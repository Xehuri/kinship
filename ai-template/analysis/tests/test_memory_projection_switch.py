"""memory_projection_switch 的回归测试（tmp_path 假 policy/status/snapshot）。"""

import hashlib
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import memory_projection_switch as switch

SOURCES = {
    "self/必读.md": "# 必读\n\n- 主线。\n",
    "profile/core-lite.md": "# core-lite\n\n- 用户。\n",
    "topics/INDEX.md": "# 索引\n\n| 话题 |\n|---|\n| 系统 |\n",
}


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _repo(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    for relative, text in SOURCES.items():
        _write(root / "ai/memory" / relative, text)
    _write(root / "ai/memory/claims/claims.jsonl", '{"claim_id":"claim_000000000000"}\n')
    return root


def _paths(root: Path) -> dict[str, Path]:
    return {
        "policy": root / "ai/memory/claims/projection-policy.json",
        "status": root / "out/projection-status.json",
        "snapshot": root.parent / "legacy-snapshot",
    }


def _status_payload(
    root: Path,
    *,
    warnings: list[str] | None = None,
    stale: list[dict[str, str]] | None = None,
    claims_hash: str | None = None,
    source_hashes: dict[str, str] | None = None,
) -> dict:
    claims = root / "ai/memory/claims/claims.jsonl"
    return {
        "schema_version": 1,
        "warnings": [] if warnings is None else warnings,
        "stale": [] if stale is None else stale,
        "claims_hash": _sha(claims) if claims_hash is None else claims_hash,
        "source_hashes": (
            {relative: _sha(root / "ai/memory" / relative) for relative in SOURCES}
            if source_hashes is None
            else source_hashes
        ),
    }


def _write_status(paths: dict[str, Path], payload: dict) -> None:
    _write(paths["status"], json.dumps(payload, ensure_ascii=False))


def _set_claims(root: Path, paths: dict[str, Path]) -> dict:
    return switch.set_mode(
        root,
        "claims",
        policy_path=paths["policy"],
        status_path=paths["status"],
        snapshot_dir=paths["snapshot"],
    )


def test_status_reports_legacy_without_policy(tmp_path):
    root = _repo(tmp_path)
    paths = _paths(root)

    payload = switch.status_payload(
        root,
        policy_path=paths["policy"],
        status_path=paths["status"],
        snapshot_dir=paths["snapshot"],
    )

    assert payload["mode"] == "legacy"
    assert payload["policy"] is None
    assert payload["policy_path"] == "ai/memory/claims/projection-policy.json"
    assert payload["snapshot_dir"] == str(paths["snapshot"])
    assert payload["snapshot_exists"] is False
    assert payload["snapshot_files"] == []
    assert payload["status_path"] == "out/projection-status.json"
    assert payload["status_exists"] is False


def test_cli_status_prints_json(tmp_path, capsys):
    root = _repo(tmp_path)
    paths = _paths(root)

    code = switch.main(
        [
            "status",
            "--root",
            str(root),
            "--policy",
            str(paths["policy"]),
            "--status",
            str(paths["status"]),
            "--snapshot",
            str(paths["snapshot"]),
        ]
    )

    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["mode"] == "legacy"
    assert payload["snapshot_dir"] == str(paths["snapshot"])


def test_set_claims_requires_fresh_status(tmp_path):
    root = _repo(tmp_path)
    paths = _paths(root)

    with pytest.raises(switch.SwitchError, match="missing projection status"):
        _set_claims(root, paths)
    assert not paths["policy"].exists()


def test_set_claims_rejects_warnings(tmp_path):
    root = _repo(tmp_path)
    paths = _paths(root)
    _write_status(paths, _status_payload(root, warnings=["claim x: unknown target"]))

    with pytest.raises(switch.SwitchError, match="warnings"):
        _set_claims(root, paths)
    assert not paths["policy"].exists()
    assert not paths["snapshot"].exists()


def test_set_claims_rejects_stale_injection_target(tmp_path):
    root = _repo(tmp_path)
    paths = _paths(root)
    _write_status(
        paths,
        _status_payload(
            root,
            stale=[
                {
                    "claim_id": "claim_000000000001",
                    "target": "profile/core-lite.md#当前事项",
                    "object": "测试",
                }
            ],
        ),
    )

    with pytest.raises(switch.SwitchError, match="injection files: profile/core-lite.md"):
        _set_claims(root, paths)


def test_set_claims_allows_stale_semantic_target(tmp_path):
    root = _repo(tmp_path)
    paths = _paths(root)
    _write_status(
        paths,
        _status_payload(
            root,
            stale=[
                {
                    "claim_id": "claim_000000000002",
                    "target": "profile/semantic/健康基线.md#长期基线07-28-起跟踪",
                    "object": "测试",
                }
            ],
        ),
    )

    assert _set_claims(root, paths)["mode"] == "claims"


def test_set_claims_rejects_claims_hash_mismatch(tmp_path):
    root = _repo(tmp_path)
    paths = _paths(root)
    _write_status(paths, _status_payload(root, claims_hash="0" * 64))

    with pytest.raises(switch.SwitchError, match="claims hash mismatch"):
        _set_claims(root, paths)


def test_set_claims_rejects_source_hash_mismatch(tmp_path):
    root = _repo(tmp_path)
    paths = _paths(root)
    hashes = {relative: _sha(root / "ai/memory" / relative) for relative in SOURCES}
    hashes["self/必读.md"] = "0" * 64
    _write_status(paths, _status_payload(root, source_hashes=hashes))

    with pytest.raises(switch.SwitchError, match="self/必读.md hash mismatch"):
        _set_claims(root, paths)


def test_set_claims_snapshots_files_and_writes_policy(tmp_path):
    root = _repo(tmp_path)
    paths = _paths(root)
    _write_status(paths, _status_payload(root))

    policy = _set_claims(root, paths)

    assert policy["mode"] == "claims"
    stored = json.loads(paths["policy"].read_text(encoding="utf-8"))
    assert stored["mode"] == "claims"
    assert stored["snapshot_dir"] == str(paths["snapshot"])
    assert stored["claims_hash"] == _sha(root / "ai/memory/claims/claims.jsonl")
    for relative, text in SOURCES.items():
        assert (paths["snapshot"] / relative).read_text(encoding="utf-8") == text
        assert (root / "ai/memory" / relative).read_text(encoding="utf-8") == text
    manifest = json.loads((paths["snapshot"] / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["source_hashes"] == {
        relative: _sha(root / "ai/memory" / relative) for relative in SOURCES
    }

    status = switch.status_payload(
        root,
        policy_path=paths["policy"],
        status_path=paths["status"],
        snapshot_dir=tmp_path / "ignored",
    )
    assert status["mode"] == "claims"
    assert status["snapshot_dir"] == str(paths["snapshot"])
    assert status["snapshot_exists"] is True
    assert "manifest.json" in status["snapshot_files"]


def test_set_legacy_writes_policy_without_status(tmp_path):
    root = _repo(tmp_path)
    paths = _paths(root)

    policy = switch.set_mode(
        root,
        "legacy",
        policy_path=paths["policy"],
        status_path=paths["status"],
        snapshot_dir=paths["snapshot"],
    )

    assert policy["mode"] == "legacy"
    assert json.loads(paths["policy"].read_text(encoding="utf-8"))["mode"] == "legacy"
    assert not paths["snapshot"].exists()


def test_rollback_restores_snapshot_and_sets_legacy(tmp_path):
    root = _repo(tmp_path)
    paths = _paths(root)
    _write_status(paths, _status_payload(root))
    _set_claims(root, paths)
    originals = {
        relative: (root / "ai/memory" / relative).read_bytes() for relative in SOURCES
    }
    for relative in SOURCES:
        _write(root / "ai/memory" / relative, "# 已改动\n")

    policy = switch.rollback(
        root, policy_path=paths["policy"], snapshot_dir=paths["snapshot"]
    )

    assert policy["mode"] == "legacy"
    for relative, raw in originals.items():
        assert (root / "ai/memory" / relative).read_bytes() == raw
    assert json.loads(paths["policy"].read_text(encoding="utf-8"))["mode"] == "legacy"


def test_rollback_requires_claims_mode(tmp_path):
    root = _repo(tmp_path)
    paths = _paths(root)

    with pytest.raises(switch.SwitchError, match="nothing to roll back"):
        switch.rollback(root, policy_path=paths["policy"], snapshot_dir=paths["snapshot"])

    switch.set_mode(root, "legacy", policy_path=paths["policy"], snapshot_dir=paths["snapshot"])
    with pytest.raises(switch.SwitchError, match="requires policy mode claims"):
        switch.rollback(root, policy_path=paths["policy"], snapshot_dir=paths["snapshot"])


def test_rollback_rejects_snapshot_manifest_mismatch(tmp_path):
    root = _repo(tmp_path)
    paths = _paths(root)
    _write_status(paths, _status_payload(root))
    _set_claims(root, paths)
    _write(root / "ai/memory/profile/core-lite.md", "# 线上改动\n")
    _write(paths["snapshot"] / "profile/core-lite.md", "# 快照损坏\n")

    with pytest.raises(switch.SwitchError, match="does not match manifest"):
        switch.rollback(root, policy_path=paths["policy"], snapshot_dir=paths["snapshot"])

    assert (root / "ai/memory/profile/core-lite.md").read_text(encoding="utf-8") == "# 线上改动\n"
    assert json.loads(paths["policy"].read_text(encoding="utf-8"))["mode"] == "claims"
