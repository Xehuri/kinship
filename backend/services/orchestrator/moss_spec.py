# -*- coding: utf-8 -*-
"""MOSS 深度音频 watcher 的编排器声明（任务 14）。

watcher 不是 vLLM 推理服务：它只是 ``tools/moss-shadow/watcher.py --loop``
的文件订阅进程，serve 不可达时由自己冷却重试。本 spec 因此只做三件事：

- ``gate``：``moss.enabled`` 为真且解释器可执行；``python`` 缺失时给出
  ``gate_failed: python_missing``，不探活 vLLM；
- ``start``：经 ``child_entry`` 包一层父死亡保护后 spawn watcher，cwd 固定
  仓库根，绝不启动/停止 ``axeuh-moss.service``；
- ``stop``：按精确 PID SIGTERM -> ``TimeoutStopSec`` 30 秒 -> SIGKILL。

注册由 ``main.py`` 在 ``orchestrator.start_all()`` 之前显式调用；runtime 不
import 本模块，避免启动链耦合。

解释器解析顺序（``moss.python`` 为空时）：``/opt/kinship/.venv-moss/bin/python``
-> ``<repo>/.venv-moss/bin/python``（Windows 为
``<repo>\\.venv-moss\\Scripts\\python.exe``）。
"""
from __future__ import annotations

import asyncio
import logging
import os
import signal
import time
from pathlib import Path
from typing import Any, Mapping

from config.config import Config, get_config
from config.paths import backend_dir, project_root

from .spec import REGISTRY, ServiceSpec, register

logger = logging.getLogger(__name__)

# watcher 的 SIGTERM 语义是"处理完当前件再退出"，因此宽限 30 秒。
STOP_TIMEOUT_S = 30.0
KILL_GRACE_S = 2.0
POLL_INTERVAL_S = 0.1

DEFAULT_MOSS_PYTHON = "/opt/kinship/.venv-moss/bin/python"
CHILD_ENTRY_MODULE = "services.orchestrator.child_entry"
WATCHER_RELPATH = Path("tools") / "moss-shadow" / "watcher.py"

_MOSS_SPEC: ServiceSpec | None = None

# 与 asyncio 绑定一次，测试可替换本模块属性捕获 argv 而不真的 spawn。
_create_subprocess_exec = asyncio.create_subprocess_exec


class _WatcherState:
    """当前 spec 持有的 watcher 进程；runtime 通过返回的 pid/handle 观察退出。"""

    def __init__(self) -> None:
        self.pid: int | None = None
        self.process: Any = None
        self.python: str = ""


_STATE = _WatcherState()


def _reset_state() -> None:
    _STATE.pid = None
    _STATE.process = None
    _STATE.python = ""


def venv_python(root: Path, *, is_windows: bool) -> Path:
    """返回项目内 MOSS venv 的解释器候选路径（仅拼路径，不探测）。"""
    if is_windows:
        return root / ".venv-moss" / "Scripts" / "python.exe"
    return root / ".venv-moss" / "bin" / "python"


def python_candidates(
    root: Path, *, is_windows: bool
) -> tuple[str, str]:
    """``moss.python`` 为空时的探测顺序：生产 venv 优先，其次项目内 venv。"""
    return (DEFAULT_MOSS_PYTHON, str(venv_python(root, is_windows=is_windows)))


def _is_executable(path: str) -> bool:
    """存在且可执行；POSIX 额外要求 X_OK，Windows 只看文件存在。"""
    try:
        candidate = Path(path)
        if not candidate.is_file():
            return False
        if os.name == "nt":
            return True
        return os.access(path, os.X_OK)
    except OSError:
        return False


def resolve_moss_python(
    cfg: Config,
    *,
    root: Path | None = None,
    is_windows: bool | None = None,
) -> str:
    """解析 watcher 解释器：显式配置优先，否则按固定顺序探测；全无返回 ""。"""
    configured = cfg.MOSS_PYTHON
    if configured:
        return configured
    base = project_root() if root is None else root
    windows = os.name == "nt" if is_windows is None else is_windows
    for candidate in python_candidates(base, is_windows=windows):
        if _is_executable(candidate):
            return candidate
    return ""


def _gate(cfg: Config) -> tuple[bool, str]:
    """``requires`` 通过后的闸门：只校验解释器存在，不碰 vLLM。"""
    python = resolve_moss_python(cfg)
    if not python or not _is_executable(python):
        return False, "gate_failed: python_missing"
    return True, ""


def build_start_command(python: str, watcher_path: Path | str) -> list[str]:
    """构造 spawn argv；``child_entry`` 只做父死亡保护，不重定向 stdio。"""
    return [
        python,
        "-m",
        CHILD_ENTRY_MODULE,
        "--target",
        python,
        str(watcher_path),
        "--loop",
    ]


def build_start_env(env: Mapping[str, str] | None = None) -> dict[str, str]:
    """复制环境并确保 ``services`` 包可被 ``-m child_entry`` 导入。

    cwd 是仓库根而非 ``backend/``，所以 ``-m`` 的 sys.path 不含 backend；
    这里把 backend 前置到 PYTHONPATH，既有值保持不变。watcher 自身仍从
    脚本所在目录解析兄弟模块，不依赖 PYTHONPATH。
    """
    merged = dict(os.environ if env is None else env)
    backend = str(backend_dir())
    existing = merged.get("PYTHONPATH", "")
    parts = [backend]
    if existing:
        parts.extend(
            item for item in existing.split(os.pathsep)
            if item and item != backend
        )
    merged["PYTHONPATH"] = os.pathsep.join(parts)
    return merged


def _pid_alive(pid: int) -> bool:
    """按精确 PID 判活；复用 runtime 的僵尸/Windows 语义，避免第二套判定。"""
    from .runtime import _pid_alive as runtime_pid_alive

    return runtime_pid_alive(pid)


def _signal_pid(pid: int, signal_name: str) -> None:
    """按精确 PID 发信号；Windows 没有 POSIX 信号，走 TerminateProcess。"""
    if os.name == "nt":
        from .runtime import _win_terminate

        _win_terminate(pid)
        return
    sig = getattr(signal, signal_name, None)
    if sig is None:
        return
    try:
        os.kill(pid, sig)
    except ProcessLookupError:
        return
    except PermissionError:
        # 归属证明失败时宁可记录日志，也不按名称杀进程。
        logger.error("[MOSS] 无权限向 pid=%s 发送 %s", pid, signal_name)
    except OSError:
        return


async def _wait_pid_gone(pid: int, timeout: float) -> bool:
    """轮询精确 PID 是否消失；超时返回 False 由调用方升级信号。"""
    deadline = time.monotonic() + max(0.0, timeout)
    while _pid_alive(pid):
        if time.monotonic() >= deadline:
            return False
        await asyncio.sleep(POLL_INTERVAL_S)
    return True


async def _terminate_after_cancel(pid: int) -> None:
    """取消路径按精确 PID 回收子进程：SIGTERM -> 短宽限 -> SIGKILL。"""
    try:
        _signal_pid(pid, "SIGTERM")
        if await asyncio.shield(_wait_pid_gone(pid, KILL_GRACE_S)):
            return
        _signal_pid(pid, "SIGKILL")
        await asyncio.shield(_wait_pid_gone(pid, KILL_GRACE_S))
    except asyncio.CancelledError:
        logger.warning("[MOSS] 取消清理期间再次被取消，pid=%s", pid)
    except Exception as exc:
        logger.error("[MOSS] 取消后终止 pid=%s 失败: %s", pid, exc)
    finally:
        if _STATE.pid == pid:
            _reset_state()


async def _spawn_watcher(
    argv: list[str], *, cwd: str, env: Mapping[str, str]
) -> Any:
    """取消安全的 spawn：取消发生在子进程落地前时，等它落地后按 PID 终止。

    ``_create_subprocess_exec`` 自身在取消时会回收 transport，但不同事件循环
    实现并不保证；这里用 shield + 二次等待把"已创建但 pid 未返回"的窗口
    收敛为确定性清理，然后重新抛出 CancelledError。
    """
    spawn = asyncio.ensure_future(
        _create_subprocess_exec(*argv, cwd=cwd, env=env)
    )
    try:
        return await asyncio.shield(spawn)
    except asyncio.CancelledError:
        process = None
        try:
            process = await asyncio.shield(spawn)
        except asyncio.CancelledError:
            pass
        except Exception:
            pass
        if process is not None:
            await _terminate_after_cancel(int(process.pid))
        raise


async def _start_moss_watcher() -> dict[str, Any]:
    """spawn watcher；返回 pid/process 供 runtime 观察退出。"""
    cfg = get_config()
    ok, reason = _gate(cfg)
    if not ok:
        return {"ok": False, "detail": reason}
    python = resolve_moss_python(cfg)
    root = project_root()
    watcher_path = root / WATCHER_RELPATH
    argv = build_start_command(python, watcher_path)
    env = build_start_env()
    try:
        process = await _spawn_watcher(argv, cwd=str(root), env=env)
    except OSError as exc:
        return {"ok": False, "detail": "spawn failed: %s" % exc}
    pid = int(process.pid)
    _STATE.pid = pid
    _STATE.process = process
    _STATE.python = python
    return {
        "pid": pid,
        "process": process,
        "python": python,
        "argv": argv,
    }


async def _stop_moss_watcher() -> dict[str, Any]:
    """SIGTERM -> 30 秒 -> SIGKILL；全程按精确 PID，绝不按名称杀。"""
    pid = _STATE.pid
    process = _STATE.process
    if pid is None and process is not None:
        candidate = getattr(process, "pid", None)
        if isinstance(candidate, int) and candidate > 0:
            pid = candidate
    if not isinstance(pid, int) or pid <= 0:
        _reset_state()
        return {"stopped": False, "pid": None, "signal": None}
    if not _pid_alive(pid):
        _reset_state()
        return {
            "stopped": False,
            "pid": pid,
            "signal": None,
            "reason": "already_exited",
        }
    _signal_pid(pid, "SIGTERM")
    if await _wait_pid_gone(pid, STOP_TIMEOUT_S):
        signal_name = "SIGTERM"
    else:
        _signal_pid(pid, "SIGKILL")
        await _wait_pid_gone(pid, KILL_GRACE_S)
        signal_name = "SIGKILL"
    _reset_state()
    return {"stopped": True, "pid": pid, "signal": signal_name}


def build_moss_spec() -> ServiceSpec:
    """返回 watcher spec 的进程级单例（start/stop 闭包保持对象等价）。"""
    global _MOSS_SPEC
    if _MOSS_SPEC is None:
        _MOSS_SPEC = ServiceSpec(
            id="moss_watcher",
            requires=("moss.enabled",),
            gate=_gate,
            start=_start_moss_watcher,
            stop=_stop_moss_watcher,
            critical=False,
            restart=True,
        )
    return _MOSS_SPEC


def register_moss_spec() -> ServiceSpec:
    """幂等注册 watcher spec；同 id 但声明不同则抛 ValueError。"""
    spec = build_moss_spec()
    existing = REGISTRY.get(spec.id)
    if existing is None:
        register(spec)
        return spec
    if existing == spec:
        REGISTRY[spec.id] = spec
        return spec
    raise ValueError("conflicting service spec for id: moss_watcher")


__all__ = [
    "build_moss_spec",
    "build_start_command",
    "build_start_env",
    "python_candidates",
    "register_moss_spec",
    "resolve_moss_python",
    "venv_python",
]
