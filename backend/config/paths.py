# -*- coding: utf-8 -*-
"""项目路径解析单点。

所有需要项目根的模块必须经这里取路径，禁止再手写
``Path(__file__).resolve().parents[N]``。staging / 安装器可用
``AXEUH_PROJECT_ROOT`` 指到隔离根，默认行为与历史完全一致。

导入本模块无副作用：不读配置文件、不建目录、不探测环境。
"""
from __future__ import annotations

import os
from pathlib import Path, PurePosixPath, PureWindowsPath

_DEFAULT_PROJECT_ROOT = Path(__file__).resolve().parents[2]

_AUTH_STATE_ENV_KEYS = ("AXEUH_AUTH_STATE_DIR", "AEUH_AUTH_STATE_DIR")
_DATA_ROOT_ENV = "AXEUH_DATA_ROOT"
_MODELS_DIR_ENV = "AXEUH_MODELS_DIR"


def project_root() -> Path:
    """返回项目根目录；``AXEUH_PROJECT_ROOT`` 优先（staging 隔离入口）。"""
    override = os.environ.get("AXEUH_PROJECT_ROOT", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    return _DEFAULT_PROJECT_ROOT


def backend_dir() -> Path:
    return project_root() / "backend"


def frontend_mobile_dir() -> Path:
    return project_root() / "frontend" / "mobile"


def frontend_dist_dir() -> Path:
    return frontend_mobile_dir() / "dist"


def kernel_dir() -> Path:
    return project_root() / "kernel"


def ai_dir() -> Path:
    return project_root() / "ai"


def default_auth_state_dir() -> Path:
    """认证状态目录：显式 env 覆盖优先，否则 backend/config。"""
    for key in _AUTH_STATE_ENV_KEYS:
        override = os.environ.get(key, "").strip()
        if override:
            return Path(override).expanduser()
    return backend_dir() / "config"


def _is_absolute_path(raw: str, *, windows: bool | None = None) -> bool:
    """判断路径是否绝对；``windows`` 可显式模拟 Windows 语义（供测试用）。"""
    if windows is None:
        windows = os.name == "nt"
    probe = PureWindowsPath(raw) if windows else PurePosixPath(raw)
    return probe.is_absolute()


def _configured_path(attribute: str) -> str:
    """读取 Config 属性；import 延迟到调用期，保持本模块导入零副作用。"""
    from .config import get_config

    return str(getattr(get_config(), attribute, "") or "").strip()


def _resolve_from_project_root(raw: str, *, windows: bool | None = None) -> Path:
    """相对路径按项目根解析，返回绝对路径（``~`` 先展开）。

    ``windows`` 与 ``_is_absolute_path`` 同义，仅用于测试模拟平台语义。
    """
    expanded = Path(raw).expanduser()
    if _is_absolute_path(str(expanded), windows=windows):
        return expanded.resolve()
    return (project_root() / expanded).resolve()


def data_root() -> Path:
    """运行时数据根：env ``AXEUH_DATA_ROOT`` -> config ``data.root`` -> ``<项目根>/var``。

    相对路径（env 与 config 同规则）按项目根解析；恒返回绝对路径。
    """
    override = os.environ.get(_DATA_ROOT_ENV, "").strip()
    if override:
        return _resolve_from_project_root(override)
    configured = _configured_path("DATA_ROOT")
    if configured:
        return _resolve_from_project_root(configured)
    return (project_root() / "var").resolve()


def models_root() -> Path:
    """模型根：env ``AXEUH_MODELS_DIR`` -> config ``models.dir`` -> ``<data_root>/models``。

    相对路径按项目根解析；恒返回绝对路径。
    """
    override = os.environ.get(_MODELS_DIR_ENV, "").strip()
    if override:
        return _resolve_from_project_root(override)
    configured = _configured_path("MODELS_DIR")
    if configured:
        return _resolve_from_project_root(configured)
    return (data_root() / "models").resolve()


def secrets_dir() -> Path:
    """密钥目录：``<data_root>/secrets``。"""
    return data_root() / "secrets"


def runtime_dir() -> Path:
    """运行时目录（pid/lock 等）：``<data_root>/run``。"""
    return data_root() / "run"


def logs_dir() -> Path:
    """日志目录：``<data_root>/logs``。"""
    return data_root() / "logs"
