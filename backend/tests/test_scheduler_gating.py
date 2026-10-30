# -*- coding: utf-8 -*-
"""TaskScheduler 业务就绪门控（任务 18）。

验收语义：
- 没有 critical 服务 ready 时保持 ``set_paused(True)``，到期任务不派发；
- 任一 critical 服务 ready 后恢复 ``set_paused(False)``；
- 可选服务（moss/qq/loom）的 ready/failed 变化不改变暂停状态；
- 门控完全由 ``Orchestrator.on_state_change`` 回调驱动，没有轮询。
"""
from __future__ import annotations

import asyncio
from typing import Any

import pytest

from config.config import Config
from services.orchestrator.runtime import ORCHESTRATOR_ENV, Orchestrator
from services.orchestrator.spec import ServiceSpec
from services.scheduler_gating import (
    bind_scheduler_gating,
    critical_ready,
)
from services.task_scheduler import TaskScheduler
from services.task_storage import TaskStorage


class _FakeOrchestrator:
    """最小回调契约替身：记录回调并支持手动状态迁移。"""

    def __init__(
        self, services: list[dict[str, Any]], *, enabled: bool = True
    ) -> None:
        self.services = [dict(entry) for entry in services]
        self.enabled = enabled
        self.callbacks: list[Any] = []
        self.snapshot_calls = 0

    def snapshot(self) -> dict[str, Any]:
        self.snapshot_calls += 1
        return {
            "orchestrator": "on" if self.enabled else "off",
            "services": [dict(entry) for entry in self.services],
        }

    def on_state_change(self, callback: Any) -> Any:
        self.callbacks.append(callback)

        def _unsubscribe() -> None:
            self.callbacks.remove(callback)

        return _unsubscribe

    def transition(self, service_id: str, state: str) -> None:
        for entry in self.services:
            if entry["id"] == service_id:
                entry["state"] = state
        payload = {"id": service_id, "state": state}
        for callback in tuple(self.callbacks):
            callback(payload)


def _entry(service_id: str, state: str, *, critical: bool) -> dict[str, Any]:
    return {
        "id": service_id,
        "state": state,
        "reason_code": "missing_config" if state == "blocked" else "",
        "critical": critical,
    }


@pytest.fixture
def scheduler(tmp_path) -> TaskScheduler:
    return TaskScheduler(task_storage=TaskStorage(data_dir=str(tmp_path)))


async def _pump_until_idle(sched: TaskScheduler, timeout: float = 2.0) -> None:
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while sched._pending_tasks and loop.time() < end:
        await asyncio.sleep(0.01)
    assert not sched._pending_tasks


def test_all_services_blocked_pauses_and_skips_due_tasks(
    scheduler: TaskScheduler,
) -> None:
    async def scenario() -> None:
        hits: list[int] = []

        async def callback() -> None:
            hits.append(1)

        task = scheduler.register_builtin(
            "gating_blocked_probe", "daily 03:00", callback
        )
        task.next_run = 1.0
        orchestrator = _FakeOrchestrator(
            [
                _entry("kernel", "blocked", critical=True),
                _entry("moss_watcher", "blocked", critical=False),
                _entry("loom", "blocked", critical=False),
            ]
        )

        unsubscribe = bind_scheduler_gating(orchestrator, scheduler)

        assert scheduler.is_paused() is True
        assert len(orchestrator.callbacks) == 1

        await scheduler._check_tasks()
        await _pump_until_idle(scheduler)

        assert hits == []
        assert task.run_count == 0

        unsubscribe()
        assert orchestrator.callbacks == []

    asyncio.run(scenario())


def test_critical_ready_resumes_and_optional_changes_do_not_flip(
    scheduler: TaskScheduler,
) -> None:
    async def scenario() -> None:
        orchestrator = _FakeOrchestrator(
            [
                _entry("kernel", "blocked", critical=True),
                _entry("moss_watcher", "blocked", critical=False),
            ]
        )
        bind_scheduler_gating(orchestrator, scheduler)

        assert scheduler.is_paused() is True

        orchestrator.transition("moss_watcher", "ready")
        assert scheduler.is_paused() is True

        orchestrator.transition("kernel", "starting")
        assert scheduler.is_paused() is True

        orchestrator.transition("kernel", "ready")
        assert scheduler.is_paused() is False

        orchestrator.transition("moss_watcher", "failed")
        assert scheduler.is_paused() is False

        orchestrator.transition("moss_watcher", "ready")
        assert scheduler.is_paused() is False

        orchestrator.transition("kernel", "failed")
        assert scheduler.is_paused() is True

    asyncio.run(scenario())


def test_optional_ready_does_not_unpause_while_critical_blocked(
    scheduler: TaskScheduler,
) -> None:
    orchestrator = _FakeOrchestrator(
        [
            _entry("kernel", "blocked", critical=True),
            _entry("moss_watcher", "ready", critical=False),
            _entry("loom", "ready", critical=False),
        ]
    )

    bind_scheduler_gating(orchestrator, scheduler)

    assert scheduler.is_paused() is True
    assert critical_ready(orchestrator.services) is False


def test_gating_uses_state_callback_without_polling(
    scheduler: TaskScheduler,
) -> None:
    async def scenario() -> None:
        orchestrator = _FakeOrchestrator(
            [_entry("kernel", "blocked", critical=True)]
        )
        bind_scheduler_gating(orchestrator, scheduler)

        assert len(orchestrator.callbacks) == 1
        assert scheduler.is_running() is False
        assert scheduler._task is None

        snapshots_after_bind = orchestrator.snapshot_calls
        await asyncio.sleep(0.05)
        assert orchestrator.snapshot_calls == snapshots_after_bind

        orchestrator.transition("kernel", "ready")
        assert scheduler.is_paused() is False
        assert orchestrator.snapshot_calls == snapshots_after_bind + 1

    asyncio.run(scenario())


def test_orchestrator_off_leaves_pause_state_untouched(
    scheduler: TaskScheduler,
) -> None:
    orchestrator = _FakeOrchestrator([], enabled=False)

    scheduler.set_paused(True)
    unsubscribe = bind_scheduler_gating(orchestrator, scheduler)

    assert orchestrator.callbacks == []
    assert scheduler.is_paused() is True
    unsubscribe()

    scheduler.set_paused(False)
    bind_scheduler_gating(orchestrator, scheduler)
    assert scheduler.is_paused() is False


def test_start_all_recomputes_blocked_reasons_and_reapplies() -> None:
    async def scenario() -> None:
        cfg_doc: dict[str, Any] = {"moss": {"enabled": False}}
        start_calls: list[str] = []

        async def start() -> dict[str, Any]:
            start_calls.append("start")
            return {"ok": False, "detail": "qa start probe"}

        async def stop() -> dict[str, Any]:
            return {"ok": True}

        def spec(
            service_id: str,
            *,
            requires: tuple[str, ...] = (),
            critical: bool = False,
            enable_key: str | None = None,
            gate: Any = None,
        ) -> ServiceSpec:
            return ServiceSpec(
                id=service_id,
                requires=requires,
                gate=gate,
                start=start,
                stop=stop,
                critical=critical,
                restart=False,
                enable_key=enable_key,
            )

        specs = (
            spec("kernel", requires=("qa.kernel",), critical=True),
            spec("moss_watcher", enable_key="moss.enabled"),
            spec(
                "loom",
                gate=lambda cfg: (False, "gate_failed: node_missing"),
            ),
        )
        orchestrator = Orchestrator(
            spec_provider=lambda: specs,
            config_provider=lambda: Config(cfg_doc),
            env={ORCHESTRATOR_ENV: "on"},
        )

        first = {entry["id"]: entry for entry in await orchestrator.start_all()}
        assert first["kernel"]["state"] == "blocked"
        assert first["kernel"]["reason_code"] == "missing_config"
        assert first["moss_watcher"]["state"] == "blocked"
        assert first["moss_watcher"]["reason_code"] == "disabled"
        assert first["loom"]["state"] == "blocked"
        assert first["loom"]["reason_code"] == "gate_failed"
        assert start_calls == []

        cfg_doc["qa"] = {"kernel": "present"}
        second = {entry["id"]: entry for entry in await orchestrator.start_all()}

        assert second["kernel"]["state"] == "failed"
        assert second["kernel"]["reason_code"] == "spawn_failed"
        assert start_calls == ["start"]
        assert second["moss_watcher"]["reason_code"] == "disabled"
        assert second["loom"]["reason_code"] == "gate_failed"

    asyncio.run(scenario())
