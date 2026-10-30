# -*- coding: utf-8 -*-
"""MOSS 引导只读校验门面。

契约：

- 只读校验 ``GET {base}/v1/models``，不发送任何凭证，也不接受 URL 内嵌
  用户名/密码。
- 默认面向回环地址；非回环地址会返回告警（v1 客户端无 API Key 鉴权，
  也没有独立 TLS 客户端配置）。
- 后端不启停任何服务或单元，只负责校验外部 vLLM 是否可达、模型是否匹配。
- 本模块不写配置、不写引导状态，供 finish 软告警等只读场景复用。
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any
from urllib.parse import urlsplit

import aiohttp

from config.config import Config, get_config
from services import moss_probe

logger = logging.getLogger(__name__)

DEFAULT_MODEL = moss_probe.DEFAULT_MODEL

# 这些别名保留在门面模块，便于测试/调用方替换探测原语。
_error = moss_probe.error
_non_loopback_warning = moss_probe.non_loopback_warning
_normalise_base_url = moss_probe.normalise_base_url
_model_ids = moss_probe.model_ids
_match_model = moss_probe.match_model
_fetch_models = moss_probe.fetch_models


async def validate(
    base_url: str | None = None,
    model: str | None = None,
    timeout: float = 3.0,
    *,
    config: Config | None = None,
) -> dict[str, Any]:
    cfg = config or get_config()
    raw_base = base_url if base_url is not None else cfg.MOSS_BASE_URL
    requested = (
        (model if model is not None else cfg.MOSS_MODEL) or DEFAULT_MODEL
    ).strip() or DEFAULT_MODEL
    normalized, loopback, url_error = _normalise_base_url(str(raw_base or ""))
    warnings = []
    if normalized and not loopback:
        warnings.append(_non_loopback_warning(urlsplit(normalized).hostname))

    result: dict[str, Any] = {
        "base_url": normalized,
        "model": requested,
        "reachable": False,
        "model_found": False,
        "models": [],
        "matched_model": None,
        "latency_ms": 0,
        "loopback": loopback,
        "warnings": warnings,
        "warning": warnings[0] if warnings else None,
        "error": None,
    }
    if url_error:
        result["error"] = url_error
        logger.warning(
            "[MossOnboarding] validate invalid url code=%s", url_error["code"]
        )
        return result

    assert normalized is not None
    started = time.perf_counter()
    try:
        status, data = await _fetch_models(normalized, max(0.1, float(timeout)))
    except asyncio.TimeoutError:
        result["latency_ms"] = int(round((time.perf_counter() - started) * 1000))
        result["error"] = _error(
            "moss_timeout",
            f"连接 MOSS 超时（{timeout:.1f}s）：请确认 vLLM 已启动且未过载；冷启动可能需要数分钟。",
        )
        logger.warning("[MossOnboarding] validate timeout base=%s", normalized)
        return result
    except (aiohttp.ClientError, OSError) as exc:
        result["latency_ms"] = int(round((time.perf_counter() - started) * 1000))
        result["error"] = _error(
            "moss_unreachable",
            f"无法连接 MOSS（{type(exc).__name__}）：请确认地址 {normalized} 可访问且 vLLM 已启动。",
        )
        logger.warning(
            "[MossOnboarding] validate unreachable base=%s type=%s",
            normalized,
            type(exc).__name__,
        )
        return result

    result["latency_ms"] = int(round((time.perf_counter() - started) * 1000))
    if status != 200:
        result["reachable"] = True
        result["error"] = _error(
            "moss_http_error",
            f"MOSS /v1/models 返回 HTTP {status}；请确认地址指向 vLLM 的 OpenAI 兼容接口（通常端口 8100）。",
        )
        logger.warning(
            "[MossOnboarding] validate http status=%s base=%s", status, normalized
        )
        return result

    ids = _model_ids(data)
    if ids is None:
        result["reachable"] = True
        result["error"] = _error(
            "invalid_response",
            "MOSS /v1/models 响应不是合法的 OpenAI 模型列表；请确认服务为 vLLM 且地址未指向普通网页。",
        )
        logger.warning("[MossOnboarding] validate invalid response base=%s", normalized)
        return result

    matched = _match_model(requested, ids)
    result["reachable"] = True
    result["models"] = ids
    result["model_found"] = matched is not None
    result["matched_model"] = matched
    if matched is None:
        available = ", ".join(ids[:10]) or "（空）"
        result["error"] = _error(
            "model_not_found",
            f"服务可达，但模型列表中没有 {requested}；可用模型：{available}。",
        )
        logger.warning(
            "[MossOnboarding] validate model missing base=%s model=%s",
            normalized,
            requested,
        )
        return result

    logger.info(
        "[MossOnboarding] validate ok base=%s model=%s matched=%s latency_ms=%s loopback=%s",
        normalized,
        requested,
        matched,
        result["latency_ms"],
        loopback,
    )
    return result
