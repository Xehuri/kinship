# -*- coding: utf-8 -*-
"""进程编排器的服务声明模型与注册表（GAP-5 / GAP-8）。

本模块只回答两个问题：某个服务在当前配置下是否应当运行，以及它的起停
入口是什么。所有判定都是声明式的：``requirements_satisfied`` 只读配置
快照，不做 IO、不探测端口、不检查文件是否存在；需要等待或副作用的检查
（探活、版本比对、模型文件校验）一律属于 ``ServiceSpec.start``。

``REGISTRY`` 是唯一事实源：任务 12/14/15 把各服务声明注册进来，运行时
（任务 8）与 ``/api/services``（任务 9）都只从它读取，不得另建第二份清单。
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any

from config.config import Config

Gate = Callable[[Config], tuple[bool, str]]
ServiceAction = Callable[[], Awaitable[dict[str, Any]]]

# 配置快照中"键不存在"的哨兵：与显式配置为 null（None）区分开。
_MISSING = object()
_GATE_FAILED_REASON = "gate_failed"
_GATE_MALFORMED_REASON = "gate_failed: invalid_result"


@dataclass(frozen=True)
class ServiceSpec:
    """单个可编排服务的静态声明。

    字段语义：

    - ``id``：注册表主键，全进程唯一；
    - ``requires``：必须存在且非空的配置键（点分路径，如
      ``("moss.enabled", "moss.python")``）；布尔假值视为 disabled；
    - ``gate``：闸门，在 requires/enable_key 全部通过后调用，返回
      ``(ok, reason)``；无闸门时传 None。只允许做轻量判定，阻塞探测
      放进 ``start``；
    - ``start`` / ``stop``：异步起停入口，返回结果 dict 供运行时记录；
    - ``critical``：关键服务（停止顺序与失败策略由运行时决定）；
    - ``restart``：异常退出后是否允许运行时自动重启；
    - ``enable_key``：可选配置键；None 表示总是启用，设为键时该键为假
      则保持 blocked/disabled。供迁移期逐个接管与运维暂停使用。
    """

    id: str
    requires: tuple[str, ...]
    gate: Gate | None
    start: ServiceAction
    stop: ServiceAction
    critical: bool
    restart: bool
    enable_key: str | None = None


def _lookup_path(cfg: Config, path: str) -> Any:
    """按点分路径读取 Config 当前快照；键缺失返回 ``_MISSING``。

    复用 ``Config._data``（config/config.py:156）暴露的快照 dict：live 模式
    是 ConfigStore 当前快照，静态模式是注入文档。这里只遍历内存映射，不
    重新解析 yaml，也不触碰 provider。
    """
    node: Any = cfg._data
    for part in path.split("."):
        if not isinstance(node, Mapping) or part not in node:
            return _MISSING
        node = node[part]
    return node


def _evaluate_path(cfg: Config, path: str) -> tuple[bool, str]:
    """判定单个配置键：缺失/None/空串/空集合 = missing_config，布尔假 = disabled。"""
    value = _lookup_path(cfg, path)
    if value is _MISSING or value is None:
        return False, f"missing_config: {path}"
    if isinstance(value, bool):
        return (True, "") if value else (False, "disabled")
    if isinstance(value, str):
        if not value.strip():
            return False, f"missing_config: {path}"
        return True, ""
    if isinstance(value, (list, tuple, dict, set, frozenset)) and not value:
        return False, f"missing_config: {path}"
    return True, ""


def _normalize_gate_result(result: object) -> tuple[bool, str]:
    """收敛 gate 返回值；畸形结果按失败处理并给出稳定 reason。"""
    if isinstance(result, tuple) and len(result) == 2:
        ok, reason = result
        if isinstance(ok, bool) and isinstance(reason, str):
            if ok:
                return True, reason
            return False, reason or _GATE_FAILED_REASON
    return False, _GATE_MALFORMED_REASON


def requirements_satisfied(spec: ServiceSpec, cfg: Config) -> tuple[bool, str]:
    """声明式判定 spec 是否满足启动条件，返回 ``(ok, reason)``。

    顺序：``requires`` 逐项 -> ``enable_key`` -> ``gate``。失败 reason 取值：
    ``missing_config: <键>`` / ``disabled`` / gate 原文。本函数不产生任何
    副作用；配置键存在性只来自内存快照。
    """
    for path in spec.requires:
        ok, reason = _evaluate_path(cfg, path)
        if not ok:
            return ok, reason

    if spec.enable_key is not None:
        ok, reason = _evaluate_path(cfg, spec.enable_key)
        if not ok:
            return ok, reason

    if spec.gate is not None:
        return _normalize_gate_result(spec.gate(cfg))

    return True, ""


# ── 注册表 ──────────────────────────────────────────────────

REGISTRY: dict[str, ServiceSpec] = {}


def register(spec: ServiceSpec) -> None:
    """把服务声明写入全局注册表；重复 id 属于编程错误。"""
    if spec.id in REGISTRY:
        raise ValueError(f"duplicate service id: {spec.id}")
    REGISTRY[spec.id] = spec


def get(spec_id: str) -> ServiceSpec | None:
    """按 id 取声明；未注册返回 None。"""
    return REGISTRY.get(spec_id)


def all_specs() -> tuple[ServiceSpec, ...]:
    """按注册顺序返回全部声明的快照，调用方无法改到 REGISTRY 本身。"""
    return tuple(REGISTRY.values())


def clear_registry() -> None:
    """清空注册表；供测试与进程级重置使用。"""
    REGISTRY.clear()


__all__ = [
    "Gate",
    "REGISTRY",
    "ServiceAction",
    "ServiceSpec",
    "all_specs",
    "clear_registry",
    "get",
    "register",
    "requirements_satisfied",
]
