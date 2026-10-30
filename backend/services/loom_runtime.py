# -*- coding: utf-8 -*-
"""Loom 跨平台运行时管理：模式探测、token/配置供给、子进程生命周期。

契约边界（T6）：
  - 模式矩阵：``systemd``（systemctl 存在且 ``axeuh-loom`` 单元存在）>
    ``child``（``node`` 可执行且 ``loom-harness/packages/server/dist/cli.js`` 存在）>
    ``none``。发行版 dist 被 gitignore、也不在发布清单内，缺件时如实返回 none，
    绝不假装能拉起。
  - token 发现顺序与 ``loom_onboarding`` 完全一致；缺失时生成并写入
    ``<data_root>/secrets/loom.env``（0600），再把绝对路径持久化为
    ``loom.token_file``。对外只返回 found/source/fingerprint/provisioned。
  - 托管配置只在 ``loom.manage_config=true`` 时写入
    ``<ai_root>/.loom/config.yaml``；覆盖前备份，凭据只保留 ``${ENV_REF}``。
  - child 模式的 PID 记录包含 pid、进程启动时间、命令哈希、配置哈希。
    stop 只在 PID、启动时间、命令哈希全部可验证且一致时才发信号；任何一项
    不可验证或指向外来进程都拒绝，绝不 pkill/killall/taskkill 按名杀。
  - 密钥只进子进程环境，绝不进 argv、日志、异常或 HTTP 响应。

平台事实：
  - Windows 下 ``os.chmod(0o600)`` 只影响只读位，不落实 NTFS ACL；密钥仍放在
    用户数据根（``<data_root>/secrets``），依赖用户目录 ACL。这是已知残余风险。
  - Windows 无 SIGTERM；优雅退出退化为 TerminateProcess（本模块第二段仍保留
    有界等待，仅用于确认进程确实消失）。
"""

# allow: SIZE_OK - 单一 Loom 运行时状态机（模式/token/config/生命周期/指纹），任务契约要求单文件

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import secrets
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse

import aiohttp
import yaml

from config import paths
from config.config import Config, get_config
from config.store import get_config_store
from core.redaction import redact_text
from services import loom_onboarding

logger = logging.getLogger(__name__)

MODE_SYSTEMD = "systemd"
MODE_CHILD = "child"
MODE_AUTO = "auto"
MODE_NONE = "none"

# 迁移期模式开关：默认 child（后端托管），显式 systemd 才允许 systemctl。
LOOM_MODE_ENV = "AXEUH_LOOM_MODE"
DEFAULT_LOOM_MODE = MODE_CHILD
_LOOM_MODES = frozenset({MODE_CHILD, MODE_SYSTEMD, MODE_AUTO})

DEFAULT_SYSTEMD_UNIT = "axeuh-loom"
DEFAULT_PORT = 5100
MIN_LOOM_PORT = 5097
MAX_PORT = 65535

HEALTH_TIMEOUT_S = 2.0
START_HEALTH_TIMEOUT_S = 45.0
STOP_TIMEOUT_S = 15.0
PID_START_TOLERANCE_S = 5.0
POLL_INTERVAL_S = 0.5

SOURCE_PROVISIONED = "provisioned"

_ENV_REF_RE = re.compile(r"^\$\{[A-Za-z_][A-Za-z0-9_]*\}$")
_LOOM_ENV_FILENAME = "loom.env"
_PIDFILE_NAME = "loom.pid"
_LOGFILE_NAME = "loom.log"
_TEMPLATE_PATH = (
    Path(__file__).resolve().parents[1] / "resources" / "loom-config.template.yaml"
)

# Windows 常量：Linux 上 subprocess 不暴露这些名字，故显式写数值。
_WINDOWS = os.name == "nt"
_CREATE_NEW_PROCESS_GROUP = 0x00000200
_DETACHED_PROCESS = 0x00000008
_CREATE_NO_WINDOW = 0x08000000

# 本进程直接 spawn 的子进程句柄：及时 poll 回收，避免 POSIX 僵尸被误判为存活。
_MANAGED_CHILDREN: dict[int, Any] = {}


# ── 数据形状 ─────────────────────────────────────────────────


@dataclass(frozen=True)
class ProcessIdentity:
    """可验证的进程身份（不包含命令行原文，避免泄漏 argv）。"""

    alive: bool
    start_time: Optional[float]
    cmdline_hash: Optional[str]
    exe: Optional[str]


@dataclass(frozen=True)
class _TokenState:
    token: str = field(repr=False)
    public: dict[str, Any] = field(default_factory=dict)


# ── 路径与平台探测 ───────────────────────────────────────────


def _data_root() -> Path:
    return paths.data_root()


def _pidfile_path() -> Path:
    return _data_root() / "run" / _PIDFILE_NAME


def _logfile_path() -> Path:
    return _data_root() / "logs" / _LOGFILE_NAME


def _cli_path() -> Path:
    return (
        paths.project_root()
        / "loom-harness"
        / "packages"
        / "server"
        / "dist"
        / "cli.js"
    )


def _which(name: str) -> Optional[str]:
    try:
        return shutil.which(name)
    except OSError:
        return None


_EXEC_START_PATH_RE = re.compile(r"(?:path=|argv\[\]=)([^;}]*)")
_SYSTEMD_SHOW_PROPERTIES = (
    "MainPID,ActiveState,SubState,LoadState,Restart,"
    "WorkingDirectory,ExecStart,FragmentPath"
)


def _unit_path_value(raw: Any) -> str:
    """清理 systemd 路径属性：去掉 ``-``/``~`` 前缀与包裹引号。"""
    token = str(raw or "").strip()
    if token.startswith("-"):
        token = token[1:].strip()
    if token.startswith("~"):
        token = os.path.expanduser(token)
    return token.strip().strip("\"'")


def _normalize_unit_path(raw: Any) -> str:
    token = _unit_path_value(raw)
    if not token:
        return ""
    try:
        resolved = os.path.realpath(token)
    except (OSError, ValueError):
        resolved = token
    return os.path.normcase(os.path.normpath(resolved))


def _owned_unit_roots() -> tuple[str, ...]:
    """允许归属的目录：项目根与 Loom harness（生产单元的工作目录即后者）。"""
    root = paths.project_root()
    candidates = (_normalize_unit_path(root), _normalize_unit_path(root / "loom-harness"))
    return tuple(dict.fromkeys(item for item in candidates if item))


def _unit_path_within(value: str, roots: tuple[str, ...]) -> bool:
    if not value:
        return False
    for root in roots:
        if value == root or value.startswith(root + os.sep):
            return True
    return False


def _exec_start_paths(value: str) -> list[str]:
    """从 ``systemctl show -p ExecStart`` 的 structured 输出提取绝对路径。"""
    result: list[str] = []
    for match in _EXEC_START_PATH_RE.finditer(str(value or "")):
        chunk = match.group(1).strip()
        if not chunk:
            continue
        try:
            parts = shlex.split(chunk)
        except ValueError:
            parts = chunk.split()
        for part in parts:
            candidate = _unit_path_value(part)
            if candidate and os.path.isabs(candidate):
                result.append(candidate)
    return result


def _systemd_unit_owned(info: Optional[dict[str, str]]) -> bool:
    """单元是否属于当前 checkout；无法验证归属时一律视为外来，绝不放行。"""
    if not info:
        return False
    roots = _owned_unit_roots()
    working_directory = _normalize_unit_path(info.get("WorkingDirectory"))
    if working_directory and working_directory in roots:
        return True
    fragment = _normalize_unit_path(info.get("FragmentPath"))
    if roots and _unit_path_within(fragment, (roots[0],)):
        return True
    for token in _exec_start_paths(info.get("ExecStart") or ""):
        if _unit_path_within(_normalize_unit_path(token), roots):
            return True
    return False


def _systemd_unit_info(unit: str = DEFAULT_SYSTEMD_UNIT) -> Optional[dict[str, str]]:
    """返回单元属性；单元不存在（LoadState=not-found）返回 None。

    同时带归属判定所需的 ``WorkingDirectory``/``ExecStart``/``FragmentPath``；
    任一项无法取得都不影响本函数返回，归属判定按“未知即外来”处理。
    """
    try:
        completed = subprocess.run(
            [
                "systemctl",
                "show",
                unit,
                "-p",
                _SYSTEMD_SHOW_PROPERTIES,
                "--no-pager",
            ],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if completed.returncode != 0:
        return None
    info: dict[str, str] = {}
    for line in completed.stdout.splitlines():
        key, separator, value = line.partition("=")
        if separator:
            info[key.strip()] = value.strip()
    if not info or info.get("LoadState") in ("", "not-found"):
        return None
    return info


def _systemctl_run(action: str, unit: str = DEFAULT_SYSTEMD_UNIT) -> dict[str, Any]:
    """执行 systemctl 子命令；返回脱敏摘要，不写 /etc/systemd。"""
    try:
        completed = subprocess.run(
            ["systemctl", action, unit],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return {
            "ok": False,
            "returncode": None,
            "detail": redact_text(str(exc))[:300],
        }
    detail = (completed.stderr or completed.stdout or "").strip()
    return {
        "ok": completed.returncode == 0,
        "returncode": completed.returncode,
        "detail": redact_text(detail)[:300],
    }


def _mode_details(mode: Optional[str] = None) -> dict[str, Any]:
    """运行面细节；child 模式绝不执行 ``systemctl show``。

    ``mode`` 是已解析的模式（状态接口避免重复探测）；缺省时现场解析。
    systemd 是否探测只看环境开关，不看解析结果：env=child 且 node/dist
    缺失时解析结果是 none，但这里仍不得回退去调用 systemctl。
    """
    configured = _configured_mode()
    effective = detect_mode() if mode is None else mode
    probe_systemd = configured != MODE_CHILD
    systemctl = _which("systemctl")
    info = _systemd_unit_info() if (probe_systemd and systemctl) else None
    owned = _systemd_unit_owned(info)
    node = _which("node")
    cli = _cli_path()
    reasons: list[str] = []
    if probe_systemd and systemctl and info is None:
        reasons.append("systemd_unit_not_found")
    elif probe_systemd and systemctl and not owned:
        reasons.append("systemd_unit_foreign")
    if not systemctl:
        reasons.append("systemctl_missing")
    if not node:
        reasons.append("node_missing")
    if not cli.is_file():
        reasons.append("loom_harness_dist_missing")
    return {
        "mode_env": configured,
        "effective_mode": effective,
        "systemd": {
            "systemctl": bool(systemctl),
            "unit": DEFAULT_SYSTEMD_UNIT,
            "present": info is not None,
            "owned": owned,
            "load_state": (info or {}).get("LoadState"),
            "active_state": (info or {}).get("ActiveState"),
            "sub_state": (info or {}).get("SubState"),
            "pid": _parse_pid((info or {}).get("MainPID")),
        },
        "child": {
            "node": bool(node),
            "cli_path": str(cli),
            "cli_present": cli.is_file(),
        },
        "reasons": reasons,
    }


def _configured_mode() -> str:
    """读取 AXEUH_LOOM_MODE 并归一；非法值按默认 child 处理。"""
    raw = str(os.environ.get(LOOM_MODE_ENV, "") or "").strip().lower()
    return raw if raw in _LOOM_MODES else DEFAULT_LOOM_MODE


def _child_available() -> bool:
    return bool(_which("node")) and _cli_path().is_file()


def detect_mode(config: Optional[Config] = None) -> str:
    """环境开关优先：child 完全跳过 systemd 探测；auto 保留 systemd > child。"""
    del config  # 模式只依赖本机能力，保留参数供调用方统一签名
    configured = _configured_mode()
    if configured == MODE_CHILD:
        return MODE_CHILD if _child_available() else MODE_NONE

    if _which("systemctl"):
        info = _systemd_unit_info()
        if info is not None:
            if not _systemd_unit_owned(info):
                return MODE_NONE
            return MODE_SYSTEMD
    if configured == MODE_SYSTEMD:
        return MODE_NONE
    return MODE_CHILD if _child_available() else MODE_NONE


# ── 小工具 ───────────────────────────────────────────────────


def _parse_pid(value: Any) -> Optional[int]:
    try:
        pid = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    return pid if pid > 0 else None


def _hash_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _hash_argv(argv: list[str]) -> str:
    return _hash_text("\0".join(argv))


def _hash_file(path: Path) -> str:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return ""


def _best_effort_chmod(path: Path, mode: int) -> None:
    """POSIX 落权限；Windows 的 chmod 不映射 ACL，失败一律忽略。"""
    try:
        os.chmod(path, mode)
    except (OSError, NotImplementedError):
        pass


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_error(exc: BaseException, token: str = "") -> str:
    text = str(exc)
    if token:
        text = text.replace(token, "***")
    return redact_text(text)[:300]


def _error(code: str, message: str) -> dict[str, str]:
    return {"code": code, "message": message}


# ── token 供给 ───────────────────────────────────────────────


def _write_secret_env(path: Path, token: str) -> None:
    """原子写 ``LOOM_TOKEN=...``，文件目标权限 0600。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    _best_effort_chmod(path.parent, 0o700)
    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent)
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(f"LOOM_TOKEN={token}\n")
            handle.flush()
            os.fsync(handle.fileno())
        _best_effort_chmod(Path(tmp_name), 0o600)
        os.replace(tmp_name, path)
        _best_effort_chmod(path, 0o600)
        try:
            dir_fd = os.open(str(path.parent), os.O_RDONLY)
        except OSError:
            dir_fd = None
        if dir_fd is not None:
            try:
                os.fsync(dir_fd)
            except OSError:
                pass
            finally:
                os.close(dir_fd)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def _persist_token_file(path: Path) -> tuple[bool, Optional[dict[str, str]]]:
    """把 token_file 绝对路径写进既有 config store（热写，无覆盖层旁路）。"""
    try:
        get_config_store().save({"loom.token_file": str(path)})
        return True, None
    except Exception as exc:  # 配置层错误统一收口为可外发摘要
        logger.warning("[LoomRuntime] loom.token_file 持久化失败")
        return False, _error("config_persist_failed", _safe_error(exc))


def _token_public(
    *,
    found: bool,
    source: str,
    fingerprint_value: str,
    provisioned: bool,
    token_file: Optional[str],
    persisted: bool,
    detail: str,
    errors: list[dict[str, str]],
) -> dict[str, Any]:
    return {
        "found": found,
        "source": source,
        "fingerprint": fingerprint_value,
        "provisioned": provisioned,
        "token_file": token_file,
        "persisted": persisted,
        "detail": detail,
        "errors": errors,
    }


def _ensure_token_internal(
    config: Optional[Config] = None,
    *,
    data_root: Optional[Path] = None,
    persist: bool = True,
) -> _TokenState:
    """内部解析/供给 token；token 仅在本函数返回值内流动。"""
    cfg = config or get_config()
    token, source, detail = loom_onboarding._resolve_token(cfg)
    if token:
        return _TokenState(
            token=token,
            public=_token_public(
                found=True,
                source=source,
                fingerprint_value=loom_onboarding.fingerprint(token),
                provisioned=False,
                token_file=cfg.LOOM_TOKEN_FILE or None,
                persisted=False,
                detail=detail,
                errors=[],
            ),
        )

    base = Path(data_root) if data_root is not None else _data_root()
    env_path = base / "secrets" / _LOOM_ENV_FILENAME
    errors: list[dict[str, str]] = []
    provisioned = False
    existing = ""
    try:
        existing = loom_onboarding._read_loom_token_file(str(env_path)).strip()
    except OSError:
        existing = ""

    if existing:
        token = existing
        source = "token_file"
        detail = f"loom.env: {env_path}"
    else:
        token = secrets.token_urlsafe(32)
        try:
            _write_secret_env(env_path, token)
        except OSError as exc:
            logger.error("[LoomRuntime] token 写入失败 path=%s", env_path)
            return _TokenState(
                token="",
                public=_token_public(
                    found=False,
                    source=SOURCE_PROVISIONED,
                    fingerprint_value="",
                    provisioned=False,
                    token_file=None,
                    persisted=False,
                    detail="无法写入 loom.env",
                    errors=[_error("token_write_failed", _safe_error(exc))],
                ),
            )
        provisioned = True
        source = SOURCE_PROVISIONED
        detail = f"已生成 {env_path}"

    persisted, persist_error = _persist_token_file(env_path) if persist else (False, None)
    if persist_error:
        errors.append(persist_error)

    fingerprint_value = loom_onboarding.fingerprint(token)
    logger.info(
        "[LoomRuntime] token ready source=%s provisioned=%s fingerprint=%s persisted=%s",
        source,
        provisioned,
        fingerprint_value,
        persisted,
    )
    return _TokenState(
        token=token,
        public=_token_public(
            found=True,
            source=source,
            fingerprint_value=fingerprint_value,
            provisioned=provisioned,
            token_file=str(env_path),
            persisted=persisted,
            detail=detail,
            errors=errors,
        ),
    )


def ensure_token(
    config: Optional[Config] = None,
    *,
    data_root: Optional[Path] = None,
) -> dict[str, Any]:
    """发现或生成 token；返回值永不含 token 本体。"""
    return _ensure_token_internal(config, data_root=data_root).public


# ── 配置供给 ─────────────────────────────────────────────────


def _port_from_url(url: str) -> tuple[Optional[int], str]:
    if not str(url or "").strip():
        return None, "loom.url 为空"
    parsed = urlparse(str(url or ""))
    try:
        port = parsed.port
    except ValueError:
        return None, "loom.url 端口非法"
    if port is None:
        port = DEFAULT_PORT
    if not (1 <= port <= MAX_PORT):
        return None, "loom.url 端口超出范围"
    if port < MIN_LOOM_PORT:
        return None, f"Loom 端口下限为 {MIN_LOOM_PORT}（当前 {port}）"
    return port, ""


def _loopback_host(url: str) -> Optional[str]:
    parsed = urlparse(str(url or ""))
    host = (parsed.hostname or "127.0.0.1").lower()
    return host


def _yaml_scalar(value: str) -> str:
    """双引号 YAML 标量；JSON 字符串转义在 YAML 中同样合法。"""
    return json.dumps(value, ensure_ascii=False)


def _env_slug(value: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9]+", "_", value).strip("_").upper()
    return slug or "DEFAULT"


def _credential_ref(provider: str, credential_env: Optional[str]) -> tuple[str, str]:
    raw = (credential_env or f"LOOM_KEY_{_env_slug(provider)}").strip()
    if not raw:
        return "", "credential_env 不能为空"
    ref = raw if raw.startswith("${") else f"${{{raw}}}"
    if not _ENV_REF_RE.match(ref):
        return "", "credentials 只允许 ${ENV_VAR} 形式"
    return ref, ""


def _render_template(
    selection: loom_onboarding.Selection,
    config: Config,
    *,
    credential_env: Optional[str],
) -> tuple[Optional[dict[str, Any]], Optional[str], list[dict[str, str]]]:
    """渲染资源模板为配置文档；返回 (doc, rendered_text, errors)。"""
    errors: list[dict[str, str]] = []
    provider = selection.provider.strip()
    model_id = selection.model.strip()
    base_url = (selection.base_url or "").strip()
    if not provider:
        errors.append(_error("provider_required", "必须选择渠道（provider）"))
    if not model_id:
        errors.append(_error("model_required", "必须选择主模型"))
    if not base_url or not re.match(r"^https?://", base_url):
        errors.append(_error("base_url_required", "新增配置必须提供 http(s) base_url"))
    credential_ref, credential_error = _credential_ref(provider, credential_env)
    if credential_error:
        errors.append(_error("credential_ref_invalid", credential_error))

    port, port_error = _port_from_url(config.LOOM_URL)
    if port_error:
        errors.append(_error("port_invalid", port_error))

    context_window = (
        128000 if selection.context_window is None else selection.context_window
    )
    max_output = 8192 if selection.max_output is None else selection.max_output
    timeout = 600000 if selection.timeout is None else selection.timeout
    if context_window < 1024 or max_output < 1 or max_output > context_window:
        errors.append(
            _error("model_limits_invalid", "context_window/max_output 不合法")
        )
    if timeout <= 0:
        errors.append(_error("model_timeout_invalid", "timeout 必须为正整数"))

    pricing = selection.pricing or {}
    price_values: dict[str, float] = {}
    for key in ("input", "output", "cacheRead", "cacheWrite"):
        value = pricing.get(key, 0)
        if (
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or value < 0
        ):
            errors.append(_error("pricing_invalid", f"pricing.{key} 必须为不小于 0 的数字"))
            value = 0
        price_values[key] = float(value)

    if errors:
        return None, None, errors
    if not _TEMPLATE_PATH.is_file():
        return None, None, [
            _error("template_missing", f"缺少模板: {_TEMPLATE_PATH}")
        ]

    replacements = {
        "{{PORT}}": str(port),
        "{{WORKSPACE}}": _yaml_scalar(str(Path(config.AI_ROOT).resolve())),
        "{{PROVIDER}}": _yaml_scalar(provider),
        "{{BASE_URL}}": _yaml_scalar(base_url),
        "{{MODEL}}": _yaml_scalar(model_id),
        "{{CONTEXT_WINDOW}}": str(int(context_window)),
        "{{MAX_OUTPUT}}": str(int(max_output)),
        "{{VISION}}": "true" if selection.vision else "false",
        "{{TIMEOUT}}": str(int(timeout)),
        "{{PRICE_INPUT}}": str(price_values["input"]),
        "{{PRICE_OUTPUT}}": str(price_values["output"]),
        "{{PRICE_CACHE_READ}}": str(price_values["cacheRead"]),
        "{{PRICE_CACHE_WRITE}}": str(price_values["cacheWrite"]),
        "{{CREDENTIAL_REF}}": _yaml_scalar(credential_ref),
    }
    text = _TEMPLATE_PATH.read_text(encoding="utf-8")
    for placeholder, value in replacements.items():
        text = text.replace(placeholder, value)
    try:
        doc = yaml.safe_load(text)
    except yaml.YAMLError:
        return None, None, [_error("template_invalid", "模板渲染结果不是合法 YAML")]
    if not isinstance(doc, dict):
        return None, None, [_error("template_invalid", "模板渲染结果顶层不是映射")]
    return doc, text, []


def _validate_required_keys(doc: dict[str, Any]) -> list[dict[str, str]]:
    """Loom 加载器硬键 + 本模板固定段的复核。"""
    errors: list[dict[str, str]] = []
    for key in ("server", "workspace", "providers", "models", "pricing", "credentials"):
        if key not in doc:
            errors.append(_error("config_invalid", f"缺少顶层键 {key}"))
    server = doc.get("server")
    if isinstance(server, dict):
        port = server.get("port")
        if not isinstance(port, int) or isinstance(port, bool) or not (
            MIN_LOOM_PORT <= port <= MAX_PORT
        ):
            errors.append(_error("config_invalid", f"server.port 必须 >= {MIN_LOOM_PORT}"))
        hostname = server.get("hostname")
        if not isinstance(hostname, str) or not hostname:
            errors.append(_error("config_invalid", "server.hostname 缺失"))
    else:
        errors.append(_error("config_invalid", "server 必须是映射"))
    workspace = doc.get("workspace")
    if not isinstance(workspace, str) or not workspace:
        errors.append(_error("config_invalid", "workspace 必须是非空字符串"))
    return errors


def _config_path(config: Optional[Config] = None) -> Path:
    return loom_onboarding.managed_config_path(config)


def _ensure_ai_instance(config: Config) -> dict[str, Any]:
    """托管配置前置：按运行时同一项目根/AI 根补齐 AI 实例，幂等不覆盖。"""
    from services import onboarding_service

    return onboarding_service.ensure_ai_instance(
        project_root=paths.project_root(), ai_root=config.AI_ROOT
    )


def ensure_config(
    selection: loom_onboarding.Selection,
    config: Optional[Config] = None,
    *,
    config_path: Optional[Path] = None,
    overwrite: bool = False,
    credential_env: Optional[str] = None,
) -> dict[str, Any]:
    """托管模式下生成最小 Loom 配置；外部模式只报告、不落盘。"""
    cfg = config or get_config()
    path = Path(config_path) if config_path else _config_path(cfg)
    result: dict[str, Any] = {
        "ok": False,
        "managed": bool(cfg.LOOM_MANAGE_CONFIG),
        "path": str(path),
        "exists": path.exists(),
        "created": False,
        "overwritten": False,
        "backup": None,
        "manual_required": False,
        "validation": "skipped",
        "credential_ref": None,
        "ai_instance": None,
        "errors": [],
    }
    if not result["managed"]:
        result["ok"] = True
        result["manual_required"] = not path.exists()
        result["detail"] = (
            "外部托管模式：不写入 Loom 配置"
            if path.exists()
            else "外部托管模式：请手工创建 .loom/config.yaml"
        )
        return result

    from services import onboarding_service

    try:
        result["ai_instance"] = _ensure_ai_instance(cfg)
    except onboarding_service.OnboardingActionError as exc:
        result["ai_instance"] = {"ok": False, "code": exc.code}
        result["errors"] = [_error(exc.code, _safe_error(exc))]
        result["detail"] = "AI 实例初始化失败；未写入 Loom 配置"
        return result
    except OSError as exc:
        result["ai_instance"] = {"ok": False, "code": "ai_instance_failed"}
        result["errors"] = [_error("ai_instance_failed", _safe_error(exc))]
        result["detail"] = "AI 实例初始化失败；未写入 Loom 配置"
        return result

    if path.exists() and not overwrite:
        doc, read_errors = loom_onboarding._load_config_document(path)
        errors = list(read_errors)
        if doc is not None:
            errors.extend(_validate_required_keys(doc))
            errors.extend(loom_onboarding._validate_config_structure(doc))
        result["errors"] = errors
        if not errors:
            result["ok"] = True
            result["validation"] = "structural"
            result["detail"] = "配置已存在且结构有效，未覆盖"
            return result
        result["detail"] = "配置已存在但结构无效；如需重写请显式 overwrite"
        result["overwrite_required"] = True
        return result

    doc, text, render_errors = _render_template(
        selection, cfg, credential_env=credential_env
    )
    if render_errors or doc is None or text is None:
        result["errors"] = render_errors
        return result

    structure_errors = _validate_required_keys(doc)
    structure_errors.extend(loom_onboarding._validate_config_structure(doc))
    if structure_errors:
        result["errors"] = structure_errors
        return result
    result["validation"] = "structural"

    if path.exists():
        try:
            result["backup"] = str(loom_onboarding._write_backup(path))
        except OSError as exc:
            result["errors"] = [_error("backup_failed", _safe_error(exc))]
            return result
        result["overwritten"] = True

    try:
        loom_onboarding._write_text_atomic(path, text, 0o600)
    except OSError as exc:
        result["errors"] = [_error("config_write_failed", _safe_error(exc))]
        return result

    result["ok"] = True
    result["created"] = True
    result["exists"] = True
    result["credential_ref"] = _credential_ref(
        selection.provider.strip(), credential_env
    )[0]
    result["detail"] = "已写入 Loom 配置"
    logger.info(
        "[LoomRuntime] config written path=%s provider=%s model=%s",
        path,
        selection.provider,
        selection.model,
    )
    return result


# ── 健康检查 ─────────────────────────────────────────────────


async def _probe_health(
    config: Config,
    token: str,
    *,
    timeout: float = HEALTH_TIMEOUT_S,
) -> dict[str, Any]:
    """GET /health；返回可外发摘要，永不 dump body。"""
    base = str(config.LOOM_URL or "").rstrip("/")
    result: dict[str, Any] = {
        "reachable": False,
        "ok": False,
        "http_status": None,
        "status": None,
        "version": None,
        "error": None,
    }
    try:
        status, data = await loom_onboarding._request_json(
            "GET", f"{base}/health", token, timeout=timeout
        )
    except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as exc:
        result["error"] = _safe_error(exc, token)
        return result
    result["reachable"] = True
    result["http_status"] = status
    if isinstance(data, dict):
        result["status"] = data.get("status")
        version = data.get("version")
        if isinstance(version, str) and version:
            result["version"] = version
    result["ok"] = status == 200 and result["status"] == "ok"
    if not result["ok"] and status != 200:
        error = data.get("error") if isinstance(data, dict) else None
        message = None
        if isinstance(error, dict):
            message = error.get("message") or error.get("code")
        elif isinstance(data, dict) and isinstance(data.get("message"), str):
            message = data["message"]
        result["error"] = _safe_error(
            Exception(message or f"HTTP {status}"), token
        )
    return result


async def _wait_health(
    config: Config,
    token: str,
    *,
    timeout: float,
    interval: float = POLL_INTERVAL_S,
) -> dict[str, Any]:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + max(timeout, 0.0)
    last: dict[str, Any] = {
        "reachable": False,
        "ok": False,
        "http_status": None,
        "status": None,
        "version": None,
        "error": "health timeout",
    }
    while True:
        last = await _probe_health(config, token)
        if last.get("ok"):
            return last
        remaining = deadline - loop.time()
        if remaining <= 0:
            return last
        await asyncio.sleep(min(interval, remaining))


async def _wait_down(
    config: Config,
    token: str,
    *,
    timeout: float,
    interval: float = POLL_INTERVAL_S,
) -> bool:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + max(timeout, 0.0)
    while True:
        probe = await _probe_health(config, token)
        if not probe.get("ok"):
            return True
        remaining = deadline - loop.time()
        if remaining <= 0:
            return False
        await asyncio.sleep(min(interval, remaining))


# ── 进程身份与信号 ───────────────────────────────────────────


def _pid_alive(pid: int) -> bool:
    if _WINDOWS:
        # Windows 的 os.kill 对非 CTRL_* 信号会直接 TerminateProcess，禁止用它探活。
        return _pid_exists(pid)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _same_user(pid: int) -> bool:
    """POSIX 同 UID 校验；无法读取时交给指纹与存活判定，不在这里擅自放行。"""
    if _WINDOWS or not hasattr(os, "getuid"):
        return True
    try:
        return os.stat(f"/proc/{pid}").st_uid == os.getuid()
    except OSError:
        return True


def _pid_exists(pid: int) -> bool:
    """PID 是否存在（含无权查询的外来进程）；仅用于拒绝误删 pidfile。"""
    if _WINDOWS:
        import ctypes

        synchronize = 0x00100000
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(synchronize, False, pid)
        if handle:
            kernel32.CloseHandle(handle)
            return True
        return kernel32.GetLastError() == 5
    return _pid_alive(pid)


def _reap_managed_child(pid: int) -> bool:
    """轮询本进程 spawn 的句柄；返回 True 表示已退出并被回收。"""
    process = _MANAGED_CHILDREN.get(pid)
    if process is None:
        return False
    poll = getattr(process, "poll", None)
    if not callable(poll):
        return False
    try:
        returncode = poll()
    except OSError:
        return False
    if returncode is None:
        return False
    _MANAGED_CHILDREN.pop(pid, None)
    return True


def _linux_is_zombie(pid: int) -> bool:
    try:
        stat_text = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
        return stat_text.rsplit(") ", 1)[1].split()[0] == "Z"
    except (OSError, IndexError):
        return False


def _linux_start_time(pid: int) -> Optional[float]:
    try:
        stat_text = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
        boot_time = None
        for line in Path("/proc/stat").read_text(encoding="utf-8").splitlines():
            if line.startswith("btime "):
                boot_time = float(line.split()[1])
                break
        if boot_time is None:
            return None
        tail = stat_text.rsplit(") ", 1)[1]
        parts = tail.split()
        start_ticks = float(parts[19])
        clock_ticks = float(os.sysconf("SC_CLK_TCK"))
        return boot_time + start_ticks / clock_ticks
    except (OSError, IndexError, ValueError):
        return None


def _linux_cmdline_hash(pid: int) -> Optional[str]:
    try:
        raw = Path(f"/proc/{pid}/cmdline").read_bytes()
    except OSError:
        return None
    if not raw:
        return None
    argv = [part.decode("utf-8", errors="replace") for part in raw.split(b"\0") if part]
    if not argv:
        return None
    return _hash_argv(argv)


def _linux_exe(pid: int) -> Optional[str]:
    try:
        return os.readlink(f"/proc/{pid}/exe")
    except OSError:
        return None


def _windows_identity(pid: int) -> Optional[ProcessIdentity]:
    import ctypes
    from ctypes import wintypes

    process_query_limited_information = 0x1000
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(process_query_limited_information, False, pid)
    if not handle:
        return None
    try:
        creation = wintypes.FILETIME()
        exit_time = wintypes.FILETIME()
        kernel = wintypes.FILETIME()
        user = wintypes.FILETIME()
        if not kernel32.GetProcessTimes(
            handle,
            ctypes.byref(creation),
            ctypes.byref(exit_time),
            ctypes.byref(kernel),
            ctypes.byref(user),
        ):
            return None
        ticks = (creation.dwHighDateTime << 32) | creation.dwLowDateTime
        start_time = ticks / 10_000_000 - 11_644_473_600.0
        buffer = ctypes.create_unicode_buffer(32768)
        size = wintypes.DWORD(32768)
        exe = None
        if kernel32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
            exe = buffer.value
        return ProcessIdentity(True, start_time, None, exe)
    finally:
        kernel32.CloseHandle(handle)


def _read_process_identity(pid: int) -> Optional[ProcessIdentity]:
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return None
    if _reap_managed_child(pid):
        return ProcessIdentity(False, None, None, None)
    if _WINDOWS:
        return _windows_identity(pid)
    if not _pid_alive(pid) or _linux_is_zombie(pid):
        return ProcessIdentity(False, None, None, None)
    return ProcessIdentity(
        True,
        _linux_start_time(pid),
        _linux_cmdline_hash(pid),
        _linux_exe(pid),
    )


def _fingerprint_matches(
    record: dict[str, Any], identity: Optional[ProcessIdentity]
) -> tuple[bool, str]:
    """只有 pid/启动时间/命令哈希均可对齐才算自己的进程。"""
    if identity is None or not identity.alive:
        return False, "process_gone"
    recorded_start = record.get("start_time")
    recorded_command = record.get("command_hash")
    recorded_exe = record.get("exe_hash")
    has_start = isinstance(recorded_start, (int, float)) and not isinstance(
        recorded_start, bool
    )
    has_command = isinstance(recorded_command, str) and bool(recorded_command)
    has_exe = isinstance(recorded_exe, str) and bool(recorded_exe)
    if not has_start and not has_command and not has_exe:
        return False, "missing_fingerprint"
    start_verified = False
    if has_start and identity.start_time is not None:
        if abs(float(recorded_start) - identity.start_time) > PID_START_TOLERANCE_S:
            return False, "start_time_mismatch"
        start_verified = True
    command_verified = False
    if has_command and identity.cmdline_hash is not None:
        if recorded_command != identity.cmdline_hash:
            return False, "command_mismatch"
        command_verified = True
    exe_verified = False
    if has_exe and identity.exe:
        if recorded_exe != _hash_text(identity.exe):
            return False, "exe_mismatch"
        exe_verified = True
    if not start_verified and not command_verified and not exe_verified:
        return False, "unverifiable_identity"
    return True, "ok"


def _terminate_pid(pid: int, *, graceful: bool) -> bool:
    """POSIX 发 SIGTERM/SIGKILL；Windows 发 TerminateProcess（无 SIGTERM）。"""
    try:
        if _WINDOWS:
            import ctypes

            process_terminate = 0x0001
            kernel32 = ctypes.windll.kernel32
            handle = kernel32.OpenProcess(process_terminate, False, pid)
            if not handle:
                return False
            try:
                return bool(kernel32.TerminateProcess(handle, 1))
            finally:
                kernel32.CloseHandle(handle)
        os.kill(pid, signal.SIGTERM if graceful else signal.SIGKILL)
        return True
    except (OSError, ProcessLookupError):
        return False


async def _wait_pid_dead(
    pid: int, *, timeout: float, interval: float = 0.2
) -> bool:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + max(timeout, 0.0)
    while True:
        identity = await asyncio.to_thread(_read_process_identity, pid)
        if identity is None:
            if not await asyncio.to_thread(_pid_exists, pid):
                return True
        elif not identity.alive:
            return True
        remaining = deadline - loop.time()
        if remaining <= 0:
            return False
        await asyncio.sleep(min(interval, remaining))


# ── pidfile ──────────────────────────────────────────────────


def _read_pid_record() -> Optional[dict[str, Any]]:
    path = _pidfile_path()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    pid = _parse_pid(data.get("pid"))
    if pid is None:
        return None
    data["pid"] = pid
    return data


def _write_pid_record(record: dict[str, Any]) -> None:
    path = _pidfile_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n"
    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent)
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        _best_effort_chmod(Path(tmp_name), 0o600)
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def _remove_pidfile() -> None:
    try:
        _pidfile_path().unlink()
    except OSError:
        pass


# ── 端口与子进程 ─────────────────────────────────────────────


def _port_in_use(port: int, host: str = "127.0.0.1") -> bool:
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe.settimeout(0.3)
    try:
        return probe.connect_ex((host, port)) == 0
    except OSError:
        return False
    finally:
        probe.close()


def _spawn_options(windows: bool) -> dict[str, Any]:
    if windows:
        return {
            "creationflags": (
                _CREATE_NEW_PROCESS_GROUP | _DETACHED_PROCESS | _CREATE_NO_WINDOW
            ),
            "start_new_session": False,
        }
    return {"creationflags": 0, "start_new_session": True}


def _spawn_child_process(
    argv: list[str],
    *,
    env: dict[str, str],
    cwd: str,
    log_path: Path,
) -> subprocess.Popen[Any]:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with open(log_path, "ab", buffering=0) as log_handle:
        return subprocess.Popen(
            argv,
            cwd=cwd,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            close_fds=True,
            **_spawn_options(_WINDOWS),
        )


# ── 结果构造 ─────────────────────────────────────────────────


def _base_result(mode: str, requested: str) -> dict[str, Any]:
    return {
        "ok": False,
        "mode": mode,
        "requested": requested,
        "performed": False,
        "verified": False,
        "manual_required": False,
        "adopted": False,
        "pid": None,
        "old_pid": None,
        "new_pid": None,
        "command": None,
        "detail": "",
        "health": None,
        "errors": [],
    }


def _mark_manual(
    result: dict[str, Any],
    detail: str,
    *,
    code: Optional[str] = None,
    message: Optional[str] = None,
    command: Optional[str] = None,
) -> dict[str, Any]:
    result["ok"] = False
    result["manual_required"] = True
    result["detail"] = detail
    if command is not None:
        result["command"] = command
    if code is not None:
        result["errors"].append(_error(code, message or detail))
    return result


def _mode_none_result(requested: str, details: dict[str, Any]) -> dict[str, Any]:
    result = _base_result(MODE_NONE, requested)
    reason_list = list(details.get("reasons") or [])
    reasons = ", ".join(reason_list) or "unknown"
    if "systemd_unit_foreign" in reason_list:
        return _mark_manual(
            result,
            f"检测到的 {DEFAULT_SYSTEMD_UNIT} 单元属于其他部署（{reasons}），本实例不执行 systemctl 操作",
            code="systemd_unit_foreign",
            message="该 systemd 单元不属于当前项目实例；请为本实例部署独立单元，或改用 child 模式",
        )
    return _mark_manual(
        result,
        f"未检测到可管理的 Loom（{reasons}）",
        code="runtime_unavailable",
        message="Loom systemd 单元与本地发行版（node + dist）均不可用；请手工部署或构建 loom-harness",
    )


# ── systemd 生命周期 ─────────────────────────────────────────


def _systemd_command(action: str) -> str:
    return f"sudo systemctl {action} {DEFAULT_SYSTEMD_UNIT}"


def _systemd_ownership_denial(
    result: dict[str, Any], info: Optional[dict[str, str]], action: str
) -> Optional[dict[str, Any]]:
    """非本实例单元直接拒绝，确保任何路径都不会落到 systemctl 动作。"""
    if _systemd_unit_owned(info):
        return None
    code = "systemd_unit_foreign" if info is not None else "systemd_unit_not_found"
    return _mark_manual(
        result,
        f"无法验证 {DEFAULT_SYSTEMD_UNIT} 属于当前实例（{code}），拒绝执行 systemctl {action}",
        code=code,
        message="只有属于当前项目实例的 systemd 单元才允许自动启停",
    )


async def _start_systemd(
    config: Config, *, timeout: float
) -> dict[str, Any]:
    result = _base_result(MODE_SYSTEMD, "start")
    unit_info = await asyncio.to_thread(_systemd_unit_info)
    denial = _systemd_ownership_denial(result, unit_info, "start")
    if denial is not None:
        return denial
    token, _source, _detail = loom_onboarding._resolve_token(config)
    outcome = await asyncio.to_thread(_systemctl_run, "start", DEFAULT_SYSTEMD_UNIT)
    result["performed"] = bool(outcome.get("ok"))
    if not outcome.get("ok"):
        return _mark_manual(
            result,
            f"systemctl start 失败: {outcome.get('detail') or 'unknown'}",
            code="systemctl_failed",
            command=_systemd_command("start"),
        )
    if not token:
        result["verified"] = False
        return _mark_manual(
            result,
            "systemd 已执行 start，但未发现 token，无法验证健康状态",
            code="token_missing",
            command=_systemd_command("start"),
        )
    health = await _wait_health(config, token, timeout=timeout)
    result["health"] = health
    if health.get("ok"):
        result["ok"] = True
        result["verified"] = True
        result["manual_required"] = False
        result["detail"] = "systemd 启动完成"
        info = await asyncio.to_thread(_systemd_unit_info)
        result["pid"] = _parse_pid((info or {}).get("MainPID"))
        result["new_pid"] = result["pid"]
        return result
    return _mark_manual(
        result,
        "systemd 已执行 start，但健康检查未通过",
        code="health_failed",
        command=_systemd_command("start"),
    )


async def _stop_systemd(
    config: Config, *, timeout: float
) -> dict[str, Any]:
    result = _base_result(MODE_SYSTEMD, "stop")
    info = await asyncio.to_thread(_systemd_unit_info)
    denial = _systemd_ownership_denial(result, info, "stop")
    if denial is not None:
        return denial
    result["old_pid"] = _parse_pid((info or {}).get("MainPID"))
    outcome = await asyncio.to_thread(_systemctl_run, "stop", DEFAULT_SYSTEMD_UNIT)
    result["performed"] = bool(outcome.get("ok"))
    if not outcome.get("ok"):
        return _mark_manual(
            result,
            f"systemctl stop 失败: {outcome.get('detail') or 'unknown'}",
            code="systemctl_failed",
            command=_systemd_command("stop"),
        )
    token, _source, _detail = loom_onboarding._resolve_token(config)
    after = await asyncio.to_thread(_systemd_unit_info)
    unit_active = bool(
        after
        and after.get("ActiveState") in ("active", "activating", "reloading")
    )
    down = not unit_active
    if token and down:
        down = await _wait_down(
            config, token, timeout=min(timeout, STOP_TIMEOUT_S), interval=0.25
        )
    result["ok"] = down
    result["verified"] = down
    result["manual_required"] = not down
    result["detail"] = "systemd 停止完成" if down else "已执行 stop，但单元仍处于活动状态"
    return result


async def _restart_systemd(
    config: Config, *, timeout: float
) -> dict[str, Any]:
    result = _base_result(MODE_SYSTEMD, "restart")
    info = await asyncio.to_thread(_systemd_unit_info)
    denial = _systemd_ownership_denial(result, info, "restart")
    if denial is not None:
        return denial
    old_pid = _parse_pid((info or {}).get("MainPID"))
    result["old_pid"] = old_pid
    outcome = await asyncio.to_thread(
        _systemctl_run, "restart", DEFAULT_SYSTEMD_UNIT
    )
    result["performed"] = bool(outcome.get("ok"))
    result["requested"] = True
    if not outcome.get("ok"):
        return _mark_manual(
            result,
            f"systemctl restart 失败: {outcome.get('detail') or 'unknown'}",
            code="systemctl_failed",
            command=_systemd_command("restart"),
        )
    token, _source, _detail = loom_onboarding._resolve_token(config)
    if not token:
        result["new_pid"] = _parse_pid(
            (await asyncio.to_thread(_systemd_unit_info) or {}).get("MainPID")
        )
        return _mark_manual(
            result,
            "systemd 已执行 restart，但未发现 token，无法验证健康状态",
            code="token_missing",
            command=_systemd_command("restart"),
        )
    health = await _wait_health(config, token, timeout=timeout)
    result["health"] = health
    new_info = await asyncio.to_thread(_systemd_unit_info)
    result["new_pid"] = _parse_pid((new_info or {}).get("MainPID"))
    result["pid"] = result["new_pid"]
    if health.get("ok"):
        result["ok"] = True
        result["verified"] = True
        result["detail"] = "systemd 重启完成"
        return result
    return _mark_manual(
        result,
        "systemd 已执行 restart，但健康检查未通过",
        code="health_failed",
        command=_systemd_command("restart"),
    )


# ── child 生命周期 ───────────────────────────────────────────


def _child_spawn_errors(
    config: Config,
) -> tuple[Optional[list[str]], Optional[int], str, str]:
    node = _which("node")
    cli = _cli_path()
    if not node:
        return None, None, "", "node_missing"
    if not cli.is_file():
        return None, None, "", "loom_harness_dist_missing"
    port, port_error = _port_from_url(config.LOOM_URL)
    if port is None:
        return None, None, "", port_error
    host = _loopback_host(config.LOOM_URL)
    if host not in ("127.0.0.1", "localhost"):
        return None, None, "", "child 模式只允许 127.0.0.1/localhost 的 loom.url"
    return [node, str(cli), "serve"], port, "127.0.0.1", ""


def _port_owner_pid(port: int, host: str = "127.0.0.1") -> Optional[int]:
    """尽力定位监听端口的本机 PID（仅 Linux）；定位失败返回 None。"""
    if _WINDOWS or not sys.platform.startswith("linux"):
        return None
    port_hex = "%04X" % int(port)
    inode = ""
    for table in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            lines = Path(table).read_text(encoding="utf-8").splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            parts = line.split()
            if len(parts) < 10 or parts[3] != "0A":
                continue
            if parts[1].rsplit(":", 1)[-1] == port_hex:
                inode = parts[9]
                break
        if inode:
            break
    if not inode:
        return None
    needle = "socket:[%s]" % inode
    try:
        candidates = list(Path("/proc").iterdir())
    except OSError:
        return None
    for entry in candidates:
        if not entry.name.isdigit():
            continue
        try:
            fds = list((entry / "fd").iterdir())
        except OSError:
            continue
        for fd in fds:
            try:
                if os.readlink(fd) == needle:
                    return int(entry.name)
            except OSError:
                continue
    return None


async def _port_conflict(
    result: dict[str, Any], *, port: int, host: str
) -> dict[str, Any]:
    """child 模式端口被占时只报错，绝不接管已在跑的 Loom。"""
    owner = await asyncio.to_thread(_port_owner_pid, port, host)
    owner_detail = "pid=%s" % owner if owner else "pid=unknown"
    return _mark_manual(
        result,
        f"端口 {port} 已被占用（{owner_detail}），child 模式拒绝接管",
        code="port_in_use",
        message="端口被占用；请按 PID 释放端口或改用其他 loom.url",
    )


async def _start_child(
    config: Config, *, timeout: float
) -> dict[str, Any]:
    result = _base_result(MODE_CHILD, "start")
    argv_prefix, port, host, error_code = _child_spawn_errors(config)
    if error_code or argv_prefix is None or port is None:
        return _mark_manual(
            result,
            f"child 模式不可用: {error_code or 'unknown'}",
            code=error_code or "runtime_unavailable",
        )

    config_path = _config_path(config)
    result["config_path"] = str(config_path)
    if not config_path.is_file():
        return _mark_manual(
            result,
            "Loom 配置缺失，先执行 /config/ensure",
            code="config_missing",
        )

    record = await asyncio.to_thread(_read_pid_record)
    if record is not None:
        identity = await asyncio.to_thread(
            _read_process_identity, int(record["pid"])
        )
        matches, reason = _fingerprint_matches(record, identity)
        if matches:
            token, _source, _detail = loom_onboarding._resolve_token(config)
            if not token:
                result["pid"] = record["pid"]
                return _mark_manual(
                    result,
                    "已有受管 Loom 进程，但未发现 token，无法验证健康状态",
                    code="token_missing",
                )
            health = await _wait_health(config, token, timeout=min(timeout, 5.0))
            result["pid"] = record["pid"]
            result["health"] = health
            if health.get("ok"):
                result["ok"] = True
                result["verified"] = True
                result["detail"] = "Loom 已在运行"
                return result
            return _mark_manual(
                result,
                "受管 Loom 进程存在但健康检查未通过",
                code="health_failed",
            )
        still_exists = (
            identity.alive
            if identity is not None
            else await asyncio.to_thread(_pid_exists, int(record["pid"]))
        )
        if still_exists:
            result["pid"] = record["pid"]
            return _mark_manual(
                result,
                f"pidfile 指向的进程无法通过指纹验证（{reason}），拒绝操作",
                code="pidfile_foreign",
            )
        await asyncio.to_thread(_remove_pidfile)

    if _port_in_use(port, host):
        return await _port_conflict(result, port=port, host=host)

    token_state = _ensure_token_internal(config)
    if not token_state.token:
        result["token_state"] = token_state.public
        return _mark_manual(
            result,
            "无法获得 Loom token",
            code="token_missing",
        )
    result["token_state"] = token_state.public

    argv = [
        *argv_prefix,
        "--port",
        str(port),
        "--hostname",
        "127.0.0.1",
        "--config",
        str(config_path),
    ]
    command_hash = _hash_argv(argv)
    config_hash = _hash_file(config_path)
    env = os.environ.copy()
    env.update(
        {
            "LOOM_TOKEN": token_state.token,
            "LOOM_INSTANCE": str(Path(config.AI_ROOT).resolve()),
            "LOOM_CONFIG": str(config_path),
            "LOOM_STATE": str(Path(config.AI_ROOT).resolve() / ".loom"),
        }
    )
    log_path = _logfile_path()
    result["log_path"] = str(log_path)
    try:
        process = await asyncio.to_thread(
            _spawn_child_process,
            argv,
            env=env,
            cwd=str(paths.project_root()),
            log_path=log_path,
        )
    except OSError as exc:
        return _mark_manual(
            result,
            f"spawn 失败: {_safe_error(exc, token_state.token)}",
            code="spawn_failed",
        )

    pid = int(process.pid)
    _MANAGED_CHILDREN[pid] = process
    result["pid"] = pid
    result["new_pid"] = pid
    identity = await asyncio.to_thread(_read_process_identity, pid)
    started_at = (
        identity.start_time
        if identity is not None and identity.start_time is not None
        else time.time()
    )
    record = {
        "version": 1,
        "pid": pid,
        "start_time": started_at,
        "started_at": _utc_now_iso(),
        "command_hash": command_hash,
        "config_hash": config_hash,
        "exe_hash": (
            _hash_text(identity.exe)
            if identity is not None and identity.exe
            else ""
        ),
        "mode": MODE_CHILD,
    }
    pidfile_ok = True
    try:
        await asyncio.to_thread(_write_pid_record, record)
    except OSError:
        pidfile_ok = False
        result["errors"].append(
            _error("pidfile_write_failed", "进程已启动，但 pidfile 写入失败；stop 需人工")
        )
        logger.error("[LoomRuntime] pidfile 写入失败 pid=%s", pid)

    result["performed"] = True
    health = await _wait_health(config, token_state.token, timeout=timeout)
    result["health"] = health
    if health.get("ok"):
        result["verified"] = True
        persist_failed = any(
            item.get("code") == "config_persist_failed"
            for item in token_state.public.get("errors") or []
        )
        if persist_failed:
            return _mark_manual(
                result,
                "子进程已启动且健康，但 token 未持久化到配置；后端重启后将无法认证",
                code="config_persist_failed",
            )
        result["ok"] = True
        result["detail"] = "Loom 子进程已启动"
        return result
    if not pidfile_ok:
        return _mark_manual(
            result,
            "子进程已拉起但健康检查失败，且 pidfile 缺失",
            code="health_failed",
        )
    return _mark_manual(
        result,
        "子进程已拉起但健康检查未通过，请查看 logs/loom.log",
        code="health_failed",
    )


async def _stop_child(
    config: Config, *, timeout: float
) -> dict[str, Any]:
    result = _base_result(MODE_CHILD, "stop")
    record = await asyncio.to_thread(_read_pid_record)
    token, _source, _detail = loom_onboarding._resolve_token(config)
    if record is None:
        if token:
            probe = await _probe_health(config, token)
            if probe.get("ok"):
                result["health"] = probe
                return _mark_manual(
                    result,
                    "Loom 在线但无 pidfile（可能为接管或外部进程），拒绝按 PID 停止",
                    code="untracked_process",
                )
        port = _port_from_url(config.LOOM_URL)[0]
        if port is not None and await asyncio.to_thread(_port_in_use, port):
            return _mark_manual(
                result,
                f"端口 {port} 被占用，但无法识别为当前 token 的 Loom",
                code="port_conflict",
            )
        result["ok"] = True
        result["verified"] = True
        result["detail"] = "Loom 未运行"
        return result

    pid = int(record["pid"])
    identity = await asyncio.to_thread(_read_process_identity, pid)
    matches, reason = _fingerprint_matches(record, identity)
    if not matches:
        still_exists = (
            identity.alive
            if identity is not None
            else await asyncio.to_thread(_pid_exists, pid)
        )
        if not still_exists:
            await asyncio.to_thread(_remove_pidfile)
            result["ok"] = True
            result["verified"] = True
            result["detail"] = "进程已不存在，清理 stale pidfile"
            return result
        result["pid"] = pid
        return _mark_manual(
            result,
            f"pidfile 指纹校验失败（{reason}），拒绝终止 PID {pid}",
            code="pidfile_foreign",
        )

    if not await asyncio.to_thread(_same_user, pid):
        result["pid"] = pid
        return _mark_manual(
            result,
            f"PID {pid} 不属于当前用户，拒绝终止",
            code="pidfile_foreign",
        )

    result["pid"] = pid
    result["old_pid"] = pid
    await asyncio.to_thread(_terminate_pid, pid, graceful=True)
    dead = await _wait_pid_dead(
        pid, timeout=min(timeout, STOP_TIMEOUT_S), interval=0.25
    )
    if not dead:
        await asyncio.to_thread(_terminate_pid, pid, graceful=False)
        dead = await _wait_pid_dead(pid, timeout=5.0, interval=0.25)
    if not dead:
        return _mark_manual(
            result,
            f"PID {pid} 在 SIGTERM/SIGKILL 后仍存活",
            code="stop_failed",
        )

    await asyncio.to_thread(_remove_pidfile)
    _MANAGED_CHILDREN.pop(pid, None)
    down = True
    if token:
        down = await _wait_down(config, token, timeout=5.0, interval=0.25)
    result["ok"] = down
    result["performed"] = True
    result["verified"] = down
    result["manual_required"] = not down
    result["detail"] = "Loom 子进程已停止" if down else "进程已结束但健康检查仍在线"
    return result


async def _restart_child(
    config: Config, *, timeout: float
) -> dict[str, Any]:
    result = _base_result(MODE_CHILD, "restart")
    result["requested"] = True
    record = await asyncio.to_thread(_read_pid_record)
    if record is not None:
        identity = await asyncio.to_thread(
            _read_process_identity, int(record["pid"])
        )
        matches, _reason = _fingerprint_matches(record, identity)
        if matches:
            result["old_pid"] = int(record["pid"])
    stop_result = await _stop_child(config, timeout=STOP_TIMEOUT_S)
    result["performed"] = bool(stop_result.get("performed"))
    if stop_result.get("manual_required"):
        for key in ("pid", "old_pid", "health", "detail"):
            if key in stop_result:
                result[key] = stop_result[key]
        result["manual_required"] = True
        result["errors"].extend(stop_result.get("errors") or [])
        result["detail"] = f"停止阶段需人工处理: {stop_result.get('detail')}"
        return result

    start_result = await _start_child(config, timeout=timeout)
    result["performed"] = result["performed"] or bool(start_result.get("performed"))
    result["new_pid"] = start_result.get("new_pid")
    result["pid"] = start_result.get("pid")
    result["health"] = start_result.get("health")
    result["verified"] = bool(start_result.get("verified"))
    result["ok"] = bool(start_result.get("ok"))
    result["manual_required"] = bool(start_result.get("manual_required"))
    result["adopted"] = bool(start_result.get("adopted"))
    result["detail"] = start_result.get("detail") or ""
    result["errors"].extend(start_result.get("errors") or [])
    return result


# ── 公共生命周期 API ─────────────────────────────────────────


async def start(
    config: Optional[Config] = None, *, timeout: float = START_HEALTH_TIMEOUT_S
) -> dict[str, Any]:
    cfg = config or get_config()
    mode = await asyncio.to_thread(detect_mode, cfg)
    if mode == MODE_NONE:
        return _mode_none_result("start", _mode_details())
    if mode == MODE_SYSTEMD:
        return await _start_systemd(cfg, timeout=timeout)
    return await _start_child(cfg, timeout=timeout)


async def stop(
    config: Optional[Config] = None, *, timeout: float = STOP_TIMEOUT_S
) -> dict[str, Any]:
    cfg = config or get_config()
    mode = await asyncio.to_thread(detect_mode, cfg)
    if mode == MODE_NONE:
        details = await asyncio.to_thread(_mode_details)
        if "systemd_unit_foreign" in (details.get("reasons") or []):
            return _mode_none_result("stop", details)
        token, _source, _detail = loom_onboarding._resolve_token(cfg)
        result = _base_result(MODE_NONE, "stop")
        if token:
            probe = await _probe_health(cfg, token)
            if probe.get("ok"):
                result["health"] = probe
                return _mark_manual(
                    result,
                    "Loom 在线但未检测到 systemd 单元或本地发行版，无法安全停止",
                    code="untracked_process",
                )
        port = _port_from_url(cfg.LOOM_URL)[0]
        if port is not None and await asyncio.to_thread(_port_in_use, port):
            return _mark_manual(
                result,
                f"端口 {port} 被占用，但无法识别为当前 token 的 Loom",
                code="port_conflict",
            )
        result["ok"] = True
        result["verified"] = True
        result["detail"] = "Loom 未运行"
        return result
    if mode == MODE_SYSTEMD:
        return await _stop_systemd(cfg, timeout=timeout)
    return await _stop_child(cfg, timeout=timeout)


async def restart(
    config: Optional[Config] = None, *, timeout: float = START_HEALTH_TIMEOUT_S
) -> dict[str, Any]:
    cfg = config or get_config()
    mode = await asyncio.to_thread(detect_mode, cfg)
    if mode == MODE_NONE:
        result = _mode_none_result("restart", _mode_details())
        result["requested"] = True
        return result
    if mode == MODE_SYSTEMD:
        result = await _restart_systemd(cfg, timeout=timeout)
    else:
        result = await _restart_child(cfg, timeout=timeout)
    result["requested"] = True
    if not result.get("verified"):
        result["command"] = _systemd_command("restart") if mode == MODE_SYSTEMD else None
    return result


async def status(config: Optional[Config] = None) -> dict[str, Any]:
    cfg = config or get_config()
    mode = await asyncio.to_thread(detect_mode, cfg)
    details = await asyncio.to_thread(_mode_details, mode)
    config_path = _config_path(cfg)
    discovery = loom_onboarding.discover_token(cfg)

    token, _source, _detail = loom_onboarding._resolve_token(cfg)
    health = await _probe_health(cfg, token) if token else None
    record = await asyncio.to_thread(_read_pid_record)
    pid: Optional[int] = None
    pid_verified = False
    if record is not None:
        identity = await asyncio.to_thread(
            _read_process_identity, int(record["pid"])
        )
        matched, _reason = _fingerprint_matches(record, identity)
        if matched:
            pid = int(record["pid"])
            pid_verified = True

    unit = details["systemd"]
    unit_running = (
        mode == MODE_SYSTEMD
        and bool(unit.get("owned"))
        and bool(unit.get("present"))
        and unit.get("active_state") in ("active", "activating", "reloading")
        and bool(unit.get("pid"))
    )
    if unit_running and pid is None:
        pid = unit.get("pid")
        pid_verified = True

    healthy = bool(health and health.get("ok"))
    running = bool(pid_verified or unit_running or healthy)
    if mode == MODE_NONE:
        if "systemd_unit_foreign" in (details.get("reasons") or []):
            detail = (
                f"检测到的 {DEFAULT_SYSTEMD_UNIT} 单元属于其他部署，"
                "本实例不控制该单元"
            )
        else:
            detail = "本机无 Loom systemd 单元，且 loom-harness dist/node 缺失"
    elif mode == MODE_SYSTEMD:
        detail = f"systemd 单元 {DEFAULT_SYSTEMD_UNIT} 状态 {unit.get('active_state') or 'unknown'}"
    else:
        detail = "本地发行版可用，可拉起 child 进程"
    return {
        "ok": True,
        "mode": mode,
        "mode_detail": details,
        "managed": bool(cfg.LOOM_MANAGE_CONFIG),
        "config_path": str(config_path),
        "config_exists": config_path.is_file(),
        "token_state": discovery.public(),
        "running": running,
        "pid": pid,
        "pid_verified": pid_verified,
        "adopted": bool(healthy and not pid_verified),
        "reachable": bool(health and health.get("reachable")),
        "health": health,
        "port": _port_from_url(cfg.LOOM_URL)[0],
        "detail": detail,
    }
