# -*- coding: utf-8 -*-
"""apply_strategy 分派：respawn / reconnect 真正执行，deployment 只登记重启。"""
from __future__ import annotations

import asyncio
from typing import Any

from config.providers import ProviderInfo
from config.store import ConfigChange, ConfigStore
from services.config_reconciler import register_default_appliers


class _MemoryProvider:
    kind = "memory"

    def load(self) -> dict[str, Any]:
        return {}

    def save(
        self, document: dict[str, Any], *, expected_revision: str | None = None
    ) -> str:
        return "mem-1"

    def revision(self) -> str:
        return "mem-1"

    def describe(self) -> ProviderInfo:
        return ProviderInfo(
            kind="memory",
            location="memory://apply-strategy",
            writable=True,
            detail="test",
        )


def _change(*paths: str) -> ConfigChange:
    return ConfigChange(old={}, new={}, changed_paths=tuple(paths))


def _store() -> ConfigStore:
    store = ConfigStore(_MemoryProvider())
    register_default_appliers(store)
    return store


def test_kernel_device_respawn_resets_and_ensures(monkeypatch) -> None:
    import services.kernel_client as kernel_client

    calls: list[str] = []

    class _FakeClient:
        base_url = "http://127.0.0.1:1"
        adopted = False

        def ensure(self) -> None:
            calls.append("ensure")

    fake_client = _FakeClient()
    monkeypatch.setattr(
        kernel_client,
        "stop_kernel_process",
        lambda **kwargs: calls.append("stop")
        or {"stopped": False, "reason": "no-pidfile"},
    )
    monkeypatch.setattr(
        kernel_client, "reset_kernel_client", lambda: calls.append("reset")
    )
    monkeypatch.setattr(
        kernel_client, "get_kernel_client", lambda *a, **kw: fake_client
    )

    report = asyncio.run(_store().apply(_change("kernel.device")))

    assert calls == ["stop", "reset", "ensure"]
    assert "respawn:kernel" in report.applied
    assert report.failed == {}


def test_qq_gateway_reconnect_calls_client_restart(monkeypatch) -> None:
    import services.p2p.manager as p2p_manager
    import services.qq_gateway.service as qq_service

    calls: list[str] = []

    async def _restart_qq(*args: Any, **kwargs: Any) -> dict[str, Any]:
        calls.append("qq")
        return {"ok": True}

    async def _restart_p2p(*args: Any, **kwargs: Any) -> dict[str, Any]:
        calls.append("p2p")
        return {"ok": True}

    monkeypatch.setattr(qq_service, "restart_qq_gateway", _restart_qq)
    monkeypatch.setattr(p2p_manager, "restart_p2p_manager", _restart_p2p)

    report = asyncio.run(_store().apply(_change("qq_gateway.base_url")))

    assert calls == ["qq"]
    assert "reconnect:qq_gateway" in report.applied
    assert report.failed == {}


def test_deployment_has_no_side_effect_and_requires_restart(monkeypatch) -> None:
    import core.hot_server as hot_server
    import services.kernel_client as kernel_client
    import services.loom_client as loom_client
    import services.opencode_client as opencode_client

    calls: list[str] = []

    class _FakeServer:
        async def rebind_from_config(self) -> dict[str, Any]:
            calls.append("rebind")
            return {"ok": True}

    monkeypatch.setattr(hot_server, "get_hot_server", lambda: _FakeServer())
    monkeypatch.setattr(
        opencode_client,
        "reload_static_config",
        lambda: calls.append("opencode_reload"),
    )
    monkeypatch.setattr(
        loom_client, "reload_static_config", lambda: calls.append("loom_reload")
    )
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

    store = ConfigStore(_MemoryProvider())
    register_default_appliers(store, cors_refresh=lambda: calls.append("cors"))
    report = asyncio.run(store.apply(_change("opencode.enabled")))

    assert calls == []
    assert report.failed == {}
    assert len(report.deferred_restart) == 1
    entry = report.deferred_restart[0]
    assert entry["path"] == "opencode.enabled"
    assert entry["strategy"] == "deployment"
    assert entry["requires_restart"] is True
    assert entry["reason"]
    assert "respawn:kernel" not in report.applied


def test_respawn_failure_is_isolated_from_reconnect_success(monkeypatch) -> None:
    import services.kernel_client as kernel_client
    import services.qq_gateway.service as qq_service

    calls: list[str] = []

    def _boom(**kwargs: Any) -> dict[str, Any]:
        raise RuntimeError("kernel boom")

    async def _restart_qq(*args: Any, **kwargs: Any) -> dict[str, Any]:
        calls.append("qq")
        return {"ok": True}

    monkeypatch.setattr(kernel_client, "stop_kernel_process", _boom)
    monkeypatch.setattr(qq_service, "restart_qq_gateway", _restart_qq)

    report = asyncio.run(
        _store().apply(_change("kernel.device", "qq_gateway.base_url"))
    )

    assert calls == ["qq"]
    assert "reconnect:qq_gateway" in report.applied
    assert "respawn:kernel" in report.failed
    assert "kernel boom" in report.failed["respawn:kernel"]
