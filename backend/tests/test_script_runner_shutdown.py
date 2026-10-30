# -*- coding: utf-8 -*-
"""RED tests: ScriptRunner must stay inert once shutdown has begun.

Planned guards:
    ScriptRunner._check_processes() -> return immediately when not self._running
    ScriptRunner._restart_script(name) -> return immediately when not self._running

No real processes are created: fake Popen objects plus monkeypatched
``subprocess.Popen`` keep these tests fast and side-effect free.
"""

from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace

import pytest

import services.script_runner as script_runner_module
from services.script_runner import ScriptRunner


def _fake_process(*, poll_return: int | None = -15, pid: int = 4242) -> SimpleNamespace:
    return SimpleNamespace(
        pid=pid,
        poll=lambda: poll_return,
        terminate=lambda: None,
        wait=lambda timeout=None: 0,
        kill=lambda: None,
    )


def test_check_processes_noop_when_stopped(monkeypatch: pytest.MonkeyPatch) -> None:
    """A monitor tick after stop() must not handle a dead script."""
    runner = ScriptRunner()
    runner._running = False
    runner._processes["s"] = {
        "process": _fake_process(poll_return=-15),
        "last_heartbeat": time.time(),
        "restart_count": 0,
    }

    deaths: list = []
    monkeypatch.setattr(
        runner,
        "_handle_process_death",
        lambda *args, **kwargs: deaths.append(args),
    )

    runner._check_processes()

    assert deaths == []


def test_restart_script_noop_when_stopped(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    """A shutdown-time restart attempt must not mutate state or spawn a process."""
    runner = ScriptRunner()
    runner._running = False
    runner._processes["s"] = {
        "process": _fake_process(poll_return=1),
        "script_path": str(tmp_path / "task.py"),
        "restart_count": 0,
        "wrapper_path": None,
    }

    def _popen_must_not_run(*args, **kwargs):
        raise AssertionError("subprocess.Popen must not run during shutdown")

    monkeypatch.setattr(script_runner_module.subprocess, "Popen", _popen_must_not_run)
    monkeypatch.setattr(runner, "_create_wrapper", lambda *a, **k: str(tmp_path / "wrapper.py"))
    monkeypatch.setattr(script_runner_module, "_build_task_env", lambda: {})

    runner._restart_script("s")

    assert runner._processes["s"]["restart_count"] == 0


class _FakeStopProcess:
    def __init__(self, pid: int = 777) -> None:
        self.pid = pid
        self.terminate_calls = 0
        self.wait_calls = 0
        self.kill_calls = 0

    def terminate(self) -> None:
        self.terminate_calls += 1

    def wait(self, timeout=None) -> int:
        self.wait_calls += 1
        return 0

    def kill(self) -> None:
        self.kill_calls += 1


def test_stop_all_is_idempotent(monkeypatch: pytest.MonkeyPatch) -> None:
    """Repeated stop_all() must be safe, and shutdown must stay inert afterwards."""
    runner = ScriptRunner()
    process = _FakeStopProcess()
    runner._processes["s"] = {"process": process, "wrapper_path": None}
    monkeypatch.setattr(runner, "_audit_log", lambda *a, **k: None)

    runner.stop_all()
    runner.stop_all()

    assert runner._processes == {}
    assert process.terminate_calls == 1
    assert process.kill_calls == 0

    # During shutdown a monitor tick must not resurrect/handle anything.
    runner._running = False
    runner._processes["zombie"] = {
        "process": _fake_process(poll_return=-15, pid=999),
        "last_heartbeat": time.time(),
        "restart_count": 0,
    }
    deaths: list = []
    monkeypatch.setattr(
        runner,
        "_handle_process_death",
        lambda *args, **kwargs: deaths.append(args),
    )
    runner._check_processes()
    assert deaths == []


def test_stop_sets_not_running_before_stop_all(monkeypatch: pytest.MonkeyPatch) -> None:
    """stop() must flip _running before stop_all(), so the monitor cannot restart."""
    runner = ScriptRunner()
    runner._running = True
    runner._processes["s"] = {
        "process": _fake_process(poll_return=-15),
        "last_heartbeat": time.time(),
        "restart_count": 0,
    }

    observed: dict = {}
    deaths: list = []
    monkeypatch.setattr(
        runner,
        "_handle_process_death",
        lambda *args, **kwargs: deaths.append(args),
    )

    def _fake_stop_all() -> None:
        observed["running"] = runner._running
        # A monitor tick racing with shutdown must already see _running=False.
        runner._check_processes()

    monkeypatch.setattr(runner, "stop_all", _fake_stop_all)

    asyncio.run(runner.stop())

    assert observed == {"running": False}
    assert deaths == []
