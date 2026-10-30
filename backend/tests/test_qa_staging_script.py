# -*- coding: utf-8 -*-
"""T05 staging QA harness tests.

Only dry-run and pure helpers are exercised here; a real backend is never
started by this test module.
"""
from __future__ import annotations

import importlib.util
import inspect
import json
import os
import signal
import stat
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
SCRIPT = BACKEND / "scripts" / "qa_config_staging.py"
REPO_CONFIG = ROOT / "config.yaml"
REPO_AUTH = BACKEND / "config" / "auth.json"

STAGING_ENV_KEYS = {
    "CONFIG_PATH",
    "AXEUH_PROJECT_ROOT",
    "AXEUH_AUTH_STATE_DIR",
    "AEUH_ONBOARDING_STATE",
    "AEUH_FRONTEND_DIST",
    "PYTHONUNBUFFERED",
}

HEALTH_STATE_KEYS = (
    "health_devices",
    "health_source_selection",
    "health_cloud_state",
)


def _load_module():
    spec = importlib.util.spec_from_file_location("qa_config_staging_t05", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载 {SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def qa():
    return _load_module()


def _clean_env() -> dict[str, str]:
    return {
        key: value
        for key, value in os.environ.items()
        if not key.startswith("AXEUH_SETTINGS__")
    }


def _run_cli(args: list[str], timeout: int = 60) -> subprocess.CompletedProcess:
    env = _clean_env()
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        cwd=str(ROOT),
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def _mtimes() -> dict[Path, int | None]:
    return {
        path: path.stat().st_mtime_ns if path.exists() else None
        for path in (REPO_CONFIG, REPO_AUTH)
    }


def test_dry_run_exits_zero_with_full_plan_and_creates_nothing(tmp_path):
    root = tmp_path / "staging-root"
    report = tmp_path / "report.json"
    dist = tmp_path / "missing-dist"

    result = _run_cli(
        [
            "--dry-run",
            "--root",
            str(root),
            "--report",
            str(report),
            "--dist",
            str(dist),
        ]
    )

    assert result.returncode == 0, result.stderr
    plan = json.loads(result.stdout)
    assert plan["root"] == str(root)
    assert plan["port"] == 18768
    assert plan["http_port"] == 18769
    assert plan["config_path"] == str(root / "config" / "config.yaml")
    assert plan["report"] == str(report)
    assert plan["dist"] == str(dist)
    assert plan["mode"] == "dry-run"
    assert STAGING_ENV_KEYS <= set(plan["env_keys"])
    assert plan["env"]["CONFIG_PATH"] == plan["config_path"]
    assert plan["env"]["AXEUH_PROJECT_ROOT"] == str(root)
    for key in ("AXEUH_AUTH_STATE_DIR", "AEUH_ONBOARDING_STATE"):
        assert Path(plan["env"][key]).is_relative_to(root), key
    assert not root.exists()
    assert not report.exists()


def test_dry_run_never_calls_popen(qa, tmp_path, monkeypatch, capsys):
    def _boom(*args, **kwargs):
        raise AssertionError("dry-run must not spawn a process")

    monkeypatch.setattr(qa.subprocess, "Popen", _boom)
    monkeypatch.setattr(qa, "DEFAULT_ROOT_BASE", tmp_path / "base")

    assert qa.main(["--dry-run"]) == 0

    plan = json.loads(capsys.readouterr().out)
    assert Path(plan["root"]).parent == tmp_path / "base"


def test_dry_run_leaves_default_root_and_repo_state_untouched(
    qa, tmp_path, monkeypatch, capsys
):
    base = tmp_path / "system-config"
    monkeypatch.setattr(qa, "DEFAULT_ROOT_BASE", base)
    before = _mtimes()

    assert qa.main(["--dry-run"]) == 0

    plan = json.loads(capsys.readouterr().out)
    assert Path(plan["root"]).parent == base
    assert plan["root"].startswith(str(base))
    assert not Path(plan["root"]).exists()
    assert not base.exists()
    assert _mtimes() == before


def test_argparse_defaults(qa, monkeypatch, tmp_path):
    monkeypatch.setattr(qa, "DEFAULT_ROOT_BASE", tmp_path / "base")

    args = qa.build_parser().parse_args([])

    assert args.port == 18768
    assert args.http_port == 18769
    assert args.timeout == 30
    assert args.dist == ROOT / "frontend" / "mobile" / "dist-e2e"
    assert args.report == qa.DEFAULT_REPORT
    assert args.report.name == "staging-report.md"
    assert args.root.parent == tmp_path / "base"
    assert args.root.name.startswith("staging-")
    assert args.dry_run is False
    assert args.smoke is False
    assert args.keep is False


def test_argparse_overrides(qa, tmp_path):
    args = qa.build_parser().parse_args(
        [
            "--root",
            str(tmp_path / "root"),
            "--port",
            "18800",
            "--http-port",
            "18801",
            "--dist",
            str(tmp_path / "dist"),
            "--report",
            str(tmp_path / "report.json"),
            "--dry-run",
            "--smoke",
            "--keep",
            "--timeout",
            "7",
        ]
    )

    assert args.root == tmp_path / "root"
    assert args.port == 18800
    assert args.http_port == 18801
    assert args.dist == tmp_path / "dist"
    assert args.report == tmp_path / "report.json"
    assert args.dry_run is True
    assert args.smoke is True
    assert args.keep is True
    assert args.timeout == 7


def test_generated_config_is_valid_and_isolated(qa, tmp_path):
    args = qa.build_parser().parse_args(
        ["--root", str(tmp_path / "staging"), "--port", "18800", "--http-port", "18801"]
    )
    root = qa.prepare_root(args)
    config_path = root / "config" / "config.yaml"

    for name in ("config", "auth", "onboarding", "data", "logs"):
        assert (root / name).is_dir(), name
    assert stat.S_IMODE(config_path.stat().st_mode) == 0o600

    raw = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    assert raw["server"] == {
        "host": "127.0.0.1",
        "port": 18800,
    }
    assert raw["ssl"]["enabled"] is False
    assert raw["ai_backend"] == "opencode"
    assert raw["opencode"]["enabled"] is False
    for key in ("default_agent", "default_model", "default_provider"):
        assert raw["opencode"][key], f"opencode.{key} 必须非空"
    assert raw["data"]["dir"] == str(root / "data")
    assert raw["data"]["sessions"] == str(root / "data" / "usersessions.json")
    assert raw["data"]["tasks"] == str(root / "data")
    assert raw["data"]["voiceprints"] == str(root / "data" / "voiceprints.json")
    assert raw["data"]["ai_root"] == str(root / "data")
    for key in HEALTH_STATE_KEYS:
        value = Path(raw["data"][key])
        assert value == root / "data" / f"{key}.json", key
        assert value.is_relative_to(root), key
        assert not value.is_relative_to(BACKEND / "data"), key
    assert raw["auth"]["setup_require_token"] is True
    assert raw["features"]["opencode_mock_enabled"] is True
    assert raw["qq_gateway"]["enabled"] is False
    assert raw["p2p"]["enabled"] is False
    assert raw["tts"]["enabled"] is False
    assert raw["audio_compressor"]["enabled"] is False
    assert raw["unknown_speaker"]["enabled"] is False
    assert raw["health"]["primary_user"] == "staging"
    assert raw["log"]["level"] == "INFO"

    probe = (
        "import json\n"
        "from config.config import get_config\n"
        "cfg = get_config()\n"
        "print(json.dumps({\n"
        "    'unconfigured': bool(getattr(cfg, 'UNCONFIGURED', False)),\n"
        "    'port': cfg.BACKEND_PORT,\n"
        "    'https_port': cfg.BACKEND_HTTPS_PORT,\n"
        "    'http_port': cfg.BACKEND_HTTP_PORT,\n"
        "    'data_dir': cfg.DATA_DIR,\n"
        "    'health_devices': cfg.HEALTH_DEVICES_PATH,\n"
        "    'health_source_selection': cfg.HEALTH_SOURCE_SELECTION_PATH,\n"
        "    'health_cloud_state': cfg.HEALTH_CLOUD_STATE_PATH,\n"
        "    'ai_backend': cfg.AI_BACKEND,\n"
        "    'ssl_enabled': cfg.SSL_ENABLED,\n"
        "    'opencode_enabled': cfg.OPENCODE_ENABLED,\n"
        "}))\n"
    )
    env = _clean_env()
    env["CONFIG_PATH"] = str(config_path)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    result = subprocess.run(
        [sys.executable, "-c", probe],
        cwd=str(BACKEND),
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout.strip().splitlines()[-1])
    assert payload["unconfigured"] is False
    assert payload["port"] == 18800
    assert payload["https_port"] == 18800
    assert payload["http_port"] == 18800
    assert payload["data_dir"] == str(root / "data")
    for key in HEALTH_STATE_KEYS:
        resolved = Path(payload[key])
        assert resolved == root / "data" / f"{key}.json", key
        assert resolved.is_relative_to(root), key
        assert not resolved.is_relative_to(BACKEND / "data"), key
    assert payload["ai_backend"] == "opencode"
    assert payload["ssl_enabled"] is False
    assert payload["opencode_enabled"] is False


def test_source_has_no_process_wide_kill_commands():
    source = SCRIPT.read_text(encoding="utf-8")
    assert "p" + "kill" not in source
    assert "kill" + "all" not in source


def test_terminate_pid_sends_sigterm_to_recorded_pid(qa):
    calls: list[tuple[int, int]] = []

    result = qa.terminate_pid(
        4321,
        kill=lambda pid, sig: calls.append((pid, sig)),
        alive=lambda pid: False,
    )

    assert calls == [(4321, signal.SIGTERM)]
    assert result == "sigterm"


def test_terminate_pid_escalates_to_sigkill_when_still_alive(qa):
    calls: list[tuple[int, int]] = []
    ticks = iter([0.0, 0.0, 99.0])

    result = qa.terminate_pid(
        99,
        wait_seconds=1,
        kill=lambda pid, sig: calls.append((pid, sig)),
        alive=lambda pid: True,
        sleep=lambda seconds: None,
        clock=lambda: next(ticks),
    )

    assert calls == [(99, signal.SIGTERM), (99, signal.SIGKILL)]
    assert result == "sigkill"


def test_terminate_pid_default_kill_is_os_kill(qa):
    params = inspect.signature(qa.terminate_pid).parameters
    assert params["kill"].default is os.kill
