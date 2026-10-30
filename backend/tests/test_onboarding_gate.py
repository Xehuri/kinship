# -*- coding: utf-8 -*-
"""Onboarding gate: keys on onboarding_state.completed, not bootstrap runtime."""
from __future__ import annotations

import json

import pytest
from fastapi import FastAPI, WebSocket
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from middleware.onboarding_gate import OnboardingGateMiddleware

BLOCKED_BODY = {
    "code": "onboarding_required",
    "message": "Complete onboarding first",
}


def _build_app(completed: bool) -> FastAPI:
    app = FastAPI()
    app.state.onboarding_state_completed = completed
    app.add_middleware(OnboardingGateMiddleware)

    @app.get("/")
    async def root():
        return {"ok": True}

    @app.get("/health")
    async def health():
        return {"status": "healthy"}

    @app.get("/favicon.ico")
    async def favicon():
        return {"ok": True}

    @app.get("/login")
    async def login():
        return {"ok": True}

    @app.get("/auth/setup-status")
    async def setup_status():
        return {"ok": True}

    @app.get("/mobile")
    @app.get("/mobile/{asset_path:path}")
    async def mobile(asset_path: str = "index.html"):
        return {"asset": asset_path}

    @app.get("/static/{asset_path:path}")
    async def static_asset(asset_path: str):
        return {"asset": asset_path}

    @app.get("/api/system/onboarding/status")
    async def onboarding_status():
        return {"ok": True}

    @app.get("/api/system/config")
    async def system_config():
        return {"ok": True}

    @app.get("/api/ota/download")
    async def ota_download():
        return {"ok": True}

    @app.get("/api/clients/catalog")
    async def clients_catalog():
        return {"ok": True}

    @app.get("/api/screen/session/list")
    async def session_list():
        return {"sessions": []}

    @app.get("/vaudit/")
    async def vaudit():
        return {"ok": True}

    @app.websocket("/ws")
    async def websocket_endpoint(websocket: WebSocket):
        await websocket.accept()
        await websocket.send_text("hello")

    return app


ALLOWED_PATHS = [
    "/",
    "/health",
    "/favicon.ico",
    "/login",
    "/auth/setup-status",
    "/mobile",
    "/mobile/assets/app.js",
    "/static/app.css",
    "/api/system/onboarding/status",
    "/api/system/config",
    "/api/ota/download",
    "/api/clients/catalog",
]

BLOCKED_PATHS = [
    "/api/screen/session/list",
    "/vaudit/",
    "/api/p2p/enroll",
]


def test_incomplete_gate_allows_onboarding_paths():
    with TestClient(_build_app(False)) as client:
        for path in ALLOWED_PATHS:
            response = client.get(path)
            assert response.status_code != 503, path


def test_incomplete_gate_blocks_other_http_with_503_json():
    with TestClient(_build_app(False)) as client:
        for path in BLOCKED_PATHS:
            response = client.get(path)
            assert response.status_code == 503, path
            assert response.json() == BLOCKED_BODY


def test_completed_gate_is_pass_through():
    with TestClient(_build_app(True)) as client:
        response = client.get("/api/screen/session/list")
        assert response.status_code == 200
        assert response.json() == {"sessions": []}


def test_incomplete_gate_closes_websocket_with_1013():
    with TestClient(_build_app(False)) as client:
        with pytest.raises(WebSocketDisconnect) as excinfo:
            with client.websocket_connect("/ws"):
                pass

    assert excinfo.value.code == 1013
    assert excinfo.value.reason == "onboarding_required"


def test_empty_bootstrap_app_starts_plane_and_gate_requires_onboarding(monkeypatch):
    import auth
    import main

    monkeypatch.setenv("AXEUH_ONBOARDING_BOOTSTRAP", "1")
    monkeypatch.setattr(auth, "is_setup_required", lambda: True)
    with TestClient(main.app) as client:
        assert client.get("/health").status_code == 200
        assert client.get("/api/system/onboarding/status").status_code == 200
        assert client.get("/api/config").status_code != 503
        blocked = client.get("/api/screen/session/list")
        assert blocked.status_code == 503
        assert blocked.json() == BLOCKED_BODY

        assert main.app.state.bootstrap_runtime.active is False
        assert main.app.state.bootstrap_runtime.committed is True
        assert main.app.state.service_plane_started is True


def test_fresh_startup_creates_state_while_runtime_is_inactive(monkeypatch, tmp_path):
    import auth
    import main

    state_file = tmp_path / "onboarding_state.json"
    monkeypatch.setenv("AEUH_ONBOARDING_STATE", str(state_file))
    monkeypatch.delenv("AXEUH_ONBOARDING_BOOTSTRAP", raising=False)
    monkeypatch.setattr(auth, "is_setup_required", lambda: True)

    with TestClient(main.app):
        assert state_file.is_file()
        assert main.app.state.bootstrap_runtime.active is False


def test_restart_after_admin_creation_keeps_single_startup_path(monkeypatch, tmp_path):
    import auth
    import main
    from services import onboarding_service

    monkeypatch.setenv(
        "AEUH_ONBOARDING_STATE", str(tmp_path / "onboarding_state.json")
    )
    monkeypatch.delenv("AXEUH_ONBOARDING_BOOTSTRAP", raising=False)
    monkeypatch.setattr(auth, "is_setup_required", lambda: True)
    assert onboarding_service.ensure_fresh_state() is True
    monkeypatch.setattr(auth, "is_setup_required", lambda: False)

    with TestClient(main.app) as client:
        assert main.app.state.bootstrap_runtime.active is False
        assert main.app.state.service_plane_started is True
        blocked = client.get("/api/screen/session/list")
        assert blocked.status_code == 503


def _write_state(path, *, completed: bool) -> None:
    from services import onboarding_service

    steps = [step.id for step in onboarding_service.STEPS] if completed else []
    path.write_text(
        json.dumps({"version": 4, "completed_steps": steps}), encoding="utf-8"
    )


def test_completed_state_opens_gate_after_single_startup_path(monkeypatch, tmp_path):
    import auth
    import main

    state_file = tmp_path / "onboarding_state.json"
    _write_state(state_file, completed=True)
    monkeypatch.setenv("AEUH_ONBOARDING_STATE", str(state_file))
    monkeypatch.setattr(auth, "is_setup_required", lambda: True)

    with TestClient(main.app) as client:
        assert client.get("/api/screen/session/list").status_code != 503


def test_bootstrap_env_zero_starts_service_plane(monkeypatch, tmp_path):
    import main

    state_file = tmp_path / "onboarding_state.json"
    _write_state(state_file, completed=True)
    monkeypatch.setenv("AEUH_ONBOARDING_STATE", str(state_file))
    monkeypatch.setenv("AXEUH_ONBOARDING_BOOTSTRAP", "0")
    with TestClient(main.app) as client:
        response = client.get("/api/screen/session/list")
        assert response.status_code != 503
        assert main.app.state.bootstrap_runtime.active is False
        assert main.app.state.service_plane_started is True


def _write_step_sets(path, *, completed, skipped=()):
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


def test_phase1_gate_blocks_with_welcome_and_account_only(monkeypatch, tmp_path):
    import auth
    import main

    state_file = tmp_path / "onboarding_state.json"
    _write_step_sets(state_file, completed=["welcome", "account"])
    monkeypatch.setenv("AEUH_ONBOARDING_STATE", str(state_file))
    monkeypatch.delenv("AXEUH_ONBOARDING_STATE", raising=False)
    monkeypatch.setattr(auth, "is_setup_required", lambda: True)

    with TestClient(main.app) as client:
        for path in ALLOWED_PATHS:
            assert client.get(path).status_code != 503, path
        blocked = client.get("/api/screen/session/list")
        assert blocked.status_code == 503
        assert blocked.json() == BLOCKED_BODY


def test_phase1_gate_opens_perception_event_after_dependencies(
    client, auth_headers, monkeypatch, tmp_path
):
    from services import onboarding_service

    state_file = tmp_path / "onboarding_state.json"
    monkeypatch.setenv("AEUH_ONBOARDING_STATE", str(state_file))
    monkeypatch.delenv("AXEUH_ONBOARDING_STATE", raising=False)
    payload = {"type": "sensor", "payload": {"qa": "phase1", "battery": 88}}

    _write_step_sets(state_file, completed=["welcome", "account"])
    blocked = client.post(
        "/api/screen/stt/perception-event", json=payload, headers=auth_headers
    )
    assert blocked.status_code == 503
    assert blocked.json() == BLOCKED_BODY

    _write_step_sets(
        state_file,
        completed=["welcome", "account", "dependencies"],
        skipped=["kernel", "kernel_models"],
    )
    opened = client.post(
        "/api/screen/stt/perception-event", json=payload, headers=auth_headers
    )
    assert opened.status_code == 200, opened.text
    assert opened.json() == {"status": "ok", "type": "sensor"}

    assert onboarding_service.read_state_snapshot()["completed"] is False
