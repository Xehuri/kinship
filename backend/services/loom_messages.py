"""Loom 历史消息形状适配器（纯函数层，零 IO）。

loom 历史（GET /sessions/:id/history）回的是 pi-ai Message：
    user:       {role, content: str | [TextContent|ImageContent], timestamp}
    assistant:  {role, content: [TextContent|ThinkingContent|ToolCall], model, provider,
                 usage, stopReason, timestamp}
    toolResult: {role, toolCallId, toolName, content, isError, timestamp}

后端消费面（routers/session.py 的 _strip_user_wrapper/_msg_to_turn、
chatlog 时间窗过滤）吃的是 opencode 形状 {info:{id,role,sessionID,time:{created}},
parts:[{type:text|tool|reasoning,...}]}。本模块做单向 pi→opencode 形状映射，
保证前端与既有剥离/汇总逻辑零改动（用户拍板：前端零改动，靠 loom 对齐形状）。

W43 渲染契约（对齐 frontend/mobile composables/streaming 的 part 白名单与工具卡消费面）：
  - ThinkingContent → part {type:"reasoning", text}（白名单只认 reasoning，"thinking" 不认）；
  - toolResult 页级合并：按 toolCallId 并回同页对应 assistant toolCall part 的
    state.output（isError → state.status="error"），合并后不再产出独立消息；
    同页无匹配 callID 的孤儿 → **原位保留独立 toolResult 壳**（info.role="toolResult"），
    绝不挂到本页最后一条 assistant——20 条分页会截断 toolCall，旧实现会把早期 read
    结果错挂到最终纯文本回复；孤儿/兜底计数打 logger.debug；
  - 每个产出 part 补稳定字段 id（=part_hist_{created}_{index}_{blockIdx}）、
    callID（toolCall 块的 id / toolResult 的 toolCallId，非 tool part 不带）、
    messageID（=info.id）、sessionID；
  - 无匹配 toolResult 的 toolCall 不编造 output（留 ""、status "completed"）。

id 决策：loom history 响应体只带 messages 不带 entry id（游标是另一条链），
故 info.id 用 (role, timestamp, 页内下标) 合成——历史页只做展示与对话日志，
SSE 实时面（loom 侧 msg_/part_ 序号）才是 splice 主渠道，两者不必同 id 空间。
info.id 维持 msg_hist_*——与 live msg_N 统一 id 空间需 harness 历史体携带 msg
序号，属遗留，不在本主题。timestamp 为 JS 毫秒（pi-ai Date.now()），
与 opencode info.time.created 同单位。
W51 增补：history 条目若携带 raw "id"（entry id，harness 侧可缺），经
_stamp_entry_id 透传为 info["loomEntryId"] 供压缩分隔线锚匹配——纯增量键，
msg_hist_* 方案逐字节不变。
"""

import logging
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

ResultMsg = Dict[str, Any]  # 一条 opencode {info, parts} 消息


def _content_to_text(content: Any) -> str:
    """user/toolResult content 归一为纯文本（str 或 TextContent 块拼接；ImageContent 跳过）。"""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            b.get("text", "") for b in content
            if isinstance(b, dict) and b.get("type") == "text"
        )
    return ""


def _created_ms(message: Dict[str, Any]) -> int:
    """pi-ai timestamp（JS 毫秒）→ info.time.created；非数值回退 0（与旧行为一致）。"""
    ts = message.get("timestamp")
    return int(ts) if isinstance(ts, (int, float)) else 0


def _stamp_entry_id(info: Dict[str, Any], message: Dict[str, Any]) -> None:
    """W51：loom history 条目 id 透传——raw 带真值 "id" 时补 info["loomEntryId"]。

    唯一消费面 = routers/session.py 压缩分隔线的锚匹配（compaction 快照的
    anchorMessageId 对本页条目）。纯增量：raw 无 id / 假值 id 不建键，
    info.id 的 msg_hist_{created}_{index} 方案逐字节不变。
    """
    entry_id = message.get("id")
    if entry_id:
        info["loomEntryId"] = entry_id


def _part_fields(created: int, index: int, block_index: int,
                 msg_id: str, session_id: str) -> Dict[str, Any]:
    """part 稳定字段（W43c）：id 由宿主消息坐标 + 产出序号派生，页内位置重排不影响幂等性。"""
    return {
        "id": f"part_hist_{created}_{index}_{block_index}",
        "messageID": msg_id,
        "sessionID": session_id,
    }


def _plain_message(index: int, message: Dict[str, Any], session_id: str) -> ResultMsg:
    """user（及其余非 assistant/toolResult 角色）→ 单 text part 消息。"""
    created = _created_ms(message)
    msg_id = f"msg_hist_{created}_{index}"
    info = {"id": msg_id, "role": message.get("role", ""),
            "sessionID": session_id, "time": {"created": created}}
    _stamp_entry_id(info, message)
    part = {"type": "text", "text": _content_to_text(message.get("content")),
            **_part_fields(created, index, 0, msg_id, session_id)}
    return {"info": info, "parts": [part]}


def _assistant_message(index: int, message: Dict[str, Any], session_id: str,
                       call_parts: Dict[str, Dict[str, Any]]) -> ResultMsg:
    """assistant content 块 → parts：text 直映、thinking→reasoning、toolCall→tool part；
    toolCall 按块 id 登记进 call_parts 供页级 toolResult 合并（重复 id 取先登记者）。"""
    created = _created_ms(message)
    msg_id = f"msg_hist_{created}_{index}"
    parts: List[Dict[str, Any]] = []
    content = message.get("content")
    if isinstance(content, list):
        for block in content:
            if not isinstance(block, dict):
                continue
            btype = block.get("type")
            fields = _part_fields(created, index, len(parts), msg_id, session_id)
            if btype == "text":
                parts.append({"type": "text", "text": block.get("text", ""), **fields})
            elif btype == "thinking":
                parts.append({"type": "reasoning", "text": block.get("thinking", ""), **fields})
            elif btype == "toolCall":
                call_id = block.get("id", "")
                part = {
                    "type": "tool", "callID": call_id, "tool": block.get("name", ""),
                    "state": {
                        "status": "completed",
                        "input": block.get("arguments") or {},
                        "output": "",
                    },
                    **fields,
                }
                if call_id:
                    call_parts.setdefault(call_id, part)
                parts.append(part)
    info = {
        "id": msg_id,
        "role": "assistant",
        "sessionID": session_id,
        "time": {"created": created},
        "model": message.get("model", ""),
        "provider": message.get("provider", ""),
        "stopReason": message.get("stopReason", ""),
        "tokens": _tokens_from_usage(message.get("usage")),
    }
    _stamp_entry_id(info, message)
    return {"info": info, "parts": parts}


def _toolresult_message(index: int, message: Dict[str, Any], session_id: str) -> ResultMsg:
    """toolResult 独立壳（本页无匹配 toolCall 时的原位置容器）：前端按 parts 渲染
    tool 卡；info.role="toolResult" 不被 _msg_to_turn 当对话轮，时间线位置不丢。"""
    created = _created_ms(message)
    msg_id = f"msg_hist_{created}_{index}"
    info = {"id": msg_id, "role": "toolResult",
            "sessionID": session_id, "time": {"created": created}}
    _stamp_entry_id(info, message)
    part = {"type": "tool", "callID": message.get("toolCallId", ""),
            "tool": message.get("toolName", ""),
            "state": _result_state(message),
            **_part_fields(created, index, 0, msg_id, session_id)}
    return {"info": info, "parts": [part]}


def _result_state(message: Dict[str, Any]) -> Dict[str, Any]:
    """toolResult → tool part state（isError 定 status，正文归一为 output 文本）。"""
    return {
        "status": "error" if message.get("isError") else "completed",
        "input": {},
        "output": _content_to_text(message.get("content")),
    }


def _tokens_from_usage(usage: Any) -> Dict[str, Any]:
    """pi-ai Usage → 前端硬契约 info.tokens 六字段（形状与 loom events/mapping.ts 同源）。"""
    u = usage if isinstance(usage, dict) else {}
    return {
        "total": u.get("totalTokens", 0),
        "input": u.get("input", 0),
        "output": u.get("output", 0),
        "reasoning": 0,
        "cache": {"read": u.get("cacheRead", 0), "write": u.get("cacheWrite", 0)},
    }


def to_opencode_messages(messages: List[Dict[str, Any]], session_id: str) -> List[ResultMsg]:
    """整页转换（保持 loom 的升序序，旧→新，与 opencode 行为一致）。

    两趟：正序转换非 toolResult 消息并登记 toolCall part 索引；再按原序并回
    toolResult（命中→写宿主 part；孤儿→原位独立壳），消息序全程不重排。
    """
    call_parts: Dict[str, Dict[str, Any]] = {}
    slots: List[Any] = []
    for i, m in enumerate(messages):
        if not isinstance(m, dict):
            continue
        role = m.get("role", "")
        if role == "assistant":
            slots.append(_assistant_message(i, m, session_id, call_parts))
        elif role == "toolResult":
            slots.append(("toolResult", i, m))
        else:
            slots.append(_plain_message(i, m, session_id))

    out: List[ResultMsg] = []
    n_orphan = 0
    for slot in slots:
        if not isinstance(slot, tuple):
            out.append(slot)
            continue
        _, i, m = slot
        call_id = m.get("toolCallId") or ""
        host_part = call_parts.get(call_id) if call_id else None
        if host_part is not None:
            host_part["state"]["output"] = _content_to_text(m.get("content"))
            if m.get("isError"):
                host_part["state"]["status"] = "error"
        else:
            n_orphan += 1
            out.append(_toolresult_message(i, m, session_id))
    if n_orphan:
        logger.debug(f"[loom-history] toolResult 孤儿壳计数: orphan_shell={n_orphan}")
    return out
