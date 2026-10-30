# -*- coding: utf-8 -*-
"""小米健康云引导 HTTP API。

路由前缀 ``/api/system/onboarding/xiaomi``，落在既有引导免拦截前缀内；
``/api/health/cloud/*`` 仍由 ``OnboardingGateMiddleware`` 在引导期拦截。

与本路由的约定：

- 只写配置/运行时状态，不启动后台拉取线程，也不发起首次拉取；
- GET 走 ``require_config_read``，写入走 ``require_config_write``
  （bootstrap 用 ``X-Setup-Token``，已有管理员后需要 Bearer + 当前密码）；
- 响应只含脱敏 userid，永不返回 passToken。
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from config.config import get_config
from core.redaction import mask_secret, redact_text
from services import config_authz
from services.health_cloud_service import (
    STATE_AUTH_EXPIRED,
    get_health_cloud_service,
)

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/system/onboarding/xiaomi", tags=["xiaomi-onboarding"]
)

_PASSWORD_MAX = 400
_LP_MAX = 4000


class XiaomiConfigRequest(BaseModel):
    enabled: bool
    current_password: Optional[str] = Field(default=None, max_length=_PASSWORD_MAX)


class XiaomiQrRequest(BaseModel):
    current_password: Optional[str] = Field(default=None, max_length=_PASSWORD_MAX)


class XiaomiQrPollRequest(XiaomiQrRequest):
    lp: str = Field(min_length=1, max_length=_LP_MAX)


def _error(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status_code, content={"code": code, "message": message}
    )


async def _read_auth_error(request: Request) -> Optional[JSONResponse]:
    try:
        await config_authz.require_config_read(request)
    except config_authz.ConfigAuthError as exc:
        return config_authz.config_auth_error_response(exc)
    return None


async def _write_auth_error(
    request: Request, password: Optional[str]
) -> Optional[JSONResponse]:
    try:
        await config_authz.require_config_write(request, password)
    except config_authz.ConfigAuthError as exc:
        return config_authz.config_auth_error_response(exc)
    return None


def _redact_message(message: str) -> str:
    """脱敏通用密钥，并把当前配置里的 userid 原文替换为掩码。"""
    cleaned = redact_text(message)
    userid = str(get_config().HEALTH_CLOUD_USERID or "")
    if userid and userid in cleaned:
        cleaned = cleaned.replace(userid, mask_secret(userid))
    return cleaned


def _status_payload(service: Any) -> dict[str, Any]:
    """把服务快照收敛为引导契约：脱敏 userid，去掉时间戳/批次等运行细节。"""
    status = service.status()
    phase = str(status.get("phase") or "")
    enabled = bool(status.get("enabled"))
    configured = bool(status.get("configured"))
    present_userid = str(status.get("userid") or "")
    return {
        "enabled": enabled,
        "configured": configured,
        "phase": phase,
        "userid_masked": mask_secret(present_userid) if present_userid else "",
        "userid_configured": bool(status.get("userid_configured")),
        "region": str(status.get("region") or ""),
        "last_error": _redact_message(str(status.get("last_error") or "")),
        "needs_login": enabled and (not configured or phase == STATE_AUTH_EXPIRED),
    }


@router.get("", response_model=None)
async def inspect_xiaomi(request: Request) -> Any:
    auth_error = await _read_auth_error(request)
    if auth_error is not None:
        return auth_error
    service = get_health_cloud_service()
    return await run_in_threadpool(_status_payload, service)


@router.post("/config", response_model=None)
async def configure_xiaomi(body: XiaomiConfigRequest, request: Request) -> Any:
    auth_error = await _write_auth_error(request, body.current_password)
    if auth_error is not None:
        return auth_error
    service = get_health_cloud_service()
    await run_in_threadpool(service.set_enabled, body.enabled, start_pull=False)
    payload = await run_in_threadpool(_status_payload, service)
    payload["starts_after_finish"] = True
    return payload


@router.post("/qr", response_model=None)
async def request_xiaomi_qr(
    request: Request, body: Optional[XiaomiQrRequest] = None
) -> Any:
    auth_error = await _write_auth_error(
        request, body.current_password if body else None
    )
    if auth_error is not None:
        return auth_error
    service = get_health_cloud_service()
    try:
        payload = await run_in_threadpool(service.request_qr)
    except Exception as exc:
        message = _redact_message(f"二维码申请失败: {exc}")
        logger.warning("小米云引导二维码申请失败: %s", message)
        return _error(502, "xiaomi_qr_failed", message)
    return {
        "lp": str(payload.get("lp") or ""),
        "qr_base64": str(payload.get("qr_base64") or ""),
        "expires_in": int(payload.get("expires_in") or 0),
        "login_url": str(payload.get("login_url") or ""),
    }


@router.post("/qr/poll", response_model=None)
async def poll_xiaomi_qr(body: XiaomiQrPollRequest, request: Request) -> Any:
    auth_error = await _write_auth_error(request, body.current_password)
    if auth_error is not None:
        return auth_error
    service = get_health_cloud_service()
    try:
        result = await run_in_threadpool(
            service.poll_qr_once, body.lp, start_pull=False
        )
    except Exception as exc:
        message = _redact_message(f"扫码轮询失败: {exc}")
        logger.warning("小米云引导扫码轮询失败: %s", message)
        return _error(502, "xiaomi_qr_poll_failed", message)
    if result.get("state") != "success":
        return {"state": "waiting"}
    return {
        "state": "success",
        "userid_masked": str(result.get("user_id") or ""),
        "configured": True,
    }
