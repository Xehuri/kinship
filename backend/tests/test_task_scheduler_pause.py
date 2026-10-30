# -*- coding: utf-8 -*-
"""TaskScheduler.set_paused: idempotent flag, no dispatch while paused, resume dispatch."""
import asyncio

import pytest

from services.task_scheduler import TaskScheduler
from services.task_storage import TaskStorage


@pytest.fixture
def storage(tmp_path):
    return TaskStorage(data_dir=str(tmp_path))


async def _pump_until_idle(sched, timeout=2.0):
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while sched._pending_tasks and loop.time() < end:
        await asyncio.sleep(0.01)
    assert not sched._pending_tasks


async def _check(sched):
    await sched._check_tasks()
    await _pump_until_idle(sched)


def test_set_paused_is_idempotent_and_does_not_touch_lifecycle(storage):
    sched = TaskScheduler(task_storage=storage)

    assert sched.paused is False
    assert sched.get_status()["paused"] is False

    sched.set_paused(True)
    sched.set_paused(True)

    assert sched.paused is True
    assert sched.get_status()["paused"] is True
    assert sched.is_running() is False
    assert sched._task is None

    sched.set_paused(False)
    sched.set_paused(False)

    assert sched.paused is False
    assert sched.get_status()["paused"] is False
    assert sched.is_running() is False
    assert sched._task is None


def test_paused_scheduler_skips_due_tasks_then_resumes(storage):
    async def scenario():
        hits: list[int] = []

        async def callback():
            hits.append(1)

        sched = TaskScheduler(task_storage=storage)
        task = sched.register_builtin("pause_probe", "daily 03:00", callback)
        task.next_run = 1.0
        sched.set_paused(True)

        await _check(sched)

        assert hits == []
        assert task.run_count == 0

        sched.set_paused(False)
        await _check(sched)

        assert hits == [1]
        assert task.run_count == 1

    asyncio.run(scenario())
