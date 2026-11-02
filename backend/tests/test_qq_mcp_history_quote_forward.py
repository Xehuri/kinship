from __future__ import annotations

import asyncio
import json
from typing import Any

from services import qq_mcp_server
from services.qq_mcp_server import ResponseFormat, _compact_history


def _compact(
    data: Any, fmt: ResponseFormat = ResponseFormat.MARKDOWN, *, fetch_media: bool = True
) -> str:
    return asyncio.run(
        _compact_history(
            data,
            fmt,
            "QQ History",
            "target=1",
            fetch_media=fetch_media,
        )
    )


def _patch_actions(
    monkeypatch: Any,
    actions: dict[str, Any],
    calls: list[tuple[str, Any]],
) -> None:
    async def fake_call(action: str, params: Any = None, mutating: Any = None) -> Any:
        calls.append((action, params))
        return actions[action]

    monkeypatch.setattr(qq_mcp_server.client, "call", fake_call)


def _patch_media_paths(
    monkeypatch: Any,
    media_calls: list[tuple[str, dict[str, Any]]],
) -> None:
    async def fake_post(url: str, body: dict[str, Any]) -> Any:
        media_calls.append((url, body))
        message_id = str(body.get("message_id") or "msg")
        index = int(body.get("index") or 0)
        return {"path": f"/tmp/qq_media/{message_id}_{index}.png"}

    monkeypatch.setattr(qq_mcp_server.client, "post", fake_post)


def _quote_message() -> dict[str, Any]:
    return {
        "time": 1761331200,
        "message_id": 2001,
        "sender": {"user_id": 222, "nickname": "李四"},
        "message": [
            {"type": "text", "data": {"text": "收到 "}},
            {"type": "reply", "data": {"id": "q1"}},
        ],
    }


def _forward_message() -> dict[str, Any]:
    return {
        "time": 1761331300,
        "message_id": 3001,
        "sender": {"user_id": 333, "nickname": "王五"},
        "message": [{"type": "forward", "data": {"id": "f1"}}],
    }


def test_compact_quote_renders_content_and_downloads_media(monkeypatch: Any) -> None:
    actions = {
        "get_msg": {
            "sender": {"card": "张三", "nickname": "张三", "user_id": 111},
            "message": [
                {"type": "text", "data": {"text": "引用文字"}},
                {"type": "image", "data": {"summary": "[图片]"}},
            ],
        }
    }
    calls: list[tuple[str, Any]] = []
    media_calls: list[tuple[str, dict[str, Any]]] = []
    _patch_actions(monkeypatch, actions, calls)
    _patch_media_paths(monkeypatch, media_calls)

    output = _compact({"messages": [_quote_message()]})
    payload = json.loads(_compact({"messages": [_quote_message()]}, ResponseFormat.JSON))
    row = payload["messages"][0]

    assert "[引用 张三: 引用文字[图片]]" in output
    assert "/tmp/qq_media/q1_1.png" in output
    assert ("get_msg", {"message_id": "q1"}) in calls
    assert row["media"] == ["/tmp/qq_media/q1_1.png"]
    assert row["text"].startswith("收到 [引用 张三: 引用文字[图片]]")
    assert row["text"].endswith("/tmp/qq_media/q1_1.png")
    assert media_calls[0] == (
        "/v1/media",
        {
            "segment": {"type": "image", "data": {"summary": "[图片]"}},
            "index": 1,
            "message_id": "q1",
        },
    )


def test_compact_quote_uses_inline_content_without_get_msg(monkeypatch: Any) -> None:
    calls: list[tuple[str, Any]] = []
    media_calls: list[tuple[str, dict[str, Any]]] = []
    _patch_actions(monkeypatch, {}, calls)
    _patch_media_paths(monkeypatch, media_calls)
    message = {
        "time": 1761331200,
        "message_id": 2002,
        "sender": {"user_id": 222, "nickname": "李四"},
        "message": [
            {
                "type": "reply",
                "data": {
                    "sender": {"nickname": "张三"},
                    "message": [{"type": "text", "data": {"text": "内嵌引用"}}],
                },
            }
        ],
    }

    output = _compact({"messages": [message]}, fetch_media=False)

    assert "[引用 张三: 内嵌引用]" in output
    assert calls == []
    assert media_calls == []


def test_compact_forward_renders_nodes_and_downloads_media(monkeypatch: Any) -> None:
    actions = {
        "get_forward_msg": {
            "messages": [
                {
                    "type": "node",
                    "data": {
                        "sender": {"card": "张三"},
                        "content": [{"type": "text", "data": {"text": "合并文字"}}],
                    },
                },
                {
                    "type": "node",
                    "data": {
                        "sender": {"card": "李四"},
                        "content": [
                            {"type": "file", "data": {"name": "a.pdf"}},
                            {"type": "image", "data": {"summary": "[图片]"}},
                        ],
                    },
                },
            ]
        }
    }
    calls: list[tuple[str, Any]] = []
    media_calls: list[tuple[str, dict[str, Any]]] = []
    _patch_actions(monkeypatch, actions, calls)
    _patch_media_paths(monkeypatch, media_calls)

    output = _compact({"messages": [_forward_message()]})
    payload = json.loads(_compact({"messages": [_forward_message()]}, ResponseFormat.JSON))
    row = payload["messages"][0]

    assert "[合并转发:" in output
    assert "张三: 合并文字" in output
    assert "李四: [文件:a.pdf][图片]" in output
    assert "/tmp/qq_media/3001_fwd1_0.png" in output
    assert "/tmp/qq_media/3001_fwd1_1.png" in output
    assert ("get_forward_msg", {"message_id": "f1"}) in calls
    assert row["media"] == [
        "/tmp/qq_media/3001_fwd1_0.png",
        "/tmp/qq_media/3001_fwd1_1.png",
    ]


def test_compact_nested_forward_stops_at_depth_limit(monkeypatch: Any) -> None:
    nested = {
        "messages": [
            {
                "type": "node",
                "data": {
                    "sender": {"card": "张三"},
                    "content": [
                        {"type": "text", "data": {"text": "外层"}},
                        {"type": "forward", "data": {"id": "f1"}},
                    ],
                },
            }
        ]
    }
    calls: list[tuple[str, Any]] = []

    async def fake_call(action: str, params: Any = None, mutating: Any = None) -> Any:
        calls.append((action, params))
        return nested

    monkeypatch.setattr(qq_mcp_server.client, "call", fake_call)

    output = asyncio.run(
        asyncio.wait_for(
            _compact_history(
                {"messages": [_forward_message()]},
                ResponseFormat.MARKDOWN,
                "QQ History",
                "target=1",
                fetch_media=False,
            ),
            timeout=5,
        )
    )

    assert "深度上限" in output
    assert "外层" in output
    assert calls == [
        ("get_forward_msg", {"message_id": "f1"}),
        ("get_forward_msg", {"message_id": "f1"}),
    ]


def test_compact_without_media_never_calls_media_for_quote_and_forward(
    monkeypatch: Any,
) -> None:
    actions = {
        "get_msg": {
            "sender": {"card": "张三"},
            "message": [
                {"type": "text", "data": {"text": "引用文字"}},
                {"type": "image", "data": {"summary": "[图片]"}},
            ],
        },
        "get_forward_msg": {
            "messages": [
                {
                    "type": "node",
                    "data": {
                        "sender": {"card": "李四"},
                        "content": [
                            {"type": "text", "data": {"text": "合并文字"}},
                            {"type": "file", "data": {"name": "a.pdf"}},
                        ],
                    },
                }
            ]
        },
    }
    calls: list[tuple[str, Any]] = []
    media_calls: list[tuple[str, dict[str, Any]]] = []
    _patch_actions(monkeypatch, actions, calls)

    async def fake_post(url: str, body: dict[str, Any]) -> Any:
        media_calls.append((url, body))
        raise AssertionError("media endpoint must not be called")

    monkeypatch.setattr(qq_mcp_server.client, "post", fake_post)

    data = {"messages": [_quote_message(), _forward_message()]}
    output = _compact(data, fetch_media=False)
    payload = json.loads(_compact(data, ResponseFormat.JSON, fetch_media=False))

    assert "[引用 张三: 引用文字[图片]]" in output
    assert "[合并转发: 李四: 合并文字[文件:a.pdf]]" in output
    assert "/tmp/qq_media" not in output
    assert media_calls == []
    assert all("media" not in row for row in payload["messages"])
