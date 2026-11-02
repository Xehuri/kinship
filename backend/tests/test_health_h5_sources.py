# -*- coding: utf-8 -*-
"""
Stage H5 / P1-V7 —— 健康数据源归一 + 设备注册表。

P1-V7 分组双胞胎合一后的覆盖：
  1. phone push 单实现回归：/sync 载荷经 phone_push.batches_from_request（唯一
     分组实现，save_health_data 与路由两支共用）归一出的 HealthBatch 与
     /sync 实际写入 phone 分片的内容一致 —— 锁「分组/睡眠 stage 映射/电量
     拆分/设备构造/身份字段」逐字段等价（分组实现合一后，本组用例即新单
     实现的行为特征锁，非旧"双胞胎防漂移"）。
  2. 单实现路由锁：/sync phone/cloud 两支都必须流经 batches_from_request
     （防分组代码回流 health_storage）。
  3. 源语义：normalize 缺 user_id 显式报错（H6 隔离红线）；云适配器
     source_id/direction；CLOUD_FETCH_KEYS 9 键清单防漂移。
     （原 registry.get_source/capabilities 死抽象已删，用例随之清算为
     直接构造 CloudPullSource 断言，覆盖不减。）
  4. cloud_pull normalize（录制 fixture，无网络）：
     - 睡眠 state 映射 2/3/4/5 -> deep/light/rem/awake（1/未知 -> unknown，
       2/3 绝不合并；与 phone 的 2/3/4/5 语义相同、码表独立）
     - 每条睡眠记录各存一条 session，顶层字段镜像最长主觉（小睡不丢）
     - 原始 sleep_*_duration / awake_count 优先且 0 值保真
     - steps 云侧只给日总 -> 只写 daily_summary.total_steps，绝不造样本
     - heart_rate/spo2/stress -> 样本；resting_heart_rate/calories -> 日汇总
  5. 协议原语：RC4 预热丢前 1024 字节（对称 roundtrip + 源码含 1024）、
     登录响应 &&&START&&& 剥离、nonce 12 字节、分页 next_key 去重防环 +
     200 页上限、401/403/-6/-10001 认证失效重新登录并重试一次。
  6. devices：register 写 backend/data/health_devices.json（cloud id =
     cloud:{userId}），normalize 自动注册。
  7. 拉取任务脚本随包出货 enabled: false；沙箱白名单放行 cloud_pull 导入。

运行时文件（设备注册表 / 源选择）一律重定向到 tmp_path，禁止污染 backend/data/。
写入隔离沿用 H2/H3 的四重防御（配置 data.dir / _DATA_BASE / 既有 store /
新建 store 全部指向 tmp_path）。
"""
import inspect
import json
import os
from datetime import datetime, timedelta, timezone

import pytest

from config.config import get_config
from services.health.store import HealthStore
from tests.health_sleep_fixtures import (
    cst_ts,
    main_sleep_20261020,
    main_sleep_20261027,
    raw_sleep_items,
    raw_zero_totals_record,
    sleep_records_20261020,
    state_map_record,
)

# 东八区（与 health_storage / HealthStore 的时区口径一致）
_CST = timezone(timedelta(hours=8))

# conftest 登录用户（中间件注入的 user_id）
TEST_USER_ID = "Axeuh"

# 固定测试日期（与 H3 一致：未来日期，沙箱/真实感知两侧都无既有文件）
FIXED_DATE = "2030-01-01"

# 云设备 id（任务 §7：云端拉取 cloud:{userId}）
CLOUD_DEVICE_ID = "cloud:test-cloud-user"


@pytest.fixture(autouse=True)
def _redirect_runtime_files(tmp_path, monkeypatch):
    """运行时文件（源选择 / 设备注册表）重定向到 tmp_path，禁止污染 backend/data/。"""
    import routers.health as health_router
    import services.health.devices as devices_mod

    monkeypatch.setattr(
        health_router, "_selection_path",
        lambda: str(tmp_path / "health_source_selection.json"),
    )
    monkeypatch.setattr(
        devices_mod, "_registry_path",
        lambda: str(tmp_path / "health_devices.json"),
    )


@pytest.fixture
def sandbox_root(tmp_path, monkeypatch):
    """健康数据写入四重防御（与 test_health_sync_store / test_health_h3_bugs 同口径）。"""
    import config.config as cc
    import services.health as hp
    import services.health_storage as hs

    root = str(tmp_path)
    cfg = cc.get_config()
    monkeypatch.setitem(
        cfg._data, "data", {**(cfg._data.get("data") or {}), "dir": root}
    )
    monkeypatch.setattr(hs, "_DATA_BASE", os.path.join(root, "daily"))
    for mod in (hs, hp):
        for name in dir(mod):
            obj = getattr(mod, name)
            if isinstance(obj, HealthStore):
                monkeypatch.setattr(obj, "data_root", root)
    orig_init = HealthStore.__init__

    def _init(self, data_root, primary_user=None):
        orig_init(self, root, primary_user)

    monkeypatch.setattr(HealthStore, "__init__", _init)
    return root


def _noon_ts(date_str: str, hour: int = 12) -> int:
    """指定日期（东八区）整点的 epoch 秒。"""
    dt = datetime.strptime(date_str, "%Y-%m-%d").replace(
        hour=hour, minute=0, second=0, microsecond=0
    )
    return int(dt.replace(tzinfo=_CST).timestamp())


def _shard_path(root: str, source: str, date_str: str) -> str:
    """源分片路径：{root}/users/{user}/health/{date}/{source}.json。"""
    return os.path.join(
        root, "users", TEST_USER_ID, "health", date_str, f"{source}.json"
    )


def _load_json(path):
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    return data if isinstance(data, dict) else None


def _today_anchor() -> tuple:
    """今天（东八区）正午：样本日 == sleep 主日（_pick_date 对无 t 的 sleep 回退今天）。"""
    now = datetime.now(_CST)
    date_str = now.strftime("%Y-%m-%d")
    noon = now.replace(hour=12, minute=0, second=0, microsecond=0)
    return date_str, int(noon.timestamp())


def _android_payload(t_base: int) -> dict:
    """Android 真实契约载荷（与 H2 测试同构：数字 stage 编码 + device_name + 电量）。"""
    return {
        "samples": [
            {"t": t_base, "hr": 70, "steps": 10},
            {"t": t_base + 60, "hr": 72, "steps": 20},
        ],
        "battery_levels": [{"t": t_base, "level": 88}],
        "sleep_data": {
            "duration_min": 400,
            "deep_min": 100,
            "stages": [
                {"t": "00:01", "stage": 3},
                {"t": "01:00", "stage": 2},
            ],
        },
        "device_name": "PhoneA",
    }


class TestPhonePushSingleImplementation:
    """P1-V7 合一后：batches_from_request 是 push 分组唯一实现，
    本类锁定其经 /sync 写路径落盘的分片逐字段行为（行为特征锁）。"""

    def test_batches_from_request_matches_shard_written_by_sync(
        self, sandbox_root, client, auth_headers
    ):
        from services.health.sources.phone_push import batches_from_request

        date_str, t_base = _today_anchor()
        payload = _android_payload(t_base)

        # 路径 A：现行 code path —— POST /sync（save_health_data 委派唯一分组实现写分片）
        resp = client.post(
            "/api/health/sync", json=payload, headers=auth_headers
        )
        assert resp.status_code == 200, resp.text
        shard = _load_json(_shard_path(sandbox_root, "phone", date_str))
        assert shard is not None, "phone 分片未生成"

        # 路径 B：同一实现直接归一（内存，不落盘）—— A/B 必须同源
        batches = batches_from_request(payload, user_id=TEST_USER_ID)
        assert len(batches) == 1, f"应归一为单日批次，实际 {len(batches)}"
        got = batches[0].to_dict()

        # 逐字段等价：样本（同 t 同值）、睡眠 stage 映射（数字码 -> 枚举）、
        # 电量拆分（battery_levels -> {t,level}）、设备块、身份字段
        assert got["samples"] == shard["samples"], (
            f"phone_push 样本与 /sync 写入不一致:\n"
            f"  push  = {got['samples']}\n  shard = {shard['samples']}"
        )
        assert got.get("sleep_data") == shard.get("sleep_data"), (
            f"睡眠归一不一致:\n  push  = {got.get('sleep_data')}\n"
            f"  shard = {shard.get('sleep_data')}"
        )
        assert got.get("battery_levels") == shard.get("battery_levels"), (
            f"电量拆分不一致: {got.get('battery_levels')} != "
            f"{shard.get('battery_levels')}"
        )
        assert got["device"] == shard["device"], (
            f"设备构造不一致: {got['device']} != {shard['device']}"
        )
        for key in ("source", "user_id", "date"):
            assert got[key] == shard[key], (
                f"{key} 不一致: {got[key]!r} != {shard[key]!r}"
            )
        # 本载荷无 daily_summary：两边都不该有 daily 键（store 注入 total_steps
        # 的前提是 daily_summary 已存在，空 daily 不注入）
        assert "daily_summary" not in got and "daily_summary" not in shard

    def test_daily_total_steps_injected_only_in_shard(
        self, sandbox_root, client, auth_headers
    ):
        """带 daily 的载荷：分片按增量求和补 total_steps，push 批次保持原样。"""
        from services.health.sources.phone_push import batches_from_request

        date_str, t_base = _today_anchor()
        payload = {
            "samples": [
                {"t": t_base, "steps": 10},
                {"t": t_base + 60, "steps": 20},
            ],
            "daily_summary": {"steps": 20, "hr_resting": 58},
            "device_name": "PhoneB",
        }
        resp = client.post("/api/health/sync", json=payload, headers=auth_headers)
        assert resp.status_code == 200, resp.text
        shard = _load_json(_shard_path(sandbox_root, "phone", date_str))
        assert shard is not None

        batches = batches_from_request(payload, user_id=TEST_USER_ID)
        assert len(batches) == 1
        got = batches[0].to_dict()

        # 样本与设备仍逐字段等价
        assert got["samples"] == shard["samples"]
        assert got["device"] == shard["device"]
        # daily：push 侧 = 载荷原样；shard 侧额外按增量求和注入 total_steps
        shard_daily = dict(shard.get("daily_summary") or {})
        injected = shard_daily.pop("total_steps", None)
        assert injected == 30, f"分片应按增量求和注入 total_steps=30，实际 {injected}"
        assert (got.get("daily_summary") or {}) == shard_daily, (
            f"daily 归一不一致: {got.get('daily_summary')} != {shard_daily}"
        )


class TestSingleImplementationRouting:
    """P1-V7 合一结构锁：/sync phone/cloud 两支与 save_health_data 全部
    流经 phone_push.batches_from_request（防分组代码回流 health_storage）。"""

    def test_sync_phone_and_cloud_both_use_batches_from_request(
        self, sandbox_root, client, auth_headers, monkeypatch, tmp_path
    ):
        # merge 模式：允许 phone 与 cloud 两支都写入（默认 exclusive 会 409）
        with open(tmp_path / "health_source_selection.json", "w", encoding="utf-8") as f:
            json.dump({TEST_USER_ID: {"primary": "phone", "mode": "merge"}}, f)

        import services.health_storage as hs
        from services.health.sources import phone_push

        seen = []
        orig = phone_push.batches_from_request

        def spy(payload, user_id, explicit_date=None):
            seen.append(payload.get("source") or "phone")
            return orig(payload, user_id=user_id, explicit_date=explicit_date)

        monkeypatch.setattr(hs, "batches_from_request", spy)
        monkeypatch.setattr(phone_push, "batches_from_request", spy)

        t = _noon_ts(FIXED_DATE)
        r1 = client.post(
            "/api/health/sync",
            json={"samples": [{"t": t, "hr": 70}], "device_name": "V7Phone"},
            headers=auth_headers,
        )
        assert r1.status_code == 200, r1.text
        r2 = client.post(
            "/api/health/sync",
            json={
                "samples": [{"t": t + 60, "hr": 71}],
                "source": "cloud",
                "device_id": CLOUD_DEVICE_ID,
                "date": FIXED_DATE,
            },
            headers=auth_headers,
        )
        assert r2.status_code == 200, r2.text
        assert seen == ["phone", "cloud"], (
            f"/sync 两支未全部流经唯一分组实现: {seen}"
        )

    def test_save_health_data_signature_unchanged(self):
        """合一后对外签名保持（新增参数必须全部带默认值、位置不变）。"""
        import inspect

        from services.health_storage import save_health_data

        params = list(inspect.signature(save_health_data).parameters.values())
        positional = [p.name for p in params[:6]]
        assert positional == [
            "samples", "daily_summary", "battery_levels",
            "sleep_data", "user_id", "device_name",
        ], f"前六个参数位漂移: {positional}"
        added = {p.name: p.default for p in params[6:]}
        assert added == {"source": "phone", "device_id": None, "explicit_date": None}, (
            f"新增参数名/默认值漂移: {added}"
        )

    def test_normalize_requires_user_id(self):
        """H6 红线随合一保留：normalize 缺 user_id 显式报错，绝不降级 default。"""
        from services.health.sources.phone_push import normalize

        with pytest.raises(ValueError, match="user_id"):
            normalize({"date": FIXED_DATE, "samples": []})

    def test_phone_push_grouping_not_duplicated_in_storage(self):
        """health_storage 不再自带分组/睡眠归一原语（单一实现处 = phone_push）。"""
        import services.health_storage as hs
        from services.health.sources import phone_push

        for gone in ("_ts_to_date", "_pick_date", "_build_sleep", "_stage_to_enum", "_hm_to_epoch"):
            assert not hasattr(hs, gone), f"health_storage 仍带分组原语: {gone}"
        for kept in ("_ts_to_date", "_pick_date", "_build_sleep", "normalize", "batches_from_request"):
            assert hasattr(phone_push, kept), f"phone_push 缺少唯一实现: {kept}"


def _cloud_record(key: str, t: int, value) -> dict:
    """构造 §3.6 形状的云记录（value 为 JSON 字符串，需二次 loads）。"""
    return {
        "sid": 1,
        "key": key,
        "time": t,
        "zone_offset": 28800,
        "zone_name": "Asia/Shanghai",
        "value": json.dumps(value, separators=(",", ":")),
        "update_time": t,
    }


class TestCloudNormalize:
    """云记录 -> HealthBatch（录制 fixture，无网络）。"""

    def _normalize(self, records):
        from services.health.sources.cloud_pull import CloudPullSource

        src = CloudPullSource(user_id="test-cloud-user", pass_token="fixture-token")
        return src.normalize({
            "date": FIXED_DATE,
            "records": records,
            "user_id": TEST_USER_ID,
            "device_id": CLOUD_DEVICE_ID,
        })

    def test_sleep_state_map_cloud_2_to_5(self):
        """云睡眠 state 2/3/4/5 -> deep/light/rem/awake（1/未知 -> unknown）。"""
        batch = self._normalize([state_map_record()])

        assert batch.source_id == "cloud"
        assert batch.date == FIXED_DATE
        sleep = batch.sleep
        assert sleep is not None, "云睡眠未归一"
        got_stages = [seg.stage for seg in sleep.segments]
        assert got_stages == ["deep", "light", "rem", "awake"], (
            f"云睡眠 state 映射错误: {got_stages} "
            "（期望 2=deep, 3=light, 4=rem, 5=awake）"
        )
        # 2/3 绝不合并：light 只允许出现一次
        assert got_stages.count("light") == 1, f"深睡/浅睡被合并: {got_stages}"
        assert sleep.duration_min == 120, "duration 应取原始 duration 字段"
        assert sleep.awake_min == 30, "awake 应取原始 sleep_awake_duration"
        # 段时长 = (end-start)//60 = 30 分钟
        assert all(seg.duration_min == 30 for seg in sleep.segments)
        # 段起点为绝对 epoch 秒
        assert all(isinstance(seg.start_ts, int) for seg in sleep.segments)

    def test_sleep_fields_from_raw_and_zero_preserved(self):
        """原始 rem/awake/awake_count 优先；0 不是 None，不得被吞。"""
        batch = self._normalize([raw_zero_totals_record()])
        sleep = batch.sleep
        assert sleep is not None

        assert sleep.duration_min == 300, "duration 应取原始 duration"
        assert sleep.deep_min == 100
        assert sleep.light_min == 200
        assert sleep.rem_min == 0 and sleep.rem_min is not None, (
            f"rem_min 原始值 0 必须保留，实际 {sleep.rem_min!r}"
        )
        assert sleep.awake_min == 0 and sleep.awake_min is not None, (
            f"awake_min 原始值 0 必须保留，实际 {sleep.awake_min!r}"
        )
        assert sleep.awake_count == 0 and sleep.awake_count is not None, (
            f"awake_count 原始值 0 必须保留，实际 {sleep.awake_count!r}"
        )
        session = sleep.sleep_sessions[0]
        assert (
            session.duration, session.deep, session.light,
            session.rem, session.awake, session.awake_count,
        ) == (300, 100, 200, 0, 0, 0)

    def test_sleep_duration_excludes_awake(self):
        """10-20 口径：duration = deep+light+rem（351），段合计 352 含清醒。"""
        batch = self._normalize([main_sleep_20261020()])
        sleep = batch.sleep
        assert sleep is not None

        stage_sum = sum(seg.duration_min for seg in sleep.segments)
        assert stage_sum == 352, f"10-20 段合计应为 352（含清醒 1），实际 {stage_sum}"
        assert sleep.duration_min == 351, (
            f"duration 应排除清醒（351），实际 {sleep.duration_min}"
        )
        assert sleep.awake_min == 1
        assert (
            (sleep.deep_min or 0) + (sleep.light_min or 0) + (sleep.rem_min or 0)
        ) == 351, "duration_min 应等于 deep+light+rem"

    def test_sleep_multi_session_main_is_longest(self):
        """同一归日组三条睡眠：各存 session，顶层镜像最长主觉（351）。"""
        batch = self._normalize(sleep_records_20261020())
        sleep = batch.sleep
        assert sleep is not None

        assert sleep.duration_min == 351, (
            f"顶层 duration 应取主觉（最长），不得被小睡覆盖，实际 {sleep.duration_min}"
        )
        assert len(sleep.sleep_sessions) == 3, (
            f"三条睡眠应各存一条 session，实际 {len(sleep.sleep_sessions)}"
        )
        assert [s.duration for s in sleep.sleep_sessions] == [351, 85, 41], (
            f"session 应按 wakeup 升序且主觉在前: "
            f"{[s.duration for s in sleep.sleep_sessions]}"
        )
        assert [s.wakeup for s in sleep.sleep_sessions] == sorted(
            s.wakeup for s in sleep.sleep_sessions
        ), "sleep_sessions 未按 wakeup 排序"
        # 顶层字段镜像主觉
        assert sleep.wakeup_time == cst_ts("2026-10-20", "07:02")
        assert sleep.bedtime == cst_ts("2026-10-20", "01:10")
        assert (sleep.deep_min, sleep.light_min, sleep.rem_min) == (88, 222, 41)

        # 序列化键名精确（store 后续按该键读取）
        out = batch.to_dict()["sleep_data"]
        assert len(out["sleep_sessions"]) == 3
        assert all(s["items"] for s in out["sleep_sessions"])

    def test_sleep_acceptance_20261020(self):
        """10-20 与 App 对账：深 88 / 浅 222 / REM 41 / 清醒 1 次 1 分钟。"""
        date = "2026-10-20"
        batch = self._normalize([main_sleep_20261020()])
        sleep = batch.sleep
        assert sleep is not None

        assert sleep.duration_min == 351
        assert (sleep.deep_min, sleep.light_min, sleep.rem_min) == (88, 222, 41)
        assert sleep.awake_min == 1
        assert sleep.awake_count == 1
        assert sleep.wakeup_time == cst_ts(date, "07:02")
        assert sleep.bedtime == cst_ts(date, "01:10")
        awake_segments = [seg for seg in sleep.segments if seg.stage == "awake"]
        assert len(awake_segments) == 1, f"10-20 应只有一次清醒: {awake_segments}"
        assert awake_segments[0].start_ts == cst_ts(date, "04:06")
        assert awake_segments[0].duration_min == 1

    def test_sleep_acceptance_20261027(self):
        """10-27 与 App 对账：6h0m / 深 120 / 浅 198 / REM 42 / 清醒 0 次。"""
        date = "2026-10-27"
        record = main_sleep_20261027()
        batch = self._normalize([record])
        sleep = batch.sleep
        assert sleep is not None

        assert sleep.duration_min == 360
        assert (sleep.deep_min, sleep.light_min, sleep.rem_min) == (120, 198, 42)
        assert sleep.awake_min == 0 and sleep.awake_min is not None
        assert sleep.awake_count == 0 and sleep.awake_count is not None
        assert sleep.wakeup_time == cst_ts(date, "06:32")
        assert sleep.bedtime == cst_ts(date, "00:32")
        assert all(item["state"] != 5 for item in raw_sleep_items(record)), (
            "10-27 原始 items 不应含 state=5"
        )
        assert not any(seg.stage == "awake" for seg in sleep.segments)

    def test_sleep_raw_items_preserved(self):
        """每个 session 逐条保留原始 {start_time,end_time,state}。"""
        records = sleep_records_20261020()
        batch = self._normalize(records)
        sleep = batch.sleep
        assert sleep is not None

        assert [s.items for s in sleep.sleep_sessions] == [
            raw_sleep_items(rec) for rec in records
        ], "session.items 与原始 items 不一致"
        assert sleep.sleep_sessions[0].items[2] == {
            "start_time": cst_ts("2026-10-20", "04:06"),
            "end_time": cst_ts("2026-10-20", "04:07"),
            "state": 5,
        }

    def test_sleep_backward_compat_old_dict(self):
        """旧分片 sleep_data（无新键）原样加载，sleep_sessions 缺省为空。"""
        from services.health.models import SleepData

        old = {
            "duration_min": 400,
            "deep_min": 100,
            "light_min": 250,
            "rem_min": 50,
            "awake_min": 0,
            "wakeup_time": 1234567890,
            "stages": [
                {"start_ts": 1234567000, "stage": "deep", "duration_min": 60},
            ],
        }
        sleep = SleepData.from_dict(old)

        assert sleep.duration_min == 400
        assert sleep.awake_min == 0
        assert sleep.awake_count is None
        assert sleep.bedtime is None
        assert sleep.sleep_sessions == []
        assert sleep.to_dict() == old, "旧分片反序列化后再序列化应逐键不变"

    def test_steps_write_daily_total_without_fake_samples(self):
        """云 steps 只有日总 -> daily_summary.total_steps，绝不造 steps 样本。"""
        noon = _noon_ts(FIXED_DATE)
        batch = self._normalize([
            _cloud_record("steps", noon, {
                "time": noon, "steps": 9451, "distance": 6000, "calories": 300,
            }),
            _cloud_record("heart_rate", noon + 60, {"time": noon + 60, "bpm": 72, "type": 0}),
        ])

        assert batch.daily_summary is not None
        assert batch.daily_summary.total_steps == 9451, (
            f"云日总 steps 应写 total_steps，实际 {batch.daily_summary.total_steps}"
        )
        # 无任何 steps 样本（云日总不得造样本）
        assert all(s.steps is None for s in batch.samples), (
            f"云 steps 不得生成样本: {[s.to_dict() for s in batch.samples]}"
        )
        # heart_rate 仍是样本
        hr_samples = [s for s in batch.samples if s.hr is not None]
        assert len(hr_samples) == 1
        assert hr_samples[0].hr == 72
        assert hr_samples[0].t == noon + 60

    def test_metric_records_map_to_samples_and_daily(self):
        """heart_rate/spo2/stress -> 样本；resting/calories -> 日汇总。"""
        t1 = _noon_ts(FIXED_DATE)
        t2 = t1 + 300
        batch = self._normalize([
            _cloud_record("heart_rate", t1, {"time": t1, "bpm": 72, "type": 0}),
            _cloud_record("heart_rate", t2, {"time": t2, "bpm": 80, "type": 1}),
            _cloud_record("spo2", t1, {"time": t1, "spo2": 98}),
            _cloud_record("stress", t1, {"time": t1, "stress": 41}),
            _cloud_record("resting_heart_rate", t1, {"bpm": 58, "date_time": "2026-09-20T07:00:00+08:00"}),
            _cloud_record("calories", t2, {"time": t2, "calories": 2100}),
        ])

        by_t = {s.t: s for s in batch.samples}
        assert by_t[t1].hr == 72
        assert by_t[t2].hr == 80
        assert by_t[t1].spo2 == 98
        assert by_t[t1].stress == 41

        daily = batch.daily_summary
        assert daily is not None
        assert daily.hr_resting == 58, f"resting_heart_rate 应写 hr_resting: {daily}"
        assert daily.calories == 2100, f"云 calories 日总应写 calories: {daily}"
        assert daily.hr_avg == 76  # (72+80)//2
        assert daily.hr_max == 80
        assert daily.hr_min == 72
        assert daily.stress_avg == 41
        assert daily.spo2_avg == 98

    def test_normalize_auto_registers_cloud_device(
        self, tmp_path
    ):
        """normalize 自动注册设备到 health_devices.json。"""
        noon = _noon_ts(FIXED_DATE)
        self._normalize([
            _cloud_record("heart_rate", noon, {"time": noon, "bpm": 70, "type": 0}),
        ])
        registry = _load_json(str(tmp_path / "health_devices.json"))
        assert registry is not None, "normalize 未自动注册设备"
        assert CLOUD_DEVICE_ID in registry, (
            f"云设备 id 应为 cloud:{{userId}}: {list(registry)}"
        )
        entry = registry[CLOUD_DEVICE_ID]
        assert entry.get("kind") == "cloud"
        assert entry.get("owner_user_id") == TEST_USER_ID
        assert entry.get("source_id") == "cloud"

    def test_direct_write_keeps_canonical_detail(self):
        """P2-V8 直写契约：canonical 批次全量保真（旧 payload 降级环已退役）。

        旧链经 /sync 线格式往返会丢睡眠分段与 fetched_at；直写链以
        batch.to_dict() 原样落分片，分段明细与拉取时刻随分片持久化。
        """
        import services.health.sources.cloud_pull as cp_mod

        assert not hasattr(cp_mod, "batch_to_sync_payload"), (
            "batch_to_sync_payload 应已随 P2-V8 去 round-trip 退役"
        )
        noon = _noon_ts(FIXED_DATE)
        items = [
            {"start_time": noon - 3600, "end_time": noon - 1800, "state": 2},
            {"start_time": noon - 1800, "end_time": noon, "state": 5},
        ]
        batch = self._normalize([
            _cloud_record("steps", noon, {"time": noon, "steps": 9451}),
            _cloud_record("sleep", noon, {
                "bedtime": noon - 3600, "wake_up_time": noon,
                "duration": 60, "sleep_deep_duration": 30,
                "sleep_light_duration": 0, "sleep_rem_duration": 0,
                "items": items,
            }),
        ])
        out = batch.to_dict()
        assert out["source"] == "cloud"
        assert out["date"] == FIXED_DATE
        assert out["device"]["device_id"] == CLOUD_DEVICE_ID
        assert out["daily_summary"]["total_steps"] == 9451
        assert out["fetched_at"]  # 拉取时刻随 canonical 落分片（旧链丢失）
        stages = out["sleep_data"]["stages"]
        assert [s["stage"] for s in stages] == ["deep", "awake"], (
            f"睡眠分段明细应随直写落分片: {stages}"
        )
        assert all(isinstance(s["start_ts"], int) for s in stages), (
            "分段起点为绝对 epoch 秒，不经 HH:mm 降级（跨午夜无损）"
        )


class TestCloudProtocolPrimitives:
    """协议原语（录制 fixture / 纯函数，无网络）。"""

    def test_rc4_roundtrip_and_prewarm_1024(self):
        """RC4 预热丢前 1024 字节：对称 roundtrip 成立，且实现含 1024 预热。"""
        import hashlib

        from services.health.sources.cloud_pull import rc4_crypt

        key = hashlib.sha256(b"fixture-ssecurity").digest()
        msg = b'{"code":0,"result":{"ok":1}}'
        assert rc4_crypt(key, rc4_crypt(key, msg)) == msg, "RC4 加解密 roundtrip 失败"
        # 预热实现回归锁（任务：prewarm discard first 1024 bytes 是 critical）
        assert "1024" in inspect.getsource(rc4_crypt), (
            "rc4_crypt 必须预热丢弃前 1024 字节密钥流（小米协议硬性要求）"
        )

    def test_login_prefix_strip(self):
        """登录响应 &&&START&&& 剥离后解析 JSON；缺前缀抛错。"""
        from services.health.sources.cloud_pull import read_login_payload

        assert read_login_payload('&&&START&&&{"ssecurity":"abc","userId":1}') == {
            "ssecurity": "abc", "userId": 1,
        }
        with pytest.raises(RuntimeError):
            read_login_payload('{"ssecurity":"abc"}')

    def test_nonce_is_12_bytes(self):
        """nonce = 8 字节 urandom + 4 字节大端分钟戳，共 12 字节。"""
        from services.health.sources.cloud_pull import gen_nonce

        nonce = gen_nonce()
        assert len(nonce) == 12, f"nonce 应 12 字节，实际 {len(nonce)}"

    def test_pagination_dedupe_breaks_cycle(self):
        """next_key 游标去重防环：环形游标应在第 4 页内截断。"""
        from services.health.sources.cloud_pull import CloudPullSource

        src = CloudPullSource(user_id="1", pass_token="x")
        calls = {"n": 0}

        def fake_post(path, payload):
            calls["n"] += 1
            rec = _cloud_record("steps", 1, {"time": 1, "steps": 1})
            return {
                "data_list": [rec],
                "has_more": True,
                "next_key": "k%d" % (calls["n"] % 3),  # k1,k2,k3,k1... 环
            }

        import services.health.sources.cloud_pull as cp
        src._post_retry = fake_post
        items = src.fetch_key("steps", 0, 100)
        assert calls["n"] == 4, (
            f"环形 next_key 应在重复时截断，实际请求 {calls['n']} 页"
        )
        assert len(items) == 4

    def test_pagination_hard_cap_200(self):
        """每页游标都新鲜时，硬上限 200 页截断。"""
        from services.health.sources.cloud_pull import CloudPullSource

        src = CloudPullSource(user_id="1", pass_token="x")
        calls = {"n": 0}

        def fake_post(path, payload):
            calls["n"] += 1
            rec = _cloud_record("steps", calls["n"], {"time": calls["n"], "steps": 1})
            return {"data_list": [rec], "has_more": True, "next_key": f"k{calls['n']}"}

        src._post_retry = fake_post
        items = src.fetch_key("steps", 0, 10**12)
        assert calls["n"] == 200, f"页上限应为 200，实际 {calls['n']}"
        assert len(items) == 200

    def test_auth_error_relogin_and_retry_once(self):
        """401/403/-6/-10001 -> 重新登录并重试恰好一次。"""
        from services.health.sources.cloud_pull import (
            CloudAuthError,
            CloudPullSource,
        )

        src = CloudPullSource(user_id="1", pass_token="x")
        logins = {"n": 0}
        attempts = {"n": 0}

        def fake_login():
            logins["n"] += 1

        def fake_signed_post(path, payload):
            attempts["n"] += 1
            if attempts["n"] == 1:
                raise CloudAuthError(401)
            return {"ok": True}

        src._login = fake_login
        src._signed_post = fake_signed_post

        assert src._post_retry("/app/v1/data/x", {}) == {"ok": True}
        assert logins["n"] == 1, f"应重新登录恰好 1 次，实际 {logins['n']}"
        assert attempts["n"] == 2, f"首次失败 + 重试 = 2 次请求，实际 {attempts['n']}"

        # 重试仍失败：上抛（不会无限重登）
        attempts["n"] = 0
        logins["n"] = 0

        def always_fail(path, payload):
            attempts["n"] += 1
            raise CloudAuthError(-6)

        src._signed_post = always_fail
        with pytest.raises(CloudAuthError):
            src._post_retry("/app/v1/data/x", {})
        assert logins["n"] == 1, "重试仍失败时不得再次重登"
        assert attempts["n"] == 2


class TestSourceAdaptersAfterV7:
    """P1-V7 清算后：registry 死抽象（get_source/capabilities）已删，
    等价性用例改造为对新单实现/直接构造适配器的断言（覆盖不减）。"""

    def test_cloud_adapter_source_and_direction(self):
        """云适配器直接构造（原 get_source('cloud') 语义）：source_id/direction。"""
        from services.health.sources.cloud_pull import CloudPullSource

        cloud = CloudPullSource(user_id="1", pass_token="x")
        assert cloud.source_id == "cloud" and cloud.direction == "pull"

    def test_push_normalized_to_plain_functions(self):
        """push 方向已平函数化：无 PhonePushSource 类、无 registry 转手；
        normalize/batches_from_request 是模块级唯一实现。"""
        import services.health.sources.phone_push as pp

        assert callable(pp.normalize) and callable(pp.batches_from_request)
        assert not hasattr(pp, "PhonePushSource"), "push 类形态残留"
        import services.health.sources.registry as reg

        assert not hasattr(reg, "get_source") and not hasattr(reg, "capabilities"), (
            "registry 死抽象未清算"
        )

    def test_cloud_fetch_keys_contract(self):
        """CLOUD_FETCH_KEYS：§3.6 全部 9 个指标 key（源提供什么列什么；
        weight/abnormal_heart_beat 已取数但 canonical 模型暂无落点）。"""
        from services.health.sources.registry import CLOUD_FETCH_KEYS

        cloud_expected = {
            "steps", "calories", "heart_rate", "resting_heart_rate",
            "sleep", "weight", "spo2", "stress", "abnormal_heart_beat",
        }
        assert cloud_expected == set(CLOUD_FETCH_KEYS), (
            f"cloud 取数清单漂移: {CLOUD_FETCH_KEYS}"
        )


class TestDevicesRegistry:
    """devices：register 写注册表 + 幂等 upsert。"""

    def test_register_phone_and_cloud(self, tmp_path):
        import services.health.devices as devices_mod

        registry_file = str(tmp_path / "health_devices.json")

        ref = devices_mod.register(
            device_name="Pixel8", owner=TEST_USER_ID,
            kind="phone", source_id="phone",
        )
        assert ref.device_id == "Pixel8"
        assert ref.kind == "phone"

        ref2 = devices_mod.register(
            device_id=CLOUD_DEVICE_ID, owner=TEST_USER_ID,
            kind="cloud", source_id="cloud",
        )
        assert ref2.device_id == CLOUD_DEVICE_ID

        data = _load_json(registry_file)
        assert data is not None, "注册表文件未生成"
        assert set(data.keys()) == {"Pixel8", CLOUD_DEVICE_ID}
        assert data["Pixel8"]["owner_user_id"] == TEST_USER_ID
        assert data[CLOUD_DEVICE_ID]["kind"] == "cloud"
        # 幂等：重复注册不产生新键
        devices_mod.register(
            device_name="Pixel8", owner=TEST_USER_ID,
            kind="phone", source_id="phone",
        )
        data2 = _load_json(registry_file)
        assert set(data2.keys()) == {"Pixel8", CLOUD_DEVICE_ID}


def _cloud_pull_task_path() -> str:
    root = os.path.dirname(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    )
    task_path = os.path.join(root, "ai", "data", "tasks", "xiaomi_cloud_health.py")
    if not os.path.isfile(task_path):
        pytest.skip("private ai/ is not part of the public tree")
    return task_path


class TestCloudPullTaskAndSandbox:
    """拉取任务随包 enabled:false；沙箱白名单放行 cloud_pull 导入。"""

    def test_task_ships_disabled(self):
        task_path = _cloud_pull_task_path()
        with open(task_path, encoding="utf-8") as f:
            head = f.read(500)
        assert "enabled: false" in head, (
            "云拉取任务必须随包停用（enabled: false），防止意外发起真实云调用"
        )
        assert "name:" in head

    def test_sandbox_allows_direct_write_imports(self):
        """script_sandbox 白名单必须放行任务脚本（P2-V8 直写版）的真实导入面。

        直接对出货的任务脚本源文件跑 check_security——白名单与脚本同步漂移
        即刻暴露（cloud_pull 取数 + health_storage.get_health_store 直写）。
        """
        from services.script_sandbox import check_security

        task_path = _cloud_pull_task_path()
        with open(task_path, encoding="utf-8") as f:
            source = f.read()
        result = check_security(source)
        assert result["passed"], (
            f"沙箱未放行直写任务导入: {result['errors']}"
        )
        assert "services.health_storage" in result["used_imports"]
        assert "services.health.sources.cloud_pull" in result["used_imports"]

    def test_v8_roundtrip_symbols_gone(self):
        """P2-V8 结构锁：脚本不再引 /sync 线格式，旧降级器全仓清零。"""
        task_path = _cloud_pull_task_path()
        with open(task_path, encoding="utf-8") as f:
            task_src = f.read()
        assert "api/health/sync" not in task_src, "脚本已直写，不应再引 /sync"
        assert "batch_to_sync_payload" not in task_src

        import services.health.sources.cloud_pull as cp_mod
        assert not hasattr(cp_mod, "batch_to_sync_payload")
