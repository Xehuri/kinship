# -*- coding: utf-8 -*-
"""PC-M10：认证失败原因可见（auth_error / 测试登录端点）。"""

import json
from email.message import Message
from types import SimpleNamespace
from urllib.error import HTTPError, URLError

from fastapi.testclient import TestClient

import pc_sensor_app
from pc_sensor.manager import SensorManager
from pc_sensor.uploader import Uploader

VALID_TOKEN = "unit-test-auth-error-token-0123456789"


class _FakeResponse:
    def __init__(self, status: int = 200, payload: dict | None = None):
        self.status = status
        self._payload = json.dumps(payload or {}).encode("utf-8")

    def read(self) -> bytes:
        return self._payload

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class _FakeUploader:
    def __init__(self, success: bool, auth_error: str = "", has_token: bool = True):
        self._success = success
        self.auth_error = auth_error
        self.has_token = has_token

    def force_relogin(self) -> bool:
        return self._success


def _client(monkeypatch) -> TestClient:
    monkeypatch.setattr(pc_sensor_app, "AGENT_TOKEN", VALID_TOKEN)
    return TestClient(pc_sensor_app.app)


def _auth() -> dict[str, str]:
    return {"Authorization": f"Bearer {VALID_TOKEN}"}


def _manager(uploader: _FakeUploader) -> SimpleNamespace:
    return SimpleNamespace(uploader=uploader)


# ============ Uploader.auth_error ============


def test_missing_credentials_sets_chinese_error():
    up = Uploader("https://example.invalid", "", "", "agent")

    assert up.has_token is False
    assert "未配置" in up.auth_error


def test_wrong_password_uses_backend_message(monkeypatch):
    def fake_urlopen(req, timeout=None, context=None):
        return _FakeResponse(200, {"success": False, "message": "用户名或密码错误"})

    monkeypatch.setattr("pc_sensor.uploader.urlopen", fake_urlopen)
    up = Uploader("https://example.invalid", "u", "wrong", "agent")

    assert up.has_token is False
    assert up.auth_error == "用户名或密码错误"


def test_wrong_password_without_message_uses_generic(monkeypatch):
    def fake_urlopen(req, timeout=None, context=None):
        return _FakeResponse(200, {"success": False})

    monkeypatch.setattr("pc_sensor.uploader.urlopen", fake_urlopen)
    up = Uploader("https://example.invalid", "u", "wrong", "agent")

    assert up.auth_error == "用户名或密码错误"


def test_backend_message_never_leaks_password(monkeypatch):
    secret = "p@ssw0rd-not-for-logs"

    def fake_urlopen(req, timeout=None, context=None):
        return _FakeResponse(
            200, {"success": False, "message": f"invalid credentials: {secret}"}
        )

    monkeypatch.setattr("pc_sensor.uploader.urlopen", fake_urlopen)
    up = Uploader("https://example.invalid", "u", secret, "agent")

    assert secret not in up.auth_error
    assert "******" in up.auth_error


def test_unreachable_backend_does_not_blame_password(monkeypatch):
    def fake_urlopen(req, timeout=None, context=None):
        raise URLError("connection refused")

    monkeypatch.setattr("pc_sensor.uploader.urlopen", fake_urlopen)
    up = Uploader("https://example.invalid", "u", "p", "agent")

    assert up.auth_error == "无法连接服务器"


def test_static_token_rejection_sets_token_error(monkeypatch):
    up = Uploader("https://example.invalid", "", "", "agent", auth_token="bad-static-token")
    assert up.has_token is True

    def fake_urlopen(req, timeout=None, context=None):
        raise HTTPError(req.full_url, 401, "Unauthorized", Message(), None)

    monkeypatch.setattr("pc_sensor.uploader.urlopen", fake_urlopen)

    assert up._send_batch([{"i": 1}]) is False
    assert up.has_token is False
    assert up.auth_error == "后端 Token 已被拒绝"
    assert "bad-static-token" not in up.auth_error


def test_successful_forced_relogin_clears_auth_error(monkeypatch):
    def failing_urlopen(req, timeout=None, context=None):
        raise URLError("offline")

    monkeypatch.setattr("pc_sensor.uploader.urlopen", failing_urlopen)
    up = Uploader("https://example.invalid", "u", "p", "agent")
    assert up.auth_error == "无法连接服务器"

    def working_urlopen(req, timeout=None, context=None):
        return _FakeResponse(200, {"success": True, "token": "fresh-token"})

    monkeypatch.setattr("pc_sensor.uploader.urlopen", working_urlopen)

    assert up.force_relogin() is True
    assert up.auth_error == ""


# ============ Manager 状态 ============


def test_manager_status_includes_auth_error(tmp_path):
    path = tmp_path / "pc_sensor_config.json"
    path.write_text(
        json.dumps({"enabled": True, "server_url": "", "username": "u"}),
        encoding="utf-8",
    )

    status = SensorManager(config_path=str(path)).get_status()

    assert status["logged_in"] is False
    assert "未配置" in status["auth_error"]


# ============ POST /pc-sensor/test-login ============


def test_test_login_requires_bearer_token(monkeypatch):
    client = _client(monkeypatch)

    assert client.post("/pc-sensor/test-login").status_code == 401


def test_test_login_reports_credentials_rejected(monkeypatch):
    monkeypatch.setattr(
        pc_sensor_app,
        "_pc_sensor_manager",
        _manager(_FakeUploader(False, "用户名或密码错误", has_token=False)),
    )
    client = _client(monkeypatch)

    resp = client.post("/pc-sensor/test-login", headers=_auth())

    assert resp.status_code == 200
    assert resp.json() == {
        "success": False,
        "logged_in": False,
        "auth_error": "用户名或密码错误",
        "message": "用户名或密码错误",
    }


def test_test_login_reports_success_and_keeps_collector_running(monkeypatch):
    monkeypatch.setattr(
        pc_sensor_app,
        "_pc_sensor_manager",
        _manager(_FakeUploader(True)),
    )
    client = _client(monkeypatch)

    resp = client.post("/pc-sensor/test-login", headers=_auth())

    assert resp.status_code == 200
    assert resp.json() == {
        "success": True,
        "logged_in": True,
        "auth_error": "",
        "message": "登录成功",
    }


def test_test_login_maps_unreachable_error(monkeypatch):
    monkeypatch.setattr(
        pc_sensor_app,
        "_pc_sensor_manager",
        _manager(_FakeUploader(False, "无法连接服务器", has_token=False)),
    )
    client = _client(monkeypatch)

    payload = client.post("/pc-sensor/test-login", headers=_auth()).json()

    assert payload["success"] is False
    assert payload["message"] == "无法连接服务器"
