# -*- coding: utf-8 -*-
"""
健康数据迁移脚本测试（H4b）。

背景：ai/data/daily/{date}/health.json 存有 109 天 legacy 单文件（多写者共写），
H4 要把它一次性迁移到 users/{primary_user}/health/{date}/phone.json 分片，
并由 HealthStore.export_legacy 重新生成派生兼容视图（单一写者）。

架构依据：health-data-source-architecture.md 第 5.6 节（迁移步骤）、
第 14 节（迁移与回滚：预期差异仅限 device_name / total_steps 补齐）。

锁定契约：
  1. 迁移生成 phone 分片，source=phone、device 标记 legacy
  2. device_name 保留进分片 device.label
  3. daily_summary / sleep_data 拷入分片
  4. stages 语义等价（字符串/数字编码规范化后一致）
  5. 派生视图由 export_legacy 重写（device_name 键补齐、total_steps 填充、样本带 t_iso）
  6. 幂等：重复迁移分片内容不变
  7. dry-run 不写真实数据（data_root 零变更）
  8. 迁移前后派生视图 diff（规范化 stage、忽略元数据后）仅 device_name + total_steps
"""
import json
import os
import shutil
import sys
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from scripts.migrate_health_store import (  # noqa: E402
    diff_views,
    dry_run,
    find_legacy_days,
    migrate_all,
    normalize_stage,
)


# ── 测试数据构造 ─────────────────────────────────────

def _legacy_payload(date, device_name=None, with_sleep=True, with_daily=True):
    """构造贴近真实形态的 legacy health.json payload。"""
    payload = {
        "date": date,
        "updated_at": f"{date}T08:00:00+08:00",
        "samples": [
            # t_iso 必须与 store._epoch_to_iso(t) 一致，否则会被 diff 误判为样本变化
            {"t": 1780000000, "t_iso": "2026-05-29 04:26:40", "hr": 70, "steps": 10},
            {"t": 1780000060, "t_iso": "2026-05-29 04:27:40", "hr": 72, "steps": 20},
            {"t": 1780000120, "t_iso": "2026-05-29 04:28:40", "hr": 74},
            {"t": 1780000180, "t_iso": "2026-05-29 04:29:40", "battery": 88},
        ],
        "daily_summary": (
            {"steps": 30, "hr_resting": 60, "hr_avg": 72, "hr_max": 74, "hr_min": 70,
             "calories": 150}
            if with_daily else {}
        ),
        "sleep_data": (
            {
                "duration_min": 420,
                "deep_min": 100,
                "light_min": 200,
                "rem_min": 90,
                "awake_min": 30,
                "stages": [
                    {"t": "23:00", "stage": "light"},
                    {"t": "23:30", "stage": "deep"},
                    {"t": "01:00", "stage": "rem"},
                    {"t": "03:00", "stage": "awake"},
                    {"t": "03:05", "stage": "light"},
                ],
            }
            if with_sleep else {}
        ),
    }
    if device_name is not None:
        payload["device_name"] = device_name
    return payload


def _write_day(data_root, date, payload):
    day_dir = os.path.join(data_root, "daily", date)
    os.makedirs(day_dir, exist_ok=True)
    path = os.path.join(day_dir, "health.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    return path


def _read(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _shard_path(data_root, user, date, source="phone"):
    return os.path.join(data_root, "users", user, "health", date, f"{source}.json")


def _legacy_path(data_root, date):
    return os.path.join(data_root, "daily", date, "health.json")


# 两个代表日：一天有 device_name + 睡眠 + 日汇总，一天两者皆无
DATE_A = "2026-07-30"
DATE_B = "2026-06-06"
USER = "Axeuh"


@pytest.fixture
def data_root(tmp_path):
    """构造含两天 legacy 数据的数据根目录。"""
    root = str(tmp_path / "data")
    _write_day(root, DATE_A, _legacy_payload(DATE_A, device_name="example-phone"))
    _write_day(root, DATE_B, _legacy_payload(
        DATE_B, device_name=None, with_sleep=False, with_daily=False,
    ))
    return root


# ── 1. 日期发现 ──────────────────────────────────────

class TestFindLegacyDays:
    def test_returns_sorted_dates(self, data_root):
        days = find_legacy_days(data_root)
        assert days == sorted(days)
        assert DATE_A in days and DATE_B in days
        assert len(days) == 2

    def test_ignores_missing_dir(self, tmp_path):
        assert find_legacy_days(str(tmp_path / "nope")) == []


# ── 2. 迁移写分片 ────────────────────────────────────

class TestMigrateShards:
    @pytest.fixture(autouse=True)
    def _run(self, data_root):
        self.root = data_root
        self.result = migrate_all(data_root, USER)

    def test_creates_phone_shards_for_every_day(self):
        for date in (DATE_A, DATE_B):
            assert os.path.isfile(_shard_path(self.root, USER, date)), (
                f"{date} 的 phone 分片未生成"
            )

    def test_shard_source_and_device_marker(self):
        shard = _read(_shard_path(self.root, USER, DATE_A))
        assert shard["source"] == "phone"
        assert shard["user_id"] == USER
        assert shard["date"] == DATE_A
        # device 标记为 legacy 来源
        assert shard["device"]["device_id"] == "legacy"
        assert shard["device"]["kind"] == "phone"
        assert shard["device"]["source_id"] == "phone"

    def test_device_name_preserved_in_label(self):
        shard = _read(_shard_path(self.root, USER, DATE_A))
        assert shard["device"]["label"] == "example-phone"

    def test_missing_device_name_omits_label_key(self):
        """原文件无 device_name 时 label 键省略（不写 null，符合分片缺省语义）。"""
        shard = _read(_shard_path(self.root, USER, DATE_B))
        assert "label" not in shard.get("device", {})

    def test_daily_summary_copied(self):
        shard = _read(_shard_path(self.root, USER, DATE_A))
        daily = shard.get("daily_summary") or {}
        assert daily.get("hr_avg") == 72
        assert daily.get("calories") == 150
        # 按增量求和补齐 total_steps（10+20）
        assert daily.get("total_steps") == 30

    def test_sleep_copied_with_enum_stages(self):
        shard = _read(_shard_path(self.root, USER, DATE_A))
        sleep = shard.get("sleep_data") or {}
        assert sleep.get("duration_min") == 420
        assert sleep.get("deep_min") == 100
        stages = sleep.get("stages") or []
        assert len(stages) == 5
        # 分片内为 canonical 枚举 + 绝对 start_ts 形状
        enums = [s["stage"] for s in stages]
        assert enums == ["light", "deep", "rem", "awake", "light"]
        for seg in stages:
            assert set(seg.keys()) == {"start_ts", "stage", "duration_min"}

    def test_samples_split_from_battery(self):
        shard = _read(_shard_path(self.root, USER, DATE_A))
        samples = shard.get("samples") or []
        battery = shard.get("battery_levels") or []
        # 3 条样本 + 1 条电量条目被拆开
        assert len(samples) == 3
        assert len(battery) == 1
        assert battery[0]["level"] == 88
        assert all("battery" not in s for s in samples)

    def test_result_reports_migrated_dates(self):
        assert sorted(self.result["dates"]) == sorted([DATE_A, DATE_B])


# ── 3. 派生视图由 export_legacy 重写 ─────────────────

class TestDerivedViewRegenerated:
    @pytest.fixture(autouse=True)
    def _run(self, data_root):
        self.root = data_root
        self.orig_a = _read(_legacy_path(data_root, DATE_A))
        self.orig_b = _read(_legacy_path(data_root, DATE_B))
        migrate_all(data_root, USER)
        self.new_a = _read(_legacy_path(data_root, DATE_A))
        self.new_b = _read(_legacy_path(data_root, DATE_B))

    def test_updated_at_refreshed_to_iso_now(self):
        """export_legacy 用 datetime.now().isoformat() 重写 updated_at。"""
        for new in (self.new_a, self.new_b):
            ua = new.get("updated_at", "")
            assert "T" in ua and ("+" in ua or ua.endswith("Z")), (
                f"updated_at 非 export_legacy 的 ISO 形状: {ua!r}"
            )
        assert self.new_a["updated_at"] != self.orig_a["updated_at"]

    def test_device_name_key_always_present(self):
        """即便原文件无 device_name，export_legacy 也写出该键（null）。"""
        assert "device_name" in self.new_b
        assert self.new_b["device_name"] is None
        assert self.new_a["device_name"] == "example-phone"

    def test_total_steps_filled(self):
        assert self.new_a["daily_summary"]["total_steps"] == 30
        assert self.new_b["daily_summary"]["total_steps"] == 30

    def test_samples_carry_t_iso(self):
        """export_legacy 给每条样本补 t_iso（派生视图可读形状）。"""
        for new in (self.new_a, self.new_b):
            for s in new["samples"]:
                assert "t_iso" in s, "派生视图样本缺少 t_iso"

    def test_other_daily_fields_preserved(self):
        """除 total_steps 补齐外，原有日汇总字段逐字保留。"""
        for key in ("hr_avg", "hr_resting", "calories", "steps"):
            assert self.new_a["daily_summary"].get(key) == self.orig_a["daily_summary"].get(key)


# ── 4. 幂等 ──────────────────────────────────────────

class TestIdempotent:
    def test_second_migration_is_noop(self, data_root):
        migrate_all(data_root, USER)
        shard1 = _read(_shard_path(data_root, USER, DATE_A))
        view1 = _read(_legacy_path(data_root, DATE_A))

        time.sleep(0.01)
        migrate_all(data_root, USER)
        shard2 = _read(_shard_path(data_root, USER, DATE_A))
        view2 = _read(_legacy_path(data_root, DATE_A))

        # 分片完全不变（懒引导跳过：分片已存在）
        assert shard1 == shard2
        # 派生视图除 updated_at 时间戳外数据不变
        view1.pop("updated_at", None)
        view2.pop("updated_at", None)
        assert view1 == view2


# ── 5. dry-run 不写真实数据 ──────────────────────────

class TestDryRun:
    def test_data_root_unchanged(self, data_root):
        def _snapshot(root):
            snap = {}
            for dirpath, _dirnames, filenames in os.walk(root):
                for fn in filenames:
                    p = os.path.join(dirpath, fn)
                    with open(p, "rb") as f:
                        snap[os.path.relpath(p, root)] = f.read()
            return snap

        before = _snapshot(data_root)
        report = dry_run(data_root, USER)
        after = _snapshot(data_root)

        assert before == after, "dry-run 修改了真实数据根目录"
        # 不产生分片目录
        assert not os.path.exists(os.path.join(data_root, "users")), (
            "dry-run 不应在真实 data_root 下创建 users/"
        )
        # 但演练本身应完成并返回报告
        assert sorted(report["dates"]) == sorted([DATE_A, DATE_B])
        assert report["mode"] == "dry-run"

    def test_does_not_copy_unrelated_daily_files(self, data_root, tmp_path):
        """回归：daily/ 含 80GB+ 音频，dry-run 只能暂存 health.json（否则演练拖垮磁盘）。"""
        # 放一个哨兵文件模拟音频/大文件
        sentinel = os.path.join(data_root, "daily", DATE_A, "audio", "seg.wav")
        os.makedirs(os.path.dirname(sentinel), exist_ok=True)
        with open(sentinel, "wb") as f:
            f.write(b"\x00" * 1024)

        report = dry_run(data_root, USER, keep_copy=True)
        tmp_dir = report.get("tmp_dir")
        assert tmp_dir, "keep_copy=True 应返回 tmp_dir 供检查"
        try:
            # daily/ 子树（从源复制进来的文件）只能是 health.json
            daily_copy = os.path.join(tmp_dir, "daily")
            copied = []
            for dirpath, _dirs, files in os.walk(daily_copy):
                for fn in files:
                    copied.append(os.path.relpath(os.path.join(dirpath, fn), daily_copy))
            assert copied, "dry-run 未复制任何 health.json"
            assert all(p.endswith("health.json") for p in copied), (
                f"daily/ 副本混入了 health.json 之外的文件: {copied}"
            )
            assert not any("seg.wav" in p for p in copied), "哨兵音频被复制了"
            # 迁移产出的分片在 users/ 下（预期，非复制）
            for date in (DATE_A, DATE_B):
                assert os.path.isfile(os.path.join(daily_copy, date, "health.json"))
                assert os.path.isfile(
                    os.path.join(tmp_dir, "users", USER, "health", date, "phone.json")
                ), f"{date} 演练未生成分片"
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)


# ── 6. diff：仅 device_name + total_steps ────────────

class TestDiffViews:
    @pytest.fixture(autouse=True)
    def _setup(self, data_root, tmp_path):
        self.root = data_root
        # 迁移前先备份 daily/（模拟 H4c 备份）
        self.backup = str(tmp_path / "backup")
        shutil.copytree(os.path.join(data_root, "daily"), os.path.join(self.backup, "daily"))
        migrate_all(data_root, USER)

    def _orig(self, date):
        return os.path.join(self.backup, "daily", date, "health.json")

    def _new(self, date):
        return _legacy_path(self.root, date)

    def test_stage_encoding_normalized_as_equal(self):
        """字符串枚举与数字编码规范化后等价（stage 表示差异不计为数据 diff）。"""
        assert normalize_stage("light") == normalize_stage(3) == "light"
        assert normalize_stage("deep") == normalize_stage(2) == "deep"
        assert normalize_stage("awake") == normalize_stage(5) == "awake"
        assert normalize_stage("rem") == normalize_stage(4) == "rem"

    def test_diff_only_expected_fields(self):
        for date in (DATE_A, DATE_B):
            d = diff_views(self._orig(date), self._new(date))
            unexpected = set(d.keys()) - {"device_name", "total_steps"}
            assert not unexpected, (
                f"{date} 出现预期外差异: {unexpected}（完整 diff={d}）"
            )

    def test_total_steps_is_filled(self):
        d = diff_views(self._orig(DATE_A), self._new(DATE_A))
        assert "total_steps" in d
        assert d["total_steps"]["orig"] is None
        assert d["total_steps"]["new"] == 30

    def test_device_name_differs_only_when_originally_missing(self):
        # DATE_A 原本有 device_name，保留后无差异
        assert "device_name" not in diff_views(self._orig(DATE_A), self._new(DATE_A))
        # DATE_B 原本无 device_name（键缺失），导出补 null
        d = diff_views(self._orig(DATE_B), self._new(DATE_B))
        assert "device_name" in d
        assert d["device_name"]["orig"] is None
        assert d["device_name"]["new"] is None

    def test_samples_and_sleep_untouched(self):
        """样本与睡眠标量（除 stage 表示）逐字保留，不在 diff 中。"""
        for date in (DATE_A, DATE_B):
            d = diff_views(self._orig(date), self._new(date))
            assert "samples" not in d, f"{date} 样本发生了变化: {d.get('samples')}"
            assert "sleep_data.duration_min" not in d
            assert "sleep_data.deep_min" not in d
            assert "sleep_data.stages" not in d, (
                f"{date} stage 规范化后仍不等价: {d.get('sleep_data.stages')}"
            )
