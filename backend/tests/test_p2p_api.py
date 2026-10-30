# -*- coding: utf-8 -*-
"""P2P API：禁用 404、启用配对/状态/撤销、设备 token 鉴权。"""
from types import SimpleNamespace

import pytest

import auth
import routers.p2p as p2p_router
from services.p2p.config import P2PConfig
from services.p2p.manager import P2PManager
from services.p2p.tokens import SignalTicketIssuer


class FakeManager:
    def __init__(self, enabled=True):
        self.config = SimpleNamespace(
            enabled=enabled,
            allow_shared_token=False,
            room="home",
            server_id="home",
            signal_url="wss://signal.example.com",
            endpoints={"frp": "https://home.example.com:8768"},
        )
        self.pairing = ("12345678", 1_700_000_300)
        self.devices = [
            SimpleNamespace(
                device_id="dev-1",
                name="Phone",
                platform="android",
                user_id="Axeuh",
                created_at=1,
                last_seen=2,
                revoked_at=None,
                token_fingerprint="must-not-leak",
            )
        ]
        self.enroll_calls = []
        self.ticket_calls = []
        self.auto_enroll_flags = []
        self.revoked = []

    def issue_pairing_code(self, user_id):
        return self.pairing

    def enroll(self, pairing_code, device_id, device_name, platform):
        self.enroll_calls.append((pairing_code, device_id, device_name, platform))
        return {
            "device_id": device_id,
            "user_id": "Axeuh",
            "device_token": "device-token",
            "signal_url": self.config.signal_url,
            "room": "home",
            "endpoints": dict(self.config.endpoints),
            "signal_ticket": "v1.ticket",
            "signal_ticket_expires_at": 1_700_000_600_000,
        }

    def status(self):
        return {
            "enabled": True,
            "signal_connected": False,
            "room": "home",
            "endpoints": dict(self.config.endpoints),
            "device_count": len(self.devices),
            "server_id": "home",
        }

    def list_devices(self, user_id=None):
        return [device for device in self.devices if user_id in (None, device.user_id)]

    def get_device(self, device_id):
        return next(
            (device for device in self.devices if device.device_id == device_id), None
        )

    def issue_signal_ticket(self, user_id, device_id, *, allow_auto_enroll=True):
        self.ticket_calls.append((user_id, device_id))
        self.auto_enroll_flags.append(allow_auto_enroll)
        return "v1.ticket", 1_700_000_600_000

    async def revoke_device(self, device_id):
        self.revoked.append(device_id)
        return 2


@pytest.fixture(autouse=True)
def _reset_rate_limiter():
    p2p_router._enroll_limiter.reset()
    yield
    p2p_router._enroll_limiter.reset()


@pytest.fixture
def enabled_manager(monkeypatch):
    manager = FakeManager(enabled=True)
    monkeypatch.setattr(p2p_router, "get_p2p_manager", lambda: manager)
    return manager


@pytest.fixture
def disabled_manager(monkeypatch):
    manager = FakeManager(enabled=False)
    monkeypatch.setattr(p2p_router, "get_p2p_manager", lambda: manager)
    return manager


def _enroll_payload(device_id="dev-1"):
    return {
        "pairing_code": "12345678",
        "device_id": device_id,
        "device_name": "Phone",
        "platform": "android",
    }


def _use_memory_auth(monkeypatch):
    import main as main_module

    config = auth.AuthConfig(users={}, tokens={})
    monkeypatch.setattr(auth, "get_auth_config", lambda: config)
    monkeypatch.setattr(auth, "save_auth_config", lambda _config: None)
    monkeypatch.setattr(auth, "_auth_config", config)
    main_module.app.state.onboarding_state_completed = True
    return config


def test_disabled_returns_404_for_all_endpoints(client, auth_headers, disabled_manager):
    assert client.post("/api/p2p/pairing-code", headers=auth_headers).status_code == 404
    assert client.post("/api/p2p/signal-ticket", headers=auth_headers).status_code == 404
    assert client.get("/api/p2p/status", headers=auth_headers).status_code == 404
    assert client.get("/api/p2p/devices", headers=auth_headers).status_code == 404
    assert (
        client.post("/api/p2p/devices/dev-1/revoke", headers=auth_headers).status_code
        == 404
    )
    assert client.post("/api/p2p/enroll", json=_enroll_payload()).status_code == 404


def test_disabled_returns_404_before_authentication(client, disabled_manager):
    assert client.get("/api/p2p/status").status_code == 404
    assert client.post("/api/p2p/pairing-code").status_code == 404
    assert client.post("/api/p2p/signal-ticket").status_code == 404
    assert client.get("/api/p2p/devices").status_code == 404
    assert client.post("/api/p2p/devices/dev-1/revoke").status_code == 404


def test_pairing_code_issued_without_logging_code(client, auth_headers, enabled_manager, caplog):
    caplog.set_level("INFO")

    response = client.post("/api/p2p/pairing-code", headers=auth_headers)

    assert response.status_code == 200
    assert response.json() == {
        "pairing_code": "12345678",
        "expires_at": 1_700_000_300,
    }
    assert "12345678" not in caplog.text


def test_enroll_is_public_and_returns_sanitized_payload(client, enabled_manager):
    response = client.post("/api/p2p/enroll", json=_enroll_payload())

    assert response.status_code == 200
    body = response.json()
    assert body["device_id"] == "dev-1"
    assert body["device_token"] == "device-token"
    assert body["signal_ticket"] == "v1.ticket"
    assert body["room"] == "home"
    assert enabled_manager.enroll_calls == [
        ("12345678", "dev-1", "Phone", "android")
    ]


def test_enroll_rate_limit_returns_429(client, enabled_manager):
    for _ in range(10):
        assert client.post("/api/p2p/enroll", json=_enroll_payload()).status_code == 200

    assert client.post("/api/p2p/enroll", json=_enroll_payload()).status_code == 429


def test_enroll_rejects_device_id_longer_than_64(client, enabled_manager):
    response = client.post("/api/p2p/enroll", json=_enroll_payload("a" * 65))

    assert response.status_code == 422
    assert enabled_manager.enroll_calls == []


def test_enroll_rate_limit_uses_forwarded_ip_first_hop(client, enabled_manager):
    headers = {"X-Forwarded-For": "203.0.113.10, 10.0.0.1"}
    for _ in range(10):
        assert (
            client.post(
                "/api/p2p/enroll", json=_enroll_payload(), headers=headers
            ).status_code
            == 200
        )

    assert (
        client.post(
            "/api/p2p/enroll", json=_enroll_payload(), headers=headers
        ).status_code
        == 429
    )


def test_enroll_rate_limit_isolates_forwarded_ips(client, enabled_manager):
    exhausted = {"X-Forwarded-For": "203.0.113.20"}
    for _ in range(10):
        assert (
            client.post(
                "/api/p2p/enroll", json=_enroll_payload(), headers=exhausted
            ).status_code
            == 200
        )

    other_ip = client.post(
        "/api/p2p/enroll",
        json=_enroll_payload(),
        headers={"X-Forwarded-For": "203.0.113.21"},
    )

    assert other_ip.status_code == 200


def test_enroll_rate_limit_falls_back_to_x_real_ip(client, enabled_manager):
    headers = {"X-Real-IP": "203.0.113.30"}
    for _ in range(10):
        assert (
            client.post(
                "/api/p2p/enroll", json=_enroll_payload(), headers=headers
            ).status_code
            == 200
        )

    assert (
        client.post(
            "/api/p2p/enroll", json=_enroll_payload(), headers=headers
        ).status_code
        == 429
    )


def test_status_and_devices_are_sanitized(client, auth_headers, enabled_manager):
    status_response = client.get("/api/p2p/status", headers=auth_headers)
    devices_response = client.get("/api/p2p/devices", headers=auth_headers)

    assert status_response.status_code == 200
    assert status_response.json() == {
        "enabled": True,
        "signal_connected": False,
        "room": "home",
        "endpoints": {"frp": "https://home.example.com:8768"},
        "device_count": 1,
        "server_id": "home",
    }
    assert devices_response.status_code == 200
    devices = devices_response.json()["devices"]
    assert devices[0]["device_id"] == "dev-1"
    assert devices[0]["revoked"] is False
    assert "token_fingerprint" not in devices[0]
    assert "must-not-leak" not in devices_response.text


def test_revoke_device_returns_token_count(client, auth_headers, enabled_manager):
    response = client.post(
        "/api/p2p/devices/dev-1/revoke", headers=auth_headers
    )

    assert response.status_code == 200
    assert response.json() == {"ok": True, "revoked_tokens": 2}
    assert enabled_manager.revoked == ["dev-1"]


def test_revoke_other_users_device_is_forbidden(client, auth_headers, enabled_manager):
    enabled_manager.devices[0].user_id = "someone-else"

    response = client.post(
        "/api/p2p/devices/dev-1/revoke", headers=auth_headers
    )

    assert response.status_code == 403
    assert enabled_manager.revoked == []


def test_signal_ticket_user_token_requires_device_header(
    client, auth_headers, enabled_manager
):
    missing = client.post("/api/p2p/signal-ticket", headers=auth_headers)
    ok = client.post(
        "/api/p2p/signal-ticket",
        headers={**auth_headers, "X-Device-Id": "dev-1"},
    )

    assert missing.status_code == 400
    assert ok.status_code == 200
    assert ok.json() == {
        "signal_ticket": "v1.ticket",
        "signal_ticket_expires_at": 1_700_000_600_000,
    }
    assert enabled_manager.ticket_calls == [("Axeuh", "dev-1")]
    assert enabled_manager.auto_enroll_flags == [True]


def test_signal_ticket_uses_device_token_binding(
    client, enabled_manager, monkeypatch
):
    _use_memory_auth(monkeypatch)
    device_token = auth.create_device_token("Axeuh", "dev-1")

    mismatched = client.post(
        "/api/p2p/signal-ticket",
        headers={
            "Authorization": f"Bearer {device_token}",
            "X-Device-Id": "dev-2",
        },
    )
    matched = client.post(
        "/api/p2p/signal-ticket",
        headers={"Authorization": f"Bearer {device_token}"},
    )

    assert mismatched.status_code == 403
    assert matched.status_code == 200
    assert enabled_manager.ticket_calls == [("Axeuh", "dev-1")]
    assert enabled_manager.auto_enroll_flags == [False]


def _real_manager(tmp_path, **overrides):
    raw = {
        "enabled": True,
        "server_id": "home",
        "room": "home",
        "signal_url": "wss://signal.example.com",
        "signal_secret_env": "P2P_SIGNAL_SECRET",
        "endpoints": {"frp": "https://home.example.com:8768"},
        "devices_path": str(tmp_path / "devices.json"),
    }
    raw.update(overrides)
    return P2PManager(P2PConfig.from_dict(raw))


def test_signal_ticket_user_token_auto_enrolls_unknown_device(
    client, auth_headers, tmp_path, monkeypatch
):
    monkeypatch.setenv("P2P_SIGNAL_SECRET", "secret")
    manager = _real_manager(tmp_path)
    monkeypatch.setattr(p2p_router, "get_p2p_manager", lambda: manager)
    headers = {**auth_headers, "X-Device-Id": "phone-1"}

    first = client.post("/api/p2p/signal-ticket", headers=headers)
    first_record = manager.get_device("phone-1")
    second = client.post("/api/p2p/signal-ticket", headers=headers)
    second_record = manager.get_device("phone-1")

    assert first.status_code == 200
    assert second.status_code == 200
    assert first_record is not None
    assert first_record.user_id == "Axeuh"
    assert second_record.created_at == first_record.created_at
    assert len(manager.list_devices("Axeuh")) == 1
    issuer = SignalTicketIssuer("secret", room="home")
    assert issuer.verify(first.json()["signal_ticket"], "phone-1", "home") is True
    assert issuer.verify(second.json()["signal_ticket"], "phone-1", "home") is True


def test_signal_ticket_device_token_unknown_device_does_not_auto_enroll(
    client, tmp_path, monkeypatch
):
    _use_memory_auth(monkeypatch)
    monkeypatch.setenv("P2P_SIGNAL_SECRET", "secret")
    manager = _real_manager(tmp_path)
    monkeypatch.setattr(p2p_router, "get_p2p_manager", lambda: manager)
    device_token = auth.create_device_token("Axeuh", "dev-unknown")

    response = client.post(
        "/api/p2p/signal-ticket",
        headers={"Authorization": f"Bearer {device_token}"},
    )

    assert response.status_code == 403
    assert manager.get_device("dev-unknown") is None
