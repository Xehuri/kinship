"""QQ gateway client library.

Loom's QQ tool surface migrated to the `qq` CLI (ai/skills/qq-cli). The FastMCP
object and tool decorators are retained only for the legacy contract test; this
module is no longer registered as an MCP server.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any, Optional

import httpx
from mcp.server.fastmcp import FastMCP
from pydantic import BaseModel, ConfigDict, Field, field_validator

from services.qq_gateway.render import render_segments as _render_segments


class MessageType(str, Enum):
    PRIVATE = "private"
    GROUP = "group"


class ResponseFormat(str, Enum):
    MARKDOWN = "markdown"
    JSON = "json"


class SendMessageInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, validate_assignment=True)
    message_type: MessageType
    target_id: str = Field(..., min_length=5, max_length=20)
    auto_escape: bool = False
    response_format: ResponseFormat = ResponseFormat.MARKDOWN
    delay_seconds: float = Field(default=0.0, ge=0.0, le=10.0)
    message: str = Field(..., min_length=1)


class GetFriendsInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    use_cache: bool = True
    response_format: ResponseFormat = ResponseFormat.MARKDOWN


class SearchFriendInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    name: str = Field(..., min_length=1, max_length=50)
    exact_match: bool = False
    use_cache: bool = True
    response_format: ResponseFormat = ResponseFormat.MARKDOWN


class SendFileInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, validate_assignment=True)
    message_type: MessageType
    target_id: str
    file_path: str
    custom_name: Optional[str] = None
    use_base64: bool = True
    response_format: ResponseFormat = ResponseFormat.MARKDOWN

    @field_validator("file_path")
    @classmethod
    def validate_file_path(cls, value: str) -> str:
        if not os.path.exists(value):
            raise ValueError(f"File not found: {value}")
        return value


class GetGroupMsgHistoryInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    group_id: str = Field(..., min_length=5, max_length=20)
    message_seq: Optional[str] = None
    count: int = Field(default=20, ge=1, le=100)
    reverse_order: bool = False
    unread_only: bool = Field(
        default=False,
        description="Only return messages newer than the stored per-chat read watermark.",
    )
    mark_read: bool = Field(
        default=False,
        description="Advance the per-chat read watermark to the newest returned message.",
    )
    count_only: bool = Field(
        default=False,
        description="Return only the number of matching messages, without message bodies.",
    )
    since_minutes: Optional[int] = Field(
        default=None,
        ge=1,
        le=10080,
        description="Only return messages from the last N minutes.",
    )
    compact: bool = Field(
        default=False,
        description="Return a one-line-per-message digest instead of the full NapCat JSON.",
    )
    response_format: ResponseFormat = ResponseFormat.MARKDOWN


class GetLoginInfoInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    response_format: ResponseFormat = ResponseFormat.MARKDOWN


class SendPokeInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    user_id: str = Field(..., min_length=5, max_length=20)
    group_id: Optional[str] = None
    response_format: ResponseFormat = ResponseFormat.MARKDOWN


class GetFileInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    file_id: Optional[str] = None
    file: Optional[str] = None
    user_id: Optional[str] = None
    response_format: ResponseFormat = ResponseFormat.MARKDOWN


class GetForwardMsgInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    message_id: str
    response_format: ResponseFormat = ResponseFormat.MARKDOWN


class EmojiLikeInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    message_id: str
    emoji_id: str
    set: bool = True
    response_format: ResponseFormat = ResponseFormat.MARKDOWN


class GetMsgInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    message_id: str
    response_format: ResponseFormat = ResponseFormat.MARKDOWN


class FriendMsgHistoryInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    user_id: str
    count: int = Field(default=50, ge=1, le=100)
    unread_only: bool = Field(
        default=False,
        description="Only return messages newer than the stored per-chat read watermark.",
    )
    mark_read: bool = Field(
        default=False,
        description="Advance the per-chat read watermark to the newest returned message.",
    )
    count_only: bool = Field(
        default=False,
        description="Return only the number of matching messages, without message bodies.",
    )
    since_minutes: Optional[int] = Field(
        default=None,
        ge=1,
        le=10080,
        description="Only return messages from the last N minutes.",
    )
    compact: bool = Field(
        default=False,
        description="Return a one-line-per-message digest instead of the full NapCat JSON.",
    )
    response_format: ResponseFormat = ResponseFormat.MARKDOWN


class ListStickersInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    count: int = Field(default=48, ge=1, le=200)
    response_format: ResponseFormat = ResponseFormat.MARKDOWN


class SendStickerInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    message_type: MessageType
    target_id: str = Field(..., min_length=5, max_length=20)
    res_id: Optional[str] = None
    source_message_id: Optional[str] = None
    file_path: Optional[str] = None
    response_format: ResponseFormat = ResponseFormat.MARKDOWN


class SaveStickerInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    source_message_id: Optional[str] = None
    file_path: Optional[str] = None
    url: Optional[str] = None
    is_mark_face: bool = False
    note: str = ""
    usage: str = ""
    response_format: ResponseFormat = ResponseFormat.MARKDOWN


class UpdateStickerInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    res_id: str
    note: Optional[str] = None
    usage: Optional[str] = None
    response_format: ResponseFormat = ResponseFormat.MARKDOWN


class DeleteStickerInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    res_id: str
    response_format: ResponseFormat = ResponseFormat.MARKDOWN


class GetQZoneFeedsInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    target_qq: str = Field(..., pattern=r"^\d{5,20}$")
    limit: int = Field(default=10, ge=1, le=20)
    response_format: ResponseFormat = ResponseFormat.MARKDOWN


class GetQZoneCommentsInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    target_qq: str = Field(..., pattern=r"^\d{5,20}$")
    tid: str = Field(..., min_length=1, max_length=64)
    scan: int = Field(default=10, ge=1, le=20)
    response_format: ResponseFormat = ResponseFormat.MARKDOWN


class CommentQZoneInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    target_qq: str = Field(..., pattern=r"^\d{5,20}$")
    tid: str = Field(..., min_length=1, max_length=64)
    content: str = Field(..., min_length=1, max_length=1000)
    response_format: ResponseFormat = ResponseFormat.MARKDOWN


class ReplyQZoneCommentInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    target_qq: str = Field(..., pattern=r"^\d{5,20}$")
    tid: str = Field(..., min_length=1, max_length=64)
    comment_id: str = Field(..., min_length=1, max_length=64)
    content: str = Field(..., min_length=1, max_length=1000)
    comment_uin: Optional[str] = Field(default=None, pattern=r"^\d{5,20}$")
    comment_nick: Optional[str] = Field(default=None, max_length=100)
    response_format: ResponseFormat = ResponseFormat.MARKDOWN


class DeleteQZoneCommentInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    target_qq: str = Field(..., pattern=r"^\d{5,20}$")
    tid: str = Field(..., min_length=1, max_length=64)
    comment_id: str = Field(..., min_length=1, max_length=64)
    comment_uin: Optional[str] = Field(default=None, pattern=r"^\d{5,20}$")
    response_format: ResponseFormat = ResponseFormat.MARKDOWN


class LikeQZoneInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    target_qq: str = Field(..., pattern=r"^\d{5,20}$")
    tid: str = Field(..., min_length=1, max_length=64)
    response_format: ResponseFormat = ResponseFormat.MARKDOWN


class GatewayError(RuntimeError):
    def __init__(self, message: str, retcode: int = -1) -> None:
        super().__init__(message)
        self.retcode = retcode


def _token() -> str:
    token = os.environ.get("QQ_GATEWAY_MCP_TOKEN", "")
    if token:
        return token.strip()
    path = os.environ.get("QQ_GATEWAY_MCP_TOKEN_FILE", "")
    if path:
        try:
            return Path(path).read_text(encoding="utf-8").strip()
        except OSError:
            return ""
    return ""


class GatewayClient:
    def __init__(self) -> None:
        self.base_url = os.environ.get("QQ_GATEWAY_MCP_BASE_URL", "http://127.0.0.1:8770")
        self.timeout = float(os.environ.get("QQ_GATEWAY_MCP_TIMEOUT", "60"))

    async def call(self, action: str, params: Optional[dict[str, Any]] = None,
                   mutating: Optional[bool] = None) -> Any:
        headers = {"Authorization": f"Bearer {_token()}"}
        async with httpx.AsyncClient(base_url=self.base_url, timeout=self.timeout) as client:
            response = await client.post(
                f"/v1/actions/{action}",
                headers=headers,
                json={"params": params or {}, "mutating": mutating},
            )
        return self._decode(response)

    async def get(self, path: str, params: Optional[dict[str, Any]] = None) -> Any:
        headers = {"Authorization": f"Bearer {_token()}"}
        async with httpx.AsyncClient(base_url=self.base_url, timeout=self.timeout) as client:
            response = await client.get(path, headers=headers, params=params)
        return self._decode(response)

    async def post(self, path: str, body: dict[str, Any]) -> Any:
        headers = {"Authorization": f"Bearer {_token()}"}
        async with httpx.AsyncClient(base_url=self.base_url, timeout=self.timeout) as client:
            response = await client.post(path, headers=headers, json=body)
        return self._decode(response)

    @staticmethod
    def _decode(response: httpx.Response) -> Any:
        try:
            payload = response.json()
        except ValueError as exc:
            raise GatewayError(f"gateway returned non-json: {response.text[:200]}") from exc
        if response.status_code == 401:
            raise GatewayError("gateway authentication failed", 401)
        if not payload.get("ok"):
            error = payload.get("error") or {}
            raise GatewayError(error.get("message") or "gateway action failed",
                               int(error.get("retcode") or -1))
        return payload.get("data")


client = GatewayClient()
mcp = FastMCP("qq-mcp")


def _result(data: Any, fmt: ResponseFormat, title: str) -> str:
    if fmt == ResponseFormat.JSON:
        return json.dumps(data, ensure_ascii=False, indent=2)
    return f"# {title}\n\n```json\n{json.dumps(data, ensure_ascii=False, indent=2)}\n```"


_COMPACT_TEXT_LIMIT = 300


def _history_time(value: Any) -> str:
    if not value:
        return "?"
    try:
        return datetime.fromtimestamp(int(value)).strftime("%Y-%m-%d %H:%M:%S")
    except (TypeError, ValueError, OSError):
        return "?"


def _history_name(message: dict[str, Any]) -> str:
    sender = message.get("sender") or {}
    return str(sender.get("card") or sender.get("nickname") or "").strip()


def _history_user_id(message: dict[str, Any]) -> str:
    sender = message.get("sender") or {}
    return str(sender.get("user_id") or message.get("user_id") or "").strip()


def _history_sender(message: dict[str, Any]) -> str:
    name = _history_name(message)
    user_id = _history_user_id(message)
    if name and user_id:
        return name + "(" + user_id + ")"
    return name or user_id or "?"


def _history_text(value: str) -> str:
    text = " ".join(value.split())
    if len(text) > _COMPACT_TEXT_LIMIT:
        return text[:_COMPACT_TEXT_LIMIT] + "…"
    return text


async def _history_body(
    message: dict[str, Any], *, fetch_media: bool = False,
    media_paths: Optional[list[str]] = None,
) -> str:
    segments = message.get("message")
    paths: list[str] = []
    if isinstance(segments, list):
        resolver = None
        if fetch_media:
            message_id = str(
                message.get("message_id") or message.get("message_seq") or ""
            )

            async def resolve_media(segment: dict[str, Any], index: int) -> Optional[str]:
                if not message_id:
                    return None
                try:
                    response = await client.post(
                        "/v1/media",
                        {
                            "segment": segment,
                            "index": index,
                            "message_id": message_id,
                        },
                    )
                except Exception:
                    return None
                if isinstance(response, dict):
                    path = response.get("path")
                    if path:
                        value = str(path)
                        paths.append(value)
                        if media_paths is not None:
                            media_paths.append(value)
                        return value
                return None

            resolver = resolve_media
        try:
            text = await _render_segments(segments, media=resolver)
        except Exception:
            text = str(message.get("raw_message") or "")
    else:
        text = str(segments or message.get("raw_message") or "")
    if paths:
        unique_paths = list(dict.fromkeys(paths))
        for path in unique_paths:
            text = text.replace(" " + path, "")
        return _history_text(text) + " " + " ".join(unique_paths)
    return _history_text(text)


async def _compact_history(
    data: Any, fmt: ResponseFormat, title: str, meta: str,
    *, fetch_media: bool = False,
) -> str:
    messages = data.get("messages") if isinstance(data, dict) else data
    if not isinstance(messages, list):
        return _result(data, fmt, title)
    items = [message for message in messages if isinstance(message, dict)]
    if fmt == ResponseFormat.JSON:
        rows = []
        for message in items:
            media_paths: list[str] = []
            row: dict[str, Any] = {
                "time": _history_time(message.get("time")),
                "message_id": str(
                    message.get("message_id") or message.get("message_seq") or ""
                ),
                "sender": _history_name(message) or _history_user_id(message) or "?",
                "user_id": _history_user_id(message),
                "text": await _history_body(
                    message, fetch_media=fetch_media, media_paths=media_paths
                ),
            }
            if media_paths:
                row["media"] = media_paths
            rows.append(row)
        return json.dumps(
            {"count": len(rows), "messages": rows}, ensure_ascii=False, indent=2
        )
    lines = []
    for message in items:
        prefix = "[" + _history_time(message.get("time")) + "] " + _history_sender(message)
        message_id = str(
            message.get("message_id") or message.get("message_seq") or ""
        ).strip()
        if message_id:
            prefix += " id=" + message_id
        if message.get("post_type") == "message_sent":
            prefix += " [我]"
        lines.append(
            prefix
            + ": "
            + (await _history_body(message, fetch_media=fetch_media) or "(empty)")
        )
    header = "# " + title
    if meta:
        header += "\n" + meta
    header += "\ncount=" + str(len(lines))
    return header + "\n\n" + ("\n".join(lines) if lines else "(empty)")


def _message_time(message: dict[str, Any]) -> int:
    try:
        return int(message.get("time") or 0)
    except (TypeError, ValueError):
        return 0


async def _read_watermark(chat_type: str, target: str) -> dict[str, Any]:
    try:
        data = await client.get("/v1/read-state", {"chat_type": chat_type, "target": target})
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}
    return {
        "time": data.get("last_time") or 0,
        "message_id": str(data.get("last_message_id") or ""),
    }


async def _write_watermark(chat_type: str, target: str, message: dict[str, Any]) -> None:
    body = {
        "chat_type": chat_type,
        "target": target,
        "last_time": _message_time(message),
        "last_message_id": str(message.get("message_id") or message.get("message_seq") or ""),
    }
    await client.post("/v1/read-state", body)


def _filter_history_messages(
    messages: list[Any],
    *,
    unread_only: bool,
    since_minutes: Optional[int],
    watermark: dict[str, Any],
) -> list[dict[str, Any]]:
    items = [message for message in messages if isinstance(message, dict)]
    if unread_only and watermark:
        floor = int(watermark.get("time") or 0)
        items = [message for message in items if _message_time(message) > floor]
    if since_minutes:
        cutoff = int(time.time()) - since_minutes * 60
        items = [message for message in items if _message_time(message) >= cutoff]
    return items


def _count_only_response(
    fmt: ResponseFormat,
    title: str,
    meta: str,
    count: int,
    watermark: Optional[dict[str, Any]],
) -> str:
    payload: dict[str, Any] = {"count": count}
    if watermark:
        payload["watermark"] = watermark
    if fmt == ResponseFormat.JSON:
        return json.dumps(payload, ensure_ascii=False, indent=2)
    lines = ["# " + title]
    if meta:
        lines.append(meta)
    lines.append("count=" + str(count))
    if watermark:
        lines.append("watermark=" + str(watermark.get("time") or 0))
    return "\n".join(lines)


async def _history_response(
    data: Any, params: Any, *, chat_type: str, target: str, title: str, meta: str
) -> str:
    if not (params.unread_only or params.since_minutes or params.mark_read or params.count_only):
        if params.compact:
            return await _compact_history(data, params.response_format, title, meta)
        return _result(data, params.response_format, title)
    messages = data.get("messages") if isinstance(data, dict) else data
    if not isinstance(messages, list):
        return _result(data, params.response_format, title)
    watermark = await _read_watermark(chat_type, target) if params.unread_only else {}
    items = _filter_history_messages(
        messages,
        unread_only=params.unread_only,
        since_minutes=params.since_minutes,
        watermark=watermark,
    )
    if params.mark_read and items:
        await _write_watermark(chat_type, target, max(items, key=_message_time))
        watermark = await _read_watermark(chat_type, target)
    if params.count_only:
        return _count_only_response(
            params.response_format,
            title,
            meta,
            len(items),
            watermark if params.unread_only else None,
        )
    filtered: dict[str, Any] = {"messages": items}
    if isinstance(data, dict):
        filtered = dict(data)
        filtered["messages"] = items
    if params.compact:
        return await _compact_history(
            filtered,
            params.response_format,
            title,
            meta,
            fetch_media=bool(getattr(params, "unread_only", False)),
        )
    return _result(filtered, params.response_format, title)


def _format_sticker_list(items: Any) -> str:
    if not isinstance(items, list):
        return str(items)
    if not items:
        return "收藏表情：0 个"
    lines = [f"收藏表情：{len(items)} 个"]
    for index, item in enumerate(items, 1):
        if not isinstance(item, dict):
            continue
        note = item.get("note") or item.get("name") or "-"
        usage = item.get("usage") or "-"
        lines.append(
            f"{index}. res_id={item.get('res_id', '')} | 备注={note} | 用法={usage}"
        )
    return "\n".join(lines)


@mcp.tool(name="qq_send_message")
async def qq_send_message(params: SendMessageInput) -> str:
    if params.delay_seconds > 0:
        await asyncio.sleep(params.delay_seconds)
    message: Any = params.message
    try:
        parsed = json.loads(params.message)
        if isinstance(parsed, list):
            message = parsed
    except (json.JSONDecodeError, TypeError):
        pass
    if params.message_type == MessageType.PRIVATE:
        data = await client.call("send_private_msg", {
            "user_id": params.target_id, "message": message, "auto_escape": params.auto_escape,
        }, mutating=True)
    else:
        data = await client.call("send_group_msg", {
            "group_id": params.target_id, "message": message, "auto_escape": params.auto_escape,
        }, mutating=True)
    return _result({"success": True, "target": params.target_id, "response": data},
                   params.response_format, "QQ Message Sent")


@mcp.tool(name="qq_get_friends")
async def qq_get_friends(params: GetFriendsInput) -> str:
    data = await client.call("get_friend_list", {})
    return _result(data, params.response_format, "QQ Friends")


@mcp.tool(name="qq_search_friend")
async def qq_search_friend(params: SearchFriendInput) -> str:
    data = await client.call("get_friend_list", {})
    friends = data if isinstance(data, list) else []
    needle = params.name.lower()
    matches = []
    for friend in friends:
        if not isinstance(friend, dict):
            continue
        names = [str(friend.get("nickname") or ""), str(friend.get("remark") or "")]
        hit = any((name.lower() == needle) if params.exact_match else (needle in name.lower())
                  for name in names)
        if hit:
            matches.append(friend)
    return _result(matches, params.response_format, "QQ Friend Search")


@mcp.tool(name="qq_send_file")
async def qq_send_file(params: SendFileInput) -> str:
    name = params.custom_name or Path(params.file_path).name
    if params.message_type == MessageType.GROUP:
        data = await client.call("upload_group_file", {
            "group_id": params.target_id, "file": params.file_path, "name": name,
        }, mutating=True)
    else:
        data = await client.call("upload_private_file", {
            "user_id": params.target_id, "file": params.file_path, "name": name,
        }, mutating=True)
    return _result(data, params.response_format, "QQ File Sent")


@mcp.tool(name="qq_get_group_msg_history")
async def qq_get_group_msg_history(params: GetGroupMsgHistoryInput) -> str:
    body: dict[str, Any] = {"group_id": params.group_id, "count": params.count}
    if params.message_seq:
        body["message_seq"] = params.message_seq
    if params.reverse_order:
        body["reverse_order"] = True
    if params.compact:
        body["parse_mult_msg"] = False
        body["disable_get_url"] = True
    data = await client.call("get_group_msg_history", body)
    return await _history_response(
        data,
        params,
        chat_type="group",
        target=params.group_id,
        title="QQ Group History",
        meta="group_id=" + params.group_id,
    )


@mcp.tool(name="qq_get_login_info")
async def qq_get_login_info(params: GetLoginInfoInput) -> str:
    data = await client.call("get_login_info", {})
    return _result(data, params.response_format, "QQ Login Info")


@mcp.tool(name="qq_send_poke")
async def qq_send_poke(params: SendPokeInput) -> str:
    body: dict[str, Any] = {"user_id": params.user_id}
    if params.group_id:
        body["group_id"] = params.group_id
    data = await client.call("send_poke", body, mutating=True)
    return _result(data, params.response_format, "QQ Poke Sent")


@mcp.tool(name="qq_get_file")
async def qq_get_file(params: GetFileInput) -> str:
    body = {key: value for key, value in {
        "file_id": params.file_id, "file": params.file,
    }.items() if value}
    data = await client.call("get_file", body)
    return _result(data, params.response_format, "QQ File")


@mcp.tool(name="qq_get_forward_msg")
async def qq_get_forward_msg(params: GetForwardMsgInput) -> str:
    data = await client.call("get_forward_msg", {"message_id": params.message_id})
    return _result(data, params.response_format, "QQ Forward")


@mcp.tool(name="qq_set_msg_emoji_like")
async def qq_set_msg_emoji_like(params: EmojiLikeInput) -> str:
    data = await client.call("set_msg_emoji_like", {
        "message_id": params.message_id, "emoji_id": params.emoji_id, "set": params.set,
    }, mutating=True)
    return _result(data, params.response_format, "QQ Emoji Like")


@mcp.tool(name="qq_get_msg")
async def qq_get_msg(params: GetMsgInput) -> str:
    data = await client.call("get_msg", {"message_id": params.message_id})
    return _result(data, params.response_format, "QQ Message")


@mcp.tool(name="qq_get_friend_msg_history")
async def qq_get_friend_msg_history(params: FriendMsgHistoryInput) -> str:
    body: dict[str, Any] = {"user_id": params.user_id, "count": params.count}
    if params.compact:
        body["parse_mult_msg"] = False
        body["disable_get_url"] = True
    data = await client.call("get_friend_msg_history", body)
    return await _history_response(
        data,
        params,
        chat_type="friend",
        target=params.user_id,
        title="QQ Friend History",
        meta="user_id=" + params.user_id,
    )


@mcp.tool(name="qq_list_stickers")
async def qq_list_stickers(params: ListStickersInput) -> str:
    data = await client.get("/v1/stickers", {"count": params.count})
    if params.response_format == ResponseFormat.JSON:
        return json.dumps(data, ensure_ascii=False, indent=2)
    return _format_sticker_list(data)


@mcp.tool(name="qq_send_sticker")
async def qq_send_sticker(params: SendStickerInput) -> str:
    body = {
        "message_type": params.message_type.value,
        "target_id": params.target_id,
        "res_id": params.res_id,
        "source_message_id": params.source_message_id,
        "file_path": params.file_path,
    }
    data = await client.post("/v1/stickers/send", body)
    return _result(data, params.response_format, "QQ Sticker Sent")


@mcp.tool(name="qq_save_sticker")
async def qq_save_sticker(params: SaveStickerInput) -> str:
    body = {
        "source_message_id": params.source_message_id,
        "file_path": params.file_path,
        "url": params.url,
        "is_mark_face": params.is_mark_face,
        "note": params.note,
        "usage": params.usage,
    }
    data = await client.post("/v1/stickers/save", body)
    return _result(data, params.response_format, "QQ Sticker Saved")


@mcp.tool(name="qq_update_sticker")
async def qq_update_sticker(params: UpdateStickerInput) -> str:
    data = await client.post("/v1/stickers/update", {
        "res_id": params.res_id,
        "note": params.note,
        "usage": params.usage,
    })
    return _result(data, params.response_format, "QQ Sticker Updated")


@mcp.tool(name="qq_delete_sticker")
async def qq_delete_sticker(params: DeleteStickerInput) -> str:
    data = await client.post("/v1/stickers/delete", {"res_id": params.res_id})
    return _result(data, params.response_format, "QQ Sticker Deleted")


@mcp.tool(name="qq_get_qzone_feeds")
async def qq_get_qzone_feeds(params: GetQZoneFeedsInput) -> str:
    """获取指定 QQ 的说说列表。"""
    data = await client.get("/v1/qzone/feeds", {
        "target_qq": params.target_qq, "limit": params.limit,
    })
    return _result(data, params.response_format, "QQ Zone Feeds")


@mcp.tool(name="qq_get_qzone_comments")
async def qq_get_qzone_comments(params: GetQZoneCommentsInput) -> str:
    """获取指定说说的评论列表。"""
    data = await client.get("/v1/qzone/comments", {
        "target_qq": params.target_qq, "tid": params.tid, "scan": params.scan,
    })
    return _result(data, params.response_format, "QQ Zone Comments")


@mcp.tool(name="qq_comment_qzone")
async def qq_comment_qzone(params: CommentQZoneInput) -> str:
    """在指定说说下发表评论。"""
    data = await client.post("/v1/qzone/comment", {
        "target_qq": params.target_qq, "tid": params.tid, "content": params.content,
    })
    return _result(data, params.response_format, "QQ Zone Comment Posted")


@mcp.tool(name="qq_reply_qzone_comment")
async def qq_reply_qzone_comment(params: ReplyQZoneCommentInput) -> str:
    """回复指定说说下的某条评论。"""
    data = await client.post("/v1/qzone/reply", {
        "target_qq": params.target_qq,
        "tid": params.tid,
        "comment_id": params.comment_id,
        "content": params.content,
        "comment_uin": params.comment_uin,
        "comment_nick": params.comment_nick,
    })
    return _result(data, params.response_format, "QQ Zone Reply Posted")


@mcp.tool(name="qq_delete_qzone_comment")
async def qq_delete_qzone_comment(params: DeleteQZoneCommentInput) -> str:
    """删除指定说说下的某条评论。"""
    data = await client.post("/v1/qzone/delete_comment", {
        "target_qq": params.target_qq,
        "tid": params.tid,
        "comment_id": params.comment_id,
        "comment_uin": params.comment_uin,
    })
    return _result(data, params.response_format, "QQ Zone Comment Deleted")


@mcp.tool(name="qq_like_qzone")
async def qq_like_qzone(params: LikeQZoneInput) -> str:
    """给指定说说点赞。"""
    data = await client.post("/v1/qzone/like", {
        "target_qq": params.target_qq, "tid": params.tid,
    })
    return _result(data, params.response_format, "QQ Zone Liked")
