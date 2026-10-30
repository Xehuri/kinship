# -*- coding: utf-8 -*-
"""业务就绪门控：由编排器状态回调驱动调度器暂停/恢复派发。

约束（任务 18）：

- 只认 ``critical=True`` 的服务：任一 critical 服务 ``ready`` 即恢复派发，
  全部非 ``ready`` 时暂停派发；可选服务（moss/loom/qq）的起落不影响结论。
- 完全由 ``Orchestrator.on_state_change`` 触发，不轮询、不 sleep。
- ``AXEUH_ORCHESTRATOR=off`` 时不改变调度器的既有暂停状态（保持改造前
  行为）；该判断在绑定期与每次回调各做一次，避免环境变量运行期翻转后
  把调度器永久卡在暂停态。
"""
from __future__ import annotations

import logging
from collections.abc import Callable, Iterable, Mapping
from typing import Any

logger = logging.getLogger(__name__)


def critical_ready(services: Iterable[Mapping[str, Any]]) -> bool:
    """快照条目中是否存在处于 ``ready`` 的 critical 服务。"""
    for entry in services:
        if bool(entry.get("critical")) and entry.get("state") == "ready":
            return True
    return False


def apply_service_readiness(
    scheduler: Any, services: Iterable[Mapping[str, Any]]
) -> bool:
    """按服务快照更新 ``set_paused``，返回更新后的暂停状态。"""
    paused = not critical_ready(services)
    previous_getter = getattr(scheduler, "is_paused", None)
    previous = bool(previous_getter()) if callable(previous_getter) else None
    scheduler.set_paused(paused)
    if previous is not None and previous != paused:
        logger.info(
            "[SchedulerGating] critical_ready=%s -> paused=%s",
            not paused,
            paused,
        )
    return paused


def bind_scheduler_gating(
    orchestrator: Any, scheduler: Any
) -> Callable[[], None]:
    """注册编排器状态回调并立即对齐一次；返回取消函数。

    ``scheduler`` 只要求提供 ``set_paused(bool)``；``orchestrator`` 只要求
    ``enabled``、``on_state_change(cb)`` 与 ``snapshot()``，便于测试替换。
    ``off`` 模式不注册回调，也不触碰调度器当前暂停状态。
    """
    if not orchestrator.enabled:
        return lambda: None

    def _reconcile(_entry: Mapping[str, Any] | None = None) -> None:
        snapshot = orchestrator.snapshot()
        if snapshot.get("orchestrator") != "on":
            # 运行期把开关切到 off：回退到改造前的"不门控"语义。
            scheduler.set_paused(False)
            return
        apply_service_readiness(scheduler, snapshot.get("services") or ())

    unsubscribe = orchestrator.on_state_change(_reconcile)
    _reconcile()
    return unsubscribe


__all__ = [
    "apply_service_readiness",
    "bind_scheduler_gating",
    "critical_ready",
]
