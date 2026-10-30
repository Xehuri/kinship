#!/usr/bin/env python3
"""Isolated staging QA harness for config changes.

Creates a disposable root with its own config/state/logs, starts the backend on
loopback HTTP, runs basic smoke checks, then stops exactly the PID it started.
Dry-run prints the plan without creating files or spawning processes.

Usage:
    python backend/scripts/qa_config_staging.py --dry-run
    python backend/scripts/qa_config_staging.py --smoke
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

_FILE = Path(__file__).resolve()
BACKEND_DIR = _FILE.parents[1]
REPO_ROOT = _FILE.parents[2]
DEFAULT_ROOT_BASE = Path(tempfile.gettempdir()) / "kinship-system-config"
DEFAULT_REPORT = DEFAULT_ROOT_BASE / "staging-report.md"
DEFAULT_DIST = REPO_ROOT / "frontend" / "mobile" / "dist-e2e"
DEFAULT_PORT, DEFAULT_HTTP_PORT, DEFAULT_TIMEOUT = 18768, 18769, 30


def default_root(now: datetime | None = None) -> Path:
    stamp = (now or datetime.now()).strftime("%Y%m%d-%H%M%S")
    return DEFAULT_ROOT_BASE / f"staging-{stamp}"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Isolated staging QA harness for config changes.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--root", type=Path, default=default_root(),
                        help="staging root (default: <TMP_DIR>/kinship-system-config/staging-<ts>)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT,
                        help="configured service port written to server.port")
    parser.add_argument("--http-port", type=int, default=DEFAULT_HTTP_PORT,
                        help="actual uvicorn bind port")
    parser.add_argument("--dist", type=Path, default=DEFAULT_DIST)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--dry-run", action="store_true", help="print plan JSON only")
    parser.add_argument("--smoke", action="store_true", help="start and smoke-test")
    parser.add_argument("--keep", action="store_true", help="keep staging files")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    return parser


def _validate(args: argparse.Namespace) -> None:
    for flag, value in (("--port", args.port), ("--http-port", args.http_port)):
        if not 1 <= value <= 65535:
            raise SystemExit(f"{flag} must be in 1..65535 (got {value})")
    if args.timeout < 1:
        raise SystemExit(f"--timeout must be >= 1 (got {args.timeout})")


def staging_config(root: Path, args: argparse.Namespace) -> dict[str, Any]:
    data = root / "data"
    return {
        "server": {"host": "127.0.0.1", "port": args.port},
        "ssl": {"enabled": False, "cert": "", "key": ""},
        "ai_backend": "opencode",
        "opencode": {"enabled": False, "url": "http://127.0.0.1:4096", "directory": "ai",
                     "default_agent": "main-task", "default_model": "gpt-4o-mini",
                     "default_provider": "openai"},
        "loom": {"url": "http://127.0.0.1:5100", "token": ""},
        "data": {"dir": str(data), "sessions": str(data / "usersessions.json"), "tasks": str(data),
                 "voiceprints": str(data / "voiceprints.json"), "ai_root": str(data),
                 "health_devices": str(data / "health_devices.json"),
                 "health_source_selection": str(data / "health_source_selection.json"),
                 "health_cloud_state": str(data / "health_cloud_state.json")},
        "auth": {"setup_require_token": True},
        "features": {"opencode_mock_enabled": True},
        "qq_gateway": {"enabled": False}, "p2p": {"enabled": False}, "tts": {"enabled": False},
        "audio_compressor": {"enabled": False}, "unknown_speaker": {"enabled": False},
        "health": {"primary_user": "staging"}, "log": {"level": "INFO"},
    }


def write_staging_config(root: Path, args: argparse.Namespace) -> Path:
    import yaml

    path = root / "config" / "config.yaml"
    payload = yaml.safe_dump(staging_config(root, args), sort_keys=False, allow_unicode=True)
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600),
                   "w", encoding="utf-8") as handle:
        handle.write(payload)
    os.chmod(path, 0o600)
    return path


def prepare_root(args: argparse.Namespace) -> Path:
    root = Path(args.root)
    for name in ("config", "auth", "onboarding", "data", "logs"):
        (root / name).mkdir(parents=True, exist_ok=True)
    write_staging_config(root, args)
    return root


def staging_env_overrides(root: Path, args: argparse.Namespace) -> dict[str, str]:
    return {
        "CONFIG_PATH": str(root / "config" / "config.yaml"),
        "AXEUH_PROJECT_ROOT": str(root),
        "AXEUH_AUTH_STATE_DIR": str(root / "auth"),
        "AEUH_ONBOARDING_STATE": str(root / "onboarding" / "onboarding_state.json"),
        "AEUH_FRONTEND_DIST": str(args.dist),
        "PYTHONUNBUFFERED": "1",
    }


def build_plan(args: argparse.Namespace) -> dict[str, Any]:
    root = Path(args.root)
    overrides = staging_env_overrides(root, args)
    return {
        "mode": "dry-run" if args.dry_run else "smoke",
        "root": str(root), "repo_root": str(REPO_ROOT), "backend_dir": str(BACKEND_DIR),
        "port": args.port, "http_port": args.http_port,
        "config_path": overrides["CONFIG_PATH"], "dist": str(args.dist),
        "report": str(args.report), "timeout": args.timeout,
        "keep": bool(args.keep), "smoke": bool(args.smoke or not args.dry_run),
        "env": overrides, "env_keys": sorted(overrides),
    }


def _http_status(url: str, timeout: float = 2.0) -> tuple[int, bytes]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def wait_for_health(
    port: int,
    timeout: int,
    proc: subprocess.Popen | None = None,
) -> tuple[bool, bytes]:
    deadline, last = time.monotonic() + timeout, b""
    while time.monotonic() < deadline:
        if proc is not None and proc.poll() is not None:
            return False, last
        try:
            status, body = _http_status(f"http://127.0.0.1:{port}/health")
        except (urllib.error.URLError, OSError):
            pass
        else:
            if status == 200:
                return True, body
            last = body
        time.sleep(0.5)
    return False, last


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def terminate_pid(
    pid: int,
    *,
    wait_seconds: float = 10.0,
    kill: Callable[[int, int], None] = os.kill,
    sleep: Callable[[float], None] = time.sleep,
    alive: Callable[[int], bool] | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> str:
    """SIGTERM then SIGKILL after a grace period; targets exactly one PID."""
    checker = _pid_alive if alive is None else alive
    try:
        kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return "already-exited"
    deadline = clock() + wait_seconds
    while clock() < deadline:
        if not checker(pid):
            return "sigterm"
        sleep(0.1)
    try:
        kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        return "sigterm"
    return "sigkill"


def run_smoke(args: argparse.Namespace) -> int:
    started = time.monotonic()
    root = prepare_root(args)
    log_path = root / "logs" / "backend.log"
    report: dict[str, Any] = {
        "status": "fail",
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "root": str(root), "port": args.port, "http_port": args.http_port,
        "dist": str(args.dist), "checks": [],
    }
    proc: subprocess.Popen | None = None
    cmd = [sys.executable, "-m", "uvicorn", "main:app",
           "--host", "127.0.0.1", "--port", str(args.http_port)]

    with open(log_path, "w", encoding="utf-8") as log_file:
        try:
            proc = subprocess.Popen(
                cmd, cwd=str(BACKEND_DIR),
                env={**os.environ, **staging_env_overrides(root, args)},
                stdout=log_file, stderr=subprocess.STDOUT,
            )
            report["pid"] = proc.pid
            ready, body = wait_for_health(args.http_port, args.timeout, proc=proc)
            try:
                health_status = str(json.loads(body).get("status", "")).lower()
            except (ValueError, TypeError, AttributeError):
                health_status = ""
            report["checks"].append({
                "name": "health", "ok": ready and health_status == "healthy",
                "detail": body.decode("utf-8", "replace")[:2000],
            })
            if ready:
                mobile_status, _ = _http_status(f"http://127.0.0.1:{args.http_port}/mobile/")
                dist_exists = Path(args.dist).exists()
                report["checks"].append({
                    "name": "mobile",
                    "ok": mobile_status == 200 or (mobile_status == 404 and not dist_exists),
                    "detail": f"status={mobile_status} dist_exists={dist_exists}",
                })
            if not all(check["ok"] for check in report["checks"]):
                print("staging smoke failed; last 50 backend log lines:", file=sys.stderr)
                try:
                    lines = log_path.read_text(encoding="utf-8", errors="replace").splitlines()
                except OSError:
                    lines = ["(log unavailable)"]
                print("\n".join(lines[-50:]), file=sys.stderr)
        except Exception as exc:  # boundary: surface startup failures in the report
            report["error"] = f"{type(exc).__name__}: {exc}"
            print(report["error"], file=sys.stderr)
        finally:
            if proc is not None and proc.poll() is None:
                report["teardown"] = terminate_pid(proc.pid, alive=lambda _pid: proc.poll() is None)
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    report["teardown"] = "wait-timeout"

    report["status"] = ("pass" if report["checks"] and all(c["ok"] for c in report["checks"])
                        and "error" not in report else "fail")
    report["duration_s"] = round(time.monotonic() - started, 2)
    report["kept_root"] = bool(args.keep)
    report_path = Path(args.report)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n",
                           encoding="utf-8")
    if not args.keep:
        shutil.rmtree(root, ignore_errors=True)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["status"] == "pass" else 1


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    _validate(args)
    if args.dry_run:
        print(json.dumps(build_plan(args), ensure_ascii=False, indent=2))
        return 0
    return run_smoke(args)


if __name__ == "__main__":
    sys.exit(main())
