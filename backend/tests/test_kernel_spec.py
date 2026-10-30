# -*- coding: utf-8 -*-
"""kernel ServiceSpec 的声明与注册契约（GAP-5/GAP-6）。

spec 只做编排声明：start 委托 ensure（spawn+握手），stop 委托
stop_kernel_process（按 PID/归属证明停止）。本文件不打桩真实内核：
分别替换 kernel_client 的两个入口验证委托关系。
"""
from __future__ import annotations

import asyncio

import pytest

from services import kernel_client as kc
from services.orchestrator import kernel_spec
from services.orchestrator.spec import REGISTRY, ServiceSpec, clear_registry


@pytest.fixture(autouse=True)
def _clean_registry():
    clear_registry()
    yield
    clear_registry()


def _foreign_kernel_spec() -> ServiceSpec:
    async def _action() -> dict:
        return {"foreign": True}

    return ServiceSpec(
        id="kernel",
        requires=(),
        gate=None,
        start=_action,
        stop=_action,
        critical=False,
        restart=False,
    )


def test_build_kernel_spec_declares_critical_restartable_kernel():
    spec = kernel_spec.build_kernel_spec()

    assert spec.id == "kernel"
    assert spec.requires == ()
    assert spec.gate is None
    assert spec.critical is True
    assert spec.restart is True
    assert spec.enable_key is None


def test_build_kernel_spec_is_a_process_singleton():
    assert kernel_spec.build_kernel_spec() is kernel_spec.build_kernel_spec()


def test_register_kernel_spec_is_idempotent():
    first = kernel_spec.register_kernel_spec()
    second = kernel_spec.register_kernel_spec()

    assert first is second
    assert REGISTRY["kernel"] is first
    assert len(REGISTRY) == 1


def test_register_kernel_spec_rejects_conflicting_declaration():
    from services.orchestrator.spec import register

    register(_foreign_kernel_spec())

    with pytest.raises(ValueError, match="conflicting service spec"):
        kernel_spec.register_kernel_spec()
    assert REGISTRY["kernel"].critical is False


def test_start_delegates_to_ensure_async(monkeypatch):
    """编排器只走异步入口：同步 ensure() 会阻塞事件循环（T45）。"""
    calls: list = []

    class _Client:
        base_url = "http://127.0.0.1:55555"
        adopted = False
        _state_dir = None

        async def ensure_async(self) -> None:
            calls.append("ensure_async")

        def ensure(self) -> None:  # pragma: no cover - 命中即失败
            raise AssertionError("编排器不得调用同步 ensure()")

    monkeypatch.setattr(kc, "get_kernel_client", lambda: _Client())
    monkeypatch.setattr(kc, "_read_pidfile", lambda state_dir: {
        "pid": 4321,
        "port": 55555,
    })

    spec = kernel_spec.build_kernel_spec()
    result = asyncio.run(spec.start())

    assert calls == ["ensure_async"]
    assert result == {"pid": 4321, "port": 55555, "adopted": False}


def test_stop_delegates_to_stop_kernel_process(monkeypatch):
    calls: list = []

    def _stop(**kwargs):
        calls.append(kwargs)
        return {"stopped": True, "pid": 4321}

    monkeypatch.setattr(kc, "stop_kernel_process", _stop)

    spec = kernel_spec.build_kernel_spec()
    result = asyncio.run(spec.stop())

    assert calls == [{}]
    assert result == {"stopped": True, "pid": 4321}
