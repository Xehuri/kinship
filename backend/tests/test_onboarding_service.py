# -*- coding: utf-8 -*-
"""T03: onboarding state persistence + read-only preflight checks.

All state and config writes are redirected into pytest tmp_path; the real
backend/data and config.yaml are never touched by this module.
"""
import json
import os
import shutil
import socket
import stat
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml

import auth as auth_module
from config import config as config_module
from services import onboarding_service as onboarding

_ORIGINAL_LOAD_LIVE_CONFIG = onboarding._load_live_config
_ORIGINAL_INSPECT_LOOM = onboarding._inspect_loom_for_preflight


STEP_IDS = [
    "welcome",
    "account",
    "dependencies",
    "kernel",
    "kernel_models",
    "xiaomi",
    "qq",
    "moss",
    "loom",
    "clients",
    "finish",
]

STARTUP_OK = onboarding.StartupStatus(
    runtime_state="promoted",
    validation_report={"ok": True, "state": "validated"},
    runtime_report={"state": "promoted", "promoted": True},
)

CHECK_IDS = [
    "python",
    "config",
    "frontend_dist",
    "ai_dir",
    "disk",
    "ports",
    "ssl",
    "kernel",
    "kernel_models",
    "loom",
    "ai_backend",
]

HARD_CHECK_IDS = {
    "python",
    "config",
    "frontend_dist",
    "disk",
    "ports",
    "ssl",
}
SOFT_CHECK_IDS = {
    "ai_dir",
    "kernel",
    "kernel_models",
    "loom",
    "ai_backend",
}

BASE_CONFIG = {
    "server": {"port": 18768},
    "ssl": {"enabled": False},
    "ai_backend": "opencode",
    "opencode": {
        "default_model": "test-model",
        "default_provider": "test-provider",
        "default_agent": "test-agent",
        "url": "http://127.0.0.1:4999",
    },
}


@pytest.fixture(autouse=True)
def _isolated_env(tmp_path, monkeypatch):
    """Redirect onboarding state + CONFIG_PATH to tmp_path for every test."""
    state_file = tmp_path / "state" / "onboarding_state.json"
    monkeypatch.setenv("AEUH_ONBOARDING_STATE", str(state_file))
    monkeypatch.delenv("AXEUH_ONBOARDING_STATE", raising=False)

    config_file = tmp_path / "config.yaml"
    config_file.write_text(
        yaml.safe_dump(BASE_CONFIG, allow_unicode=True), encoding="utf-8"
    )
    monkeypatch.setenv("CONFIG_PATH", str(config_file))

    original_config_path = config_module._CONFIG_PATH
    config_module.set_config_path(str(config_file))
    config_module.get_config.cache_clear()

    # 默认走原始配置回退路径；live ConfigStore 用例在单个测试里显式覆盖。
    monkeypatch.setattr(onboarding, "_load_live_config", lambda: None)
    # 预检中的模型/Loom 探测默认打桩，测试内按需覆盖；绝不联网。
    monkeypatch.setattr(
        onboarding, "_kernel_models_rows", lambda _root: _model_rows()
    )
    monkeypatch.setattr(
        onboarding,
        "_inspect_loom_for_preflight",
        lambda: {
            "found": True,
            "source": "config",
            "fingerprint": "abc12345",
            "reachable": True,
            "online": True,
            "errors": [],
        },
    )

    for name in (
        "AEUH_FRONTEND_DIST",
        "AXEUH_KERNEL_PYTHON",
        "AEUH_KERNEL_PYTHON",
        "LOOM_TOKEN",
        "AXEUH_ONBOARDING_BOOTSTRAP",
        "AXEUH_SETTINGS__SERVER__HTTP_PORT",
        "AXEUH_SETTINGS__SERVER__HTTPS_PORT",
        "AXEUH_SETTINGS__SERVER__PORT",
    ):
        monkeypatch.delenv(name, raising=False)

    yield SimpleNamespace(
        tmp_path=tmp_path, state_file=state_file, config_file=config_file
    )

    config_module.set_config_path(original_config_path or "")
    config_module.get_config.cache_clear()


@pytest.fixture
def fake_disk(monkeypatch):
    monkeypatch.setattr(
        onboarding.shutil,
        "disk_usage",
        lambda _path: SimpleNamespace(free=10 * 1024 ** 3),
    )


def _state_file() -> Path:
    return Path(os.environ["AEUH_ONBOARDING_STATE"])


def _alt_config(**overrides) -> dict:
    """Deep-copy BASE_CONFIG and apply either ``section.key`` or ``section``."""
    data = json.loads(json.dumps(BASE_CONFIG))
    for dotted, value in overrides.items():
        section, _, key = dotted.partition(".")
        if key:
            data.setdefault(section, {})[key] = value
        else:
            data[section] = value
    return data


def _reconfigure(config_file: Path, data: dict) -> None:
    config_file.write_text(
        yaml.safe_dump(data, allow_unicode=True), encoding="utf-8"
    )
    config_module.set_config_path(str(config_file))
    config_module.get_config.cache_clear()


def _checks(result: dict) -> dict:
    return {check["id"]: check for check in result["checks"]}


def _live_config(
    document: dict, degraded: tuple[str, ...] = ()
) -> onboarding._LiveConfigSnapshot:
    return onboarding._LiveConfigSnapshot(document=document, degraded=degraded)


_REQUIRED_MODELS = (
    ("eres2netv2", 74_138_036),
    ("sensevoice", 940_019_376),
    ("fsmn-vad", 4_033_603),
    ("pyannote-segmentation", 11_964_742),
    ("pyannote-diarization", 21_854_050),
    ("wespeaker", 53_300_994),
)


def _model_rows(
    *, required_present: bool = True, optional_present: bool = True
) -> list[dict]:
    rows = [
        {
            "id": model_id,
            "tier": "required",
            "present": required_present,
            "size_bytes": size,
            "error": None if required_present else "target_missing",
        }
        for model_id, size in _REQUIRED_MODELS
    ]
    rows.append(
        {
            "id": "cnn14",
            "tier": "optional",
            "present": optional_present,
            "size_bytes": 358_670_570,
            "error": None if optional_present else "target_missing",
        }
    )
    return rows


LIVE_CONFIG = {
    "server": {"port": 19768},
    "ssl": {"enabled": False, "cert": "", "key": ""},
    "ai_backend": "opencode",
    "opencode": {
        "default_agent": "live-agent",
        "default_model": "live-model",
        "default_provider": "live-provider",
        "url": "http://127.0.0.1:4096",
        "directory": "ai",
    },
    "data": {"dir": "ai/data"},
}


def _make_project(
    root: Path,
    *,
    dist: bool = True,
    ai: bool = True,
    kernel: bool = True,
    certs: bool = False,
) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    if dist:
        dist_dir = root / "frontend" / "mobile" / "dist"
        dist_dir.mkdir(parents=True, exist_ok=True)
        (dist_dir / "index.html").write_text("<!doctype html>", encoding="utf-8")
    if ai:
        ai_dir = root / "ai"
        ai_dir.mkdir()
        (ai_dir / "AGENTS.md").write_text("# ai", encoding="utf-8")
    if kernel:
        package = root / "kernel" / "axeuh_kernel"
        package.mkdir(parents=True)
        (package / "__init__.py").write_text('__version__ = "0.0.0"\n', encoding="utf-8")
    if certs:
        cert_dir = root / "certs"
        cert_dir.mkdir()
        (cert_dir / "cert.pem").write_text("CERT", encoding="utf-8")
        (cert_dir / "key.pem").write_text("KEY", encoding="utf-8")
    return root


def _snapshot(root: Path) -> dict:
    return {
        str(path.relative_to(root)): (
            path.stat().st_size,
            path.stat().st_mtime_ns,
            path.is_dir(),
        )
        for path in sorted(root.rglob("*"))
    }


# ---------------------------------------------------------------------------
# Step model
# ---------------------------------------------------------------------------


def test_steps_are_ordered_dataclasses():
    import dataclasses

    assert [step.id for step in onboarding.STEPS] == STEP_IDS
    for step in onboarding.STEPS:
        assert dataclasses.is_dataclass(step)
        assert isinstance(step.title, str) and step.title
        assert isinstance(step.description, str) and step.description
        assert step.apply_strategy in {
            "hot",
            "reconnect",
            "respawn",
            "deployment",
            "none",
        }


def test_steps_apply_strategy_matches_config_lifecycle():
    strategies = {step.id: step.apply_strategy for step in onboarding.STEPS}
    assert strategies == {
        "welcome": "none",
        "account": "none",
        "dependencies": "none",
        "kernel": "none",
        "kernel_models": "none",
        "xiaomi": "hot",
        "qq": "reconnect",
        "moss": "reconnect",
        "loom": "hot",
        "clients": "none",
        "finish": "none",
    }


def test_step_config_changes_ignore_passive_steps():
    assert onboarding.step_config_changes("welcome", {}) == {}
    assert onboarding.step_config_changes("account", {"username": "alice"}) == {}
    assert onboarding.step_config_changes("clients", {}) == {}
    assert onboarding.step_config_changes("finish", {}) == {}


def test_step_config_changes_dependencies_and_kernel():
    deps = onboarding.step_config_changes(
        "dependencies",
        {"choice": "decline", "tiers": ["required"], "models_dir": "/tmp/models"},
        {},
    )
    assert deps == {
        "onboarding.allow_model_download": False,
        "onboarding.model_tiers": ["required"],
        "models.dir": "/tmp/models",
    }

    kernel = onboarding.step_config_changes(
        "kernel",
        {"python": "/tmp/.venv-kernel/bin/python", "device": "gpu"},
        {},
    )
    assert kernel == {
        "kernel.python": "/tmp/.venv-kernel/bin/python",
        "kernel.device": "gpu",
    }


def test_step_config_changes_moss_keeps_three_keys():
    changes = onboarding.step_config_changes(
        "moss",
        {"enabled": True},
        {
            "moss": {
                "enabled": False,
                "base_url": "http://127.0.0.1:8100",
                "model": "moss-audio-4b",
            }
        },
    )
    assert changes == {
        "moss.enabled": True,
        "moss.base_url": "http://127.0.0.1:8100",
        "moss.model": "moss-audio-4b",
    }


def test_step_config_changes_loom_and_type_guards():
    assert onboarding.step_config_changes("loom", {"port": 5100}, {}) == {
        "ai_backend": "loom",
        "loom.url": "http://127.0.0.1:5100",
    }
    assert onboarding.step_config_changes("xiaomi", {"enabled": "yes"}, {}) == {}
    assert onboarding.step_config_changes("qq", {"enabled": True}, {}) == {
        "qq_gateway.enabled": True
    }


def test_gate_should_block_uses_completed_state(tmp_path, monkeypatch):
    path = tmp_path / "onboarding_state.json"
    monkeypatch.setenv("AEUH_ONBOARDING_STATE", str(path))
    monkeypatch.delenv("AXEUH_ONBOARDING_STATE", raising=False)

    assert onboarding.gate_should_block() is False
    path.write_text(json.dumps({"version": 4, "completed_steps": []}), encoding="utf-8")
    assert onboarding.gate_should_block() is True
    path.write_text(
        json.dumps(
            {"version": 4, "completed_steps": [step.id for step in onboarding.STEPS]}
        ),
        encoding="utf-8",
    )
    assert onboarding.gate_should_block() is False


def test_gate_should_block_opens_after_phase1_steps(tmp_path, monkeypatch):
    path = tmp_path / "onboarding_state.json"
    monkeypatch.setenv("AEUH_ONBOARDING_STATE", str(path))
    monkeypatch.delenv("AXEUH_ONBOARDING_STATE", raising=False)

    def write(*, completed=(), skipped=()):
        path.write_text(
            json.dumps(
                {
                    "version": 4,
                    "completed_steps": list(completed),
                    "skipped_steps": list(skipped),
                }
            ),
            encoding="utf-8",
        )

    write(completed=["welcome", "account"])
    assert onboarding.gate_should_block() is True

    write(completed=["welcome", "account", "dependencies"])
    assert onboarding.gate_should_block() is False
    assert onboarding.get_state()["completed"] is False

    write(completed=["account", "dependencies"])
    assert onboarding.gate_should_block() is False

    write(completed=["welcome", "account"], skipped=["kernel"])
    assert onboarding.gate_should_block() is True

    write(completed=["welcome", "dependencies"], skipped=["account"])
    assert onboarding.gate_should_block() is False


def test_steps_required_and_skippable_contract():
    required = {step.id for step in onboarding.STEPS if step.required}
    skippable = {step.id for step in onboarding.STEPS if step.skippable}

    assert required == set(STEP_IDS)
    assert skippable == {
        "kernel",
        "kernel_models",
        "xiaomi",
        "qq",
        "moss",
        "loom",
    }
    assert onboarding.SKIPPABLE_STEPS == skippable
    assert onboarding.STATE_VERSION == 4
    assert onboarding._PASSIVE_STEP_IDS == {"welcome"}
    assert onboarding.STEPS[9].id == "clients"
    assert onboarding.STEPS[10].id == "finish"


# ---------------------------------------------------------------------------
# State persistence
# ---------------------------------------------------------------------------


def test_default_state_path_is_backend_data(monkeypatch):
    monkeypatch.delenv("AEUH_ONBOARDING_STATE", raising=False)
    monkeypatch.delenv("AXEUH_ONBOARDING_STATE", raising=False)
    expected = (
        Path(onboarding.__file__).resolve().parents[1]
        / "data"
        / "onboarding_state.json"
    )
    assert onboarding._state_path() == expected


def test_state_path_prefers_axueh_alias_when_both_set(tmp_path, monkeypatch):
    legacy = tmp_path / "legacy-state.json"
    preferred = tmp_path / "preferred-state.json"
    monkeypatch.setenv("AEUH_ONBOARDING_STATE", str(legacy))
    monkeypatch.setenv("AXEUH_ONBOARDING_STATE", str(preferred))

    assert onboarding._state_path() == preferred


def test_state_path_accepts_axueh_alias_alone(tmp_path, monkeypatch):
    monkeypatch.delenv("AEUH_ONBOARDING_STATE")
    monkeypatch.setenv("AXEUH_ONBOARDING_STATE", str(tmp_path / "axueh.json"))

    assert onboarding._state_path() == tmp_path / "axueh.json"


def test_default_state_when_file_missing():
    state = onboarding.get_state()

    assert set(state) == {
        "version",
        "completed_steps",
        "skipped_steps",
        "current_step",
        "completed",
        "legacy_upgraded",
        "started_at",
        "updated_at",
    }
    assert state["version"] == onboarding.STATE_VERSION
    assert state["completed_steps"] == []
    assert state["skipped_steps"] == []
    assert state["current_step"] == "welcome"
    assert state["completed"] is False
    assert state["legacy_upgraded"] is False
    datetime.fromisoformat(state["started_at"])
    datetime.fromisoformat(state["updated_at"])
    assert not _state_file().exists()


def test_record_in_order_advances_current_step():
    first = onboarding.record_step("welcome", "completed")
    assert first["current_step"] == "account"

    second = onboarding.record_step("account", "completed")
    assert second["completed_steps"] == ["welcome", "account"]
    assert second["skipped_steps"] == []
    assert second["current_step"] == "dependencies"
    assert second["completed"] is False
    assert second["started_at"] == first["started_at"]

    assert json.loads(_state_file().read_text(encoding="utf-8")) == second


def test_passive_welcome_is_auto_completed_by_account():
    state = onboarding.record_step("account", "completed")

    assert state["completed_steps"] == ["welcome", "account"]
    assert state["current_step"] == "dependencies"

    persisted = json.loads(_state_file().read_text(encoding="utf-8"))
    assert persisted["completed_steps"] == ["welcome", "account"]


def test_idempotent_re_record_does_not_rewrite():
    onboarding.record_step("welcome", "completed")
    path = _state_file()
    fixed_ns = 1_600_000_000_000_000_000
    os.utime(path, ns=(fixed_ns, fixed_ns))
    before = path.read_bytes()

    again = onboarding.record_step("welcome", "completed")

    assert again["completed_steps"] == ["welcome"]
    assert path.read_bytes() == before
    assert path.stat().st_mtime_ns == fixed_ns


def test_out_of_order_raises_and_preserves_state():
    with pytest.raises(onboarding.StepOutOfOrder):
        onboarding.record_step("finish", "completed")
    assert not _state_file().exists()

    onboarding.record_step("welcome", "completed")
    with pytest.raises(onboarding.StepOutOfOrder):
        onboarding.record_step("finish", "completed")

    assert onboarding.get_state()["current_step"] == "account"


def test_all_steps_done_marks_complete():
    statuses = {
        step_id: "skipped" if step_id in onboarding.SKIPPABLE_STEPS else "completed"
        for step_id in STEP_IDS
    }
    for step_id in STEP_IDS:
        onboarding.record_step(
            step_id, statuses[step_id], startup_status=STARTUP_OK
        )

    state = onboarding.get_state()
    assert state["completed"] is True
    assert state["current_step"] is None
    assert state["completed_steps"] == [
        step_id for step_id in STEP_IDS if step_id not in onboarding.SKIPPABLE_STEPS
    ]
    assert state["skipped_steps"] == [
        step_id for step_id in STEP_IDS if step_id in onboarding.SKIPPABLE_STEPS
    ]
    assert json.loads(_state_file().read_text(encoding="utf-8"))["completed"] is True


def test_finish_requires_every_prior_step_done():
    onboarding.record_step("welcome", "completed")
    onboarding.record_step("account", "completed")

    with pytest.raises(onboarding.StepOutOfOrder):
        onboarding.record_step("finish", "completed")

    state = onboarding.get_state()
    assert "finish" not in state["completed_steps"]
    assert state["current_step"] == "dependencies"


def test_finish_requires_all_prior_steps_and_startup_status():
    for step_id in STEP_IDS:
        if step_id == "finish":
            continue
        status = (
            "skipped" if step_id in onboarding.SKIPPABLE_STEPS else "completed"
        )
        onboarding.record_step(step_id, status)

    with pytest.raises(onboarding.StartupRequired):
        onboarding.record_step("finish", "completed")

    state = onboarding.record_step(
        "finish", "completed", startup_status=STARTUP_OK
    )
    assert state["completed"] is True
    assert state["completed_steps"] == [
        step_id
        for step_id in STEP_IDS
        if step_id not in onboarding.SKIPPABLE_STEPS
    ]
    assert state["skipped_steps"] == [
        step_id
        for step_id in STEP_IDS
        if step_id in onboarding.SKIPPABLE_STEPS
    ]


def test_record_validates_step_id_and_status():
    with pytest.raises(ValueError):
        onboarding.record_step("bogus", "completed")
    with pytest.raises(ValueError):
        onboarding.record_step("preflight", "completed")
    with pytest.raises(ValueError):
        onboarding.record_step("startup", "completed")
    with pytest.raises(ValueError):
        onboarding.record_step("welcome", "done")
    with pytest.raises(ValueError):
        onboarding.record_step("dependencies", "skipped")
    with pytest.raises(ValueError):
        onboarding.record_step("clients", "skipped")
    with pytest.raises(ValueError):
        onboarding.record_step("finish", "skipped")
    assert not _state_file().exists()


def test_dry_run_does_not_write_or_create_file():
    preview = onboarding.record_step("welcome", "completed", dry_run=True)
    assert preview["completed_steps"] == ["welcome"]
    assert preview["current_step"] == "account"
    assert not _state_file().exists()

    onboarding.record_step("welcome", "completed")
    path = _state_file()
    fixed_ns = 1_600_000_000_000_000_000
    os.utime(path, ns=(fixed_ns, fixed_ns))
    before = path.read_bytes()

    preview = onboarding.record_step("account", "completed", dry_run=True)

    assert preview["completed_steps"] == ["welcome", "account"]
    assert preview["current_step"] == "dependencies"
    assert path.read_bytes() == before
    assert path.stat().st_mtime_ns == fixed_ns
    assert onboarding.get_state()["current_step"] == "account"


def test_state_file_written_with_0600_mode():
    onboarding.record_step("welcome", "completed")
    mode = stat.S_IMODE(_state_file().stat().st_mode)
    assert mode == 0o600


def test_corrupt_state_is_quarantined_and_reset():
    path = _state_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{ not json", encoding="utf-8")

    state = onboarding.get_state()

    assert state["completed_steps"] == []
    assert not path.exists()
    backups = list(path.parent.glob("onboarding_state.json.corrupt-*"))
    assert len(backups) == 1
    assert backups[0].read_text(encoding="utf-8") == "{ not json"
    assert onboarding.get_state()["current_step"] == "welcome"


def test_non_object_state_is_treated_as_corrupt():
    path = _state_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("[]", encoding="utf-8")

    assert onboarding.get_state()["completed"] is False
    assert len(list(path.parent.glob("onboarding_state.json.corrupt-*"))) == 1


def test_step_data_is_copied_not_aliased():
    payload = {"note": "first", "nested": {"value": 1}}
    state = onboarding.record_step("welcome", "completed", data=payload)

    payload["nested"]["value"] = 99
    state["step_data"]["welcome"]["nested"]["value"] = 77

    fresh = onboarding.get_state()
    assert fresh["step_data"]["welcome"]["nested"]["value"] == 1


def test_get_state_returns_isolated_copy():
    onboarding.record_step("welcome", "completed")
    first = onboarding.get_state()
    first["completed_steps"].append("account")

    assert onboarding.get_state()["completed_steps"] == ["welcome"]


def test_concurrent_records_are_serialized():
    def _record(_index):
        return onboarding.record_step("welcome", "completed")

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(_record, range(24)))

    state = onboarding.get_state()
    assert state["completed_steps"] == ["welcome"]
    assert json.loads(_state_file().read_text(encoding="utf-8"))["version"] == 4


# ---------------------------------------------------------------------------
# legacy_complete
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "users_exist,degraded,expected",
    [
        (True, False, True),
        (False, False, False),
        (True, True, False),
        (False, True, False),
    ],
)
def test_legacy_complete_without_state_file(users_exist, degraded, expected):
    assert onboarding.legacy_complete(users_exist, degraded) is expected


def test_legacy_complete_state_file_overrides_heuristic():
    onboarding.record_step("welcome", "completed")
    assert onboarding.legacy_complete(True, False) is False

    for step_id in STEP_IDS[1:]:
        onboarding.record_step(step_id, "completed", startup_status=STARTUP_OK)

    assert onboarding.legacy_complete(False, True) is True


# ---------------------------------------------------------------------------
# v1 -> v4 migration
# ---------------------------------------------------------------------------


def _write_raw_state(payload: dict) -> Path:
    path = _state_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return path


def test_v1_completed_state_migrates_to_all_v4_completed():
    _write_raw_state(
        {
            "version": 1,
            "completed_steps": [
                "preflight",
                "server",
                "ssl",
                "ai_backend",
                "data",
                "admin",
                "integrations",
                "clients",
            ],
            "skipped_steps": [],
            "current_step": "finish",
            "completed": True,
            "started_at": "2026-01-01T00:00:00+00:00",
            "updated_at": "2026-01-02T00:00:00+00:00",
        }
    )

    state = onboarding.get_state()

    assert state["version"] == 4
    assert state["completed"] is True
    assert state["current_step"] is None
    assert state["completed_steps"] == list(STEP_IDS)
    assert state["skipped_steps"] == []
    assert state["legacy_upgraded"] is True
    assert state["started_at"] == "2026-01-01T00:00:00+00:00"
    assert state["updated_at"] == "2026-01-02T00:00:00+00:00"
    assert onboarding.record_step("finish", "completed")["completed"] is True


def test_v1_incomplete_maps_known_ids_and_drops_retired_ones():
    _write_raw_state(
        {
            "version": 1,
            "completed_steps": ["preflight", "server", "admin"],
            "skipped_steps": ["ssl", "integrations", "finish", "bogus"],
            "completed": False,
            "step_data": {
                "admin": {"username": "alice"},
                "server": {"http_port": 8769},
                "finish": {"note": "old"},
            },
        }
    )

    state = onboarding.get_state()

    assert state["version"] == 4
    assert state["completed"] is False
    assert state["completed_steps"] == ["welcome", "account", "dependencies"]
    assert state["skipped_steps"] == ["xiaomi", "qq", "moss"]
    assert state["current_step"] == "kernel"
    assert state["legacy_upgraded"] is True
    assert "preflight" not in state["skipped_steps"]
    assert set(state["legacy_step_data"]) == {"admin", "server"}
    assert state["step_data"]["finish"] == {"note": "old"}
    for step_id in ("kernel", "kernel_models", "loom"):
        assert step_id not in state["completed_steps"]
        assert step_id not in state["skipped_steps"]


def test_state_without_version_is_treated_as_v1():
    _write_raw_state(
        {
            "completed_steps": ["preflight", "admin"],
            "skipped_steps": [],
            "completed": False,
        }
    )

    state = onboarding.get_state()

    assert state["version"] == 4
    assert state["completed_steps"] == ["welcome", "account"]
    assert state["legacy_upgraded"] is True


def test_v4_state_orders_filters_and_recomputes_completed():
    _write_raw_state(
        {
            "version": 4,
            "completed_steps": ["account", "bogus", "welcome", "account"],
            "skipped_steps": ["kernel", "account"],
            "completed": True,
            "legacy_upgraded": False,
        }
    )

    state = onboarding.get_state()

    assert state["version"] == 4
    assert state["completed_steps"] == ["welcome", "account"]
    assert state["skipped_steps"] == ["kernel"]
    assert state["current_step"] == "dependencies"
    assert state["completed"] is False
    assert state["legacy_upgraded"] is False


# ---------------------------------------------------------------------------
# bootstrap / legacy install detection
# ---------------------------------------------------------------------------


def test_ensure_fresh_state_creates_v4_default_for_new_install(monkeypatch):
    monkeypatch.setattr(auth_module, "is_setup_required", lambda: True)
    assert not _state_file().exists()

    assert onboarding.ensure_fresh_state() is True

    raw = json.loads(_state_file().read_text(encoding="utf-8"))
    assert raw["version"] == onboarding.STATE_VERSION == 4
    assert raw["completed_steps"] == []
    assert raw["completed"] is False
    assert raw["current_step"] == "welcome"
    assert stat.S_IMODE(_state_file().stat().st_mode) == 0o600
    assert onboarding.ensure_fresh_state() is False


def test_ensure_fresh_state_leaves_legacy_install_untouched(monkeypatch):
    monkeypatch.setattr(auth_module, "is_setup_required", lambda: False)

    assert onboarding.ensure_fresh_state() is False
    assert not _state_file().exists()
    assert onboarding.legacy_complete(True, False) is True


def test_ensure_fresh_state_skips_unknown_auth_state(monkeypatch):
    def _fail():
        raise RuntimeError("auth unavailable")

    monkeypatch.setattr(auth_module, "is_setup_required", _fail)

    assert onboarding.ensure_fresh_state() is False
    assert not _state_file().exists()


def test_is_legacy_install_when_users_exist_without_state_file(monkeypatch):
    monkeypatch.setattr(auth_module, "is_setup_required", lambda: False)

    assert onboarding.is_legacy_install() is True
    assert onboarding.is_bootstrap_mode() is False


def test_new_install_without_users_or_state_is_bootstrap(monkeypatch):
    monkeypatch.setattr(auth_module, "is_setup_required", lambda: True)

    assert onboarding.is_legacy_install() is False
    assert onboarding.is_bootstrap_mode() is True


def test_incomplete_state_with_users_opens_bootstrap(monkeypatch):
    monkeypatch.setattr(auth_module, "is_setup_required", lambda: False)
    onboarding.record_step("welcome", "completed")

    assert onboarding.is_legacy_install() is False
    assert onboarding.is_bootstrap_mode() is True

    for step_id in STEP_IDS[1:]:
        onboarding.record_step(step_id, "completed", startup_status=STARTUP_OK)

    assert onboarding.is_bootstrap_mode() is False


def test_legacy_v1_incomplete_state_does_not_gate_existing_users(monkeypatch):
    path = onboarding._state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "version": 1,
                "completed_steps": ["preflight"],
                "skipped_steps": [],
                "current_step": "server",
                "completed": False,
                "started_at": "2026-01-01T00:00:00+00:00",
                "updated_at": "2026-01-01T00:00:00+00:00",
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(auth_module, "is_setup_required", lambda: False)

    assert onboarding.is_bootstrap_mode() is False


def test_bootstrap_env_override_wins(monkeypatch):
    monkeypatch.setattr(auth_module, "is_setup_required", lambda: True)
    monkeypatch.setenv("AXEUH_ONBOARDING_BOOTSTRAP", "0")
    assert onboarding.is_bootstrap_mode() is False

    monkeypatch.setattr(auth_module, "is_setup_required", lambda: False)
    monkeypatch.delenv("AEUH_ONBOARDING_STATE", raising=False)
    monkeypatch.delenv("AXEUH_ONBOARDING_STATE", raising=False)
    monkeypatch.setenv("AXEUH_ONBOARDING_BOOTSTRAP", "1")
    assert onboarding.is_bootstrap_mode() is True


def test_completed_state_beats_bootstrap_env_override(monkeypatch):
    monkeypatch.setattr(auth_module, "is_setup_required", lambda: False)
    monkeypatch.setenv("AXEUH_ONBOARDING_BOOTSTRAP", "1")
    onboarding.record_step("welcome", "completed")
    assert onboarding.is_bootstrap_mode() is True

    for step_id in STEP_IDS[1:]:
        onboarding.record_step(step_id, "completed", startup_status=STARTUP_OK)

    assert onboarding.is_bootstrap_mode() is False


# ---------------------------------------------------------------------------
# Preflight checks
# ---------------------------------------------------------------------------


def test_preflight_returns_eleven_stable_checks(tmp_path, fake_disk, monkeypatch):
    root = _make_project(tmp_path / "project")
    monkeypatch.setenv("AEUH_KERNEL_PYTHON", sys.executable)

    result = onboarding.run_preflight(root)

    assert [check["id"] for check in result["checks"]] == CHECK_IDS
    assert len(result["checks"]) == 11
    assert len({check["id"] for check in result["checks"]}) == 11
    for check in result["checks"]:
        assert set(check) == {
            "id",
            "label",
            "status",
            "blocking",
            "category",
            "detail",
            "fix",
        }
        assert check["status"] in {"pass", "warn", "fail"}
        assert isinstance(check["blocking"], bool)
        assert isinstance(check["category"], str) and check["category"]
        assert isinstance(check["label"], str) and check["label"]
        assert isinstance(check["detail"], str) and check["detail"]
        assert isinstance(check["fix"], str)
        assert check["blocking"] is (check["id"] in HARD_CHECK_IDS)
    assert result["can_proceed"] is True
    assert result["blocking_failures"] == []
    assert result["soft_failures"] == []
    assert result["summary"] == {"pass": 11, "warn": 0, "fail": 0}
    assert all(check["status"] == "pass" for check in result["checks"])


def test_preflight_flags_missing_dist_ai_kernel(tmp_path, fake_disk):
    root = _make_project(tmp_path / "project", dist=False, ai=False, kernel=False)

    result = onboarding.run_preflight(root)
    checks = _checks(result)

    assert checks["frontend_dist"]["status"] == "fail"
    assert checks["ai_dir"]["status"] == "warn"
    assert checks["kernel"]["status"] == "warn"
    assert result["can_proceed"] is False


def test_preflight_frontend_dist_env_override(
    tmp_path, fake_disk, monkeypatch
):
    root = _make_project(tmp_path / "project", dist=False)
    override = tmp_path / "dist"
    override.mkdir()
    (override / "index.html").write_text("<!doctype html>", encoding="utf-8")

    monkeypatch.setenv("AEUH_FRONTEND_DIST", str(override))
    assert _checks(onboarding.run_preflight(root))["frontend_dist"]["status"] == "pass"

    monkeypatch.delenv("AEUH_FRONTEND_DIST")
    assert _checks(onboarding.run_preflight(root))["frontend_dist"]["status"] == "fail"


def test_preflight_kernel_warns_without_kernel_python(
    tmp_path, fake_disk, monkeypatch
):
    root = _make_project(tmp_path / "project")
    monkeypatch.setattr(
        onboarding.kernel_assets,
        "inspect",
        lambda _root: {
            "kernel": {"present": True, "source": "source", "version": "1.0"},
            "python": {"exists": False, "source": "none", "last_resort": False},
        },
    )

    check = _checks(onboarding.run_preflight(root))["kernel"]

    assert check["status"] == "warn"
    assert "解释器" in check["detail"]


def test_preflight_kernel_env_alias_satisfies_check(tmp_path, fake_disk, monkeypatch):
    root = _make_project(tmp_path / "project")
    monkeypatch.setenv("AEUH_KERNEL_PYTHON", sys.executable)

    assert _checks(onboarding.run_preflight(root))["kernel"]["status"] == "pass"


def test_preflight_ssl_disabled_passes_without_files(tmp_path, fake_disk):
    root = _make_project(tmp_path / "project")

    assert _checks(onboarding.run_preflight(root))["ssl"]["status"] == "pass"


def test_preflight_ssl_enabled_with_missing_files_blocks(
    tmp_path, fake_disk, _isolated_env
):
    root = _make_project(tmp_path / "project")
    _reconfigure(
        _isolated_env.config_file,
        _alt_config(
            **{
                "ssl": {
                    "enabled": True,
                    "cert": "certs/cert.pem",
                    "key": "certs/key.pem",
                }
            }
        ),
    )

    result = onboarding.run_preflight(root)
    check = _checks(result)["ssl"]

    assert check["status"] == "fail"
    assert "不存在" in check["detail"]
    assert "ssl" in result["blocking_failures"]
    assert result["can_proceed"] is False

    root_with_certs = _make_project(tmp_path / "project2", certs=True)
    assert (
        _checks(onboarding.run_preflight(root_with_certs))["ssl"]["status"] == "pass"
    )


def test_preflight_ssl_placeholder_values_warn(tmp_path, fake_disk, _isolated_env):
    root = _make_project(tmp_path / "project")
    _reconfigure(
        _isolated_env.config_file,
        _alt_config(
            **{
                "ssl": {
                    "enabled": True,
                    "cert": "path/to/your/cert.pem",
                    "key": "path/to/your/key.pem",
                }
            }
        ),
    )

    result = onboarding.run_preflight(root)
    check = _checks(result)["ssl"]

    assert check["status"] == "warn"
    assert "占位" in check["detail"]
    assert result["can_proceed"] is True


def test_preflight_ssl_empty_certificate_file_fails(tmp_path, fake_disk, _isolated_env):
    root = _make_project(tmp_path / "project")
    certs = root / "certs"
    certs.mkdir()
    (certs / "cert.pem").write_text("", encoding="utf-8")
    (certs / "key.pem").write_text("KEY", encoding="utf-8")
    _reconfigure(
        _isolated_env.config_file,
        _alt_config(
            **{
                "ssl": {
                    "enabled": True,
                    "cert": "certs/cert.pem",
                    "key": "certs/key.pem",
                }
            }
        ),
    )

    result = onboarding.run_preflight(root)

    assert _checks(result)["ssl"]["status"] == "fail"
    assert result["can_proceed"] is False


def test_preflight_config_example_shape_can_proceed_with_ssl_warn(
    tmp_path, fake_disk, _isolated_env, monkeypatch
):
    root = _make_project(tmp_path / "project")
    monkeypatch.setenv("AEUH_KERNEL_PYTHON", sys.executable)
    _reconfigure(
        _isolated_env.config_file,
        _alt_config(
            **{
                "ssl": {
                    "enabled": True,
                    "cert": "path/to/your/cert.pem",
                    "key": "path/to/your/key.pem",
                }
            }
        ),
    )

    result = onboarding.run_preflight(root)

    assert _checks(result)["ssl"]["status"] == "warn"
    assert result["can_proceed"] is True


def test_preflight_partial_config_without_ssl_warns(
    tmp_path, fake_disk, _isolated_env, monkeypatch
):
    root = _make_project(tmp_path / "project")
    monkeypatch.setenv("AEUH_KERNEL_PYTHON", sys.executable)
    _reconfigure(
        _isolated_env.config_file,
        {"server": {"port": 18768}},
    )

    result = onboarding.run_preflight(root)

    assert _checks(result)["ssl"]["status"] == "warn"
    assert result["can_proceed"] is True


def test_preflight_rejects_invalid_port(tmp_path, fake_disk, _isolated_env):
    root = _make_project(tmp_path / "project")
    _reconfigure(
        _isolated_env.config_file,
        _alt_config(**{"server": {"port": 80}}),
    )

    check = _checks(onboarding.run_preflight(root))["ports"]

    assert check["status"] == "fail"
    assert "invalid" in check["detail"]


def test_preflight_ports_prefer_env_overlay(
    tmp_path, fake_disk, monkeypatch
):
    root = _make_project(tmp_path / "project")
    monkeypatch.setenv("AXEUH_SETTINGS__SERVER__PORT", "19011")

    check = _checks(onboarding.run_preflight(root))["ports"]

    assert "19011" in check["detail"]


def test_preflight_port_owned_by_current_process_passes(
    tmp_path, fake_disk, _isolated_env
):
    root = _make_project(tmp_path / "project")
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        busy_port = listener.getsockname()[1]
        _reconfigure(
            _isolated_env.config_file,
            _alt_config(**{"server": {"port": busy_port}}),
        )

        check = _checks(onboarding.run_preflight(root))["ports"]

    assert check["status"] == "pass"
    assert f"port={busy_port} (in use: true)" in check["detail"]
    assert "当前服务监听" in check["detail"]


def test_preflight_port_owned_by_other_process_blocks(
    tmp_path, fake_disk, _isolated_env
):
    root = _make_project(tmp_path / "project")
    child = subprocess.Popen(
        [
            sys.executable,
            "-c",
            (
                "import socket,time;"
                "s=socket.socket();"
                "s.bind(('127.0.0.1',0));"
                "s.listen(1);"
                "print(s.getsockname()[1], flush=True);"
                "time.sleep(30)"
            ),
        ],
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        assert child.stdout is not None
        busy_port = int(child.stdout.readline().strip())
        _reconfigure(
            _isolated_env.config_file,
            _alt_config(**{"server": {"port": busy_port}}),
        )

        check = _checks(onboarding.run_preflight(root))["ports"]

        assert check["status"] == "fail"
        assert f"port={busy_port} (in use: true)" in check["detail"]
        assert f"pid={child.pid}" in check["detail"]
    finally:
        if child.poll() is None:
            os.kill(child.pid, 15)
        child.wait(timeout=5)


def test_preflight_port_owner_unknown_warns(
    tmp_path, fake_disk, _isolated_env, monkeypatch
):
    root = _make_project(tmp_path / "project")
    monkeypatch.setattr(onboarding, "_port_owner", lambda port: ("unknown", None))
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        busy_port = listener.getsockname()[1]
        _reconfigure(
            _isolated_env.config_file,
            _alt_config(**{"server": {"port": busy_port}}),
        )

        check = _checks(onboarding.run_preflight(root))["ports"]

    assert check["status"] == "warn"
    assert "无法识别占用进程" in check["detail"]


def test_preflight_config_unwritable_blocks(tmp_path, fake_disk, _isolated_env):
    root = _make_project(tmp_path / "project")
    _isolated_env.config_file.chmod(0o444)
    try:
        result = onboarding.run_preflight(root)
    finally:
        _isolated_env.config_file.chmod(0o600)

    check = _checks(result)["config"]

    assert check["status"] == "fail"
    assert "不可写" in check["detail"]
    assert "config" in result["blocking_failures"]
    assert result["can_proceed"] is False


def test_preflight_warns_when_config_missing(
    tmp_path, fake_disk, _isolated_env, monkeypatch
):
    root = _make_project(tmp_path / "project")
    missing = tmp_path / "absent.yaml"
    monkeypatch.setenv("CONFIG_PATH", str(missing))
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        free_port = probe.getsockname()[1]
    monkeypatch.setenv("AXEUH_SETTINGS__SERVER__PORT", str(free_port))
    config_module.set_config_path(str(missing))
    config_module.get_config.cache_clear()

    result = onboarding.run_preflight(root)
    checks = _checks(result)

    assert checks["config"]["status"] == "warn"
    assert "降级" in checks["config"]["detail"]
    assert checks["ssl"]["status"] == "warn"
    assert checks["ai_backend"]["status"] == "warn"
    assert result["can_proceed"] is True


def test_preflight_warns_when_config_unparseable(
    tmp_path, fake_disk, _isolated_env
):
    root = _make_project(tmp_path / "project")
    _isolated_env.config_file.write_text(
        "server: [unclosed", encoding="utf-8"
    )
    config_module.set_config_path(str(_isolated_env.config_file))

    checks = _checks(onboarding.run_preflight(root))

    assert checks["config"]["status"] == "warn"


def test_preflight_uses_live_store_snapshot_over_raw_file(
    tmp_path, fake_disk, _isolated_env, monkeypatch
):
    root = _make_project(tmp_path / "project")
    monkeypatch.setenv("AEUH_KERNEL_PYTHON", sys.executable)
    live_document = json.loads(json.dumps(LIVE_CONFIG))
    live_document["server"] = {"port": 19901}
    monkeypatch.setattr(
        onboarding, "_load_live_config", lambda: _live_config(live_document)
    )
    _reconfigure(
        _isolated_env.config_file,
        _alt_config(**{"server": {"port": 18001}}),
    )

    result = onboarding.run_preflight(root)
    checks = _checks(result)

    assert "19901" in checks["ports"]["detail"]
    assert checks["config"]["status"] == "pass"
    assert checks["ssl"]["status"] == "pass"
    assert checks["ai_backend"]["status"] == "pass"
    assert result["can_proceed"] is True


def test_preflight_reads_config_store_snapshot(
    tmp_path, fake_disk, monkeypatch
):
    import config.store as store_module

    root = _make_project(tmp_path / "project")
    monkeypatch.setenv("AEUH_KERNEL_PYTHON", sys.executable)
    live_document = json.loads(json.dumps(LIVE_CONFIG))
    live_document["server"] = {"port": 19801}

    class FakeStore:
        degraded: list[str] = []
        revision = "rev-live"
        provider_info = SimpleNamespace(kind="sqlite")

        def snapshot(self) -> dict:
            return live_document

    monkeypatch.setattr(
        store_module, "get_config_store", lambda: FakeStore()
    )
    monkeypatch.setattr(
        onboarding, "_load_live_config", _ORIGINAL_LOAD_LIVE_CONFIG
    )

    result = onboarding.run_preflight(root)
    checks = _checks(result)

    assert "19801" in checks["ports"]["detail"]
    assert checks["config"]["status"] == "pass"
    assert "provider=sqlite" in checks["config"]["detail"]
    assert result["can_proceed"] is True


def test_preflight_live_store_avoids_raw_config_missing_alarm(
    tmp_path, fake_disk, _isolated_env, monkeypatch
):
    root = _make_project(tmp_path / "project")
    monkeypatch.setenv("AEUH_KERNEL_PYTHON", sys.executable)
    monkeypatch.setattr(
        onboarding,
        "_load_live_config",
        lambda: _live_config(json.loads(json.dumps(LIVE_CONFIG))),
    )
    missing = tmp_path / "absent.yaml"
    monkeypatch.setenv("CONFIG_PATH", str(missing))
    config_module.set_config_path(str(missing))
    config_module.get_config.cache_clear()

    result = onboarding.run_preflight(root)
    check = _checks(result)["config"]

    assert check["status"] == "pass"
    assert "未找到配置文件" not in check["detail"]
    assert result["can_proceed"] is True


def test_preflight_live_store_read_only_provider_blocks(
    tmp_path, fake_disk, monkeypatch
):
    root = _make_project(tmp_path / "project")
    monkeypatch.setattr(
        onboarding,
        "_load_live_config",
        lambda: onboarding._LiveConfigSnapshot(
            document=json.loads(json.dumps(LIVE_CONFIG)), writable=False
        ),
    )

    result = onboarding.run_preflight(root)
    check = _checks(result)["config"]

    assert check["status"] == "fail"
    assert "只读" in check["detail"]
    assert "config" in result["blocking_failures"]
    assert result["can_proceed"] is False


def test_preflight_live_store_config_missing_is_warning(
    tmp_path, fake_disk, _isolated_env, monkeypatch
):
    root = _make_project(tmp_path / "project")
    live_document = json.loads(json.dumps(LIVE_CONFIG))
    live_document["ssl"] = {"enabled": True, "cert": "", "key": ""}
    monkeypatch.setattr(
        onboarding,
        "_load_live_config",
        lambda: _live_config(live_document, ("config_missing",)),
    )
    missing = tmp_path / "absent.yaml"
    monkeypatch.setenv("CONFIG_PATH", str(missing))
    config_module.set_config_path(str(missing))
    config_module.get_config.cache_clear()

    result = onboarding.run_preflight(root)
    checks = _checks(result)

    assert checks["config"]["status"] == "warn"
    assert "config_missing" in checks["config"]["detail"]
    assert "未找到配置文件" not in checks["config"]["detail"]
    assert checks["ssl"]["status"] == "warn"
    assert result["can_proceed"] is True


def test_preflight_live_store_supplies_loom_credentials(
    tmp_path, fake_disk, _isolated_env, monkeypatch
):
    root = _make_project(tmp_path / "project")
    live_document = json.loads(json.dumps(LIVE_CONFIG))
    live_document["ai_backend"] = "loom"
    live_document["loom"] = {
        "url": "http://127.0.0.1:5100",
        "token": "LIVE_LOOM_TOKEN_MARKER",
    }
    monkeypatch.setattr(
        onboarding, "_load_live_config", lambda: _live_config(live_document)
    )

    result = onboarding.run_preflight(root)
    check = _checks(result)["ai_backend"]

    assert check["status"] == "pass"
    assert "LIVE_LOOM_TOKEN_MARKER" not in json.dumps(result, ensure_ascii=False)


def test_preflight_warns_when_unconfigured(tmp_path, fake_disk, _isolated_env):
    root = _make_project(tmp_path / "project")
    data = _alt_config()
    for key in ("default_model", "default_provider", "default_agent"):
        data["opencode"].pop(key)
    _reconfigure(_isolated_env.config_file, data)

    checks = _checks(onboarding.run_preflight(root))

    assert checks["config"]["status"] == "warn"
    assert checks["ai_backend"]["status"] == "warn"
    assert checks["ssl"]["status"] == "pass"
    assert onboarding.run_preflight(root)["can_proceed"] is True


def test_preflight_open_degraded_when_loom_has_no_token(
    tmp_path, fake_disk, _isolated_env, monkeypatch
):
    root = _make_project(tmp_path / "project")
    data = _alt_config(**{"ai_backend": "loom"})
    data["loom"] = {"url": "http://127.0.0.1:5100"}
    _reconfigure(_isolated_env.config_file, data)

    assert _checks(onboarding.run_preflight(root))["ai_backend"]["status"] == "warn"

    monkeypatch.setenv("LOOM_TOKEN", "test-token")
    assert _checks(onboarding.run_preflight(root))["ai_backend"]["status"] == "pass"


def test_preflight_loom_token_file_counts_as_token(
    tmp_path, fake_disk, _isolated_env, monkeypatch
):
    root = _make_project(tmp_path / "project")
    data = _alt_config(**{"ai_backend": "loom"})
    data["loom"] = {
        "url": "http://127.0.0.1:5100",
        "token_file": "/tmp/loom-token.env",
    }
    _reconfigure(_isolated_env.config_file, data)
    monkeypatch.delenv("LOOM_TOKEN", raising=False)

    assert _checks(onboarding.run_preflight(root))["ai_backend"]["status"] == "pass"


def test_preflight_loom_credentials_file_counts_as_token(
    tmp_path, fake_disk, _isolated_env, monkeypatch
):
    root = _make_project(tmp_path / "project")
    data = _alt_config(**{"ai_backend": "loom"})
    data["loom"] = {
        "url": "http://127.0.0.1:5100",
        "credentials_file": "/tmp/loom-credentials.json",
    }
    _reconfigure(_isolated_env.config_file, data)
    monkeypatch.delenv("LOOM_TOKEN", raising=False)

    assert _checks(onboarding.run_preflight(root))["ai_backend"]["status"] == "pass"


def test_preflight_loom_requires_url(tmp_path, fake_disk, _isolated_env, monkeypatch):
    root = _make_project(tmp_path / "project")
    data = _alt_config(**{"ai_backend": "loom"})
    data["loom"] = {"token": "x"}
    _reconfigure(_isolated_env.config_file, data)
    monkeypatch.setenv("LOOM_TOKEN", "test-token")

    assert _checks(onboarding.run_preflight(root))["ai_backend"]["status"] == "warn"


def test_preflight_unknown_ai_backend_fails(tmp_path, fake_disk, _isolated_env):
    root = _make_project(tmp_path / "project")
    _reconfigure(
        _isolated_env.config_file, _alt_config(**{"ai_backend": "bogus"})
    )

    assert _checks(onboarding.run_preflight(root))["ai_backend"]["status"] == "fail"


def test_preflight_disk_below_one_gib_blocks(tmp_path, monkeypatch):
    root = _make_project(tmp_path / "project")
    monkeypatch.setattr(
        onboarding.shutil,
        "disk_usage",
        lambda _path: SimpleNamespace(free=512 * 1024 ** 2),
    )

    result = onboarding.run_preflight(root)
    check = _checks(result)["disk"]

    assert check["status"] == "fail"
    assert result["blocking_failures"] == ["disk"]
    assert result["can_proceed"] is False


def _patch_disk_roots(monkeypatch, tmp_path):
    models_target = tmp_path / "models-target"
    data_target = tmp_path / "data-target"
    models_target.mkdir()
    data_target.mkdir()
    monkeypatch.setattr(onboarding, "_paths_models_root", lambda: models_target)
    monkeypatch.setattr(onboarding, "_paths_data_root", lambda: data_target)
    return models_target, data_target


def test_preflight_disk_fails_when_models_root_is_small(tmp_path, monkeypatch):
    root = _make_project(tmp_path / "project")
    models_target, data_target = _patch_disk_roots(monkeypatch, tmp_path)
    monkeypatch.setattr(
        onboarding.shutil,
        "disk_usage",
        lambda path: SimpleNamespace(
            free=512 * 1024 ** 2
            if Path(path) == models_target
            else 10 * 1024 ** 3
        ),
    )

    result = onboarding.run_preflight(root)
    check = _checks(result)["disk"]

    assert check["status"] == "fail"
    assert str(models_target) in check["detail"]
    assert result["blocking_failures"] == ["disk"]


def test_preflight_disk_ignores_small_project_root_when_targets_are_large(
    tmp_path, monkeypatch
):
    root = _make_project(tmp_path / "project")
    models_target, data_target = _patch_disk_roots(monkeypatch, tmp_path)
    targets = {models_target, data_target}

    def usage(path):
        return SimpleNamespace(
            free=10 * 1024 ** 3
            if Path(path) in targets
            else 512 * 1024 ** 2
        )

    monkeypatch.setattr(onboarding.shutil, "disk_usage", usage)

    result = onboarding.run_preflight(root)
    check = _checks(result)["disk"]

    assert check["status"] == "pass"
    assert "disk" not in result["blocking_failures"]
    assert str(models_target) in check["detail"]
    assert str(data_target) in check["detail"]


def test_preflight_fails_on_old_python(tmp_path, fake_disk, monkeypatch):
    root = _make_project(tmp_path / "project")
    monkeypatch.setattr(onboarding.sys, "version_info", (3, 9, 0))

    assert _checks(onboarding.run_preflight(root))["python"]["status"] == "fail"


def test_preflight_makes_no_filesystem_changes(
    tmp_path, fake_disk, monkeypatch, _isolated_env
):
    root = _make_project(tmp_path / "project", certs=True)
    monkeypatch.setenv("AEUH_KERNEL_PYTHON", sys.executable)
    _reconfigure(
        _isolated_env.config_file,
        _alt_config(
            **{
                "ssl": {
                    "enabled": True,
                    "cert": "certs/cert.pem",
                    "key": "certs/key.pem",
                }
            }
        ),
    )
    before = _snapshot(root)

    result = onboarding.run_preflight(root)

    assert result["can_proceed"] is True
    assert _snapshot(root) == before
    assert not _isolated_env.state_file.exists()


def test_preflight_details_do_not_leak_secrets(
    tmp_path, fake_disk, _isolated_env
):
    root = _make_project(tmp_path / "project")
    secrets = [
        "LOOM_SECRET_MARKER_9f3",
        "OPENCODE_PASSWORD_MARKER_77",
        "DASHSCOPE_MARKER_42",
    ]
    data = _alt_config(**{"ai_backend": "loom"})
    data["loom"] = {"url": "http://127.0.0.1:5100", "token": secrets[0]}
    data["opencode"]["server_password"] = secrets[1]
    data["api"] = {"dashscope_key": secrets[2]}
    _reconfigure(_isolated_env.config_file, data)

    result = onboarding.run_preflight(root)
    dumped = json.dumps(result, ensure_ascii=False)

    for secret in secrets:
        assert secret not in dumped


def test_preflight_summary_counts_match_check_statuses(tmp_path, fake_disk):
    root = _make_project(tmp_path / "project", dist=False, ai=False)

    result = onboarding.run_preflight(root)
    counts = {"pass": 0, "warn": 0, "fail": 0}
    for check in result["checks"]:
        counts[check["status"]] += 1

    assert result["summary"] == counts
    assert sum(result["summary"].values()) == 11
    assert result["blocking_failures"] == ["frontend_dist"]
    assert result["soft_failures"] == ["ai_dir"]
    assert result["can_proceed"] is False


def test_preflight_soft_failure_alone_does_not_block(tmp_path, fake_disk):
    root = _make_project(tmp_path / "project", ai=False)

    result = onboarding.run_preflight(root)

    assert _checks(result)["ai_dir"]["status"] == "warn"
    assert result["blocking_failures"] == []
    assert result["soft_failures"] == ["ai_dir"]
    assert result["can_proceed"] is True


def test_preflight_kernel_inspect_is_passive_and_never_spawns(
    tmp_path, fake_disk, monkeypatch
):
    root = _make_project(tmp_path / "project")
    monkeypatch.setenv("AXEUH_KERNEL_STATE_DIR", str(tmp_path / "kernel-state"))
    monkeypatch.setattr(
        onboarding.kernel_assets,
        "_probe_health",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("health probe must not run without a pidfile")
        ),
    )
    monkeypatch.setattr(
        onboarding.subprocess,
        "Popen",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("preflight must never spawn the kernel")
        ),
    )

    check = _checks(onboarding.run_preflight(root))["kernel"]

    assert check["status"] == "pass"
    assert "kernel=source" in check["detail"]
    assert not (tmp_path / "kernel-state" / "kernel.pid").exists()


def test_preflight_kernel_models_required_missing_blocks_completion(
    tmp_path, fake_disk, monkeypatch
):
    root = _make_project(tmp_path / "project")
    monkeypatch.setattr(
        onboarding,
        "_kernel_models_rows",
        lambda _root: _model_rows(required_present=False),
    )

    result = onboarding.run_preflight(root)
    check = _checks(result)["kernel_models"]

    assert check["status"] == "fail"
    assert check["blocking"] is False
    assert "必需模型缺失" in check["detail"]
    assert result["blocking_failures"] == []
    assert "kernel_models" in result["soft_failures"]
    with pytest.raises(onboarding.PreflightBlocked):
        onboarding._evaluate_preflight_gate(result, {"allow_degraded": True})


def test_preflight_kernel_models_optional_missing_passes_with_note(
    tmp_path, fake_disk, monkeypatch
):
    root = _make_project(tmp_path / "project")
    monkeypatch.setattr(
        onboarding,
        "_kernel_models_rows",
        lambda _root: _model_rows(optional_present=False),
    )

    check = _checks(onboarding.run_preflight(root))["kernel_models"]

    assert check["status"] == "pass"
    assert "cnn14" in check["detail"]


def test_preflight_loom_reports_source_and_fingerprint_not_token(
    tmp_path, fake_disk, _isolated_env, monkeypatch
):
    root = _make_project(tmp_path / "project")
    secret = "LOOM_PREFLIGHT_SECRET_TOKEN"
    data = _alt_config(**{"ai_backend": "loom"})
    data["loom"] = {"url": "http://127.0.0.1:15100", "token": secret}
    _reconfigure(_isolated_env.config_file, data)
    monkeypatch.setattr(
        onboarding,
        "_inspect_loom_for_preflight",
        lambda: {
            "found": True,
            "source": "config",
            "fingerprint": "deadbeef",
            "reachable": False,
            "online": False,
            "errors": [{"code": "loom_unreachable", "message": "masked"}],
        },
    )

    result = onboarding.run_preflight(root)
    check = _checks(result)["loom"]
    dumped = json.dumps(result, ensure_ascii=False)

    assert check["status"] == "warn"
    assert "token_source=config" in check["detail"]
    assert "fingerprint=deadbeef" in check["detail"]
    assert secret not in dumped
    assert "loom" in result["soft_failures"]


def test_preflight_frontend_dist_downloading_warns_not_blocks(
    tmp_path, fake_disk, monkeypatch
):
    root = _make_project(tmp_path / "project", dist=False)
    monkeypatch.setattr(onboarding, "_frontend_download_active", lambda: True)

    result = onboarding.run_preflight(root)
    check = _checks(result)["frontend_dist"]

    assert check["status"] == "warn"
    assert check["blocking"] is True
    assert result["blocking_failures"] == []
    assert result["can_proceed"] is True


def test_preflight_probe_wrappers_use_short_timeouts(monkeypatch):
    from services import loom_onboarding

    calls: dict[str, object] = {}

    async def fake_inspect(*, timeout=None):
        calls["loom"] = timeout
        return {}

    monkeypatch.setattr(loom_onboarding, "inspect", fake_inspect)
    monkeypatch.setattr(
        onboarding, "_inspect_loom_for_preflight", _ORIGINAL_INSPECT_LOOM
    )

    onboarding._inspect_loom_for_preflight()

    assert calls["loom"] == onboarding._LOOM_PREFLIGHT_TIMEOUT_S
    assert onboarding._LOOM_PREFLIGHT_TIMEOUT_S <= 2.0


# ---------------------------------------------------------------------------
# Runtime config status (N14: no-config / degraded model)
# ---------------------------------------------------------------------------


def test_config_runtime_status_ok_for_valid_config(_isolated_env, monkeypatch):
    monkeypatch.setattr(onboarding, "_probe_store_status", lambda: None)

    status = onboarding.read_config_runtime_status()

    assert status.degraded is False
    assert isinstance(status.revision, str)


def test_config_runtime_status_degrades_when_config_missing(
    _isolated_env, monkeypatch
):
    monkeypatch.setattr(onboarding, "_probe_store_status", lambda: None)
    missing = _isolated_env.tmp_path / "absent.yaml"
    monkeypatch.setenv("CONFIG_PATH", str(missing))
    config_module.set_config_path(str(missing))
    config_module.get_config.cache_clear()

    status = onboarding.read_config_runtime_status()

    assert status.degraded is True
    assert "degraded" in status.detail


def test_config_runtime_status_reads_config_store(monkeypatch):
    import config.store as store_module

    class FakeStore:
        @property
        def degraded(self):
            return ["config_missing"]

        def is_degraded(self):
            return True

        @property
        def revision(self):
            return "rev-42"

        def provider_info(self):
            return SimpleNamespace(kind="yaml")

    monkeypatch.setattr(
        store_module, "get_config_store", lambda: FakeStore()
    )

    status = onboarding.read_config_runtime_status()

    assert status.degraded is True
    assert status.revision == "rev-42"
    assert status.provider == "yaml"


# ---------------------------------------------------------------------------
# Onboarding actions
# ---------------------------------------------------------------------------


def _make_template(root: Path) -> Path:
    template = root / "ai-template"
    (template / "data" / "tasks").mkdir(parents=True)
    (template / "AGENTS.md").write_text("# template", encoding="utf-8")
    (template / "data" / "tasks" / "sample.yaml").write_text(
        "name: sample\n", encoding="utf-8"
    )
    return template


def test_copy_ai_template_creates_ai_directory(tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    _make_template(root)

    result = onboarding.copy_ai_template(root)

    assert result["action"] == "copy_ai_template"
    assert result["copied"] is True
    assert result["overwritten"] is False
    assert result["files"] == 2
    assert (root / "ai" / "AGENTS.md").read_text(encoding="utf-8") == "# template"


def test_copy_ai_template_refuses_non_empty_target_without_overwrite(tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    _make_template(root)
    (root / "ai").mkdir()
    (root / "ai" / "AGENTS.md").write_text("# user", encoding="utf-8")

    with pytest.raises(onboarding.OnboardingActionError) as excinfo:
        onboarding.copy_ai_template(root)

    assert excinfo.value.status_code == 409
    assert excinfo.value.code == "already_exists"
    assert (root / "ai" / "AGENTS.md").read_text(encoding="utf-8") == "# user"
    assert not (root / "ai" / "data" / "tasks" / "sample.yaml").exists()


def test_copy_ai_template_blocks_existing_target_even_with_overwrite(tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    _make_template(root)
    (root / "ai").mkdir()
    (root / "ai" / "AGENTS.md").write_text("# user", encoding="utf-8")
    (root / "ai" / "keep.txt").write_text("keep", encoding="utf-8")

    with pytest.raises(onboarding.OnboardingActionError) as excinfo:
        onboarding.copy_ai_template(root, overwrite=True)

    assert excinfo.value.status_code == 409
    assert excinfo.value.code == "already_exists"
    assert (root / "ai" / "AGENTS.md").read_text(encoding="utf-8") == "# user"
    assert (root / "ai" / "keep.txt").read_text(encoding="utf-8") == "keep"
    assert not (root / "ai" / "data" / "tasks" / "sample.yaml").exists()


def test_default_project_root_respects_axueh_project_root(monkeypatch, tmp_path):
    monkeypatch.setenv("AXEUH_PROJECT_ROOT", str(tmp_path))
    assert onboarding.default_project_root() == tmp_path.resolve()


def test_copy_ai_template_blocks_existing_empty_ai_directory(tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    _make_template(root)
    (root / "ai").mkdir()

    with pytest.raises(onboarding.OnboardingActionError) as excinfo:
        onboarding.copy_ai_template(root)

    assert excinfo.value.status_code == 409
    assert excinfo.value.code == "already_exists"
    assert not (root / "ai" / "AGENTS.md").exists()


def test_copy_ai_template_reports_missing_template(tmp_path):
    root = tmp_path / "project"
    root.mkdir()

    with pytest.raises(onboarding.OnboardingActionError) as excinfo:
        onboarding.copy_ai_template(root)

    assert excinfo.value.status_code == 422
    assert excinfo.value.code == "template_missing"


def test_generate_self_signed_cert_reports_missing_openssl(tmp_path, monkeypatch):
    root = tmp_path / "project"
    root.mkdir()
    monkeypatch.setattr(onboarding.shutil, "which", lambda _name: None)

    with pytest.raises(onboarding.OnboardingActionError) as excinfo:
        onboarding.generate_self_signed_cert(root)

    assert excinfo.value.status_code == 422
    assert excinfo.value.code == "openssl_unavailable"


@pytest.mark.skipif(shutil.which("openssl") is None, reason="openssl unavailable")
def test_generate_self_signed_cert_creates_private_san_certificate(tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    config_file = root / "config.yaml"
    config_file.write_text("server: {}\n", encoding="utf-8")
    before = config_file.read_bytes()

    result = onboarding.generate_self_signed_cert(root)

    cert = Path(result["cert"])
    key = Path(result["key"])
    assert cert == root / "backend" / "config" / "certs" / "cert.pem"
    assert key == root / "backend" / "config" / "certs" / "key.pem"
    assert cert.is_file() and key.is_file()
    assert stat.S_IMODE(cert.stat().st_mode) == 0o600
    assert stat.S_IMODE(key.stat().st_mode) == 0o600
    assert config_file.read_bytes() == before
    text = subprocess.run(
        [
            shutil.which("openssl") or "openssl",
            "x509",
            "-in",
            str(cert),
            "-noout",
            "-text",
        ],
        capture_output=True,
        text=True,
        timeout=60,
        check=True,
    ).stdout
    assert "DNS:localhost" in text
    assert "IP Address:127.0.0.1" in text

    with pytest.raises(onboarding.OnboardingActionError) as excinfo:
        onboarding.generate_self_signed_cert(root)
    assert excinfo.value.status_code == 409
    assert excinfo.value.code == "already_exists"

    replaced = onboarding.generate_self_signed_cert(root, overwrite=True)
    assert replaced["overwritten"] is True
    assert stat.S_IMODE(Path(replaced["key"]).stat().st_mode) == 0o600


# ---------------------------------------------------------------------------
# ensure_ai_instance
# ---------------------------------------------------------------------------


def _make_ai_instance_template(root: Path) -> Path:
    template = root / "ai-template"
    (template / "agents").mkdir(parents=True)
    (template / "data" / "tasks").mkdir(parents=True)
    (template / "AGENTS.md").write_text("# template agents", encoding="utf-8")
    (template / "pyproject.toml").write_text("[project]\nname = \"x\"\n", encoding="utf-8")
    (template / "data" / "tasks" / ".keep").write_text("", encoding="utf-8")
    (template / "loom-config.example.yaml").write_text(
        "token: example\n", encoding="utf-8"
    )
    (template / "agents" / "sample.md").write_text("agent\n", encoding="utf-8")
    return template


def test_ensure_ai_instance_creates_directory_and_copies_template(tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    _make_ai_instance_template(root)

    result = onboarding.ensure_ai_instance(root, "ai")

    target = root / "ai"
    assert result["action"] == "ensure_ai_instance"
    assert result["target"] == str(target.resolve())
    assert result["created"] is True
    assert result["copied_files"] == 5
    assert result["existing_files"] == 0
    assert result["errors"] == []
    assert (target / "AGENTS.md").read_text(encoding="utf-8") == "# template agents"
    assert (target / "pyproject.toml").is_file()
    assert (target / "data" / "tasks" / ".keep").is_file()
    assert (target / "loom-config.example.yaml").is_file()
    assert (target / "agents" / "sample.md").read_text(encoding="utf-8") == "agent\n"
    assert not (target / ".loom").exists()


def test_ensure_ai_instance_is_idempotent(tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    _make_ai_instance_template(root)

    first = onboarding.ensure_ai_instance(root, "ai")
    second = onboarding.ensure_ai_instance(root, "ai")

    assert second["target"] == first["target"]
    assert second["created"] is False
    assert second["copied_files"] == 0
    assert second["existing_files"] == first["copied_files"]
    assert second["errors"] == []


def test_ensure_ai_instance_preserves_user_files_and_copies_new_template_files(
    tmp_path,
):
    root = tmp_path / "project"
    root.mkdir()
    template = _make_ai_instance_template(root)
    target = root / "ai"
    target.mkdir()
    (target / "AGENTS.md").write_text("# user edited", encoding="utf-8")
    (target / "keep.txt").write_text("keep", encoding="utf-8")

    first = onboarding.ensure_ai_instance(root, "ai")

    assert first["created"] is False
    assert first["existing_files"] == 1
    assert first["copied_files"] == 4
    assert (target / "AGENTS.md").read_text(encoding="utf-8") == "# user edited"
    assert (target / "keep.txt").read_text(encoding="utf-8") == "keep"

    (template / "new-notes.md").write_text("new\n", encoding="utf-8")
    second = onboarding.ensure_ai_instance(root, "ai")

    assert second["copied_files"] == 1
    assert (target / "new-notes.md").read_text(encoding="utf-8") == "new\n"
    assert (target / "AGENTS.md").read_text(encoding="utf-8") == "# user edited"
    assert (target / "keep.txt").read_text(encoding="utf-8") == "keep"


def test_ensure_ai_instance_completes_interrupted_copy_on_retry(tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    _make_ai_instance_template(root)

    onboarding.ensure_ai_instance(root, "ai")
    (root / "ai" / "pyproject.toml").unlink()

    retry = onboarding.ensure_ai_instance(root, "ai")

    assert retry["created"] is False
    assert retry["copied_files"] == 1
    assert (root / "ai" / "pyproject.toml").is_file()


def test_ensure_ai_instance_skips_internal_and_symlink_entries(tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    template = _make_ai_instance_template(root)
    for junk in (".git", "node_modules", "__pycache__", ".loom"):
        (template / junk).mkdir()
        (template / junk / "junk.txt").write_text("junk", encoding="utf-8")
    outside = tmp_path / "outside.txt"
    outside.write_text("outside", encoding="utf-8")
    (template / "linked.md").symlink_to(outside)

    onboarding.ensure_ai_instance(root, "ai")

    target = root / "ai"
    for junk in (".git", "node_modules", "__pycache__", ".loom"):
        assert not (target / junk).exists()
    assert not (target / "linked.md").exists()


def test_ensure_ai_instance_rejects_file_target(tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    _make_ai_instance_template(root)
    (root / "ai").write_text("not a directory", encoding="utf-8")

    with pytest.raises(onboarding.OnboardingActionInvalid) as excinfo:
        onboarding.ensure_ai_instance(root, "ai")

    assert excinfo.value.status_code == 422
    assert excinfo.value.code == "target_not_directory"
    assert (root / "ai").read_text(encoding="utf-8") == "not a directory"


def test_ensure_ai_instance_rejects_missing_template(tmp_path):
    root = tmp_path / "project"
    root.mkdir()

    with pytest.raises(onboarding.OnboardingActionInvalid) as excinfo:
        onboarding.ensure_ai_instance(root, "ai")

    assert excinfo.value.status_code == 422
    assert excinfo.value.code == "template_missing"
    assert not (root / "ai").exists()


def test_ensure_ai_instance_rejects_unsafe_targets(tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    _make_ai_instance_template(root)

    for unsafe in (str(Path("/")), str(Path.home())):
        with pytest.raises(onboarding.OnboardingActionInvalid) as excinfo:
            onboarding.ensure_ai_instance(root, unsafe)
        assert excinfo.value.status_code == 422
        assert excinfo.value.code == "unsafe_target"


def test_ensure_ai_instance_refuses_staging_target_outside_staging_root(
    tmp_path, monkeypatch
):
    staging = tmp_path / "staging"
    staging.mkdir()
    _make_ai_instance_template(staging)
    code_root = tmp_path / "code"
    (code_root / "ai").mkdir(parents=True)
    monkeypatch.setenv("AXEUH_PROJECT_ROOT", str(staging))

    with pytest.raises(onboarding.OnboardingActionInvalid) as excinfo:
        onboarding.ensure_ai_instance(
            staging, str(code_root / "ai"), code_repo_root=code_root
        )

    assert excinfo.value.status_code == 422
    assert excinfo.value.code == "staging_target_escape"
    assert list((code_root / "ai").iterdir()) == []


def test_ensure_ai_instance_allows_target_inside_staging_root(tmp_path, monkeypatch):
    code_root = tmp_path / "code"
    code_root.mkdir()
    _make_ai_instance_template(code_root)
    monkeypatch.setenv("AXEUH_PROJECT_ROOT", str(code_root))

    result = onboarding.ensure_ai_instance(code_root, "ai", code_repo_root=code_root)

    assert result["target"] == str((code_root / "ai").resolve())
    assert result["created"] is True


def test_ensure_ai_instance_uses_config_ai_root(
    tmp_path, _isolated_env, monkeypatch
):
    root = tmp_path / "project"
    root.mkdir()
    _make_ai_instance_template(root)
    configured = tmp_path / "configured-ai"
    monkeypatch.delenv("AXEUH_SETTINGS__DATA__AI_ROOT", raising=False)
    _reconfigure(
        _isolated_env.config_file,
        _alt_config(**{"data.ai_root": str(configured)}),
    )

    result = onboarding.ensure_ai_instance(root)

    assert result["target"] == str(configured.resolve())
    assert (configured / "AGENTS.md").is_file()
    assert not (root / "ai").exists()


def test_check_ai_dir_prefers_data_ai_root(tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    custom = root / "custom-ai"
    custom.mkdir()
    (custom / "AGENTS.md").write_text("# ai", encoding="utf-8")
    before = _snapshot(root)

    check = onboarding._check_ai_dir(root, {"data": {"ai_root": "custom-ai"}})

    assert check["status"] == "pass"
    assert str(custom) in check["detail"]
    assert _snapshot(root) == before


def test_check_ai_dir_uses_data_dir_parent_before_opencode_directory(tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    ai_dir = root / "data-root" / "ai"
    ai_dir.mkdir(parents=True)
    (ai_dir / "AGENTS.md").write_text("# ai", encoding="utf-8")
    document = {
        "data": {"dir": "data-root/ai/data"},
        "opencode": {"directory": "wrong-ai"},
    }

    check = onboarding._check_ai_dir(root, document)

    assert check["status"] == "pass"
    assert str(ai_dir) in check["detail"]
    assert not (root / "wrong-ai").exists()


def test_check_ai_dir_warns_for_missing_opencode_directory(tmp_path):
    root = tmp_path / "project"
    root.mkdir()

    check = onboarding._check_ai_dir(
        root, {"opencode": {"directory": "missing-ai"}}
    )

    assert check["status"] == "warn"
    assert "missing-ai" in check["detail"]
    assert list(root.iterdir()) == []
