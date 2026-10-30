# -*- coding: utf-8 -*-
"""Task 6: staged apply transaction - strategy order, partial failure, retry.

The transaction executes hot -> reconnect -> respawn -> deployment, keeps a
failure in one group from stopping later groups, and persists only the
successful path subset. Failed values stay staged and never reach config.yaml.
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any, Iterator

import pytest
import yaml
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

import config.config as config_module
import config.store as store_module
from config.providers import YamlFileProvider
from config.store import ConfigStore
from routers import system_config
from services import config_reconciler

APPLY_URL = "/api/config/apply"
RETRY_URL = "/api/config/apply/retry"
PENDING_URL = "/api/config/pending"
DRAFT_URL = "/api/config/draft"

BASE_DOCUMENT: dict[str, Any] = {
    "server": {"host": "127.0.0.1", "port": 9443},
    "tts": {"enabled": False},
    "qq_gateway": {
        "enabled": False,
        "account": {"ws_url": "ws://127.0.0.1:3001"},
    },
    "moss": {"enabled": False, "model": "old-model"},
    "launcher": {"conda_python": "python"},
    "kernel": {"python": ""},
}


def _write_base(tmp_path) -> Any:
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        yaml.safe_dump(BASE_DOCUMENT, allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )
    return config_path


def _make_store(tmp_path) -> tuple[ConfigStore, Any]:
    config_path = _write_base(tmp_path)
    store = ConfigStore(
        YamlFileProvider(config_path),
        watcher_interval_s=0.01,
        draft_path=tmp_path / "config_draft.json",
    )
    return store, config_path


def _read_yaml(config_path) -> dict[str, Any]:
    return yaml.safe_load(config_path.read_text(encoding="utf-8"))


def _mock_hooks(monkeypatch) -> tuple[dict[str, list[tuple[str, ...]]], dict[str, bool]]:
    calls: dict[str, list[tuple[str, ...]]] = {
        "reconnect": [],
        "respawn": [],
    }
    state = {"respawn_fails": True}

    async def _reconnect(paths: tuple[str, ...]) -> dict[str, Any]:
        calls["reconnect"].append(paths)
        return {"ok": True}

    async def _respawn(paths: tuple[str, ...]) -> dict[str, Any]:
        calls["respawn"].append(paths)
        if state["respawn_fails"]:
            raise RuntimeError("moss respawn boom")
        return {"ok": True}

    monkeypatch.setitem(
        config_reconciler._RECONNECT_HOOKS, "qq_gateway", _reconnect
    )
    monkeypatch.setitem(config_reconciler._RESPAWN_HOOKS, "moss", _respawn)
    return calls, state


def _stage_four(store: ConfigStore) -> None:
    store.stage(
        {
            "tts.enabled": True,
            "qq_gateway.account.ws_url": "ws://new.local:3001",
            "moss.enabled": True,
            "launcher.conda_python": "/opt/kinship/.venv-health/bin/python",
        }
    )


def test_partial_failure_commits_only_successful_paths_and_retry(
    monkeypatch, tmp_path
) -> None:
    store, config_path = _make_store(tmp_path)
    calls, state = _mock_hooks(monkeypatch)
    applier_seen: list[tuple[str, ...]] = []

    def _probe(change) -> None:
        applier_seen.append(change.changed_paths)

    store.register_applier("probe", _probe)
    _stage_four(store)

    result = asyncio.run(config_reconciler.apply_staged(store))

    assert result["partial"] is True
    assert len(result["applied"]) == 3
    assert set(result["applied"]) == {
        "tts.enabled",
        "qq_gateway.account.ws_url",
        "launcher.conda_python",
    }
    assert len(result["failed"]) == 1
    failure = result["failed"][0]
    assert failure["path"] == "moss.enabled"
    assert "moss respawn boom" in failure["error"]
    assert [entry["path"] for entry in result["deferred_restart"]] == [
        "launcher.conda_python"
    ]
    assert result["deferred_restart"][0]["requires_restart"] is True

    persisted = _read_yaml(config_path)
    assert persisted["tts"]["enabled"] is True
    assert persisted["qq_gateway"]["account"]["ws_url"] == "ws://new.local:3001"
    assert persisted["launcher"]["conda_python"] == (
        "/opt/kinship/.venv-health/bin/python"
    )
    assert persisted["moss"]["enabled"] is False

    assert store.pending() == {
        "moss.enabled": {"from": False, "to": True}
    }
    assert (tmp_path / "config_draft.json").exists()

    state["respawn_fails"] = False
    retry = asyncio.run(config_reconciler.apply_staged(store))

    assert retry["partial"] is False
    assert retry["applied"] == ["moss.enabled"]
    assert retry["failed"] == []
    assert retry["deferred_restart"] == []
    assert len(calls["reconnect"]) == 1
    assert len(calls["respawn"]) == 2
    assert calls["respawn"][1] == ("moss.enabled",)
    assert applier_seen == [("tts.enabled",)]

    assert _read_yaml(config_path)["moss"]["enabled"] is True
    assert store.pending() == {}
    assert store.staged_revision is None
    assert not (tmp_path / "config_draft.json").exists()


def test_reconnect_failure_does_not_stop_later_groups(
    monkeypatch, tmp_path
) -> None:
    store, config_path = _make_store(tmp_path)

    async def _reconnect_boom(paths: tuple[str, ...]) -> dict[str, Any]:
        raise RuntimeError("reconnect boom")

    async def _respawn_ok(paths: tuple[str, ...]) -> dict[str, Any]:
        return {"ok": True}

    monkeypatch.setitem(
        config_reconciler._RECONNECT_HOOKS, "qq_gateway", _reconnect_boom
    )
    monkeypatch.setitem(config_reconciler._RESPAWN_HOOKS, "moss", _respawn_ok)
    store.stage(
        {
            "qq_gateway.account.ws_url": "ws://new.local:3001",
            "moss.enabled": True,
            "launcher.conda_python": "/opt/kinship/.venv-health/bin/python",
        }
    )

    result = asyncio.run(config_reconciler.apply_staged(store))

    assert result["partial"] is True
    assert set(result["applied"]) == {
        "moss.enabled",
        "launcher.conda_python",
    }
    assert [item["path"] for item in result["failed"]] == [
        "qq_gateway.account.ws_url"
    ]
    persisted = _read_yaml(config_path)
    assert persisted["qq_gateway"]["account"]["ws_url"] == (
        "ws://127.0.0.1:3001"
    )
    assert persisted["moss"]["enabled"] is True
    assert persisted["launcher"]["conda_python"] == (
        "/opt/kinship/.venv-health/bin/python"
    )
    assert store.pending() == {
        "qq_gateway.account.ws_url": {
            "from": "ws://127.0.0.1:3001",
            "to": "ws://new.local:3001",
        }
    }


def test_hooks_see_staged_values_but_committed_snapshot_is_restored(
    monkeypatch, tmp_path
) -> None:
    store, _config_path = _make_store(tmp_path)
    monkeypatch.setattr(store_module, "_STORE", store)
    monkeypatch.setattr(
        config_module, "get_config_store", lambda: store
    )
    observed: list[bool] = []

    async def _respawn(paths: tuple[str, ...]) -> dict[str, Any]:
        observed.append(config_module.get_config().MOSS_ENABLED)
        return {"ok": True}

    monkeypatch.setitem(config_reconciler._RESPAWN_HOOKS, "moss", _respawn)
    store.stage({"moss.enabled": True})

    result = asyncio.run(config_reconciler.apply_staged(store))

    assert result["applied"] == ["moss.enabled"]
    assert observed == [True]
    assert store.previewing is False


def test_kernel_python_missing_interpreter_fails_without_respawn(
    monkeypatch, tmp_path
) -> None:
    store, config_path = _make_store(tmp_path)
    invoked: list[tuple[str, ...]] = []

    async def _respawn(paths: tuple[str, ...]) -> dict[str, Any]:
        invoked.append(paths)
        return {"ok": True}

    monkeypatch.setitem(config_reconciler._RESPAWN_HOOKS, "kernel", _respawn)
    store.stage({"kernel.python": "/no/such/python"})

    result = asyncio.run(config_reconciler.apply_staged(store))

    assert result["partial"] is False
    assert result["applied"] == []
    assert len(result["failed"]) == 1
    assert result["failed"][0]["path"] == "kernel.python"
    assert "解释器不存在" in result["failed"][0]["error"]
    assert invoked == []
    assert _read_yaml(config_path)["kernel"]["python"] == ""
    assert store.pending() == {
        "kernel.python": {"from": "", "to": "/no/such/python"}
    }


def test_deprecated_clear_commits_without_side_effects(tmp_path) -> None:
    document = dict(BASE_DOCUMENT)
    document["log"] = {"level": "INFO"}
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        yaml.safe_dump(document, allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )
    store = ConfigStore(
        YamlFileProvider(config_path),
        watcher_interval_s=0.01,
        draft_path=tmp_path / "config_draft.json",
    )
    store.stage({}, clear_keys=["log.level"])

    result = asyncio.run(config_reconciler.apply_staged(store))

    assert result["applied"] == ["log.level"]
    assert result["failed"] == []
    assert result["deferred_restart"] == []
    assert "level" not in (_read_yaml(config_path).get("log") or {})
    assert store.pending() == {}
    assert not (tmp_path / "config_draft.json").exists()


def _build_app() -> FastAPI:
    app = FastAPI()

    @app.middleware("http")
    async def _inject_identity(request: Request, call_next):
        request.state.user_id = request.headers.get(
            "X-Test-User", "alice"
        )
        request.state.token_kind = "user"
        return await call_next(request)

    app.include_router(system_config.router)
    app.include_router(system_config.draft_router)
    return app


@pytest.fixture
def client(monkeypatch) -> Iterator[TestClient]:
    async def _allow(request: Request, password: str | None = None):
        return SimpleNamespace(
            user_id="tester", method="password", token_kind="user"
        )

    monkeypatch.setattr(system_config, "require_config_write", _allow)
    with TestClient(_build_app()) as test_client:
        yield test_client


def test_apply_and_retry_endpoints(client, monkeypatch, tmp_path) -> None:
    store, config_path = _make_store(tmp_path)
    monkeypatch.setattr(system_config, "get_config_store", lambda: store)
    calls, state = _mock_hooks(monkeypatch)

    staged = client.post(
        DRAFT_URL,
        json={
            "changes": {
                "tts.enabled": True,
                "moss.enabled": True,
                "launcher.conda_python": "/opt/kinship/.venv-health/bin/python",
            }
        },
        headers={"X-Test-User": "alice"},
    )
    assert staged.status_code == 200

    applied = client.post(APPLY_URL, json={}, headers={"X-Test-User": "alice"})
    assert applied.status_code == 200
    body = applied.json()
    assert body["partial"] is True
    assert set(body["applied"]) == {"tts.enabled", "launcher.conda_python"}
    assert len(body["failed"]) == 1
    assert body["failed"][0]["path"] == "moss.enabled"
    assert "moss respawn boom" in body["failed"][0]["error"]
    assert body["deferred_restart"][0]["path"] == "launcher.conda_python"

    pending = client.get(PENDING_URL, headers={"X-Test-User": "alice"})
    assert pending.status_code == 200
    assert [item["path"] for item in pending.json()["changes"]] == [
        "moss.enabled"
    ]
    assert _read_yaml(config_path)["moss"]["enabled"] is False

    state["respawn_fails"] = False
    retried = client.post(
        RETRY_URL, json={}, headers={"X-Test-User": "alice"}
    )
    assert retried.status_code == 200
    retry_body = retried.json()
    assert retry_body["applied"] == ["moss.enabled"]
    assert retry_body["failed"] == []
    assert len(calls["reconnect"]) == 0
    assert len(calls["respawn"]) == 2

    assert client.get(PENDING_URL, headers={"X-Test-User": "alice"}).json()[
        "count"
    ] == 0
    assert _read_yaml(config_path)["moss"]["enabled"] is True
    assert not (tmp_path / "config_draft.json").exists()
