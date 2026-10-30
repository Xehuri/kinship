# -*- coding: utf-8 -*-
"""Onboarding startup API: auth split, report shape, retry and gate safety."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

import auth
from routers import onboarding_startup
from services import config_authz
from services.bootstrap_runtime import BootstrapRuntime
from services.startup_validation import (
    DEFERRED_SUBSYSTEMS,
    REQUIRED_PROBES,
    ProbeResult,
    StartupValidation,
)

BASE = "/api/system/onboarding/startup"


def _probes() -> dict[str, Any]:
    def ok() -> ProbeResult:
        return ProbeResult(True, "ok")

    probes: dict[str, Any] = {name: ok for name in REQUIRED_PROBES}
    for name in ("kernel", "loom"):
        probes[name] = ok
    return probes


def _validation() -> StartupValidation:
    return StartupValidation(
        _probes(),
        state_reader=lambda: {"completed_steps": [], "skipped_steps": []},
        config_reader=lambda: SimpleNamespace(AI_BACKEND="opencode"),
    )


def _build_app(
    runtime: BootstrapRuntime, validation: StartupValidation
) -> FastAPI:
    app = FastAPI()

    @app.middleware("http")
    async def identity(request: Request, call_next):
        user_id = request.headers.get("X-Test-User", "").strip()
        if user_id:
            request.state.user_id = user_id
            request.state.token_kind = request.headers.get("X-Test-Kind", "user")
        return await call_next(request)

    app.state.bootstrap_runtime = runtime
    app.state.startup_validation = validation
    app.include_router(onboarding_startup.router)
    return app


def _runtime(validation: StartupValidation) -> tuple[BootstrapRuntime, dict[str, int]]:
    calls = {"start": 0, "stop": 0}

    async def start():
        calls["start"] += 1
        if calls["start"] == 1:
            raise RuntimeError("first attempt exploded")
        return {"subsystems": {"scheduler": "ok"}, "errors": []}

    async def stop():
        calls["stop"] += 1

    runtime = BootstrapRuntime(True, start, stop, validator=validation.validate)
    return runtime, calls


@pytest.fixture
def allow_auth(monkeypatch) -> None:
    async def read(request: Request):
        return SimpleNamespace(user_id="alice", token_kind="user")

    async def write(request: Request, password: str | None = None):
        return SimpleNamespace(user_id="alice", token_kind="user")

    monkeypatch.setattr(config_authz, "require_config_read", read)
    monkeypatch.setattr(config_authz, "require_config_write", write)


def test_attempt_validate_abort_retry_and_gate_stays_closed(allow_auth):
    validation = _validation()
    runtime, calls = _runtime(validation)
    app = _build_app(runtime, validation)

    with TestClient(app) as client:
        initial = client.get(BASE)
        assert initial.status_code == 200
        payload = initial.json()
        assert payload["ok"] is None
        assert payload["state"] == "deferred"
        assert payload["mode"] == "validation"
        assert payload["deferred"] == list(DEFERRED_SUBSYSTEMS)
        assert payload["runtime"]["active"] is True
        assert payload["runtime"]["gate_open"] is False

        first = client.post(f"{BASE}/attempt")
        assert first.status_code == 200
        payload = first.json()
        assert payload["ok"] is False
        assert payload["state"] == "failed"
        assert payload["lifecycle"]["ok"] is False
        assert payload["lifecycle"]["errors"][0]["subsystem"] == "service_plane"
        assert payload["runtime"]["active"] is True
        assert payload["runtime"]["gate_open"] is False

        aborted = client.post(f"{BASE}/abort")
        assert aborted.status_code == 200
        payload = aborted.json()
        assert payload["state"] == "aborted"
        assert payload["runtime"]["state"] == "deferred"
        assert payload["runtime"]["active"] is True
        assert payload["runtime"]["gate_open"] is False
        assert calls == {"start": 1, "stop": 1}

        retry = client.post(f"{BASE}/attempt")
        assert retry.status_code == 200
        payload = retry.json()
        assert payload["ok"] is None
        assert payload["state"] == "attempted"
        assert payload["lifecycle"]["ok"] is True
        assert calls == {"start": 2, "stop": 1}

        checked = client.post(f"{BASE}/validate")
        assert checked.status_code == 200
        payload = checked.json()
        assert payload["ok"] is True
        assert payload["state"] == "validated"
        assert payload["subsystems"]["scheduler"] == "ok"
        assert payload["subsystems"]["p2p"] == "deferred"
        assert payload["runtime"]["state"] == "validated"
        assert payload["runtime"]["active"] is True
        assert payload["runtime"]["committed"] is False
        assert payload["runtime"]["gate_open"] is False
        assert calls == {"start": 2, "stop": 1}

        again = client.post(f"{BASE}/attempt")
        assert again.status_code == 200
        assert again.json()["state"] == "validated"
        assert again.json()["runtime"]["state"] == "validated"
        assert calls == {"start": 2, "stop": 1}

    assert runtime.active is True
    assert runtime.committed is False


def test_validate_requires_attempt(allow_auth):
    validation = _validation()
    runtime = BootstrapRuntime(True)
    app = _build_app(runtime, validation)

    with TestClient(app) as client:
        response = client.post(f"{BASE}/validate")

    assert response.status_code == 409
    assert response.json()["code"] == "startup_not_attempted"
    assert runtime.active is True
    assert runtime.state == "deferred"


def test_non_bootstrap_runtime_rejects_attempt_and_abort(allow_auth):
    runtime = BootstrapRuntime(False)
    validation = _validation()
    app = _build_app(runtime, validation)

    with TestClient(app) as client:
        attempt = client.post(f"{BASE}/attempt")
        abort = client.post(f"{BASE}/abort")
        status = client.get(BASE)

    assert attempt.status_code == 409
    assert attempt.json()["code"] == "startup_not_bootstrap"
    assert abort.status_code == 409
    assert abort.json()["code"] == "startup_not_bootstrap"
    assert status.status_code == 200
    assert status.json()["runtime"]["active"] is False


def test_bootstrap_auth_requires_setup_token_for_writes(monkeypatch):
    validation = _validation()
    runtime, calls = _runtime(validation)
    app = _build_app(runtime, validation)
    monkeypatch.setattr(auth, "is_setup_required", lambda: True)
    monkeypatch.setattr(
        auth, "verify_setup_token", lambda token: token == "setup-good"
    )

    with TestClient(app) as client:
        assert client.get(BASE).status_code == 200

        missing = client.post(f"{BASE}/attempt")
        assert missing.status_code == 403
        assert missing.json()["code"] == "setup_token_required"

        attempt = client.post(
            f"{BASE}/attempt", headers={"X-Setup-Token": "setup-good"}
        )
        assert attempt.status_code == 200

        validated = client.post(f"{BASE}/validate")
        assert validated.status_code == 200

        abort_missing = client.post(f"{BASE}/abort")
        assert abort_missing.status_code == 403
        assert abort_missing.json()["code"] == "setup_token_required"

        aborted = client.post(
            f"{BASE}/abort", headers={"X-Setup-Token": "setup-good"}
        )
        assert aborted.status_code == 200
        assert calls["stop"] == 1


def test_user_mode_requires_bearer_for_read_and_password_for_writes(monkeypatch):
    validation = _validation()
    runtime, calls = _runtime(validation)
    app = _build_app(runtime, validation)
    monkeypatch.setattr(auth, "is_setup_required", lambda: False)
    monkeypatch.setattr(
        auth,
        "verify_password",
        lambda user_id, password: (password == "pw", user_id),
    )
    headers = {"X-Test-User": "alice"}

    with TestClient(app) as client:
        assert client.get(BASE).status_code == 401
        assert client.get(BASE, headers=headers).status_code == 200

        missing = client.post(f"{BASE}/attempt", headers=headers)
        assert missing.status_code == 403
        assert missing.json()["code"] == "password_required"

        invalid = client.post(
            f"{BASE}/attempt", headers=headers, json={"password": "nope"}
        )
        assert invalid.status_code == 403
        assert invalid.json()["code"] == "password_invalid"

        attempt = client.post(
            f"{BASE}/attempt", headers=headers, json={"password": "pw"}
        )
        assert attempt.status_code == 200

        validated = client.post(f"{BASE}/validate", headers=headers)
        assert validated.status_code == 200

        abort = client.post(f"{BASE}/abort", headers=headers)
        assert abort.status_code == 403

        aborted = client.post(
            f"{BASE}/abort", headers=headers, json={"password": "pw"}
        )
        assert aborted.status_code == 200
        assert calls["stop"] == 1


def test_main_app_exposes_startup_status_with_single_startup_path(monkeypatch):
    import main

    monkeypatch.setenv("AXEUH_ONBOARDING_BOOTSTRAP", "1")
    monkeypatch.setattr(auth, "is_setup_required", lambda: True)
    with TestClient(main.app) as client:
        response = client.get(BASE)
        blocked = client.get("/api/screen/session/list")

    assert response.status_code == 200
    payload = response.json()
    assert payload["mode"] == "validation"
    assert payload["runtime"]["active"] is False
    assert payload["runtime"]["gate_open"] is True
    assert payload["runtime"]["committed"] is True
    assert blocked.status_code == 503
    assert blocked.json()["code"] == "onboarding_required"
