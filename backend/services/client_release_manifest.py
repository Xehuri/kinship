# -*- coding: utf-8 -*-
"""客户端发行清单缓存与 GitHub 发行页地址。

目录请求可能每秒被前端轮询，故清单读取必须 fail-open 且有界：

* 正缓存 600s、负缓存 60s；
* 单次拉取 3s 超时、不重试；
* 任何异常都退化为 ``(None, error_code)``，由调用方继续回退。
"""
from __future__ import annotations

import logging
import threading
import time
import urllib.parse
from typing import Optional

from services import release_assets

logger = logging.getLogger(__name__)

POSITIVE_TTL_SECONDS = 600.0
NEGATIVE_TTL_SECONDS = 60.0
MANIFEST_TIMEOUT_SECONDS = 3.0

DEFAULT_GITHUB_RELEASE_BASE = "https://github.com/Xehuri/kinship"
DEFAULT_GITHUB_RELEASE_TAG = "onboarding-v1.0.0"
DEFAULT_GITHUB_RELEASES_URL = DEFAULT_GITHUB_RELEASE_BASE + "/releases"

_manifest_loader = None

_cache_lock = threading.Lock()
_cache: dict[tuple[str, str], tuple[float, Optional[release_assets.ReleaseManifest], str]] = {}


def reset_cache() -> None:
    """清空缓存；测试与配置切换后使用。"""
    with _cache_lock:
        _cache.clear()


def _is_https_base(value: str) -> bool:
    try:
        parts = urllib.parse.urlsplit(value)
    except ValueError:
        return False
    return (
        parts.scheme == "https"
        and bool(parts.hostname)
        and not parts.username
        and not parts.password
        and not parts.query
        and not parts.fragment
    )


def release_page_url(cfg: object) -> Optional[str]:
    """按配置拼 GitHub 发行页；配置非法或显式禁用时返回 None。"""
    raw_base = getattr(cfg, "CLIENTS_GITHUB_RELEASE_BASE", DEFAULT_GITHUB_RELEASE_BASE)
    base = DEFAULT_GITHUB_RELEASE_BASE if raw_base is None else str(raw_base).strip()
    if not base:
        return None
    if not _is_https_base(base):
        return None
    raw_tag = getattr(cfg, "CLIENTS_GITHUB_RELEASE_TAG", DEFAULT_GITHUB_RELEASE_TAG)
    tag = DEFAULT_GITHUB_RELEASE_TAG if raw_tag is None else str(raw_tag).strip()
    if tag:
        return f"{base.rstrip('/')}/releases/tag/{urllib.parse.quote(tag, safe='')}"
    return f"{base.rstrip('/')}/releases/latest"


def _error_code(exc: BaseException) -> str:
    if isinstance(exc, release_assets.ReleaseAssetError):
        return exc.code
    return type(exc).__name__


def _fetch_manifest(
    manifest_url: str, base_url: str
) -> tuple[Optional[release_assets.ReleaseManifest], str]:
    loader = _manifest_loader or release_assets.load_manifest
    try:
        manifest = loader(
            manifest_url,
            base_url=base_url,
            timeout=MANIFEST_TIMEOUT_SECONDS,
            retries=0,
        )
    except Exception as exc:
        return None, _error_code(exc)
    return manifest, ""


def load_manifest_cached(
    cfg: object,
) -> tuple[Optional[release_assets.ReleaseManifest], str]:
    """读取发行清单；返回 ``(manifest, error)``，失败时 manifest 为 None。"""
    try:
        manifest_url, base_url = release_assets.resolve_manifest_url(
            getattr(cfg, "ONBOARDING_RELEASE_MANIFEST_URL", ""),
            getattr(cfg, "ONBOARDING_RELEASE_BASE_URL", ""),
        )
    except Exception as exc:
        return None, _error_code(exc)

    key = (manifest_url, base_url)
    now = time.monotonic()
    with _cache_lock:
        cached = _cache.get(key)
        if cached is not None and cached[0] > now:
            return cached[1], cached[2]

    manifest, error = _fetch_manifest(manifest_url, base_url)
    ttl = POSITIVE_TTL_SECONDS if manifest is not None else NEGATIVE_TTL_SECONDS
    with _cache_lock:
        _cache[key] = (time.monotonic() + ttl, manifest, error)
    if manifest is None:
        logger.info(
            "[ClientsCatalog] phase=manifest result=failed error=%s", error or "unknown"
        )
    return manifest, error
