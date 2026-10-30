# -*- coding: utf-8 -*-
"""引导下载作业：内存注册表、全局单活、进度与取消。

作业不持久化：后端重启即丢失（启动期的 ``.part`` 清理由下载器负责）。
所有对外文本经 ``core.redaction.redact_text`` 二次脱敏；令牌/URL 永不进
``logs_tail`` 或 ``error``。
"""
from __future__ import annotations

import logging
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from core.redaction import redact_text

logger = logging.getLogger(__name__)

TERMINAL_STATES = frozenset({"done", "failed", "cancelled"})
_ACTIVE_STATES = frozenset({"queued", "running"})
_MAX_ERROR_CHARS = 500
_MAX_LOG_CHARS = 500

JobRunner = Callable[["Job"], Any]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _truncate(text: str, limit: int) -> str:
    value = redact_text(str(text))
    return value if len(value) <= limit else value[: limit - 1] + "…"


def _jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_jsonable(item) for item in value]
    return str(value)


class JobNotFound(KeyError):
    def __init__(self, job_id: str) -> None:
        super().__init__(job_id)
        self.job_id = job_id


class JobAlreadyRunning(RuntimeError):
    def __init__(self, job_id: str) -> None:
        super().__init__(f"onboarding job already running: {job_id}")
        self.job_id = job_id


class Job:
    def __init__(
        self,
        kind: str,
        *,
        asset: str | None = None,
        job_id: str | None = None,
        max_logs: int = 40,
    ) -> None:
        self.id = job_id or uuid.uuid4().hex
        self.kind = kind
        self.asset = asset
        self.state = "queued"
        self.progress: dict[str, int | None] = {"bytes": 0, "total": None, "pct": 0}
        self.current = "queued"
        self.result: Any = None
        self.error: str | None = None
        self.logs_tail: list[str] = []
        self.created_at = _now()
        self.updated_at = self.created_at
        self._max_logs = max(1, int(max_logs))
        self._lock = threading.Lock()
        self._cancel = threading.Event()
        self._done = threading.Event()

    @property
    def cancel_event(self) -> threading.Event:
        return self._cancel

    @property
    def cancel_requested(self) -> bool:
        return self._cancel.is_set()

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "id": self.id,
                "kind": self.kind,
                "asset": self.asset,
                "state": self.state,
                "progress": dict(self.progress),
                "current": self.current,
                "logs_tail": list(self.logs_tail),
                "result": _jsonable(self.result),
                "error": self.error,
                "cancel_requested": self._cancel.is_set(),
                "created_at": self.created_at,
                "updated_at": self.updated_at,
            }

    def _append_log_locked(self, line: str) -> None:
        text = _truncate(line, _MAX_LOG_CHARS)
        self.logs_tail.append(text)
        if len(self.logs_tail) > self._max_logs:
            del self.logs_tail[: len(self.logs_tail) - self._max_logs]
        self.updated_at = _now()

    def log(self, line: str) -> None:
        with self._lock:
            self._append_log_locked(line)

    def set_current(self, current: str) -> None:
        with self._lock:
            self.current = str(current)
            self.updated_at = _now()

    def update_progress(
        self, done: int, total: int | None, *, phase: str | None = None
    ) -> None:
        done_value = max(0, int(done))
        total_value = int(total) if total else None
        pct = int(done_value * 100 / total_value) if total_value else 0
        pct = min(100, max(0, pct))
        with self._lock:
            previous = self.progress["pct"] or 0
            self.progress = {
                "bytes": done_value,
                "total": total_value,
                "pct": pct,
            }
            if total_value and pct // 10 != previous // 10:
                self._append_log_locked(
                    "[OnboardingAssets] phase=%s asset=%s bytes=%d/%d pct=%d result=progress"
                    % (
                        phase or "download",
                        self.asset or "unknown",
                        done_value,
                        total_value,
                        pct,
                    )
                )
            else:
                self.updated_at = _now()

    def request_cancel(self) -> bool:
        with self._lock:
            if self.state in TERMINAL_STATES:
                return False
            self._cancel.set()
            self.updated_at = _now()
        self.log("[OnboardingJobs] cancel requested")
        return True

    def wait(self, timeout: float | None = None) -> bool:
        return self._done.wait(timeout)

    def _mark_running(self) -> None:
        with self._lock:
            if self.state == "queued":
                self.state = "running"
                self.current = "starting"
                self.updated_at = _now()

    def _finish(self, state: str, result: Any = None, error: str | None = None) -> None:
        with self._lock:
            if self.state in TERMINAL_STATES:
                return
            self.state = state
            self.result = _jsonable(result)
            self.error = _truncate(error, _MAX_ERROR_CHARS) if error else None
            if state == "done":
                self.progress["pct"] = 100
            self.updated_at = _now()
        self._done.set()


class JobManager:
    """单进程作业注册表；同一时刻只允许一个非终态作业。"""

    def __init__(self, *, max_logs: int = 40, max_jobs: int = 50) -> None:
        self._lock = threading.RLock()
        self._jobs: dict[str, Job] = {}
        self._order: list[str] = []
        self._active_id: str | None = None
        self._max_logs = max_logs
        self._max_jobs = max(1, max_jobs)

    def start(
        self,
        kind: str,
        runner: JobRunner,
        *,
        asset: str | None = None,
    ) -> Job:
        with self._lock:
            active = self._jobs.get(self._active_id) if self._active_id else None
            if active is not None and active.state in _ACTIVE_STATES:
                raise JobAlreadyRunning(active.id)
            job = Job(kind, asset=asset, max_logs=self._max_logs)
            self._jobs[job.id] = job
            self._order.append(job.id)
            self._active_id = job.id
            self._prune_locked()
        thread = threading.Thread(
            target=self._run,
            args=(job, runner),
            name=f"onboarding-job-{job.id[:8]}",
            daemon=True,
        )
        thread.start()
        return job

    def get(self, job_id: str) -> Job:
        with self._lock:
            job = self._jobs.get(job_id)
        if job is None:
            raise JobNotFound(job_id)
        return job

    def snapshot(self, job_id: str) -> dict[str, Any]:
        return self.get(job_id).snapshot()

    def list_snapshots(self) -> list[dict[str, Any]]:
        with self._lock:
            jobs = [self._jobs[job_id] for job_id in self._order if job_id in self._jobs]
        return [job.snapshot() for job in jobs]

    def cancel(self, job_id: str) -> dict[str, Any]:
        job = self.get(job_id)
        job.request_cancel()
        return job.snapshot()

    def _run(self, job: Job, runner: JobRunner) -> None:
        job._mark_running()
        if job.cancel_requested:
            job._finish("cancelled", None, "cancelled")
            self._release(job)
            return
        try:
            result = runner(job)
        except Exception as exc:
            if job.cancel_requested:
                logger.info("[OnboardingJobs] job=%s result=cancelled", job.id)
                job._finish("cancelled", None, "cancelled")
            else:
                error = f"{type(exc).__name__}: {exc}"
                logger.warning("[OnboardingJobs] job=%s result=failed error=%s", job.id, type(exc).__name__)
                job._finish("failed", None, error)
        else:
            if job.cancel_requested:
                logger.info("[OnboardingJobs] job=%s result=cancelled", job.id)
                job._finish("cancelled", result, "cancelled")
            else:
                logger.info("[OnboardingJobs] job=%s result=done", job.id)
                job._finish("done", result)
        finally:
            self._release(job)

    def _release(self, job: Job) -> None:
        with self._lock:
            if self._active_id == job.id:
                self._active_id = None

    def _prune_locked(self) -> None:
        if len(self._order) <= self._max_jobs:
            return
        removable = [
            job_id
            for job_id in self._order
            if job_id != self._active_id
            and self._jobs.get(job_id) is not None
            and self._jobs[job_id].state in TERMINAL_STATES
        ]
        for job_id in removable[: len(self._order) - self._max_jobs]:
            self._jobs.pop(job_id, None)
            self._order.remove(job_id)


_manager: JobManager | None = None
_manager_lock = threading.Lock()


def get_job_manager() -> JobManager:
    global _manager
    with _manager_lock:
        if _manager is None:
            _manager = JobManager()
        return _manager
