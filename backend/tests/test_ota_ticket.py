# -*- coding: utf-8 -*-
"""OTA ticket contract: 60s one-time ticket, actual filename, legacy token."""
from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import auth
from config.config import get_config
from routers import ota

_TEST_HOST = f"localhost:{get_config().BACKEND_HTTPS_PORT}"
_FAKE_APK = b"FAKE-APK-BYTES" * 2048


def _headers(auth_headers) -> dict[str, str]:
    return {**auth_headers, "host": _TEST_HOST}


def _write_apk(tmp_path: Path, name: str = "app-debug.apk") -> Path:
    apk_dir = tmp_path / "ota"
    apk_dir.mkdir()
    apk = apk_dir / name
    apk.write_bytes(_FAKE_APK)
    (apk_dir / "output-metadata.json").write_text(
        json.dumps(
            {
                "version": 3,
                "elements": [
                    {
                        "type": "SINGLE",
                        "attributes": [],
                        "versionCode": 11,
                        "versionName": "9.9.9",
                        "variantName": "debug",
                        "outputFile": name,
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    return apk


@pytest.fixture
def apk(tmp_path, monkeypatch):
    apk = _write_apk(tmp_path)
    monkeypatch.setenv("OTA_FILE_DIR", str(apk.parent))
    return apk


class TestTicketIssue:
    def test_requires_bearer(self, client):
        resp = client.post("/api/ota/ticket", headers={"host": _TEST_HOST})
        assert resp.status_code == 401

    def test_issue_returns_metadata_without_bearer_in_url(
        self, client, auth_headers, apk
    ):
        resp = client.post("/api/ota/ticket", headers=_headers(auth_headers))
        assert resp.status_code == 200, resp.text
        body = resp.json()

        assert set(body) >= {
            "ticket",
            "url",
            "expires_at",
            "filename",
            "sha256",
            "size",
        }
        assert len(body["ticket"]) == 64
        assert body["url"] == f"/api/ota/download?ticket={body['ticket']}"
        assert "token=" not in body["url"]
        bearer = auth_headers["Authorization"].split(" ", 1)[1]
        assert bearer not in body["url"]
        assert body["filename"] == "Kinship-9.9.9-debug.apk"
        assert body["filename"] != "Kinship-v1.1.0.apk"
        assert body["source_filename"] == "app-debug.apk"
        assert body["sha256"] == hashlib.sha256(_FAKE_APK).hexdigest()
        assert body["size"] == len(_FAKE_APK)
        assert 55 <= body["expires_at"] - time.time() <= 65
        assert body["expires_in"] == 60

    def test_missing_apk_returns_404(self, client, auth_headers, tmp_path, monkeypatch):
        empty = tmp_path / "empty"
        empty.mkdir()
        monkeypatch.setenv("OTA_FILE_DIR", str(empty))
        resp = client.post("/api/ota/ticket", headers=_headers(auth_headers))
        assert resp.status_code == 404
        assert "不存在" in resp.text


class TestTicketScope:
    def test_issued_ticket_has_download_scope(self, client, auth_headers, apk):
        ticket = client.post(
            "/api/ota/ticket", headers=_headers(auth_headers)
        ).json()["ticket"]

        with auth._ws_ticket_lock:
            assert auth._ws_tickets[ticket]["scope"] == auth.TICKET_SCOPE_DOWNLOAD

    def test_ota_ticket_rejected_on_other_query_path_without_consuming(
        self, client, auth_headers, apk
    ):
        ticket = client.post(
            "/api/ota/ticket", headers=_headers(auth_headers)
        ).json()["ticket"]

        blocked = client.get(
            "/api/mobile/files",
            params={"ticket": ticket},
            headers={"host": _TEST_HOST},
        )
        assert blocked.status_code == 401

        download = client.get(
            "/api/ota/download",
            params={"ticket": ticket},
            headers={"host": _TEST_HOST},
        )
        assert download.status_code == 200
        assert download.content == _FAKE_APK

    def test_ota_ticket_rejected_on_sse(self, client, auth_headers, apk):
        ticket = client.post(
            "/api/ota/ticket", headers=_headers(auth_headers)
        ).json()["ticket"]

        resp = client.get(
            "/api/screen/events/stream",
            params={"ticket": ticket},
            headers={"host": _TEST_HOST},
        )
        assert resp.status_code == 401

    def test_generic_ticket_works_for_download(self, client, apk):
        ticket, _ = auth.create_ws_ticket("Axeuh", ttl_seconds=60)

        resp = client.get(
            "/api/ota/download",
            params={"ticket": ticket},
            headers={"host": _TEST_HOST},
        )
        assert resp.status_code == 200
        assert resp.content == _FAKE_APK


class TestTicketConsume:
    def test_ticket_downloads_once(self, client, auth_headers, apk):
        ticket = client.post(
            "/api/ota/ticket", headers=_headers(auth_headers)
        ).json()["ticket"]

        first = client.get(
            "/api/ota/download",
            params={"ticket": ticket},
            headers={"host": _TEST_HOST},
        )
        assert first.status_code == 200
        assert first.content == _FAKE_APK
        assert first.headers["content-md5"] == hashlib.md5(_FAKE_APK).hexdigest()
        assert first.headers["x-file-size"] == str(len(_FAKE_APK))
        assert first.headers["x-package-name"] == "com.xehuri.kinship"
        assert "Kinship-9.9.9-debug.apk" in first.headers["content-disposition"]

        second = client.get(
            "/api/ota/download",
            params={"ticket": ticket},
            headers={"host": _TEST_HOST},
        )
        assert second.status_code == 401

    def test_expired_ticket_rejected(self, client, auth_headers, apk):
        ticket = client.post(
            "/api/ota/ticket", headers=_headers(auth_headers)
        ).json()["ticket"]
        with auth._ws_ticket_lock:
            auth._ws_tickets[ticket]["expires_at"] = 0

        resp = client.get(
            "/api/ota/download",
            params={"ticket": ticket},
            headers={"host": _TEST_HOST},
        )
        assert resp.status_code == 401

    def test_invalid_ticket_rejected(self, client, apk):
        resp = client.get(
            "/api/ota/download",
            params={"ticket": "not-a-real-ticket"},
            headers={"host": _TEST_HOST},
        )
        assert resp.status_code == 401

    def test_legacy_query_token_still_works(self, client, auth_headers, apk):
        token = auth_headers["Authorization"].split(" ", 1)[1]
        resp = client.get(
            "/api/ota/download",
            params={"token": token},
            headers={"host": _TEST_HOST},
        )
        assert resp.status_code == 200
        assert resp.content == _FAKE_APK

    def test_no_auth_rejected(self, client, apk):
        resp = client.get("/api/ota/download", headers={"host": _TEST_HOST})
        assert resp.status_code == 401

    def test_route_level_ticket_validation_without_middleware(self, apk):
        app = FastAPI()
        app.include_router(ota.router)
        ticket, _ = auth.create_ws_ticket("Axeuh", ttl_seconds=60)

        with TestClient(app) as standalone:
            resp = standalone.get("/api/ota/download", params={"ticket": ticket})

        assert resp.status_code == 200
        assert resp.content == _FAKE_APK
