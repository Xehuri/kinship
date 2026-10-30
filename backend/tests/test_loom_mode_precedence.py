# -*- coding: utf-8 -*-
"""AXEUH_LOOM_MODE 优先级、child 模式零 systemctl 与禁止 adopt（任务 15）。"""
from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest

from config.config import Config
from services import loom_runtime as rt
from services.orchestrator import loom_spec
from services.orchestrator.runtime import Orchestrator


def _cfg(tmp_path: Path) -> Config:
    return Config(
        {
            "ai_backend": "loom",
            "loom": {"url": "http://127.0.0.1:5100", "token": "tok"},
            "data": {"ai_root": str(tmp_path / "ai")},
        }
    )


def _unit_info(**overrides: str) -> dict[str, str]:
    info = {
        "LoadState": "loaded",
        "ActiveState": "active",
        "SubState": "running",
        "MainPID": "222",
        "WorkingDirectory": str(rt.paths.project_root() / "loom-harness"),
    }
    info.update(overrides)
    return info


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def _isolate(monkeypatch, tmp_path):
    monkeypatch.setattr(rt, "_data_root", lambda: tmp_path / "var")
    monkeypatch.setattr(rt, "_port_in_use", lambda port, host="127.0.0.1": False)
    monkeypatch.setattr(rt, "_port_owner_pid", lambda port, host="127.0.0.1": None)
    monkeypatch.setattr(rt, "_read_process_identity", lambda pid: None)
    monkeypatch.setattr(rt, "_spawn_child_process", lambda *a, **k: None)

    async def unreachable(config, token, *, timeout=rt.HEALTH_TIMEOUT_S):
        return {"ok": False, "reachable": False, "error": "down"}

    monkeypatch.setattr(rt, "_probe_health", unreachable)
    monkeypatch.setattr(rt, "_wait_health", unreachable)


def test_unit_present_but_env_child_selects_child_without_any_systemctl(
    monkeypatch, tmp_path
):
    cli = tmp_path / "cli.js"
    cli.write_text("// built\n", encoding="utf-8")
    monkeypatch.setenv(rt.LOOM_MODE_ENV, rt.MODE_CHILD)
    monkeypatch.setattr(
        rt,
        "_which",
        lambda name: f"/usr/bin/{name}" if name in ("systemctl", "node") else None,
    )
    monkeypatch.setattr(rt, "_cli_path", lambda: cli)
    monkeypatch.setattr(
        rt,
        "_systemd_unit_info",
        lambda unit=rt.DEFAULT_SYSTEMD_UNIT: _unit_info(),
    )
    calls: list[list[str]] = []
    monkeypatch.setattr(
        rt,
        "subprocess",
        SimpleNamespace(run=lambda argv, **kwargs: calls.append(list(argv))),
    )

    assert rt.detect_mode() == rt.MODE_CHILD
    details = rt._mode_details()
    assert details["mode_env"] == rt.MODE_CHILD
    assert details["systemd"]["present"] is False
    assert details["systemd"]["owned"] is False
    status = _run(rt.status(_cfg(tmp_path)))
    assert status["mode"] == rt.MODE_CHILD
    assert status["running"] is False
    assert calls == []


def test_env_auto_prefers_owned_systemd_unit(monkeypatch, tmp_path):
    cli = tmp_path / "cli.js"
    cli.write_text("// built\n", encoding="utf-8")
    monkeypatch.setenv(rt.LOOM_MODE_ENV, rt.MODE_AUTO)
    monkeypatch.setattr(
        rt,
        "_which",
        lambda name: f"/usr/bin/{name}" if name in ("systemctl", "node") else None,
    )
    monkeypatch.setattr(rt, "_cli_path", lambda: cli)
    monkeypatch.setattr(
        rt,
        "_systemd_unit_info",
        lambda unit=rt.DEFAULT_SYSTEMD_UNIT: _unit_info(),
    )

    assert rt.detect_mode() == rt.MODE_SYSTEMD
    status = _run(rt.status(_cfg(tmp_path)))
    assert status["mode"] == rt.MODE_SYSTEMD
    assert status["running"] is True
    assert status["pid"] == 222


def test_env_systemd_uses_unit_and_never_falls_back_to_child(monkeypatch, tmp_path):
    cli = tmp_path / "cli.js"
    cli.write_text("// built\n", encoding="utf-8")
    monkeypatch.setenv(rt.LOOM_MODE_ENV, rt.MODE_SYSTEMD)
    monkeypatch.setattr(
        rt,
        "_which",
        lambda name: f"/usr/bin/{name}" if name in ("systemctl", "node") else None,
    )
    monkeypatch.setattr(rt, "_cli_path", lambda: cli)
    monkeypatch.setattr(
        rt,
        "_systemd_unit_info",
        lambda unit=rt.DEFAULT_SYSTEMD_UNIT: _unit_info(),
    )

    assert rt.detect_mode() == rt.MODE_SYSTEMD

    monkeypatch.setattr(rt, "_systemd_unit_info", lambda unit=None: None)
    assert rt.detect_mode() == rt.MODE_NONE


def test_env_child_without_node_or_dist_is_none_not_systemd(monkeypatch, tmp_path):
    monkeypatch.setenv(rt.LOOM_MODE_ENV, rt.MODE_CHILD)
    monkeypatch.setattr(
        rt,
        "_which",
        lambda name: "/usr/bin/systemctl" if name == "systemctl" else None,
    )
    monkeypatch.setattr(rt, "_cli_path", lambda: tmp_path / "missing" / "cli.js")
    monkeypatch.setattr(
        rt,
        "_systemd_unit_info",
        lambda unit=None: pytest.fail("child 模式不得探测 systemd"),
    )

    assert rt.detect_mode() == rt.MODE_NONE
    assert "loom_harness_dist_missing" in rt._mode_details()["reasons"]


def test_status_does_not_count_foreign_active_unit(monkeypatch, tmp_path):
    monkeypatch.setenv(rt.LOOM_MODE_ENV, rt.MODE_AUTO)
    monkeypatch.setattr(
        rt,
        "_which",
        lambda name: "/usr/bin/systemctl" if name == "systemctl" else None,
    )
    monkeypatch.setattr(
        rt,
        "_systemd_unit_info",
        lambda unit=rt.DEFAULT_SYSTEMD_UNIT: _unit_info(
            WorkingDirectory=str(tmp_path / "other-checkout")
        ),
    )

    status = _run(rt.status(_cfg(tmp_path)))

    assert status["mode"] == rt.MODE_NONE
    assert status["mode_detail"]["systemd"]["present"] is True
    assert status["mode_detail"]["systemd"]["owned"] is False
    assert status["running"] is False
    assert status["pid"] is None


def test_status_in_systemd_mode_still_requires_unit_ownership(monkeypatch, tmp_path):
    monkeypatch.setenv(rt.LOOM_MODE_ENV, rt.MODE_AUTO)
    monkeypatch.setattr(rt, "detect_mode", lambda config=None: rt.MODE_SYSTEMD)
    monkeypatch.setattr(
        rt,
        "_which",
        lambda name: "/usr/bin/systemctl" if name == "systemctl" else None,
    )
    monkeypatch.setattr(
        rt,
        "_systemd_unit_info",
        lambda unit=rt.DEFAULT_SYSTEMD_UNIT: _unit_info(
            WorkingDirectory=str(tmp_path / "other-checkout")
        ),
    )

    status = _run(rt.status(_cfg(tmp_path)))

    assert status["mode"] == rt.MODE_SYSTEMD
    assert status["mode_detail"]["systemd"]["present"] is True
    assert status["mode_detail"]["systemd"]["owned"] is False
    assert status["running"] is False
    assert status["pid"] is None


def test_child_port_busy_fails_and_never_adopts(monkeypatch, tmp_path):
    cfg = _cfg(tmp_path)
    config_path = Path(cfg.AI_ROOT) / ".loom" / "config.yaml"
    config_path.parent.mkdir(parents=True)
    config_path.write_text("server:\n  port: 5100\n", encoding="utf-8")
    cli = tmp_path / "cli.js"
    cli.write_text("// built\n", encoding="utf-8")
    monkeypatch.setenv(rt.LOOM_MODE_ENV, rt.MODE_CHILD)
    monkeypatch.setattr(
        rt, "_which", lambda name: "/usr/bin/node" if name == "node" else None
    )
    monkeypatch.setattr(rt, "_cli_path", lambda: cli)
    monkeypatch.setattr(rt, "_port_in_use", lambda port, host="127.0.0.1": True)
    monkeypatch.setattr(rt, "_port_owner_pid", lambda port, host="127.0.0.1": 4321)
    probes: list[str] = []
    spawns: list[object] = []

    async def fake_spawn(*args, **kwargs):
        spawns.append(args)
        raise AssertionError("port busy must not spawn")

    async def probe(config, token, *, timeout=rt.HEALTH_TIMEOUT_S):
        probes.append(token)
        return {"ok": True, "reachable": True, "http_status": 200, "status": "ok"}

    monkeypatch.setattr(rt, "_probe_health", probe)
    monkeypatch.setattr(loom_spec, "_create_subprocess_exec", fake_spawn)

    result = _run(rt.start(cfg, timeout=0.01))

    assert result["ok"] is False
    assert result["adopted"] is False
    assert result["manual_required"] is True
    assert result["errors"][0]["code"] == "port_in_use"
    assert "pid=4321" in result["detail"]
    assert probes == []
    assert spawns == []

    monkeypatch.setattr(loom_spec, "get_config", lambda: cfg)
    orch = Orchestrator(
        spec_provider=lambda: (loom_spec.build_loom_spec(),),
        config_provider=lambda: cfg,
        env={"AXEUH_ORCHESTRATOR": "on"},
        spawn_grace_s=0.01,
    )
    entry = _run(orch.start("loom"))

    assert entry["state"] == "failed"
    assert "port_in_use" in entry["detail"]
    assert entry["pid"] is None
