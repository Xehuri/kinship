# -*- coding: utf-8 -*-
"""
安全整改 阶段 3b 回归测试：
覆盖任务调度/SSE/网关/音频/auth 的正确性与并发修复（BE-COR-M1/M4/M5/M6/M7/M9/M10/M11/M12/M13、BE-SEC-M2/M3）。

注意：conftest.py 在导入期把 auth.get_auth_config/save_auth_config 替换为内存 mock，
因此涉及真实文件落盘的用例自行提供文件版 get/save 覆盖，并在测试结束后由 monkeypatch 还原。
"""
import hashlib
import json
import os
import tempfile
import threading

import pytest

import auth


# ============================================================
# BE-COR-M1：熔断器按 task_id 维度隔离
# ============================================================

class TestCircuitBreakerPerTask:
    def _make_task(self, task_id: str):
        from services.task_models import Task
        return Task(
            task_id=task_id,
            user_id="u",
            task_name=task_id,
            prompt="p",
            schedule_type="scheduled",
            schedule_config={},
        )

    @pytest.mark.asyncio
    async def test_failing_task_does_not_block_other_task(self, monkeypatch):
        from services.task_executor import TaskExecutor, CircuitBreakerOpen

        executor = TaskExecutor()
        # 屏蔽重试等待
        monkeypatch.setattr(executor, "_calculate_retry_delay", lambda attempt: 0)

        async def fake_execute_once(task):
            # A 永远失败，B 永远成功
            return task.task_id != "A"

        monkeypatch.setattr(executor, "_execute_once", fake_execute_once)

        task_a = self._make_task("A")
        task_b = self._make_task("B")

        # A 反复失败，直到自身熔断
        for _ in range(5):
            try:
                await executor.execute(task_a)
            except CircuitBreakerOpen:
                break

        assert executor._is_circuit_open("A") is True
        # B 不受 A 的熔断影响
        assert await executor.execute(task_b) is True
        assert executor._is_circuit_open("B") is False

        # 再次执行 A 应直接抛熔断异常，而非把 B 一起拉下水
        with pytest.raises(CircuitBreakerOpen):
            await executor.execute(task_a)

        # get_status 聚合视图仍兼容旧字段
        status = executor.get_status()["circuit_breaker"]
        assert status["open"] is True
        assert "A" in status["open_tasks"]


# ============================================================
# BE-COR-M4 / M5：SSE 单上游扇出 + finally 不再 yield
# ============================================================

class TestEventHub:
    @pytest.mark.asyncio
    async def test_single_upstream_for_multiple_subscribers(self, monkeypatch):
        import asyncio
        from routers.events import EventHub

        hub = EventHub("http://upstream", heartbeat_interval=100, initial_backoff=0.01)
        calls = 0
        started = asyncio.Event()
        release = asyncio.Event()

        async def fake_stream():
            nonlocal calls
            calls += 1
            started.set()
            await release.wait()

        monkeypatch.setattr(hub, "_stream_upstream", fake_stream)

        q1 = await hub.subscribe()
        q2 = await hub.subscribe()
        # 等待唯一上游启动
        await asyncio.wait_for(started.wait(), timeout=2)

        assert calls == 1

        # 广播对两个订阅者都可见
        hub._broadcast("data: X\n\n")
        assert await asyncio.wait_for(q1.get(), 1) == "data: X\n\n"
        assert await asyncio.wait_for(q2.get(), 1) == "data: X\n\n"

        release.set()
        await hub.unsubscribe(q1)
        await hub.unsubscribe(q2)

    @pytest.mark.asyncio
    async def test_heartbeat_emitted(self, monkeypatch):
        from routers.events import EventHub
        import asyncio

        hub = EventHub("http://upstream", heartbeat_interval=0.05, initial_backoff=0.01)

        async def fake_stream():
            await asyncio.sleep(10)

        monkeypatch.setattr(hub, "_stream_upstream", fake_stream)

        q = await hub.subscribe()
        msg = await asyncio.wait_for(q.get(), timeout=2)
        assert msg == ": heartbeat\n\n"
        await hub.unsubscribe(q)

    @pytest.mark.asyncio
    async def test_upstream_reconnects_with_backoff(self, monkeypatch):
        from routers.events import EventHub
        import asyncio

        hub = EventHub(
            "http://upstream",
            heartbeat_interval=100,
            initial_backoff=0.01,
            max_backoff=0.02,
        )
        calls = 0

        async def fake_stream():
            nonlocal calls
            calls += 1
            raise RuntimeError("boom")

        monkeypatch.setattr(hub, "_stream_upstream", fake_stream)

        q = await hub.subscribe()
        for _ in range(100):
            if calls >= 2:
                break
            await asyncio.sleep(0.02)
        assert calls >= 2
        await hub.unsubscribe(q)

    @pytest.mark.asyncio
    async def test_client_disconnect_finally_logs_only(self, monkeypatch):
        """断开时 finally 只清理、不 yield，且退订生效（无 GeneratorExit 告警路径）。"""
        from routers.events import EventHub
        import asyncio

        hub = EventHub("http://upstream", heartbeat_interval=100)

        async def fake_stream():
            await asyncio.sleep(10)

        monkeypatch.setattr(hub, "_stream_upstream", fake_stream)

        q = await hub.subscribe()
        gen = hub.stream_for(q)
        first = await gen.__anext__()
        assert "proxy.connected" in first

        # 客户端断开：关闭生成器后不应再产出任何内容
        await gen.aclose()
        assert hub.has_subscribers is False


# ============================================================
# BE-COR-M6 / M13：TaskStorage 备份与落盘
# ============================================================

class TestTaskStoragePersistence:
    def _make_storage(self, tmp_path):
        from services.task_storage import TaskStorage
        return TaskStorage(data_dir=str(tmp_path))

    def test_partial_yaml_not_renamed_on_first_failure(self, tmp_path):
        storage = self._make_storage(tmp_path)
        bad = storage.tasks_file
        bad.write_text("tasks: [\n  - task_id: x\n", encoding="utf-8")

        # 第一次解析失败：不备份
        assert storage._load_file(bad) is None
        assert not bad.with_suffix(".bak").exists()

        # 第二次连续失败：备份为 .bak
        assert storage._load_file(bad) is None
        assert bad.with_suffix(".bak").exists()

    def test_create_task_persisted_immediately(self, tmp_path):
        import yaml
        storage = self._make_storage(tmp_path)
        task = storage.create_task(
            user_id="u",
            task_name="立即落盘",
            prompt="p",
            schedule_type="scheduled",
            schedule_config={"hour": 1, "minute": 0},
        )
        # 函数返回后立刻读磁盘，应已包含该任务
        data = yaml.safe_load(storage.tasks_file.read_text(encoding="utf-8"))
        ids = [t["task_id"] for t in data.get("tasks", [])]
        assert task.task_id in ids

    def test_update_task_persisted_immediately(self, tmp_path):
        import yaml
        storage = self._make_storage(tmp_path)
        task = storage.create_task(
            user_id="u",
            task_name="原名",
            prompt="p",
            schedule_type="scheduled",
            schedule_config={"hour": 1, "minute": 0},
        )
        storage.update_task(task.task_id, task_name="新名")

        data = yaml.safe_load(storage.tasks_file.read_text(encoding="utf-8"))
        found = next(t for t in data.get("tasks", []) if t["task_id"] == task.task_id)
        assert found["task_name"] == "新名"


# ============================================================
# BE-COR-M7：调度器 pending 集合防重复入队
# ============================================================

class TestSchedulerPending:
    @pytest.mark.asyncio
    async def test_pending_does_not_grow_unbounded(self):
        import asyncio
        from types import SimpleNamespace
        from services.task_scheduler import TaskScheduler
        from services.task_models import Task

        task = Task(
            task_id="t1",
            user_id="u",
            task_name="n",
            prompt="p",
            schedule_type="scheduled",
            schedule_config={},
        )
        task.next_run = 1.0  # 已到期（1970 年的时间戳，非 0 以免被 falsy 判断跳过）

        class FakeStorage:
            def get_enabled_tasks(self):
                return [task]

            def update_task(self, *a, **k):
                return task

            def record_execution(self, **k):
                return SimpleNamespace(status="", completed_at=None, error_message=None)

            def update_execution(self, *a, **k):
                return True

        release = asyncio.Event()

        async def cb(_task):
            await release.wait()

        sched = TaskScheduler(task_storage=FakeStorage(), execute_callback=cb)
        # 信号量置 0：任务入队后全部阻塞，pending 保持
        sched._semaphore = asyncio.Semaphore(0)

        await sched._check_tasks()
        await sched._check_tasks()

        assert len(sched._pending_tasks) == 1
        assert sched.get_status()["pending_tasks"] == 1

        # 放行并清理，避免挂起的任务泄漏到其它用例
        release.set()
        sched._semaphore.release()
        for _ in range(10):
            await asyncio.sleep(0)
        assert len(sched._pending_tasks) == 0


# ============================================================
# BE-COR-M9 / M10：脚本退出与热加载
# ============================================================

class TestScriptRunnerLifecycle:
    def test_exit_zero_not_restarted(self, monkeypatch):
        from services.script_runner import ScriptRunner

        runner = ScriptRunner(client=None)
        monkeypatch.setattr(runner, "_audit_log", lambda *a, **k: None)
        restarts = []
        monkeypatch.setattr(runner, "_restart_script", lambda name: restarts.append(name))

        class FakeProc:
            def poll(self):
                return 0

        runner._processes["s"] = {
            "process": FakeProc(),
            "restart_count": 0,
            "crashed": False,
        }
        runner._handle_process_death("s", 0, 0)

        assert restarts == []
        assert runner._processes["s"]["status"] == "exited"

    def test_watcher_rechecks_running_after_sleep(self, monkeypatch):
        import services.script_runner as sr

        runner = sr.ScriptRunner(client=None)
        runner._running = True
        scans = []

        class FakeWatcher:
            def __init__(self, *a, **k):
                self.interval = 0

            def _scan(self):
                scans.append(1)

        monkeypatch.setattr(sr, "FileWatcher", FakeWatcher)

        def fake_sleep(_seconds):
            # 模拟 sleep 期间 stop() 被调用
            runner._running = False

        monkeypatch.setattr(sr.time, "sleep", fake_sleep)

        runner._run_watcher()
        assert scans == []


# ============================================================
# BE-COR-M11：端口探测不阻塞事件循环
# ============================================================

class TestClientLazyAcquire:
    """V6 平迁（原 TestGatewayLazyClient，gateway 已退役）：
    acquire_opencode_client 保持 BE-COR-M11——客户端构造延迟到线程池，
    不在事件循环线程上触发端口探测。"""

    def test_acquire_defers_client_creation_to_executor(self, monkeypatch):
        import asyncio
        import threading
        from unittest.mock import MagicMock
        from config.config import get_config
        import services.opencode_client as oc

        cfg = get_config()
        features = cfg._data.setdefault("features", {})
        monkeypatch.setitem(features, "opencode_mock_enabled", False)

        fake_client = MagicMock()

        calls = []

        def fake_get_client():
            calls.append(threading.get_ident())
            return fake_client

        monkeypatch.setattr(oc, "get_opencode_client", fake_get_client)

        oc._reset_opencode_client()

        # 仅导入/取工厂引用不触发获取
        assert calls == []

        got = asyncio.run(oc.acquire_opencode_client())
        assert got is fake_client
        assert len(calls) == 1
        # 客户端获取发生在工作线程（run_in_executor），而非事件循环线程
        assert calls[0] != threading.get_ident()

        # 第二次 acquire 命中单例缓存，不再走 executor
        got2 = asyncio.run(oc.acquire_opencode_client())
        assert got2 is fake_client
        assert len(calls) == 1

        oc._reset_opencode_client()


# ============================================================
# BE-COR-M12：音频分离临时目录泄漏
# （Wave C1 处置：本用例直测已删除的本地 audio_processor.AudioProcessor
#  process() 临时目录清理；该算法链已整体迁入内核，临时目录语义随之消亡，
# 无外层等价职责，按"假绿零容忍"规则删除。）
# ============================================================


# ============================================================
# BE-SEC-M2 / M3：auth 并发与哈希迁移
# ============================================================

def _install_file_backed_auth(monkeypatch, tmp_path):
    """把 auth 的 get/save 换成真实文件读写版本，并隔离全局指针。"""
    target = tmp_path / "auth.json"
    monkeypatch.setattr(auth, "AUTH_CONFIG_FILE", str(target))
    monkeypatch.setattr(auth, "SETUP_TOKEN_FILE", str(tmp_path / ".setup_token"))
    monkeypatch.setattr(auth, "_auth_config", None)

    def _file_get():
        if auth._auth_config is None:
            auth._auth_config = auth.load_auth_config()
        return auth._auth_config

    def _file_save(config):
        fd, tmp = tempfile.mkstemp(
            dir=str(target.parent), prefix=".auth_", suffix=".tmp"
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(config.model_dump(), f, indent=2, ensure_ascii=False)
            os.replace(tmp, str(target))
        except Exception:
            try:
                os.remove(tmp)
            except OSError:
                pass
            raise

    monkeypatch.setattr(auth, "get_auth_config", _file_get)
    monkeypatch.setattr(auth, "save_auth_config", _file_save)
    return target


class TestAuthConcurrency:
    def test_concurrent_logout_no_lost_tokens(self, monkeypatch, tmp_path):
        _install_file_backed_auth(monkeypatch, tmp_path)
        ok, _, _ = auth.create_first_user("u", "password123")
        assert ok is True

        tokens = [auth.create_token("u") for _ in range(40)]

        barrier = threading.Barrier(2)

        def logout_group(group):
            barrier.wait()
            for token in group:
                auth.logout(token)

        t1 = threading.Thread(target=logout_group, args=(tokens[:20],))
        t2 = threading.Thread(target=logout_group, args=(tokens[20:],))
        t1.start()
        t2.start()
        t1.join()
        t2.join()

        # 读磁盘：所有显式登出的 token 都应被删除，无丢写残留
        config = auth.load_auth_config()
        remaining = [t for t in tokens if t in config.tokens]
        assert remaining == []


class TestAuthHashMigration:
    def test_sha256_login_migrates_to_bcrypt(self, monkeypatch, tmp_path):
        target = _install_file_backed_auth(monkeypatch, tmp_path)

        old_digest = hashlib.sha256(b"password123").hexdigest()
        cfg = auth.AuthConfig(
            users={"u": auth.UserInfo(password_hash=old_digest, display_name="u")}
        )
        auth.save_auth_config(cfg)
        auth._auth_config = None

        # 旧哈希登录成功
        assert auth.verify_password("u", "password123") == (True, "u")

        # 磁盘上的哈希已迁移为 bcrypt
        reloaded = auth.load_auth_config()
        new_hash = reloaded.users["u"].password_hash
        assert new_hash.startswith(("$2a$", "$2b$"))

    def test_unknown_hash_format_rejected(self, monkeypatch):
        cfg = auth.AuthConfig(
            users={"u": auth.UserInfo(password_hash="deadbeef", display_name="u")}
        )
        monkeypatch.setattr(auth, "get_auth_config", lambda: cfg)
        assert auth._check_password("anything", "deadbeef") is False
        assert auth._check_password("anything", "z" * 64) is False

    def test_sha256_compare_uses_constant_time(self, monkeypatch):
        digest = hashlib.sha256(b"pw").hexdigest()
        calls = []
        real = auth.hmac.compare_digest

        def spy(a, b):
            calls.append(1)
            return real(a, b)

        monkeypatch.setattr(auth.hmac, "compare_digest", spy)
        assert auth._check_password("pw", digest) is True
        assert calls, "SHA256 比较应使用 hmac.compare_digest"
