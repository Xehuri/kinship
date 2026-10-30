from __future__ import annotations

import asyncio
import json
from typing import Any, Optional

from services import qq_mcp_server
from services.qq_mcp_server import (
    CommentQZoneInput,
    DeleteQZoneCommentInput,
    GetQZoneCommentsInput,
    GetQZoneFeedsInput,
    LikeQZoneInput,
    ReplyQZoneCommentInput,
    ResponseFormat,
)


def _patch_get(monkeypatch: Any, result: Any) -> list[tuple[str, Optional[dict[str, Any]]]]:
    calls: list[tuple[str, Optional[dict[str, Any]]]] = []

    async def fake_get(path: str, params: Optional[dict[str, Any]] = None) -> Any:
        calls.append((path, params))
        return result

    monkeypatch.setattr(qq_mcp_server.client, "get", fake_get)
    return calls


def _patch_post(monkeypatch: Any, result: Any) -> list[tuple[str, dict[str, Any]]]:
    calls: list[tuple[str, dict[str, Any]]] = []

    async def fake_post(path: str, body: dict[str, Any]) -> Any:
        calls.append((path, body))
        return result

    monkeypatch.setattr(qq_mcp_server.client, "post", fake_post)
    return calls


def test_get_qzone_feeds_calls_get_route(monkeypatch: Any) -> None:
    calls = _patch_get(monkeypatch, {"feeds": [{"tid": "tid-1"}]})
    params = GetQZoneFeedsInput(
        target_qq="123456", limit=5, response_format=ResponseFormat.JSON,
    )

    output = asyncio.run(qq_mcp_server.qq_get_qzone_feeds(params))

    assert calls == [("/v1/qzone/feeds", {"target_qq": "123456", "limit": 5})]
    assert json.loads(output) == {"feeds": [{"tid": "tid-1"}]}


def test_get_qzone_comments_calls_get_route(monkeypatch: Any) -> None:
    calls = _patch_get(monkeypatch, {"comments": [{"comment_id": "c-1"}]})
    params = GetQZoneCommentsInput(
        target_qq="123456", tid="tid-1", scan=3, response_format=ResponseFormat.JSON,
    )

    output = asyncio.run(qq_mcp_server.qq_get_qzone_comments(params))

    assert calls == [("/v1/qzone/comments", {
        "target_qq": "123456", "tid": "tid-1", "scan": 3,
    })]
    assert "c-1" in output


def test_comment_qzone_posts_exact_body(monkeypatch: Any) -> None:
    calls = _patch_post(monkeypatch, {"comment_id": "c-1"})
    params = CommentQZoneInput(
        target_qq="123456", tid="tid-1", content="测试评论",
        response_format=ResponseFormat.JSON,
    )

    output = asyncio.run(qq_mcp_server.qq_comment_qzone(params))

    assert calls == [("/v1/qzone/comment", {
        "target_qq": "123456", "tid": "tid-1", "content": "测试评论",
    })]
    assert json.loads(output) == {"comment_id": "c-1"}


def test_reply_qzone_comment_posts_exact_body(monkeypatch: Any) -> None:
    calls = _patch_post(monkeypatch, {"ok": True})
    params = ReplyQZoneCommentInput(
        target_qq="123456",
        tid="tid-1",
        comment_id="c-1",
        content="测试回复",
        comment_uin="654321",
        comment_nick="小明",
        response_format=ResponseFormat.JSON,
    )

    output = asyncio.run(qq_mcp_server.qq_reply_qzone_comment(params))

    assert calls == [("/v1/qzone/reply", {
        "target_qq": "123456",
        "tid": "tid-1",
        "comment_id": "c-1",
        "content": "测试回复",
        "comment_uin": "654321",
        "comment_nick": "小明",
    })]
    assert json.loads(output) == {"ok": True}


def test_delete_qzone_comment_posts_exact_body(monkeypatch: Any) -> None:
    calls = _patch_post(monkeypatch, {"deleted": True})
    params = DeleteQZoneCommentInput(
        target_qq="123456",
        tid="tid-1",
        comment_id="c-1",
        comment_uin="654321",
        response_format=ResponseFormat.JSON,
    )

    output = asyncio.run(qq_mcp_server.qq_delete_qzone_comment(params))

    assert calls == [("/v1/qzone/delete_comment", {
        "target_qq": "123456",
        "tid": "tid-1",
        "comment_id": "c-1",
        "comment_uin": "654321",
    })]
    assert json.loads(output) == {"deleted": True}


def test_like_qzone_posts_exact_body(monkeypatch: Any) -> None:
    calls = _patch_post(monkeypatch, {"liked": True})
    params = LikeQZoneInput(
        target_qq="123456", tid="tid-1", response_format=ResponseFormat.JSON,
    )

    output = asyncio.run(qq_mcp_server.qq_like_qzone(params))

    assert calls == [("/v1/qzone/like", {"target_qq": "123456", "tid": "tid-1"})]
    assert json.loads(output) == {"liked": True}


def test_qzone_tool_returns_markdown_title(monkeypatch: Any) -> None:
    _patch_get(monkeypatch, {"feeds": []})
    params = GetQZoneFeedsInput(target_qq="123456")

    output = asyncio.run(qq_mcp_server.qq_get_qzone_feeds(params))

    assert output.startswith("# QQ Zone Feeds\n\n```json\n")
