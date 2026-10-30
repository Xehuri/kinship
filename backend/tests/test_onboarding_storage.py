# -*- coding: utf-8 -*-
"""Onboarding storage API: snapshot shape, path validation and config save."""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from routers import onboarding_storage
from services import config_authz, storage_layout

BASE = "/api/system/onboarding/storage"


def _build_app() -> FastAPI:
    app = FastAPI()

    @app.middleware("http")
    async def identity(request: Request, call_next):
        user_id = request.headers.get("X-Test-User", "").strip()
        if user_id:
            request.state.user_id = user_id
            request.state.token_kind = request.headers.get("X-Test-Kind", "user")
        return await call_next(request)

    app.include_router(onboarding_storage.router)
    return app


@pytest.fixture
def roots(tmp_path, monkeypatch):
    data_root = tmp_path / "data-root"
    models_root = tmp_path / "models-root"
    home = tmp_path / "home"
    monkeypatch.setattr(storage_layout.paths, "data_root", lambda: data_root)
    monkeypatch.setattr(storage_layout.paths, "models_root", lambda: models_root)
    monkeypatch.setattr(storage_layout, "home_dir", lambda: home)
    return SimpleNamespace(
        data_root=data_root, models_root=models_root, home=home
    )


@pytest.fixture
def allow_read(monkeypatch) -> None:
    async def read(request: Request):
        return SimpleNamespace(user_id="alice", token_kind="user")

    monkeypatch.setattr(config_authz, "require_config_read", read)


@pytest.fixture
def allow_write(monkeypatch) -> dict[str, Any]:
    seen: dict[str, Any] = {}

    async def write(request: Request, password: str | None = None):
        seen["password"] = password
        return SimpleNamespace(user_id="alice", token_kind="user")

    monkeypatch.setattr(config_authz, "require_config_write", write)
    return seen


def test_storage_route_is_registered_on_main_app(client, auth_headers):
    response = client.get(BASE, headers=auth_headers)

    assert response.status_code == 200
    payload = response.json()
    assert payload["data_root"]
    assert payload["models_root"]
    assert isinstance(payload["warnings"], list)


def test_get_storage_returns_snapshot_without_creating_directories(
    roots, allow_read, monkeypatch
):
    monkeypatch.setenv("AXEUH_DATA_ROOT", str(roots.data_root))
    monkeypatch.setenv("AXEUH_MODELS_DIR", str(roots.models_root))

    with TestClient(_build_app()) as client:
        response = client.get(BASE)

    assert response.status_code == 200
    payload = response.json()
    assert payload["data_root"] == str(roots.data_root)
    assert payload["models_root"] == str(roots.models_root)
    assert payload["free_bytes"] > 0
    assert payload["writable"] is True
    assert payload["source"] == {"data_root": "env", "models_root": "env"}
    assert payload["models_dir_configured"] in (True, False)
    assert payload["data_root_configured"] in (True, False)
    assert payload["system_disk"] is False
    assert any("AXEUH_MODELS_DIR" in item for item in payload["warnings"])
    assert set(payload["legacy"]) >= {
        "exists",
        "modelscope",
        "huggingface",
        "axeuh_kernel",
        "home",
        "suggested_root",
        "paths",
    }
    assert payload["legacy"]["exists"] is False
    assert payload["legacy"]["suggested_root"] is None
    assert not roots.models_root.exists()
    assert not roots.data_root.exists()


def test_get_storage_detects_legacy_caches(roots, allow_read):
    (roots.home / ".cache" / "modelscope").mkdir(parents=True)
    (roots.home / ".cache" / "huggingface").mkdir(parents=True)

    with TestClient(_build_app()) as client:
        response = client.get(BASE)

    assert response.status_code == 200
    legacy = response.json()["legacy"]
    assert legacy["exists"] is True
    assert legacy["modelscope"] is True
    assert legacy["huggingface"] is True
    assert legacy["axeuh_kernel"] is False
    assert legacy["suggested_root"] == str(roots.home)


def test_get_storage_reports_system_disk_warning(roots, allow_read, monkeypatch):
    monkeypatch.setattr(
        storage_layout, "system_drive_info", lambda path: (True, "C:")
    )

    with TestClient(_build_app()) as client:
        response = client.get(BASE)

    assert response.status_code == 200
    payload = response.json()
    assert payload["system_disk"] is True
    assert payload["system_drive"] == "C:"
    assert any("系统盘" in item for item in payload["warnings"])


def test_get_storage_requires_read_auth(roots):
    with TestClient(_build_app()) as client:
        response = client.get(BASE)

    assert response.status_code == 401
    assert response.json()["code"] == "auth_required"


def test_post_storage_requires_password(roots):
    target = roots.models_root

    with TestClient(_build_app()) as client:
        response = client.post(
            BASE,
            json={"models_dir": str(target)},
            headers={"X-Test-User": "alice"},
        )

    assert response.status_code == 403
    assert response.json()["code"] == "password_required"


@pytest.mark.parametrize(
    ("models_dir", "code"),
    [
        ("", "invalid_models_dir"),
        ("relative/models", "models_dir_not_absolute"),
        ("/", "models_dir_too_broad"),
        ("bad\x00path", "invalid_models_dir"),
    ],
)
def test_post_storage_rejects_invalid_paths(
    roots, allow_read, allow_write, models_dir: str, code: str
):
    with TestClient(_build_app()) as client:
        response = client.post(
            BASE, json={"models_dir": models_dir, "password": "pw"}
        )

    assert response.status_code == 422
    assert response.json()["code"] == code


def test_post_storage_rejects_missing_parent(roots, allow_read, allow_write):
    target = roots.models_root / "missing" / "models"

    with TestClient(_build_app()) as client:
        response = client.post(
            BASE, json={"models_dir": str(target), "password": "pw"}
        )

    assert response.status_code == 422
    assert response.json()["code"] == "models_dir_parent_missing"


def test_post_storage_rejects_existing_file(roots, allow_read, allow_write):
    target = roots.home / "models.txt"
    target.parent.mkdir(parents=True)
    target.write_text("not a directory", encoding="utf-8")

    with TestClient(_build_app()) as client:
        response = client.post(
            BASE, json={"models_dir": str(target), "password": "pw"}
        )

    assert response.status_code == 422
    assert response.json()["code"] == "models_dir_not_directory"


def test_post_storage_rejects_unwritable_parent(
    roots, allow_read, allow_write, monkeypatch
):
    target = roots.models_root
    target.parent.mkdir(parents=True, exist_ok=True)
    real_access = storage_layout.os.access

    def deny_write(path, mode):
        if mode == storage_layout.os.W_OK:
            return False
        return real_access(path, mode)

    monkeypatch.setattr(storage_layout.os, "access", deny_write)

    with TestClient(_build_app()) as client:
        response = client.post(
            BASE, json={"models_dir": str(target), "password": "pw"}
        )

    assert response.status_code == 422
    assert response.json()["code"] == "models_dir_parent_not_writable"


def test_post_storage_saves_models_dir_in_config_store(
    roots, allow_read, allow_write, monkeypatch
):
    class FakeStore:
        def __init__(self) -> None:
            self.saved: dict[str, Any] | None = None
            self.change = object()
            self.applied: object | None = None

        def save(self, changes: dict[str, Any]):
            self.saved = changes
            return SimpleNamespace(
                change=self.change, revision="rev-2", warnings=[]
            )

        async def apply(self, change):
            self.applied = change
            return SimpleNamespace(applied=(), failed={})

    store = FakeStore()
    monkeypatch.setattr(onboarding_storage, "get_config_store", lambda: store)
    target = roots.home / "models-v2"
    target.parent.mkdir(parents=True)

    with TestClient(_build_app()) as client:
        response = client.post(
            BASE, json={"models_dir": str(target), "password": "pw"}
        )

    assert response.status_code == 200
    assert allow_write["password"] == "pw"
    assert store.saved == {"models.dir": str(target)}
    assert store.applied is store.change
    payload = response.json()
    assert payload["data_root"] == str(roots.data_root)
    assert payload["models_root"] == str(roots.models_root)
    assert not target.exists()


def test_system_drive_detection_is_windows_only():
    assert (
        storage_layout.is_system_drive(
            r"C:\models", os_name="nt", system_drive="C:"
        )
        is True
    )
    assert (
        storage_layout.is_system_drive(
            r"D:\Kinship\models", os_name="nt", system_drive="C:"
        )
        is False
    )
    assert (
        storage_layout.is_system_drive(
            "/srv/models", os_name="posix", system_drive="C:"
        )
        is False
    )
