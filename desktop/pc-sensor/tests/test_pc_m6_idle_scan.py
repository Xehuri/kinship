# -*- coding: utf-8 -*-
"""PC-M6：锁屏全进程扫描降频到 >= 30s，廉价空闲检测保持高频。"""

import pc_sensor.idle_tracker as idle_mod
import pc_sensor.manager as manager_mod
from pc_sensor.idle_tracker import IdleTracker


def test_screen_scan_interval_at_least_30s():
    assert manager_mod.SCREEN_SCAN_INTERVAL >= 30.0


def test_cheap_idle_check_is_more_frequent():
    assert manager_mod.IDLE_CHECK_INTERVAL < manager_mod.SCREEN_SCAN_INTERVAL


def test_tick_skips_screen_scan_when_disabled(monkeypatch):
    calls = {"n": 0}

    def fake_locked() -> bool:
        calls["n"] += 1
        return False

    monkeypatch.setattr(idle_mod, "is_screen_locked", fake_locked)
    monkeypatch.setattr(idle_mod, "get_idle_seconds", lambda: 0)

    tracker = IdleTracker(idle_threshold=300)
    tracker.start()  # start 内部会扫描一次，随后重置计数
    calls["n"] = 0

    tracker.tick(check_screen=False)
    assert calls["n"] == 0  # 未触发全进程扫描

    tracker.tick(check_screen=True)
    assert calls["n"] == 1  # 显式调用才扫描


def test_tick_default_still_checks_screen(monkeypatch):
    calls = {"n": 0}

    def fake_locked() -> bool:
        calls["n"] += 1
        return False

    monkeypatch.setattr(idle_mod, "is_screen_locked", fake_locked)
    monkeypatch.setattr(idle_mod, "get_idle_seconds", lambda: 0)

    tracker = IdleTracker(idle_threshold=300)
    tracker._running = True
    tracker._last_screen_locked = False

    tracker.tick()
    assert calls["n"] == 1
