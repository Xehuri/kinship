# -*- coding: utf-8 -*-
"""trigger_task 速率限制的 per-script 覆盖。

QQ 私聊中继需要比全局默认（1 次/分钟）更高的触发频率，因此在脚本
frontmatter 里用 ``trigger_rate_per_min`` 覆盖；这里锁定解析、缺省值以
及 ``_handle_message`` 的实际限流行为。
"""

from __future__ import annotations

import threading

from services.script_runner import ScriptRunner, _get_script_info, _parse_frontmatter

SRC_WITH_RATE = '''
"""
name: QQ私聊转发
enabled: true
trigger_rate_per_min: 20
"""

def run(context):
    pass
'''

SRC_WITHOUT_RATE = '''
"""
name: 脚本B
enabled: true
"""

def run(context):
    pass
'''

SRC_WITH_BAD_RATE = '''
"""
name: 脚本C
enabled: true
trigger_rate_per_min: not-a-number
"""

def run(context):
    pass
'''


def _rate_runner(limit: int | None) -> ScriptRunner:
    """最小可用的 ScriptRunner：只装配限流与 trigger 分支需要的字段。"""
    runner = ScriptRunner.__new__(ScriptRunner)
    runner._lock = threading.RLock()
    runner._rate_limits = {}
    runner._rate_limit_window = 60
    runner._rate_limit_max = 1
    runner._processes = {"qq": {} if limit is None else {"trigger_rate_per_min": limit}}
    runner._main_loop = None
    runner._client = None
    runner._audit_log = lambda *args, **kwargs: None  # type: ignore[assignment]
    return runner


def test_frontmatter_parses_trigger_rate():
    fm = _parse_frontmatter(SRC_WITH_RATE)
    assert fm["trigger_rate_per_min"] == 20


def test_script_info_defaults_trigger_rate_to_one():
    assert _get_script_info(SRC_WITHOUT_RATE)["trigger_rate_per_min"] == 1


def test_script_info_keeps_valid_trigger_rate():
    assert _get_script_info(SRC_WITH_RATE)["trigger_rate_per_min"] == 20


def test_script_info_normalizes_invalid_trigger_rate():
    assert _get_script_info(SRC_WITH_BAD_RATE)["trigger_rate_per_min"] == 1


def test_trigger_rate_override_allows_more_than_one_per_minute(caplog):
    runner = _rate_runner(3)
    msg = {"type": "trigger_task", "target": "main-task", "prompt": "x"}

    for _ in range(3):
        runner._handle_message("qq", dict(msg))

    assert not any("速率限制触发" in row.message for row in caplog.records)

    runner._handle_message("qq", dict(msg))
    assert any("速率限制触发 (每分钟最多 3 次)" in row.message for row in caplog.records)


def test_trigger_rate_default_still_blocks_second_call_per_minute(caplog):
    runner = _rate_runner(None)
    msg = {"type": "trigger_task", "target": "main-task", "prompt": "x"}

    runner._handle_message("qq", dict(msg))
    runner._handle_message("qq", dict(msg))

    assert any("速率限制触发 (每分钟最多 1 次)" in row.message for row in caplog.records)
