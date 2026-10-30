# -*- coding: utf-8 -*-
"""T7b: onboarding 模型状态与下载作业 HTTP 契约。

独立的小 FastAPI app + 注入身份头，不加载生产 AuthMiddleware / config；
下载器与状态查询均以假实现替换，测试不触网、不写生产缓存。
"""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

import auth
from routers import system_onboarding
from services import kernel_model_assets, onboarding_jobs

MODELS_URL = "/api/system/onboarding/models"
DOWNLOAD_URL = "/api/system/onboarding/models/download"
USER_HEADERS = {"X-Test-User": "alice", "X-Test-Kind": "user"}

STATUS_PAYLOAD = {
    "manifest_version": "2026.10.26",
    "models": [
        {
            "id": "tiny",
            "tier": "required",
            "source": "modelscope",
            "repo": "iic/Tiny",
            "target": "/tmp/models/tiny",
            "kind": "directory",
            "size_bytes": 10,
            "gated": False,
            "present": False,
            "missing_files": [],
            "error": "target_missing",
        }
    ],
    "tiers": [
        {
            "id": "required",
            "model_ids": ["tiny"],
            "total_size_bytes": 10,
            "missing_size_bytes": 10,
        }
    ],
    "total_size_bytes": 10,
    "required_size_bytes": 10,
}

SUMMARY = {
    "manifest_version": "2026.10.26",
    "selection": ["tiny"],
    "models": [
        {
            "id": "tiny",
            "status": "installed",
            "error": None,
            "bytes": 10,
        }
    ],
    "installed": ["tiny"],
    "present": [],
    "bundled": [],
    "gated": [],
    "unsupported": [],
    "failed": [],
    "download_bytes": 10,
}


def _build_app() -> FastAPI:
    app = FastAPI()

    @app.middleware("http")
    async def _inject_identity(request: Request, call_next):
        user_id = request.headers.get("X-Test-User", "").strip()
        if user_id:
            request.state.user_id = user_id
            request.state.token_kind = request.headers.get("X-Test-Kind", "user")
        return await call_next(request)

    app.include_router(system_onboarding.router)
    return app


def _manifest_file(tmp_path: Path) -> Path:
    path = tmp_path / "kernel-models.json"
    path.write_text(
        json.dumps(
            {
                "schema": 1,
                "product": "test-models",
                "version": "2026.10.26",
                "default_source": "modelscope",
                "models": [
                    {
                        "id": "tiny",
                        "tier": "required",
                        "source": "modelscope",
                        "repo": "iic/Tiny",
                        "target": "~/models/tiny",
                        "kind": "directory",
                        "size_bytes": 10,
                        "sha256": None,
                        "md5": None,
                        "gated": False,
                        "required_files": ["config.yaml"],
                        "url": None,
                        "mirrors": [],
                        "notes": "",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    return path


def _wait(predicate, timeout: float = 3.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


@pytest.fixture
def env(tmp_path, monkeypatch):
    manifest_file = _manifest_file(tmp_path)
    manager = onboarding_jobs.JobManager(max_jobs=5)
    monkeypatch.setattr(auth, "is_setup_required", lambda: False)
    monkeypatch.setattr(
        auth,
        "verify_password",
        lambda user_id, password: (password == "pw", user_id),
    )
    monkeypatch.setattr(
        system_onboarding, "_project_root", lambda: tmp_path / "project"
    )
    monkeypatch.setattr(
        system_onboarding.onboarding_service,
        "ensure_ai_instance",
        lambda project_root=None, ai_root=None, **kwargs: {
            "action": "ensure_ai_instance",
            "target": "/tmp/ai",
            "created": False,
            "copied_files": 0,
            "existing_files": 0,
            "errors": [],
        },
    )
    monkeypatch.setattr(
        kernel_model_assets, "manifest_path", lambda config=None: manifest_file
    )
    monkeypatch.setattr(
        kernel_model_assets,
        "status",
        lambda project_root=None, config=None: STATUS_PAYLOAD,
    )
    monkeypatch.setattr(
        kernel_model_assets, "download_enabled", lambda config=None: True
    )

    def fake_download(manifest, selection, project_root=None, **kwargs):
        return SUMMARY

    monkeypatch.setattr(kernel_model_assets, "download", fake_download)
    monkeypatch.setattr(
        onboarding_jobs, "get_job_manager", lambda: manager
    )
    app = _build_app()
    with TestClient(app) as client:
        yield SimpleNamespace(
            client=client,
            manager=manager,
            tmp_path=tmp_path,
            manifest_file=manifest_file,
        )


def test_models_status_requires_auth_and_returns_contract(env):
    unauthorized = env.client.get(MODELS_URL)
    assert unauthorized.status_code == 401
    assert unauthorized.json()["code"] == "auth_required"

    response = env.client.get(MODELS_URL, headers=USER_HEADERS)

    assert response.status_code == 200
    assert response.json() == STATUS_PAYLOAD


def test_models_download_requires_write_auth(env):
    missing = env.client.post(DOWNLOAD_URL, json={"models": ["tiny"]})
    assert missing.status_code == 401
    assert missing.json()["code"] == "auth_required"

    no_password = env.client.post(
        DOWNLOAD_URL, json={"models": ["tiny"]}, headers=USER_HEADERS
    )
    assert no_password.status_code == 403
    assert no_password.json()["code"] == "password_required"

    wrong = env.client.post(
        DOWNLOAD_URL,
        json={"models": ["tiny"], "password": "bad"},
        headers=USER_HEADERS,
    )
    assert wrong.status_code == 403
    assert wrong.json()["code"] == "password_invalid"

    accepted = env.client.post(
        DOWNLOAD_URL,
        json={"models": ["tiny"], "password": "pw"},
        headers=USER_HEADERS,
    )
    assert accepted.status_code == 202
    job = accepted.json()["job"]
    assert job["kind"] == "download:models"
    assert job["asset"] == "models"
    assert job["state"] in {"queued", "running"}
    assert env.manager.get(job["id"]).wait(3)
    assert env.manager.get(job["id"]).state == "done"
    assert env.manager.get(job["id"]).snapshot()["result"]["installed"] == ["tiny"]


def test_models_download_rejects_unknown_or_empty_selection(env):
    unknown = env.client.post(
        DOWNLOAD_URL,
        json={"models": ["nope"], "password": "pw"},
        headers=USER_HEADERS,
    )
    assert unknown.status_code == 422
    assert unknown.json()["code"] == "unknown_model_id"

    empty = env.client.post(
        DOWNLOAD_URL,
        json={"models": [], "password": "pw"},
        headers=USER_HEADERS,
    )
    assert empty.status_code == 422
    assert empty.json()["code"] == "empty_selection"


def test_models_download_runs_one_active_job(env, monkeypatch):
    gate = threading.Event()
    started = threading.Event()
    recorded: dict = {}

    def fake_download(manifest, selection, project_root=None, **kwargs):
        recorded["selection"] = selection
        recorded["project_root"] = project_root
        kwargs["log"]("[KernelModels] phase=download result=start")
        kwargs["progress"](5, 10)
        started.set()
        gate.wait(3)
        return SUMMARY

    monkeypatch.setattr(kernel_model_assets, "download", fake_download)
    first = env.client.post(
        DOWNLOAD_URL,
        json={"models": ["tiny"], "password": "pw"},
        headers=USER_HEADERS,
    )
    assert first.status_code == 202
    job_id = first.json()["job"]["id"]
    assert started.wait(2)

    second = env.client.post(
        DOWNLOAD_URL,
        json={"models": ["tiny"], "password": "pw"},
        headers=USER_HEADERS,
    )
    assert second.status_code == 409
    assert second.json()["code"] == "download_in_progress"

    gate.set()
    job = env.manager.get(job_id)
    assert job.wait(3)
    snapshot = job.snapshot()
    assert snapshot["state"] == "done"
    assert snapshot["result"]["installed"] == ["tiny"]
    assert recorded["selection"] == {"models": ["tiny"], "tiers": None}
    assert recorded["project_root"] == env.tmp_path / "project"


def test_models_download_disabled(env, monkeypatch):
    monkeypatch.setattr(
        kernel_model_assets, "download_enabled", lambda config=None: False
    )

    response = env.client.post(
        DOWNLOAD_URL,
        json={"models": ["tiny"], "password": "pw"},
        headers=USER_HEADERS,
    )

    assert response.status_code == 409
    assert response.json()["code"] == "model_download_disabled"


def test_models_download_uses_configured_tiers_when_selection_empty(env, monkeypatch):
    recorded: dict = {}

    def fake_download(manifest, selection, project_root=None, **kwargs):
        recorded["selection"] = selection
        return SUMMARY

    monkeypatch.setattr(kernel_model_assets, "download", fake_download)

    response = env.client.post(
        DOWNLOAD_URL, json={"password": "pw"}, headers=USER_HEADERS
    )

    assert response.status_code == 202
    job = env.manager.get(response.json()["job"]["id"])
    assert job.wait(3)
    assert recorded["selection"] == {"models": None, "tiers": None}
