from __future__ import annotations

import asyncio

from services.qq_gateway.config import ForwardConfig
from services.qq_gateway.forward import flatten_forward, to_send_nodes


def _node(name: str, content: list) -> dict:
    return {"type": "node", "data": {"user_id": "1", "nickname": name, "content": content}}


def _text(value: str) -> dict:
    return {"type": "text", "data": {"text": value}}


async def _no_action(action: str, params: dict) -> dict:
    raise AssertionError(f"unexpected action {action}")


def test_three_level_inline_forward() -> None:
    async def scenario() -> None:
        level3 = [_node("C", [_text("l3")])]
        level2 = [_node("B", [_text("l2"), {"type": "forward", "data": {"content": level3}}])]
        level1 = [_node("A", [_text("l1"), {"type": "forward", "data": {"content": level2}}])]
        text = await flatten_forward(level1, _no_action, ForwardConfig(max_depth=3))
        assert "l1" in text
        assert "l2" in text
        assert "l3" in text
        assert text.count("【合并转发消息") == 3

    asyncio.run(scenario())


def test_non_inline_forward_uses_get_forward_msg() -> None:
    async def scenario() -> None:
        calls: list[tuple[str, dict]] = []

        async def action(name: str, params: dict) -> dict:
            calls.append((name, params))
            return {"messages": [_node("B", [_text("remote")])]}

        text = await flatten_forward(
            [_node("A", [_text("head"), {"type": "forward", "data": {"id": "f1"}}])],
            action,
            ForwardConfig(max_depth=3),
        )
        assert calls == [("get_forward_msg", {"message_id": "f1"})]
        assert "remote" in text

    asyncio.run(scenario())


def test_caps_and_roundtrip_nodes() -> None:
    async def scenario() -> None:
        messages = [_node(f"U{i}", [_text("x" * 50)]) for i in range(10)]
        text = await flatten_forward(messages, _no_action, ForwardConfig(max_nodes=3, max_chars=200))
        assert "...（还有 7 条）" in text
        nodes = to_send_nodes([{"sender": {"user_id": 9, "nickname": "Z"}, "message": [_text("hi")]}])
        assert nodes[0]["type"] == "node"
        assert nodes[0]["data"]["content"] == [_text("hi")]

    asyncio.run(scenario())
