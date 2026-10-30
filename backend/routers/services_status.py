# -*- coding: utf-8 -*-
"""服务状态 API：``GET /api/services`` 与运维闸门（任务 9 / 任务 36）。

读端点只投影 ``Orchestrator.snapshot()`` 的公开字段：不探测端口、不读取进程
命令行或环境变量、不触发 start/stop。鉴权沿用全局 Bearer 中间件，并在路由
内按 ``require_config_read`` 再次收口（device/service token 一律拒绝）。

写端点（任务 36）::

    POST /api/services/{service_id}/pause   -> 200 <entry>
    POST /api/services/{service_id}/resume  -> 200 <entry>

闸门直接调用进程内 ``Orchestrator.pause/resume``；pause 内部经
``spec.stop()`` 停服务（绝不按名杀进程）。未知 id -> 404；``AXEUH_ORCHESTRATOR=off``
-> 409。写授权与配置面同级（user token；bootstrap 放行），但**不要求密码二次
校验**——stage3.sh 闸门契约只带 Bearer user token（见
``scripts/migrate-orchestrator/README.md`` 第 6 节），密码门会让迁移脚本 403。

读响应契约::

    {"orchestrator": "on"|"off",
     "services": [{id, state, reason_code, detail, pid, started_at,
                   retry_count, next_retry_at, requires, critical}]}

``reason_code`` 的公开枚举：missing_config / disabled / gate_failed /
spawn_failed / crashed / restart_exhausted / stopped；starting/ready 为空串，
运维 pause 由运行时给出 manually_paused。``detail`` 只返回人话摘要，内部
异常堆栈由运行时写日志，绝不进响应。
"""
from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse

from core.redaction import redact_text
from services.config_authz import (
    ConfigAuthError,
    config_auth_error_response,
    require_config_read,
)
from services.orchestrator.runtime import ORCHESTRATOR_ENV, get_orchestrator

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["services"])

_PUBLIC_FIELDS = (
    "id",
    "state",
    "reason_code",
    "detail",
    "pid",
    "started_at",
    "retry_count",
    "next_retry_at",
    "requires",
    "critical",
)


def _service_entry(entry: Mapping[str, Any]) -> dict[str, Any]:
    """把运行时条目裁剪为公开字段，并对 detail 做密钥脱敏。"""
    requires = entry.get("requires")
    public: dict[str, Any] = {
        "id": entry.get("id"),
        "state": entry.get("state"),
        "reason_code": entry.get("reason_code") or "",
        "detail": redact_text(str(entry.get("detail") or "")),
        "pid": entry.get("pid"),
        "started_at": entry.get("started_at"),
        "retry_count": int(entry.get("retry_count") or 0),
        "next_retry_at": entry.get("next_retry_at"),
        "requires": (
            [str(item) for item in requires]
            if isinstance(requires, (list, tuple))
            else []
        ),
        "critical": bool(entry.get("critical", False)),
    }
    # 保持字段集合与顺序稳定（契约字段即白名单）。
    return {field: public[field] for field in _PUBLIC_FIELDS}


@router.get("/services", response_model=None)
async def get_services(
    request: Request, response: Response
) -> dict[str, Any] | JSONResponse:
    """返回编排器全局开关与各服务状态；纯读，不产生任何副作用。"""
    try:
        await require_config_read(request)
    except ConfigAuthError as exc:
        return config_auth_error_response(exc)

    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"

    try:
        snapshot = get_orchestrator().snapshot()
        orchestrator = snapshot.get("orchestrator", "off")
        raw_services = snapshot.get("services") or ()
        services = [
            _service_entry(item)
            for item in raw_services
            if isinstance(item, Mapping)
        ]
    except Exception:
        logger.exception("[ServicesStatus] 读取编排器快照失败")
        return JSONResponse(
            status_code=500, content={"detail": "服务状态暂时不可用"}
        )

    return {"orchestrator": orchestrator, "services": services}


async def _require_gate_write(request: Request) -> None:
    """运维闸门写授权。

    与配置写入同级只收 user token（device/service token 403；引导模式放行），
    但不做密码二次校验：闸门调用方是迁移脚本，契约只有 Bearer user token。
    该端点只改运行时状态，不落任何配置。
    """
    await require_config_read(request)


async def _run_gate(
    service_id: str, action: str
) -> dict[str, Any] | JSONResponse:
    """调用编排器闸门并返回公开 entry；错误统一映射为可读 JSON。"""
    try:
        orchestrator = get_orchestrator()
    except Exception:
        logger.exception("[ServicesStatus] 获取编排器失败")
        return JSONResponse(status_code=500, content={"detail": "服务编排器不可用"})

    if not getattr(orchestrator, "enabled", True):
        return JSONResponse(
            status_code=409,
            content={
                "detail": (
                    f"服务编排器已关闭（{ORCHESTRATOR_ENV}=off），"
                    f"无法执行 {action}"
                )
            },
        )

    try:
        handler = (
            orchestrator.pause if action == "pause" else orchestrator.resume
        )
        entry = await handler(service_id)
    except KeyError:
        return JSONResponse(
            status_code=404, content={"detail": f"未知服务：{service_id}"}
        )
    except Exception:
        logger.exception(
            "[ServicesStatus] 执行 %s(%s) 失败", action, service_id
        )
        return JSONResponse(
            status_code=500,
            content={"detail": f"服务 {action} 失败，详见后端日志"},
        )

    if not isinstance(entry, Mapping):
        return JSONResponse(
            status_code=500, content={"detail": "编排器返回了无效的服务条目"}
        )
    return _service_entry(entry)


@router.post("/services/{service_id}/pause", response_model=None)
async def pause_service(
    service_id: str, request: Request
) -> dict[str, Any] | JSONResponse:
    """运维闸门：停止并禁止自动拉起，状态变为 blocked/manually_paused。"""
    try:
        await _require_gate_write(request)
    except ConfigAuthError as exc:
        return config_auth_error_response(exc)
    return await _run_gate(service_id, "pause")


@router.post("/services/{service_id}/resume", response_model=None)
async def resume_service(
    service_id: str, request: Request
) -> dict[str, Any] | JSONResponse:
    """运维闸门：解除暂停并立即重新判定/拉起服务。"""
    try:
        await _require_gate_write(request)
    except ConfigAuthError as exc:
        return config_auth_error_response(exc)
    return await _run_gate(service_id, "resume")
