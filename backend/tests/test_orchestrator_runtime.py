# -*- coding: utf-8 -*-
"""Orchestrator 运行时契约（任务 8）。

覆盖：启动失败不重试、崩溃按窗口重试到耗尽、blocked 不启动、stop_all 预算
与 SIGKILL 升级、运维闸门、全局开关、并发单实例、主动停止不计崩溃、窗口
过期重置、状态回调与启动动作契约。

全部用例用 ``sys.executable`` 起真实小脚本作子进程，``asyncio.run`` 驱动
（本 venv 无 pytest-asyncio）。观察窗与退避窗口一律注入短值，不 sleep 真实
的 10 秒 / 300 秒；每个用例结束都 ``stop_all`` 清理，绝不按名称杀进程。
"""
from __future__ import annotations

import asyncio
import os
import sys
import time
from types import SimpleNamespace
from typing import Any, Callable

import pytest

from services.orchestrator.runtime import (
    BACKOFF_S,
    MAX_RESTARTS,
    ORCHESTRATOR_ENV,
    STOP_ALL_BUDGET_S,
    Orchestrator,
)
from services.orchestrator.spec import ServiceSpec

_LONG_RUN = "import time\nwhile True:\n    time.sleep(0.05)\n"
_IGNORE_TERM = (
    "import signal, time\n"
    "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
    "time.sleep(60)\n"
)
_INSTANT_EXIT = "import sys\nsys.exit(3)\n"

_FAST_GRACE = 0.1
_FAST_BACKOFF = (0.01, 0.01, 0.01, 0.01, 0.01)


@pytest.fixture(autouse=True)
def _orchestrator_default_on(monkeypatch: pytest.MonkeyPatch) -> None:
    # conftest 为 lifespan 测试全局设 off；本模块单独验证运行时默认 on。
    monkeypatch.setenv(ORCHESTRATOR_ENV, "on")


def _spawn_argv(script: str) -> list[str]:
    return [sys.executable, "-c", script]


def _alive(pid: int | None) -> bool:
    if pid is None:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


class FakeService:
    """把进程起停封装成 ServiceSpec 所需的异步动作。"""

    def __init__(
        self,
        service_id: str,
        *,
        script: str = _LONG_RUN,
        restart: bool = True,
        requires: tuple[str, ...] = (),
        gate: Callable[[Any], tuple[bool, str]] | None = None,
        enable_key: str | None = None,
        stop_mode: str = "kill",
        spawn_delay: float = 0.0,
        events: list[str] | None = None,
    ) -> None:
        self.service_id = service_id
        self.script = script
        self.restart = restart
        self.requires = requires
        self.gate = gate
        self.enable_key = enable_key
        self.stop_mode = stop_mode
        self.spawn_delay = spawn_delay
        self.spawns: list[asyncio.subprocess.Process] = []
        self.start_calls = 0
        self.stop_calls = 0
        self.events = events if events is not None else []

    @property
    def pid(self) -> int | None:
        return self.spawns[-1].pid if self.spawns else None

    def spec(self) -> ServiceSpec:
        return ServiceSpec(
            id=self.service_id,
            requires=self.requires,
            gate=self.gate,
            start=self.start,
            stop=self.stop,
            critical=False,
            restart=self.restart,
            enable_key=self.enable_key,
        )

    async def start(self) -> dict[str, Any]:
        self.start_calls += 1
        if self.spawn_delay:
            await asyncio.sleep(self.spawn_delay)
        proc = await asyncio.create_subprocess_exec(
            *_spawn_argv(self.script),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        self.spawns.append(proc)
        return {"ok": True, "pid": proc.pid, "process": proc}

    async def stop(self) -> dict[str, Any]:
        self.stop_calls += 1
        self.events.append(self.service_id)
        if self.stop_mode == "hang":
            await asyncio.sleep(3600)
        proc = self.spawns[-1] if self.spawns else None
        if proc is not None and proc.returncode is None:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
        return {"ok": True}


def _make(
    services: list[FakeService], **overrides: Any
) -> Orchestrator:
    options: dict[str, Any] = {
        "spec_provider": lambda: tuple(s.spec() for s in services),
        "config_provider": lambda: SimpleNamespace(_data={}),
        "spawn_grace_s": _FAST_GRACE,
        "backoff": _FAST_BACKOFF,
        "poll_interval_s": 0.02,
    }
    options.update(overrides)
    return Orchestrator(**options)


def _entry(orch: Orchestrator, service_id: str) -> dict[str, Any]:
    for item in orch.snapshot()["services"]:
        if item["id"] == service_id:
            return item
    raise AssertionError("snapshot 缺少服务 %s" % service_id)


async def _wait_entry(
    orch: Orchestrator,
    service_id: str,
    predicate: Callable[[dict[str, Any]], bool],
    timeout: float = 6.0,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        entry = _entry(orch, service_id)
        if predicate(entry):
            return entry
        await asyncio.sleep(0.01)
    raise AssertionError(
        "等待 %s 超时，当前状态: %s"
        % (service_id, _entry(orch, service_id))
    )


async def _wait_ready_spawn(
    orch: Orchestrator, service: FakeService, count: int, timeout: float = 6.0
) -> dict[str, Any]:
    return await _wait_entry(
        orch,
        service.service_id,
        lambda e: e["state"] == "ready" and len(service.spawns) == count,
        timeout,
    )


# ── 退出三分类 ───────────────────────────────────────────────


def test_exit_within_grace_is_spawn_failed_without_retry() -> None:
    async def scenario() -> None:
        bad = FakeService("bad", script=_INSTANT_EXIT)
        orch = _make([bad])
        try:
            await orch.start_all()
            entry = await _wait_entry(
                orch, "bad", lambda e: e["state"] == "failed"
            )
            assert entry["reason_code"] == "spawn_failed"
            assert entry["retry_count"] == 0
            assert entry["pid"] is None
            assert entry["next_retry_at"] is None
            await asyncio.sleep(0.25)
            assert bad.start_calls == 1
            assert _entry(orch, "bad")["state"] == "failed"
        finally:
            await orch.stop_all()

    asyncio.run(scenario())


def test_crash_retries_five_times_then_exhausts_without_sixth_spawn() -> None:
    async def scenario() -> None:
        svc = FakeService("crashy")
        orch = _make([svc])
        try:
            await orch.start_all()
            for index in range(MAX_RESTARTS):
                entry = await _wait_ready_spawn(orch, svc, index + 1)
                assert entry["retry_count"] == index
                svc.spawns[-1].terminate()
            sixth = await _wait_ready_spawn(orch, svc, 6)
            assert sixth["retry_count"] == MAX_RESTARTS
            svc.spawns[-1].terminate()
            entry = await _wait_entry(
                orch,
                "crashy",
                lambda e: e["reason_code"] == "restart_exhausted",
            )
            assert entry["state"] == "failed"
            assert entry["retry_count"] == MAX_RESTARTS
            assert entry["next_retry_at"] is None
            assert len(svc.spawns) == 6
            await asyncio.sleep(0.3)
            assert len(svc.spawns) == 6
            assert svc.start_calls == 6
        finally:
            await orch.stop_all()

    asyncio.run(scenario())


def test_restart_window_resets_after_expiry() -> None:
    async def scenario() -> None:
        clock = {"now": 1000.0}
        svc = FakeService("window")
        orch = _make(
            [svc], window_s=300.0, clock=lambda: clock["now"]
        )
        try:
            await orch.start_all()
            for index in range(MAX_RESTARTS):
                await _wait_ready_spawn(orch, svc, index + 1)
                svc.spawns[-1].terminate()
            sixth = await _wait_ready_spawn(orch, svc, 6)
            assert sixth["retry_count"] == MAX_RESTARTS
            clock["now"] += 301.0
            svc.spawns[-1].terminate()
            seventh = await _wait_ready_spawn(orch, svc, 7)
            assert seventh["retry_count"] == 1
        finally:
            await orch.stop_all()

    asyncio.run(scenario())


def test_active_stop_is_not_counted_as_crash() -> None:
    async def scenario() -> None:
        svc = FakeService("svc")
        orch = _make([svc])
        try:
            await orch.start_all()
            await _wait_ready_spawn(orch, svc, 1)
            entry = await orch.stop("svc")
            assert entry["state"] == "stopped"
            assert entry["reason_code"] == "stopped"
            assert entry["retry_count"] == 0
            assert entry["next_retry_at"] is None
            await asyncio.sleep(0.3)
            assert svc.start_calls == 1
            assert svc.spawns[0].returncode is not None
        finally:
            await orch.stop_all()

    asyncio.run(scenario())


def test_active_stop_cancels_pending_retry() -> None:
    async def scenario() -> None:
        svc = FakeService("crashy")
        orch = _make([svc], backoff=(0.4, 0.4, 0.4, 0.4, 0.4))
        try:
            await orch.start_all()
            await _wait_ready_spawn(orch, svc, 1)
            svc.spawns[-1].terminate()
            crashed = await _wait_entry(
                orch, "crashy", lambda e: e["reason_code"] == "crashed"
            )
            assert crashed["next_retry_at"] is not None
            stopped = await orch.stop("crashy")
            assert stopped["state"] == "stopped"
            assert stopped["next_retry_at"] is None
            await asyncio.sleep(0.6)
            assert svc.start_calls == 1
            assert len(svc.spawns) == 1
        finally:
            await orch.stop_all()

    asyncio.run(scenario())


# ── blocked 与运维闸门 ───────────────────────────────────────


def test_blocked_spec_is_never_spawned() -> None:
    async def scenario() -> None:
        svc = FakeService("needs", requires=("no.such.key",))
        orch = _make([svc])
        try:
            before = _entry(orch, "needs")
            assert before["state"] == "blocked"
            assert before["reason_code"] == "missing_config"
            await orch.start_all()
            entry = _entry(orch, "needs")
            assert entry["state"] == "blocked"
            assert entry["reason_code"] == "missing_config"
            assert "no.such.key" in entry["detail"]
            await orch.retry("needs")
            assert svc.start_calls == 0
            assert _entry(orch, "needs")["state"] == "blocked"
        finally:
            await orch.stop_all()

    asyncio.run(scenario())


def test_pause_stops_and_resume_restarts() -> None:
    async def scenario() -> None:
        svc = FakeService("svc")
        orch = _make([svc])
        try:
            await orch.start_all()
            ready = await _wait_ready_spawn(orch, svc, 1)
            first_pid = ready["pid"]
            assert first_pid is not None
            paused = await orch.pause("svc")
            assert paused["state"] == "blocked"
            assert paused["reason_code"] == "manually_paused"
            assert paused["pid"] is None
            assert not _alive(first_pid)
            await orch.start("svc")
            assert _entry(orch, "svc")["state"] == "blocked"
            assert svc.start_calls == 1
            resumed = await orch.resume("svc")
            assert resumed["state"] == "ready"
            assert resumed["pid"] is not None
            assert resumed["pid"] != first_pid
            assert svc.start_calls == 2
        finally:
            await orch.stop_all()

    asyncio.run(scenario())


# ── stop_all 预算与信号升级 ─────────────────────────────────


def test_stop_all_uses_reverse_order_and_clears_pids() -> None:
    async def scenario() -> None:
        events: list[str] = []
        first = FakeService("first", events=events)
        second = FakeService("second", events=events)
        orch = _make([first, second])
        try:
            await orch.start_all()
            await _wait_ready_spawn(orch, first, 1)
            await _wait_ready_spawn(orch, second, 1)
            started = time.monotonic()
            entries = await orch.stop_all()
            elapsed = time.monotonic() - started
            assert elapsed < STOP_ALL_BUDGET_S
            assert events == ["second", "first"]
            assert all(item["pid"] is None for item in entries)
            assert all(item["state"] == "stopped" for item in entries)
            assert first.spawns[0].returncode is not None
            assert second.spawns[0].returncode is not None
        finally:
            await orch.stop_all()

    asyncio.run(scenario())


def test_stop_all_escalates_to_sigkill_for_sigterm_ignoring_process() -> None:
    async def scenario() -> None:
        svc = FakeService(
            "stubborn", script=_IGNORE_TERM, stop_mode="hang"
        )
        orch = _make([svc])
        try:
            await orch.start_all()
            await _wait_ready_spawn(orch, svc, 1)
            proc = svc.spawns[0]
            assert proc.returncode is None
            started = time.monotonic()
            await orch.stop_all(timeout=0.4)
            elapsed = time.monotonic() - started
            assert elapsed < 15
            deadline = time.monotonic() + 3.0
            while proc.returncode is None and time.monotonic() < deadline:
                await asyncio.sleep(0.01)
            assert proc.returncode is not None
            assert not _alive(proc.pid)
        finally:
            await orch.stop_all()

    asyncio.run(scenario())


def test_orchestrator_constants_match_contract() -> None:
    assert MAX_RESTARTS == 5
    assert BACKOFF_S == (1.0, 2.0, 4.0, 8.0, 16.0)
    assert STOP_ALL_BUDGET_S == 15.0


# ── 全局开关 ─────────────────────────────────────────────────


def test_global_switch_off_registers_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(ORCHESTRATOR_ENV, "off")

    async def scenario() -> None:
        svc = FakeService("svc")
        orch = _make([svc])
        assert orch.mode == "off"
        assert orch.snapshot() == {"orchestrator": "off", "services": []}
        assert await orch.start_all() == []
        assert orch.snapshot() == {"orchestrator": "off", "services": []}
        await orch.start("svc")
        await orch.stop("svc")
        assert svc.start_calls == 0
        assert svc.stop_calls == 0

    asyncio.run(scenario())


def test_global_switch_defaults_to_on(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(ORCHESTRATOR_ENV, raising=False)
    orch = Orchestrator(spec_provider=lambda: ())
    assert orch.mode == "on"
    assert orch.snapshot() == {"orchestrator": "on", "services": []}


# ── 并发单实例 ───────────────────────────────────────────────


def test_concurrent_start_spawns_exactly_once() -> None:
    async def scenario() -> None:
        svc = FakeService("slow", spawn_delay=0.1)
        orch = _make([svc])
        try:
            results = await asyncio.gather(
                *[orch.start("slow") for _ in range(10)]
            )
            assert svc.start_calls == 1
            assert len(svc.spawns) == 1
            ready = await _wait_ready_spawn(orch, svc, 1)
            assert ready["pid"] == svc.spawns[0].pid
            assert all(
                item["pid"] in (None, ready["pid"]) for item in results
            )
        finally:
            await orch.stop_all()

    asyncio.run(scenario())


# ── 状态回调与启动动作契约 ───────────────────────────────────


def test_state_change_callbacks_fire_and_unsubscribe() -> None:
    async def scenario() -> None:
        svc = FakeService("svc")
        orch = _make([svc])
        seen: list[str] = []
        unsubscribe = orch.on_state_change(
            lambda entry: seen.append(entry["state"])
        )
        try:
            await orch.start_all()
            await _wait_ready_spawn(orch, svc, 1)
            await orch.stop_all()
            unsubscribe()
            count = len(seen)
            assert "starting" in seen
            assert "ready" in seen
            assert "stopped" in seen
            await orch.start_all()
            assert len(seen) == count
        finally:
            await orch.stop_all()

    asyncio.run(scenario())


def test_start_action_returning_no_pid_is_spawn_failed() -> None:
    async def no_pid() -> dict[str, Any]:
        return {"ok": True}

    async def noop() -> dict[str, Any]:
        return {"ok": True}

    spec = ServiceSpec(
        id="nopid",
        requires=(),
        gate=None,
        start=no_pid,
        stop=noop,
        critical=False,
        restart=True,
    )

    async def scenario() -> None:
        orch = Orchestrator(
            spec_provider=lambda: (spec,),
            config_provider=lambda: SimpleNamespace(_data={}),
            spawn_grace_s=0.05,
        )
        entry = await orch.start("nopid")
        assert entry["state"] == "failed"
        assert entry["reason_code"] == "spawn_failed"
        assert "pid" in entry["detail"]
        await orch.stop_all()

    asyncio.run(scenario())


def test_start_action_raising_is_spawn_failed() -> None:
    async def boom() -> dict[str, Any]:
        raise RuntimeError("boom")

    async def noop() -> dict[str, Any]:
        return {"ok": True}

    spec = ServiceSpec(
        id="boom",
        requires=(),
        gate=None,
        start=boom,
        stop=noop,
        critical=False,
        restart=True,
    )

    async def scenario() -> None:
        orch = Orchestrator(
            spec_provider=lambda: (spec,),
            config_provider=lambda: SimpleNamespace(_data={}),
            spawn_grace_s=0.05,
        )
        entry = await orch.start("boom")
        assert entry["state"] == "failed"
        assert entry["reason_code"] == "spawn_failed"
        assert "boom" in entry["detail"]
        await orch.stop_all()

    asyncio.run(scenario())


def test_gate_failure_maps_to_gate_failed_reason() -> None:
    async def scenario() -> None:
        svc = FakeService(
            "gated", gate=lambda cfg: (False, "python_missing: /nope/python")
        )
        orch = _make([svc])
        try:
            await orch.start_all()
            entry = _entry(orch, "gated")
            assert entry["state"] == "blocked"
            assert entry["reason_code"] == "gate_failed"
            assert "/nope/python" in entry["detail"]
            assert svc.start_calls == 0
        finally:
            await orch.stop_all()

    asyncio.run(scenario())
