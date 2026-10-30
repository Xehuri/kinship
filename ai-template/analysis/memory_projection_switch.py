#!/usr/bin/env python3
"""One-key switch between legacy memory injection and claims projection.

``set --mode claims`` is gated on a fresh ``projection-status.json``: no
warnings, no stale entries for the three injected files, and hashes that still
match ``claims.jsonl`` and those files. The three files are copied to a
snapshot before the policy flips. ``rollback`` restores that snapshot and sets
``legacy``. Tests pass their own policy, status and snapshot paths.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any, Sequence

SCHEMA_VERSION = 1
AI_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MEMORY_DIR = "ai/memory"
DEFAULT_CLAIMS = "ai/memory/claims/claims.jsonl"
DEFAULT_POLICY = "ai/memory/claims/projection-policy.json"
DEFAULT_WORK_DIR = AI_ROOT / "data" / "cache" / "memory-projection"
DEFAULT_STATUS = DEFAULT_WORK_DIR / "v2" / "projection-status.json"
DEFAULT_SNAPSHOT = DEFAULT_WORK_DIR / "legacy-snapshot"
INJECTION_SOURCES: tuple[str, ...] = (
    "self/必读.md",
    "profile/core-lite.md",
    "topics/INDEX.md",
)
MODES: tuple[str, ...] = ("legacy", "claims")
MANIFEST_NAME = "manifest.json"


class SwitchError(RuntimeError):
    """Raised when a switch cannot proceed safely."""


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _resolve(base: Path, value: str | Path) -> Path:
    path = Path(value)
    return path if path.is_absolute() else base / path


def _display(root: Path, path: Path) -> str:
    resolved = path.resolve()
    relative = resolved.relative_to(root) if root in resolved.parents else resolved
    return relative.as_posix()


def _read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise SwitchError(f"missing {label}: {path}") from exc
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SwitchError(f"invalid {label} {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise SwitchError(f"invalid {label} {path}: expected a JSON object")
    return value


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def _read_policy(path: Path) -> dict[str, Any] | None:
    return _read_json(path, "projection policy") if path.is_file() else None


def _policy_document(
    mode: str, snapshot: Path, claims_hash: str | None
) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "mode": mode,
        "snapshot_dir": str(snapshot),
        "claims_hash": claims_hash,
    }


def _verify_status(status_path: Path, claims_path: Path, memory_root: Path) -> dict[str, Any]:
    payload = _read_json(status_path, "projection status")
    warnings = payload.get("warnings")
    if not isinstance(warnings, list):
        raise SwitchError("projection status has no warnings list")
    if warnings:
        raise SwitchError("projection status still has warnings; resolve them before switching")
    stale = payload.get("stale")
    if not isinstance(stale, list):
        raise SwitchError("projection status has no stale list")
    stale_sources = {
        entry["target"].rpartition("#")[0]
        for entry in stale
        if isinstance(entry, dict) and isinstance(entry.get("target"), str)
    }
    blocked = sorted(stale_sources & set(INJECTION_SOURCES))
    if blocked:
        raise SwitchError(
            "projection status has stale entries for injection files: " + ", ".join(blocked)
        )
    if payload.get("claims_hash") != _sha256(claims_path):
        raise SwitchError("projection status is stale: claims hash mismatch")
    hashes = payload.get("source_hashes")
    if not isinstance(hashes, dict):
        raise SwitchError("projection status has no source_hashes object")
    for source in INJECTION_SOURCES:
        path = memory_root / source
        if not path.is_file():
            raise SwitchError(f"missing injection file: {path}")
        if hashes.get(source) != _sha256(path):
            raise SwitchError(f"projection status is stale: {source} hash mismatch")
    return payload


def status_payload(
    root: str | Path = ".",
    *,
    policy_path: str | Path = DEFAULT_POLICY,
    status_path: str | Path = DEFAULT_STATUS,
    snapshot_dir: str | Path | None = None,
) -> dict[str, Any]:
    root_path = Path(root).resolve()
    policy_file = _resolve(root_path, policy_path)
    status_file = _resolve(root_path, status_path)
    policy = _read_policy(policy_file)
    recorded = policy.get("snapshot_dir") if policy else None
    if not isinstance(recorded, str):
        recorded = None
    snapshot = _resolve(root_path, recorded or snapshot_dir or DEFAULT_SNAPSHOT)
    return {
        "mode": policy["mode"] if policy and isinstance(policy.get("mode"), str) else "legacy",
        "policy": policy,
        "policy_path": _display(root_path, policy_file),
        "snapshot_dir": str(snapshot),
        "snapshot_exists": snapshot.is_dir(),
        "snapshot_files": (
            sorted(
                path.relative_to(snapshot).as_posix()
                for path in snapshot.rglob("*")
                if path.is_file()
            )
            if snapshot.is_dir()
            else []
        ),
        "status_path": _display(root_path, status_file),
        "status_exists": status_file.is_file(),
    }


def set_mode(
    root: str | Path,
    mode: str,
    *,
    claims_path: str | Path = DEFAULT_CLAIMS,
    policy_path: str | Path = DEFAULT_POLICY,
    status_path: str | Path = DEFAULT_STATUS,
    snapshot_dir: str | Path | None = None,
) -> dict[str, Any]:
    if mode not in MODES:
        raise SwitchError(f"unknown mode {mode}; expected one of {', '.join(MODES)}")
    root_path = Path(root).resolve()
    memory_root = root_path / DEFAULT_MEMORY_DIR
    policy_file = _resolve(root_path, policy_path)
    snapshot = _resolve(root_path, snapshot_dir or DEFAULT_SNAPSHOT)
    if mode == "legacy":
        document = _policy_document("legacy", snapshot, None)
        _write_json(policy_file, document)
        return document

    claims = _resolve(root_path, claims_path)
    if not claims.is_file():
        raise SwitchError(f"missing claims file: {claims}")
    _verify_status(_resolve(root_path, status_path), claims, memory_root)
    source_hashes: dict[str, str] = {}
    for source in INJECTION_SOURCES:
        path = memory_root / source
        if not path.is_file():
            raise SwitchError(f"missing injection file: {path}")
        raw = path.read_bytes()
        snapshot_file = snapshot / source
        snapshot_file.parent.mkdir(parents=True, exist_ok=True)
        snapshot_file.write_bytes(raw)
        source_hashes[source] = hashlib.sha256(raw).hexdigest()
    claims_hash = _sha256(claims)
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "snapshot_dir": str(snapshot),
        "claims_hash": claims_hash,
        "source_hashes": source_hashes,
    }
    _write_json(snapshot / MANIFEST_NAME, manifest)
    document = _policy_document("claims", snapshot, claims_hash)
    _write_json(policy_file, document)
    return document


def rollback(
    root: str | Path,
    *,
    policy_path: str | Path = DEFAULT_POLICY,
    snapshot_dir: str | Path | None = None,
) -> dict[str, Any]:
    root_path = Path(root).resolve()
    policy_file = _resolve(root_path, policy_path)
    policy = _read_policy(policy_file)
    if policy is None:
        raise SwitchError("missing projection policy; nothing to roll back")
    if policy.get("mode") != "claims":
        raise SwitchError("rollback requires policy mode claims")
    recorded = policy.get("snapshot_dir")
    if not isinstance(recorded, str):
        recorded = None
    snapshot = _resolve(root_path, snapshot_dir or recorded or DEFAULT_SNAPSHOT)
    contents: dict[str, bytes] = {}
    for source in INJECTION_SOURCES:
        path = snapshot / source
        if not path.is_file():
            raise SwitchError(f"snapshot is missing {source}")
        contents[source] = path.read_bytes()
    manifest_path = snapshot / MANIFEST_NAME
    if manifest_path.is_file():
        manifest = _read_json(manifest_path, "snapshot manifest")
        hashes = manifest.get("source_hashes")
        if not isinstance(hashes, dict):
            raise SwitchError("snapshot manifest has no source_hashes object")
        for source, raw in contents.items():
            if hashes.get(source) != hashlib.sha256(raw).hexdigest():
                raise SwitchError(f"snapshot file does not match manifest: {source}")
    memory_root = root_path / DEFAULT_MEMORY_DIR
    for source, raw in contents.items():
        target = memory_root / source
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
    document = _policy_document("legacy", snapshot, policy.get("claims_hash"))
    _write_json(policy_file, document)
    return document


def main(argv: Sequence[str] | None = None) -> int:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--root", default=".")
    common.add_argument("--claims", default=DEFAULT_CLAIMS)
    common.add_argument("--policy", default=DEFAULT_POLICY)
    common.add_argument("--status", default=str(DEFAULT_STATUS))
    common.add_argument("--snapshot", default=None)

    parser = argparse.ArgumentParser(
        prog="memory_projection_switch.py",
        description="Switch memory injection between legacy files and claims projection.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("status", parents=[common], help="print policy and snapshot state")
    set_parser = subparsers.add_parser(
        "set", parents=[common], help="write the projection policy"
    )
    set_parser.add_argument("--mode", choices=MODES, required=True)
    subparsers.add_parser(
        "rollback", parents=[common], help="restore the injection snapshot and go legacy"
    )
    args = parser.parse_args(argv)
    try:
        if args.command == "status":
            payload = status_payload(
                args.root,
                policy_path=args.policy,
                status_path=args.status,
                snapshot_dir=args.snapshot,
            )
        elif args.command == "set":
            payload = set_mode(
                args.root,
                args.mode,
                claims_path=args.claims,
                policy_path=args.policy,
                status_path=args.status,
                snapshot_dir=args.snapshot,
            )
        else:
            payload = rollback(
                args.root, policy_path=args.policy, snapshot_dir=args.snapshot
            )
    except (SwitchError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
