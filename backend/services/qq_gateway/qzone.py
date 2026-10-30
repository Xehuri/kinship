from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from collections.abc import Callable, Mapping
from typing import Any

from .actions import ActionError
from .config import OutboundConfig, QZoneConfig
from .qzone_client import QZoneAuth, QZoneClient, QZoneError
from .qzone_parse import djb2_gtk, normalize_uin, parse_cookie_string

_COOKIE_DOMAIN = "user.qzone.qq.com"
_COOKIE_TTL_SEC = 1800.0
_READ_LIMIT = 30
_READ_WINDOW_SEC = 60.0
_WRITE_WINDOW_SEC = 3600.0
_MAX_FEEDS = 20
_REPLY_SCAN = 10
_MAX_CONTENT = 1000
_LOG_GUARD_FLAG = "_axeuh_qzone_log_guard"


class _QZoneRequestFilter(logging.Filter):
    """Drop httpx request lines that carry QZone query parameters."""

    def filter(self, record: logging.LogRecord) -> bool:
        return "user.qzone.qq.com" not in record.getMessage()


def _install_log_guard() -> None:
    logger = logging.getLogger("httpx")
    if getattr(logger, _LOG_GUARD_FLAG, False):
        return
    logger.addFilter(_QZoneRequestFilter())
    setattr(logger, _LOG_GUARD_FLAG, True)


class QZoneService:
    """Gated, rate-limited facade over :class:`QZoneClient`."""

    def __init__(self, actions: Any, qzone: QZoneConfig, outbound: OutboundConfig,
                 self_qq: str, logger: logging.Logger | None = None,
                 http_transport: Any = None,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self.actions = actions
        self.qzone = qzone
        self.outbound = outbound
        self._self_uin = normalize_uin(self_qq)
        self._logger = logger or logging.getLogger(__name__)
        self._clock = clock
        self._client = QZoneClient(transport=http_transport, logger=self._logger)
        self._auth_lock = asyncio.Lock()
        self._auth_cache: QZoneAuth | None = None
        self._auth_at = 0.0
        self._reads: deque[float] = deque()
        self._writes: deque[float] = deque()
        self._write_limit = max(1, int(qzone.rate_per_hour))
        self._closed = False
        _install_log_guard()

    async def list_feeds(self, target_qq: str, limit: int = 10) -> dict[str, Any]:
        started = time.monotonic()
        target = self._target(target_qq, "target_qq")
        capped = self._limit(limit)
        self._ensure_read("qzone_list_feeds")
        self._acquire(self._reads, _READ_LIMIT, _READ_WINDOW_SEC,
                      "qzone_list_feeds", "read")
        feeds = await self._fetch_feeds(target, capped)
        self._log("list_feeds", "ok", started, len(feeds))
        return {"target_qq": target, "count": len(feeds), "feeds": feeds}

    async def get_comments(self, target_qq: str, tid: str,
                           scan: int = 10) -> dict[str, Any]:
        started = time.monotonic()
        target = self._target(target_qq, "target_qq")
        topic = self._text(tid, "tid")
        window = self._limit(scan)
        self._ensure_read("qzone_get_comments")
        self._acquire(self._reads, _READ_LIMIT, _READ_WINDOW_SEC,
                      "qzone_get_comments", "read")
        feeds = await self._fetch_feeds(target, window)
        for feed in feeds:
            if str(feed.get("tid") or "") != topic:
                continue
            comments = feed.get("comments") or []
            count = feed.get("comment_count")
            if isinstance(count, bool) or not isinstance(count, int):
                count = len(comments)
            self._log("get_comments", "found", started, len(comments))
            return {
                "target_qq": target,
                "tid": topic,
                "found": True,
                "comments": comments,
                "comment_count": count,
            }
        self._log("get_comments", "not_found", started, window)
        return {
            "target_qq": target,
            "tid": topic,
            "found": False,
            "comments": [],
            "scanned": window,
        }

    async def comment(self, target_qq: str, tid: str, content: str) -> dict[str, Any]:
        started = time.monotonic()
        target = self._target(target_qq, "target_qq")
        topic = self._text(tid, "tid")
        text = self._content(content)
        self._ensure_write("qzone_comment")
        if self.outbound.dry_run:
            self._log("comment", "dry_run", started)
            return self._dry_run("comment", target, topic, len(text))
        self._acquire(self._writes, self._write_limit, _WRITE_WINDOW_SEC,
                      "qzone_comment", "write")
        auth = await self._auth()
        try:
            await self._client.comment(auth, target, topic, text)
        except QZoneError as exc:
            self._invalidate_auth_on_1401(exc)
            raise
        self._log("comment", "ok", started)
        return {
            "success": True,
            "target_qq": target,
            "tid": topic,
            "content_length": len(text),
            "code": 0,
        }

    async def reply(self, target_qq: str, tid: str, comment_id: str, content: str,
                    comment_uin: str | None = None,
                    comment_nick: str | None = None) -> dict[str, Any]:
        started = time.monotonic()
        target = self._target(target_qq, "target_qq")
        topic = self._text(tid, "tid")
        cid = self._text(comment_id, "comment_id")
        text = self._content(content)
        self._ensure_write("qzone_reply")
        if self.outbound.dry_run:
            self._log("reply", "dry_run", started)
            return self._dry_run("reply", target, topic, len(text))
        if comment_uin is not None and comment_nick is not None:
            parent_uin = self._target(comment_uin, "comment_uin")
            parent_nick = str(comment_nick)
        else:
            parent_uin, parent_nick = await self._resolve_comment(target, topic, cid)
        self._acquire(self._writes, self._write_limit, _WRITE_WINDOW_SEC,
                      "qzone_reply", "write")
        auth = await self._auth()
        try:
            await self._client.reply(auth, target, topic, cid, text, parent_uin, parent_nick)
        except QZoneError as exc:
            self._invalidate_auth_on_1401(exc)
            raise
        self._log("reply", "ok", started)
        return {
            "success": True,
            "target_qq": target,
            "tid": topic,
            "comment_id": cid,
            "content_length": len(text),
            "code": 0,
        }

    async def delete_comment(self, target_qq: str, tid: str, comment_id: str,
                             comment_uin: str | None = None) -> dict[str, Any]:
        started = time.monotonic()
        target = self._target(target_qq, "target_qq")
        topic = self._text(tid, "tid")
        comment = self._text(comment_id, "comment_id")
        parent = None
        if comment_uin not in (None, ""):
            parent = self._target(comment_uin, "comment_uin")
        self._ensure_delete("qzone_delete_comment")
        if self.outbound.dry_run:
            self._log("delete_comment", "dry_run", started)
            return {
                "dry_run": True,
                "action": "delete_comment",
                "target_qq": target,
                "tid": topic,
                "comment_id": comment,
            }
        self._acquire(self._writes, self._write_limit, _WRITE_WINDOW_SEC,
                      "qzone_delete_comment", "write")
        auth = await self._auth()
        effective_uin = parent or auth.uin
        try:
            await self._client.delete_comment(auth, target, topic, comment, effective_uin)
        except QZoneError as exc:
            self._invalidate_auth_on_1401(exc)
            raise
        self._log("delete_comment", "ok", started)
        return {
            "success": True,
            "target_qq": target,
            "tid": topic,
            "comment_id": comment,
            "comment_uin": effective_uin,
            "code": 0,
        }

    async def like(self, target_qq: str, tid: str) -> dict[str, Any]:
        started = time.monotonic()
        target = self._target(target_qq, "target_qq")
        topic = self._text(tid, "tid")
        self._ensure_write("qzone_like")
        if self.outbound.dry_run:
            self._log("like", "dry_run", started)
            return {"dry_run": True, "action": "like",
                    "target_qq": target, "tid": topic}
        self._acquire(self._writes, self._write_limit, _WRITE_WINDOW_SEC,
                      "qzone_like", "write")
        auth = await self._auth()
        try:
            await self._client.like(auth, target, topic)
        except QZoneError as exc:
            self._invalidate_auth_on_1401(exc)
            raise
        self._log("like", "ok", started)
        return {"success": True, "target_qq": target, "tid": topic}

    def status(self) -> dict[str, Any]:
        active = bool(self.qzone.enabled and self.qzone.mode == "http_sidecar")
        read = bool(active and self.qzone.allow_read)
        send = bool(read and self.qzone.allow_send and self.outbound.enabled)
        return {
            "enabled": bool(self.qzone.enabled),
            "mode": self.qzone.mode,
            "read": read,
            "send": send,
            "delete": bool(active and self.qzone.allow_delete and self.outbound.enabled),
            "write_limit_per_hour": self._write_limit,
        }

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        await self._client.close()

    async def _fetch_feeds(self, target: str, limit: int) -> list[dict[str, Any]]:
        auth = await self._auth()
        try:
            return await self._client.list_feeds(auth, target, limit)
        except QZoneError as exc:
            if exc.retcode != 1401:
                raise
        auth = await self._auth(force=True)
        return await self._client.list_feeds(auth, target, limit)

    async def _resolve_comment(self, target: str, tid: str,
                               comment_id: str) -> tuple[str, str]:
        if not self.qzone.allow_read:
            raise QZoneError("qzone_reply", "qzone read is disabled", 1403)
        result = await self.list_feeds(target, _REPLY_SCAN)
        for feed in result["feeds"]:
            if str(feed.get("tid") or "") != tid:
                continue
            for comment in feed.get("comments") or []:
                if str(comment.get("comment_id") or "") != comment_id:
                    continue
                uin = str(comment.get("uin") or "")
                if uin:
                    return uin, str(comment.get("nick") or "")
        raise QZoneError("qzone_reply", "qzone comment not found", 1404)

    async def _auth(self, *, force: bool = False) -> QZoneAuth:
        if not force:
            cached = self._cached_auth()
            if cached is not None:
                return cached
        async with self._auth_lock:
            if not force:
                cached = self._cached_auth()
                if cached is not None:
                    return cached
            auth = await self._fetch_auth()
            self._auth_cache = auth
            self._auth_at = self._clock()
            return auth

    def _invalidate_auth_on_1401(self, exc: QZoneError) -> None:
        if exc.retcode == 1401:
            self._auth_cache = None

    def _cached_auth(self) -> QZoneAuth | None:
        if self._auth_cache is None:
            return None
        if self._clock() - self._auth_at >= _COOKIE_TTL_SEC:
            return None
        return self._auth_cache

    async def _fetch_auth(self) -> QZoneAuth:
        try:
            data = await self.actions.call("get_cookies", {"domain": _COOKIE_DOMAIN})
        except ActionError as exc:
            code = exc.retcode if exc.retcode and exc.retcode > 0 else 1401
            raise QZoneError("qzone_auth", "qzone cookie fetch failed", code) from None
        return self._build_auth(data)

    def _build_auth(self, data: Any) -> QZoneAuth:
        bkn: Any = None
        if isinstance(data, Mapping):
            if "cookies" in data:
                raw = data.get("cookies")
                bkn = data.get("bkn")
            else:
                raw = data
                bkn = data.get("bkn")
        else:
            raw = data
        if isinstance(raw, str):
            cookies = parse_cookie_string(raw)
        elif isinstance(raw, Mapping):
            cookies = {str(key): str(value) for key, value in raw.items()
                       if value is not None}
        else:
            raise QZoneError("qzone_auth", "qzone cookies unavailable", 1401)
        uin = normalize_uin(cookies.get("uin") or cookies.get("p_uin") or "")
        if not uin or not self._self_uin or uin != self._self_uin:
            raise QZoneError("qzone_auth", "qzone cookie account mismatch", 1409)
        if bkn:
            gtk = str(bkn)
        else:
            skey = cookies.get("p_skey") or cookies.get("skey") or ""
            gtk = djb2_gtk(skey) if skey else ""
        if not gtk:
            raise QZoneError("qzone_auth", "qzone gtk unavailable", 1401)
        return QZoneAuth(cookies=cookies, gtk=gtk, uin=uin)

    def _ensure_read(self, action: str) -> None:
        if not self.qzone.enabled or self.qzone.mode != "http_sidecar" \
                or not self.qzone.allow_read:
            raise QZoneError(action, "qzone read is disabled", 1403)

    def _ensure_write(self, action: str) -> None:
        if not self.qzone.enabled or self.qzone.mode != "http_sidecar" \
                or not self.qzone.allow_read:
            raise QZoneError(action, "qzone write is disabled", 1403)
        if not self.qzone.allow_send or not self.outbound.enabled:
            raise QZoneError(action, "qzone write is disabled", 1403)

    def _ensure_delete(self, action: str) -> None:
        if not self.qzone.enabled or self.qzone.mode != "http_sidecar" \
                or not self.qzone.allow_delete:
            raise QZoneError(action, "qzone delete is disabled", 1403)
        if not self.outbound.enabled:
            raise QZoneError(action, "qzone delete is disabled", 1403)

    def _acquire(self, bucket: deque[float], limit: int, window: float,
                 action: str, label: str) -> None:
        now = self._clock()
        while bucket and now - bucket[0] >= window:
            bucket.popleft()
        if len(bucket) >= limit:
            raise QZoneError(action, f"qzone {label} rate limit exceeded", 1200)
        bucket.append(now)

    @staticmethod
    def _dry_run(action: str, target: str, tid: str,
                 content_length: int) -> dict[str, Any]:
        return {
            "dry_run": True,
            "action": action,
            "target_qq": target,
            "tid": tid,
            "content_length": content_length,
        }

    @staticmethod
    def _target(value: Any, field: str) -> str:
        if isinstance(value, str):
            text = value.strip()
        elif isinstance(value, int) and not isinstance(value, bool):
            text = str(value)
        else:
            text = ""
        if not text or not text.isdigit():
            raise QZoneError("qzone_input", f"{field} must be digits", 1400)
        return text

    @staticmethod
    def _text(value: Any, field: str) -> str:
        if isinstance(value, str):
            text = value.strip()
        elif isinstance(value, int) and not isinstance(value, bool):
            text = str(value)
        else:
            text = ""
        if not text:
            raise QZoneError("qzone_input", f"{field} is required", 1400)
        return text

    @staticmethod
    def _content(value: Any) -> str:
        if not isinstance(value, str):
            raise QZoneError("qzone_input", "content is required", 1400)
        text = value.strip()
        if not text or len(text) > _MAX_CONTENT:
            raise QZoneError("qzone_input", "content length must be 1..1000", 1400)
        return text

    @staticmethod
    def _limit(value: Any) -> int:
        if isinstance(value, bool) or not isinstance(value, int):
            raise QZoneError("qzone_input", "limit must be an integer", 1400)
        return max(1, min(_MAX_FEEDS, value))

    def _log(self, operation: str, status: str, started: float,
             count: int | None = None) -> None:
        duration = (time.monotonic() - started) * 1000.0
        if count is None:
            self._logger.info(
                "qzone operation=%s status=%s duration_ms=%.1f",
                operation, status, duration,
            )
        else:
            self._logger.info(
                "qzone operation=%s status=%s duration_ms=%.1f count=%d",
                operation, status, duration, count,
            )
