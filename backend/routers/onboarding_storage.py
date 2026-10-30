# -*- coding: utf-8 -*-
"""Onboarding storage selection API (Wave 3 T16).

``GET /api/system/onboarding/storage`` returns the read-only snapshot built by
``services.storage_layout``. ``POST`` validates and saves an absolute
``models.dir`` through the live ``ConfigStore`` after config-write auth.

The router never creates directories, never migrates or deletes caches and
never accepts ``data.root``; only ``models.dir`` is written.
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ValidationError
from starlette.concurrency import run_in_threadpool

from config.store import (
    ConfigEnvLocked,
    ConfigReadOnly,
    ConfigRevisionConflict,
    ConfigStoreError,
    ConfigValidationError,
    ConfigWriteError,
    get_config_store,
)
from services import config_authz, storage_layout

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/system/onboarding/storage", tags=["system-onboarding"]
)


class StorageSaveRequest(BaseModel):
    models_dir: str
    password: str | None = None
    current_password: str | None = None

    @property
    def effective_password(self) -> str | None:
        return self.password or self.current_password


def _error(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status_code, content={"code": code, "message": message}
    )


async def _read_auth(request: Request) -> JSONResponse | None:
    try:
        await config_authz.require_config_read(request)
    except config_authz.ConfigAuthError as exc:
        return config_authz.config_auth_error_response(exc)
    return None


async def _write_auth(
    request: Request, password: str | None
) -> JSONResponse | None:
    try:
        await config_authz.require_config_write(request, password)
    except config_authz.ConfigAuthError as exc:
        return config_authz.config_auth_error_response(exc)
    return None


async def _json_object(
    request: Request,
) -> tuple[dict[str, Any] | None, JSONResponse | None]:
    try:
        payload = await request.json()
    except (ValueError, UnicodeDecodeError):
        return None, _error(400, "invalid_json", "请求体必须是 JSON")
    if not isinstance(payload, dict):
        return None, _error(422, "invalid_request", "请求体必须是 JSON 对象")
    return payload, None


def _config_error(exc: ConfigStoreError) -> JSONResponse:
    if isinstance(exc, ConfigValidationError):
        return _error(422, exc.code, exc.message)
    if isinstance(exc, ConfigRevisionConflict):
        return JSONResponse(
            status_code=409,
            content={
                "code": exc.code,
                "message": exc.message,
                "current_revision": exc.current_revision,
            },
        )
    if isinstance(exc, ConfigEnvLocked):
        return JSONResponse(
            status_code=409,
            content={
                "code": exc.code,
                "message": exc.message,
                "paths": list(exc.paths),
            },
        )
    if isinstance(exc, ConfigReadOnly):
        return _error(409, exc.code, exc.message)
    if isinstance(exc, ConfigWriteError):
        return _error(500, exc.code, exc.message)
    return _error(500, exc.code or "config_error", exc.message)


@router.get("", response_model=None)
async def get_storage(request: Request) -> dict[str, Any] | JSONResponse:
    auth_error = await _read_auth(request)
    if auth_error is not None:
        return auth_error
    try:
        return storage_layout.snapshot()
    except Exception:
        logger.exception("onboarding storage snapshot failed")
        return _error(500, "storage_snapshot_failed", "读取模型存储信息失败")


@router.post("", response_model=None)
async def save_storage(request: Request) -> dict[str, Any] | JSONResponse:
    payload, body_error = await _json_object(request)
    if body_error is not None:
        return body_error
    if payload is None:
        return _error(422, "invalid_request", "请求体必须是 JSON 对象")
    try:
        body = StorageSaveRequest.model_validate(payload)
    except ValidationError as exc:
        return _error(422, "invalid_request", f"models_dir 无效：{exc.errors()[0]}")

    auth_error = await _write_auth(request, body.effective_password)
    if auth_error is not None:
        return auth_error

    target, path_error = storage_layout.validate_models_dir(body.models_dir)
    if path_error is not None:
        return _error(422, path_error.code, path_error.message)
    assert target is not None

    try:
        store = get_config_store()
        outcome = await run_in_threadpool(
            store.save, {"models.dir": str(target)}
        )
        await store.apply(outcome.change)
    except ConfigStoreError as exc:
        return _config_error(exc)

    try:
        snapshot = storage_layout.snapshot()
    except Exception:
        logger.exception("onboarding storage snapshot failed after save")
        return _error(500, "storage_snapshot_failed", "读取模型存储信息失败")
    return snapshot
