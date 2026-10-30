# -*- coding: utf-8 -*-
"""P2PManager 生命周期与设备操作集成。"""
import asyncio

import pytest

import auth
import services.p2p.manager as manager_module
from services.p2p.config import P2PConfig
from services.p2p.manager import P2PAccessError, P2PManager
from services.p2p.protocol import AudioMeta
from services.p2p.tokens import SignalTicketIssuer
from services.p2p.webrtc import WebRtcUnavailableError


def _use_memory_auth(monkeypatch):
    config = auth.AuthConfig(users={}, tokens={})
    monkeypatch.setattr(auth, "get_auth_config", lambda: config)
    monkeypatch.setattr(auth, "save_auth_config", lambda _config: None)
    monkeypatch.setattr(auth, "_auth_config", config)
    return config


def _real_config(tmp_path, webrtc=None, **overrides):
    raw = {
        "enabled": True,
        "server_id": "home",
        "room": "home",
        "signal_url": "wss://signal.example.com",
        "signal_secret_env": "P2P_SIGNAL_SECRET",
        "signal_ticket_ttl_seconds": 600,
        "endpoints": {"frp": "https://home.example.com:8768"},
        "pairing_code_ttl_seconds": 300,
        "devices_path": str(tmp_path / "devices.json"),
    }
    if webrtc is not None:
        raw["webrtc"] = webrtc
    raw.update(overrides)
    return P2PConfig.from_dict(raw)


def test_real_manager_enroll_ticket_and_revoke(tmp_path, monkeypatch):
    monkeypatch.setenv("P2P_SIGNAL_SECRET", "secret")
    _use_memory_auth(monkeypatch)

    manager = P2PManager(_real_config(tmp_path))
    code, _expires = manager.issue_pairing_code("Axeuh")
    enrolled = manager.enroll(code, "dev-9", "Phone", "android")

    assert enrolled["user_id"] == "Axeuh"
    assert enrolled["room"] == "home"
    assert auth.verify_token_full(enrolled["device_token"])[2] == "device"

    issuer = SignalTicketIssuer("secret", room="home")
    assert issuer.verify(enrolled["signal_ticket"], "dev-9", "home") is True

    ticket, expires_at_ms = manager.issue_signal_ticket("Axeuh", "dev-9")
    assert issuer.verify(ticket, "dev-9", "home") is True
    assert expires_at_ms > 0

    with pytest.raises(P2PAccessError):
        manager.issue_signal_ticket("Someone-Else", "dev-9")

    assert manager.revoke("dev-9") == 1
    assert manager.get_device("dev-9").revoked_at is not None
    assert auth.verify_token_full(enrolled["device_token"])[0] is False
    with pytest.raises(P2PAccessError):
        manager.issue_signal_ticket("Axeuh", "dev-9")


def test_issue_signal_ticket_auto_enrolls_unknown_device_for_user(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("P2P_SIGNAL_SECRET", "secret")
    _use_memory_auth(monkeypatch)

    manager = P2PManager(_real_config(tmp_path))
    ticket, expires_at_ms = manager.issue_signal_ticket("Axeuh", "phone-1")
    record = manager.get_device("phone-1")

    assert record is not None
    assert record.user_id == "Axeuh"
    assert record.name == "phone-1"
    assert record.platform == ""
    assert record.token_fingerprint == ""
    assert expires_at_ms > 0
    issuer = SignalTicketIssuer("secret", room="home")
    assert issuer.verify(ticket, "phone-1", "home") is True

    again, _expires = manager.issue_signal_ticket("Axeuh", "phone-1")
    reused = manager.get_device("phone-1")

    assert reused.created_at == record.created_at
    assert len(manager.list_devices()) == 1
    assert issuer.verify(again, "phone-1", "home") is True

    with pytest.raises(P2PAccessError):
        manager.issue_signal_ticket("Someone-Else", "phone-1")
    assert manager.get_device("phone-1").user_id == "Axeuh"


def test_issue_signal_ticket_rejects_unknown_device_when_auto_enroll_disabled(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("P2P_SIGNAL_SECRET", "secret")
    _use_memory_auth(monkeypatch)

    manager = P2PManager(_real_config(tmp_path, auto_enroll_user_devices=False))

    with pytest.raises(P2PAccessError):
        manager.issue_signal_ticket("Axeuh", "phone-1")

    assert manager.get_device("phone-1") is None


def test_issue_signal_ticket_device_token_never_auto_enrolls(tmp_path, monkeypatch):
    monkeypatch.setenv("P2P_SIGNAL_SECRET", "secret")
    _use_memory_auth(monkeypatch)

    manager = P2PManager(_real_config(tmp_path))

    with pytest.raises(P2PAccessError):
        manager.issue_signal_ticket("Axeuh", "phone-1", allow_auto_enroll=False)

    assert manager.get_device("phone-1") is None


def test_real_manager_revoke_device_closes_webrtc_session(tmp_path, monkeypatch):
    monkeypatch.setenv("P2P_SIGNAL_SECRET", "secret")
    _use_memory_auth(monkeypatch)

    class FakeWebRtc:
        def __init__(self):
            self.closed = []

        async def close_device(self, device_id):
            self.closed.append(device_id)

    async def scenario():
        manager = P2PManager(_real_config(tmp_path))
        code, _expires = manager.issue_pairing_code("Axeuh")
        manager.enroll(code, "dev-9", "Phone", "android")
        fake_webrtc = FakeWebRtc()
        manager._webrtc = fake_webrtc

        revoked_tokens = await manager.revoke_device("dev-9")

        assert revoked_tokens == 1
        assert fake_webrtc.closed == ["dev-9"]
        assert manager.get_device("dev-9").revoked_at is not None
        with pytest.raises(P2PAccessError):
            manager.issue_signal_ticket("Axeuh", "dev-9")

    asyncio.run(scenario())


def test_real_manager_enroll_does_not_create_token_when_ticket_fails(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("P2P_SIGNAL_SECRET", "secret")
    config = _use_memory_auth(monkeypatch)

    class FailingIssuer:
        def issue(self, device_id):
            raise ValueError("ticket failure")

    def unexpected_create(*args, **kwargs):
        raise AssertionError("device token created before signal ticket")

    monkeypatch.setattr(auth, "create_device_token", unexpected_create)
    manager = P2PManager(_real_config(tmp_path), issuer=FailingIssuer())
    code, _expires = manager.issue_pairing_code("Axeuh")

    with pytest.raises(ValueError):
        manager.enroll(code, "dev-9")

    assert [info for info in config.tokens.values() if info.kind == "device"] == []
    assert manager.get_device("dev-9") is None


def test_real_manager_enroll_revokes_token_when_store_fails(tmp_path, monkeypatch):
    monkeypatch.setenv("P2P_SIGNAL_SECRET", "secret")
    config = _use_memory_auth(monkeypatch)
    created_tokens = []
    real_create = auth.create_device_token

    def spying_create(username, device_id, expires_days=365):
        token = real_create(username, device_id, expires_days)
        created_tokens.append(token)
        return token

    class FailingStore:
        def register(self, **kwargs):
            raise OSError("disk full")

    monkeypatch.setattr(auth, "create_device_token", spying_create)
    manager = P2PManager(_real_config(tmp_path), store=FailingStore())
    code, _expires = manager.issue_pairing_code("Axeuh")

    with pytest.raises(OSError):
        manager.enroll(code, "dev-9")

    assert len(created_tokens) == 1
    assert all(token not in config.tokens for token in created_tokens)


def test_real_manager_start_fail_open_on_bad_config(tmp_path, monkeypatch):
    monkeypatch.delenv("P2P_SIGNAL_SECRET", raising=False)

    async def scenario():
        manager = P2PManager(_real_config(tmp_path))
        await manager.start()
        assert manager.status()["signal_connected"] is False
        await manager.stop()

    asyncio.run(scenario())


def test_real_manager_starts_and_stops_signaling(tmp_path, monkeypatch):
    monkeypatch.setenv("P2P_SIGNAL_SECRET", "secret")

    class FakeSignaling:
        def __init__(self):
            self.connected = False
            self.started = False
            self.stopped = False

        async def run(self):
            self.started = True
            await asyncio.Event().wait()

        async def stop(self):
            self.stopped = True

    async def scenario():
        signaling = FakeSignaling()
        manager = P2PManager(_real_config(tmp_path), signaling=signaling)
        await manager.start()
        await asyncio.sleep(0)

        assert signaling.started is True
        assert manager.status()["device_count"] == 0

        await manager.stop()
        assert signaling.stopped is True

    asyncio.run(scenario())


def test_status_exposes_signal_url_and_webrtc_flag(tmp_path):
    manager = P2PManager(_real_config(tmp_path))
    status = manager.status()

    assert status["signal_url"] == "wss://signal.example.com"
    assert status["webrtc_enabled"] is False
    assert manager.config.public_dict()["webrtc_enabled"] is False


def test_start_fail_open_when_aiortc_missing(tmp_path, monkeypatch):
    monkeypatch.setenv("P2P_SIGNAL_SECRET", "secret")

    class FakeSignaling:
        def __init__(self):
            self.connected = False
            self.stopped = False

        async def run(self):
            await asyncio.Event().wait()

        async def stop(self):
            self.stopped = True

    def unavailable(*_args, **_kwargs):
        raise WebRtcUnavailableError("aiortc is not installed")

    monkeypatch.setattr(manager_module, "WebRtcPeerManager", unavailable)

    async def scenario():
        signaling = FakeSignaling()
        manager = P2PManager(
            _real_config(tmp_path, webrtc={"enabled": True}),
            signaling=signaling,
        )
        await manager.start()

        assert manager.status()["webrtc_enabled"] is True
        assert manager._webrtc is None
        assert manager.status()["signal_connected"] is False

        await manager.stop()
        assert signaling.stopped is True

    asyncio.run(scenario())


def test_ingest_audio_rejects_non_positive_start_ms(tmp_path, monkeypatch):
    import routers.perception as perception

    called = []

    async def handler(*_args, **_kwargs):
        called.append(True)
        return {"status": "ok"}

    monkeypatch.setattr(perception, "_handle_voice_session", handler)
    manager = P2PManager(_real_config(tmp_path))
    meta = AudioMeta(
        message_id=1,
        session_id="session-1",
        seq=1,
        start_ms=0,
        client_time="2026-10-23T12:00:00+08:00",
        format="wav",
        size=1,
        chunks=1,
    )

    assert asyncio.run(manager._ingest_audio("dev-1", meta, b"x")) is False
    assert called == []
