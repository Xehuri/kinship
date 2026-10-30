from __future__ import annotations

import asyncio
import json
from typing import Any

from services import qq_mcp_server
from services.qq_mcp_server import ResponseFormat, _compact_history


MEDIA_PATH = "/tmp/qq_media/1001_1.png"
LONG_TEXT = "x" * 400


def _message(text: str = "你好 世界", message_id: Any = 1001) -> dict[str, Any]:
    return {
        "time": 1761331200,
        "message_id": message_id,
        "sender": {"user_id": 123, "nickname": "张三"},
        "message": [
            {"type": "text", "data": {"text": text}},
            {"type": "image", "data": {"summary": "[图片]"}},
        ],
    }


def _patch_media(
    monkeypatch: Any,
    path: str = MEDIA_PATH,
    calls: list[tuple[str, dict[str, Any]]] | None = None,
) -> None:
    async def fake_post(url: str, body: dict[str, Any]) -> Any:
        if calls is not None:
            calls.append((url, body))
        return {"path": path}

    monkeypatch.setattr(qq_mcp_server.client, "post", fake_post)


def _compact(data: Any, fmt: ResponseFormat, fetch_media: bool = True) -> str:
    return asyncio.run(
        _compact_history(
            data,
            fmt,
            "QQ Group History",
            "group_id=10003",
            fetch_media=fetch_media,
        )
    )


def test_compact_markdown_downloads_image_and_embeds_path(monkeypatch: Any) -> None:
    calls: list[tuple[str, dict[str, Any]]] = []
    _patch_media(monkeypatch, calls=calls)

    output = _compact({"messages": [_message()]}, ResponseFormat.MARKDOWN)

    assert "你好 世界[图片] " + MEDIA_PATH in output
    assert calls == [
        (
            "/v1/media",
            {
                "segment": {"type": "image", "data": {"summary": "[图片]"}},
                "index": 1,
                "message_id": "1001",
            },
        )
    ]


def test_compact_json_returns_media_array(monkeypatch: Any) -> None:
    _patch_media(monkeypatch)

    payload = json.loads(_compact({"messages": [_message()]}, ResponseFormat.JSON))
    row = payload["messages"][0]

    assert row["media"] == [MEDIA_PATH]
    assert row["text"].startswith("你好 世界[图片]")
    assert row["text"].endswith(MEDIA_PATH)
    assert set(row) == {"time", "message_id", "sender", "user_id", "text", "media"}


def test_long_text_keeps_full_media_path(monkeypatch: Any) -> None:
    _patch_media(monkeypatch)

    output = _compact({"messages": [_message(text=LONG_TEXT)]}, ResponseFormat.MARKDOWN)
    line = next(line for line in output.splitlines() if "id=1001" in line)

    assert line.endswith(" " + MEDIA_PATH)
    assert LONG_TEXT[:300] + "…" in line
    assert LONG_TEXT[:301] not in line


def test_compact_without_unread_does_not_call_media_endpoint(monkeypatch: Any) -> None:
    calls: list[str] = []

    async def fake_post(url: str, body: dict[str, Any]) -> Any:
        calls.append(url)
        raise AssertionError("media endpoint must not be called")

    monkeypatch.setattr(qq_mcp_server.client, "post", fake_post)

    output = _compact({"messages": [_message()]}, ResponseFormat.MARKDOWN, fetch_media=False)
    payload = json.loads(
        _compact({"messages": [_message()]}, ResponseFormat.JSON, fetch_media=False)
    )

    assert "[图片]" in output
    assert MEDIA_PATH not in output
    assert "media" not in payload["messages"][0]
    assert calls == []


def test_media_fetch_failure_falls_back_to_placeholder(monkeypatch: Any) -> None:
    async def fake_post(url: str, body: dict[str, Any]) -> Any:
        raise RuntimeError("gateway down")

    monkeypatch.setattr(qq_mcp_server.client, "post", fake_post)

    output = _compact({"messages": [_message()]}, ResponseFormat.MARKDOWN)
    payload = json.loads(_compact({"messages": [_message()]}, ResponseFormat.JSON))

    assert "[图片]" in output
    assert MEDIA_PATH not in output
    assert "media" not in payload["messages"][0]


def test_compact_markdown_file_segment_appends_path(monkeypatch: Any) -> None:
    path = "/tmp/qq_media/1002_1.pdf"
    _patch_media(monkeypatch, path=path)
    message = {
        "time": 1761331200,
        "message_id": 1002,
        "sender": {"user_id": 456, "nickname": "李四"},
        "message": [{"type": "file", "data": {"name": "a.pdf"}}],
    }

    output = _compact({"messages": [message]}, ResponseFormat.MARKDOWN)

    assert "[文件:a.pdf] " + path in output
