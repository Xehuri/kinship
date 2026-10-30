from __future__ import annotations

import logging
import random
import time
from dataclasses import dataclass
from typing import Any

import httpx

from .actions import ActionError
from .qzone_parse import (
    extract_response_result,
    normalize_feeds,
    parse_jsonp,
)

_LIST_URL = (
    "https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6"
)
_WRITE_URL = (
    "https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds"
)
_LIKE_URL = (
    "https://user.qzone.qq.com/proxy/domain/w.qzone.qq.com/cgi-bin/likes/internal_dolike_app"
)
_DELETE_URL = (
    "https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_delcomment_ugc"
)
_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
_TIMEOUT = httpx.Timeout(connect=5, read=15, write=10, pool=5)


class QZoneError(ActionError):
    """A QZone request failed with a determinate outcome."""


class QZoneIndeterminateError(QZoneError):
    """A QZone write may have been applied, but its outcome is unknown."""


@dataclass(frozen=True)
class QZoneAuth:
    cookies: dict[str, str]
    gtk: str
    uin: str


class QZoneClient:
    def __init__(
        self,
        transport: httpx.AsyncBaseTransport | None = None,
        logger: logging.Logger | None = None,
    ) -> None:
        self._transport = transport
        self._logger = logger or logging.getLogger(__name__)
        self._client: httpx.AsyncClient | None = None

    async def list_feeds(self, auth: QZoneAuth, target_qq: str,
                         limit: int = 10) -> list[dict]:
        action = "list_feeds"
        self._check_auth(action, auth)
        target = self._text(action, target_qq, "target_qq")
        if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1:
            raise QZoneError(action, "limit must be a positive integer", 1400)
        params = {
            "g_tk": auth.gtk, "uin": target, "ftype": "0", "sort": "0", "pos": "0",
            "num": str(limit), "replynum": "100", "callback": "_preloadCallback",
            "code_version": "1", "format": "jsonp", "need_comment": "1",
            "need_private_comment": "1",
        }
        response, started = await self._get(action, _LIST_URL, params, target, auth)
        self._check_status(action, started, response.status_code)
        try:
            payload = parse_jsonp(response.text)
        except ValueError:
            self._log(action, started, "parse_error")
            raise QZoneError(action, "invalid response payload", 1402) from None
        if not _is_zero(payload.get("code")):
            self._log(action, started, "business_error")
            raise QZoneError(action, "unexpected response code", 1402)
        feeds = normalize_feeds(payload, limit)
        self._log(action, started, response.status_code, len(feeds))
        return feeds

    async def comment(self, auth: QZoneAuth, target_qq: str, tid: str,
                      content: str) -> dict:
        return await self._write_comment("comment", auth, target_qq, tid, content, {})

    async def reply(self, auth: QZoneAuth, target_qq: str, tid: str,
                    comment_id: str, content: str, comment_uin: str,
                    comment_nick: str = "") -> dict:
        action = "reply"
        body = self._text(action, content, "content", strip=False)
        parent_uin = self._text(action, comment_uin, "comment_uin")
        extra = {
            "commentId": self._text(action, comment_id, "comment_id"),
            "commentUin": parent_uin,
            "richtype": "",
            "richval": "",
            "paramstr": "1",
        }
        nick = _sanitize_nick(comment_nick)
        rendered = f"@{{uin:{parent_uin},nick:{nick},auto:1}}{body}"
        return await self._write_comment(action, auth, target_qq, tid, body, extra, rendered)

    async def delete_comment(self, auth: QZoneAuth, target_qq: str, tid: str,
                             comment_id: str, comment_uin: str | None = None) -> dict:
        action = "delete_comment"
        self._check_auth(action, auth)
        target = self._text(action, target_qq, "target_qq")
        topic_tid = self._text(action, tid, "tid")
        comment = self._text(action, comment_id, "comment_id")
        parent_uin = auth.uin
        if comment_uin is not None and str(comment_uin).strip():
            parent_uin = self._text(action, comment_uin, "comment_uin")
        form = {
            "g_tk": auth.gtk,
            "inCharset": "utf-8",
            "outCharset": "utf-8",
            "plat": "qzone",
            "source": "ic",
            "hostUin": target,
            "uin": auth.uin,
            "topicId": f"{target}_{topic_tid}__1",
            "feedsType": "100",
            "commentId": comment,
            "commentUin": parent_uin,
            "format": "fs",
            "ref": "feeds",
            "paramstr": "1",
            "qzreferrer": f"https://user.qzone.qq.com/{auth.uin}/infocenter?via=toolbar",
            "rand": str(int(time.time() * 1000) + random.randint(100, 999)),
        }
        response, started = await self._post(action, form, target, auth)
        self._check_status(action, started, response.status_code)
        self._check_write_code(action, started, response.text)
        self._log(action, started, response.status_code, 1)
        return {
            "success": True,
            "target_qq": target,
            "tid": topic_tid,
            "comment_id": comment,
            "comment_uin": parent_uin,
            "code": 0,
        }

    async def like(self, auth: QZoneAuth, target_qq: str, tid: str) -> dict:
        action = "like"
        self._check_auth(action, auth)
        target = self._text(action, target_qq, "target_qq")
        topic_tid = self._text(action, tid, "tid")
        mood_url = f"http://user.qzone.qq.com/{target}/mood/{topic_tid}"
        form = {
            "qzreferrer": f"https://user.qzone.qq.com/{auth.uin}",
            "opuin": auth.uin,
            "unikey": mood_url,
            "curkey": mood_url,
            "appid": "311",
            "from": "1",
            "typeid": "0",
            "abstime": str(int(time.time())),
            "fid": topic_tid,
            "active": "0",
            "format": "json",
            "fupdate": "1",
        }
        response, started = await self._post(action, form, target, auth)
        self._check_status(action, started, response.status_code)
        self._check_write_code(action, started, response.text)
        self._log(action, started, response.status_code, 1)
        return {"success": True, "tid": topic_tid, "target_qq": target}

    async def close(self) -> None:
        client, self._client = self._client, None
        if client is not None:
            await client.aclose()

    async def _write_comment(self, action: str, auth: QZoneAuth, target_qq: str,
                             tid: str, content: str, extra: dict[str, str],
                             rendered: str | None = None) -> dict:
        self._check_auth(action, auth)
        target = self._text(action, target_qq, "target_qq")
        topic_tid = self._text(action, tid, "tid")
        body = self._text(action, content, "content", strip=False)
        form = {
            "topicId": f"{target}_{topic_tid}__1",
            "uin": auth.uin,
            "hostUin": target,
            "feedsType": "100",
            "inCharset": "utf-8",
            "outCharset": "utf-8",
            "plat": "qzone",
            "source": "ic",
            "platformid": "52",
            "format": "json",
            "ref": "feeds",
            "content": rendered if rendered is not None else body,
        }
        form.update(extra)
        response, started = await self._post(action, form, target, auth)
        self._check_status(action, started, response.status_code)
        self._check_write_code(action, started, response.text)
        self._log(action, started, response.status_code, 1)
        return {
            "success": True,
            "tid": topic_tid,
            "target_qq": target,
            "content_length": len(body),
            "code": 0,
        }

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                transport=self._transport,
                timeout=_TIMEOUT,
                follow_redirects=False,
                trust_env=False,
            )
        return self._client

    async def _get(self, action: str, url: str, params: dict[str, str],
                   target: str, auth: QZoneAuth) -> tuple[httpx.Response, float]:
        started = time.monotonic()
        try:
            response = await self._http().get(
                url, params=params, headers=_headers(target), cookies=auth.cookies
            )
        except httpx.TimeoutException:
            self._log(action, started, "timeout")
            raise QZoneError(action, "request timed out", 0) from None
        except httpx.RequestError:
            self._log(action, started, "transport_error")
            raise QZoneError(action, "transport error", 0) from None
        return response, started

    async def _post(self, action: str, form: dict[str, str], target: str,
                    auth: QZoneAuth) -> tuple[httpx.Response, float]:
        url = _WRITE_URL
        if action == "like":
            url = _LIKE_URL
        elif action == "delete_comment":
            url = _DELETE_URL
        started = time.monotonic()
        try:
            response = await self._http().post(
                url,
                params={"g_tk": auth.gtk},
                data=form,
                headers=_headers(target),
                cookies=auth.cookies,
            )
        except httpx.TimeoutException:
            self._log(action, started, "timeout")
            raise QZoneIndeterminateError(action, "write timed out", 0) from None
        except httpx.RequestError:
            self._log(action, started, "transport_error")
            raise QZoneError(action, "transport error", 0) from None
        return response, started

    def _check_status(self, action: str, started: float, status: int) -> None:
        if 200 <= status < 300:
            return
        self._log(action, started, status)
        if 300 <= status < 400 or status == 401:
            raise QZoneError(action, "login or cookie rejected", 1401)
        if status == 429:
            raise QZoneError(action, "rate limited", 1200)
        raise QZoneError(action, f"http status {status}", 1402)

    def _check_write_code(self, action: str, started: float, text: str) -> None:
        code, subcode, _message = extract_response_result(text)
        if code == 0 and subcode in (None, 0):
            return
        self._log(action, started, f"business_error code={code} subcode={subcode}")
        raise QZoneError(action, "unexpected response code", 1402)

    def _check_auth(self, action: str, auth: QZoneAuth) -> None:
        if not isinstance(auth, QZoneAuth) or not auth.cookies or not auth.gtk or not auth.uin:
            raise QZoneError(action, "invalid auth", 1400)

    @staticmethod
    def _text(action: str, value: str, field: str, *, strip: bool = True) -> str:
        if not isinstance(value, str) or not value.strip():
            raise QZoneError(action, f"{field} is required", 1400)
        return value.strip() if strip else value

    def _log(self, action: str, started: float, status: object,
             count: int | None = None) -> None:
        duration = (time.monotonic() - started) * 1000.0
        if count is None:
            self._logger.warning(
                "qzone %s status=%s duration_ms=%.1f", action, status, duration,
            )
        else:
            self._logger.info(
                "qzone %s status=%s duration_ms=%.1f count=%d",
                action, status, duration, count,
            )


def _headers(target_qq: str) -> dict[str, str]:
    return {
        "User-Agent": _USER_AGENT,
        "Referer": f"https://user.qzone.qq.com/{target_qq}",
        "Origin": "https://user.qzone.qq.com",
        "Accept": "*/*",
    }


def _sanitize_nick(nick: str) -> str:
    text = nick if isinstance(nick, str) else ""
    return text.replace("{", "").replace("}", "").replace("\n", "").replace("\r", "")


def _is_zero(value: Any) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, (int, float)):
        return value == 0
    if isinstance(value, str):
        return value.strip() == "0"
    return False
