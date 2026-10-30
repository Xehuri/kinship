# -*- coding: utf-8 -*-
"""N08 配置热重载：数据路径消费者 + session/task/script 安全重绑。

全部用例使用 tmp_path + monkeypatch：不依赖真实 config.yaml 业务值、
不触网、不启动内核、不写仓库数据目录。
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any, List, Optional

import pytest
from fastapi import HTTPException

_CST = timezone(timedelta(hours=8))


def _cfg(**values: Any) -> SimpleNamespace:
    return SimpleNamespace(**values)


# ── mobile / ota：每次调用现读配置 ──────────────────────────────


def test_mobile_roots_follow_current_config_and_keep_traversal_guard(
    monkeypatch, tmp_path
):
    import routers.mobile as mobile

    ai_a, ai_b = tmp_path / "ai-a", tmp_path / "ai-b"
    cfg = _cfg(AI_ROOT=str(ai_a), DATA_DIR=str(ai_a / "data"))
    monkeypatch.setattr(mobile, "get_config", lambda: cfg)

    assert mobile._safe_resolve("daily/x.jsonl", "data") == str(
        ai_a / "data" / "daily" / "x.jsonl"
    )
    assert mobile._safe_resolve("data/x.md", "root") == str(ai_a / "data" / "x.md")

    cfg.AI_ROOT = str(ai_b)
    cfg.DATA_DIR = str(ai_b / "data")

    assert mobile._safe_resolve("daily/x.jsonl", "data") == str(
        ai_b / "data" / "daily" / "x.jsonl"
    )
    assert mobile._safe_resolve("data/x.md", "root") == str(ai_b / "data" / "x.md")

    with pytest.raises(HTTPException) as exc:
        mobile._safe_resolve("../escape.txt", "data")
    assert exc.value.status_code == 403


def test_mobile_report_scan_uses_live_ai_root(monkeypatch, tmp_path):
    import routers.mobile as mobile

    def _make_report(ai_root: Path, title: str) -> None:
        day = ai_root / "data" / "daily" / "2026-10-26"
        day.mkdir(parents=True)
        (day / "健康清单-2026-10-26.md").write_text(
            f"---\ndate: 2026-10-26\n---\n# {title}\n", encoding="utf-8"
        )

    ai_a, ai_b = tmp_path / "ai-a", tmp_path / "ai-b"
    _make_report(ai_a, "A 清单")
    _make_report(ai_b, "B 清单")

    cfg = _cfg(AI_ROOT=str(ai_a), DATA_DIR=str(ai_a / "data"))
    monkeypatch.setattr(mobile, "get_config", lambda: cfg)

    first = mobile._scan_report_files()
    assert [row["title"] for row in first] == ["A 清单"]

    cfg.AI_ROOT = str(ai_b)
    cfg.DATA_DIR = str(ai_b / "data")

    second = mobile._scan_report_files()
    assert [row["title"] for row in second] == ["B 清单"]


def test_ota_dir_follows_config_with_env_override(monkeypatch, tmp_path):
    import routers.ota as ota

    dir_a, dir_b, dir_env = tmp_path / "a", tmp_path / "b", tmp_path / "env"
    for path in (dir_a, dir_b, dir_env):
        path.mkdir()

    cfg = _cfg(OTA_APK_DIR=str(dir_a))
    monkeypatch.setattr(ota, "get_config", lambda: cfg)
    monkeypatch.delenv("OTA_FILE_DIR", raising=False)

    assert ota.get_ota_dir() == str(dir_a)

    cfg.OTA_APK_DIR = str(dir_b)
    assert ota.get_ota_dir() == str(dir_b)

    (dir_a / "a.apk").write_bytes(b"a")
    (dir_b / "b.apk").write_bytes(b"b")
    assert ota.get_apk_path() == str(dir_b / "b.apk")

    monkeypatch.setenv("OTA_FILE_DIR", str(dir_env))
    assert ota.get_ota_dir() == str(dir_env)


# ── perception_store：reload_paths 原子换根 + 单次调用单根快照 ──


def test_perception_store_reload_paths_moves_new_writes(monkeypatch, tmp_path):
    import services.perception_store as perception_store

    root_a, root_b = tmp_path / "data-a", tmp_path / "data-b"
    cfg = _cfg(DATA_DIR=str(root_a), STREAM_DIR=str(root_a / "stream"))
    monkeypatch.setattr(perception_store, "get_config", lambda: cfg)

    perception_store.reload_paths()
    start_ms = int(datetime(2026, 10, 26, 12, 0, tzinfo=_CST).timestamp() * 1000)

    rel_a = perception_store.save_audio(
        b"alpha", user_id="u", start_ms=start_ms, ext="wav"
    )
    assert rel_a is not None
    assert rel_a.startswith("daily/2026-10-26/audio/120000-120000_u_")
    assert (root_a / rel_a).read_bytes() == b"alpha"

    assert perception_store.append_perception(
        {"type": "sensor", "t": 1}, date_str="2026-10-26"
    )
    old_jsonl = root_a / "daily" / "2026-10-26" / "perception.jsonl"
    assert old_jsonl.exists()

    cfg.DATA_DIR = str(root_b)
    cfg.STREAM_DIR = str(root_b / "stream")
    perception_store.reload_paths()

    rel_b = perception_store.save_audio(
        b"beta", user_id="u", start_ms=start_ms, ext="flac"
    )
    assert rel_b is not None
    assert rel_b.startswith("daily/2026-10-26/audio/120000-120000_u_")
    assert (root_b / rel_b).read_bytes() == b"beta"

    stream_rel = perception_store.save_audio(
        b"stream", user_id="u", start_ms=start_ms, origin="stream"
    )
    assert stream_rel is not None
    assert stream_rel.startswith("stream/2026-10-26/audio/")
    assert (root_b / stream_rel).read_bytes() == b"stream"

    assert perception_store.append_perception(
        {"type": "sensor", "t": 2}, date_str="2026-10-26"
    )
    assert json.loads(
        (root_b / "daily" / "2026-10-26" / "perception.jsonl").read_text("utf-8")
    )["t"] == 2

    # 旧根文件一字未动
    assert (root_a / rel_a).read_bytes() == b"alpha"
    assert len(old_jsonl.read_text("utf-8").splitlines()) == 1


# ── health_storage：reload_paths + 缓存键含 primary_user ─────────


def test_health_store_cache_key_includes_primary_user(monkeypatch, tmp_path):
    import services.health_storage as health_storage

    root = tmp_path / "data"
    cfg = _cfg(HEALTH_DIR=str(root), DATA_DIR=str(root), HEALTH_PRIMARY_USER="alice")
    monkeypatch.setattr(health_storage, "get_config", lambda: cfg)
    monkeypatch.setattr(health_storage, "_store_cache", {})

    health_storage.reload_paths()
    store_a = health_storage.get_health_store()
    assert store_a.primary_user == "alice"
    assert store_a.data_root == str(root)

    cfg.HEALTH_PRIMARY_USER = "bob"
    health_storage.reload_paths()
    store_b = health_storage.get_health_store()

    assert store_b is not store_a
    assert store_b.primary_user == "bob"
    assert store_b.data_root == str(root)
    assert health_storage.get_health_store() is store_b


# ── stt_session_manager：换文件前保存旧文件 ────────────────────


def test_stt_reload_storage_path_saves_old_and_loads_new(monkeypatch, tmp_path):
    import services.stt_session_manager as ssm

    old_path = tmp_path / "sessions-old.json"
    new_path = tmp_path / "sessions-new.json"
    new_path.write_text(
        json.dumps({"agent_sessions": {"main-task": "sess-b"}}), encoding="utf-8"
    )

    manager = ssm.STTSessionManager(str(old_path))
    manager.set_agent_session("probe", "sess-a")
    assert old_path.exists()

    monkeypatch.setattr(
        ssm, "get_config", lambda: _cfg(SESSIONS_PATH=str(new_path))
    )

    assert manager.reload_storage_path() is True
    assert manager.storage_path == Path(new_path)
    assert manager.get_agent_session("main-task") == "sess-b"
    assert manager.get_agent_session("probe") is None

    old_data = json.loads(old_path.read_text("utf-8"))
    assert old_data["agent_sessions"]["probe"] == "sess-a"

    manager.set_agent_session("probe-2", "sess-c")
    new_data = json.loads(new_path.read_text("utf-8"))
    assert new_data["agent_sessions"]["probe-2"] == "sess-c"
    assert "probe-2" not in json.loads(old_path.read_text("utf-8"))["agent_sessions"]

    # 路径未变：幂等返回 False，不重复清空内存
    assert manager.reload_storage_path() is False

    # 默认构造也现读配置，不复用导入时快照
    fresh = ssm.STTSessionManager()
    assert fresh.storage_path == Path(new_path)


# ── task_scheduler：rebind 保内建、无孤儿 monitor ───────────────


def test_task_scheduler_rebind_transfers_builtins_and_monitor(monkeypatch, tmp_path):
    from services.task_scheduler import TaskScheduler
    from services.task_storage import TaskStorage

    async def scenario() -> bool:
        storage_a = TaskStorage(str(tmp_path / "tasks-a"))
        scheduler = TaskScheduler(task_storage=storage_a)

        async def probe() -> None:
            return None

        scheduler.register_builtin("probe", "daily 03:00", probe)
        await scheduler.start()
        old_monitor = storage_a._repair_monitor_task
        assert old_monitor is not None and not old_monitor.done()

        async def release_fake_execution() -> None:
            await asyncio.sleep(0.02)
            scheduler._executing_tasks.discard("fake-task")

        scheduler._executing_tasks.add("fake-task")
        asyncio.create_task(release_fake_execution())

        storage_b = TaskStorage(str(tmp_path / "tasks-b"))
        result = await scheduler.rebind_storage(new_storage=storage_b)

        assert result["ok"] is True
        assert result["warnings"] == []
        assert result["drained"] is True
        assert scheduler.storage is storage_b
        assert scheduler.is_running() is True
        assert set(storage_b.get_builtin_tasks()) == {"builtin_probe"}
        assert storage_b.get_task("builtin_probe") is not None
        assert set(scheduler._builtin_callbacks) == {"builtin_probe"}

        assert old_monitor.done()
        new_monitor = storage_b._repair_monitor_task
        assert new_monitor is not None and not new_monitor.done()

        await scheduler.stop()
        assert new_monitor.done()
        return True

    assert asyncio.run(scenario()) is True


def test_task_scheduler_rebind_uses_current_tasks_dir(monkeypatch, tmp_path):
    import config.config as config_module
    from services.task_scheduler import TaskScheduler
    from services.task_storage import TaskStorage

    target_dir = tmp_path / "tasks-current"
    monkeypatch.setattr(
        config_module, "get_config", lambda: _cfg(TASKS_DIR=str(target_dir))
    )

    async def scenario() -> bool:
        scheduler = TaskScheduler(task_storage=TaskStorage(str(tmp_path / "old")))

        async def probe() -> None:
            return None

        scheduler.register_builtin("probe", "daily 03:00", probe)
        result = await scheduler.rebind_storage()

        assert result["started"] is False
        assert result["storage_dir"] == str(target_dir)
        assert scheduler.is_running() is False
        assert set(scheduler.storage.get_builtin_tasks()) == {"builtin_probe"}
        return True

    assert asyncio.run(scenario()) is True


def test_task_scheduler_rebind_warns_when_inflight_never_drains(
    monkeypatch, tmp_path
):
    from services.task_scheduler import TaskScheduler
    from services.task_storage import TaskStorage

    async def scenario() -> bool:
        scheduler = TaskScheduler(task_storage=TaskStorage(str(tmp_path / "a")))
        scheduler.REBIND_DRAIN_TIMEOUT_S = 0.01
        scheduler._executing_tasks.add("stuck-task")

        result = await scheduler.rebind_storage(
            new_storage=TaskStorage(str(tmp_path / "b"))
        )

        assert result["ok"] is True
        assert result["drained"] is False
        assert any("in-flight" in warning for warning in result["warnings"])
        scheduler._executing_tasks.clear()
        return True

    assert asyncio.run(scenario()) is True


# ── script_runner：先收旧线程再起新 watcher；超时不重复启动 ────


class _FakeThread:
    def __init__(
        self,
        name: str,
        *,
        release_on_join: bool,
        events: Optional[List[Any]] = None,
    ) -> None:
        self.name = name
        self._alive = True
        self._release_on_join = release_on_join
        self._events = events
        self.joins: List[Optional[float]] = []

    def is_alive(self) -> bool:
        return self._alive

    def join(self, timeout: Optional[float] = None) -> None:
        self.joins.append(timeout)
        if self._events is not None:
            self._events.append(("join", self.name))
        if self._release_on_join:
            self._alive = False


class _FakeRunner:
    def __init__(self, name: str, events: List[Any]) -> None:
        self.name = name
        self.events = events
        self._client = "fake-client"
        self._watcher_thread = _FakeThread(
            f"{name}-watcher", release_on_join=True, events=events
        )
        self._monitor_thread = _FakeThread(
            f"{name}-monitor", release_on_join=True, events=events
        )
        self.started_dir: Optional[str] = None

    async def stop(self) -> None:
        self.events.append(("stop", self.name))

    async def start(self, scripts_dir: Optional[str] = None) -> None:
        self.events.append(("start", self.name))
        self.started_dir = scripts_dir


def test_reload_scripts_dir_joins_old_threads_before_new_start(
    monkeypatch, tmp_path
):
    import services.script_runner as script_runner

    events: List[Any] = []
    old = _FakeRunner("old", events)
    new = _FakeRunner("new", events)
    monkeypatch.setattr(script_runner, "_script_runner_instance", old)
    monkeypatch.setattr(
        script_runner, "_current_scripts_dir", lambda: tmp_path / "scripts-new"
    )
    monkeypatch.setattr(
        script_runner, "init_script_runner", lambda client=None: new
    )

    result = asyncio.run(script_runner.reload_scripts_dir(timeout_s=0.2))

    assert result["ok"] is True
    assert result["warnings"] == []
    assert script_runner.get_script_runner() is new
    assert new.started_dir == str(tmp_path / "scripts-new")
    kinds = [event[0] for event in events]
    assert kinds.index("stop") < kinds.index("join") < kinds.index("start")
    assert all(timeout is not None and timeout <= 0.2 for timeout in old._watcher_thread.joins)


def test_reload_scripts_dir_timeout_does_not_start_duplicate(monkeypatch, tmp_path):
    import services.script_runner as script_runner

    events: List[Any] = []
    old = _FakeRunner("old", events)
    old._watcher_thread = _FakeThread("old-watcher", release_on_join=False)
    old._monitor_thread = _FakeThread("old-monitor", release_on_join=False)
    created: List[Any] = []
    monkeypatch.setattr(script_runner, "_script_runner_instance", old)
    monkeypatch.setattr(
        script_runner, "_current_scripts_dir", lambda: tmp_path / "scripts-new"
    )

    def _factory(client=None):
        created.append(client)
        return _FakeRunner("new", events)

    monkeypatch.setattr(script_runner, "init_script_runner", _factory)

    result = asyncio.run(script_runner.reload_scripts_dir(timeout_s=0.01))

    assert result["ok"] is False
    assert any("超时" in warning for warning in result["warnings"])
    assert created == []
    assert script_runner.get_script_runner() is old
