# -*- coding: utf-8 -*-
"""
Stage H3 —— 既有 Bug 的 RED 守卫测试（TDD：先测试，后实现）。

目标（实现前必须 FAIL，实现后必须 PASS）：
  1. Bug① test_dashboard_steps_sum_semantics：
     backend/routers/mobile.py:398-409 对 samples.steps（实为区间增量）做差值累加，
     结果错误。派生视图缺 daily_summary.total_steps 时，dashboard 回退必须按
     增量【求和】（[10,20,30] -> 60），而非差分（-> 30）；
     有 daily_summary.total_steps 时优先读日总（999 -> 999）。

注：Bug②（upload-db 走单一写者）整类 TestUploadDbViaStore 随 P0 裁剪删除——
/api/health/upload-db 端点已不存在。

写入隔离（四重防御，绝不触碰真实 ai/data —— 与 test_health_sync_store 同口径）：
  1) 配置单例 data.dir 临时指向 tmp_path
  2) health_storage 模块导入时快照的 _DATA_BASE 指向 tmp_path/daily
  3) 既有模块级 HealthStore 实例的 data_root 强制改指 tmp_path
  4) 新建 HealthStore 的 data_root 一律强制为 tmp_path

日期固定取 2030-01-01（未来日期）：沙箱内无历史文件干扰，dashboard 的感知
部分（mobile._DATA_ROOT 指真实 ai/data）也读不到该日 perception.jsonl，
避免真实数据读取影响断言。
"""
import json
import os
from datetime import datetime, timedelta, timezone

import pytest

from services.health.store import HealthStore

# 东八区（与 health_storage / HealthStore 的时区口径一致）
_CST = timezone(timedelta(hours=8))

# conftest 的 auth_headers 用用户名 "Axeuh" 登录，中间件注入的 user_id 即该用户名
TEST_USER_ID = "Axeuh"

# 固定测试日期（未来日期，保证沙箱/真实感知两侧都无既有文件）
FIXED_DATE = "2030-01-01"

# 种子样本的步数增量 —— 求和=60，差分（Bug①口径）=30
STEPS_INCREMENTS = [10, 20, 30]


@pytest.fixture
def sandbox_root(tmp_path, monkeypatch):
    """把健康数据的全部写入路径重定向到 tmp_path（禁止写真实 ai/data）。

    四重防御覆盖直写路径（health.py upload-db 直写 _DATA_BASE 拼接路径）与
    HealthStore 路径（data_root 来自配置或模块级实例）两种实现。
    """
    import config.config as cc
    import services.health as hp
    import services.health_storage as hs

    root = str(tmp_path)

    # 1) 配置单例 data.dir 指向 tmp（绝对路径，property 直接返回不走 _resolve_base）
    cfg = cc.get_config()
    monkeypatch.setitem(
        cfg._data, "data", {**(cfg._data.get("data") or {}), "dir": root}
    )

    # 2) health_storage 导入时快照的直写基目录
    monkeypatch.setattr(hs, "_DATA_BASE", os.path.join(root, "daily"))

    # 3) 既有模块级 HealthStore 实例（防御 import 时创建单例）
    for mod in (hs, hp):
        for name in dir(mod):
            obj = getattr(mod, name)
            if isinstance(obj, HealthStore):
                monkeypatch.setattr(obj, "data_root", root)

    # 4) 新建 HealthStore 一律以 tmp 为 data_root
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


def _derived_path(root: str, date_str: str) -> str:
    """派生兼容视图路径：{root}/daily/{date}/health.json。"""
    return os.path.join(root, "daily", date_str, "health.json")



def _load_json(path):
    """读取 JSON 文件（不存在或非 dict 时返回 None）。"""
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    return data if isinstance(data, dict) else None


def _seed_derived(root: str, date_str: str, *, daily_summary: dict) -> dict:
    """直接预置历史日派生文件（P2-V9 起写链不再产生该文件的存量形态）。

    样本 steps 为区间增量 [10,20,30]；daily_summary 由调用方给定
    （Bug① 回退路径的触发形态就是"无 total_steps 的日总"）。
    """
    t_base = _noon_ts(date_str)
    payload = {
        "date": date_str,
        "updated_at": datetime.now(_CST).isoformat(),
        "samples": [
            {
                "t": t_base + i * 60,
                "t_iso": datetime.fromtimestamp(
                    t_base + i * 60, _CST
                ).strftime("%Y-%m-%d %H:%M:%S"),
                "steps": steps,
            }
            for i, steps in enumerate(STEPS_INCREMENTS)
        ],
        "daily_summary": dict(daily_summary),
        "sleep_data": {},
        "device_name": None,
    }
    path = _derived_path(root, date_str)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    return payload


class TestDashboardStepsSemantics:
    """Bug①：dashboard 步数回退必须按增量求和（非差分），日总优先。

    P2-V9：原"save_health_data 生成派生视图后剥离 total_steps"的前置构造
    改为直接预置历史日存量文件（V9 起该文件只以存量形态存在，无分片时
    query 走派生回落——正是本 Bug 回退分支的真实触发场景）。
    """

    def test_dashboard_steps_sum_semantics(
        self, sandbox_root, client, auth_headers
    ):
        # —— 种子：历史日派生文件，steps 增量 [10,20,30]，无 daily_summary ——
        seeded = _seed_derived(sandbox_root, FIXED_DATE, daily_summary={})
        assert seeded is not None, "种子派生视图未生成"
        assert "total_steps" not in (seeded.get("daily_summary") or {}), (
            "前置条件被破坏：daily_summary 不应含 total_steps"
        )
        # 前置：该用户无分片（query 才会回落派生文件走回退分支）
        for source in ("phone", "cloud"):
            assert not os.path.exists(os.path.join(
                sandbox_root, "users", TEST_USER_ID, "health", FIXED_DATE,
                f"{source}.json",
            )), "前置条件被破坏：不应存在分片"

        # —— 断言 1：无日总时按增量求和 = 60（Bug① 差分口径会得 30 -> RED）——
        resp = client.get(
            f"/api/mobile/dashboard?date={FIXED_DATE}", headers=auth_headers
        )
        assert resp.status_code == 200, f"看板请求失败: {resp.status_code} {resp.text}"
        steps = resp.json().get("health", {}).get("steps")
        assert steps == sum(STEPS_INCREMENTS), (
            f"dashboard 步数口径错误: 期望增量求和 {sum(STEPS_INCREMENTS)}，"
            f"实际 {steps}（差分累加会得到 30 —— Bug① 未修复）"
        )

        # —— 断言 2：日总存在时优先读 daily_summary.total_steps = 999 ——
        seeded["daily_summary"] = {"total_steps": 999}
        with open(_derived_path(sandbox_root, FIXED_DATE), "w", encoding="utf-8") as f:
            json.dump(seeded, f, ensure_ascii=False, indent=2)
        # 分片保持缺席：query 回落到派生文件（回落仅主用户/未配置）

        resp2 = client.get(
            f"/api/mobile/dashboard?date={FIXED_DATE}", headers=auth_headers
        )
        assert resp2.status_code == 200, f"看板请求失败: {resp2.status_code}"
        steps2 = resp2.json().get("health", {}).get("steps")
        assert steps2 == 999, (
            f"日总存在时未优先读 daily_summary.total_steps: 期望 999，实际 {steps2}"
        )

