# -*- coding: utf-8 -*-
"""QQ 网关引导 HTTP API。

路由前缀 ``/api/system/onboarding/qq``，落在既有引导免拦截前缀内。

约定：

- 读取走 ``require_config_read``，校验/写入走 ``require_config_write``；
- ``/validate`` 只读，不创建密钥目录、不写配置；
- ``/config`` 先校验后写盘，失败返回 422 且零写入；
- 响应只含脱敏状态与布尔，永不返回 token 内容或 token 文件路径；
- 不启动网关，成功只标记 ``starts_after_finish``。
"""
from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from config.store import ConfigStoreError
from services import config_authz
from services import onboarding_qq

router = APIRouter(
    prefix="/api/system/onboarding/qq", tags=["qq-onboarding"]
)


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


async def _json_body(request: Request) -> Any:
    """读取原始 JSON；解析失败只返回 None，避免回显请求体。"""
    try:
        return await request.json()
    except (ValueError, UnicodeDecodeError):
        return None


@router.get("", response_model=None)
async def inspect_qq(request: Request, response: Response) -> Any:
    auth_error = await _read_auth_error(request)
    if auth_error is not None:
        return auth_error
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"
    return await run_in_threadpool(onboarding_qq.inspect_status)


@router.post("/validate", response_model=None)
async def validate_qq(request: Request) -> Any:
    body = await _json_body(request)
    auth_error = await _write_auth_error(
        request, onboarding_qq.password_from_payload(body)
    )
    if auth_error is not None:
        return auth_error
    return await run_in_threadpool(onboarding_qq.validate_qq_config, body)


@router.post("/config", response_model=None)
async def configure_qq(request: Request) -> Any:
    body = await _json_body(request)
    auth_error = await _write_auth_error(
        request, onboarding_qq.password_from_payload(body)
    )
    if auth_error is not None:
        return auth_error
    try:
        payload = await run_in_threadpool(onboarding_qq.apply_qq_config, body)
    except onboarding_qq.QQConfigInvalid as exc:
        return JSONResponse(
            status_code=422,
            content={"code": "qq_config_invalid", "errors": exc.errors},
        )
    except ConfigStoreError:
        return _error(500, "qq_config_write_failed", "QQ 网关配置写入失败")
    payload["starts_after_finish"] = True
    return payload
