# -*- coding: utf-8 -*-
"""把 Kinship 数据路径推给 dsh 计划调度器（bridge POST /v1/kinship/paths）。

dsh 侧 kinship-plan-scheduler 与 Loom 读写同一份 plan master/overlay，路径不能
硬编码——由后端在生命周期点主动推送一次，bridge 缓存后供排班器定位数据根。

契约（bridge 路由由插件侧并行落地，本模块只从调用方一侧钉形状）：

    POST {DSH_URL}/v1/kinship/paths
    Authorization: Bearer <dsh.token>
    {"schema":1,"ai_root":"/abs","data_dir":"/abs","plan_root":"/abs",
     "plan_master":"/abs/plan/master.json","source":"kinship-backend",
     "generated_at":<epoch ms>}
    200 -> {"ok":true,"schema":1,"ai_root":...,"data_dir":...,"plan_root":...,
            "source":...,"generated_at":...,"stored_at":...}

行为约定：
- **无条件推送**，不按 ai_backend 分流：非 dsh 通道时 bridge 通常不在线，失败
  只记 warning；等之后热切 ``ai_backend=dsh``，bridge 侧已有缓存路径，排班器
  不必等下一次数据路径变更才就位。
- **永不抛**：``push_paths`` 把一切异常（传输/构造/配置）收成
  ``{"ok": False, "error": ...}``；``schedule_push`` 是 fire-and-forget，无运行
  事件循环时只记 debug（例如脚本/同步工具/测试直接调用）。
- **合并**：同一在途任务期间或 1 秒内的连续调用只产生一次推送——启动期
  boot/data_paths/health 三连击不会打出三次 HTTP。

诊断面 ``last_push()`` 供 /health 或日志读取最近一次结果（模块级状态，进程重启
即清空；不落盘、不进配置）。
"""

import asyncio
import json
import logging
import os
import time
from typing import Any, Dict, Optional

from config.config import get_config
from core.redaction import redact_text
from services.dsh_client import get_dsh_client

logger = logging.getLogger(__name__)

PAYLOAD_SCHEMA = 1
SOURCE = "kinship-backend"
# 合并窗口：启动期多个钩子在同一秒内连发，只保留首个 reason
MIN_INTERVAL_S = 1.0

_last_push: Optional[Dict[str, Any]] = None
_task: Optional[asyncio.Task] = None
_scheduled_at: Optional[float] = None


def _now_ms() -> int:
    """当前墙钟毫秒（契约字段 generated_at/at 的单位）。"""
    return int(time.time() * 1000)


def _abs_path(value: Any) -> str:
    """配置路径归一为绝对路径；空值返回空串（不把 cwd 当数据根）。"""
    text = str(value or "").strip()
    if not text:
        return ""
    return os.path.abspath(os.path.expanduser(text))


def build_paths_payload() -> Dict[str, Any]:
    """按当前配置构造推送体（纯函数：只读 config，无 IO，不发请求）。"""
    cfg = get_config()
    ai_root = _abs_path(cfg.AI_ROOT)
    data_dir = _abs_path(cfg.DATA_DIR)
    plan_root = data_dir
    plan_master = os.path.join(plan_root, "plan", "master.json") if plan_root else ""
    return {
        "schema": PAYLOAD_SCHEMA,
        "ai_root": ai_root,
        "data_dir": data_dir,
        "plan_root": plan_root,
        "plan_master": plan_master,
        "source": SOURCE,
        "generated_at": _now_ms(),
    }


def _error_detail(status: int, body: Any) -> str:
    """失败详情：状态码 + 截断 body，统一过 redact（令牌/查询凭据不外泄）。"""
    if isinstance(body, str):
        text = body
    else:
        try:
            text = json.dumps(body, ensure_ascii=False)
        except (TypeError, ValueError):
            text = str(body)
    return redact_text(f"HTTP {status}: {text[:300]}")


def _remember(result: Dict[str, Any]) -> None:
    global _last_push
    _last_push = dict(result)


async def push_paths(reason: str) -> Dict[str, Any]:
    """推送一次数据路径；返回 ``{"ok","status","reason","error","at"}``，绝不抛。

    reason 只作诊断标签（boot/data_paths/ai_surface/health），不影响载荷；失败
    （bridge 未起/401/非 200/传输异常）一律 ok=False + 脱敏 detail，由调用方
    决定是否刷屏——本函数自身只打一条 warning。
    """
    at = _now_ms()
    try:
        payload = build_paths_payload()
        client = get_dsh_client()
        status, body, _headers = await client.push_kinship_paths(payload)
    except Exception as e:
        result: Dict[str, Any] = {
            "ok": False,
            "status": None,
            "reason": reason,
            "error": redact_text(str(e)),
            "at": at,
        }
        _remember(result)
        logger.warning("[DshPaths] push failed reason=%s: %s", reason, result["error"])
        return result

    ok = status == 200
    error = None if ok else _error_detail(status, body)
    result = {"ok": ok, "status": status, "reason": reason, "error": error, "at": at}
    _remember(result)
    if ok:
        logger.info(
            "[DshPaths] pushed plan_root=%s reason=%s", payload["plan_root"], reason
        )
    else:
        logger.warning("[DshPaths] push failed reason=%s: %s", reason, error)
    return result


async def _run(reason: str) -> None:
    """任务体：push_paths 自身永不抛，这里只兜底不可预期异常，防孤儿告警。"""
    try:
        await push_paths(reason)
    except Exception as e:  # pragma: no cover - push_paths 已收敛全部异常
        logger.warning(
            "[DshPaths] push task crashed reason=%s: %s", reason, redact_text(str(e))
        )


def schedule_push(reason: str) -> None:
    """fire-and-forget 推送调度（同步入口，交给当前事件循环执行）。

    - 无运行中事件循环（同步工具/测试/脚本上下文）：no-op，只记 debug；
    - 已有在途任务，或距上次调度不足 ``MIN_INTERVAL_S``：合并掉本次调用；
    - 否则在当前循环 create_task，结果只进日志与 ``last_push()``。
    """
    global _task, _scheduled_at
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        logger.debug("[DshPaths] no running loop, skip push reason=%s", reason)
        return
    if _task is not None and not _task.done():
        logger.debug("[DshPaths] push in flight, coalesce reason=%s", reason)
        return
    now = time.monotonic()
    if _scheduled_at is not None and now - _scheduled_at < MIN_INTERVAL_S:
        logger.debug("[DshPaths] push coalesced (<%.1fs) reason=%s", MIN_INTERVAL_S, reason)
        return
    _scheduled_at = now
    _task = loop.create_task(_run(reason), name=f"dsh-paths-push:{reason}")


def last_push() -> Optional[Dict[str, Any]]:
    """最近一次推送结果快照（诊断用）；从未推送返回 None。"""
    return dict(_last_push) if _last_push is not None else None


def _reset_state() -> None:
    """清空模块状态（仅测试用）。"""
    global _last_push, _task, _scheduled_at
    _last_push = None
    _task = None
    _scheduled_at = None
