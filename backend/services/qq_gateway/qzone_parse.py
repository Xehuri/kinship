from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from typing import Any

_TZ = timezone(timedelta(hours=8))

_LOOSE_CODE_RE = re.compile(
    r"""(?<![A-Za-z0-9_])["']?code["']?\s*[:=]\s*"""
    r"""(?:"(-?\d+)"|'(-?\d+)'|(-?\d+)(?![\d.]))"""
)
_LOOSE_SUBCODE_RE = re.compile(
    r"""(?<![A-Za-z0-9_])["']?subcode["']?\s*[:=]\s*"""
    r"""(?:"(-?\d+)"|'(-?\d+)'|(-?\d+)(?![\d.]))"""
)
_LOOSE_MESSAGE_RE = re.compile(
    r"""(?<![A-Za-z0-9_])["']?(?:message|msg)["']?\s*[:=]\s*"""
    r"""(?:"([^"]*)"|'([^']*)')"""
)


def parse_cookie_string(raw: str) -> dict[str, str]:
    """Parse a semicolon-separated cookie string into a dict."""
    result: dict[str, str] = {}
    if not raw:
        return result
    for part in raw.split(";"):
        piece = part.strip()
        if not piece or "=" not in piece:
            continue
        key, value = piece.split("=", 1)
        key = key.strip()
        if not key:
            continue
        result[key] = value.strip()
    return result


def normalize_uin(value: str) -> str:
    """Strip leading ``o``/``0`` characters from a QZone uin."""
    text = "" if value is None else str(value)
    return text.lstrip("o0")


def djb2_gtk(skey: str) -> str:
    """Compute the QZone gtk hash for a skey."""
    h = 5381
    for char in str(skey):
        h += (h << 5) + ord(char)
    return str(h & 0x7FFFFFFF)


def parse_jsonp(text: str) -> dict[str, Any]:
    """Parse raw JSON or a JSONP callback wrapper into a dict."""
    body = text.strip() if isinstance(text, str) else ""
    if not body:
        raise ValueError("empty jsonp payload")
    try:
        value = json.loads(body)
    except (TypeError, ValueError):
        value = None
    else:
        if isinstance(value, dict):
            return value
        raise ValueError("jsonp payload is not an object")
    if body.endswith(";"):
        body = body[:-1].rstrip()
    if not body.endswith(")"):
        raise ValueError("invalid jsonp wrapper")
    start = body.find("(")
    end = body.rfind(")")
    if start < 0 or end <= start:
        raise ValueError("invalid jsonp wrapper")
    inner = body[start + 1:end].strip()
    if not inner:
        raise ValueError("empty jsonp body")
    try:
        value = json.loads(inner)
    except (TypeError, ValueError) as exc:
        raise ValueError("invalid jsonp body") from exc
    if not isinstance(value, dict):
        raise ValueError("jsonp payload is not an object")
    return value


def extract_response_code(text: str) -> int | None:
    """Extract the QZone response code from JSON, JSONP, or a frame callback."""
    payload = _extract_payload(text)
    if payload is None:
        return None
    return _coerce_code(payload.get("code"))


def extract_response_result(text: str) -> tuple[int | None, int | None, str]:
    """Extract ``(code, subcode, message)`` from JSON, JSONP, or a frame callback."""
    payload = _extract_payload(text)
    if payload is None:
        return _extract_loose_result(text)
    message = payload.get("message")
    if message is None:
        message = payload.get("msg")
    return (
        _coerce_code(payload.get("code")),
        _coerce_code(payload.get("subcode")),
        _as_str(message),
    )


def normalize_comment(item: dict[str, Any]) -> dict[str, Any]:
    """Normalize a single QZone comment entry."""
    data = item if isinstance(item, dict) else {}
    created = _created_time(data)
    return {
        "comment_id": _as_str(data.get("tid")),
        "uin": _as_str(data.get("uin")),
        "nick": _as_str(_nick_value(data)),
        "content": _as_str(data.get("content")),
        "created_time": created,
        "created_at": _render_time(created),
        "parent_id": None,
        "replies": [],
    }


def normalize_comments(msg: dict[str, Any]) -> list[dict[str, Any]]:
    """Flatten ``commentlist`` so replies follow their parent comment."""
    data = msg if isinstance(msg, dict) else {}
    raw_items = data.get("commentlist")
    if not isinstance(raw_items, list):
        return []
    flat: list[dict[str, Any]] = []
    for raw in raw_items:
        if not isinstance(raw, dict):
            continue
        parent = normalize_comment(raw)
        replies: list[dict[str, Any]] = []
        raw_replies = raw.get("list_3")
        if isinstance(raw_replies, list):
            for raw_reply in raw_replies:
                if not isinstance(raw_reply, dict):
                    continue
                reply = normalize_comment(raw_reply)
                reply["parent_id"] = parent["comment_id"] or ""
                replies.append(reply)
        parent["replies"] = replies
        flat.append(parent)
        flat.extend(replies)
    return flat


def normalize_feed(msg: dict[str, Any]) -> dict[str, Any]:
    """Normalize a QZone feed entry into the gateway schema."""
    data = msg if isinstance(msg, dict) else {}
    created = _created_time(data)
    return {
        "tid": _as_str(data.get("tid")),
        "created_time": created,
        "created_at": _render_time(created),
        "content": _as_str(data.get("content")),
        "images": _image_urls(data.get("pic")),
        "videos": _video_urls(data.get("video")),
        "repost": _repost_content(data.get("rt_con")),
        "comment_count": _as_int(data.get("cmtnum", data.get("comment_count"))),
        "has_more_comments": _as_bool(data.get("has_more_con")),
        "comments": normalize_comments(data),
        "uin": _as_str(data.get("uin")),
    }


def normalize_feeds(payload: dict[str, Any], limit: int | None = None) -> list[dict[str, Any]]:
    """Normalize a QZone ``msglist`` payload, skipping malformed entries."""
    data = payload if isinstance(payload, dict) else {}
    raw_items = data.get("msglist")
    if not isinstance(raw_items, list):
        return []
    feeds: list[dict[str, Any]] = []
    for raw in raw_items:
        if limit is not None and len(feeds) >= limit:
            break
        if not isinstance(raw, dict):
            continue
        try:
            feed = normalize_feed(raw)
        except Exception:
            continue
        if not feed["tid"] and not feed["content"]:
            continue
        feeds.append(feed)
    return feeds


def _extract_payload(text: str) -> dict[str, Any] | None:
    try:
        payload = parse_jsonp(text)
    except ValueError:
        payload = _extract_frame_payload(text)
    return payload if isinstance(payload, dict) else None


def _extract_frame_payload(text: str) -> dict[str, Any] | None:
    source = text if isinstance(text, str) else ""
    marker = "frameElement.callback"
    marker_index = source.find(marker)
    if marker_index < 0:
        return None
    open_index = source.find("(", marker_index + len(marker))
    if open_index < 0:
        return None
    start = source.find("{", open_index + 1)
    if start < 0:
        return None
    depth = 0
    quote = ""
    escaped = False
    in_string = False
    for position in range(start, len(source)):
        char = source[position]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                in_string = False
            continue
        if char in ('"', "'"):
            in_string = True
            quote = char
            continue
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                try:
                    value = json.loads(source[start:position + 1])
                except (TypeError, ValueError):
                    return None
                return value if isinstance(value, dict) else None
    return None


def _extract_loose_result(text: str) -> tuple[int | None, int | None, str]:
    """Regex-extract code/subcode/message from a non-strict JS object literal."""
    source = text if isinstance(text, str) else ""
    code = _loose_int(_LOOSE_CODE_RE.search(source))
    if code is None:
        return None, None, ""
    subcode = _loose_int(_LOOSE_SUBCODE_RE.search(source))
    message_match = _LOOSE_MESSAGE_RE.search(source)
    message = ""
    if message_match is not None:
        value = message_match.group(1)
        if value is None:
            value = message_match.group(2)
        message = value or ""
    return code, subcode, message


def _loose_int(match: re.Match[str] | None) -> int | None:
    if match is None:
        return None
    for group in match.groups():
        if group is not None:
            return int(group, 10)
    return None


def _coerce_code(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        try:
            return int(value.strip(), 10)
        except ValueError:
            return None
    return None


def _nick_value(item: dict[str, Any]) -> Any:
    for key in ("name", "nickname", "nick"):
        value = item.get(key)
        if value:
            return value
    return None


def _created_time(item: dict[str, Any]) -> Any:
    for key in ("created_time", "createTime", "createtime", "time"):
        if item.get(key) is not None:
            return item[key]
    return None


def _render_time(value: Any) -> str:
    try:
        moment = datetime.fromtimestamp(int(value), _TZ)
    except (TypeError, ValueError, OverflowError, OSError):
        return ""
    return moment.strftime("%Y-%m-%dT%H:%M:%S+08:00")


def _as_str(value: Any) -> str:
    if value is None:
        return ""
    return str(value)


def _as_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _as_bool(value: Any) -> bool:
    if isinstance(value, str):
        return value.strip().lower() not in ("", "0", "false", "none")
    return bool(value)


def _image_urls(pics: Any) -> list[str]:
    entries = pics if isinstance(pics, list) else [pics]
    seen: set[str] = set()
    urls: list[str] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        for key in ("url1", "url2", "url3", "smallurl", "pic_id"):
            url = _as_str(entry.get(key)).strip()
            if url and url not in seen:
                seen.add(url)
                urls.append(url)
                break
    return urls


def _video_urls(videos: Any) -> list[str]:
    entries = videos if isinstance(videos, list) else [videos]
    return [url for entry in entries if isinstance(entry, dict)
            for url in (_as_str(entry.get("url3")).strip(),) if url]


def _repost_content(value: Any) -> str | None:
    if isinstance(value, dict):
        value = value.get("content")
    if isinstance(value, str):
        return value.strip() or None
    return None
