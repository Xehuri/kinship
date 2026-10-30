from __future__ import annotations

import asyncio

import pytest

from services.qq_gateway.actions import ActionError, ActionService, IndeterminateActionError
from services.qq_gateway.config import InboundConfig, OutboundConfig
from services.qq_gateway.transport import ActionResponse, TransportClosed


class FakeTransport:
    def __init__(self, response: ActionResponse | None = None, exc: Exception | None = None):
        self.response = response
        self.exc = exc
        self.calls: list[tuple[str, dict]] = []

    async def call(self, action: str, params: dict | None = None, timeout: float | None = None):
        self.calls.append((action, dict(params or {})))
        if self.exc:
            raise self.exc
        assert self.response is not None
        return self.response


def _ok(action: str = "send_private_msg") -> ActionResponse:
    return ActionResponse(action=action, status="ok", retcode=0, data={"message_id": 1},
                          message="", wording="", echo="e1", stream="")


def test_retcode_error_and_dry_run() -> None:
    async def scenario() -> None:
        transport = FakeTransport(ActionResponse(
            action="send_private_msg", status="failed", retcode=1200, data=None,
            message="boom", wording="", echo="e1", stream="",
        ))
        service = ActionService(transport, InboundConfig(), OutboundConfig())
        with pytest.raises(ActionError) as exc:
            await service.call("send_private_msg", {"user_id": 1, "message": []})
        assert exc.value.retcode == 1200
        dry = ActionService(transport, InboundConfig(), OutboundConfig(dry_run=True))
        result = await dry.call("send_private_msg", {"user_id": 1, "message": []})
        assert result["dry_run"] is True
        assert transport.calls == [("send_private_msg", {"user_id": 1, "message": []})]

    asyncio.run(scenario())


def test_mutating_disconnect_is_indeterminate() -> None:
    async def scenario() -> None:
        service = ActionService(FakeTransport(exc=TransportClosed("gone")),
                                InboundConfig(), OutboundConfig())
        with pytest.raises(IndeterminateActionError):
            await service.call("send_private_msg", {"user_id": 1, "message": []})
        with pytest.raises(ActionError):
            await service.call("get_login_info", {})

    asyncio.run(scenario())


def test_disallowed_action() -> None:
    async def scenario() -> None:
        service = ActionService(FakeTransport(_ok()), InboundConfig(), OutboundConfig())
        with pytest.raises(ActionError) as exc:
            await service.call("set_restart", {})
        assert exc.value.retcode == 1404

    asyncio.run(scenario())


def test_get_cookies_is_non_mutating_read() -> None:
    async def scenario() -> None:
        transport = FakeTransport(ActionResponse(
            action="get_cookies", status="ok", retcode=0, data={"cookies": "a=b"},
            message="", wording="", echo="e2", stream="",
        ))
        service = ActionService(transport, InboundConfig(),
                                OutboundConfig(enabled=False, dry_run=True,
                                               private=False, groups=False))
        result = await service.call("get_cookies", {})
        assert result == {"cookies": "a=b"}
        assert transport.calls == [("get_cookies", {})]

    asyncio.run(scenario())


def test_send_message_mapping() -> None:
    async def scenario() -> None:
        transport = FakeTransport(_ok())
        service = ActionService(transport, InboundConfig(), OutboundConfig(groups=True))
        await service.send_message("group", 300, [{"type": "text", "data": {"text": "hi"}}])
        assert transport.calls[0][0] == "send_group_msg"
        assert transport.calls[0][1]["group_id"] == 300

    asyncio.run(scenario())


def test_outbound_target_policy() -> None:
    async def scenario() -> None:
        service = ActionService(FakeTransport(_ok()), InboundConfig(), OutboundConfig())
        with pytest.raises(ActionError) as exc:
            await service.call("send_group_msg", {"group_id": 300, "message": []})
        assert exc.value.retcode == 1403
        private_off = ActionService(FakeTransport(_ok()), InboundConfig(), OutboundConfig(private=False))
        with pytest.raises(ActionError):
            await private_off.call("send_private_msg", {"user_id": 200, "message": []})

    asyncio.run(scenario())
