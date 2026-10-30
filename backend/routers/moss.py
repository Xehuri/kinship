# -*- coding: utf-8 -*-
"""MOSS 引导 HTTP API：只托管 enabled / base_url / model 三项配置。

约定：

- 读取走 ``require_config_read``，写入走 ``require_config_write``；
- 写入沿用常规密码（bootstrap 模式使用 ``X-Setup-Token``）；
- 只读写配置，不探测网络、不启停任何服务或 systemd 单元；
- 写入时顺带清除旧版的 ``moss.manage_units`` 遗留键；
- 响应只含生效配置与 ``starts_after_finish``，永不返回凭证。
"""
from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any, Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, StrictBool, ValidationError
from starlette.concurrency import run_in_threadpool

from config.config import get_config
from config.store import ConfigStoreError, get_config_store
from services import config_authz, moss_probe

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/system/onboarding/moss", tags=["moss-onboarding"]
)

LEGACY_MANAGE_UNITS_KEY = "moss.manage_units"


class MossConfigPayload(BaseModel):
    model_config = ConfigDict(extra="ignore", frozen=True)

    enabled: StrictBool | None = None
    base_url: str | None = None
    model: str | None = None


def _err(field: str, message: str) -> dict[str, str]:
    return {"field": field, "message": message}


def _invalid(errors: list[dict[str, str]]) -> JSONResponse:
    return JSONResponse(
        status_code=422,
        content={"code": "moss_config_invalid", "errors": errors},
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


def _password_from_payload(raw: Any) -> Optional[str]:
    if not isinstance(raw, Mapping):
        return None
    value = raw.get("current_password")
    return value if isinstance(value, str) else None


def _current_payload() -> dict[str, Any]:
    cfg = get_config()
    return {
        "enabled": bool(cfg.MOSS_ENABLED),
        "base_url": cfg.MOSS_BASE_URL,
        "model": cfg.MOSS_MODEL,
    }


def _parse_payload(
    raw: Any,
) -> tuple[Optional[MossConfigPayload], list[dict[str, str]]]:
    if not isinstance(raw, Mapping):
        return None, [_err("body", "请求体必须是 JSON 对象")]
    try:
        parsed = MossConfigPayload.model_validate(dict(raw))
    except ValidationError as exc:
        errors = [
            _err(
                ".".join(str(part) for part in item.get("loc") or ()) or "body",
                "参数类型无效",
            )
            for item in exc.errors()
        ]
        return None, errors
    return parsed, []


def _prepare_changes(
    payload: MossConfigPayload,
) -> tuple[Optional[dict[str, Any]], list[dict[str, str]]]:
    """合并当前值并校验 URL/模型；返回可直接落盘的三个键。"""
    current = _current_payload()
    enabled = (
        payload.enabled if payload.enabled is not None else current["enabled"]
    )
    raw_base = payload.base_url if payload.base_url is not None else current["base_url"]
    raw_model = payload.model if payload.model is not None else current["model"]

    errors: list[dict[str, str]] = []
    normalized, _loopback, url_error = moss_probe.normalise_base_url(
        str(raw_base or "")
    )
    if url_error is not None:
        errors.append(_err("base_url", url_error["message"]))
    model = str(raw_model or "").strip()
    if not model:
        errors.append(_err("model", "MOSS 模型名不能为空"))
    if errors:
        return None, errors
    return {
        "moss.enabled": bool(enabled),
        "moss.base_url": normalized,
        "moss.model": model,
    }, []


def _legacy_keys() -> list[str]:
    """旧版 ``moss.manage_units`` 仍存在时才清除，避免未知键告警。"""
    section = get_config_store().snapshot().get("moss")
    if isinstance(section, Mapping) and "manage_units" in section:
        return [LEGACY_MANAGE_UNITS_KEY]
    return []


@router.get("", response_model=None)
async def inspect_moss(request: Request) -> Any:
    auth_error = await _read_auth_error(request)
    if auth_error is not None:
        return auth_error
    return _current_payload()


@router.post("/config", response_model=None)
async def configure_moss(request: Request) -> Any:
    raw = await _json_body(request)
    auth_error = await _write_auth_error(request, _password_from_payload(raw))
    if auth_error is not None:
        return auth_error

    payload, errors = _parse_payload(raw)
    if payload is None:
        return _invalid(errors)
    changes, errors = _prepare_changes(payload)
    if changes is None:
        return _invalid(errors)

    def _save() -> None:
        get_config_store().save(changes, _legacy_keys() or None)

    try:
        await run_in_threadpool(_save)
    except ConfigStoreError:
        logger.warning("[MossOnboarding] 配置写入失败")
        return JSONResponse(
            status_code=500,
            content={
                "code": "moss_config_write_failed",
                "message": "MOSS 配置写入失败",
            },
        )

    result = await run_in_threadpool(_current_payload)
    result["starts_after_finish"] = True
    return result
