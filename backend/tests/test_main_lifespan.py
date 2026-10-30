# -*- coding: utf-8 -*-
"""lifespan 关停契约：服务面 finally + 编排器/内核尾段顺序与失败隔断。"""
import asyncio
import logging
from types import SimpleNamespace

import pytest

import main as main_module
import services.audio_ingest_registry as audio_registry_module
import services.kernel_client as kernel_client
import services.orchestrator.runtime as runtime_module
import services.script_runner as script_runner_module
import services.task_scheduler as task_scheduler_module


class _FakeStore:
    def __init__(self, calls):
        self._calls = calls

    def stop_watcher(self):
        self._calls.append("config_watcher")

    def apply(self, *args, **kwargs):
        self._calls.append("config_apply")


class _FakeStopper:
    def __init__(self, calls, name):
        self._calls = calls
        self._name = name

    async def stop(self):
        self._calls.append(self._name)


class _FakeRegistry:
    def __init__(self, calls):
        self._calls = calls

    def stop_sweeper(self):
        self._calls.append("audio_ingest")


class _FakeOrchestrator:
    def __init__(self, calls, services=(), stop_error=None):
        self._calls = calls
        self._services = list(services)
        self._stop_error = stop_error
        self.timeout = None

    def snapshot(self):
        self._calls.append("orchestrator.snapshot")
        return {"orchestrator": "on", "services": self._services}

    async def stop_all(self, *, timeout=None):
        self._calls.append("orchestrator.stop_all")
        self.timeout = timeout
        if self._stop_error is not None:
            raise self._stop_error


def _forbidden(*args, **kwargs):
    raise AssertionError("关停路径不得创建编排器实例")


def _wire_plane(
    monkeypatch,
    calls,
    *,
    orchestrator_services=(),
    stop_all_error=None,
    orchestrator_exists=True,
):
    store = _FakeStore(calls)
    orchestrator = (
        _FakeOrchestrator(
            calls,
            services=orchestrator_services,
            stop_error=stop_all_error,
        )
        if orchestrator_exists
        else None
    )
    scheduler = _FakeStopper(calls, "scheduler")
    runner = _FakeStopper(calls, "script_runner")
    registry = _FakeRegistry(calls)
    kernel_timeouts = []

    monkeypatch.setattr(
        task_scheduler_module, "get_task_scheduler", lambda: scheduler
    )
    monkeypatch.setattr(script_runner_module, "get_script_runner", lambda: runner)
    monkeypatch.setattr(
        audio_registry_module,
        "peek_audio_ingest_registry",
        lambda: registry,
    )
    monkeypatch.setattr(runtime_module, "peek_orchestrator", lambda: orchestrator)
    monkeypatch.setattr(runtime_module, "get_orchestrator", _forbidden)

    def _stop_kernel(**kwargs):
        calls.append("kernel.stop")
        kernel_timeouts.append(kwargs.get("timeout_s"))
        return {"stopped": False, "reason": "no-pidfile"}

    monkeypatch.setattr(kernel_client, "stop_kernel_process", _stop_kernel)

    app = SimpleNamespace(
        state=SimpleNamespace(
            config_store=store,
            service_plane_stopped=False,
            deferred_integrations_started=False,
        )
    )
    return app, orchestrator, kernel_timeouts


def test_stop_service_plane_stops_orchestrator_then_kernel(monkeypatch):
    calls = []
    app, orchestrator, kernel_timeouts = _wire_plane(monkeypatch, calls)

    asyncio.run(main_module._stop_service_plane(app))

    assert calls == [
        "config_watcher",
        "scheduler",
        "script_runner",
        "audio_ingest",
        "orchestrator.snapshot",
        "orchestrator.stop_all",
        "kernel.stop",
    ]
    assert calls.count("orchestrator.stop_all") == 1
    assert calls.count("kernel.stop") == 1
    assert calls.count("config_apply") == 0
    assert 0 < orchestrator.timeout <= 15.0
    assert 0 < kernel_timeouts[0] <= 15.0
    assert app.state.service_plane_stopped is True


def test_shutdown_without_orchestrator_still_stops_kernel(monkeypatch):
    calls = []
    app, orchestrator, _ = _wire_plane(
        monkeypatch, calls, orchestrator_exists=False
    )

    asyncio.run(main_module._stop_service_plane(app))

    assert orchestrator is None
    assert "orchestrator.stop_all" not in calls
    assert calls.count("kernel.stop") == 1


def test_stop_all_failure_logs_error_and_still_stops_kernel(monkeypatch, caplog):
    calls = []
    app, _, _ = _wire_plane(
        monkeypatch,
        calls,
        stop_all_error=RuntimeError("orchestrator boom"),
    )
    caplog.set_level(logging.ERROR, logger="main")

    asyncio.run(main_module._stop_service_plane(app))

    assert calls.index("orchestrator.stop_all") < calls.index("kernel.stop")
    messages = [
        record.getMessage()
        for record in caplog.records
        if record.levelno == logging.ERROR
    ]
    assert any("orchestrator boom" in message for message in messages), messages


def test_kernel_owned_by_orchestrator_is_not_stopped_twice(monkeypatch):
    calls = []
    app, _, _ = _wire_plane(
        monkeypatch,
        calls,
        orchestrator_services=[
            {"id": "kernel", "state": "ready", "pid": 4321}
        ],
    )

    asyncio.run(main_module._stop_service_plane(app))

    assert "orchestrator.stop_all" in calls
    assert "kernel.stop" not in calls


def test_managed_kernel_still_stopped_directly_after_stop_all_failure(monkeypatch):
    calls = []
    app, _, _ = _wire_plane(
        monkeypatch,
        calls,
        orchestrator_services=[
            {"id": "kernel", "state": "ready", "pid": 4321}
        ],
        stop_all_error=RuntimeError("orchestrator boom"),
    )

    asyncio.run(main_module._stop_service_plane(app))

    assert calls.index("orchestrator.stop_all") < calls.index("kernel.stop")


def test_second_shutdown_is_a_noop(monkeypatch):
    calls = []
    app, _, _ = _wire_plane(monkeypatch, calls)

    asyncio.run(main_module._stop_service_plane(app))
    asyncio.run(main_module._stop_service_plane(app))

    assert calls.count("orchestrator.stop_all") == 1
    assert calls.count("kernel.stop") == 1


class _FakeRuntime:
    def __init__(self, events, *, active=False):
        self.events = events
        self.active = active

    def mark_started(self):
        self.events.append("mark_started")

    async def deactivate(self):
        self.events.append("deactivate")


def _wire_lifespan(monkeypatch, events, *, start_error=None, active=False):
    runtime = _FakeRuntime(events, active=active)
    app = SimpleNamespace(state=SimpleNamespace())

    async def fake_start_core(target):
        target.state.bootstrap_runtime = runtime
        events.append("start_core")

    async def fake_start_plane(target, *args, **kwargs):
        events.append("start_service_plane")
        if start_error is not None:
            raise start_error
        return {}

    monkeypatch.setattr(main_module, "_start_core", fake_start_core)
    monkeypatch.setattr(main_module, "_start_service_plane", fake_start_plane)
    return app


def test_lifespan_deactivates_when_service_plane_start_raises(monkeypatch):
    events = []
    app = _wire_lifespan(
        monkeypatch, events, start_error=RuntimeError("plane boom")
    )

    async def scenario():
        with pytest.raises(RuntimeError, match="plane boom"):
            async with main_module.lifespan(app):
                pass

    asyncio.run(scenario())

    assert events == ["start_core", "start_service_plane", "deactivate"]


def test_lifespan_deactivates_when_yield_body_raises(monkeypatch):
    events = []
    app = _wire_lifespan(monkeypatch, events)

    async def scenario():
        with pytest.raises(RuntimeError, match="body boom"):
            async with main_module.lifespan(app):
                events.append("body")
                raise RuntimeError("body boom")

    asyncio.run(scenario())

    assert events == [
        "start_core",
        "start_service_plane",
        "mark_started",
        "body",
        "deactivate",
    ]


def test_lifespan_starts_plane_even_when_runtime_reports_active(monkeypatch):
    events = []
    app = _wire_lifespan(monkeypatch, events, active=True)

    async def scenario():
        async with main_module.lifespan(app):
            events.append("body")

    asyncio.run(scenario())

    assert events == [
        "start_core",
        "start_service_plane",
        "mark_started",
        "body",
        "deactivate",
    ]
