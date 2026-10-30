# -*- coding: utf-8 -*-
"""PC-M3：聚合末段按截止时刻截断，跨天 active_seconds 不超过真实时间跨度。"""

from typing import Any

from pc_sensor_app import aggregate_pc_events


def _win(t: str, t_iso: str, process: str = "Code.exe") -> dict[str, Any]:
    return {
        "type": "pc_window",
        "t": t,
        "t_iso": t_iso,
        "payload": {"process": process, "title": "title"},
    }


def test_last_segment_clamped_cross_day():
    """23:50 -> 次日 00:05，真实跨度 900s；末段按 cutoff=00:05 截断。"""
    events = [
        _win("23:50:00", "2026-09-09T23:50:00"),
        _win("23:55:00", "2026-09-09T23:55:00"),
        _win("00:00:00", "2026-09-10T00:00:00"),
    ]
    agg = aggregate_pc_events(events, cutoff_seconds=5 * 60)
    real_span = 900  # 15 分钟
    assert abs(agg["totals"]["active_seconds"] - real_span) < 5


def test_without_cutoff_inflates():
    """不给 cutoff（历史日期）时按 86400 收尾，明显大于真实跨度——证明修复生效。"""
    events = [
        _win("23:50:00", "2026-09-09T23:50:00"),
        _win("23:55:00", "2026-09-09T23:55:00"),
        _win("00:00:00", "2026-09-10T00:00:00"),
    ]
    agg = aggregate_pc_events(events)
    assert agg["totals"]["active_seconds"] > 1000


def test_same_day_cutoff():
    events = [_win("10:00:00", "2026-09-10T10:00:00")]
    agg = aggregate_pc_events(events, cutoff_seconds=10 * 3600 + 120)
    assert agg["totals"]["active_seconds"] == 120
