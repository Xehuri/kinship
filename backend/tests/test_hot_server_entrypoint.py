# -*- coding: utf-8 -*-
"""HotServer 进程入口回归：启动后必须等待 serve 退出，不能启动即返回。"""
import asyncio

import core.hot_server as hot_server
from core import runtime_registry


def test_runtime_registry_is_process_wide():
    sentinel = object()
    runtime_registry.set_hot_server(sentinel)
    try:
        assert runtime_registry.get_hot_server() is sentinel
    finally:
        runtime_registry.set_hot_server(None)


def test_hot_server_module_shares_runtime_registry():
    assert hot_server.get_hot_server is runtime_registry.get_hot_server


def test_run_hot_server_waits_until_stopped(monkeypatch):
    events: list[str] = []

    class _FakeServer:
        async def start(self) -> None:
            events.append("start")

        async def wait_stopped(self) -> None:
            events.append("wait_stopped")

        def stop(self) -> None:
            events.append("stop")

    monkeypatch.setattr(hot_server, "HotServer", _FakeServer)
    asyncio.run(hot_server.run_hot_server())
    assert events == ["start", "wait_stopped", "stop"]
