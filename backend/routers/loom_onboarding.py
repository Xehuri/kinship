# -*- coding: utf-8 -*-
"""Loom 引导 HTTP API（T8）。

路由前缀 ``/api/system/onboarding/loom``，由编排器统一注册到主应用；本文件
不修改 ``main.py``，也不触碰既有 ``system_onboarding.py``。

认证沿用既有引导模式：读取/校验要求 Bearer 用户 Token；应用/重启额外要求
当前密码（无用户时的引导模式走 ``X-Setup-Token``，由 ``require_config_write``
统一裁决）。响应永不含 Loom Token 或 provider 密钥，只含发现来源与指纹。
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from services import config_authz, loom_onboarding, loom_runtime, loom_setup

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/system/onboarding/loom", tags=["loom-onboarding"]
)


class LoomPricing(BaseModel):
    input: float = 0
    output: float = 0
    cacheRead: float = 0
    cacheWrite: float = 0


class LoomSelectionRequest(BaseModel):
    provider: str = Field(min_length=1, max_length=200)
    model: str = Field(min_length=1, max_length=200)
    base_url: Optional[str] = Field(default=None, max_length=2000)
    context_window: Optional[int] = Field(default=None, gt=0)
    max_output: Optional[int] = Field(default=None, gt=0)
    vision: Optional[bool] = None
    timeout: Optional[int] = Field(default=None, gt=0)
    pricing: Optional[LoomPricing] = None
    api_key: Optional[str] = Field(default=None, repr=False)

    def to_selection(self) -> loom_onboarding.Selection:
        return loom_onboarding.Selection(
            provider=self.provider,
            model=self.model,
            base_url=self.base_url,
            context_window=self.context_window,
            max_output=self.max_output,
            vision=self.vision,
            timeout=self.timeout,
            pricing=self.pricing.model_dump() if self.pricing else None,
            api_key=self.api_key,
        )


class LoomApplyRequest(LoomSelectionRequest):
    restart: bool = False
    current_password: Optional[str] = None


class LoomSetupRequest(LoomSelectionRequest):
    port: int
    current_password: Optional[str] = None


class LoomRestartRequest(BaseModel):
    current_password: Optional[str] = None


class LoomRuntimeActionRequest(BaseModel):
    current_password: Optional[str] = None


class LoomConfigEnsureRequest(LoomSelectionRequest):
    overwrite: bool = False
    credential_env: Optional[str] = Field(default=None, max_length=200)
    current_password: Optional[str] = None


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


@router.get("", response_model=None)
async def inspect_loom(request: Request) -> Any:
    auth_error = await _read_auth_error(request)
    if auth_error is not None:
        return auth_error
    return await loom_onboarding.inspect()


@router.get("/runtime", response_model=None)
async def loom_runtime_status(request: Request) -> Any:
    auth_error = await _read_auth_error(request)
    if auth_error is not None:
        return auth_error
    return await loom_runtime.status()


@router.post("/token/ensure", response_model=None)
async def ensure_loom_token(
    request: Request, body: Optional[LoomRuntimeActionRequest] = None
) -> Any:
    auth_error = await _write_auth_error(
        request, body.current_password if body else None
    )
    if auth_error is not None:
        return auth_error
    return await asyncio.to_thread(loom_runtime.ensure_token)


@router.post("/config/ensure", response_model=None)
async def ensure_loom_config(
    body: LoomConfigEnsureRequest, request: Request
) -> Any:
    auth_error = await _write_auth_error(request, body.current_password)
    if auth_error is not None:
        return auth_error
    return await asyncio.to_thread(
        loom_runtime.ensure_config,
        body.to_selection(),
        overwrite=body.overwrite,
        credential_env=body.credential_env,
    )


@router.post("/start", response_model=None)
async def start_loom(
    request: Request, body: Optional[LoomRuntimeActionRequest] = None
) -> Any:
    auth_error = await _write_auth_error(
        request, body.current_password if body else None
    )
    if auth_error is not None:
        return auth_error
    return await loom_runtime.start()


@router.post("/stop", response_model=None)
async def stop_loom(
    request: Request, body: Optional[LoomRuntimeActionRequest] = None
) -> Any:
    auth_error = await _write_auth_error(
        request, body.current_password if body else None
    )
    if auth_error is not None:
        return auth_error
    return await loom_runtime.stop()


@router.post("/setup", response_model=None)
async def setup_loom(body: LoomSetupRequest, request: Request) -> Any:
    auth_error = await _write_auth_error(request, body.current_password)
    if auth_error is not None:
        return auth_error
    try:
        return await loom_setup.setup(
            body.to_selection(), loom_setup.SetupOptions(port=body.port)
        )
    except loom_setup.SetupError as exc:
        return JSONResponse(status_code=200, content=exc.to_response())


@router.post("/validate", response_model=None)
async def validate_loom(
    body: LoomSelectionRequest, request: Request
) -> Any:
    auth_error = await _read_auth_error(request)
    if auth_error is not None:
        return auth_error
    return await loom_onboarding.validate(body.to_selection())


@router.post("/apply", response_model=None)
async def apply_loom(body: LoomApplyRequest, request: Request) -> Any:
    auth_error = await _write_auth_error(request, body.current_password)
    if auth_error is not None:
        return auth_error
    return await loom_onboarding.apply(
        body.to_selection(), restart=body.restart
    )


@router.post("/restart", response_model=None)
async def restart_loom(body: LoomRestartRequest, request: Request) -> Any:
    auth_error = await _write_auth_error(request, body.current_password)
    if auth_error is not None:
        return auth_error
    return await loom_runtime.restart()
