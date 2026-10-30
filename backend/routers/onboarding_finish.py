# -*- coding: utf-8 -*-
"""v4 完成引导 API：``GET`` 只读收口快照，``POST`` 执行合并后的 finish。

路由前缀 ``/api/system/onboarding/finish``。``GET`` 使用配置读取授权；
``POST`` 使用配置写入授权（无用户时走 setup token，已有管理员时需要
Bearer + 当前密码，密码从请求体 ``current_password`` 提取）。

``POST`` 只调用 :func:`services.onboarding_finish.run_finish`，不复制
预检/启动/激活逻辑；失败统一返回 ``FinishError.payload()``，响应中不含
令牌、密码或配置密钥。
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from services import config_authz
from services.onboarding_finish import FinishError, run_finish
from services.startup_validation import StartupValidation

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/system/onboarding/finish", tags=["system-onboarding"]
)


class FinishRequest(BaseModel):
    allow_degraded: bool = False
    current_password: Optional[str] = Field(default=None, max_length=400)


def _runtime_status(runtime: Any) -> dict[str, Any]:
    if runtime is None:
        return {"available": False}
    return {
        "available": True,
        "active": bool(getattr(runtime, "active", False)),
        "started": bool(getattr(runtime, "started", False)),
        "state": str(getattr(runtime, "state", "") or ""),
        "committed": bool(getattr(runtime, "committed", False)),
        "gate_open": not bool(getattr(runtime, "active", False)),
    }


def _startup_report(validation: Any) -> dict[str, Any]:
    if validation is None:
        return StartupValidation.empty_report()
    reader = getattr(validation, "report", None)
    if not callable(reader):
        return StartupValidation.empty_report()
    try:
        report = reader()
    except Exception:  # noqa: BLE001 - 只读快照失败时返回空报告
        logger.warning("[OnboardingFinish] 启动报告读取失败", exc_info=True)
        return StartupValidation.empty_report()
    return report if isinstance(report, dict) else StartupValidation.empty_report()


async def _read_auth(request: Request) -> Optional[JSONResponse]:
    try:
        await config_authz.require_config_read(request)
    except config_authz.ConfigAuthError as exc:
        return config_authz.config_auth_error_response(exc)
    return None


async def _write_auth(
    request: Request, password: Optional[str]
) -> Optional[JSONResponse]:
    try:
        await config_authz.require_config_write(request, password)
    except config_authz.ConfigAuthError as exc:
        return config_authz.config_auth_error_response(exc)
    return None


@router.get("", response_model=None)
async def get_finish(request: Request) -> dict[str, Any] | JSONResponse:
    auth_error = await _read_auth(request)
    if auth_error is not None:
        return auth_error
    app = request.app
    runtime = getattr(app.state, "bootstrap_runtime", None)
    validation = getattr(app.state, "startup_validation", None)
    groups = getattr(app.state, "finish_groups", None)
    activation = getattr(app.state, "finish_activation", None)
    runtime_report = None
    reader = getattr(runtime, "report", None)
    if callable(reader):
        try:
            runtime_report = reader()
        except Exception:  # noqa: BLE001 - 状态快照失败不影响读取
            logger.warning("[OnboardingFinish] 运行时报告读取失败", exc_info=True)
    payload: dict[str, Any] = {
        "runtime": _runtime_status(runtime),
        "startup": _startup_report(validation),
        "lifecycle": runtime_report,
        "groups": groups,
        "activation": activation,
        "closing": None,
    }
    payload["finish"] = {"groups": groups, "activation": activation}
    return payload


@router.post("", response_model=None)
async def post_finish(body: FinishRequest, request: Request) -> Any:
    auth_error = await _write_auth(request, body.current_password)
    if auth_error is not None:
        return auth_error
    try:
        return await run_finish(
            request.app, allow_degraded=bool(body.allow_degraded)
        )
    except FinishError as exc:
        return JSONResponse(status_code=exc.status_code, content=exc.payload())
