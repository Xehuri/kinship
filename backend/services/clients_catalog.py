# -*- coding: utf-8 -*-
"""客户端下载目录：Android APK 与 Windows 桌面端的本地/发行资产元数据。

解析优先级固定为 local -> configured URL -> release manifest -> GitHub 发行页。
任一环节失败都 fail-open 到下一级，目录请求不会因远端清单不可用而报错。
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional
from urllib.parse import unquote, urlparse

from config.config import get_config
from services import client_release_manifest
from services.client_artifacts import (
    LocalArtifact,
    desktop_release_dir,
    file_sha256,
    inspect_apk_file,
    inspect_local_apk,
    inspect_local_desktop,
    version_from_filename,
)

__all__ = [
    "ANDROID_KIND",
    "DESKTOP_KIND",
    "android_entry",
    "catalog",
    "connection_info",
    "desktop_entry",
    "desktop_release_dir",
    "file_sha256",
    "get_config",
    "inspect_apk_file",
    "inspect_local_apk",
    "inspect_local_desktop",
    "reset_manifest_cache",
]

ANDROID_KIND = "android"
DESKTOP_KIND = "desktop"

_LOCAL_URLS = {
    ANDROID_KIND: "/api/ota/download",
    DESKTOP_KIND: "/api/clients/desktop/download",
}
_FALLBACK_NAMES = {
    ANDROID_KIND: "Kinship-Android.apk",
    DESKTOP_KIND: "Kinship-Desktop-Setup.exe",
}
_CONFIG_URL_ATTRS = {
    ANDROID_KIND: "CLIENTS_ANDROID_URL",
    DESKTOP_KIND: "CLIENTS_DESKTOP_URL",
}
_CONFIG_SHA_ATTRS = {
    ANDROID_KIND: "CLIENTS_ANDROID_SHA256",
    DESKTOP_KIND: "CLIENTS_DESKTOP_SHA256",
}


def reset_manifest_cache() -> None:
    client_release_manifest.reset_cache()


def _filename_from_url(url: str, fallback: str) -> str:
    name = Path(unquote(urlparse(url).path)).name
    return name or fallback


def _sha_or_none(value: str) -> Optional[str]:
    normalized = (value or "").strip().lower()
    return normalized or None


def _debug_from_filename(filename: str) -> bool:
    return "debug" in filename.lower()


def _entry(
    kind: str,
    *,
    source: str,
    action: str,
    url: Optional[str],
    page_url: Optional[str],
    filename: Optional[str],
    download_filename: Optional[str],
    expected_filename: Optional[str],
    size: Optional[int],
    sha256: Optional[str],
    version: Optional[str],
    variant: Optional[str],
    debug: Optional[bool],
    label: Optional[str],
    fallback_reason: Optional[str],
) -> dict[str, object]:
    return {
        "kind": kind,
        "available": action != "none",
        "action": action,
        "source": source,
        "url": url,
        "page_url": page_url,
        "filename": filename,
        "download_filename": download_filename,
        "expected_filename": expected_filename,
        "size": size,
        "sha256": sha256,
        "version": version,
        "variant": variant,
        "debug": debug,
        "label": label,
        "fallback_reason": fallback_reason,
    }


def _local_entry(
    kind: str, artifact: LocalArtifact, page_url: Optional[str]
) -> dict[str, object]:
    return _entry(
        kind,
        source="local",
        action="download",
        url=_LOCAL_URLS[kind],
        page_url=page_url,
        filename=artifact.source_filename,
        download_filename=artifact.download_name,
        expected_filename=artifact.download_name,
        size=artifact.size,
        sha256=artifact.sha256,
        version=artifact.version,
        variant=artifact.variant,
        debug=artifact.debug,
        label="debug build" if artifact.debug else "release build",
        fallback_reason=None,
    )


def _configured_entry(
    kind: str, url: str, sha256: str, page_url: Optional[str]
) -> dict[str, object]:
    filename = _filename_from_url(url, _FALLBACK_NAMES[kind])
    debug = _debug_from_filename(filename)
    return _entry(
        kind,
        source="configured",
        action="download",
        url=url,
        page_url=page_url,
        filename=filename,
        download_filename=filename,
        expected_filename=filename,
        size=None,
        sha256=_sha_or_none(sha256),
        version=version_from_filename(filename),
        variant="debug" if debug else "release",
        debug=debug,
        label="debug build" if debug else "release build",
        fallback_reason="local_missing",
    )


def _manifest_entry(
    kind: str,
    asset: object,
    manifest_version: str,
    page_url: Optional[str],
) -> dict[str, object]:
    filename = str(getattr(asset, "file"))
    debug = _debug_from_filename(filename)
    return _entry(
        kind,
        source="manifest",
        action="download",
        url=str(getattr(asset, "url")),
        page_url=page_url,
        filename=filename,
        download_filename=filename,
        expected_filename=filename,
        size=getattr(asset, "size"),
        sha256=str(getattr(asset, "sha256")),
        version=version_from_filename(filename) or manifest_version or None,
        variant="debug" if debug else "release",
        debug=debug,
        label="debug build" if debug else "release build",
        fallback_reason="local_missing,configured_missing",
    )


def _github_entry(
    kind: str, page_url: str, fallback_reason: str
) -> dict[str, object]:
    return _entry(
        kind,
        source="github",
        action="external",
        url=page_url,
        page_url=page_url,
        filename=None,
        download_filename=None,
        expected_filename=None,
        size=None,
        sha256=None,
        version=None,
        variant=None,
        debug=None,
        label="GitHub release page",
        fallback_reason=fallback_reason,
    )


def _none_entry(
    kind: str, fallback_reason: str, page_url: Optional[str]
) -> dict[str, object]:
    return _entry(
        kind,
        source="none",
        action="none",
        url=None,
        page_url=page_url or client_release_manifest.DEFAULT_GITHUB_RELEASES_URL,
        filename=None,
        download_filename=None,
        expected_filename=None,
        size=None,
        sha256=None,
        version=None,
        variant=None,
        debug=None,
        label=None,
        fallback_reason=fallback_reason,
    )


def _resolve_entry(kind: str) -> dict[str, object]:
    cfg = get_config()
    page_url = client_release_manifest.release_page_url(cfg)

    local = inspect_local_apk() if kind == ANDROID_KIND else inspect_local_desktop()
    if local is not None:
        return _local_entry(kind, local, page_url)

    configured_url = str(getattr(cfg, _CONFIG_URL_ATTRS[kind], "") or "").strip()
    if configured_url:
        sha256 = str(getattr(cfg, _CONFIG_SHA_ATTRS[kind], "") or "")
        return _configured_entry(kind, configured_url, sha256, page_url)

    manifest, manifest_error = client_release_manifest.load_manifest_cached(cfg)
    skipped = "local_missing,configured_missing"
    if manifest is not None:
        asset = manifest.assets.get(kind)
        if asset is not None:
            return _manifest_entry(kind, asset, manifest.version, page_url)
        skipped = f"{skipped},manifest_asset_missing"
    else:
        skipped = f"{skipped},manifest_{manifest_error or 'unavailable'}"

    if page_url:
        return _github_entry(kind, page_url, skipped)
    return _none_entry(kind, f"{skipped},github_page_unavailable", page_url)


def android_entry() -> dict[str, object]:
    return _resolve_entry(ANDROID_KIND)


def desktop_entry() -> dict[str, object]:
    return _resolve_entry(DESKTOP_KIND)


def connection_info() -> dict[str, object]:
    cfg = get_config()
    return {
        "host": str(cfg.BACKEND_HOST),
        "https": {
            "enabled": bool(cfg.SSL_ENABLED),
            "port": int(cfg.BACKEND_HTTPS_PORT),
        },
        "http": {"enabled": True, "port": int(cfg.BACKEND_HTTP_PORT)},
    }


def catalog() -> dict[str, object]:
    """引导客户端目录；不含 PC 采集器字段。"""
    return {
        "android": android_entry(),
        "desktop": desktop_entry(),
        "connection": connection_info(),
    }
