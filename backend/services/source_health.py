"""数据源健康采集（GET /api/sources/health 的实现层）。

每个采集器返回 {id,name,status,last_sync,records,detail}，状态只依据
本地可验证的事实：分片文件、服务状态机、进程内连接表。无法确定的
来源返回 unknown 与短说明，绝不编造 records/last_sync。
"""

import json
import logging
import os
import re
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from config.config import get_config
from services.health_cloud_service import get_health_cloud_service
from services.loom_health import get_loom_health
from services.source_health_pc import collect_pc_sensor as _collect_pc_sensor

logger = logging.getLogger(__name__)

CST = timezone(timedelta(hours=8))
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
CACHE_TTL_S = 5.0
PHONE_FRESH_S = 6 * 3600
FILES_FRESH_S = 10 * 60
LOOM_PROBE_FRESH_S = 60

_NAMES = {
    "phone_health": "手机健康数据",
    "mi_cloud": "小米健康云",
    "pc_sensor": "PC 感知采集",
    "realtime": "实时事件流",
    "loom": "Loom AI 后端",
    "files": "每日感知文件",
}

_cache_lock = threading.Lock()
_cache: Dict[str, Tuple[float, Dict[str, Any]]] = {}


def reset_cache() -> None:
    with _cache_lock:
        _cache.clear()


def _now() -> datetime:
    return datetime.now(CST)


def _iso(ts: Optional[float]) -> Optional[str]:
    if ts is None:
        return None
    return datetime.fromtimestamp(float(ts), CST).isoformat(timespec="seconds")


def _row(source_id: str, status: str, last_sync: Optional[str] = None,
         records: Optional[int] = None, detail: str = "") -> Dict[str, Any]:
    return {
        "id": source_id,
        "name": _NAMES[source_id],
        "status": status,
        "last_sync": last_sync,
        "records": records,
        "detail": detail,
    }


def _safe(source_id: str, collector) -> Dict[str, Any]:
    try:
        return collector()
    except Exception as exc:
        logger.warning("[Sources] %s 采集失败: %s", source_id, exc)
        return _row(source_id, "unknown", detail="检查失败，无法确定状态")


def _data_dir() -> str:
    return get_config().DATA_DIR


def _find_latest_shard(user_id: str, source: str) -> Tuple[Optional[str], Optional[str]]:
    root = os.path.join(_data_dir(), "users", user_id, "health")
    try:
        dates = sorted(os.listdir(root), reverse=True)
    except OSError:
        return None, None
    for date in dates:
        if not _DATE_RE.match(date):
            continue
        path = os.path.join(root, date, f"{source}.json")
        if os.path.isfile(path):
            return date, path
    return None, None


def _read_records(path: str) -> Optional[int]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None
    samples = data.get("samples") if isinstance(data, dict) else None
    if not isinstance(samples, list):
        return 0
    return len(samples)


def collect_phone_health(user_id: str) -> Dict[str, Any]:
    date, path = _find_latest_shard(user_id, "phone")
    if path is None:
        return _row("phone_health", "offline", detail="未发现手机健康分片")
    ts = os.path.getmtime(path)
    records = _read_records(path)
    if records is None:
        return _row("phone_health", "degraded", _iso(ts), None,
                    f"手机健康分片 {date} 解析失败")
    if time.time() - ts <= PHONE_FRESH_S:
        return _row("phone_health", "ok", _iso(ts), records,
                    f"分片 {date} 最近 6 小时内有写入")
    return _row("phone_health", "stale", _iso(ts), records,
                f"分片 {date} 最后写入已超过 6 小时")


def collect_mi_cloud(user_id: str) -> Dict[str, Any]:
    status = get_health_cloud_service().status(probe=False)
    cfg = get_config()
    primary = getattr(cfg, "HEALTH_PRIMARY_USER", "") or user_id
    date, path = _find_latest_shard(primary, "cloud")
    records = _read_records(path) if path else None
    last_success = status.get("last_success")
    if isinstance(last_success, (int, float)) and last_success > 0:
        last_ts: Optional[float] = float(last_success)
    elif path:
        last_ts = os.path.getmtime(path)
    else:
        last_ts = None
    last_sync = _iso(last_ts)
    phase = status.get("phase")
    if phase == "disabled":
        return _row("mi_cloud", "offline", last_sync, records, "小米云同步已禁用")
    if phase == "unconfigured":
        return _row("mi_cloud", "offline", last_sync, records, "小米云未配置凭据")
    if phase == "auth_expired":
        return _row("mi_cloud", "degraded", last_sync, records, "小米云登录凭据已过期")
    if phase == "error":
        error = str(status.get("last_error") or "未知错误")[:120]
        return _row("mi_cloud", "degraded", last_sync, records, f"小米云同步异常: {error}")
    if phase == "syncing":
        return _row("mi_cloud", "degraded", last_sync, records, "小米云正在同步")
    if phase != "ok":
        return _row("mi_cloud", "unknown", last_sync, records,
                    f"小米云状态未知: {phase or '空'}")
    if last_ts is None:
        return _row("mi_cloud", "unknown", None, records, "尚无成功同步记录")
    poll = status.get("poll_interval_min") or getattr(
        cfg, "HEALTH_CLOUD_POLL_INTERVAL_MIN", 30)
    try:
        poll = int(poll)
    except (TypeError, ValueError):
        poll = 30
    grace = max(2 * poll * 60 + 600, 3600)
    if time.time() - last_ts <= grace:
        return _row("mi_cloud", "ok", last_sync, records, "最近一次同步成功")
    return _row("mi_cloud", "stale", last_sync, records,
                f"最后成功同步已超过 {grace // 60} 分钟")


def collect_pc_sensor() -> Dict[str, Any]:
    return _collect_pc_sensor(_data_dir())


def _sse_connected() -> bool:
    from routers.events import get_event_hub
    return any(
        get_event_hub(backend).has_subscribers
        for backend in ("loom", "opencode")
    )


def collect_realtime() -> Dict[str, Any]:
    connected = _sse_connected()
    if connected:
        return _row("realtime", "ok", detail="SSE 事件流有活跃订阅")
    return _row("realtime", "offline", detail="当前无 SSE 订阅连接")


def collect_loom() -> Dict[str, Any]:
    state = get_loom_health()
    checked = state.get("checked_at")
    last_ts = float(checked) if isinstance(checked, (int, float)) else None
    last_sync = _iso(last_ts)
    raw = state.get("status")
    version = state.get("version") or ""
    if raw == "online":
        if last_ts is not None and time.time() - last_ts > LOOM_PROBE_FRESH_S:
            return _row("loom", "stale", last_sync, None,
                        "Loom 健康探针已超过 60 秒未更新")
        detail = f"Loom 在线（版本 {version}）" if version else "Loom 在线"
        return _row("loom", "ok", last_sync, None, detail)
    if raw == "offline":
        return _row("loom", "offline", last_sync, None, "Loom 健康探测为离线")
    return _row("loom", "unknown", last_sync, None, "尚未完成 Loom 健康探测")


def _latest_daily_shard() -> Tuple[Optional[str], Optional[str]]:
    root = os.path.join(_data_dir(), "daily")
    try:
        dates = sorted(os.listdir(root), reverse=True)
    except OSError:
        return None, None
    for date in dates:
        if not _DATE_RE.match(date):
            continue
        path = os.path.join(root, date, "perception.jsonl")
        if os.path.isfile(path):
            return date, path
    return None, None


def _count_lines(path: str) -> int:
    with open(path, "rb") as f:
        return sum(1 for _ in f)


def collect_files() -> Dict[str, Any]:
    date, path = _latest_daily_shard()
    if path is None:
        return _row("files", "offline", detail="未发现每日感知分片")
    ts = os.path.getmtime(path)
    records = _count_lines(path)
    if date != _now().date().isoformat():
        return _row("files", "stale", _iso(ts), records,
                    f"最新感知分片为 {date}，不是今日")
    if time.time() - ts <= FILES_FRESH_S:
        return _row("files", "ok", _iso(ts), records, "今日分片最近 10 分钟内有写入")
    return _row("files", "stale", _iso(ts), records,
                "今日分片最后写入已超过 10 分钟")


def collect_all(user_id: str) -> Dict[str, Any]:
    now = time.time()
    with _cache_lock:
        cached = _cache.get(user_id)
        if cached is not None and cached[0] > now:
            return cached[1]
    sources: List[Dict[str, Any]] = [
        _safe("phone_health", lambda: collect_phone_health(user_id)),
        _safe("mi_cloud", lambda: collect_mi_cloud(user_id)),
        _safe("pc_sensor", collect_pc_sensor),
        _safe("realtime", collect_realtime),
        _safe("loom", collect_loom),
        _safe("files", collect_files),
    ]
    payload = {
        "generated_at": _now().isoformat(timespec="seconds"),
        "sources": sources,
    }
    with _cache_lock:
        _cache[user_id] = (now + CACHE_TTL_S, payload)
    return payload
