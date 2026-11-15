"""Loom 会话日志的只读离线读取层（chatlog 的 loom 腿）。

Loom 把主会话持久化在 ``<AI_ROOT>/.loom/session/loom-main.jsonl``：追加写、每行
一个 JSON 对象，消息形如::

    {"t":"entry","sid":"loom_main","e":{"entry":{"kind":"message",
     "message":{"role":"user","content":"...","timestamp":1791975880412}}}}

本模块只做一件事：按时间窗从文件尾部反向扫描出 user/assistant 轮次，供
``GET /api/screen/session/chatlog?backend=loom`` 在 Loom 进程未运行时也能查询
历史。它不写文件、不依赖 Loom 服务，也不解析 Loom 的 flow/compaction 私有结构。

边界：
- 只读当前 ``loom-main.jsonl``；``.bak-*`` 轮转备份不扫描（跨备份合并留给运维）。
- 文件是追加写的，时间戳单调，所以反向扫描一旦早于 ``start_ms`` 即可停止。
- 坏行逐行跳过（与 perception 读层同款容错），不因单行损坏中断整窗查询。
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Iterator

# 反向扫描块大小：太大会一次读入过多大行（toolResult 可能很长），太小则 syscall 变多。
_CHUNK_BYTES = 1 << 20


def loom_log_path() -> Path:
    """Loom 主会话日志路径（每次现取配置，测试可 monkeypatch 本缝）。"""
    from config.config import get_config

    return Path(get_config().AI_ROOT) / ".loom" / "session" / "loom-main.jsonl"


def _iter_reverse_lines(path: Path) -> Iterator[bytes]:
    """从文件末尾按块反向 yield 每一行（不含换行符）。"""
    with open(path, "rb") as f:
        f.seek(0, os.SEEK_END)
        pos = f.tell()
        buffer = b""
        while pos > 0:
            step = min(_CHUNK_BYTES, pos)
            pos -= step
            f.seek(pos)
            buffer = f.read(step) + buffer
            lines = buffer.split(b"\n")
            buffer = lines[0]
            for raw in reversed(lines[1:]):
                if raw:
                    yield raw
        if buffer:
            yield buffer


def _content_of(message: dict[str, Any]) -> tuple[str, list[str]]:
    """把 Loom 的 message.content 归一为 (正文, 工具名列表)。

    - user：content 是纯字符串。
    - assistant：content 是 block 列表，正文只拼 ``type=="text"``，工具取
      ``type=="toolCall"`` 的 name，thinking 一律忽略（与前端展示同口径）。
    """
    content = message.get("content")
    if isinstance(content, str):
        return content, []
    if not isinstance(content, list):
        return "", []
    texts: list[str] = []
    tools: list[str] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        btype = block.get("type")
        if btype == "text":
            text = block.get("text")
            if isinstance(text, str) and text:
                texts.append(text)
        elif btype == "toolCall":
            name = block.get("name")
            if isinstance(name, str) and name and name not in tools:
                tools.append(name)
    return "".join(texts), tools


def read_turns(
    start_ms: int,
    end_ms: int,
    *,
    path: Path | None = None,
) -> list[dict[str, Any]]:
    """读取时间窗内的 user/assistant 轮次（升序）。

    返回条目只含跨层稳定的原始字段：``{id, role, time_ms, content, tools,
    session_id}``；时间字符串与展示口径由路由层统一补（避免 services 反向依赖
    routers）。
    """
    target = path if path is not None else loom_log_path()
    turns: list[dict[str, Any]] = []
    try:
        iterator = _iter_reverse_lines(target)
    except OSError:
        raise

    for raw in iterator:
        try:
            row = json.loads(raw)
        except (ValueError, TypeError):
            continue
        if not isinstance(row, dict) or row.get("t") != "entry":
            continue
        outer = row.get("e")
        if not isinstance(outer, dict):
            continue
        entry = outer.get("entry")
        if not isinstance(entry, dict) or entry.get("kind") != "message":
            continue
        message = entry.get("message")
        if not isinstance(message, dict):
            continue
        ts = message.get("timestamp")
        if not isinstance(ts, (int, float)):
            continue
        if ts < start_ms:
            # 追加写且时间单调：更早的行不可能再落进窗口。
            break
        if ts > end_ms:
            continue
        role = message.get("role")
        if role not in ("user", "assistant"):
            continue
        content, tools = _content_of(message)
        if role == "assistant":
            if not content and not tools:
                continue
            if not content:
                content = "[工具调用]"
        elif not content:
            continue
        turns.append(
            {
                "id": str(outer.get("id") or ""),
                "role": role,
                "time_ms": int(ts),
                "content": content,
                "tools": tools or None,
                "session_id": str(row.get("sid") or "loom_main"),
            }
        )

    turns.sort(key=lambda item: item["time_ms"])
    return turns
