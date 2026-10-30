# -*- coding: utf-8 -*-
"""PC-M1：空 token 拒绝 + 常量时间比较（进程内 TestClient，不启动服务）。"""

from fastapi.testclient import TestClient

import pc_sensor_app

# 便于断言的最小合法 token（仅测试用）
_VALID_TOKEN = "unit-test-secret-token-0123456789abcdef"


def _client(monkeypatch, token: str = _VALID_TOKEN) -> TestClient:
    monkeypatch.setattr(pc_sensor_app, "AGENT_TOKEN", token)
    return TestClient(pc_sensor_app.app)


def test_missing_authorization_rejected(monkeypatch):
    client = _client(monkeypatch)
    assert client.get("/pc-sensor/status").status_code == 401


def test_empty_bearer_token_rejected(monkeypatch):
    """空 token 必须 401，不能被当作免认证。"""
    client = _client(monkeypatch)
    resp = client.get("/pc-sensor/status", headers={"Authorization": "Bearer "})
    assert resp.status_code == 401


def test_wrong_token_rejected(monkeypatch):
    client = _client(monkeypatch)
    resp = client.get("/pc-sensor/status", headers={"Authorization": "Bearer wrong-token"})
    assert resp.status_code == 401


def test_valid_token_accepted(monkeypatch):
    client = _client(monkeypatch)
    resp = client.get(
        "/pc-sensor/status", headers={"Authorization": f"Bearer {_VALID_TOKEN}"}
    )
    assert resp.status_code == 200
    assert resp.json()["running"] is False


def test_public_health_without_token(monkeypatch):
    client = _client(monkeypatch)
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


def test_uses_constant_time_compare():
    """源码层面确认使用 hmac.compare_digest，而非 == 比较。"""
    import inspect

    src = inspect.getsource(pc_sensor_app.verify_token)
    assert "hmac.compare_digest" in src
