# -*- coding: utf-8 -*-
"""Single startup path (task 17): the service plane always starts.

The bootstrap/normal split is gone. ``BootstrapRuntime`` is created inactive and
only reaches ``committed`` through ``mark_started()`` after ``lifespan`` starts
the plane. An unfinished onboarding is expressed by blocked orchestrator
services, not by skipping the plane.
"""
from __future__ import annotations

import asyncio

import pytest

import auth
import main as main_module
import services.orchestrator.kernel_spec as kernel_spec_module
import services.orchestrator.loom_spec as loom_spec_module
import services.orchestrator.moss_spec as moss_spec_module
from services.bootstrap_runtime import (
    STATE_COMMITTED,
    STATE_DEFERRED,
    BootstrapRuntime,
)
from services.orchestrator.runtime import (
    ORCHESTRATOR_ENV,
    get_orchestrator,
    reset_orchestrator,
)
from services.orchestrator.spec import (
    ServiceSpec,
    clear_registry,
    register,
)


async def _blocked_start() -> dict:
    raise AssertionError("blocked service must never start")


async def _noop_stop() -> dict:
    return {"stopped": False}


def _fake_spec(service_id: str, requires: tuple[str, ...]) -> ServiceSpec:
    return ServiceSpec(
        id=service_id,
        requires=requires,
        gate=None,
        start=_blocked_start,
        stop=_noop_stop,
        critical=service_id == "kernel",
        restart=False,
    )


@pytest.fixture
def unfinished_onboarding(monkeypatch):
    monkeypatch.setenv("AXEUH_ONBOARDING_BOOTSTRAP", "1")


@pytest.fixture
def orchestrator_on(monkeypatch):
    monkeypatch.setenv(ORCHESTRATOR_ENV, "on")
    reset_orchestrator()
    clear_registry()
    yield
    reset_orchestrator()
    clear_registry()


@pytest.fixture
def fake_business_specs(monkeypatch):
    def register_fakes() -> None:
        register(_fake_spec("kernel", ("qa.missing.kernel",)))
        register(_fake_spec("moss_watcher", ("qa.missing.moss",)))
        register(_fake_spec("loom", ("qa.missing.loom",)))

    monkeypatch.setattr(main_module, "_register_orchestrator_specs", register_fakes)


def test_inactive_runtime_commits_only_through_mark_started():
    async def scenario():
        stopped: list[str] = []

        async def stop() -> None:
            stopped.append("stop")

        runtime = BootstrapRuntime(active=False, stop=stop)
        assert runtime.active is False
        assert runtime.state == STATE_DEFERRED
        assert runtime.committed is False

        runtime.mark_started()

        assert runtime.state == STATE_COMMITTED
        assert runtime.committed is True
        assert runtime.active is False

        await runtime.deactivate()
        assert stopped == ["stop"]

    asyncio.run(scenario())


def test_inactive_runtime_activate_does_not_start_the_plane():
    async def scenario():
        calls: list[str] = []

        async def start():
            calls.append("start")

        runtime = BootstrapRuntime(active=False, start=start)
        report = await runtime.activate("onboarding_finish")

        assert calls == []
        assert report["activated"] is False
        assert report["reason"] == "already_active"
        assert report["gate_open"] is True
        assert runtime.active is False

    asyncio.run(scenario())


def test_lifespan_starts_plane_with_unfinished_onboarding(
    unfinished_onboarding, client, auth_headers, monkeypatch
):
    monkeypatch.setattr(auth, "is_setup_required", lambda: True)

    runtime = main_module.app.state.bootstrap_runtime
    assert runtime.active is False
    assert runtime.committed is True
    assert main_module.app.state.service_plane_started is True

    assert client.get("/health").status_code == 200

    status = client.get("/api/system/onboarding/status")
    assert status.status_code == 200
    assert status.json()["bootstrap"] is True

    blocked = client.get("/api/services", headers=auth_headers)
    assert blocked.status_code == 503
    assert blocked.json()["code"] == "onboarding_required"


def test_empty_config_reports_blocked_business_services(
    orchestrator_on, fake_business_specs, client, auth_headers, monkeypatch
):
    monkeypatch.setattr(auth, "is_setup_required", lambda: True)

    assert client.get("/health").status_code == 200
    assert client.get("/api/system/onboarding/status").status_code == 200

    main_module.app.state.onboarding_state_completed = True
    response = client.get("/api/services", headers=auth_headers)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["orchestrator"] == "on"

    entries = {entry["id"]: entry for entry in body["services"]}
    assert list(entries) == ["kernel", "moss_watcher", "loom"]
    for entry in entries.values():
        assert entry["state"] == "blocked"
        assert entry["reason_code"] == "missing_config"
        assert entry["pid"] is None

    registry = get_orchestrator().snapshot()["services"]
    assert {entry["id"]: entry["state"] for entry in registry} == {
        "kernel": "blocked",
        "moss_watcher": "blocked",
        "loom": "blocked",
    }


def test_register_orchestrator_specs_uses_kernel_moss_loom_order(monkeypatch):
    calls: list[str] = []
    monkeypatch.setattr(
        kernel_spec_module,
        "register_kernel_spec",
        lambda: calls.append("kernel"),
    )
    monkeypatch.setattr(
        moss_spec_module,
        "register_moss_spec",
        lambda: calls.append("moss"),
    )
    monkeypatch.setattr(
        loom_spec_module,
        "register_loom_spec",
        lambda: calls.append("loom"),
    )

    main_module._register_orchestrator_specs()

    assert calls == ["kernel", "moss", "loom"]
