# -*- coding: utf-8 -*-
"""
无人检测 + 屏幕锁屏追踪器

通过 GetLastInputInfo() 检测系统空闲时间，
通过 LogonUI.exe 进程检测屏幕锁定状态。
事件驱动上报（空闲/活跃切换、锁屏/解锁切换时触发回调）。
"""

import ctypes
import logging
import sys
from typing import Optional, Callable

logger = logging.getLogger("pc_sensor.idle")

# 非 Windows 或 ctypes 无 windll 时置空；Windows 行为保持不变
try:
    user32 = ctypes.windll.user32 if sys.platform == "win32" else None
    kernel32 = ctypes.windll.kernel32 if sys.platform == "win32" else None
except AttributeError:  # pragma: no cover - 非 Windows 防御分支
    user32 = None
    kernel32 = None


class LASTINPUTINFO(ctypes.Structure):
    """GetLastInputInfo 所需的输入结构"""
    _fields_ = [
        ("cbSize", ctypes.c_uint),
        ("dwTime", ctypes.c_uint),
    ]


def get_idle_seconds() -> float:
    """获取系统空闲秒数（距上次键盘/鼠标输入）；非 Windows 返回 0.0。"""
    if user32 is None or kernel32 is None:
        return 0.0
    try:
        info = LASTINPUTINFO()
        info.cbSize = ctypes.sizeof(LASTINPUTINFO)
        if user32.GetLastInputInfo(ctypes.byref(info)):
            current_tick = kernel32.GetTickCount()
            # 处理 tick 溢出（约 49.7 天循环一次）
            diff = (current_tick - info.dwTime) & 0xFFFFFFFF
            return diff // 1000
        return 0.0
    except Exception as e:
        logger.warning("获取空闲时间失败: %s", e)
        return 0.0


def is_screen_locked() -> bool:
    """检测屏幕是否锁定

    检测策略：
    1. 检查 LogonUI.exe 进程（Windows 锁屏进程）是否存在
    2. 如果 logonui 存在 → 已锁定
    3. 否则 → 未锁定

    非 Windows 无锁屏概念，返回 False。
    """
    if user32 is None:
        return False
    try:
        import psutil
        for proc in psutil.process_iter(['name']):
            try:
                pname = proc.info['name']
                if pname and pname.lower() == 'logonui.exe':
                    return True
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
        return False
    except ImportError:
        # 没有 psutil 时，尝试用 tasklist 命令
        import subprocess
        try:
            result = subprocess.run(
                'tasklist /fi "IMAGENAME eq LogonUI.exe"',
                shell=True, capture_output=True, text=True, timeout=5
            )
            return 'LogonUI.exe' in result.stdout
        except Exception:
            return False
    except Exception as e:
        logger.warning("检测屏幕锁定状态失败: %s", e)
        return False


class IdleTracker:
    """无人检测 + 屏幕锁屏追踪器

    管理三个状态：
    - idle: 空闲（无人操作）
    - active: 活跃（用户在操作）
    - screen_lock: 屏幕锁定

    状态变化时触发回调。
    """

    def __init__(
        self,
        idle_threshold: int = 300,
        on_idle: Optional[Callable[[int], None]] = None,
        on_active: Optional[Callable[[], None]] = None,
        on_screen_change: Optional[Callable[[bool], None]] = None,
    ):
        """
        Args:
            idle_threshold: 空闲阈值（秒），超过此时间无操作认为无人
            on_idle: 进入空闲时回调，参数为空闲秒数
            on_active: 恢复活跃时回调
            on_screen_change: 屏幕锁定/解锁时回调，参数为 True=锁定
        """
        self.idle_threshold = idle_threshold
        self.on_idle = on_idle
        self.on_active = on_active
        self.on_screen_change = on_screen_change

        self._was_idle = False
        self._last_screen_locked: Optional[bool] = None
        self._running = False

    @property
    def running(self) -> bool:
        return self._running

    @property
    def is_idle(self) -> bool:
        return self._was_idle

    def start(self):
        """启动追踪器"""
        self._running = True
        self._last_screen_locked = is_screen_locked()
        idle_secs = get_idle_seconds()
        self._was_idle = idle_secs >= self.idle_threshold
        logger.info(
            "无人检测已启动 (阈值: %ds, 初始状态: %s, 屏幕: %s)",
            self.idle_threshold,
            "空闲" if self._was_idle else "活跃",
            "锁定" if self._last_screen_locked else "未锁定",
        )

    def stop(self):
        """停止追踪器"""
        self._running = False
        logger.info("无人检测已停止")

    def tick(self, check_screen: bool = True):
        """执行一次检测，状态变化时回调。

        Args:
            check_screen: 是否执行全进程锁屏扫描（PC-M6）。为 False 时跳过
                psutil/tasklist 全进程遍历，仅做廉价的空闲检测并沿用上次
                锁屏状态；调用方应把 True 的扫描降频到 >= 30s。
        """
        if not self._running:
            return

        current_locked = self._last_screen_locked

        # ---- 1. 屏幕锁屏/解锁检测（可选，降频）----
        if check_screen:
            current_locked = is_screen_locked()
            if current_locked != self._last_screen_locked:
                self._last_screen_locked = current_locked
                if self.on_screen_change:
                    try:
                        self.on_screen_change(current_locked)
                    except Exception as e:
                        logger.error("屏幕状态回调异常: %s", e)
                # 屏幕锁定/解锁本身影响无人状态判断
                if current_locked:
                    # 锁屏时一定是无人状态
                    if not self._was_idle:
                        self._was_idle = True
                        if self.on_idle:
                            try:
                                self.on_idle(self.idle_threshold)
                            except Exception as e:
                                logger.error("空闲回调异常: %s", e)
                else:
                    # 解锁时如果上次是空闲，发恢复事件
                    if self._was_idle:
                        self._was_idle = False
                        if self.on_active:
                            try:
                                self.on_active()
                            except Exception as e:
                                logger.error("活跃回调异常: %s", e)

        # ---- 2. 空闲/活跃检测（屏幕未锁定时才检测）----
        if not current_locked:
            idle_secs = get_idle_seconds()
            is_now_idle = idle_secs >= self.idle_threshold

            if is_now_idle and not self._was_idle:
                # 进入空闲
                self._was_idle = True
                if self.on_idle:
                    try:
                        self.on_idle(idle_secs)
                    except Exception as e:
                        logger.error("空闲回调异常: %s", e)
            elif not is_now_idle and self._was_idle:
                # 恢复活跃
                self._was_idle = False
                if self.on_active:
                    try:
                        self.on_active()
                    except Exception as e:
                        logger.error("活跃回调异常: %s", e)
