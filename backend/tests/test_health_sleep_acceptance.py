# -*- coding: utf-8 -*-
"""T5 跨层验收：小米云睡眠 normalize -> HealthStore 分片 -> 派生视图。

全部基于录制 fixture：无网络、不依赖当前时钟、只写 pytest tmp_path。
断言口径对齐小米运动 App 当日睡眠页（时长 / 入睡 / 清醒 / 深睡 / 浅睡 / REM /
清醒次数），并锁定派生视图的 stages 转换与 items 原样保留。
"""
from datetime import datetime, timedelta, timezone

import pytest

from services.health.sources.cloud_pull import CloudPullSource
from services.health.store import HealthStore
from tests.health_sleep_fixtures import (
    cloud_record,
    cst_ts,
    main_sleep_20261027,
    raw_sleep_items,
    sleep_item,
    sleep_records_20261020,
)

TEST_USER_ID = "Axeuh"
CLOUD_USER_ID = "test-cloud-user"
CLOUD_DEVICE_ID = "cloud:test-cloud-user"

# 东八区（与 cloud_pull fixture / HealthStore 派生视图同一口径）
_CST = timezone(timedelta(hours=8))


@pytest.fixture(autouse=True)
def _no_device_registry_writes(monkeypatch):
    """normalize 内部会自动注册云设备；验收测试改为 no-op，杜绝侧写。"""
    import services.health.devices as devices_mod

    monkeypatch.setattr(devices_mod, "register", lambda *args, **kwargs: None)


def _write(store, records, date):
    """云记录 -> CloudPullSource.normalize -> store.write，返回批次。"""
    source = CloudPullSource(user_id=CLOUD_USER_ID, pass_token="fixture-token")
    batch = source.normalize({
        "date": date,
        "records": records,
        "user_id": TEST_USER_ID,
        "device_id": CLOUD_DEVICE_ID,
    })
    store.write(batch)
    return batch


def _read_sleep(store, date):
    """读回 cloud 分片并返回其睡眠汇总。"""
    batch = store.read(TEST_USER_ID, date, "cloud")
    assert batch is not None, f"{date} 云分片未写入"
    assert batch.sleep is not None, f"{date} 云分片缺少 sleep_data"
    return batch.sleep


def _stage_sums(sleep):
    """按 canonical 枚举累计顶层阶段段时长。"""
    sums = {"deep": 0, "light": 0, "rem": 0, "awake": 0, "unknown": 0}
    for seg in sleep.segments:
        sums[seg.stage] = sums.get(seg.stage, 0) + seg.duration_min
    return sums


def _hm(ts):
    """epoch 秒 -> 东八区 HH:MM（派生视图 stages 的 t 字段口径）。"""
    return datetime.fromtimestamp(ts, _CST).strftime("%H:%M")


def test_10_20_cloud_write_read_app_values(tmp_path):
    """10-20 主觉 + 两段小睡：顶层镜像主觉，会话全保留，视图转换正确。"""
    date = "2026-10-20"
    records = sleep_records_20261020()
    store = HealthStore(str(tmp_path))

    _write(store, records, date)
    sleep = _read_sleep(store, date)

    # 小米运动 App 当日睡眠页逐项对账（主觉 351 min）
    assert sleep.duration_min == 351
    assert sleep.deep_min == 88
    assert sleep.light_min == 222
    assert sleep.rem_min == 41
    assert sleep.awake_min == 1
    assert sleep.awake_count == 1
    assert sleep.wakeup_time == cst_ts(date, "07:02")
    assert sleep.bedtime == cst_ts(date, "01:10")

    sessions = sleep.sleep_sessions
    assert len(sessions) == 3, f"三条睡眠记录应各存一个会话，实际 {len(sessions)}"
    assert [s.duration for s in sessions] == [351, 85, 41], (
        f"会话时长/顺序错误: {[s.duration for s in sessions]}"
    )

    sums = _stage_sums(sleep)
    assert (sums["deep"], sums["light"], sums["rem"], sums["awake"]) == (
        88, 222, 41, 1,
    ), f"canonical 阶段合计错误: {sums}"
    assert sleep.duration_min == (
        sleep.deep_min + sleep.light_min + sleep.rem_min
    ), "duration_min 应等于 deep+light+rem（不含 awake）"

    view = store.read_view(TEST_USER_ID, date)
    assert view is not None
    sd = view["sleep_data"]
    stages = sd["sleep_sessions"][0]["stages"]
    assert stages, "派生视图主觉会话 stages 为空"
    assert all(
        "t" in entry and "stage" in entry for entry in stages
    ), f"派生视图 stages 形状错误: {stages}"
    assert stages[0] == {"t": _hm(cst_ts(date, "01:10")), "stage": "deep"}
    assert sd["sleep_sessions"][0]["items"] == raw_sleep_items(records[0]), (
        "派生视图应原样保留云 items"
    )


def test_10_27_cloud_write_read_app_values(tmp_path):
    """10-27 主觉 360 min、清醒 0：零值保真，且不产生 awake 段/state=5 item。"""
    date = "2026-10-27"
    record = main_sleep_20261027()
    store = HealthStore(str(tmp_path))

    _write(store, [record], date)
    sleep = _read_sleep(store, date)

    assert sleep.duration_min == 360
    assert sleep.deep_min == 120
    assert sleep.light_min == 198
    assert sleep.rem_min == 42
    assert sleep.wakeup_time == cst_ts(date, "06:32")
    assert sleep.bedtime == cst_ts(date, "00:32")

    # 零值必须是整数 0，绝不是 None（or None 吞值回归锁）
    assert sleep.awake_min is not None and sleep.awake_min == 0
    assert sleep.awake_count is not None and sleep.awake_count == 0
    assert type(sleep.awake_min) is int
    assert type(sleep.awake_count) is int

    sessions = sleep.sleep_sessions
    assert len(sessions) == 1
    assert sessions[0].items == raw_sleep_items(record)

    sums = _stage_sums(sleep)
    assert (sums["deep"], sums["light"], sums["rem"], sums["awake"]) == (
        120, 198, 42, 0,
    ), f"canonical 阶段合计错误: {sums}"
    assert sleep.duration_min == (
        sleep.deep_min + sleep.light_min + sleep.rem_min
    ), "duration_min 应等于 deep+light+rem（不含 awake）"

    assert all(seg.stage != "awake" for seg in sleep.segments), (
        f"10-27 无清醒段却出现 awake: {[seg.to_dict() for seg in sleep.segments]}"
    )
    assert all(item["state"] != 5 for item in sessions[0].items), (
        f"10-27 原始 items 不应含 state=5: {sessions[0].items}"
    )


def test_10_26_main_not_nap(tmp_path):
    """10-26 主觉 + 午后小睡同批写入：顶层取主觉，小睡不得反吞主觉。"""
    date = "2026-10-26"
    main_items = [
        sleep_item(cst_ts(date, "01:32"), cst_ts(date, "03:05"), 2),
        sleep_item(cst_ts(date, "03:05"), cst_ts(date, "05:16"), 3),
        sleep_item(cst_ts(date, "05:16"), cst_ts(date, "06:29"), 4),
        sleep_item(cst_ts(date, "06:29"), cst_ts(date, "06:31"), 5),
    ]
    main_value = {
        "bedtime": cst_ts(date, "01:32"),
        "wake_up_time": cst_ts(date, "06:31"),
        "duration": 297,
        "sleep_deep_duration": 93,
        "sleep_light_duration": 131,
        "sleep_rem_duration": 73,
        "sleep_awake_duration": 2,
        "awake_count": 1,
        "items": main_items,
    }
    nap_items = [
        sleep_item(cst_ts(date, "13:14"), cst_ts(date, "13:24"), 2),
        sleep_item(cst_ts(date, "13:24"), cst_ts(date, "14:44"), 3),
        sleep_item(cst_ts(date, "14:44"), cst_ts(date, "15:03"), 4),
    ]
    nap_value = {
        "bedtime": cst_ts(date, "13:14"),
        "wake_up_time": cst_ts(date, "15:03"),
        "duration": 109,
        "sleep_deep_duration": 10,
        "sleep_light_duration": 80,
        "sleep_rem_duration": 19,
        "sleep_awake_duration": 0,
        "awake_count": 0,
        "items": nap_items,
    }
    records = [
        cloud_record("sleep", cst_ts(date, "06:31"), main_value),
        cloud_record("sleep", cst_ts(date, "15:03"), nap_value),
    ]

    store = HealthStore(str(tmp_path))
    _write(store, records, date)
    sleep = _read_sleep(store, date)

    assert (
        sleep.duration_min, sleep.deep_min, sleep.light_min,
        sleep.rem_min, sleep.awake_min, sleep.awake_count,
    ) == (297, 93, 131, 73, 2, 1), "顶层字段应镜像主觉而非小睡"
    assert sleep.wakeup_time == cst_ts(date, "06:31")
    assert sleep.bedtime == cst_ts(date, "01:32")

    sessions = sleep.sleep_sessions
    assert len(sessions) == 2
    assert [s.duration for s in sessions] == [297, 109]

    sums = _stage_sums(sleep)
    assert (sums["deep"], sums["light"], sums["rem"], sums["awake"]) == (
        93, 131, 73, 2,
    ), f"canonical 阶段合计错误: {sums}"
    assert sleep.duration_min == (
        sleep.deep_min + sleep.light_min + sleep.rem_min
    ), "duration_min 应等于 deep+light+rem（不含 awake）"

    # 小睡原始 0 值同样必须保真为整数 0
    nap = sessions[1]
    assert nap.duration == 109
    assert nap.awake is not None and nap.awake == 0
    assert nap.awake_count is not None and nap.awake_count == 0
    assert type(nap.awake) is int
    assert type(nap.awake_count) is int
