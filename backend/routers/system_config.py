# -*- coding: utf-8 -*-
"""系统配置 HTTP API（N13）。

冻结契约（与前端 N15 对齐）：``/api/system/config`` 读快照/schema/状态，
``validate`` 只校验，``PUT`` 走 ConfigStore 热写 + 应用器，``restart`` 仅作为
部署接线变更的兼容拒绝端点。错误信封统一为 ``{code, message, errors?}``；
GET 一律经 ``masked_config()``，响应与日志都不出现明文密钥。
"""
from __future__ import annotations

# allow: SIZE_OK - N13 冻结为单一 API 面（4 请求模型 + 6 端点 + 错误映射），拆分即改任务契约

import copy
import re
from collections.abc import Iterable, Mapping
from typing import Any

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from config.config_schema import (
    CATEGORIES,
    FIELDS,
    SCHEMA_VERSION,
    ConfigField,
    SchemaError,
    apply_strategy_for_path,
    get_field,
    has_blocking_errors,
    validate_changes,
)
from config.store import (
    REPO_ROOT,
    ConfigEnvLocked,
    ConfigReadOnly,
    ConfigRevisionConflict,
    ConfigStore,
    ConfigStoreError,
    ConfigValidationError,
    ConfigWriteError,
    get_config_store,
)
from core.redaction import is_secret_path, redact_text, redact_value
from services.config_authz import (
    ConfigAuthError,
    config_auth_error_response,
    require_config_read,
    require_config_write,
)
from services.config_reconciler import apply_staged

DEPLOYMENT_COMMAND = "sudo systemctl restart axeuh-health"

# 旧 OpenCode 运行配置继续由后端兼容读取，但不再暴露在系统配置界面。
_HIDDEN_CONFIG_TOP_LEVELS = frozenset({"opencode"})
_HIDDEN_CONFIG_PATHS = frozenset(
    {
        "features.opencode_mock_enabled",
        "launcher.opencode_cmd",
    }
)

router = APIRouter(prefix="/api/system", tags=["system-config"])
draft_router = APIRouter(prefix="/api/config", tags=["config-draft"])


class ValidateRequest(BaseModel):
    changes: dict[str, Any] = Field(default_factory=dict)
    clear_keys: list[str] | None = None


class SaveConfigRequest(BaseModel):
    revision: str
    current_password: str | None = None
    changes: dict[str, Any] = Field(default_factory=dict)
    clear_keys: list[str] | None = None
    dry_run: bool = False


class RestartRequest(BaseModel):
    revision: str
    current_password: str | None = None


class DraftStageRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    changes: dict[str, Any] = Field(default_factory=dict)
    clear_keys: list[str] | None = None
    current_password: str | None = None


class DraftActionRequest(BaseModel):
    current_password: str | None = None


class DraftApplyRequest(BaseModel):
    paths: list[str] | None = None
    current_password: str | None = None


# ── 响应工具 ────────────────────────────────────────────────


def _error(
    status_code: int,
    code: str,
    message: str,
    errors: list[dict[str, Any]] | None = None,
) -> JSONResponse:
    content: dict[str, Any] = {"code": code, "message": message}
    if errors is not None:
        content["errors"] = errors
    return JSONResponse(status_code=status_code, content=content)


def _no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"


def _schema_errors(errors: Iterable[SchemaError]) -> list[dict[str, Any]]:
    return [
        {
            "path": error.path,
            "code": error.code,
            "message": error.message,
            "severity": error.severity,
        }
        for error in errors
    ]


def _warnings(store: ConfigStore | None = None) -> list[dict[str, Any]]:
    try:
        target = store if store is not None else get_config_store()
        return _schema_errors(target.warnings)
    except Exception:
        return []


def _degraded(store: ConfigStore | None = None) -> list[str]:
    try:
        target = store if store is not None else get_config_store()
        return [str(reason) for reason in target.degraded]
    except Exception:
        return []


def _apply_failures(store: ConfigStore | None = None) -> dict[str, str]:
    try:
        target = store if store is not None else get_config_store()
        return {
            str(name): redact_text(str(detail))
            for name, detail in target.apply_failures.items()
        }
    except Exception:
        return {}


def _revision(store: ConfigStore) -> str:
    try:
        return str(store.revision)
    except Exception:
        return "unknown"


def _provider_payload(store: ConfigStore) -> dict[str, Any]:
    try:
        info = store.provider_info()
    except Exception:
        return {
            "kind": "unknown",
            "location": "unknown",
            "writable": False,
            "detail": "provider_info_failed",
        }
    return {
        "kind": str(info.kind),
        "location": str(info.location),
        "writable": bool(info.writable),
        "detail": str(info.detail),
    }


def _pending_flags(store: ConfigStore) -> tuple[bool, int]:
    """只读待应用计数；草稿不可读时降级为无待应用项。"""
    try:
        pending = store.pending()
    except Exception:
        return False, 0
    if not isinstance(pending, Mapping):
        return False, 0
    count = len(pending)
    return count > 0, count


def _field_payload(field: ConfigField) -> dict[str, Any]:
    return {
        "path": field.path,
        "type": field.type,
        "default": field.default,
        "enum": list(field.enum),
        "min": field.min,
        "max": field.max,
        "sensitive": field.sensitive,
        "apply_strategy": field.apply_strategy,
        "category": field.category,
        "title": field.title,
        "help": field.help,
        "deprecated": field.deprecated,
        "advanced": field.advanced,
        "core": field.core,
    }


def _visible_config_field(field: ConfigField) -> bool:
    if field.path.split(".", 1)[0] in _HIDDEN_CONFIG_TOP_LEVELS:
        return False
    return field.path not in _HIDDEN_CONFIG_PATHS


def _public_field_payload(field: ConfigField) -> dict[str, Any]:
    payload = _field_payload(field)
    if field.path == "ai_backend":
        payload["enum"] = ["loom"]
        payload["default"] = "loom"
        payload["help"] = "助手通道：loom。"
    return payload


def _drop_path(document: dict[str, Any], path: str) -> None:
    parts = path.split(".")
    node: Any = document
    for part in parts[:-1]:
        if not isinstance(node, dict):
            return
        node = node.get(part)
    if isinstance(node, dict):
        node.pop(parts[-1], None)


def _public_config(document: Mapping[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(dict(document))
    for top_level in _HIDDEN_CONFIG_TOP_LEVELS:
        result.pop(top_level, None)
    for path in _HIDDEN_CONFIG_PATHS:
        _drop_path(result, path)
    return result


# ── 变更归一化与策略拒绝 ────────────────────────────────────


def _flatten_changes(
    changes: Mapping[str, Any], prefix: str = ""
) -> dict[str, Any]:
    """把嵌套字典便利写法展开为点分路径；已知路径的 mapping 留给校验报类型错误。"""
    normalized: dict[str, Any] = {}
    for key, value in changes.items():
        path = f"{prefix}.{key}" if prefix else str(key)
        if isinstance(value, Mapping) and value and get_field(path) is None:
            normalized.update(_flatten_changes(value, path))
        else:
            normalized[path] = value
    return normalized


def _reject_non_hot(
    paths: Iterable[str], *, allow_deprecated_clear: bool = False
) -> JSONResponse | None:
    deployment: list[str] = []
    unsupported: list[str] = []
    seen: set[str] = set()
    for path in paths:
        if path in seen:
            continue
        seen.add(path)
        match apply_strategy_for_path(path):
            case "deployment":
                deployment.append(path)
            case "none" if allow_deprecated_clear:
                continue
            case "none":
                unsupported.append(path)
            case _:
                pass

    if deployment:
        errors = [
            SchemaError(
                path,
                "deployment_required",
                f"{path} 属于部署接线配置，无法热更新",
            )
            for path in deployment
        ]
        return JSONResponse(
            status_code=409,
            content={
                "code": "deployment_required",
                "message": (
                    "以下配置由部署接线决定，热更新不可用："
                    + "、".join(deployment)
                ),
                "command": DEPLOYMENT_COMMAND,
                "errors": _schema_errors(errors),
            },
        )
    if unsupported:
        errors = [
            SchemaError(
                path,
                "apply_strategy_none",
                f"{path} 不支持写入（已废弃或不可配置）",
            )
            for path in unsupported
        ]
        return _error(
            422,
            "unsupported_change",
            "以下配置项不支持写入：" + "、".join(unsupported),
            _schema_errors(errors),
        )
    return None


def _validate(
    store: ConfigStore,
    changes: Mapping[str, Any],
    clear_keys: list[str],
) -> tuple[dict[str, Any], dict[str, Any], list[SchemaError]]:
    current = store.base_document()
    merged, errors = validate_changes(
        current,
        dict(changes),
        list(clear_keys) if clear_keys else None,
        project_root=REPO_ROOT,
        strict=False,
    )
    return current, merged, errors


def _validation_warnings(errors: Iterable[SchemaError]) -> list[dict[str, Any]]:
    return _schema_errors(
        error for error in errors if error.severity == "warning"
    )


# ── 只读端点 ────────────────────────────────────────────────


def _config_payload(store: ConfigStore) -> dict[str, Any]:
    provider = _provider_payload(store)
    has_pending, pending_count = _pending_flags(store)
    return {
        "revision": _revision(store),
        "path": provider["location"],
        "provider": provider,
        "config": _public_config(store.masked_config()),
        "degraded": _degraded(store),
        "warnings": _warnings(store),
        "apply_failures": _apply_failures(store),
        "schema_version": str(SCHEMA_VERSION),
        "has_pending": has_pending,
        "pending_count": pending_count,
    }


@router.get("/config", response_model=None)
async def get_config(
    request: Request, response: Response
) -> dict[str, Any] | JSONResponse:
    try:
        await require_config_read(request)
    except ConfigAuthError as exc:
        return config_auth_error_response(exc)

    _no_store(response)
    return _config_payload(get_config_store())


@router.get("/config/schema", response_model=None)
async def get_config_schema(
    request: Request, response: Response
) -> dict[str, Any] | JSONResponse:
    try:
        await require_config_read(request)
    except ConfigAuthError as exc:
        return config_auth_error_response(exc)

    _no_store(response)
    return {
        "schema_version": str(SCHEMA_VERSION),
        "categories": [dict(category) for category in CATEGORIES],
        "fields": [
            _public_field_payload(field)
            for field in FIELDS
            if _visible_config_field(field)
        ],
    }


@router.get("/config/status", response_model=None)
async def get_config_status(
    request: Request, response: Response
) -> dict[str, Any] | JSONResponse:
    try:
        await require_config_read(request)
    except ConfigAuthError as exc:
        return config_auth_error_response(exc)

    _no_store(response)
    store = get_config_store()
    provider = _provider_payload(store)
    return {
        "revision": _revision(store),
        "path": provider["location"],
        "provider": provider,
        "degraded": _degraded(store),
        "warnings": _warnings(store),
        "apply_failures": _apply_failures(store),
    }


# ── 校验 / 保存 ─────────────────────────────────────────────


@router.post("/config/validate", response_model=None)
async def validate_config(
    body: ValidateRequest,
    request: Request,
    response: Response,
) -> dict[str, Any] | JSONResponse:
    try:
        await require_config_read(request)
    except ConfigAuthError as exc:
        return config_auth_error_response(exc)

    _no_store(response)
    store = get_config_store()
    changes = _flatten_changes(body.changes)
    clear_keys = list(body.clear_keys or ())
    _current, _merged, errors = _validate(store, changes, clear_keys)
    if has_blocking_errors(errors):
        return _error(
            422,
            "validation_failed",
            f"配置校验失败：{len(errors)} 项问题",
            _schema_errors(errors),
        )
    return {"ok": True, "warnings": _validation_warnings(errors)}


@router.put("/config", response_model=None)
async def save_config(
    request: Request,
    body: SaveConfigRequest,
) -> dict[str, Any] | JSONResponse:
    try:
        await require_config_write(request, body.current_password)
    except ConfigAuthError as exc:
        return config_auth_error_response(exc)

    changes = _flatten_changes(body.changes)
    clear_keys = list(body.clear_keys or ())
    rejection = _reject_non_hot(changes)
    if rejection is None:
        rejection = _reject_non_hot(
            clear_keys, allow_deprecated_clear=True
        )
    if rejection is not None:
        return rejection

    store = get_config_store()
    if body.dry_run:
        current, merged, errors = _validate(store, changes, clear_keys)
        if has_blocking_errors(errors):
            return _error(
                422,
                "validation_failed",
                f"配置校验失败：{len(errors)} 项问题",
                _schema_errors(errors),
            )
        return {
            "ok": True,
            "revision": _revision(store),
            "changed": list(ConfigStore.changed_paths(current, merged)),
            "applied": [],
            "failed": {},
            "degraded": _degraded(store),
            "warnings": _validation_warnings(errors),
            "dry_run": True,
        }

    try:
        outcome = store.save(
            changes,
            clear_keys,
            expected_revision=body.revision,
        )
    except ConfigValidationError as exc:
        return _error(
            422, exc.code, exc.message, _schema_errors(exc.errors)
        )
    except ConfigRevisionConflict as exc:
        return JSONResponse(
            status_code=409,
            content={
                "code": exc.code,
                "message": exc.message,
                "current_revision": exc.current_revision,
            },
        )
    except ConfigEnvLocked as exc:
        return JSONResponse(
            status_code=409,
            content={
                "code": exc.code,
                "message": exc.message,
                "paths": list(exc.paths),
                "errors": _schema_errors(exc.errors),
            },
        )
    except ConfigReadOnly as exc:
        return _error(409, exc.code, exc.message)
    except ConfigWriteError as exc:
        return _error(500, exc.code, exc.message)
    except ConfigStoreError as exc:
        return _error(
            500,
            exc.code or "config_error",
            exc.message,
            _schema_errors(exc.errors),
        )

    report = await store.apply(outcome.change)
    return {
        "ok": True,
        "revision": outcome.revision,
        "changed": list(outcome.change.changed_paths),
        "applied": list(report.applied),
        "failed": dict(report.failed),
        "degraded": _degraded(store),
        "warnings": _schema_errors(outcome.warnings),
        "dry_run": False,
    }


@router.post("/config/restart", response_model=None)
async def restart_config(
    request: Request,
    body: RestartRequest,
) -> JSONResponse:
    try:
        await require_config_write(request, body.current_password)
    except ConfigAuthError as exc:
        return config_auth_error_response(exc)
    return JSONResponse(
        status_code=409,
        content={
            "code": "deployment_required",
            "message": "配置已热生效；监听/部署接线变更请按命令操作",
            "command": DEPLOYMENT_COMMAND,
        },
    )


# ── 草稿层端点（/api/config/*） ─────────────────────────────


def _draft_store_error(exc: ConfigStoreError) -> JSONResponse:
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
                "errors": _schema_errors(exc.errors),
            },
        )
    if isinstance(exc, (ConfigValidationError, ConfigReadOnly)):
        return _error(
            409,
            exc.code,
            exc.message,
            _schema_errors(exc.errors) if exc.errors else None,
        )
    return _error(
        500,
        exc.code or "config_error",
        exc.message,
        _schema_errors(exc.errors) if exc.errors else None,
    )


def _staged_revision(store: ConfigStore) -> str | None:
    try:
        value = store.staged_revision
    except Exception:
        return None
    return str(value) if value else None


_SECRET_PATH_PARTS = ("token", "password", "secret", "key")
_URL_USERINFO_RE = re.compile(
    r"(?i)\b([a-z][a-z0-9+.-]*://)([^/@\s]+)@"
)


def _is_secret_pending_path(path: str) -> bool:
    field = get_field(path)
    if field is not None and field.sensitive:
        return True
    if is_secret_path(path):
        return True
    return any(
        part.lower().endswith(_SECRET_PATH_PARTS) for part in path.split(".")
    )


def _mask_pending_value(path: str, value: Any) -> Any:
    if _is_secret_pending_path(path):
        return "***" if value is not None and value != "" else value
    masked = redact_value(value)
    if isinstance(masked, str):
        return _URL_USERINFO_RE.sub(r"\1***@", masked)
    return masked


def _pending_changes(
    pending: Mapping[str, Mapping[str, Any]],
) -> tuple[list[dict[str, Any]], list[str]]:
    changes: list[dict[str, Any]] = []
    unknown: list[str] = []
    for path in sorted(pending):
        change = pending[path]
        strategy = apply_strategy_for_path(path)
        if strategy is None:
            unknown.append(path)
            continue
        changes.append(
            {
                "path": path,
                "from": _mask_pending_value(path, change.get("from")),
                "to": _mask_pending_value(path, change.get("to")),
                "strategy": strategy,
                "requires_restart": strategy == "deployment",
            }
        )
    return changes, unknown


def _unknown_pending_response(paths: list[str]) -> JSONResponse:
    errors = [
        SchemaError(path, "unknown_key", f"{path} 不是已知配置项")
        for path in paths
    ]
    return JSONResponse(
        status_code=409,
        content={
            "code": "unknown_config_paths",
            "message": "草稿包含未识别的配置路径：" + "、".join(paths),
            "paths": list(paths),
            "errors": _schema_errors(errors),
        },
    )


def _mask_pending(
    pending: Mapping[str, Mapping[str, Any]],
) -> dict[str, Any]:
    masked: dict[str, Any] = {}
    for path, change in pending.items():
        masked[path] = {
            "from": _mask_pending_value(path, change.get("from")),
            "to": _mask_pending_value(path, change.get("to")),
        }
    return masked


def _request_password(request: Request) -> str | None:
    return request.headers.get("X-Config-Password") or None


def _draft_changes(body: DraftStageRequest) -> dict[str, Any]:
    changes = _flatten_changes(body.changes)
    if changes:
        return changes
    extras = dict(body.model_extra or {})
    for key in ("changes", "clear_keys", "current_password"):
        extras.pop(key, None)
    return _flatten_changes(extras)


@draft_router.post("/draft", response_model=None)
async def stage_config_draft(
    request: Request,
    body: DraftStageRequest,
) -> dict[str, Any] | JSONResponse:
    try:
        await require_config_write(request, body.current_password)
    except ConfigAuthError as exc:
        return config_auth_error_response(exc)

    store = get_config_store()
    try:
        diff = store.stage(
            _draft_changes(body),
            list(body.clear_keys or ()),
        )
    except ConfigStoreError as exc:
        return _draft_store_error(exc)
    return {
        "ok": True,
        "revision": _revision(store),
        "staged_revision": _staged_revision(store),
        "changes": _mask_pending(diff),
        "count": len(diff),
    }


@draft_router.get("/pending", response_model=None)
async def get_config_pending(
    request: Request,
    response: Response,
) -> dict[str, Any] | JSONResponse:
    try:
        await require_config_write(request, _request_password(request))
    except ConfigAuthError as exc:
        return config_auth_error_response(exc)

    _no_store(response)
    store = get_config_store()
    changes, unknown = _pending_changes(store.pending())
    if unknown:
        return _unknown_pending_response(unknown)
    return {
        "revision": _revision(store),
        "staged_revision": _staged_revision(store),
        "changes": changes,
        "count": len(changes),
    }


@draft_router.get("", response_model=None)
async def get_config_root(
    request: Request,
    response: Response,
) -> dict[str, Any] | JSONResponse:
    """``/api/config`` 只读别名，与 ``/api/system/config`` 响应同构。"""
    try:
        await require_config_read(request)
    except ConfigAuthError as exc:
        return config_auth_error_response(exc)

    _no_store(response)
    return _config_payload(get_config_store())


@draft_router.post("/discard", response_model=None)
async def discard_config_draft(
    request: Request,
    body: DraftActionRequest | None = None,
) -> dict[str, Any] | JSONResponse:
    password = (
        body.current_password if body is not None else None
    ) or _request_password(request)
    try:
        await require_config_write(request, password)
    except ConfigAuthError as exc:
        return config_auth_error_response(exc)

    store = get_config_store()
    try:
        store.discard()
    except ConfigStoreError as exc:
        return _draft_store_error(exc)
    return {"ok": True, "count": 0}


@draft_router.post("/apply", response_model=None)
async def apply_config_draft(
    request: Request,
    body: DraftApplyRequest | None = None,
) -> dict[str, Any] | JSONResponse:
    password = (
        body.current_password if body is not None else None
    ) or _request_password(request)
    try:
        await require_config_write(request, password)
    except ConfigAuthError as exc:
        return config_auth_error_response(exc)

    store = get_config_store()
    try:
        result = await apply_staged(
            store, body.paths if body is not None else None
        )
    except ConfigStoreError as exc:
        return _draft_store_error(exc)
    applied = list(result["applied"])
    return {
        "ok": True,
        "revision": _revision(store),
        "changes": applied,
        "applied": applied,
        "failed": list(result["failed"]),
        "deferred_restart": list(result["deferred_restart"]),
        "partial": bool(result["partial"]),
        "staged_revision": _staged_revision(store),
    }


@draft_router.post("/apply/retry", response_model=None)
async def retry_config_apply(
    request: Request,
    body: DraftApplyRequest | None = None,
) -> dict[str, Any] | JSONResponse:
    """重跑仍留在草稿里的失败项；已成功项已清出草稿，不会被重复执行。"""
    password = (
        body.current_password if body is not None else None
    ) or _request_password(request)
    try:
        await require_config_write(request, password)
    except ConfigAuthError as exc:
        return config_auth_error_response(exc)

    store = get_config_store()
    try:
        result = await apply_staged(
            store, body.paths if body is not None else None
        )
    except ConfigStoreError as exc:
        return _draft_store_error(exc)
    applied = list(result["applied"])
    return {
        "ok": True,
        "revision": _revision(store),
        "changes": applied,
        "applied": applied,
        "failed": list(result["failed"]),
        "deferred_restart": list(result["deferred_restart"]),
        "partial": bool(result["partial"]),
        "staged_revision": _staged_revision(store),
    }
