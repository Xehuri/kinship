# -*- coding: utf-8 -*-
"""任务 9 / 任务 36：``GET /api/services`` 与 pause/resume 运维闸门。

覆盖：无服务返回空数组、blocked spec 暴露 state/reason_code、缺 token 401、
响应不含 token/password 字样、detail 中的凭证被脱敏、off 模式顶层字段；
任务 36 新增：pause 停真实子进程并置 blocked/manually_paused、resume 重新
拉起、未知 id 404、off 模式 409、GET 绝不调用 pause/resume。
每个用例前后清空编排器单例与全局注册表，避免跨测试污染。
"""
from __future__ import annotations

import asyncio
import os
import sys
import time
from types import SimpleNamespace
from typing import Any

import pytest

import main as main_module
import routers.services_status as services_status
import services.orchestrator.runtime as runtime_module
from services.orchestrator.runtime import Orchestrator, reset_orchestrator
from services.orchestrator.spec import ServiceSpec, clear_registry, register

API_PATH = "/api/services"

ENTRY_FIELDS = {
    "id",
    "state",
    "reason_code",
    "detail",
    "pid",
    "started_at",
    "retry_count",
    "next_retry_at",
    "requires",
    "critical",
}


@pytest.fixture(autouse=True)
def _fresh_orchestrator(monkeypatch: pytest.MonkeyPatch):
    """每个用例使用独立的编排器单例与空注册表。"""
    monkeypatch.setenv(runtime_module.ORCHESTRATOR_ENV, "on")
    monkeypatch.setattr(main_module, "_register_orchestrator_specs", lambda: None)
    reset_orchestrator()
    clear_registry()
    yield
    reset_orchestrator()
    clear_registry()


async def _must_not_start() -> dict[str, object]:
    raise AssertionError("GET /api/services 不得启动任何服务")


async def _noop_stop() -> dict[str, object]:
    return {"ok": True}


def _register_blocked(
    service_id: str = "blocked-svc",
    requires: tuple[str, ...] = ("missing.key",),
    critical: bool = True,
) -> None:
    register(
        ServiceSpec(
            id=service_id,
            requires=requires,
            gate=None,
            start=_must_not_start,
            stop=_noop_stop,
            critical=critical,
            restart=False,
        )
    )


def _get(client, headers=None):
    return client.get(API_PATH, headers=headers or {})


_LONG_RUN = "import time\nwhile True:\n    time.sleep(0.05)\n"


def _alive(pid: int | None) -> bool:
    if pid is None:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


class _LiveService:
    """用真实短命子进程驱动 pause/resume 的测试 spec。"""

    def __init__(self, service_id: str = "live-svc") -> None:
        self.service_id = service_id
        self.spawns: list[asyncio.subprocess.Process] = []
        self.start_calls = 0
        self.stop_calls = 0

    def spec(self) -> ServiceSpec:
        return ServiceSpec(
            id=self.service_id,
            requires=(),
            gate=None,
            start=self.start,
            stop=self.stop,
            critical=False,
            restart=False,
        )

    async def start(self) -> dict[str, Any]:
        self.start_calls += 1
        proc = await asyncio.create_subprocess_exec(
            sys.executable,
            "-c",
            _LONG_RUN,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        self.spawns.append(proc)
        return {"ok": True, "pid": proc.pid, "process": proc}

    async def stop(self) -> dict[str, Any]:
        self.stop_calls += 1
        proc = self.spawns[-1] if self.spawns else None
        if proc is not None and proc.returncode is None:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
        return {"ok": True}


def _make_live_orchestrator(svc: _LiveService) -> Orchestrator:
    return Orchestrator(
        spec_provider=lambda: (svc.spec(),),
        config_provider=lambda: SimpleNamespace(_data={}),
        spawn_grace_s=0.05,
        poll_interval_s=0.01,
    )


def _find_entry(snapshot: dict[str, Any], service_id: str) -> dict[str, Any]:
    for entry in snapshot.get("services") or ():
        if entry.get("id") == service_id:
            return entry
    raise AssertionError(f"{service_id} missing from snapshot: {snapshot}")


def _wait_state(
    orch: Orchestrator,
    service_id: str,
    states: set[str],
    timeout: float = 3.0,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        entry = _find_entry(orch.snapshot(), service_id)
        if entry["state"] in states:
            return entry
        time.sleep(0.02)
    raise AssertionError(
        f"{service_id} did not reach {states}: {orch.snapshot()}"
    )


def test_no_services_returns_empty_list(client, auth_headers):
    response = _get(client, auth_headers)
    assert response.status_code == 200, response.text

    body = response.json()
    assert body == {"orchestrator": "on", "services": []}
    assert body["services"] == []


def test_blocked_spec_exposes_missing_config(client, auth_headers):
    _register_blocked()

    response = _get(client, auth_headers)
    assert response.status_code == 200, response.text

    body = response.json()
    assert body["orchestrator"] == "on"
    assert len(body["services"]) == 1

    entry = body["services"][0]
    assert set(entry) == ENTRY_FIELDS
    assert entry["id"] == "blocked-svc"
    assert entry["state"] == "blocked"
    assert entry["reason_code"] == "missing_config"
    assert "missing.key" in entry["detail"]
    assert entry["requires"] == ["missing.key"]
    assert entry["critical"] is True
    assert entry["pid"] is None
    assert entry["started_at"] is None
    assert entry["retry_count"] == 0
    assert entry["next_retry_at"] is None


def test_missing_token_is_401(client):
    response = _get(client)
    assert response.status_code == 401, response.text


def test_response_has_no_token_or_password_words(client, auth_headers):
    _register_blocked()

    response = _get(client, auth_headers)
    assert response.status_code == 200, response.text

    text = response.text.lower()
    assert "token" not in text
    assert "password" not in text


def test_detail_credentials_are_redacted(client, auth_headers, monkeypatch):
    class FakeOrchestrator:
        def snapshot(self):
            return {
                "orchestrator": "on",
                "services": [
                    {
                        "id": "svc",
                        "state": "failed",
                        "reason_code": "spawn_failed",
                        "detail": (
                            "start failed: Authorization: Bearer qa-super-secret"
                        ),
                        "pid": None,
                        "started_at": None,
                        "retry_count": 0,
                        "next_retry_at": None,
                        "requires": [],
                        "critical": False,
                        "restart": True,
                        "paused": False,
                        "last_error": "qa-super-secret",
                    }
                ],
            }

    monkeypatch.setattr(
        services_status, "get_orchestrator", lambda: FakeOrchestrator()
    )

    response = _get(client, auth_headers)
    assert response.status_code == 200, response.text

    text = response.text
    assert "qa-super-secret" not in text
    assert "Bearer ***" in response.json()["services"][0]["detail"]


def test_orchestrator_off_returns_empty_services(
    client, auth_headers, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setenv(runtime_module.ORCHESTRATOR_ENV, "off")
    _register_blocked()

    response = _get(client, auth_headers)
    assert response.status_code == 200, response.text

    assert response.json() == {"orchestrator": "off", "services": []}


# ── 任务 36：运维闸门 HTTP 端点 ─────────────────────────────


def test_pause_endpoint_stops_service_and_marks_manually_paused(
    client, auth_headers, monkeypatch: pytest.MonkeyPatch
):
    svc = _LiveService()
    orch = _make_live_orchestrator(svc)
    monkeypatch.setattr(services_status, "get_orchestrator", lambda: orch)
    try:
        client.portal.call(orch.start_all)
        ready = _wait_state(orch, svc.service_id, {"ready"})
        first_pid = ready["pid"]
        assert first_pid is not None and _alive(first_pid)

        response = client.post(
            f"{API_PATH}/{svc.service_id}/pause", headers=auth_headers
        )
        assert response.status_code == 200, response.text

        body = response.json()
        assert set(body) == ENTRY_FIELDS
        assert body["id"] == svc.service_id
        assert body["state"] == "blocked"
        assert body["reason_code"] == "manually_paused"
        assert body["pid"] is None

        snapshot = _get(client, auth_headers).json()
        entry = _find_entry(snapshot, svc.service_id)
        assert entry["state"] == "blocked"
        assert entry["reason_code"] == "manually_paused"
        assert svc.stop_calls == 1
        assert not _alive(first_pid)
    finally:
        client.portal.call(orch.stop_all)


def test_resume_endpoint_restarts_service(
    client, auth_headers, monkeypatch: pytest.MonkeyPatch
):
    svc = _LiveService()
    orch = _make_live_orchestrator(svc)
    monkeypatch.setattr(services_status, "get_orchestrator", lambda: orch)
    try:
        client.portal.call(orch.start_all)
        ready = _wait_state(orch, svc.service_id, {"ready"})
        first_pid = ready["pid"]

        paused = client.post(
            f"{API_PATH}/{svc.service_id}/pause", headers=auth_headers
        )
        assert paused.status_code == 200, paused.text
        assert paused.json()["state"] == "blocked"

        response = client.post(
            f"{API_PATH}/{svc.service_id}/resume", headers=auth_headers
        )
        assert response.status_code == 200, response.text

        body = response.json()
        assert body["id"] == svc.service_id
        assert body["state"] in {"starting", "ready"}
        assert body["reason_code"] == ""

        entry = _wait_state(orch, svc.service_id, {"ready"})
        assert entry["pid"] is not None
        assert entry["pid"] != first_pid
        assert _alive(entry["pid"])
        assert svc.start_calls == 2
    finally:
        client.portal.call(orch.stop_all)


@pytest.mark.parametrize("action", ["pause", "resume"])
def test_unknown_service_returns_404(
    client, auth_headers, monkeypatch: pytest.MonkeyPatch, action: str
):
    orch = Orchestrator(
        spec_provider=lambda: (),
        config_provider=lambda: SimpleNamespace(_data={}),
        spawn_grace_s=0.05,
        poll_interval_s=0.01,
    )
    monkeypatch.setattr(services_status, "get_orchestrator", lambda: orch)

    response = client.post(
        f"{API_PATH}/ghost-svc/{action}", headers=auth_headers
    )
    assert response.status_code == 404, response.text
    assert "ghost-svc" in response.json()["detail"]


@pytest.mark.parametrize("action", ["pause", "resume"])
def test_gate_returns_409_when_orchestrator_off(
    client, auth_headers, monkeypatch: pytest.MonkeyPatch, action: str
):
    monkeypatch.setenv(runtime_module.ORCHESTRATOR_ENV, "off")
    orch = Orchestrator(
        spec_provider=lambda: (),
        config_provider=lambda: SimpleNamespace(_data={}),
        spawn_grace_s=0.05,
        poll_interval_s=0.01,
    )
    assert orch.enabled is False
    monkeypatch.setattr(services_status, "get_orchestrator", lambda: orch)

    response = client.post(
        f"{API_PATH}/kernel/{action}", headers=auth_headers
    )
    assert response.status_code == 409, response.text
    assert runtime_module.ORCHESTRATOR_ENV in response.json()["detail"]


def test_gate_missing_token_is_401(client):
    response = client.post(f"{API_PATH}/kernel/pause")
    assert response.status_code == 401, response.text


def test_get_never_calls_pause_or_resume(
    client, auth_headers, monkeypatch: pytest.MonkeyPatch
):
    class FakeOrchestrator:
        def __init__(self) -> None:
            self.calls: list[tuple[str, str]] = []

        def snapshot(self) -> dict[str, Any]:
            return {
                "orchestrator": "on",
                "services": [
                    {
                        "id": "svc",
                        "state": "ready",
                        "reason_code": "",
                        "detail": "",
                        "pid": 123,
                        "started_at": None,
                        "retry_count": 0,
                        "next_retry_at": None,
                        "requires": [],
                        "critical": False,
                    }
                ],
            }

        async def pause(self, service_id: str) -> dict[str, Any]:
            self.calls.append(("pause", service_id))
            raise AssertionError("GET 不得调用 pause")

        async def resume(self, service_id: str) -> dict[str, Any]:
            self.calls.append(("resume", service_id))
            raise AssertionError("GET 不得调用 resume")

    fake = FakeOrchestrator()
    monkeypatch.setattr(services_status, "get_orchestrator", lambda: fake)

    for _ in range(2):
        response = _get(client, auth_headers)
        assert response.status_code == 200, response.text

    assert fake.calls == []
