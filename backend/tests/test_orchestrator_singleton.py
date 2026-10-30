# -*- coding: utf-8 -*-
"""Orchestrator 单实例保证的并发证明（任务 16）。

本文件独立于 ``test_orchestrator_runtime.py``，专门证明「同一服务绝不被
并发拉起两次」：

1. 10 个并发 ``start`` 只调用一次 ``spec.start``，最终只有一个真实 PID；
2. ``spec.start`` 返回 pid 前注入 200ms 延迟，仍然只 spawn 一次；
3. 并发 ``stop`` + ``start`` 结束后状态自洽，存活 PID 不超过一个；
4. 两个不同服务可以同时启动（锁按服务粒度，不是全局锁）。

所有用例用 ``sys.executable -c`` 起真实长驻脚本，pid 是真实进程，用
``ps`` 与 ``os.kill(pid, 0)`` 双重核验。每个用例在 ``finally`` 里先走
``stop_all``，再按精确 PID 兜底清理；绝不按进程名批杀。
"""
from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import sys
import time
from types import SimpleNamespace
from typing import Any, Callable

from services.orchestrator.runtime import Orchestrator
from services.orchestrator.spec import ServiceSpec

_MARKER_PREFIX = "axeuh-orchestrator-task16"
_FAST_GRACE = 0.1
_FAST_BACKOFF = (0.01, 0.01, 0.01, 0.01, 0.01)


def _script(marker: str) -> str:
    """长驻脚本；marker 只存在于 argv，便于用 ps 精确计数。"""
    return (
        "import time\n"
        "MARKER = %r\n"
        "while True:\n"
        "    time.sleep(0.05)\n" % marker
    )


def _alive(pid: int | None) -> bool:
    """POSIX 存活判定；僵尸进程视为已死（与 runtime._pid_alive 同口径）。"""
    if pid is None or pid <= 0:
        return False
    if os.name != "nt":
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


def _ps_available() -> bool:
    return os.name != "nt" and shutil.which("ps") is not None


def _ps_rows(pids: list[int]) -> dict[int, str]:
    """按精确 PID 查询 ps，返回 ``{pid: stat+args}``；只读，不杀进程。"""
    if not pids or not _ps_available():
        return {}
    completed = subprocess.run(
        [
            "ps",
            "-ww",
            "-o",
            "pid=,stat=,args=",
            "-p",
            ",".join(str(p) for p in pids),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    rows: dict[int, str] = {}
    for line in completed.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        pid_text, _, rest = line.partition(" ")
        try:
            rows[int(pid_text)] = rest.strip()
        except ValueError:
            continue
    return rows


def _ps_marker_pids(marker: str) -> set[int]:
    """全表扫描 argv 中的唯一 marker，返回匹配 PID 集合。"""
    if not _ps_available():
        return set()
    completed = subprocess.run(
        ["ps", "-ww", "-eo", "pid=,args="],
        capture_output=True,
        text=True,
        check=False,
    )
    matched: set[int] = set()
    for line in completed.stdout.splitlines():
        line = line.strip()
        if not line or marker not in line:
            continue
        pid_text, _, _ = line.partition(" ")
        try:
            matched.add(int(pid_text))
        except ValueError:
            continue
    return matched


def _live_pids(services: list["FakeService"]) -> list[int]:
    return [
        proc.pid
        for service in services
        for proc in service.spawns
        if proc.pid is not None and _alive(proc.pid)
    ]


class FakeService:
    """把真实子进程封装成 ``ServiceSpec`` 所需的异步起停动作。"""

    def __init__(
        self,
        service_id: str,
        *,
        spawn_delay: float = 0.0,
        restart: bool = True,
    ) -> None:
        self.service_id = service_id
        self.spawn_delay = spawn_delay
        self.restart = restart
        self.marker = "%s-%s" % (_MARKER_PREFIX, service_id)
        self.start_calls = 0
        self.stop_calls = 0
        self.spawns: list[asyncio.subprocess.Process] = []
        self.spawn_monotonic: list[float] = []

    @property
    def pid(self) -> int | None:
        return self.spawns[-1].pid if self.spawns else None

    def spec(self) -> ServiceSpec:
        return ServiceSpec(
            id=self.service_id,
            requires=(),
            gate=None,
            start=self.start,
            stop=self.stop,
            critical=False,
            restart=self.restart,
            enable_key=None,
        )

    async def start(self) -> dict[str, Any]:
        self.start_calls += 1
        if self.spawn_delay > 0:
            await asyncio.sleep(self.spawn_delay)
        proc = await asyncio.create_subprocess_exec(
            sys.executable,
            "-c",
            _script(self.marker),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        self.spawns.append(proc)
        self.spawn_monotonic.append(time.monotonic())
        return {"ok": True, "pid": proc.pid, "process": proc}

    async def stop(self) -> dict[str, Any]:
        self.stop_calls += 1
        proc = self.spawns[-1] if self.spawns else None
        if proc is not None and proc.returncode is None:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                proc.kill()
                await asyncio.wait_for(proc.wait(), timeout=2.0)
        return {"ok": True}


def _make(
    services: list[FakeService], **overrides: Any
) -> Orchestrator:
    options: dict[str, Any] = {
        "spec_provider": lambda: tuple(s.spec() for s in services),
        "config_provider": lambda: SimpleNamespace(_data={}),
        "env": {"AXEUH_ORCHESTRATOR": "on"},
        "spawn_grace_s": _FAST_GRACE,
        "backoff": _FAST_BACKOFF,
        "poll_interval_s": 0.01,
        "stop_timeout_s": 2.0,
        "kill_grace_s": 0.2,
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


async def _wait_settled(
    orch: Orchestrator, service_id: str, timeout: float = 6.0
) -> dict[str, Any]:
    """等待占位集合清空且状态不再处于 starting/stopping。"""

    def settled(entry: dict[str, Any]) -> bool:
        if service_id in orch._starting or service_id in orch._stopping:
            return False
        return entry["state"] not in ("starting", "stopping")

    return await _wait_entry(orch, service_id, settled, timeout)


async def _cleanup(orch: Orchestrator, services: list[FakeService]) -> None:
    """先走运行时停止路径，再按精确 PID 兜底；任何异常都不外抛。"""
    try:
        await asyncio.wait_for(orch.stop_all(), timeout=8.0)
    except Exception:
        pass
    for service in services:
        for proc in service.spawns:
            if proc.returncode is not None:
                continue
            try:
                proc.terminate()
            except ProcessLookupError:
                continue
            except Exception:
                pass
            try:
                await asyncio.wait_for(proc.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
                try:
                    await asyncio.wait_for(proc.wait(), timeout=2.0)
                except asyncio.TimeoutError:
                    pass
            except ProcessLookupError:
                pass


def _assert_cleaned(services: list[FakeService]) -> None:
    leaked = [p.pid for s in services for p in s.spawns if _alive(p.pid)]
    assert not leaked, "子进程未清理: %s" % leaked


def _log_ps(label: str, services: list[FakeService]) -> list[int]:
    """打印 ps 证据并返回当前存活 PID。"""
    live = _live_pids(services)
    rows = _ps_rows(live)
    for pid in live:
        print("QA[%s] ps pid=%d %s" % (label, pid, rows.get(pid, "<no row>")))
    print(
        "QA[%s] live_pid_count=%d pids=%s"
        % (label, len(live), sorted(live))
    )
    return live


# ── 1. 10 并发 start：只 spawn 一次 ──────────────────────────


def test_ten_concurrent_starts_spawn_exactly_once() -> None:
    async def scenario() -> None:
        svc = FakeService("alpha")
        orch = _make([svc])
        try:
            results = await asyncio.gather(
                *[orch.start("alpha") for _ in range(10)]
            )
            assert svc.start_calls == 1, svc.start_calls
            assert len(svc.spawns) == 1, len(svc.spawns)
            ready = await _wait_entry(
                orch, "alpha", lambda e: e["state"] == "ready"
            )
            pid = svc.spawns[0].pid
            assert ready["pid"] == pid
            assert {item["pid"] for item in results} <= {None, pid}
            assert sum(1 for item in results if item["pid"] == pid) == 1

            live = _log_ps("10x-concurrent-start", [svc])
            assert live == [pid], live
            rows = _ps_rows(live)
            assert len(rows) == 1, rows
            if _ps_available():
                assert _ps_marker_pids(svc.marker) == {pid}
        finally:
            await _cleanup(orch, [svc])
        _assert_cleaned([svc])

    asyncio.run(scenario())


# ── 2. spec.start 内 200ms 延迟：仍只 spawn 一次 ─────────────


def test_delayed_start_still_spawns_exactly_once() -> None:
    async def scenario() -> None:
        svc = FakeService("slow", spawn_delay=0.2)
        orch = _make([svc])
        try:
            started = time.monotonic()
            await asyncio.gather(*[orch.start("slow") for _ in range(10)])
            elapsed = time.monotonic() - started
            assert svc.start_calls == 1, svc.start_calls
            assert len(svc.spawns) == 1, len(svc.spawns)
            assert len(svc.spawn_monotonic) == 1
            assert elapsed >= 0.2, elapsed
            ready = await _wait_entry(
                orch, "slow", lambda e: e["state"] == "ready"
            )
            pid = svc.spawns[0].pid
            assert ready["pid"] == pid

            live = _log_ps("200ms-delay-start", [svc])
            assert live == [pid], live
            assert len(_ps_rows(live)) == 1
            if _ps_available():
                assert _ps_marker_pids(svc.marker) == {pid}
        finally:
            await _cleanup(orch, [svc])
        _assert_cleaned([svc])

    asyncio.run(scenario())


# ── 3. 并发 stop + start：状态自洽，最多一个存活 PID ─────────


def test_concurrent_stop_and_start_leaves_consistent_state() -> None:
    async def scenario() -> None:
        svc = FakeService("race")
        orch = _make([svc])
        try:
            await orch.start("race")
            first = await _wait_entry(
                orch, "race", lambda e: e["state"] == "ready"
            )
            old_pid = first["pid"]
            assert old_pid is not None

            await asyncio.gather(orch.stop("race"), orch.start("race"))
            entry = await _wait_settled(orch, "race")
            live = _log_ps("stop-start-race", [svc])

            assert entry["state"] in ("ready", "stopped"), entry
            assert svc.stop_calls == 1, svc.stop_calls
            assert len(live) <= 1, live
            assert len(_ps_rows(live)) == len(live)
            if entry["state"] == "ready":
                assert entry["pid"] is not None
                assert live == [entry["pid"]], (live, entry)
                assert _alive(old_pid) is False
            else:
                assert live == [], live
                assert _alive(old_pid) is False
            if _ps_available():
                assert _ps_marker_pids(svc.marker) == set(live)
            assert len(svc.spawns) <= 2, len(svc.spawns)
        finally:
            await _cleanup(orch, [svc])
        _assert_cleaned([svc])

    asyncio.run(scenario())


def test_stop_during_inflight_spawn_leaves_no_live_pid() -> None:
    async def scenario() -> None:
        svc = FakeService("inflight", spawn_delay=0.2)
        orch = _make([svc])
        try:
            start_task = asyncio.create_task(orch.start("inflight"))
            await asyncio.sleep(0.06)
            assert svc.start_calls == 1
            assert len(svc.spawns) == 0

            stop_task = asyncio.create_task(orch.stop("inflight"))
            await asyncio.gather(start_task, stop_task)
            entry = await _wait_settled(orch, "inflight")
            live = _log_ps("stop-during-inflight-spawn", [svc])

            assert entry["state"] == "stopped", entry
            assert svc.stop_calls == 1, svc.stop_calls
            assert live == [], live
            assert len(svc.spawns) == 1, len(svc.spawns)
            assert _ps_rows(_live_pids([svc])) == {}
            if _ps_available():
                assert _ps_marker_pids(svc.marker) == set()
        finally:
            await _cleanup(orch, [svc])
        _assert_cleaned([svc])

    asyncio.run(scenario())


# ── 4. 两个服务并发启动：锁是每服务粒度 ─────────────────────


def test_two_services_start_concurrently() -> None:
    async def scenario() -> None:
        first = FakeService("svc-a", spawn_delay=0.3)
        second = FakeService("svc-b", spawn_delay=0.3)
        orch = _make([first, second])
        try:
            started = time.monotonic()
            await asyncio.gather(
                orch.start("svc-a"), orch.start("svc-b")
            )
            elapsed = time.monotonic() - started
            assert first.start_calls == 1
            assert second.start_calls == 1
            assert len(first.spawns) == 1
            assert len(second.spawns) == 1

            delta = abs(
                first.spawn_monotonic[0] - second.spawn_monotonic[0]
            )
            assert delta < 0.15, delta
            assert elapsed < 0.55, elapsed

            ready_a = await _wait_entry(
                orch, "svc-a", lambda e: e["state"] == "ready"
            )
            ready_b = await _wait_entry(
                orch, "svc-b", lambda e: e["state"] == "ready"
            )
            assert ready_a["pid"] == first.spawns[0].pid
            assert ready_b["pid"] == second.spawns[0].pid

            live = _log_ps("two-services-concurrent", [first, second])
            assert sorted(live) == sorted(
                [first.spawns[0].pid, second.spawns[0].pid]
            )
            assert len(_ps_rows(live)) == 2
            if _ps_available():
                assert _ps_marker_pids(first.marker) == {
                    first.spawns[0].pid
                }
                assert _ps_marker_pids(second.marker) == {
                    second.spawns[0].pid
                }
        finally:
            await _cleanup(orch, [first, second])
        _assert_cleaned([first, second])

    asyncio.run(scenario())
