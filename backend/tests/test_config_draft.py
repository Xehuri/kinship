# -*- coding: utf-8 -*-
from __future__ import annotations

import copy
import json
import logging
import stat
from types import SimpleNamespace
from typing import Any, Iterator

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from config.providers import ComposedProvider, ProviderInfo
from config.store import (
    ConfigEnvLocked,
    ConfigStore,
    ConfigValidationError,
)
from middleware.onboarding_gate import is_allowed_path
from routers import system_config
from services import config_reconciler
from services.config_authz import ConfigAuthError

DRAFT_URL = "/api/config/draft"
PENDING_URL = "/api/config/pending"
DISCARD_URL = "/api/config/discard"
APPLY_URL = "/api/config/apply"
CONFIG_URL = "/api/system/config"


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


class OverlayProvider:
    kind = "env"

    def __init__(self, document: dict[str, Any] | None = None) -> None:
        self._document = copy.deepcopy(document or {})

    def load(self) -> dict[str, Any]:
        return copy.deepcopy(self._document)

    def revision(self) -> str:
        return "overlay-1"

    def describe(self) -> ProviderInfo:
        return ProviderInfo(
            kind="env",
            location="env://test",
            writable=False,
            detail="read-only overlay",
        )


BASE_DOCUMENT: dict[str, Any] = {
    "server": {"port": 9443},
    "moss": {"enabled": False, "model": "base-model"},
    "tts": {"enabled": False},
}


def _make_store(
    tmp_path, document: dict[str, Any] | None = None
) -> tuple[ConfigStore, MemoryProvider]:
    provider = MemoryProvider(
        BASE_DOCUMENT if document is None else document
    )
    store = ConfigStore(
        provider,
        watcher_interval_s=0.01,
        draft_path=tmp_path / "config_draft.json",
    )
    return store, provider


def _draft_file(tmp_path):
    return tmp_path / "config_draft.json"


def test_stage_pending_discard_does_not_touch_committed_state(tmp_path):
    store, provider = _make_store(tmp_path)
    revision = store.revision
    snapshot_before = copy.deepcopy(store.snapshot())

    diff = store.stage({"moss.enabled": True})

    assert diff == {"moss.enabled": {"from": False, "to": True}}
    assert store.pending() == diff
    assert store.revision == revision
    assert store.get("moss.enabled") is False
    assert store.snapshot() == snapshot_before
    assert provider.load()["moss"]["enabled"] is False
    assert store.staged_revision is not None
    assert store.staged_revision.startswith("draft-")
    assert _draft_file(tmp_path).exists()

    store.discard()

    assert store.pending() == {}
    assert store.staged_revision is None
    assert not _draft_file(tmp_path).exists()


def test_stage_accepts_nested_changes_and_clear_keys(tmp_path):
    store, _provider = _make_store(tmp_path)

    first = store.stage({"moss": {"enabled": True, "model": "new-model"}})

    assert first == {
        "moss.enabled": {"from": False, "to": True},
        "moss.model": {"from": "base-model", "to": "new-model"},
    }

    second = store.stage({}, clear_keys=["moss.model"])

    assert second == {
        "moss.enabled": {"from": False, "to": True},
        "moss.model": {"from": "base-model", "to": None},
    }
    assert store.pending() == second


def test_restart_recovers_staged_draft(tmp_path):
    store, provider = _make_store(tmp_path)
    store.stage({"moss.enabled": True})
    staged_revision = store.staged_revision

    recovered = ConfigStore(
        provider,
        watcher_interval_s=0.01,
        draft_path=_draft_file(tmp_path),
    )

    assert recovered.pending() == {
        "moss.enabled": {"from": False, "to": True}
    }
    assert recovered.staged_revision == staged_revision
    assert recovered.get("moss.enabled") is False
    assert provider.load()["moss"]["enabled"] is False


def test_stage_noop_value_does_not_create_invisible_draft(tmp_path):
    store, _provider = _make_store(tmp_path)

    diff = store.stage({"moss.enabled": False})
    masked = store.stage({"loom.token": "***"})

    assert diff == {}
    assert masked == {}
    assert store.pending() == {}
    assert store.staged_revision is None
    assert not _draft_file(tmp_path).exists()


def test_invalid_stage_is_rejected_and_pending_stays_empty(tmp_path):
    store, _provider = _make_store(tmp_path)

    with pytest.raises(ConfigValidationError) as exc_info:
        store.stage({"server.port": 0})

    assert any(
        error.path == "server.port" and error.code == "out_of_range"
        for error in exc_info.value.errors
    )
    assert store.pending() == {}
    assert not _draft_file(tmp_path).exists()

    with pytest.raises(ConfigValidationError) as unknown:
        store.stage({"not.a.real.key": 1})
    assert any(
        error.code == "unknown_key" for error in unknown.value.errors
    )
    assert store.pending() == {}


def test_env_locked_stage_is_rejected(tmp_path):
    provider = MemoryProvider(BASE_DOCUMENT)
    overlay = OverlayProvider({"moss": {"enabled": True}})
    store = ConfigStore(
        ComposedProvider(provider, overlay),
        watcher_interval_s=0.01,
        draft_path=_draft_file(tmp_path),
    )

    with pytest.raises(ConfigEnvLocked) as exc_info:
        store.stage({"moss.enabled": False})

    assert exc_info.value.paths == ("moss.enabled",)
    assert store.pending() == {}
    assert not _draft_file(tmp_path).exists()


def test_commit_paths_persists_only_selected_and_keeps_rest_staged(tmp_path):
    store, provider = _make_store(tmp_path)
    store.stage({"moss.enabled": True})
    store.stage({"tts.enabled": True})

    outcome = store.commit(paths=["moss.enabled"])

    assert outcome.change.changed_paths == ("moss.enabled",)
    assert provider.load()["moss"]["enabled"] is True
    assert provider.load()["tts"]["enabled"] is False
    assert store.pending() == {
        "tts.enabled": {"from": False, "to": True}
    }
    assert _draft_file(tmp_path).exists()
    assert store.staged_revision is not None

    second = store.commit()

    assert second.change.changed_paths == ("tts.enabled",)
    assert provider.load()["tts"]["enabled"] is True
    assert store.pending() == {}
    assert store.staged_revision is None
    assert not _draft_file(tmp_path).exists()


def test_commit_paths_can_persist_a_clear(tmp_path):
    store, provider = _make_store(tmp_path)
    store.stage({}, clear_keys=["moss.model"])

    outcome = store.commit(paths=["moss.model"])

    assert outcome.change.changed_paths == ("moss.model",)
    assert "model" not in provider.load()["moss"]
    assert store.pending() == {}
    assert not _draft_file(tmp_path).exists()


def test_commit_all_persists_everything_and_deletes_draft(tmp_path):
    store, provider = _make_store(tmp_path)
    store.stage({"moss.enabled": True, "tts.enabled": True})

    outcome = store.commit()

    assert set(outcome.change.changed_paths) == {
        "moss.enabled",
        "tts.enabled",
    }
    assert provider.load()["moss"]["enabled"] is True
    assert provider.load()["tts"]["enabled"] is True
    assert store.pending() == {}
    assert not _draft_file(tmp_path).exists()


def test_commit_with_unknown_path_is_noop(tmp_path):
    store, provider = _make_store(tmp_path)
    store.stage({"moss.enabled": True})
    before = provider.load()

    outcome = store.commit(paths=["tts.enabled"])

    assert outcome.change.changed_paths == ()
    assert provider.load() == before
    assert store.pending() == {
        "moss.enabled": {"from": False, "to": True}
    }


def test_commit_empty_paths_prunes_noop_residual(tmp_path):
    store, provider = _make_store(tmp_path)
    store.stage({"moss.enabled": True})
    store.save({"moss.enabled": True})
    assert store.pending() == {}
    assert _draft_file(tmp_path).exists()

    outcome = store.commit(paths=[])

    assert outcome.change.changed_paths == ()
    assert _draft_file(tmp_path).exists() is False
    assert store.staged_revision is None
    assert provider.load()["moss"]["enabled"] is True


def test_draft_file_permissions_and_corrupt_file_is_ignored(
    tmp_path, caplog
):
    store, provider = _make_store(tmp_path)
    store.stage({"moss.enabled": True})
    draft = _draft_file(tmp_path)

    assert stat.S_IMODE(draft.stat().st_mode) == 0o600

    draft.write_text("{not-json", encoding="utf-8")
    with caplog.at_level(logging.WARNING, logger="config.store"):
        recovered = ConfigStore(
            provider,
            watcher_interval_s=0.01,
            draft_path=draft,
        )
    assert recovered.pending() == {}
    assert recovered.staged_revision is None
    assert any("已忽略" in record.message for record in caplog.records)

    draft.write_text(
        json.dumps({"version": 1, "staged": ["wrong-shape"]}),
        encoding="utf-8",
    )
    recovered = ConfigStore(
        provider,
        watcher_interval_s=0.01,
        draft_path=draft,
    )
    assert recovered.pending() == {}


def test_restore_prunes_staged_entries_already_committed(tmp_path):
    draft = _draft_file(tmp_path)
    draft.write_text(
        json.dumps(
            {
                "version": 1,
                "staged_revision": "draft-stale",
                "staged": {"moss.enabled": True},
                "clear": [],
            }
        ),
        encoding="utf-8",
    )
    provider = MemoryProvider(
        {"server": {"port": 9443}, "moss": {"enabled": True}}
    )

    store = ConfigStore(
        provider,
        watcher_interval_s=0.01,
        draft_path=draft,
    )

    assert store.pending() == {}
    assert store.staged_revision is None
    assert not draft.exists()


def test_config_draft_paths_allowed_in_bootstrap():
    assert is_allowed_path("/api/config") is True
    assert is_allowed_path("/api/config/draft") is True
    assert is_allowed_path("/api/config/pending") is True
    assert is_allowed_path("/api/config/discard") is True
    assert is_allowed_path("/api/config/apply") is True
    assert is_allowed_path("/api/config/apply/retry") is True


def _build_app() -> FastAPI:
    app = FastAPI()

    @app.middleware("http")
    async def _inject_identity(request: Request, call_next):
        user_id = request.headers.get("X-Test-User", "").strip()
        if user_id:
            request.state.user_id = user_id
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


def _install_store(monkeypatch, store: ConfigStore) -> None:
    monkeypatch.setattr(system_config, "get_config_store", lambda: store)


def test_draft_route_keeps_config_until_apply(client, monkeypatch, tmp_path):
    store, _provider = _make_store(tmp_path)
    _install_store(monkeypatch, store)
    headers = {"X-Test-User": "alice"}

    async def _respawn_ok(paths):
        return {"ok": True}

    monkeypatch.setitem(
        config_reconciler._RESPAWN_HOOKS, "moss", _respawn_ok
    )

    initial = client.get(CONFIG_URL, headers=headers).json()
    assert initial["config"]["moss"]["enabled"] is False
    revision = initial["revision"]

    staged = client.post(
        DRAFT_URL,
        json={"changes": {"moss.enabled": True}},
        headers=headers,
    )
    assert staged.status_code == 200
    staged_body = staged.json()
    assert staged_body["changes"] == {
        "moss.enabled": {"from": False, "to": True}
    }
    assert staged_body["staged_revision"].startswith("draft-")

    pending = client.get(PENDING_URL, headers=headers)
    assert pending.status_code == 200
    assert pending.json()["changes"] == [
        {
            "path": "moss.enabled",
            "from": False,
            "to": True,
            "strategy": "respawn",
            "requires_restart": False,
        }
    ]
    assert pending.json()["count"] == 1

    after_draft = client.get(CONFIG_URL, headers=headers).json()
    assert after_draft["revision"] == revision
    assert after_draft["config"]["moss"]["enabled"] is False

    applied = client.post(APPLY_URL, json={}, headers=headers)
    assert applied.status_code == 200
    applied_body = applied.json()
    assert applied_body["revision"] != revision
    assert applied_body["changes"] == ["moss.enabled"]
    assert applied_body["applied"] == ["moss.enabled"]
    assert applied_body["failed"] == []
    assert applied_body["deferred_restart"] == []

    final = client.get(CONFIG_URL, headers=headers).json()
    assert final["config"]["moss"]["enabled"] is True
    assert final["revision"] == applied_body["revision"]
    assert not _draft_file(tmp_path).exists()


def test_draft_route_accepts_top_level_changes_shape(
    client, monkeypatch, tmp_path
):
    store, _provider = _make_store(tmp_path)
    _install_store(monkeypatch, store)
    headers = {"X-Test-User": "alice"}

    response = client.post(
        DRAFT_URL,
        json={"moss.enabled": True},
        headers=headers,
    )

    assert response.status_code == 200
    assert response.json()["changes"] == {
        "moss.enabled": {"from": False, "to": True}
    }
    assert store.pending() == {
        "moss.enabled": {"from": False, "to": True}
    }


def test_invalid_draft_route_returns_409_and_pending_empty(
    client, monkeypatch, tmp_path
):
    store, _provider = _make_store(tmp_path)
    _install_store(monkeypatch, store)
    headers = {"X-Test-User": "alice"}

    response = client.post(
        DRAFT_URL,
        json={"changes": {"server.port": 0}},
        headers=headers,
    )

    assert response.status_code == 409
    body = response.json()
    assert body["code"] == "validation_failed"
    assert any(
        error["path"] == "server.port"
        and error["code"] == "out_of_range"
        for error in body["errors"]
    )
    pending = client.get(PENDING_URL, headers=headers).json()
    assert pending["changes"] == []
    assert pending["count"] == 0


def test_discard_route_clears_pending_and_removes_file(
    client, monkeypatch, tmp_path
):
    store, _provider = _make_store(tmp_path)
    _install_store(monkeypatch, store)
    headers = {"X-Test-User": "alice"}

    client.post(
        DRAFT_URL,
        json={"changes": {"moss.enabled": True}},
        headers=headers,
    )
    assert _draft_file(tmp_path).exists()

    response = client.post(DISCARD_URL, json={}, headers=headers)

    assert response.status_code == 200
    assert response.json() == {"ok": True, "count": 0}
    assert client.get(PENDING_URL, headers=headers).json()["changes"] == []
    assert not _draft_file(tmp_path).exists()


def test_pending_route_masks_secret_values(client, monkeypatch, tmp_path):
    store, _provider = _make_store(tmp_path)
    _install_store(monkeypatch, store)
    headers = {"X-Test-User": "alice"}

    response = client.post(
        DRAFT_URL,
        json={"changes": {"loom.token": "super-secret-token"}},
        headers=headers,
    )

    assert response.status_code == 200
    pending = client.get(PENDING_URL, headers=headers)
    assert pending.status_code == 200
    assert pending.json()["changes"] == [
        {
            "path": "loom.token",
            "from": "",
            "to": "***",
            "strategy": "hot",
            "requires_restart": False,
        }
    ]
    assert "super-secret-token" not in pending.text


def test_draft_route_maps_auth_error(client, monkeypatch, tmp_path):
    async def _deny(request: Request, password: str | None = None):
        raise ConfigAuthError(401, "auth_required", "未授权访问，请先登录")

    monkeypatch.setattr(system_config, "require_config_write", _deny)

    response = client.post(
        DRAFT_URL,
        json={"changes": {"moss.enabled": True}},
        headers={"X-Test-User": "alice"},
    )

    assert response.status_code == 401
    assert response.json()["code"] == "auth_required"
