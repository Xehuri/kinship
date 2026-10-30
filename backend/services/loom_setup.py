# -*- coding: utf-8 -*-
"""Loom 一次性托管初始化（向导专用）。

流水线（严格顺序）：
  校验端口/供应商 → 供应商探活（/models）→ 持久化 loom.url → 补齐 AI 实例与
  Loom token → 生成 ai/.loom/config.yaml（providers[].apiKey 内联）→ 重启/启动
  Loom → health + catalog 验证 → 持久化 ai_backend=loom 与 loom.token_file。

密钥边界：api_key 只出现在 ``Selection.api_key``、请求体与 ``providers[].apiKey``；
任何响应、日志、错误 details 只含布尔/位置/错误码，绝不回显密钥或 token。
内联密钥的 provider 必须从 credentials 段删除：``${ENV_VAR}`` 无值时 Loom
加载器 fail-fast，残留引用会让整份配置加载失败。

失败边界：写完配置后任一环节失败都恢复备份（无备份则删除新建文件）、恢复
loom.url，并尽力用旧配置重启；绝不留下半写配置或已切换的 ai_backend。
"""
# allow: SIZE_OK - 单一托管初始化状态机（校验/探活/写盘/重启/回滚）不可跨文件拆分

from __future__ import annotations

import asyncio
import copy
import logging
import os
import re
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse

import aiohttp
import yaml

from config.config import Config, get_config
from config.store import ConfigStoreError, get_config_store
from services import loom_onboarding, loom_runtime

logger = logging.getLogger(__name__)

_MIN_PORT = loom_runtime.MIN_LOOM_PORT
_MAX_PORT = loom_runtime.MAX_PORT
_MAX_API_KEY = 8192
_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")
_PRICING_KEYS = ("input", "output", "cacheRead", "cacheWrite")


class SetupError(Exception):
    """一次性初始化失败：稳定错误码 + 阶段 + 字段 + 可外发 details（无密钥）。"""

    def __init__(
        self,
        code: str,
        stage: str,
        message: str,
        *,
        field: Optional[str] = None,
        details: Optional[dict[str, Any]] = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.stage = stage
        self.message = message
        self.field = field
        self.details: dict[str, Any] = dict(details or {})

    def to_response(self) -> dict[str, Any]:
        return {
            "ok": False,
            "code": self.code,
            "stage": self.stage,
            "message": self.message,
            "field": self.field,
            "details": dict(self.details),
        }


@dataclass(frozen=True)
class SetupOptions:
    """一次初始化的目标端口与超时预算（向导默认 8s 探活 / 45s 健康）。"""

    port: int
    probe_timeout: float = 8.0
    health_timeout: float = 45.0
    restart_timeout: float = 45.0


# ── 输入校验 ─────────────────────────────────────────────────


def _normalize_port(port: Any) -> int:
    if isinstance(port, bool) or not isinstance(port, int):
        raise SetupError(
            "loom_port_invalid",
            "validate",
            f"端口必须是 {_MIN_PORT}-{_MAX_PORT} 的整数",
            field="port",
            details={"min": _MIN_PORT, "max": _MAX_PORT},
        )
    if not (_MIN_PORT <= port <= _MAX_PORT):
        raise SetupError(
            "loom_port_invalid",
            "validate",
            f"端口必须在 {_MIN_PORT}-{_MAX_PORT} 之间",
            field="port",
            details={"min": _MIN_PORT, "max": _MAX_PORT},
        )
    return port


def _inline_key(doc: Optional[dict[str, Any]], provider: str) -> str:
    if not isinstance(doc, dict):
        return ""
    providers = doc.get("providers")
    if not isinstance(providers, list):
        return ""
    for item in providers:
        if isinstance(item, dict) and item.get("provider") == provider:
            value = item.get("apiKey")
            return value.strip() if isinstance(value, str) else ""
    return ""


def _normalize_selection(
    selection: loom_onboarding.Selection, doc: Optional[dict[str, Any]]
) -> loom_onboarding.Selection:
    provider = selection.provider.strip()
    if not provider or _CONTROL_CHARS.search(provider) or len(provider) > 200:
        raise SetupError(
            "loom_provider_invalid", "validate", "渠道（provider）不能为空且不能含控制字符", field="provider"
        )
    model = selection.model.strip()
    if not model or _CONTROL_CHARS.search(model) or len(model) > 200:
        raise SetupError(
            "loom_model_invalid", "validate", "主模型不能为空且不能含控制字符", field="model"
        )
    base_url = (selection.base_url or "").strip()
    parsed = urlparse(base_url)
    if not base_url or not re.match(r"^https?://", base_url) or not parsed.hostname:
        raise SetupError(
            "loom_provider_invalid",
            "validate",
            "base_url 必须是带主机名的 http:// 或 https:// 地址",
            field="base_url",
        )
    _validate_limits(selection)
    key = (selection.api_key or "").strip()
    if not key:
        key = _inline_key(doc, provider)
    if not key:
        raise SetupError(
            "loom_api_key_missing",
            "validate",
            "必须提供供应商 API Key（已有内联密钥时可留空以沿用）",
            field="api_key",
        )
    if len(key) > _MAX_API_KEY:
        raise SetupError(
            "loom_api_key_invalid", "validate", "API Key 过长", field="api_key"
        )
    return loom_onboarding.Selection(
        provider=provider,
        model=model,
        base_url=base_url,
        context_window=selection.context_window,
        max_output=selection.max_output,
        vision=selection.vision,
        timeout=selection.timeout,
        pricing=selection.pricing,
        api_key=key,
    )


def _validate_limits(selection: loom_onboarding.Selection) -> None:
    context_window = selection.context_window
    max_output = selection.max_output
    if context_window is not None and (
        isinstance(context_window, bool) or not isinstance(context_window, int)
    ):
        raise SetupError(
            "loom_model_limits_invalid", "validate", "context_window 必须是整数", field="context_window"
        )
    if max_output is not None and (
        isinstance(max_output, bool) or not isinstance(max_output, int)
    ):
        raise SetupError(
            "loom_model_limits_invalid", "validate", "max_output 必须是整数", field="max_output"
        )
    if context_window is not None and max_output is not None:
        if not loom_onboarding._sane_limits(context_window, max_output):
            raise SetupError(
                "loom_model_limits_invalid",
                "validate",
                "context_window/max_output 超出允许范围",
                field="context_window",
            )
    if selection.timeout is not None and (
        isinstance(selection.timeout, bool)
        or not isinstance(selection.timeout, int)
        or selection.timeout <= 0
    ):
        raise SetupError(
            "loom_model_limits_invalid", "validate", "timeout 必须为正整数", field="timeout"
        )
    if selection.pricing is not None:
        for key in _PRICING_KEYS:
            value = selection.pricing.get(key)
            if (
                value is None
                or isinstance(value, bool)
                or not isinstance(value, (int, float))
                or value < 0
                or value != value
                or value in (float("inf"), float("-inf"))
            ):
                raise SetupError(
                    "loom_pricing_invalid",
                    "validate",
                    f"pricing.{key} 必须是不小于 0 的数字",
                    field="pricing",
                )


# ── 供应商探活 ───────────────────────────────────────────────


def _model_ids(data: Any) -> Optional[list[str]]:
    container: Optional[list[Any]] = None
    if isinstance(data, dict):
        for key in ("data", "models"):
            value = data.get(key)
            if isinstance(value, list):
                container = value
                break
    elif isinstance(data, list):
        container = data
    if container is None:
        return None
    ids: list[str] = []
    for item in container:
        if isinstance(item, str) and item:
            ids.append(item)
        elif isinstance(item, dict) and isinstance(item.get("id"), str) and item["id"]:
            ids.append(item["id"])
    return ids


def _provider_base_candidates(base_url: str) -> list[str]:
    base = base_url.rstrip("/")
    path = urlparse(base).path.rstrip("/")
    candidates = [base]
    if not path.endswith("/v1"):
        candidates.append(f"{base}/v1")
    return candidates


async def _probe_provider(
    base_url: str, api_key: str, model_id: str, *, timeout: float
) -> tuple[list[dict[str, str]], str]:
    """探活并返回 (warnings, resolved_base_url)。

    很多 OpenAI 兼容网关把 API 挂在 ``/v1`` 下；如果用户只填了主机根地址，
    根路径 ``/models`` 可能返回 HTML 200 而不是模型 JSON。依次尝试根和 ``/v1``，
    命中 JSON 模型列表后把规范化的 base_url 写回配置，避免聊天流被 HTML 打断。
    """
    base = base_url.rstrip("/")
    last_warning: dict[str, str] | None = None
    saw_model_list = False
    for candidate in _provider_base_candidates(base):
        endpoint = f"{candidate}/models"
        try:
            status, data = await loom_onboarding._request_json(
                "GET", endpoint, api_key, timeout=timeout
            )
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as exc:
            raise SetupError(
                "loom_provider_unreachable",
                "provider_probe",
                "无法连接模型供应商端点，请检查 base_url 与网络",
                field="base_url",
                details={"reason": type(exc).__name__},
            ) from exc
        if status in (401, 403):
            raise SetupError(
                "loom_provider_auth_failed",
                "provider_probe",
                "供应商拒绝鉴权（401/403），请检查 API Key",
                field="api_key",
                details={"http_status": status},
            )
        if status in (404, 405):
            last_warning = {
                "code": "loom_provider_models_unavailable",
                "message": f"供应商未实现 GET /models（HTTP {status}），已跳过远端模型校验",
            }
            continue
        ids = _model_ids(data)
        if ids is None:
            last_warning = {
                "code": "loom_provider_models_unavailable",
                "message": "供应商 /models 未返回可解析的模型列表，已跳过远端模型校验",
            }
            continue
        saw_model_list = True
        if model_id not in ids:
            last_warning = {
                "code": "loom_model_invalid",
                "message": f"供应商模型列表中不存在 {model_id}",
            }
            continue
        if candidate != base:
            return (
                [
                    {
                        "code": "loom_provider_v1_normalized",
                        "message": f"已自动使用 OpenAI 兼容前缀 {candidate}",
                    }
                ],
                candidate,
            )
        return [], candidate
    if saw_model_list:
        raise SetupError(
            "loom_model_invalid",
            "provider_probe",
            f"供应商模型列表中不存在 {model_id}",
            field="model",
            details={"model": model_id},
        )
    return [last_warning or {
        "code": "loom_provider_models_unavailable",
        "message": "供应商 /models 未返回可解析的模型列表，已跳过远端模型校验",
    }], base


async def _assert_port_free(
    config: Config, port: int, *, timeout: float = 3.0
) -> None:
    in_use = await asyncio.to_thread(
        loom_runtime._port_in_use, port, "127.0.0.1"
    )
    if not in_use:
        return
    token, _source, _detail = loom_onboarding._resolve_token(config)
    if token:
        try:
            status, data = await loom_onboarding._request_json(
                "GET", f"{_url_for(port)}/health", token, timeout=timeout
            )
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError):
            status, data = 0, None
        if status == 200 and isinstance(data, dict) and data.get("status") == "ok":
            return
    raise SetupError(
        "loom_port_conflict",
        "port",
        f"端口 {port} 已被其他进程占用",
        field="port",
        details={"port": port},
    )


# ── 配置生成 ─────────────────────────────────────────────────


def _url_for(port: int) -> str:
    return f"http://127.0.0.1:{port}"


def _load_existing(path: Path) -> Optional[dict[str, Any]]:
    if not path.is_file():
        return None
    doc, errors = loom_onboarding._load_config_document(path)
    if errors or doc is None:
        raise SetupError(
            "loom_config_invalid",
            "config",
            "现有 Loom 配置无法解析，请先修复或移除",
            field="config_path",
            details={"errors": [item.get("code") for item in errors]},
        )
    return doc


def _base_document(
    selection: loom_onboarding.Selection, port: int, ai_root: str
) -> dict[str, Any]:
    wrapper = Config(
        {"loom": {"url": _url_for(port)}, "data": {"ai_root": str(ai_root)}}
    )
    doc, _text, errors = loom_runtime._render_template(
        selection, wrapper, credential_env=None
    )
    if errors or not isinstance(doc, dict):
        raise SetupError(
            "loom_config_write_failed",
            "config",
            "无法从模板生成 Loom 配置",
            details={"errors": [item.get("code") for item in errors]},
        )
    return doc


def _merge_document(
    doc: dict[str, Any],
    selection: loom_onboarding.Selection,
    port: int,
    ai_root: str,
) -> dict[str, Any]:
    provider = selection.provider
    model_id = selection.model
    merged = copy.deepcopy(doc)

    server = merged.get("server")
    server = dict(server) if isinstance(server, dict) else {}
    server["port"] = port
    server.setdefault("hostname", "127.0.0.1")
    merged["server"] = server
    if not isinstance(merged.get("workspace"), str) or not merged["workspace"]:
        merged["workspace"] = str(Path(ai_root).resolve())

    providers = merged.get("providers")
    if not isinstance(providers, list):
        raise SetupError(
            "loom_config_invalid", "config", "providers 段必须是数组", field="providers"
        )
    entry = next(
        (
            item
            for item in providers
            if isinstance(item, dict) and item.get("provider") == provider
        ),
        None,
    )
    if entry is None:
        entry = {"provider": provider, "baseUrl": selection.base_url}
        providers.append(entry)
    else:
        entry["baseUrl"] = selection.base_url
    entry["apiKey"] = selection.api_key

    credentials = merged.get("credentials")
    credentials = dict(credentials) if isinstance(credentials, dict) else {}
    credentials.pop(provider, None)
    merged["credentials"] = credentials

    pricing = merged.get("pricing")
    pricing = dict(pricing) if isinstance(pricing, dict) else {}
    if provider not in pricing:
        prices = selection.pricing or {}
        pricing[provider] = {
            key: float(prices.get(key, 0)) for key in _PRICING_KEYS
        }
    merged["pricing"] = pricing

    models = merged.get("models")
    models = list(models) if isinstance(models, list) else []
    existing = next(
        (item for item in models if isinstance(item, dict) and item.get("id") == model_id),
        None,
    )
    context_window = selection.context_window
    max_output = selection.max_output
    if existing is None:
        effective_context = context_window or 128000
        existing = {
            "id": model_id,
            "provider": provider,
            "contextWindow": effective_context,
            "maxOutput": max_output or min(8192, effective_context),
            "vision": bool(selection.vision) if selection.vision is not None else False,
            "timeout": selection.timeout or 600000,
        }
    else:
        existing["provider"] = provider
        effective_context = (
            context_window or existing.get("contextWindow") or 128000
        )
        existing["contextWindow"] = effective_context
        if max_output is not None:
            existing["maxOutput"] = max_output
        else:
            effective_max = existing.get("maxOutput") or 8192
            existing["maxOutput"] = min(effective_max, effective_context)
        if selection.vision is not None:
            existing["vision"] = bool(selection.vision)
        if selection.timeout is not None:
            existing["timeout"] = selection.timeout
    if not loom_onboarding._sane_limits(
        existing.get("contextWindow"), existing.get("maxOutput")
    ):
        raise SetupError(
            "loom_model_limits_invalid",
            "config",
            "context_window/max_output 超出允许范围",
            field="context_window",
        )
    if (
        isinstance(existing.get("timeout"), bool)
        or not isinstance(existing.get("timeout"), int)
        or existing["timeout"] <= 0
    ):
        existing["timeout"] = 600000
    models = [item for item in models if item is not existing]
    models.insert(0, existing)
    merged["models"] = models

    structure_errors = loom_onboarding._validate_config_structure(merged)
    if structure_errors:
        raise SetupError(
            "loom_config_invalid",
            "config",
            "生成的 Loom 配置未通过结构校验",
            details={"errors": [item.get("code") for item in structure_errors]},
        )
    return merged


def _build_document(
    existing: Optional[dict[str, Any]],
    selection: loom_onboarding.Selection,
    port: int,
    ai_root: str,
) -> dict[str, Any]:
    base = existing if existing is not None else _base_document(selection, port, ai_root)
    return _merge_document(base, selection, port, ai_root)


def _write_config(path: Path, text: str) -> Optional[Path]:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path.parent, 0o700)
    except OSError:
        pass
    backup: Optional[Path] = None
    try:
        if path.exists():
            backup = loom_onboarding._write_backup(path, mode=0o600)
        loom_onboarding._write_text_atomic(path, text, 0o600)
    except OSError as exc:
        raise SetupError(
            "loom_config_write_failed",
            "config_write",
            "写入 Loom 配置失败",
            details={"reason": type(exc).__name__},
        ) from exc
    return backup


# ── 运行时与持久化 ───────────────────────────────────────────


def _ensure_ai_instance(config: Config) -> None:
    from services import onboarding_service

    try:
        loom_runtime._ensure_ai_instance(config)
    except onboarding_service.OnboardingActionError as exc:
        raise SetupError(
            "loom_ai_instance_failed",
            "ai_instance",
            "AI 实例初始化失败",
            details={"reason": exc.code},
        ) from exc
    except OSError as exc:
        raise SetupError(
            "loom_ai_instance_failed",
            "ai_instance",
            "AI 实例初始化失败",
            details={"reason": type(exc).__name__},
        ) from exc


def _ensure_token(config: Config) -> tuple[str, Optional[str], bool]:
    state = loom_runtime._ensure_token_internal(config, persist=False)
    if not state.token:
        codes = [
            item.get("code")
            for item in state.public.get("errors") or []
            if isinstance(item, dict)
        ]
        raise SetupError(
            "loom_token_failed",
            "token",
            "无法生成或读取 Loom Token",
            details={"errors": codes},
        )
    token_file = state.public.get("token_file")
    return state.token, str(token_file) if token_file else None, bool(
        state.public.get("provisioned")
    )


def _persist_settings(changes: dict[str, Any]) -> None:
    try:
        get_config_store().save(changes)
    except ConfigStoreError as exc:
        raise SetupError(
            "loom_config_write_failed",
            "config_store",
            "无法写入后端配置（loom.url/ai_backend）",
            details={"reason": exc.code},
        ) from exc
    except OSError as exc:
        raise SetupError(
            "loom_config_write_failed",
            "config_store",
            "无法写入后端配置（loom.url/ai_backend）",
            details={"reason": type(exc).__name__},
        ) from exc


def _try_persist_settings(changes: dict[str, Any]) -> bool:
    try:
        get_config_store().save(changes)
    except (ConfigStoreError, OSError):
        return False
    return True


def _runtime_config(config: Config, url: str, token: str) -> Config:
    data = copy.deepcopy(config._data)
    loom = data.get("loom")
    loom = dict(loom) if isinstance(loom, dict) else {}
    loom["url"] = url
    loom["token"] = token
    loom["manage_config"] = True
    data["loom"] = loom
    return Config(data)


async def _wait_health(
    url: str, token: str, *, timeout: float
) -> Optional[dict[str, Any]]:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + max(timeout, 0.0)
    request_timeout = min(3.0, max(timeout, 0.1))
    while True:
        try:
            status, data = await loom_onboarding._request_json(
                "GET", f"{url}/health", token, timeout=request_timeout
            )
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError):
            status, data = 0, None
        if status == 200 and isinstance(data, dict) and data.get("status") == "ok":
            return _health_view(data)
        if loop.time() >= deadline:
            return None
        await asyncio.sleep(0.5)


def _health_view(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "status": payload.get("status"),
        "version": payload.get("version"),
        "uptime_ms": payload.get("uptimeMs"),
        "started_at": payload.get("startedAt"),
    }


async def _verify_catalog(
    url: str, token: str, model_id: str, *, timeout: float
) -> None:
    try:
        status, data = await loom_onboarding._request_json(
            "GET", f"{url}/catalog/models", token, timeout=timeout
        )
    except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as exc:
        raise SetupError(
            "loom_catalog_failed",
            "catalog",
            "无法读取 Loom 模型目录",
            details={"reason": type(exc).__name__},
        ) from exc
    models = data.get("models") if isinstance(data, dict) else None
    if status != 200 or not isinstance(models, list):
        raise SetupError(
            "loom_catalog_failed",
            "catalog",
            "Loom 模型目录不可用或格式异常",
            details={"http_status": status},
        )
    ids = {
        item["id"]
        for item in models
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }
    if model_id not in ids:
        raise SetupError(
            "loom_model_invalid",
            "catalog",
            f"Loom 模型目录中不存在 {model_id}",
            field="model",
            details={"model": model_id},
        )


async def _rollback(
    config: Config,
    path: Path,
    backup: Optional[Path],
    *,
    created: bool,
    previous_url: str,
    token: str,
    restart: bool,
) -> dict[str, Any]:
    state: dict[str, Any] = {
        "config_restored": False,
        "config_removed": False,
        "url_restored": False,
        "runtime_restarted": False,
    }
    try:
        if backup is not None:
            text = backup.read_text(encoding="utf-8")
            loom_onboarding._write_text_atomic(path, text, 0o600)
            state["config_restored"] = True
        elif created and path.exists():
            path.unlink()
            state["config_removed"] = True
    except OSError:
        pass
    if previous_url:
        state["url_restored"] = _try_persist_settings({"loom.url": previous_url})
    if restart and token:
        try:
            previous = await loom_runtime.restart(
                _runtime_config(config, previous_url, token), timeout=20.0
            )
            state["runtime_restarted"] = bool(previous.get("verified"))
        except Exception:  # 回滚是错误路径的最后清理，不能覆盖原始错误
            pass
    return state


# ── 主流水线 ─────────────────────────────────────────────────


async def setup(
    selection: loom_onboarding.Selection,
    options: SetupOptions,
    *,
    config: Optional[Config] = None,
) -> dict[str, Any]:
    """一次性托管初始化；成功返回无密钥投影，失败抛 ``SetupError``。"""
    cfg = config or get_config()
    normalized_port = _normalize_port(options.port)
    path = loom_onboarding.managed_config_path(cfg)
    existing = _load_existing(path)
    normalized = _normalize_selection(selection, existing)
    await _assert_port_free(cfg, normalized_port)

    url = _url_for(normalized_port)
    warnings, resolved_base = await _probe_provider(
        normalized.base_url or "",
        normalized.api_key or "",
        normalized.model,
        timeout=options.probe_timeout,
    )
    if resolved_base != normalized.base_url:
        normalized = replace(normalized, base_url=resolved_base)
    previous_url = str(cfg.LOOM_URL or "")
    token = ""
    token_file: Optional[str] = None
    provisioned = False
    backup: Optional[Path] = None
    created = not path.exists()
    written = False
    url_saved = False
    mode = loom_runtime.MODE_NONE

    try:
        _persist_settings({"loom.url": url})
        url_saved = True
        _ensure_ai_instance(cfg)
        token, token_file, provisioned = _ensure_token(cfg)
        doc = _build_document(existing, normalized, normalized_port, cfg.AI_ROOT)
        try:
            config_text = loom_onboarding._dump_config(doc)
        except yaml.YAMLError as exc:
            raise SetupError(
                "loom_config_write_failed",
                "config",
                "无法序列化 Loom 配置",
                details={"reason": type(exc).__name__},
            ) from exc
        backup = _write_config(path, config_text)
        written = True
        logger.info(
            "[LoomSetup] config written provider=%s model=%s port=%s",
            normalized.provider,
            normalized.model,
            normalized_port,
        )

        mode = await asyncio.to_thread(loom_runtime.detect_mode, cfg)
        if mode == loom_runtime.MODE_NONE:
            reasons = (
                await asyncio.to_thread(loom_runtime._mode_details)
            ).get("reasons") or []
            raise SetupError(
                "loom_runtime_unavailable",
                "runtime",
                "未检测到可管理的 Loom 运行时（systemd 单元与本发行版均不可用），请先安装后重试",
                details={"mode": mode, "reasons": reasons},
            )

        loop = asyncio.get_running_loop()
        deadline = loop.time() + max(options.health_timeout, 0.1)
        runtime_cfg = _runtime_config(cfg, url, token)
        restart = await loom_runtime.restart(
            runtime_cfg, timeout=max(1.0, min(options.restart_timeout, options.health_timeout))
        )
        if not restart.get("performed") or restart.get("manual_required"):
            raise SetupError(
                "loom_start_failed",
                "runtime",
                "Loom 重启未完成，请检查运行时日志",
                details={
                    "mode": mode,
                    "performed": bool(restart.get("performed")),
                    "verified": bool(restart.get("verified")),
                },
            )
        health = await _wait_health(
            url, token, timeout=max(0.0, deadline - loop.time())
        )
        if health is None:
            raise SetupError(
                "loom_health_timeout",
                "health",
                f"Loom 在 {int(options.health_timeout)} 秒内未通过健康检查",
                details={"mode": mode, "port": normalized_port},
            )
        await _verify_catalog(
            url,
            token,
            normalized.model,
            timeout=max(0.5, min(5.0, deadline - loop.time())),
        )
        settings: dict[str, Any] = {
            "ai_backend": "loom",
            "loom.url": url,
            "loom.manage_config": True,
        }
        if token_file:
            settings["loom.token_file"] = token_file
        _persist_settings(settings)
    except SetupError as exc:
        rollback = await _rollback(
            cfg,
            path,
            backup,
            created=created,
            previous_url=previous_url,
            token=token,
            restart=written and mode != loom_runtime.MODE_NONE,
        )
        if not url_saved:
            rollback["url_restored"] = True
        if provisioned and token_file:
            try:
                os.unlink(token_file)
            except OSError:
                pass
        exc.details["rollback"] = rollback
        logger.warning(
            "[LoomSetup] failed code=%s stage=%s provider=%s model=%s rolled_back=%s",
            exc.code,
            exc.stage,
            normalized.provider,
            normalized.model,
            rollback["config_restored"] or rollback["config_removed"],
        )
        raise

    logger.info(
        "[LoomSetup] completed provider=%s model=%s port=%s mode=%s catalog=ok",
        normalized.provider,
        normalized.model,
        normalized_port,
        mode,
    )
    return {
        "ok": True,
        "stage": "done",
        "url": url,
        "port": normalized_port,
        "provider": normalized.provider,
        "base_url": normalized.base_url,
        "model": normalized.model,
        "api_key_configured": True,
        "token_configured": True,
        "config_path": str(path),
        "runtime": {"mode": mode, "running": True, "health": health},
        "catalog_verified": True,
        "warnings": warnings,
    }
