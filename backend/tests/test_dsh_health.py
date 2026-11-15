# -*- coding: utf-8 -*-
"""dsh 健康探针与 /health 可见性。

不连真实网络：DshClient 经 monkeypatch 的假客户端替换，/health 只读进程内
缓存。覆盖：探针在线/离线/异常/超时、copy 语义、/health 在 ai_backend=dsh
下的降级规则、loom 通道不受 dsh 状态影响、探针未启动时的 unknown 表达。
"""

import asyncio
import json
import time
import types

import pytest

import main as main_module
import services.dsh_client as dsh_client
import services.dsh_health as dsh_health

_FIELDS = {"status", "version", "session_id", "checked_at", "age_s"}


class _FakeClient:
    """最小 DshClient 桩：health_check 返回给定信封（或抛给定异常）。"""

    def __init__(self, result=None, *, exc=None, delay=0.0):
        self._result = result
        self._exc = exc
        self._delay = delay

    async def health_check(self):
        if self._delay:
            await asyncio.sleep(self._delay)
        if self._exc is not None:
            raise self._exc
        return self._result


def _reset():
    dsh_health._STATE.update(
        {"status": "unknown", "version": None, "session_id": None, "checked_at": None}
    )
    dsh_health._last_status = None
    dsh_health._last_log_at = 0.0


@pytest.fixture(autouse=True)
def _clean_state():
    _reset()
    yield
    _reset()


def _patch_client(monkeypatch, client):
    async def _acquire():
        return client

    monkeypatch.setattr(dsh_client, "acquire_dsh_client", _acquire)


def _patch_cfg(monkeypatch, backend):
    monkeypatch.setattr(
        main_module, "get_config", lambda: types.SimpleNamespace(AI_BACKEND=backend)
    )


def _patch_loom(monkeypatch, status="unknown"):
    state = {
        "status": status,
        "version": None,
        "checked_at": None if status == "unknown" else 1.0,
        "age_s": None if status == "unknown" else 0.1,
    }
    monkeypatch.setattr(main_module.loom_health, "get_loom_health", lambda: state)


# ---------------------------------------------------------------- 探针本体


def test_probe_online_records_version_and_session(monkeypatch):
    _patch_client(
        monkeypatch,
        _FakeClient(
            {"ok": True, "data": {"status": "online", "version": "0.2.1",
                                  "session_id": "dsh-sess-1", "mode": "online"}}
        ),
    )
    state = asyncio.run(dsh_health.probe_once(timeout=1))
    assert set(state) == _FIELDS
    assert state["status"] == "online"
    assert state["version"] == "0.2.1"
    assert state["session_id"] == "dsh-sess-1"
    assert state["checked_at"] is not None
    assert state["age_s"] is not None
    assert json.dumps(state)  # 可 JSON 序列化


def test_probe_offline_records_state(monkeypatch):
    _patch_client(
        monkeypatch,
        _FakeClient({"ok": True, "data": {"status": "offline", "detail": "connect refused"}}),
    )
    state = asyncio.run(dsh_health.probe_once(timeout=1))
    assert state["status"] == "offline"
    assert state["version"] is None
    assert state["session_id"] is None
    assert state["checked_at"] is not None


def test_probe_online_then_offline_clears_version(monkeypatch):
    _patch_client(
        monkeypatch,
        _FakeClient({"ok": True, "data": {"status": "online", "version": "0.2.1",
                                          "session_id": "dsh-sess-1"}}),
    )
    assert asyncio.run(dsh_health.probe_once(timeout=1))["status"] == "online"

    _patch_client(monkeypatch, _FakeClient({"ok": True, "data": {"status": "offline"}}))
    state = asyncio.run(dsh_health.probe_once(timeout=1))
    assert state["status"] == "offline"
    assert state["version"] is None
    assert state["session_id"] is None


def test_probe_exception_is_fail_open_and_serializable(monkeypatch):
    _patch_client(monkeypatch, _FakeClient(exc=RuntimeError("boom token=secret-abc")))
    state = asyncio.run(dsh_health.probe_once(timeout=1))
    assert state["status"] == "offline"
    assert state["checked_at"] is not None
    assert json.dumps(state)  # 异常路径也不产生不可序列化字段
    assert _FIELDS == set(state)


def test_probe_timeout_is_bounded(monkeypatch):
    _patch_client(monkeypatch, _FakeClient({"ok": True, "data": {"status": "online"}}, delay=5.0))
    started = time.monotonic()
    state = asyncio.run(dsh_health.probe_once(timeout=0.05))
    elapsed = time.monotonic() - started
    assert state["status"] == "offline"
    assert elapsed < 1.0


def test_get_dsh_health_returns_copy():
    state = dsh_health.get_dsh_health()
    assert set(state) == _FIELDS
    assert state["status"] == "unknown"
    assert state["checked_at"] is None
    assert state["age_s"] is None
    state["status"] = "tampered"
    state["session_id"] = "tampered"
    fresh = dsh_health.get_dsh_health()
    assert fresh["status"] == "unknown"
    assert fresh["session_id"] is None


def test_probe_start_stop_lifecycle(monkeypatch):
    _patch_client(
        monkeypatch,
        _FakeClient({"ok": True, "data": {"status": "online", "version": "1.2.3",
                                          "session_id": "dsh-sess-1"}}),
    )

    async def _scenario():
        task = dsh_health.start_dsh_health_probe()
        assert dsh_health.start_dsh_health_probe() is task  # 幂等
        await asyncio.sleep(0.05)
        assert dsh_health.get_dsh_health()["status"] == "online"
        await dsh_health.stop_dsh_health_probe()
        assert task.done()
        assert dsh_health._task is None

    asyncio.run(_scenario())


def test_stop_without_start_is_noop():
    async def _scenario():
        await dsh_health.stop_dsh_health_probe()
        await dsh_health.stop_dsh_health_probe()

    asyncio.run(_scenario())


# ---------------------------------------------------------------- /health


def test_health_endpoint_degraded_when_dsh_offline(monkeypatch):
    _patch_cfg(monkeypatch, "dsh")
    _patch_loom(monkeypatch, "unknown")
    _patch_client(monkeypatch, _FakeClient({"ok": True, "data": {"status": "offline"}}))
    asyncio.run(dsh_health.probe_once(timeout=1))

    payload = asyncio.run(main_module.health_check())
    assert payload["ai_backend"] == "dsh"
    assert payload["status"] == "degraded"
    assert payload["dsh"]["status"] == "offline"
    assert payload["dsh"]["checked_at"] is not None
    assert set(payload["dsh"]) == _FIELDS


def test_health_endpoint_healthy_when_dsh_online(monkeypatch):
    _patch_cfg(monkeypatch, "dsh")
    _patch_loom(monkeypatch, "unknown")
    _patch_client(
        monkeypatch,
        _FakeClient({"ok": True, "data": {"status": "online", "version": "0.2.1",
                                          "session_id": "dsh-sess-1"}}),
    )
    asyncio.run(dsh_health.probe_once(timeout=1))

    payload = asyncio.run(main_module.health_check())
    assert payload["status"] == "healthy"
    assert payload["dsh"]["status"] == "online"
    assert payload["dsh"]["version"] == "0.2.1"
    assert payload["dsh"]["session_id"] == "dsh-sess-1"
    assert payload["dsh"]["age_s"] is not None
    assert payload["loom"]["status"] == "unknown"
    assert set(payload) == {"status", "service", "ai_backend", "loom", "dsh", "config"}


def test_health_endpoint_loom_backend_ignores_dsh_offline(monkeypatch):
    _patch_cfg(monkeypatch, "loom")
    _patch_loom(monkeypatch, "online")
    _patch_client(monkeypatch, _FakeClient({"ok": True, "data": {"status": "offline"}}))
    asyncio.run(dsh_health.probe_once(timeout=1))

    payload = asyncio.run(main_module.health_check())
    assert payload["ai_backend"] == "loom"
    assert payload["status"] == "healthy"  # dsh 离线不影响 loom 通道判定
    assert payload["dsh"]["status"] == "offline"  # 但可见性照常暴露


def test_health_endpoint_loom_offline_still_degrades(monkeypatch):
    """原有 loom 降级规则不被 dsh 接线改坏。"""
    _patch_cfg(monkeypatch, "loom")
    _patch_loom(monkeypatch, "offline")
    payload = asyncio.run(main_module.health_check())
    assert payload["status"] == "degraded"
    assert payload["dsh"]["status"] == "unknown"


def test_health_endpoint_dsh_unknown_before_probe(monkeypatch):
    """探针未启动（ai_backend != dsh）时 dsh 键仍存在，状态诚实为 unknown。"""
    _patch_cfg(monkeypatch, "opencode")
    _patch_loom(monkeypatch, "unknown")
    payload = asyncio.run(main_module.health_check())
    assert payload["status"] in {"healthy", "degraded"}
    assert payload["status"] == "healthy"
    assert "dsh" in payload
    assert payload["dsh"]["status"] == "unknown"
    assert payload["dsh"]["checked_at"] is None
    assert payload["dsh"]["age_s"] is None
    assert set(payload["dsh"]) == _FIELDS
    assert json.dumps(payload)


def test_health_endpoint_dsh_unknown_is_not_degraded(monkeypatch):
    """首探窗口内 unknown 不算 degraded（与 loom 同口径）。"""
    _patch_cfg(monkeypatch, "dsh")
    _patch_loom(monkeypatch, "unknown")
    payload = asyncio.run(main_module.health_check())
    assert payload["status"] == "healthy"
    assert payload["dsh"]["status"] == "unknown"
