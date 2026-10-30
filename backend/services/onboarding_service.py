# -*- coding: utf-8 -*-
"""Onboarding 状态持久化、只读环境预检与引导动作。

状态真源为 ``backend/data/onboarding_state.json``（可用环境变量
``AXEUH_ONBOARDING_STATE`` / ``AEUH_ONBOARDING_STATE`` 覆盖，前者优先），
写入采用同目录 mkstemp + fsync +
chmod 0600 + os.replace + fsync(dir) 的原子序列。预检全程只读：不写文件、
不绑定端口，detail 中不包含配置里的任何密钥值。

无配置启动属于正常降级状态：配置缺失只产生 warning，不会阻断引导；
``read_config_runtime_status`` 优先读取 ``config.store.get_config_store()``，
未安装新配置存储时回退到 ``get_config()`` 的 ``CONFIG_STATUS`` / revision。

v4 起预检与启动校验不再作为可见步骤；唯一的 ``finish`` 步骤承担全部
门禁，预检必须在服务面启动前完成并由编排层把结果传入 ``record_step``。
"""
from __future__ import annotations

import asyncio
import copy
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any, Optional

import yaml

from config.paths import data_root as _paths_data_root
from config.paths import models_root as _paths_models_root
from config.paths import project_root as _paths_project_root
from core.redaction import redact_text
from services import kernel_assets

if TYPE_CHECKING:
    from config.config_schema import ApplyStrategy


@dataclass(frozen=True)
class OnboardingStep:
    """引导向导的单步定义。

    ``required`` 表示该步骤是否必须完成（可跳过的步骤也属于 required，
    skipped 视为已处理）；``skippable`` 仅决定是否允许显式 skipped；
    ``auth`` 是动作端点的凭据类型，``write_auth`` 是记录进度
    （``POST /state``）所需的凭据类型。
    """

    id: str
    title: str
    description: str
    apply_strategy: ApplyStrategy
    required: bool = True
    skippable: bool = False
    auth: str = "none"
    write_auth: str = "bearer"


STEPS: tuple[OnboardingStep, ...] = (
    OnboardingStep(
        "welcome",
        "欢迎",
        "了解 Kinship 能为你做什么，准备好后开始配置",
        "none",
        required=True,
        skippable=False,
        auth="none",
    ),
    OnboardingStep(
        "account",
        "管理员账号",
        "创建首个管理员账号，作为后续配置的登录凭据",
        "none",
        required=True,
        skippable=False,
        auth="setup_token",
    ),
    OnboardingStep(
        "dependencies",
        "依赖检查",
        "检查系统环境与 AI 工作目录，确认下载与安装选择",
        "none",
        required=True,
        skippable=False,
        auth="bearer",
    ),
    OnboardingStep(
        "kernel",
        "音频内核",
        "安装或复用音频内核程序（语音识别、声纹与环境声分析）",
        "none",
        required=True,
        skippable=True,
        auth="password",
    ),
    OnboardingStep(
        "kernel_models",
        "内核模型",
        "下载或校验音频内核所需的模型文件",
        "none",
        required=True,
        skippable=True,
        auth="password",
    ),
    OnboardingStep(
        "xiaomi",
        "小米健康云",
        "连接小米健康云账号，同步手机健康数据，或跳过",
        "hot",
        required=True,
        skippable=True,
        auth="password",
    ),
    OnboardingStep(
        "qq",
        "QQ 网关",
        "配置 QQ 网关与机器人账号，或跳过",
        "reconnect",
        required=True,
        skippable=True,
        auth="password",
    ),
    OnboardingStep(
        "moss",
        "MOSS 深度音频",
        "连接可选的 MOSS 深度音频理解服务，或跳过",
        "reconnect",
        required=True,
        skippable=True,
        auth="password",
    ),
    OnboardingStep(
        "loom",
        "AI 助手",
        "配置 Loom 助手连接、渠道与模型，或跳过",
        "hot",
        required=True,
        skippable=True,
        auth="password",
    ),
    OnboardingStep(
        "clients",
        "客户端",
        "获取 Android 与 Windows 客户端并连接",
        "none",
        required=True,
        skippable=False,
        auth="bearer",
    ),
    OnboardingStep(
        "finish",
        "完成",
        "提交启动结果、激活服务并结束引导",
        "none",
        required=True,
        skippable=False,
        auth="bearer",
    ),
)

STATE_VERSION = 4
SKIPPABLE_STEPS = frozenset(
    {"kernel", "kernel_models", "xiaomi", "qq", "moss", "loom"}
)
_PASSIVE_STEP_IDS = frozenset({"welcome"})
# IS-3 / F3 C3：数据面只依赖第一阶段三步。这三步记录齐全即开闸，
# 不要求完成 kernel 及其后的可跳过步骤；account/dependencies 缺一仍阻断。
_PHASE1_DATA_PLANE_STEP_IDS: tuple[str, ...] = (
    "welcome",
    "account",
    "dependencies",
)

_STEP_IDS: tuple[str, ...] = tuple(step.id for step in STEPS)
_STEP_INDEX = {step_id: index for index, step_id in enumerate(_STEP_IDS)}
_STEP_STATUSES = ("completed", "skipped")

# v4 把 preflight/startup 移出可见步骤；步骤状态里不再保留这两个 id。
_REMOVED_IN_V4_STEP_IDS: tuple[str, ...] = ("preflight", "startup")

# v1 -> v2 合并映射；finish 直接丢弃（v2 的 finish 由新契约重新判定）。
_V1_STEP_MAP: dict[str, str] = {
    "preflight": "welcome",
    "server": "dependencies",
    "ssl": "dependencies",
    "ai_backend": "dependencies",
    "data": "dependencies",
    "admin": "account",
    "integrations": "moss",
    "clients": "clients",
}

_STATE_LOCK = threading.RLock()
_AI_ENSURE_LOCK = threading.Lock()
_AI_TEMPLATE_SKIP_DIRS = frozenset({".git", "node_modules", "__pycache__", ".loom"})
_CORRUPT_SUFFIX = ".corrupt-"

_GIB = 1024 ** 3
_MIN_FREE_BYTES = _GIB
_MIN_PYTHON = (3, 10)
_OPENCODE_REQUIRED_KEYS = ("default_agent", "default_model", "default_provider")
_OK_CONFIG_STATUSES = frozenset({"ok", "ready", "healthy", "configured", "active"})
_DEGRADED_CONFIG_STATUSES = frozenset(
    {"degraded", "unconfigured", "invalid", "missing", "error", "failed"}
)
_PREFLIGHT_SOFT_STATUSES = frozenset({"warn", "fail"})
_LOOM_PREFLIGHT_TIMEOUT_S = 2.0


class StepOutOfOrder(Exception):
    """当前步骤之前的步骤尚未全部 completed/skipped。"""


class OnboardingActionError(Exception):
    """引导动作失败：携带 HTTP 状态码与稳定错误码。"""

    status_code: int
    code: str
    message: str

    def __init__(self, status_code: int, code: str, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


class OnboardingActionConflict(OnboardingActionError):
    """目标已存在且未允许覆盖。"""

    def __init__(self, code: str, message: str):
        super().__init__(409, code, message)


class OnboardingActionInvalid(OnboardingActionError):
    """动作参数或运行环境不满足执行条件。"""

    def __init__(self, code: str, message: str):
        super().__init__(422, code, message)


class PreflightGateError(OnboardingActionError):
    """预检门禁拒绝记录步骤；携带完整只读预检结果供前端展示。"""

    def __init__(self, code: str, message: str, result: dict):
        super().__init__(409, code, message)
        self.result = result
        self.checks = list(result.get("checks") or ())
        self.blocking_failures = list(result.get("blocking_failures") or ())
        self.soft_failures = list(result.get("soft_failures") or ())
        self.summary = dict(result.get("summary") or {})
        self.can_proceed = bool(result.get("can_proceed"))


class PreflightBlocked(PreflightGateError):
    """存在硬阻断项，预检/完成不可继续。"""

    def __init__(self, result: dict):
        super().__init__(
            "preflight_blocked",
            "预检存在阻塞项，处理后重试",
            result,
        )


class DegradedRequiresAck(PreflightGateError):
    """存在软失败项，需要调用方显式确认降级。"""

    def __init__(self, result: dict):
        super().__init__(
            "degraded_requires_ack",
            "预检存在降级项，需要显式确认 allow_degraded=true",
            result,
        )


class StartupGateError(OnboardingActionError):
    """启动校验门禁拒绝记录步骤；携带校验与运行时报告。"""

    def __init__(self, code: str, message: str, report: dict):
        super().__init__(409, code, message)
        self.report = report
        self.runtime = dict(report.get("runtime") or {})
        self.startup = dict(report.get("startup") or {})


class StartupRequired(StartupGateError):
    """尚未尝试/完成启动校验（或运行时状态不可用）。"""

    def __init__(self, report: dict):
        super().__init__(
            "startup_required",
            "请先完成启动校验（attempt + validate）再记录该步骤",
            report,
        )


class StartupFailed(StartupGateError):
    """启动校验已执行但未通过。"""

    def __init__(self, report: dict):
        super().__init__(
            "startup_failed",
            "启动校验未通过，处理后重新校验",
            report,
        )


@dataclass(frozen=True)
class StartupStatus:
    """引导启动门禁的运行时快照（由 HTTP 层从 app.state 组装）。"""

    runtime_state: str
    validation_report: dict[str, Any] = field(default_factory=dict)
    runtime_report: dict[str, Any] = field(default_factory=dict)


_STARTUP_READY_STATES = frozenset({"validated", "promoted", "committed"})


@dataclass(frozen=True)
class ConfigRuntimeStatus:
    """配置运行态摘要：降级标记、revision 与 provider 类型。"""

    degraded: bool
    revision: Optional[str]
    provider: Optional[str]
    detail: str = ""


@dataclass(frozen=True)
class _LiveConfigSnapshot:
    """ConfigStore 的有效配置快照（schema 默认值 + base + env overlay）。"""

    document: dict
    degraded: tuple[str, ...] = ()
    revision: Optional[str] = None
    provider: Optional[str] = None
    writable: bool = True


# ---------------------------------------------------------------------------
# 状态持久化
# ---------------------------------------------------------------------------


def _default_project_root() -> Path:
    return _paths_project_root()


def default_project_root() -> Path:
    """返回项目根目录；staging 可用 ``AXEUH_PROJECT_ROOT`` 强制隔离。"""
    return _default_project_root()


def _state_path() -> Path:
    for key in ("AXEUH_ONBOARDING_STATE", "AEUH_ONBOARDING_STATE"):
        override = os.environ.get(key, "").strip()
        if override:
            return Path(override).expanduser()
    return _paths_project_root() / "backend" / "data" / "onboarding_state.json"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _default_state() -> dict:
    now = _now_iso()
    return {
        "version": STATE_VERSION,
        "completed_steps": [],
        "skipped_steps": [],
        "current_step": _STEP_IDS[0],
        "completed": False,
        "legacy_upgraded": False,
        "started_at": now,
        "updated_at": now,
    }


def _string_set(value: Any) -> set[str]:
    if not isinstance(value, list):
        return set()
    return {item for item in value if isinstance(item, str)}


def _migrate_v1(raw: dict, now: str) -> dict:
    completed_raw = _string_set(raw.get("completed_steps"))
    skipped_raw = _string_set(raw.get("skipped_steps"))

    if raw.get("completed") is True:
        completed_set = set(_STEP_IDS)
        skipped_set: set[str] = set()
    else:
        completed_set = set()
        skipped_set = set()
        for step_id in completed_raw:
            target = _V1_STEP_MAP.get(step_id)
            if target is not None:
                completed_set.add(target)
        for step_id in skipped_raw:
            target = _V1_STEP_MAP.get(step_id)
            if target is not None:
                skipped_set.add(target)
        skipped_set -= completed_set

    state = _state_from_raw(
        raw,
        now,
        completed=completed_set,
        skipped=skipped_set,
        legacy_upgraded=True,
    )
    return _apply_v4_completion_rule(
        state,
        finish_done=_finish_done(raw, completed_set, skipped_set),
        source_version=1,
    )


def _finish_done(raw: dict, completed: set[str], skipped: set[str]) -> bool:
    return (
        raw.get("completed") is True
        or "finish" in completed
        or "finish" in skipped
    )


def _v4_synthetic_step_data(source_version: int) -> dict:
    return {
        "migrated": True,
        "reason": f"v{source_version}_upgrade",
        "enabled": False,
    }


def _apply_v4_completion_rule(
    state: dict, *, finish_done: bool, source_version: int
) -> dict:
    """把旧安装收敛到 v4 步骤集合。

    已完成安装补齐到全部 v4 步骤（保留可跳过步骤的 skipped 选择），进行中
    安装只把新增的 xiaomi/qq 记为 skipped，避免新插入的可选步骤卡住引导。
    """
    completed = set(state["completed_steps"])
    skipped = set(state["skipped_steps"])
    if finish_done:
        skipped = {
            step_id for step_id in skipped if step_id in SKIPPABLE_STEPS
        }
        completed = set(_STEP_IDS) - skipped
    else:
        completed -= {"xiaomi", "qq"}
        skipped |= {"xiaomi", "qq"}

    synthetic = _v4_synthetic_step_data(source_version)
    step_data = state.setdefault("step_data", {})
    for step_id in ("xiaomi", "qq"):
        step_data[step_id] = copy.deepcopy(synthetic)

    state["completed_steps"] = [
        step_id for step_id in _STEP_IDS if step_id in completed
    ]
    state["skipped_steps"] = [
        step_id
        for step_id in _STEP_IDS
        if step_id in skipped and step_id not in completed
    ]
    _finalise(state)
    return state


def _mark_removed_step_data(value: Any) -> dict:
    payload = copy.deepcopy(value)
    if isinstance(payload, dict):
        payload["removed_in_v4"] = True
        return payload
    return {"value": payload, "removed_in_v4": True}


def _state_from_raw(
    raw: dict,
    now: str,
    *,
    completed: set[str],
    skipped: set[str],
    legacy_upgraded: bool,
) -> dict:
    """Build a v4 state from already-normalised step sets."""
    started_at = raw.get("started_at")
    updated_at = raw.get("updated_at")
    state: dict[str, Any] = {
        "version": STATE_VERSION,
        "completed_steps": [
            step_id for step_id in _STEP_IDS if step_id in completed
        ],
        "skipped_steps": [
            step_id
            for step_id in _STEP_IDS
            if step_id in skipped and step_id not in completed
        ],
        "current_step": None,
        "completed": False,
        "legacy_upgraded": legacy_upgraded,
        "started_at": started_at
        if isinstance(started_at, str) and started_at
        else now,
        "updated_at": updated_at
        if isinstance(updated_at, str) and updated_at
        else now,
    }
    step_data = raw.get("step_data")
    legacy_data: dict[str, Any] = {}
    raw_legacy = raw.get("legacy_step_data")
    if isinstance(raw_legacy, dict):
        legacy_data = {
            key: copy.deepcopy(value)
            for key, value in raw_legacy.items()
            if isinstance(key, str)
        }
    if isinstance(step_data, dict):
        migrated_data: dict[str, Any] = {}
        for key, value in step_data.items():
            if not isinstance(key, str):
                continue
            if key in _STEP_INDEX:
                migrated_data[key] = copy.deepcopy(value)
            elif key in _REMOVED_IN_V4_STEP_IDS:
                legacy_data[key] = _mark_removed_step_data(value)
            else:
                legacy_data[key] = copy.deepcopy(value)
        if migrated_data:
            state["step_data"] = migrated_data
    if legacy_data:
        state["legacy_step_data"] = legacy_data
    _finalise(state)
    return state


def _normalise_state(raw: dict) -> dict:
    """收敛外部状态文件：v1/v2/v3 迁移到 v4，v4 只认可 STEPS id 并按序重排。"""
    now = _now_iso()
    raw_version = raw.get("version")
    if raw_version in (STATE_VERSION, str(STATE_VERSION)):
        return _state_from_raw(
            raw,
            now,
            completed=_string_set(raw.get("completed_steps")),
            skipped=_string_set(raw.get("skipped_steps")),
            legacy_upgraded=raw.get("legacy_upgraded") is True,
        )
    if raw_version in (3, "3"):
        return _migrate_v3(raw, now)
    if raw_version in (2, "2"):
        return _migrate_v2(raw, now)
    return _migrate_v1(raw, now)


def _migrate_v3(raw: dict, now: str) -> dict:
    """v3 -> v4: preflight/startup leave the visible contract."""
    completed = _string_set(raw.get("completed_steps"))
    skipped = _string_set(raw.get("skipped_steps"))
    state = _state_from_raw(
        raw,
        now,
        completed=completed,
        skipped=skipped,
        legacy_upgraded=raw.get("legacy_upgraded") is True,
    )
    return _apply_v4_completion_rule(
        state,
        finish_done=_finish_done(raw, completed, skipped),
        source_version=3,
    )


def _migrate_v2(raw: dict, now: str) -> dict:
    """v2 -> v4: old completed installs never re-enter onboarding."""
    completed = _string_set(raw.get("completed_steps"))
    skipped = _string_set(raw.get("skipped_steps"))
    state = _state_from_raw(
        raw,
        now,
        completed=completed,
        skipped=skipped,
        legacy_upgraded=raw.get("legacy_upgraded") is True,
    )
    return _apply_v4_completion_rule(
        state,
        finish_done=_finish_done(raw, completed, skipped),
        source_version=2,
    )


def _quarantine_corrupt(path: Path) -> None:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")
    target = path.with_name(f"{path.name}{_CORRUPT_SUFFIX}{stamp}")
    try:
        os.replace(path, target)
    except OSError:
        pass


def _read_state(*, repair_corrupt: bool) -> dict:
    path = _state_path()
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return _default_state()
    except OSError:
        return _default_state()
    try:
        raw = json.loads(text)
    except (TypeError, ValueError):
        if repair_corrupt:
            _quarantine_corrupt(path)
        return _default_state()
    if not isinstance(raw, dict):
        if repair_corrupt:
            _quarantine_corrupt(path)
        return _default_state()
    return _normalise_state(raw)


def get_state() -> dict:
    """读取引导状态；缺失返回默认值，损坏文件隔离后返回默认值。"""
    with _STATE_LOCK:
        return _read_state(repair_corrupt=True)


def read_state_snapshot() -> dict:
    """只读状态快照：不修复、不隔离、不写盘（启动校验用）。"""
    with _STATE_LOCK:
        return _read_state(repair_corrupt=False)


def _finalise(state: dict) -> None:
    completed = {item for item in state["completed_steps"] if item in _STEP_INDEX}
    skipped = {
        item
        for item in state["skipped_steps"]
        if item in _STEP_INDEX and item not in completed
    }
    later_done = any(
        step_id not in _PASSIVE_STEP_IDS and step_id in (completed | skipped)
        for step_id in _STEP_IDS
    )
    if later_done:
        completed |= _PASSIVE_STEP_IDS
        skipped -= _PASSIVE_STEP_IDS
    state["version"] = STATE_VERSION
    state["completed_steps"] = [
        step_id for step_id in _STEP_IDS if step_id in completed
    ]
    state["skipped_steps"] = [
        step_id for step_id in _STEP_IDS if step_id in skipped
    ]
    done = completed | skipped
    state["current_step"] = next(
        (step_id for step_id in _STEP_IDS if step_id not in done), None
    )
    state["completed"] = len(done) == len(_STEP_IDS)


def _fsync_directory(directory: Path) -> None:
    if os.name != "posix":
        return
    try:
        dir_fd = os.open(str(directory), os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(dir_fd)
    except OSError:
        pass
    finally:
        os.close(dir_fd)


def _write_state(state: dict) -> None:
    path = _state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent)
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(state, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp_name, 0o600)
        os.replace(tmp_name, path)
        _fsync_directory(path.parent)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


_GATED_STEP_IDS = frozenset({"finish"})
_STARTUP_GATED_STEP_IDS = frozenset({"finish"})


def _missing_previous_steps(state: dict, step_id: str) -> list[str]:
    done = set(state.get("completed_steps") or ()) | set(
        state.get("skipped_steps") or ()
    )
    position = _STEP_INDEX[step_id]
    return [
        previous
        for previous in _STEP_IDS[:position]
        if previous not in done and previous not in _PASSIVE_STEP_IDS
    ]


def _raise_out_of_order(step_id: str, missing: list[str]) -> None:
    raise StepOutOfOrder(
        f"步骤 {step_id!r} 之前还有未完成步骤: {', '.join(missing)}"
    )


def _preflight_step_summary(result: dict, *, allow_degraded: bool) -> dict:
    """落盘用的稳定摘要：只保留 id/status，避免把 detail 里的路径写进状态。"""
    return {
        "can_proceed": bool(result.get("can_proceed")),
        "blocking": list(result.get("blocking_failures") or ()),
        "blocking_failures": list(result.get("blocking_failures") or ()),
        "soft_failures": list(result.get("soft_failures") or ()),
        "checks": [
            {"id": check["id"], "status": check["status"]}
            for check in result.get("checks") or ()
        ],
        "summary": dict(result.get("summary") or {}),
        "allow_degraded": bool(allow_degraded),
    }


def _gated_step_data(
    data: Optional[dict], result: dict, *, allow_degraded: bool
) -> dict:
    payload = copy.deepcopy(data) if isinstance(data, dict) else {}
    payload.update(_preflight_step_summary(result, allow_degraded=allow_degraded))
    return payload


def _kernel_models_blocked(result: dict) -> bool:
    """必需模型缺失是硬阻断：``allow_degraded`` 不得豁免。

    ``_check_kernel_models`` 仅在 required 层模型缺失时返回 ``fail``；
    可选/推荐层缺失仍是 pass/warn，保持可跳过。
    """
    for check in result.get("checks") or ():
        if isinstance(check, dict) and check.get("id") == "kernel_models":
            return check.get("status") == "fail"
    return False


def _evaluate_preflight_gate(
    result: dict, data: Optional[dict]
) -> tuple[dict, bool]:
    """执行硬阻断/软降级判定，不触发任何预检 IO。

    重跑与直接传入预检结果共用这一处判定，保证两条路径的硬失败、
    ``allow_degraded`` 归一化完全一致。
    """
    allow_degraded = isinstance(data, dict) and data.get("allow_degraded") is True
    if result.get("blocking_failures") or _kernel_models_blocked(result):
        raise PreflightBlocked(result)
    if result.get("soft_failures") and not allow_degraded:
        raise DegradedRequiresAck(result)
    return result, allow_degraded


def _run_preflight_gate(data: Optional[dict]) -> tuple[dict, bool]:
    """重跑预检并执行硬阻断/软降级门禁。"""
    result = run_preflight(default_project_root())
    return _evaluate_preflight_gate(result, data)


def _startup_gate_report(status: Optional[StartupStatus]) -> dict:
    if status is None:
        return {"runtime": {}, "startup": {}}
    runtime_report = copy.deepcopy(status.runtime_report)
    if not runtime_report:
        runtime_report = {"state": status.runtime_state}
    return {
        "runtime": runtime_report,
        "startup": copy.deepcopy(status.validation_report),
    }


def _check_startup_gate(
    status: Optional[StartupStatus], *, require_report: bool = True
) -> None:
    report = _startup_gate_report(status)
    if status is None:
        raise StartupRequired(report)
    validation = status.validation_report
    if require_report and isinstance(validation, dict) and validation.get("ok") is False:
        raise StartupFailed(report)
    if status.runtime_state not in _STARTUP_READY_STATES:
        raise StartupRequired(report)
    if require_report and (
        not isinstance(validation, dict) or validation.get("ok") is not True
    ):
        raise StartupRequired(report)


def record_step(
    step_id: str,
    status: str,
    data: Optional[dict] = None,
    dry_run: bool = False,
    *,
    startup_status: Optional[StartupStatus] = None,
    preflight_result: Optional[dict] = None,
) -> dict:
    """记录一步 completed/skipped；返回（或预演）写入后的完整状态。

    v4 把预检与启动校验合并进唯一可见的 ``finish``：记录 completed 时默认
    重跑预检并执行硬阻断/软降级门禁（硬失败抛 :class:`PreflightBlocked`，
    仅软失败且未显式 ``allow_degraded=true`` 时抛
    :class:`DegradedRequiresAck`）；同时要求启动运行时处于
    validated/promoted/committed 且最后一次启动校验未失败，否则抛
    :class:`StartupRequired` / :class:`StartupFailed`。

    启动服务面会占用预检端口，因此 ``/finish`` 编排层必须在启动前完成预检，
    再把结果经 ``preflight_result`` 传入：传入后不再重跑 ``run_preflight``，
    但仍按同一套硬阻断/软降级规则判定，并生成同样的步骤摘要。

    门禁检查先于幂等提前返回，因此重复记录不会绕过服务端复检。
    """
    if step_id not in _STEP_INDEX:
        raise ValueError(f"未知的引导步骤: {step_id!r}")
    if status not in _STEP_STATUSES:
        raise ValueError(
            f"非法的步骤状态: {status!r}（仅支持 completed / skipped）"
        )
    if status == "skipped" and step_id not in SKIPPABLE_STEPS:
        raise ValueError(f"步骤 {step_id!r} 不可跳过（仅允许 completed）")

    gated = step_id in _GATED_STEP_IDS and status == "completed"
    if gated:
        with _STATE_LOCK:
            preview_state = _read_state(repair_corrupt=not dry_run)
        missing = _missing_previous_steps(preview_state, step_id)
        if missing:
            _raise_out_of_order(step_id, missing)
        if preflight_result is not None:
            gate_result, allow_degraded = _evaluate_preflight_gate(
                preflight_result, data
            )
        else:
            gate_result, allow_degraded = _run_preflight_gate(data)
        data = _gated_step_data(data, gate_result, allow_degraded=allow_degraded)

    if step_id in _STARTUP_GATED_STEP_IDS and status == "completed":
        with _STATE_LOCK:
            preview_state = _read_state(repair_corrupt=not dry_run)
        missing = _missing_previous_steps(preview_state, step_id)
        if missing:
            _raise_out_of_order(step_id, missing)
        if step_id not in preview_state.get("completed_steps", ()):
            _check_startup_gate(startup_status)

    with _STATE_LOCK:
        state = _read_state(repair_corrupt=not dry_run)
        missing = _missing_previous_steps(state, step_id)
        if missing:
            _raise_out_of_order(step_id, missing)

        target_key = "completed_steps" if status == "completed" else "skipped_steps"
        data_copy = copy.deepcopy(data) if data is not None else None

        if step_id in state[target_key]:
            stored_data = state.get("step_data", {}).get(step_id)
            if data_copy is None or stored_data == data_copy:
                return copy.deepcopy(state)
            state = copy.deepcopy(state)
            state.setdefault("step_data", {})[step_id] = data_copy
            state["updated_at"] = _now_iso()
            _finalise(state)
            if not dry_run:
                _write_state(state)
            return copy.deepcopy(state)

        hypothetical = copy.deepcopy(state)
        for key in ("completed_steps", "skipped_steps"):
            if step_id in hypothetical[key]:
                hypothetical[key].remove(step_id)
        hypothetical[target_key].append(step_id)
        if data_copy is not None:
            hypothetical.setdefault("step_data", {})[step_id] = data_copy
        hypothetical["updated_at"] = _now_iso()
        _finalise(hypothetical)

        if not dry_run:
            _write_state(hypothetical)
        return copy.deepcopy(hypothetical)


def legacy_complete(users_exist: bool, degraded: bool) -> bool:
    """升级安装的静默判定：有状态文件看状态，没有则沿用旧启发式。

    状态文件缺失时，已存在用户且配置不处于降级态即视为引导已完成，
    避免升级安装被反复要求走向导；无用户则一律视为未完成。
    """
    with _STATE_LOCK:
        if _state_path().is_file():
            return bool(get_state().get("completed"))
    return bool(users_exist) and not bool(degraded)


def is_legacy_install() -> bool:
    """无状态文件且已有用户 = 升级安装；此时绝不进入 bootstrap 门禁。"""
    with _STATE_LOCK:
        if _state_path().is_file():
            return False
    try:
        import auth

        return not auth.is_setup_required()
    except Exception:
        return False


def _auth_setup_required() -> Optional[bool]:
    try:
        import auth

        return bool(auth.is_setup_required())
    except Exception:
        return None


def ensure_fresh_state() -> bool:
    """全新安装（无状态文件且无用户）落地 v4 默认状态文件。

    只在这一确定条件下写盘：已有状态文件、已有用户（升级安装）或认证状态
    不可知时一律返回 False，绝不覆盖或新建。写入复用 ``_write_state`` 的
    原子序列，并在 ``_STATE_LOCK`` 下完成检查与写入。
    """
    with _STATE_LOCK:
        if _state_path().is_file():
            return False
        if _auth_setup_required() is not True:
            return False
        _write_state(_default_state())
        return True


def is_bootstrap_mode() -> bool:
    """Deprecated：仅供回滚脚本与只读状态展示，不再驱动服务面启动。

    任务 17 起主入口只有一个启动路径；未完成引导由编排器的 blocked 服务
    表达。新代码请读 ``onboarding_state.completed`` 或 ``/api/services``。
    """
    state: Optional[dict] = None
    with _STATE_LOCK:
        if _state_path().is_file():
            state = get_state()
            if state.get("completed"):
                return False
    override = os.environ.get("AXEUH_ONBOARDING_BOOTSTRAP", "").strip().lower()
    if override in {"1", "true", "yes", "on"}:
        return True
    if override in {"0", "false", "no", "off"}:
        return False
    setup_required = _auth_setup_required()
    if setup_required is True:
        return True
    if state is not None:
        if state.get("legacy_upgraded") and setup_required is not True:
            return False
        return True
    return False


def gate_should_block() -> bool:
    """503 引导门的决策函数（唯一真源）。

    全部步骤完成（``completed``）放行；第一阶段三步
    （``_PHASE1_DATA_PLANE_STEP_IDS``）记录齐全也放行，使数据面在
    finish 之前即可收发数据。没有状态文件的旧安装（已有用户）放行；
    读取异常按放行处理，与旧门禁在运行时缺失时的纯放行语义一致。
    """
    with _STATE_LOCK:
        if not _state_path().is_file():
            try:
                import auth

                return bool(auth.is_setup_required())
            except Exception:  # noqa: BLE001 - 认证状态不可知时不阻断
                return False
        try:
            state = _read_state(repair_corrupt=False)
        except Exception:  # noqa: BLE001 - 读状态失败时按放行处理
            return False
        if bool(state.get("completed")):
            return False
        done = set(state.get("completed_steps") or ()) | set(
            state.get("skipped_steps") or ()
        )
        return not all(
            step_id in done for step_id in _PHASE1_DATA_PLANE_STEP_IDS
        )


def _text_value(value: Any) -> Optional[str]:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _bool_value(value: Any) -> Optional[bool]:
    return value if isinstance(value, bool) else None


def _tiers_value(value: Any) -> Optional[list[str]]:
    if not isinstance(value, (list, tuple)) or not value:
        return None
    return [str(item) for item in value]


def _step_config_section(snapshot: Optional[dict], name: str) -> dict:
    if not isinstance(snapshot, dict):
        return {}
    section = snapshot.get(name)
    return section if isinstance(section, dict) else {}


def step_config_changes(
    step_id: str,
    data: Optional[dict],
    snapshot: Optional[dict] = None,
) -> dict[str, Any]:
    """返回某步骤完成后应写入草稿的配置变更（schema 校验前的原始意图）。

    ``POST /state`` 只把这里返回的键交给 ``ConfigStore.stage()``：单步不会
    立即 apply，finish 时统一应用。映射只覆盖步骤自身管理的、非密钥的配置；
    token / 密码等敏感值仍由各步骤专用端点落独立密钥文件，绝不进入草稿。
    ``snapshot`` 是当前生效配置（``ConfigStore.snapshot()``），moss 用它补齐
    未在步骤数据里重复提交的三个键。
    """
    payload = data if isinstance(data, dict) else {}
    changes: dict[str, Any] = {}

    if step_id == "dependencies":
        choice = _text_value(payload.get("choice"))
        if choice in {"download", "decline"}:
            changes["onboarding.allow_model_download"] = choice == "download"
        tiers = _tiers_value(payload.get("tiers"))
        if tiers:
            changes["onboarding.model_tiers"] = tiers
        models_dir = _text_value(payload.get("models_dir"))
        if models_dir:
            changes["models.dir"] = models_dir
    elif step_id == "kernel":
        python = _text_value(payload.get("python"))
        if python:
            changes["kernel.python"] = python
        device = _text_value(payload.get("device"))
        if device:
            changes["kernel.device"] = device
        torch_index = _text_value(payload.get("torch_index_url"))
        if torch_index:
            changes["kernel.torch_index_url"] = torch_index
    elif step_id == "kernel_models":
        tiers = _tiers_value(payload.get("tiers"))
        if tiers:
            changes["onboarding.model_tiers"] = tiers
        models_dir = _text_value(payload.get("models_dir"))
        if models_dir:
            changes["models.dir"] = models_dir
    elif step_id == "xiaomi":
        enabled = _bool_value(payload.get("enabled"))
        if enabled is not None:
            changes["health.cloud.enabled"] = enabled
    elif step_id == "qq":
        enabled = _bool_value(payload.get("enabled"))
        if enabled is not None:
            changes["qq_gateway.enabled"] = enabled
        self_qq = _text_value(payload.get("self_qq"))
        if self_qq:
            changes["qq_gateway.account.self_qq"] = self_qq
        ws_url = _text_value(payload.get("ws_url"))
        if ws_url:
            changes["qq_gateway.account.ws_url"] = ws_url
    elif step_id == "moss":
        # MOSS 步骤固定只托管三个键；数据缺省时沿用当前生效值。
        section = _step_config_section(snapshot, "moss")
        enabled = _bool_value(payload.get("enabled"))
        if enabled is None:
            enabled = _bool_value(section.get("enabled"))
        if enabled is not None:
            changes["moss.enabled"] = enabled
        for field in ("base_url", "model"):
            value = _text_value(payload.get(field)) or _text_value(
                section.get(field)
            )
            if value:
                changes[f"moss.{field}"] = value
    elif step_id == "loom":
        # 只有完成了 Loom 步骤才把通道切到 loom；跳过的步骤不改 ai_backend。
        changes["ai_backend"] = "loom"
        url = _text_value(payload.get("url"))
        port = payload.get("port")
        if url:
            changes["loom.url"] = url
        elif isinstance(port, int) and not isinstance(port, bool) and 1 <= port <= 65535:
            changes["loom.url"] = f"http://127.0.0.1:{port}"
    return changes


def steps_metadata(state: Optional[dict] = None) -> list[dict[str, Any]]:
    """把状态映射为前端可消费的步骤元数据（顺序即契约）。"""
    snapshot = state if state is not None else get_state()
    completed = set(snapshot.get("completed_steps") or ())
    skipped = set(snapshot.get("skipped_steps") or ())
    current = snapshot.get("current_step")
    result: list[dict[str, Any]] = []
    for step in STEPS:
        if step.id in completed:
            step_state = "completed"
        elif step.id in skipped:
            step_state = "skipped"
        elif step.id == current:
            step_state = "current"
        else:
            step_state = "pending"
        result.append(
            {
                "id": step.id,
                "title": step.title,
                "description": step.description,
                "required": step.required,
                "skippable": step.skippable,
                "state": step_state,
                "auth": step.auth,
                "write_auth": step.write_auth,
            }
        )
    return result


# ---------------------------------------------------------------------------
# 配置运行态（无配置 / 降级）
# ---------------------------------------------------------------------------


def _call_value(target: Any, name: str) -> Any:
    """读取属性或调用无参方法；未知可选接口的异常一律视为缺失。"""
    value = getattr(target, name, None)
    if callable(value):
        try:
            return value()
        except Exception:
            return None
    return value


def _status_flag(source: Any) -> Optional[bool]:
    """把多种可能的状态表示归一为“是否降级”。"""
    for name in ("degraded", "is_degraded", "unconfigured", "is_unconfigured"):
        value = _call_value(source, name)
        if isinstance(value, bool):
            return value
    status = _call_value(source, "status")
    if status is None:
        status = _call_value(source, "state")
    if isinstance(status, str):
        token = status.strip().lower()
        if token in _OK_CONFIG_STATUSES:
            return False
        if token in _DEGRADED_CONFIG_STATUSES:
            return True
    if isinstance(status, dict):
        for key in ("degraded", "status", "state"):
            value = status.get(key)
            if isinstance(value, bool):
                return value
            if isinstance(value, str):
                token = value.strip().lower()
                if token in _OK_CONFIG_STATUSES:
                    return False
                if token in _DEGRADED_CONFIG_STATUSES:
                    return True
    if status is not None and not isinstance(status, str):
        nested = _status_flag(status)
        if nested is not None:
            return nested
    return None


def _read_revision(source: Any) -> Optional[str]:
    for name in ("revision", "current_revision", "config_revision", "CONFIG_REVISION"):
        value = _call_value(source, name)
        if isinstance(value, str) and value:
            return value
        if isinstance(value, int) and not isinstance(value, bool):
            return str(value)
    return None


def _read_provider(source: Any) -> Optional[str]:
    raw = _call_value(source, "provider")
    if raw is None:
        raw = _call_value(source, "config_provider")
    if raw is None:
        raw = _call_value(source, "provider_info")
    if isinstance(raw, str) and raw:
        return raw
    if raw is not None:
        kind = _call_value(raw, "kind")
        if kind is None:
            kind = _call_value(raw, "name")
        if isinstance(kind, str) and kind:
            return kind
        described = _call_value(raw, "describe")
        if described is not None:
            kind = _call_value(described, "kind")
            if isinstance(kind, str) and kind:
                return kind
    return None


def _file_revision(path: Path) -> Optional[str]:
    try:
        stat = path.stat()
    except OSError:
        return None
    return f"{stat.st_mtime_ns}-{stat.st_size}"


def _probe_store_status() -> Optional[ConfigRuntimeStatus]:
    """尝试读取新的 ConfigStore；模块不存在或接口不符时返回 None。"""
    try:
        from config import store as store_module
    except Exception:
        return None
    getter = getattr(store_module, "get_config_store", None)
    if not callable(getter):
        return None
    try:
        store = getter()
    except Exception:
        return None
    if store is None:
        return None
    sources = [store]
    snapshot = _call_value(store, "snapshot")
    if snapshot is not None and snapshot is not store:
        sources.append(snapshot)
    degraded: Optional[bool] = None
    revision: Optional[str] = None
    provider: Optional[str] = None
    for source in sources:
        if degraded is None:
            degraded = _status_flag(source)
        if revision is None:
            revision = _read_revision(source)
        if provider is None:
            provider = _read_provider(source)
    return ConfigRuntimeStatus(
        degraded=False if degraded is None else degraded,
        revision=revision,
        provider=provider,
        detail=f"store={type(store).__name__}",
    )


def read_config_runtime_status() -> ConfigRuntimeStatus:
    """读取配置运行态；新存储不可用时回退到旧 Config 对象。"""
    probed = _probe_store_status()
    if probed is not None:
        return probed
    try:
        from config.config import get_config
    except ImportError as exc:
        return ConfigRuntimeStatus(
            degraded=True,
            revision=None,
            provider=None,
            detail=f"config module unavailable: {type(exc).__name__}",
        )
    try:
        config = get_config()
    except Exception as exc:
        return ConfigRuntimeStatus(
            degraded=True,
            revision=None,
            provider=None,
            detail=f"config unavailable: {type(exc).__name__}",
        )
    degraded = _status_flag(config)
    raw_status = _call_value(config, "CONFIG_STATUS")
    status_text = str(raw_status) if raw_status is not None else ""
    revision = _read_revision(config)
    if revision is None:
        revision = _file_revision(_resolve_config_path(default_project_root()))
    return ConfigRuntimeStatus(
        degraded=False if degraded is None else degraded,
        revision=revision,
        provider=_read_provider(config),
        detail=f"status={status_text}" if status_text else "",
    )


# ---------------------------------------------------------------------------
# 引导动作
# ---------------------------------------------------------------------------


def _action_project_root(project_root: Path | str) -> Path:
    root = Path(project_root).expanduser().resolve()
    if not root.is_dir():
        raise OnboardingActionInvalid(
            "project_root_missing", f"项目根目录不存在: {root}"
        )
    return root


def _count_files(root: Path) -> int:
    return sum(1 for path in root.rglob("*") if path.is_file())


def copy_ai_template(
    project_root: Path | str, overwrite: bool = False
) -> dict[str, Any]:
    """仅在 ``ai/`` 不存在时复制模板；已存在则无条件拒绝。"""
    root = _action_project_root(project_root)
    source = root / "ai-template"
    target = root / "ai"
    if not source.is_dir():
        raise OnboardingActionInvalid(
            "template_missing", f"未找到 ai-template 目录: {source}"
        )
    if target.exists() or target.is_symlink():
        raise OnboardingActionConflict(
            "already_exists",
            "ai/ 已存在（含空目录或符号链接），拒绝执行 copy_ai_template；"
            "请先确认并移走现有 ai/，本操作不会覆盖或删除任何既有文件",
        )

    staging_root = Path(
        tempfile.mkdtemp(prefix=".onboarding-ai-", dir=str(root))
    )
    staged = staging_root / "ai"
    try:
        shutil.copytree(source, staged)
        os.replace(staged, target)
    finally:
        shutil.rmtree(staging_root, ignore_errors=True)
    return {
        "action": "copy_ai_template",
        "source": str(source),
        "target": str(target),
        "copied": True,
        "overwritten": False,
        "files": _count_files(target),
    }


def _default_code_repo_root() -> Path:
    from config import paths as config_paths

    return Path(config_paths._DEFAULT_PROJECT_ROOT)


def _resolve_ai_instance_target(root: Path, ai_root: Path | str | None) -> Path:
    if ai_root is not None and str(ai_root).strip():
        raw = str(ai_root).strip()
    else:
        from config.config import get_config

        raw = str(get_config().AI_ROOT or "").strip()
        if not raw:
            raise OnboardingActionInvalid(
                "ai_root_missing",
                "无法确定 AI 实例目录：config 未提供 data.ai_root 或 data.dir",
            )
    path = Path(raw).expanduser()
    if not path.is_absolute():
        path = root / path
    return path.resolve()


def _assert_safe_ai_instance_target(
    target: Path, staging_root: Optional[Path], code_repo_root: Path
) -> None:
    anchor = Path(target.anchor) if target.anchor else None
    if (anchor is not None and target == anchor) or target == Path.home().resolve():
        raise OnboardingActionInvalid(
            "unsafe_target",
            f"拒绝把 AI 实例目录指向系统根或用户主目录: {target}",
        )
    if staging_root is None:
        return
    live_ai = (code_repo_root / "ai").resolve()
    if target.is_relative_to(live_ai) and not target.is_relative_to(staging_root):
        raise OnboardingActionInvalid(
            "staging_target_escape",
            f"拒绝写入代码仓库 ai 目录（{live_ai}）：AXEUH_PROJECT_ROOT 指向 "
            f"{staging_root}，目标 {target} 在其外部",
        )


def _copy_new_file(source: Path, target: Path) -> bool:
    """以独占方式写入单个文件；目标已存在时返回 False，绝不覆盖。"""
    descriptor, temp_name = tempfile.mkstemp(
        dir=str(target.parent), prefix=".ensure-ai-", suffix=".tmp"
    )
    os.close(descriptor)
    temp = Path(temp_name)
    try:
        shutil.copy2(source, temp)
        try:
            os.link(temp, target)
        except FileExistsError:
            return False
        except OSError:
            if target.exists() or target.is_symlink():
                return False
            os.replace(temp, target)
        return True
    finally:
        try:
            temp.unlink()
        except FileNotFoundError:
            pass


def _copy_missing_template_files(
    source: Path, target: Path
) -> tuple[int, int, list[str]]:
    copied = 0
    existing = 0
    errors: list[str] = []
    for directory, dirnames, filenames in os.walk(source):
        current = Path(directory)
        dirnames[:] = sorted(
            name
            for name in dirnames
            if name not in _AI_TEMPLATE_SKIP_DIRS
            and not (current / name).is_symlink()
        )
        relative = current.relative_to(source)
        destination_dir = target / relative
        try:
            destination_dir.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            errors.append(f"{relative}: {exc}")
            continue
        for name in sorted(filenames):
            item = current / name
            if item.is_symlink() or not item.is_file():
                continue
            destination = destination_dir / name
            if destination.exists() or destination.is_symlink():
                existing += 1
                continue
            try:
                if _copy_new_file(item, destination):
                    copied += 1
                else:
                    existing += 1
            except OSError as exc:
                errors.append(f"{relative / name}: {exc}")
    return copied, existing, errors


def ensure_ai_instance(
    project_root: Path | str | None = None,
    ai_root: Path | str | None = None,
    *,
    template_root: Path | str | None = None,
    code_repo_root: Path | str | None = None,
) -> dict[str, Any]:
    """确保 AI 实例目录存在并补齐 ai-template 中缺失的文件，永不覆盖。"""
    root = (
        Path(project_root).expanduser().resolve()
        if project_root is not None
        else default_project_root()
    )
    staging_raw = os.environ.get("AXEUH_PROJECT_ROOT", "").strip()
    staging_root = Path(staging_raw).expanduser().resolve() if staging_raw else None
    repo_root = (
        Path(code_repo_root).expanduser().resolve()
        if code_repo_root is not None
        else _default_code_repo_root().resolve()
    )
    target = _resolve_ai_instance_target(root, ai_root)
    _assert_safe_ai_instance_target(target, staging_root, repo_root)

    source = (
        Path(template_root).expanduser().resolve()
        if template_root is not None
        else (root / "ai-template").resolve()
    )
    if not source.is_dir():
        raise OnboardingActionInvalid(
            "template_missing", f"未找到 ai-template 目录: {source}"
        )

    with _AI_ENSURE_LOCK:
        created = not target.exists()
        if target.is_symlink() and not target.exists():
            raise OnboardingActionInvalid(
                "target_not_directory", f"AI 实例目录不可用（悬空符号链接）: {target}"
            )
        if target.exists() and not target.is_dir():
            raise OnboardingActionInvalid(
                "target_not_directory", f"AI 实例路径已存在但不是目录: {target}"
            )
        target.mkdir(parents=True, exist_ok=True)
        copied, existing, errors = _copy_missing_template_files(source, target)
    return {
        "action": "ensure_ai_instance",
        "target": str(target),
        "created": created,
        "copied_files": copied,
        "existing_files": existing,
        "errors": errors,
    }


def generate_self_signed_cert(
    project_root: Path | str, overwrite: bool = False
) -> dict[str, Any]:
    """用 openssl 生成 localhost/127.0.0.1 自签证书，不写任何配置。"""
    root = _action_project_root(project_root)
    certs = root / "backend" / "config" / "certs"
    cert = certs / "cert.pem"
    key = certs / "key.pem"
    existing = cert.exists() or key.exists()
    if existing and not overwrite:
        raise OnboardingActionConflict(
            "already_exists", "证书或私钥已存在；如需重新生成请显式设置 overwrite=true"
        )
    openssl = shutil.which("openssl")
    if not openssl:
        raise OnboardingActionInvalid(
            "openssl_unavailable", "系统未安装 openssl，无法生成自签证书"
        )

    try:
        certs.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise OnboardingActionInvalid(
            "cert_directory_invalid", f"无法创建证书目录: {certs}"
        ) from exc
    try:
        os.chmod(certs, 0o700)
    except OSError:
        pass
    staging = Path(
        tempfile.mkdtemp(prefix=".onboarding-certs-", dir=str(certs))
    )
    staged_cert = staging / "cert.pem"
    staged_key = staging / "key.pem"
    command = [
        openssl,
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        str(staged_key),
        "-out",
        str(staged_cert),
        "-days",
        "825",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ]
    try:
        try:
            completed = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=60,
                check=False,
                shell=False,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise OnboardingActionInvalid(
                "cert_generation_failed",
                f"无法执行 openssl: {type(exc).__name__}",
            ) from exc
        if completed.returncode != 0:
            stderr_lines = (
                (completed.stderr or completed.stdout or "").strip().splitlines()
            )
            reason = (
                stderr_lines[-1]
                if stderr_lines
                else f"exit {completed.returncode}"
            )
            raise OnboardingActionInvalid(
                "cert_generation_failed", f"openssl 生成证书失败: {reason}"
            )
        os.chmod(staged_cert, 0o600)
        os.chmod(staged_key, 0o600)
        os.replace(staged_cert, cert)
        os.replace(staged_key, key)
        _fsync_directory(certs)
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    return {
        "action": "generate_self_signed_cert",
        "cert": str(cert),
        "key": str(key),
        "san": ["localhost", "127.0.0.1"],
        "days": 825,
        "overwritten": bool(existing and overwrite),
    }


# ---------------------------------------------------------------------------
# 只读环境预检
# ---------------------------------------------------------------------------


_CHECK_META: dict[str, tuple[str, str, bool]] = {
    "python": ("Python 版本", "environment", True),
    "config": ("配置文件", "config", True),
    "frontend_dist": ("前端构建产物", "assets", True),
    "ai_dir": ("AI 数据目录", "assets", False),
    "disk": ("磁盘可用空间", "environment", True),
    "ports": ("服务端口", "network", True),
    "ssl": ("SSL 证书", "security", True),
    "kernel": ("音频内核", "runtime", False),
    "kernel_models": ("内核模型", "runtime", False),
    "loom": ("Loom 助手", "services", False),
    "ai_backend": ("AI 后端", "services", False),
}

CHECK_IDS: tuple[str, ...] = tuple(_CHECK_META)


def _check_result(
    check_id: str, status: str, detail: str, fix: str = ""
) -> dict:
    label, category, blocking = _CHECK_META[check_id]
    return {
        "id": check_id,
        "label": label,
        "status": status,
        "blocking": blocking,
        "category": category,
        "detail": redact_text(detail),
        "fix": redact_text(fix),
    }


def _resolve_config_path(project_root: Path) -> Path:
    env_path = os.environ.get("AXEUH_CONFIG_PATH", "").strip()
    if not env_path:
        env_path = os.environ.get("CONFIG_PATH", "").strip()
    if env_path:
        return Path(env_path).expanduser()
    try:
        from config.config import _CONFIG_PATH as configured_path
    except Exception:
        configured_path = None
    if configured_path:
        return Path(configured_path).expanduser()
    backend_config = project_root / "backend" / "config" / "config.yaml"
    if backend_config.is_file():
        return backend_config
    root_config = project_root / "config.yaml"
    if root_config.is_file():
        return root_config
    return backend_config


def _load_raw_config(root: Path) -> tuple[Optional[dict], Path, Optional[str]]:
    path = _resolve_config_path(root)
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None, path, "missing"
    except OSError:
        return None, path, "unreadable"
    try:
        raw = yaml.safe_load(text)
    except yaml.YAMLError:
        return None, path, "invalid"
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        return None, path, "invalid"
    return raw, path, None


def _load_live_config() -> Optional[_LiveConfigSnapshot]:
    """读取 ConfigStore 当前有效快照；存储不可用时返回 None。

    快照由 store 负责合并 schema 默认值、base 层与 env overlay，预检不再自行
    解析原始 YAML/JSON（仅作为 store 不可用时的回退）。
    """
    try:
        from config import store as store_module
    except Exception:
        return None
    getter = getattr(store_module, "get_config_store", None)
    if not callable(getter):
        return None
    try:
        store = getter()
    except Exception:
        return None
    if store is None:
        return None
    try:
        document = store.snapshot()
    except Exception:
        return None
    if not isinstance(document, dict) or not document:
        return None

    degraded: list[str] = []
    raw_reasons = _call_value(store, "degraded")
    if isinstance(raw_reasons, (list, tuple)):
        degraded = [
            str(reason) for reason in raw_reasons if str(reason).strip()
        ]
    elif isinstance(raw_reasons, bool) and raw_reasons:
        degraded = ["degraded"]
    provider_info = _call_value(store, "provider_info")
    writable = getattr(provider_info, "writable", True)
    return _LiveConfigSnapshot(
        document=copy.deepcopy(document),
        degraded=tuple(dict.fromkeys(degraded)),
        revision=_read_revision(store),
        provider=_read_provider(store),
        writable=True if writable is None else bool(writable),
    )


def _section(raw: Optional[dict], name: str) -> dict:
    if not isinstance(raw, dict):
        return {}
    value = raw.get(name)
    return value if isinstance(value, dict) else {}


def _opencode_missing_keys(raw: Optional[dict]) -> list[str]:
    section = _section(raw, "opencode")
    return [
        key
        for key in _OPENCODE_REQUIRED_KEYS
        if not str(section.get(key) or "").strip()
    ]


def _resolve_path(root: Path, value: str) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = root / path
    return path


def _check_python() -> dict:
    version = sys.version.split()[0]
    if tuple(sys.version_info[:2]) >= _MIN_PYTHON:
        return _check_result("python", "pass", f"Python {version}")
    return _check_result(
        "python",
        "fail",
        f"Python {version}（要求 >= 3.10）",
        "安装并切换到 Python 3.10 或更高版本",
    )


def _config_runtime_suffix(degraded_hint: bool = False) -> str:
    runtime = read_config_runtime_status()
    degraded = runtime.degraded or degraded_hint
    state_text = "降级" if degraded else "正常"
    parts = [f"运行状态={state_text}"]
    if runtime.provider:
        parts.append(f"provider={runtime.provider}")
    if runtime.detail:
        parts.append(runtime.detail)
    return "；".join(parts)


def _live_config_suffix(live: _LiveConfigSnapshot) -> str:
    state_text = "降级" if live.degraded else "正常"
    parts = [f"运行状态={state_text}"]
    if live.provider:
        parts.append(f"provider={live.provider}")
    if live.degraded:
        parts.append("原因=" + ", ".join(live.degraded))
    elif live.revision:
        parts.append(f"revision={live.revision}")
    return "；".join(parts)


def _config_path_writable(path: Optional[Path]) -> bool:
    if path is None:
        return False
    try:
        if path.exists():
            return path.is_file() and os.access(path, os.W_OK)
        parent = path.parent
        return parent.is_dir() and os.access(parent, os.W_OK)
    except OSError:
        return False


def _check_config(
    live: Optional[_LiveConfigSnapshot],
    raw: Optional[dict],
    path: Optional[Path],
    load_error: Optional[str],
) -> dict:
    if live is not None:
        suffix = _live_config_suffix(live)
        if not live.writable:
            return _check_result(
                "config",
                "fail",
                f"配置后端只读，无法保存设置；{suffix}",
                "切换到可写的配置后端或修正配置文件权限",
            )
        if live.degraded:
            reasons = ", ".join(live.degraded)
            return _check_result(
                "config",
                "warn",
                f"配置存储处于降级状态: {reasons}；{suffix}",
                "可继续在设置向导中完成配置；未配置时按默认值降级运行",
            )
        return _check_result("config", "pass", f"配置存储可用；{suffix}")

    degraded_hint = bool(load_error) or not raw or bool(
        _opencode_missing_keys(raw)
    )
    suffix = _config_runtime_suffix(degraded_hint)
    path_text = str(path) if path is not None else "（未解析到配置路径）"
    if path is not None and path.exists() and not _config_path_writable(path):
        return _check_result(
            "config",
            "fail",
            f"配置文件不可写: {path_text}；{suffix}",
            "修正文件属主/权限，确保后端运行用户可写配置",
        )
    if load_error == "missing":
        if path is not None and path.parent.is_dir() and not _config_path_writable(path):
            return _check_result(
                "config",
                "fail",
                f"配置目录不可写，无法创建配置文件: {path_text}；{suffix}",
                "修正目录属主/权限，确保后端运行用户可写配置目录",
            )
        return _check_result(
            "config",
            "warn",
            f"未找到配置文件: {path_text}；{suffix}",
            "可继续在设置向导中完成配置；未配置时按默认值降级运行",
        )
    if load_error:
        return _check_result(
            "config",
            "warn",
            f"配置文件无法读取或解析: {path_text}；{suffix}",
            "检查 YAML 语法与文件权限后重新保存，或继续以默认值降级运行",
        )
    missing = _opencode_missing_keys(raw)
    if missing:
        names = ", ".join(f"opencode.{key}" for key in missing)
        return _check_result(
            "config",
            "warn",
            f"配置文件存在但尚未初始化完成（缺少 {names}）；{suffix}",
            "在设置向导或 config.yaml 中补齐 opencode 必填项",
        )
    return _check_result(
        "config", "pass", f"配置文件可写且可解析: {path_text}；{suffix}"
    )


def _frontend_download_active() -> bool:
    """只读判断前端 dist 是否正在下载/自愈（不启动任何下载）。"""
    try:
        from services import onboarding_jobs

        for snapshot in onboarding_jobs.get_job_manager().list_snapshots():
            if (
                snapshot.get("asset") == "frontend"
                and snapshot.get("state") in {"queued", "running"}
            ):
                return True
    except Exception:
        pass
    try:
        from services import release_assets

        state = release_assets.frontend_self_heal_state()
        return state.get("status") in {"running", "downloading"}
    except Exception:
        return False


def _check_frontend_dist(root: Path) -> dict:
    override = os.environ.get("AEUH_FRONTEND_DIST", "").strip()
    if override:
        dist_dir = _resolve_path(root, override)
        source = f"AEUH_FRONTEND_DIST={dist_dir}"
    else:
        dist_dir = root / "frontend" / "mobile" / "dist"
        source = str(dist_dir)
    index = dist_dir / "index.html"
    if index.is_file():
        return _check_result("frontend_dist", "pass", f"{index} 已存在")
    if _frontend_download_active():
        return _check_result(
            "frontend_dist",
            "warn",
            f"{index} 尚不存在（{source}），下载/自愈进行中",
            "等待下载完成后重新预检；失败时可手动运行 npm run build:atomic",
        )
    return _check_result(
        "frontend_dist",
        "fail",
        f"{index} 不存在（{source}）",
        "运行 cd frontend/mobile && npm run build:atomic 生成 dist",
    )


def _configured_ai_dir(root: Path, document: Optional[dict]) -> Path:
    data = _section(document, "data")
    configured = data.get("ai_root")
    if isinstance(configured, str) and configured.strip():
        return _resolve_path(root, configured.strip())
    data_dir = data.get("dir")
    if isinstance(data_dir, str) and data_dir.strip():
        return _resolve_path(root, data_dir.strip()).parent
    configured = _section(document, "opencode").get("directory")
    if isinstance(configured, str) and configured.strip():
        return _resolve_path(root, configured.strip())
    return root / "ai"


def _check_ai_dir(root: Path, document: Optional[dict] = None) -> dict:
    ai_dir = _configured_ai_dir(root, document)
    if not ai_dir.is_dir():
        return _check_result(
            "ai_dir",
            "warn",
            f"{ai_dir} 不存在",
            "复制 ai-template/ 为 ai/ 并完成 AI 侧配置",
        )
    markers = [ai_dir / "AGENTS.md", ai_dir / "data" / "tasks"]
    if any(marker.exists() for marker in markers):
        return _check_result("ai_dir", "pass", f"{ai_dir} 已存在且包含 AI 结构")
    return _check_result(
        "ai_dir",
        "warn",
        f"{ai_dir} 存在但缺少 AGENTS.md 与 data/tasks",
        "复制 ai-template/ 的完整内容到 ai/",
    )


def _selected_model_tiers() -> tuple[str, ...]:
    try:
        from config.config import get_config

        tiers = tuple(
            str(tier) for tier in get_config().ONBOARDING_MODEL_TIERS if str(tier)
        )
    except Exception:
        tiers = ("required", "recommended")
    return tiers or ("required",)


def _required_download_bytes(rows: Optional[list[dict]]) -> int:
    if not rows:
        return 0
    tiers = set(_selected_model_tiers())
    pending = sum(
        int(row.get("size_bytes") or 0)
        for row in rows
        if not row.get("present") and row.get("tier") in tiers
    )
    return int(pending * 1.2)


def _disk_free_bytes(path: Path) -> int:
    """读取目标路径所在文件系统可用空间；目标未创建时回退最近的已存在祖先。"""
    try:
        return int(shutil.disk_usage(str(path)).free)
    except OSError:
        probe = path
        while not probe.exists() and probe.parent != probe:
            probe = probe.parent
        return int(shutil.disk_usage(str(probe)).free)


def _disk_targets(rows: Optional[list[dict]]) -> "list[tuple[str, Path, int]]":
    """返回 (标签, 目标, 最低可用字节)；模型下载落在模型根，运行时数据落在数据根。"""
    required_models = max(_MIN_FREE_BYTES, _required_download_bytes(rows))
    targets: "list[tuple[str, Path, int]]" = [
        ("模型根", _paths_models_root(), required_models)
    ]
    data_target = _paths_data_root()
    if data_target.resolve() != _paths_models_root().resolve():
        targets.append(("数据根", data_target, _MIN_FREE_BYTES))
    return targets


def _check_disk(
    root: Path,
    document: Optional[dict] = None,
    rows: Optional[list[dict]] = None,
) -> dict:
    targets = _disk_targets(rows)
    checked: "list[str]" = []
    failing: "tuple[str, Path, int, int] | None" = None
    for label, target, required in targets:
        try:
            free = _disk_free_bytes(target)
        except OSError as exc:
            return _check_result(
                "disk",
                "warn",
                f"无法读取磁盘信息: {exc}（目标 {target}）",
                "确认模型根/数据根可访问",
            )
        checked.append(
            f"{label} {target} 可用 {free / _GIB:.1f} GiB（要求 >= {required / _GIB:.1f} GiB）"
        )
        if free < required and failing is None:
            failing = (label, target, free, required)
    if failing is None:
        return _check_result("disk", "pass", "；".join(checked))
    label, target, free, required = failing
    return _check_result(
        "disk",
        "fail",
        f"{label} {target} 可用空间仅 {free / _GIB:.2f} GiB（要求 >= {required / _GIB:.1f} GiB）",
        f"为 {target} 清理磁盘，至少保留 {required / _GIB:.1f} GiB 可用空间",
    )


def _valid_port(value: Any) -> bool:
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and 1024 <= value <= 65535
    )


def _port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.2)
        try:
            return sock.connect_ex(("127.0.0.1", port)) == 0
        except OSError:
            return False


def _linux_listener_pid(port: int) -> Optional[int]:
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
            if parts[1].rsplit(":", 1)[-1].upper() == port_hex:
                inode = parts[9]
                break
        if inode:
            break
    if not inode:
        return None
    needle = "socket:[%s]" % inode
    try:
        entries = list(Path("/proc").iterdir())
    except OSError:
        return None
    for entry in entries:
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


def _windows_listener_pid(port: int) -> Optional[int]:
    try:
        completed = subprocess.run(
            ["netstat", "-ano"],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    suffix = ":%d" % int(port)
    for line in completed.stdout.splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        if not parts[1].endswith(suffix) or parts[3].upper() != "LISTENING":
            continue
        try:
            return int(parts[4])
        except ValueError:
            continue
    return None


def _listener_pid(port: int) -> Optional[int]:
    """尽力定位监听端口的本机 PID；无法定位返回 None。"""
    if sys.platform.startswith("linux"):
        return _linux_listener_pid(port)
    if os.name == "nt":
        return _windows_listener_pid(port)
    return None


def _port_owner(port: int) -> tuple[str, Optional[int]]:
    """返回 ``(owned|other|unknown, pid)``；owned 指当前服务进程或其父进程。"""
    pid = _listener_pid(port)
    if pid is None:
        return "unknown", None
    if pid in {os.getpid(), os.getppid()}:
        return "owned", pid
    return "other", pid


def _coerce_port(value: Any) -> Any:
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            return value
    return value


def _schema_default_port() -> Any:
    try:
        from config.config_schema import defaults_document

        server = _section(defaults_document(), "server")
        return server.get("port")
    except Exception:
        return None


def _fallback_port() -> Any:
    """配置层缺端口时的回退：优先 schema 默认值，其次 Config 访问器。"""
    port = _schema_default_port()
    if port is not None:
        return port
    try:
        from config.config import get_config

        return get_config().BACKEND_PORT
    except Exception:
        return port


def _preflight_port(document: Optional[dict], *, apply_env: bool = True) -> Any:
    """读取唯一端口；缺失时回退 schema 默认值，仅原始配置回退路径再叠 env。"""
    port: Any = _section(document, "server").get("port")
    if port is None:
        port = _fallback_port()
    if apply_env:
        env_port = os.environ.get("AXEUH_SETTINGS__SERVER__PORT")
        if env_port is not None:
            port = _coerce_port(env_port)
    return port


def _check_ports(document: Optional[dict], port: Any = None) -> dict:
    if port is None:
        port = _preflight_port(document)
    valid = _valid_port(port)
    used = _port_in_use(port) if valid else False
    detail = f"port={port!r} (in use: {str(used).lower()})"
    if not valid:
        return _check_result(
            "ports",
            "fail",
            detail + "; invalid port",
            "将 server.port 设为 1024-65535 的整数",
        )
    if not used:
        return _check_result("ports", "pass", detail)
    ownership, owner_pid = _port_owner(port)
    if ownership == "owned":
        return _check_result(
            "ports",
            "pass",
            detail + f"; 端口由当前服务监听（pid={owner_pid}，正常）",
        )
    if ownership == "unknown":
        return _check_result(
            "ports",
            "warn",
            detail + "; 端口已被占用，但无法识别占用进程",
            "确认占用端口的进程；若不是本服务，按 PID 释放端口或修改 server.port",
        )
    return _check_result(
        "ports",
        "fail",
        detail + f"; 端口被其他进程占用（pid={owner_pid}）",
        "按 PID 结束占用进程，或修改 server.port",
    )


_SSL_PLACEHOLDER_MARKERS = (
    "path/to/",
    "your",
    "<",
    ">",
    "placeholder",
    "changeme",
    "example.com",
)


def _looks_like_placeholder(value: str) -> bool:
    token = value.strip().lower()
    return any(marker in token for marker in _SSL_PLACEHOLDER_MARKERS)


def _check_ssl(
    document: Optional[dict], root: Path, *, degraded: bool = False
) -> dict:
    if not document:
        return _check_result(
            "ssl",
            "warn",
            "配置缺失，SSL 尚未配置（降级运行）",
            "在设置向导中启用 HTTPS 并填写证书/私钥，或显式关闭 SSL",
        )
    raw_section = document.get("ssl")
    if not isinstance(raw_section, dict) or not raw_section:
        return _check_result(
            "ssl",
            "warn",
            "SSL 尚未配置（降级运行）",
            "在设置向导中启用 HTTPS 并填写证书/私钥，或显式关闭 SSL",
        )
    section = raw_section
    enabled = section.get("enabled", True)
    if enabled is False or (
        isinstance(enabled, str)
        and enabled.strip().lower() in {"false", "0", "no", "off"}
    ):
        return _check_result("ssl", "pass", "SSL 未启用")
    cert = str(section.get("cert") or "").strip()
    key = str(section.get("key") or "").strip()
    if not cert or not key:
        if degraded:
            return _check_result(
                "ssl",
                "warn",
                "SSL 已启用，但配置存储降级且未同时配置 ssl.cert 与 ssl.key",
                "在设置向导中填写证书/私钥路径，或先设置 ssl.enabled: false",
            )
        return _check_result(
            "ssl",
            "fail",
            "SSL 已启用，但未同时配置 ssl.cert 与 ssl.key",
            "在设置向导中填写证书/私钥路径，或先设置 ssl.enabled: false",
        )

    warnings: list[str] = []
    failures: list[str] = []
    resolved_paths: list[Path] = []
    for label, value in (("ssl.cert", cert), ("ssl.key", key)):
        resolved = _resolve_path(root, value)
        resolved_paths.append(resolved)
        if not resolved.exists():
            if _looks_like_placeholder(value):
                warnings.append(f"{label} 仍是占位值: {value}")
            else:
                failures.append(f"{label} 指向的文件不存在: {resolved}")
        elif not resolved.is_file():
            failures.append(f"{label} 不是文件: {resolved}")
        elif resolved.stat().st_size == 0:
            failures.append(f"{label} 文件为空: {resolved}")
        elif not os.access(resolved, os.R_OK):
            failures.append(f"{label} 文件不可读: {resolved}")
    if len(resolved_paths) == 2 and resolved_paths[0] == resolved_paths[1]:
        failures.append("ssl.cert 与 ssl.key 指向同一个文件")

    if failures:
        return _check_result(
            "ssl",
            "fail",
            "证书/私钥配置无效: " + ", ".join(failures),
            "确认 ssl.cert / ssl.key 分别指向可读且非空的证书与私钥文件",
        )
    if warnings:
        return _check_result(
            "ssl",
            "warn",
            "SSL 已启用，但证书/私钥尚未就绪: " + ", ".join(warnings),
            "填写真实证书/私钥路径，或在设置向导中生成自签证书后重试",
        )
    return _check_result("ssl", "pass", "SSL 已启用且证书/私钥文件存在")


def _run_coroutine_sync(factory: Any) -> Any:
    """在同步预检里执行协程；有运行中事件循环时退回独立线程。"""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(factory())

    values: list[Any] = []
    errors: list[BaseException] = []

    def runner() -> None:
        try:
            values.append(asyncio.run(factory()))
        except BaseException as exc:  # noqa: BLE001 - 原样转交调用线程
            errors.append(exc)

    thread = threading.Thread(
        target=runner, name="onboarding-preflight-probe", daemon=True
    )
    thread.start()
    thread.join(timeout=30)
    if thread.is_alive():
        raise TimeoutError("onboarding preflight probe timed out")
    if errors:
        raise errors[0]
    return values[0] if values else None


def _inspect_loom_for_preflight() -> dict:
    from services import loom_onboarding

    return _run_coroutine_sync(
        lambda: loom_onboarding.inspect(timeout=_LOOM_PREFLIGHT_TIMEOUT_S)
    )


def _kernel_models_rows(root: Path) -> list[dict]:
    from services import kernel_model_manifest

    manifest = kernel_model_manifest.load_manifest()
    return manifest.status_for(
        project_root=root,
        kernel_root=root / "kernel",
        home=_paths_models_root(),
    )


def _step_snapshot(step_id: str) -> tuple[bool, dict]:
    """只读步骤状态：不修复损坏文件，不写任何状态。"""
    with _STATE_LOCK:
        state = _read_state(repair_corrupt=False)
    skipped = step_id in set(state.get("skipped_steps") or ())
    data = (state.get("step_data") or {}).get(step_id)
    return skipped, data if isinstance(data, dict) else {}


def _check_kernel(root: Path, document: Optional[dict] = None) -> dict:
    """内核巡检：只读 pidfile/解释器，绝不 spawn。"""
    info = kernel_assets.inspect(root)
    kernel = info.get("kernel") or {}
    python = info.get("python") or {}
    issues: list[str] = []
    if not kernel.get("present"):
        issues.append("kernel/ 目录不存在")
    elif kernel.get("source") not in {"source", "release"}:
        issues.append("kernel/ 存在但缺少可识别的内核程序")
    if not python.get("exists"):
        issues.append("未找到可用的内核解释器")
    elif python.get("last_resort"):
        issues.append("将回退后端解释器，建议配置专用内核 venv")
    parts = [
        f"kernel={kernel.get('source') or 'none'}",
        f"version={kernel.get('version') or 'unknown'}",
        f"python_source={python.get('source') or 'none'}",
    ]
    device = _section(document, "kernel").get("device")
    if isinstance(device, str) and device:
        parts.append(f"device={device}")
    detail = "；".join(parts)
    if issues:
        return _check_result(
            "kernel",
            "warn",
            detail + "；" + "；".join(issues),
            "运行内核步骤安装发行包，并设置 AXEUH_KERNEL_PYTHON 指向内核 venv",
        )
    return _check_result("kernel", "pass", detail)


def _check_kernel_models(rows: Optional[list[dict]], error: Optional[str]) -> dict:
    if error:
        return _check_result(
            "kernel_models",
            "warn",
            f"模型清单不可用: {error}",
            "恢复 backend/resources/kernel-models.json 或重新安装后端",
        )
    if not rows:
        return _check_result(
            "kernel_models",
            "warn",
            "模型清单为空，无法校验模型",
            "恢复 backend/resources/kernel-models.json",
        )
    required = [row for row in rows if row.get("tier") == "required"]
    missing_required = [row["id"] for row in required if not row.get("present")]
    if missing_required:
        return _check_result(
            "kernel_models",
            "fail",
            "必需模型缺失: " + ", ".join(sorted(missing_required)),
            "在引导的内核模型步骤下载必需模型，或复用已有模型目录",
        )
    missing_other = sorted(
        row["id"]
        for row in rows
        if row.get("tier") != "required" and not row.get("present")
    )
    if missing_other:
        return _check_result(
            "kernel_models",
            "pass",
            f"必需模型齐全（{len(required)} 个）；未下载的可选模型: "
            + ", ".join(missing_other),
        )
    return _check_result(
        "kernel_models", "pass", f"模型清单校验通过（{len(rows)} 个模型齐全）"
    )


def _backend_name(document: Optional[dict]) -> str:
    return str((document or {}).get("ai_backend") or "opencode").strip().lower()


def _check_loom(document: Optional[dict]) -> dict:
    backend = _backend_name(document)
    skipped, data = _step_snapshot("loom")
    choice = str(data.get("choice") or "").strip().lower()
    if skipped or choice == "skipped":
        if backend == "loom":
            return _check_result(
                "loom",
                "warn",
                "Loom 步骤已跳过（AI 助手不可用）",
                "重新进入 Loom 步骤完成 token 与渠道配置",
            )
        return _check_result("loom", "pass", "Loom 已跳过（当前 AI 后端 opencode）")

    try:
        info = _inspect_loom_for_preflight()
    except Exception as exc:  # noqa: BLE001 - 预检降级为软警告
        return _check_result(
            "loom",
            "warn",
            f"Loom 巡检失败: {type(exc).__name__}",
            "确认 Loom 服务可访问，或跳过 Loom 步骤",
        )
    source = info.get("source") or info.get("token_source") or "missing"
    fingerprint_value = info.get("fingerprint") or ""
    token_detail = f"token_source={source}"
    if fingerprint_value:
        token_detail += f"；fingerprint={fingerprint_value}"
    if not info.get("found"):
        if backend == "loom":
            return _check_result(
                "loom",
                "warn",
                f"未发现 Loom token；{token_detail}",
                "在 Loom 步骤自动发现或填写 token",
            )
        return _check_result(
            "loom", "pass", f"Loom 未配置（当前 AI 后端 opencode）；{token_detail}"
        )
    if info.get("online"):
        return _check_result("loom", "pass", f"Loom 在线；{token_detail}")
    if info.get("reachable"):
        return _check_result(
            "loom",
            "warn",
            f"Loom 可达但状态非 ok；{token_detail}",
            "检查 Loom 服务日志后重试",
        )
    errors = info.get("errors") or []
    codes = sorted(
        {
            str(item.get("code"))
            for item in errors
            if isinstance(item, dict) and item.get("code")
        }
    )
    suffix = f"；errors={','.join(codes)}" if codes else ""
    return _check_result(
        "loom",
        "warn",
        f"Loom 不可达；{token_detail}{suffix}",
        "启动 Loom 服务或核对 loom.url 后重试，或跳过 Loom 步骤",
    )


def _check_ai_backend(document: Optional[dict]) -> dict:
    if not document:
        return _check_result(
            "ai_backend",
            "warn",
            "配置缺失，AI 后端尚未配置（降级运行）",
            "在设置向导中选择 opencode 或 loom 并补齐连接参数",
        )
    backend = _backend_name(document)
    if backend == "loom":
        section = _section(document, "loom")
        url = str(section.get("url") or "").strip()
        token = (
            str(section.get("token") or "").strip()
            or os.environ.get("LOOM_TOKEN", "").strip()
            or str(section.get("token_file") or "").strip()
            or str(section.get("credentials_file") or "").strip()
        )
        if not url:
            return _check_result(
                "ai_backend",
                "warn",
                "ai_backend=loom 但未配置 loom.url（降级运行）",
                "在设置向导中设置 loom.url（如 http://127.0.0.1:5100）",
            )
        if not token:
            return _check_result(
                "ai_backend",
                "warn",
                "ai_backend=loom 但未配置 loom token（降级运行）",
                "配置 loom.token、loom.token_file、loom.credentials_file 或环境变量 LOOM_TOKEN",
            )
        return _check_result(
            "ai_backend", "pass", "AI 后端 loom：URL 与 token 已配置"
        )
    if backend == "opencode":
        section = _section(document, "opencode")
        missing = _opencode_missing_keys(document)
        names = [f"opencode.{key}" for key in missing]
        if not str(section.get("url") or "").strip():
            names.append("opencode.url")
        if names:
            return _check_result(
                "ai_backend",
                "warn",
                "AI 后端 opencode 缺少必填项（降级运行）: " + ", ".join(names),
                "配置 opencode.default_agent / default_model / default_provider / url",
            )
        return _check_result(
            "ai_backend",
            "pass",
            "AI 后端 opencode：必填项已配置（生产推荐 Loom）",
        )
    return _check_result(
        "ai_backend",
        "fail",
        f"未知的 ai_backend 值: {backend}",
        "ai_backend 仅支持 opencode 或 loom",
    )


def run_preflight(project_root: Optional[Path] = None) -> dict:
    """执行 11 项稳定 id 的只读预检。

    硬阻断项（python/config/frontend_dist/disk/ports/ssl）出现 fail 时
    ``can_proceed`` 为 False；软检查（ai_dir/kernel/kernel_models/
    loom/ai_backend）的 fail/warn 进入 ``soft_failures``，由调用方显式
    确认降级后方可继续。内核检查只调用 ``kernel_assets.inspect``，不 spawn；
    MOSS 是外部旁路，不参与预检。
    """
    root = (
        Path(project_root).expanduser()
        if project_root is not None
        else default_project_root()
    )
    root = root.resolve()
    live = _load_live_config()
    raw: Optional[dict] = None
    config_path: Optional[Path] = None
    config_error: Optional[str] = None
    if live is not None:
        document = live.document
        apply_env = False
    else:
        raw, config_path, config_error = _load_raw_config(root)
        document = raw
        apply_env = True

    rows: Optional[list[dict]] = None
    models_error: Optional[str] = None
    try:
        rows = _kernel_models_rows(root)
    except Exception as exc:  # noqa: BLE001 - 清单缺失降级为软警告
        models_error = str(getattr(exc, "code", type(exc).__name__))

    port = _preflight_port(document, apply_env=apply_env)
    checks = [
        _check_python(),
        _check_config(live, raw, config_path, config_error),
        _check_frontend_dist(root),
        _check_ai_dir(root, document),
        _check_disk(root, document, rows),
        _check_ports(document, port),
        _check_ssl(
            document,
            root,
            degraded=bool(live.degraded) if live is not None else bool(config_error),
        ),
        _check_kernel(root, document),
        _check_kernel_models(rows, models_error),
        _check_loom(document),
        _check_ai_backend(document),
    ]
    blocking_failures = [
        check["id"]
        for check in checks
        if check["blocking"] and check["status"] == "fail"
    ]
    soft_failures = [
        check["id"]
        for check in checks
        if not check["blocking"] and check["status"] in _PREFLIGHT_SOFT_STATUSES
    ]
    summary = {
        "pass": sum(1 for check in checks if check["status"] == "pass"),
        "warn": sum(1 for check in checks if check["status"] == "warn"),
        "fail": sum(1 for check in checks if check["status"] == "fail"),
    }
    return {
        "checks": checks,
        "can_proceed": not blocking_failures,
        "blocking_failures": blocking_failures,
        "soft_failures": soft_failures,
        "summary": summary,
    }
