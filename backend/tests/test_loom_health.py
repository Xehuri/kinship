import asyncio
import types

import pytest

import services.loom_client as loom_client
import services.loom_health as loom_health
import main as main_module


class _FakeClient:
    def __init__(self, result):
        self._result = result

    async def health_check(self):
        return self._result


def _reset():
    loom_health._STATE.update({"status": "unknown", "version": None, "checked_at": None})
    loom_health._last_status = None
    loom_health._last_log_at = 0.0


def test_probe_online_records_version(monkeypatch):
    _reset()

    async def _acquire():
        return _FakeClient({"ok": True, "data": {"status": "online", "version": "d399298"}})

    monkeypatch.setattr(loom_client, "acquire_loom_client", _acquire)
    state = asyncio.run(loom_health.probe_once(timeout=1))
    assert state["status"] == "online"
    assert state["version"] == "d399298"
    assert state["checked_at"] is not None


def test_probe_offline_records_detail(monkeypatch):
    _reset()

    async def _acquire():
        return _FakeClient({"ok": True, "data": {"status": "offline", "detail": "401"}})

    monkeypatch.setattr(loom_client, "acquire_loom_client", _acquire)
    state = asyncio.run(loom_health.probe_once(timeout=1))
    assert state["status"] == "offline"
    assert state["version"] is None


def test_probe_exception_is_fail_open(monkeypatch):
    _reset()

    async def _acquire():
        raise RuntimeError("boom")

    monkeypatch.setattr(loom_client, "acquire_loom_client", _acquire)
    state = asyncio.run(loom_health.probe_once(timeout=1))
    assert state["status"] == "offline"


def test_get_loom_health_returns_copy():
    _reset()
    state = loom_health.get_loom_health()
    state["status"] = "tampered"
    assert loom_health.get_loom_health()["status"] == "unknown"


def _patch_health(monkeypatch, backend: str, loom_state: dict):
    monkeypatch.setattr(main_module, "get_config", lambda: types.SimpleNamespace(AI_BACKEND=backend))
    monkeypatch.setattr(loom_health, "get_loom_health", lambda: loom_state)


def test_health_endpoint_online(monkeypatch):
    _patch_health(
        monkeypatch,
        "loom",
        {"status": "online", "version": "d399298", "checked_at": 1.0, "age_s": 0.1},
    )
    payload = asyncio.run(main_module.health_check())
    assert payload["status"] == "healthy"
    assert payload["ai_backend"] == "loom"
    assert payload["loom"]["version"] == "d399298"


def test_health_endpoint_degraded_when_loom_offline(monkeypatch):
    _patch_health(
        monkeypatch,
        "loom",
        {"status": "offline", "version": None, "checked_at": 1.0, "age_s": 0.1},
    )
    payload = asyncio.run(main_module.health_check())
    assert payload["status"] == "degraded"


def test_health_endpoint_unknown_is_healthy(monkeypatch):
    _patch_health(
        monkeypatch,
        "loom",
        {"status": "unknown", "version": None, "checked_at": None, "age_s": None},
    )
    payload = asyncio.run(main_module.health_check())
    assert payload["status"] == "healthy"
