# -*- coding: utf-8 -*-
"""测试会话历史接口对 user 消息系统包装的剥离（C2 修复）。

覆盖：
1. 带 <Axeuh-home-system> 包装的 user 消息 -> 剥离包装，保留真实文本；
2. 以 '<' 开头的普通 user 文本（如 <div>/<svg>）不被误伤；
3. assistant 消息与非 text part 不受影响。
"""
import asyncio
from typing import Any, Dict, List, Optional

import pytest

from routers import session as session_router


# 与 opencode_client.py 发送时的包装格式保持一致
WRAPPED_RAW = (
    "<Axeuh-home-system>\n"
    "{\n"
    '  "speaker": "用户",\n'
    '  "prompt": "必须第一时间使用tts_speak工具中文回复语音消息。",\n'
    '  "current_datetime": "2026-09-11 10:00:00"\n'
    "}\n"
    "</Axeuh-home-system>\n\n"
    "今天天气怎么样？"
)


def _make_msg(
    role: str, parts: List[Dict[str, Any]], msg_id: str = "m1"
) -> Dict[str, Any]:
    """构造一条 OpenCode 风格消息"""
    return {"info": {"id": msg_id, "role": role}, "parts": parts}


class _FakeGateway:
    """替身网关，返回预置消息，避免访问真实 OpenCode 服务"""

    def __init__(self, messages: List[Dict[str, Any]]) -> None:
        self._messages = messages

    async def get_session_messages(
        self, session_id: str, limit: int = 100, before: Optional[str] = None
    ) -> Dict[str, Any]:
        return {
            "ok": True,
            "data": {"messages": self._messages, "next_cursor": None},
        }


def _call_endpoint(
    monkeypatch: pytest.MonkeyPatch, messages: List[Dict[str, Any]]
) -> Dict[str, Any]:
    """直接调用路由函数（绕过 HTTP 与认证），返回响应体"""
    fake_client = _FakeGateway(messages)

    async def _fake_acquire():
        return fake_client

    monkeypatch.setattr(session_router, "acquire_web_client", _fake_acquire)
    return asyncio.run(session_router.get_session_messages("sess_test"))


def test_wrapped_user_message_is_stripped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """带系统包装的 user 消息应只保留真实文本"""
    messages = [_make_msg("user", [{"type": "text", "text": WRAPPED_RAW}])]
    result = _call_endpoint(monkeypatch, messages)
    parts = result["messages"][0]["parts"]
    assert parts[0]["text"] == "今天天气怎么样？"


def test_plain_user_text_starting_with_angle_bracket_not_mangled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """以 '<' 开头的普通文本（<div>/<svg>）不能被清洗逻辑误伤"""
    for raw in ("<div>hello</div>", "<svg viewBox='0 0 10 10'></svg>"):
        messages = [_make_msg("user", [{"type": "text", "text": raw}])]
        result = _call_endpoint(monkeypatch, messages)
        assert result["messages"][0]["parts"][0]["text"] == raw


def test_assistant_and_non_text_parts_unchanged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """assistant 消息与非 text part 保持不变"""
    assistant_raw = "<Axeuh-home-system>不应被处理</Axeuh-home-system>回复内容"
    messages = [
        _make_msg("assistant", [{"type": "text", "text": assistant_raw}], "a1"),
        _make_msg(
            "user",
            [
                {"type": "file", "url": "file:///tmp/x.png"},
                {"type": "text", "text": WRAPPED_RAW},
            ],
            "u1",
        ),
    ]
    result = _call_endpoint(monkeypatch, messages)
    # assistant 消息原文保持不变
    assert result["messages"][0]["parts"][0]["text"] == assistant_raw
    # user 的非 text part 原样保留，只有 text part 被清洗
    user_parts = result["messages"][1]["parts"]
    assert user_parts[0] == {"type": "file", "url": "file:///tmp/x.png"}
    assert user_parts[1]["text"] == "今天天气怎么样？"
