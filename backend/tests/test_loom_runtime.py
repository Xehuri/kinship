# -*- coding: utf-8 -*-
"""T6 Loom 运行时：模式矩阵、token/config 供给、子进程生命周期与安全边界。

全部零真实进程/零网络：systemctl、Popen、/proc 身份、端口探测与 /health 均被桩替换。
"""

from __future__ import annotations

import asyncio
import json
import logging
import stat
from pathlib import Path
from typing import Any, Optional

import pytest
import yaml
from fastapi import FastAPI
from fastapi.testclient import TestClient

from config import paths
from config.config import Config
from routers import loom_onboarding as router_module
from services import config_authz, loom_onboarding as loom, loom_runtime as rt

TOKEN = "runtime-secret-token-never-returned"


def _cfg(
    tmp_path: Path,
    *,
    token: str = TOKEN,
    manage: bool = True,
    url: str = "http://127.0.0.1:5100",
) -> Config:
    return Config(
        {
            "loom": {"url": url, "token": token, "manage_config": manage},
            "data": {"ai_root": str(tmp_path / "ai")},
        }
    )


def _selection(**overrides: Any) -> loom.Selection:
    values: dict[str, Any] = {
        "provider": "prov-a",
        "model": "main-model",
        "base_url": "https://api.example/v1",
        "context_window": 128000,
        "max_output": 8192,
        "vision": True,
        "timeout": 600000,
        "pricing": {"input": 1.0, "output": 2.0, "cacheRead": 0.0, "cacheWrite": 0.0},
    }
    values.update(overrides)
    return loom.Selection(**values)


def _config_path(tmp_path: Path) -> Path:
    return tmp_path / "ai" / ".loom" / "config.yaml"


def _write_valid_config(tmp_path: Path) -> Path:
    cfg = _cfg(tmp_path)
    result = rt.ensure_config(
        _selection(), cfg, config_path=_config_path(tmp_path)
    )
    assert result["ok"] is True
    return _config_path(tmp_path)


def _allow_child(monkeypatch, tmp_path: Path) -> Path:
    cli = tmp_path / "loom-harness" / "packages" / "server" / "dist" / "cli.js"
    cli.parent.mkdir(parents=True, exist_ok=True)
    cli.write_text("// fake loom cli\n", encoding="utf-8")
    monkeypatch.setattr(
        rt, "_which", lambda name: "/usr/bin/node" if name == "node" else None
    )
    monkeypatch.setattr(rt, "_cli_path", lambda: cli)
    return cli


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def _isolate_runtime(monkeypatch, tmp_path):
    """阻断宿主真实 systemd/node/端口/环境，测试默认落在 none 模式。"""
    monkeypatch.setenv(rt.LOOM_MODE_ENV, rt.MODE_CHILD)
    monkeypatch.setattr(rt, "_data_root", lambda: tmp_path / "var")
    monkeypatch.setattr(
        rt, "_systemd_unit_info", lambda unit=rt.DEFAULT_SYSTEMD_UNIT: None
    )
    monkeypatch.setattr(rt, "_which", lambda name: None)
    monkeypatch.setattr(rt, "_cli_path", lambda: tmp_path / "missing-cli.js")
    monkeypatch.setattr(rt, "_port_in_use", lambda port, host="127.0.0.1": False)
    monkeypatch.setattr(rt, "_same_user", lambda pid: True)
    monkeypatch.setattr(rt, "_MANAGED_CHILDREN", {})
    monkeypatch.delenv("LOOM_TOKEN", raising=False)


# ── 模式矩阵 ─────────────────────────────────────────────────


def _unit_info(**overrides: str) -> dict[str, str]:
    info = {
        "LoadState": "loaded",
        "ActiveState": "inactive",
        "SubState": "dead",
        "MainPID": "0",
        "WorkingDirectory": str(paths.project_root()),
    }
    info.update(overrides)
    return info


def _force_systemd(monkeypatch) -> None:
    monkeypatch.setenv(rt.LOOM_MODE_ENV, rt.MODE_SYSTEMD)


class TestDetectMode:
    def test_systemd_when_unit_exists_and_owned(self, monkeypatch):
        _force_systemd(monkeypatch)
        monkeypatch.setattr(
            rt,
            "_which",
            lambda name: "/usr/bin/systemctl" if name == "systemctl" else None,
        )
        monkeypatch.setattr(
            rt,
            "_systemd_unit_info",
            lambda unit=rt.DEFAULT_SYSTEMD_UNIT: _unit_info(),
        )

        assert rt.detect_mode() == rt.MODE_SYSTEMD
        assert rt._mode_details()["systemd"]["owned"] is True

    def test_unit_owned_via_loom_harness_working_directory(self, monkeypatch):
        _force_systemd(monkeypatch)
        monkeypatch.setattr(
            rt,
            "_which",
            lambda name: "/usr/bin/systemctl" if name == "systemctl" else None,
        )
        monkeypatch.setattr(
            rt,
            "_systemd_unit_info",
            lambda unit=rt.DEFAULT_SYSTEMD_UNIT: _unit_info(
                WorkingDirectory=str(paths.project_root() / "loom-harness"),
                FragmentPath="/etc/systemd/system/axeuh-loom.service",
            ),
        )

        assert rt.detect_mode() == rt.MODE_SYSTEMD

    def test_unit_owned_via_exec_start_cli_path(self, monkeypatch):
        _force_systemd(monkeypatch)
        cli = paths.project_root() / "loom-harness" / "packages" / "server" / "dist" / "cli.js"
        monkeypatch.setattr(
            rt,
            "_which",
            lambda name: "/usr/bin/systemctl" if name == "systemctl" else None,
        )
        monkeypatch.setattr(
            rt,
            "_systemd_unit_info",
            lambda unit=rt.DEFAULT_SYSTEMD_UNIT: _unit_info(
                WorkingDirectory="",
                ExecStart=(
                    "{ path=/usr/bin/node ; argv[]=/usr/bin/node "
                    + str(cli)
                    + " serve ; ignore_errors=no }"
                ),
            ),
        )

        assert rt.detect_mode() == rt.MODE_SYSTEMD

    def test_foreign_unit_is_none_and_not_owned(self, monkeypatch, tmp_path):
        _force_systemd(monkeypatch)
        monkeypatch.setattr(
            rt,
            "_which",
            lambda name: "/usr/bin/systemctl" if name == "systemctl" else None,
        )
        monkeypatch.setattr(
            rt,
            "_systemd_unit_info",
            lambda unit=rt.DEFAULT_SYSTEMD_UNIT: _unit_info(
                ActiveState="active",
                SubState="running",
                MainPID="222",
                WorkingDirectory=str(tmp_path / "stage-onboarding"),
                FragmentPath="/etc/systemd/system/axeuh-loom.service",
            ),
        )

        assert rt.detect_mode() == rt.MODE_NONE
        details = rt._mode_details()
        assert details["systemd"]["present"] is True
        assert details["systemd"]["owned"] is False
        assert "systemd_unit_foreign" in details["reasons"]

    def test_unit_without_ownership_properties_is_foreign(self, monkeypatch):
        _force_systemd(monkeypatch)
        monkeypatch.setattr(
            rt,
            "_which",
            lambda name: "/usr/bin/systemctl" if name == "systemctl" else None,
        )
        monkeypatch.setattr(
            rt,
            "_systemd_unit_info",
            lambda unit=rt.DEFAULT_SYSTEMD_UNIT: {
                "LoadState": "loaded",
                "ActiveState": "inactive",
                "MainPID": "0",
                "WorkingDirectory": "",
                "ExecStart": "",
                "FragmentPath": "/etc/systemd/system/axeuh-loom.service",
            },
        )

        assert rt.detect_mode() == rt.MODE_NONE
        assert "systemd_unit_foreign" in rt._mode_details()["reasons"]

    def test_foreign_unit_blocks_child_fallback(self, monkeypatch, tmp_path):
        monkeypatch.setenv(rt.LOOM_MODE_ENV, rt.MODE_AUTO)
        cli = tmp_path / "cli.js"
        cli.write_text("// built\n", encoding="utf-8")
        monkeypatch.setattr(
            rt,
            "_which",
            lambda name: f"/usr/bin/{name}" if name in ("systemctl", "node") else None,
        )
        monkeypatch.setattr(rt, "_cli_path", lambda: cli)
        monkeypatch.setattr(
            rt,
            "_systemd_unit_info",
            lambda unit=rt.DEFAULT_SYSTEMD_UNIT: _unit_info(
                WorkingDirectory=str(tmp_path / "other-checkout")
            ),
        )

        assert rt.detect_mode() == rt.MODE_NONE

    def test_child_only_when_node_and_dist_exist(self, monkeypatch, tmp_path):
        cli = tmp_path / "cli.js"
        cli.write_text("// built\n", encoding="utf-8")
        monkeypatch.setattr(
            rt, "_which", lambda name: "/usr/bin/node" if name == "node" else None
        )
        monkeypatch.setattr(rt, "_cli_path", lambda: cli)

        assert rt.detect_mode() == rt.MODE_CHILD

    def test_none_when_dist_missing(self, monkeypatch, tmp_path):
        monkeypatch.setattr(
            rt, "_which", lambda name: "/usr/bin/node" if name == "node" else None
        )
        monkeypatch.setattr(rt, "_cli_path", lambda: tmp_path / "absent" / "cli.js")

        assert rt.detect_mode() == rt.MODE_NONE
        details = rt._mode_details()
        assert "loom_harness_dist_missing" in details["reasons"]
        assert details["child"]["cli_present"] is False

    def test_none_when_node_missing(self, monkeypatch, tmp_path):
        cli = tmp_path / "cli.js"
        cli.write_text("// built\n", encoding="utf-8")
        monkeypatch.setattr(rt, "_which", lambda name: None)
        monkeypatch.setattr(rt, "_cli_path", lambda: cli)

        assert rt.detect_mode() == rt.MODE_NONE

    def test_child_when_systemctl_exists_but_unit_absent(self, monkeypatch, tmp_path):
        monkeypatch.setenv(rt.LOOM_MODE_ENV, rt.MODE_AUTO)
        cli = tmp_path / "cli.js"
        cli.write_text("// built\n", encoding="utf-8")
        monkeypatch.setattr(
            rt,
            "_which",
            lambda name: f"/usr/bin/{name}" if name in ("systemctl", "node") else None,
        )
        monkeypatch.setattr(rt, "_systemd_unit_info", lambda unit=None: None)
        monkeypatch.setattr(rt, "_cli_path", lambda: cli)

        assert rt.detect_mode() == rt.MODE_CHILD

    def test_none_start_is_manual_required(self, tmp_path, monkeypatch):
        spawn: list[Any] = []
        monkeypatch.setattr(rt, "_spawn_child_process", lambda *a, **k: spawn.append(a))

        result = _run(rt.start(_cfg(tmp_path)))

        assert result["mode"] == rt.MODE_NONE
        assert result["manual_required"] is True
        assert result["errors"][0]["code"] == "runtime_unavailable"
        assert spawn == []


# ── token 供给 ───────────────────────────────────────────────


class TestEnsureToken:
    def test_provisions_0600_file_and_never_returns_token(
        self, tmp_path, monkeypatch, caplog
    ):
        cfg = _cfg(tmp_path, token="")
        persisted: list[Path] = []

        def fake_persist(path: Path):
            persisted.append(path)
            return True, None

        monkeypatch.setattr(rt, "_persist_token_file", fake_persist)
        with caplog.at_level(logging.INFO, logger=rt.__name__):
            result = rt.ensure_token(cfg, data_root=tmp_path / "var")

        env_file = tmp_path / "var" / "secrets" / "loom.env"
        content = env_file.read_text(encoding="utf-8")
        token = content.strip().split("=", 1)[1]
        assert token
        assert stat.S_IMODE(env_file.stat().st_mode) == 0o600
        assert result["found"] is True
        assert result["source"] == rt.SOURCE_PROVISIONED
        assert result["provisioned"] is True
        assert result["persisted"] is True
        assert result["fingerprint"] == loom.fingerprint(token)
        assert token not in json.dumps(result, ensure_ascii=False)
        assert token not in caplog.text
        assert persisted == [env_file]

    def test_reuses_existing_provisioned_file_without_regenerating(
        self, tmp_path, monkeypatch
    ):
        env_file = tmp_path / "var" / "secrets" / "loom.env"
        env_file.parent.mkdir(parents=True)
        env_file.write_text("LOOM_TOKEN=existing-token\n", encoding="utf-8")
        monkeypatch.setattr(rt, "_persist_token_file", lambda path: (True, None))

        result = rt.ensure_token(_cfg(tmp_path, token=""), data_root=tmp_path / "var")

        assert result["provisioned"] is False
        assert result["source"] == "token_file"
        assert result["fingerprint"] == loom.fingerprint("existing-token")
        assert env_file.read_text(encoding="utf-8") == "LOOM_TOKEN=existing-token\n"

    def test_token_state_repr_excludes_token(self):
        state = rt._TokenState(token="repr-secret", public={"found": True})

        assert state.token == "repr-secret"
        assert "repr-secret" not in repr(state)

    def test_configured_token_is_used_without_writing(self, tmp_path, monkeypatch):
        called: list[Path] = []
        monkeypatch.setattr(
            rt, "_persist_token_file", lambda path: called.append(path) or (True, None)
        )

        result = rt.ensure_token(_cfg(tmp_path), data_root=tmp_path / "var")

        assert result["found"] is True
        assert result["source"] == loom.SOURCE_CONFIG
        assert result["provisioned"] is False
        assert not (tmp_path / "var" / "secrets" / "loom.env").exists()
        assert called == []

    def test_persist_writes_loom_token_file_through_config_store(
        self, tmp_path, monkeypatch
    ):
        from config.providers import YamlFileProvider
        from config.store import ConfigStore

        config_file = tmp_path / "config.yaml"
        config_file.write_text(
            "ai_backend: loom\n"
            "loom:\n"
            "  url: http://127.0.0.1:5100\n"
            "  token: seed-token\n",
            encoding="utf-8",
        )
        store = ConfigStore(YamlFileProvider(config_file))
        monkeypatch.setattr(rt, "get_config_store", lambda: store)
        target = tmp_path / "var" / "secrets" / "loom.env"

        ok, error = rt._persist_token_file(target)

        assert ok is True
        assert error is None
        doc = yaml.safe_load(config_file.read_text(encoding="utf-8"))
        assert doc["loom"]["token_file"] == str(target)

    def test_persist_failure_is_reported_honestly(self, tmp_path, monkeypatch):
        monkeypatch.setattr(
            rt,
            "_persist_token_file",
            lambda path: (
                False,
                {"code": "config_persist_failed", "message": "locked"},
            ),
        )

        result = rt.ensure_token(_cfg(tmp_path, token=""), data_root=tmp_path / "var")

        assert result["found"] is True
        assert result["provisioned"] is True
        assert result["persisted"] is False
        assert result["errors"][0]["code"] == "config_persist_failed"


# ── 配置供给 ─────────────────────────────────────────────────


class TestEnsureConfig:
    def test_creates_minimal_schema_valid_config(self, tmp_path):
        result = rt.ensure_config(
            _selection(), _cfg(tmp_path), config_path=_config_path(tmp_path)
        )

        assert result["ok"] is True
        assert result["created"] is True
        assert result["managed"] is True
        doc = yaml.safe_load(_config_path(tmp_path).read_text(encoding="utf-8"))
        assert {"server", "workspace", "providers", "models", "pricing", "credentials"} <= set(doc)
        assert doc["server"]["port"] == 5100
        assert doc["server"]["hostname"] == "127.0.0.1"
        assert doc["workspace"] == str((tmp_path / "ai").resolve())
        assert doc["providers"] == [
            {"provider": "prov-a", "baseUrl": "https://api.example/v1"}
        ]
        assert doc["models"][0]["id"] == "main-model"
        assert doc["credentials"] == {"prov-a": "${LOOM_KEY_PROV_A}"}
        assert result["credential_ref"] == "${LOOM_KEY_PROV_A}"

    def test_source_contract_renders_as_string_not_boolean(self, tmp_path):
        result = rt.ensure_config(
            _selection(), _cfg(tmp_path), config_path=_config_path(tmp_path)
        )

        assert result["ok"] is True
        doc = yaml.safe_load(_config_path(tmp_path).read_text(encoding="utf-8"))
        assert doc["server"]["sourceContract"] == "off"
        assert isinstance(doc["server"]["sourceContract"], str)

    def test_overwrite_backs_up_existing_config(self, tmp_path):
        path = _write_valid_config(tmp_path)
        original = path.read_text(encoding="utf-8")

        result = rt.ensure_config(
            _selection(model="second-model"),
            _cfg(tmp_path),
            config_path=path,
            overwrite=True,
        )

        assert result["ok"] is True
        assert result["overwritten"] is True
        assert result["backup"]
        backup = Path(result["backup"])
        assert backup.read_text(encoding="utf-8") == original
        doc = yaml.safe_load(path.read_text(encoding="utf-8"))
        assert doc["models"][0]["id"] == "second-model"

    def test_existing_valid_config_is_not_overwritten(self, tmp_path):
        path = _write_valid_config(tmp_path)
        before = path.read_text(encoding="utf-8")

        result = rt.ensure_config(
            _selection(model="second-model"), _cfg(tmp_path), config_path=path
        )

        assert result["ok"] is True
        assert result["created"] is False
        assert result.get("overwrite_required") is not True
        assert path.read_text(encoding="utf-8") == before

    def test_managed_false_never_writes(self, tmp_path):
        path = _config_path(tmp_path)

        result = rt.ensure_config(
            _selection(),
            _cfg(tmp_path, manage=False),
            config_path=path,
        )

        assert result["ok"] is True
        assert result["managed"] is False
        assert result["manual_required"] is True
        assert not path.exists()

    def test_missing_base_url_is_rejected_before_write(self, tmp_path):
        result = rt.ensure_config(
            _selection(base_url=None),
            _cfg(tmp_path),
            config_path=_config_path(tmp_path),
        )

        assert result["ok"] is False
        assert result["errors"][0]["code"] == "base_url_required"
        assert not _config_path(tmp_path).exists()

    def test_custom_credential_env_and_pricing(self, tmp_path):
        result = rt.ensure_config(
            _selection(pricing={"input": 0.5, "output": 1.5, "cacheRead": 0, "cacheWrite": 0}),
            _cfg(tmp_path),
            config_path=_config_path(tmp_path),
            credential_env="MY_LOOM_KEY",
        )

        assert result["ok"] is True
        doc = yaml.safe_load(_config_path(tmp_path).read_text(encoding="utf-8"))
        assert doc["credentials"] == {"prov-a": "${MY_LOOM_KEY}"}
        assert doc["pricing"]["prov-a"] == {
            "input": 0.5,
            "output": 1.5,
            "cacheRead": 0.0,
            "cacheWrite": 0.0,
        }

    def test_low_port_is_rejected(self, tmp_path):
        result = rt.ensure_config(
            _selection(),
            _cfg(tmp_path, url="http://127.0.0.1:5000"),
            config_path=_config_path(tmp_path),
        )

        assert result["ok"] is False
        assert any(error["code"] == "port_invalid" for error in result["errors"])


# ── 生命周期：systemd ────────────────────────────────────────


class TestSystemdLifecycle:
    def _systemd(
        self,
        monkeypatch,
        calls: list[tuple[str, str]],
        *,
        state: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        _force_systemd(monkeypatch)
        unit_state = state if state is not None else {"pid": "222", "active": True}
        monkeypatch.setattr(
            rt,
            "_which",
            lambda name: "/usr/bin/systemctl" if name == "systemctl" else None,
        )

        def unit_info(unit=rt.DEFAULT_SYSTEMD_UNIT):
            return {
                "LoadState": "loaded",
                "ActiveState": "active" if unit_state["active"] else "inactive",
                "SubState": "running" if unit_state["active"] else "dead",
                "MainPID": unit_state["pid"],
                "Restart": "always",
                "WorkingDirectory": str(paths.project_root() / "loom-harness"),
            }

        monkeypatch.setattr(rt, "_systemd_unit_info", unit_info)

        def fake_systemctl(action: str, unit: str = rt.DEFAULT_SYSTEMD_UNIT):
            calls.append((action, unit))
            if action == "stop":
                unit_state["active"] = False
                unit_state["pid"] = "0"
            if action == "start":
                unit_state["active"] = True
            if action == "restart":
                unit_state["active"] = True
                unit_state["pid"] = "333"
            return {"ok": True, "returncode": 0, "detail": ""}

        monkeypatch.setattr(rt, "_systemctl_run", fake_systemctl)

        async def probe(config, token, *, timeout=rt.HEALTH_TIMEOUT_S):
            if unit_state["active"]:
                return {"ok": True, "reachable": True, "http_status": 200, "status": "ok"}
            return {"ok": False, "reachable": False, "error": "down"}

        monkeypatch.setattr(rt, "_probe_health", probe)
        return unit_state

    def test_start_and_stop_use_systemctl_only(self, tmp_path, monkeypatch):
        calls: list[tuple[str, str]] = []
        self._systemd(monkeypatch, calls)
        spawn: list[Any] = []
        monkeypatch.setattr(rt, "_spawn_child_process", lambda *a, **k: spawn.append(a))
        cfg = _cfg(tmp_path)

        started = _run(rt.start(cfg, timeout=0.01))
        stopped = _run(rt.stop(cfg, timeout=0.01))

        assert started["ok"] is True and started["pid"] == 222
        assert stopped["ok"] is True
        assert calls == [("start", "axeuh-loom"), ("stop", "axeuh-loom")]
        assert spawn == []

    def test_restart_reports_old_and_new_pid(self, tmp_path, monkeypatch):
        calls: list[tuple[str, str]] = []
        state = {"pid": "111", "active": True}
        self._systemd(monkeypatch, calls, state=state)

        result = _run(rt.restart(_cfg(tmp_path), timeout=0.01))

        assert result["ok"] is True
        assert result["performed"] is True
        assert result["verified"] is True
        assert result["old_pid"] == 111
        assert result["new_pid"] == 333
        assert calls == [("restart", "axeuh-loom")]

    def test_foreign_unit_never_invokes_systemctl(self, tmp_path, monkeypatch):
        _force_systemd(monkeypatch)
        monkeypatch.setattr(
            rt,
            "_which",
            lambda name: "/usr/bin/systemctl" if name == "systemctl" else None,
        )
        monkeypatch.setattr(
            rt,
            "_systemd_unit_info",
            lambda unit=rt.DEFAULT_SYSTEMD_UNIT: _unit_info(
                ActiveState="active",
                SubState="running",
                MainPID="222",
                WorkingDirectory=str(tmp_path / "stage-onboarding"),
            ),
        )
        calls: list[str] = []
        monkeypatch.setattr(
            rt,
            "_systemctl_run",
            lambda action, unit=rt.DEFAULT_SYSTEMD_UNIT: calls.append(action)
            or {"ok": True, "returncode": 0, "detail": ""},
        )
        cfg = _cfg(tmp_path)

        started = _run(rt.start(cfg))
        stopped = _run(rt.stop(cfg))
        restarted = _run(rt.restart(cfg))

        assert calls == []
        for result in (started, stopped, restarted):
            assert result["mode"] == rt.MODE_NONE
            assert result["manual_required"] is True
            assert result["errors"][0]["code"] == "systemd_unit_foreign"
        assert "systemd_unit_foreign" in started["detail"]
        assert "systemctl start" not in (started["command"] or "")

    def test_missing_token_after_start_is_manual_required(self, tmp_path, monkeypatch):
        calls: list[tuple[str, str]] = []
        self._systemd(monkeypatch, calls)

        result = _run(rt.start(_cfg(tmp_path, token=""), timeout=0.01))

        assert result["performed"] is True
        assert result["ok"] is False
        assert result["manual_required"] is True
        assert result["errors"][0]["code"] == "token_missing"

    def test_stop_without_token_verifies_unit_inactive(self, tmp_path, monkeypatch):
        _force_systemd(monkeypatch)
        monkeypatch.setattr(
            rt,
            "_which",
            lambda name: "/usr/bin/systemctl" if name == "systemctl" else None,
        )
        monkeypatch.setattr(
            rt,
            "_systemd_unit_info",
            lambda unit=rt.DEFAULT_SYSTEMD_UNIT: {
                "LoadState": "loaded",
                "ActiveState": "active",
                "SubState": "running",
                "MainPID": "111",
                "Restart": "always",
                "WorkingDirectory": str(paths.project_root() / "loom-harness"),
            },
        )
        monkeypatch.setattr(
            rt,
            "_systemctl_run",
            lambda action, unit=rt.DEFAULT_SYSTEMD_UNIT: {
                "ok": True,
                "returncode": 0,
                "detail": "",
            },
        )

        result = _run(rt.stop(_cfg(tmp_path, token=""), timeout=0.01))

        assert result["performed"] is True
        assert result["ok"] is False
        assert result["manual_required"] is True
        assert "仍处于活动状态" in result["detail"]


# ── 生命周期：child ──────────────────────────────────────────


class _FakeProcess:
    def __init__(self, pid: int) -> None:
        self.pid = pid


class TestChildLifecycle:
    def test_port_conflict_unknown_process_is_manual_required(
        self, tmp_path, monkeypatch
    ):
        _write_valid_config(tmp_path)
        _allow_child(monkeypatch, tmp_path)
        monkeypatch.setattr(rt, "_port_in_use", lambda port, host="127.0.0.1": True)
        monkeypatch.setattr(rt, "_port_owner_pid", lambda port, host="127.0.0.1": None)
        spawn: list[Any] = []
        monkeypatch.setattr(rt, "_spawn_child_process", lambda *a, **k: spawn.append(a))

        async def probe(config, token, *, timeout=rt.HEALTH_TIMEOUT_S):
            return {"ok": False, "reachable": True, "http_status": 401, "status": None}

        monkeypatch.setattr(rt, "_probe_health", probe)

        result = _run(rt.start(_cfg(tmp_path), timeout=0.01))

        assert result["ok"] is False
        assert result["manual_required"] is True
        assert result["errors"][0]["code"] == "port_in_use"
        assert spawn == []

    def test_port_conflict_with_healthy_same_token_is_never_adopted(
        self, tmp_path, monkeypatch
    ):
        _write_valid_config(tmp_path)
        _allow_child(monkeypatch, tmp_path)
        monkeypatch.setattr(rt, "_port_in_use", lambda port, host="127.0.0.1": True)
        monkeypatch.setattr(rt, "_port_owner_pid", lambda port, host="127.0.0.1": None)
        spawn: list[Any] = []
        probes: list[str] = []
        monkeypatch.setattr(rt, "_spawn_child_process", lambda *a, **k: spawn.append(a))

        async def probe(config, token, *, timeout=rt.HEALTH_TIMEOUT_S):
            probes.append(token)
            return {"ok": True, "reachable": True, "http_status": 200, "status": "ok"}

        monkeypatch.setattr(rt, "_probe_health", probe)

        result = _run(rt.start(_cfg(tmp_path), timeout=0.01))

        assert result["ok"] is False
        assert result["adopted"] is False
        assert result["manual_required"] is True
        assert result["errors"][0]["code"] == "port_in_use"
        assert probes == []
        assert spawn == []

    def test_spawn_injects_env_but_not_token_in_argv(self, tmp_path, monkeypatch):
        config_path = _write_valid_config(tmp_path)
        cli = _allow_child(monkeypatch, tmp_path)
        captured: dict[str, Any] = {}

        def fake_spawn(argv, *, env, cwd, log_path):
            captured.update(
                {"argv": list(argv), "env": dict(env), "cwd": cwd, "log_path": log_path}
            )
            return _FakeProcess(4242)

        monkeypatch.setattr(rt, "_spawn_child_process", fake_spawn)
        monkeypatch.setattr(
            rt,
            "_read_process_identity",
            lambda pid: rt.ProcessIdentity(
                True, 5000.0, rt._hash_argv(captured["argv"]), "/usr/bin/node"
            ),
        )

        async def probe(config, token, *, timeout=rt.HEALTH_TIMEOUT_S):
            return {"ok": True, "reachable": True, "http_status": 200, "status": "ok"}

        monkeypatch.setattr(rt, "_probe_health", probe)

        result = _run(rt.start(_cfg(tmp_path), timeout=0.01))

        assert result["ok"] is True
        assert result["pid"] == 4242
        assert TOKEN not in json.dumps(result, ensure_ascii=False)
        assert captured["argv"] == [
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
        assert captured["env"]["LOOM_TOKEN"] == TOKEN
        assert captured["env"]["LOOM_INSTANCE"] == str((tmp_path / "ai").resolve())
        assert captured["env"]["LOOM_CONFIG"] == str(config_path)
        assert captured["env"]["LOOM_STATE"] == str(
            (tmp_path / "ai").resolve() / ".loom"
        )
        assert captured["log_path"] == tmp_path / "var" / "logs" / "loom.log"
        assert TOKEN not in json.dumps(captured["argv"], ensure_ascii=False)
        pidfile = tmp_path / "var" / "run" / "loom.pid"
        record = json.loads(pidfile.read_text(encoding="utf-8"))
        assert record["pid"] == 4242
        assert record["command_hash"] == rt._hash_argv(captured["argv"])
        assert record["config_hash"]
        assert TOKEN not in pidfile.read_text(encoding="utf-8")

    def test_token_persist_failure_prevents_fake_success(self, tmp_path, monkeypatch):
        _write_valid_config(tmp_path)
        _allow_child(monkeypatch, tmp_path)
        monkeypatch.setattr(
            rt,
            "_persist_token_file",
            lambda path: (
                False,
                {"code": "config_persist_failed", "message": "locked"},
            ),
        )
        monkeypatch.setattr(
            rt, "_spawn_child_process", lambda *a, **k: _FakeProcess(6262)
        )
        monkeypatch.setattr(
            rt,
            "_read_process_identity",
            lambda pid: rt.ProcessIdentity(True, 7000.0, None, "/usr/bin/node"),
        )

        async def probe(config, token, *, timeout=rt.HEALTH_TIMEOUT_S):
            return {"ok": True, "reachable": True, "http_status": 200, "status": "ok"}

        monkeypatch.setattr(rt, "_probe_health", probe)

        result = _run(rt.start(_cfg(tmp_path, token=""), timeout=0.01))

        assert result["performed"] is True
        assert result["verified"] is True
        assert result["ok"] is False
        assert result["manual_required"] is True
        assert result["errors"][0]["code"] == "config_persist_failed"
        generated = (
            (tmp_path / "var" / "secrets" / "loom.env")
            .read_text(encoding="utf-8")
            .strip()
            .split("=", 1)[1]
        )
        assert generated not in json.dumps(result, ensure_ascii=False)

    def test_health_failure_is_reported_without_fake_success(
        self, tmp_path, monkeypatch
    ):
        _write_valid_config(tmp_path)
        _allow_child(monkeypatch, tmp_path)
        monkeypatch.setattr(
            rt, "_spawn_child_process", lambda *a, **k: _FakeProcess(5252)
        )
        monkeypatch.setattr(
            rt,
            "_read_process_identity",
            lambda pid: rt.ProcessIdentity(True, 6000.0, None, "/usr/bin/node"),
        )

        async def probe(config, token, *, timeout=rt.HEALTH_TIMEOUT_S):
            return {"ok": False, "reachable": False, "error": "connection refused"}

        monkeypatch.setattr(rt, "_probe_health", probe)

        result = _run(rt.start(_cfg(tmp_path), timeout=0.01))

        assert result["performed"] is True
        assert result["verified"] is False
        assert result["manual_required"] is True
        assert result["errors"][0]["code"] == "health_failed"

    def test_stop_rejects_foreign_pid_fingerprint(self, tmp_path, monkeypatch):
        _allow_child(monkeypatch, tmp_path)
        rt._write_pid_record(
            {
                "pid": 4321,
                "start_time": 1000.0,
                "command_hash": "expected-command",
                "config_hash": "expected-config",
            }
        )
        terminate: list[tuple[int, bool]] = []
        monkeypatch.setattr(
            rt, "_terminate_pid", lambda pid, *, graceful: terminate.append((pid, graceful))
        )
        monkeypatch.setattr(
            rt,
            "_read_process_identity",
            lambda pid: rt.ProcessIdentity(
                True, 1000.0, "foreign-command", "/usr/bin/node"
            ),
        )

        result = _run(rt.stop(_cfg(tmp_path), timeout=0.01))

        assert result["manual_required"] is True
        assert result["errors"][0]["code"] == "pidfile_foreign"
        assert terminate == []
        assert (tmp_path / "var" / "run" / "loom.pid").exists()

    def test_stop_rejects_pidfile_without_any_fingerprint(self, tmp_path, monkeypatch):
        _allow_child(monkeypatch, tmp_path)
        rt._write_pid_record({"pid": 4323})
        terminate: list[Any] = []
        monkeypatch.setattr(rt, "_terminate_pid", lambda *a, **k: terminate.append(a))
        monkeypatch.setattr(
            rt,
            "_read_process_identity",
            lambda pid: rt.ProcessIdentity(
                True, 1000.0, "expected-command", "/usr/bin/node"
            ),
        )

        result = _run(rt.stop(_cfg(tmp_path), timeout=0.01))

        assert result["manual_required"] is True
        assert "missing_fingerprint" in result["detail"]
        assert terminate == []

    def test_stop_refuses_other_uid(self, tmp_path, monkeypatch):
        _allow_child(monkeypatch, tmp_path)
        rt._write_pid_record(
            {
                "pid": 4324,
                "start_time": 1000.0,
                "command_hash": "expected-command",
                "config_hash": "expected-config",
            }
        )
        monkeypatch.setattr(rt, "_same_user", lambda pid: False)
        terminate: list[Any] = []
        monkeypatch.setattr(rt, "_terminate_pid", lambda *a, **k: terminate.append(a))
        monkeypatch.setattr(
            rt,
            "_read_process_identity",
            lambda pid: rt.ProcessIdentity(
                True, 1000.0, "expected-command", "/usr/bin/node"
            ),
        )

        result = _run(rt.stop(_cfg(tmp_path), timeout=0.01))

        assert result["manual_required"] is True
        assert "不属于当前用户" in result["detail"]
        assert terminate == []

    def test_stop_kills_only_verified_pid_and_removes_pidfile(
        self, tmp_path, monkeypatch
    ):
        _allow_child(monkeypatch, tmp_path)
        rt._write_pid_record(
            {
                "pid": 4322,
                "start_time": 1000.0,
                "command_hash": "expected-command",
                "config_hash": "expected-config",
            }
        )
        state = {"terminated": False}
        terminate: list[tuple[int, bool]] = []

        def fake_terminate(pid, *, graceful):
            terminate.append((pid, graceful))
            state["terminated"] = True
            return True

        monkeypatch.setattr(rt, "_terminate_pid", fake_terminate)
        monkeypatch.setattr(
            rt,
            "_read_process_identity",
            lambda pid: (
                rt.ProcessIdentity(False, None, None, None)
                if state["terminated"]
                else rt.ProcessIdentity(True, 1000.0, "expected-command", "/usr/bin/node")
            ),
        )

        async def probe(config, token, *, timeout=rt.HEALTH_TIMEOUT_S):
            return {"ok": False, "reachable": False}

        monkeypatch.setattr(rt, "_probe_health", probe)

        result = _run(rt.stop(_cfg(tmp_path), timeout=0.01))

        assert result["ok"] is True
        assert result["performed"] is True
        assert terminate == [(4322, True)]
        assert not (tmp_path / "var" / "run" / "loom.pid").exists()

    def test_stop_without_pidfile_but_healthy_refuses(self, tmp_path, monkeypatch):
        _allow_child(monkeypatch, tmp_path)

        async def probe(config, token, *, timeout=rt.HEALTH_TIMEOUT_S):
            return {"ok": True, "reachable": True, "http_status": 200, "status": "ok"}

        monkeypatch.setattr(rt, "_probe_health", probe)
        terminate: list[Any] = []
        monkeypatch.setattr(rt, "_terminate_pid", lambda *a, **k: terminate.append(a))

        result = _run(rt.stop(_cfg(tmp_path)))

        assert result["manual_required"] is True
        assert result["errors"][0]["code"] == "untracked_process"
        assert terminate == []

    def test_restart_in_none_mode_is_manual_required(self, tmp_path, monkeypatch):
        spawn: list[Any] = []
        monkeypatch.setattr(rt, "_spawn_child_process", lambda *a, **k: spawn.append(a))

        result = _run(rt.restart(_cfg(tmp_path), timeout=0.01))

        assert result["mode"] == rt.MODE_NONE
        assert result["requested"] is True
        assert result["manual_required"] is True
        assert spawn == []


# ── 平台与安全细节 ───────────────────────────────────────────


class TestPlatformAndSecrets:
    def test_windows_spawn_flags_are_detached_without_window(self):
        options = rt._spawn_options(True)

        assert options["creationflags"] & 0x00000200
        assert options["creationflags"] & 0x00000008
        assert options["creationflags"] & 0x08000000
        assert options["start_new_session"] is False

    def test_posix_spawn_uses_new_session(self):
        options = rt._spawn_options(False)

        assert options["start_new_session"] is True
        assert options["creationflags"] == 0

    def test_windows_identity_matches_by_start_time_and_exe(self):
        record = {
            "pid": 777,
            "start_time": 1000.0,
            "command_hash": "argv-hash",
            "exe_hash": rt._hash_text(r"C:\Program Files\nodejs\node.exe"),
        }
        identity = rt.ProcessIdentity(
            True, 1000.0, None, r"C:\Program Files\nodejs\node.exe"
        )

        assert rt._fingerprint_matches(record, identity) == (True, "ok")

        other = rt.ProcessIdentity(True, 1000.0, None, r"C:\Windows\notepad.exe")
        assert rt._fingerprint_matches(record, other) == (False, "exe_mismatch")

    def test_status_shape_has_no_token(self, tmp_path, monkeypatch):
        async def probe(config, token, *, timeout=rt.HEALTH_TIMEOUT_S):
            return {"ok": False, "reachable": False, "error": "down"}

        monkeypatch.setattr(rt, "_probe_health", probe)
        cfg = _cfg(tmp_path)
        result = _run(rt.status(cfg))

        assert result["mode"] == rt.MODE_NONE
        assert result["token_state"]["found"] is True
        assert result["token_state"]["fingerprint"] == loom.fingerprint(TOKEN)
        serialized = json.dumps(result, ensure_ascii=False)
        assert TOKEN not in serialized
        assert "token_state" in result
        assert "token" not in result


# ── HTTP 路由 ────────────────────────────────────────────────


class TestRuntimeRouter:
    def _client(self, monkeypatch) -> TestClient:
        async def allow_read(request):
            return None

        async def allow_write(request, password):
            return None

        monkeypatch.setattr(router_module.config_authz, "require_config_read", allow_read)
        monkeypatch.setattr(router_module.config_authz, "require_config_write", allow_write)
        app = FastAPI()
        app.include_router(router_module.router)
        return TestClient(app)

    def test_runtime_delegates_to_service(self, tmp_path, monkeypatch):
        client = self._client(monkeypatch)

        async def fake_status(config=None):
            return {"mode": "none", "running": False, "token_state": {"found": True}}

        monkeypatch.setattr(rt, "status", fake_status)

        response = client.get("/api/system/onboarding/loom/runtime")

        assert response.status_code == 200
        assert response.json()["mode"] == "none"

    def test_token_ensure_requires_write_auth_and_hides_token(
        self, tmp_path, monkeypatch
    ):
        passwords: list[Optional[str]] = []

        async def deny_write(request, password):
            passwords.append(password)
            raise config_authz.ConfigAuthError(403, "password_required", "需要密码")

        monkeypatch.setattr(
            router_module.config_authz, "require_config_write", deny_write
        )
        app = FastAPI()
        app.include_router(router_module.router)
        client = TestClient(app)

        response = client.post("/api/system/onboarding/loom/token/ensure", json={})

        assert response.status_code == 403
        assert passwords == [None]

    def test_start_and_stop_delegate(self, monkeypatch):
        calls: list[str] = []

        async def fake_start(config=None, **kwargs):
            calls.append("start")
            return {"ok": True, "manual_required": False}

        async def fake_stop(config=None, **kwargs):
            calls.append("stop")
            return {"ok": True, "manual_required": False}

        client = self._client(monkeypatch)
        monkeypatch.setattr(rt, "start", fake_start)
        monkeypatch.setattr(rt, "stop", fake_stop)

        assert client.post("/api/system/onboarding/loom/start").status_code == 200
        assert client.post("/api/system/onboarding/loom/stop").status_code == 200
        assert calls == ["start", "stop"]

    def test_config_ensure_maps_selection_and_credential_env(self, monkeypatch):
        captured: dict[str, Any] = {}

        def fake_ensure(selection, config=None, **kwargs):
            captured["selection"] = selection
            captured["kwargs"] = kwargs
            return {"ok": True, "created": True}

        client = self._client(monkeypatch)
        monkeypatch.setattr(rt, "ensure_config", fake_ensure)

        response = client.post(
            "/api/system/onboarding/loom/config/ensure",
            json={
                "provider": "prov-a",
                "model": "main-model",
                "base_url": "https://api.example/v1",
                "credential_env": "MY_LOOM_KEY",
                "overwrite": True,
            },
        )

        assert response.status_code == 200
        assert captured["selection"].provider == "prov-a"
        assert captured["selection"].base_url == "https://api.example/v1"
        assert captured["kwargs"]["credential_env"] == "MY_LOOM_KEY"
        assert captured["kwargs"]["overwrite"] is True


class TestManagedConfigPermissions:
    def test_managed_config_is_written_0600(self, tmp_path):
        path = _write_valid_config(tmp_path)

        assert stat.S_IMODE(path.stat().st_mode) == 0o600

    def test_overwrite_backup_keeps_0600(self, tmp_path):
        path = _write_valid_config(tmp_path)

        result = rt.ensure_config(
            _selection(), _cfg(tmp_path), overwrite=True
        )

        assert result["ok"] is True
        assert result["backup"] is not None
        backup = Path(result["backup"])
        assert stat.S_IMODE(backup.stat().st_mode) == 0o600
        assert stat.S_IMODE(path.stat().st_mode) == 0o600


class TestTokenPersistControl:
    def test_persist_false_writes_token_file_without_config_store(
        self, tmp_path, monkeypatch
    ):
        calls: list[Path] = []

        def forbidden_persist(path: Path) -> tuple[bool, Optional[dict[str, str]]]:
            calls.append(path)
            return True, None

        monkeypatch.setattr(rt, "_persist_token_file", forbidden_persist)

        state = rt._ensure_token_internal(_cfg(tmp_path, token=""), persist=False)

        assert state.token
        assert calls == []
        token_file = Path(str(state.public["token_file"]))
        assert token_file.is_file()
        assert stat.S_IMODE(token_file.stat().st_mode) == 0o600
