# -*- coding: utf-8 -*-
"""
安全整改 阶段 6.1 回归测试（后端低危/死代码清理）

覆盖:
- BE-SEC-L2: _safe_resolve 同前缀兄弟目录穿越被拒（commonpath 严格校验）
- BE-SEC-L4: component_manager 的死 bash 执行路径已移除
- BE-COR-L1: 已废弃的 sse_forwarder 模块已移除
- BE-COR-L2: _cleanup_later 持有任务强引用
- BE-COR-L3: perception_store 无被覆盖的重复顶层函数定义
- BE-COR-L5: 任务调度按东八区墙上时间计算 next_run（避免本地时区偏移）
- BE-COR-L7: execute_callback=None 时执行记录不再永久停留在 running 态
（BE-COR-L6 的 session_history_saver 原子写测试已随该死模块于 2026-10-08 P0-U2 删除）
"""
import ast
import asyncio
import importlib.util
import os
import pathlib
from datetime import datetime

import pytest

_BACKEND_DIR = pathlib.Path(__file__).resolve().parent.parent


# ============================================================
# BE-SEC-L2: _safe_resolve 严格前缀校验
# ============================================================

class TestSafeResolvePrefixBypass:
    def test_sibling_prefix_rejected(self):
        """`../data_evil/x` 与 ai/data 前缀相同，旧 startswith 会误放行 -> 现应 403"""
        from fastapi import HTTPException
        from routers.mobile import _safe_resolve

        with pytest.raises(HTTPException) as ei:
            _safe_resolve("../data_evil/secret.txt", scope="data")
        assert ei.value.status_code == 403

    def test_root_scope_sibling_prefix_rejected(self):
        """scope=root 时 `../ai_evil` 同为同前缀兄弟目录 -> 403"""
        from fastapi import HTTPException
        from routers.mobile import _safe_resolve

        with pytest.raises(HTTPException) as ei:
            _safe_resolve("../ai_evil/secret.txt", scope="root")
        assert ei.value.status_code == 403

    def test_plain_parent_traversal_still_rejected(self):
        """普通 `../../etc` 穿越仍被拒"""
        from fastapi import HTTPException
        from routers.mobile import _safe_resolve

        with pytest.raises(HTTPException) as ei:
            _safe_resolve("../../etc/passwd", scope="data")
        assert ei.value.status_code == 403

    def test_normal_path_accepted(self):
        """根目录内正常相对路径解析成功"""
        from routers.mobile import _safe_resolve

        p = _safe_resolve("daily/2026-06-06/health.json", scope="data")
        assert p.endswith(os.path.join("daily", "2026-06-06", "health.json"))


# ============================================================
# BE-SEC-L4: 死 bash 执行路径移除
# ============================================================

class TestBashDeadCodeRemoved:
    def test_component_manager_no_bash_exec(self):
        """create_bash / _run_bash_command 等潜在 RCE 死代码已移除"""
        from services.component_manager import ComponentManager

        assert not hasattr(ComponentManager, "create_bash")
        assert not hasattr(ComponentManager, "_run_bash_command")
        assert not hasattr(ComponentManager, "_cleanup_bash")

    def test_leading_spaces_ws_no_terminal_service(self):
        """ws_main 不再引用 terminal_service（死 terminal_input 分支已移除）"""
        src = (_BACKEND_DIR / "routers" / "ws_main.py").read_text(encoding="utf-8")
        assert "terminal_service" not in src


# ============================================================
# BE-COR-L1: 废弃的 sse_forwarder 模块移除
# ============================================================

class TestSseForwarderRemoved:
    def test_module_not_importable(self):
        """失效 import 所在模块已删除，无法再被导入"""
        assert importlib.util.find_spec("services.sse_forwarder") is None


# ============================================================
# BE-COR-L2: _cleanup_later 任务强引用
# ============================================================

class TestCleanupLaterStrongRef:
    @pytest.mark.asyncio
    async def test_task_reference_retained(self, tmp_path):
        import routers.voiceprint_audit as va

        f = tmp_path / "x.txt"
        f.write_text("a", encoding="utf-8")

        va._cleanup_tasks.clear()
        va._cleanup_later(str(f))
        # 任务必须被强引用持有，否则会被事件循环提前 GC
        assert len(va._cleanup_tasks) == 1

        # 清理：取消挂起的 30s 任务，避免泄漏到其它用例
        for t in list(va._cleanup_tasks):
            t.cancel()
        await asyncio.gather(*list(va._cleanup_tasks), return_exceptions=True)
        assert len(va._cleanup_tasks) == 0


# ============================================================
# BE-COR-L3: perception_store 重复定义清理
# ============================================================

class TestPerceptionStoreNoDuplicates:
    def test_no_duplicate_top_level_functions(self):
        src = (_BACKEND_DIR / "services" / "perception_store.py").read_text(encoding="utf-8")
        tree = ast.parse(src)
        names = [n.name for n in tree.body if isinstance(n, ast.FunctionDef)]
        for fn in ("save_audio", "append_perception"):
            assert names.count(fn) == 1, f"{fn} 存在 {names.count(fn)} 次定义（应只保留 1 个）"


# ============================================================
# BE-COR-L5: 调度时区统一为东八区
# ============================================================

def _make_scheduler(execute_callback=None):
    from services.task_scheduler import TaskScheduler

    class FakeStorage:
        def start_repair_monitor(self):
            pass

    return TaskScheduler(task_storage=FakeStorage(), execute_callback=execute_callback)


class TestSchedulerTimezone:
    def test_daily_next_run_is_cst_epoch(self):
        """06:00 时计算 daily 08:00 -> 应为同日 08:00 东八区的绝对时间戳"""
        from services.task_scheduler import _CST

        sched = _make_scheduler()
        now = datetime(2026, 6, 24, 6, 0, 0)  # naive 东八区墙上时间
        ts = sched._calculate_daily_next_run({"hour": 8, "minute": 0}, now, None)
        assert ts == datetime(2026, 6, 24, 8, 0, 0, tzinfo=_CST).timestamp()

    def test_calculate_next_run_schedule_path_no_type_error(self):
        """schedule 字段（含 monthly）走 ScheduleParser 不因时区 aware/naive 混用报错"""
        from services.task_models import Task

        sched = _make_scheduler()
        base = dict(task_id="t", user_id="u", task_name="n", prompt="p",
                    schedule_type="", schedule_config={})

        t_daily = Task(**base, schedule="daily 08:00")
        assert isinstance(sched._calculate_next_run(t_daily), float)

        t_monthly = Task(**base, schedule="monthly 1,15 14:30")
        assert isinstance(sched._calculate_next_run(t_monthly), float)


# ============================================================
# BE-COR-L7: execute_callback=None 不再卡死
# ============================================================

class TestSchedulerNoCallback:
    @pytest.mark.asyncio
    async def test_execution_terminates_without_callback(self):
        from types import SimpleNamespace
        from services.task_scheduler import TaskScheduler
        from services.task_models import Task

        task = Task(
            task_id="t1", user_id="u", task_name="n", prompt="p",
            schedule_type="scheduled", schedule_config={},
        )
        updates = []

        class FakeStorage:
            def update_task(self, *a, **k):
                return task

            def record_execution(self, **k):
                return SimpleNamespace(status="executing", completed_at=None, error_message=None)

            def update_execution(self, execution):
                updates.append(execution)
                return True

        sched = TaskScheduler(task_storage=FakeStorage(), execute_callback=None)
        await sched._execute_task(task)

        assert updates, "未配置回调时执行记录必须被结束，不能停留在 executing"
        last = updates[-1]
        assert last.completed_at is not None
        assert last.status in ("success", "failed")
