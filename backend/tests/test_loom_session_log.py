# -*- coding: utf-8 -*-
"""W56：Loom 追加会话日志的离线读取层（chatlog 的 loom 腿）。

锁死：
  1. 时间窗过滤（含边界）+ 升序输出；
  2. user 字符串 / assistant block 列表的正文与工具提取（thinking 忽略，
     toolResult 跳过，空 assistant 跳过）；
  3. 坏行逐行跳过，不中断整窗；
  4. 反向分块扫描在小块（跨块行）下仍逐条正确——用 monkeypatch 把块缩到 32B。
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest

import services.loom_session_log as lsl

BASE = 1_720_000_000_000


def _entry(kind, message=None, sid="loom_main", rid="e1"):
    entry = {"kind": kind}
    if message is not None:
        entry["message"] = message
    return {"t": "entry", "sid": sid, "e": {"id": rid, "entry": entry}}


def _write(path, rows):
    lines = []
    for row in rows:
        lines.append(row if isinstance(row, str) else json.dumps(row, ensure_ascii=False))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def test_reads_window_and_skips_non_message_kinds(tmp_path):
    path = tmp_path / "loom-main.jsonl"
    _write(path, [
        _entry("message", {"role": "user", "content": "第一问", "timestamp": BASE + 1000}, rid="a"),
        _entry("terminal", {"role": "user", "content": "terminal"}, rid="t"),
        _entry("message", {"role": "assistant", "content": [
            {"type": "thinking", "thinking": "x"},
            {"type": "text", "text": "第一答"},
            {"type": "toolCall", "name": "bash"},
        ], "timestamp": BASE + 2000}, rid="b"),
        _entry("message", {"role": "toolResult", "content": [
            {"type": "text", "text": "ok"}], "timestamp": BASE + 3000}, rid="c"),
        _entry("compaction_boundary", {"summary": "x"}, rid="d"),
        _entry("message", {"role": "user", "content": "窗口外", "timestamp": BASE + 9000}, rid="e"),
        "not json",
    ])

    turns = lsl.read_turns(BASE + 1000, BASE + 8000, path=path)

    assert [t["role"] for t in turns] == ["user", "assistant"]
    assert turns[0]["content"] == "第一问"
    assert turns[0]["session_id"] == "loom_main"
    assert turns[1]["content"] == "第一答"
    assert turns[1]["tools"] == ["bash"]
    # 反向扫描跳过窗口外条目，仍保持升序输出
    assert [t["time_ms"] for t in turns] == [BASE + 1000, BASE + 2000]


def test_window_boundaries_are_inclusive(tmp_path):
    path = tmp_path / "loom-main.jsonl"
    _write(path, [
        _entry("message", {"role": "user", "content": "头", "timestamp": BASE}, rid="a"),
        _entry("message", {"role": "user", "content": "尾", "timestamp": BASE + 100}, rid="b"),
    ])
    turns = lsl.read_turns(BASE, BASE + 100, path=path)
    assert [t["content"] for t in turns] == ["头", "尾"]


def test_assistant_with_only_tools_gets_placeholder(tmp_path):
    path = tmp_path / "loom-main.jsonl"
    _write(path, [
        _entry("message", {"role": "assistant", "content": [
            {"type": "toolCall", "name": "write"}], "timestamp": BASE + 1}, rid="a"),
    ])
    turns = lsl.read_turns(BASE, BASE + 10, path=path)
    assert len(turns) == 1
    assert turns[0]["content"] == "[工具调用]"
    assert turns[0]["tools"] == ["write"]


def test_empty_user_and_empty_assistant_are_skipped(tmp_path):
    path = tmp_path / "loom-main.jsonl"
    _write(path, [
        _entry("message", {"role": "user", "content": "", "timestamp": BASE + 1}, rid="a"),
        _entry("message", {"role": "assistant", "content": [
            {"type": "thinking", "thinking": "x"}], "timestamp": BASE + 2}, rid="b"),
    ])
    assert lsl.read_turns(BASE, BASE + 10, path=path) == []


def test_reverse_chunk_scan_handles_tiny_blocks(tmp_path, monkeypatch):
    """块只有 32B 时，一行会跨多个块；反向扫描仍必须逐条不漏。"""
    path = tmp_path / "loom-main.jsonl"
    _write(path, [
        _entry("message", {"role": "user", "content": "甲" * 80, "timestamp": BASE + i},
               rid=f"r{i}")
        for i in range(1, 6)
    ])
    monkeypatch.setattr(lsl, "_CHUNK_BYTES", 32)

    turns = lsl.read_turns(BASE, BASE + 10, path=path)

    assert [t["id"] for t in turns] == ["r1", "r2", "r3", "r4", "r5"]


def test_missing_file_raises(tmp_path):
    with pytest.raises(FileNotFoundError):
        lsl.read_turns(BASE, BASE + 10, path=tmp_path / "absent.jsonl")


def test_default_path_uses_ai_root(monkeypatch, tmp_path):
    import config.config as config_module

    monkeypatch.setattr(
        config_module,
        "get_config",
        lambda: type("Cfg", (), {"AI_ROOT": str(tmp_path)})(),
    )
    assert lsl.loom_log_path() == tmp_path / ".loom" / "session" / "loom-main.jsonl"
