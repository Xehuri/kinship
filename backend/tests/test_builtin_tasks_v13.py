"""
V13 内建回调任务单测（TaskScheduler.register_builtin / TaskStorage 内建通道）

本环境无 pytest-asyncio 插件（asyncio-marked 用例属基线失败面），故全部用
同步用例 + asyncio.run 驱动，保证零新增失败可核。

覆盖:
  1. 注册语义: 稳定 task_id=builtin_{name}、非法 schedule 响亮失败、同名幂等替换
  2. 到点执行: tick 判定到期 -> 内建回调被调、不走 execute_callback(prompt 语义)
  3. 执行记录: task_executions 成功记录 + tasks_state.json 运行态落盘（观测）
  4. 同日不双触发: 执行后 next_run 推进，后续 tick 不再触发
  5. 失败路径: 回调异常记 failed 且 next_run 仍推进（明日再试不受影响）
  6. 定义不进 YAML: 序列化跳过 + 热重载重注入 + delete_task 拒绝
  7. 重启回并: 新 Storage/Scheduler 实例注册同名任务时回并 tasks_state 运行态
  8. 回归护栏: 无回调 prompt 任务的执行记录仍显式终止（BE-COR-L7 语义不变）
"""
import asyncio
import os
import sys
from datetime import datetime

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.task_scheduler import TaskScheduler
from services.task_storage import TaskStorage
from services.task_models import Task


@pytest.fixture
def storage(tmp_path):
    return TaskStorage(data_dir=str(tmp_path))


async def _pump_until_idle(sched, timeout=2.0):
    """等待 _check_tasks 派生的执行任务全部收尾（_pending_tasks 清空）。"""
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while sched._pending_tasks and loop.time() < end:
        await asyncio.sleep(0.01)
    assert not sched._pending_tasks, "执行任务未在超时内收尾"


async def _check_once(sched):
    await sched._check_tasks()
    await _pump_until_idle(sched)


# ============ 1. 注册语义 ============

def test_register_builtin_id_and_state_entry(storage):
    sched = TaskScheduler(task_storage=storage)
    task = sched.register_builtin("unit_probe", "daily 03:00", (lambda: None))
    assert task.task_id == "builtin_unit_probe"
    assert task.enabled and task.repeat and task.user_id == "system"
    assert task.schedule == "daily 03:00"
    assert storage.get_task("builtin_unit_probe") is task
    # 注册即可见为启用任务（tick 经 get_enabled_tasks 覆盖，无需调度器特判）
    assert "builtin_unit_probe" in {t.task_id for t in storage.get_enabled_tasks()}


def test_register_builtin_invalid_schedule_raises(storage):
    sched = TaskScheduler(task_storage=storage)
    with pytest.raises(ValueError, match="schedule 非法"):
        sched.register_builtin("bad", "daily 25:00", (lambda: None))


def test_register_builtin_same_name_replaces(storage):
    sched_a = TaskScheduler(task_storage=storage)
    sched_b = TaskScheduler(task_storage=storage)
    sched_a.register_builtin("dup", "daily 03:00", (lambda: None))
    task2 = sched_b.register_builtin("dup", "daily 05:00", (lambda: None))
    assert task2.task_id == "builtin_dup"
    assert storage.get_task("builtin_dup").schedule == "daily 05:00"


# ============ 2/3/4. 到点执行 + 执行记录 + 同日不双触发 ============

def test_builtin_due_executes_and_records(storage):
    hits = []

    async def cb():
        hits.append(1)

    prompt_calls = []

    async def prompt_cb(task):
        prompt_calls.append(task.task_id)

    sched = TaskScheduler(task_storage=storage, execute_callback=prompt_cb)
    task = sched.register_builtin("unit_probe", "daily 03:00", cb)
    task.next_run = 1.0  # 模拟到点（与 _check_tasks 判定基准同为绝对时间戳）

    asyncio.run(_check_once(sched))

    assert hits == [1], "内建回调应被执行且只执行一次"
    assert prompt_calls == [], "内建任务不得走 execute_callback(prompt 语义)"

    # 执行记录进 task_executions（成功）
    hist = storage.get_execution_history("builtin_unit_probe")
    assert hist and hist[0].status == "success"

    # 运行时状态进 tasks_state（观测面；存储层 YAML/JSON 双格式，用自身读取器断言）
    state = storage._load_state()
    entry = state["builtin_unit_probe"]
    assert entry["run_count"] == 1
    assert entry["last_run"]
    # next_run 已推进到未来（每日单触发由 next_run 推进天然保证）
    now_ts = datetime.now().timestamp()
    assert entry["next_run"] > now_ts

    # 后续 tick 不再同日双触发
    asyncio.run(_check_once(sched))
    asyncio.run(_check_once(sched))
    assert hits == [1], "next_run 推进后同日不得重复触发"


# ============ 5. 失败路径 ============

def test_builtin_failure_records_failed_and_advances(storage):
    async def boom():
        raise RuntimeError("kernel unreachable")

    sched = TaskScheduler(task_storage=storage)
    task = sched.register_builtin("failing_probe", "daily 04:00", boom)
    task.next_run = 1.0

    asyncio.run(_check_once(sched))

    hist = storage.get_execution_history("builtin_failing_probe")
    assert hist and hist[0].status == "failed"
    assert "kernel unreachable" in (hist[0].error_message or "")
    # 失败不影响 next_run 推进（执行前已推进，语义=原循环「明日再试」）
    assert task.next_run and task.next_run > datetime.now().timestamp()


# ============ 6. 定义不进 YAML / 热重载注入 / 删除拒绝 ============

def test_builtin_not_serialized_reload_keeps_delete_rejected(storage):
    async def cb():
        pass

    sched = TaskScheduler(task_storage=storage)
    sched.register_builtin("unit_probe", "daily 03:00", cb)

    # 制造一个 YAML 任务并走 tasks/ 目录模式热重载
    storage.tasks_dir.mkdir(parents=True, exist_ok=True)
    yaml_file = storage.tasks_dir / "100-yaml-demo.yaml"
    yaml_file.write_text(
        "name: YAML演示任务\nprompt: hi\nschedule: daily 09:00\n", encoding="utf-8"
    )
    assert storage._load_tasks_from_directory() is True

    ids = {t.task_id for t in storage.get_enabled_tasks()}
    assert "builtin_unit_probe" in ids, "热重载后内建任务必须被重新注入"
    assert any(tid.startswith("task_") for tid in ids), "YAML 任务应同时在册"

    # 内建任务定义不出现在任何 YAML 文件中（序列化跳过）
    for f in storage.tasks_dir.glob("*.yaml"):
        assert "builtin_unit_probe" not in f.read_text(encoding="utf-8")

    # 删除拒绝（防误删）
    assert storage.delete_task("builtin_unit_probe") is False
    assert storage.get_task("builtin_unit_probe") is not None


# ============ 7. 重启回并运行态 ============

def test_builtin_state_rehydrated_on_re_register(storage):
    async def cb():
        pass

    sched = TaskScheduler(task_storage=storage)
    task = sched.register_builtin("unit_probe", "daily 03:00", cb)
    task.next_run = 1.0
    asyncio.run(_check_once(sched))

    persisted = storage._load_state()["builtin_unit_probe"]
    assert persisted["run_count"] == 1

    # 模拟重启：新存储实例读同一数据目录，再注册同名内建任务
    storage2 = TaskStorage(data_dir=str(storage.data_dir))
    sched2 = TaskScheduler(task_storage=storage2)
    task2 = sched2.register_builtin("unit_probe", "daily 03:00", cb)
    assert task2.run_count == persisted["run_count"]
    assert task2.next_run == pytest.approx(persisted["next_run"])
    # 回并后的 next_run 仍在未来 -> 重启当日不重复补跑
    assert task2.next_run > datetime.now().timestamp()


# ============ 8. 回归护栏：prompt 任务无回调路径 ============

def test_prompt_task_without_callback_terminates_record():
    """BE-COR-L7 语义回归：分派重构后无回调 prompt 任务仍显式终止执行记录。"""
    from types import SimpleNamespace

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
    asyncio.run(sched._execute_task(task))

    assert updates, "未配置回调时执行记录必须被结束，不能停留在 executing"
    last = updates[-1]
    assert last.completed_at is not None
    assert last.status == "failed"
    assert "未配置执行回调" in (last.error_message or "")
