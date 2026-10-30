# -*- coding: utf-8 -*-
"""T11: finish preflight/startup gate contract (hard 409, soft ack, ordering)."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from services import onboarding_finish
from services import onboarding_service as onboarding


HARD_IDS = (
    "python",
    "config",
    "frontend_dist",
    "disk",
    "ports",
    "ssl",
)

PRIOR_TO_FINISH = (
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
)

STARTUP_OK = onboarding.StartupStatus(
    runtime_state="promoted",
    validation_report={"ok": True, "state": "validated"},
    runtime_report={"state": "promoted", "promoted": True},
)


def _checks(
    *, blocking: tuple[str, ...] = (), soft: tuple[str, ...] = ()
) -> list[dict]:
    checks: list[dict] = []
    for check_id in onboarding.CHECK_IDS:
        blocking_flag = check_id in HARD_IDS
        if check_id in blocking:
            status = "fail"
        elif check_id in soft:
            status = "warn"
        else:
            status = "pass"
        checks.append(
            {
                "id": check_id,
                "label": check_id,
                "status": status,
                "blocking": blocking_flag,
                "category": "test",
                "detail": f"{check_id} detail",
                "fix": "",
            }
        )
    return checks


def _result(
    *, blocking: tuple[str, ...] = (), soft: tuple[str, ...] = ()
) -> dict:
    checks = _checks(blocking=blocking, soft=soft)
    return {
        "checks": checks,
        "can_proceed": not blocking,
        "blocking_failures": list(blocking),
        "soft_failures": list(soft),
        "summary": {
            "pass": sum(1 for check in checks if check["status"] == "pass"),
            "warn": sum(1 for check in checks if check["status"] == "warn"),
            "fail": sum(1 for check in checks if check["status"] == "fail"),
        },
    }


@pytest.fixture(autouse=True)
def _state(tmp_path, monkeypatch) -> Path:
    state_file = tmp_path / "state" / "onboarding_state.json"
    monkeypatch.setenv("AEUH_ONBOARDING_STATE", str(state_file))
    monkeypatch.delenv("AXEUH_ONBOARDING_STATE", raising=False)
    return state_file


def _seed_state(
    state_file: Path,
    *,
    completed: tuple[str, ...],
    skipped: tuple[str, ...] = (),
) -> None:
    state_file.parent.mkdir(parents=True, exist_ok=True)
    state_file.write_text(
        json.dumps(
            {
                "version": 4,
                "completed_steps": list(completed),
                "skipped_steps": list(skipped),
            }
        ),
        encoding="utf-8",
    )


def test_finish_hard_failure_raises_and_does_not_record(
    _state, monkeypatch
):
    _seed_state(_state, completed=PRIOR_TO_FINISH)
    monkeypatch.setattr(
        onboarding,
        "run_preflight",
        lambda *args, **kwargs: _result(
            blocking=("frontend_dist",), soft=("kernel_models",)
        ),
    )

    with pytest.raises(onboarding.PreflightBlocked) as caught:
        onboarding.record_step(
            "finish", "completed", startup_status=STARTUP_OK
        )

    assert caught.value.code == "preflight_blocked"
    assert caught.value.status_code == 409
    assert [check["id"] for check in caught.value.checks] == list(
        onboarding.CHECK_IDS
    )
    assert caught.value.blocking_failures == ["frontend_dist"]
    state = onboarding.get_state()
    assert "finish" not in state["completed_steps"]
    assert "finish" not in (state.get("step_data") or {})


def test_finish_soft_failure_requires_explicit_ack(_state, monkeypatch):
    _seed_state(_state, completed=PRIOR_TO_FINISH)
    monkeypatch.setattr(
        onboarding,
        "run_preflight",
        lambda *args, **kwargs: _result(soft=("ai_dir", "kernel_models")),
    )

    with pytest.raises(onboarding.DegradedRequiresAck) as caught:
        onboarding.record_step(
            "finish",
            "completed",
            {"allow_degraded": "yes"},
            startup_status=STARTUP_OK,
        )

    assert caught.value.code == "degraded_requires_ack"
    assert caught.value.soft_failures == ["ai_dir", "kernel_models"]
    assert "finish" not in onboarding.get_state()["completed_steps"]

    state = onboarding.record_step(
        "finish",
        "completed",
        {"allow_degraded": True, "note": "accepted"},
        startup_status=STARTUP_OK,
    )

    assert state["completed"] is True
    stored = state["step_data"]["finish"]
    assert stored["allow_degraded"] is True
    assert stored["can_proceed"] is True
    assert stored["soft_failures"] == ["ai_dir", "kernel_models"]
    assert stored["blocking_failures"] == []
    assert stored["note"] == "accepted"
    assert stored["checks"] == [
        {"id": "python", "status": "pass"},
        {"id": "config", "status": "pass"},
        {"id": "frontend_dist", "status": "pass"},
        {"id": "ai_dir", "status": "warn"},
        {"id": "disk", "status": "pass"},
        {"id": "ports", "status": "pass"},
        {"id": "ssl", "status": "pass"},
        {"id": "kernel", "status": "pass"},
        {"id": "kernel_models", "status": "warn"},
        {"id": "loom", "status": "pass"},
        {"id": "ai_backend", "status": "pass"},
    ]


def test_finish_repeats_hard_gate(_state, monkeypatch):
    _seed_state(_state, completed=PRIOR_TO_FINISH)
    monkeypatch.setattr(
        onboarding,
        "run_preflight",
        lambda *args, **kwargs: _result(blocking=("ssl",)),
    )

    with pytest.raises(onboarding.PreflightBlocked):
        onboarding.record_step(
            "finish", "completed", {"allow_degraded": True}
        )

    state = onboarding.get_state()
    assert "finish" not in state["completed_steps"]
    assert state["current_step"] == "finish"


def _with_failed_kernel_models(result: dict) -> dict:
    for check in result["checks"]:
        if check["id"] == "kernel_models":
            check["status"] = "fail"
    return result


def test_required_kernel_models_block_completion_even_with_ack(_state, monkeypatch):
    _seed_state(_state, completed=PRIOR_TO_FINISH)
    monkeypatch.setattr(
        onboarding,
        "run_preflight",
        lambda *args, **kwargs: _with_failed_kernel_models(
            _result(soft=("kernel_models",))
        ),
    )

    with pytest.raises(onboarding.PreflightBlocked):
        onboarding.record_step(
            "finish", "completed", {"allow_degraded": True}, startup_status=STARTUP_OK
        )

    state = onboarding.get_state()
    assert "finish" not in state["completed_steps"]
    assert state["current_step"] == "finish"


def test_group_preflight_promotes_required_models_to_blocking():
    groups = onboarding_finish.group_preflight(
        _with_failed_kernel_models(_result(soft=("kernel_models",)))
    )

    assert [item["id"] for item in groups["blocking"]] == ["kernel_models"]
    assert groups["soft"] == []


def test_finish_soft_gate_requires_ack_then_records(_state, monkeypatch):
    _seed_state(_state, completed=PRIOR_TO_FINISH)
    monkeypatch.setattr(
        onboarding,
        "run_preflight",
        lambda *args, **kwargs: _result(soft=("loom",)),
    )

    with pytest.raises(onboarding.DegradedRequiresAck):
        onboarding.record_step(
            "finish", "completed", startup_status=STARTUP_OK
        )

    state = onboarding.record_step(
        "finish", "completed", {"allow_degraded": True}, startup_status=STARTUP_OK
    )

    assert state["completed"] is True
    assert state["step_data"]["finish"]["allow_degraded"] is True
    assert state["step_data"]["finish"]["soft_failures"] == ["loom"]


def test_finish_requires_startup_gate(_state, monkeypatch):
    _seed_state(_state, completed=PRIOR_TO_FINISH)
    monkeypatch.setattr(
        onboarding,
        "run_preflight",
        lambda *args, **kwargs: _result(),
    )

    with pytest.raises(onboarding.StartupRequired) as caught:
        onboarding.record_step("finish", "completed")

    assert caught.value.status_code == 409
    assert caught.value.code == "startup_required"
    assert "finish" not in onboarding.get_state()["completed_steps"]


def test_finish_requires_validated_runtime(_state, monkeypatch):
    _seed_state(_state, completed=PRIOR_TO_FINISH)
    monkeypatch.setattr(
        onboarding,
        "run_preflight",
        lambda *args, **kwargs: _result(),
    )

    with pytest.raises(onboarding.StartupRequired) as caught:
        onboarding.record_step("finish", "completed")

    assert caught.value.status_code == 409
    assert caught.value.code == "startup_required"
    assert caught.value.runtime == {}
    assert caught.value.startup == {}
    assert "finish" not in onboarding.get_state()["completed_steps"]


def test_finish_failed_validation_carries_report(_state, monkeypatch):
    _seed_state(_state, completed=PRIOR_TO_FINISH)
    monkeypatch.setattr(
        onboarding,
        "run_preflight",
        lambda *args, **kwargs: _result(),
    )
    failed = onboarding.StartupStatus(
        runtime_state="attempted",
        validation_report={
            "ok": False,
            "state": "failed",
            "errors": [{"subsystem": "scheduler", "error": "not running"}],
        },
        runtime_report={"state": "attempted", "ok": False},
    )

    with pytest.raises(onboarding.StartupFailed) as caught:
        onboarding.record_step(
            "finish", "completed", startup_status=failed
        )

    assert caught.value.status_code == 409
    assert caught.value.code == "startup_failed"
    assert caught.value.startup["errors"] == [
        {"subsystem": "scheduler", "error": "not running"}
    ]
    assert caught.value.runtime["state"] == "attempted"
    assert "finish" not in onboarding.get_state()["completed_steps"]


def test_finish_records_when_startup_validated(_state, monkeypatch):
    _seed_state(_state, completed=PRIOR_TO_FINISH)
    monkeypatch.setattr(
        onboarding,
        "run_preflight",
        lambda *args, **kwargs: _result(),
    )

    state = onboarding.record_step(
        "finish", "completed", startup_status=STARTUP_OK
    )

    assert "finish" in state["completed_steps"]
    assert state["completed"] is True


def test_removed_step_ids_cannot_be_recorded(_state):
    _seed_state(_state, completed=PRIOR_TO_FINISH)

    with pytest.raises(ValueError):
        onboarding.record_step("preflight", "completed")
    with pytest.raises(ValueError):
        onboarding.record_step("startup", "completed")
    with pytest.raises(ValueError):
        onboarding.record_step("startup", "skipped")


def test_finish_before_prior_steps_keeps_ordering(_state, monkeypatch):
    _seed_state(_state, completed=PRIOR_TO_FINISH[:-1])

    def _unexpected(*args, **kwargs):
        raise AssertionError("preflight must not run before ordering is checked")

    monkeypatch.setattr(onboarding, "run_preflight", _unexpected)

    with pytest.raises(onboarding.StepOutOfOrder):
        onboarding.record_step(
            "finish", "completed", {"allow_degraded": True}
        )


def test_repeated_finish_record_rechecks_gate(_state, monkeypatch):
    _seed_state(_state, completed=PRIOR_TO_FINISH)
    monkeypatch.setattr(
        onboarding,
        "run_preflight",
        lambda *args, **kwargs: _result(),
    )
    onboarding.record_step(
        "finish", "completed", {"allow_degraded": True}, startup_status=STARTUP_OK
    )

    monkeypatch.setattr(
        onboarding,
        "run_preflight",
        lambda *args, **kwargs: _result(blocking=("ports",)),
    )

    with pytest.raises(onboarding.PreflightBlocked):
        onboarding.record_step(
            "finish",
            "completed",
            {"allow_degraded": True},
            startup_status=STARTUP_OK,
        )


def test_v4_finish_is_the_only_visible_gate_step():
    assert [step.id for step in onboarding.STEPS][-2:] == ["clients", "finish"]
    assert onboarding.STEPS[-1].id == "finish"
    assert onboarding._GATED_STEP_IDS == {"finish"}
    assert onboarding._STARTUP_GATED_STEP_IDS == {"finish"}
    assert "preflight" not in onboarding._STEP_INDEX
    assert "startup" not in onboarding._STEP_INDEX


def test_provided_preflight_result_skips_rerun_and_records_summary(
    _state, monkeypatch
):
    _seed_state(_state, completed=PRIOR_TO_FINISH)

    def _unexpected(*args, **kwargs):
        raise AssertionError("provided preflight_result must not be re-run")

    monkeypatch.setattr(onboarding, "run_preflight", _unexpected)
    provided = _result(soft=("loom",))

    state = onboarding.record_step(
        "finish",
        "completed",
        {"allow_degraded": True},
        startup_status=STARTUP_OK,
        preflight_result=provided,
    )

    assert state["completed"] is True
    stored = state["step_data"]["finish"]
    assert stored["allow_degraded"] is True
    assert stored["soft_failures"] == ["loom"]
    assert stored["blocking_failures"] == []
    assert stored["checks"] == [
        {"id": check["id"], "status": check["status"]}
        for check in provided["checks"]
    ]


def test_provided_preflight_result_still_enforces_hard_gate(_state, monkeypatch):
    _seed_state(_state, completed=PRIOR_TO_FINISH)

    def _unexpected(*args, **kwargs):
        raise AssertionError("provided preflight_result must not be re-run")

    monkeypatch.setattr(onboarding, "run_preflight", _unexpected)

    with pytest.raises(onboarding.PreflightBlocked) as caught:
        onboarding.record_step(
            "finish",
            "completed",
            {"allow_degraded": True},
            startup_status=STARTUP_OK,
            preflight_result=_result(blocking=("ports",)),
        )

    assert caught.value.code == "preflight_blocked"
    assert caught.value.blocking_failures == ["ports"]
    assert "finish" not in onboarding.get_state()["completed_steps"]


def test_provided_preflight_result_still_requires_soft_ack(_state, monkeypatch):
    _seed_state(_state, completed=PRIOR_TO_FINISH)

    def _unexpected(*args, **kwargs):
        raise AssertionError("provided preflight_result must not be re-run")

    monkeypatch.setattr(onboarding, "run_preflight", _unexpected)

    with pytest.raises(onboarding.DegradedRequiresAck) as caught:
        onboarding.record_step(
            "finish",
            "completed",
            startup_status=STARTUP_OK,
            preflight_result=_result(soft=("ai_dir",)),
        )

    assert caught.value.code == "degraded_requires_ack"
    assert caught.value.soft_failures == ["ai_dir"]
    assert "finish" not in onboarding.get_state()["completed_steps"]
