# -*- coding: utf-8 -*-
"""
事件循环管理器

用于在后台线程中安全地访问主事件循环。

使用方法:
    from services.event_loop_manager import set_main_loop, get_main_loop
    
    # 在主线程中设置
    set_main_loop(asyncio.get_running_loop())
    
    # 在后台线程中获取
    loop = get_main_loop()
"""

import asyncio
import logging

logger = logging.getLogger(__name__)

# 全局事件循环引用
_MAIN_EVENT_LOOP = None


def set_main_loop(loop: asyncio.AbstractEventLoop):
    """设置主事件循环"""
    global _MAIN_EVENT_LOOP
    _MAIN_EVENT_LOOP = loop
    logger.info(f"[EventLoopManager] 事件循环已设置: {loop}")


def get_main_loop() -> asyncio.AbstractEventLoop | None:
    """获取主事件循环"""
    global _MAIN_EVENT_LOOP
    return _MAIN_EVENT_LOOP