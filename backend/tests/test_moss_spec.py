# -*- coding: utf-8 -*-
"""moss_watcher ServiceSpec 的声明、命令构造与停止升级契约（任务 14）。

不启动真实 watcher：start 用假 spawn 捕获 argv/env，stop 用假进程与注入的
PID 判活/信号记录验证 SIGTERM -> SIGKILL。真实生命周期由 QA 用假 watcher
脚本走 get_orchestrator()。
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

from config.config import Config
from config.paths import backend_dir, project_root
from services.orchestrator import moss_spec
from services.orchestrator.spec import (
    REGISTRY,
    ServiceSpec,
    clear_registry,
    register,
    requirements_satisfied,
)


@pytest.fixture(autouse=True)
def _clean_registry():
    clear_registry()
    moss_spec._reset_state()
    yield
    clear_registry()
    moss_spec._reset_state()


def _enabled_cfg(python: str) -> Config:
    return Config({"moss": {"enabled": True, "python": python}})


class _FakeProcess:
    def __init__(self, pid: int = 4321) -> None:
        self.pid = pid
        self.returncode: int | None = None

    async def wait(self) -> int:
        return 0


def _foreign_moss_spec() -> ServiceSpec:
    async def _action() -> dict:
        return {"foreign": True}

    return ServiceSpec(
        id="moss_watcher",
        requires=(),
        gate=None,
        start=_action,
        stop=_action,
        critical=True,
        restart=False,
    )


def test_spec_declaration_is_noncritical_restartable_and_gated_by_moss_enabled():
    spec = moss_spec.build_moss_spec()

    assert spec.id == "moss_watcher"
    assert spec.requires == ("moss.enabled",)
    assert spec.gate is not None
    assert spec.critical is False
    assert spec.restart is True
    assert spec.enable_key is None


def test_requirements_satisfied_disabled_when_moss_enabled_false():
    cfg = Config({"moss": {"enabled": False, "python": sys.executable}})

    ok, reason = requirements_satisfied(moss_spec.build_moss_spec(), cfg)

    assert (ok, reason) == (False, "disabled")


def test_requirements_satisfied_gate_failed_python_missing_for_configured_path():
    cfg = _enabled_cfg("/nonexistent/axeuh-moss/bin/python")

    ok, reason = requirements_satisfied(moss_spec.build_moss_spec(), cfg)

    assert (ok, reason) == (False, "gate_failed: python_missing")


def test_requirements_satisfied_gate_failed_python_missing_when_probe_empty(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(
        moss_spec, "DEFAULT_MOSS_PYTHON", str(tmp_path / "missing-python")
    )
    monkeypatch.setattr(moss_spec, "project_root", lambda: tmp_path)
    cfg = Config({"moss": {"enabled": True, "python": ""}})

    ok, reason = requirements_satisfied(moss_spec.build_moss_spec(), cfg)

    assert (ok, reason) == (False, "gate_failed: python_missing")


def test_requirements_satisfied_when_configured_python_exists():
    cfg = _enabled_cfg(sys.executable)

    ok, reason = requirements_satisfied(moss_spec.build_moss_spec(), cfg)

    assert (ok, reason) == (True, "")


def test_register_moss_spec_is_idempotent():
    first = moss_spec.register_moss_spec()
    second = moss_spec.register_moss_spec()

    assert first is second
    assert REGISTRY["moss_watcher"] is first
    assert len(REGISTRY) == 1


def test_register_moss_spec_rejects_conflicting_declaration():
    register(_foreign_moss_spec())

    with pytest.raises(ValueError, match="conflicting service spec"):
        moss_spec.register_moss_spec()
    assert REGISTRY["moss_watcher"].critical is True


def test_start_argv_uses_child_entry_configured_python_and_watcher_path(
    monkeypatch,
):
    cfg = _enabled_cfg(sys.executable)
    captured: dict = {}

    async def _fake_spawn(*argv, **kwargs):
        captured["argv"] = argv
        captured["kwargs"] = kwargs
        return _FakeProcess(pid=4321)

    monkeypatch.setattr(moss_spec, "get_config", lambda: cfg)
    monkeypatch.setattr(moss_spec, "_create_subprocess_exec", _fake_spawn)

    result = asyncio.run(moss_spec.build_moss_spec().start())

    argv = captured["argv"]
    watcher = Path(argv[5])
    assert result["pid"] == 4321
    assert isinstance(result["process"], _FakeProcess)
    assert argv[0] == sys.executable
    assert argv[1:3] == ("-m", "services.orchestrator.child_entry")
    assert argv[3:5] == ("--target", sys.executable)
    assert watcher == project_root() / "tools" / "moss-shadow" / "watcher.py"
    assert argv[6] == "--loop"
    assert captured["kwargs"]["cwd"] == str(project_root())
    assert "stdout" not in captured["kwargs"]
    assert "stderr" not in captured["kwargs"]
    assert "stdin" not in captured["kwargs"]
    assert str(backend_dir()) in captured["kwargs"]["env"]["PYTHONPATH"].split(
        moss_spec.os.pathsep
    )
    assert not any(
        token in ("axeuh-moss", "vllm", "systemctl", "systemd")
        for token in argv
    )


def test_start_returns_ok_false_when_gate_python_missing(monkeypatch):
    cfg = _enabled_cfg("/nonexistent/axeuh-moss/bin/python")
    monkeypatch.setattr(moss_spec, "get_config", lambda: cfg)

    called = False

    async def _fake_spawn(*argv, **kwargs):
        nonlocal called
        called = True
        return _FakeProcess()

    monkeypatch.setattr(moss_spec, "_create_subprocess_exec", _fake_spawn)

    result = asyncio.run(moss_spec.build_moss_spec().start())

    assert result["ok"] is False
    assert "python_missing" in result["detail"]
    assert called is False


def test_stop_escalates_sigterm_to_sigkill_by_exact_pid(monkeypatch):
    pid = 4322
    moss_spec._STATE.pid = pid
    moss_spec._STATE.process = _FakeProcess(pid=pid)
    signals: list[tuple[int, str]] = []
    alive = {"value": True}

    def _fake_signal(target: int, name: str) -> None:
        signals.append((target, name))
        if name == "SIGKILL":
            alive["value"] = False

    monkeypatch.setattr(moss_spec, "_pid_alive", lambda target: alive["value"])
    monkeypatch.setattr(moss_spec, "_signal_pid", _fake_signal)
    monkeypatch.setattr(moss_spec, "STOP_TIMEOUT_S", 0.01)
    monkeypatch.setattr(moss_spec, "KILL_GRACE_S", 0.01)
    monkeypatch.setattr(moss_spec, "POLL_INTERVAL_S", 0.001)

    result = asyncio.run(moss_spec.build_moss_spec().stop())

    assert signals == [(pid, "SIGTERM"), (pid, "SIGKILL")]
    assert result == {"stopped": True, "pid": pid, "signal": "SIGKILL"}
    assert moss_spec._STATE.pid is None
    assert moss_spec._STATE.process is None


def test_stop_graceful_sigterm_does_not_send_sigkill(monkeypatch):
    pid = 4323
    moss_spec._STATE.pid = pid
    signals: list[tuple[int, str]] = []
    alive = {"value": True}

    def _fake_signal(target: int, name: str) -> None:
        signals.append((target, name))
        if name == "SIGTERM":
            alive["value"] = False

    monkeypatch.setattr(moss_spec, "_pid_alive", lambda target: alive["value"])
    monkeypatch.setattr(moss_spec, "_signal_pid", _fake_signal)
    monkeypatch.setattr(moss_spec, "STOP_TIMEOUT_S", 0.01)
    monkeypatch.setattr(moss_spec, "POLL_INTERVAL_S", 0.001)

    result = asyncio.run(moss_spec.build_moss_spec().stop())

    assert signals == [(pid, "SIGTERM")]
    assert result == {"stopped": True, "pid": pid, "signal": "SIGTERM"}


def test_resolve_python_prefers_configured_then_opt_then_project_venv(
    tmp_path, monkeypatch
):
    configured = tmp_path / "custom" / "python"
    assert moss_spec.resolve_moss_python(
        _enabled_cfg(str(configured)), root=tmp_path, is_windows=False
    ) == str(configured)

    opt_python = tmp_path / "opt-python"
    opt_python.write_text("", encoding="utf-8")
    opt_python.chmod(0o755)
    monkeypatch.setattr(moss_spec, "DEFAULT_MOSS_PYTHON", str(opt_python))
    assert moss_spec.resolve_moss_python(
        _enabled_cfg(""), root=tmp_path, is_windows=False
    ) == str(opt_python)

    project_python = moss_spec.venv_python(tmp_path, is_windows=False)
    project_python.parent.mkdir(parents=True)
    project_python.write_text("", encoding="utf-8")
    project_python.chmod(0o755)
    monkeypatch.setattr(moss_spec, "DEFAULT_MOSS_PYTHON", str(tmp_path / "missing"))
    assert moss_spec.resolve_moss_python(
        _enabled_cfg(""), root=tmp_path, is_windows=False
    ) == str(project_python)


def test_python_candidates_use_scripts_on_windows(tmp_path):
    posix = moss_spec.python_candidates(tmp_path, is_windows=False)
    windows = moss_spec.python_candidates(tmp_path, is_windows=True)

    assert posix[0] == moss_spec.DEFAULT_MOSS_PYTHON
    assert posix[1].endswith("/.venv-moss/bin/python")
    assert windows[1].endswith("/.venv-moss/Scripts/python.exe")


def test_config_moss_python_property_is_trimmed_raw_value():
    assert Config({"moss": {"python": "  /tmp/python  "}}).MOSS_PYTHON == "/tmp/python"
    assert Config({"moss": {}}).MOSS_PYTHON == ""
