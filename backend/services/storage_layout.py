# -*- coding: utf-8 -*-
"""Read-only storage layout resolution for onboarding.

Resolves the live ``data.root``/``models.dir`` roots, reports free space,
writability, Windows system-drive placement and legacy cache detection. Nothing
here creates a directory, writes a file or migrates a cache; the module only
inspects the filesystem. HTTP concerns stay in
``routers/onboarding_storage.py``.
"""
from __future__ import annotations

import ntpath
import os
import shutil
from dataclasses import dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any, Literal

from config import paths
from config.config import get_config

_DATA_ROOT_ENV = "AXEUH_DATA_ROOT"
_MODELS_DIR_ENV = "AXEUH_MODELS_DIR"
_LEGACY_CACHE_ENTRIES = {
    "modelscope": Path(".cache") / "modelscope",
    "huggingface": Path(".cache") / "huggingface",
    "axeuh_kernel": Path(".cache") / "axeuh-kernel" / "models",
}

RootSource = Literal["env", "config", "default"]


@dataclass(frozen=True)
class StoragePathError:
    code: str
    message: str


def _configured_value(attribute: str) -> bool:
    try:
        return bool(str(getattr(get_config(), attribute, "") or "").strip())
    except Exception:
        return False


def root_source(env_key: str, attribute: str) -> RootSource:
    if os.environ.get(env_key, "").strip():
        return "env"
    if _configured_value(attribute):
        return "config"
    return "default"


def nearest_existing(path: Path) -> Path:
    probe = path
    while not probe.exists() and probe.parent != probe:
        probe = probe.parent
    return probe


def free_bytes(path: Path) -> int:
    try:
        return int(shutil.disk_usage(str(nearest_existing(path))).free)
    except OSError:
        return 0


def writable(path: Path) -> bool:
    try:
        return os.access(nearest_existing(path), os.W_OK)
    except OSError:
        return False


def is_system_drive(
    path: str,
    *,
    os_name: str | None = None,
    system_drive: str | None = None,
) -> bool:
    if (os_name or os.name) != "nt":
        return False
    drive = ntpath.splitdrive(str(path))[0].rstrip("\\/")
    if not drive:
        return False
    configured = (system_drive or os.environ.get("SystemDrive", "") or "C:").rstrip(
        "\\/"
    )
    return drive.upper() == configured.upper()


def system_drive_info(path: Path) -> tuple[bool, str | None]:
    if os.name != "nt":
        return False, None
    drive = ntpath.splitdrive(str(path))[0].rstrip("\\/")
    if not drive:
        return False, None
    return is_system_drive(str(path)), drive


def home_dir() -> Path:
    return Path.home()


def legacy_caches(home: Path | None = None) -> dict[str, Any]:
    resolved_home = home if home is not None else home_dir()
    entries = {
        key: resolved_home / relative
        for key, relative in _LEGACY_CACHE_ENTRIES.items()
    }
    found = {key: bool(path.exists()) for key, path in entries.items()}
    exists = any(found.values())
    return {
        "home": str(resolved_home),
        "suggested_root": str(resolved_home) if exists else None,
        "exists": exists,
        "modelscope": found["modelscope"],
        "huggingface": found["huggingface"],
        "axeuh_kernel": found["axeuh_kernel"],
        "paths": {key: str(path) for key, path in entries.items()},
    }


def storage_warnings(
    models_root: Path,
    *,
    source: str,
    system_disk: bool,
    system_drive: str | None,
    is_writable: bool,
) -> list[str]:
    warnings: list[str] = []
    if system_disk:
        label = f"（{system_drive}）" if system_drive else ""
        warnings.append(
            f"模型根位于系统盘{label}，系统盘空间紧张时会影响系统稳定性；"
            "建议改到独立数据盘。"
        )
    if not is_writable:
        warnings.append(
            f"模型根当前不可写：{models_root}。请选择可写目录或修正权限后重试。"
        )
    if source == "env":
        warnings.append(
            "环境变量 AXEUH_MODELS_DIR 正在覆盖 models.dir；"
            "在移除该环境变量前，界面保存的模型根不会生效。"
        )
    return warnings


def snapshot() -> dict[str, Any]:
    data_root = paths.data_root()
    models_root = paths.models_root()
    source = {
        "data_root": root_source(_DATA_ROOT_ENV, "DATA_ROOT"),
        "models_root": root_source(_MODELS_DIR_ENV, "MODELS_DIR"),
    }
    system_disk, system_drive = system_drive_info(models_root)
    is_writable = writable(models_root)
    return {
        "data_root": str(data_root),
        "models_root": str(models_root),
        "free_bytes": free_bytes(models_root),
        "writable": is_writable,
        "source": source,
        "models_dir_configured": _configured_value("MODELS_DIR"),
        "data_root_configured": _configured_value("DATA_ROOT"),
        "legacy": legacy_caches(),
        "system_disk": system_disk,
        "system_drive": system_drive,
        "warnings": storage_warnings(
            models_root,
            source=source["models_root"],
            system_disk=system_disk,
            system_drive=system_drive,
            is_writable=is_writable,
        ),
    }


def is_absolute(raw: str, *, os_name: str | None = None) -> bool:
    windows = (os_name or os.name) == "nt"
    probe = PureWindowsPath(raw) if windows else PurePosixPath(raw)
    return probe.is_absolute()


def is_root_path(raw: str, *, os_name: str | None = None) -> bool:
    windows = (os_name or os.name) == "nt"
    probe = PureWindowsPath(raw) if windows else PurePosixPath(raw)
    return probe.parent == probe


def validate_models_dir(
    raw: Any,
) -> tuple[Path | None, StoragePathError | None]:
    if not isinstance(raw, str):
        return None, StoragePathError("invalid_request", "models_dir 必须是字符串")
    candidate = raw.strip()
    if not candidate:
        return None, StoragePathError("invalid_models_dir", "模型根目录不能为空")
    if "\x00" in candidate:
        return None, StoragePathError(
            "invalid_models_dir", "模型根目录包含非法字符"
        )
    if not is_absolute(candidate):
        return None, StoragePathError(
            "models_dir_not_absolute", "模型根目录必须是绝对路径"
        )
    if is_root_path(candidate):
        return None, StoragePathError(
            "models_dir_too_broad", "不能把文件系统根目录设为模型根"
        )

    target = Path(os.path.abspath(candidate))
    if not is_absolute(str(target)):
        return None, StoragePathError(
            "models_dir_not_absolute", "模型根目录必须是绝对路径"
        )
    if is_root_path(str(target)):
        return None, StoragePathError(
            "models_dir_too_broad", "不能把文件系统根目录设为模型根"
        )
    if target.exists() and not target.is_dir():
        return None, StoragePathError(
            "models_dir_not_directory", f"目标路径不是目录：{target}"
        )
    parent = target.parent
    if not parent.is_dir():
        return None, StoragePathError(
            "models_dir_parent_missing", f"父目录不存在：{parent}"
        )
    if not os.access(parent, os.W_OK):
        return None, StoragePathError(
            "models_dir_parent_not_writable", f"父目录不可写：{parent}"
        )
    return target, None


__all__ = [
    "RootSource",
    "StoragePathError",
    "free_bytes",
    "home_dir",
    "is_absolute",
    "is_root_path",
    "is_system_drive",
    "legacy_caches",
    "nearest_existing",
    "root_source",
    "snapshot",
    "storage_warnings",
    "system_drive_info",
    "validate_models_dir",
    "writable",
]
