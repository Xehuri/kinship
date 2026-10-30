# -*- coding: utf-8 -*-
"""发行资产：清单校验、流式下载、安全解包与前端 dist 自愈。

信任锚：只接受 HTTPS（含重定向），资产完整性只认清单里的 SHA-256。
日志固定 ``[OnboardingAssets]`` / ``[FrontendAssets]`` 前缀；请求头与
查询令牌一律不落日志。下载在已有字节后失败时，额外用去掉查询串的 URL
给出“已下载 / 总大小”快照，便于定位卡点。所有网络/解包原语都支持注入
opener、sleep 与取消事件，测试无需真实网络。
"""
from __future__ import annotations

import hashlib
import http.client
import json
import logging
import os
import re
import shutil
import tarfile
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Callable, Iterable, Mapping, Optional

from config.paths import project_root as _paths_project_root

logger = logging.getLogger(__name__)

DEFAULT_MANIFEST_NAME = "release-manifest.json"
# 内置默认发行清单：配置留空时直接指向 GitHub 最新发行，保证首次引导可下载。
DEFAULT_MANIFEST_URL = (
    "https://github.com/Xehuri/kinship/releases/latest/download/"
    + DEFAULT_MANIFEST_NAME
)
# 国内镜像前缀：GitHub 直连不可达时按顺序回退，仅用于 github.com 官方 URL。
GITHUB_MIRROR_PREFIXES = ("https://ghfast.top/", "https://gh-proxy.com/")
DOWNLOAD_BACKOFF_S = (5.0, 30.0, 120.0)
FRONTEND_BACKOFF_S = (5.0, 30.0, 120.0)
CHUNK_SIZE = 256 * 1024
MAX_MANIFEST_BYTES = 1024 * 1024
MAX_DOWNLOAD_BYTES = 8 * 1024**3
MAX_EXTRACT_BYTES = 4 * 1024**3
MAX_ARCHIVE_MEMBERS = 50_000
FRONTEND_ENV_KILL_SWITCH = "AXEUH_FRONTEND_AUTODOWNLOAD"

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_ASSET_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
_ASSET_FILE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]*$")
_WINDOWS_DRIVE_RE = re.compile(r"^[A-Za-z]:")


class ReleaseAssetError(Exception):
    """发行资产失败；``code`` 是稳定、可上报且不含敏感值的错误码。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class ReleaseConfigError(ReleaseAssetError):
    pass


class ManifestError(ReleaseAssetError):
    pass


class DownloadError(ReleaseAssetError):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        retryable: bool = True,
        downloaded_bytes: int = 0,
        total_bytes: int | None = None,
    ) -> None:
        super().__init__(code, message)
        self.retryable = retryable
        self.downloaded_bytes = max(0, int(downloaded_bytes))
        self.total_bytes = total_bytes


class IntegrityError(DownloadError):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        downloaded_bytes: int = 0,
        total_bytes: int | None = None,
    ) -> None:
        super().__init__(
            code,
            message,
            retryable=False,
            downloaded_bytes=downloaded_bytes,
            total_bytes=total_bytes,
        )


class ExtractionError(ReleaseAssetError):
    pass


class DownloadCancelled(DownloadError):
    def __init__(self, message: str = "download cancelled") -> None:
        super().__init__("download_cancelled", message, retryable=False)


@dataclass(frozen=True)
class Asset:
    name: str
    file: str
    sha256: str
    url: str
    size: Optional[int] = None
    api_version: str = ""
    tiers: tuple[str, ...] = ()
    md5: Optional[str] = None
    mirror_urls: tuple[str, ...] = ()

    def public(self) -> dict:
        return {
            "name": self.name,
            "file": self.file,
            "sha256": self.sha256,
            "size": self.size,
            "url": self.url,
            "api_version": self.api_version,
            "tiers": list(self.tiers),
        }


@dataclass(frozen=True)
class ReleaseManifest:
    schema: int
    product: str
    version: str
    assets: dict[str, Asset]
    source: str
    base_url: str

    def public(self) -> dict:
        return {
            "schema": self.schema,
            "product": self.product,
            "version": self.version,
            "assets": {name: asset.public() for name, asset in self.assets.items()},
        }


class _HttpsOnlyRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        _require_https(newurl, "redirect")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_OPENER = urllib.request.build_opener(_HttpsOnlyRedirectHandler())


def _urlopen(request: urllib.request.Request, timeout: float):  # type: ignore[no-untyped-def]
    return _OPENER.open(request, timeout=timeout)


def _require_https(url: str, kind: str) -> None:
    parts = urllib.parse.urlsplit(url or "")
    if (
        parts.scheme != "https"
        or not parts.hostname
        or parts.username
        or parts.password
    ):
        raise ReleaseConfigError(
            "insecure_url", f"{kind} URL must be HTTPS without credentials"
        )


def _base_dir(url: str) -> str:
    parts = urllib.parse.urlsplit(url)
    path = parts.path
    if path.endswith("/"):
        directory_path = path
    else:
        head, separator, _segment = path.rpartition("/")
        directory_path = head + separator if separator else "/"
    directory = urllib.parse.urlunsplit(
        (parts.scheme, parts.netloc, directory_path, "", "")
    )
    _require_https(directory, "release base")
    return directory


def _join_url(base: str, filename: str) -> str:
    return base.rstrip("/") + "/" + urllib.parse.quote(filename, safe="._+-")


def _github_mirror_urls(url: str) -> tuple[str, ...]:
    if not url.startswith("https://github.com/"):
        return ()
    return tuple(prefix + url for prefix in GITHUB_MIRROR_PREFIXES)


def _host_label(url: str) -> str:
    try:
        host = urllib.parse.urlsplit(url).hostname
    except ValueError:
        host = None
    return host or "unknown"


def _loggable_url(url: str) -> str:
    """去掉查询串/片段后的 URL，只用于下载失败快照定位。"""
    try:
        parts = urllib.parse.urlsplit(url)
        port = parts.port
    except ValueError:
        return "unknown"
    if not parts.scheme or not parts.hostname:
        return "unknown"
    netloc = parts.hostname if port is None else f"{parts.hostname}:{port}"
    return urllib.parse.urlunsplit((parts.scheme, netloc, parts.path or "/", "", ""))


def _safe_asset_filename(file_name: str) -> str:
    name = (file_name or "").strip()
    if (
        not name
        or name in {".", ".."}
        or Path(name).name != name
        or "/" in name
        or "\\" in name
        or not _ASSET_FILE_RE.match(name)
    ):
        raise ReleaseAssetError("invalid_asset_file", "asset filename is not safe")
    return name


def resolve_manifest_url(
    manifest_url: str | None = None, base_url: str | None = None
) -> tuple[str, str]:
    """返回 ``(manifest_url, asset_base_url)``。

    显式 ``manifest_url`` > 显式 ``base_url`` > 内置默认清单；前两者始终优先。
    """
    explicit = (manifest_url or "").strip()
    base = (base_url or "").strip()
    if explicit:
        if explicit.endswith("/"):
            explicit = explicit.rstrip("/") + "/" + DEFAULT_MANIFEST_NAME
        _require_https(explicit, "manifest")
        derived = _base_dir(explicit) if not base else base
    elif base:
        _require_https(base, "release base")
        explicit = base.rstrip("/") + "/" + DEFAULT_MANIFEST_NAME
        _require_https(explicit, "manifest")
        derived = base
    else:
        explicit = DEFAULT_MANIFEST_URL
        _require_https(explicit, "manifest")
        derived = _base_dir(explicit)
    _require_https(derived, "release base")
    return explicit, derived.rstrip("/") + "/"


def _request(url: str, *, accept: str) -> urllib.request.Request:
    return urllib.request.Request(
        url,
        headers={"User-Agent": "kinship-onboarding/1", "Accept": accept},
    )


def _read_manifest_json(response) -> dict:  # type: ignore[no-untyped-def]
    raw = response.read(MAX_MANIFEST_BYTES + 1)
    if len(raw) > MAX_MANIFEST_BYTES:
        raise ManifestError("manifest_too_large", "manifest exceeds size limit")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise ManifestError("manifest_invalid_json", "manifest is not valid JSON") from exc
    if not isinstance(payload, dict):
        raise ManifestError("manifest_invalid_schema", "manifest must be a JSON object")
    return payload


def _fetch_manifest(
    url: str,
    *,
    timeout: float,
    retries: int,
    sleep: Callable[[float], None],
) -> dict:
    attempts = max(0, int(retries)) + 1
    last: ReleaseAssetError | None = None
    for attempt in range(attempts):
        try:
            with _urlopen(_request(url, accept="application/json"), timeout=timeout) as resp:
                status = getattr(resp, "status", 200)
                if status != 200:
                    raise ManifestError("manifest_http_error", f"manifest HTTP {status}")
                return _read_manifest_json(resp)
        except urllib.error.HTTPError as exc:
            code = "manifest_not_found" if exc.code == 404 else "manifest_http_error"
            last = ManifestError(code, f"manifest HTTP {exc.code}")
            if exc.code not in (408, 429, 500, 502, 503, 504):
                break
        except (urllib.error.URLError, TimeoutError, OSError, http.client.HTTPException) as exc:
            last = ManifestError(
                "manifest_unreachable", f"manifest request failed: {type(exc).__name__}"
            )
        except ManifestError as exc:
            last = exc
            break
        if attempt + 1 < attempts:
            delay = _backoff_value(DOWNLOAD_BACKOFF_S, attempt)
            logger.warning(
                "[OnboardingAssets] phase=manifest result=retry attempt=%d delay=%s error=%s",
                attempt + 1,
                delay,
                last.code if last else "unknown",
            )
            sleep(delay)
    assert last is not None
    logger.warning("[OnboardingAssets] phase=manifest result=failed error=%s", last.code)
    raise last


def parse_manifest(
    payload: Mapping, *, source: str, base_url: str | None = None
) -> ReleaseManifest:
    if payload.get("schema") != 1 or isinstance(payload.get("schema"), bool):
        raise ManifestError("manifest_invalid_schema", "manifest schema must be 1")
    product = payload.get("product")
    version = payload.get("version")
    if not isinstance(product, str) or not product.strip():
        raise ManifestError("manifest_invalid_schema", "manifest product is required")
    if not isinstance(version, str) or not version.strip():
        raise ManifestError("manifest_invalid_schema", "manifest version is required")
    raw_assets = payload.get("assets")
    if not isinstance(raw_assets, dict) or not raw_assets:
        raise ManifestError("manifest_invalid_schema", "manifest assets are required")

    base = (base_url or _base_dir(source)).rstrip("/") + "/"
    _require_https(base, "release base")
    assets: dict[str, Asset] = {}
    for name, raw in raw_assets.items():
        if not isinstance(name, str) or not _ASSET_NAME_RE.match(name):
            raise ManifestError("manifest_invalid_schema", "invalid asset name")
        if not isinstance(raw, Mapping):
            raise ManifestError("manifest_invalid_schema", "asset entry must be an object")
        file_name = raw.get("file")
        if not isinstance(file_name, str) or not _ASSET_FILE_RE.match(file_name):
            raise ManifestError("manifest_invalid_schema", f"asset {name} has invalid file")
        sha256 = raw.get("sha256")
        if not isinstance(sha256, str) or not _SHA256_RE.match(sha256.lower()):
            raise ManifestError("manifest_invalid_schema", f"asset {name} has invalid sha256")
        size = raw.get("size")
        if size is not None and (
            isinstance(size, bool) or not isinstance(size, int) or size < 0
        ):
            raise ManifestError("manifest_invalid_schema", f"asset {name} has invalid size")
        if size is not None and size > MAX_DOWNLOAD_BYTES:
            raise ManifestError("asset_too_large", f"asset {name} exceeds download limit")
        api_version = raw.get("api_version") or ""
        if not isinstance(api_version, str):
            raise ManifestError("manifest_invalid_schema", f"asset {name} has invalid api_version")
        tiers_raw = raw.get("tiers") or []
        if not isinstance(tiers_raw, list) or any(not isinstance(t, str) for t in tiers_raw):
            raise ManifestError("manifest_invalid_schema", f"asset {name} has invalid tiers")
        url = _join_url(base, file_name)
        _require_https(url, "asset")
        assets[name] = Asset(
            name=name,
            file=file_name,
            sha256=sha256.lower(),
            url=url,
            size=size,
            api_version=api_version,
            tiers=tuple(tiers_raw),
            mirror_urls=_github_mirror_urls(url),
        )
    return ReleaseManifest(
        schema=1,
        product=product.strip(),
        version=version.strip(),
        assets=assets,
        source=source,
        base_url=base,
    )


def _manifest_candidates(url: str, base: str) -> list[tuple[str, str]]:
    pairs = [(url, base)]
    mirror_urls = _github_mirror_urls(url)
    mirror_bases = _github_mirror_urls(base)
    if not mirror_urls or not mirror_bases:
        return pairs
    return pairs + list(zip(mirror_urls, mirror_bases))


def load_manifest(
    manifest_url: str | None = None,
    *,
    base_url: str | None = None,
    timeout: float = 15.0,
    retries: int = 2,
    sleep: Callable[[float], None] = time.sleep,
) -> ReleaseManifest:
    url, resolved_base = resolve_manifest_url(manifest_url, base_url)
    candidates = _manifest_candidates(url, resolved_base)
    multi = len(candidates) > 1
    primary: ReleaseAssetError | None = None
    for candidate_url, candidate_base in candidates:
        try:
            payload = _fetch_manifest(
                candidate_url,
                timeout=timeout,
                retries=0 if multi else retries,
                sleep=sleep,
            )
            manifest = parse_manifest(
                payload, source=candidate_url, base_url=candidate_base
            )
        except ReleaseAssetError as exc:
            if primary is None:
                primary = exc
            logger.warning(
                "[OnboardingAssets] phase=manifest host=%s result=failed error=%s",
                _host_label(candidate_url),
                exc.code,
            )
            continue
        logger.info(
            "[OnboardingAssets] phase=manifest result=ok version=%s assets=%d host=%s",
            manifest.version,
            len(manifest.assets),
            _host_label(candidate_url),
        )
        return manifest
    assert primary is not None
    raise primary


def _backoff_value(backoff: Iterable[float], index: int) -> float:
    values = tuple(backoff)
    if not values:
        return 0.0
    return max(0.0, float(values[min(index, len(values) - 1)]))


def _raise_if_cancelled(cancel_event: threading.Event | None) -> None:
    if cancel_event is not None and cancel_event.is_set():
        raise DownloadCancelled()


def _sleep_cancellable(
    seconds: float,
    cancel_event: threading.Event | None,
    sleep: Callable[[float], None],
) -> None:
    deadline = time.monotonic() + max(0.0, seconds)
    while True:
        _raise_if_cancelled(cancel_event)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        sleep(min(0.25, remaining))


def _unlink(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    except OSError:
        logger.warning("[OnboardingAssets] phase=cleanup result=failed path_suffix=%s", path.suffix)


def _content_length(response) -> int | None:  # type: ignore[no-untyped-def]
    headers = getattr(response, "headers", None)
    if headers is None:
        return None
    try:
        value = headers.get("Content-Length")
    except AttributeError:
        return None
    try:
        parsed = int(value) if value is not None else 0
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _progress_log(
    asset: Asset,
    written: int,
    total: int | None,
    result: str,
    *,
    pct: int | None = None,
) -> None:
    if pct is None:
        pct = int(written * 100 / total) if total else None
    logger.info(
        "[OnboardingAssets] phase=download asset=%s bytes=%d/%s pct=%s result=%s",
        asset.name,
        written,
        total if total else "?",
        pct if pct is not None else "?",
        result,
    )


def _partial_download_log(asset: Asset, exc: DownloadError, url: str) -> None:
    """下载失败但已有字节时给出进度快照；不做断点续传，只报告卡点。"""
    downloaded = max(0, int(getattr(exc, "downloaded_bytes", 0) or 0))
    if downloaded <= 0:
        return
    total = getattr(exc, "total_bytes", None) or asset.size
    total_text = f"{total / (1024 * 1024):.2f} MB" if total else "未知"
    logger.warning(
        "[OnboardingAssets] phase=download asset=%s url=%s result=failed "
        "snapshot=已下载 %.2f MB / 总 %s error=%s detail=%s",
        asset.name,
        _loggable_url(url),
        downloaded / (1024 * 1024),
        total_text,
        exc.code,
        str(exc),
    )


def _download_once(
    asset: Asset,
    part: Path,
    *,
    progress: Callable[[int, Optional[int]], None] | None,
    cancel_event: threading.Event | None,
    timeout: float,
    max_bytes: int,
    opener: Callable[..., object] | None = None,
    allow_unverified: bool = False,
) -> tuple[int, str]:
    expected = asset.size or None
    if expected is not None and expected > max_bytes:
        raise DownloadError("asset_too_large", "asset exceeds download limit", retryable=False)
    expected_sha256 = (asset.sha256 or "").strip().lower()
    expected_md5 = (asset.md5 or "").strip().lower()
    if not expected_sha256 and not expected_md5 and expected is None and not allow_unverified:
        raise IntegrityError(
            "checksum_missing", "asset has no checksum and no declared size"
        )
    _raise_if_cancelled(cancel_event)
    open_url = opener or _urlopen
    try:
        response = open_url(_request(asset.url, accept="application/octet-stream"), timeout=timeout)
    except urllib.error.HTTPError as exc:
        retryable = exc.code in (408, 429, 500, 502, 503, 504)
        raise DownloadError(
            "download_http_error", f"asset HTTP {exc.code}", retryable=retryable
        ) from exc
    except (urllib.error.URLError, TimeoutError, OSError, http.client.HTTPException) as exc:
        raise DownloadError(
            "download_unreachable", f"asset request failed: {type(exc).__name__}"
        ) from exc

    total = expected or _content_length(response)
    if total is not None and total > max_bytes:
        response.close()
        raise DownloadError("asset_too_large", "asset exceeds download limit", retryable=False)
    _progress_log(asset, 0, total, "start")
    digest = hashlib.sha256()
    md5_digest = hashlib.md5(usedforsecurity=False) if expected_md5 else None
    written = 0
    bucket = 0
    try:
        with response, open(part, "wb") as handle:
            while True:
                _raise_if_cancelled(cancel_event)
                try:
                    chunk = response.read(CHUNK_SIZE)
                except (OSError, http.client.HTTPException) as exc:
                    raise DownloadError(
                        "download_stream_failed",
                        f"stream failed: {type(exc).__name__}",
                        downloaded_bytes=written,
                        total_bytes=total,
                    ) from exc
                if not chunk:
                    break
                written += len(chunk)
                if written > max_bytes:
                    raise DownloadError(
                        "asset_too_large",
                        "asset exceeds download limit",
                        retryable=False,
                        downloaded_bytes=written,
                        total_bytes=total,
                    )
                if expected is not None and written > expected:
                    raise IntegrityError(
                        "size_mismatch",
                        "download exceeds manifest size",
                        downloaded_bytes=written,
                        total_bytes=total,
                    )
                digest.update(chunk)
                if md5_digest is not None:
                    md5_digest.update(chunk)
                handle.write(chunk)
                pct = int(written * 100 / total) if total else None
                next_bucket = pct // 10 if pct is not None else -1
                if next_bucket != bucket:
                    bucket = next_bucket
                    _progress_log(asset, written, total, "progress", pct=pct)
                if progress is not None:
                    try:
                        progress(written, total)
                    except Exception:
                        logger.warning(
                            "[OnboardingAssets] phase=download asset=%s result=callback_failed",
                            asset.name,
                        )
            handle.flush()
            os.fsync(handle.fileno())
    finally:
        try:
            response.close()
        except Exception:
            pass

    if expected is not None and written != expected:
        raise IntegrityError(
            "size_mismatch",
            "downloaded size does not match manifest",
            downloaded_bytes=written,
            total_bytes=total,
        )
    actual = digest.hexdigest()
    if expected_sha256 and actual != expected_sha256:
        raise IntegrityError(
            "sha256_mismatch",
            "downloaded sha256 does not match manifest",
            downloaded_bytes=written,
            total_bytes=total,
        )
    if md5_digest is not None and md5_digest.hexdigest() != expected_md5:
        raise IntegrityError(
            "md5_mismatch",
            "downloaded md5 does not match manifest",
            downloaded_bytes=written,
            total_bytes=total,
        )
    _progress_log(asset, written, total, "ok", pct=100)
    logger.info(
        "[OnboardingAssets] phase=verify asset=%s bytes=%d result=ok", asset.name, written
    )
    return written, actual


def download_asset(
    asset: Asset,
    dest: Path,
    *,
    progress: Callable[[int, Optional[int]], None] | None = None,
    cancel_event: threading.Event | None = None,
    retries: int = 3,
    backoff: Iterable[float] = DOWNLOAD_BACKOFF_S,
    sleep: Callable[[float], None] = time.sleep,
    timeout: float = 60.0,
    max_bytes: int = MAX_DOWNLOAD_BYTES,
    opener: Callable[..., object] | None = None,
    allow_unverified: bool = False,
) -> dict:
    """流式下载到 ``.part``，校验后原子替换；失败/取消清理临时文件。

    资产带镜像时按 ``mirror_urls`` 顺序先试镜像再试原始 URL，每个候选只试一次；
    镜像校验失败继续回退下一个候选，取消立即终止。无镜像时保持原有重试语义。
    """
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    candidates = (*asset.mirror_urls, asset.url)
    fallback = bool(asset.mirror_urls)
    attempts = 1 if fallback else max(0, int(retries)) + 1
    for index, candidate in enumerate(candidates):
        current = asset if candidate == asset.url else replace(asset, url=candidate)
        is_last = index + 1 >= len(candidates)
        _unlink(part)
        for attempt in range(attempts):
            _raise_if_cancelled(cancel_event)
            try:
                written, digest = _download_once(
                    current,
                    part,
                    progress=progress,
                    cancel_event=cancel_event,
                    timeout=timeout,
                    max_bytes=max_bytes,
                    opener=opener,
                    allow_unverified=allow_unverified,
                )
                os.replace(part, dest)
                return {
                    "asset": asset.name,
                    "path": str(dest),
                    "bytes": written,
                    "sha256": digest,
                    "source": _host_label(candidate),
                }
            except DownloadCancelled:
                _unlink(part)
                _progress_log(asset, 0, asset.size, "cancelled")
                raise
            except IntegrityError as exc:
                _unlink(part)
                _partial_download_log(current, exc, candidate)
                if fallback and not is_last:
                    logger.warning(
                        "[OnboardingAssets] phase=download asset=%s host=%s result=fallback error=%s",
                        asset.name,
                        _host_label(candidate),
                        exc.code,
                    )
                    break
                _progress_log(asset, 0, asset.size, "failed", pct=0)
                raise exc
            except DownloadError as exc:
                _unlink(part)
                _partial_download_log(current, exc, candidate)
                if fallback and not is_last:
                    logger.warning(
                        "[OnboardingAssets] phase=download asset=%s host=%s result=fallback error=%s",
                        asset.name,
                        _host_label(candidate),
                        exc.code,
                    )
                    break
                if not exc.retryable or attempt + 1 >= attempts:
                    _progress_log(asset, 0, asset.size, "failed", pct=0)
                    raise
                delay = _backoff_value(backoff, attempt)
                logger.warning(
                    "[OnboardingAssets] phase=download asset=%s result=retry attempt=%d delay=%s error=%s",
                    asset.name,
                    attempt + 1,
                    delay,
                    exc.code,
                )
                try:
                    _sleep_cancellable(delay, cancel_event, sleep)
                except DownloadCancelled:
                    _progress_log(asset, 0, asset.size, "cancelled")
                    raise
            except (urllib.error.URLError, TimeoutError, OSError, http.client.HTTPException) as exc:
                _unlink(part)
                if fallback and not is_last:
                    logger.warning(
                        "[OnboardingAssets] phase=download asset=%s host=%s result=fallback error=%s",
                        asset.name,
                        _host_label(candidate),
                        type(exc).__name__,
                    )
                    break
                if attempt + 1 >= attempts:
                    _progress_log(asset, 0, asset.size, "failed", pct=0)
                    raise DownloadError(
                        "download_failed", f"download failed: {type(exc).__name__}"
                    ) from exc
                delay = _backoff_value(backoff, attempt)
                logger.warning(
                    "[OnboardingAssets] phase=download asset=%s result=retry attempt=%d delay=%s error=%s",
                    asset.name,
                    attempt + 1,
                    delay,
                    type(exc).__name__,
                )
                try:
                    _sleep_cancellable(delay, cancel_event, sleep)
                except DownloadCancelled:
                    _progress_log(asset, 0, asset.size, "cancelled")
                    raise
    raise DownloadError("download_failed", "download failed")


def _safe_member_target(root: Path, name: str) -> Path:
    raw = (name or "").replace("\\", "/")
    if "\x00" in raw:
        raise ExtractionError("archive_path_invalid", "archive path contains NUL")
    if not raw or raw.startswith("/") or _WINDOWS_DRIVE_RE.match(raw):
        raise ExtractionError("archive_absolute_path", "archive contains an absolute path")
    parts = [part for part in raw.split("/") if part not in ("", ".")]
    if not parts or any(part == ".." for part in parts):
        raise ExtractionError("archive_path_traversal", "archive contains a traversal path")
    target = root.joinpath(*parts)
    try:
        parent = target.parent.resolve()
    except OSError as exc:
        raise ExtractionError("archive_path_invalid", "archive path cannot be resolved") from exc
    if not parent.is_relative_to(root):
        raise ExtractionError("archive_path_traversal", "archive path escapes target")
    return target


def _ensure_no_symlink_parents(root: Path, target: Path) -> None:
    current = target.parent
    while current != root and current != current.parent:
        if current.is_symlink():
            raise ExtractionError(
                "archive_symlink_parent", "archive writes through a symlink"
            )
        current = current.parent


def _validate_symlink(root: Path, target: Path, linkname: str) -> None:
    raw = (linkname or "").replace("\\", "/")
    if not raw or raw.startswith("/") or _WINDOWS_DRIVE_RE.match(raw):
        raise ExtractionError("archive_symlink_escape", "symlink target is absolute")
    resolved = (target.parent / raw).resolve(strict=False)
    if not resolved.is_relative_to(root):
        raise ExtractionError("archive_symlink_escape", "symlink target escapes root")


def _extract_into(
    archive: Path,
    staging: Path,
    *,
    asset: str,
    cancel_event: threading.Event | None,
    max_bytes: int,
    max_members: int,
) -> dict:
    root = staging.resolve()
    total = 0
    files = 0
    seen = 0
    try:
        tar = tarfile.open(archive, "r:*")
    except (tarfile.TarError, OSError) as exc:
        raise ExtractionError("archive_invalid", "archive cannot be opened") from exc
    with tar:
        try:
            for member in tar:
                seen += 1
                if seen > max_members:
                    raise ExtractionError("archive_too_many_members", "archive has too many members")
                _raise_if_cancelled(cancel_event)
                rootish = member.name.replace("\\", "/").strip("/")
                if rootish in {"", "."} and member.isdir():
                    continue
                if member.size < 0:
                    raise ExtractionError("archive_size_mismatch", "archive member has negative size")
                target = _safe_member_target(root, member.name)
                _ensure_no_symlink_parents(root, target)
                if member.isdir():
                    if target.is_symlink():
                        raise ExtractionError("archive_symlink_parent", "directory is a symlink")
                    target.mkdir(parents=True, exist_ok=True)
                elif member.isfile():
                    total += member.size
                    if total > max_bytes:
                        raise ExtractionError("archive_too_large", "archive exceeds size limit")
                    target.parent.mkdir(parents=True, exist_ok=True)
                    source = tar.extractfile(member)
                    if source is None:
                        raise ExtractionError("archive_invalid", "archive member cannot be read")
                    written = 0
                    with source, open(target, "xb") as out:
                        while True:
                            _raise_if_cancelled(cancel_event)
                            chunk = source.read(CHUNK_SIZE)
                            if not chunk:
                                break
                            written += len(chunk)
                            if written > member.size:
                                raise ExtractionError(
                                    "archive_size_mismatch", "archive member is oversized"
                                )
                            out.write(chunk)
                    if written != member.size:
                        raise ExtractionError(
                            "archive_size_mismatch", "archive member is truncated"
                        )
                    try:
                        os.chmod(target, member.mode & 0o777)
                    except OSError:
                        pass
                    files += 1
                elif member.issym():
                    _validate_symlink(root, target, member.linkname)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    os.symlink(member.linkname, target)
                    files += 1
                elif member.islnk():
                    source_target = _safe_member_target(root, member.linkname)
                    if source_target.is_symlink() or not source_target.is_file():
                        raise ExtractionError(
                            "archive_hardlink_invalid", "hardlink source is invalid"
                        )
                    target.parent.mkdir(parents=True, exist_ok=True)
                    os.link(source_target, target)
                    files += 1
                else:
                    raise ExtractionError(
                        "archive_member_forbidden", "unsupported archive member type"
                    )
        except (tarfile.TarError, EOFError) as exc:
            raise ExtractionError("archive_invalid", "archive is corrupted") from exc
        except OSError as exc:
            raise ExtractionError(
                "archive_extract_failed", f"archive extraction failed: {type(exc).__name__}"
            ) from exc
    logger.info(
        "[OnboardingAssets] phase=extract asset=%s files=%d bytes=%d result=ok",
        asset or "unknown",
        files,
        total,
    )
    return {"files": files, "bytes": total}


def extract_tarball(
    archive: Path,
    dest: Path,
    *,
    asset: str = "",
    cancel_event: threading.Event | None = None,
    max_bytes: int = MAX_EXTRACT_BYTES,
    max_members: int = MAX_ARCHIVE_MEMBERS,
    overwrite: bool = False,
) -> dict:
    """解包到同级 staging 后原子换入；默认拒绝覆盖已有目标。"""
    archive = Path(archive)
    dest = Path(dest)
    if dest.exists() and not overwrite:
        raise ExtractionError("destination_exists", "destination already exists")
    parent = dest.parent
    parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{dest.name}.staging-", dir=str(parent)))
    try:
        result = _extract_into(
            archive,
            staging,
            asset=asset,
            cancel_event=cancel_event,
            max_bytes=max_bytes,
            max_members=max_members,
        )
        if dest.exists():
            if not overwrite:
                raise ExtractionError("destination_exists", "destination already exists")
            backup = parent / f".{dest.name}.backup-{uuid.uuid4().hex}"
            os.replace(dest, backup)
            try:
                os.replace(staging, dest)
            except OSError:
                os.replace(backup, dest)
                raise
            shutil.rmtree(backup, ignore_errors=True)
        else:
            os.replace(staging, dest)
        return {"dest": str(dest), **result}
    finally:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)


def install_frontend_asset(
    asset: Asset,
    project_root: Path,
    *,
    progress: Callable[[int, Optional[int]], None] | None = None,
    cancel_event: threading.Event | None = None,
    timeout: float = 60.0,
    retries: int = 3,
    sleep: Callable[[float], None] = time.sleep,
) -> dict:
    """下载前端资产并安装到 ``frontend/mobile/dist``；已存在则拒绝覆盖。"""
    root = Path(project_root)
    mobile = root / "frontend" / "mobile"
    dist = mobile / "dist"
    if (dist / "index.html").is_file():
        raise ReleaseAssetError("frontend_dist_present", "frontend dist already present")
    mobile.mkdir(parents=True, exist_ok=True)
    if asset.size:
        required = int(asset.size * 1.2)
        try:
            free = int(shutil.disk_usage(str(mobile)).free)
        except OSError:
            free = 0
        if free < required:
            raise ReleaseAssetError(
                "insufficient_disk",
                f"frontend asset needs {required} bytes free, {free} available",
            )
    work = Path(tempfile.mkdtemp(prefix=".dist-download-", dir=str(mobile)))
    archive = work / _safe_asset_filename(asset.file)
    staging = work / "staging"
    try:
        download_asset(
            asset,
            archive,
            progress=progress,
            cancel_event=cancel_event,
            timeout=timeout,
            retries=retries,
            sleep=sleep,
        )
        extract_tarball(
            archive,
            staging,
            asset=asset.name,
            cancel_event=cancel_event,
            overwrite=False,
        )
        candidate = staging / "dist"
        if candidate.is_symlink():
            raise ExtractionError("frontend_links_forbidden", "dist is a symlink")
        source = candidate if candidate.is_dir() else staging
        ensure_no_links(source, "frontend_links_forbidden")
        if not (source / "index.html").is_file():
            raise ExtractionError(
                "frontend_index_missing", "frontend archive has no dist/index.html"
            )
        if dist.exists():
            raise ReleaseAssetError("frontend_dist_present", "frontend dist already present")
        os.chmod(source, 0o755)
        os.replace(source, dist)
        return {"path": str(dist), "bytes": _dir_size(dist)}
    finally:
        shutil.rmtree(work, ignore_errors=True)


def ensure_no_links(path: Path, code: str) -> None:
    """安装前拒绝符号链接与硬链接：发行包不需要链接，链接会破坏原子换入语义。"""
    for entry in Path(path).rglob("*"):
        try:
            if entry.is_symlink() or (
                entry.is_file() and entry.stat(follow_symlinks=False).st_nlink > 1
            ):
                raise ExtractionError(code, "archive contains links")
        except OSError:
            continue


def _dir_size(path: Path) -> int:
    total = 0
    for entry in path.rglob("*"):
        try:
            if entry.is_file():
                total += entry.stat().st_size
        except OSError:
            continue
    return total


def _autodownload_enabled() -> tuple[bool, str]:
    raw = os.environ.get(FRONTEND_ENV_KILL_SWITCH)
    if raw is not None and raw.strip():
        disabled = raw.strip().lower() in {"0", "false", "no", "off"}
        return (not disabled, "env")
    try:
        from config.config import get_config

        enabled = bool(get_config().ONBOARDING_FRONTEND_AUTODOWNLOAD)
    except Exception:
        enabled = True
    return enabled, "config" if enabled else "config_disabled"


def _manifest_settings(
    manifest_url: str | None, base_url: str | None
) -> tuple[str, str]:
    if manifest_url is None and base_url is None:
        try:
            from config.config import get_config

            cfg = get_config()
            manifest_url = cfg.ONBOARDING_RELEASE_MANIFEST_URL
            base_url = cfg.ONBOARDING_RELEASE_BASE_URL
        except Exception:
            pass
    return resolve_manifest_url(manifest_url, base_url)


def _error_code(exc: BaseException) -> str:
    if isinstance(exc, ReleaseAssetError):
        return exc.code
    if isinstance(exc, urllib.error.HTTPError):
        return f"http_{exc.code}"
    return type(exc).__name__


def ensure_frontend_dist(
    project_root: Path | None = None,
    *,
    manifest_url: str | None = None,
    base_url: str | None = None,
    retries: int = 3,
    backoff: Iterable[float] = FRONTEND_BACKOFF_S,
    sleep: Callable[[float], None] = time.sleep,
    timeout: float = 60.0,
    cancel_event: threading.Event | None = None,
) -> dict:
    """dist 缺失时后台自愈；存在则只记日志，永不覆盖。"""
    root = Path(project_root) if project_root is not None else _paths_project_root()
    dist = root / "frontend" / "mobile" / "dist"
    index = dist / "index.html"
    if index.is_file():
        logger.info("[FrontendAssets] present path=%s", index)
        return {"status": "present", "path": str(index)}
    enabled, reason = _autodownload_enabled()
    if not enabled:
        logger.info(
            "[FrontendAssets] missing path=%s autodownload=disabled reason=%s",
            dist,
            reason,
        )
        return {"status": "disabled", "path": str(dist), "reason": reason}
    logger.warning("[FrontendAssets] missing path=%s; attempting release download", dist)
    try:
        resolved_manifest, resolved_base = _manifest_settings(manifest_url, base_url)
    except ReleaseAssetError as exc:
        logger.error(
            "[FrontendAssets] result=failed path=%s error=%s api_only=true",
            dist,
            exc.code,
        )
        return {"status": "failed", "path": str(dist), "error": exc.code, "api_only": True}
    source = urllib.parse.urlsplit(resolved_manifest).netloc or "release"
    attempts = max(0, int(retries)) + 1
    last_error = "unknown"
    for attempt in range(1, attempts + 1):
        if cancel_event is not None and cancel_event.is_set():
            logger.info("[FrontendAssets] result=cancelled path=%s", dist)
            return {"status": "cancelled", "path": str(dist)}
        try:
            logger.info(
                "[FrontendAssets] attempt=%d source=%s path=%s", attempt, source, dist
            )
            manifest = load_manifest(
                resolved_manifest,
                base_url=resolved_base,
                timeout=timeout,
                retries=0,
                sleep=sleep,
            )
            asset = manifest.assets.get("frontend")
            if asset is None:
                raise ManifestError("frontend_asset_missing", "manifest has no frontend asset")
            result = install_frontend_asset(
                asset,
                root,
                cancel_event=cancel_event,
                timeout=timeout,
                retries=0,
                sleep=sleep,
            )
            logger.info(
                "[FrontendAssets] result=ok bytes=%d path=%s attempt=%d",
                result["bytes"],
                result["path"],
                attempt,
            )
            return {"status": "ok", "attempt": attempt, **result}
        except Exception as exc:
            last_error = _error_code(exc)
            logger.warning(
                "[FrontendAssets] attempt=%d result=failed error=%s",
                attempt,
                last_error,
            )
            if attempt >= attempts:
                break
            delay = _backoff_value(backoff, attempt - 1)
            logger.info("[FrontendAssets] retry delay=%s attempt=%d", delay, attempt)
            try:
                _sleep_cancellable(delay, cancel_event, sleep)
            except DownloadCancelled:
                logger.info("[FrontendAssets] result=cancelled path=%s", dist)
                return {"status": "cancelled", "path": str(dist)}
    logger.error(
        "[FrontendAssets] result=failed path=%s error=%s api_only=true",
        dist,
        last_error,
    )
    return {
        "status": "failed",
        "path": str(dist),
        "error": last_error,
        "api_only": True,
    }


def cleanup_stale_downloads(project_root: Path | None = None) -> int:
    """清理上次进程遗留的下载/解包临时目录（只匹配本模块创建的隐藏名）。"""
    root = Path(project_root) if project_root is not None else _paths_project_root()
    patterns = (
        root / "frontend" / "mobile",
        root,
    )
    removed = 0
    prefixes = (".dist-download-", ".kernel-download-", ".kernel-staging-")
    for parent in patterns:
        if not parent.is_dir():
            continue
        for entry in parent.iterdir():
            if entry.name.startswith(prefixes) and entry.is_dir():
                shutil.rmtree(entry, ignore_errors=True)
                removed += 1
    if removed:
        logger.info("[OnboardingAssets] phase=cleanup removed=%d result=ok", removed)
    return removed


_SELF_HEAL_LOCK = threading.Lock()
_SELF_HEAL_STATE: dict[str, object] = {"status": "idle", "error": None}


def frontend_self_heal_state() -> dict:
    """只读自愈状态；预检据此区分“正在下载”与“下载失败”。"""
    with _SELF_HEAL_LOCK:
        return dict(_SELF_HEAL_STATE)


def _set_frontend_self_heal_state(status: str, error: object = None) -> None:
    with _SELF_HEAL_LOCK:
        _SELF_HEAL_STATE.update({"status": status, "error": error})


def start_frontend_self_heal() -> threading.Thread:
    """启动守护线程自愈；不占用事件循环默认线程池，不阻塞进程关停。"""
    _set_frontend_self_heal_state("running")

    def _run() -> None:
        _set_frontend_self_heal_state("downloading")
        try:
            result = ensure_frontend_dist()
            status = str(result.get("status") or "failed")
            if status not in {"present", "ok", "disabled", "failed", "cancelled"}:
                status = "failed"
            _set_frontend_self_heal_state(status, result.get("error"))
        except Exception as exc:
            _set_frontend_self_heal_state("failed", type(exc).__name__)
            logger.error("[FrontendAssets] result=failed error=%s", type(exc).__name__)

    thread = threading.Thread(
        target=_run, name="frontend-self-heal", daemon=True
    )
    thread.start()
    return thread
