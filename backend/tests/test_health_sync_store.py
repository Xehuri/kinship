# -*- coding: utf-8 -*-
"""
Stage H2 写路径切换 —— 守卫测试（P2-V9 更新：派生视图双写退役）。

目标（V9 语义）：
  1. POST /api/health/sync 只写「源分片」且经 HealthStore；
     export_legacy 双写已退役——写链不得再产生/更新 daily/{date}/health.json
     （V8 前语义为"同时写分片+派生"，V9 起改为"仅分片+派生文件不更新"）
  2. 响应 JSON 形状锁死：{"status","dates","stats"}，stats 为
     {"samples","dates_updated"}（契约守卫，切换前后都必须成立）
  3. 合并语义不变：同 t 样本后写覆盖先写、不同 t 追加；
     daily_summary / sleep_data 字段级 update（dict.update，缺省键保留）
     —— 读取口径改用 query 合成视图（store.read_view 与退役前 export 的
     落盘形状共用 _compose_legacy_locked，逐键一致，断言语义不降级）
  4. health_storage 三个公开签名保持可导入且 kwargs 不变
     （save_health_data / query_health_data / list_health_dates）
  5. device_name 省略时保留已存标签（分片合并语义，V9 后经视图验证）
  6. 睡眠 stage 编码 round-trip：payload 用 Android 数字编码
     2=deep, 3=light, 4=rem, 5=awake（health-data-source-architecture.md 第 9 节
     源 A）；分片（canonical）必须映射为枚举字符串（SleepSegment 拒绝原始数字）；
     读取视图必须输出 canonical 枚举字符串（读取端 ground truth：
     fact_extractor == 'awake' / f'{stage}({t})'；Android 客户端已做码表映射，
     生产 legacy 输入本就是字符串；H4 曾误映射回数字，本测试修正该错误前提）

E2E 载荷严格对齐真实 Android 契约（HealthDataCollector.uploadToBackend）：
  {samples:[{t,hr,steps}], sleep_data:{...stages:[{t:"HH:mm",stage}...]},
   device_name:"X"} —— 不带 daily_summary、不带 battery_levels、不带 user_id。

写入隔离（四重防御，绝不触碰真实 ai/data）：
  1) 配置单例 data.dir 临时指向 tmp_path（调用时读 DATA_DIR 的代码被重定向）
  2) health_storage 模块导入时快照的 _DATA_BASE 指向 tmp_path/daily
  3) 既有模块级 HealthStore 实例的 data_root 强制改指 tmp_path
  4) 新建 HealthStore 的 data_root 一律强制为 tmp_path

懒引导用例保留（V9 后 daily/{date}/health.json 的历史日文件仍是种子源）：
  断言重心从"派生视图被正确更新"移到"种子进分片 + 派生文件保持原样不被更新"。
"""
import inspect
import json
import os
import re
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

from services.health.store import HealthStore

# 东八区（与 health_storage / HealthStore 的时区口径一致）
_CST = timezone(timedelta(hours=8))

# conftest 的 auth_headers 用用户名 "Axeuh" 登录，中间件注入的 user_id 即该用户名
TEST_USER_ID = "Axeuh"

# 读取视图/历史派生文件的顶层键集合（_compose_legacy_locked 口径，不得漂移；
# P2-V9 起派生文件为历史存量只读，新写入经 query 视图呈现同一形状）
LEGACY_TOP_KEYS = {
    "date", "updated_at", "samples", "daily_summary", "sleep_data", "device_name",
}

# Android 数字 stage 编码 -> canonical 枚举（架构文档第 9 节：源 A 2/3/4/5）
STAGE_CODE_TO_ENUM = {2: "deep", 3: "light", 4: "rem", 5: "awake"}

# 本测试使用的数字编码时间线（与上述映射一一对应）
PAYLOAD_STAGE_CODES = [3, 2, 4, 5]
PAYLOAD_STAGE_TIMES = ["00:01", "01:00", "03:00", "05:00"]


def _today_anchor():
    """以当前（东八区）日期为锚：返回 (日期串, 当天 12:00 的 epoch 秒)。

    样本时间固定取当天正午附近，保证：
      - 样本归属日期 == 今天 == sleep_data 的主日期（无 t 字段时取 _today_str）
      - 多个样本 t 单调且不跨日（避免午夜边界歧义）
    """
    now = datetime.now(_CST)
    date_str = now.strftime("%Y-%m-%d")
    noon = now.replace(hour=12, minute=0, second=0, microsecond=0)
    return date_str, int(noon.timestamp())


def _android_payload(t_base, device_name=None, stages=True):
    """构造最小可用的 Android 真实契约载荷。

    不含 daily_summary、不含 battery_levels —— 与
    HealthDataCollector.uploadToBackend() 的实际请求体一致。
    """
    payload: dict[str, Any] = {
        "samples": [
            {"t": t_base, "hr": 70, "steps": 10},
            {"t": t_base + 60, "hr": 72, "steps": 20},
        ],
    }
    if stages:
        payload["sleep_data"] = {
            "duration_min": 400,
            "deep_min": 100,
            "light_min": 180,
            "rem_min": 90,
            "awake_min": 30,
            "stages": [
                {"t": t, "stage": code}
                for t, code in zip(PAYLOAD_STAGE_TIMES, PAYLOAD_STAGE_CODES)
            ],
        }
    if device_name is not None:
        payload["device_name"] = device_name
    return payload


@pytest.fixture
def sandbox_root(tmp_path, monkeypatch):
    """把健康数据的全部写入路径重定向到 tmp_path（禁止写真实 ai/data）。

    四重防御覆盖 H2 前（health_storage 直写 _DATA_BASE）与 H2 后
    （薄外观委派 HealthStore，data_root 可能来自配置或模块级实例）两种实现。
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

    # 3) 既有模块级 HealthStore 实例（防御 H2 在 import 时创建单例）
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


def _post_sync(client, auth_headers, payload):
    """POST /api/health/sync 并返回响应 JSON（断言 HTTP 200）。"""
    resp = client.post("/api/health/sync", json=payload, headers=auth_headers)
    assert resp.status_code == 200, f"同步失败: {resp.status_code} {resp.text}"
    return resp.json()


def _derived_path(root, date_str):
    """派生兼容视图路径：{root}/daily/{date}/health.json。

    P2-V9：写链不再产生该文件；路径仅用于断言"不生成/不更新"。
    """
    return os.path.join(root, "daily", date_str, "health.json")


def _query_view(client, auth_headers, date_str):
    """GET /api/health/query 取合成视图（P2-V9 起的读取口径）。

    store.read_view 与退役前 export_legacy 的落盘共用 _compose_legacy_locked，
    形状逐键一致（另带 status 键）——原派生视图断言全部等价迁移到这里。
    """
    resp = client.get(
        "/api/health/query", params={"date": date_str}, headers=auth_headers
    )
    assert resp.status_code == 200, f"query 失败: {resp.status_code} {resp.text}"
    body = resp.json()
    assert body.get("status") == "ok", f"query 视图无数据: {body}"
    return body


def _shard_path(root, date_str):
    """phone 源分片路径：{root}/users/{user}/health/{date}/phone.json。"""
    return os.path.join(root, "users", TEST_USER_ID, "health", date_str, "phone.json")


def _load_json(path) -> dict[str, Any] | None:
    """读取 JSON 文件（不存在或非 dict 时返回 None）。"""
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    return data if isinstance(data, dict) else None


def _seed_legacy(root, date_str, payload) -> str:
    """直接预置 legacy daily/{date}/health.json（模拟 H2 切换前已存在的历史数据）。

    在 sandbox_root（tmp 重定向路径）上写入，绝不触碰真实 ai/data。
    """
    path = _derived_path(root, date_str)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    return path


def _legacy_samples_with_ts(ts_list) -> list[dict[str, Any]]:
    """按 t 列表生成 legacy 形状样本（含 t_iso，hr/steps 为可区分合成值）。"""
    return [
        {
            "t": t,
            "t_iso": datetime.fromtimestamp(t, _CST).strftime("%Y-%m-%d %H:%M:%S"),
            "hr": 60 + i % 30,
            "steps": 10 + i % 50,
        }
        for i, t in enumerate(ts_list)
    ]


def _legacy_sleep_payload() -> dict[str, Any]:
    """legacy sleep_data：Android 数字编码 stages（与 PAYLOAD_STAGE_* 对齐）。"""
    return {
        "duration_min": 400,
        "deep_min": 100,
        "light_min": 180,
        "rem_min": 90,
        "awake_min": 30,
        "stages": [
            {"t": t, "stage": code}
            for t, code in zip(PAYLOAD_STAGE_TIMES, PAYLOAD_STAGE_CODES)
        ],
    }


class TestResponseContract:
    """用例 1：响应 JSON 形状锁死（H2 切换不得改变对外契约）。"""

    def test_top_level_keys_exact(self, sandbox_root, client, auth_headers):
        date_str, t_base = _today_anchor()
        payload = _android_payload(t_base, device_name="Pixel-Test")

        body = _post_sync(client, auth_headers, payload)

        # 顶层键必须精确匹配，不得增减
        assert set(body.keys()) == {"status", "dates", "stats"}, (
            f"响应顶层键漂移: {sorted(body.keys())}"
        )
        assert body["status"] == "ok"
        # 样本全部归属今天 -> dates 恰为该日期
        assert body["dates"] == [date_str]
        assert all(isinstance(d, str) for d in body["dates"])

        stats = body["stats"]
        # stats 内必有键（契约给出的形状）；允许保留历史既有键（如 stats.dates），
        # H2 的底线是不得删减必有键 —— "响应形状不变"指不破坏而非收窄
        assert "samples" in stats, f"stats 缺少 samples: {sorted(stats.keys())}"
        assert "dates_updated" in stats, (
            f"stats 缺少 dates_updated: {sorted(stats.keys())}"
        )
        assert isinstance(stats["samples"], int)
        assert stats["samples"] == 2  # 载荷 2 条样本
        assert stats["dates_updated"] == [date_str]


class TestShardAndDerivedWrite:
    """用例 2：/sync 只写源分片且经 HealthStore；P2-V9 起派生视图不再产生。"""

    def test_sync_writes_shard_only_no_derived(
        self, sandbox_root, client, auth_headers, monkeypatch
    ):
        date_str, t_base = _today_anchor()

        # 记录 HealthStore 的写入调用（V9：write 必有、export 必无）
        calls = {"write": 0, "export": 0}
        orig_write = HealthStore.write
        orig_export = HealthStore.export_legacy

        def spy_write(self, batch):
            calls["write"] += 1
            return orig_write(self, batch)

        def spy_export(self, user_id, date):
            calls["export"] += 1
            return orig_export(self, user_id, date)

        monkeypatch.setattr(HealthStore, "write", spy_write)
        monkeypatch.setattr(HealthStore, "export_legacy", spy_export)

        payload = _android_payload(t_base, device_name="Pixel-Test")
        body = _post_sync(client, auth_headers, payload)
        assert body["status"] == "ok"

        # 断言 1：源分片存在（H2 起的核心写路径，V9 后仍是唯一落点）
        shard = _shard_path(sandbox_root, date_str)
        assert os.path.exists(shard), (
            f"源分片未生成: {shard} —— /sync 的分片写路径丢失（V9 不得破坏 write）"
        )

        # 断言 2（V9 新语义）：派生视图文件由写链"不产生"
        derived = _derived_path(sandbox_root, date_str)
        assert not os.path.exists(derived), (
            f"派生视图被写链生成: {derived} —— V9 双写已退役，写链不得再 export"
        )

        # 断言 3：write 真实经过 HealthStore、export 零调用
        assert calls["write"] >= 1, (
            "HealthStore.write 未被调用 —— /sync 分片写路径丢失"
        )
        assert calls["export"] == 0, (
            f"HealthStore.export_legacy 被写链调用 {calls['export']} 次 —— "
            "V9 双写退役被破坏"
        )

        # 断言 4：分片基础身份字段正确（source=phone，归属认证用户）
        shard_raw = _load_json(shard)
        assert shard_raw is not None
        assert shard_raw.get("source") == "phone"
        assert shard_raw.get("user_id") == TEST_USER_ID
        assert shard_raw.get("date") == date_str
        assert len(shard_raw.get("samples") or []) == 2


class TestDerivedSchema:
    """用例 3：读取视图结构与既有派生文件完全一致（读取端零改动）。

    P2-V9：形状契约从"export 落盘文件"迁移到"query 合成视图"——
    read_view 与 export_legacy 共用 _compose_legacy_locked，逐键一致。
    """

    def test_query_view_keeps_legacy_schema(
        self, sandbox_root, client, auth_headers
    ):
        date_str, t_base = _today_anchor()
        payload = _android_payload(t_base, device_name="Pixel-Test")
        _post_sync(client, auth_headers, payload)

        # V9：写链不产生派生文件
        assert not os.path.exists(_derived_path(sandbox_root, date_str)), (
            "V9 起写链不应生成派生文件"
        )

        view = _query_view(client, auth_headers, date_str)

        # 顶层键 = 历史直写格式 + status（query 附加键）
        assert set(view.keys()) == LEGACY_TOP_KEYS | {"status"}, (
            f"视图顶层键漂移: {sorted(view.keys())}"
        )
        assert view["date"] == date_str
        assert isinstance(view["updated_at"], str)

        # samples 每项含 t + t_iso（下游按 t_iso 展示）
        samples = view["samples"]
        assert isinstance(samples, list) and len(samples) == 2
        assert all("t" in s and "t_iso" in s for s in samples)

        # daily_summary / sleep_data 为 dict（缺省也不得是 None 以外的坏形状）
        assert isinstance(view["daily_summary"], dict)
        assert isinstance(view["sleep_data"], dict)
        assert view["sleep_data"]["duration_min"] == 400

        # device_name 取自载荷
        assert view["device_name"] == "Pixel-Test"


class TestDeviceNamePreserve:
    """用例 4：device_name 省略时保留已存标签（分片合并语义，经视图验证）。"""

    def test_device_name_preserved_when_omitted(
        self, sandbox_root, client, auth_headers
    ):
        date_str, t_base = _today_anchor()

        # 第一次同步：显式带 device_name
        _post_sync(
            client,
            auth_headers,
            _android_payload(t_base, device_name="PhoneA", stages=False),
        )

        # 第二次同步：不带 device_name（模拟 Android 未自定义设备名时的省略行为）
        second = _android_payload(t_base, stages=False)
        assert "device_name" not in second
        second["samples"] = [{"t": t_base + 120, "hr": 75, "steps": 5}]
        _post_sync(client, auth_headers, second)

        # V9：写链不产生派生文件；label 保留语义验证移到视图（分片合并口径）
        assert not os.path.exists(_derived_path(sandbox_root, date_str)), (
            "V9 起写链不应生成派生文件"
        )
        view = _query_view(client, auth_headers, date_str)
        assert view.get("device_name") == "PhoneA", (
            "省略 device_name 后已存标签被清空 —— "
            "store 分片合并要求保留旧标签（device label 缺省保留）"
        )


class TestSleepStageMapping:
    """用例 5：Android 数字编码在分片中映射为 canonical 枚举（RED）。"""

    def test_sleep_stage_numeric_codes_mapped_in_shard(
        self, sandbox_root, client, auth_headers
    ):
        date_str, t_base = _today_anchor()
        payload = _android_payload(t_base, device_name="Pixel-Test")
        # 确认载荷确实使用数字编码（防漂移）
        codes = [st["stage"] for st in payload["sleep_data"]["stages"]]
        assert codes == PAYLOAD_STAGE_CODES
        assert all(isinstance(c, int) for c in codes)

        _post_sync(client, auth_headers, payload)

        # 分片必须存在（H2 前为红）
        shard = _shard_path(sandbox_root, date_str)
        assert os.path.exists(shard), (
            f"源分片未生成: {shard} —— 无法验证 stage 枚举映射（H2 未实现）"
        )

        shard_raw = _load_json(shard)
        assert shard_raw is not None, "分片文件不可读"
        stages = (shard_raw.get("sleep_data") or {}).get("stages") or []
        assert stages, "分片 sleep_data.stages 为空"

        # canonical 枚举映射：2=deep, 3=light, 4=rem, 5=awake（SleepSegment 拒绝原始数字）
        got_enums = [seg["stage"] for seg in stages]
        expected_enums = [STAGE_CODE_TO_ENUM[c] for c in PAYLOAD_STAGE_CODES]
        assert got_enums == expected_enums, (
            f"分片 stage 枚举映射错误: {got_enums} != {expected_enums}"
        )
        # 每段为 canonical 形状 {start_ts, stage, duration_min}
        for seg in stages:
            assert set(seg.keys()) == {"start_ts", "stage", "duration_min"}, (
                f"分片 stage 段形状漂移: {sorted(seg.keys())}"
            )
            assert isinstance(seg["start_ts"], int)
            assert seg["stage"] in {"deep", "light", "rem", "awake", "unknown"}


class TestSleepRoundtrip:
    """用例 6：睡眠 stages 编码 round-trip + 读取视图可读形状（V9：经 query）。"""

    def test_view_stages_are_canonical_strings(
        self, sandbox_root, client, auth_headers
    ):
        """视图 stage 必须是 canonical 字符串枚举（H4 OQ2 数值映射回归守卫）。

        两条输入路径归一到同一字符串：
          - Android 数字编码 {stage: 3} -> 分片枚举 'light' -> 视图 'light'
          - 生产真实字符串 {stage: 'light'}（Android 客户端已做码表映射）
            -> 分片枚举 'light' -> 视图 'light'
        读取端 ground truth：fact_extractor L1685 判 == 'awake'、L1269 格式化
        f'{stage}({t})' —— 输出数字会让 awake 计数恒 0、格式化成 '3(01:57)'。
        """
        date_str, t_base = _today_anchor()

        # 路径 A：Android 数字编码 3（= light）
        payload_num = _android_payload(t_base, device_name="Pixel-Test")
        payload_num["sleep_data"]["stages"] = [
            {"t": "00:01", "stage": 3},
            {"t": "01:00", "stage": 2},
            {"t": "03:00", "stage": 4},
            {"t": "05:00", "stage": 5},
        ]
        _post_sync(client, auth_headers, payload_num)

        view = _query_view(client, auth_headers, date_str)
        stages = (view.get("sleep_data") or {}).get("stages")
        assert isinstance(stages, list) and stages, "视图 sleep stages 缺失"

        got = [(st["t"], st["stage"]) for st in stages]
        want = [
            ("00:01", "light"),
            ("01:00", "deep"),
            ("03:00", "rem"),
            ("05:00", "awake"),
        ]
        for st in stages:
            assert isinstance(st["stage"], str), (
                f"数字编码输入导出了非字符串 stage: {st['stage']!r}"
            )
            assert st["stage"] in {"deep", "light", "rem", "awake"}, (
                f"stage 非 canonical 枚举: {st['stage']!r}"
            )
        assert got == want, (
            f"数字编码 3/2/4/5 未导出为 canonical 字符串: {got} != {want}"
        )

        # 路径 B：生产真实字符串输入 'light' -> 视图仍为 'light'（字节兼容既有语料）
        payload_str = _android_payload(t_base, device_name="Pixel-Test")
        payload_str["sleep_data"]["stages"] = [
            {"t": "00:01", "stage": "light"},
            {"t": "01:00", "stage": "deep"},
        ]
        _post_sync(client, auth_headers, payload_str)

        view2 = _query_view(client, auth_headers, date_str)
        stages2 = (view2.get("sleep_data") or {}).get("stages")
        assert isinstance(stages2, list) and stages2, "视图 sleep stages 缺失"
        for st in stages2:
            assert isinstance(st["stage"], str), (
                f"字符串输入导出了非字符串 stage: {st['stage']!r}"
            )
            assert st["stage"] in {"deep", "light", "rem", "awake"}, (
                f"stage 非 canonical 枚举: {st['stage']!r}"
            )
        # 字符串输入的两条（00:01/01:00）必须原样保留为字符串枚举
        by_t = {st["t"]: st["stage"] for st in stages2}
        assert by_t.get("00:01") == "light", (
            f"字符串 'light' 输入未原样导出: {by_t.get('00:01')!r}"
        )
        assert by_t.get("01:00") == "deep", (
            f"字符串 'deep' 输入未原样导出: {by_t.get('01:00')!r}"
        )

    def test_sleep_stages_roundtrip_in_view(
        self, sandbox_root, client, auth_headers
    ):
        date_str, t_base = _today_anchor()
        payload = _android_payload(t_base, device_name="Pixel-Test")
        expected_stages = payload["sleep_data"]["stages"]

        _post_sync(client, auth_headers, payload)

        # V9：派生文件不产生，round-trip 断言迁移至 query 视图
        assert not os.path.exists(_derived_path(sandbox_root, date_str)), (
            "V9 起写链不应生成派生文件"
        )
        view = _query_view(client, auth_headers, date_str)
        stages = (view.get("sleep_data") or {}).get("stages")
        assert isinstance(stages, list) and stages, "视图 sleep_data.stages 缺失"

        # 形状契约：list[dict]，每项恰好 {t, stage}，t 为 HH:mm
        # （fact_extractor._section_sleep_stages / health_extractor 的消费形状）
        for st in stages:
            assert isinstance(st, dict)
            assert set(st.keys()) == {"t", "stage"}, (
                f"stage 段键漂移: {sorted(st.keys())}（读取端要求 {{t, stage}}）"
            )
            assert re.fullmatch(r"\d{2}:\d{2}", str(st["t"])), (
                f"stage.t 非 HH:mm: {st['t']!r}"
            )
            assert st["stage"] is not None

        # 数字编码 round-trip：数字进 -> 分片枚举 -> 视图必须输出
        # canonical 枚举字符串（读取端 ground truth：fact_extractor == 'awake'、
        # f'{stage}({t})' 格式化；H4 的 OQ2 曾误映射回数字，此处修正该前提）
        got_pairs = [(st["t"], st["stage"]) for st in stages]
        want_pairs = [
            (t, STAGE_CODE_TO_ENUM[c])
            for t, c in zip(PAYLOAD_STAGE_TIMES, PAYLOAD_STAGE_CODES)
        ]
        assert got_pairs == want_pairs, (
            f"stage 枚举字符串 round-trip 失败: {got_pairs} != {want_pairs}"
            "（期望 3=light/2=deep/4=rem/5=awake 映射入分片后导出为字符串枚举）"
        )
        assert all(
            isinstance(st["stage"], str)
            and st["stage"] in {"deep", "light", "rem", "awake"}
            for st in stages
        ), f"视图 stage 非 canonical 字符串枚举: {[st['stage'] for st in stages]}"

        # 模拟 fact_extractor 的消费路径：按 t 解析分钟 + 读 stage（不得抛异常）
        def _minutes(hm):
            h, m = str(hm).split(":")
            return int(h) * 60 + int(m)

        parsed = [(_minutes(st["t"]), st["stage"]) for st in stages]
        assert len(parsed) == len(expected_stages)


class TestMergeSemantics:
    """用例 7：合并语义不变 —— 同 t 后写覆盖、不同 t 追加（V9：视图口径）。"""

    def test_same_t_replaced_and_new_t_appended(
        self, sandbox_root, client, auth_headers
    ):
        date_str, t_base = _today_anchor()
        t1, t2, t3 = t_base, t_base + 60, t_base + 120

        # 第一批：t1 / t2
        _post_sync(
            client,
            auth_headers,
            {
                "samples": [
                    {"t": t1, "hr": 70, "steps": 10},
                    {"t": t2, "hr": 72, "steps": 20},
                ],
                "device_name": "PhoneA",
            },
        )
        # 第二批：t2 同 t（hr 应被覆盖为 99）+ t3 新 t（应追加）
        _post_sync(
            client,
            auth_headers,
            {
                "samples": [
                    {"t": t2, "hr": 99},
                    {"t": t3, "hr": 75, "steps": 5},
                ],
            },
        )

        # V9：合并结果经 query 视图呈现（写链不产生派生文件）
        assert not os.path.exists(_derived_path(sandbox_root, date_str)), (
            "V9 起写链不应生成派生文件"
        )
        derived = _query_view(client, auth_headers, date_str)
        samples = derived["samples"]
        by_t = {s["t"]: s for s in samples}

        # 同 t 覆盖：t2 只有一条且 hr=99（后写覆盖先写）
        t2_entries = [s for s in samples if s["t"] == t2]
        assert len(t2_entries) == 1, f"同 t 样本未去重: {len(t2_entries)} 条"
        assert by_t[t2]["hr"] == 99, (
            f"同 t 样本未被后写覆盖: hr={by_t[t2]['hr']} != 99"
        )

        # 不同 t 追加：t1 / t2 / t3 全部保留，且按 t 升序
        assert set(by_t.keys()) == {t1, t2, t3}, (
            f"样本 t 集合漂移: {sorted(by_t.keys())}"
        )
        ts_list = [s["t"] for s in samples]
        assert ts_list == sorted(ts_list), "样本未按 t 升序排列"

        # 覆盖后 t1 的原值不受影响
        assert by_t[t1]["hr"] == 70


class TestFieldLevelMerge:
    """用例 8：daily_summary / sleep_data 字段级 update（缺省键保留旧值，V9：视图口径）。"""

    def test_daily_and_sleep_merge_field_level(
        self, sandbox_root, client, auth_headers
    ):
        date_str, t_base = _today_anchor()

        # 第一批：完整 daily + 完整 sleep（含数字编码 stages）
        _post_sync(
            client,
            auth_headers,
            {
                "samples": [{"t": t_base, "hr": 70, "steps": 10}],
                "daily_summary": {"hr_resting": 58, "steps": 500},
                "sleep_data": {
                    "duration_min": 400,
                    "deep_min": 100,
                    "stages": [
                        {"t": t, "stage": code}
                        for t, code in zip(PAYLOAD_STAGE_TIMES, PAYLOAD_STAGE_CODES)
                    ],
                },
                "device_name": "PhoneA",
            },
        )
        # 第二批：只更新部分字段（不带 stages、不带 hr_resting/steps）
        _post_sync(
            client,
            auth_headers,
            {
                "samples": [{"t": t_base + 60, "hr": 71, "steps": 20}],
                "daily_summary": {"hr_avg": 62},
                "sleep_data": {"duration_min": 420},
            },
        )

        # V9：字段级合并在分片层发生，经 query 视图断言（原派生文件口径）
        assert not os.path.exists(_derived_path(sandbox_root, date_str)), (
            "V9 起写链不应生成派生文件"
        )
        derived = _query_view(client, auth_headers, date_str)

        # daily_summary：字段级合并 —— 新字段写入，旧字段保留
        daily = derived["daily_summary"]
        assert daily.get("hr_resting") == 58, "daily_summary 旧字段被清空"
        assert daily.get("steps") == 500, "daily_summary.steps 未保留"
        assert daily.get("hr_avg") == 62, "daily_summary 新字段未写入"

        # sleep_data：字段级合并 —— duration_min 更新，deep_min / stages 保留
        sleep = derived["sleep_data"]
        assert sleep.get("duration_min") == 420, "sleep_data.duration_min 未更新"
        assert sleep.get("deep_min") == 100, "sleep_data.deep_min 未保留"
        stages = sleep.get("stages") or []
        assert len(stages) == len(PAYLOAD_STAGE_CODES), (
            f"sleep_data.stages 未保留: {len(stages)} 段"
        )


class TestPublicSignatures:
    """用例 9：health_storage 三个公开签名保持可导入且 kwargs 不变。"""

    def test_save_health_data_signature(self):
        from services.health_storage import save_health_data

        assert callable(save_health_data)
        params = inspect.signature(save_health_data).parameters
        expected = [
            "samples",
            "daily_summary",
            "battery_levels",
            "sleep_data",
            "user_id",
            "device_name",
        ]
        for name in expected:
            assert name in params, f"save_health_data 缺少参数: {name}"
        # 关键默认值保持（H2 薄外观不得收紧契约）
        assert params["user_id"].default == "default"
        assert params["device_name"].default is None
        assert params["daily_summary"].default is None
        assert params["battery_levels"].default is None
        assert params["sleep_data"].default is None

    def test_query_health_data_signature(self):
        from services.health_storage import query_health_data

        assert callable(query_health_data)
        params = inspect.signature(query_health_data).parameters
        for name in ("date", "user_id"):
            assert name in params, f"query_health_data 缺少参数: {name}"
        assert params["date"].default is None
        assert params["user_id"].default == "default"

    def test_list_health_dates_signature(self):
        from services.health_storage import list_health_dates

        assert callable(list_health_dates)
        params = inspect.signature(list_health_dates).parameters
        assert "user_id" in params, "list_health_dates 缺少参数: user_id"
        assert params["user_id"].default == "default"


class TestLegacyBootstrap:
    """懒引导（H2 正确性守卫，V9 后仍是历史日种子源）：首同步不得丢历史数据。

    场景：daily/{date}/health.json 为 H2~V8 期间的历史存量文件。若该日分片
    尚未建立而文件已有真实数据（如 2026-09-22 的 763 条样本），首同步必须
    先经 _bootstrap_from_legacy_locked 把 legacy 一次性种子进 phone 分片，
    再合并本次写入 —— 历史数据进分片真源、绝不丢失。
    P2-V9：export 双写退役后派生文件"保持原样不被更新"（懒引导只读它）；
    合并结果经 query 视图断言（种子 + 增量全部可见）。
    """

    SEED_COUNT = 200

    def _seed_day(self, root, date_str, t_base, *, with_sleep=True, extra_entries=None):
        """预置 legacy daily/{date}/health.json：SEED_COUNT 条合成样本 + 设备名。"""
        # 历史样本落在当天上午（与正午新增样本 t 互不重叠），t 全部互异
        seed_ts = [t_base - 6 * 3600 + i * 60 for i in range(self.SEED_COUNT)]
        assert len(set(seed_ts)) == self.SEED_COUNT
        payload: dict[str, Any] = {
            "date": date_str,
            "updated_at": datetime.now(_CST).isoformat(),
            "samples": _legacy_samples_with_ts(seed_ts) + list(extra_entries or []),
            "daily_summary": {},
            "sleep_data": _legacy_sleep_payload() if with_sleep else {},
            "device_name": "OldPhone",
        }
        _seed_legacy(root, date_str, payload)
        return seed_ts

    def _assert_derived_untouched(self, root, date_str, snapshot: dict):
        """V9 核心守卫：写链懒引导只读派生文件，绝不再原子替换它。"""
        current = _load_json(_derived_path(root, date_str))
        assert current == snapshot, (
            "派生视图文件被写链更新 —— V9 双写退役被破坏（应只读种子源）"
        )

    def test_first_sync_seeds_history_into_shard_derived_untouched(
        self, sandbox_root, client, auth_headers
    ):
        """首同步：预置 200 条 legacy + 2 条新增 -> 分片 202 条、派生文件原样。"""
        date_str, t_base = _today_anchor()
        seed_ts = self._seed_day(sandbox_root, date_str, t_base)
        seeded_snapshot = _load_json(_derived_path(sandbox_root, date_str))
        assert seeded_snapshot is not None, "预置的 legacy 派生文件应存在"

        # 分片必须缺席（懒引导的前提：分片尚未成为真源）
        assert not os.path.exists(_shard_path(sandbox_root, date_str)), (
            "前置条件被破坏：phone 分片不应存在"
        )

        # 首次真实同步：只带 2 条新样本（t 与历史 200 条互异），不带
        # device_name / sleep_data —— 标签与睡眠必须从 legacy 种子保留
        new_ts = [t_base, t_base + 60]
        assert not set(new_ts) & set(seed_ts)
        _post_sync(
            client,
            auth_headers,
            {"samples": [{"t": t, "hr": 70, "steps": 10} for t in new_ts]},
        )

        # 断言 1：分片 = 200 历史 + 2 新增 = 202 条互异 t（缺任何一条即丢史事故）
        shard_raw = _load_json(_shard_path(sandbox_root, date_str))
        assert shard_raw is not None, "首同步后 phone 分片应存在（种子落盘）"
        got_ts = [s["t"] for s in shard_raw.get("samples") or []]
        assert len(got_ts) == len(set(got_ts)), (
            f"分片出现重复 t: {len(got_ts)} 条 / {len(set(got_ts))} 互异"
        )
        assert set(got_ts) == set(seed_ts) | set(new_ts), (
            f"首同步未保留历史样本: 期望 202 条互异 t，实际 {len(set(got_ts))} 条"
        )
        assert len(got_ts) == self.SEED_COUNT + 2

        # 断言 2：派生文件字节级原样（V9：写链不再 export 覆盖）
        self._assert_derived_untouched(sandbox_root, date_str, seeded_snapshot)

        # 断言 3：query 视图（分片合成）呈现完整合并结果
        view = _query_view(client, auth_headers, date_str)
        assert {s["t"] for s in view["samples"]} == set(seed_ts) | set(new_ts)

        # device_name 从 legacy 种子保留（payload 未带 -> 不得清空）
        assert view.get("device_name") == "OldPhone", (
            f"device_name 未保留: {view.get('device_name')!r}"
        )

        # sleep stages 为视图 {t: HH:mm, stage: 字符串枚举} 形状（读取端 ground
        # truth：fact_extractor 判 == 'awake'、f'{stage}({t})'；种子的数字编码经
        # 分片 canonical 化后导出为枚举字符串，H4 曾误断言 int）
        stages = (view.get("sleep_data") or {}).get("stages")
        assert isinstance(stages, list) and stages, "视图 sleep stages 缺失"
        want_pairs = [
            (t, STAGE_CODE_TO_ENUM[c])
            for t, c in zip(PAYLOAD_STAGE_TIMES, PAYLOAD_STAGE_CODES)
        ]
        got_pairs = []
        for st in stages:
            assert isinstance(st, dict)
            assert set(st.keys()) == {"t", "stage"}, (
                f"stage 段键漂移: {sorted(st.keys())}"
            )
            assert isinstance(st["stage"], str), (
                f"stage 非字符串枚举: {st['stage']!r}"
            )
            assert st["stage"] in {"deep", "light", "rem", "awake"}, (
                f"stage 非 canonical 枚举: {st['stage']!r}"
            )
            got_pairs.append((st["t"], st["stage"]))
        assert got_pairs == want_pairs, (
            f"stages 枚举字符串漂移: {got_pairs} != {want_pairs}"
        )

    def test_bootstrap_runs_once(self, sandbox_root, client, auth_headers):
        """二次同步：种子只发生一次（分片落盘后永久跳过），不重复导入 200 条。"""
        date_str, t_base = _today_anchor()
        seed_ts = self._seed_day(sandbox_root, date_str, t_base)
        seeded_snapshot = _load_json(_derived_path(sandbox_root, date_str))

        # 第一次同步：2 条新增（触发懒引导种子 -> 分片建立）
        first_ts = [t_base, t_base + 60]
        _post_sync(
            client,
            auth_headers,
            {"samples": [{"t": t, "hr": 70, "steps": 10} for t in first_ts]},
        )
        shard = _shard_path(sandbox_root, date_str)
        assert os.path.exists(shard), "首同步后 phone 分片应存在（种子落盘）"

        # 第二次同步：再增 1 条 —— 分片非空，bootstrap 必须跳过
        third_t = t_base + 120
        _post_sync(
            client,
            auth_headers,
            {"samples": [{"t": third_t, "hr": 72, "steps": 20}]},
        )

        # 派生文件全程原样（V9：两次同步都不应触碰它）
        self._assert_derived_untouched(sandbox_root, date_str, seeded_snapshot)

        # 分片：200 历史 + 3 新增 = 203 条互异 t（种子重复执行会引入重复条目，
        # 故同时用 len == len(set) 双保险抓重复）
        shard_raw = _load_json(shard)
        assert shard_raw is not None, "phone 分片不可读"
        shard_ts = [s["t"] for s in shard_raw.get("samples") or []]
        assert len(shard_ts) == len(set(shard_ts)), (
            f"分片出现重复 t（种子被执行多次）: {len(shard_ts)} 条 / "
            f"{len(set(shard_ts))} 互异"
        )
        assert set(shard_ts) == set(seed_ts) | set(first_ts) | {third_t}, (
            f"二次同步后 t 集合漂移: 期望 {self.SEED_COUNT + 3} 条，"
            f"实际 {len(set(shard_ts))} 条"
        )
        assert len(shard_ts) == self.SEED_COUNT + 3

        # query 视图同口径：203 条互异
        view = _query_view(client, auth_headers, date_str)
        assert len({s["t"] for s in view["samples"]}) == self.SEED_COUNT + 3

    def test_bootstrap_battery_split(self, sandbox_root, client, auth_headers):
        """legacy 把电量混入 samples（{t,t_iso,battery}）：种子须拆回分片电量表；
        视图再并回 samples，不崩溃、不丢普通样本；派生文件保持原样。"""
        date_str, t_base = _today_anchor()

        # 预置 legacy：2 条普通样本 + 1 条电量条目（与普通样本 t 互异）
        seed_ts = [t_base - 6 * 3600, t_base - 6 * 3600 + 60]
        t_batt = t_base - 6 * 3600 + 120
        battery_entry = {
            "t": t_batt,
            "t_iso": datetime.fromtimestamp(t_batt, _CST).strftime(
                "%Y-%m-%d %H:%M:%S"
            ),
            "battery": 88,
        }
        _seed_legacy(
            sandbox_root,
            date_str,
            {
                "date": date_str,
                "updated_at": datetime.now(_CST).isoformat(),
                "samples": _legacy_samples_with_ts(seed_ts) + [battery_entry],
                "daily_summary": {},
                "sleep_data": {},
                "device_name": "OldPhone",
            },
        )
        seeded_snapshot = _load_json(_derived_path(sandbox_root, date_str))

        # 同步 1 条新样本（走 write -> bootstrap 拆分全链路，不得崩）
        t_new = t_base
        assert t_new not in set(seed_ts) | {t_batt}
        _post_sync(
            client,
            auth_headers,
            {"samples": [{"t": t_new, "hr": 71, "steps": 15}]},
        )

        # 分片：电量条目已拆回 battery_levels（种子拆分正确性的真源断言）
        shard_raw = _load_json(_shard_path(sandbox_root, date_str))
        assert shard_raw is not None, "phone 分片应存在"
        batt_shard = shard_raw.get("battery_levels") or []
        assert len(batt_shard) == 1 and batt_shard[0]["t"] == t_batt, (
            f"电量条目未拆回分片 battery_levels: {batt_shard}"
        )
        assert batt_shard[0].get("level") == 88
        shard_ts = {s["t"] for s in shard_raw.get("samples") or []}
        assert shard_ts == set(seed_ts) | {t_new}, (
            f"分片普通样本漂移: {sorted(shard_ts)}"
        )

        # 派生文件原样（V9：写链不 export）
        self._assert_derived_untouched(sandbox_root, date_str, seeded_snapshot)

        # 视图：电量条目以 legacy 形状（含 battery 键）并回 samples
        view = _query_view(client, auth_headers, date_str)
        entries = view["samples"]
        batt_entries = [e for e in entries if e.get("battery") is not None]
        assert len(batt_entries) == 1, (
            f"视图电量条目数异常: {len(batt_entries)} != 1（{batt_entries}）"
        )
        assert batt_entries[0]["t"] == t_batt
        assert batt_entries[0]["battery"] == 88
        assert isinstance(batt_entries[0].get("t_iso"), str), "电量条目缺 t_iso"

        # 全部样本在场：2 历史普通 + 1 新增普通 + 1 电量 = 4 条互异 t
        got_ts = [e["t"] for e in entries]
        assert len(got_ts) == len(set(got_ts)), "视图出现重复 t"
        assert set(got_ts) == set(seed_ts) | {t_new, t_batt}, (
            f"样本集合漂移: 实际 {sorted(got_ts)}"
        )
        # 普通样本（无 battery 键）应为 3 条
        normal = [e for e in entries if e.get("battery") is None]
        assert len(normal) == 3, f"普通样本数异常: {len(normal)} != 3"

    def test_no_legacy_no_bootstrap(
        self, sandbox_root, client, auth_headers
    ):
        """无 legacy 回归：分片与 legacy 双缺时 bootstrap 跳过，只写入本次载荷。

        TestShardAndDerivedWrite 覆盖了「经 HealthStore 写」的主路径；本用例
        额外锁死「无历史时不得出现幻影种子数据」——视图条目数 == 载荷条目数，
        且 V9 起写链不得凭空生成派生文件。
        """
        date_str, t_base = _today_anchor()
        # 前置：legacy 不存在
        assert not os.path.exists(_derived_path(sandbox_root, date_str))

        payload = _android_payload(t_base, device_name="Pixel-Test")
        _post_sync(client, auth_headers, payload)

        # 派生文件仍不存在（V9：写链不产生）
        assert not os.path.exists(_derived_path(sandbox_root, date_str)), (
            "V9 起写链不应生成派生文件"
        )

        view = _query_view(client, auth_headers, date_str)
        got_ts = [s["t"] for s in view["samples"]]
        # 恰为载荷 2 条，无 legacy 种子引入的额外条目
        assert set(got_ts) == {t_base, t_base + 60}, (
            f"无 legacy 时出现幻影样本: {sorted(got_ts)}"
        )
        assert len(got_ts) == 2
        assert view.get("device_name") == "Pixel-Test"
        # 分片照常建立（bootstrap 未种子，write 正常落盘）
        shard_raw = _load_json(_shard_path(sandbox_root, date_str))
        assert shard_raw is not None, "phone 分片未生成"
        assert len(shard_raw.get("samples") or []) == 2
