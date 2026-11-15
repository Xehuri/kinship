"""dsh readiness cache for the public /health endpoint.

与 services/loom_health.py 同构（模块级缓存 + 后台探针 + 公开读取器），
差异只在协议侧：探针调 DshClient.health_check()（bridge GET /v1/health，
异常也返回 {"ok": True, "data": {"status": "offline", ...}} 信封，不外抛）。

探针跑在后台，/health 永不等待 bridge 请求。状态进程内、后端重启即重置；
首探窗口内保持 "unknown" 是诚实表达；ai_backend != "dsh" 时探针不启动，
/health 里 dsh 键恒为 status="unknown"（不假装有结论）。

字段刻意只暴露 health_check 信封能给的：status / version / session_id /
checked_at / age_s。preset、bound 只在 bridge GET /v1/session 里，本探针
不追加第二次请求（公开端点保持零额外往来；且不修改 dsh_client.py 的信封）。
离线原因（detail）只进日志、不进 /health，与 loom_health 同口径，避免公开
端点回显内部错误串。
"""

import asyncio
import contextlib
import logging
import time
from typing import Any, Dict, Optional

from core.redaction import redact_text

logger = logging.getLogger(__name__)

PROBE_INTERVAL_S = 15.0
PROBE_TIMEOUT_S = 2.0
OFFLINE_LOG_INTERVAL_S = 60.0

_STATE: Dict[str, Any] = {
    "status": "unknown",
    "version": None,
    "session_id": None,
    "checked_at": None,
}
_task: Optional[asyncio.Task] = None
_last_status: Optional[str] = None
_last_log_at = 0.0


def _text(value: Any) -> Optional[str]:
    """只接受非空字符串，其余（None/数字/空串）归 None，保证字段可 JSON 序列化。"""
    return value if isinstance(value, str) and value else None


def _record(
    state: str,
    version: Optional[str],
    session_id: Optional[str],
    detail: Optional[str],
) -> None:
    global _last_status, _last_log_at
    now = time.time()
    _STATE.update(
        {
            "status": state,
            "version": version,
            "session_id": session_id,
            "checked_at": now,
        }
    )
    should_log = state != _last_status or (
        state == "offline" and now - _last_log_at >= OFFLINE_LOG_INTERVAL_S
    )
    if should_log:
        if state == "online":
            logger.info(
                "[DshHealth] online version=%s session=%s",
                version or "unknown",
                session_id or "unknown",
            )
        else:
            logger.warning("[DshHealth] offline: %s", detail or "unknown")
        _last_status = state
        _last_log_at = now


async def probe_once(timeout: float = PROBE_TIMEOUT_S) -> Dict[str, Any]:
    """探测一次 bridge /v1/health 并刷缓存；任何异常都落在 offline（绝不外抛）。"""
    from services.dsh_client import acquire_dsh_client

    detail: Optional[str] = None
    version: Optional[str] = None
    session_id: Optional[str] = None
    try:
        client = await acquire_dsh_client()
        result = await asyncio.wait_for(client.health_check(), timeout=timeout)
        data = result.get("data") if isinstance(result, dict) else None
        if not isinstance(data, dict):
            data = {}
        if data.get("status") == "online":
            version = _text(data.get("version"))
            session_id = _text(data.get("session_id"))
            _record("online", version, session_id, None)
        else:
            detail = redact_text(str(data.get("detail") or "dsh health not online"))
            _record("offline", None, None, detail)
    except Exception as exc:
        _record("offline", None, None, redact_text(str(exc)))
    return get_dsh_health()


def get_dsh_health() -> Dict[str, Any]:
    """返回缓存快照的浅拷贝 + 派生 age_s；外部改返回值不会污染内部状态。"""
    state = dict(_STATE)
    checked_at = state.get("checked_at")
    state["age_s"] = None if checked_at is None else round(time.time() - checked_at, 1)
    return state


async def _probe_loop() -> None:
    while True:
        await probe_once()
        await asyncio.sleep(PROBE_INTERVAL_S)


def start_dsh_health_probe() -> asyncio.Task:
    """启动后台探针（幂等：已有存活任务时返回同一任务）。"""
    global _task
    if _task is None or _task.done():
        _task = asyncio.create_task(_probe_loop())
    return _task


async def stop_dsh_health_probe() -> None:
    """取消后台探针；从未启动时是 no-op。"""
    global _task
    task, _task = _task, None
    if task is None:
        return
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
