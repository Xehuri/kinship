# -*- coding: utf-8 -*-
"""dsh 路径推送：载荷构造、成功/失败降级、合并调度与四个生命周期钩子。

全部离线：bridge 传输一律 monkeypatch（``DshClient.push_kinship_paths`` 或
``services.dsh_paths.push_paths``/``schedule_push`` 记录器），不发真实 HTTP。
本 venv 无 pytest-asyncio，async 统一 asyncio.run 驱动（与 test_dsh_health /
test_config_reconciler 同款）。
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any, Callable, Dict, List

import pytest

import main as main_module
import services.dsh_health as dsh_health
import services.dsh_paths as dsh_paths
from config.store import ConfigChange
from services.config_reconciler import apply_ai_surface, apply_data_paths
from services.dsh_client import DshClient

_PAYLOAD_FIELDS = {
    "schema",
    "ai_root",
    "data_dir",
    "plan_root",
    "plan_master",
    "source",
    "generated_at",
}


def _reset_health() -> None:
    dsh_health._STATE.update(
        {"status": "unknown", "version": None, "session_id": None, "checked_at": None}
    )
    dsh_health._last_status = None
    dsh_health._last_log_at = 0.0


@pytest.fixture(autouse=True)
def _clean_state():
    dsh_paths._reset_state()
    _reset_health()
    yield
    dsh_paths._reset_state()
    _reset_health()


def _patch_cfg(
    monkeypatch,
    *,
    ai_root: str = "/srv/kinship/ai",
    data_dir: str = "/srv/kinship/ai/data",
) -> SimpleNamespace:
    """把 dsh_paths 的配置源换成最小桩（只提供本模块读的两个属性）。"""
    stub = SimpleNamespace(AI_ROOT=ai_root, DATA_DIR=data_dir)
    monkeypatch.setattr(dsh_paths, "get_config", lambda: stub)
    return stub


def _recorder(store: List[str]) -> Callable[[str], None]:
    def _record(reason: str) -> None:
        store.append(reason)

    return _record


def _change(*paths: str) -> ConfigChange:
    return ConfigChange(old={}, new={}, changed_paths=tuple(paths))


def _ai_change(old: str | None, new: str | None) -> ConfigChange:
    return ConfigChange(
        old={"ai_backend": old} if old else {},
        new={"ai_backend": new} if new else {},
        changed_paths=("ai_backend",),
    )


# ---------------------------------------------------------------------------
# 载荷构造
# ---------------------------------------------------------------------------


def test_build_paths_payload_uses_config_roots(monkeypatch) -> None:
    _patch_cfg(monkeypatch)

    payload = dsh_paths.build_paths_payload()

    assert set(payload) == _PAYLOAD_FIELDS
    assert payload["schema"] == dsh_paths.PAYLOAD_SCHEMA == 1
    assert payload["ai_root"] == "/srv/kinship/ai"
    assert payload["data_dir"] == "/srv/kinship/ai/data"
    assert payload["plan_root"] == payload["data_dir"]
    assert payload["plan_master"] == "/srv/kinship/ai/data/plan/master.json"
    assert payload["source"] == "kinship-backend"
    assert isinstance(payload["generated_at"], int)
    assert payload["generated_at"] > 0


def test_build_paths_payload_normalizes_relative_and_trailing_slash(monkeypatch) -> None:
    _patch_cfg(monkeypatch, ai_root="/srv/kinship/ai/", data_dir="/srv/kinship/ai/data/")

    payload = dsh_paths.build_paths_payload()

    assert payload["ai_root"] == "/srv/kinship/ai"
    assert payload["plan_root"] == "/srv/kinship/ai/data"
    assert payload["plan_master"] == "/srv/kinship/ai/data/plan/master.json"


# ---------------------------------------------------------------------------
# 推送本体
# ---------------------------------------------------------------------------


def test_push_paths_success_records_last_push(monkeypatch) -> None:
    _patch_cfg(monkeypatch)
    captured: Dict[str, Any] = {}

    async def _fake_push(self, payload):
        captured["payload"] = dict(payload)
        return 200, {"ok": True, "schema": 1, "stored_at": 1794759000123}, {}

    monkeypatch.setattr(DshClient, "push_kinship_paths", _fake_push)

    result = asyncio.run(dsh_paths.push_paths("boot"))

    assert result["ok"] is True
    assert result["status"] == 200
    assert result["reason"] == "boot"
    assert result["error"] is None
    assert isinstance(result["at"], int)
    assert set(captured["payload"]) == _PAYLOAD_FIELDS
    assert captured["payload"]["plan_master"].endswith("/plan/master.json")
    assert dsh_paths.last_push() == result


def test_push_paths_non_200_is_failure(monkeypatch) -> None:
    _patch_cfg(monkeypatch)

    async def _denied(self, payload):
        return 503, {"error": "no plan store"}, {}

    monkeypatch.setattr(DshClient, "push_kinship_paths", _denied)

    result = asyncio.run(dsh_paths.push_paths("data_paths"))

    assert result["ok"] is False
    assert result["status"] == 503
    assert result["reason"] == "data_paths"
    assert "503" in result["error"]
    assert dsh_paths.last_push()["ok"] is False


def test_push_paths_exception_is_swallowed_and_redacted(monkeypatch) -> None:
    _patch_cfg(monkeypatch)

    async def _boom(self, payload):
        raise RuntimeError(
            "connect failed Authorization: Bearer token=secret-abc"
        )

    monkeypatch.setattr(DshClient, "push_kinship_paths", _boom)

    result = asyncio.run(dsh_paths.push_paths("ai_surface"))

    assert result["ok"] is False
    assert result["status"] is None
    assert result["error"]
    assert "secret-abc" not in result["error"]  # 令牌不落日志/不落状态
    assert dsh_paths.last_push()["ok"] is False


# ---------------------------------------------------------------------------
# 调度合并
# ---------------------------------------------------------------------------


def test_schedule_push_coalesces_rapid_calls(monkeypatch) -> None:
    calls: List[str] = []

    async def _recording(reason: str):
        calls.append(reason)
        return {"ok": True}

    monkeypatch.setattr(dsh_paths, "push_paths", _recording)

    async def _scenario():
        dsh_paths.schedule_push("boot")
        dsh_paths.schedule_push("data_paths")  # 在途任务期间的调用被合并
        dsh_paths.schedule_push("health")
        await asyncio.sleep(0.05)

    asyncio.run(_scenario())

    assert calls == ["boot"]


def test_schedule_push_throttles_next_call_after_completion(monkeypatch) -> None:
    calls: List[str] = []

    async def _recording(reason: str):
        calls.append(reason)
        return {"ok": True}

    monkeypatch.setattr(dsh_paths, "push_paths", _recording)

    async def _scenario():
        dsh_paths.schedule_push("boot")
        await asyncio.sleep(0.05)  # 首个任务已完成
        assert dsh_paths._task is not None and dsh_paths._task.done()
        dsh_paths.schedule_push("data_paths")  # 距上次 < 1s，仍被合并
        await asyncio.sleep(0.05)

    asyncio.run(_scenario())

    assert calls == ["boot"]


def test_schedule_push_without_running_loop_is_noop(monkeypatch) -> None:
    calls: List[str] = []

    async def _recording(reason: str):
        calls.append(reason)
        return {"ok": True}

    monkeypatch.setattr(dsh_paths, "push_paths", _recording)

    dsh_paths.schedule_push("boot")  # 同步上下文：无运行中事件循环

    assert calls == []
    assert dsh_paths._task is None


# ---------------------------------------------------------------------------
# 钩子：dsh 健康探针状态跃迁
# ---------------------------------------------------------------------------


def test_health_transition_to_online_schedules_one_push(monkeypatch) -> None:
    calls: List[str] = []
    monkeypatch.setattr(dsh_paths, "schedule_push", _recorder(calls))

    dsh_health._record("offline", None, None, "connect refused")
    assert calls == []

    dsh_health._record("online", "0.2.1", "dsh-sess-1", None)
    assert calls == ["health"]

    dsh_health._record("online", "0.2.1", "dsh-sess-1", None)  # 重复 online 不推
    assert calls == ["health"]


def test_health_first_online_schedules_push(monkeypatch) -> None:
    """首探 unknown -> online 同样是跃迁：bridge 刚起就该拿到路径。"""
    calls: List[str] = []
    monkeypatch.setattr(dsh_paths, "schedule_push", _recorder(calls))

    dsh_health._record("online", None, None, None)

    assert calls == ["health"]


# ---------------------------------------------------------------------------
# 钩子：配置热应用器
# ---------------------------------------------------------------------------


def test_apply_data_paths_schedules_push(monkeypatch) -> None:
    import services.health_storage as health_storage
    import services.perception_store as perception_store

    reloaded: List[str] = []
    monkeypatch.setattr(
        perception_store, "reload_paths", lambda: reloaded.append("perception")
    )
    monkeypatch.setattr(
        health_storage, "reload_paths", lambda: reloaded.append("health")
    )
    pushed: List[str] = []
    monkeypatch.setattr(dsh_paths, "schedule_push", _recorder(pushed))

    asyncio.run(apply_data_paths(_change("data.dir")))

    assert reloaded == ["perception", "health"]
    assert pushed == ["data_paths"]


def test_apply_ai_surface_pushes_only_for_dsh(monkeypatch) -> None:
    import services.config_reconciler as reconciler

    synced: List[str] = []
    pushed: List[str] = []

    async def _fake_sync(backend: str):
        synced.append(backend)
        return {"backend": backend, "loom": None}

    monkeypatch.setattr(reconciler, "sync_ai_surface", _fake_sync)
    monkeypatch.setattr(dsh_paths, "schedule_push", _recorder(pushed))

    asyncio.run(apply_ai_surface(_ai_change("loom", "dsh")))
    assert synced == ["dsh"]
    assert pushed == ["ai_surface"]

    asyncio.run(apply_ai_surface(_ai_change("dsh", "loom")))
    assert synced == ["dsh", "loom"]
    assert pushed == ["ai_surface"]  # 非 dsh 后端不推


# ---------------------------------------------------------------------------
# 钩子：服务面启动
# ---------------------------------------------------------------------------


class _FakeScheduler:
    def __init__(self) -> None:
        self.paused = None

    def set_paused(self, value: bool) -> None:
        self.paused = value

    async def start(self) -> None:
        pass


class _FakeRunner:
    async def start(self) -> None:
        pass


class _FakeRegistry:
    def set_sweep_sink(self, sink) -> None:
        pass

    def start_sweeper(self) -> None:
        pass


class _FakeStore:
    appliers: tuple[str, ...] = ()

    def start_watcher(self, loop) -> None:
        pass


def test_service_plane_boot_schedules_push(monkeypatch) -> None:
    scheduler = _FakeScheduler()
    runner = _FakeRunner()
    registry = _FakeRegistry()
    store = _FakeStore()

    monkeypatch.setattr(main_module, "get_config", lambda: SimpleNamespace())
    monkeypatch.setattr(
        main_module,
        "init_task_executor",
        lambda: SimpleNamespace(execute=lambda *a, **kw: None),
    )
    monkeypatch.setattr(
        main_module,
        "init_task_scheduler",
        lambda execute_callback=None: scheduler,
    )
    monkeypatch.setattr(main_module, "init_script_runner", lambda: runner)
    monkeypatch.setattr(main_module, "get_config_store", lambda: store)
    monkeypatch.setattr(
        main_module, "register_default_appliers", lambda *a, **kw: ["ai"]
    )
    monkeypatch.setattr(main_module, "_register_builtin_tasks", lambda *a, **kw: None)

    import services.audio_ingest_registry as registry_module

    monkeypatch.setattr(
        registry_module, "get_audio_ingest_registry", lambda: registry
    )

    pushed: List[str] = []
    monkeypatch.setattr(dsh_paths, "schedule_push", _recorder(pushed))

    app = SimpleNamespace(state=SimpleNamespace(config_store=store))

    async def _scenario():
        return await main_module._start_service_plane(app, mode="validation")

    report = asyncio.run(_scenario())

    assert report["subsystems"]["config_appliers"] == "ok"
    assert pushed == ["boot"]
