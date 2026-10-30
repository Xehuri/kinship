# -*- coding: utf-8 -*-
"""RED tests: /api/screen/restart must stop ScriptRunner before hard exit.

These tests target the planned module-level seams in
``routers.maintenance``:

    _RESTART_DELAY_S, _is_windows, _resolve_script_runner,
    _stop_scripts_before_exit, _hard_exit, _spawn_new_process, _do_restart

They are fully deterministic: no real sleep, no subprocess, no os._exit.
They are expected to fail on the pre-fix module with AttributeError because
the helpers do not exist yet.
"""

from __future__ import annotations

import asyncio
import logging

import pytest

from routers import maintenance as maintenance_module


class _RecordingRunner:
    """Minimal async runner stand-in; records the ordered stop call."""

    def __init__(self, record: list, *, raises: bool = False) -> None:
        self._record = record
        self._raises = raises
        self.stop_calls = 0

    async def stop(self) -> None:
        self.stop_calls += 1
        self._record.append("stop")
        if self._raises:
            raise RuntimeError("stop boom")


def _patch_exit(monkeypatch: pytest.MonkeyPatch, record: list) -> None:
    monkeypatch.setattr(
        maintenance_module,
        "_hard_exit",
        lambda code: record.append(("exit", code)),
    )


def _patch_spawn(monkeypatch: pytest.MonkeyPatch, record: list) -> None:
    monkeypatch.setattr(
        maintenance_module,
        "_spawn_new_process",
        lambda: record.append("spawn"),
    )


def test_restart_stops_runner_before_exit_linux(monkeypatch: pytest.MonkeyPatch) -> None:
    """Linux: stop scripts must complete before the process hard-exits."""
    record: list = []
    runner = _RecordingRunner(record)

    monkeypatch.setattr(maintenance_module, "_RESTART_DELAY_S", 0)
    monkeypatch.setattr(maintenance_module, "_resolve_script_runner", lambda: runner)
    monkeypatch.setattr(maintenance_module, "_is_windows", lambda: False)
    _patch_spawn(monkeypatch, record)
    _patch_exit(monkeypatch, record)

    asyncio.run(maintenance_module._do_restart())

    assert record == ["stop", ("exit", 0)]


def test_restart_stops_runner_before_spawning_windows(monkeypatch: pytest.MonkeyPatch) -> None:
    """Windows: stop scripts, then spawn the replacement, then exit."""
    record: list = []
    runner = _RecordingRunner(record)

    monkeypatch.setattr(maintenance_module, "_RESTART_DELAY_S", 0)
    monkeypatch.setattr(maintenance_module, "_resolve_script_runner", lambda: runner)
    monkeypatch.setattr(maintenance_module, "_is_windows", lambda: True)
    _patch_spawn(monkeypatch, record)
    _patch_exit(monkeypatch, record)

    asyncio.run(maintenance_module._do_restart())

    assert record == ["stop", "spawn", ("exit", 0)]


def test_restart_still_exits_when_stop_raises(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A failing stop() must be swallowed, logged, and must not block the exit."""
    record: list = []
    runner = _RecordingRunner(record, raises=True)

    monkeypatch.setattr(maintenance_module, "_RESTART_DELAY_S", 0)
    monkeypatch.setattr(maintenance_module, "_resolve_script_runner", lambda: runner)
    monkeypatch.setattr(maintenance_module, "_is_windows", lambda: False)
    _patch_spawn(monkeypatch, record)
    _patch_exit(monkeypatch, record)

    with caplog.at_level(logging.WARNING, logger="routers.maintenance"):
        asyncio.run(maintenance_module._do_restart())

    assert runner.stop_calls == 1
    assert record == ["stop", ("exit", 0)]
    assert any(record_.levelno >= logging.WARNING for record_ in caplog.records)


def test_restart_exits_when_runner_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    """No initialized ScriptRunner must not prevent the restart exit."""
    record: list = []

    monkeypatch.setattr(maintenance_module, "_RESTART_DELAY_S", 0)
    monkeypatch.setattr(maintenance_module, "_resolve_script_runner", lambda: None)
    monkeypatch.setattr(maintenance_module, "_is_windows", lambda: False)
    _patch_spawn(monkeypatch, record)
    _patch_exit(monkeypatch, record)

    asyncio.run(maintenance_module._do_restart())

    assert record == [("exit", 0)]


def test_restart_stop_called_exactly_once(monkeypatch: pytest.MonkeyPatch) -> None:
    """The shutdown path must stop the runner once, not once per branch."""
    record: list = []
    runner = _RecordingRunner(record)

    monkeypatch.setattr(maintenance_module, "_RESTART_DELAY_S", 0)
    monkeypatch.setattr(maintenance_module, "_resolve_script_runner", lambda: runner)
    monkeypatch.setattr(maintenance_module, "_is_windows", lambda: True)
    _patch_spawn(monkeypatch, record)
    _patch_exit(monkeypatch, record)

    asyncio.run(maintenance_module._do_restart())

    assert runner.stop_calls == 1
    assert record.count("stop") == 1


# ============================================================
# Windows 重启必须先停内核：失败返回可读 HTTP 错误且不启动新后端
# ============================================================

def _patch_kernel_stop(monkeypatch: pytest.MonkeyPatch, outcome) -> list:
    calls: list = []

    def _stop():
        calls.append("kernel_stop")
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome

    monkeypatch.setattr(maintenance_module, "_stop_kernel_for_restart", _stop)
    return calls


def _patch_create_task(monkeypatch: pytest.MonkeyPatch) -> list:
    tasks: list = []

    def _create_task(coro):
        tasks.append(coro)
        return coro

    monkeypatch.setattr(maintenance_module.asyncio, "create_task", _create_task)
    return tasks


def test_windows_restart_stops_kernel_before_returning(monkeypatch):
    calls = _patch_kernel_stop(monkeypatch, (True, "stopped"))
    tasks = _patch_create_task(monkeypatch)
    monkeypatch.setattr(maintenance_module, "_is_windows", lambda: True)

    result = asyncio.run(maintenance_module.restart_backend())

    assert calls == ["kernel_stop"]
    assert result["success"] is True
    assert len(tasks) == 1
    tasks[0].close()


def test_windows_restart_returns_409_without_scheduling_when_stop_refused(monkeypatch):
    from fastapi import HTTPException

    _patch_kernel_stop(monkeypatch, (False, "ownership_unproven: cmdline"))
    tasks = _patch_create_task(monkeypatch)
    monkeypatch.setattr(maintenance_module, "_is_windows", lambda: True)

    with pytest.raises(HTTPException) as ei:
        asyncio.run(maintenance_module.restart_backend())

    assert ei.value.status_code == 409
    assert "ownership_unproven" in ei.value.detail
    assert tasks == []


def test_windows_restart_returns_500_without_scheduling_when_stop_raises(monkeypatch):
    from fastapi import HTTPException

    _patch_kernel_stop(monkeypatch, RuntimeError("terminate boom"))
    tasks = _patch_create_task(monkeypatch)
    monkeypatch.setattr(maintenance_module, "_is_windows", lambda: True)

    with pytest.raises(HTTPException) as ei:
        asyncio.run(maintenance_module.restart_backend())

    assert ei.value.status_code == 500
    assert "terminate boom" in ei.value.detail
    assert tasks == []


def test_linux_restart_does_not_touch_kernel(monkeypatch):
    calls = _patch_kernel_stop(monkeypatch, (True, "stopped"))
    tasks = _patch_create_task(monkeypatch)
    monkeypatch.setattr(maintenance_module, "_is_windows", lambda: False)

    result = asyncio.run(maintenance_module.restart_backend())

    assert calls == []
    assert result["success"] is True
    assert len(tasks) == 1
    tasks[0].close()


@pytest.mark.parametrize("reason", ["no-pidfile", "not-running"])
def test_stop_kernel_for_restart_allows_absent_kernel(monkeypatch, reason):
    from services import kernel_client as kc

    fenced: list = []
    monkeypatch.setattr(kc, "fence_kernel_respawn", lambda: fenced.append("fence"))
    monkeypatch.setattr(
        kc, "stop_kernel_process", lambda **kw: {"stopped": False, "reason": reason}
    )

    assert maintenance_module._stop_kernel_for_restart() == (True, reason)
    assert fenced == ["fence"]


def test_stop_kernel_for_restart_fences_after_success(monkeypatch):
    from services import kernel_client as kc

    fenced: list = []
    monkeypatch.setattr(kc, "fence_kernel_respawn", lambda: fenced.append("fence"))
    monkeypatch.setattr(
        kc, "stop_kernel_process", lambda **kw: {"stopped": True, "pid": 1}
    )

    assert maintenance_module._stop_kernel_for_restart() == (True, "stopped")
    assert fenced == ["fence"]


def test_stop_kernel_for_restart_refuses_ownership_unproven(monkeypatch):
    from services import kernel_client as kc

    fenced: list = []
    monkeypatch.setattr(kc, "fence_kernel_respawn", lambda: fenced.append("fence"))
    monkeypatch.setattr(
        kc,
        "stop_kernel_process",
        lambda **kw: {
            "stopped": False,
            "reason": "ownership_unproven: cmdline 不含 axeuh_kernel",
        },
    )

    ok, detail = maintenance_module._stop_kernel_for_restart()
    assert ok is False
    assert "ownership_unproven" in detail
    assert fenced == []
