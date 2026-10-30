# -*- coding: utf-8 -*-
"""音频内核的编排器声明（GAP-5/GAP-6）。

内核不是普通外部服务：它由后端进程内 spawn 并持有 pidfile。因此本 spec 的
start/stop 直接委托 ``kernel_client``，不做第二套进程管理：

- ``start``: ``get_kernel_client().ensure_async()``（异步 spawn + 握手；pidfile
  里 pid 存活时由 ensure 抛 ``stale_kernel_detected``，编排器据此把 kernel
  标 failed）。内核真实冷启（模型加载）耗时 25~60s，同步 ``ensure()`` 会
  阻塞事件循环并拖垮 ``/health``，故编排器只走异步入口；工作线程里的同步
  调用点（音频惰性路径）保持原语义不变
- ``stop``: ``stop_kernel_process()``（POSIX 按 PID SIGTERM/SIGKILL；Windows
  先做四项归属证明再 TerminateProcess；adopt 客户端 no-op）

``critical=True`` 表示内核是音频主链关键服务；``restart=True`` 允许运行时在
异常退出后重启。``requires=()``/``gate=None``：内核对配置没有硬前置，解释器
解析与降级告警由 spawn 自身负责。

注意：不要在 ``services/orchestrator/runtime.py`` 里 import 本模块——注册由
``main.py`` 在 ``start_all()`` 之前显式调用，runtime 只读 ``REGISTRY``。
"""
from __future__ import annotations

from typing import Any

from .spec import REGISTRY, ServiceSpec, register

_KERNEL_SPEC: ServiceSpec | None = None


async def _start_kernel() -> dict[str, Any]:
    from services import kernel_client as kc

    client = kc.get_kernel_client()
    await client.ensure_async()
    link = kc._read_pidfile(client._state_dir) or {}
    return {
        "pid": kc._int_or_zero(link.get("pid")),
        "port": kc._int_or_zero(link.get("port"))
        or kc._port_from_base_url(client.base_url),
        "adopted": bool(getattr(client, "adopted", False)),
    }


async def _stop_kernel() -> dict[str, Any]:
    from services import kernel_client as kc

    return kc.stop_kernel_process()


def build_kernel_spec() -> ServiceSpec:
    """返回内核 spec 的进程级单例（start/stop 闭包因此保持对象等价）。"""
    global _KERNEL_SPEC
    if _KERNEL_SPEC is None:
        _KERNEL_SPEC = ServiceSpec(
            id="kernel",
            requires=(),
            gate=None,
            start=_start_kernel,
            stop=_stop_kernel,
            critical=True,
            restart=True,
        )
    return _KERNEL_SPEC


def register_kernel_spec() -> ServiceSpec:
    """幂等注册内核 spec；同 id 但声明不同则抛 ValueError。

    重复调用（main.py 的 lifespan 与测试/运维脚本）不抛错：已注册且与
    ``build_kernel_spec()`` 等价时原样返回；不等价说明有第二份内核声明，
    属于编程错误，必须显式失败而不是静默覆盖。
    """
    spec = build_kernel_spec()
    existing = REGISTRY.get(spec.id)
    if existing is None:
        register(spec)
        return spec
    if existing == spec:
        REGISTRY[spec.id] = spec
        return spec
    raise ValueError("conflicting service spec for id: kernel")


__all__ = ["build_kernel_spec", "register_kernel_spec"]
