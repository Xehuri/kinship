# -*- coding: utf-8 -*-
"""测试会话消息接口的分页契约（limit / before / next_cursor）。

覆盖：
1. limit 与 before 被透传给网关；
2. next_cursor 作为 before 再取一页，两页无重叠；
3. 无更早消息（底层游标已到顶）时 next_cursor 为 null；非空短页游标恒透传（W50）。

before / next_cursor 的语义：OpenCode 的 x-next-cursor 不透明游标，
用于获取比该游标更早的一页；无更早消息时为 None。
"""
import asyncio
from typing import Any, Dict, List, Optional

from routers import session as session_router


def _make_msg(idx: int) -> Dict[str, Any]:
    """构造一条 OpenCode 风格消息（idx 越大时间越新）"""
    return {
        "info": {"id": f"m{idx}", "role": "user", "time": {"created": idx}},
        "parts": [{"type": "text", "text": f"t{idx}"}],
    }


class _PagingGateway:
    """模拟 OpenCode 分页：消息按时间升序，游标为页内最旧消息下标。

    before=None 取最新一页；before="k" 取 end=k 的更早一页。
    next_cursor 为继续更早翻页的 end 值（无更早时为 None）。
    """

    def __init__(self, dataset: List[Dict[str, Any]]) -> None:
        # dataset 按时间升序（旧 -> 新）
        self._dataset = dataset
        self.calls: List[Dict[str, Any]] = []

    async def get_session_messages(
        self,
        session_id: str,
        limit: int = 50,
        before: Optional[str] = None,
    ) -> Dict[str, Any]:
        self.calls.append({"session_id": session_id, "limit": limit, "before": before})
        end = len(self._dataset) if before is None else int(before)
        start = max(0, end - limit)
        page = self._dataset[start:end]
        next_cursor = str(start) if start > 0 else None
        return {"ok": True, "data": {"messages": page, "next_cursor": next_cursor}}


class _StaticCursorGateway:
    """固定返回预置消息与游标，用于验证"页不足 limit 即置空"逻辑"""

    def __init__(
        self, messages: List[Dict[str, Any]], next_cursor: Optional[str]
    ) -> None:
        self._messages = messages
        self._next_cursor = next_cursor

    async def get_session_messages(
        self, session_id: str, limit: int = 50, before: Optional[str] = None
    ) -> Dict[str, Any]:
        return {
            "ok": True,
            "data": {"messages": self._messages, "next_cursor": self._next_cursor},
        }


def _ids(result: Dict[str, Any]) -> List[str]:
    return [m["info"]["id"] for m in result["messages"]]


def test_limit_and_before_forwarded_to_gateway(monkeypatch) -> None:
    """limit 与 before 必须原样透传给网关"""
    gateway = _PagingGateway([_make_msg(i) for i in range(10)])
    async def _fake_acquire():
        return gateway

    monkeypatch.setattr(session_router, "acquire_web_client", _fake_acquire)

    asyncio.run(session_router.get_session_messages("sess", limit=3, before=None))
    asyncio.run(session_router.get_session_messages("sess", limit=4, before="5"))

    assert gateway.calls[0] == {"session_id": "sess", "limit": 3, "before": None}
    assert gateway.calls[1] == {"session_id": "sess", "limit": 4, "before": "5"}


def test_passing_next_cursor_yields_next_page_without_overlap(monkeypatch) -> None:
    """next_cursor 作为 before 再取页，得到更早一页且两页无重叠"""
    gateway = _PagingGateway([_make_msg(i) for i in range(7)])
    async def _fake_acquire():
        return gateway

    monkeypatch.setattr(session_router, "acquire_web_client", _fake_acquire)

    page1: Dict[str, Any] = asyncio.run(
        session_router.get_session_messages("sess", limit=2, before=None)
    )
    assert page1["next_cursor"] == "5"
    assert _ids(page1) == ["m5", "m6"]

    page2: Dict[str, Any] = asyncio.run(
        session_router.get_session_messages(
            "sess", limit=2, before=page1["next_cursor"]
        )
    )
    assert _ids(page2) == ["m3", "m4"]
    assert set(_ids(page1)) & set(_ids(page2)) == set()


def test_next_cursor_null_when_no_more_pages(monkeypatch) -> None:
    """底层已无更早消息时 next_cursor 为 null"""
    gateway = _PagingGateway([_make_msg(i) for i in range(2)])
    async def _fake_acquire():
        return gateway

    monkeypatch.setattr(session_router, "acquire_web_client", _fake_acquire)

    result = asyncio.run(
        session_router.get_session_messages("sess", limit=2, before=None)
    )
    assert result["next_cursor"] is None
    assert result["count"] == 2


def test_short_page_keeps_cursor_passthrough(monkeypatch) -> None:
    """W50 修正后语义：页不足 limit 不再视为到头（loom 页级合并使译后条数<limit
    是常态），上游游标恒透传；截断只发生在译后空页（新语义双钉另见
    test_session_dual_channel.TestMessagesCursorPassthrough，W50 漏迁此旧钉，随 W51 补齐）。"""
    gateway = _StaticCursorGateway([_make_msg(0)], next_cursor="0")
    async def _fake_acquire():
        return gateway

    monkeypatch.setattr(session_router, "acquire_web_client", _fake_acquire)

    result = asyncio.run(
        session_router.get_session_messages("sess", limit=5, before=None)
    )
    assert result["next_cursor"] == "0"
    assert result["count"] == 1
