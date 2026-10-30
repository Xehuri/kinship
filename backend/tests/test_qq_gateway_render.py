from __future__ import annotations

import asyncio

from services.qq_gateway.media import sniff_media_ext
from services.qq_gateway.render import render_segments


def test_render_segments() -> None:
    async def media(_segment: dict, index: int) -> str:
        return f"/tmp/{index}.gif"

    async def forward(_segment: dict) -> str:
        return "【合并转发消息: ...】\n- A: hi"

    async def scenario() -> None:
        text = await render_segments([
            {"type": "text", "data": {"text": "hello "}},
            {"type": "at", "data": {"qq": "100"}},
            {"type": "image", "data": {"summary": "[动画表情]"}},
            {"type": "mface", "data": {"summary": "[比心]"}},
            {"type": "file", "data": {"name": "a.txt"}},
            {"type": "forward", "data": {"id": "f1"}},
        ], media=media, forward=forward)
        assert "hello " in text
        assert "@100" in text
        assert "[动画表情] /tmp/2.gif" in text
        assert "[比心]" in text
        assert "[文件:a.txt] /tmp/4.gif" in text
        assert "【合并转发消息" in text

    asyncio.run(scenario())


def test_sniff_media_ext() -> None:
    assert sniff_media_ext(b"GIF89a....") == ".gif"
    assert sniff_media_ext(b"GIF87a....") == ".gif"
    assert sniff_media_ext(b"\x89PNG\r\n\x1a\n....") == ".png"
    assert sniff_media_ext(b"\xff\xd8\xff....") == ".jpg"
    assert sniff_media_ext(b"RIFF\x00\x00\x00\x00WEBP") == ".webp"
    assert sniff_media_ext(b"unknown", ".bin") == ".bin"
