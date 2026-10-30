"""PC 感知上报健康采集：从每日 perception.jsonl 读取 pc_sensor 事件。

独立成模块只为控制单文件体积；对外入口由 services.source_health 包装。
"""

import json
import os
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional, Tuple

from config.config import get_config

CST = timezone(timedelta(hours=8))
PC_FRESH_S = 10 * 60
PC_LOOKBACK_DAYS = 7


def _iso(ts: Optional[float]) -> Optional[str]:
    if ts is None:
        return None
    return datetime.fromtimestamp(float(ts), CST).isoformat(timespec="seconds")


def _now() -> datetime:
    return datetime.now(CST)


def _row(status: str, last_sync: Optional[str] = None,
         records: Optional[int] = None, detail: str = "") -> Dict[str, Any]:
    return {
        "id": "pc_sensor",
        "name": "PC 感知采集",
        "status": status,
        "last_sync": last_sync,
        "records": records,
        "detail": detail,
    }


def _event_ts(obj: Dict[str, Any], day: str) -> Optional[float]:
    raw = obj.get("t_iso")
    if isinstance(raw, str):
        try:
            dt = datetime.fromisoformat(raw)
        except ValueError:
            dt = None
        if dt is not None:
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=CST)
            return dt.timestamp()
    raw = obj.get("ts")
    if isinstance(raw, (int, float)) and raw > 0:
        return float(raw) / 1000.0 if raw > 1e11 else float(raw)
    raw = obj.get("t")
    if isinstance(raw, str):
        try:
            dt = datetime.strptime(f"{day} {raw}", "%Y-%m-%d %H:%M:%S")
        except ValueError:
            return None
        return dt.replace(tzinfo=CST).timestamp()
    return None


def _scan_shard(path: str, day: str) -> Tuple[int, Optional[float]]:
    count = 0
    last: Optional[float] = None
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            if "_source" not in line or "pc_sensor" not in line:
                continue
            try:
                obj = json.loads(line)
            except (json.JSONDecodeError, TypeError):
                continue
            if not isinstance(obj, dict) or obj.get("_source") != "pc_sensor":
                continue
            count += 1
            ts = _event_ts(obj, day)
            if ts is not None and (last is None or ts > last):
                last = ts
    return count, last


def collect_pc_sensor(data_dir: Optional[str] = None) -> Dict[str, Any]:
    root = os.path.join(data_dir or get_config().DATA_DIR, "daily")
    today = _now().date()
    for offset in range(PC_LOOKBACK_DAYS):
        day = (today - timedelta(days=offset)).isoformat()
        path = os.path.join(root, day, "perception.jsonl")
        if not os.path.isfile(path):
            continue
        count, last = _scan_shard(path, day)
        if count == 0:
            continue
        if last is None:
            last = os.path.getmtime(path)
        if time.time() - last <= PC_FRESH_S:
            return _row("ok", _iso(last), count,
                        f"分片 {day} 最近 10 分钟内有 PC 上报")
        return _row("stale", _iso(last), count,
                    f"分片 {day} 最后 PC 上报已超过 10 分钟")
    return _row("offline", detail="近 7 天未发现 PC 采集上报")
