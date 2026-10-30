from __future__ import annotations

import asyncio
import time

import pytest

from services.qq_gateway.config import AccountConfig, ConnectionConfig
from services.qq_gateway.transport import ActionTimeout, NapCatTransport, TransportClosed
from tests.qq_gateway_fixtures.fake_napcat import FakeNapCat


async def _wait_connected(transport: NapCatTransport, timeout: float = 3.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if transport.connected:
            return
        await asyncio.sleep(0.02)
    raise AssertionError("transport did not connect")


@pytest.mark.parametrize("action", ["get_login_info"])
def test_transport_echo_roundtrip(action: str) -> None:
    async def scenario() -> None:
        fake = FakeNapCat()
        await fake.start()
        transport = NapCatTransport(
            AccountConfig(ws_url=fake.url, ws_token=""),
            ConnectionConfig(action_timeout_sec=1.0),
            on_event=_ignore_event,
        )
        await transport.start()
        await _wait_connected(transport)
        response = await transport.call(action, {"x": 1})
        assert response.retcode == 0
        assert response.data["action"] == action
        assert response.data["params"] == {"x": 1}
        await transport.stop()
        await fake.stop()

    asyncio.run(scenario())


async def _ignore_event(_: dict) -> None:
    return None


def test_transport_out_of_order() -> None:
    async def scenario() -> None:
        fake = FakeNapCat()
        fake.delay["slow"] = 0.2
        await fake.start()
        transport = NapCatTransport(
            AccountConfig(ws_url=fake.url, ws_token=""),
            ConnectionConfig(action_timeout_sec=2.0),
            on_event=_ignore_event,
        )
        await transport.start()
        await _wait_connected(transport)
        slow, fast = await asyncio.gather(
            transport.call("slow", {}),
            transport.call("fast", {}),
        )
        assert slow.data["action"] == "slow"
        assert fast.data["action"] == "fast"
        await transport.stop()
        await fake.stop()

    asyncio.run(scenario())


def test_transport_timeout_and_disconnect() -> None:
    async def scenario() -> None:
        fake = FakeNapCat()
        await fake.start()
        transport = NapCatTransport(
            AccountConfig(ws_url=fake.url, ws_token=""),
            ConnectionConfig(action_timeout_sec=0.1),
            on_event=_ignore_event,
        )
        await transport.start()
        await _wait_connected(transport)
        with pytest.raises(ActionTimeout):
            await transport.call("silent", {})
        await fake.stop()
        await asyncio.sleep(0.05)
        with pytest.raises(TransportClosed):
            await transport.call("get_login_info", {})
        await transport.stop()

    asyncio.run(scenario())


def test_transport_stream_aggregation() -> None:
    async def scenario() -> None:
        fake = FakeNapCat()
        await fake.start()
        transport = NapCatTransport(
            AccountConfig(ws_url=fake.url, ws_token=""),
            ConnectionConfig(action_timeout_sec=2.0),
            on_event=_ignore_event,
        )
        await transport.start()
        await _wait_connected(transport)
        response = await transport.call("stream_test", {})
        assert response.data["type"] == "response"
        assert len(response.frames) == 4
        await transport.stop()
        await fake.stop()

    asyncio.run(scenario())
