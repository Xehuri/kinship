# -*- coding: utf-8 -*-
"""客户端产物文件元数据：APK 与桌面安装包的发现、哈希与版本解析。"""
from __future__ import annotations

import hashlib
import json
import os
import re
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from config.config import get_config

_DESKTOP_PATTERN = "Kinship-Desktop-Setup-*-x64.exe"
_DESKTOP_VERSION_RE = re.compile(
    r"^Kinship-Desktop-Setup-(?P<version>.+)-x64\.exe$"
)
_VERSION_RE = re.compile(r"(?:^|[^0-9])(?P<version>\d+\.\d+(?:\.\d+)?)")

_hash_cache: dict[str, tuple[int, int, str]] = {}
_hash_lock = threading.Lock()


@dataclass(frozen=True)
class LocalArtifact:
    """本地客户端产物；path 仅供服务端下载，不进入 HTTP 响应。"""

    path: str
    source_filename: str
    download_name: str
    size: int
    sha256: str
    version: Optional[str]
    variant: Optional[str]
    debug: bool


def _repo_root() -> Path:
    from config.paths import project_root

    return project_root()


def _ota_dir() -> str:
    env_dir = os.environ.get("OTA_FILE_DIR")
    if env_dir:
        return env_dir
    return str(get_config().OTA_APK_DIR)


def desktop_release_dir() -> str:
    """桌面端发行目录；测试可用 KINSHIP_DESKTOP_RELEASE_DIR 覆盖。"""
    override = os.environ.get("KINSHIP_DESKTOP_RELEASE_DIR")
    if override:
        return override
    return str(_repo_root() / "desktop" / "release")


def _is_within(path: Path, root: Path) -> bool:
    try:
        return path.resolve().is_relative_to(root.resolve())
    except (OSError, ValueError):
        return False


def _sha256(path: str, mtime_ns: int, size: int) -> str:
    key = str(Path(path).resolve())
    with _hash_lock:
        cached = _hash_cache.get(key)
        if cached and cached[0] == mtime_ns and cached[1] == size:
            return cached[2]

    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    value = digest.hexdigest()

    with _hash_lock:
        _hash_cache[key] = (mtime_ns, size, value)
    return value


def file_sha256(path: str) -> str:
    """返回文件 SHA-256（按 mtime/size 缓存）。"""
    stat = os.stat(path)
    return _sha256(path, stat.st_mtime_ns, stat.st_size)


def _read_apk_metadata(apk_path: Path) -> dict[str, object]:
    metadata_path = apk_path.parent / "output-metadata.json"
    try:
        data = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    elements = data.get("elements")
    if not isinstance(elements, list):
        return {}
    selected: Optional[dict[str, object]] = None
    for item in elements:
        if not isinstance(item, dict):
            continue
        if item.get("outputFile") == apk_path.name:
            selected = item
            break
        if selected is None and isinstance(item.get("attributes"), list):
            selected = item
    if selected is None:
        return {}
    attributes = selected.get("attributes")
    package_name = ""
    if isinstance(attributes, list):
        for attribute in attributes:
            if isinstance(attribute, dict) and attribute.get("key") == "applicationId":
                package_name = str(attribute.get("value") or "")
    return {
        "version": str(selected.get("versionName") or "") or None,
        "variant": str(selected.get("variantName") or "") or None,
        "package": package_name or None,
    }


def version_from_filename(filename: str) -> Optional[str]:
    match = _VERSION_RE.search(filename)
    return match.group("version") if match else None


def _desktop_version(filename: str) -> Optional[str]:
    match = _DESKTOP_VERSION_RE.match(filename)
    return match.group("version") if match else None


def _android_download_name(
    source_filename: str, version: Optional[str], debug: bool
) -> str:
    if not version:
        return source_filename
    suffix = "-debug.apk" if debug else ".apk"
    return f"Kinship-{version}{suffix}"


def inspect_apk_file(apk_path: str) -> Optional[LocalArtifact]:
    """读取指定 APK 的元数据；文件不存在返回 None。"""
    latest = Path(apk_path)
    if not latest.is_file():
        return None
    stat = latest.stat()
    metadata = _read_apk_metadata(latest)
    variant = str(metadata.get("variant") or "").strip() or None
    debug = (variant or "").lower() == "debug" or "debug" in latest.name.lower()
    version = str(metadata.get("version") or "").strip() or version_from_filename(
        latest.name
    )
    return LocalArtifact(
        path=str(latest),
        source_filename=latest.name,
        download_name=_android_download_name(latest.name, version, debug),
        size=stat.st_size,
        sha256=_sha256(str(latest), stat.st_mtime_ns, stat.st_size),
        version=version,
        variant=variant or ("debug" if debug else "release"),
        debug=debug,
    )


def inspect_local_apk() -> Optional[LocalArtifact]:
    """返回 ota.apk_dir 中最新 APK 的元数据；缺失或越界符号链接返回 None。"""
    root = Path(_ota_dir())
    if not root.is_dir():
        return None
    candidates = [
        path
        for path in root.glob("*.apk")
        if path.is_file() and _is_within(path, root)
    ]
    if not candidates:
        return None
    latest = max(candidates, key=lambda path: path.stat().st_mtime_ns)
    return inspect_apk_file(str(latest))


def inspect_local_desktop() -> Optional[LocalArtifact]:
    """返回 desktop/release 中最新 Kinship 安装包的元数据。"""
    root = Path(desktop_release_dir())
    if not root.is_dir():
        return None
    candidates = [
        path
        for path in root.glob(_DESKTOP_PATTERN)
        if path.is_file()
        and not path.name.endswith(".blockmap")
        and _is_within(path, root)
    ]
    if not candidates:
        return None
    latest = max(candidates, key=lambda path: path.stat().st_mtime_ns)
    stat = latest.stat()
    return LocalArtifact(
        path=str(latest),
        source_filename=latest.name,
        download_name=latest.name,
        size=stat.st_size,
        sha256=_sha256(str(latest), stat.st_mtime_ns, stat.st_size),
        version=_desktop_version(latest.name),
        variant=None,
        debug=False,
    )
