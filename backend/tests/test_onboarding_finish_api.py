# -*- coding: utf-8 -*-
"""v4 finish API：预检 -> 草稿应用 -> 服务就绪审计的收口契约。"""
from __future__ import annotations

import copy
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers.onboarding_finish import router as finish_router
from services import config_authz, onboarding_finish, onboarding_service

BASE = "/api/system/onboarding/finish"

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

HARD_IDS = (
    "python",
    "config",
    "frontend_dist",
    "disk",
    "ports",
    "ssl",
)


def _preflight(
    *, blocking: tuple[str, ...] = (), soft: tuple[str, ...] = ()
) -> dict[str, Any]:
    checks: list[dict[str, Any]] = []
    for check_id in onboarding_service.CHECK_IDS:
        status = "pass"
        if check_id in blocking:
            status = "fail"
        elif check_id in soft:
            status = "warn"
        checks.append(
            {
                "id": check_id,
                "label": f"label:{check_id}",
                "status": status,
                "blocking": check_id in HARD_IDS,
                "category": "test",
                "detail": f"detail:{check_id}",
                "fix": f"fix:{check_id}",
            }
        )
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


def _service(
    service_id: str,
    *,
    state: str = "ready",
    critical: bool = True,
    reason_code: str = "",
    detail: str = "",
    pid: int = 1,
) -> dict[str, Any]:
    return {
        "id": service_id,
        "state": state,
        "reason_code": reason_code,
        "detail": detail,
        "pid": pid,
        "critical": critical,
    }


def _snapshot(*entries: dict[str, Any], orchestrator: str = "on") -> dict[str, Any]:
    return {"orchestrator": orchestrator, "services": list(entries)}


def _write_state(
    path: Path,
    *,
    completed: tuple[str, ...] = PRIOR_TO_FINISH,
    skipped: tuple[str, ...] = (),
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
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


@pytest.fixture(autouse=True)
def _state_file(tmp_path, monkeypatch) -> Path:
    path = tmp_path / "state" / "onboarding_state.json"
    _write_state(path)
    monkeypatch.setenv("AEUH_ONBOARDING_STATE", str(path))
    monkeypatch.delenv("AXEUH_ONBOARDING_STATE", raising=False)
    return path


@pytest.fixture(autouse=True)
def _auth(monkeypatch) -> list[str | None]:
    passwords: list[str | None] = []

    async def allow_read(request):
        return SimpleNamespace(user_id="alice", token_kind="user")

    async def allow_write(request, password=None):
        passwords.append(password)
        return SimpleNamespace(user_id="alice", token_kind="user")

    monkeypatch.setattr(config_authz, "require_config_read", allow_read)
    monkeypatch.setattr(config_authz, "require_config_write", allow_write)
    return passwords


@pytest.fixture(autouse=True)
def _default_config(monkeypatch) -> None:
    monkeypatch.setattr(
        onboarding_finish,
        "get_config",
        lambda: SimpleNamespace(
            MOSS_ENABLED=False,
            HEALTH_CLOUD_ENABLED=False,
            AI_BACKEND="opencode",
        ),
    )
    monkeypatch.setattr(onboarding_finish, "_qq_gateway_enabled", lambda: False)


@pytest.fixture(autouse=True)
def _orchestrator(monkeypatch) -> dict[str, Any]:
    holder: dict[str, Any] = {
        "snapshot": _snapshot(
            _service("kernel"),
            _service("loom", critical=False),
            _service("moss_watcher", critical=False),
        ),
        "calls": 0,
    }

    def fake_snapshot() -> dict[str, Any]:
        holder["calls"] += 1
        return copy.deepcopy(holder["snapshot"])

    monkeypatch.setattr(onboarding_finish, "_orchestrator_snapshot", fake_snapshot)
    return holder


@pytest.fixture(autouse=True)
def _apply_staged_spy(monkeypatch) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []

    async def fake(store=None, paths=None):
        calls.append({"store": store, "paths": paths})
        return {
            "applied": [],
            "failed": [],
            "deferred_restart": [],
            "partial": False,
        }

    monkeypatch.setattr(onboarding_finish, "apply_staged", fake)
    return calls


def _patch_preflight(monkeypatch, result: dict[str, Any], counter=None) -> None:
    def fake(*args, **kwargs):
        if counter is not None:
            counter.append(1)
        return copy.deepcopy(result)

    monkeypatch.setattr(onboarding_service, "run_preflight", fake)


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(finish_router)
    return app


def _post(client: TestClient, **payload: Any):
    return client.post(BASE, json=payload)


def _blocking_layers(payload: dict[str, Any]) -> list[str]:
    return [item["layer"] for item in payload["groups"]["blocking"]]


def _blocking_ids(payload: dict[str, Any]) -> list[str]:
    return [item["id"] for item in payload["groups"]["blocking"]]


def test_all_critical_ready_completes(monkeypatch, _apply_staged_spy):
    _patch_preflight(monkeypatch, _preflight())

    with TestClient(_app()) as client:
        response = _post(client)

    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert payload["state"]["completed"] is True
    assert payload["readiness"]["ok"] is True
    assert payload["readiness"]["blocking"] == []
    assert payload["activation"]["committed"] is True
    assert payload["activation"]["source"] == "readiness_audit"
    assert payload["closing"]["enter_label"] == "进入主界面"
    assert len(_apply_staged_spy) == 1

    state = onboarding_service.get_state()
    assert state["completed"] is True
    assert "finish" in state["completed_steps"]
    stored = state["step_data"]["finish"]
    assert stored["readiness"]["blocking"] == []
    assert stored["allow_degraded"] is False
    assert stored["blocking_failures"] == []


def test_second_finish_is_idempotent(monkeypatch, _apply_staged_spy, _orchestrator):
    _patch_preflight(monkeypatch, _preflight())

    with TestClient(_app()) as client:
        first = _post(client)
        second = _post(client)

    assert first.status_code == 200
    assert second.status_code == 200
    result = second.json()
    assert result["idempotent"] is True
    assert result["state"]["completed"] is True
    assert result["closing"]["enter_label"] == "进入主界面"
    assert len(_apply_staged_spy) == 1
    assert _orchestrator["calls"] == 1


def test_critical_failure_blocks_with_service_detail(
    monkeypatch, _apply_staged_spy, _orchestrator
):
    _patch_preflight(monkeypatch, _preflight())
    _orchestrator["snapshot"] = _snapshot(
        _service(
            "kernel",
            state="failed",
            reason_code="spawn_failed",
            detail="start action raised: bad interpreter",
        ),
        _service("loom", critical=False),
        _service("moss_watcher", critical=False),
    )

    with TestClient(_app()) as client:
        response = _post(client)

    assert response.status_code == 409
    payload = response.json()
    assert payload["code"] == "finish_blocked"
    assert payload["report"]["readiness"]["ok"] is False
    assert payload["report"]["readiness"]["blocking"] == [
        {
            "id": "kernel",
            "reason_code": "spawn_failed",
            "detail": "start action raised: bad interpreter",
        }
    ]
    assert _blocking_layers(payload) == ["readiness"]
    assert _blocking_ids(payload) == ["kernel"]
    assert payload["groups"]["blocking"][0]["title"] == "音频内核"
    assert payload["groups"]["blocking"][0]["message"] == (
        "start action raised: bad interpreter"
    )
    assert len(_apply_staged_spy) == 1
    assert onboarding_service.get_state()["completed"] is False
    assert "finish" not in onboarding_service.get_state()["completed_steps"]


def test_skipped_critical_service_is_accepted(
    monkeypatch, _state_file, _apply_staged_spy, _orchestrator
):
    _write_state(
        _state_file,
        completed=tuple(step for step in PRIOR_TO_FINISH if step != "kernel"),
        skipped=("kernel",),
    )
    _patch_preflight(monkeypatch, _preflight())
    _orchestrator["snapshot"] = _snapshot(
        _service(
            "kernel",
            state="failed",
            reason_code="spawn_failed",
            detail="kernel skipped by user",
        ),
        _service("loom", critical=False),
        _service("moss_watcher", critical=False),
    )

    with TestClient(_app()) as client:
        response = _post(client)

    assert response.status_code == 200
    payload = response.json()
    assert payload["state"]["completed"] is True
    kernel = next(
        item
        for item in payload["readiness"]["services"]
        if item["id"] == "kernel"
    )
    assert kernel["skipped"] is True
    assert kernel["ok"] is True
    assert payload["readiness"]["blocking"] == []


def test_non_critical_failure_does_not_block(
    monkeypatch, _apply_staged_spy, _orchestrator
):
    _patch_preflight(monkeypatch, _preflight())
    _orchestrator["snapshot"] = _snapshot(
        _service("kernel"),
        _service(
            "loom",
            state="failed",
            critical=False,
            reason_code="spawn_failed",
            detail="loom crashed",
        ),
        _service(
            "moss_watcher",
            state="failed",
            critical=False,
            reason_code="spawn_failed",
            detail="moss crashed",
        ),
    )

    with TestClient(_app()) as client:
        response = _post(client)

    assert response.status_code == 200
    payload = response.json()
    assert payload["state"]["completed"] is True
    assert payload["groups"]["blocking"] == []
    assert [item["id"] for item in payload["readiness"]["non_critical"]] == [
        "loom",
        "moss_watcher",
    ]
    assert onboarding_service.get_state()["completed"] is True


def test_critical_not_ready_but_not_failed_blocks(monkeypatch, _orchestrator):
    _patch_preflight(monkeypatch, _preflight())
    _orchestrator["snapshot"] = _snapshot(
        _service(
            "kernel",
            state="blocked",
            reason_code="missing_config",
            detail="missing_config: kernel.python",
        ),
    )

    with TestClient(_app()) as client:
        response = _post(client)

    assert response.status_code == 409
    payload = response.json()
    assert payload["code"] == "finish_blocked"
    assert payload["report"]["readiness"]["blocking"] == [
        {
            "id": "kernel",
            "reason_code": "missing_config",
            "detail": "missing_config: kernel.python",
        }
    ]
    assert onboarding_service.get_state()["completed"] is False


def test_preflight_hard_failure_blocks_before_apply_and_audit(
    monkeypatch, _apply_staged_spy, _orchestrator
):
    _patch_preflight(monkeypatch, _preflight(blocking=("frontend_dist",)))

    with TestClient(_app()) as client:
        response = _post(client, allow_degraded=True)

    assert response.status_code == 409
    payload = response.json()
    assert payload["code"] == "finish_blocked"
    assert _blocking_layers(payload) == ["preflight"]
    assert _blocking_ids(payload) == ["frontend_dist"]
    assert payload["groups"]["blocking"][0]["message"] == "detail:frontend_dist"
    assert _apply_staged_spy == []
    assert _orchestrator["calls"] == 0
    assert onboarding_service.get_state()["completed"] is False


def test_preflight_soft_failure_requires_ack(monkeypatch, _apply_staged_spy):
    _patch_preflight(monkeypatch, _preflight(soft=("loom",)))

    with TestClient(_app()) as client:
        first = _post(client)
        assert first.status_code == 409
        payload = first.json()
        assert payload["code"] == "finish_degraded_requires_ack"
        assert [item["layer"] for item in payload["groups"]["soft"]] == ["preflight"]
        assert _apply_staged_spy == []

        second = _post(client, allow_degraded=True)
        assert second.status_code == 200
        result = second.json()
        assert result["state"]["completed"] is True
        assert result["closing"]["degraded"] == [
            {"id": "loom", "message": "detail:loom"}
        ]
        assert len(_apply_staged_spy) == 1

    stored = onboarding_service.get_state()["step_data"]["finish"]
    assert stored["allow_degraded"] is True
    assert stored["degraded"] is True
    assert stored["warnings"] == ["detail:loom"]


def test_apply_failure_blocks_completed(monkeypatch, _orchestrator):
    _patch_preflight(monkeypatch, _preflight())

    async def failing(store=None, paths=None):
        return {
            "applied": [],
            "failed": [{"path": "kernel.python", "error": "respawn hook exploded"}],
            "deferred_restart": [],
            "partial": False,
        }

    monkeypatch.setattr(onboarding_finish, "apply_staged", failing)

    with TestClient(_app()) as client:
        response = _post(client)

    assert response.status_code == 409
    payload = response.json()
    assert payload["code"] == "finish_apply_failed"
    assert _blocking_layers(payload) == ["apply"]
    assert _blocking_ids(payload) == ["kernel.python"]
    assert "respawn hook exploded" in payload["groups"]["blocking"][0]["message"]
    assert _orchestrator["calls"] == 0
    assert onboarding_service.get_state()["completed"] is False


def test_apply_runs_before_readiness_audit(monkeypatch, _orchestrator):
    _patch_preflight(monkeypatch, _preflight())
    _orchestrator["snapshot"] = _snapshot(
        _service(
            "kernel",
            state="failed",
            reason_code="spawn_failed",
            detail="pending kernel.python draft",
        )
    )

    async def apply_now(store=None, paths=None):
        _orchestrator["snapshot"] = _snapshot(_service("kernel"))
        return {
            "applied": ["kernel.python"],
            "failed": [],
            "deferred_restart": [],
            "partial": False,
        }

    monkeypatch.setattr(onboarding_finish, "apply_staged", apply_now)

    with TestClient(_app()) as client:
        response = _post(client)

    assert response.status_code == 200
    payload = response.json()
    assert payload["apply"]["applied"] == ["kernel.python"]
    assert payload["readiness"]["ok"] is True
    assert payload["state"]["completed"] is True


def test_orchestrator_unavailable_blocks(monkeypatch):
    _patch_preflight(monkeypatch, _preflight())

    def broken() -> dict[str, Any]:
        raise RuntimeError("orchestrator down")

    monkeypatch.setattr(onboarding_finish, "_orchestrator_snapshot", broken)

    with TestClient(_app()) as client:
        response = _post(client)

    assert response.status_code == 409
    payload = response.json()
    assert payload["code"] == "finish_blocked"
    assert payload["report"]["readiness"]["blocking"] == [
        {
            "id": "orchestrator",
            "reason_code": "snapshot_failed",
            "detail": "RuntimeError",
        }
    ]
    assert onboarding_service.get_state()["completed"] is False


def test_orchestrator_off_blocks(monkeypatch, _orchestrator):
    _patch_preflight(monkeypatch, _preflight())
    _orchestrator["snapshot"] = _snapshot(orchestrator="off")

    with TestClient(_app()) as client:
        response = _post(client)

    assert response.status_code == 409
    payload = response.json()
    assert payload["code"] == "finish_blocked"
    assert payload["report"]["readiness"]["blocking"] == [
        {
            "id": "orchestrator",
            "reason_code": "orchestrator_off",
            "detail": "服务编排器未启用，无法完成就绪审计",
        }
    ]


def test_preflight_runs_once_and_after_apply_is_not_rerun(monkeypatch):
    calls: list[int] = []
    _patch_preflight(monkeypatch, _preflight(soft=("loom",)), counter=calls)

    with TestClient(_app()) as client:
        response = _post(client, allow_degraded=True)

    assert response.status_code == 200
    assert len(calls) == 1
    assert onboarding_service.get_state()["completed"] is True


def test_responses_do_not_leak_password_or_tokens(monkeypatch, _auth):
    _patch_preflight(monkeypatch, _preflight())
    secret = "super-secret-password-123"

    with TestClient(_app()) as client:
        response = _post(client, current_password=secret)

    assert response.status_code == 200
    assert secret not in response.text
    assert _auth == [secret]


def test_closing_uses_step_enabled_flags_and_lists_disabled_as_skipped(monkeypatch):
    monkeypatch.setattr(
        onboarding_finish,
        "_safe_config",
        lambda: SimpleNamespace(
            AI_BACKEND="opencode",
            HEALTH_CLOUD_ENABLED=False,
            MOSS_ENABLED=False,
        ),
    )
    state = {
        "completed_steps": ["xiaomi", "qq", "moss", "loom", "clients", "finish"],
        "skipped_steps": ["kernel"],
        "step_data": {
            "xiaomi": {"enabled": False},
            "qq": {"enabled": False},
            "moss": {"enabled": False},
            "loom": {"port": 5110},
        },
    }
    closing = onboarding_finish.closing(state, {"blocking": [], "soft": []})
    assert closing["enabled"] == [{"id": "clients", "label": "客户端"}]
    skipped_ids = {item["id"] for item in closing["skipped"]}
    assert {"kernel", "xiaomi", "qq", "moss", "loom"} <= skipped_ids


def test_closing_lists_enabled_integrations(monkeypatch):
    monkeypatch.setattr(
        onboarding_finish,
        "_safe_config",
        lambda: SimpleNamespace(
            AI_BACKEND="loom",
            HEALTH_CLOUD_ENABLED=True,
            MOSS_ENABLED=True,
        ),
    )
    state = {
        "completed_steps": ["xiaomi", "qq", "moss", "loom", "clients", "finish"],
        "skipped_steps": ["kernel"],
        "step_data": {
            "xiaomi": {"enabled": True},
            "qq": {"enabled": True},
            "moss": {"enabled": True},
            "loom": {"port": 5110},
        },
    }
    closing = onboarding_finish.closing(state, {"blocking": [], "soft": []})
    enabled_ids = {item["id"] for item in closing["enabled"]}
    assert enabled_ids == {"xiaomi", "qq", "moss", "loom", "clients"}
    assert {item["id"] for item in closing["skipped"]} == {"kernel"}
