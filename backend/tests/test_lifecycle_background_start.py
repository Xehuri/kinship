# -*- coding: utf-8 -*-
"""T44：``start_all`` 后台化后的 lifespan 启动/关停契约。

覆盖四类风险：

1. 慢启动 spec 不再阻塞 ``_start_service_plane``（冷启动 60s 预算）；
2. ``start_all`` 后台任务抛异常时 lifespan 与 ``/health`` 不受影响；
3. 在途启动期间关停会先取消任务再 ``stop_all``，不遗留孤儿进程；
4. lifespan 返回后 ``/api/services`` 立即可读并显示 ``starting``。

另附两条 spec 级取消安全用例：Loom 在健康等待中被取消、MOSS 在 spawn
落地前被取消，都必须按精确 PID 回收已创建的子进程。
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import signal
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import main as main_module
import services.audio_ingest_registry as audio_registry_module
import services.kernel_client as kernel_client
import services.loom_runtime as rt
import services.orchestrator.runtime as runtime_module
import services.script_runner as script_runner_module
import services.task_scheduler as task_scheduler_module
from config.config import Config
from services.orchestrator import loom_spec, moss_spec
from services.orchestrator.runtime import (
    ORCHESTRATOR_ENV,
    get_orchestrator,
    reset_orchestrator,
)
from services.orchestrator.spec import (
    ServiceSpec,
    clear_registry,
    register,
)

_LONG_RUNNING = "import time\nwhile True:\n    time.sleep(0.05)\n"
_POSIX_ONLY = pytest.mark.skipif(
    os.name == "nt", reason="精确 PID 判活用例只在 POSIX 上运行"
)


def _alive(pid: int | None) -> bool:
    if not isinstance(pid, int) or pid <= 0:
        return False
    if os.name != "nt":
        try:
            with open(f"/proc/{pid}/stat", "r", encoding="utf-8") as fh:
                return fh.read().split()[2] != "Z"
        except OSError:
            return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _wait_dead(pid: int | None, timeout: float = 5.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not _alive(pid):
            return True
        time.sleep(0.02)
    return not _alive(pid)


class _FakeStore:
    def __init__(self) -> None:
        self.watcher_started = False
        self.watcher_stopped = False

    def start_watcher(self, loop=None) -> None:
        self.watcher_started = True

    def stop_watcher(self) -> None:
        self.watcher_stopped = True

    def apply(self, *args, **kwargs) -> None:
        return None


class _FakeStopper:
    def __init__(self) -> None:
        self.start_calls = 0
        self.stop_calls = 0
        self.paused = False

    def set_paused(self, paused: bool) -> None:
        self.paused = paused

    def is_paused(self) -> bool:
        return self.paused

    async def start(self) -> None:
        self.start_calls += 1

    async def stop(self) -> None:
        self.stop_calls += 1


class _FakeRegistry:
    def __init__(self) -> None:
        self.sweeper_started = False
        self.sweeper_stopped = False

    def set_sweep_sink(self, sink) -> None:
        self.sink = sink

    def start_sweeper(self) -> None:
        self.sweeper_started = True

    def stop_sweeper(self) -> None:
        self.sweeper_stopped = True


class _SlowSpec:
    """真实拉起长驻子进程、但延迟返回 pid 的 spec（模拟 Loom 健康等待）。"""

    def __init__(self, delay: float = 45.0) -> None:
        self.delay = delay
        self.started = asyncio.Event()
        self.child_ready = asyncio.Event()
        self.child_pid: int | None = None
        self.process = None
        self.stop_calls = 0
        self.cancelled = False

    async def start(self) -> dict:
        self.started.set()
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-c", _LONG_RUNNING
        )
        self.process = process
        self.child_pid = process.pid
        self.child_ready.set()
        try:
            await asyncio.sleep(self.delay)
        except asyncio.CancelledError:
            self.cancelled = True
            await self._kill_child()
            raise
        return {"pid": process.pid, "process": process}

    async def _kill_child(self) -> int | None:
        process = self.process
        pid = self.child_pid
        self.process = None
        self.child_pid = None
        if process is not None and process.returncode is None:
            try:
                process.terminate()
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(process.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
                await process.wait()
        return pid

    async def stop(self) -> dict:
        self.stop_calls += 1
        pid = await self._kill_child()
        return {"stopped": pid is not None, "pid": pid}


def _slow_spec(delay: float = 45.0):
    slow = _SlowSpec(delay=delay)

    async def stop() -> dict:
        return await slow.stop()

    spec = ServiceSpec(
        id="slow",
        requires=(),
        gate=None,
        start=slow.start,
        stop=stop,
        critical=False,
        restart=False,
    )
    return spec, slow


@pytest.fixture
def orchestrator_on(monkeypatch):
    monkeypatch.setenv(ORCHESTRATOR_ENV, "on")
    reset_orchestrator()
    clear_registry()
    yield
    reset_orchestrator()
    clear_registry()


def _register_spec_via_main(monkeypatch, spec: ServiceSpec) -> None:
    def _register() -> None:
        clear_registry()
        register(spec)

    monkeypatch.setattr(main_module, "_register_orchestrator_specs", _register)


def _wire_plane(monkeypatch):
    cfg = Config(
        {
            "audio_compressor": {"enabled": False},
            "unknown_speaker": {"enabled": False},
        }
    )
    store = _FakeStore()
    scheduler = _FakeStopper()
    runner = _FakeStopper()
    registry = _FakeRegistry()

    monkeypatch.setattr(main_module, "get_config", lambda: cfg)
    monkeypatch.setattr(main_module, "get_config_store", lambda: store)
    monkeypatch.setattr(
        main_module, "register_default_appliers", lambda *a, **k: []
    )
    monkeypatch.setattr(
        task_scheduler_module, "get_task_scheduler", lambda: scheduler
    )
    monkeypatch.setattr(
        script_runner_module, "get_script_runner", lambda: runner
    )
    monkeypatch.setattr(
        audio_registry_module,
        "get_audio_ingest_registry",
        lambda: registry,
    )
    monkeypatch.setattr(
        audio_registry_module,
        "peek_audio_ingest_registry",
        lambda: registry,
    )
    monkeypatch.setattr(
        kernel_client,
        "stop_kernel_process",
        lambda **kwargs: {"stopped": False, "reason": "no-pidfile"},
    )

    async def _deferred(target, report) -> None:
        target.state.deferred_integrations_started = True

    monkeypatch.setattr(main_module, "_start_deferred_integrations", _deferred)

    # conftest 已把 main 的 init_* 换成长生命周期 mock；这里只包一层可观测
    # 的调度器/runner，验证服务面其他部分仍按原顺序启停。
    monkeypatch.setattr(main_module, "init_task_executor", lambda: SimpleNamespace(
        execute=lambda *a, **k: None
    ))
    monkeypatch.setattr(
        main_module,
        "init_task_scheduler",
        lambda execute_callback=None: scheduler,
    )
    monkeypatch.setattr(main_module, "init_script_runner", lambda: runner)

    app = SimpleNamespace(state=SimpleNamespace(config_store=store))
    return SimpleNamespace(
        app=app,
        store=store,
        scheduler=scheduler,
        runner=runner,
        registry=registry,
    )


@_POSIX_ONLY
def test_start_service_plane_returns_before_slow_spec_finishes(
    orchestrator_on, monkeypatch
):
    wiring = _wire_plane(monkeypatch)

    async def scenario():
        spec, slow = _slow_spec(delay=45.0)
        _register_spec_via_main(monkeypatch, spec)
        started = time.monotonic()
        report = await main_module._start_service_plane(wiring.app)
        elapsed = time.monotonic() - started

        assert elapsed < 5.0, elapsed
        assert report["subsystems"]["orchestrator"] == "ok"
        task = wiring.app.state.orchestrator_start_task
        assert isinstance(task, asyncio.Task)
        assert not task.done()

        await asyncio.wait_for(slow.child_ready.wait(), timeout=5.0)
        pid = slow.child_pid
        assert _alive(pid)

        await main_module._stop_service_plane(wiring.app)

        assert task.done() and task.cancelled()
        assert slow.cancelled is True
        assert _wait_dead(pid)
        assert wiring.store.watcher_stopped is True

    asyncio.run(scenario())


@_POSIX_ONLY
def test_shutdown_during_in_flight_start_cancels_then_stops_all(
    orchestrator_on, monkeypatch
):
    wiring = _wire_plane(monkeypatch)

    async def scenario():
        spec, slow = _slow_spec(delay=45.0)
        _register_spec_via_main(monkeypatch, spec)
        await main_module._start_service_plane(wiring.app)
        task = wiring.app.state.orchestrator_start_task
        await asyncio.wait_for(slow.child_ready.wait(), timeout=5.0)
        pid = slow.child_pid
        assert _alive(pid)

        orchestrator = get_orchestrator()
        stop_all_calls: list[float | None] = []
        original_stop_all = orchestrator.stop_all

        async def spy_stop_all(*, timeout=None):
            stop_all_calls.append(timeout)
            return await original_stop_all(timeout=timeout)

        monkeypatch.setattr(orchestrator, "stop_all", spy_stop_all)

        await main_module._stop_service_plane(wiring.app)

        assert task.done() and task.cancelled()
        assert len(stop_all_calls) == 1
        assert slow.cancelled is True
        assert _wait_dead(pid)
        assert get_orchestrator().snapshot()["services"][0]["state"] == "stopped"

    asyncio.run(scenario())


def test_fake_spec_start_failure_keeps_lifespan_and_health_alive(
    orchestrator_on, monkeypatch, caplog
):
    async def exploding_start() -> dict:
        raise RuntimeError("fake spec boom")

    async def noop_stop() -> dict:
        return {"stopped": False}

    spec = ServiceSpec(
        id="boom",
        requires=(),
        gate=None,
        start=exploding_start,
        stop=noop_stop,
        critical=False,
        restart=False,
    )
    _register_spec_via_main(monkeypatch, spec)
    caplog.set_level(logging.INFO)

    with TestClient(main_module.app) as client:
        assert client.get("/health").status_code == 200
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            if any(
                "boom 启动失败" in record.getMessage()
                for record in caplog.records
            ):
                break
            time.sleep(0.02)
        messages = [record.getMessage() for record in caplog.records]
        assert any("boom 启动失败" in message for message in messages), messages
        assert client.get("/health").status_code == 200


def test_background_start_all_exception_is_logged_not_raised(
    orchestrator_on, monkeypatch, caplog
):
    class _RaisingOrchestrator:
        enabled = True

        def __init__(self) -> None:
            self.stop_all_calls = 0

        def snapshot(self) -> dict:
            return {"orchestrator": "on", "services": []}

        def on_state_change(self, callback):
            return lambda: None

        async def start_all(self) -> list:
            raise RuntimeError("start_all boom")

        async def stop_all(self, *, timeout=None) -> list:
            self.stop_all_calls += 1
            return []

    stub = _RaisingOrchestrator()
    monkeypatch.setattr(
        main_module, "_register_orchestrator_specs", lambda: None
    )
    monkeypatch.setattr(runtime_module, "get_orchestrator", lambda: stub)
    monkeypatch.setattr(runtime_module, "peek_orchestrator", lambda: stub)
    caplog.set_level(logging.INFO)

    with TestClient(main_module.app) as client:
        assert client.get("/health").status_code == 200
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            if any(
                "start_all 失败" in record.getMessage()
                for record in caplog.records
            ):
                break
            time.sleep(0.02)
        messages = [record.getMessage() for record in caplog.records]
        assert any("start_all 失败" in message for message in messages), messages

    assert stub.stop_all_calls == 1


def test_services_api_readable_right_after_startup_with_starting_state(
    orchestrator_on, monkeypatch
):
    spec, slow = _slow_spec(delay=30.0)
    _register_spec_via_main(monkeypatch, spec)

    started = time.monotonic()
    client = TestClient(main_module.app)
    with client:
        elapsed = time.monotonic() - started
        assert elapsed < 5.0, elapsed
        login = client.post(
            "/login", json={"username": "Axeuh", "password": "test-password-123"}
        )
        assert login.status_code == 200, login.text
        headers = {"Authorization": f"Bearer {login.json()['token']}"}
        main_module.app.state.onboarding_state_completed = True

        entry = None
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            response = client.get("/api/services", headers=headers)
            assert response.status_code == 200, response.text
            body = response.json()
            assert body["orchestrator"] == "on"
            entry = next(
                item for item in body["services"] if item["id"] == "slow"
            )
            if entry["state"] == "starting":
                break
            time.sleep(0.02)

        assert entry is not None
        assert entry["state"] == "starting"
        assert entry["pid"] is None

    assert slow.cancelled is True


@_POSIX_ONLY
def test_loom_start_cancelled_during_health_wait_kills_child(
    monkeypatch, tmp_path
):
    cfg = Config(
        {
            "ai_backend": "loom",
            "loom": {"url": "http://127.0.0.1:5100", "token": "tok"},
            "data": {"ai_root": str(tmp_path / "ai")},
        }
    )
    config_path = Path(cfg.AI_ROOT) / ".loom" / "config.yaml"
    config_path.parent.mkdir(parents=True)
    config_path.write_text("server:\n  port: 5100\n", encoding="utf-8")
    cli = tmp_path / "cli.js"
    cli.write_text("// built\n", encoding="utf-8")
    child_ready = asyncio.Event()
    pids: list[int] = []

    async def fake_spawn(*argv, **kwargs):
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-c", _LONG_RUNNING
        )
        pids.append(process.pid)
        child_ready.set()
        return process

    async def slow_health(config, token, *, timeout):
        await asyncio.sleep(30.0)

    monkeypatch.setattr(loom_spec, "get_config", lambda: cfg)
    monkeypatch.setattr(loom_spec, "_create_subprocess_exec", fake_spawn)
    monkeypatch.setattr(
        loom_spec, "child_log_path", lambda: tmp_path / "loom-child.log"
    )
    monkeypatch.setattr(
        rt,
        "_child_spawn_errors",
        lambda config: (["/usr/bin/node", str(cli), "serve"], 5100, "127.0.0.1", ""),
    )
    monkeypatch.setattr(rt, "_config_path", lambda config: config_path)
    monkeypatch.setattr(rt, "_port_in_use", lambda port, host: False)
    monkeypatch.setattr(
        rt,
        "_ensure_token_internal",
        lambda config: SimpleNamespace(token="tok", public={}),
    )
    monkeypatch.setattr(rt, "_wait_health", slow_health)
    monkeypatch.setattr(rt, "_which", lambda name: "/usr/bin/node")
    monkeypatch.setattr(rt, "_cli_path", lambda: cli)
    monkeypatch.setattr(rt, "_data_root", lambda: tmp_path / "var")
    monkeypatch.setattr(loom_spec, "DRAIN_TIMEOUT_S", 1.0)
    monkeypatch.setattr(loom_spec, "KILL_GRACE_S", 1.0)

    async def scenario():
        loom_spec._reset_state()
        task = asyncio.create_task(loom_spec.build_loom_spec().start())
        await asyncio.wait_for(child_ready.wait(), timeout=5.0)
        pid = pids[0]
        assert _alive(pid)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert _wait_dead(pid)
        assert loom_spec._STATE.pid is None

    try:
        asyncio.run(scenario())
    finally:
        loom_spec._reset_state()


@_POSIX_ONLY
def test_moss_start_cancelled_during_spawn_kills_created_child(
    monkeypatch, tmp_path
):
    cfg = Config({"moss": {"enabled": True, "python": sys.executable}})
    child_ready = asyncio.Event()
    pids: list[int] = []

    async def fake_spawn(*argv, **kwargs):
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-c", _LONG_RUNNING
        )
        pids.append(process.pid)
        child_ready.set()
        await asyncio.sleep(0.3)
        return process

    monkeypatch.setattr(moss_spec, "get_config", lambda: cfg)
    monkeypatch.setattr(moss_spec, "project_root", lambda: tmp_path)
    monkeypatch.setattr(moss_spec, "_create_subprocess_exec", fake_spawn)
    monkeypatch.setattr(moss_spec, "KILL_GRACE_S", 1.0)

    async def scenario():
        moss_spec._reset_state()
        task = asyncio.create_task(moss_spec.build_moss_spec().start())
        await asyncio.wait_for(child_ready.wait(), timeout=5.0)
        pid = pids[0]
        assert _alive(pid)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert _wait_dead(pid)
        assert moss_spec._STATE.pid is None

    try:
        asyncio.run(scenario())
    finally:
        moss_spec._reset_state()


@_POSIX_ONLY
def test_kernel_spec_start_is_async_and_reports_starting_then_ready(
    orchestrator_on, monkeypatch
):
    """T45：内核握手在途时事件循环必须持续推进，状态 starting -> ready。"""
    from services.orchestrator import kernel_spec

    state = {"pid": 0}
    monkeypatch.setattr(
        kernel_client, "_read_pidfile", lambda state_dir: dict(state)
    )
    monkeypatch.setattr(
        kernel_client, "stop_kernel_process", lambda **kwargs: {"stopped": False}
    )
    monkeypatch.setattr(runtime_module, "SPAWN_GRACE_S", 0.2)

    ticks: list = []

    async def scenario():
        child = await asyncio.create_subprocess_exec(
            sys.executable, "-c", _LONG_RUNNING
        )
        state["pid"] = child.pid
        started = asyncio.Event()

        class _StubClient:
            adopted = False
            base_url = "http://127.0.0.1:55555"
            _state_dir = None

            async def ensure_async(self) -> None:
                started.set()
                await asyncio.sleep(2.0)

            def ensure(self) -> None:  # pragma: no cover - 命中即失败
                raise AssertionError("编排器不得调用同步 ensure()")

        monkeypatch.setattr(
            kernel_client, "get_kernel_client", lambda: _StubClient()
        )
        clear_registry()
        register(kernel_spec.build_kernel_spec())
        orchestrator = get_orchestrator()
        task = asyncio.create_task(orchestrator.start_all())
        await asyncio.wait_for(started.wait(), timeout=5.0)

        mid = {
            entry["id"]: entry for entry in orchestrator.snapshot()["services"]
        }
        while not task.done():
            ticks.append(time.monotonic())
            await asyncio.sleep(0.01)
        await task
        final = {
            entry["id"]: entry for entry in orchestrator.snapshot()["services"]
        }

        await orchestrator.stop_all(timeout=5.0)
        with contextlib.suppress(ProcessLookupError):
            os.kill(child.pid, signal.SIGKILL)
        await child.wait()
        return mid, final, child.pid

    try:
        mid, final, pid = asyncio.run(scenario())
        assert mid["kernel"]["state"] == "starting"
        assert len(ticks) >= 100, (
            "内核握手期间事件循环被阻塞：只推进了 %d 次" % len(ticks)
        )
        assert final["kernel"]["state"] == "ready", final["kernel"]
        assert final["kernel"]["pid"] == pid
    finally:
        if state["pid"]:
            with contextlib.suppress(ProcessLookupError, OSError):
                os.kill(int(state["pid"]), signal.SIGKILL)
