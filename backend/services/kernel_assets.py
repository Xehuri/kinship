# -*- coding: utf-8 -*-
"""内核资产：只读巡检与发行包安装。

``inspect`` 绝不 import/调用 ``KernelClient``（不 ensure、不 spawn）；它只读
配置/pidfile，并在 pid 存活时用短超时 GET 本地 ``/v1/health``。内核包安装
遵守 C1 守卫：源码检出（有 ``axeuh_kernel/__init__.py`` 且无发行标记）拒绝
覆盖；非空且无标记的目录同样拒绝。
"""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import sys
import tempfile
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterable, Mapping, Optional

from config.paths import project_root as _paths_project_root
from services import kernel_model_paths
from services.release_assets import (
    DOWNLOAD_BACKOFF_S,
    Asset,
    ManifestError,
    ReleaseAssetError,
    ReleaseManifest,
    download_asset,
    ensure_no_links,
    extract_tarball,
)

logger = logging.getLogger(__name__)

INSTALL_MARKER = ".installed-from-release"
DEFAULT_KERNEL_PYTHONS = (Path("/opt/kinship/.venv-kernel/bin/python"),)
_WINDOWS = os.name == "nt"
_VERSION_RE = re.compile(
    r"^(?:__version__|API_VERSION|PACKAGE_VERSION)\s*=\s*[\"']([^\"']+)[\"']",
    re.MULTILINE,
)


def default_model_dir() -> Path:
    """未配置 ``kernel.model_dir`` 时的模型目录（``<models_root>/.cache/...``）。"""
    return kernel_model_paths.default_model_dir()


def _project_path(project_root: Path | str | None) -> Path:
    if project_root is None:
        return _paths_project_root().resolve()
    return Path(project_root).expanduser().resolve()


def _config(name: str, default: object = "") -> object:
    try:
        from config.config import get_config

        return getattr(get_config(), name, default)
    except Exception:
        return default


def _default_state_dir(project_root: Path) -> Path:
    env = os.environ.get("AXEUH_KERNEL_STATE_DIR", "").strip()
    if env:
        return Path(env).expanduser()
    configured = str(_config("KERNEL_STATE_DIR", "") or "").strip()
    if configured:
        return Path(configured).expanduser()
    return project_root / "backend" / "data" / "kernel_state"


def resolve_kernel_python(
    project_root: Path | str | None = None,
    *,
    configured: str | None = None,
    env: str | None = None,
    candidates: Iterable[Path | str] | None = None,
    sys_executable: str | None = None,
) -> dict:
    """按 config > env > /opt venv > 项目 venv > 后端解释器解析。"""
    root = _project_path(project_root)
    configured_value = (
        str(_config("KERNEL_PYTHON", "") or "") if configured is None else configured
    ).strip()
    env_value = (
        os.environ.get("AXEUH_KERNEL_PYTHON", "") if env is None else env
    ).strip()
    entries: list[tuple[str, str]] = []
    if configured_value:
        entries.append((configured_value, "config"))
    if env_value:
        entries.append((env_value, "env"))
    for candidate in DEFAULT_KERNEL_PYTHONS if candidates is None else candidates:
        entries.append((str(candidate), "default"))
    venv_dir = root / ".venv-kernel"
    venv_python = (
        venv_dir / "Scripts" / "python.exe"
        if _WINDOWS
        else venv_dir / "bin" / "python"
    )
    entries.append((str(venv_python), "venv"))
    entries.append((sys_executable or sys.executable, "backend"))

    for raw, source in entries:
        path = Path(raw).expanduser()
        if not path.is_absolute():
            path = root / path
        if path.exists():
            return {
                "path": str(path),
                "source": source,
                "exists": True,
                "configured": configured_value,
                "configured_exists": bool(
                    configured_value
                    and (root / Path(configured_value).expanduser()).exists()
                ),
                "last_resort": source == "backend",
            }
    raw, source = entries[0] if entries else ("", "none")
    return {
        "path": raw,
        "source": source,
        "exists": False,
        "configured": configured_value,
        "configured_exists": False,
        "last_resort": False,
    }


def _read_kernel_version(kernel_dir: Path) -> Optional[str]:
    marker = kernel_dir / INSTALL_MARKER
    if marker.is_file():
        try:
            data = json.loads(marker.read_text(encoding="utf-8"))
            version = data.get("version") if isinstance(data, dict) else None
            if isinstance(version, str) and version.strip():
                return version.strip()
        except (OSError, ValueError):
            pass
    build_info = kernel_dir / "BUILD_INFO.json"
    if build_info.is_file():
        try:
            data = json.loads(build_info.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                for key in ("package_version", "version", "api_version"):
                    value = data.get(key)
                    if isinstance(value, str) and value.strip():
                        return value.strip()
        except (OSError, ValueError):
            pass
    init = kernel_dir / "axeuh_kernel" / "__init__.py"
    if init.is_file():
        try:
            match = _VERSION_RE.search(init.read_text(encoding="utf-8", errors="replace"))
            if match:
                return match.group(1)
        except OSError:
            pass
    return None


def kernel_install_guard(project_root: Path | str | None = None) -> Optional[str]:
    """返回拒绝安装的稳定错误码；``None`` 表示允许安装。"""
    target = _project_path(project_root) / "kernel"
    if not target.exists():
        return None
    if (target / INSTALL_MARKER).is_file():
        return None
    if (target / "axeuh_kernel" / "__init__.py").is_file():
        return "kernel_install_forbidden_dev_checkout"
    try:
        entries = [entry for entry in target.iterdir()]
    except OSError:
        return "kernel_install_target_unreadable"
    if entries:
        return "kernel_install_target_not_empty"
    return None


def _windows_pid_alive(pid: int) -> bool:
    """Windows 存活探测：句柄查询，绝不调用 ``os.kill``。

    Windows 上 ``os.kill(pid, 0)`` 会走 TerminateProcess 直接杀掉目标进程，
    因此只读巡检必须改用 OpenProcess + GetExitCodeProcess。
    """
    import ctypes

    process_query_limited_information = 0x1000
    still_active = 259
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(
        process_query_limited_information, False, int(pid)
    )
    if not handle:
        return False
    try:
        code = ctypes.c_ulong()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
            return False
        return code.value == still_active
    finally:
        kernel32.CloseHandle(handle)


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if _WINDOWS:
        return _windows_pid_alive(pid)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _read_pidfile(state_dir: Path) -> dict | None:
    path = state_dir / "kernel.pid"
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        return {"_error": "pidfile_invalid"}
    return raw if isinstance(raw, dict) else {"_error": "pidfile_invalid"}


def _probe_health(port: int, timeout: float = 1.0) -> bool:
    url = f"http://127.0.0.1:{int(port)}/v1/health"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return getattr(response, "status", 200) == 200
    except Exception:
        return False


def _health_status(
    state_dir: Path,
    link: Mapping | None,
    *,
    probe: Callable[[int], bool] | None = None,
) -> dict:
    path = state_dir / "kernel.pid"
    status: dict = {
        "pidfile": str(path),
        "found": link is not None,
        "pid": None,
        "port": None,
        "alive": False,
        "healthy": False,
        "api_version": None,
        "base_url": None,
        "error": None,
    }
    if link is None:
        status["error"] = "pidfile_missing"
        return status
    if link.get("_error"):
        status["error"] = str(link["_error"])
        return status
    try:
        pid = int(link.get("pid"))
        port = int(link.get("port"))
    except (TypeError, ValueError):
        status["error"] = "pidfile_invalid"
        return status
    status.update(
        {
            "pid": pid,
            "port": port,
            "api_version": link.get("api_version"),
            "base_url": f"http://127.0.0.1:{port}",
        }
    )
    alive = _pid_alive(pid)
    status["alive"] = alive
    if not alive:
        status["error"] = "stale_pidfile"
        return status
    checker = probe or _probe_health
    try:
        healthy = bool(checker(port))
    except Exception:
        healthy = False
    status["healthy"] = healthy
    if not healthy:
        status["error"] = "health_unreachable"
    return status


def inspect(
    project_root: Path | str | None = None,
    *,
    manifest: ReleaseManifest | None = None,
    state_dir: Path | str | None = None,
    kernel_python: str | None = None,
    model_dir: str | None = None,
    python_candidates: Iterable[Path | str] | None = None,
    sys_executable: str | None = None,
    health_probe: Callable[[int], bool] | None = None,
    disk_usage: Callable[[str], object] | None = None,
) -> dict:
    """只读巡检：不 ensure/spawn 内核，不启动任何子进程。"""
    root = _project_path(project_root)
    kernel_dir = root / "kernel"
    marker = kernel_dir / INSTALL_MARKER
    package_init = kernel_dir / "axeuh_kernel" / "__init__.py"
    present = kernel_dir.is_dir()
    if marker.is_file():
        origin = "release"
    elif package_init.is_file():
        origin = "source"
    elif present:
        origin = "unknown"
    else:
        origin = None
    guard = kernel_install_guard(root)
    python = resolve_kernel_python(
        root,
        configured=kernel_python,
        candidates=python_candidates,
        sys_executable=sys_executable,
    )

    raw_model_dir = (
        str(_config("KERNEL_MODEL_DIR", "") or "") if model_dir is None else model_dir
    ).strip()
    model_path = (
        Path(raw_model_dir).expanduser() if raw_model_dir else default_model_dir()
    )
    if not model_path.is_absolute():
        model_path = root / model_path
    state_path = (
        Path(state_dir).expanduser() if state_dir is not None else _default_state_dir(root)
    )
    health = _health_status(state_path, _read_pidfile(state_path), probe=health_probe)

    kernel_asset = manifest.assets.get("kernel") if manifest is not None else None
    required = int((kernel_asset.size or 0) * 1.2) if kernel_asset else 0
    usage = (disk_usage or shutil.disk_usage)(str(root))
    free = int(getattr(usage, "free", 0))
    return {
        "kernel": {
            "dir": str(kernel_dir),
            "present": present,
            "source": origin,
            "version": _read_kernel_version(kernel_dir) if present else None,
            "marker": str(marker),
            "installed_from_release": marker.is_file(),
            "installable": guard is None,
            "install_blocked_reason": guard,
        },
        "python": python,
        "models": {
            "model_dir": str(model_path),
            "configured": bool(raw_model_dir),
            "exists": model_path.is_dir(),
        },
        "disk": {
            "path": str(root),
            "free": free,
            "required": required,
            "sufficient": free >= required,
        },
        "health": health,
    }


def _install_tree(staging: Path, target: Path) -> None:
    if not target.exists():
        os.replace(staging, target)
        return
    backup = target.parent / f".{target.name}.backup-{uuid.uuid4().hex}"
    os.replace(target, backup)
    try:
        os.replace(staging, target)
    except OSError:
        os.replace(backup, target)
        raise
    shutil.rmtree(backup, ignore_errors=True)


def download_kernel(
    manifest: ReleaseManifest,
    project_root: Path | str | None = None,
    *,
    asset_name: str = "kernel",
    progress: Callable[[int, Optional[int]], None] | None = None,
    cancel_event=None,
    phase: Callable[[str], None] | None = None,
    timeout: float = 60.0,
    retries: int = 3,
    backoff: Iterable[float] = DOWNLOAD_BACKOFF_S,
    sleep: Callable[[float], None] | None = None,
    disk_usage: Callable[[str], object] | None = None,
) -> dict:
    """下载、校验并原子安装内核发行包；任何前置失败都不触网。

    ``phase`` 在下载/校验/解包/安装边界被调用，供引导作业映射
    ``job.current``；全部阶段名固定为 ``download``/``verify``/``extract``/
    ``install``。
    """
    from time import sleep as _sleep

    sleep_fn = sleep or _sleep

    def _phase(name: str) -> None:
        if phase is not None:
            phase(name)

    root = _project_path(project_root)
    asset = manifest.assets.get(asset_name)
    if asset is None:
        raise ManifestError("kernel_asset_missing", "manifest has no kernel asset")
    file_name = (asset.file or "").strip()
    if (
        not file_name
        or file_name in {".", ".."}
        or Path(file_name).name != file_name
        or "/" in file_name
        or "\\" in file_name
    ):
        raise ReleaseAssetError("invalid_asset_file", "asset filename is not safe")
    guard = kernel_install_guard(root)
    if guard is not None:
        raise ReleaseAssetError(guard, "kernel install is not allowed in this tree")
    if asset.size:
        required = int(asset.size * 1.2)
        usage = (disk_usage or shutil.disk_usage)(str(root))
        free = int(getattr(usage, "free", 0))
        if free < required:
            raise ReleaseAssetError(
                "insufficient_disk",
                f"kernel package needs {required} bytes free, {free} available",
            )
    work = Path(tempfile.mkdtemp(prefix=".kernel-download-", dir=str(root)))
    archive = work / file_name
    staging = work / "staging"
    try:
        _phase("download")
        downloaded = download_asset(
            asset,
            archive,
            progress=progress,
            cancel_event=cancel_event,
            timeout=timeout,
            retries=retries,
            backoff=backoff,
            sleep=sleep_fn,
        )
        _phase("verify")
        _phase("extract")
        extract_tarball(
            archive,
            staging,
            asset=asset.name,
            cancel_event=cancel_event,
            overwrite=False,
        )
        package_dir = staging / "axeuh_kernel"
        if not package_dir.is_dir() or not any(package_dir.iterdir()):
            raise ReleaseAssetError(
                "kernel_package_invalid", "archive has no axeuh_kernel package"
            )
        ensure_no_links(staging, "kernel_links_forbidden")
        marker = {
            "asset": asset.name,
            "sha256": asset.sha256,
            "version": manifest.version,
            "installed_at": datetime.now(timezone.utc).isoformat(),
        }
        (staging / INSTALL_MARKER).write_text(
            json.dumps(marker, ensure_ascii=False, sort_keys=True), encoding="utf-8"
        )
        os.chmod(staging, 0o755)
        _phase("install")
        _install_tree(staging, root / "kernel")
        logger.info(
            "[OnboardingAssets] phase=install asset=%s version=%s result=ok",
            asset.name,
            manifest.version,
        )
        return {
            "path": str(root / "kernel"),
            "asset": asset.name,
            "version": manifest.version,
            "sha256": asset.sha256,
            "bytes": downloaded["bytes"],
        }
    finally:
        shutil.rmtree(work, ignore_errors=True)


def verify_kernel_installed(project_root: Path | str | None = None) -> dict:
    """安装后只读复核：标记、包目录与版本。"""
    root = _project_path(project_root)
    kernel_dir = root / "kernel"
    marker = kernel_dir / INSTALL_MARKER
    return {
        "installed": marker.is_file()
        and (kernel_dir / "axeuh_kernel").is_dir(),
        "version": _read_kernel_version(kernel_dir),
        "path": str(kernel_dir),
    }


def __getattr__(name: str) -> object:
    """兼容旧常量名：``DEFAULT_MODEL_DIR`` 改为调用期解析的默认模型目录。"""
    if name == "DEFAULT_MODEL_DIR":
        return default_model_dir()
    raise AttributeError("module %r has no attribute %r" % (__name__, name))
