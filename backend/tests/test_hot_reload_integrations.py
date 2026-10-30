# -*- coding: utf-8 -*-
"""N09 配置热重载：QQ 网关 / P2P 管理器原地重启契约。

钉住：
  (a) 新配置非法时先拒绝，运行中的实例不 stop、不被替换；
  (b) enabled false -> true 时旧实例 stop、新实例 start、单例替换；
  (c) enabled true -> false 时只 stop 不 start；
  (d) 旧实例 stop 抛错也清空单例并继续换新；
  (e) P2P 新配置的 devices_path 反映到新管理器；
  (f) 并发两次 restart 由模块级锁串行化（start 不重叠）。

零真实 WS / SQLite / 网络 / 生产配置：配置全用 frozen dataclass 构造，
服务类全部 monkeypatch 成内存假件。本 venv 无 pytest-asyncio，统一
asyncio.run 同步驱动（test_hot_reload_ai_audio 先例）。
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

import services.p2p.manager as manager_module
import services.qq_gateway.service as service_module
from services.p2p.config import P2PConfig
from services.qq_gateway.config import QQGatewayConfig


# ── 配置构造（不读 config.yaml） ──────────────────────────────────────────


def _qq_disabled() -> QQGatewayConfig:
    return QQGatewayConfig.from_dict({"enabled": False, "mcp": {"enabled": False}})


def _qq_enabled() -> QQGatewayConfig:
    return QQGatewayConfig.from_dict(
        {
            "enabled": True,
            "account": {"ws_url": "ws://127.0.0.1:3001", "ws_token": "test-token"},
            "mcp": {"enabled": False},
        }
    )


def _qq_invalid() -> QQGatewayConfig:
    """enabled=true 但 ws_token 为空，validate() 必然报错。"""
    return QQGatewayConfig.from_dict(
        {
            "enabled": True,
            "account": {"ws_url": "ws://127.0.0.1:3001", "ws_token": ""},
            "mcp": {"enabled": False},
        }
    )


def _p2p_config(tmp_path: Any, filename: str, *, enabled: bool = True) -> P2PConfig:
    return P2PConfig.from_dict(
        {
            "enabled": enabled,
            "server_id": "home",
            "room": "home",
            "signal_url": "wss://signal.example.com",
            "signal_secret_env": "P2P_SIGNAL_SECRET",
            "endpoints": {"frp": "https://home.example.com:8768"},
            "devices_path": str(tmp_path / filename),
        }
    )


def _p2p_invalid(tmp_path: Any) -> P2PConfig:
    return P2PConfig.from_dict(
        {
            "enabled": True,
            "server_id": "home",
            "room": "home",
            "signal_url": "",
            "endpoints": {},
            "devices_path": str(tmp_path / "devices.json"),
        }
    )


# ── 假件与隔离 ───────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _isolate_module_state(monkeypatch: pytest.MonkeyPatch) -> None:
    """单例与锁逐用例重置，避免同进程其它测试互相污染。"""
    monkeypatch.setattr(service_module, "_instance", None)
    monkeypatch.setattr(manager_module, "_instance", None)
    monkeypatch.setattr(service_module, "_restart_lock", asyncio.Lock())
    monkeypatch.setattr(manager_module, "_restart_lock", asyncio.Lock())


@pytest.fixture
def fake_gateway(monkeypatch: pytest.MonkeyPatch) -> type:
    class FakeGateway:
        created: list["FakeGateway"] = []

        def __init__(self, config: QQGatewayConfig) -> None:
            self.config = config
            self.starts = 0
            self.stops = 0
            type(self).created.append(self)

        async def start(self) -> None:
            self.starts += 1

        async def stop(self) -> None:
            self.stops += 1

        def health(self) -> dict[str, Any]:
            return {"enabled": self.config.enabled, "started": self.starts > 0}

    monkeypatch.setattr(service_module, "QQGatewayService", FakeGateway)
    return FakeGateway


@pytest.fixture
def fake_manager(monkeypatch: pytest.MonkeyPatch) -> type:
    class FakeManager:
        created: list["FakeManager"] = []

        def __init__(self, config: P2PConfig) -> None:
            self.config = config
            self.starts = 0
            self.stops = 0
            type(self).created.append(self)

        async def start(self) -> None:
            self.starts += 1

        async def stop(self) -> None:
            self.stops += 1

        def status(self) -> dict[str, Any]:
            return {
                "enabled": self.config.enabled,
                "devices_path": self.config.devices_path,
                "started": self.starts > 0,
            }

    monkeypatch.setattr(manager_module, "P2PManager", FakeManager)
    return FakeManager


# ── QQ Gateway ───────────────────────────────────────────────────────────


def test_qq_restart_rejects_invalid_config_without_touching_running_service(
    monkeypatch: pytest.MonkeyPatch, fake_gateway: type
) -> None:
    old = fake_gateway(_qq_disabled())
    monkeypatch.setattr(service_module, "_instance", old)

    result = asyncio.run(service_module.restart_qq_gateway(_qq_invalid()))

    assert result["ok"] is False
    assert result["errors"]
    assert old.stops == 0
    assert service_module._instance is old
    assert fake_gateway.created == [old]


def test_qq_restart_disabled_to_enabled_starts_new_instance(
    monkeypatch: pytest.MonkeyPatch, fake_gateway: type
) -> None:
    old = fake_gateway(_qq_disabled())
    monkeypatch.setattr(service_module, "_instance", old)
    new_config = _qq_enabled()

    result = asyncio.run(service_module.restart_qq_gateway(new_config))

    new = service_module._instance
    assert result["ok"] is True
    assert result["enabled"] is True
    assert result["state"] == {"enabled": True, "started": True}
    assert old.stops == 1
    assert new is not old
    assert new is fake_gateway.created[1]
    assert new.config is new_config
    assert new.starts == 1


def test_qq_restart_without_new_config_uses_loaded_config(
    monkeypatch: pytest.MonkeyPatch, fake_gateway: type
) -> None:
    loaded = _qq_enabled()
    monkeypatch.setattr(
        QQGatewayConfig, "load", classmethod(lambda cls: loaded)
    )

    result = asyncio.run(service_module.restart_qq_gateway())

    assert result["ok"] is True
    assert service_module._instance.config is loaded
    assert service_module._instance.starts == 1


def test_qq_restart_enabled_to_disabled_stops_without_starting(
    monkeypatch: pytest.MonkeyPatch, fake_gateway: type
) -> None:
    old = fake_gateway(_qq_enabled())
    monkeypatch.setattr(service_module, "_instance", old)

    result = asyncio.run(service_module.restart_qq_gateway(_qq_disabled()))

    new = service_module._instance
    assert result["ok"] is True
    assert result["enabled"] is False
    assert old.stops == 1
    assert new is not old
    assert new.starts == 0


def test_qq_restart_swaps_instance_even_when_old_stop_fails(
    monkeypatch: pytest.MonkeyPatch, fake_gateway: type
) -> None:
    class ExplodingGateway(fake_gateway):
        async def stop(self) -> None:
            self.stops += 1
            raise RuntimeError("stop boom")

    old = ExplodingGateway(_qq_disabled())
    monkeypatch.setattr(service_module, "_instance", old)

    result = asyncio.run(service_module.restart_qq_gateway(_qq_enabled()))

    assert result["ok"] is True
    assert old.stops == 1
    assert service_module._instance is not old
    assert service_module._instance.starts == 1


def test_qq_concurrent_restarts_are_serialized(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class ConcurrencyGateway:
        created: list["ConcurrencyGateway"] = []
        events: list[str] = []
        in_flight_starts = 0
        max_in_flight_starts = 0

        def __init__(self, config: QQGatewayConfig) -> None:
            self.config = config
            self.index = len(type(self).created)
            type(self).created.append(self)

        async def start(self) -> None:
            cls = type(self)
            cls.in_flight_starts += 1
            cls.max_in_flight_starts = max(
                cls.max_in_flight_starts, cls.in_flight_starts
            )
            cls.events.append(f"start:{self.index}")
            await asyncio.sleep(0.02)
            cls.in_flight_starts -= 1

        async def stop(self) -> None:
            type(self).events.append(f"stop:{self.index}")
            await asyncio.sleep(0.01)

        def health(self) -> dict[str, Any]:
            return {"enabled": self.config.enabled}

    monkeypatch.setattr(service_module, "QQGatewayService", ConcurrencyGateway)
    monkeypatch.setattr(
        service_module, "_instance", ConcurrencyGateway(_qq_disabled())
    )

    async def scenario() -> list[dict[str, Any]]:
        return await asyncio.gather(
            service_module.restart_qq_gateway(_qq_enabled()),
            service_module.restart_qq_gateway(_qq_enabled()),
        )

    results = asyncio.run(scenario())

    assert all(result["ok"] for result in results)
    assert ConcurrencyGateway.max_in_flight_starts == 1
    assert ConcurrencyGateway.events == ["stop:0", "start:1", "stop:1", "start:2"]


# ── P2P Manager ──────────────────────────────────────────────────────────


def test_p2p_restart_rejects_invalid_config_without_touching_running_manager(
    monkeypatch: pytest.MonkeyPatch, fake_manager: type, tmp_path: Any
) -> None:
    monkeypatch.setenv("P2P_SIGNAL_SECRET", "secret")
    old = fake_manager(_p2p_config(tmp_path, "old-devices.json"))
    monkeypatch.setattr(manager_module, "_instance", old)

    result = asyncio.run(manager_module.restart_p2p_manager(_p2p_invalid(tmp_path)))

    assert result["ok"] is False
    assert result["errors"]
    assert old.stops == 0
    assert manager_module._instance is old
    assert fake_manager.created == [old]


def test_p2p_restart_applies_new_devices_path(
    monkeypatch: pytest.MonkeyPatch, fake_manager: type, tmp_path: Any
) -> None:
    monkeypatch.setenv("P2P_SIGNAL_SECRET", "secret")
    old = fake_manager(_p2p_config(tmp_path, "old-devices.json"))
    monkeypatch.setattr(manager_module, "_instance", old)
    new_config = _p2p_config(tmp_path, "new-devices.json")

    result = asyncio.run(manager_module.restart_p2p_manager(new_config))

    new = manager_module._instance
    assert result["ok"] is True
    assert result["enabled"] is True
    assert result["state"]["devices_path"] == str(tmp_path / "new-devices.json")
    assert old.stops == 1
    assert new is not old
    assert new.config is new_config
    assert new.starts == 1


def test_p2p_restart_without_new_config_uses_loaded_config(
    monkeypatch: pytest.MonkeyPatch, fake_manager: type, tmp_path: Any
) -> None:
    monkeypatch.setenv("P2P_SIGNAL_SECRET", "secret")
    loaded = _p2p_config(tmp_path, "loaded-devices.json")
    monkeypatch.setattr(manager_module, "_load_config", lambda: loaded)

    result = asyncio.run(manager_module.restart_p2p_manager())

    assert result["ok"] is True
    assert manager_module._instance.config is loaded
    assert manager_module._instance.starts == 1


def test_p2p_restart_disabled_to_enabled_starts_manager(
    monkeypatch: pytest.MonkeyPatch, fake_manager: type, tmp_path: Any
) -> None:
    monkeypatch.setenv("P2P_SIGNAL_SECRET", "secret")
    old = fake_manager(_p2p_config(tmp_path, "devices.json", enabled=False))
    monkeypatch.setattr(manager_module, "_instance", old)

    result = asyncio.run(
        manager_module.restart_p2p_manager(_p2p_config(tmp_path, "devices.json"))
    )

    assert result["ok"] is True
    assert result["enabled"] is True
    assert old.stops == 1
    assert manager_module._instance.starts == 1


def test_p2p_concurrent_restarts_are_serialized(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    monkeypatch.setenv("P2P_SIGNAL_SECRET", "secret")

    class ConcurrencyManager:
        created: list["ConcurrencyManager"] = []
        events: list[str] = []
        in_flight_starts = 0
        max_in_flight_starts = 0

        def __init__(self, config: P2PConfig) -> None:
            self.config = config
            self.index = len(type(self).created)
            type(self).created.append(self)

        async def start(self) -> None:
            cls = type(self)
            cls.in_flight_starts += 1
            cls.max_in_flight_starts = max(
                cls.max_in_flight_starts, cls.in_flight_starts
            )
            cls.events.append(f"start:{self.index}")
            await asyncio.sleep(0.02)
            cls.in_flight_starts -= 1

        async def stop(self) -> None:
            type(self).events.append(f"stop:{self.index}")
            await asyncio.sleep(0.01)

        def status(self) -> dict[str, Any]:
            return {"enabled": self.config.enabled}

    monkeypatch.setattr(manager_module, "P2PManager", ConcurrencyManager)
    monkeypatch.setattr(
        manager_module,
        "_instance",
        ConcurrencyManager(_p2p_config(tmp_path, "devices.json", enabled=False)),
    )

    async def scenario() -> list[dict[str, Any]]:
        return await asyncio.gather(
            manager_module.restart_p2p_manager(_p2p_config(tmp_path, "devices.json")),
            manager_module.restart_p2p_manager(_p2p_config(tmp_path, "devices.json")),
        )

    results = asyncio.run(scenario())

    assert all(result["ok"] for result in results)
    assert ConcurrencyManager.max_in_flight_starts == 1
    assert ConcurrencyManager.events == ["stop:0", "start:1", "stop:1", "start:2"]
