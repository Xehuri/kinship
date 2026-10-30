# -*- coding: utf-8 -*-
"""Startup validation report and retryable lifecycle.

Covers required/conditional/deferred probe policy, redaction, the
promote-time scheduler rule, and the main.py validation-mode start callback
(deferred integrations stay off until promote).
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

import main as main_module
import services.audio_ingest_registry as audio_registry_module
import services.health_cloud_service as health_cloud_module
import services.onboarding_service as onboarding_service
import services.p2p.manager as p2p_manager_module
import services.qq_gateway.service as qq_service_module
import services.script_runner as script_runner_module
import services.task_scheduler as task_scheduler_module
import services.unknown_speaker_config as unknown_speaker_module
from services.bootstrap_runtime import BootstrapRuntime
from services.startup_validation import (
    DEFERRED_SUBSYSTEMS,
    MODE_VALIDATION,
    REQUIRED_PROBES,
    ProbeResult,
    StartupValidation,
)

CONDITIONALS = ("kernel", "loom")


def _state(
    *,
    completed: tuple[str, ...] = (),
    skipped: tuple[str, ...] = (),
    step_data: dict[str, Any] | None = None,
):
    payload: dict[str, Any] = {
        "completed_steps": list(completed),
        "skipped_steps": list(skipped),
    }
    if step_data is not None:
        payload["step_data"] = step_data
    return lambda: payload


def _config(*, backend: str = "opencode"):
    return lambda: SimpleNamespace(AI_BACKEND=backend)


def _probes(**overrides: Any) -> tuple[dict[str, Any], list[str]]:
    calls: list[str] = []

    def recorder(name: str):
        def probe() -> ProbeResult:
            calls.append(name)
            return ProbeResult(True, f"{name} ok")

        return probe

    probes = {name: recorder(name) for name in REQUIRED_PROBES}
    for name in CONDITIONALS:
        probes[name] = recorder(name)
    probes.update(overrides)
    return probes, calls


def _validation(
    *,
    completed: tuple[str, ...] = (),
    skipped: tuple[str, ...] = (),
    step_data: dict[str, Any] | None = None,
    backend: str = "opencode",
    **overrides: Any,
) -> tuple[StartupValidation, list[str]]:
    probes, calls = _probes(**overrides)
    service = StartupValidation(
        probes,
        state_reader=_state(
            completed=completed, skipped=skipped, step_data=step_data
        ),
        config_reader=_config(backend=backend),
    )
    return service, calls


def test_required_pass_and_unconfigured_conditionals_skip():
    async def scenario():
        service, calls = _validation()
        report = await service.validate()
        assert report["ok"] is True
        assert report["state"] == "validated"
        assert report["mode"] == "validation"
        assert report["deferred"] == list(DEFERRED_SUBSYSTEMS)
        for name in REQUIRED_PROBES:
            assert report["subsystems"][name] == "ok"
        for name in CONDITIONALS:
            assert report["subsystems"][name] == "skipped"
            assert name not in calls
        for name in DEFERRED_SUBSYSTEMS:
            assert report["subsystems"][name] == "deferred"
        assert report["errors"] == []
        assert {check["id"] for check in report["checks"]} >= set(REQUIRED_PROBES)

    asyncio.run(scenario())


def test_required_failure_is_exact_and_redacted():
    async def scenario():
        def broken() -> ProbeResult:
            raise RuntimeError("https://example.test/?token=supersecret")

        service, _ = _validation(scheduler=broken)
        report = await service.validate()
        assert report["ok"] is False
        assert report["state"] == "failed"
        assert report["subsystems"]["scheduler"] == "failed"
        error = next(
            item for item in report["errors"] if item["subsystem"] == "scheduler"
        )
        assert "supersecret" not in error["error"]
        assert "token=***" in error["error"]
        check = next(
            item for item in report["checks"] if item["id"] == "scheduler"
        )
        assert check["status"] == "failed"
        assert check["kind"] == "required"

    asyncio.run(scenario())


def test_kernel_probe_only_when_step_completed_and_not_skipped():
    async def scenario():
        service, calls = _validation(completed=("kernel",))
        report = await service.validate()
        assert "kernel" in calls
        assert report["subsystems"]["kernel"] == "ok"

        skipped_service, skipped_calls = _validation(skipped=("kernel",))
        skipped_report = await skipped_service.validate()
        assert "kernel" not in skipped_calls
        assert skipped_report["subsystems"]["kernel"] == "skipped"
        assert skipped_report["ok"] is True

    asyncio.run(scenario())


def test_loom_probe_when_step_completed_or_backend_loom():
    async def scenario():
        completed_service, completed_calls = _validation(completed=("loom",))
        await completed_service.validate()
        assert "loom" in completed_calls

        backend_service, backend_calls = _validation(backend="loom")
        await backend_service.validate()
        assert "loom" in backend_calls

        skipped_service, skipped_calls = _validation()
        report = await skipped_service.validate()
        assert "loom" not in skipped_calls
        assert report["subsystems"]["loom"] == "skipped"

    asyncio.run(scenario())


def test_conditional_failure_fails_validation_but_deferred_still_never_fails():
    async def scenario():
        def broken() -> ProbeResult:
            raise RuntimeError("kernel exploded")

        service, _ = _validation(completed=("kernel",), kernel=broken)
        report = await service.validate()
        assert report["ok"] is False
        assert report["subsystems"]["kernel"] == "failed"
        for name in DEFERRED_SUBSYSTEMS:
            assert report["subsystems"][name] == "deferred"

    asyncio.run(scenario())


def test_probe_warnings_are_reported_without_failing():
    async def scenario():
        def degraded() -> ProbeResult:
            return ProbeResult(True, "ok", ("config degraded: config_missing",))

        service, _ = _validation(config_store=degraded)
        report = await service.validate()
        assert report["ok"] is True
        assert report["warnings"] == [
            {
                "subsystem": "config_store",
                "warning": "config degraded: config_missing",
            }
        ]

    asyncio.run(scenario())


def test_scheduler_probe_requires_paused_until_promoted(monkeypatch):
    class Scheduler:
        def __init__(self, running: bool, paused: bool):
            self.running = running
            self.paused = paused

        def is_running(self) -> bool:
            return self.running

    monkeypatch.setattr(
        task_scheduler_module,
        "get_task_scheduler",
        lambda: Scheduler(False, False),
    )
    service = StartupValidation({})
    with pytest.raises(RuntimeError, match="not running"):
        service._probe_scheduler()

    monkeypatch.setattr(
        task_scheduler_module,
        "get_task_scheduler",
        lambda: Scheduler(True, False),
    )
    with pytest.raises(RuntimeError, match="not paused"):
        service._probe_scheduler()

    paused = Scheduler(True, True)
    monkeypatch.setattr(
        task_scheduler_module, "get_task_scheduler", lambda: paused
    )
    assert service._probe_scheduler().ok is True

    paused.paused = False
    service.mark_promoted()
    assert service._probe_scheduler().ok is True


def test_attempt_failure_abort_then_retry_keeps_gate_closed():
    async def scenario():
        state = {"started": False, "starts": 0, "stops": 0}

        async def start():
            state["starts"] += 1
            if state["starts"] == 1:
                raise RuntimeError("first attempt exploded")
            state["started"] = True
            return {"subsystems": {"scheduler": "ok"}, "errors": []}

        async def stop():
            state["stops"] += 1
            state["started"] = False

        def required() -> ProbeResult:
            if not state["started"]:
                raise RuntimeError("service plane is not started")
            return ProbeResult(True, "live")

        probes = {name: required for name in REQUIRED_PROBES}
        service = StartupValidation(
            probes, state_reader=_state(), config_reader=_config()
        )
        runtime = BootstrapRuntime(
            True, start, stop, validator=service.validate
        )

        first = await runtime.attempt("first")
        assert first["ok"] is False
        service.record_attempt(first)
        assert runtime.active is True
        assert runtime.state == "attempted"

        aborted = await runtime.abort("cleanup")
        assert aborted["ok"] is True
        assert aborted["state"] == "deferred"
        assert state["stops"] == 1
        assert runtime.active is True
        service.record_abort()
        assert service.report()["state"] == "aborted"

        second = await runtime.attempt("retry")
        assert second["ok"] is True
        service.record_attempt(second)
        assert runtime.active is True

        checked = await runtime.validate()
        assert checked["ok"] is True
        assert runtime.state == "validated"
        assert runtime.active is True
        assert runtime.committed is False
        assert state == {"started": True, "starts": 2, "stops": 1}

    asyncio.run(scenario())


def test_runtime_validation_report_preserves_deferred_subsystem_state():
    async def scenario():
        async def start():
            return {"subsystems": {"scheduler": "ok"}, "errors": []}

        service, _ = _validation()
        runtime = BootstrapRuntime(True, start, validator=service.validate)
        await runtime.attempt("boot")
        report = await runtime.validate()
        assert report["ok"] is True
        assert report["subsystems"]["p2p"] == "deferred"
        assert runtime.active is True
        await runtime.abort("cleanup")

    asyncio.run(scenario())


class _FakeScheduler:
    def __init__(self) -> None:
        self.running = False
        self.paused = False
        self.builtins: list[str] = []

    async def start(self) -> None:
        self.running = True

    async def stop(self) -> None:
        self.running = False

    def is_running(self) -> bool:
        return self.running

    def set_paused(self, value: bool) -> None:
        self.paused = bool(value)

    def register_builtin(self, name: str, schedule: str, callback: Any) -> None:
        self.builtins.append(name)


class _FakeRunner:
    def __init__(self) -> None:
        self.running = False

    async def start(self) -> None:
        self.running = True

    async def stop(self) -> None:
        self.running = False


class _FakeRegistry:
    def __init__(self) -> None:
        self.sink: Any = None
        self.sweeper = False

    def set_sweep_sink(self, sink: Any) -> None:
        self.sink = sink

    def start_sweeper(self) -> None:
        self.sweeper = True

    def stop_sweeper(self, timeout: float = 5.0) -> None:
        self.sweeper = False


class _FakeStore:
    def __init__(self) -> None:
        self.watcher = False
        self.appliers: tuple[str, ...] = ()

    def start_watcher(self, loop: Any) -> None:
        self.watcher = True

    def stop_watcher(self) -> None:
        self.watcher = False


class _FakeCloud:
    def __init__(self) -> None:
        self.started = False

    def start(self) -> None:
        self.started = True

    def stop(self) -> None:
        self.started = False


class _FakeQQ:
    def __init__(self) -> None:
        self.started = False
        self.config = SimpleNamespace(enabled=True)

    async def start(self) -> None:
        self.started = True

    async def stop(self) -> None:
        self.started = False


class _FakeP2P:
    def __init__(self) -> None:
        self.started = False

    async def start(self) -> None:
        self.started = True

    async def stop(self) -> None:
        self.started = False


class _FakeValidation:
    def __init__(self) -> None:
        self.promoted = 0

    def mark_promoted(self) -> None:
        self.promoted += 1


def _wire_plane(monkeypatch) -> SimpleNamespace:
    scheduler = _FakeScheduler()
    runner = _FakeRunner()
    registry = _FakeRegistry()
    store = _FakeStore()
    cloud = _FakeCloud()
    qq = _FakeQQ()
    p2p = _FakeP2P()
    validation = _FakeValidation()
    loom_started = {"value": False}

    cfg = SimpleNamespace(
        AUDIO_COMPRESSOR_ENABLED=False,
        AUDIO_COMPRESSOR_KEEP_DAYS=30,
        AUDIO_COMPRESSOR_FFMPEG_THREADS=1,
        AUDIO_COMPRESSOR_NICE=10,
    )
    executor = SimpleNamespace(execute=lambda *args, **kwargs: None)

    def register(store_arg, *, registry_sink=None, cors_refresh=None):
        store_arg.appliers = ("ai", "audio")
        return ["ai", "audio"]

    def start_loom_probe():
        loom_started["value"] = True

    async def stop_loom_probe():
        loom_started["value"] = False

    monkeypatch.setattr(main_module, "get_config", lambda: cfg)
    monkeypatch.setattr(main_module, "_register_orchestrator_specs", lambda: None)
    monkeypatch.setattr(main_module, "init_task_executor", lambda: executor)
    monkeypatch.setattr(
        main_module,
        "init_task_scheduler",
        lambda execute_callback=None: scheduler,
    )
    monkeypatch.setattr(main_module, "init_script_runner", lambda: runner)
    monkeypatch.setattr(main_module, "get_config_store", lambda: store)
    monkeypatch.setattr(main_module, "register_default_appliers", register)
    monkeypatch.setattr(
        main_module.loom_health, "start_loom_health_probe", start_loom_probe
    )
    monkeypatch.setattr(
        main_module.loom_health, "stop_loom_health_probe", stop_loom_probe
    )
    monkeypatch.setattr(
        task_scheduler_module, "get_task_scheduler", lambda: scheduler
    )
    monkeypatch.setattr(script_runner_module, "get_script_runner", lambda: runner)
    monkeypatch.setattr(
        audio_registry_module, "get_audio_ingest_registry", lambda: registry
    )
    monkeypatch.setattr(
        audio_registry_module, "peek_audio_ingest_registry", lambda: registry
    )
    monkeypatch.setattr(
        health_cloud_module, "get_health_cloud_service", lambda: cloud
    )
    monkeypatch.setattr(qq_service_module, "get_qq_gateway", lambda: qq)
    monkeypatch.setattr(qq_service_module, "stop_qq_gateway", qq.stop)
    monkeypatch.setattr(p2p_manager_module, "get_p2p_manager", lambda: p2p)
    monkeypatch.setattr(p2p_manager_module, "stop_p2p_manager", p2p.stop)
    monkeypatch.setattr(
        unknown_speaker_module,
        "get_unknown_speaker_config",
        lambda: {"enabled": False},
    )

    app = SimpleNamespace(
        state=SimpleNamespace(
            config_store=store, startup_validation=validation
        )
    )
    return SimpleNamespace(
        app=app,
        scheduler=scheduler,
        runner=runner,
        registry=registry,
        store=store,
        cloud=cloud,
        qq=qq,
        p2p=p2p,
        validation=validation,
        loom_started=loom_started,
    )


def test_validation_mode_starts_safe_subset(monkeypatch):
    async def scenario():
        wired = _wire_plane(monkeypatch)
        report = await main_module._start_service_plane(
            wired.app, mode="validation"
        )

        assert wired.scheduler.paused is True
        for name in (
            "scheduler",
            "script_runner",
            "audio_ingest",
            "config_appliers",
            "config_watcher",
        ):
            assert report["subsystems"][name] == "ok"
        for name in ("health_cloud", "loom_health", "qq_gateway", "p2p"):
            assert report["subsystems"][name] == "skipped"
        assert report["subsystems"]["orchestrator"] == "skipped"
        assert wired.cloud.started is False
        assert wired.qq.started is False
        assert wired.p2p.started is False
        assert wired.loom_started["value"] is False
        assert wired.store.watcher is True
        assert wired.registry.sweeper is True
        assert wired.app.state.service_plane_mode == "validation"

        await main_module._stop_service_plane(wired.app)
        assert wired.scheduler.running is False
        assert wired.runner.running is False
        assert wired.registry.sweeper is False
        assert wired.store.watcher is False
        assert wired.cloud.started is False
        assert wired.qq.started is False
        assert wired.p2p.started is False
        assert wired.app.state.service_plane_stopped is True

    asyncio.run(scenario())


def test_full_mode_still_starts_deferred_integrations(monkeypatch):
    async def scenario():
        wired = _wire_plane(monkeypatch)
        report = await main_module._start_service_plane(wired.app, mode="full")

        assert wired.scheduler.paused is False
        for name in ("health_cloud", "loom_health", "qq_gateway", "p2p"):
            assert report["subsystems"][name] == "ok"
        assert wired.cloud.started is True
        assert wired.qq.started is True
        assert wired.p2p.started is True
        assert wired.loom_started["value"] is True

        await main_module._stop_service_plane(wired.app)

    asyncio.run(scenario())


def test_full_mode_deferred_failures_are_fail_open(monkeypatch):
    async def scenario():
        wired = _wire_plane(monkeypatch)

        async def broken_start():
            raise RuntimeError("qq gateway down")

        wired.qq.start = broken_start
        report = await main_module._start_service_plane(wired.app, mode="full")

        assert report["subsystems"]["qq_gateway"] == "failed"
        assert report["subsystems"]["scheduler"] == "ok"
        assert [
            error for error in report["errors"]
            if error["subsystem"] == "qq_gateway"
        ]

        await main_module._stop_service_plane(wired.app)

    asyncio.run(scenario())


def test_read_state_snapshot_never_repairs_or_writes(tmp_path, monkeypatch):
    state_file = tmp_path / "onboarding_state.json"
    state_file.write_text("{not-json", encoding="utf-8")
    monkeypatch.setenv("AEUH_ONBOARDING_STATE", str(state_file))
    monkeypatch.delenv("AXEUH_ONBOARDING_STATE", raising=False)

    snapshot = onboarding_service.read_state_snapshot()

    assert snapshot["completed_steps"] == []
    assert snapshot["skipped_steps"] == []
    assert state_file.read_text(encoding="utf-8") == "{not-json"
    assert list(tmp_path.glob("*corrupt*")) == []


def test_validation_plane_restarts_cleanly_after_stop(monkeypatch):
    async def scenario():
        wired = _wire_plane(monkeypatch)
        await main_module._start_service_plane(wired.app, mode=MODE_VALIDATION)
        assert wired.registry.sweeper is True
        assert wired.scheduler.paused is True

        await main_module._stop_service_plane(wired.app)
        assert wired.registry.sweeper is False
        assert wired.store.watcher is False
        assert wired.scheduler.running is False

        await main_module._start_service_plane(wired.app, mode=MODE_VALIDATION)
        assert wired.registry.sweeper is True
        assert wired.store.watcher is True
        assert wired.scheduler.paused is True

        await main_module._stop_service_plane(wired.app)

    asyncio.run(scenario())


def test_main_wiring_opens_gate_only_at_final_commit(monkeypatch):
    async def scenario():
        wired = _wire_plane(monkeypatch)

        def ok_probe() -> ProbeResult:
            return ProbeResult(True, "ok")

        probes = {
            name: ok_probe for name in REQUIRED_PROBES if name != "scheduler"
        }
        validation = StartupValidation(
            probes, state_reader=_state(), config_reader=_config()
        )
        wired.app.state.startup_validation = validation

        async def promote_plane():
            wired.scheduler.set_paused(False)
            validation.mark_promoted()
            report: dict[str, Any] = {"subsystems": {}, "errors": []}
            await main_module._start_deferred_integrations(wired.app, report)
            return report

        runtime = BootstrapRuntime(
            True,
            start=lambda: main_module._start_service_plane(
                wired.app, mode=MODE_VALIDATION
            ),
            stop=lambda: main_module._stop_service_plane(wired.app),
            validator=validation.validate,
            promote=promote_plane,
        )

        attempt = await runtime.attempt("boot")
        assert attempt["ok"] is True
        assert wired.scheduler.paused is True
        assert wired.cloud.started is False
        assert runtime.active is True
        assert runtime.committed is False

        checked = await runtime.validate()
        assert checked["ok"] is True
        assert runtime.active is True
        assert runtime.committed is False

        promoted = await runtime.promote("boot")
        assert promoted["ok"] is True
        assert wired.scheduler.paused is False
        assert wired.cloud.started is True
        assert runtime.active is True
        assert runtime.committed is False

        committed = await runtime.commit("boot")
        assert committed["ok"] is True
        assert committed["gate_open"] is True
        assert runtime.active is False
        assert runtime.committed is True

        await runtime.deactivate()
        assert wired.cloud.started is False

    asyncio.run(scenario())
