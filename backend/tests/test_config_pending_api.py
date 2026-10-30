# -*- coding: utf-8 -*-
"""Task 5: ``GET /api/config/pending`` diff contract.

The endpoint must be directly consumable by the settings UI: a flat list of
``{path, from, to, strategy, requires_restart}`` items, with secrets masked and
unknown staged paths rejected as 409 instead of silently omitted.
"""
from __future__ import annotations

import copy
from types import SimpleNamespace
from typing import Any, Iterator

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from config.providers import ProviderInfo
from config.store import ConfigStore
from routers import system_config

DRAFT_URL = "/api/config/draft"
PENDING_URL = "/api/config/pending"
DISCARD_URL = "/api/config/discard"
CONFIG_URL = "/api/system/config"
CONFIG_ALIAS_URL = "/api/config"

HEADERS = {"X-Test-User": "alice"}


class MemoryProvider:
    kind = "memory"

    def __init__(self, document: dict[str, Any] | None = None) -> None:
        self._document = copy.deepcopy(document or {})
        self._revision = 0

    def load(self) -> dict[str, Any]:
        return copy.deepcopy(self._document)

    def save(
        self, document: dict[str, Any], *, expected_revision: str | None = None
    ) -> str:
        self._document = copy.deepcopy(document)
        self._revision += 1
        return self.revision()

    def revision(self) -> str:
        return f"mem-{self._revision}"

    def describe(self) -> ProviderInfo:
        return ProviderInfo(
            kind="memory",
            location="memory://test",
            writable=True,
            detail="in-memory test provider",
        )


BASE_DOCUMENT: dict[str, Any] = {
    "moss": {
        "enabled": False,
        "base_url": "http://127.0.0.1:8100",
    },
    "tts": {"enabled": False},
    "launcher": {"conda_python": "python"},
    "loom": {"token": ""},
}


def _make_store(
    tmp_path, document: dict[str, Any] | None = None
) -> ConfigStore:
    provider = MemoryProvider(
        BASE_DOCUMENT if document is None else document
    )
    return ConfigStore(
        provider,
        watcher_interval_s=0.01,
        draft_path=tmp_path / "config_draft.json",
    )


def _install_store(monkeypatch, store: Any) -> None:
    monkeypatch.setattr(system_config, "get_config_store", lambda: store)


@pytest.fixture
def client(monkeypatch) -> Iterator[TestClient]:
    async def _allow(request: Request, password: str | None = None):
        return SimpleNamespace(
            user_id="tester", method="password", token_kind="user"
        )

    monkeypatch.setattr(system_config, "require_config_read", _allow)
    monkeypatch.setattr(system_config, "require_config_write", _allow)

    app = FastAPI()

    @app.middleware("http")
    async def _inject_identity(request: Request, call_next):
        user_id = request.headers.get("X-Test-User", "").strip()
        if user_id:
            request.state.user_id = user_id
        return await call_next(request)

    app.include_router(system_config.router)
    app.include_router(system_config.draft_router)
    with TestClient(app) as test_client:
        yield test_client


def test_pending_empty_draft_returns_empty_list(client, monkeypatch, tmp_path):
    store = _make_store(tmp_path)
    _install_store(monkeypatch, store)

    response = client.get(PENDING_URL, headers=HEADERS)

    assert response.status_code == 200
    body = response.json()
    assert body["changes"] == []
    assert body["count"] == 0
    assert body["revision"] == store.revision
    assert body["staged_revision"] is None


def test_pending_three_drafts_has_frontend_fields(
    client, monkeypatch, tmp_path
):
    store = _make_store(tmp_path)
    _install_store(monkeypatch, store)

    staged = client.post(
        DRAFT_URL,
        json={
            "changes": {
                "moss.enabled": True,
                "tts.enabled": True,
                "launcher.conda_python": "/opt/kinship/.venv-health/bin/python",
            }
        },
        headers=HEADERS,
    )
    assert staged.status_code == 200

    response = client.get(PENDING_URL, headers=HEADERS)
    assert response.status_code == 200
    body = response.json()

    assert body["count"] == 3
    assert len(body["changes"]) == 3
    assert body["revision"] == store.revision
    assert body["staged_revision"].startswith("draft-")

    required = {"path", "from", "to", "strategy", "requires_restart"}
    items = {item["path"]: item for item in body["changes"]}
    assert set(items) == {
        "moss.enabled",
        "tts.enabled",
        "launcher.conda_python",
    }
    for item in body["changes"]:
        assert required <= set(item)
        assert item["strategy"] in {
            "hot",
            "reconnect",
            "respawn",
            "deployment",
            "none",
        }
        assert isinstance(item["requires_restart"], bool)

    assert items["moss.enabled"]["from"] is False
    assert items["moss.enabled"]["to"] is True
    assert items["moss.enabled"]["strategy"] == "respawn"
    assert items["moss.enabled"]["requires_restart"] is False

    assert items["tts.enabled"]["strategy"] == "hot"
    assert items["tts.enabled"]["requires_restart"] is False

    assert items["launcher.conda_python"]["strategy"] == "deployment"
    assert items["launcher.conda_python"]["requires_restart"] is True


def test_pending_never_echoes_raw_secrets(client, monkeypatch, tmp_path):
    store = _make_store(tmp_path)
    _install_store(monkeypatch, store)

    token_secret = "super-secret-token-value"
    embedded_secret = "embedded-token-123"
    api_secret = "mimo-raw-key-value"

    staged = client.post(
        DRAFT_URL,
        json={
            "changes": {
                "loom.token": token_secret,
                "api.mimo_key": api_secret,
                "moss.base_url": (
                    f"http://{embedded_secret}@127.0.0.1:8100/v1"
                    f"?token={embedded_secret}"
                ),
            }
        },
        headers=HEADERS,
    )
    assert staged.status_code == 200

    response = client.get(PENDING_URL, headers=HEADERS)
    assert response.status_code == 200
    body = response.json()
    items = {item["path"]: item for item in body["changes"]}

    assert items["loom.token"]["to"] == "***"
    assert items["api.mimo_key"]["to"] == "***"
    assert embedded_secret not in items["moss.base_url"]["to"]
    assert items["moss.base_url"]["to"].startswith("http://***@")

    assert token_secret not in response.text
    assert embedded_secret not in response.text
    assert api_secret not in response.text


def test_get_config_exposes_pending_flags(client, monkeypatch, tmp_path):
    store = _make_store(tmp_path)
    _install_store(monkeypatch, store)

    initial = client.get(CONFIG_URL, headers=HEADERS).json()
    assert initial["has_pending"] is False
    assert initial["pending_count"] == 0
    assert "config" in initial and "revision" in initial

    client.post(
        DRAFT_URL,
        json={"changes": {"moss.enabled": True, "tts.enabled": True}},
        headers=HEADERS,
    )

    pending = client.get(CONFIG_URL, headers=HEADERS).json()
    assert pending["has_pending"] is True
    assert pending["pending_count"] == 2
    assert pending["config"]["moss"]["enabled"] is False

    alias = client.get(CONFIG_ALIAS_URL, headers=HEADERS).json()
    assert alias["has_pending"] is True
    assert alias["pending_count"] == 2

    client.post(DISCARD_URL, json={}, headers=HEADERS)

    cleared = client.get(CONFIG_URL, headers=HEADERS).json()
    assert cleared["has_pending"] is False
    assert cleared["pending_count"] == 0


def test_pending_unknown_path_returns_409_listing_keys(client, monkeypatch):
    class PendingOnlyStore:
        revision = "rev-1"
        staged_revision = "draft-unknown"

        def pending(self) -> dict[str, Any]:
            return {
                "mystery.option": {"from": None, "to": "x"},
                "another.unknown": {"from": None, "to": 1},
            }

    _install_store(monkeypatch, PendingOnlyStore())

    response = client.get(PENDING_URL, headers=HEADERS)

    assert response.status_code == 409
    body = response.json()
    assert body["paths"] == ["another.unknown", "mystery.option"]
    assert {error["path"] for error in body["errors"]} == {
        "mystery.option",
        "another.unknown",
    }
    assert "mystery.option" in response.text


def test_draft_unknown_key_returns_409_listing_key(
    client, monkeypatch, tmp_path
):
    store = _make_store(tmp_path)
    _install_store(monkeypatch, store)

    response = client.post(
        DRAFT_URL,
        json={"changes": {"mystery.option": 1}},
        headers=HEADERS,
    )

    assert response.status_code == 409
    body = response.json()
    assert any(
        error["path"] == "mystery.option"
        and error["code"] == "unknown_key"
        for error in body.get("errors", [])
    )
    assert client.get(PENDING_URL, headers=HEADERS).json()["changes"] == []


def test_ssl_pending_requires_restart_without_applying_hot(
    client, monkeypatch, tmp_path
):
    import core.hot_server as hot_server
    import services.kernel_client as kernel_client

    store = _make_store(tmp_path)
    _install_store(monkeypatch, store)

    calls: list[str] = []

    class _FakeServer:
        async def rebind_from_config(self) -> dict[str, Any]:
            calls.append("rebind")
            return {"ok": True}

    monkeypatch.setattr(hot_server, "get_hot_server", lambda: _FakeServer())
    monkeypatch.setattr(
        kernel_client,
        "stop_kernel_process",
        lambda **kwargs: calls.append("kernel_stop"),
    )
    monkeypatch.setattr(
        kernel_client,
        "restart_kernel",
        lambda **kwargs: calls.append("kernel_restart"),
    )

    staged = client.post(
        DRAFT_URL,
        json={"changes": {"ssl.enabled": True}},
        headers=HEADERS,
    )
    assert staged.status_code == 200

    body = client.get(PENDING_URL, headers=HEADERS).json()
    items = {item["path"]: item for item in body["changes"]}
    item = items["ssl.enabled"]
    assert item["from"] is False
    assert item["to"] is True
    assert item["strategy"] == "deployment"
    assert item["requires_restart"] is True

    applied = client.post("/api/config/apply", json={}, headers=HEADERS)
    assert applied.status_code == 200
    result = applied.json()

    assert result["applied"] == ["ssl.enabled"]
    assert result["failed"] == []
    deferred = {
        entry["path"]: entry for entry in result["deferred_restart"]
    }
    assert deferred["ssl.enabled"]["strategy"] == "deployment"
    assert deferred["ssl.enabled"]["requires_restart"] is True
    assert calls == []
