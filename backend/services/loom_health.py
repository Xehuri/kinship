"""Loom readiness cache for the public /health endpoint.

The probe runs in the background so /health never waits on a Loom request.
State is process-local and reset on backend restart; an unknown state is
honest during the first probe window.
"""

import asyncio
import contextlib
import logging
import time
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

PROBE_INTERVAL_S = 15.0
PROBE_TIMEOUT_S = 2.0
OFFLINE_LOG_INTERVAL_S = 60.0

_STATE: Dict[str, Any] = {
    "status": "unknown",
    "version": None,
    "checked_at": None,
}
_task: Optional[asyncio.Task] = None
_last_status: Optional[str] = None
_last_log_at = 0.0


def _record(state: str, version: Optional[str], detail: Optional[str]) -> None:
    global _last_status, _last_log_at
    now = time.time()
    _STATE.update({"status": state, "version": version, "checked_at": now})
    should_log = state != _last_status or (
        state == "offline" and now - _last_log_at >= OFFLINE_LOG_INTERVAL_S
    )
    if should_log:
        if state == "online":
            logger.info("[LoomHealth] online version=%s", version or "unknown")
        else:
            logger.warning("[LoomHealth] offline: %s", detail or "unknown")
        _last_status = state
        _last_log_at = now


async def probe_once(timeout: float = PROBE_TIMEOUT_S) -> Dict[str, Any]:
    from services.loom_client import acquire_loom_client

    detail: Optional[str] = None
    version: Optional[str] = None
    try:
        client = await acquire_loom_client()
        result = await asyncio.wait_for(client.health_check(), timeout=timeout)
        data = result.get("data") if isinstance(result, dict) else None
        if not isinstance(data, dict):
            data = {}
        status = data.get("status")
        candidate = data.get("version")
        if isinstance(candidate, str) and candidate:
            version = candidate
        if status == "online":
            _record("online", version, None)
        else:
            detail = str(data.get("detail") or "loom health not online")
            _record("offline", None, detail)
    except Exception as exc:
        _record("offline", None, str(exc))
    return get_loom_health()


def get_loom_health() -> Dict[str, Any]:
    state = dict(_STATE)
    checked_at = state.get("checked_at")
    state["age_s"] = None if checked_at is None else round(time.time() - checked_at, 1)
    return state


async def _probe_loop() -> None:
    while True:
        await probe_once()
        await asyncio.sleep(PROBE_INTERVAL_S)


def start_loom_health_probe() -> asyncio.Task:
    global _task
    if _task is None or _task.done():
        _task = asyncio.create_task(_probe_loop())
    return _task


async def stop_loom_health_probe() -> None:
    global _task
    task, _task = _task, None
    if task is None:
        return
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
