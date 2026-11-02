# -*- coding: utf-8 -*-
"""
Stage H6 —— 健康数据多用户物理隔离验收（A5）+ 缺 user_id 拒绝 + 设备注册表自动建档。

锁定（架构 health-data-source-architecture.md §5.5 / §7 / §12-A5 / 风险 7）：
  1. 两个不同 user_id 经 TestClient 写入同一天 → 分片分别落
     users/{user}/health/{date}/phone.json，内容互不可串，绝不写 users/default/
  2. 各自 GET /api/health/query 互不可见（读自己分片合成；非主用户分片缺失
     即 empty，不回落共享派生视图 —— 防跨用户泄露）
  3. request.state.user_id 缺失（中间件放行但注入 None）→ 现存健康端点
     （/sync、/query）全部 401 拒绝（health.py _require_user_id），绝不静默
     降级 default
  4. POST /api/health/sync 首见 device_name 自动登记设备注册表
     （owner = 认证用户，幂等 upsert，first_seen 保留）；分片内嵌 device 块
  5. P2-V9 语义：写链不再产生派生视图（export 双写退役）——分片与 query
     视图天然按用户隔离；历史日派生存量文件仍仅主用户可回落读（A5 防泄露
     守卫不回归，非主用户无分片即 empty）

注：源选择 GET/PUT /api/health/source 端点与 dates/upload-db 端点已随 P0 裁剪
删除（原 TestSourceSelectionPerUser 整类、dates 互不可见用例移除）；
/sync 仍读运行时选择文件，_redirect_runtime_files 夹具保留以隔离。

运行时文件（源选择 / 设备注册表）与健康数据写入全部重定向到 tmp_path：
  - 源选择：本文件 autouse monkeypatch routers.health._selection_path
  - 设备注册表：conftest._redirect_device_registry autouse（同一 tmp_path）
  - 健康数据：sandbox_root 四重防御（与 H2/H3/H5 测试同口径）
"""
import hashlib
import json
import os
from datetime import datetime, timedelta, timezone

import pytest

import auth as auth_mod
from config.config import get_config
from services.health.store import HealthStore

# 东八区（与 health_storage / HealthStore 口径一致）
_CST = timezone(timedelta(hours=8))

# 用户 A = conftest auth_headers 登录的用户名（同时是 health.primary_user）
TEST_USER_A = "Axeuh"
# 用户 B = 本文件局部创建的第二账号（用后清理）
TEST_USER_B = "H6UserB"
PASSWORD_B = "h6pass123"

# 固定测试日期（未来日期，沙箱内无历史文件干扰）
FIXED_DATE = "2030-02-02"

# 读取视图/历史派生文件的顶层键集合（_compose_legacy_locked 口径；
# P2-V9 起写链不再产生派生文件，视图契约按用户隔离后仍须含这些键）
LEGACY_TOP_KEYS = {
    "date", "updated_at", "samples", "daily_summary", "sleep_data", "device_name",
}


# ============================================================
# 夹具
# ============================================================

@pytest.fixture(autouse=True)
def _redirect_runtime_files(tmp_path, monkeypatch):
    """源选择运行时文件重定向到 tmp_path（仿 health.py:_selection_path 测试手法）；
    设备注册表由 conftest autouse 重定向到同一 tmp_path。"""
    import routers.health as health_router
    monkeypatch.setattr(
        health_router, "_selection_path",
        lambda: str(tmp_path / "health_source_selection.json"),
    )


@pytest.fixture(autouse=True)
def _fixed_health_config(monkeypatch):
    """固定 health 配置节：主用户 = A，默认 exclusive/phone。

    不依赖真实 config.yaml（保证 primary_user 派生视图断言自洽）；
    store 按 data_root 缓存，sandbox 每测试新 root -> 构造时读到本夹具值。
    """
    cfg = get_config()
    monkeypatch.setitem(cfg._data, "health", {
        "primary_user": TEST_USER_A,
        "source_mode": "exclusive",
        "default_source": "phone",
    })


@pytest.fixture
def sandbox_root(tmp_path, monkeypatch):
    """健康数据写入四重防御（与 H2/H3/H5 测试同口径，绝不触碰真实 ai/data）。"""
    import config.config as cc
    import services.health as hp
    import services.health_storage as hs

    root = str(tmp_path)

    # 1) 配置单例 data.dir 指向 tmp
    cfg = cc.get_config()
    monkeypatch.setitem(
        cfg._data, "data", {**(cfg._data.get("data") or {}), "dir": root}
    )
    # 2) health_storage 导入时快照的派生视图基目录
    monkeypatch.setattr(hs, "_DATA_BASE", os.path.join(root, "daily"))
    # 3) 既有模块级 HealthStore 实例
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


@pytest.fixture
def auth_headers_b(client):
    """创建第二用户 H6UserB 并登录，返回其 Bearer 头（用后清理用户与 token）。"""
    pw_hash = hashlib.sha256(PASSWORD_B.encode()).hexdigest()
    cfg = auth_mod._auth_config
    cfg.users[TEST_USER_B] = auth_mod.UserInfo(
        password_hash=pw_hash, display_name=TEST_USER_B,
    )
    created_tokens = []
    try:
        resp = client.post(
            "/login", json={"username": TEST_USER_B, "password": PASSWORD_B}
        )
        assert resp.status_code == 200, f"第二用户登录失败: {resp.text} {resp.content}"
        data = resp.json()
        assert data.get("success") is True, f"第二用户登录失败: {data}"
        created_tokens.append(data["token"])
        yield {"Authorization": f"Bearer {data['token']}"}
    finally:
        cfg.users.pop(TEST_USER_B, None)
        for tk in created_tokens:
            cfg.tokens.pop(tk, None)


# ============================================================
# 工具
# ============================================================

def _noon_ts(date_str: str, hour: int = 12) -> int:
    """指定日期（东八区）整点 epoch 秒。"""
    dt = datetime.strptime(date_str, "%Y-%m-%d").replace(
        hour=hour, minute=0, second=0, microsecond=0
    )
    return int(dt.replace(tzinfo=_CST).timestamp())


def _load_json(path):
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    return data if isinstance(data, dict) else None


def _shard_path(root, user_id, date_str, source="phone"):
    return os.path.join(
        root, "users", user_id, "health", date_str, f"{source}.json"
    )


def _derived_path(root, date_str):
    return os.path.join(root, "daily", date_str, "health.json")


def _post_sync(client, headers, *, t, hr, device_name):
    resp = client.post(
        "/api/health/sync",
        json={"samples": [{"t": t, "hr": hr}], "device_name": device_name},
        headers=headers,
    )
    assert resp.status_code == 200, f"sync 失败: {resp.status_code} {resp.text}"
    return resp.json()


def _write_two_users_same_day(client, auth_headers, auth_headers_b):
    """A/B 各写同一天一个可区分样本，返回 (t_a, t_b)。"""
    t_a = _noon_ts(FIXED_DATE, 10)
    t_b = _noon_ts(FIXED_DATE, 11)
    _post_sync(client, auth_headers, t=t_a, hr=70, device_name="H6-PhoneA")
    _post_sync(client, auth_headers_b, t=t_b, hr=99, device_name="H6-PhoneB")
    return t_a, t_b


# ============================================================
# 1. 分片物理隔离（A5 前半：文件系统落点）
# ============================================================

class TestShardIsolation:
    """两个 user_id 写同一天 -> 分片分别落各自 users/{user}/... 目录。"""

    def test_two_users_same_day_separate_shards(
        self, sandbox_root, client, auth_headers, auth_headers_b
    ):
        t_a, t_b = _write_two_users_same_day(
            client, auth_headers, auth_headers_b
        )

        shard_a = _shard_path(sandbox_root, TEST_USER_A, FIXED_DATE)
        shard_b = _shard_path(sandbox_root, TEST_USER_B, FIXED_DATE)
        assert os.path.exists(shard_a), f"A 分片缺失: {shard_a}"
        assert os.path.exists(shard_b), f"B 分片缺失: {shard_b}"

        raw_a = _load_json(shard_a)
        raw_b = _load_json(shard_b)
        assert raw_a["user_id"] == TEST_USER_A
        assert raw_b["user_id"] == TEST_USER_B

        ts_a = {s["t"] for s in raw_a.get("samples") or []}
        ts_b = {s["t"] for s in raw_b.get("samples") or []}
        assert t_a in ts_a and t_b not in ts_a, (
            f"A 分片混入 B 样本: {sorted(ts_a)}（期望仅 {t_a}）"
        )
        assert t_b in ts_b and t_a not in ts_b, (
            f"B 分片混入 A 样本: {sorted(ts_b)}（期望仅 {t_b}）"
        )

        # 绝不静默写 users/default/
        assert not os.path.exists(
            os.path.join(sandbox_root, "users", "default")
        ), "出现 users/default/ —— 存在静默降级写入"

    def test_shard_embeds_device_block(
        self, sandbox_root, client, auth_headers
    ):
        """分片内嵌 device 块可回溯源（架构 §7；store.write 已带 device）。"""
        t = _noon_ts(FIXED_DATE, 10)
        _post_sync(client, auth_headers, t=t, hr=71, device_name="H6-Trace")

        raw = _load_json(_shard_path(sandbox_root, TEST_USER_A, FIXED_DATE))
        device = raw.get("device") or {}
        assert device.get("device_id") == "H6-Trace"
        assert device.get("label") == "H6-Trace"
        assert device.get("kind") == "phone"
        assert device.get("owner_user_id") == TEST_USER_A
        assert device.get("source_id") == "phone"


# ============================================================
# 2. query 互不可见（A5 后半：读路径隔离）
# ============================================================

class TestQueryMutuallyInvisible:
    """各自 GET /api/health/query 只见自己的数据。"""

    def test_query_isolation_same_day(
        self, sandbox_root, client, auth_headers, auth_headers_b
    ):
        t_a, t_b = _write_two_users_same_day(
            client, auth_headers, auth_headers_b
        )

        qa = client.get(
            "/api/health/query", params={"date": FIXED_DATE},
            headers=auth_headers,
        )
        qb = client.get(
            "/api/health/query", params={"date": FIXED_DATE},
            headers=auth_headers_b,
        )
        assert qa.status_code == 200, qa.text
        assert qb.status_code == 200, qb.text
        body_a, body_b = qa.json(), qb.json()
        assert body_a["status"] == "ok", body_a
        assert body_b["status"] == "ok", body_b

        ts_a = {s["t"] for s in body_a.get("samples") or []}
        ts_b = {s["t"] for s in body_b.get("samples") or []}
        assert t_a in ts_a and t_b not in ts_a, (
            f"A query 可见 B 的样本（隔离失效）: A={sorted(ts_a)}"
        )
        assert t_b in ts_b and t_a not in ts_b, (
            f"B query 可见 A 的样本（隔离失效）: B={sorted(ts_b)}"
        )
        hrs_a = {s.get("hr") for s in body_a.get("samples") or []}
        hrs_b = {s.get("hr") for s in body_b.get("samples") or []}
        assert 99 not in hrs_a, f"A query 泄露 B 的 hr=99: {hrs_a}"
        assert 70 not in hrs_b, f"B query 泄露 A 的 hr=70: {hrs_b}"

    def test_non_primary_empty_when_no_own_shard(
        self, sandbox_root, client, auth_headers, auth_headers_b
    ):
        """非主用户无自己分片时返回 empty —— 不回落共享派生视图（防泄露）。

        P2-V9：派生文件不再由写链产生，本用例按生产实际直接预置历史日
        存量文件（H2~V8 期间导出），验证 B 依旧不得借回落读到主用户数据。
        """
        path = _derived_path(sandbox_root, FIXED_DATE)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "date": FIXED_DATE,
                    "updated_at": datetime.now(_CST).isoformat(),
                    "samples": [{
                        "t": _noon_ts(FIXED_DATE, 10), "t_iso": "2030-02-02 10:00:00",
                        "hr": 70,
                    }],
                    "daily_summary": {},
                    "sleep_data": {},
                    "device_name": "H6-PhoneA",
                },
                f,
                ensure_ascii=False,
            )
        # B 从未写过该日（分片缺席是回落守卫的前提）
        assert not os.path.exists(_shard_path(sandbox_root, TEST_USER_B, FIXED_DATE))

        qb = client.get(
            "/api/health/query", params={"date": FIXED_DATE},
            headers=auth_headers_b,
        )
        assert qb.status_code == 200, qb.text
        body = qb.json()
        assert body["status"] == "empty", (
            f"非主用户无分片应回 empty，实际 {body} —— 回落共享派生视图会泄露主用户数据"
        )
        assert not body.get("samples"), f"empty 响应不得携带样本: {body}"


# ============================================================
# 3. 缺 user_id 即拒（现存端点 401，绝不落 users/default/）
# ============================================================

class TestMissingUserIdRejected:
    """中间件放行但 user_id 缺失 -> health.py 全端点 401。"""

    def test_active_endpoints_reject_missing_user_id(
        self, sandbox_root, client, auth_headers, monkeypatch
    ):
        # 模拟“token 有效但身份缺失”的异常注入（中间件写入 None）
        monkeypatch.setattr(
            "middleware.auth_middleware.verify_token_full",
            lambda token: (True, None, "user", ""),
        )

        cases = [
            ("POST", "/api/health/sync", {"json": {"samples": []}}),
            ("GET", "/api/health/query", {}),
        ]
        for method, path, kwargs in cases:
            resp = client.request(method, path, headers=auth_headers, **kwargs)
            assert resp.status_code == 401, (
                f"{method} {path} 缺 user_id 应 401，实际 {resp.status_code}: "
                f"{resp.text[:300]}"
            )

        # 绝不静默写入 users/default/，也不产生任何用户分片
        users_root = os.path.join(sandbox_root, "users")
        if os.path.isdir(users_root):
            assert "default" not in os.listdir(users_root), (
                f"缺 user_id 的请求写出了 users/default/: {os.listdir(users_root)}"
            )

    def test_missing_user_id_rejects_sync_write(
        self, sandbox_root, client, auth_headers, monkeypatch
    ):
        """sync 写路径专项：被拒后无任何分片落盘。"""
        monkeypatch.setattr(
            "middleware.auth_middleware.verify_token_full",
            lambda token: (True, None, "user", ""),
        )
        resp = client.post(
            "/api/health/sync",
            json={
                "samples": [{"t": _noon_ts(FIXED_DATE), "hr": 60}],
                "device_name": "H6-RejectMe",
            },
            headers=auth_headers,
        )
        assert resp.status_code == 401, resp.text
        # 无任何用户目录产生
        users_root = os.path.join(sandbox_root, "users")
        assert not os.path.isdir(users_root) or not os.listdir(users_root), (
            "被 401 拒绝的 sync 仍写出了用户分片"
        )


# ============================================================
# 4. 设备注册表自动建档（架构 §7）
# ============================================================

class TestDeviceRegistryAutoRegister:
    """/api/health/sync 首见 device_name -> health_devices.json 幂等建档。"""

    def _registry(self, tmp_path):
        path = tmp_path / "health_devices.json"
        if not path.exists():
            return None, path
        return _load_json(str(path)), path

    def test_sync_auto_registers_device(
        self, sandbox_root, client, auth_headers, tmp_path
    ):
        t = _noon_ts(FIXED_DATE, 10)
        _post_sync(client, auth_headers, t=t, hr=70, device_name="H6AutoPhone")

        data, path = self._registry(tmp_path)
        assert data is not None, f"设备注册表未生成: {path}"
        assert "H6AutoPhone" in data, f"首见 device_name 未建档: {list(data)}"
        entry = data["H6AutoPhone"]
        assert entry["owner_user_id"] == TEST_USER_A, (
            f"owner 应为认证用户: {entry}"
        )
        assert entry["kind"] == "phone"
        assert entry["source_id"] == "phone"
        assert entry.get("first_seen"), "缺 first_seen"
        assert entry.get("last_seen"), "缺 last_seen"

    def test_register_is_idempotent(
        self, sandbox_root, client, auth_headers, tmp_path
    ):
        """重复同步同设备：不新增键，first_seen 保留（幂等 upsert）。"""
        t = _noon_ts(FIXED_DATE, 10)
        _post_sync(client, auth_headers, t=t, hr=70, device_name="H6Idem")
        data1, _ = self._registry(tmp_path)
        first_seen = data1["H6Idem"]["first_seen"]

        _post_sync(
            client, auth_headers,
            t=t + 60, hr=71, device_name="H6Idem",
        )
        data2, _ = self._registry(tmp_path)
        assert set(data2.keys()) == {"H6Idem"}, (
            f"幂等破坏：出现多余键 {set(data2.keys())}"
        )
        assert data2["H6Idem"]["first_seen"] == first_seen, (
            "重复注册改写了 first_seen"
        )

    def test_second_user_device_owned_by_second_user(
        self, sandbox_root, client, auth_headers, auth_headers_b, tmp_path
    ):
        """B 的设备以 B 为 owner 建档（owner = 认证用户，而非 default）。"""
        t = _noon_ts(FIXED_DATE, 11)
        _post_sync(
            client, auth_headers_b,
            t=t, hr=99, device_name="H6-PhoneB",
        )
        data, _ = self._registry(tmp_path)
        assert data is not None and "H6-PhoneB" in data
        assert data["H6-PhoneB"]["owner_user_id"] == TEST_USER_B, (
            f"B 的设备 owner 应为 {TEST_USER_B}: {data['H6-PhoneB']}"
        )
        # 注册表中绝不出现 default 属主
        for dev_id, entry in data.items():
            assert entry.get("owner_user_id") != "default", (
                f"注册表出现 default 属主: {dev_id} -> {entry}"
            )


# ============================================================
# 5. 写链零派生 + 视图按用户隔离（P2-V9 新语义）
# ============================================================

class TestPrimaryUserDerivedView:
    """P2-V9：A/B 写入均不产生/更新派生文件；隔离由分片 + query 视图保证。

    原语义（V9 前）：A 写生成派生视图（主用户兼容），B 写不得混入该文件。
    新语义（V9 后）：写链 export 退役 -> 派生文件全程不存在；"不污染"升级为
    "根本不产生"，跨用户隔离断言迁移到 query 视图（A 不见 B、B 不见 A）。
    """

    def test_writes_never_produce_derived_view(
        self, sandbox_root, client, auth_headers, auth_headers_b
    ):
        t_a = _noon_ts(FIXED_DATE, 10)
        t_b = _noon_ts(FIXED_DATE, 11)

        _post_sync(client, auth_headers, t=t_a, hr=70, device_name="H6-PhoneA")
        assert not os.path.exists(_derived_path(sandbox_root, FIXED_DATE)), (
            "主用户写入后出现了派生文件 —— V9 双写退役被破坏"
        )

        _post_sync(client, auth_headers_b, t=t_b, hr=99, device_name="H6-PhoneB")
        assert os.path.exists(
            _shard_path(sandbox_root, TEST_USER_B, FIXED_DATE)
        ), "B 的分片未落盘"
        assert not os.path.exists(_derived_path(sandbox_root, FIXED_DATE)), (
            "非主用户写入后出现了派生文件 —— V9 双写退役被破坏"
        )

        # 隔离经视图验证：A 只见自己、B 只见自己（原派生文件不污染断言的迁移）
        qa = client.get(
            "/api/health/query", params={"date": FIXED_DATE}, headers=auth_headers
        )
        qb = client.get(
            "/api/health/query", params={"date": FIXED_DATE}, headers=auth_headers_b
        )
        body_a, body_b = qa.json(), qb.json()
        assert body_a["status"] == "ok" and body_b["status"] == "ok"

        ts_a = {s["t"] for s in body_a.get("samples") or []}
        ts_b = {s["t"] for s in body_b.get("samples") or []}
        assert ts_a == {t_a}, f"A 视图样本集合漂移: {sorted(ts_a)}"
        assert ts_b == {t_b}, f"B 视图样本集合漂移: {sorted(ts_b)}"
        hrs_a = {s.get("hr") for s in body_a.get("samples") or []}
        assert 99 not in hrs_a, f"A 视图泄露 B 的 hr: {hrs_a}"

        # 视图形状仍兼容历史派生键集（读取端零改动契约，另带 status 键）
        assert LEGACY_TOP_KEYS <= set(body_a.keys()), (
            f"视图键集漂移: {sorted(body_a.keys())}"
        )

    def test_primary_user_still_reads_derived_fallback(
        self, sandbox_root, client, auth_headers
    ):
        """主用户分片缺失时可回落派生视图（legacy 兼容路径不回归）。"""
        from services.health_storage import query_health_data
        import config.config as cc
        import services.health as hp
        import services.health_storage as hs

        # 预置派生视图（模拟迁移边缘：只有 legacy、无分片）
        date_str = "2030-02-05"
        path = _derived_path(sandbox_root, date_str)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        legacy = {
            "date": date_str,
            "updated_at": datetime.now(_CST).isoformat(),
            "samples": [{
                "t": _noon_ts(date_str, 9),
                "t_iso": "2030-02-05 09:00:00",
                "hr": 66,
            }],
            "daily_summary": {},
            "sleep_data": {},
            "device_name": "LegacyPhone",
        }
        with open(path, "w", encoding="utf-8") as f:
            json.dump(legacy, f, ensure_ascii=False)

        # 分片确认缺席
        assert not os.path.exists(
            _shard_path(sandbox_root, TEST_USER_A, date_str)
        )

        out = query_health_data(date=date_str, user_id=TEST_USER_A)
        assert out["status"] == "ok", out
        assert [s["hr"] for s in out["samples"]] == [66], (
            f"主用户回落派生视图失败: {out}"
        )
