"""dsh 原生事件 -> 前端 SSE 词表转译（纯状态机，无 IO）。

bridge 的 ``GET /v1/session/events`` 在契约事件流里转发两类帧，信封同构：

- durable Session 事件：``{"seq": 12, "payload": {"type": "user/message", "properties": {...}}}``
- live 助手流（额外类型，契约允许客户端忽略）：``{"seq": 12.001, "payload":
  {"type": "kinship/assistant-stream", "properties": {"session_id": ..., "frame": {...}}}}``

前端（``frontend/mobile``）只认 opencode/loom 词表，并且要求每帧
``properties.sessionID`` 与活跃会话 id 相等，否则整帧丢弃。本模块把 dsh 事件
翻译成前端可消费的事件（累积全文的 part 更新，part id 跨帧稳定），并注入
``sessionID`` / ``backend``。

设计约束：

- 纯函数式状态机：每个绑定会话一个实例，无 IO、无日志副作用；
- 不翻译的事件类型返回空列表（调用方丢弃），绝不透传 dsh 原生类型；
- 流式阶段没有 durable message id，因此 part 帧不带 ``messageID``，让前端写入
  未绑定占位符；durable ``assistant/message`` 提交时用同 part id + 真实
  ``messageID`` 再发一次，前端按 id 整体替换并绑定后端消息 id（实时与历史去重）；
- part id 规则：正文/推理 ``dsh-{turn}-{step}-{index}``、工具 ``dsh-tool-{callId}``、
  用户 ``dsh-user-{messageId}-{index}``。
"""

from __future__ import annotations

import json
import time
from typing import Any, Dict, List, Optional

# 内容块类型 -> 前端 part 类型
_TEXT_BLOCKS = {"text": "text"}
_REASONING_BLOCKS = {"reasoning", "thinking"}

# 工具参数增量帧的最小字符间隔（避免每个 delta 一帧把带宽打满）
_TOOL_PARTIAL_STEP_CHARS = 240


def _as_int(value: Any, default: int = 0) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return int(value)
    return default


def _as_dict(value: Any) -> Dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _content_text(content: Any) -> str:
    if not isinstance(content, list):
        return ""
    parts: List[str] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        text = block.get("text")
        if isinstance(text, str) and text != "":
            parts.append(text)
    return "\n".join(parts)


def _parse_arguments(raw: Any) -> Dict[str, Any]:
    """工具参数是模型产出的原始 JSON 字符串；解析失败保留 raw。"""
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            return {"raw": raw}
        return parsed if isinstance(parsed, dict) else {"value": parsed}
    return raw if isinstance(raw, dict) else {}


def _token_usage(usage: Any) -> Optional[Dict[str, Any]]:
    """dsh TokenUsage -> 前端 ``info.tokens`` 形状（``normalizeTokenUsage`` 认的键）。"""
    if not isinstance(usage, dict):
        return None
    input_tokens = _as_int(usage.get("inputTokens"))
    output_tokens = _as_int(usage.get("outputTokens"))
    reasoning = _as_int(usage.get("reasoningTokens"))
    cache_read = _as_int(usage.get("cacheReadTokens"))
    cache_write = _as_int(usage.get("cacheWriteTokens"))
    total = _as_int(usage.get("totalTokens"), input_tokens + output_tokens)
    if total <= 0 and input_tokens <= 0 and output_tokens <= 0:
        return None
    return {
        "total": total,
        "input": input_tokens,
        "output": output_tokens,
        "reasoning": reasoning,
        "cache": {"read": cache_read, "write": cache_write},
    }


class DshEventTranslator:
    """把一个 dsh 绑定会话的事件流翻译成前端词表 SSE 帧。"""

    def __init__(self, session_id: str) -> None:
        self._session_id = session_id
        self._turn = 0
        self._step = 0
        # attemptId -> {turn, step, revision}
        self._attempts: Dict[str, Dict[str, int]] = {}
        # "turn:step:index" -> {"type": "text"|"reasoning", "text": str}
        self._blocks: Dict[str, Dict[str, Any]] = {}
        # callId -> {"name": str, "arguments": str, "sent": int}
        self._tool_calls: Dict[str, Dict[str, Any]] = {}
        # "turn:step" -> assistant message id（供 tool 事件补 messageID）
        self._message_ids: Dict[str, str] = {}

    # ------------------------------------------------------------------ 入口

    def translate_line(self, line: str) -> List[str]:
        """把 bridge 的一行原始 SSE 文本翻译成零到多帧 SSE 文本。"""
        text = line.strip()
        if not text:
            return []
        if text.startswith(":"):
            return []
        if text.startswith("retry:"):
            return []
        if not text.startswith("data:"):
            return []
        raw = text[5:].strip()
        try:
            event = json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            return []
        if not isinstance(event, dict):
            return []
        return self.translate_event(event)

    def translate_event(self, event: Dict[str, Any]) -> List[str]:
        """翻译一个 bridge SSE 事件（``{"payload": {"type", "properties"}}``）。"""
        payload = _as_dict(event.get("payload"))
        event_type = payload.get("type")
        properties = _as_dict(payload.get("properties"))
        if not isinstance(event_type, str) or event_type == "":
            return []

        if event_type == "kinship/assistant-stream":
            return self._on_live(properties)

        handler = _DURABLE_HANDLERS.get(event_type)
        if handler is None:
            return []
        return handler(self, properties)

    # ------------------------------------------------------------- 帧构造工具

    def _frame(self, event_type: str, properties: Dict[str, Any]) -> str:
        properties = dict(properties)
        properties["sessionID"] = self._session_id
        properties["backend"] = "dsh"
        frame = {"payload": {"type": event_type, "properties": properties}}
        return f"data: {json.dumps(frame, ensure_ascii=False)}\n\n"

    def _now_ms(self) -> int:
        return int(time.time() * 1000)

    def _status(self, status_type: str) -> str:
        return self._frame("session.status", {"status": {"type": status_type}})

    def _message_updated(self, info: Dict[str, Any]) -> str:
        return self._frame("message.updated", {"info": info})

    def _part_updated(self, part: Dict[str, Any], message_id: Optional[str] = None) -> str:
        properties: Dict[str, Any] = {"part": part}
        if message_id is not None:
            properties["messageID"] = message_id
        return self._frame("message.part.updated", properties)

    @staticmethod
    def _text_part(part_id: str, part_type: str, text: str) -> Dict[str, Any]:
        return {"id": part_id, "type": part_type, "text": text}

    @staticmethod
    def _tool_part(part_id: str, name: str, input_value: Any, output: str, status: str) -> Dict[str, Any]:
        return {
            "id": part_id,
            "type": "tool",
            "tool": name,
            "state": {"status": status, "input": input_value, "output": output},
        }

    # --------------------------------------------------------------- live 流

    def _on_live(self, properties: Dict[str, Any]) -> List[str]:
        remote = properties.get("session_id")
        if isinstance(remote, str) and remote != "" and remote != self._session_id:
            return []
        frame = _as_dict(properties.get("frame"))
        frame_type = frame.get("type")

        if frame_type == "start":
            attempt_id = str(frame.get("attemptId") or "")
            turn = _as_int(frame.get("turn"))
            step = _as_int(frame.get("step"))
            revision = _as_int(frame.get("revision"))
            previous = self._attempts.get(attempt_id)
            self._attempts[attempt_id] = {"turn": turn, "step": step, "revision": revision}
            self._turn, self._step = turn, step
            if previous is None or previous.get("revision") != revision:
                self._reset_step(turn, step)
            return [self._status("busy")]

        if frame_type == "chunk":
            return self._on_chunk(frame)

        if frame_type == "end":
            attempt_id = str(frame.get("attemptId") or "")
            self._attempts.pop(attempt_id, None)
            return []

        return []

    def _reset_step(self, turn: int, step: int) -> None:
        prefix = f"{turn}:{step}:"
        for key in [key for key in self._blocks if key.startswith(prefix)]:
            self._blocks.pop(key, None)
        self._tool_calls.clear()

    def _on_chunk(self, frame: Dict[str, Any]) -> List[str]:
        chunk = _as_dict(frame.get("chunk"))
        chunk_type = chunk.get("type")
        turn = _as_int(frame.get("turn"), self._turn)
        step = _as_int(frame.get("step"), self._step)
        index = _as_int(chunk.get("index"))
        block_key = f"{turn}:{step}:{index}"
        part_id = f"dsh-{turn}-{step}-{index}"

        if chunk_type == "block-start":
            block_type = str(chunk.get("blockType") or "")
            if block_type in _TEXT_BLOCKS:
                self._blocks[block_key] = {"type": "text", "text": ""}
                return [self._part_updated(self._text_part(part_id, "text", ""))]
            if block_type in _REASONING_BLOCKS:
                self._blocks[block_key] = {"type": "reasoning", "text": ""}
                return [self._part_updated(self._text_part(part_id, "reasoning", ""))]
            return []

        if chunk_type in ("text-delta", "reasoning-delta"):
            block = self._blocks.setdefault(
                block_key,
                {"type": "text" if chunk_type == "text-delta" else "reasoning", "text": ""},
            )
            delta = chunk.get("text")
            if isinstance(delta, str) and delta != "":
                block["text"] = str(block.get("text") or "") + delta
            return [self._part_updated(self._text_part(part_id, str(block["type"]), str(block.get("text") or "")))]

        if chunk_type == "tool-call-delta":
            call_id = str(chunk.get("id") or "")
            if call_id == "":
                return []
            entry = self._tool_calls.setdefault(call_id, {"name": "", "arguments": "", "sent": 0})
            name = chunk.get("name")
            if isinstance(name, str) and name != "":
                entry["name"] = name
            delta = chunk.get("argumentsDelta")
            if isinstance(delta, str):
                entry["arguments"] = str(entry.get("arguments") or "") + delta
            arguments = str(entry.get("arguments") or "")
            sent = _as_int(entry.get("sent"))
            # 未完成的 JSON 无法解析，先给 raw 预览；block-end 再给结构化 input。
            if len(arguments) - sent < _TOOL_PARTIAL_STEP_CHARS and sent > 0:
                return []
            entry["sent"] = len(arguments)
            part = self._tool_part(f"dsh-tool-{call_id}", str(entry.get("name") or ""), {"raw": arguments}, "", "running")
            return [self._part_updated(part)]

        if chunk_type == "block-end":
            block = _as_dict(chunk.get("block"))
            block_type = str(block.get("type") or "")
            if block_type == "tool-call":
                call_id = str(block.get("id") or "")
                if call_id == "":
                    return []
                entry = self._tool_calls.setdefault(call_id, {"name": "", "arguments": "", "sent": 0})
                entry["name"] = str(block.get("name") or entry.get("name") or "")
                entry["arguments"] = str(block.get("arguments") or entry.get("arguments") or "")
                part = self._tool_part(
                    f"dsh-tool-{call_id}",
                    str(entry.get("name") or ""),
                    _parse_arguments(entry.get("arguments")),
                    "",
                    "running",
                )
                return [self._part_updated(part)]
            if block_type in _TEXT_BLOCKS:
                text = str(block.get("text") or "")
                self._blocks[block_key] = {"type": "text", "text": text}
                return [self._part_updated(self._text_part(part_id, "text", text))]
            if block_type in _REASONING_BLOCKS:
                text = str(block.get("text") or "")
                self._blocks[block_key] = {"type": "reasoning", "text": text}
                return [self._part_updated(self._text_part(part_id, "reasoning", text))]
            return []

        # usage / finish 等控制帧不产生前端事件
        return []

    # ---------------------------------------------------------- durable 事件

    def _on_turn_start(self, data: Dict[str, Any]) -> List[str]:
        self._turn = _as_int(data.get("turn"), self._turn)
        return [self._status("busy")]

    def _on_step_start(self, data: Dict[str, Any]) -> List[str]:
        self._turn = _as_int(data.get("turn"), self._turn)
        self._step = _as_int(data.get("step"), self._step)
        return []

    def _on_turn_end(self, data: Dict[str, Any]) -> List[str]:
        frames: List[str] = []
        reason = _as_dict(data.get("reason"))
        if reason.get("kind") == "error":
            error = _as_dict(reason.get("error"))
            message = error.get("message")
            if isinstance(message, str) and message != "":
                frames.append(self._frame("session.error", {"error": {"message": message}}))
        frames.append(self._status("idle"))
        self._blocks.clear()
        self._tool_calls.clear()
        return frames

    def _on_user_message(self, data: Dict[str, Any]) -> List[str]:
        message = _as_dict(data)
        message_id = message.get("id")
        if not isinstance(message_id, str) or message_id == "":
            return []
        created = self._now_ms()
        frames = [
            self._message_updated(
                {"id": message_id, "role": "user", "time": {"created": created}}
            )
        ]
        for index, block in enumerate(message.get("content") or []):
            if not isinstance(block, dict):
                continue
            if block.get("type") not in _TEXT_BLOCKS:
                continue
            text = str(block.get("text") or "")
            frames.append(
                self._part_updated(
                    self._text_part(f"dsh-user-{message_id}-{index}", "text", text),
                    message_id,
                )
            )
        return frames

    def _on_assistant_message(self, data: Dict[str, Any]) -> List[str]:
        turn = _as_int(data.get("turn"), self._turn)
        step = _as_int(data.get("step"), self._step)
        message = _as_dict(data.get("message"))
        message_id = message.get("id")
        if not isinstance(message_id, str) or message_id == "":
            return []
        self._turn, self._step = turn, step
        self._message_ids[f"{turn}:{step}"] = message_id
        created = self._now_ms()
        info: Dict[str, Any] = {
            "id": message_id,
            "role": "assistant",
            "time": {"created": created},
        }
        tokens = _token_usage(data.get("usage"))
        if tokens is not None:
            info["tokens"] = tokens
        frames = [self._message_updated(info)]
        for index, block in enumerate(message.get("content") or []):
            if not isinstance(block, dict):
                continue
            block_type = block.get("type")
            part_id = f"dsh-{turn}-{step}-{index}"
            if block_type in _TEXT_BLOCKS:
                text = str(block.get("text") or "")
                self._blocks[f"{turn}:{step}:{index}"] = {"type": "text", "text": text}
                frames.append(self._part_updated(self._text_part(part_id, "text", text), message_id))
            elif block_type in _REASONING_BLOCKS:
                text = str(block.get("text") or "")
                self._blocks[f"{turn}:{step}:{index}"] = {"type": "reasoning", "text": text}
                frames.append(self._part_updated(self._text_part(part_id, "reasoning", text), message_id))
            elif block_type == "tool-call":
                call_id = str(block.get("id") or "")
                if call_id == "":
                    continue
                self._tool_calls[call_id] = {
                    "name": str(block.get("name") or ""),
                    "arguments": str(block.get("arguments") or ""),
                    "sent": 0,
                }
                part = self._tool_part(
                    f"dsh-tool-{call_id}",
                    str(block.get("name") or ""),
                    _parse_arguments(block.get("arguments")),
                    "",
                    "running",
                )
                frames.append(self._part_updated(part, message_id))
        return frames

    def _on_tool_call(self, data: Dict[str, Any]) -> List[str]:
        call_id = data.get("callId")
        if not isinstance(call_id, str) or call_id == "":
            return []
        turn = _as_int(data.get("turn"), self._turn)
        step = _as_int(data.get("step"), self._step)
        name = str(data.get("name") or "")
        arguments = str(data.get("arguments") or "")
        self._tool_calls[call_id] = {"name": name, "arguments": arguments, "sent": len(arguments)}
        part = self._tool_part(f"dsh-tool-{call_id}", name, _parse_arguments(arguments), "", "running")
        return [self._part_updated(part, self._message_ids.get(f"{turn}:{step}"))]

    def _on_tool_result(self, data: Dict[str, Any]) -> List[str]:
        message = _as_dict(data.get("message"))
        call_id = message.get("toolCallId")
        if not isinstance(call_id, str) or call_id == "":
            return []
        turn = _as_int(data.get("turn"), self._turn)
        step = _as_int(data.get("step"), self._step)
        entry = self._tool_calls.get(call_id, {"name": "", "arguments": "", "sent": 0})
        is_error = message.get("isError") is True
        part = self._tool_part(
            f"dsh-tool-{call_id}",
            str(entry.get("name") or ""),
            _parse_arguments(entry.get("arguments")),
            _content_text(message.get("content")),
            "error" if is_error else "completed",
        )
        return [self._part_updated(part, self._message_ids.get(f"{turn}:{step}"))]

    def _on_compaction(self, data: Dict[str, Any]) -> List[str]:
        return [self._frame("session.compacted", {})]


_DURABLE_HANDLERS = {
    "turn/start": DshEventTranslator._on_turn_start,
    "step/start": DshEventTranslator._on_step_start,
    "turn/end": DshEventTranslator._on_turn_end,
    "user/message": DshEventTranslator._on_user_message,
    "assistant/message": DshEventTranslator._on_assistant_message,
    "tool/call": DshEventTranslator._on_tool_call,
    "tool/result": DshEventTranslator._on_tool_result,
    "compaction/summary": DshEventTranslator._on_compaction,
}
