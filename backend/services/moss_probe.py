# -*- coding: utf-8 -*-
"""MOSS 探测原语：URL 归一化、模型列表解析与共享常量。"""
from __future__ import annotations

import ipaddress
import json
from typing import Any
from urllib.parse import urlsplit

import aiohttp

DEFAULT_MODEL = "moss-audio-4b"
CHOICES = ("enabled", "disabled", "skipped")

# vLLM 的 --served-model-name 是 moss-audio-4b；部分部署会在 /v1/models
# 暴露完整权重名。仅在这一组等价名之间放宽匹配，避免把任意模型当成 MOSS。
MODEL_ALIASES = frozenset(
    {
        "moss-audio-4b",
        "moss-audio-4b-instruct",
        "openmoss-team/moss-audio-4b-instruct",
    }
)

MAX_BODY_BYTES = 65536
MAX_MODELS = 200
MAX_MODEL_ID = 200


def error(code: str, message: str) -> dict[str, str]:
    return {"code": code, "message": message}


def is_loopback(hostname: str | None) -> bool:
    if not hostname:
        return False
    host = hostname.strip("[]").lower()
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def non_loopback_warning(hostname: str | None) -> str:
    host = hostname or "unknown"
    return (
        f"MOSS 地址 {host} 不是回环地址：v1 客户端不支持 API Key 鉴权，"
        "也没有独立的 TLS 客户端配置；请只在本机或受信内网暴露该端口。"
    )


def normalise_base_url(
    raw: str,
) -> tuple[str | None, bool, dict[str, str] | None]:
    """校验并归一化 MOSS 基址；拒绝 URL 内嵌凭证、查询串与片段。"""
    value = (raw or "").strip()
    if not value:
        return None, False, error("invalid_base_url", "MOSS 地址为空，请填写 http://host:port")
    if any(ch in value for ch in "\r\n\t "):
        return None, False, error("invalid_base_url", "MOSS 地址不能包含空白字符")
    try:
        parts = urlsplit(value)
        _port = parts.port
    except ValueError:
        return None, False, error("invalid_base_url", "MOSS 地址格式或端口无效")
    if parts.scheme not in ("http", "https"):
        return None, False, error("invalid_base_url", "MOSS 地址必须以 http:// 或 https:// 开头")
    if parts.username is not None or parts.password is not None or "@" in parts.netloc:
        return None, False, error("invalid_base_url", "MOSS 地址不能包含用户名或密码")
    if not parts.hostname:
        return None, False, error("invalid_base_url", "MOSS 地址缺少主机名")
    if parts.query or parts.fragment:
        return None, False, error("invalid_base_url", "MOSS 地址不能包含查询串或片段")

    path = parts.path.rstrip("/")
    for suffix in ("/v1/models", "/v1"):
        if path.endswith(suffix):
            path = path[: -len(suffix)]
            break
    normalized = f"{parts.scheme}://{parts.netloc}{path}"
    return normalized, is_loopback(parts.hostname), None


def model_ids(payload: Any) -> list[str] | None:
    if isinstance(payload, list):
        candidates: Any = payload
    elif isinstance(payload, dict):
        candidates = payload.get("data")
        if candidates is None:
            candidates = payload.get("models")
    else:
        return None
    if not isinstance(candidates, list):
        return None

    ids: list[str] = []
    for item in candidates[:MAX_MODELS]:
        if isinstance(item, dict):
            candidate = item.get("id")
        elif isinstance(item, str):
            candidate = item
        else:
            continue
        if not isinstance(candidate, str) or not candidate.strip():
            continue
        value = candidate.strip()[:MAX_MODEL_ID]
        if value not in ids:
            ids.append(value)
    return ids


def match_model(requested: str, ids: list[str]) -> str | None:
    wanted = requested.strip().lower()
    wanted_base = wanted.split("@", 1)[0]
    for model_id in ids:
        candidate = model_id.strip().lower()
        candidate_base = candidate.split("@", 1)[0]
        if wanted == candidate or wanted_base == candidate_base:
            return model_id
        if wanted in MODEL_ALIASES and candidate_base in MODEL_ALIASES:
            return model_id
    return None


async def fetch_models(base_url: str, timeout: float) -> tuple[int, Any]:
    client_timeout = aiohttp.ClientTimeout(
        total=timeout,
        connect=min(timeout, 2.0),
        sock_read=timeout,
    )
    async with aiohttp.ClientSession(
        timeout=client_timeout, trust_env=False
    ) as client:
        async with client.get(
            f"{base_url}/v1/models",
            headers={"Accept": "application/json"},
            allow_redirects=False,
        ) as response:
            raw = await response.content.read(MAX_BODY_BYTES)
            text = raw.decode("utf-8", errors="replace")
            data: Any = None
            if text:
                try:
                    data = json.loads(text)
                except ValueError:
                    data = None
            return response.status, data
