# -*- coding: utf-8 -*-
"""
Stage H5 —— 健康数据源选择机制（TDD：先测试，后实现）。

覆盖：
  1. exclusive-409：运行时 mode==exclusive 且 source != primary -> HTTP 409，
     错误体走全局 handler 的 {"success":false,"error":{"code","message"}} 形状，
     message 含主源提示。
  2. merge-allows-both：mode==merge 时 phone 与 cloud 同日各写各分片共存。
  3. config @property：HEALTH_SOURCE_MODE/HEALTH_DEFAULT_SOURCE/
     HEALTH_CLOUD_POLL_INTERVAL_MIN/HEALTH_CLOUD_USERID/HEALTH_CLOUD_PASSTOKEN
     默认值与读取。

注：GET/PUT /api/health/source 端点已随 P0 旁路清理删除（原 TestSourceSelectionApi
整类移除）。merge/切回 exclusive 场景改为直接写运行时选择文件（与
_effective_selection 读取口径一致的结构 {user_id:{primary,mode}}）。

运行时文件（源选择 / 设备注册表）一律重定向到 tmp_path，禁止污染 backend/data/。
写入隔离沿用四重防御（配置 data.dir / _DATA_BASE / 既有 store / 新建 store）。
"""
import json
import os
from datetime import datetime, timedelta, timezone

import pytest

from config.config import get_config
from services.health.store import HealthStore

# 东八区
_CST = timezone(timedelta(hours=8))
TEST_USER_ID = "Axeuh"
FIXED_DATE = "2030-01-01"


@pytest.fixture(autouse=True)
def _redirect_runtime_files(tmp_path, monkeypatch):
    """运行时文件重定向：源选择 / 设备注册表都落到 tmp_path。"""
    import routers.health as health_router
    import services.health.devices as devices_mod

    sel = {"path": str(tmp_path / "health_source_selection.json")}
    monkeypatch.setattr(
        health_router, "_selection_path", lambda: sel["path"]
    )
    monkeypatch.setattr(
        devices_mod, "_registry_path",
        lambda: str(tmp_path / "health_devices.json"),
    )
    return sel


@pytest.fixture
def sandbox_root(tmp_path, monkeypatch):
    """健康数据写入四重防御（与 H2/H3 测试同口径）。"""
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


@pytest.fixture
def default_health_config(monkeypatch):
    """把 health 配置节固定为默认（exclusive / phone），隔离真实 config.yaml。"""
    cfg = get_config()
    monkeypatch.setitem(
        cfg._data, "health",
        {"source_mode": "exclusive", "default_source": "phone"},
    )
    return cfg


def _noon_ts(date_str: str, hour: int = 12) -> int:
    dt = datetime.strptime(date_str, "%Y-%m-%d").replace(
        hour=hour, minute=0, second=0, microsecond=0
    )
    return int(dt.replace(tzinfo=_CST).timestamp())


def _shard_path(root: str, source: str, date_str: str) -> str:
    return os.path.join(
        root, "users", TEST_USER_ID, "health", date_str, f"{source}.json"
    )


def _load_json(path):
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    return data if isinstance(data, dict) else None


def _payload(source: str, t_base: int) -> dict:
    body = {
        "samples": [{"t": t_base, "hr": 71}],
        "device_name": "SrcTest",
        "source": source,
    }
    if source == "cloud":
        # 云样本用错开的 t，保证与 phone 同日分片互不覆盖（不同 t 共存）
        body["samples"] = [{"t": t_base + 60, "hr": 71}]
        body["device_id"] = "cloud:test-cloud-user"
        body["date"] = FIXED_DATE
        body["daily_summary"] = {"total_steps": 9451, "calories": 2100}
    return body


class TestExclusiveMode:
    """exclusive（默认）：非主源写入被 409 拒绝。"""

    def test_exclusive_rejects_non_primary_with_409(
        self, sandbox_root, client, auth_headers, default_health_config
    ):
        t_base = _noon_ts(FIXED_DATE)
        resp = client.post(
            "/api/health/sync",
            json=_payload("cloud", t_base),
            headers=auth_headers,
        )
        assert resp.status_code == 409, (
            f"exclusive 下非主源写入应 409，实际 {resp.status_code}: {resp.text}"
        )
        body = resp.json()
        # 全局 handler 错误形状
        assert body.get("success") is False, f"错误体形状漂移: {body}"
        err = body.get("error") or {}
        assert "message" in err and err["message"], f"错误缺少 message: {body}"
        # message 含主源提示（plan: 409 + prompt）
        assert "phone" in err["message"], (
            f"409 message 应提示主源 phone: {err['message']}"
        )
        # 拒绝后不得写任何分片
        assert not os.path.exists(_shard_path(sandbox_root, "cloud", FIXED_DATE)), (
            "被拒的写入不应产生分片"
        )

    def test_exclusive_allows_primary_phone(
        self, sandbox_root, client, auth_headers, default_health_config
    ):
        """exclusive + primary=phone：手机端照常写入（Android 链路零影响）。"""
        t_base = _noon_ts(FIXED_DATE)
        resp = client.post(
            "/api/health/sync",
            json=_payload("phone", t_base),
            headers=auth_headers,
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert set(body.keys()) == {"status", "dates", "stats"}
        assert body["status"] == "ok"
        assert os.path.exists(_shard_path(sandbox_root, "phone", FIXED_DATE)), (
            "主源 phone 写入未落分片"
        )


class TestMergeMode:
    """merge：两源各写各分片，同日共存。

    PUT /api/health/source 端点已删除；切换模式改为直接写运行时选择文件
    （_redirect_runtime_files 已把 routers.health._selection_path 重定向到
    tmp_path，_effective_selection 读取该文件，结构 {user_id:{primary,mode}}）。
    """

    @staticmethod
    def _write_selection(path: str, user_id: str, primary: str, mode: str) -> None:
        data = {}
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        data[user_id] = {"primary": primary, "mode": mode}
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)

    def test_merge_allows_both_sources_coexist(
        self, sandbox_root, client, auth_headers, default_health_config,
        _redirect_runtime_files,
    ):
        # 切到 merge 模式（直接写运行时选择文件）
        self._write_selection(
            _redirect_runtime_files["path"], TEST_USER_ID, "phone", "merge",
        )

        t_base = _noon_ts(FIXED_DATE)
        r1 = client.post(
            "/api/health/sync",
            json=_payload("phone", t_base),
            headers=auth_headers,
        )
        assert r1.status_code == 200, f"merge 下 phone 写入被拒: {r1.text}"

        r2 = client.post(
            "/api/health/sync",
            json=_payload("cloud", t_base),
            headers=auth_headers,
        )
        assert r2.status_code == 200, f"merge 下 cloud 写入被拒: {r2.text}"
        assert r2.json()["status"] == "ok"
        # 响应契约与 /sync 现行一致
        assert set(r2.json().keys()) == {"status", "dates", "stats"}

        phone_shard = _shard_path(sandbox_root, "phone", FIXED_DATE)
        cloud_shard = _shard_path(sandbox_root, "cloud", FIXED_DATE)
        assert os.path.exists(phone_shard), "phone 分片缺失"
        assert os.path.exists(cloud_shard), "cloud 分片缺失"

        phone_raw = _load_json(phone_shard)
        cloud_raw = _load_json(cloud_shard)
        # 各写各的：source/device 块不串
        assert phone_raw["source"] == "phone"
        assert cloud_raw["source"] == "cloud"
        assert cloud_raw["device"]["device_id"] == "cloud:test-cloud-user"
        assert cloud_raw["device"]["kind"] == "cloud"
        # 云日总落 daily_summary.total_steps
        assert cloud_raw.get("daily_summary", {}).get("total_steps") == 9451

        # 两源样本同日共存互不覆盖（不同 t）
        phone_ts = {s["t"] for s in phone_raw.get("samples") or []}
        cloud_ts = {s["t"] for s in cloud_raw.get("samples") or []}
        assert phone_ts and cloud_ts
        assert t_base in phone_ts
        assert (t_base + 60) in cloud_ts

    def test_switching_back_to_exclusive(
        self, sandbox_root, client, auth_headers, default_health_config,
        _redirect_runtime_files,
    ):
        """运行时文件切回 exclusive 后，非主源再次被 409（覆盖即时生效）。"""
        self._write_selection(
            _redirect_runtime_files["path"], TEST_USER_ID, "phone", "merge",
        )

        t_base = _noon_ts(FIXED_DATE)
        ok = client.post(
            "/api/health/sync",
            json=_payload("cloud", t_base),
            headers=auth_headers,
        )
        assert ok.status_code == 200

        self._write_selection(
            _redirect_runtime_files["path"], TEST_USER_ID, "phone", "exclusive",
        )

        again = client.post(
            "/api/health/sync",
            json=_payload("cloud", t_base + 60),
            headers=auth_headers,
        )
        assert again.status_code == 409, (
            f"切回 exclusive 后 cloud 应被拒，实际 {again.status_code}"
        )


class TestHealthConfigProperties:
    """config @property：H5 新增健康云配置项的默认值与读取。"""

    def test_defaults(self, monkeypatch):
        cfg = get_config()
        monkeypatch.setitem(cfg._data, "health", {})
        assert cfg.HEALTH_SOURCE_MODE == "exclusive"
        assert cfg.HEALTH_DEFAULT_SOURCE == "phone"
        assert cfg.HEALTH_CLOUD_POLL_INTERVAL_MIN == 30
        assert cfg.HEALTH_CLOUD_USERID == ""
        assert cfg.HEALTH_CLOUD_PASSTOKEN == ""

    def test_reads_configured_values(self, monkeypatch):
        cfg = get_config()
        monkeypatch.setitem(
            cfg._data, "health",
            {
                "source_mode": "merge",
                "default_source": "cloud",
                "cloud_poll_interval_min": 15,
                "cloud": {"userid": "test-cloud-user", "passtoken": "tok"},
            },
        )
        assert cfg.HEALTH_SOURCE_MODE == "merge"
        assert cfg.HEALTH_DEFAULT_SOURCE == "cloud"
        assert cfg.HEALTH_CLOUD_POLL_INTERVAL_MIN == 15
        assert cfg.HEALTH_CLOUD_USERID == "test-cloud-user"
        assert cfg.HEALTH_CLOUD_PASSTOKEN == "tok"
