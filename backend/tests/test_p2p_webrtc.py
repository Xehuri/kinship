# -*- coding: utf-8 -*-
"""WebRTC 会话/peer 管理与 aiortc 本地回环（可选依赖）。"""
import asyncio
import json
from types import SimpleNamespace

import pytest

import services.p2p.webrtc as webrtc_module
from services.p2p.config import P2PConfig
from services.p2p.protocol import (
    DATACHANNEL_LABEL,
    AudioMeta,
    EventEnvelope,
    ProtocolError,
    encode_chunk,
)
from services.p2p.webrtc import WebRtcPeerManager, WebRtcSession


def _config() -> P2PConfig:
    return P2PConfig.from_dict(
        {"enabled": True, "webrtc": {"enabled": True, "stun_servers": []}}
    )


async def _wait_until(predicate, timeout: float = 10.0) -> None:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("condition not met before timeout")


def _applied_remote_ice(session) -> list:
    description = session._pc._RTCPeerConnection__remoteDescription()
    return [
        candidate
        for media in description.media
        for candidate in media.ice_candidates
    ]


def _android_candidate(foundation: str, port: int) -> dict:
    return {
        "candidate": (
            f"candidate:{foundation} 1 udp 2130706431 127.0.0.1 {port} typ host"
        ),
        "sdpMid": "0",
        "sdpMLineIndex": 0,
    }


async def _make_offer_session(aiortc):
    client = aiortc.RTCPeerConnection(aiortc.RTCConfiguration(iceServers=[]))
    client.createDataChannel(DATACHANNEL_LABEL)
    offer = await client.createOffer()
    await client.setLocalDescription(offer)
    return client, client.localDescription.sdp


def test_session_add_ice_accepts_android_candidate_payload():
    aiortc = pytest.importorskip("aiortc")

    async def scenario() -> None:
        async def callback(*_args, **_kwargs):
            return True

        session = WebRtcSession(
            "dev-1", callback, callback, callback, _config()
        )
        client, offer_sdp = await _make_offer_session(aiortc)
        try:
            await session.handle_offer(offer_sdp)
            await session.add_ice(_android_candidate("11", 5000))
            await session.add_ice(_android_candidate("12", 5001))

            applied = [
                candidate
                for candidate in _applied_remote_ice(session)
                if candidate.port in {5000, 5001}
            ]
            assert [candidate.foundation for candidate in applied] == ["11", "12"]
            assert all(candidate.sdpMid == "0" for candidate in applied)
            assert all(candidate.sdpMLineIndex == 0 for candidate in applied)
        finally:
            await session.close()
            await client.close()

    asyncio.run(asyncio.wait_for(scenario(), 30))


def test_session_queues_ice_until_remote_description_ready():
    aiortc = pytest.importorskip("aiortc")

    async def scenario() -> None:
        async def callback(*_args, **_kwargs):
            return True

        session = WebRtcSession(
            "dev-1", callback, callback, callback, _config()
        )
        client, offer_sdp = await _make_offer_session(aiortc)
        try:
            await session.add_ice(_android_candidate("21", 5002))
            assert session.remote_description_set is False
            assert session.pending_ice_count == 1

            await session.handle_offer(offer_sdp)

            assert session.remote_description_set is True
            assert session.pending_ice_count == 0
            applied = [
                candidate
                for candidate in _applied_remote_ice(session)
                if candidate.port == 5002
            ]
            assert len(applied) == 1
            assert applied[0].sdpMid == "0"
            assert applied[0].sdpMLineIndex == 0
        finally:
            await session.close()
            await client.close()

    asyncio.run(asyncio.wait_for(scenario(), 30))


def test_session_rejects_malformed_ice_without_logging_candidate(caplog):
    pytest.importorskip("aiortc")

    async def scenario() -> None:
        async def callback(*_args, **_kwargs):
            return True

        session = WebRtcSession(
            "dev-1", callback, callback, callback, _config()
        )
        try:
            caplog.set_level("WARNING")
            await session.add_ice(
                {"candidate": "candidate:not-a-candidate", "sdpMid": "0"}
            )
            assert session.pending_ice_count == 0
            assert "dev-1" in caplog.text
            assert "not-a-candidate" not in caplog.text
        finally:
            await session.close()

    asyncio.run(asyncio.wait_for(scenario(), 10))


def test_session_pending_ice_is_bounded_and_cleared_on_close():
    pytest.importorskip("aiortc")

    async def scenario() -> None:
        async def callback(*_args, **_kwargs):
            return True

        session = WebRtcSession(
            "dev-1", callback, callback, callback, _config()
        )
        for index in range(webrtc_module._MAX_PENDING_ICE):
            await session.add_ice(_android_candidate(str(100 + index), 6000 + index))
        assert session.pending_ice_count == webrtc_module._MAX_PENDING_ICE

        with pytest.raises(ProtocolError):
            await session.add_ice(_android_candidate("200", 7000))

        await session.close()
        assert session.pending_ice_count == 0

    asyncio.run(asyncio.wait_for(scenario(), 10))


def test_webrtc_loopback_audio_and_event():
    aiortc = pytest.importorskip("aiortc")

    async def scenario() -> None:
        received = {}
        signal_messages = []

        async def send_signal(message):
            signal_messages.append(message)
            return True

        async def ingest_audio(device_id, meta, payload):
            received["audio"] = (device_id, meta, payload)
            return True

        async def ingest_event(device_id, event):
            received["event"] = (device_id, event)
            return True

        session = WebRtcSession(
            "dev-1", send_signal, ingest_audio, ingest_event, _config()
        )
        client = aiortc.RTCPeerConnection(
            aiortc.RTCConfiguration(iceServers=[])
        )
        incoming = asyncio.Queue()
        channel = client.createDataChannel(DATACHANNEL_LABEL)
        channel.on("message", incoming.put_nowait)

        try:
            offer = await client.createOffer()
            await client.setLocalDescription(offer)
            answer = await session.handle_offer(client.localDescription.sdp)
            await client.setRemoteDescription(
                aiortc.RTCSessionDescription(sdp=answer["sdp"], type="answer")
            )
            await _wait_until(lambda: channel.readyState == "open")

            payload = b"RIFFdata"
            meta = AudioMeta(
                message_id=7,
                session_id="session-1",
                seq=3,
                start_ms=1_700_000_000_000,
                client_time="2026-10-23T12:00:00+08:00",
                format="wav",
                size=len(payload),
                chunks=2,
            )
            channel.send(meta.to_json())
            channel.send(encode_chunk(7, 1, 2, payload[4:]))
            channel.send(encode_chunk(7, 0, 2, payload[:4]))

            ack = json.loads(await asyncio.wait_for(incoming.get(), 10))
            assert ack == {"type": "ack", "message_id": 7, "ok": True}
            device_id, received_meta, received_payload = received["audio"]
            assert device_id == "dev-1"
            assert received_meta == meta
            assert received_payload == payload

            event = EventEnvelope(
                event_type="screen", payload={"on": True}, ts="12:00:00"
            )
            channel.send(event.to_json())
            event_ack = json.loads(await asyncio.wait_for(incoming.get(), 10))
            assert event_ack == {"type": "ack", "message_id": 0, "ok": True}
            assert received["event"][0] == "dev-1"
            assert received["event"][1].event_type == "screen"
            assert received["event"][1].payload == {"on": True}
        finally:
            await session.close()
            await session.close()
            await client.close()

    asyncio.run(asyncio.wait_for(scenario(), 30))


def test_session_close_is_idempotent():
    pytest.importorskip("aiortc")

    async def scenario() -> None:
        async def callback(*_args, **_kwargs):
            return True

        session = WebRtcSession(
            "dev-1", callback, callback, callback, _config()
        )
        await session.close()
        await session.close()
        assert session.closed is True

    asyncio.run(asyncio.wait_for(scenario(), 10))


class FakeSession:
    created: list["FakeSession"] = []

    def __init__(self, device_id, *_args):
        self.device_id = device_id
        self.closed = False
        self.ice = []
        FakeSession.created.append(self)

    async def handle_offer(self, sdp):
        return {"sdp": f"answer:{sdp}", "type": "answer"}

    async def add_ice(self, payload):
        self.ice.append(payload)

    async def close(self):
        self.closed = True


def test_peer_manager_ice_from_revoked_device_closes_session(monkeypatch, caplog):
    monkeypatch.setattr(webrtc_module, "_load_aiortc", lambda: object())
    monkeypatch.setattr(webrtc_module, "WebRtcSession", FakeSession)
    FakeSession.created.clear()

    signal_messages = []
    devices = {"dev-1": SimpleNamespace(revoked_at=None)}

    async def send_signal(message):
        signal_messages.append(message)
        return True

    async def callback(*_args):
        return True

    manager = WebRtcPeerManager(
        _config(), devices.get, send_signal, callback, callback
    )

    async def scenario() -> None:
        await manager.handle_signal(
            {"type": "offer", "from": "dev-1", "payload": {"sdp": "offer-1"}}
        )
        session = FakeSession.created[-1]
        assert manager.session_count == 1

        devices["dev-1"] = SimpleNamespace(revoked_at=123)
        caplog.set_level("WARNING")
        await manager.handle_signal(
            {
                "type": "ice",
                "from": "dev-1",
                "payload": {"candidate": "candidate:secret"},
            }
        )

        assert session.ice == []
        assert session.closed is True
        assert manager.session_count == 0
        assert "dev-1" in caplog.text
        assert "candidate:secret" not in caplog.text

        await manager.handle_signal(
            {
                "type": "ice",
                "from": "ghost",
                "payload": {"candidate": "candidate:ghost"},
            }
        )
        assert all(item.ice == [] for item in FakeSession.created)
        assert "ghost" in caplog.text
        assert "candidate:ghost" not in caplog.text

        await manager.close()

    asyncio.run(asyncio.wait_for(scenario(), 10))


def test_peer_manager_dispatch_and_limits(monkeypatch):
    monkeypatch.setattr(webrtc_module, "_load_aiortc", lambda: object())
    monkeypatch.setattr(webrtc_module, "WebRtcSession", FakeSession)
    FakeSession.created.clear()

    signal_messages = []
    devices = {
        "dev-1": SimpleNamespace(revoked_at=None),
        "dev-2": SimpleNamespace(revoked_at=None),
        "dev-3": SimpleNamespace(revoked_at=123),
    }

    async def send_signal(message):
        signal_messages.append(message)
        return True

    async def callback(*_args):
        return True

    manager = WebRtcPeerManager(
        _config(),
        devices.get,
        send_signal,
        callback,
        callback,
        max_sessions=1,
    )

    async def scenario() -> None:
        await manager.handle_signal(
            {"type": "offer", "from": "ghost", "payload": {"sdp": "v=0"}}
        )
        assert manager.session_count == 0
        assert signal_messages[-1] == {
            "type": "bye",
            "to": "ghost",
            "payload": {},
        }

        await manager.handle_signal(
            {"type": "offer", "from": "dev-3", "payload": {"sdp": "v=0"}}
        )
        assert manager.session_count == 0

        await manager.handle_signal(
            {"type": "offer", "from": "dev-1", "payload": {"sdp": "offer-1"}}
        )
        assert manager.session_count == 1
        assert signal_messages[-1] == {
            "type": "answer",
            "to": "dev-1",
            "payload": {"sdp": "answer:offer-1", "type": "answer"},
        }
        first = FakeSession.created[-1]

        await manager.handle_signal(
            {
                "type": "ice",
                "from": "dev-1",
                "payload": {"candidate": "candidate:1"},
            }
        )
        assert first.ice == [{"candidate": "candidate:1"}]

        await manager.handle_signal({"type": "peer_left", "device_id": "dev-1"})
        assert first.closed is True
        assert manager.session_count == 0

        await manager.handle_signal(
            {"type": "offer", "from": "dev-1", "payload": {"sdp": "offer-2"}}
        )
        second = FakeSession.created[-1]
        await manager.handle_signal(
            {"type": "offer", "from": "dev-2", "payload": {"sdp": "offer-3"}}
        )
        assert len(FakeSession.created) == 2
        assert signal_messages[-1] == {
            "type": "bye",
            "to": "dev-2",
            "payload": {},
        }

        await manager.handle_signal({"type": "bye", "from": "dev-1"})
        assert second.closed is True
        assert manager.session_count == 0

        await manager.close()
        await manager.close()

    asyncio.run(asyncio.wait_for(scenario(), 10))


class BlockingSession(FakeSession):
    def __init__(self, device_id, *_args):
        super().__init__(device_id, *_args)
        self.entered = asyncio.Event()
        self.release = asyncio.Event()

    async def handle_offer(self, sdp):
        self.entered.set()
        await self.release.wait()
        return {"sdp": f"answer:{sdp}", "type": "answer"}


class FailingOfferSession(FakeSession):
    async def handle_offer(self, sdp):
        raise RuntimeError("offer failed")


def _fake_manager(monkeypatch, session_cls, send_signal, *devices):
    monkeypatch.setattr(webrtc_module, "_load_aiortc", lambda: object())
    monkeypatch.setattr(webrtc_module, "WebRtcSession", session_cls)
    FakeSession.created.clear()
    lookup = {
        device_id: SimpleNamespace(revoked_at=None) for device_id in devices
    }

    async def callback(*_args):
        return True

    return WebRtcPeerManager(
        _config(), lookup.get, send_signal, callback, callback
    )


def test_peer_manager_routes_ice_while_offer_is_still_negotiating(monkeypatch):
    signal_messages = []

    async def send_signal(message):
        signal_messages.append(message)
        return True

    manager = _fake_manager(
        monkeypatch, BlockingSession, send_signal, "dev-1"
    )

    async def scenario() -> None:
        offer_task = asyncio.create_task(
            manager.handle_signal(
                {"type": "offer", "from": "dev-1", "payload": {"sdp": "offer-1"}}
            )
        )
        await _wait_until(lambda: manager.session_count == 1)
        session = FakeSession.created[-1]
        await _wait_until(lambda: session.entered.is_set())
        assert offer_task.done() is False

        await manager.handle_signal(
            {
                "type": "ice",
                "from": "dev-1",
                "payload": {"candidate": "candidate:early"},
            }
        )
        assert session.ice == [{"candidate": "candidate:early"}]

        session.release.set()
        await asyncio.wait_for(offer_task, 5)
        assert manager.session_count == 1
        assert signal_messages[-1]["type"] == "answer"

        await manager.close()

    asyncio.run(asyncio.wait_for(scenario(), 10))


def test_peer_manager_discards_session_when_offer_fails(monkeypatch):
    async def send_signal(message):
        return True

    manager = _fake_manager(
        monkeypatch, FailingOfferSession, send_signal, "dev-1"
    )

    async def scenario() -> None:
        await manager.handle_signal(
            {"type": "offer", "from": "dev-1", "payload": {"sdp": "offer-1"}}
        )
        session = FakeSession.created[-1]
        assert session.closed is True
        assert manager.session_count == 0

        await manager.close()

    asyncio.run(asyncio.wait_for(scenario(), 10))


def test_peer_manager_discards_session_when_answer_send_fails(monkeypatch):
    async def send_signal(message):
        return False

    manager = _fake_manager(monkeypatch, FakeSession, send_signal, "dev-1")

    async def scenario() -> None:
        await manager.handle_signal(
            {"type": "offer", "from": "dev-1", "payload": {"sdp": "offer-1"}}
        )
        session = FakeSession.created[-1]
        assert session.closed is True
        assert manager.session_count == 0

        await manager.close()

    asyncio.run(asyncio.wait_for(scenario(), 10))
