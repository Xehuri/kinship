# -*- coding: utf-8 -*-
"""睡眠分片合并：空载荷不得覆盖既有数据（回归测试）。

对应缺陷：`HealthStore._merge_shard` -> `_merge_sleep_data` 在合并
「只带步数/心率、sleep 字段为空」的推送或云端回补时，会把该日期已存的
睡眠数据整段清空（duration_min/stages 等变成 None/[]），且无任何日志。

修复要点：
1. 新载荷里的空值（None / "" / [] / {}）不参与覆盖；
2. 会话合并结果为空时保留既存值；
3. `_merge_shard` 中 `sleep_data` 为空字典时不进入合并。
"""

from __future__ import annotations

from services.health.store import HealthStore, _merge_sleep_data


def _full_sleep():
    return {
        "stages": [
            {"t": "00:13", "stage": "light"},
            {"t": "00:40", "stage": "deep"},
        ],
        "duration_min": 833,
        "deep_min": 266,
        "light_min": 375,
        "rem_min": 192,
        "awake_min": 0,
        "awake_count": 0,
        "bedtime": "00:13",
        "wakeup_time": "07:10",
    }


def _shard(sleep_data):
    return {
        "source": "phone",
        "user_id": "pzn",
        "date": "2026-10-30",
        "device": {"label": None},
        "samples": [],
        "daily_summary": {"total_steps": 1000},
        "sleep_data": sleep_data,
    }


def test_empty_session_payload_keeps_existing():
    """空会话载荷不得清空既有睡眠。"""
    merged = _merge_sleep_data(
        _full_sleep(),
        {"sleep_sessions": [], "stages": [], "duration_min": None},
    )
    assert merged["duration_min"] == 833
    assert len(merged["stages"]) == 2
    assert merged["deep_min"] == 266


def test_field_level_none_does_not_override():
    """字段级 update 中的 None / 空列表不得覆盖非空值。"""
    merged = _merge_sleep_data(
        _full_sleep(),
        {"duration_min": None, "deep_min": None, "stages": []},
    )
    assert merged["duration_min"] == 833
    assert merged["deep_min"] == 266
    assert len(merged["stages"]) == 2


def test_real_values_still_override():
    """正常的新值仍然覆盖旧值（不得因为防覆盖而丢掉更新能力）。"""
    merged = _merge_sleep_data(_full_sleep(), {"duration_min": 900})
    assert merged["duration_min"] == 900


def test_merge_shard_ignores_empty_sleep_dict():
    """`_merge_shard` 收到空 sleep_data 时保留既存整段。"""
    existing = _shard(_full_sleep())
    new = _shard({})
    merged = HealthStore._merge_shard(existing, new)
    assert merged["sleep_data"]["duration_min"] == 833
    assert len(merged["sleep_data"]["stages"]) == 2
