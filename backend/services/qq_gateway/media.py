from __future__ import annotations

import asyncio
import base64
import logging
import re
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

import aiohttp

ActionCaller = Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]

_MAGIC = (
    (b"GIF87a", ".gif"),
    (b"GIF89a", ".gif"),
    (b"\x89PNG\r\n\x1a\n", ".png"),
    (b"\xff\xd8\xff", ".jpg"),
    (b"RIFF", ".webp"),
    (b"BM", ".bmp"),
)


def sniff_media_ext(data: bytes, fallback: str = ".bin") -> str:
    for magic, ext in _MAGIC:
        if data.startswith(magic):
            if ext == ".webp" and not data[8:12] == b"WEBP":
                continue
            return ext
    return fallback


def _safe_name(message_id: str, index: int, ext: str) -> str:
    base = re.sub(r"[^A-Za-z0-9_.-]", "_", message_id or "msg")
    return f"{base}_{index}{ext}"


class MediaFetcher:
    def __init__(self, media_dir: str, max_mb: int, gif_sniff: bool = True,
                 logger: Optional[logging.Logger] = None) -> None:
        self.media_dir = Path(media_dir)
        self.media_dir.mkdir(parents=True, exist_ok=True)
        self.max_bytes = max_mb * 1024 * 1024
        self.gif_sniff = gif_sniff
        self.log = logger or logging.getLogger(__name__)

    def _existing(self, message_id: str, index: int) -> Optional[str]:
        pattern = _safe_name(message_id, index, ".*")
        for candidate in sorted(self.media_dir.glob(pattern)):
            if candidate.is_file():
                return str(candidate)
        return None

    async def fetch(self, segment: dict[str, Any], index: int, message_id: str,
                    call_action: Optional[ActionCaller] = None) -> Optional[str]:
        data = segment.get("data") or {}
        local = data.get("file") or data.get("path")
        if local and Path(str(local)).is_file():
            return str(local)
        cached = self._existing(message_id, index)
        if cached:
            return cached
        payload = await self._resolve_payload(
            data, call_action, str(segment.get("type") or "")
        )
        if not payload:
            return None
        raw: Optional[bytes] = None
        if payload.get("base64"):
            try:
                raw = base64.b64decode(str(payload["base64"]))
            except Exception:
                raw = None
        url = payload.get("url") or payload.get("file")
        if raw is None and url:
            raw = await self._download(str(url))
        if raw is None:
            return None
        fallback = Path(str(data.get("file") or "")).suffix or ".bin"
        ext = sniff_media_ext(raw, fallback) if self.gif_sniff else fallback
        target = self.media_dir / _safe_name(message_id, index, ext)
        await asyncio.to_thread(target.write_bytes, raw)
        return str(target)

    async def _resolve_payload(self, data: dict[str, Any],
                               call_action: Optional[ActionCaller],
                               segment_type: str = "") -> Optional[dict[str, Any]]:
        if data.get("url") or data.get("base64"):
            return data
        if call_action is None:
            return None
        action = "get_image" if segment_type == "image" else "get_file"
        if action == "get_image":
            file_value = str(data.get("file") or data.get("file_id") or "")
            if not file_value:
                return None
            params = {"file": file_value}
        else:
            file_id = str(data.get("file_id") or "")
            file_value = str(data.get("file") or "")
            if not file_id and not file_value:
                return None
            params = {"file_id": file_id, "file": file_value}
        try:
            result = await call_action(action, params)
        except Exception as exc:
            self.log.warning("qq-gateway media resolve failed: %s", exc)
            return None
        return result if isinstance(result, dict) else None

    async def _download(self, url: str) -> Optional[bytes]:
        if not url.startswith(("http://", "https://")):
            return None
        timeout = aiohttp.ClientTimeout(total=30)
        try:
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.get(url) as response:
                    if response.status != 200:
                        return None
                    chunks: list[bytes] = []
                    size = 0
                    async for chunk in response.content.iter_chunked(64 * 1024):
                        size += len(chunk)
                        if size > self.max_bytes:
                            return None
                        chunks.append(chunk)
                    return b"".join(chunks)
        except Exception as exc:
            self.log.warning("qq-gateway media download failed: %s", exc)
            return None
