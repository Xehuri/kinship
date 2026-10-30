# -*- coding: utf-8 -*-
"""小米健康云 API 契约测试：鉴权、状态、开关、扫码与同步。"""

from unittest.mock import MagicMock

import pytest


@pytest.fixture()
def cloud_service(monkeypatch):
    import routers.health_cloud as router_mod

    service = MagicMock()
    service.status.return_value = {"phase": "ok", "enabled": True}
    service.request_qr.return_value = {
        "lp": "https://example.invalid/lp",
        "qr_base64": "iVBORw0KGgo=",
        "expires_in": 300,
    }
    service.poll_qr_once.return_value = {"state": "waiting"}
    service.pull_once.return_value = {"ok": True, "written": 2}
    service.backfill.return_value = {"ok": True, "written": 5}
    service.latest_cloud_samples.return_value = {"ok": True, "samples": {}}
    monkeypatch.setattr(router_mod, "get_health_cloud_service", lambda: service)
    return service


def test_status_requires_auth(client):
    assert client.get("/api/health/cloud/status").status_code == 401


def test_status_returns_service_snapshot(client, auth_headers, cloud_service):
    resp = client.get("/api/health/cloud/status", headers=auth_headers)
    assert resp.status_code == 200
    assert resp.json()["phase"] == "ok"


def test_enable_toggles_service(client, auth_headers, cloud_service):
    resp = client.post(
        "/api/health/cloud/enable", json={"enabled": True}, headers=auth_headers
    )
    assert resp.status_code == 200
    cloud_service.set_enabled.assert_called_once_with(True)


def test_qr_returns_base64_payload(client, auth_headers, cloud_service):
    resp = client.post("/api/health/cloud/qr", headers=auth_headers)
    assert resp.status_code == 200
    assert resp.json()["qr_base64"].startswith("iVBOR")
    cloud_service.request_qr.assert_called_once()


def test_qr_poll_reports_waiting(client, auth_headers, cloud_service):
    resp = client.post(
        "/api/health/cloud/qr/poll",
        json={"lp": "https://example.invalid/lp"},
        headers=auth_headers,
    )
    assert resp.status_code == 200
    assert resp.json()["state"] == "waiting"


def test_sync_default_uses_pull_once(client, auth_headers, cloud_service):
    resp = client.post("/api/health/cloud/sync", json={}, headers=auth_headers)
    assert resp.status_code == 200
    cloud_service.pull_once.assert_called_once()
    cloud_service.backfill.assert_not_called()


def test_sync_with_days_uses_backfill(client, auth_headers, cloud_service):
    resp = client.post(
        "/api/health/cloud/sync", json={"days": 30}, headers=auth_headers
    )
    assert resp.status_code == 200
    cloud_service.backfill.assert_called_once_with(30)


def test_sync_failure_maps_to_502(client, auth_headers, cloud_service):
    cloud_service.pull_once.return_value = {"ok": False, "error": "凭据失效"}
    resp = client.post("/api/health/cloud/sync", json={}, headers=auth_headers)
    assert resp.status_code == 502
    assert "凭据失效" in resp.text


def test_qr_failure_maps_to_502(client, auth_headers, cloud_service):
    cloud_service.request_qr.side_effect = RuntimeError("network down")
    resp = client.post("/api/health/cloud/qr", headers=auth_headers)
    assert resp.status_code == 502
