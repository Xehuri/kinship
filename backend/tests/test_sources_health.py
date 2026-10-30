# -*- coding: utf-8 -*-
"""GET /api/sources/health 契约测试：鉴权、六源形状、真实事实与故障隔离。"""

import json
import os
import time
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from services import source_health as sh

CST = timezone(timedelta(hours=8))
SOURCE_IDS = ["phone_health", "mi_cloud", "pc_sensor", "realtime", "loom", "files"]


class _CloudService:
    def __init__(self, phase="ok", last_success=None, error=""):
        self.phase = phase
        self.last_success = int(time.time()) if last_success is None else last_success
        self.error = error

    def status(self, probe=False):
        return {
            "phase": self.phase,
            "last_success": self.last_success,
            "poll_interval_min": 30,
            "last_error": self.error,
        }


@pytest.fixture(autouse=True)
def _clear_cache():
    sh.reset_cache()
    yield
    sh.reset_cache()


@pytest.fixture()
def env(tmp_path, monkeypatch):
    cfg = SimpleNamespace(
        DATA_DIR=str(tmp_path),
        HEALTH_PRIMARY_USER="Axeuh",
        HEALTH_CLOUD_POLL_INTERVAL_MIN=30,
        AI_BACKEND="loom",
    )
    monkeypatch.setattr(sh, "get_config", lambda: cfg)
    monkeypatch.setattr(
        sh, "get_health_cloud_service", lambda: _CloudService()
    )
    monkeypatch.setattr(
        sh, "get_loom_health",
        lambda: {"status": "online", "version": "test", "checked_at": time.time()},
    )
    monkeypatch.setattr(sh, "_sse_connected", lambda: True)
    return tmp_path


def _write_shard(root, user, date, source, sample_count):
    target = root / "users" / user / "health" / date
    target.mkdir(parents=True, exist_ok=True)
    path = target / f"{source}.json"
    path.write_text(
        json.dumps({"source": source, "samples": [{"t": i} for i in range(sample_count)]}),
        encoding="utf-8",
    )
    return path


def _write_perception(root, date, entries):
    target = root / "daily" / date
    target.mkdir(parents=True, exist_ok=True)
    path = target / "perception.jsonl"
    with open(path, "w", encoding="utf-8") as f:
        for entry in entries:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return path


def _source(payload, source_id):
    return next(item for item in payload["sources"] if item["id"] == source_id)


def _today():
    return datetime.now(CST).date().isoformat()


def test_requires_auth(client):
    assert client.get("/api/sources/health").status_code == 401


def test_query_token_is_not_accepted(client, auth_headers):
    token = auth_headers["Authorization"].split(" ", 1)[1]
    resp = client.get("/api/sources/health", params={"token": token})
    assert resp.status_code == 401


def test_returns_six_sources_with_contract_shape(client, auth_headers, env):
    resp = client.get("/api/sources/health", headers=auth_headers)
    assert resp.status_code == 200
    payload = resp.json()
    assert set(payload) == {"generated_at", "sources"}
    generated = datetime.fromisoformat(payload["generated_at"])
    assert generated.tzinfo is not None
    assert [item["id"] for item in payload["sources"]] == SOURCE_IDS
    allowed = {"ok", "degraded", "stale", "offline", "unknown"}
    for item in payload["sources"]:
        assert set(item) == {"id", "name", "status", "last_sync", "records", "detail"}
        assert item["status"] in allowed
        assert item["records"] is None or isinstance(item["records"], int)
        assert item["last_sync"] is None or isinstance(item["last_sync"], str)
        assert isinstance(item["detail"], str)


def test_phone_health_reads_latest_shard(client, auth_headers, env):
    _write_shard(env, "Axeuh", _today(), "phone", 3)

    resp = client.get("/api/sources/health", headers=auth_headers)
    assert resp.status_code == 200
    item = _source(resp.json(), "phone_health")
    assert item["status"] == "ok"
    assert item["records"] == 3
    assert item["last_sync"] is not None


def test_phone_health_stale_when_write_is_old(client, auth_headers, env):
    path = _write_shard(env, "Axeuh", _today(), "phone", 2)
    old = time.time() - 7 * 3600
    os.utime(path, (old, old))

    resp = client.get("/api/sources/health", headers=auth_headers)
    item = _source(resp.json(), "phone_health")
    assert item["status"] == "stale"
    assert item["records"] == 2


def test_phone_health_offline_without_shard(client, auth_headers, env):
    resp = client.get("/api/sources/health", headers=auth_headers)
    item = _source(resp.json(), "phone_health")
    assert item["status"] == "offline"
    assert item["records"] is None
    assert item["last_sync"] is None


def test_mi_cloud_ok_without_shard_has_null_records(client, auth_headers, env):
    resp = client.get("/api/sources/health", headers=auth_headers)
    item = _source(resp.json(), "mi_cloud")
    assert item["status"] == "ok"
    assert item["records"] is None


def test_mi_cloud_reads_cloud_shard_records(client, auth_headers, env):
    _write_shard(env, "Axeuh", _today(), "cloud", 5)

    resp = client.get("/api/sources/health", headers=auth_headers)
    item = _source(resp.json(), "mi_cloud")
    assert item["status"] == "ok"
    assert item["records"] == 5
    assert item["last_sync"] is not None


def test_mi_cloud_disabled_is_offline(client, auth_headers, env, monkeypatch):
    monkeypatch.setattr(
        sh, "get_health_cloud_service",
        lambda: _CloudService(phase="disabled", last_success=0),
    )

    resp = client.get("/api/sources/health", headers=auth_headers)
    item = _source(resp.json(), "mi_cloud")
    assert item["status"] == "offline"
    assert "禁用" in item["detail"]


def test_mi_cloud_error_is_degraded(client, auth_headers, env, monkeypatch):
    monkeypatch.setattr(
        sh, "get_health_cloud_service",
        lambda: _CloudService(phase="error", error="401 unauthorized"),
    )

    resp = client.get("/api/sources/health", headers=auth_headers)
    item = _source(resp.json(), "mi_cloud")
    assert item["status"] == "degraded"
    assert "401 unauthorized" in item["detail"]


def test_pc_sensor_counts_today_events(client, auth_headers, env):
    now = datetime.now(CST)
    entries = [
        {"type": "pc_window", "t_iso": (now - timedelta(minutes=1)).isoformat(),
         "_source": "pc_sensor", "payload": {}},
        {"type": "pc_idle", "t_iso": (now - timedelta(minutes=2)).isoformat(),
         "_source": "pc_sensor", "payload": {}},
        {"type": "sensor", "t_iso": now.isoformat(), "device_name": "手机"},
    ]
    _write_perception(env, _today(), entries)

    resp = client.get("/api/sources/health", headers=auth_headers)
    item = _source(resp.json(), "pc_sensor")
    assert item["status"] == "ok"
    assert item["records"] == 2
    assert item["last_sync"] is not None


def test_pc_sensor_offline_without_events(client, auth_headers, env):
    resp = client.get("/api/sources/health", headers=auth_headers)
    item = _source(resp.json(), "pc_sensor")
    assert item["status"] == "offline"
    assert item["records"] is None


def test_files_reads_latest_daily_shard(client, auth_headers, env):
    _write_perception(env, _today(), [
        {"type": "heartbeat", "t": "10:00:00"},
        {"type": "sensor", "t": "10:00:01"},
    ])

    resp = client.get("/api/sources/health", headers=auth_headers)
    item = _source(resp.json(), "files")
    assert item["status"] == "ok"
    assert item["records"] == 2
    assert item["last_sync"] is not None


def test_single_source_failure_is_isolated(client, auth_headers, env, monkeypatch):
    def _boom():
        raise RuntimeError("boom")

    monkeypatch.setattr(sh, "collect_loom", _boom)

    resp = client.get("/api/sources/health", headers=auth_headers)
    assert resp.status_code == 200
    item = _source(resp.json(), "loom")
    assert item["status"] == "unknown"
    assert item["detail"]


def test_realtime_reports_disconnected(client, auth_headers, env, monkeypatch):
    monkeypatch.setattr(sh, "_sse_connected", lambda: False)

    resp = client.get("/api/sources/health", headers=auth_headers)
    item = _source(resp.json(), "realtime")
    assert item["status"] == "offline"
    assert item["records"] is None


def test_unexpected_failure_returns_500(client, auth_headers, env, monkeypatch):
    def _boom(user_id):
        raise RuntimeError("unexpected")

    monkeypatch.setattr(sh, "collect_all", _boom)

    resp = client.get("/api/sources/health", headers=auth_headers)
    assert resp.status_code == 500
    assert "detail" in resp.json()


def test_cache_keeps_repeated_calls_short(client, auth_headers, env, monkeypatch):
    calls = {"n": 0}
    original = sh.collect_phone_health

    def _counted(user_id):
        calls["n"] += 1
        return original(user_id)

    monkeypatch.setattr(sh, "collect_phone_health", _counted)
    sh.collect_all("Axeuh")
    sh.collect_all("Axeuh")
    assert calls["n"] == 1

    sh.reset_cache()
    sh.collect_all("Axeuh")
    assert calls["n"] == 2
