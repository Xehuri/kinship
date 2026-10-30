"""Structural tests for the fail-closed Kinship public export allowlist."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import policy  # noqa: E402

ALLOWLIST_FILE = Path(__file__).resolve().parents[1] / "allowlist.toml"


@pytest.fixture(scope="module")
def allowlist() -> dict:
    return policy.load_allowlist(ALLOWLIST_FILE)


def test_allowlist_declares_allowlist_mode_and_deny_default(allowlist: dict) -> None:
    assert allowlist["mode"] == "allowlist"
    assert allowlist["default_action"] == "deny"


def test_allow_entries_are_explicit(allowlist: dict) -> None:
    allow = allowlist["allow"]
    assert allow["files"], "exact root files must be listed explicitly"
    assert allow["trees"], "public source trees must be listed explicitly"
    for entry in allow["files"]:
        assert not any(char in entry for char in "*?["), entry
    for entry in allow["trees"]:
        assert entry.endswith("/"), entry
        assert not any(char in entry for char in "*?["), entry
    for entry in allow["patterns"]:
        assert policy._literal_prefix(entry), entry


def test_empty_allow_entry_is_rejected() -> None:
    with pytest.raises(policy.AllowlistError):
        policy.validate_allowlist(
            {
                "schema_version": 1,
                "mode": "allowlist",
                "default_action": "deny",
                "allow": {"files": [], "trees": [], "patterns": []},
                "exclude": {"patterns": ["ai/**"]},
            }
        )


def test_global_allow_pattern_is_rejected() -> None:
    with pytest.raises(policy.AllowlistError):
        policy.validate_allowlist(
            {
                "schema_version": 1,
                "mode": "allowlist",
                "default_action": "deny",
                "allow": {"patterns": ["**"]},
                "exclude": {"patterns": ["ai/**"]},
            }
        )


def test_denylist_mode_is_rejected() -> None:
    with pytest.raises(policy.AllowlistError):
        policy.validate_allowlist(
            {
                "schema_version": 1,
                "mode": "denylist",
                "default_action": "allow",
                "allow": {"files": ["README.md"]},
                "exclude": {"patterns": ["ai/**"]},
            }
        )


@pytest.mark.parametrize(
    "path",
    [
        "README.md",
        "LICENSE",
        "THIRD_PARTY_NOTICES.md",
        "VERSION",
        "LICENSES/Apache-2.0.txt",
        "LICENSES/PolyForm-Noncommercial-1.0.0.txt",
        "backend/main.py",
        "backend/tests/conftest.py",
        "frontend/mobile/src/main.ts",
        "app/src/main/java/com/xehuri/kinship/MainActivity.kt",
        "desktop/src/main/main.ts",
        "loom-harness/packages/server/src/index.ts",
        "ai-template/pyproject.toml",
        "docs/user/getting-started.md",
        "docs/dev/PROJECT_MAP.md",
        "gradle/wrapper/gradle-wrapper.jar",
        "gradle/wrapper/gradle-wrapper.properties",
        "assets/brand/kinship-mascot-rose.svg",
        "scripts/start.sh",
        "tools/kinship_export/allowlist.toml",
        "tools/kinship_export/policy.py",
    ],
)
def test_explicit_public_paths_are_allowed(allowlist: dict, path: str) -> None:
    assert policy.is_public_path(path, allowlist) is True


@pytest.mark.parametrize(
    "path",
    [
        "mystery/notes.txt",
        "health-data-source-architecture.md",
        "sync-to-github.ps1",
        "backend/config/auth.json",
        "backend/config/config.yaml",
        "backend/config/config.local.yaml",
        "backend/config/agents.json",
        "config.yaml",
        "desktop/pc-sensor/config.json",
        "desktop/pc-sensor/pc_sensor_config.json",
        "ai/data/daily/2026-10-29/perception.jsonl",
        "validation/voiceprint/sample.wav",
        "archive/behavior/verify.py",
        "logs/backend.log",
        "backend/logs/backend.log",
        "app/logs/build.txt",
        "backend/data/health_devices.json",
        "backend/models/weights.bin",
        "kernel/axeuh_kernel/main.py",
        "kernel/axeuh_kernel/models/pretrained_eres2netv2.ckpt",
        "models/model.safetensors",
        "app/build/outputs/apk/debug/app-debug.apk",
        "gradle/evil.jar",
        "desktop/pc-sensor/dist/Kinship-PCSensor.exe",
        "release/kinship-0.1.0.tar.gz",
        "frontend/mobile/node_modules/left-pad/index.js",
        "frontend/mobile/public/circuitjs1/circuitjs1/circuitjs1.nocache.js",
        "frontend/mobile/public/circuitjs1/README.md",
        "tools/public-sync/sync.py",
        "tools/public-sync/SYNC_MANIFEST.toml",
        "backend/tests/__pycache__/conftest.cpython-312.pyc",
        ".pytest_cache/v/cache/nodeids",
        ".git/config",
        "docs/migration/pii-inventory.md",
        "docs/archive/old-plan.md",
        "docs/dev/kinship-technical-migration.md",
        "docs/dev/public-sync-同步指南.md",
        "loom-harness/state/fleet/probe/2026-10-11.md",
        "loom-harness/scripts/make-fixture.sh",
        "loom-harness/docs/02-实施计划-v1.md.bak-20261008-t40tick",
        "loom-harness/packages/core/package.json.bak-20261008-121253-t27",
    ],
)
def test_forbidden_paths_are_denied(allowlist: dict, path: str) -> None:
    assert policy.is_public_path(path, allowlist) is False


def test_deny_wins_over_allowed_tree(allowlist: dict) -> None:
    assert policy.is_public_path("backend/services/health/store.py", allowlist) is True
    assert policy.is_public_path("backend/services/health/__pycache__/store.pyc", allowlist) is False
    assert policy.is_public_path("backend/config/agents.json", allowlist) is False


def test_public_sync_is_retired(allowlist: dict) -> None:
    assert allowlist["meta"]["retired_tool"] == "tools/public-sync"
    assert policy.is_public_path("tools/public-sync/sync.py", allowlist) is False


def test_circuitjs_is_not_part_of_this_export(allowlist: dict) -> None:
    assert "separate" in allowlist["meta"]["circuitjs_location"]
    assert (
        policy.is_public_path(
            "frontend/mobile/public/circuitjs1/circuitjs1/circuitjs1.nocache.js",
            allowlist,
        )
        is False
    )


@pytest.mark.parametrize(
    "path",
    [
        "",
        "/etc/passwd",
        "C:/Users/test/secret.txt",
        "../backend/main.py",
        "backend/../ai/data/x.jsonl",
        "backend//main.py",
        "./backend/main.py",
    ],
)
def test_invalid_paths_are_denied(allowlist: dict, path: str) -> None:
    assert policy.is_public_path(path, allowlist) is False


@pytest.mark.parametrize(
    "path",
    [
        "frontend/mobile/index.original.html",
        "docs/记忆-系统级审计与改进-2026-10-22.md",
        "docs/记忆与心流-讨论与决策-2026-10-23.md",
        "docs/记忆与心流-D1-D9执行记录-2026-10-23.md",
        "docs/记忆与心流-VCP对照研究-2026-10-22.md",
        "docs/Loom-借鉴报告-2026-10-24.md",
        "docs/VCP-记忆与运行时研究-2026-10-22.md",
        "docs/dev/记忆-A方案-2026-10-20.md",
        "docs/dev/规律机载-方案-2026-10-20.md",
        "docs/dev/p2p-方案与进展-2026-10-23.md",
        "docs/ops/数据源-小米健康云.md",
        "loom-harness/docs/09-小贺测试Loom作战手册.md",
    ],
)
def test_internal_and_personal_documents_are_denied(allowlist: dict, path: str) -> None:
    assert policy.is_public_path(path, allowlist) is False


@pytest.mark.parametrize(
    "path",
    [
        "docs/记忆-未来审计-2027-01-01.md",
        "docs/记忆与心流-未来讨论-2027-01-01.md",
        "docs/Loom-借鉴报告-2027-01-01.md",
        "docs/VCP-未来研究-2027-01-01.md",
        "docs/dev/记忆-B方案-2027-01-01.md",
        "docs/dev/规律机载-新方案-2027-01-01.md",
        "docs/dev/p2p-方案与进展-2027-01-01.md",
        "loom-harness/docs/09-未来作战手册-2027-01-01.md",
    ],
)
def test_internal_document_families_stay_denied_for_future_files(
    allowlist: dict, path: str
) -> None:
    assert policy.is_public_path(path, allowlist) is False


@pytest.mark.parametrize(
    "path",
    [
        "docs/dev/DATA_FORMAT.md",
        "docs/dev/qq-gateway.md",
        "docs/ops/deploy-linux.md",
        "loom-harness/docs/02-实施计划-v1.md",
        "loom-harness/docs/06-Loom使用文档.md",
    ],
)
def test_scrubbed_technical_documents_stay_public(allowlist: dict, path: str) -> None:
    assert policy.is_public_path(path, allowlist) is True


def test_allowlist_entries_have_no_surrounding_whitespace(allowlist: dict) -> None:
    entries = (
        allowlist["allow"]["files"]
        + allowlist["allow"]["trees"]
        + allowlist["allow"]["patterns"]
        + allowlist["exclude"]["patterns"]
    )
    assert all(entry == entry.strip() for entry in entries)
