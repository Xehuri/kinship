# -*- coding: utf-8 -*-
"""Windows Phase 1：配对码换取设备 Token 与凭据落盘。"""

import json
import logging
import ssl
from email.message import Message
from urllib.error import HTTPError, URLError

import pytest
from fastapi.testclient import TestClient

import pc_sensor_app
from pc_sensor import pairing, secret_store
from pc_sensor.manager import ENCRYPTED_TOKEN_KEY, SensorManager


class _FakeResponse:
    def __init__(self, payload: dict, status: int = 200):
        self.status = status
        self._raw = json.dumps(payload).encode("utf-8")

    def read(self) -> bytes:
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def _install_urlopen(monkeypatch, payload: dict | None = None, error: Exception | None = None) -> dict:
    captured: dict = {}

    def fake_urlopen(req, timeout=None, context=None):
        captured["url"] = req.full_url
        captured["body"] = json.loads(req.data.decode("utf-8"))
        captured["timeout"] = timeout
        captured["context"] = context
        if error is not None:
            raise error
        return _FakeResponse(payload or {})

    monkeypatch.setattr(pairing, "urlopen", fake_urlopen)
    return captured


# ============ 配对网络交换 ============


def test_enroll_posts_code_and_returns_token(monkeypatch):
    captured = _install_urlopen(
        monkeypatch,
        {
            "device_id": "pc-1",
            "device_token": "device-token",
            "signal_url": "wss://signal.example",
            "endpoints": {"ipv6": "https://home.example:23443"},
        },
    )

    result = pairing.enroll(
        "https://server.example:8768/",
        "12345678",
        "pc-1",
        "My PC",
        "windows",
    )

    assert captured["url"] == "https://server.example:8768/api/p2p/enroll"
    assert captured["body"] == {
        "pairing_code": "12345678",
        "device_id": "pc-1",
        "device_name": "My PC",
        "platform": "windows",
    }
    assert captured["context"].verify_mode == ssl.CERT_REQUIRED
    assert result["device_token"] == "device-token"
    assert result["signal_url"] == "wss://signal.example"


def test_enroll_rejects_missing_device_token(monkeypatch):
    _install_urlopen(monkeypatch, {"signal_url": "wss://signal.example"})

    with pytest.raises(pairing.PairingError, match="device_token"):
        pairing.enroll("https://server.example", "12345678", "pc-1", "PC", "windows")


def test_enroll_rejects_missing_signal_url(monkeypatch):
    _install_urlopen(monkeypatch, {"device_token": "device-token"})

    with pytest.raises(pairing.PairingError, match="signal_url"):
        pairing.enroll("https://server.example", "12345678", "pc-1", "PC", "windows")


def test_enroll_rejects_invalid_pairing_code_without_network(monkeypatch):
    def fail_network(*args, **kwargs):
        raise AssertionError("非法配对码不应发起网络请求")

    monkeypatch.setattr(pairing, "urlopen", fail_network)

    with pytest.raises(pairing.PairingError, match="8 位数字"):
        pairing.enroll("https://server.example", "1234", "pc-1", "PC", "windows")


def test_enroll_maps_http_error_without_echoing_secrets(monkeypatch):
    req_error = HTTPError("https://server.example/api/p2p/enroll", 400, "Bad Request", Message(), None)
    _install_urlopen(monkeypatch, error=req_error)

    with pytest.raises(pairing.PairingError) as excinfo:
        pairing.enroll("https://server.example", "87654321", "pc-1", "PC", "windows")

    message = str(excinfo.value)
    assert "400" in message
    assert "87654321" not in message


def test_enroll_maps_network_error(monkeypatch):
    _install_urlopen(monkeypatch, error=URLError("unreachable"))

    with pytest.raises(pairing.PairingError, match="无法连接服务器"):
        pairing.enroll("https://server.example", "12345678", "pc-1", "PC", "windows")


def test_enroll_does_not_log_code_or_token(monkeypatch, caplog):
    caplog.set_level(logging.DEBUG, logger="pc_sensor.pairing")
    _install_urlopen(
        monkeypatch,
        {
            "device_id": "pc-1",
            "device_token": "super-secret-device-token",
            "signal_url": "wss://signal.example",
        },
    )

    pairing.enroll("https://server.example", "24681357", "pc-1", "PC", "windows")

    assert "24681357" not in caplog.text
    assert "super-secret-device-token" not in caplog.text


def test_enroll_failure_does_not_log_code(monkeypatch, caplog):
    caplog.set_level(logging.DEBUG, logger="pc_sensor.pairing")
    _install_urlopen(monkeypatch, error=URLError("unreachable"))

    with pytest.raises(pairing.PairingError):
        pairing.enroll("https://server.example", "13572468", "pc-1", "PC", "windows")

    assert "13572468" not in caplog.text


def test_candidates_from_endpoints_prefers_ipv6():
    candidates = pairing.candidates_from_endpoints(
        {"frp": "https://frp.example:8768", "ipv6": "https://home.example:23443"}
    )

    assert [entry["name"] for entry in candidates] == ["ipv6", "frp"]


def test_candidates_from_endpoints_ignores_invalid_entries():
    assert pairing.candidates_from_endpoints({"lan": "ftp://192.168.1.2"}) == []


# ============ 凭据落盘 ============


def test_manager_loads_encrypted_backend_token_when_plaintext_absent(tmp_path, monkeypatch):
    monkeypatch.setattr(secret_store, "unprotect", lambda blob: "paired-token" if blob == "enc-blob" else None)
    cfg_path = tmp_path / "pc_sensor_config.json"
    cfg_path.write_text(
        json.dumps({"server_url": "", "backend_token_enc": "enc-blob"}),
        encoding="utf-8",
    )

    manager = SensorManager(config_path=str(cfg_path))

    assert manager._cfg["backend_token"] == "paired-token"
    assert manager.uploader._auth_token == "paired-token"
    assert manager.config["backend_token"] == "******"
    assert ENCRYPTED_TOKEN_KEY not in manager.config


def test_pairing_token_is_persisted_encrypted_not_plaintext(tmp_path, monkeypatch):
    monkeypatch.setattr(secret_store, "protect", lambda value: f"enc:{value}")
    monkeypatch.setattr(secret_store, "unprotect", lambda blob: blob.removeprefix("enc:"))
    cfg_path = tmp_path / "pc_sensor_config.json"
    manager = SensorManager(config_path=str(cfg_path))

    manager.update_config({"backend_token": "paired-token"}, encrypt_backend_token=True)

    saved = json.loads(cfg_path.read_text(encoding="utf-8"))
    assert saved["backend_token_enc"] == "enc:paired-token"
    assert "backend_token" not in saved

    reloaded = SensorManager(config_path=str(cfg_path))
    assert reloaded.uploader._auth_token == "paired-token"


def test_manual_token_replaces_encrypted_pairing_token(tmp_path, monkeypatch):
    monkeypatch.setattr(secret_store, "protect", lambda value: f"enc:{value}")
    monkeypatch.setattr(secret_store, "unprotect", lambda blob: blob.removeprefix("enc:"))
    cfg_path = tmp_path / "pc_sensor_config.json"
    manager = SensorManager(config_path=str(cfg_path))
    manager.update_config({"backend_token": "paired-token"}, encrypt_backend_token=True)

    manager.update_config({"backend_token": "manual-token"})

    saved = json.loads(cfg_path.read_text(encoding="utf-8"))
    assert saved["backend_token"] == "manual-token"
    assert ENCRYPTED_TOKEN_KEY not in saved
    assert SensorManager(config_path=str(cfg_path)).uploader._auth_token == "manual-token"


def test_plaintext_backend_token_still_supported(tmp_path, monkeypatch):
    monkeypatch.setattr(secret_store, "protect", lambda value: None)
    cfg_path = tmp_path / "pc_sensor_config.json"
    manager = SensorManager(config_path=str(cfg_path))

    manager.update_config({"backend_token": "plain-token"}, encrypt_backend_token=True)

    saved = json.loads(cfg_path.read_text(encoding="utf-8"))
    assert saved["backend_token"] == "plain-token"
    assert ENCRYPTED_TOKEN_KEY not in saved


# ============ 本地 HTTP 接口 ============

VALID_TOKEN = "unit-test-pairing-token-0123456789"


class _FakeManager:
    def __init__(self):
        self.config = {
            "agent_id": "pc-1",
            "agent_name": "Test PC",
            "server_url": "https://server.example:8768",
            "ssl_verify": True,
            "ssl_ca_file": "",
            "backend_token": "******",
            "endpoint_candidates": [],
        }
        self.calls: list[tuple[dict, bool]] = []

    def update_config(self, updates, *, encrypt_backend_token=False):
        self.calls.append((dict(updates), encrypt_backend_token))
        self.config.update(updates)
        result = dict(self.config)
        if result.get("backend_token"):
            result["backend_token"] = "******"
        return result


def _client(monkeypatch) -> TestClient:
    monkeypatch.setattr(pc_sensor_app, "AGENT_TOKEN", VALID_TOKEN)
    return TestClient(pc_sensor_app.app)


def _auth() -> dict[str, str]:
    return {"Authorization": f"Bearer {VALID_TOKEN}"}


def test_pair_endpoint_requires_bearer_token(monkeypatch):
    client = _client(monkeypatch)
    response = client.post("/pc-sensor/pair", json={"pairing_code": "12345678"})
    assert response.status_code == 401


def test_pair_endpoint_updates_config_and_masks_token(monkeypatch):
    fake = _FakeManager()
    monkeypatch.setattr(pc_sensor_app, "_pc_sensor_manager", fake)
    monkeypatch.setattr(
        pc_sensor_app.pairing,
        "enroll",
        lambda **kwargs: {
            "device_id": "pc-1",
            "device_token": "device-token-secret",
            "signal_url": "wss://signal.example",
            "endpoints": {"frp": "https://frp.example:8768", "ipv6": "https://home.example:23443"},
        },
    )
    client = _client(monkeypatch)

    response = client.post(
        "/pc-sensor/pair",
        json={"pairing_code": "12345678", "server_url": "https://server.example:8768"},
        headers=_auth(),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    assert body["config"]["backend_token"] == "******"
    assert "device-token-secret" not in response.text

    updates, encrypt_flag = fake.calls[0]
    assert encrypt_flag is True
    assert updates["backend_token"] == "device-token-secret"
    assert updates["server_url"] == "https://server.example:8768"
    assert [entry["name"] for entry in updates["endpoint_candidates"]] == ["ipv6", "frp"]


def test_pair_endpoint_reports_pairing_error(monkeypatch):
    fake = _FakeManager()
    monkeypatch.setattr(pc_sensor_app, "_pc_sensor_manager", fake)

    def fail_enroll(**kwargs):
        raise pairing.PairingError("配对失败（HTTP 400）")

    monkeypatch.setattr(pc_sensor_app.pairing, "enroll", fail_enroll)
    client = _client(monkeypatch)

    response = client.post(
        "/pc-sensor/pair",
        json={"pairing_code": "12345678", "server_url": "https://server.example:8768"},
        headers=_auth(),
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "配对失败（HTTP 400）"
    assert fake.calls == []
