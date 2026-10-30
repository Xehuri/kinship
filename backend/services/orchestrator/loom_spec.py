# -*- coding: utf-8 -*-
"""Loom 的编排器声明（任务 15）。

Loom 从 systemd 单元改为后端子进程：``start`` 复用 ``loom_runtime`` 的
child 模式前置（node/dist、配置、token、健康检查），但 spawn 必须经过
``child_entry`` 以获得父死亡保护，且 cwd 固定 ``loom-harness``、日志固定
``backend/data/logs/loom-child.log``。``stop`` 按精确 PID 先发 SIGTERM，
等待 Loom 自身的 5 秒排水窗口后再 SIGKILL。

``requires=("loom.url", "ai_backend")`` 只做声明式判定，``gate`` 额外要求
``ai_backend`` 归一后等于 ``"loom"``：缺省 ``opencode`` 的部署（含全新安装）
必须保持 blocked/disabled，不得尝试 spawn 未构建的 Loom。node/dist 缺失、
配置缺失、token 缺失与端口占用都在 ``start`` 内转成可读的失败详情。
"""
from __future__ import annotations

import asyncio
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any, Mapping

from config.config import Config, get_config
from config.paths import backend_dir, project_root

from .spec import REGISTRY, ServiceSpec, register

logger = logging.getLogger(__name__)

SPEC_ID = "loom"
CHILD_ENTRY_MODULE = "services.orchestrator.child_entry"
DRAIN_TIMEOUT_S = 5.0
KILL_GRACE_S = 2.0
POLL_INTERVAL_S = 0.1
HEALTH_TIMEOUT_S = 45.0

_LOOM_SPEC: ServiceSpec | None = None

_create_subprocess_exec = asyncio.create_subprocess_exec


class _LoomState:
    def __init__(self) -> None:
        self.pid: int | None = None
        self.process: Any = None


_STATE = _LoomState()


def _reset_state() -> None:
    _STATE.pid = None
    _STATE.process = None


def loom_harness_dir() -> Path:
    return project_root() / "loom-harness"


def child_log_path() -> Path:
    return backend_dir() / "data" / "logs" / "loom-child.log"


def loom_instance_root(config: Config) -> Path:
    return Path(config.AI_ROOT).resolve()


def build_start_command(
    node: str,
    cli: Path | str,
    *,
    port: int,
    host: str,
    config_path: Path | str,
    python: str | None = None,
) -> list[str]:
    target = [
        str(node),
        str(cli),
        "serve",
        "--port",
        str(port),
        "--hostname",
        str(host),
        "--config",
        str(config_path),
    ]
    return [
        python or sys.executable,
        "-m",
        CHILD_ENTRY_MODULE,
        "--target",
        *target,
    ]


def build_start_env(
    config: Config,
    token: str,
    *,
    env: Mapping[str, str] | None = None,
    config_path: Path | str | None = None,
) -> dict[str, str]:
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

    instance = loom_instance_root(config)
    managed = Path(config_path) if config_path is not None else (
        instance / ".loom" / "config.yaml"
    )
    merged.update(
        {
            "LOOM_TOKEN": token,
            "LOOM_INSTANCE": str(instance),
            "LOOM_CONFIG": str(managed),
            "LOOM_STATE": str(instance / ".loom"),
        }
    )
    return merged


async def _pid_gone(pid: int) -> bool:
    from services import loom_runtime as rt

    identity = await asyncio.to_thread(rt._read_process_identity, pid)
    return identity is None or not identity.alive


async def _write_pid_record(
    pid: int, target_argv: list[str], config_path: Path
) -> None:
    from services import loom_runtime as rt

    identity = await asyncio.to_thread(rt._read_process_identity, pid)
    record = {
        "version": 1,
        "pid": pid,
        "start_time": (
            identity.start_time
            if identity is not None and identity.start_time is not None
            else time.time()
        ),
        "started_at": rt._utc_now_iso(),
        "command_hash": rt._hash_argv(target_argv),
        "config_hash": rt._hash_file(config_path),
        "exe_hash": (
            rt._hash_text(identity.exe)
            if identity is not None and identity.exe
            else ""
        ),
        "mode": rt.MODE_CHILD,
    }
    try:
        await asyncio.to_thread(rt._write_pid_record, record)
    except OSError as exc:
        logger.warning("[Loom] pidfile 写入失败 pid=%s: %s", pid, exc)


async def _clear_own_pidfile(pid: int) -> None:
    from services import loom_runtime as rt

    record = await asyncio.to_thread(rt._read_pid_record)
    if record is None or int(record.get("pid") or 0) != pid:
        return
    await asyncio.to_thread(rt._remove_pidfile)


async def _wait_gone(pid: int, timeout: float) -> bool:
    deadline = asyncio.get_running_loop().time() + max(0.0, timeout)
    while True:
        if await _pid_gone(pid):
            return True
        remaining = deadline - asyncio.get_running_loop().time()
        if remaining <= 0:
            return False
        await asyncio.sleep(min(POLL_INTERVAL_S, remaining))


async def _terminate_spawned(pid: int) -> str | None:
    from services import loom_runtime as rt

    await asyncio.to_thread(rt._terminate_pid, pid, graceful=True)
    if await _wait_gone(pid, DRAIN_TIMEOUT_S):
        return "SIGTERM"
    await asyncio.to_thread(rt._terminate_pid, pid, graceful=False)
    await _wait_gone(pid, KILL_GRACE_S)
    return "SIGKILL"


async def _terminate_spawned_after_cancel(pid: int) -> None:
    """取消后按精确 PID 回收已 spawn 但尚未返回给运行时的子进程。

    健康等待期间被取消时 runtime 还没拿到 pid，若只 re-raise 会留下孤儿；
    用 ``shield`` 保护终止协程，二次取消也不会中断正在进行的 SIGTERM/SIGKILL。
    """
    try:
        await asyncio.shield(_terminate_spawned(pid))
    except asyncio.CancelledError:
        logger.warning("[Loom] 取消清理期间再次被取消，pid=%s 终止转后台", pid)
    except Exception as exc:
        logger.error("[Loom] 取消后终止 pid=%s 失败: %s", pid, exc)
    try:
        await asyncio.shield(_clear_own_pidfile(pid))
    except asyncio.CancelledError:
        logger.warning("[Loom] 清理 pidfile 期间再次被取消，pid=%s", pid)
    except Exception as exc:
        logger.warning("[Loom] 取消后清理 pidfile 失败 pid=%s: %s", pid, exc)


async def _start_loom() -> dict[str, Any]:
    from services import loom_runtime as rt

    config = get_config()
    node = rt._which("node")
    argv_prefix, port, host, error_code = rt._child_spawn_errors(config)
    if error_code or argv_prefix is None or port is None:
        return {"ok": False, "detail": error_code or "runtime_unavailable"}
    if not node:
        return {"ok": False, "detail": "node_missing"}

    config_path = rt._config_path(config)
    if not config_path.is_file():
        return {
            "ok": False,
            "detail": "config_missing: %s" % config_path,
        }
    if rt._port_in_use(port, host):
        owner = await asyncio.to_thread(rt._port_owner_pid, port, host)
        return {
            "ok": False,
            "detail": "port_in_use: %s:%s (pid=%s)"
            % (host, port, owner if owner else "unknown"),
        }

    token_state = rt._ensure_token_internal(config)
    if not token_state.token:
        return {"ok": False, "detail": "token_missing"}

    cli = rt._cli_path()
    argv = build_start_command(
        node,
        cli,
        port=port,
        host=host,
        config_path=config_path,
    )
    env = build_start_env(config, token_state.token, config_path=config_path)
    log_path = child_log_path()
    log_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with open(log_path, "ab", buffering=0) as log_handle:
            process = await _create_subprocess_exec(
                *argv,
                cwd=str(loom_harness_dir()),
                env=env,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=log_handle,
                stderr=asyncio.subprocess.STDOUT,
                **rt._spawn_options(os.name == "nt"),
            )
    except OSError as exc:
        return {"ok": False, "detail": "spawn_failed: %s" % exc}

    pid = int(process.pid)
    _STATE.pid = pid
    _STATE.process = process

    try:
        try:
            health = await rt._wait_health(
                config, token_state.token, timeout=HEALTH_TIMEOUT_S
            )
        except Exception as exc:
            await _terminate_spawned(pid)
            _reset_state()
            return {"ok": False, "detail": "health_check_failed: %s" % exc}

        if not health.get("ok"):
            await _terminate_spawned(pid)
            _reset_state()
            return {
                "ok": False,
                "detail": "health_failed: %s"
                % (health.get("error") or "Loom 未通过 /health"),
            }

        target_argv = argv[argv.index("--target") + 1:]
        await _write_pid_record(pid, target_argv, config_path)

        return {
            "pid": pid,
            "process": process,
            "port": port,
            "argv": argv,
            "log_path": str(log_path),
            "health": health,
        }
    except asyncio.CancelledError:
        await _terminate_spawned_after_cancel(pid)
        _reset_state()
        raise


async def _stop_loom() -> dict[str, Any]:
    from services import loom_runtime as rt

    pid = _STATE.pid
    process = _STATE.process
    if pid is None and process is not None:
        candidate = getattr(process, "pid", None)
        if isinstance(candidate, int) and candidate > 0:
            pid = candidate
    if not isinstance(pid, int) or pid <= 0:
        _reset_state()
        return {"stopped": False, "pid": None, "signal": None}
    if await _pid_gone(pid):
        await _clear_own_pidfile(pid)
        _reset_state()
        return {
            "stopped": False,
            "pid": pid,
            "signal": None,
            "reason": "already_exited",
        }

    signal_name = await _terminate_spawned(pid)
    await _clear_own_pidfile(pid)
    _reset_state()
    return {"stopped": True, "pid": pid, "signal": signal_name}


def _gate(config: Config) -> tuple[bool, str]:
    """仅当配置的 AI 后端是 Loom 时放行。

    纯配置读取：只访问 ``Config.AI_BACKEND`` 的内存快照，不探测文件、端口
    或健康状态。缺省 ``ai_backend=opencode`` 的部署必须停在 blocked/disabled，
    否则编排器会反复 spawn 没有 ``loom-harness`` 构建产物的 Loom。

    大小写与首尾空白由 ``Config.AI_BACKEND`` 归一（``str.strip().lower()``）。
    """
    if str(config.AI_BACKEND or "").strip().lower() == "loom":
        return True, ""
    return False, "disabled"


def build_loom_spec() -> ServiceSpec:
    global _LOOM_SPEC
    if _LOOM_SPEC is None:
        _LOOM_SPEC = ServiceSpec(
            id=SPEC_ID,
            requires=("loom.url", "ai_backend"),
            gate=_gate,
            start=_start_loom,
            stop=_stop_loom,
            critical=False,
            restart=True,
        )
    return _LOOM_SPEC


def register_loom_spec() -> ServiceSpec:
    spec = build_loom_spec()
    existing = REGISTRY.get(spec.id)
    if existing is None:
        register(spec)
        return spec
    if existing == spec:
        REGISTRY[spec.id] = spec
        return spec
    raise ValueError("conflicting service spec for id: loom")


__all__ = [
    "build_loom_spec",
    "build_start_command",
    "build_start_env",
    "child_log_path",
    "loom_harness_dir",
    "loom_instance_root",
    "register_loom_spec",
]
