from __future__ import annotations

import asyncio
import json
import re
from typing import Any

from services import qq_mcp_server
from services.qq_mcp_server import (
    FriendMsgHistoryInput,
    GetGroupMsgHistoryInput,
    ResponseFormat,
    _compact_history,
)


SAMPLE: dict[str, Any] = {
    "messages": [
        {
            "time": 1761331200,
            "message_id": 1001,
            "post_type": "message",
            "sender": {"user_id": 123, "nickname": "张三", "card": ""},
            "message": [
                {"type": "text", "data": {"text": "你好 世界"}},
                {"type": "image", "data": {"summary": "[图片]"}},
            ],
        },
        {
            "time": 1761331260,
            "message_id": 1002,
            "post_type": "message",
            "sender": {"user_id": 456, "nickname": "李四", "card": "李四"},
            "message": [
                {"type": "at", "data": {"qq": "all"}},
                {"type": "face", "data": {"summary": "[表情]"}},
            ],
        },
    ]
}


def test_compact_markdown_renders_one_line_per_message() -> None:
    output = asyncio.run(
        _compact_history(
            SAMPLE, ResponseFormat.MARKDOWN, "QQ Group History", "group_id=10003"
        )
    )
    assert output.startswith("# QQ Group History\ngroup_id=10003\ncount=2\n\n")
    assert re.search(
        r"\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] 张三\(123\) id=1001: 你好 世界\[图片\]",
        output,
    )
    assert "@全体成员" in output
    assert "[表情]" in output
    assert "id=1002" in output


def test_compact_json_returns_structured_rows() -> None:
    output = asyncio.run(
        _compact_history(
            SAMPLE, ResponseFormat.JSON, "QQ Group History", "group_id=10003"
        )
    )
    payload = json.loads(output)
    assert payload["count"] == 2
    rows = payload["messages"]
    assert rows[0]["sender"] == "张三"
    assert rows[0]["user_id"] == "123"
    assert rows[0]["text"] == "你好 世界[图片]"
    assert rows[1]["text"] == "@全体成员[表情]"


def test_compact_markdown_empty_list() -> None:
    output = asyncio.run(
        _compact_history(
            {"messages": []},
            ResponseFormat.MARKDOWN,
            "QQ Group History",
            "group_id=10003",
        )
    )
    assert "count=0" in output
    assert "(empty)" in output


def test_compact_markdown_falls_back_for_unknown_shape() -> None:
    output = asyncio.run(
        _compact_history(
            {"unexpected": 1},
            ResponseFormat.MARKDOWN,
            "QQ Group History",
            "group_id=10003",
        )
    )
    assert "```json" in output


def test_compact_truncates_text_and_renders_zero_time() -> None:
    data = {
        "messages": [
            {
                "time": 0,
                "message_id": "9",
                "sender": {"user_id": 1, "nickname": "n"},
                "message": [{"type": "text", "data": {"text": "x" * 400}}],
            }
        ]
    }
    output = asyncio.run(
        _compact_history(data, ResponseFormat.MARKDOWN, "QQ History", "meta=1")
    )
    assert "x" * 300 + "…" in output
    assert "x" * 301 not in output
    assert "[?]" in output


def test_group_tool_compact_adds_napcat_flags(monkeypatch: Any) -> None:
    calls: list[tuple[str, Any, bool]] = []

    async def fake_call(action: str, params: Any = None, mutating: bool = False) -> Any:
        calls.append((action, params, mutating))
        return SAMPLE

    monkeypatch.setattr(qq_mcp_server.client, "call", fake_call)
    output = asyncio.run(
        qq_mcp_server.qq_get_group_msg_history(
            GetGroupMsgHistoryInput(group_id="10003", count=20, compact=True)
        )
    )
    assert calls[0][0] == "get_group_msg_history"
    assert calls[0][1] == {
        "group_id": "10003",
        "count": 20,
        "parse_mult_msg": False,
        "disable_get_url": True,
    }
    assert output.startswith("# QQ Group History\ngroup_id=10003\ncount=2")


def test_group_tool_non_compact_keeps_original_output(monkeypatch: Any) -> None:
    calls: list[tuple[str, Any, bool]] = []

    async def fake_call(action: str, params: Any = None, mutating: bool = False) -> Any:
        calls.append((action, params, mutating))
        return SAMPLE

    monkeypatch.setattr(qq_mcp_server.client, "call", fake_call)
    output = asyncio.run(
        qq_mcp_server.qq_get_group_msg_history(
            GetGroupMsgHistoryInput(group_id="10003", count=20)
        )
    )
    assert "```json" in output
    assert "parse_mult_msg" not in calls[0][1]
    assert "disable_get_url" not in calls[0][1]


def test_friend_tool_compact_adds_napcat_flags(monkeypatch: Any) -> None:
    calls: list[tuple[str, Any, bool]] = []

    async def fake_call(action: str, params: Any = None, mutating: bool = False) -> Any:
        calls.append((action, params, mutating))
        return SAMPLE

    monkeypatch.setattr(qq_mcp_server.client, "call", fake_call)
    output = asyncio.run(
        qq_mcp_server.qq_get_friend_msg_history(
            FriendMsgHistoryInput(user_id="10002", compact=True)
        )
    )
    assert calls[0][0] == "get_friend_msg_history"
    assert calls[0][1] == {
        "user_id": "10002",
        "count": 50,
        "parse_mult_msg": False,
        "disable_get_url": True,
    }
    assert output.startswith("# QQ Friend History\nuser_id=10002\ncount=2")
