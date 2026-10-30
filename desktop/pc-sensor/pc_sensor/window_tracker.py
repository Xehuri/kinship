# -*- coding: utf-8 -*-
"""
聚焦窗口追踪器

通过轮询 GetForegroundWindow() 检测前台窗口变化，
事件驱动上报（只在窗口变化时触发回调）。
"""

import ctypes
from ctypes import wintypes
import logging
import sys
from dataclasses import dataclass
from typing import Optional, Callable

logger = logging.getLogger("pc_sensor.window")

# 非 Windows 或 ctypes 无 windll 时置空，供导入期安全检查；不影响 Windows 行为
try:
    user32 = ctypes.windll.user32 if sys.platform == "win32" else None
except AttributeError:  # pragma: no cover - 非 Windows 防御分支
    user32 = None


@dataclass
class WindowInfo:
    """前台窗口信息"""
    process: str      # 进程名，如 Code.exe
    title: str        # 窗口标题
    pid: int          # 进程 ID


def get_foreground_window() -> Optional[WindowInfo]:
    """获取当前前台窗口信息"""
    if user32 is None:
        return None
    try:
        hwnd = user32.GetForegroundWindow()
        if hwnd == 0:
            return None

        # 获取窗口标题
        length = user32.GetWindowTextLengthW(hwnd) + 1
        title_buf = ctypes.create_unicode_buffer(length)
        user32.GetWindowTextW(hwnd, title_buf, length)
        title = title_buf.value or ""

        # 获取进程 ID
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))

        # 获取进程名
        process_name = ""
        try:
            import psutil
            proc = psutil.Process(pid.value)
            process_name = proc.name()
        except ImportError:
            pass
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass

        return WindowInfo(process=process_name, title=title, pid=pid.value)
    except Exception as e:
        logger.warning("获取前台窗口失败: %s", e)
        return None


class WindowTracker:
    """聚焦窗口追踪器

    轮询检测前台窗口变化，仅在窗口切换时回调。
    默认轮询间隔 1 秒，可在 start() 后调整 poll_interval 属性。
    """

    def __init__(self, on_change: Optional[Callable[[WindowInfo], None]] = None):
        self.on_change = on_change
        self._last_key: Optional[tuple] = None  # (process, title_prefix)
        self._running = False
        self.poll_interval = 1.0  # 秒

    @property
    def running(self) -> bool:
        return self._running

    def start(self):
        """启动追踪器"""
        self._running = True
        # 记录当前窗口作为基线
        win = get_foreground_window()
        if win:
            self._last_key = (win.process, win.title[:80])
        logger.info("窗口追踪器已启动 (轮询间隔: %.1fs)", self.poll_interval)

    def stop(self):
        """停止追踪器"""
        self._running = False
        logger.info("窗口追踪器已停止")

    def tick(self) -> bool:
        """执行一次检测，窗口变化时回调，返回是否有变化"""
        if not self._running:
            return False

        win = get_foreground_window()
        if win is None:
            return False

        # 构建比较键值：标题太长时截断，避免微小变化触发重复上报
        key = (win.process, win.title[:80])

        if key != self._last_key:
            self._last_key = key
            if self.on_change:
                try:
                    self.on_change(win)
                except Exception as e:
                    logger.error("窗口变化回调异常: %s", e)
            return True

        return False
