# -*- coding: utf-8 -*-
"""Onboarding startup validation API (Wave 2 T11).

``GET`` returns the last startup report plus the live runtime status.
``POST /attempt`` starts the validation-mode service plane, ``POST /validate``
runs the read-only probes, and ``POST /abort`` stops the plane and resets the
runtime so a failed attempt can be retried.

Auth: ``GET`` and ``POST /validate`` require config-read (the probes are
read-only); ``POST /attempt`` and ``POST /abort`` require config-write because
they start and stop processes. None of these endpoints calls ``activate`` or
``commit``; the onboarding gate stays closed until the existing finish flow
calls ``BootstrapRuntime.commit``.
"""
from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from services import config_authz
from services.bootstrap_runtime import STATE_DEFERRED, BootstrapRuntime
from services.startup_validation import StartupValidation

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/system/onboarding/startup", tags=["system-onboarding"]
)


def _error(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status_code, content={"code": code, "message": message}
    )


def _runtime(request: Request) -> BootstrapRuntime | None:
    return getattr(request.app.state, "bootstrap_runtime", None)


def _validation(request: Request) -> StartupValidation | None:
    return getattr(request.app.state, "startup_validation", None)


def _runtime_status(runtime: BootstrapRuntime | None) -> dict[str, Any]:
    if runtime is None:
        return {"available": False}
    return {
        "available": True,
        "active": runtime.active,
        "started": runtime.started,
        "state": runtime.state,
        "committed": runtime.committed,
        "gate_open": not runtime.active,
    }


def _payload(
    request: Request, lifecycle: dict[str, Any] | None = None
) -> dict[str, Any]:
    validation = _validation(request)
    report = (
        validation.report()
        if validation is not None
        else StartupValidation.empty_report()
    )
    runtime = _runtime(request)
    payload = dict(report)
    payload["startup"] = report
    payload["runtime"] = _runtime_status(runtime)
    payload["lifecycle"] = (
        lifecycle if lifecycle is not None else (runtime.report() if runtime else None)
    )
    return payload


async def _read_auth(request: Request) -> JSONResponse | None:
    try:
        await config_authz.require_config_read(request)
    except config_authz.ConfigAuthError as exc:
        return config_authz.config_auth_error_response(exc)
    return None


async def _write_auth(
    request: Request, password: str | None = None
) -> JSONResponse | None:
    try:
        await config_authz.require_config_write(request, password)
    except config_authz.ConfigAuthError as exc:
        return config_authz.config_auth_error_response(exc)
    return None


async def _write_password(
    request: Request,
) -> tuple[str | None, JSONResponse | None]:
    try:
        raw = await request.body()
    except Exception:
        return None, None
    if not raw.strip():
        return None, None
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None, _error(400, "invalid_json", "请求体必须是 JSON")
    if payload is None:
        return None, None
    if not isinstance(payload, dict):
        return None, _error(422, "invalid_request", "请求体必须是 JSON 对象")
    password = payload.get("password")
    if password is not None and not isinstance(password, str):
        return None, _error(422, "invalid_request", "password 必须是字符串")
    return password, None


def _require_plane(
    request: Request,
) -> tuple[BootstrapRuntime | None, JSONResponse | None]:
    runtime = _runtime(request)
    if runtime is None:
        return None, _error(409, "startup_unavailable", "启动运行时不可用")
    if not runtime.active or runtime.committed:
        return None, _error(
            409, "startup_not_bootstrap", "当前不在引导模式，启动校验不可用"
        )
    return runtime, None


@router.get("", response_model=None)
async def get_startup(request: Request) -> dict[str, Any] | JSONResponse:
    auth_error = await _read_auth(request)
    if auth_error is not None:
        return auth_error
    return _payload(request)


@router.post("/attempt", response_model=None)
async def attempt_startup(request: Request) -> dict[str, Any] | JSONResponse:
    password, body_error = await _write_password(request)
    if body_error is not None:
        return body_error
    auth_error = await _write_auth(request, password)
    if auth_error is not None:
        return auth_error
    runtime, plane_error = _require_plane(request)
    if plane_error is not None:
        return plane_error
    assert runtime is not None
    lifecycle = await runtime.attempt("onboarding_startup_attempt")
    validation = _validation(request)
    if validation is not None and not lifecycle.get("idempotent"):
        validation.record_attempt(lifecycle)
    return _payload(request, lifecycle)


@router.post("/validate", response_model=None)
async def validate_startup(request: Request) -> dict[str, Any] | JSONResponse:
    auth_error = await _read_auth(request)
    if auth_error is not None:
        return auth_error
    runtime, plane_error = _require_plane(request)
    if plane_error is not None:
        return plane_error
    assert runtime is not None
    if runtime.state == STATE_DEFERRED:
        return _error(409, "startup_not_attempted", "请先调用 /attempt 启动验证平面")
    lifecycle = await runtime.validate()
    return _payload(request, lifecycle)


@router.post("/abort", response_model=None)
async def abort_startup(request: Request) -> dict[str, Any] | JSONResponse:
    password, body_error = await _write_password(request)
    if body_error is not None:
        return body_error
    auth_error = await _write_auth(request, password)
    if auth_error is not None:
        return auth_error
    runtime, plane_error = _require_plane(request)
    if plane_error is not None:
        return plane_error
    assert runtime is not None
    lifecycle = await runtime.abort("onboarding_startup_abort")
    validation = _validation(request)
    if validation is not None:
        validation.record_abort()
    return _payload(request, lifecycle)
