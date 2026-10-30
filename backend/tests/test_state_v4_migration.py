# -*- coding: utf-8 -*-
"""Onboarding state v4: 11-step contract and v1/v2/v3 migration."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from services import onboarding_service as onboarding


V4_STEPS = (
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
)

V3_STEPS = (
    "welcome",
    "account",
    "dependencies",
    "kernel",
    "kernel_models",
    "moss",
    "loom",
    "clients",
    "preflight",
    "startup",
    "finish",
)

V2_STEPS = (
    "welcome",
    "account",
    "dependencies",
    "kernel",
    "kernel_models",
    "moss",
    "loom",
    "clients",
    "preflight",
    "finish",
)

PRIOR_TO_FINISH = V4_STEPS[:-1]

STARTUP_OK = onboarding.StartupStatus(
    runtime_state="promoted",
    validation_report={"ok": True, "state": "validated"},
    runtime_report={"state": "promoted", "promoted": True},
)


@pytest.fixture(autouse=True)
def _state(tmp_path, monkeypatch) -> Path:
    state_file = tmp_path / "state" / "onboarding_state.json"
    monkeypatch.setenv("AEUH_ONBOARDING_STATE", str(state_file))
    monkeypatch.delenv("AXEUH_ONBOARDING_STATE", raising=False)
    return state_file


def _seed(
    state_file: Path,
    *,
    version: int,
    completed: tuple[str, ...],
    skipped: tuple[str, ...] = (),
    completed_flag: bool | None = None,
    step_data: dict | None = None,
    legacy_step_data: dict | None = None,
    started_at: str | None = None,
    updated_at: str | None = None,
) -> dict:
    payload: dict = {
        "version": version,
        "completed_steps": list(completed),
        "skipped_steps": list(skipped),
    }
    if completed_flag is not None:
        payload["completed"] = completed_flag
    if step_data is not None:
        payload["step_data"] = step_data
    if legacy_step_data is not None:
        payload["legacy_step_data"] = legacy_step_data
    if started_at is not None:
        payload["started_at"] = started_at
    if updated_at is not None:
        payload["updated_at"] = updated_at
    state_file.parent.mkdir(parents=True, exist_ok=True)
    state_file.write_text(json.dumps(payload), encoding="utf-8")
    return payload


def _clean_preflight(monkeypatch) -> None:
    monkeypatch.setattr(
        onboarding,
        "run_preflight",
        lambda *args, **kwargs: {
            "checks": [],
            "can_proceed": True,
            "blocking_failures": [],
            "soft_failures": [],
            "summary": {},
        },
    )


def _synthetic(reason: str) -> dict:
    return {"migrated": True, "reason": reason, "enabled": False}


def test_fresh_state_exposes_eleven_step_v4_contract():
    state = onboarding.get_state()

    assert onboarding.STATE_VERSION == 4
    assert state["version"] == 4
    assert state["current_step"] == "welcome"
    assert tuple(onboarding._STEP_IDS) == V4_STEPS
    steps = onboarding.steps_metadata(state)
    assert len(steps) == 11
    assert [step["id"] for step in steps] == list(V4_STEPS)
    assert steps[5]["id"] == "xiaomi"
    assert steps[6]["id"] == "qq"
    assert steps[9]["id"] == "clients"
    assert steps[10]["id"] == "finish"
    assert all(
        step["id"] not in {"preflight", "startup"} for step in steps
    )

    xiaomi = steps[5]
    assert xiaomi["title"] == "小米健康云"
    assert xiaomi["required"] is True
    assert xiaomi["skippable"] is True
    assert xiaomi["auth"] == "password"
    qq = steps[6]
    assert qq["title"] == "QQ 网关"
    assert qq["required"] is True
    assert qq["skippable"] is True
    assert qq["auth"] == "password"
    moss = steps[7]
    assert moss["title"] == "MOSS 深度音频"
    assert moss["required"] is True
    assert moss["skippable"] is True
    assert moss["auth"] == "password"
    loom = steps[8]
    assert loom["title"] == "AI 助手"
    assert loom["required"] is True
    assert loom["skippable"] is True
    assert loom["auth"] == "password"
    clients = steps[9]
    assert clients["required"] is True
    assert clients["skippable"] is False
    finish = steps[10]
    assert finish["required"] is True
    assert finish["skippable"] is False
    assert finish["state"] == "pending"


def test_v3_completed_install_marks_v4_complete_without_regating(
    _state, monkeypatch
):
    started_at = "2026-01-01T00:00:00+00:00"
    updated_at = "2026-01-02T00:00:00+00:00"
    _seed(
        _state,
        version=3,
        completed=(
            "welcome",
            "account",
            "dependencies",
            "kernel",
            "kernel_models",
            "loom",
            "clients",
            "preflight",
            "startup",
            "finish",
        ),
        skipped=("moss",),
        step_data={
            "moss": {"choice": "skipped"},
            "preflight": {"allow_degraded": True},
            "startup": {"validated": True},
        },
        legacy_step_data={"admin": {"username": "legacy-admin"}},
        started_at=started_at,
        updated_at=updated_at,
    )

    state = onboarding.get_state()

    assert state["version"] == 4
    assert state["completed"] is True
    assert state["current_step"] is None
    assert state["completed_steps"] == [
        step_id for step_id in V4_STEPS if step_id != "moss"
    ]
    assert state["skipped_steps"] == ["moss"]
    assert "xiaomi" in state["completed_steps"]
    assert "qq" in state["completed_steps"]
    assert state["step_data"]["moss"] == {"choice": "skipped"}
    assert state["step_data"]["xiaomi"] == _synthetic("v3_upgrade")
    assert state["step_data"]["qq"] == _synthetic("v3_upgrade")
    assert "preflight" not in state["step_data"]
    assert "startup" not in state["step_data"]
    assert state["legacy_step_data"]["preflight"] == {
        "allow_degraded": True,
        "removed_in_v4": True,
    }
    assert state["legacy_step_data"]["startup"] == {
        "validated": True,
        "removed_in_v4": True,
    }
    assert state["legacy_step_data"]["admin"] == {"username": "legacy-admin"}
    assert state["started_at"] == started_at
    assert state["updated_at"] == updated_at
    assert onboarding.is_bootstrap_mode() is False

    _clean_preflight(monkeypatch)
    replayed = onboarding.record_step("finish", "completed")
    assert replayed["completed"] is True
    assert replayed["step_data"]["xiaomi"]["migrated"] is True


def test_v3_finish_skipped_still_yields_completed_v4_install(_state):
    _seed(
        _state,
        version=3,
        completed=(
            "welcome",
            "account",
            "dependencies",
            "kernel",
            "kernel_models",
            "loom",
            "clients",
            "preflight",
            "startup",
        ),
        skipped=("moss", "finish"),
    )

    state = onboarding.get_state()

    assert state["version"] == 4
    assert state["completed"] is True
    assert state["skipped_steps"] == ["moss"]
    assert "finish" in state["completed_steps"]
    assert "xiaomi" in state["completed_steps"]
    assert "qq" in state["completed_steps"]


def test_v3_in_progress_at_moss_skips_new_optional_steps(_state):
    _seed(
        _state,
        version=3,
        completed=("welcome", "account", "dependencies"),
        skipped=("kernel", "kernel_models"),
    )

    state = onboarding.get_state()

    assert state["version"] == 4
    assert state["completed"] is False
    assert state["completed_steps"] == [
        "welcome",
        "account",
        "dependencies",
    ]
    assert state["skipped_steps"] == [
        "kernel",
        "kernel_models",
        "xiaomi",
        "qq",
    ]
    assert state["current_step"] == "moss"
    assert state["step_data"]["xiaomi"] == _synthetic("v3_upgrade")
    assert state["step_data"]["qq"] == _synthetic("v3_upgrade")
    assert "finish" not in state["completed_steps"]


def test_v3_in_progress_at_clients_keeps_current_step(_state):
    _seed(
        _state,
        version=3,
        completed=(
            "welcome",
            "account",
            "dependencies",
            "moss",
            "loom",
        ),
        skipped=("kernel", "kernel_models"),
    )

    state = onboarding.get_state()

    assert state["version"] == 4
    assert state["current_step"] == "clients"
    assert state["completed"] is False
    assert state["skipped_steps"] == [
        "kernel",
        "kernel_models",
        "xiaomi",
        "qq",
    ]
    assert state["completed_steps"][-1] == "loom"


def test_v3_removed_step_ids_leave_state_and_step_data(_state):
    _seed(
        _state,
        version=3,
        completed=(
            "welcome",
            "account",
            "dependencies",
            "kernel",
            "kernel_models",
            "moss",
            "loom",
            "clients",
            "preflight",
            "startup",
        ),
        step_data={
            "preflight": {"soft_failures": []},
            "startup": {"validated": True},
            "clients": {"android": True},
        },
    )

    state = onboarding.get_state()

    assert "preflight" not in state["completed_steps"]
    assert "startup" not in state["completed_steps"]
    assert "preflight" not in state["skipped_steps"]
    assert "startup" not in state["skipped_steps"]
    assert state["step_data"] == {
        "clients": {"android": True},
        "xiaomi": _synthetic("v3_upgrade"),
        "qq": _synthetic("v3_upgrade"),
    }
    assert state["legacy_step_data"] == {
        "preflight": {"soft_failures": [], "removed_in_v4": True},
        "startup": {"validated": True, "removed_in_v4": True},
    }


def test_v2_completed_install_migrates_to_v4_without_regating(_state):
    _seed(
        _state,
        version=2,
        completed=V2_STEPS,
        completed_flag=True,
    )

    state = onboarding.get_state()

    assert state["version"] == 4
    assert state["completed"] is True
    assert state["completed_steps"] == list(V4_STEPS)
    assert state["skipped_steps"] == []
    assert state["step_data"]["xiaomi"] == _synthetic("v2_upgrade")
    assert state["step_data"]["qq"] == _synthetic("v2_upgrade")
    assert onboarding.is_bootstrap_mode() is False


def test_v2_in_progress_skips_new_optional_steps_and_keeps_finish_pending(
    _state,
):
    _seed(
        _state,
        version=2,
        completed=(
            "welcome",
            "account",
            "dependencies",
            "kernel",
            "kernel_models",
            "moss",
            "loom",
            "clients",
            "preflight",
        ),
    )

    state = onboarding.get_state()

    assert state["version"] == 4
    assert state["completed"] is False
    assert state["current_step"] == "finish"
    assert state["skipped_steps"] == ["xiaomi", "qq"]
    assert state["step_data"]["xiaomi"] == _synthetic("v2_upgrade")
    assert state["step_data"]["qq"] == _synthetic("v2_upgrade")


def test_v1_completed_install_reaches_v4_completed(_state):
    _seed(
        _state,
        version=1,
        completed=("preflight", "server", "admin", "clients"),
        completed_flag=True,
    )

    state = onboarding.get_state()

    assert state["version"] == 4
    assert state["completed"] is True
    assert state["legacy_upgraded"] is True
    assert state["completed_steps"] == list(V4_STEPS)
    assert state["step_data"]["xiaomi"] == _synthetic("v1_upgrade")
    assert state["step_data"]["qq"] == _synthetic("v1_upgrade")


def test_v1_in_progress_is_not_blocked_by_new_optional_steps(_state):
    _seed(
        _state,
        version=1,
        completed=("preflight", "server", "admin"),
        skipped=("integrations",),
    )

    state = onboarding.get_state()

    assert state["version"] == 4
    assert state["completed"] is False
    assert state["completed_steps"] == [
        "welcome",
        "account",
        "dependencies",
    ]
    assert state["skipped_steps"] == ["xiaomi", "qq", "moss"]
    assert state["current_step"] == "kernel"
    assert state["legacy_upgraded"] is True
    assert state["step_data"]["xiaomi"] == _synthetic("v1_upgrade")
    assert state["step_data"]["qq"] == _synthetic("v1_upgrade")


def test_v4_state_is_normalised_without_upgrade(_state):
    _seed(
        _state,
        version=4,
        completed=("account", "bogus", "welcome", "account"),
        skipped=("kernel", "account"),
    )

    state = onboarding.get_state()

    assert state["version"] == 4
    assert state["completed_steps"] == ["welcome", "account"]
    assert state["skipped_steps"] == ["kernel"]
    assert state["current_step"] == "dependencies"
    assert state["completed"] is False
    assert state["legacy_upgraded"] is False
    assert "xiaomi" not in state["skipped_steps"]


def test_removed_step_ids_are_rejected_by_record_step(_state):
    with pytest.raises(ValueError):
        onboarding.record_step("preflight", "completed")
    with pytest.raises(ValueError):
        onboarding.record_step("startup", "completed")
    assert not _state.exists()


def test_finish_requires_preflight_and_startup_after_v3_migration(
    _state, monkeypatch
):
    _seed(
        _state,
        version=3,
        completed=(
            "welcome",
            "account",
            "dependencies",
            "kernel",
            "kernel_models",
            "moss",
            "loom",
            "clients",
            "preflight",
            "startup",
        ),
    )
    _clean_preflight(monkeypatch)

    state = onboarding.get_state()
    assert state["current_step"] == "finish"
    assert state["skipped_steps"] == ["xiaomi", "qq"]

    with pytest.raises(onboarding.StartupRequired) as caught:
        onboarding.record_step("finish", "completed")

    assert caught.value.status_code == 409
    assert caught.value.code == "startup_required"
    assert "finish" not in onboarding.get_state()["completed_steps"]

    completed = onboarding.record_step(
        "finish", "completed", startup_status=STARTUP_OK
    )
    assert completed["completed"] is True
