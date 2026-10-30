# -*- coding: utf-8 -*-
"""
PC 感知数据采集器

采集电脑的聚焦窗口、无人状态、屏幕锁屏等数据，
通过 HTTP POST 上报到后端，存入 perception.jsonl。
"""

from .manager import SensorManager, default_device_name
from .window_tracker import WindowTracker, get_foreground_window, WindowInfo
from .idle_tracker import IdleTracker, get_idle_seconds, is_screen_locked

__all__ = [
    "SensorManager", "default_device_name",
    "WindowTracker", "get_foreground_window", "WindowInfo",
    "IdleTracker", "get_idle_seconds", "is_screen_locked",
]
