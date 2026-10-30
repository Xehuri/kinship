# -*- coding: utf-8 -*-
"""进程编排器运行时（任务 8）：状态机、有界重启、运维闸门与全局开关。

状态与语义
----------

``blocked``
    声明式判定不满足（缺配置 / 被 ``enable_key`` 关闭 / gate 失败 / 运维
    ``pause``）。**永不自动重试**，只能由配置变更触发的 ``start_all()`` 或
    显式 ``resume()`` / ``retry()`` 重新判定。
``starting``
    已取得 ``_starting`` 占位并调用 ``spec.start``，或仍在 ``SPAWN_GRACE_S``
    观察窗内。
``ready``
    子进程存活超过 ``SPAWN_GRACE_S``（默认 10 秒），进入受管状态。
``stopping``
    主动停止进行中；此期间的退出**不计入崩溃**。
``failed``
    启动失败（``spawn_failed``，不重试）或崩溃（``crashed``，按窗口重试；
    超限后 ``restart_exhausted``，直到 ``start_all()`` / ``retry()``）。
``stopped``
    从未启动或已被主动停止。

启动动作契约
------------

``ServiceSpec.start`` 必须返回 dict，至少含 ``pid``（int）与可选 ``process``
句柄（``asyncio.subprocess.Process`` 或 ``subprocess.Popen``）。运行时用该
句柄做 ``proc.wait()`` 退出观察；没有句柄时退化为按 PID 轮询（POSIX 用
``waitpid(WNOHANG)`` + ``kill(pid, 0)``，Windows 用 ``OpenProcess``）。返回
``{"ok": False}`` 或抛异常一律视为启动失败（``spawn_failed``，不重试）。

线程约束（沿用 ``child_entry`` 契约）
-------------------------------------

``PR_SET_PDEATHSIG`` 跟随**创建子进程的父线程**。``spec.start`` 一律在事件
循环线程内被 await（不使用 ``asyncio.to_thread`` 包装 spawn），运行时自身
也只做协程与按 PID 信号，不引入工作线程。

停止语义
--------

``stop()`` 先调 ``spec.stop()``（受限超时），随后按**精确 PID** 兜底：
SIGTERM -> 宽限 -> SIGKILL；``stop_all()`` 按注册逆序逐个停止，总预算
``STOP_ALL_BUDGET_S``（15 秒），超预算后对残留 PID 直接 SIGKILL。全程禁止
按名称杀进程。
"""
from __future__ import annotations

import asyncio
import inspect
import logging
import os
import signal
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Awaitable, Callable, Mapping, Sequence

from .spec import ServiceSpec, all_specs, requirements_satisfied

logger = logging.getLogger(__name__)

ORCHESTRATOR_ENV = "AXEUH_ORCHESTRATOR"

MAX_RESTARTS = 5
WINDOW_S = 300.0
BACKOFF_S: tuple[float, ...] = (1.0, 2.0, 4.0, 8.0, 16.0)
SPAWN_GRACE_S = 10.0
STOP_ALL_BUDGET_S = 15.0
STOP_TIMEOUT_S = 15.0
KILL_GRACE_S = 2.0
POLL_INTERVAL_S = 0.2
PLACEHOLDER_WAIT_S = 5.0
FALLBACK_TERM_GRACE_S = 1.0

_MODE_ON = "on"
_MODE_OFF = "off"
_MODE_OFF_VALUES = frozenset({"off", "0", "false", "no"})

_STATE_BLOCKED = "blocked"
_STATE_STARTING = "starting"
_STATE_READY = "ready"
_STATE_STOPPING = "stopping"
_STATE_FAILED = "failed"
_STATE_STOPPED = "stopped"

_REASON_MANUAL_PAUSE = "manually_paused"


class ServiceState(str, Enum):
    """服务生命周期状态；继承 str 以便直接序列化进 JSON。"""

    BLOCKED = _STATE_BLOCKED
    STARTING = _STATE_STARTING
    READY = _STATE_READY
    STOPPING = _STATE_STOPPING
    FAILED = _STATE_FAILED
    STOPPED = _STATE_STOPPED


@dataclass
class ServiceRecord:
    """单个服务的运行时清单；``spec`` 恒指向注册时的声明对象。"""

    spec: ServiceSpec
    state: ServiceState = ServiceState.STOPPED
    reason_code: str = _STATE_STOPPED
    detail: str = "not started"
    pid: int | None = None
    started_at: str | None = None
    started_monotonic: float | None = None
    spawn_monotonic: float | None = None
    retry_count: int = 0
    window_started_at: float | None = None
    next_retry_at: str | None = None
    last_error: str | None = None
    paused: bool = False
    # 以下字段只服务运行时内部，不进快照。
    process: Any = None
    job: Any = None
    generation: int = 0
    stop_requested: bool = False
    retry_task: asyncio.Task[Any] | None = None
    watcher: asyncio.Task[Any] | None = None

    @property
    def service_id(self) -> str:
        return self.spec.id


StateCallback = Callable[[dict[str, Any]], Any]


def _read_mode(env: Mapping[str, str]) -> str:
    """把 ``AXEUH_ORCHESTRATOR`` 归一为 ``on`` / ``off``；缺省为 on。"""
    raw = env.get(ORCHESTRATOR_ENV, "")
    value = str(raw).strip().lower()
    return _MODE_OFF if value in _MODE_OFF_VALUES else _MODE_ON


def _reason_code(reason: str) -> str:
    """把 ``requirements_satisfied`` 的 reason 收敛为稳定的 reason_code。

    ``requires`` / ``enable_key`` 只产生 ``missing_config: <键>`` 与
    ``disabled`` 两种固定形态；其余原文均来自 gate，统一归 ``gate_failed``。
    """
    if reason.startswith("missing_config"):
        return "missing_config"
    if reason == "disabled":
        return "disabled"
    return "gate_failed"


def _format_wall(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, tz=timezone.utc).isoformat(
        timespec="seconds"
    )


def _decode_wait_status(status: int) -> int | None:
    decoder = getattr(os, "waitstatus_to_exitcode", None)
    if decoder is None:
        return None
    try:
        return int(decoder(status))
    except (ValueError, OSError):
        return None


def _win_pid_alive(pid: int) -> bool:
    """Windows 存活判定：``OpenProcess`` 能打开即存活（``os.kill`` 会杀进程）。"""
    try:
        import ctypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.restype = ctypes.c_void_p
        kernel32.OpenProcess.argtypes = (
            ctypes.c_uint32,
            ctypes.c_int,
            ctypes.c_uint32,
        )
        kernel32.CloseHandle.argtypes = (ctypes.c_void_p,)
        handle = kernel32.OpenProcess(0x1000, 0, int(pid))
    except Exception:
        return True
    if not handle:
        return False
    kernel32.CloseHandle(handle)
    return True


def _win_terminate(pid: int) -> None:
    """Windows 按精确 PID 终止（优先 ``TerminateProcess``）。"""
    try:
        import ctypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.restype = ctypes.c_void_p
        kernel32.OpenProcess.argtypes = (
            ctypes.c_uint32,
            ctypes.c_int,
            ctypes.c_uint32,
        )
        kernel32.TerminateProcess.argtypes = (ctypes.c_void_p, ctypes.c_uint)
        kernel32.CloseHandle.argtypes = (ctypes.c_void_p,)
        handle = kernel32.OpenProcess(0x0001, 0, int(pid))
        if not handle:
            return
        try:
            kernel32.TerminateProcess(handle, 1)
        finally:
            kernel32.CloseHandle(handle)
    except Exception as exc:  # 平台 API 异常只降级告警
        logger.warning("[Orchestrator] Windows 终止 pid=%s 失败: %s", pid, exc)


def _pid_alive(pid: int | None) -> bool:
    """按精确 PID 判断存活；Linux 上僵尸进程视为已死。"""
    if pid is None or pid <= 0:
        return False
    if os.name == "nt":
        return _win_pid_alive(pid)
    if sys.platform.startswith("linux"):
        try:
            with open("/proc/%d/stat" % pid, "rb") as handle:
                data = handle.read()
        except FileNotFoundError:
            return False
        except OSError:
            pass
        else:
            fields = data.rpartition(b")")[2].strip()
            return not fields.startswith(b"Z")
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _try_reap(pid: int) -> int | None:
    """POSIX 非阻塞回收自有子进程；非本进程子进程返回 None。"""
    if os.name == "nt":
        return None
    try:
        waited, status = os.waitpid(pid, os.WNOHANG)
    except (ChildProcessError, OSError):
        return None
    if waited != pid:
        return None
    return _decode_wait_status(status)


class Orchestrator:
    """受管服务的状态机与子进程生命周期。

    所有公开 async 方法都要求运行在事件循环线程内；``snapshot()`` 是纯读。
    构造参数全部可注入，供测试替换时钟 / 退避窗口，不改变生产默认值。
    """

    def __init__(
        self,
        *,
        spec_provider: Callable[[], Sequence[ServiceSpec]] | None = None,
        config_provider: Callable[[], Any] | None = None,
        env: Mapping[str, str] | None = None,
        clock: Callable[[], float] | None = None,
        sleep: Callable[[float], Awaitable[Any]] | None = None,
        max_restarts: int | None = None,
        window_s: float | None = None,
        backoff: Sequence[float] | None = None,
        spawn_grace_s: float | None = None,
        stop_budget_s: float | None = None,
        stop_timeout_s: float | None = None,
        kill_grace_s: float | None = None,
        poll_interval_s: float | None = None,
    ) -> None:
        self._spec_provider = spec_provider or all_specs
        self._config_provider = config_provider
        self._env = env
        self._clock = clock or time.time
        self._sleep = sleep or asyncio.sleep
        self._max_restarts = max_restarts
        self._window_s = window_s
        self._backoff = tuple(backoff) if backoff is not None else None
        self._spawn_grace_s = spawn_grace_s
        self._stop_budget_s = stop_budget_s
        self._stop_timeout_s = stop_timeout_s
        self._kill_grace_s = kill_grace_s
        self._poll_interval_s = poll_interval_s
        self._records: dict[str, ServiceRecord] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._starting: set[str] = set()
        self._stopping: set[str] = set()
        self._callbacks: list[StateCallback] = []

    # ── 全局开关 ──────────────────────────────────────────────

    @property
    def mode(self) -> str:
        """每次读取环境变量，测试与迁移脚本可在进程内切换。"""
        source = self._env if self._env is not None else os.environ
        return _read_mode(source)

    @property
    def enabled(self) -> bool:
        return self.mode == _MODE_ON

    # ── 只读快照 ──────────────────────────────────────────────

    def snapshot(self) -> dict[str, Any]:
        """服务状态快照；``off`` 模式恒为 ``{"orchestrator": "off", "services": []}``。"""
        if not self.enabled:
            return {"orchestrator": _MODE_OFF, "services": []}
        services: list[dict[str, Any]] = []
        seen: set[str] = set()
        for spec in self._specs():
            rec = self._records.get(spec.id)
            seen.add(spec.id)
            if rec is None:
                services.append(self._placeholder_entry(spec))
            else:
                services.append(self._entry(rec))
        for service_id, rec in self._records.items():
            if service_id not in seen:
                services.append(self._entry(rec))
        return {"orchestrator": _MODE_ON, "services": services}

    def on_state_change(self, callback: StateCallback) -> Callable[[], None]:
        """注册状态变更回调；返回取消函数。回调抛异常不影响状态机。"""
        self._callbacks.append(callback)

        def _unsubscribe() -> None:
            try:
                self._callbacks.remove(callback)
            except ValueError:
                pass

        return _unsubscribe

    # ── 启动 ──────────────────────────────────────────────────

    async def start_all(self) -> list[dict[str, Any]]:
        """并发拉起所有声明式判定通过的服务。

        对已 ``ready`` / ``starting`` 的服务幂等；对判定不再满足的已运行
        服务先停止再标 ``blocked``（供配置 ``apply`` 后重算，任务 18）。
        ``off`` 模式不注册任何服务并直接返回空列表。

        每个服务的启动观察窗最长 ``SPAWN_GRACE_S``（默认 10 秒）；全部服务
        并发观察（不叠加），所以本方法最坏阻塞约 10 秒。这是"启动失败 vs
        崩溃"分类的前提，调用方应在服务面启动阶段同步等待它。
        """
        if not self.enabled:
            logger.debug("[Orchestrator] 全局开关为 off，跳过 start_all")
            return []
        specs = tuple(self._specs())
        if not specs:
            return []
        tasks = [
            asyncio.create_task(self._start_all_one(spec)) for spec in specs
        ]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        for spec, result in zip(specs, results):
            if isinstance(result, BaseException):
                logger.error(
                    "[Orchestrator] 启动 %s 失败: %s", spec.id, result
                )
        return self._ordered_entries(specs)

    async def start(self, service_id: str) -> dict[str, Any]:
        """启动单个服务；已 starting/ready 时幂等返回，不重复 spawn。"""
        if not self.enabled:
            return self._off_entry(service_id)
        spec = self._require_spec(service_id)
        await self._attempt_start(spec)
        return self._entry_for(service_id, spec)

    async def retry(self, service_id: str) -> dict[str, Any]:
        """显式重试：清零重启窗口并重新判定配置。"""
        if not self.enabled:
            return self._off_entry(service_id)
        spec = self._require_spec(service_id)
        await self._reset_retry_budget(service_id, spec, clear_pause=False)
        await self._attempt_start(spec)
        return self._entry_for(service_id, spec)

    # ── 停止 ──────────────────────────────────────────────────

    async def stop(
        self, service_id: str, *, timeout: float | None = None
    ) -> dict[str, Any]:
        """主动停止单个服务；主动停止永不计入崩溃次数。"""
        if not self.enabled:
            return self._off_entry(service_id)
        spec = self._require_spec(service_id)
        await self._wait_placeholder(service_id, self._starting)
        lock = self._lock_for(service_id)
        budget = self._stop_timeout() if timeout is None else float(timeout)
        async with lock:
            rec = self._ensure_record(spec)
            self._cancel_retry_task(rec)
            rec.next_retry_at = None
            if service_id in self._stopping:
                return self._entry(rec)
            needs_stop = rec.pid is not None or rec.state in (
                ServiceState.STARTING,
                ServiceState.READY,
                ServiceState.STOPPING,
            )
            if not needs_stop:
                if rec.state is ServiceState.FAILED and not rec.paused:
                    self._set_state(
                        rec,
                        ServiceState.STOPPED,
                        reason_code=_STATE_STOPPED,
                        detail="stopped",
                    )
                return self._entry(rec)
            self._stopping.add(service_id)
            rec.stop_requested = True
            rec.generation += 1
            generation = rec.generation
            pid = rec.pid
            self._set_state(rec, ServiceState.STOPPING)
        try:
            await self._invoke_stop(rec, budget)
            if pid is not None and _pid_alive(pid):
                await self._terminate_pid(pid, grace=FALLBACK_TERM_GRACE_S)
        finally:
            async with lock:
                self._stopping.discard(service_id)
                if rec.generation == generation:
                    rec.stop_requested = False
                    rec.pid = None
                    rec.process = None
                    rec.started_at = None
                    rec.started_monotonic = None
                    rec.spawn_monotonic = None
                    rec.retry_count = 0
                    rec.window_started_at = None
                    self._close_job(rec)
                    if rec.paused:
                        self._set_state(
                            rec,
                            ServiceState.BLOCKED,
                            reason_code=_REASON_MANUAL_PAUSE,
                            detail="paused by operator",
                        )
                    else:
                        self._set_state(
                            rec,
                            ServiceState.STOPPED,
                            reason_code=_STATE_STOPPED,
                            detail="stopped",
                        )
        return self._entry(rec)

    async def stop_all(
        self, *, timeout: float | None = None
    ) -> list[dict[str, Any]]:
        """按注册逆序停止全部受管服务；总预算超时后按精确 PID 补 SIGKILL。"""
        budget = self._stop_budget() if timeout is None else float(timeout)
        deadline = time.monotonic() + max(0.0, budget)
        ordering = self._stop_order()
        recorded_pids = {
            service_id: rec.pid
            for service_id, rec in self._records.items()
            if rec.pid is not None
        }
        for service_id in ordering:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                logger.warning(
                    "[Orchestrator] stop_all 预算 %.1fs 用尽，剩余服务转 SIGKILL",
                    budget,
                )
                break
            try:
                await asyncio.wait_for(
                    self.stop(
                        service_id,
                        timeout=min(remaining, self._stop_timeout()),
                    ),
                    timeout=remaining,
                )
            except asyncio.TimeoutError:
                logger.error(
                    "[Orchestrator] 停止 %s 超过总预算，转按 PID 清理",
                    service_id,
                )
            except Exception as exc:
                logger.error(
                    "[Orchestrator] 停止 %s 失败: %s", service_id, exc
                )
        for service_id, pid in recorded_pids.items():
            rec = self._records.get(service_id)
            if rec is None or not _pid_alive(pid):
                continue
            logger.warning(
                "[Orchestrator] stop_all 残留 pid=%s（%s），按 PID 补 SIGKILL",
                pid,
                service_id,
            )
            self._signal_pid(pid, "SIGKILL")
        for rec in self._records.values():
            self._cancel_retry_task(rec)
        await self._wait_all_gone(recorded_pids)
        for rec in self._records.values():
            rec.generation += 1
            rec.stop_requested = False
            rec.pid = None
            rec.process = None
            rec.next_retry_at = None
            rec.started_at = None
            rec.started_monotonic = None
            rec.spawn_monotonic = None
            self._close_job(rec)
            if rec.paused:
                self._set_state(
                    rec,
                    ServiceState.BLOCKED,
                    reason_code=_REASON_MANUAL_PAUSE,
                    detail="paused by operator",
                )
            elif rec.state is not ServiceState.BLOCKED:
                self._set_state(
                    rec,
                    ServiceState.STOPPED,
                    reason_code=_STATE_STOPPED,
                    detail="stopped",
                )
        return self._ordered_entries(self._specs())

    # ── 运维闸门 ──────────────────────────────────────────────

    async def pause(self, service_id: str) -> dict[str, Any]:
        """运维闸门：停止并禁止自动拉起，状态固定 ``blocked/manually_paused``。"""
        if not self.enabled:
            return self._off_entry(service_id)
        spec = self._require_spec(service_id)
        lock = self._lock_for(service_id)
        async with lock:
            rec = self._ensure_record(spec)
            rec.paused = True
            self._cancel_retry_task(rec)
            rec.next_retry_at = None
            running = rec.pid is not None or rec.state in (
                ServiceState.STARTING,
                ServiceState.READY,
                ServiceState.STOPPING,
            )
        if running:
            await self.stop(service_id)
        async with lock:
            rec = self._ensure_record(spec)
            rec.paused = True
            rec.retry_count = 0
            rec.window_started_at = None
            rec.next_retry_at = None
            rec.pid = None
            self._set_state(
                rec,
                ServiceState.BLOCKED,
                reason_code=_REASON_MANUAL_PAUSE,
                detail="paused by operator",
            )
        return self._entry(rec)

    async def resume(self, service_id: str) -> dict[str, Any]:
        """解除运维闸门并立即重新拉起（配置仍不满足时保持 blocked）。"""
        if not self.enabled:
            return self._off_entry(service_id)
        spec = self._require_spec(service_id)
        await self._reset_retry_budget(service_id, spec, clear_pause=True)
        await self._attempt_start(spec)
        return self._entry_for(service_id, spec)

    # ── 启动实现 ──────────────────────────────────────────────

    async def _start_all_one(self, spec: ServiceSpec) -> None:
        ok, reason = self._evaluate(spec)
        if not ok:
            await self._apply_blocked(spec, _reason_code(reason), reason)
            return
        await self._attempt_start(spec)

    async def _attempt_start(self, spec: ServiceSpec) -> None:
        """幂等启动：判定 -> 占位 -> spawn（锁外）-> 观察窗 -> ready。"""
        service_id = spec.id
        await self._wait_placeholder(service_id, self._stopping)
        lock = self._lock_for(service_id)
        async with lock:
            rec = self._ensure_record(spec)
            if rec.paused:
                self._set_state(
                    rec,
                    ServiceState.BLOCKED,
                    reason_code=_REASON_MANUAL_PAUSE,
                    detail="paused by operator",
                )
                return
            if rec.state in (ServiceState.STARTING, ServiceState.READY):
                return
            if service_id in self._starting:
                return
            ok, reason = self._evaluate(spec)
            if not ok:
                rec.pid = None
                rec.next_retry_at = None
                self._set_state(
                    rec,
                    ServiceState.BLOCKED,
                    reason_code=_reason_code(reason),
                    detail=reason,
                )
                return
            self._starting.add(service_id)
            rec.generation += 1
            generation = rec.generation
            rec.pid = None
            rec.process = None
            rec.stop_requested = False
            rec.started_at = None
            rec.started_monotonic = None
            rec.spawn_monotonic = None
            rec.next_retry_at = None
            self._set_state(rec, ServiceState.STARTING)
        handle: Any = None
        registered = False
        try:
            result = await self._invoke_start(rec, generation)
            if result is None:
                return
            pid, handle = result
            async with lock:
                if rec.generation != generation or rec.stop_requested:
                    stale = True
                else:
                    stale = False
                    rec.pid = pid
                    rec.process = handle
                    rec.spawn_monotonic = time.monotonic()
                    self._attach_job(rec, pid)
                    registered = True
            if stale:
                logger.warning(
                    "[Orchestrator] %s spawn 期间被停止，回收 pid=%s",
                    service_id,
                    pid,
                )
                await self._terminate_pid(pid, grace=FALLBACK_TERM_GRACE_S)
                return
        except asyncio.CancelledError:
            async with lock:
                if rec.generation == generation:
                    if (
                        rec.pid is not None
                        and rec.state is ServiceState.STARTING
                    ):
                        rec.started_at = _format_wall(self._clock())
                        rec.started_monotonic = time.monotonic()
                        self._set_state(
                            rec,
                            ServiceState.READY,
                            reason_code="",
                            detail="",
                        )
                    elif rec.state is ServiceState.STARTING:
                        self._set_state(
                            rec,
                            ServiceState.FAILED,
                            reason_code="spawn_failed",
                            detail="start cancelled",
                        )
            raise
        finally:
            async with lock:
                self._starting.discard(service_id)
        if not registered or rec.pid is None:
            return
        watcher = asyncio.create_task(
            self._watch_exit(service_id, generation, handle, rec.pid)
        )
        async with lock:
            if rec.generation == generation:
                rec.watcher = watcher
        try:
            await asyncio.wait_for(
                asyncio.shield(watcher), timeout=self._spawn_grace()
            )
        except asyncio.TimeoutError:
            async with lock:
                if (
                    rec.generation == generation
                    and rec.state is ServiceState.STARTING
                ):
                    rec.started_at = _format_wall(self._clock())
                    rec.started_monotonic = time.monotonic()
                    rec.last_error = None
                    self._set_state(
                        rec,
                        ServiceState.READY,
                        reason_code="",
                        detail="",
                    )

    async def _invoke_start(
        self, rec: ServiceRecord, generation: int
    ) -> tuple[int, Any] | None:
        """调用启动动作并校验返回契约；失败标 ``spawn_failed``（不重试）。"""
        spec = rec.spec
        try:
            result = await spec.start()
        except Exception as exc:
            await self._mark_spawn_failed(
                rec, generation, "start action raised: %s" % exc
            )
            return None
        if not isinstance(result, dict):
            await self._mark_spawn_failed(
                rec,
                generation,
                "start action returned %s" % type(result).__name__,
            )
            return None
        pid = result.get("pid")
        handle = result.get("process")
        if handle is None:
            handle = result.get("handle")
        if result.get("ok") is False or not isinstance(pid, int) or pid <= 0:
            message = str(
                result.get("detail")
                or result.get("error")
                or "start action returned no valid pid"
            )
            await self._mark_spawn_failed(rec, generation, message)
            if isinstance(pid, int) and pid > 0:
                await self._terminate_pid(
                    pid, grace=FALLBACK_TERM_GRACE_S
                )
            return None
        return pid, handle

    async def _mark_spawn_failed(
        self, rec: ServiceRecord, generation: int, message: str
    ) -> None:
        lock = self._lock_for(rec.service_id)
        async with lock:
            if rec.generation != generation:
                return
            rec.pid = None
            rec.process = None
            rec.stop_requested = False
            rec.next_retry_at = None
            rec.last_error = message
            self._close_job(rec)
            self._set_state(
                rec,
                ServiceState.FAILED,
                reason_code="spawn_failed",
                detail=message,
            )
        logger.error(
            "[Orchestrator] %s 启动失败（不重试）: %s",
            rec.service_id,
            message,
        )

    async def _watch_exit(
        self,
        service_id: str,
        generation: int,
        handle: Any,
        pid: int,
    ) -> None:
        code: int | None = None
        try:
            code = await self._await_exit(handle, pid)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning(
                "[Orchestrator] %s 退出观察异常: %s", service_id, exc
            )
        await self._on_exit(service_id, generation, code)

    async def _on_exit(
        self, service_id: str, generation: int, code: int | None
    ) -> None:
        lock = self._lock_for(service_id)
        async with lock:
            rec = self._records.get(service_id)
            if rec is None or rec.generation != generation:
                return
            if rec.stop_requested or service_id in self._stopping:
                return
            spawned_at = rec.spawn_monotonic
            elapsed = (
                time.monotonic() - spawned_at
                if spawned_at is not None
                else self._spawn_grace()
            )
            rec.pid = None
            rec.process = None
            rec.started_at = None
            rec.started_monotonic = None
            self._close_job(rec)
            rec.last_error = "process exited (code=%s)" % (code,)
            if elapsed < self._spawn_grace():
                self._set_state(
                    rec,
                    ServiceState.FAILED,
                    reason_code="spawn_failed",
                    detail=(
                        "exited %.2fs after spawn (code=%s)"
                        % (elapsed, code)
                    ),
                )
                logger.error(
                    "[Orchestrator] %s 启动后 %.2fs 退出（不重试, code=%s）",
                    service_id,
                    elapsed,
                    code,
                )
                return
            self._schedule_retry(rec, code)

    def _schedule_retry(
        self, rec: ServiceRecord, code: int | None
    ) -> None:
        """崩溃后的有界重试判定；调用方必须持有该服务的锁。

        窗口按墙钟计：``WINDOW_S`` 内最多 ``MAX_RESTARTS`` 次重启；窗口过期
        先清零再计。超限后 ``failed/restart_exhausted`` 且不排新任务。
        """
        spec = rec.spec
        if not spec.restart or rec.paused:
            self._set_state(
                rec,
                ServiceState.FAILED,
                reason_code="crashed",
                detail="process exited (code=%s); restart disabled" % (code,),
            )
            return
        now = self._clock()
        window = self._window()
        if (
            rec.window_started_at is None
            or now - rec.window_started_at >= window
        ):
            rec.window_started_at = now
            rec.retry_count = 0
        if rec.retry_count >= self._max_restart_count():
            self._set_state(
                rec,
                ServiceState.FAILED,
                reason_code="restart_exhausted",
                detail=(
                    "%d restarts within %.0fs exceeded"
                    % (rec.retry_count, window)
                ),
            )
            logger.error(
                "[Orchestrator] %s 重启预算耗尽（%d 次 / %.0fs）",
                rec.service_id,
                rec.retry_count,
                window,
            )
            return
        backoff = self._backoff_table()
        delay = backoff[min(rec.retry_count, len(backoff) - 1)]
        rec.retry_count += 1
        rec.next_retry_at = _format_wall(now + delay)
        generation = rec.generation
        self._set_state(
            rec,
            ServiceState.FAILED,
            reason_code="crashed",
            detail="restart in %.1fs (attempt %d/%d)" % (
                delay,
                rec.retry_count,
                self._max_restart_count(),
            ),
        )
        rec.retry_task = asyncio.create_task(
            self._retry_after(rec.service_id, delay, generation)
        )
        logger.warning(
            "[Orchestrator] %s 崩溃（code=%s），%.1fs 后第 %d 次重启",
            rec.service_id,
            code,
            delay,
            rec.retry_count,
        )

    async def _retry_after(
        self, service_id: str, delay: float, generation: int
    ) -> None:
        try:
            await self._sleep(delay)
        except asyncio.CancelledError:
            raise
        lock = self._lock_for(service_id)
        async with lock:
            rec = self._records.get(service_id)
            if rec is None or rec.generation != generation:
                return
            if rec.state is not ServiceState.FAILED or rec.paused:
                return
            if rec.next_retry_at is None:
                return
            rec.next_retry_at = None
            rec.retry_task = None
        spec = rec.spec
        await self._attempt_start(spec)

    # ── 停止实现 ──────────────────────────────────────────────

    async def _invoke_stop(
        self, rec: ServiceRecord, timeout: float
    ) -> None:
        spec = rec.spec
        pid = rec.pid
        try:
            await asyncio.wait_for(spec.stop(), timeout=timeout)
        except asyncio.TimeoutError:
            rec.last_error = "stop timeout after %.1fs" % timeout
            logger.warning(
                "[Orchestrator] %s 停止超时 %.1fs", rec.service_id, timeout
            )
            if pid is not None and _pid_alive(pid):
                await self._terminate_pid(pid, grace=FALLBACK_TERM_GRACE_S)
        except Exception as exc:
            rec.last_error = "stop failed: %s" % exc
            logger.error(
                "[Orchestrator] %s 停止动作失败: %s", rec.service_id, exc
            )
            if pid is not None and _pid_alive(pid):
                await self._terminate_pid(pid, grace=FALLBACK_TERM_GRACE_S)
        else:
            if pid is not None and _pid_alive(pid):
                logger.warning(
                    "[Orchestrator] %s 停止动作返回后 pid=%s 仍存活，兜底终止",
                    rec.service_id,
                    pid,
                )
                await self._terminate_pid(pid, grace=FALLBACK_TERM_GRACE_S)

    async def _terminate_pid(self, pid: int, *, grace: float) -> bool:
        """SIGTERM -> 宽限 -> SIGKILL；只按精确 PID，绝不按名称。"""
        if not _pid_alive(pid):
            _try_reap(pid)
            return True
        self._signal_pid(pid, "SIGTERM")
        if await self._wait_pid_gone(pid, grace):
            return True
        logger.warning(
            "[Orchestrator] pid=%s SIGTERM %.1fs 未退出，按 PID 补 SIGKILL",
            pid,
            grace,
        )
        self._signal_pid(pid, "SIGKILL")
        return await self._wait_pid_gone(
            pid, max(self._kill_grace(), 0.5)
        )

    def _signal_pid(self, pid: int, signal_name: str) -> None:
        if os.name == "nt":
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
            logger.error(
                "[Orchestrator] 无权限向 pid=%s 发送 %s", pid, signal_name
            )
        except OSError as exc:
            logger.warning(
                "[Orchestrator] 向 pid=%s 发送 %s 失败: %s",
                pid,
                signal_name,
                exc,
            )

    async def _wait_pid_gone(self, pid: int, timeout: float) -> bool:
        deadline = time.monotonic() + max(0.0, timeout)
        while True:
            _try_reap(pid)
            if not _pid_alive(pid):
                return True
            if time.monotonic() >= deadline:
                return False
            await self._sleep(min(self._poll_interval(), 0.05))

    async def _wait_all_gone(
        self, recorded: Mapping[str, int | None]
    ) -> None:
        pids = [pid for pid in recorded.values() if pid is not None]
        if not pids:
            return
        deadline = time.monotonic() + min(self._kill_grace(), KILL_GRACE_S)
        while time.monotonic() < deadline:
            for pid in pids:
                _try_reap(pid)
            if not any(_pid_alive(pid) for pid in pids):
                return
            await self._sleep(min(self._poll_interval(), 0.05))
        alive = [pid for pid in pids if _pid_alive(pid)]
        if alive:
            logger.error(
                "[Orchestrator] SIGKILL 后仍有残留 PID: %s", alive
            )

    def _cancel_retry_task(self, rec: ServiceRecord) -> None:
        task = rec.retry_task
        rec.retry_task = None
        if task is not None and not task.done():
            task.cancel()

    # ── 判定与记录 ────────────────────────────────────────────

    async def _apply_blocked(
        self, spec: ServiceSpec, reason_code: str, detail: str
    ) -> None:
        service_id = spec.id
        lock = self._lock_for(service_id)
        need_stop = False
        async with lock:
            rec = self._ensure_record(spec)
            if rec.paused:
                self._set_state(
                    rec,
                    ServiceState.BLOCKED,
                    reason_code=_REASON_MANUAL_PAUSE,
                    detail="paused by operator",
                )
                return
            need_stop = rec.pid is not None or rec.state in (
                ServiceState.STARTING,
                ServiceState.READY,
                ServiceState.STOPPING,
            )
            if not need_stop:
                rec.next_retry_at = None
                self._set_state(
                    rec,
                    ServiceState.BLOCKED,
                    reason_code=reason_code,
                    detail=detail,
                )
                return
        if need_stop:
            await self.stop(service_id)
        async with lock:
            if not rec.paused:
                rec.pid = None
                rec.next_retry_at = None
                self._set_state(
                    rec,
                    ServiceState.BLOCKED,
                    reason_code=reason_code,
                    detail=detail,
                )

    async def _reset_retry_budget(
        self, service_id: str, spec: ServiceSpec, *, clear_pause: bool
    ) -> None:
        lock = self._lock_for(service_id)
        async with lock:
            rec = self._ensure_record(spec)
            self._cancel_retry_task(rec)
            rec.retry_count = 0
            rec.window_started_at = None
            rec.next_retry_at = None
            if clear_pause:
                rec.paused = False

    async def _wait_placeholder(
        self, service_id: str, holders: set[str]
    ) -> None:
        """在锁外等待另一操作完成（有界）；避免 start/stop 交叠。"""
        if service_id not in holders:
            return
        deadline = time.monotonic() + PLACEHOLDER_WAIT_S
        while service_id in holders:
            if time.monotonic() >= deadline:
                logger.warning(
                    "[Orchestrator] %s 等待在途操作超时，继续执行",
                    service_id,
                )
                return
            await self._sleep(0.01)

    def _ensure_record(self, spec: ServiceSpec) -> ServiceRecord:
        rec = self._records.get(spec.id)
        if rec is None:
            rec = ServiceRecord(spec=spec)
            self._records[spec.id] = rec
            self._locks.setdefault(spec.id, asyncio.Lock())
        return rec

    def _lock_for(self, service_id: str) -> asyncio.Lock:
        lock = self._locks.get(service_id)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[service_id] = lock
        return lock

    def _specs(self) -> tuple[ServiceSpec, ...]:
        return tuple(self._spec_provider())

    def _require_spec(self, service_id: str) -> ServiceSpec:
        for spec in self._specs():
            if spec.id == service_id:
                return spec
        raise KeyError("unknown service id: %s" % service_id)

    def _evaluate(self, spec: ServiceSpec) -> tuple[bool, str]:
        try:
            cfg = self._config_provider() if self._config_provider else None
            if cfg is None:
                from config.config import get_config

                cfg = get_config()
        except Exception as exc:
            return False, "missing_config: config unavailable (%s)" % exc
        try:
            return requirements_satisfied(spec, cfg)
        except Exception as exc:
            return False, "gate_failed: %s" % exc

    def _entry(self, rec: ServiceRecord) -> dict[str, Any]:
        return {
            "id": rec.service_id,
            "state": rec.state.value,
            "reason_code": rec.reason_code,
            "detail": rec.detail,
            "pid": rec.pid,
            "started_at": rec.started_at,
            "retry_count": rec.retry_count,
            "next_retry_at": rec.next_retry_at,
            "requires": list(rec.spec.requires),
            "critical": rec.spec.critical,
            "restart": rec.spec.restart,
            "paused": rec.paused,
            "last_error": rec.last_error,
        }

    def _placeholder_entry(self, spec: ServiceSpec) -> dict[str, Any]:
        ok, reason = self._evaluate(spec)
        if ok:
            rec = ServiceRecord(spec=spec)
        else:
            rec = ServiceRecord(
                spec=spec,
                state=ServiceState.BLOCKED,
                reason_code=_reason_code(reason),
                detail=reason,
            )
        return self._entry(rec)

    def _entry_for(
        self, service_id: str, spec: ServiceSpec
    ) -> dict[str, Any]:
        rec = self._records.get(service_id)
        if rec is None:
            rec = ServiceRecord(spec=spec)
        return self._entry(rec)

    def _off_entry(self, service_id: str) -> dict[str, Any]:
        return {
            "id": service_id,
            "state": _STATE_STOPPED,
            "reason_code": "orchestrator_off",
            "detail": "%s=off" % ORCHESTRATOR_ENV,
            "pid": None,
            "started_at": None,
            "retry_count": 0,
            "next_retry_at": None,
            "requires": [],
            "critical": False,
            "restart": False,
            "paused": False,
            "last_error": None,
        }

    def _ordered_entries(
        self, specs: Sequence[ServiceSpec]
    ) -> list[dict[str, Any]]:
        entries: list[dict[str, Any]] = []
        seen: set[str] = set()
        for spec in specs:
            rec = self._records.get(spec.id)
            if rec is not None:
                entries.append(self._entry(rec))
                seen.add(spec.id)
        for service_id, rec in self._records.items():
            if service_id not in seen:
                entries.append(self._entry(rec))
        return entries

    def _stop_order(self) -> list[str]:
        """停止顺序：注册逆序（consumer -> producer），未注册记录随后。"""
        ordered: list[str] = []
        known: set[str] = set()
        for spec in reversed(self._specs()):
            if spec.id in self._records:
                ordered.append(spec.id)
                known.add(spec.id)
        for service_id in reversed(list(self._records)):
            if service_id not in known:
                ordered.append(service_id)
        return ordered

    def _set_state(
        self,
        rec: ServiceRecord,
        state: ServiceState,
        *,
        reason_code: str | None = None,
        detail: str | None = None,
    ) -> None:
        """状态转移 + 回调分发；reason/detail 传 None 表示保留原值。"""
        changed = rec.state is not state
        rec.state = state
        if reason_code is not None:
            rec.reason_code = reason_code
        if detail is not None:
            rec.detail = detail
        if changed:
            logger.info(
                "[Orchestrator] %s -> %s (%s) pid=%s",
                rec.service_id,
                state.value,
                rec.reason_code,
                rec.pid,
            )
        if not changed:
            return
        entry = self._entry(rec)
        for callback in tuple(self._callbacks):
            try:
                result = callback(dict(entry))
                if inspect.isawaitable(result):
                    asyncio.get_running_loop().create_task(result)
            except Exception:
                logger.exception(
                    "[Orchestrator] 状态回调异常（%s）", rec.service_id
                )

    # ── 子进程工具 ────────────────────────────────────────────

    async def _await_exit(
        self, handle: Any, pid: int | None
    ) -> int | None:
        """等待子进程退出；优先用启动动作给的句柄，否则按 PID 轮询。"""
        if handle is not None:
            wait = getattr(handle, "wait", None)
            if callable(wait):
                if inspect.iscoroutinefunction(wait):
                    return await wait()
                poll = getattr(handle, "poll", None)
                if callable(poll):
                    while True:
                        code = poll()
                        if code is not None:
                            return int(code)
                        await self._sleep(self._poll_interval())
                return None
        if pid is None:
            return None
        while True:
            code = _try_reap(pid)
            if code is not None:
                return code
            if not _pid_alive(pid):
                return None
            await self._sleep(self._poll_interval())

    def _attach_job(self, rec: ServiceRecord, pid: int) -> None:
        """Windows：为子进程挂 Kill-on-close Job，句柄由记录持有。"""
        if os.name != "nt":
            return
        try:
            from .child_entry import (
                assign_process_to_job,
                create_kill_on_close_job,
            )

            job = create_kill_on_close_job()
            assign_process_to_job(job, pid)
        except Exception as exc:
            logger.warning(
                "[Orchestrator] %s 创建 Job Object 失败: %s",
                rec.service_id,
                exc,
            )
            return
        rec.job = job

    def _close_job(self, rec: ServiceRecord) -> None:
        job = rec.job
        rec.job = None
        if job is None:
            return
        try:
            job.close()
        except Exception as exc:
            logger.warning(
                "[Orchestrator] %s 关闭 Job Object 失败: %s",
                rec.service_id,
                exc,
            )

    # ── 可注入常量 ────────────────────────────────────────────

    def _max_restart_count(self) -> int:
        if self._max_restarts is not None:
            return self._max_restarts
        return MAX_RESTARTS

    def _window(self) -> float:
        if self._window_s is not None:
            return self._window_s
        return WINDOW_S

    def _backoff_table(self) -> tuple[float, ...]:
        if self._backoff is not None:
            return self._backoff
        return BACKOFF_S

    def _spawn_grace(self) -> float:
        if self._spawn_grace_s is not None:
            return self._spawn_grace_s
        return SPAWN_GRACE_S

    def _stop_budget(self) -> float:
        if self._stop_budget_s is not None:
            return self._stop_budget_s
        return STOP_ALL_BUDGET_S

    def _stop_timeout(self) -> float:
        if self._stop_timeout_s is not None:
            return self._stop_timeout_s
        return STOP_TIMEOUT_S

    def _kill_grace(self) -> float:
        if self._kill_grace_s is not None:
            return self._kill_grace_s
        return KILL_GRACE_S

    def _poll_interval(self) -> float:
        if self._poll_interval_s is not None:
            return self._poll_interval_s
        return POLL_INTERVAL_S


# ── 进程级单例 ───────────────────────────────────────────────

_singleton: Orchestrator | None = None


def get_orchestrator() -> Orchestrator:
    """取进程级单例（懒创建）；主入口与 ``/api/services`` 共用同一实例。"""
    global _singleton
    if _singleton is None:
        _singleton = Orchestrator()
    return _singleton


def peek_orchestrator() -> Orchestrator | None:
    """只查不建；用于关停路径避免反向创建。"""
    return _singleton


def reset_orchestrator() -> None:
    """清空单例引用（测试用）；不负责停止已在跑的子进程。"""
    global _singleton
    _singleton = None


__all__ = [
    "BACKOFF_S",
    "KILL_GRACE_S",
    "MAX_RESTARTS",
    "ORCHESTRATOR_ENV",
    "Orchestrator",
    "POLL_INTERVAL_S",
    "SPAWN_GRACE_S",
    "STOP_ALL_BUDGET_S",
    "STOP_TIMEOUT_S",
    "ServiceRecord",
    "ServiceState",
    "WINDOW_S",
    "get_orchestrator",
    "peek_orchestrator",
    "reset_orchestrator",
]
