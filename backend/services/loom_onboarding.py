# -*- coding: utf-8 -*-
"""Loom 引导服务：自动发现 token、只读巡检、结构校验、受控配置写入与重启。

契约边界（T8 / D6-D8）：
  - token 只从既有来源自动发现，顺序固定：
      config.yaml ``loom.token`` > 环境变量 ``LOOM_TOKEN`` >
      ``loom.token_file``（读其中 ``LOOM_TOKEN=`` 行）> ``loom.credentials_file``。
    对外只返回 ``found/source/fingerprint``；本模块任何日志、异常、响应体都不含 token。
  - 「渠道」= Loom ``providers[]`` 条目（没有 Loom 原生 channel 键）；
    「主模型」= ``models[0]``。
  - 外部模式（``loom.manage_config=false``，默认）只做只读选择与结构校验，
    不写文件、不重启 Loom。
  - 托管模式（``loom.manage_config=true``）才允许写 ``ai/.loom/config.yaml``：
    先备份、再原子写、只在显式 restart 请求时重启；失败恢复备份并尽力重启旧配置。
  - 凭据永不写入：``credentials`` 段只允许 ``${ENV_VAR}`` 引用；本模块不改凭据段。

非显然取舍：
  - 不调用 ``LoomClient``：引导阶段 token 可能来自 ``loom.credentials_file``，
    而 ``LoomClient`` 固定使用 ``Config.LOOM_TOKEN``（不含该来源），这里需要显式 token。
  - ``POST /config/validate`` 是可选增强；404/405 时退回本地结构校验，不伪装成远端校验。
  - PyYAML ``safe_load``/``safe_dump`` 不保留注释；托管写入会正规化 YAML 文本，
    原始注释由 ``config.yaml.bak-onboarding-<ts>`` 备份保留（已在报告中标注）。
"""
# allow: SIZE_OK - 单一引导状态机（发现/巡检/校验/写入/重启/回滚）不可跨文件拆分

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import logging
import os
import re
import shutil
import signal
import subprocess
import tempfile
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse

import aiohttp
import yaml

from config.config import Config, get_config, _parse_env_file_value, _read_loom_token_file
from core.redaction import redact_text

logger = logging.getLogger(__name__)

SOURCE_CONFIG = "config"
SOURCE_ENV = "env"
SOURCE_TOKEN_FILE = "token_file"
SOURCE_CREDENTIALS_FILE = "credentials_file"
SOURCE_MISSING = "missing"

DEFAULT_SYSTEMD_UNIT = "axeuh-loom"
MANUAL_RESTART_COMMAND = "sudo systemctl restart axeuh-loom"

_MIN_CONTEXT_WINDOW = 1024
_MAX_CONTEXT_WINDOW = 10_000_000
_ENV_REF_RE = re.compile(r"^\$\{[A-Za-z_][A-Za-z0-9_]*\}$")
_PRICING_KEYS = ("input", "output", "cacheRead", "cacheWrite")


# ── 公共数据形状 ─────────────────────────────────────────────


@dataclass(frozen=True)
class TokenDiscovery:
    """可安全外发的 token 发现结果（无 token 字段，fingerprint 仅 8 位哈希前缀）。"""

    found: bool
    source: str
    fingerprint: str
    detail: str

    def public(self) -> dict[str, Any]:
        return {
            "found": self.found,
            "source": self.source,
            "fingerprint": self.fingerprint,
            "detail": self.detail,
        }


@dataclass(frozen=True)
class Selection:
    """渠道（provider）+ 主模型选择；托管模式可附带新增端点/模型参数。

    ``api_key`` 只用于一次性托管写入 ``providers[].apiKey``：``repr=False`` 保证
    它不会出现在 repr/日志里，``public()`` 也永不投影；任何响应只暴露布尔。
    """

    provider: str
    model: str
    base_url: Optional[str] = None
    context_window: Optional[int] = None
    max_output: Optional[int] = None
    vision: Optional[bool] = None
    timeout: Optional[int] = None
    pricing: Optional[dict[str, float]] = None
    api_key: Optional[str] = field(default=None, repr=False)

    def public(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "model": self.model,
            "base_url": self.base_url,
            "context_window": self.context_window,
            "max_output": self.max_output,
            "vision": self.vision,
            "timeout": self.timeout,
            "pricing": dict(self.pricing) if self.pricing else None,
        }


def fingerprint(token: str) -> str:
    """token 指纹：sha256 前 8 位，仅供 UI 区分来源，不可反推。"""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()[:8]


def managed_config_path(config: Optional[Config] = None) -> Path:
    """托管写入目标：``<ai_root>/.loom/config.yaml``（生产 = ai/.loom/config.yaml）。"""
    cfg = config or get_config()
    return Path(cfg.AI_ROOT) / ".loom" / "config.yaml"


# ── token 自动发现 ───────────────────────────────────────────


def _resolve_token(config: Config) -> tuple[str, str, str]:
    """内部发现：返回 (token, source, detail)；token 只在本函数返回值里流动。"""
    raw_config_token = str(config._section("loom").get("token") or "").strip()
    if raw_config_token:
        return raw_config_token, SOURCE_CONFIG, "loom.token"

    env_token = (os.environ.get("LOOM_TOKEN") or "").strip()
    if env_token:
        return env_token, SOURCE_ENV, "环境变量 LOOM_TOKEN"

    token_file = config.LOOM_TOKEN_FILE
    if token_file:
        token = _read_loom_token_file(token_file).strip()
        if token:
            return token, SOURCE_TOKEN_FILE, f"loom.token_file: {token_file}"

    credentials_file = config.LOOM_CREDENTIALS_FILE
    if credentials_file:
        token = _read_credentials_token(credentials_file)
        if token:
            return token, SOURCE_CREDENTIALS_FILE, f"loom.credentials_file: {credentials_file}"

    return "", SOURCE_MISSING, "未在 config/env/token_file/credentials_file 找到 LOOM_TOKEN"


def _read_credentials_token(path: str) -> str:
    """读取凭据文件中的 LOOM_TOKEN= 行；只返回 token 值，不记录文件内容。"""
    try:
        text = Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    return _parse_env_file_value(text, "LOOM_TOKEN").strip()


def discover_token(config: Optional[Config] = None) -> TokenDiscovery:
    """按固定优先级自动发现 token；返回值永不含 token。"""
    cfg = config or get_config()
    token, source, detail = _resolve_token(cfg)
    if not token:
        return TokenDiscovery(False, SOURCE_MISSING, "", detail)
    return TokenDiscovery(True, source, fingerprint(token), detail)


# ── HTTP 只读面 ─────────────────────────────────────────────


async def _request_json(
    method: str,
    url: str,
    token: str,
    *,
    json_body: Optional[dict[str, Any]] = None,
    timeout: float = 5.0,
) -> tuple[int, Any]:
    """一次 Loom HTTP 调用；Authorization 只进请求头，不进日志/返回值。"""
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if json_body is not None:
        headers["Content-Type"] = "application/json"
    async with aiohttp.ClientSession(
        timeout=aiohttp.ClientTimeout(total=timeout)
    ) as client:
        async with client.request(
            method, url, headers=headers, json=json_body
        ) as response:
            text = await response.text()
            data: Any = None
            if text:
                try:
                    data = json.loads(text)
                except json.JSONDecodeError:
                    data = text
            return response.status, data


def _safe_message(text: str, token: str = "") -> str:
    """错误摘要统一出口：先精确抹掉已知 token，再过通用脱敏。"""
    if token:
        text = text.replace(token, "***")
    return redact_text(text)[:300]


def _http_error(status: int, data: Any, token: str = "") -> dict[str, str]:
    """从 Loom 错误信封提取安全摘要；不 dump 原始 body，防止意外密钥外泄。"""
    message = ""
    if isinstance(data, dict):
        error = data.get("error")
        if isinstance(error, dict):
            candidate = error.get("message") or error.get("code")
            if isinstance(candidate, str):
                message = candidate
        elif isinstance(data.get("message"), str):
            message = data["message"]
    if not message:
        message = f"HTTP {status}"
    return {"code": "loom_http_error", "message": _safe_message(message, token)}


def _base_url(config: Config) -> str:
    return str(config.LOOM_URL or "").rstrip("/")


def _url_port(url: str) -> Optional[int]:
    """从 loom.url 取端口；只用于展示，不改变 URL 真源。"""
    try:
        parsed = urlparse(str(url or ""))
        port = parsed.port
    except ValueError:
        return None
    return port


def _managed_projection(path: Path) -> dict[str, Any]:
    """托管配置的只读投影：主模型/渠道/端点 + 密钥是否已配置（永不含密钥值）。"""
    projection: dict[str, Any] = {
        "provider": None,
        "base_url": None,
        "model": None,
        "api_key_configured": False,
    }
    if not path.is_file():
        return projection
    doc, _errors = _load_config_document(path)
    if not isinstance(doc, dict):
        return projection
    models = doc.get("models")
    primary = models[0] if isinstance(models, list) and models else None
    if isinstance(primary, dict):
        if isinstance(primary.get("provider"), str):
            projection["provider"] = primary["provider"]
        if isinstance(primary.get("id"), str):
            projection["model"] = primary["id"]
        if isinstance(primary.get("baseUrl"), str) and primary["baseUrl"]:
            projection["base_url"] = primary["baseUrl"]
    provider = projection["provider"]
    providers = doc.get("providers")
    if isinstance(providers, list) and isinstance(provider, str) and provider:
        for item in providers:
            if not isinstance(item, dict) or item.get("provider") != provider:
                continue
            if isinstance(item.get("baseUrl"), str) and item["baseUrl"]:
                projection["base_url"] = item["baseUrl"]
            inline = item.get("apiKey")
            if isinstance(inline, str) and inline.strip():
                projection["api_key_configured"] = True
            break
    credentials = doc.get("credentials")
    if (
        isinstance(credentials, dict)
        and isinstance(provider, str)
        and provider in credentials
    ):
        # env-ref 声明也算"已配置"：密钥本体由 Loom 进程环境解析，本投影不回显。
        projection["api_key_configured"] = True
    return projection


def _runtime_mode(config: Config) -> str:
    """延迟导入避免与 loom_runtime 的模块级反向依赖；只读模式探测。"""
    from services import loom_runtime

    return loom_runtime.detect_mode(config)


def _with_runtime(result: dict[str, Any]) -> dict[str, Any]:
    """补齐 GET 投影的 runtime 段：running 以可连通为准，health 用白名单快照。"""
    runtime = result.get("runtime")
    mode = runtime.get("mode") if isinstance(runtime, dict) else None
    result["runtime"] = {
        "mode": mode,
        "running": bool(result.get("reachable")),
        "health": result.get("health"),
    }
    return result


def _safe_models(payload: Any) -> list[dict[str, Any]]:
    """白名单投影 /catalog/models 条目，绝不透传未知字段。"""
    if not isinstance(payload, dict):
        return []
    raw_models = payload.get("models")
    if not isinstance(raw_models, list):
        return []
    models: list[dict[str, Any]] = []
    for item in raw_models:
        if not isinstance(item, dict):
            continue
        model_id = item.get("id")
        provider = item.get("provider")
        if not isinstance(model_id, str) or not model_id:
            continue
        if not isinstance(provider, str) or not provider:
            continue
        model: dict[str, Any] = {
            "id": model_id,
            "provider": provider,
            "contextWindow": item.get("contextWindow"),
            "maxOutput": item.get("maxOutput"),
            "vision": bool(item.get("vision", False)),
            "timeout": item.get("timeout"),
        }
        if isinstance(item.get("reasoningEffort"), str):
            model["reasoningEffort"] = item["reasoningEffort"]
        models.append(model)
    return models


def _safe_credential_refs(payload: Any) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    """只保留 `${ENV_VAR}` 引用名；任何已解析值一律丢弃并告警。"""
    refs: list[dict[str, str]] = []
    errors: list[dict[str, str]] = []
    if not isinstance(payload, dict):
        return refs, errors
    raw = payload.get("credentials")
    if not isinstance(raw, list):
        return refs, errors
    for item in raw:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        env_ref = item.get("envRef")
        if not isinstance(name, str) or not name:
            continue
        if isinstance(env_ref, str) and _ENV_REF_RE.match(env_ref):
            refs.append({"name": name, "env_ref": env_ref})
        else:
            errors.append(
                {
                    "code": "credential_ref_invalid",
                    "message": f"凭据 {name} 未返回 ${{ENV_VAR}} 引用，已丢弃",
                }
            )
    return refs, errors


def _channels(
    models: list[dict[str, Any]],
    pricing_providers: list[str],
    credentials: list[dict[str, str]],
) -> list[dict[str, Any]]:
    """渠道 = provider 条目；模型目录/计价/凭据三源并集，保持首次出现顺序。"""
    order: list[str] = []
    grouped: dict[str, list[str]] = {}
    for model in models:
        provider = model["provider"]
        if provider not in grouped:
            order.append(provider)
            grouped[provider] = []
        if model["id"] not in grouped[provider]:
            grouped[provider].append(model["id"])
    for provider in pricing_providers:
        if provider not in grouped:
            order.append(provider)
            grouped[provider] = []
    credential_refs = {item["name"]: item["env_ref"] for item in credentials}
    for name in credential_refs:
        if name not in grouped:
            order.append(name)
            grouped[name] = []
    return [
        {
            "provider": provider,
            "model_count": len(grouped[provider]),
            "models": list(grouped[provider]),
            "credential_ref": credential_refs.get(provider),
        }
        for provider in order
    ]


async def inspect(
    config: Optional[Config] = None, *, timeout: float = 5.0
) -> dict[str, Any]:
    """只读巡检：token 状态、health、catalog、config；响应不含任何密钥。"""
    cfg = config or get_config()
    discovery = discover_token(cfg)
    path = managed_config_path(cfg)
    projection = _managed_projection(path)
    result: dict[str, Any] = {
        **discovery.public(),
        "url": _base_url(cfg),
        "port": _url_port(_base_url(cfg)),
        "provider": projection["provider"],
        "base_url": projection["base_url"],
        "model": projection["model"],
        "api_key_configured": projection["api_key_configured"],
        "token_configured": discovery.found,
        "config_path": str(path),
        "runtime": {"mode": _runtime_mode(cfg), "running": False, "health": None},
        "managed": bool(cfg.LOOM_MANAGE_CONFIG),
        "reachable": False,
        "online": False,
        "health": None,
        "main_model": None,
        "models": [],
        "channels": [],
        "credentials": [],
        "config": None,
        "managed_config": {"path": str(path), "exists": path.exists()},
        "errors": [],
    }
    if not discovery.found:
        return _with_runtime(result)

    token, _source, _detail = _resolve_token(cfg)
    base = _base_url(cfg)
    try:
        status, data = await _request_json(
            "GET", f"{base}/health", token, timeout=timeout
        )
    except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as exc:
        result["errors"].append(
            {"code": "loom_unreachable", "message": _safe_message(str(exc), token)}
        )
        return _with_runtime(result)
    if status != 200:
        result["errors"].append(_http_error(status, data, token))
        return _with_runtime(result)

    result["reachable"] = True
    health = data if isinstance(data, dict) else {}
    result["online"] = health.get("status") == "ok"
    result["health"] = {
        "status": health.get("status"),
        "version": health.get("version"),
        "uptime_ms": health.get("uptimeMs"),
        "started_at": health.get("startedAt"),
    }

    try:
        catalog_status, catalog_data = await _request_json(
            "GET", f"{base}/catalog/models", token, timeout=timeout
        )
        config_status, config_data = await _request_json(
            "GET", f"{base}/config", token, timeout=timeout
        )
    except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as exc:
        result["errors"].append(
            {"code": "loom_read_failed", "message": _safe_message(str(exc), token)}
        )
        return _with_runtime(result)

    if catalog_status != 200:
        result["errors"].append(_http_error(catalog_status, catalog_data, token))
    else:
        result["models"] = _safe_models(catalog_data)
        result["main_model"] = result["models"][0] if result["models"] else None

    config_view: Optional[dict[str, Any]] = None
    credentials: list[dict[str, str]] = []
    pricing_providers: list[str] = []
    if config_status != 200:
        result["errors"].append(_http_error(config_status, config_data, token))
    else:
        raw_config = config_data if isinstance(config_data, dict) else {}
        credentials, credential_errors = _safe_credential_refs(raw_config)
        result["errors"].extend(credential_errors)
        raw_pricing = raw_config.get("pricingProviders")
        if isinstance(raw_pricing, list):
            pricing_providers = [
                item for item in raw_pricing if isinstance(item, str) and item
            ]
        config_view = {
            "workspace": raw_config.get("workspace"),
            "model_ids": raw_config.get("modelIds")
            if isinstance(raw_config.get("modelIds"), list)
            else [],
            "pricing_providers": pricing_providers,
            "effective_version_sha256": raw_config.get("effectiveVersionSha256"),
        }

    result["credentials"] = credentials
    channels = _channels(result["models"], pricing_providers, credentials)
    result["channels"] = channels
    result["providers"] = channels
    result["config"] = config_view
    return _with_runtime(result)


# ── 结构校验 ─────────────────────────────────────────────────


def _error(code: str, message: str) -> dict[str, str]:
    return {"code": code, "message": message}


def _sane_limits(context_window: Any, max_output: Any) -> bool:
    if isinstance(context_window, bool) or not isinstance(context_window, int):
        return False
    if isinstance(max_output, bool) or not isinstance(max_output, int):
        return False
    return (
        _MIN_CONTEXT_WINDOW <= context_window <= _MAX_CONTEXT_WINDOW
        and 1 <= max_output <= context_window
    )


def _selection_errors(selection: Selection) -> list[dict[str, str]]:
    errors: list[dict[str, str]] = []
    if not selection.provider.strip():
        errors.append(_error("provider_required", "必须选择渠道（provider）"))
    if not selection.model.strip():
        errors.append(_error("model_required", "必须选择主模型"))
    if selection.context_window is not None or selection.max_output is not None:
        if not _sane_limits(selection.context_window, selection.max_output):
            errors.append(
                _error(
                    "model_limits_invalid",
                    "context_window 需在 1024-10000000 之间，且 max_output 不大于 context_window",
                )
            )
    if selection.timeout is not None and selection.timeout <= 0:
        errors.append(_error("model_timeout_invalid", "timeout 必须为正整数"))
    if selection.base_url is not None and selection.base_url.strip():
        if not re.match(r"^https?://", selection.base_url.strip()):
            errors.append(
                _error("base_url_invalid", "base_url 必须以 http:// 或 https:// 开头")
            )
    if selection.pricing is not None:
        for key in _PRICING_KEYS:
            value = selection.pricing.get(key)
            if value is None or isinstance(value, bool) or not isinstance(value, (int, float)):
                errors.append(
                    _error("pricing_invalid", f"pricing.{key} 必须为不小于 0 的数字")
                )
            elif value < 0 or value != value or value in (float("inf"), float("-inf")):
                errors.append(
                    _error("pricing_invalid", f"pricing.{key} 必须为不小于 0 的数字")
                )
    return errors


def _catalog_by_id(models: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {model["id"]: model for model in models}


def _known_providers(doc: dict[str, Any], models: list[dict[str, Any]]) -> set[str]:
    providers: set[str] = {model["provider"] for model in models}
    raw_providers = doc.get("providers")
    if isinstance(raw_providers, list):
        for item in raw_providers:
            if isinstance(item, dict) and isinstance(item.get("provider"), str):
                providers.add(item["provider"])
    raw_pricing = doc.get("pricing")
    if isinstance(raw_pricing, dict):
        providers.update(str(name) for name in raw_pricing)
    return providers


def _build_candidate(
    doc: dict[str, Any],
    selection: Selection,
    catalog_models: list[dict[str, Any]],
    *,
    managed: bool,
) -> tuple[Optional[dict[str, Any]], list[dict[str, str]], list[dict[str, str]]]:
    """按选择生成候选配置；不修改入参。返回 (candidate, errors, warnings)。"""
    errors = _selection_errors(selection)
    if errors:
        return None, errors, []
    if not isinstance(doc, dict):
        return None, [_error("config_invalid", "Loom 配置顶层必须是映射")], []

    candidate = copy.deepcopy(doc)
    provider = selection.provider.strip()
    model_id = selection.model.strip()
    catalog_model = _catalog_by_id(catalog_models).get(model_id)
    warnings: list[dict[str, str]] = []

    known = _known_providers(candidate, catalog_models)
    if provider not in known and not managed:
        errors.append(
            _error("provider_not_found", f"渠道 {provider} 不在 Loom 模型目录中")
        )
    if provider not in known and managed and not (selection.base_url or "").strip():
        errors.append(
            _error("provider_base_url_required", f"新增渠道 {provider} 必须提供 base_url")
        )
        return None, errors, warnings
    if errors and not managed:
        return None, errors, warnings

    if catalog_model is None and not managed:
        errors.append(_error("model_not_found", f"模型 {model_id} 不在 Loom 模型目录中"))
    elif catalog_model is None and (
        selection.context_window is None or selection.max_output is None
    ):
        errors.append(
            _error("model_required_fields", "新增模型必须提供 context_window 与 max_output")
        )
    elif (
        catalog_model is not None
        and catalog_model["provider"] != provider
        and not managed
    ):
        errors.append(
            _error(
                "model_provider_mismatch",
                f"模型 {model_id} 属于 {catalog_model['provider']}，与所选渠道 {provider} 不一致",
            )
        )
    elif catalog_model is not None and catalog_model["provider"] != provider:
        warnings.append(
            _error(
                "model_provider_override",
                f"模型 {model_id} 在目录中属于 {catalog_model['provider']}，托管写入会改为 {provider}",
            )
        )
    if errors and not managed:
        return None, errors, warnings

    context_window = selection.context_window
    max_output = selection.max_output
    if catalog_model is not None:
        context_window = context_window or catalog_model.get("contextWindow")
        max_output = max_output or catalog_model.get("maxOutput")
    if not _sane_limits(context_window, max_output):
        errors.append(
            _error(
                "model_limits_invalid",
                "contextWindow/maxOutput 不合法：contextWindow 需为 1024-10000000，maxOutput 需为正且不大于 contextWindow",
            )
        )
    if errors:
        return None, errors, warnings
    if not managed:
        # 外部模式只校验选择；候选写入文本不存在，也不做 pricing 等写入侧约束。
        return {}, [], warnings

    providers = candidate.get("providers")
    if providers is None:
        providers = []
    if not isinstance(providers, list):
        return None, [_error("config_invalid", "providers 段必须是数组")], warnings
    provider_entry = next(
        (
            item
            for item in providers
            if isinstance(item, dict) and item.get("provider") == provider
        ),
        None,
    )
    existing_base_url = next(
        (
            item.get("baseUrl")
            for item in candidate.get("models", [])
            if isinstance(item, dict)
            and item.get("id") == model_id
            and isinstance(item.get("baseUrl"), str)
            and item.get("baseUrl")
        ),
        None,
    )
    if provider_entry is None:
        if (selection.base_url or "").strip():
            providers.append(
                {"provider": provider, "baseUrl": selection.base_url.strip()}
            )
        elif not existing_base_url:
            errors.append(
                _error(
                    "provider_base_url_required",
                    f"渠道 {provider} 缺少 providers[] 端点，必须提供 base_url",
                )
            )
    elif (selection.base_url or "").strip():
        provider_entry["baseUrl"] = selection.base_url.strip()
    candidate["providers"] = providers

    pricing = candidate.get("pricing")
    if pricing is None:
        pricing = {}
    if not isinstance(pricing, dict):
        return None, [_error("config_invalid", "pricing 段必须是映射")], warnings
    if provider not in pricing:
        if selection.pricing is None:
            errors.append(
                _error("pricing_required", f"新增渠道 {provider} 必须提供 pricing 四项单价")
            )
        else:
            pricing[provider] = {key: float(selection.pricing[key]) for key in _PRICING_KEYS}
    candidate["pricing"] = pricing

    models = candidate.get("models")
    if not isinstance(models, list):
        models = []
    existing = next(
        (item for item in models if isinstance(item, dict) and item.get("id") == model_id),
        None,
    )
    if existing is None:
        existing = {
            "id": model_id,
            "provider": provider,
            "contextWindow": context_window,
            "maxOutput": max_output,
            "vision": bool(selection.vision) if selection.vision is not None else False,
            "timeout": selection.timeout or 600000,
        }
    else:
        existing["provider"] = provider
        existing["contextWindow"] = context_window
        existing["maxOutput"] = max_output
        if selection.vision is not None:
            existing["vision"] = bool(selection.vision)
        if selection.timeout is not None:
            existing["timeout"] = selection.timeout
    models = [item for item in models if item is not existing]
    models.insert(0, existing)
    candidate["models"] = models

    if errors:
        return None, errors, warnings
    return candidate, [], warnings


def _validate_config_structure(doc: dict[str, Any]) -> list[dict[str, str]]:
    """托管候选的结构校验（对齐 Loom T07 schema + checkReferences 的关键引用）。"""
    errors: list[dict[str, str]] = []
    if not isinstance(doc, dict):
        return [_error("config_invalid", "Loom 配置顶层必须是映射")]

    providers = doc.get("providers", [])
    provider_names: set[str] = set()
    if not isinstance(providers, list):
        errors.append(_error("config_invalid", "providers 段必须是数组"))
        providers = []
    for index, item in enumerate(providers):
        if not isinstance(item, dict):
            errors.append(_error("config_invalid", f"providers[{index}] 必须是映射"))
            continue
        name = item.get("provider")
        base_url = item.get("baseUrl")
        if not isinstance(name, str) or not name:
            errors.append(_error("config_invalid", f"providers[{index}].provider 缺失"))
            continue
        if not isinstance(base_url, str) or not base_url:
            errors.append(_error("config_invalid", f"providers[{index}].baseUrl 缺失"))
        if name in provider_names:
            errors.append(_error("config_invalid", f"providers 重复: {name}"))
        provider_names.add(name)

    models = doc.get("models")
    if not isinstance(models, list) or not models:
        errors.append(_error("config_invalid", "models 必须是非空数组"))
        models = []
    seen_ids: set[str] = set()
    model_providers: set[str] = set()
    for index, item in enumerate(models):
        if not isinstance(item, dict):
            errors.append(_error("config_invalid", f"models[{index}] 必须是映射"))
            continue
        model_id = item.get("id")
        provider = item.get("provider")
        if not isinstance(model_id, str) or not model_id:
            errors.append(_error("config_invalid", f"models[{index}].id 缺失"))
            continue
        if model_id in seen_ids:
            errors.append(_error("config_invalid", f"models 重复 id: {model_id}"))
        seen_ids.add(model_id)
        if not isinstance(provider, str) or not provider:
            errors.append(_error("config_invalid", f"models[{index}].provider 缺失"))
        else:
            model_providers.add(provider)
        if not _sane_limits(item.get("contextWindow"), item.get("maxOutput")):
            errors.append(
                _error("config_invalid", f"models[{index}] contextWindow/maxOutput 不合法")
            )
        timeout = item.get("timeout")
        if isinstance(timeout, bool) or not isinstance(timeout, int) or timeout <= 0:
            errors.append(_error("config_invalid", f"models[{index}].timeout 不合法"))
        has_model_base = isinstance(item.get("baseUrl"), str) and bool(item.get("baseUrl"))
        if isinstance(provider, str) and provider and provider not in provider_names and not has_model_base:
            errors.append(
                _error(
                    "config_invalid",
                    f"models[{index}] 的 provider {provider} 缺少 providers[] 端点与模型级 baseUrl",
                )
            )

    pricing = doc.get("pricing", {})
    if not isinstance(pricing, dict):
        errors.append(_error("config_invalid", "pricing 段必须是映射"))
        pricing = {}
    for name, entry in pricing.items():
        if not isinstance(entry, dict):
            errors.append(_error("config_invalid", f"pricing.{name} 必须是映射"))
            continue
        for key in _PRICING_KEYS:
            value = entry.get(key, 0)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
                errors.append(
                    _error("config_invalid", f"pricing.{name}.{key} 必须为不小于 0 的数字")
                )
    for provider in model_providers:
        if provider not in pricing:
            errors.append(
                _error("config_invalid", f"模型 provider {provider} 缺少 pricing 计价条目")
            )

    credentials = doc.get("credentials", {})
    if credentials is None:
        credentials = {}
    if not isinstance(credentials, dict):
        errors.append(_error("config_invalid", "credentials 段必须是映射"))
    else:
        for name, value in credentials.items():
            if not isinstance(value, str) or not _ENV_REF_RE.match(value):
                errors.append(
                    _error("config_invalid", f"credentials.{name} 必须是 ${{ENV_VAR}} 引用")
                )
            if name not in model_providers:
                errors.append(
                    _error("config_invalid", f"credentials.{name} 不对应任何模型的 provider")
                )
    return errors


def _load_config_document(path: Path) -> tuple[Optional[dict[str, Any]], list[dict[str, str]]]:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None, [_error("config_missing", f"无法读取 Loom 配置: {path}")]
    try:
        doc = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        mark = getattr(exc, "problem_mark", None)
        line = getattr(mark, "line", None)
        suffix = f"（第 {line + 1} 行附近）" if isinstance(line, int) else ""
        return None, [_error("config_invalid", f"Loom YAML 解析失败{suffix}")]
    if not isinstance(doc, dict):
        return None, [_error("config_invalid", "Loom 配置顶层必须是映射")]
    return doc, []


def _dump_config(doc: dict[str, Any]) -> str:
    return yaml.safe_dump(
        doc, allow_unicode=True, sort_keys=False, default_flow_style=False
    )


def _write_text_atomic(path: Path, text: str, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent)
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp_name, mode)
        os.replace(tmp_name, path)
        _fsync_directory(path.parent)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def _fsync_directory(directory: Path) -> None:
    try:
        fd = os.open(str(directory), os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def _write_backup(path: Path, *, mode: Optional[int] = None) -> Path:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = path.with_name(f"{path.name}.bak-onboarding-{stamp}")
    counter = 1
    while backup.exists():
        backup = path.with_name(f"{path.name}.bak-onboarding-{stamp}-{counter}")
        counter += 1
    shutil.copy2(path, backup)
    if mode is not None:
        try:
            os.chmod(backup, mode)
        except OSError:
            pass
    return backup


# ── 可选 Loom 远端校验 ───────────────────────────────────────


async def _loom_validate(
    cfg: Config, token: str, candidate_text: str, *, timeout: float
) -> tuple[str, list[dict[str, str]]]:
    """尝试 POST /config/validate；404/405 或异常一律退回 structural。"""
    try:
        status, data = await _request_json(
            "POST",
            f"{_base_url(cfg)}/config/validate",
            token,
            json_body={"yaml_text": candidate_text},
            timeout=timeout,
        )
    except (aiohttp.ClientError, asyncio.TimeoutError, OSError):
        logger.info("[LoomOnboarding] /config/validate 不可达，退回结构校验")
        return "structural", []
    if status in (404, 405):
        return "structural", []
    if status != 200 or not isinstance(data, dict):
        logger.warning(
            "[LoomOnboarding] /config/validate 返回 status=%s，退回结构校验", status
        )
        return "structural", []
    errors: list[dict[str, str]] = []
    if data.get("ok") is False:
        raw_errors = data.get("errors")
        if isinstance(raw_errors, list):
            for item in raw_errors:
                text = item if isinstance(item, str) else None
                if text:
                    errors.append(
                        _error("loom_validate_failed", _safe_message(text, token))
                    )
        if not errors:
            errors.append(_error("loom_validate_failed", "Loom 配置校验未通过"))
        return "loom", errors
    return "loom", []


# ── 公共操作 ─────────────────────────────────────────────────


async def _fetch_catalog(
    cfg: Config, token: str, *, timeout: float
) -> tuple[list[dict[str, Any]], Optional[dict[str, str]]]:
    try:
        status, data = await _request_json(
            "GET", f"{_base_url(cfg)}/catalog/models", token, timeout=timeout
        )
    except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as exc:
        return [], {
            "code": "loom_unreachable",
            "message": _safe_message(str(exc), token),
        }
    if status != 200:
        return [], _http_error(status, data, token)
    return _safe_models(data), None


async def validate(
    selection: Selection,
    config: Optional[Config] = None,
    *,
    config_path: Optional[Path] = None,
    timeout: float = 5.0,
) -> dict[str, Any]:
    """结构校验选择；托管模式额外读当前 YAML 并尝试 Loom 远端校验（只读）。"""
    cfg = config or get_config()
    managed = bool(cfg.LOOM_MANAGE_CONFIG)
    result: dict[str, Any] = {
        "ok": False,
        "valid": False,
        "managed": managed,
        "selection": selection.public(),
        "main_model": None,
        "validation_mode": "structural",
        "errors": [],
        "warnings": [],
    }
    discovery = discover_token(cfg)
    if not discovery.found:
        result["errors"] = [
            _error("token_missing", "未发现 Loom Token，无法读取模型目录")
        ]
        return result
    token, _source, _detail = _resolve_token(cfg)

    catalog_models, catalog_error = await _fetch_catalog(cfg, token, timeout=timeout)
    if catalog_error:
        result["errors"] = [catalog_error]
        return result
    result["main_model"] = catalog_models[0] if catalog_models else None

    if managed:
        path = Path(config_path) if config_path else managed_config_path(cfg)
        doc, read_errors = _load_config_document(path)
        if read_errors:
            result["errors"] = read_errors
            return result
        candidate, build_errors, warnings = _build_candidate(
            doc, selection, catalog_models, managed=True
        )
        result["warnings"].extend(warnings)
        if build_errors:
            result["errors"] = build_errors
            return result
        structure_errors = _validate_config_structure(candidate or {})
        if structure_errors:
            result["errors"] = structure_errors
            return result
        mode, remote_errors = await _loom_validate(
            cfg, token, _dump_config(candidate or {}), timeout=timeout
        )
        result["validation_mode"] = mode
        if remote_errors:
            result["errors"] = remote_errors
            return result
    else:
        _candidate, build_errors, warnings = _build_candidate(
            {}, selection, catalog_models, managed=False
        )
        result["warnings"].extend(warnings)
        if build_errors:
            result["errors"] = build_errors
            return result

    result["ok"] = True
    result["valid"] = True
    return result


async def apply(
    selection: Selection,
    config: Optional[Config] = None,
    *,
    restart: bool = False,
    config_path: Optional[Path] = None,
    timeout: float = 5.0,
    restart_timeout: float = 30.0,
    unit: str = DEFAULT_SYSTEMD_UNIT,
) -> dict[str, Any]:
    """外部模式只校验；托管模式备份+原子写+（显式时）重启，失败回滚。"""
    cfg = config or get_config()
    managed = bool(cfg.LOOM_MANAGE_CONFIG)
    validation = await validate(
        selection, cfg, config_path=config_path, timeout=timeout
    )
    base_result: dict[str, Any] = {
        "ok": False,
        "managed": managed,
        "applied": False,
        "manual_required": not managed,
        "selection": selection.public(),
        "validation_mode": validation.get("validation_mode", "structural"),
        "backup": None,
        "rollback": None,
        "restart": {
            "requested": bool(restart),
            "performed": False,
            "verified": False,
            "manual_required": not managed,
            "command": None if managed else MANUAL_RESTART_COMMAND,
        },
        "errors": list(validation.get("errors") or []),
        "warnings": list(validation.get("warnings") or []),
    }
    if not validation.get("valid"):
        return base_result

    if not managed:
        base_result["ok"] = True
        base_result["manual_required"] = True
        return base_result

    path = Path(config_path) if config_path else managed_config_path(cfg)
    doc, read_errors = _load_config_document(path)
    if read_errors:
        base_result["errors"] = read_errors
        return base_result
    token, _source, _detail = _resolve_token(cfg)
    catalog_models, catalog_error = await _fetch_catalog(cfg, token, timeout=timeout)
    if catalog_error:
        base_result["errors"] = [catalog_error]
        return base_result
    candidate, build_errors, warnings = _build_candidate(
        doc, selection, catalog_models, managed=True
    )
    if build_errors:
        base_result["errors"] = build_errors
        return base_result
    base_result["warnings"].extend(warnings)
    structure_errors = _validate_config_structure(candidate or {})
    if structure_errors:
        base_result["errors"] = structure_errors
        return base_result

    try:
        original_mode = path.stat().st_mode & 0o777
    except OSError as exc:
        base_result["errors"] = [
            _error("config_missing", f"无法读取 Loom 配置: {redact_text(str(exc))[:200]}")
        ]
        return base_result
    try:
        backup = _write_backup(path)
    except OSError as exc:
        base_result["errors"] = [
            _error("backup_failed", f"备份失败: {redact_text(str(exc))[:200]}")
        ]
        return base_result
    base_result["backup"] = str(backup)

    try:
        _write_text_atomic(path, _dump_config(candidate or {}), original_mode)
    except OSError as exc:
        base_result["errors"] = [
            _error("config_write_failed", f"写入失败: {redact_text(str(exc))[:200]}")
        ]
        return base_result

    base_result["applied"] = True
    logger.info(
        "[LoomOnboarding] config written provider=%s model=%s backup=%s",
        selection.provider,
        selection.model,
        backup,
    )
    if not restart:
        base_result["ok"] = True
        base_result["restart"]["manual_required"] = False
        base_result["restart"]["detail"] = "配置已写入，需重启 Loom 后生效"
        return base_result

    restart_result = await restart_loom(
        cfg, explicit=True, timeout=restart_timeout, unit=unit
    )
    base_result["restart"] = restart_result
    if restart_result.get("performed") and not restart_result.get("verified"):
        return await _rollback(
            cfg, path, backup, base_result, selection, restart_timeout, unit,
            reason="重启后 Loom 健康检查失败",
        )
    if not restart_result.get("performed"):
        return await _rollback(
            cfg, path, backup, base_result, selection, restart_timeout, unit,
            reason="无法自动重启 Loom",
            restart_again=False,
        )

    token, _source, _detail = _resolve_token(cfg)
    if not await _verify_selection(cfg, token, selection, timeout=timeout):
        return await _rollback(
            cfg, path, backup, base_result, selection, restart_timeout, unit,
            reason="重启后主模型未生效",
        )

    base_result["ok"] = True
    base_result["restart"]["manual_required"] = False
    return base_result


async def _rollback(
    cfg: Config,
    path: Path,
    backup: Path,
    result: dict[str, Any],
    selection: Selection,
    restart_timeout: float,
    unit: str,
    *,
    reason: str,
    restart_again: bool = True,
) -> dict[str, Any]:
    """恢复备份；Loom 已被重启过时再重启旧配置，绝不留半套配置。"""
    rollback: dict[str, Any] = {
        "attempted": True,
        "restored": False,
        "reason": reason,
    }
    try:
        backup_text = backup.read_text(encoding="utf-8")
        backup_mode = backup.stat().st_mode & 0o777
        _write_text_atomic(path, backup_text, backup_mode)
        rollback["restored"] = True
    except OSError as exc:
        rollback["detail"] = redact_text(str(exc))[:200]
    result["rollback"] = rollback
    result["errors"].append(_error("apply_failed", reason))
    result["ok"] = False
    result["applied"] = False
    result["manual_required"] = True
    logger.warning(
        "[LoomOnboarding] apply failed reason=%s rolled_back=%s provider=%s model=%s",
        reason,
        rollback["restored"],
        selection.provider,
        selection.model,
    )
    if restart_again and rollback["restored"]:
        rollback_restart = await restart_loom(
            cfg, explicit=True, timeout=restart_timeout, unit=unit
        )
        rollback["restart"] = rollback_restart
        rollback["loom_down"] = not bool(rollback_restart.get("verified"))
    else:
        rollback["loom_down"] = False
    return result


async def _verify_selection(
    cfg: Config,
    token: str,
    selection: Selection,
    *,
    timeout: float,
) -> bool:
    if not token:
        return False
    try:
        status, data = await _request_json(
            "GET", f"{_base_url(cfg)}/catalog/models", token, timeout=timeout
        )
    except (aiohttp.ClientError, asyncio.TimeoutError, OSError):
        return False
    if status != 200:
        return False
    models = _safe_models(data)
    if not models:
        return False
    first = models[0]
    return (
        first.get("id") == selection.model
        and first.get("provider") == selection.provider
    )


# ── 重启（同用户 PID + 显式请求；绝不提权） ──────────────────


def _systemd_show(unit: str) -> dict[str, str]:
    try:
        completed = subprocess.run(
            [
                "systemctl",
                "show",
                unit,
                "-p",
                "MainPID,User,ActiveState,SubState,Restart",
            ],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return {}
    if completed.returncode != 0:
        return {}
    info: dict[str, str] = {}
    for line in completed.stdout.splitlines():
        key, separator, value = line.partition("=")
        if separator:
            info[key.strip()] = value.strip()
    return info


def _parse_pid(value: Any) -> Optional[int]:
    try:
        pid = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    return pid if pid > 0 else None


def _process_uid(pid: int) -> Optional[int]:
    try:
        return os.stat(f"/proc/{pid}").st_uid
    except OSError:
        return None


def _signal_pid(pid: int, sig: int) -> None:
    os.kill(pid, sig)


def _manual_result(detail: str, *, old_pid: Optional[int] = None) -> dict[str, Any]:
    return {
        "ok": False,
        "requested": True,
        "performed": False,
        "verified": False,
        "manual_required": True,
        "command": MANUAL_RESTART_COMMAND,
        "old_pid": old_pid,
        "new_pid": None,
        "detail": detail,
    }


async def _wait_pid_change(
    unit: str, old_pid: int, *, timeout: float
) -> Optional[int]:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        info = await asyncio.to_thread(_systemd_show, unit)
        pid = _parse_pid(info.get("MainPID"))
        if pid and pid != old_pid:
            return pid
        await asyncio.sleep(0.25)
    return None


async def _health_ok(cfg: Config, token: str, *, timeout: float) -> bool:
    try:
        status, data = await _request_json(
            "GET", f"{_base_url(cfg)}/health", token, timeout=min(timeout, 3.0)
        )
    except (aiohttp.ClientError, asyncio.TimeoutError, OSError):
        return False
    return (
        status == 200
        and isinstance(data, dict)
        and data.get("status") == "ok"
    )


async def _wait_health(cfg: Config, token: str, *, timeout: float) -> bool:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if await _health_ok(cfg, token, timeout=timeout):
            return True
        await asyncio.sleep(0.5)
    return False


async def restart_loom(
    config: Optional[Config] = None,
    *,
    explicit: bool = False,
    timeout: float = 30.0,
    unit: str = DEFAULT_SYSTEMD_UNIT,
) -> dict[str, Any]:
    """显式重启 Loom：按运行时模式分派，systemd 走 PID 校验，child 交给运行时。"""
    cfg = config or get_config()
    if not explicit:
        return _manual_result("未请求重启（需要一个显式确认）")
    token, _source, _detail = _resolve_token(cfg)
    if not token:
        return _manual_result("未发现 Loom Token，拒绝重启")

    # loom_runtime 在模块级导入本模块，顶层导入会形成循环；这里延迟导入。
    from services import loom_runtime

    mode = await asyncio.to_thread(loom_runtime.detect_mode, cfg)
    if mode == loom_runtime.MODE_CHILD:
        return await loom_runtime.restart(cfg, timeout=timeout)
    if mode == loom_runtime.MODE_NONE:
        return _manual_result(
            "未检测到可管理的 Loom（systemd 单元与本地发行版均不可用），请人工重启"
        )

    info = await asyncio.to_thread(_systemd_show, unit)
    old_pid = _parse_pid(info.get("MainPID"))
    if not old_pid:
        return _manual_result(f"未找到 {unit} 的 MainPID")
    if info.get("ActiveState") not in ("active", "activating", "reloading"):
        return _manual_result(f"{unit} 当前状态为 {info.get('ActiveState') or 'unknown'}", old_pid=old_pid)
    if info.get("Restart") not in ("always", "on-failure", "on-abnormal"):
        return _manual_result(
            f"{unit} 的 Restart={info.get('Restart') or 'unknown'}，无法保证自动拉起",
            old_pid=old_pid,
        )
    current_uid = getattr(os, "getuid", lambda: None)()
    pid_uid = _process_uid(old_pid)
    if current_uid is None or pid_uid != current_uid:
        return _manual_result("Loom 进程不属于当前用户，拒绝提权重启", old_pid=old_pid)

    logger.info(
        "[LoomOnboarding] restart requested unit=%s old_pid=%s", unit, old_pid
    )
    try:
        _signal_pid(old_pid, signal.SIGTERM)
    except OSError as exc:
        return _manual_result(
            f"SIGTERM 失败: {redact_text(str(exc))[:200]}", old_pid=old_pid
        )
    new_pid = await _wait_pid_change(unit, old_pid, timeout=min(timeout, 10.0))
    if new_pid is None:
        try:
            _signal_pid(old_pid, signal.SIGKILL)
        except OSError:
            pass
        new_pid = await _wait_pid_change(unit, old_pid, timeout=min(timeout, 10.0))
    if new_pid is None:
        result = _manual_result(
            "进程已终止但 systemd 未拉起新 PID，请人工检查", old_pid=old_pid
        )
        result["loom_down"] = True
        return result

    verified = await _wait_health(cfg, token, timeout=timeout)
    result = {
        "ok": verified,
        "requested": True,
        "performed": True,
        "verified": verified,
        "manual_required": not verified,
        "command": None if verified else MANUAL_RESTART_COMMAND,
        "old_pid": old_pid,
        "new_pid": new_pid,
        "detail": "重启完成" if verified else "新进程已起但健康检查未通过",
    }
    if not verified:
        result["loom_down"] = True
    logger.info(
        "[LoomOnboarding] restart result=%s old_pid=%s new_pid=%s",
        "ok" if verified else "health_failed",
        old_pid,
        new_pid,
    )
    return result
