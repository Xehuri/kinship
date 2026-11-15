"""dsh bridge 消息/子会话行 -> Kinship 后端消费形状（纯函数，无 IO）。

bridge 的 `GET /v1/session/messages` 返回扁平投影行
`{id, role, content:[block], text, created_at(ms), seq, source?, tool_call_id?, is_error?}`，
`GET /v1/session/children` 返回 `{id, parent_id, depth, kind, mode?, name?, label?,
activity?, created_at?, ...}`。后端消费面是 opencode `{info, parts}` 与 Loom
children 行，本模块是唯一转换点：

- content 块 text -> text part；thinking -> reasoning part；tool-call -> tool part
  （arguments 是 JSON 字符串，解析成 state.input；解析失败保留 {"raw": ...}）；
- role="tool" 结果按 tool_call_id 页级并回同页 tool part 的 state.output
  （is_error -> status="error"）；找不到宿主时原位保留独立 toolResult 壳；
- part 补 id/messageID/sessionID（与 loom_messages 同款稳定字段，前端可做 key）。
"""

import json
from typing import Any, Dict, List


def _content_text(content: Any) -> str:
    if not isinstance(content, list):
        return ""
    texts = [
        block["text"] for block in content
        if isinstance(block, dict)
        and block.get("type") == "text"
        and isinstance(block.get("text"), str)
        and block["text"] != ""
    ]
    return "\n".join(texts)


def _created_ms(row: Dict[str, Any]) -> int:
    value = row.get("created_at")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    return int(value)


def _arguments(block: Dict[str, Any]) -> Any:
    raw = block.get("arguments")
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return {"raw": raw}
        return parsed if isinstance(parsed, dict) else {"value": parsed}
    return raw if isinstance(raw, dict) else {}


def _part_fields(created: int, index: int, block_index: int,
                 msg_id: str, session_id: str) -> Dict[str, Any]:
    return {
        "id": f"part_hist_{created}_{index}_{block_index}",
        "messageID": msg_id,
        "sessionID": session_id,
    }


def _info(row: Dict[str, Any], index: int, session_id: str) -> Dict[str, Any]:
    created = _created_ms(row)
    info = {
        "id": str(row.get("id") or f"dsh_{created}_{index}"),
        "role": str(row.get("role") or "assistant"),
        "sessionID": session_id,
        "time": {"created": created},
    }
    if row.get("source") is not None:
        info["source"] = row["source"]
    return info


def _plain_message(row: Dict[str, Any], index: int, session_id: str) -> Dict[str, Any]:
    info = _info(row, index, session_id)
    text = _content_text(row.get("content"))
    if not text and isinstance(row.get("text"), str):
        text = row["text"]
    part = {
        "type": "text",
        "text": text,
        **_part_fields(info["time"]["created"], index, 0, info["id"], session_id),
    }
    return {"info": info, "parts": [part]}


def _assistant_message(row: Dict[str, Any], index: int, session_id: str,
                       call_parts: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    info = _info(row, index, session_id)
    created = info["time"]["created"]
    parts: List[Dict[str, Any]] = []
    content = row.get("content")
    if isinstance(content, list):
        for block in content:
            if not isinstance(block, dict):
                continue
            btype = block.get("type")
            fields = _part_fields(created, index, len(parts), info["id"], session_id)
            if btype == "text":
                parts.append({"type": "text", "text": block.get("text", ""), **fields})
            elif btype in ("reasoning", "thinking"):
                # dsh 的 ReasoningBlock 是 {"type":"reasoning","text":...}；
                # "thinking" 分支保留给旧/扁平投影，两者都归一成前端 reasoning part。
                text = block.get("text") if btype == "reasoning" else block.get("thinking", block.get("text", ""))
                parts.append({"type": "reasoning", "text": text or "", **fields})
            elif btype == "tool-call":
                call_id = str(block.get("id") or "")
                part = {
                    "type": "tool",
                    "callID": call_id,
                    "tool": block.get("name", ""),
                    "state": {"status": "completed", "input": _arguments(block), "output": ""},
                    **fields,
                }
                if call_id:
                    call_parts.setdefault(call_id, part)
                parts.append(part)
    return {"info": info, "parts": parts}


def _toolresult_message(row: Dict[str, Any], index: int,
                        session_id: str) -> Dict[str, Any]:
    info = _info(row, index, session_id)
    info["role"] = "toolResult"
    status = "error" if row.get("is_error") else "completed"
    part = {
        "type": "tool",
        "callID": str(row.get("tool_call_id") or ""),
        "tool": "",
        "state": {"status": status, "input": {}, "output": _content_text(row.get("content"))},
        **_part_fields(info["time"]["created"], index, 0, info["id"], session_id),
    }
    return {"info": info, "parts": [part]}


def to_opencode_messages(rows: Any, session_id: str) -> List[Dict[str, Any]]:
    """整页转换（bridge 页内序旧->新）：tool 结果并回宿主，孤儿原位独立壳。"""
    if not isinstance(rows, list):
        return []

    call_parts: Dict[str, Dict[str, Any]] = {}
    slots: List[Any] = []
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            continue
        role = row.get("role")
        if role == "assistant":
            slots.append(_assistant_message(row, index, session_id, call_parts))
        elif role == "tool":
            slots.append(("tool", index, row))
        else:
            slots.append(_plain_message(row, index, session_id))

    messages: List[Dict[str, Any]] = []
    for slot in slots:
        if not isinstance(slot, tuple):
            messages.append(slot)
            continue
        _, index, row = slot
        call_id = str(row.get("tool_call_id") or "")
        host_part = call_parts.get(call_id) if call_id else None
        if host_part is None:
            messages.append(_toolresult_message(row, index, session_id))
            continue
        host_part["state"]["output"] = _content_text(row.get("content"))
        if row.get("is_error"):
            host_part["state"]["status"] = "error"
    return messages


def to_children(rows: Any, session_id: str) -> List[Dict[str, Any]]:
    """ChildRow -> {id,title,type,status,parentID,createdAt}（前端子智能体列表消费面）。"""
    if not isinstance(rows, list):
        return []
    children: List[Dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        child_id = row.get("id")
        if not child_id:
            continue
        children.append({
            "id": str(child_id),
            "title": row.get("label") or row.get("name") or row.get("id") or "",
            "type": row.get("mode") or row.get("kind") or "",
            "status": row.get("activity") or row.get("status"),
            "parentID": row.get("parent_id") or session_id,
            "createdAt": row.get("created_at"),
        })
    return children
