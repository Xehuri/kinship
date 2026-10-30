# -*- coding: utf-8 -*-
"""loom ServiceSpec 的命令构造、启动契约与停止升级（任务 15）。"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from config.config import Config
from config.paths import backend_dir, project_root
from services import loom_runtime as rt
from services.orchestrator import loom_spec
from services.orchestrator.runtime import ORCHESTRATOR_ENV, Orchestrator
from services.orchestrator.spec import (
    REGISTRY,
    ServiceSpec,
    clear_registry,
    register,
    requirements_satisfied,
)


@pytest.fixture(autouse=True)
def _clean_registry(monkeypatch, tmp_path):
    clear_registry()
    loom_spec._reset_state()
    monkeypatch.setattr(rt, "_data_root", lambda: tmp_path / "var")
    yield
    clear_registry()
    loom_spec._reset_state()


def _cfg(tmp_path: Path) -> Config:
    return Config(
        {
            "ai_backend": "loom",
            "loom": {"url": "http://127.0.0.1:5100", "token": "tok"},
            "data": {"ai_root": str(tmp_path / "ai")},
        }
    )


def _run(coro):
    return asyncio.run(coro)


class _FakeProcess:
    def __init__(self, pid: int = 4321) -> None:
        self.pid = pid
        self.returncode: int | None = None


def test_spec_declaration_is_noncritical_restartable_and_requires_backend():
    spec = loom_spec.build_loom_spec()

    assert spec.id == "loom"
    assert spec.requires == ("loom.url", "ai_backend")
    assert spec.gate is not None
    assert spec.critical is False
    assert spec.restart is True
    assert spec.enable_key is None


def test_requirements_satisfied_checks_both_keys(tmp_path):
    cfg = _cfg(tmp_path)

    assert requirements_satisfied(loom_spec.build_loom_spec(), cfg) == (True, "")
    assert requirements_satisfied(
        loom_spec.build_loom_spec(), Config({"ai_backend": "loom"})
    ) == (False, "missing_config: loom.url")
    assert requirements_satisfied(
        loom_spec.build_loom_spec(),
        Config({"loom": {"url": "http://127.0.0.1:5100"}}),
    ) == (False, "missing_config: ai_backend")


def test_missing_loom_url_is_missing_config_under_opencode():
    assert requirements_satisfied(
        loom_spec.build_loom_spec(), Config({"ai_backend": "opencode"})
    ) == (False, "missing_config: loom.url")


@pytest.mark.parametrize("backend", ["loom", "LOOM", "  Loom  ", "\tloom\n"])
def test_gate_accepts_loom_ai_backend_case_and_whitespace_tolerant(backend):
    cfg = Config(
        {
            "ai_backend": backend,
            "loom": {"url": "http://127.0.0.1:5100"},
        }
    )

    assert requirements_satisfied(loom_spec.build_loom_spec(), cfg) == (True, "")


@pytest.mark.parametrize("backend", ["opencode", "  OPENCODE  ", "lm", "other"])
def test_gate_rejects_non_loom_ai_backend(backend):
    cfg = Config(
        {
            "ai_backend": backend,
            "loom": {"url": "http://127.0.0.1:5100"},
        }
    )

    assert requirements_satisfied(loom_spec.build_loom_spec(), cfg) == (
        False,
        "disabled",
    )


def test_opencode_backend_marks_spec_blocked_and_never_calls_start(tmp_path):
    cfg = Config(
        {
            "ai_backend": "opencode",
            "loom": {"url": "http://127.0.0.1:5100", "token": "tok"},
            "data": {"ai_root": str(tmp_path / "ai")},
        }
    )
    started: list[bool] = []

    async def spy_start():
        started.append(True)
        return {"pid": 999999}

    spec = replace(loom_spec.build_loom_spec(), start=spy_start)
    orchestrator = Orchestrator(
        spec_provider=lambda: [spec],
        config_provider=lambda: cfg,
        env={ORCHESTRATOR_ENV: "on"},
    )

    snapshot_entry = orchestrator.snapshot()["services"][0]
    assert snapshot_entry["id"] == "loom"
    assert snapshot_entry["state"] == "blocked"
    assert snapshot_entry["reason_code"] == "disabled"
    assert snapshot_entry["detail"] == "disabled"

    entries = _run(orchestrator.start_all())
    _run(orchestrator.start("loom"))

    assert started == []
    assert entries[0]["state"] == "blocked"
    assert entries[0]["reason_code"] == "disabled"


def test_build_start_command_wraps_node_after_child_entry(tmp_path):
    cli = tmp_path / "cli.js"
    config_path = tmp_path / "config.yaml"

    argv = loom_spec.build_start_command(
        "/usr/bin/node",
        cli,
        port=5100,
        host="127.0.0.1",
        config_path=config_path,
        python="/venv/python",
    )

    assert argv == [
        "/venv/python",
        "-m",
        "services.orchestrator.child_entry",
        "--target",
        "/usr/bin/node",
        str(cli),
        "serve",
        "--port",
        "5100",
        "--hostname",
        "127.0.0.1",
        "--config",
        str(config_path),
    ]


def test_build_start_env_sets_instance_state_and_backend_path(tmp_path):
    cfg = _cfg(tmp_path)
    instance = Path(cfg.AI_ROOT).resolve()
    config_path = instance / ".loom" / "config.yaml"

    env = loom_spec.build_start_env(
        cfg,
        "secret-token",
        env={"PYTHONPATH": "/existing"},
        config_path=config_path,
    )

    assert env["LOOM_TOKEN"] == "secret-token"
    assert env["LOOM_INSTANCE"] == str(instance)
    assert env["LOOM_STATE"] == str(instance / ".loom")
    assert env["LOOM_CONFIG"] == str(config_path)
    assert env["PYTHONPATH"].split(os.pathsep)[0] == str(backend_dir())


def test_child_log_path_is_fixed_under_backend_data():
    assert loom_spec.child_log_path() == (
        backend_dir() / "data" / "logs" / "loom-child.log"
    )


def test_start_spawns_wrapped_argv_with_loom_harness_cwd(monkeypatch, tmp_path):
    cfg = _cfg(tmp_path)
    config_path = Path(cfg.AI_ROOT) / ".loom" / "config.yaml"
    config_path.parent.mkdir(parents=True)
    config_path.write_text("server:\n  port: 5100\n", encoding="utf-8")
    cli = tmp_path / "cli.js"
    cli.write_text("// built\n", encoding="utf-8")
    log_path = tmp_path / "loom-child.log"
    captured: dict[str, object] = {}

    async def fake_spawn(*argv, **kwargs):
        captured["argv"] = list(argv)
        captured.update(kwargs)
        return _FakeProcess(4321)

    async def healthy(config, token, *, timeout):
        captured["timeout"] = timeout
        return {"ok": True, "reachable": True, "http_status": 200, "status": "ok"}

    monkeypatch.setattr(loom_spec, "get_config", lambda: cfg)
    monkeypatch.setattr(loom_spec, "_create_subprocess_exec", fake_spawn)
    monkeypatch.setattr(loom_spec, "child_log_path", lambda: log_path)
    monkeypatch.setattr(
        rt,
        "_child_spawn_errors",
        lambda config: (
            ["/usr/bin/node", str(cli), "serve"],
            5100,
            "127.0.0.1",
            "",
        ),
    )
    monkeypatch.setattr(rt, "_config_path", lambda config: config_path)
    monkeypatch.setattr(rt, "_port_in_use", lambda port, host: False)
    monkeypatch.setattr(
        rt,
        "_ensure_token_internal",
        lambda config: SimpleNamespace(token="tok", public={}),
    )
    monkeypatch.setattr(rt, "_wait_health", healthy)
    monkeypatch.setattr(rt, "_which", lambda name: "/usr/bin/node")
    monkeypatch.setattr(rt, "_cli_path", lambda: cli)
    monkeypatch.setattr(
        rt,
        "_read_process_identity",
        lambda pid: rt.ProcessIdentity(True, 1000.0, "hash", "/usr/bin/node"),
    )

    result = _run(loom_spec.build_loom_spec().start())

    assert result["pid"] == 4321
    assert result["process"].pid == 4321
    assert captured["cwd"] == str(project_root() / "loom-harness")
    assert captured["env"]["LOOM_INSTANCE"] == str(Path(cfg.AI_ROOT).resolve())
    assert captured["stdout"].name == str(log_path)
    assert captured["stderr"] == asyncio.subprocess.STDOUT
    assert log_path.exists()
    argv = captured["argv"]
    assert argv[:3] == [sys.executable, "-m", "services.orchestrator.child_entry"]
    assert argv[3] == "--target"
    assert argv[4] == "/usr/bin/node"
    assert argv[5] == str(cli)
    assert argv[6] == "serve"
    record = json.loads(
        (tmp_path / "var" / "run" / "loom.pid").read_text(encoding="utf-8")
    )
    assert record["pid"] == 4321
    assert record["command_hash"] == rt._hash_argv(argv[4:])


def test_start_missing_dist_returns_readable_failure_without_spawn(
    monkeypatch, tmp_path
):
    cfg = _cfg(tmp_path)
    spawns: list[object] = []

    async def fake_spawn(*argv, **kwargs):
        spawns.append(argv)
        return _FakeProcess()

    monkeypatch.setattr(loom_spec, "get_config", lambda: cfg)
    monkeypatch.setattr(loom_spec, "_create_subprocess_exec", fake_spawn)
    monkeypatch.setattr(rt, "_which", lambda name: "/usr/bin/node")
    monkeypatch.setattr(
        rt, "_cli_path", lambda: tmp_path / "missing" / "cli.js"
    )

    result = _run(loom_spec.build_loom_spec().start())

    assert result["ok"] is False
    assert result["detail"] == "loom_harness_dist_missing"
    assert spawns == []


def test_start_missing_config_returns_readable_failure(monkeypatch, tmp_path):
    cfg = _cfg(tmp_path)
    cli = tmp_path / "cli.js"
    cli.write_text("// built\n", encoding="utf-8")
    spawns: list[object] = []

    async def fake_spawn(*argv, **kwargs):
        spawns.append(argv)
        return _FakeProcess()

    monkeypatch.setattr(loom_spec, "get_config", lambda: cfg)
    monkeypatch.setattr(loom_spec, "_create_subprocess_exec", fake_spawn)
    monkeypatch.setattr(rt, "_which", lambda name: "/usr/bin/node")
    monkeypatch.setattr(rt, "_cli_path", lambda: cli)

    result = _run(loom_spec.build_loom_spec().start())

    assert result["ok"] is False
    assert result["detail"].startswith("config_missing:")
    assert spawns == []


def test_stop_sends_sigterm_and_waits_five_seconds(monkeypatch):
    signals: list[tuple[int, bool]] = []
    waits: list[float] = []

    async def gone(pid):
        return False

    async def wait_gone(pid, timeout):
        waits.append(timeout)
        return True

    monkeypatch.setattr(loom_spec, "_pid_gone", gone)
    monkeypatch.setattr(loom_spec, "_wait_gone", wait_gone)
    monkeypatch.setattr(
        rt,
        "_terminate_pid",
        lambda pid, *, graceful: signals.append((pid, graceful)) or True,
    )
    loom_spec._STATE.pid = 4321
    loom_spec._STATE.process = _FakeProcess(4321)

    result = _run(loom_spec.build_loom_spec().stop())

    assert result == {"stopped": True, "pid": 4321, "signal": "SIGTERM"}
    assert signals == [(4321, True)]
    assert waits == [loom_spec.DRAIN_TIMEOUT_S]
    assert loom_spec._STATE.pid is None


def test_stop_escalates_to_sigkill_after_drain(monkeypatch):
    signals: list[tuple[int, bool]] = []
    waits: list[float] = []

    async def gone(pid):
        return False

    async def wait_gone(pid, timeout):
        waits.append(timeout)
        return False if len(waits) == 1 else True

    monkeypatch.setattr(loom_spec, "_pid_gone", gone)
    monkeypatch.setattr(loom_spec, "_wait_gone", wait_gone)
    monkeypatch.setattr(
        rt,
        "_terminate_pid",
        lambda pid, *, graceful: signals.append((pid, graceful)) or True,
    )
    loom_spec._STATE.pid = 4321
    loom_spec._STATE.process = _FakeProcess(4321)

    result = _run(loom_spec.build_loom_spec().stop())

    assert result == {"stopped": True, "pid": 4321, "signal": "SIGKILL"}
    assert signals == [(4321, True), (4321, False)]
    assert waits == [loom_spec.DRAIN_TIMEOUT_S, loom_spec.KILL_GRACE_S]


def test_register_is_idempotent_and_rejects_conflicting_declaration():
    first = loom_spec.register_loom_spec()
    second = loom_spec.register_loom_spec()

    assert first is second
    assert REGISTRY["loom"] is first

    async def _action() -> dict:
        return {}

    clear_registry()
    register(
        ServiceSpec(
            id="loom",
            requires=(),
            gate=None,
            start=_action,
            stop=_action,
            critical=True,
            restart=False,
        )
    )
    with pytest.raises(ValueError):
        loom_spec.register_loom_spec()
