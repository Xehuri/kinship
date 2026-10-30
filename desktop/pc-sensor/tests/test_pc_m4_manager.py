# -*- coding: utf-8 -*-
"""PC-M4：start/stop 串行化，连续快速启停不产生双主循环。"""

import json
import threading
import time

from pc_sensor.manager import SensorManager


class _FakeUploader:
    """替代真实 Uploader，避免测试触发网络登录。"""

    def __init__(self):
        self.has_token = True
        self.buffer_size = 0
        self.flush_count = 0

    def force_relogin(self):
        return True

    def flush(self):
        self.flush_count += 1

    def enqueue(self, data):
        pass


class _CountingManager(SensorManager):
    """记录主循环并发数，用于验证任一时刻至多一个主循环。"""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.uploader = _FakeUploader()
        self.loop_entries = 0
        self.active_loops = 0
        self.max_active_loops = 0
        self._cnt_lock = threading.Lock()

    def _run_loop(self):
        with self._cnt_lock:
            self.loop_entries += 1
            self.active_loops += 1
            self.max_active_loops = max(self.max_active_loops, self.active_loops)
        try:
            while self._running:
                time.sleep(0.001)
        finally:
            with self._cnt_lock:
                self.active_loops -= 1
            self.uploader.flush()


def _write_config(tmp_path) -> str:
    cfg = {
        "enabled": True,
        "server_url": "",
        "username": "u",
        # PC-M7：不再持久化密码；此处仅用户名，配置中不出现 password 字段
        "idle_threshold": 300,
        "window_enabled": False,
        "idle_enabled": False,
        "screen_enabled": False,
    }
    path = tmp_path / "pc_sensor_config.json"
    path.write_text(json.dumps(cfg), encoding="utf-8")
    return str(path)


def test_rapid_start_stop_single_loop(tmp_path):
    sm = _CountingManager(config_path=_write_config(tmp_path))

    for _ in range(10):
        sm.start()
        sm.stop()

    assert sm.loop_entries == 10
    assert sm.max_active_loops == 1
    assert sm.active_loops == 0
    assert sm.running is False
    assert sm._thread is None


def test_stop_joins_thread(tmp_path):
    sm = _CountingManager(config_path=_write_config(tmp_path))
    sm.start()
    thread = sm._thread
    assert thread is not None and thread.is_alive()
    sm.stop()
    assert not thread.is_alive()
