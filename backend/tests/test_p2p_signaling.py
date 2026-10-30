# -*- coding: utf-8 -*-
"""信令客户端：假 WebSocket，无真实网络。"""
import asyncio
import json
import logging
from urllib.parse import parse_qs, urlsplit

from services.p2p.signaling import MAX_MESSAGE_SIZE, SignalingClient


class FakeWebSocket:
    def __init__(self, messages=()):
        self._messages = list(messages)
        self.sent = []
        self.closed = False

    def __aiter__(self):
        return self._iterate()

    async def _iterate(self):
        for message in self._messages:
            yield message
        while not self.closed:
            await asyncio.sleep(0.005)

    async def send(self, data):
        self.sent.append(data)

    async def close(self):
        self.closed = True


class FakeConnection:
    def __init__(self, websocket):
        self._websocket = websocket

    async def __aenter__(self):
        return self._websocket

    async def __aexit__(self, *exc_info):
        return False


def _connect_recorder(websocket, calls):
    def connect(uri, **kwargs):
        calls.append((uri, kwargs))
        return FakeConnection(websocket)

    return connect


async def _wait_until(predicate, timeout=2.0):
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.005)
    raise AssertionError("condition not met before timeout")


def test_connect_dispatches_messages_pings_and_builds_url(caplog):
    caplog.set_level(logging.DEBUG)

    async def scenario():
        received = []

        async def on_message(message):
            received.append(message)

        websocket = FakeWebSocket(
            [
                json.dumps({"type": "registered"}),
                json.dumps({"type": "offer", "sdp": "SECRET_SDP"}),
                "not-json",
                json.dumps({"type": "weird", "payload": "SECRET_UNKNOWN"}),
            ]
        )
        calls = []
        client = SignalingClient(
            "wss://signal.example.com",
            "home",
            "server-1",
            lambda: "ticket+/=",
            on_message=on_message,
            connect=_connect_recorder(websocket, calls),
            ping_interval=0.01,
            backoff_min=0.01,
            backoff_max=0.02,
        )

        task = asyncio.create_task(client.run())
        await _wait_until(lambda: len(received) >= 2)
        await _wait_until(lambda: any('"ping"' in data for data in websocket.sent))

        assert client.connected is True
        uri, kwargs = calls[0]
        fields = parse_qs(urlsplit(uri).query)
        assert fields["role"] == ["server"]
        assert fields["room"] == ["home"]
        assert fields["device_id"] == ["server-1"]
        assert fields["token"] == ["ticket+/="]
        assert kwargs["max_size"] == MAX_MESSAGE_SIZE
        assert [message["type"] for message in received] == ["registered", "offer"]

        await client.stop()
        assert client.state == "stopped"
        assert task.done()

    asyncio.run(asyncio.wait_for(scenario(), 5))
    assert "SECRET_SDP" not in caplog.text
    assert "SECRET_UNKNOWN" not in caplog.text
    assert "ticket+/=" not in caplog.text


def test_reconnects_after_connection_failure():
    async def scenario():
        websocket = FakeWebSocket()
        attempts = []

        def connect(uri, **kwargs):
            attempts.append(uri)
            if len(attempts) == 1:
                raise OSError("connection refused")
            return FakeConnection(websocket)

        client = SignalingClient(
            "wss://signal.example.com",
            "home",
            "server-1",
            lambda: "ticket",
            connect=connect,
            ping_interval=0.01,
            backoff_min=0.01,
            backoff_max=0.02,
        )
        task = asyncio.create_task(client.run())

        await _wait_until(lambda: client.connected)
        assert len(attempts) >= 2

        await client.stop()
        assert client.state == "stopped"
        assert task.done()

    asyncio.run(asyncio.wait_for(scenario(), 5))


def test_ticket_is_refreshed_on_each_connection_attempt():
    async def scenario():
        websocket = FakeWebSocket()
        tickets = iter(["ticket-1", "ticket-2"])
        calls = []

        def connect(uri, **kwargs):
            calls.append(uri)
            if len(calls) == 1:
                raise OSError("connection refused")
            return FakeConnection(websocket)

        client = SignalingClient(
            "wss://signal.example.com",
            "home",
            "server-1",
            lambda: next(tickets),
            connect=connect,
            ping_interval=0.01,
            backoff_min=0.01,
            backoff_max=0.02,
        )
        task = asyncio.create_task(client.run())
        await _wait_until(lambda: client.connected)

        tokens = [parse_qs(urlsplit(uri).query)["token"][0] for uri in calls]
        assert tokens == ["ticket-1", "ticket-2"]

        await client.stop()
        assert task.done()

    asyncio.run(asyncio.wait_for(scenario(), 5))


def test_stop_interrupts_reconnect_backoff():
    async def scenario():
        def connect(uri, **kwargs):
            raise OSError("always down")

        client = SignalingClient(
            "wss://signal.example.com",
            "home",
            "server-1",
            lambda: "ticket",
            connect=connect,
            ping_interval=0.01,
            backoff_min=5.0,
            backoff_max=5.0,
        )
        task = asyncio.create_task(client.run())
        await _wait_until(lambda: client.state == "reconnecting")

        await asyncio.wait_for(client.stop(), 1.0)

        assert client.state == "stopped"
        assert task.done()

    asyncio.run(asyncio.wait_for(scenario(), 5))


def test_empty_ticket_does_not_crash_and_keeps_retrying():
    async def scenario():
        client = SignalingClient(
            "wss://signal.example.com",
            "home",
            "server-1",
            lambda: "",
            connect=lambda uri, **kwargs: FakeConnection(FakeWebSocket()),
            ping_interval=0.01,
            backoff_min=0.01,
            backoff_max=0.02,
        )
        task = asyncio.create_task(client.run())
        await _wait_until(lambda: client.state == "reconnecting")
        assert not task.done()

        await client.stop()
        assert task.done()

    asyncio.run(asyncio.wait_for(scenario(), 5))


def test_send_message_requires_connection_and_serializes_json():
    async def scenario():
        websocket = FakeWebSocket()
        client = SignalingClient(
            "wss://signal.example.com",
            "home",
            "server-1",
            lambda: "ticket",
            connect=_connect_recorder(websocket, []),
            ping_interval=60,
            backoff_min=0.01,
            backoff_max=0.02,
        )

        assert await client.send_message({"type": "answer"}) is False

        task = asyncio.create_task(client.run())
        await _wait_until(lambda: client.connected)

        message = {
            "type": "answer",
            "to": "dev-1",
            "payload": {"sdp": "SECRET_SDP", "type": "answer"},
        }
        assert await client.send_message(message) is True
        assert json.loads(websocket.sent[-1]) == message

        assert await client.send_message({"type": "ice", "bad": object()}) is False

        await client.stop()
        assert await client.send_message({"type": "bye", "to": "dev-1"}) is False
        assert task.done()

    asyncio.run(asyncio.wait_for(scenario(), 5))


def test_send_message_returns_false_when_socket_send_fails():
    class FailingWebSocket(FakeWebSocket):
        async def send(self, data):
            raise OSError("send failed")

    async def scenario():
        websocket = FailingWebSocket()
        client = SignalingClient(
            "wss://signal.example.com",
            "home",
            "server-1",
            lambda: "ticket",
            connect=_connect_recorder(websocket, []),
            ping_interval=60,
            backoff_min=0.01,
            backoff_max=0.02,
        )
        task = asyncio.create_task(client.run())
        await _wait_until(lambda: client.connected)

        assert await client.send_message({"type": "bye", "to": "dev-1"}) is False

        await client.stop()
        assert task.done()

    asyncio.run(asyncio.wait_for(scenario(), 5))


def test_send_message_rejects_oversize_without_logging_payload(caplog):
    caplog.set_level(logging.WARNING)

    async def scenario():
        websocket = FakeWebSocket()
        client = SignalingClient(
            "wss://signal.example.com",
            "home",
            "server-1",
            lambda: "ticket",
            connect=_connect_recorder(websocket, []),
            ping_interval=60,
            backoff_min=0.01,
            backoff_max=0.02,
        )
        task = asyncio.create_task(client.run())
        await _wait_until(lambda: client.connected)

        message = {
            "type": "answer",
            "to": "dev-1",
            "payload": {"sdp": "SECRET_SDP" * 10_000},
        }
        assert await client.send_message(message) is False
        assert websocket.sent == []
        assert "SECRET_SDP" not in caplog.text
        assert "超过上限" in caplog.text

        await client.stop()
        assert task.done()

    asyncio.run(asyncio.wait_for(scenario(), 5))
