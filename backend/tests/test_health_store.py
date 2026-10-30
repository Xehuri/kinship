# -*- coding: utf-8 -*-
"""
HealthStore 分片存储单元测试（H1 暗接入，TDD）。

依据 health-data-source-architecture.md 第 12 节 H1 验收 + 第 13 节风险 6：
  1. 往返读写：write -> 分片文件存在 -> read 深相等
  2. 同日双源：phone + cloud 分片互不覆盖
  3. device label 保护：新批不带 label 时保留已存 label
     （反例为 health_storage.py:162 的"不传即清空"缺陷；本测试不修改该文件）
  4. 同 t 样本：后写覆盖先写（批内 + 跨批）
  5. 并发写：8 线程 x 5 次写同 (user,date)，最终文件为合法 JSON 且含最后写入标记
  6. 原子写：写后分片目录无 *.tmp 残留
  7. 派生兼容视图：export_legacy 产出与 health_storage.save_health_data 相同的顶层键
  8. 路径校验：非法 user_id/date/source 抛 ValueError

所有文件系统访问均通过 pytest 的 tmp_path 作为 data_root，
绝不写入真实 ai/data/ 目录。
"""
import json
import os
import threading
from datetime import datetime, timedelta, timezone
from typing import Optional

import pytest

from services.health.models import (
    DailySummary,
    DeviceRef,
    HealthBatch,
    HealthSample,
    SleepData,
    SleepSegment,
    SleepSession,
)
from services.health.paths import legacy_path, shard_path
from services.health.store import HealthStore

# 固定测试日期（YYYY-MM-DD）
DATE = "2026-09-22"

# 东八区（与 HealthStore 的视图时间转换口径一致）
_CST = timezone(timedelta(hours=8))

# 睡眠会话合并用例的固定时间戳（互不重叠的主觉/小睡）
MAIN_BEDTIME = 1790030400
MAIN_WAKEUP = 1790051460          # 主觉 351 min
NAP_BEDTIME = 1790055960
NAP_WAKEUP = 1790061060           # 小睡 85 min
REPULL_MAIN_WAKEUP = 1790048220   # 主觉 297 min
REPULL_NAP_WAKEUP = 1790062500    # 小睡 109 min


def _make_batch(source_id="phone", user_id="u1", label: Optional[str] = "PhoneA",
                samples=None, daily=None, sleep=None, battery=None,
                fetched_at=1790050000):
    """构造一个最小可用的 HealthBatch。"""
    return HealthBatch(
        source_id=source_id,
        user_id=user_id,
        device=DeviceRef(
            device_id="dev-1",
            label=label,
            kind="phone",
            owner_user_id=user_id,
            source_id=source_id,
        ),
        date=DATE,
        samples=samples if samples is not None else [
            HealthSample(t=1790032200, hr=70, steps=10),
            HealthSample(t=1790032260, hr=72, steps=20),
            HealthSample(t=1790032320, hr=68, steps=30),
        ],
        daily_summary=daily,
        sleep=sleep,
        battery=battery or [],
        fetched_at=fetched_at,
    )


class TestRoundtrip:
    """用例 1：write 后分片文件存在，read 深相等。"""

    def test_write_then_read_deep_equal(self, tmp_path):
        store = HealthStore(str(tmp_path))
        batch = _make_batch(
            daily=DailySummary(total_steps=60, hr_resting=58),
            sleep=SleepData(
                duration_min=420,
                deep_min=100,
                light_min=180,
                rem_min=90,
                awake_min=50,
                wakeup_time=1790046000,
                segments=[
                    SleepSegment(start_ts=1790030400, stage="light", duration_min=60),
                    SleepSegment(start_ts=1790034000, stage="deep", duration_min=90),
                ],
            ),
            battery=[{"t": 1790032200, "level": 88}],
        )
        store.write(batch)

        expected = os.path.join(
            str(tmp_path), "users", "u1", "health", DATE, "phone.json"
        )
        assert os.path.exists(expected), f"分片文件未生成: {expected}"

        got = store.read("u1", DATE, "phone")
        assert got is not None
        assert got == batch

    def test_read_missing_returns_none(self, tmp_path):
        store = HealthStore(str(tmp_path))
        assert store.read("u1", DATE, "phone") is None


class TestTwoSources:
    """用例 2：同日 phone + cloud 两个分片互不覆盖。"""

    def test_both_sources_coexist(self, tmp_path):
        store = HealthStore(str(tmp_path))
        phone_batch = _make_batch(
            source_id="phone",
            samples=[HealthSample(t=1790032200, hr=71, steps=5)],
        )
        cloud_batch = _make_batch(
            source_id="cloud",
            samples=[HealthSample(t=1790032200, hr=99, spo2=97)],
        )
        store.write(phone_batch)
        store.write(cloud_batch)

        phone_path = os.path.join(
            str(tmp_path), "users", "u1", "health", DATE, "phone.json"
        )
        cloud_path = os.path.join(
            str(tmp_path), "users", "u1", "health", DATE, "cloud.json"
        )
        assert os.path.exists(phone_path)
        assert os.path.exists(cloud_path)

        # 两个分片内容各自独立，互不污染
        with open(phone_path, encoding="utf-8") as f:
            phone_raw = json.load(f)
        with open(cloud_path, encoding="utf-8") as f:
            cloud_raw = json.load(f)
        assert phone_raw["source"] == "phone"
        assert phone_raw["samples"][0]["hr"] == 71
        assert cloud_raw["source"] == "cloud"
        assert cloud_raw["samples"][0]["hr"] == 99

        assert store.read("u1", DATE, "phone") == phone_batch
        assert store.read("u1", DATE, "cloud") == cloud_batch


class TestDeviceLabelPreserve:
    """用例 3：label 为空的写入保留已存 label（风险 6，不修改 health_storage.py）。"""

    def test_none_label_preserves_existing(self, tmp_path):
        store = HealthStore(str(tmp_path))
        store.write(_make_batch(label="PhoneA"))
        # 第二批 label=None，同 user/date/source
        store.write(_make_batch(label=None, samples=[
            HealthSample(t=1790032440, hr=75, steps=7),
        ]))

        got = store.read("u1", DATE, "phone")
        assert got is not None
        assert got.device.label == "PhoneA"

    def test_explicit_label_updates(self, tmp_path):
        # 反向保证：显式给了新 label 应当更新，而不是永远冻结
        store = HealthStore(str(tmp_path))
        store.write(_make_batch(label="PhoneA"))
        store.write(_make_batch(label="PhoneB", samples=[
            HealthSample(t=1790032440, hr=75, steps=7),
        ]))

        got = store.read("u1", DATE, "phone")
        assert got is not None
        assert got.device.label == "PhoneB"


class TestSameTSampleReplace:
    """用例 4：同 t 样本后写覆盖先写（与 health_storage.py:141-144 语义一致）。"""

    def test_same_t_within_batch_last_wins(self, tmp_path):
        store = HealthStore(str(tmp_path))
        batch = _make_batch(samples=[
            HealthSample(t=100, hr=70),
            HealthSample(t=100, hr=99),
        ])
        store.write(batch)

        got = store.read("u1", DATE, "phone")
        assert got is not None
        assert len(got.samples) == 1
        assert got.samples[0].hr == 99

    def test_same_t_across_batches_last_wins(self, tmp_path):
        store = HealthStore(str(tmp_path))
        store.write(_make_batch(samples=[HealthSample(t=100, hr=70)]))
        store.write(_make_batch(samples=[HealthSample(t=100, hr=88)]))

        got = store.read("u1", DATE, "phone")
        assert got is not None
        assert len(got.samples) == 1
        assert got.samples[0].hr == 88

    def test_different_t_accumulates(self, tmp_path):
        store = HealthStore(str(tmp_path))
        store.write(_make_batch(samples=[HealthSample(t=100, hr=70)]))
        store.write(_make_batch(samples=[HealthSample(t=200, hr=71)]))

        got = store.read("u1", DATE, "phone")
        assert got is not None
        assert [s.t for s in got.samples] == [100, 200]


class TestConcurrency:
    """用例 5：8 线程 x 5 写同 (user,date)，文件为合法 JSON 且含最后写入标记。"""

    def test_concurrent_writes_yield_valid_json(self, tmp_path):
        store = HealthStore(str(tmp_path))
        n_workers = 8
        n_writes = 5
        # 每个 worker 用独立 t 段，最后一个 worker 的最后一个样本作为标记
        marker_t = 900000
        errors = []

        def worker(wid):
            try:
                for i in range(n_writes):
                    store.write(_make_batch(samples=[
                        HealthSample(t=1000 + wid * 100 + i, hr=60 + wid),
                    ]))
                # 最后一个 worker 额外写一个可识别的标记样本
                if wid == n_workers - 1:
                    store.write(_make_batch(samples=[
                        HealthSample(t=marker_t, hr=123),
                    ]))
            except Exception as exc:  # noqa: BLE001 - 收集线程异常
                errors.append(exc)

        threads = [
            threading.Thread(target=worker, args=(w,))
            for w in range(n_workers)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors, f"并发写入出现异常: {errors}"

        shard = os.path.join(
            str(tmp_path), "users", "u1", "health", DATE, "phone.json"
        )
        with open(shard, encoding="utf-8") as f:
            data = json.load(f)  # 必须是合法 JSON
        assert isinstance(data, dict)
        # 含最后 worker 的标记样本
        assert any(s["t"] == marker_t and s["hr"] == 123 for s in data["samples"])
        # 锁串行下所有不同 t 的样本都应保留（不丢写）
        expected_ts = {1000 + w * 100 + i for w in range(n_workers) for i in range(n_writes)}
        expected_ts.add(marker_t)
        assert expected_ts.issubset({s["t"] for s in data["samples"]})


class TestAtomicity:
    """用例 6：写入完成后分片目录无 *.tmp 残留。"""

    def test_no_tmp_files_remain(self, tmp_path):
        store = HealthStore(str(tmp_path))
        store.write(_make_batch())
        # 再写一次覆盖，确保替换路径也干净
        store.write(_make_batch(samples=[HealthSample(t=1790032200, hr=77)]))

        shard_dir = os.path.join(str(tmp_path), "users", "u1", "health", DATE)
        leftovers = [n for n in os.listdir(shard_dir) if n.endswith(".tmp")]
        assert leftovers == [], f"残留临时文件: {leftovers}"


class TestExportLegacy:
    """用例 7：export_legacy 产出与 health_storage.save_health_data 相同的顶层键。"""

    def test_legacy_keys_match_current_schema(self, tmp_path):
        store = HealthStore(str(tmp_path))
        batch = _make_batch(
            daily=DailySummary(total_steps=60, hr_resting=58, stress_avg=30),
            sleep=SleepData(
                duration_min=420,
                deep_min=100,
                light_min=180,
                rem_min=90,
                awake_min=50,
                wakeup_time=1790046000,
                segments=[
                    SleepSegment(start_ts=1790030400, stage="light", duration_min=60),
                ],
            ),
        )
        store.write(batch)
        out = store.export_legacy("u1", DATE)

        expected = os.path.join(str(tmp_path), "daily", DATE, "health.json")
        assert out == expected
        assert os.path.exists(expected)

        with open(expected, encoding="utf-8") as f:
            legacy = json.load(f)

        # 顶层键与 health_storage.save_health_data 写出的结构一致
        # （date / updated_at / samples / daily_summary / sleep_data / device_name）
        assert set(legacy.keys()) == {
            "date", "updated_at", "samples", "daily_summary",
            "sleep_data", "device_name",
        }
        assert legacy["date"] == DATE
        assert isinstance(legacy["updated_at"], str)
        assert isinstance(legacy["samples"], list)
        assert len(legacy["samples"]) == 3
        # legacy 样本含 t_iso（save_health_data 给每个样本补 t_iso）
        assert all("t" in s and "t_iso" in s for s in legacy["samples"])
        # daily_summary 含 total_steps（步数 = 增量求和，非末值）
        assert legacy["daily_summary"]["total_steps"] == 60
        # sleep_data 为 dict 且含 duration_min
        assert isinstance(legacy["sleep_data"], dict)
        assert legacy["sleep_data"]["duration_min"] == 420
        # 睡眠 stages 的 legacy 形状：{t: "HH:MM", stage}
        stages = legacy["sleep_data"].get("stages") or legacy["sleep_data"].get("segments")
        assert stages, "legacy sleep_data 应含 stages"
        assert "t" in stages[0] and "stage" in stages[0]
        # device_name 取自 device label
        assert legacy["device_name"] == "PhoneA"

    def test_export_without_shard_writes_empty_view(self, tmp_path):
        # 无分片时也应产出合法的空 legacy 视图（保持单一写者契约）
        store = HealthStore(str(tmp_path))
        out = store.export_legacy("u1", DATE)
        with open(out, encoding="utf-8") as f:
            legacy = json.load(f)
        assert set(legacy.keys()) == {
            "date", "updated_at", "samples", "daily_summary",
            "sleep_data", "device_name",
        }
        assert legacy["samples"] == []

    def test_export_is_only_writer_path(self, tmp_path):
        # export_legacy 自身写入也走 temp + os.replace，目录无 tmp 残留
        store = HealthStore(str(tmp_path))
        store.write(_make_batch())
        store.export_legacy("u1", DATE)
        daily_dir = os.path.join(str(tmp_path), "daily", DATE)
        leftovers = [n for n in os.listdir(daily_dir) if n.endswith(".tmp")]
        assert leftovers == []


class TestSleepSessionMerge:
    """T2：多会话睡眠合并（小睡不得覆盖主觉；视图暴露会话与转换后的阶段）。"""

    def test_nap_only_does_not_clobber_main(self, tmp_path):
        store = HealthStore(str(tmp_path))
        main = SleepSession(
            bedtime=MAIN_BEDTIME,
            wakeup=MAIN_WAKEUP,
            duration=351,
            deep=88,
            light=222,
            rem=41,
            awake=1,
            awake_count=1,
        )
        nap = SleepSession(
            bedtime=NAP_BEDTIME,
            wakeup=NAP_WAKEUP,
            duration=85,
            deep=20,
            light=50,
            rem=15,
            awake=0,
            awake_count=0,
        )

        store.write(_make_batch(source_id="cloud", sleep=SleepData(
            duration_min=351,
            deep_min=88,
            light_min=222,
            rem_min=41,
            awake_min=1,
            wakeup_time=MAIN_WAKEUP,
            awake_count=1,
            bedtime=MAIN_BEDTIME,
            sleep_sessions=[main],
        )))
        store.write(_make_batch(source_id="cloud", sleep=SleepData(
            duration_min=85,
            deep_min=20,
            light_min=50,
            rem_min=15,
            awake_min=0,
            wakeup_time=NAP_WAKEUP,
            awake_count=0,
            bedtime=NAP_BEDTIME,
            sleep_sessions=[nap],
        )))

        got = store.read("u1", DATE, "cloud")
        assert got is not None and got.sleep is not None
        assert got.sleep.duration_min == 351, (
            f"小睡覆盖了主觉顶层时长: {got.sleep.duration_min} != 351"
        )
        assert len(got.sleep.sleep_sessions) == 2
        assert got.sleep.wakeup_time == MAIN_WAKEUP
        assert got.sleep.awake_count == 1

    def test_full_repull_replaces_legacy_corrupt_sleep(self, tmp_path):
        store = HealthStore(str(tmp_path))
        store.write(_make_batch(source_id="cloud", sleep=SleepData(
            duration_min=109,
            deep_min=0,
            light_min=0,
            rem_min=73,
            awake_min=73,
            segments=[
                SleepSegment(start_ts=MAIN_BEDTIME, stage="light", duration_min=299),
            ],
        )))

        main = SleepSession(
            bedtime=MAIN_BEDTIME,
            wakeup=REPULL_MAIN_WAKEUP,
            duration=297,
            deep=93,
            light=131,
            rem=73,
            awake=2,
            awake_count=1,
            stages=[
                SleepSegment(start_ts=MAIN_BEDTIME, stage="light", duration_min=297),
            ],
        )
        nap = SleepSession(
            bedtime=NAP_BEDTIME,
            wakeup=REPULL_NAP_WAKEUP,
            duration=109,
        )
        store.write(_make_batch(source_id="cloud", sleep=SleepData(
            duration_min=297,
            deep_min=93,
            light_min=131,
            rem_min=73,
            awake_min=2,
            wakeup_time=REPULL_MAIN_WAKEUP,
            awake_count=1,
            bedtime=MAIN_BEDTIME,
            segments=[
                SleepSegment(start_ts=MAIN_BEDTIME, stage="light", duration_min=297),
            ],
            sleep_sessions=[main, nap],
        )))

        got = store.read("u1", DATE, "cloud")
        assert got is not None and got.sleep is not None
        sleep = got.sleep
        assert (
            sleep.duration_min,
            sleep.deep_min,
            sleep.light_min,
            sleep.rem_min,
            sleep.awake_min,
            sleep.awake_count,
        ) == (297, 93, 131, 73, 2, 1)
        assert len(sleep.sleep_sessions) == 2

    def test_same_session_key_updates_in_place(self, tmp_path):
        store = HealthStore(str(tmp_path))
        store.write(_make_batch(source_id="cloud", sleep=SleepData(
            duration_min=351,
            wakeup_time=MAIN_WAKEUP,
            awake_count=1,
            bedtime=MAIN_BEDTIME,
            sleep_sessions=[SleepSession(
                bedtime=MAIN_BEDTIME,
                wakeup=MAIN_WAKEUP,
                duration=351,
                awake_count=1,
            )],
        )))
        store.write(_make_batch(source_id="cloud", sleep=SleepData(
            duration_min=351,
            wakeup_time=MAIN_WAKEUP,
            awake_count=3,
            bedtime=MAIN_BEDTIME,
            sleep_sessions=[SleepSession(
                bedtime=MAIN_BEDTIME,
                wakeup=MAIN_WAKEUP,
                duration=351,
                awake_count=3,
            )],
        )))

        got = store.read("u1", DATE, "cloud")
        assert got is not None and got.sleep is not None
        assert len(got.sleep.sleep_sessions) == 1
        assert got.sleep.sleep_sessions[0].awake_count == 3
        assert got.sleep.awake_count == 3

    def test_legacy_sleep_without_sessions_field_level_merge(self, tmp_path):
        store = HealthStore(str(tmp_path))
        store.write(_make_batch(sleep=SleepData(duration_min=420, deep_min=100)))
        store.write(_make_batch(sleep=SleepData(duration_min=400)))

        got = store.read("u1", DATE, "phone")
        assert got is not None and got.sleep is not None
        assert got.sleep.duration_min == 400
        assert got.sleep.deep_min == 100
        assert got.sleep.sleep_sessions == []

    def test_zero_awake_count_preserved_after_merge(self, tmp_path):
        store = HealthStore(str(tmp_path))
        store.write(_make_batch(source_id="cloud", sleep=SleepData(
            duration_min=351,
            wakeup_time=MAIN_WAKEUP,
            awake_count=0,
            bedtime=MAIN_BEDTIME,
            sleep_sessions=[SleepSession(
                bedtime=MAIN_BEDTIME,
                wakeup=MAIN_WAKEUP,
                duration=351,
                awake_count=0,
            )],
        )))
        store.write(_make_batch(source_id="cloud", sleep=SleepData(
            duration_min=85,
            wakeup_time=NAP_WAKEUP,
            bedtime=NAP_BEDTIME,
            sleep_sessions=[SleepSession(
                bedtime=NAP_BEDTIME,
                wakeup=NAP_WAKEUP,
                duration=85,
            )],
        )))

        got = store.read("u1", DATE, "cloud")
        assert got is not None and got.sleep is not None
        assert got.sleep.awake_count == 0, (
            f"awake_count=0 被合并丢失: {got.sleep.awake_count!r}"
        )

    def test_view_exposes_sessions_and_converted_stages(self, tmp_path):
        store = HealthStore(str(tmp_path))
        stage = SleepSegment(start_ts=MAIN_BEDTIME, stage="deep", duration_min=60)
        item = {
            "start_time": MAIN_BEDTIME,
            "end_time": MAIN_BEDTIME + 3600,
            "state": 2,
        }
        main = SleepSession(
            bedtime=MAIN_BEDTIME,
            wakeup=MAIN_WAKEUP,
            duration=351,
            items=[item],
            stages=[stage],
        )
        store.write(_make_batch(source_id="cloud", sleep=SleepData(
            duration_min=351,
            wakeup_time=MAIN_WAKEUP,
            bedtime=MAIN_BEDTIME,
            segments=[stage],
            sleep_sessions=[main],
        )))

        view = store.read_view("u1", DATE)
        assert view is not None
        sleep = view["sleep_data"]
        expected_hm = datetime.fromtimestamp(MAIN_BEDTIME, _CST).strftime("%H:%M")

        sessions = sleep["sleep_sessions"]
        assert len(sessions) == 1
        assert sessions[0]["stages"][0] == {"t": expected_hm, "stage": "deep"}
        assert sessions[0]["items"] == [item]
        assert sleep["stages"][0] == {"t": expected_hm, "stage": "deep"}


class TestPathsValidation:
    """用例 8：非法 user_id / date / source 抛 ValueError。"""

    def test_bad_user_id_raises(self, tmp_path):
        with pytest.raises(ValueError):
            shard_path(str(tmp_path), "", DATE, "phone")
        with pytest.raises(ValueError):
            shard_path(str(tmp_path), "  ", DATE, "phone")

    def test_bad_date_raises(self, tmp_path):
        with pytest.raises(ValueError):
            shard_path(str(tmp_path), "u1", "2026-99-99", "phone")
        with pytest.raises(ValueError):
            shard_path(str(tmp_path), "u1", "20260922", "phone")
        with pytest.raises(ValueError):
            shard_path(str(tmp_path), "u1", "not-a-date", "phone")
        with pytest.raises(ValueError):
            legacy_path(str(tmp_path), "bad-date")

    def test_bad_source_raises(self, tmp_path):
        with pytest.raises(ValueError):
            shard_path(str(tmp_path), "u1", DATE, "watch")
        with pytest.raises(ValueError):
            shard_path(str(tmp_path), "u1", DATE, "PHONE")
        with pytest.raises(ValueError):
            shard_path(str(tmp_path), "u1", DATE, "")

    def test_store_write_validates_source(self, tmp_path):
        # store.write 内部经 shard_path 校验，非法 source 同样被拒
        store = HealthStore(str(tmp_path))
        batch = _make_batch(source_id="watch")
        with pytest.raises(ValueError):
            store.write(batch)

    def test_valid_paths(self, tmp_path):
        p = shard_path(str(tmp_path), "u1", DATE, "phone")
        assert p.endswith(os.path.join("users", "u1", "health", DATE, "phone.json"))
        lp = legacy_path(str(tmp_path), DATE)
        assert lp.endswith(os.path.join("daily", DATE, "health.json"))


class TestDailyTotals:
    """附加：total_steps 在写入/导出时按增量求和（绝不取末值、绝不差分）。"""

    def test_total_steps_is_sum_not_last(self, tmp_path):
        store = HealthStore(str(tmp_path))
        # 三个样本 steps 增量 10/20/30，末值 30，和 60
        batch = _make_batch(daily=DailySummary(total_steps=60))
        store.write(batch)

        got = store.read("u1", DATE, "phone")
        assert got is not None
        # store 不改写调用方给的 total_steps（暗接入零行为变更），
        # 导出时若缺失则按增量求和补齐
        batch2 = _make_batch(samples=[
            HealthSample(t=1, hr=60, steps=10),
            HealthSample(t=2, hr=61, steps=20),
            HealthSample(t=3, hr=62, steps=30),
        ], daily=DailySummary(hr_resting=55))
        store.write(batch2)
        out = store.export_legacy("u1", DATE)
        with open(out, encoding="utf-8") as f:
            legacy = json.load(f)
        # 求和 = 10+20+30 + 之前批次 10+20+30？不 —— 同 t 覆盖后按最终样本求和。
        # 本例 t=1/2/3 与首批 t 不同，均保留；steps 总和应为 120。
        step_vals = [s.get("steps") for s in legacy["samples"] if s.get("steps") is not None]
        assert sum(step_vals) == legacy["daily_summary"]["total_steps"]
