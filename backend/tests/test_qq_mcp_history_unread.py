from __future__ import annotations

import asyncio
import json
import time
from typing import Any

from services import qq_mcp_server
from services.qq_mcp_server import (
    FriendMsgHistoryInput,
    GetGroupMsgHistoryInput,
    ResponseFormat,
)


def _sample() -> dict[str, Any]:
    return {
        "messages": [
            {
                "time": 1700000000,
                "message_id": 1,
                "sender": {"user_id": 123, "nickname": "张三"},
                "message": [{"type": "text", "data": {"text": "old"}}],
            },
            {
                "time": 1700000060,
                "message_id": 2,
                "sender": {"user_id": 456, "nickname": "李四"},
                "message": [{"type": "text", "data": {"text": "new"}}],
            },
        ]
    }


def _patch_gateway(
    monkeypatch: Any, sample: dict[str, Any], calls: list[tuple[str, Any, bool]]
) -> None:
    async def fake_call(action: str, params: Any = None, mutating: bool = False) -> Any:
        calls.append((action, params, mutating))
        return sample

    monkeypatch.setattr(qq_mcp_server.client, "call", fake_call)


def _patch_watermarks(monkeypatch: Any) -> dict[str, dict[str, Any]]:
    state: dict[str, dict[str, Any]] = {}

    async def fake_read(chat_type: str, target: str) -> dict[str, Any]:
        return dict(state.get(f"{chat_type}:{target}", {}))

    async def fake_write(chat_type: str, target: str, message: dict[str, Any]) -> None:
        state[f"{chat_type}:{target}"] = {
            "time": qq_mcp_server._message_time(message),
            "message_id": str(
                message.get("message_id") or message.get("message_seq") or ""
            ),
        }

    monkeypatch.setattr(qq_mcp_server, "_read_watermark", fake_read)
    monkeypatch.setattr(qq_mcp_server, "_write_watermark", fake_write)
    return state


def _group_call(**overrides: Any) -> str:
    fields: dict[str, Any] = {"group_id": "10003", "count": 20}
    fields.update(overrides)
    return asyncio.run(
        qq_mcp_server.qq_get_group_msg_history(GetGroupMsgHistoryInput(**fields))
    )


def test_unread_first_call_returns_all_without_advancing(monkeypatch: Any) -> None:
    calls: list[tuple[str, Any, bool]] = []
    _patch_gateway(monkeypatch, _sample(), calls)
    state = _patch_watermarks(monkeypatch)

    first = _group_call(unread_only=True, compact=True)
    assert "old" in first
    assert "new" in first

    second = _group_call(unread_only=True, compact=True)
    assert "old" in second
    assert "new" in second

    assert "group:10003" not in state


def test_mark_read_advances_watermark(monkeypatch: Any) -> None:
    calls: list[tuple[str, Any, bool]] = []
    _patch_gateway(monkeypatch, _sample(), calls)
    state = _patch_watermarks(monkeypatch)

    _group_call(unread_only=True, mark_read=True, compact=True)
    second = _group_call(unread_only=True, compact=True)

    assert "count=0" in second
    assert "(empty)" in second
    assert state["group:10003"] == {"time": 1700000060, "message_id": "2"}


def test_watermark_filters_older_messages(monkeypatch: Any) -> None:
    calls: list[tuple[str, Any, bool]] = []
    _patch_gateway(monkeypatch, _sample(), calls)
    state = _patch_watermarks(monkeypatch)
    state["group:10003"] = {"time": 1700000000, "message_id": "1"}

    output = _group_call(unread_only=True, compact=True)
    assert "new" in output
    assert "old" not in output


def test_count_only_returns_number(monkeypatch: Any) -> None:
    calls: list[tuple[str, Any, bool]] = []
    _patch_gateway(monkeypatch, _sample(), calls)
    _patch_watermarks(monkeypatch)

    output = _group_call(unread_only=True, count_only=True)
    assert "count=2" in output
    assert "[" not in output

    payload = json.loads(
        _group_call(
            unread_only=True,
            count_only=True,
            response_format=ResponseFormat.JSON,
        )
    )
    assert payload["count"] == 2
    assert "messages" not in payload
    assert "watermark" not in payload


def test_since_minutes_filters_old_messages(monkeypatch: Any) -> None:
    now = int(time.time())
    sample = {
        "messages": [
            {
                "time": now,
                "message_id": 11,
                "sender": {"user_id": 123, "nickname": "张三"},
                "message": [{"type": "text", "data": {"text": "fresh"}}],
            },
            {
                "time": 0,
                "message_id": 12,
                "sender": {"user_id": 456, "nickname": "李四"},
                "message": [{"type": "text", "data": {"text": "stale"}}],
            },
        ]
    }
    calls: list[tuple[str, Any, bool]] = []
    _patch_gateway(monkeypatch, sample, calls)
    _patch_watermarks(monkeypatch)

    output = _group_call(since_minutes=60, compact=True)
    assert "fresh" in output
    assert "stale" not in output
    assert "count=1" in output


def test_default_behavior_unchanged(monkeypatch: Any) -> None:
    calls: list[tuple[str, Any, bool]] = []
    _patch_gateway(monkeypatch, _sample(), calls)
    _patch_watermarks(monkeypatch)

    output = _group_call()
    assert "```json" in output
    assert "old" in output
    assert "new" in output
    assert calls[0][1] == {"group_id": "10003", "count": 20}


def test_friend_watermark_is_separate(monkeypatch: Any) -> None:
    calls: list[tuple[str, Any, bool]] = []
    _patch_gateway(monkeypatch, _sample(), calls)
    state = _patch_watermarks(monkeypatch)

    asyncio.run(
        qq_mcp_server.qq_get_friend_msg_history(
            FriendMsgHistoryInput(
                user_id="10002", unread_only=True, mark_read=True
            )
        )
    )

    assert calls[0][1] == {"user_id": "10002", "count": 50}
    assert state["friend:10002"] == {"time": 1700000060, "message_id": "2"}
    assert not any(key.startswith("group:") for key in state)


def test_watermark_uses_gateway_read_state_ipc(monkeypatch: Any) -> None:
    calls: list[tuple[str, str, Any]] = []

    async def fake_get(path: str, params: Any = None) -> Any:
        calls.append(("GET", path, params))
        return {
            "chat_type": "group",
            "target": "10003",
            "last_time": 1700000060.0,
            "last_message_id": "2",
        }

    async def fake_post(path: str, body: Any = None) -> Any:
        calls.append(("POST", path, body))
        return {"chat_type": "group", "target": "10003"}

    monkeypatch.setattr(qq_mcp_server.client, "get", fake_get)
    monkeypatch.setattr(qq_mcp_server.client, "post", fake_post)

    watermark = asyncio.run(qq_mcp_server._read_watermark("group", "10003"))
    asyncio.run(
        qq_mcp_server._write_watermark(
            "group",
            "10003",
            {"time": 1700000060, "message_id": 2},
        )
    )

    assert watermark == {"time": 1700000060.0, "message_id": "2"}
    assert calls[0] == (
        "GET",
        "/v1/read-state",
        {"chat_type": "group", "target": "10003"},
    )
    assert calls[1] == (
        "POST",
        "/v1/read-state",
        {
            "chat_type": "group",
            "target": "10003",
            "last_time": 1700000060,
            "last_message_id": "2",
        },
    )


def _media_sample() -> dict[str, Any]:
    return {
        "messages": [
            {
                "time": 1700000060,
                "message_id": 4242,
                "sender": {"user_id": 456, "nickname": "李四"},
                "message": [
                    {"type": "text", "data": {"text": "看这个"}},
                    {"type": "image", "data": {"summary": "[图片]"}},
                ],
            }
        ]
    }


def test_unread_compact_fetches_media_path(monkeypatch: Any) -> None:
    calls: list[tuple[str, Any, bool]] = []
    _patch_gateway(monkeypatch, _media_sample(), calls)
    _patch_watermarks(monkeypatch)
    media_calls: list[tuple[str, Any]] = []

    async def fake_post(path: str, body: Any = None) -> Any:
        media_calls.append((path, body))
        return {"path": "/tmp/qq_media/4242_1.png"}

    monkeypatch.setattr(qq_mcp_server.client, "post", fake_post)

    output = _group_call(unread_only=True, compact=True)

    assert "[图片]" in output
    assert "/tmp/qq_media/4242_1.png" in output
    assert media_calls == [
        (
            "/v1/media",
            {
                "segment": {"type": "image", "data": {"summary": "[图片]"}},
                "index": 1,
                "message_id": "4242",
            },
        )
    ]


def test_plain_compact_without_unread_skips_media_fetch(monkeypatch: Any) -> None:
    calls: list[tuple[str, Any, bool]] = []
    _patch_gateway(monkeypatch, _media_sample(), calls)
    media_calls: list[str] = []

    async def fake_post(path: str, body: Any = None) -> Any:
        media_calls.append(path)
        raise AssertionError("media endpoint must not be called")

    monkeypatch.setattr(qq_mcp_server.client, "post", fake_post)

    output = _group_call(compact=True)

    assert "[图片]" in output
    assert media_calls == []
