# -*- coding: utf-8 -*-
"""云睡眠录制 fixture（H5 睡眠归一测试共用）。

复刻架构 §3.6 云记录形状：``value`` 为 JSON 字符串，消费侧需二次 loads
（沿用既有 ``_cloud_record`` 包装约定）。所有时间按东八区（UTC+8）由可读
HH:MM 解析，便于与小米运动 App 的「入睡 / 清醒 / 睡眠时长」逐项对账。

录制样本：
  - 2026-10-20：主觉 351 min（深 88 / 浅 222 / REM 41 / 清醒 1，04:06 一次），
    另有 10:13 小睡 85 min 与 11:05 小睡 41 min。
  - 2026-10-27：主觉 360 min（深 120 / 浅 198 / REM 42），清醒 0 次 0 分钟。
"""
import json
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List

CST = timezone(timedelta(hours=8))


def cst_ts(date_str: str, hm: str) -> int:
    """东八区「YYYY-MM-DD HH:MM」-> epoch 秒。"""
    dt = datetime.strptime(f"{date_str} {hm}", "%Y-%m-%d %H:%M")
    return int(dt.replace(tzinfo=CST).timestamp())


def cloud_record(key: str, t: int, value: Any) -> dict:
    """架构 §3.6 云记录（value 为 JSON 字符串，测试侧二次 loads）。"""
    return {
        "sid": 1,
        "key": key,
        "time": t,
        "zone_offset": 28800,
        "zone_name": "Asia/Shanghai",
        "value": json.dumps(value, separators=(",", ":")),
        "update_time": t,
    }


def sleep_item(start: int, end: int, state: int) -> Dict[str, int]:
    """单条睡眠原始 item（绝对 epoch 秒 + 云端 state 码）。"""
    return {"start_time": int(start), "end_time": int(end), "state": int(state)}


def sleep_record(t: int, items: List[Dict[str, int]], session: Dict[str, Any]) -> dict:
    """云睡眠记录：session 为云端 value 的标量字段（原样保留，含 0）。

    items 单独传入以便逐段对账；scalars 键名与云端一致
    （bedtime / wake_up_time / duration / sleep_*_duration / awake_count）。
    """
    value = dict(session)
    value["items"] = [dict(item) for item in items]
    return cloud_record("sleep", t, value)


def raw_sleep_items(record: dict) -> List[Dict[str, int]]:
    """取回云记录里的原始 items（还原 JSON 字符串包装）。"""
    return json.loads(record["value"])["items"]


def main_sleep_20261020() -> dict:
    """10-20 主觉：351 min，深 88 / 浅 222 / REM 41 / 清醒 1（04:06）。"""
    date = "2026-10-20"
    items = [
        sleep_item(cst_ts(date, "01:10"), cst_ts(date, "02:38"), 2),  # deep 88
        sleep_item(cst_ts(date, "02:38"), cst_ts(date, "04:06"), 3),  # light 88
        sleep_item(cst_ts(date, "04:06"), cst_ts(date, "04:07"), 5),  # awake 1
        sleep_item(cst_ts(date, "04:07"), cst_ts(date, "04:48"), 4),  # rem 41
        sleep_item(cst_ts(date, "04:48"), cst_ts(date, "07:02"), 3),  # light 134
    ]
    session = {
        "bedtime": cst_ts(date, "01:10"),
        "wake_up_time": cst_ts(date, "07:02"),
        "duration": 351,
        "sleep_deep_duration": 88,
        "sleep_light_duration": 222,
        "sleep_rem_duration": 41,
        "sleep_awake_duration": 1,
        "awake_count": 1,
    }
    return sleep_record(cst_ts(date, "07:02"), items, session)


def nap_sleep_20261020_1013() -> dict:
    """10-20 小睡：10:13 醒，85 min（深 20 / 浅 50 / REM 15）。"""
    date = "2026-10-20"
    items = [
        sleep_item(cst_ts(date, "08:48"), cst_ts(date, "09:08"), 2),
        sleep_item(cst_ts(date, "09:08"), cst_ts(date, "09:58"), 3),
        sleep_item(cst_ts(date, "09:58"), cst_ts(date, "10:13"), 4),
    ]
    session = {
        "bedtime": cst_ts(date, "08:48"),
        "wake_up_time": cst_ts(date, "10:13"),
        "duration": 85,
        "sleep_deep_duration": 20,
        "sleep_light_duration": 50,
        "sleep_rem_duration": 15,
        "sleep_awake_duration": 0,
        "awake_count": 0,
    }
    return sleep_record(cst_ts(date, "10:13"), items, session)


def nap_sleep_20261020_1105() -> dict:
    """10-20 小睡：11:05 醒，41 min（深 5 / 浅 30 / REM 6）。"""
    date = "2026-10-20"
    items = [
        sleep_item(cst_ts(date, "10:24"), cst_ts(date, "10:29"), 2),
        sleep_item(cst_ts(date, "10:29"), cst_ts(date, "10:59"), 3),
        sleep_item(cst_ts(date, "10:59"), cst_ts(date, "11:05"), 4),
    ]
    session = {
        "bedtime": cst_ts(date, "10:24"),
        "wake_up_time": cst_ts(date, "11:05"),
        "duration": 41,
        "sleep_deep_duration": 5,
        "sleep_light_duration": 30,
        "sleep_rem_duration": 6,
        "sleep_awake_duration": 0,
        "awake_count": 0,
    }
    return sleep_record(cst_ts(date, "11:05"), items, session)


def sleep_records_20261020() -> List[dict]:
    """10-20 同一归日组的三条睡眠（主觉 + 两段小睡）。"""
    return [
        main_sleep_20261020(),
        nap_sleep_20261020_1013(),
        nap_sleep_20261020_1105(),
    ]


def main_sleep_20261027() -> dict:
    """10-27 主觉：360 min，深 120 / 浅 198 / REM 42，清醒 0 次 0 分钟。"""
    date = "2026-10-27"
    items = [
        sleep_item(cst_ts(date, "00:32"), cst_ts(date, "02:32"), 2),  # deep 120
        sleep_item(cst_ts(date, "02:32"), cst_ts(date, "05:50"), 3),  # light 198
        sleep_item(cst_ts(date, "05:50"), cst_ts(date, "06:32"), 4),  # rem 42
    ]
    session = {
        "bedtime": cst_ts(date, "00:32"),
        "wake_up_time": cst_ts(date, "06:32"),
        "duration": 360,
        "sleep_deep_duration": 120,
        "sleep_light_duration": 198,
        "sleep_rem_duration": 42,
        "sleep_awake_duration": 0,
        "awake_count": 0,
    }
    return sleep_record(cst_ts(date, "06:32"), items, session)


def state_map_record() -> dict:
    """2/3/4/5 各 30 min 的状态映射样本（duration 取原始值 120）。"""
    base = cst_ts("2030-01-01", "00:00")
    items = [
        sleep_item(base + idx * 1800, base + (idx + 1) * 1800, state)
        for idx, state in enumerate([2, 3, 4, 5])
    ]
    session = {
        "bedtime": base,
        "wake_up_time": base + 4 * 1800,
        "duration": 120,
        "sleep_deep_duration": 30,
        "sleep_light_duration": 30,
        "sleep_rem_duration": 30,
        "sleep_awake_duration": 30,
        "awake_count": 1,
    }
    return sleep_record(base + 4 * 1800, items, session)


def raw_zero_totals_record() -> dict:
    """原始合计含 0：duration 300 / deep 100 / light 200 / rem 0 / awake 0。

    items 故意给出相反的 30 min REM 与 2 min 清醒，用于证明原始字段优先且
    0 值不被 ``or None`` 吞掉。
    """
    base = cst_ts("2030-01-01", "00:00")
    items = [
        sleep_item(base, base + 6000, 2),       # deep 100
        sleep_item(base + 6000, base + 18000, 3),  # light 200
        sleep_item(base + 18000, base + 19800, 4),  # rem 30
        sleep_item(base + 19800, base + 19920, 5),  # awake 2
    ]
    session = {
        "bedtime": base,
        "wake_up_time": base + 19920,
        "duration": 300,
        "sleep_deep_duration": 100,
        "sleep_light_duration": 200,
        "sleep_rem_duration": 0,
        "sleep_awake_duration": 0,
        "awake_count": 0,
    }
    return sleep_record(base + 19920, items, session)
