# -*- coding: utf-8 -*-
"""T8 task letter dispatch: flag gating, accepted vs success, result reconciliation."""
import asyncio
import logging
import os
import sys
import time

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from config.config import get_config
from services import task_executor as task_executor_module
from services import task_scheduler as task_scheduler_module
from services.task_executor import TaskExecutor, TaskLetterDispatch
from services.task_models import Task, TaskExecution, TaskExecutionState
from services.task_scheduler import TaskScheduler
from services.task_storage import TaskStorage


def _set_tasks_config(monkeypatch, **values):
    cfg = get_config()
    section = cfg._data.get("tasks")
    section = dict(section) if isinstance(section, dict) else {}
    section.update(values)
    monkeypatch.setitem(cfg._data, "tasks", section)


def _task(**overrides):
    data = {
        "task_id": "task_t8",
        "user_id": "u1",
        "task_name": "T8任务",
        "prompt": "请检查今日数据",
        "schedule_type": "scheduled",
        "schedule_config": {},
        "target_type": "specific",
        "target_session": "ses_main",
        "last_run": 1_700_000_000.0,
        "run_count": 2,
    }
    data.update(overrides)
    return Task(**data)


class _FakeSessionManager:
    def get_agent_session(self, name):
        return "ses_main"

    def get_current_session(self):
        return None


class _FakeAIClient:
    def __init__(self, letter_responses=None, result_responses=None):
        self.letter_responses = list(letter_responses or [])
        self.result_responses = list(result_responses or [])
        self.letters = []
        self.messages = []
        self.result_calls = []
        self.status_calls = []

    async def get_session_status(self, session_id):
        self.status_calls.append(session_id)
        return {"ok": True, "data": {"status": "active"}}

    async def send_message(self, session_id, message, **kwargs):
        self.messages.append({"session_id": session_id, "message": message, **kwargs})
        return {"ok": True, "data": {"sent": True}}

    async def send_letter(self, session_id, letter):
        self.letters.append({"session_id": session_id, "letter": letter})
        if self.letter_responses:
            item = self.letter_responses.pop(0)
            if isinstance(item, Exception):
                raise item
            return item
        return True, None, {
            "status": 202,
            "body": {"accepted": True, "letter_id": "letter-1"},
        }

    async def get_inbox_result(self, correlation_id):
        self.result_calls.append(correlation_id)
        if self.result_responses:
            item = self.result_responses.pop(0)
            if isinstance(item, Exception):
                raise item
            return item
        return {"ok": False, "error": {"code": "not_found"}, "status": 404}


class _NoLetterClient(_FakeAIClient):
    send_letter = None


def _install_executor(monkeypatch, client, storage):
    async def _acquire():
        return client

    monkeypatch.setattr(task_executor_module, "acquire_opencode_client", _acquire)
    monkeypatch.setattr(
        task_executor_module, "get_session_manager", lambda: _FakeSessionManager()
    )
    monkeypatch.setattr(task_executor_module, "get_task_storage", lambda: storage)


def _install_scheduler_client(monkeypatch, client):
    async def _acquire():
        return client

    monkeypatch.setattr(task_scheduler_module, "acquire_opencode_client", _acquire)


def _accepted_execution(storage, correlation_id="task:task_t8:1700000000:2", started_at=None):
    execution = storage.record_execution(
        task_id="task_t8", status=TaskExecutionState.ACCEPTED.value
    )
    execution.correlation_id = correlation_id
    execution.letter_id = "letter-1"
    execution.dispatch_mode = "letter"
    execution.result_status = TaskExecutionState.ACCEPTED.value
    if started_at is not None:
        execution.started_at = started_at
    assert storage.update_execution(execution)
    return execution


@pytest.fixture
def storage(tmp_path):
    return TaskStorage(data_dir=str(tmp_path))


def test_flag_off_keeps_send_message_and_bool_success(monkeypatch, storage):
    _set_tasks_config(monkeypatch, letter_dispatch=False)
    client = _FakeAIClient()
    _install_executor(monkeypatch, client, storage)
    executor = TaskExecutor()

    result = asyncio.run(executor.execute(_task()))

    assert result is True
    assert len(client.messages) == 1
    assert client.letters == []


def test_flag_on_sends_one_letter_with_expected_fields(monkeypatch, storage):
    _set_tasks_config(monkeypatch, letter_dispatch=True)
    client = _FakeAIClient()
    _install_executor(monkeypatch, client, storage)
    executor = TaskExecutor()

    result = asyncio.run(executor.execute(_task()))

    assert isinstance(result, TaskLetterDispatch)
    assert result.correlation_id == "task:task_t8:1700000000:2"
    assert result.letter_id == "letter-1"
    assert result.duplicate is False
    assert client.messages == []
    assert len(client.letters) == 1

    sent = client.letters[0]
    assert sent["session_id"] == "ses_main"
    letter = sent["letter"]
    assert set(letter) == {
        "source",
        "kind",
        "class",
        "trust",
        "principal",
        "title",
        "body",
        "correlation_id",
        "dedupe_key",
        "ref",
    }
    assert letter["source"] == "backend.tasks"
    assert letter["kind"] == "task.trigger"
    assert letter["class"] == "notify"
    assert letter["trust"] == "trusted_service"
    assert letter["principal"] == "task:task_t8"
    assert letter["title"] == "T8任务"
    assert letter["body"].startswith("【定时任务】T8任务")
    assert "请检查今日数据" in letter["body"]
    assert letter["correlation_id"] == "task:task_t8:1700000000:2"
    assert letter["dedupe_key"] == letter["correlation_id"]
    assert letter["ref"] == {"task_id": "task_t8", "run_count": 2}


def test_duplicate_200_counts_as_dispatched(monkeypatch, storage):
    _set_tasks_config(monkeypatch, letter_dispatch=True)
    client = _FakeAIClient(
        letter_responses=[
            (True, None, {
                "status": 200,
                "body": {"duplicate": True, "letter_id": "letter-old"},
            })
        ]
    )
    _install_executor(monkeypatch, client, storage)
    executor = TaskExecutor()

    result = asyncio.run(executor.execute(_task()))

    assert isinstance(result, TaskLetterDispatch)
    assert result.duplicate is True
    assert result.letter_id == "letter-old"
    assert len(client.letters) == 1


def test_missing_send_letter_fails_loud_without_fallback(monkeypatch, storage, caplog):
    _set_tasks_config(monkeypatch, letter_dispatch=True)
    client = _NoLetterClient()
    _install_executor(monkeypatch, client, storage)
    executor = TaskExecutor()

    with caplog.at_level(logging.ERROR, logger="services.task_executor"):
        result = asyncio.run(executor._execute_once(_task()))

    assert result is False
    assert client.messages == []
    assert client.letters == []
    assert "不支持 send_letter" in caplog.text


def test_transport_failure_then_retry_reuses_same_correlation_and_dedupe(
    monkeypatch, storage
):
    _set_tasks_config(monkeypatch, letter_dispatch=True)
    client = _FakeAIClient(
        letter_responses=[
            (False, "HTTP 503: inbox down", {"status": 503}),
            (True, None, {
                "status": 202,
                "body": {"accepted": True, "letter_id": "letter-1"},
            }),
        ]
    )
    _install_executor(monkeypatch, client, storage)
    executor = TaskExecutor()
    task = _task()

    first = asyncio.run(executor._execute_once(task))
    second = asyncio.run(executor._execute_once(task))

    assert first is False
    assert isinstance(second, TaskLetterDispatch)
    assert len(client.letters) == 2
    first_letter = client.letters[0]["letter"]
    second_letter = client.letters[1]["letter"]
    assert first_letter["correlation_id"] == second_letter["correlation_id"]
    assert first_letter["dedupe_key"] == second_letter["dedupe_key"]


def test_scheduler_flag_off_marks_success(monkeypatch, storage):
    _set_tasks_config(monkeypatch, letter_dispatch=False)
    client = _FakeAIClient()
    _install_executor(monkeypatch, client, storage)
    executor = TaskExecutor()
    scheduler = TaskScheduler(task_storage=storage, execute_callback=executor.execute)

    asyncio.run(scheduler._execute_task(_task()))

    execution = storage.get_execution_history("task_t8")[0]
    assert execution.status == "success"
    assert execution.dispatch_mode == "message"
    assert execution.completed_at is not None
    assert execution.correlation_id is None


def test_scheduler_flag_on_marks_accepted_not_success(monkeypatch, storage):
    _set_tasks_config(monkeypatch, letter_dispatch=True)
    client = _FakeAIClient()
    _install_executor(monkeypatch, client, storage)
    executor = TaskExecutor()
    scheduler = TaskScheduler(task_storage=storage, execute_callback=executor.execute)
    task = _task()

    asyncio.run(scheduler._execute_task(task))

    execution = storage.get_execution_history("task_t8")[0]
    assert execution.status == TaskExecutionState.ACCEPTED.value
    assert execution.status != "success"
    assert execution.correlation_id == f"task:task_t8:{int(task.last_run)}:{task.run_count}"
    assert execution.letter_id == "letter-1"
    assert execution.dispatch_mode == "letter"
    assert execution.result_status == TaskExecutionState.ACCEPTED.value
    assert execution.completed_at is None
    assert len(client.letters) == 1


@pytest.mark.parametrize(
    ("result_body", "expected_status", "expected_result_status", "closed"),
    [
        ({"status": "pending"}, "accepted", "pending", False),
        ({"status": "observed"}, "accepted", "observed", False),
        (
            {"status": "completed", "outcome": "posted", "evidence_ref": "evt-1"},
            "completed",
            "posted",
            True,
        ),
        (
            {"status": "failed", "outcome": "delivery_failed", "evidence_ref": "evt-2"},
            "failed",
            "delivery_failed",
            True,
        ),
    ],
)
def test_reconcile_maps_loom_result(
    monkeypatch, storage, result_body, expected_status, expected_result_status, closed
):
    _set_tasks_config(monkeypatch, letter_dispatch=True)
    client = _FakeAIClient(result_responses=[{"ok": True, "data": result_body}])
    _install_scheduler_client(monkeypatch, client)
    execution = _accepted_execution(storage)
    scheduler = TaskScheduler(task_storage=storage)

    asyncio.run(scheduler._reconcile_letter_results())

    assert client.result_calls == ["task:task_t8:1700000000:2"]
    assert execution.status == expected_status
    assert execution.result_status == expected_result_status
    assert execution.last_result_at is not None
    if closed:
        assert execution.completed_at is not None
    else:
        assert execution.completed_at is None


def test_reconcile_failed_keeps_error_evidence(monkeypatch, storage):
    _set_tasks_config(monkeypatch, letter_dispatch=True)
    client = _FakeAIClient(
        result_responses=[
            {
                "ok": True,
                "data": {
                    "status": "failed",
                    "outcome": "agent_error",
                    "evidence_ref": "run-42",
                },
            }
        ]
    )
    _install_scheduler_client(monkeypatch, client)
    execution = _accepted_execution(storage)
    scheduler = TaskScheduler(task_storage=storage)

    asyncio.run(scheduler._reconcile_letter_results())

    assert execution.status == "failed"
    assert execution.result_status == "agent_error"
    assert "agent_error" in execution.error_message
    assert execution.completed_at is not None


@pytest.mark.parametrize(
    "client_result",
    [
        {"ok": False, "error": {"code": "not_found"}, "status": 404},
        {"ok": False, "error": {"code": 500}, "status": 500},
    ],
)
def test_reconcile_not_found_or_error_keeps_accepted(monkeypatch, storage, client_result):
    _set_tasks_config(monkeypatch, letter_dispatch=True)
    client = _FakeAIClient(result_responses=[client_result])
    _install_scheduler_client(monkeypatch, client)
    execution = _accepted_execution(storage)
    scheduler = TaskScheduler(task_storage=storage)

    asyncio.run(scheduler._reconcile_letter_results())

    assert execution.status == TaskExecutionState.ACCEPTED.value
    assert execution.result_status == TaskExecutionState.ACCEPTED.value
    assert execution.completed_at is None
    assert execution.last_result_at is None


def test_reconcile_timeout_turns_unknown_without_query(monkeypatch, storage):
    _set_tasks_config(
        monkeypatch, letter_dispatch=True, letter_result_timeout_seconds=10
    )
    client = _FakeAIClient(result_responses=[{"ok": True, "data": {"status": "completed"}}])
    _install_scheduler_client(monkeypatch, client)
    execution = _accepted_execution(storage, started_at=time.time() - 11)
    scheduler = TaskScheduler(task_storage=storage)

    asyncio.run(scheduler._reconcile_letter_results())

    assert client.result_calls == []
    assert execution.status == TaskExecutionState.UNKNOWN.value
    assert execution.status != "success"
    assert execution.result_status == "timeout"
    assert execution.error_message == "result timeout"
    assert execution.completed_at is not None


def test_reconcile_caps_batch_at_20_oldest_first(monkeypatch, storage):
    _set_tasks_config(monkeypatch, letter_dispatch=True)
    client = _FakeAIClient(
        result_responses=[{"ok": True, "data": {"status": "pending"}} for _ in range(25)]
    )
    _install_scheduler_client(monkeypatch, client)
    base = time.time() - 100
    executions = [
        _accepted_execution(storage, correlation_id=f"c{i}", started_at=base + i)
        for i in range(25)
    ]
    scheduler = TaskScheduler(task_storage=storage)

    asyncio.run(scheduler._reconcile_letter_results())

    assert client.result_calls == [f"c{i}" for i in range(20)]
    assert all(item.result_status == "pending" for item in executions[:20])
    assert all(item.result_status == "accepted" for item in executions[20:])


def test_reconcile_interval_gate_and_tick_integration(monkeypatch, storage):
    _set_tasks_config(
        monkeypatch, letter_dispatch=True, letter_reconcile_interval_seconds=5
    )
    client = _FakeAIClient(
        result_responses=[
            {"ok": True, "data": {"status": "pending"}},
            {"ok": True, "data": {"status": "pending"}},
        ]
    )
    _install_scheduler_client(monkeypatch, client)
    execution = _accepted_execution(storage)
    scheduler = TaskScheduler(task_storage=storage)

    scheduler._last_letter_reconcile_at = time.monotonic()
    asyncio.run(scheduler._maybe_reconcile_letter_results())
    assert client.result_calls == []

    scheduler._last_letter_reconcile_at = 0.0
    asyncio.run(scheduler._check_tasks())

    assert client.result_calls == ["task:task_t8:1700000000:2"]
    assert execution.result_status == "pending"


def test_old_execution_record_loads_with_defaults():
    loaded = TaskExecution.from_dict(
        {"execution_id": "exec_old", "task_id": "task_old", "status": "success"}
    )
    assert loaded.status == "success"
    assert loaded.dispatch_mode == "message"
    assert loaded.correlation_id is None
    assert loaded.letter_id is None
    assert loaded.result_status is None
    assert loaded.last_result_at is None
    assert loaded.completed_at is None
