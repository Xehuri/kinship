from __future__ import annotations

from typing import Any, Awaitable, Callable, Optional

from .config import ForwardConfig
from .render import render_segments

ActionCaller = Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]


def extract_messages(payload: Any) -> list[Any]:
    if isinstance(payload, list):
        return payload
    if not isinstance(payload, dict):
        return []
    for key in ("messages", "content"):
        value = payload.get(key)
        if isinstance(value, list):
            return value
    data = payload.get("data")
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        return extract_messages(data)
    return []


def normalize_node(item: Any) -> dict[str, Any]:
    if not isinstance(item, dict):
        return {"type": "node", "data": {"user_id": "", "nickname": "未知用户", "content": []}}
    if item.get("type") == "node":
        data = item.get("data") or {}
        content = data.get("content")
        if content is None:
            content = data.get("message") or []
        sender = data.get("sender") or {}
        user_id = data.get("user_id") or data.get("uin") or sender.get("user_id") or ""
        nickname = (data.get("nickname") or data.get("name")
                    or sender.get("card") or sender.get("nickname") or "未知用户")
        return {"type": "node", "data": {"user_id": str(user_id), "nickname": str(nickname),
                                          "content": content}}
    sender = item.get("sender") or {}
    content = item.get("message")
    if content is None:
        content = item.get("content") or []
    user_id = sender.get("user_id") or item.get("user_id") or ""
    nickname = sender.get("card") or sender.get("nickname") or "未知用户"
    return {"type": "node", "data": {"user_id": str(user_id), "nickname": str(nickname),
                                      "content": content}}


def to_send_nodes(messages: Any) -> list[dict[str, Any]]:
    return [normalize_node(item) for item in extract_messages(messages)]


async def expand_forward_segment(segment: dict[str, Any], call_action: ActionCaller,
                                 config: ForwardConfig, depth: int = 0) -> str:
    data = segment.get("data") or {}
    messages = data.get("content")
    if not isinstance(messages, list):
        message_id = data.get("id") or data.get("message_id")
        if not message_id:
            return "[合并转发]"
        try:
            payload = await call_action("get_forward_msg", {"message_id": str(message_id)})
        except Exception:
            return "[合并转发]"
        messages = extract_messages(payload)
    return await flatten_forward(messages, call_action, config, depth + 1)


async def flatten_forward(messages: Any, call_action: ActionCaller,
                          config: ForwardConfig, depth: int = 0) -> str:
    items = extract_messages(messages)
    if not items:
        return "[合并转发]"
    if depth > config.max_depth:
        return "[合并转发: 深度上限]"
    lines: list[str] = ["【合并转发消息: ...】"]
    used = 0
    for item in items[: config.max_nodes]:
        node = normalize_node(item)
        data = node["data"]
        nickname = data["nickname"]
        content = data["content"]

        async def resolve_forward(segment: dict[str, Any], _depth: int = depth) -> str:
            return await expand_forward_segment(segment, call_action, config, _depth)

        body = await render_segments(content, forward=resolve_forward)
        line = "- " + nickname + ": " + body
        if used + len(line) > config.max_chars:
            lines.append("...（已截断）")
            break
        lines.append(line)
        used += len(line)
    if len(items) > config.max_nodes:
        lines.append(f"...（还有 {len(items) - config.max_nodes} 条）")
    return "\n".join(lines)
