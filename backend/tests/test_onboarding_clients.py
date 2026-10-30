# -*- coding: utf-8 -*-
"""Onboarding clients API and desktop download endpoint tests."""
from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

import auth
from routers import clients as clients_router
from services import client_release_manifest, clients_catalog


def _cfg(**overrides: object) -> SimpleNamespace:
    values = {
        "CLIENTS_ANDROID_URL": "",
        "CLIENTS_ANDROID_SHA256": "",
        "CLIENTS_DESKTOP_URL": "",
        "CLIENTS_DESKTOP_SHA256": "",
        "CLIENTS_GITHUB_RELEASE_TAG": "onboarding-v1.0.0",
        "CLIENTS_GITHUB_RELEASE_BASE": "https://github.com/Xehuri/kinship",
        "ONBOARDING_RELEASE_MANIFEST_URL": "",
        "ONBOARDING_RELEASE_BASE_URL": "",
        "BACKEND_HOST": "0.0.0.0",
        "BACKEND_HTTPS_PORT": 8767,
        "BACKEND_HTTP_PORT": 8768,
        "SSL_ENABLED": True,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


@pytest.fixture(autouse=True)
def offline_manifest(monkeypatch):
    client_release_manifest.reset_cache()

    def _unavailable(*args: object, **kwargs: object) -> object:
        raise RuntimeError("network disabled in unit tests")

    monkeypatch.setattr(client_release_manifest, "_manifest_loader", _unavailable)
    yield
    client_release_manifest.reset_cache()


def _build_app() -> FastAPI:
    app = FastAPI()

    @app.middleware("http")
    async def _inject_identity(request: Request, call_next):
        user_id = request.headers.get("X-Test-User", "").strip()
        if user_id:
            request.state.user_id = user_id
            request.state.token_kind = request.headers.get("X-Test-Kind", "user")
        return await call_next(request)

    app.include_router(clients_router.router)
    return app


@pytest.fixture
def app_client():
    with TestClient(_build_app()) as client:
        yield client


@pytest.fixture
def fake_config(monkeypatch):
    def _apply(**overrides: object) -> SimpleNamespace:
        cfg = _cfg(**overrides)
        monkeypatch.setattr(clients_catalog, "get_config", lambda: cfg)
        return cfg

    return _apply


@pytest.fixture
def assets(tmp_path, monkeypatch, fake_config):
    fake_config()
    apk_dir = tmp_path / "ota"
    apk_dir.mkdir()
    (apk_dir / "app-debug.apk").write_bytes(b"APK" * 512)
    (apk_dir / "output-metadata.json").write_text(
        json.dumps(
            {
                "elements": [
                    {
                        "versionName": "9.9.9",
                        "variantName": "debug",
                        "outputFile": "app-debug.apk",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    release = tmp_path / "release"
    release.mkdir()
    (release / "Kinship-Desktop-Setup-1.0.0-x64.exe").write_bytes(b"EXE" * 512)
    monkeypatch.setenv("OTA_FILE_DIR", str(apk_dir))
    monkeypatch.setenv("KINSHIP_DESKTOP_RELEASE_DIR", str(release))
    return SimpleNamespace(apk_dir=apk_dir, release=release)


class TestOnboardingClients:
    def test_bearer_required_when_user_exists(self, app_client, assets):
        resp = app_client.get("/api/system/onboarding/clients")
        assert resp.status_code == 401

    def test_bootstrap_mode_allows_read(self, app_client, assets, monkeypatch):
        monkeypatch.setattr(auth, "is_setup_required", lambda: True)
        resp = app_client.get("/api/system/onboarding/clients")
        assert resp.status_code == 200
        assert resp.json()["android"]["available"] is True

    def test_catalog_shape_and_no_pc_sensor(self, app_client, assets):
        resp = app_client.get(
            "/api/system/onboarding/clients",
            headers={"X-Test-User": "alice"},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()

        assert set(data) == {"android", "desktop", "connection"}
        assert data["android"]["kind"] == "android"
        assert data["desktop"]["kind"] == "desktop"
        assert data["android"]["available"] is True
        assert data["desktop"]["available"] is True
        assert data["android"]["size"] > 0
        assert data["desktop"]["size"] > 0
        assert len(data["android"]["sha256"]) == 64
        assert len(data["desktop"]["sha256"]) == 64
        assert "pc_sensor" not in json.dumps(data).lower()
        assert "pcsensor" not in json.dumps(data).lower()

    def test_missing_assets_fall_back_to_github_page(
        self, app_client, tmp_path, monkeypatch, fake_config
    ):
        fake_config()
        empty = tmp_path / "empty"
        empty.mkdir()
        monkeypatch.setenv("OTA_FILE_DIR", str(empty))
        monkeypatch.setenv("KINSHIP_DESKTOP_RELEASE_DIR", str(empty))

        resp = app_client.get(
            "/api/system/onboarding/clients",
            headers={"X-Test-User": "alice"},
        )
        assert resp.status_code == 200
        data = resp.json()
        for kind in ("android", "desktop"):
            assert data[kind]["available"] is True
            assert data[kind]["source"] == "github"
            assert data[kind]["action"] == "external"
            assert data[kind]["page_url"].endswith(
                "/releases/tag/onboarding-v1.0.0"
            )


class TestDesktopDownload:
    def test_ticket_downloads_local_file_once(self, app_client, assets):
        ticket, _ = auth.create_ws_ticket("Axeuh")

        first = app_client.get(
            "/api/clients/desktop/download", params={"ticket": ticket}
        )
        assert first.status_code == 200
        assert first.content == b"EXE" * 512
        assert first.headers["x-file-size"] == str(len(b"EXE" * 512))
        assert len(first.headers["x-file-sha256"]) == 64
        assert "Kinship-Desktop-Setup-1.0.0-x64.exe" in first.headers[
            "content-disposition"
        ]

        second = app_client.get(
            "/api/clients/desktop/download", params={"ticket": ticket}
        )
        assert second.status_code == 401

    def test_bearer_header_authorizes(self, app_client, assets):
        resp = app_client.get(
            "/api/clients/desktop/download",
            headers={"X-Test-User": "alice"},
        )
        assert resp.status_code == 200

    def test_configured_url_redirects_when_local_missing(
        self, app_client, tmp_path, monkeypatch, fake_config
    ):
        empty = tmp_path / "empty"
        empty.mkdir()
        monkeypatch.setenv("KINSHIP_DESKTOP_RELEASE_DIR", str(empty))
        fake_config(
            CLIENTS_DESKTOP_URL="https://example.test/Kinship-Desktop-Setup-2.0.0-x64.exe"
        )
        resp = app_client.get(
            "/api/clients/desktop/download",
            headers={"X-Test-User": "alice"},
            follow_redirects=False,
        )
        assert resp.status_code == 302
        assert resp.headers["location"] == (
            "https://example.test/Kinship-Desktop-Setup-2.0.0-x64.exe"
        )

    def test_local_file_wins_over_configured_url(self, app_client, assets, fake_config):
        fake_config(
            CLIENTS_DESKTOP_URL="https://example.test/Kinship-Desktop-Setup-2.0.0-x64.exe"
        )
        resp = app_client.get(
            "/api/clients/desktop/download",
            headers={"X-Test-User": "alice"},
            follow_redirects=False,
        )
        assert resp.status_code == 200
        assert resp.content == b"EXE" * 512

    def test_invalid_ticket_rejected(self, app_client, assets):
        resp = app_client.get(
            "/api/clients/desktop/download", params={"ticket": "bogus"}
        )
        assert resp.status_code == 401

    def test_missing_file_returns_404(
        self, app_client, tmp_path, monkeypatch, fake_config
    ):
        fake_config()
        empty = tmp_path / "empty"
        empty.mkdir()
        monkeypatch.setenv("KINSHIP_DESKTOP_RELEASE_DIR", str(empty))

        resp = app_client.get(
            "/api/clients/desktop/download",
            headers={"X-Test-User": "alice"},
        )
        assert resp.status_code == 404

    def test_query_file_parameter_cannot_escape(self, app_client, assets):
        resp = app_client.get(
            "/api/clients/desktop/download",
            params={"file": "../../../../etc/passwd"},
            headers={"X-Test-User": "alice"},
        )
        assert resp.status_code == 200
        assert resp.content == b"EXE" * 512

    def test_symlink_escape_returns_404(self, app_client, tmp_path, monkeypatch, fake_config):
        fake_config()
        release = tmp_path / "release"
        release.mkdir()
        outside = tmp_path / "outside.exe"
        outside.write_bytes(b"secret")
        (release / "Kinship-Desktop-Setup-6.6.6-x64.exe").symlink_to(outside)
        monkeypatch.setenv("KINSHIP_DESKTOP_RELEASE_DIR", str(release))

        resp = app_client.get(
            "/api/clients/desktop/download",
            headers={"X-Test-User": "alice"},
        )
        assert resp.status_code == 404


class TestDesktopDownloadTicketScope:
    def test_download_scope_ticket_downloads_once(self, app_client, assets):
        ticket, _ = auth.create_ws_ticket(
            "Axeuh", ttl_seconds=60, scope=auth.TICKET_SCOPE_DOWNLOAD
        )

        first = app_client.get(
            "/api/clients/desktop/download", params={"ticket": ticket}
        )
        assert first.status_code == 200
        assert first.content == b"EXE" * 512

        second = app_client.get(
            "/api/clients/desktop/download", params={"ticket": ticket}
        )
        assert second.status_code == 401

    def test_generic_ticket_downloads(self, app_client, assets):
        ticket, _ = auth.create_ws_ticket("Axeuh", ttl_seconds=60)

        resp = app_client.get(
            "/api/clients/desktop/download", params={"ticket": ticket}
        )
        assert resp.status_code == 200
        assert resp.content == b"EXE" * 512

    def test_invalid_ticket_rejected(self, app_client, assets):
        resp = app_client.get(
            "/api/clients/desktop/download", params={"ticket": "not-a-ticket"}
        )
        assert resp.status_code == 401
