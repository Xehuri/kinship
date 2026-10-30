# -*- coding: utf-8 -*-
"""计划板只读 API 契约测试（GAP-1 backend）。

覆盖点：
  - GET /api/plan/{date}：计划 + 覆盖契约 + 到期长期任务的完整 200 形状；
  - 计划/覆盖缺失时返回 null（不是 404），长期任务仍可计算；
  - 无 Bearer → 401；
  - 非法日期 / 路径穿越 → 400（path 转换器捕获后由日期校验拒绝）；
  - 计划 JSON 损坏 → 500 且 detail 明确；
  - /api/plan/long-tasks 静态路由优先级（不被 {date} 吞掉）；
  - 单个长期任务 JSON 损坏 → warning + 跳过，请求仍 200。

写入隔离：把配置单例 data.dir 临时指向 tmp_path，绝不读写真实 ai/data。
"""

import json
import time

import pytest

TEST_DATE = "2026-10-27"

DATE_KEYS = {
    "date",
    "plan",
    "coverage",
    "long_tasks_due",
    "warnings",
    "generated_at",
}
LIST_KEYS = {"tasks", "generated_at"}


@pytest.fixture
def plan_data(tmp_path, monkeypatch):
    """把 DATA_DIR 重定向到 tmp_path（Config 门面动态读配置即生效）。"""
    import config.config as cc

    cfg = cc.get_config()
    monkeypatch.setitem(
        cfg._data, "data", {**(cfg._data.get("data") or {}), "dir": str(tmp_path)}
    )
    return tmp_path


def _write_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return path


def _seed_plan(root, payload=None, date=TEST_DATE):
    body = payload if payload is not None else {
        "schema": 1,
        "date": date,
        "status": "ready",
        "version": 1,
        "items": [],
    }
    return _write_json(root / "daily" / date / f"plan-{date}.json", body)


def _seed_coverage(root):
    path = root / "plan" / "coverage.yaml"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "schema: 1\ndefault: merged_7\nprofiles:\n  merged_7:\n    default: true\n",
        encoding="utf-8",
    )
    return path


def _seed_long_task(root, payload, filename=None):
    name = filename or f"{payload['id']}.json"
    return _write_json(root / "plan" / "long-tasks" / name, payload)


def _error_message(resp):
    """兼容全局错误信封（success/data/error）与裸 detail 两种形状。"""
    body = resp.json()
    return (body.get("error") or {}).get("message") or body.get("detail") or ""


def _task(task_id, next_check, status="active"):
    return {
        "schema": 1,
        "id": task_id,
        "title": task_id,
        "intent": "test",
        "next_check": next_check,
        "status": status,
        "version": 1,
    }


def test_get_plan_returns_plan_coverage_and_due_tasks(client, auth_headers, plan_data):
    plan = {
        "schema": 1,
        "date": TEST_DATE,
        "status": "ready",
        "version": 1,
        "items": [{"id": "cov-06", "kind": "checkpoint", "status": "pending"}],
        "coverage": {"profile": "merged_7"},
    }
    _seed_plan(plan_data, plan)
    _seed_coverage(plan_data)
    _seed_long_task(plan_data, _task("lt_due_late", TEST_DATE))
    _seed_long_task(plan_data, _task("lt_due_early", "2026-10-20"))
    _seed_long_task(plan_data, _task("lt_a", TEST_DATE))
    _seed_long_task(plan_data, _task("lt_future", "2026-10-28"))
    _seed_long_task(plan_data, _task("lt_paused", "2026-10-01", status="paused"))

    before = int(time.time())
    resp = client.get(f"/api/plan/{TEST_DATE}", headers=auth_headers)
    after = int(time.time())

    assert resp.status_code == 200
    body = resp.json()
    assert set(body.keys()) == DATE_KEYS
    assert body["date"] == TEST_DATE
    assert body["plan"] == plan
    assert body["coverage"]["default"] == "merged_7"
    assert body["coverage"]["profiles"]["merged_7"]["default"] is True
    assert [task["id"] for task in body["long_tasks_due"]] == [
        "lt_due_early",
        "lt_a",
        "lt_due_late",
    ]
    assert body["warnings"] == []
    assert isinstance(body["generated_at"], int)
    assert before <= body["generated_at"] <= after


def test_missing_plan_returns_null_but_long_tasks_still_due(client, auth_headers, plan_data):
    _seed_long_task(plan_data, _task("lt_due", TEST_DATE))

    resp = client.get(f"/api/plan/{TEST_DATE}", headers=auth_headers)

    assert resp.status_code == 200
    body = resp.json()
    assert body["plan"] is None
    assert body["coverage"] is None
    assert [task["id"] for task in body["long_tasks_due"]] == ["lt_due"]
    assert body["warnings"] == []


def test_requires_auth(client, plan_data):
    assert client.get(f"/api/plan/{TEST_DATE}").status_code == 401
    assert client.get("/api/plan/long-tasks").status_code == 401


@pytest.mark.parametrize(
    "path",
    [
        "/api/plan/2026-13-01",
        "/api/plan/2026-02-30",
        "/api/plan/2026-2-3",
        "/api/plan/not-a-date",
        "/api/plan/..%2F..%2Fetc%2Fpasswd",
        "/api/plan/%2e%2e%2f%2e%2e%2fetc%2fpasswd",
    ],
)
def test_invalid_date_and_traversal_return_400(client, auth_headers, plan_data, path):
    resp = client.get(path, headers=auth_headers)

    assert resp.status_code == 400
    assert _error_message(resp)


def test_corrupt_plan_json_returns_500(client, auth_headers, plan_data):
    path = plan_data / "daily" / TEST_DATE / f"plan-{TEST_DATE}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{not valid json", encoding="utf-8")

    resp = client.get(f"/api/plan/{TEST_DATE}", headers=auth_headers)

    assert resp.status_code == 500
    detail = _error_message(resp)
    assert "计划文件损坏" in detail
    assert f"plan-{TEST_DATE}.json" in detail


def test_long_tasks_route_takes_precedence_over_date(client, auth_headers, plan_data):
    _seed_long_task(plan_data, _task("lt_one", "2026-11-01"))
    _seed_long_task(plan_data, _task("lt_two", "2026-10-01", status="paused"))

    resp = client.get("/api/plan/long-tasks", headers=auth_headers)

    assert resp.status_code == 200
    body = resp.json()
    assert set(body.keys()) == LIST_KEYS
    assert [task["id"] for task in body["tasks"]] == ["lt_two", "lt_one"]
    assert isinstance(body["generated_at"], int)


def test_invalid_long_task_json_warns_and_skips(client, auth_headers, plan_data):
    _seed_plan(plan_data)
    _seed_long_task(plan_data, _task("lt_good", TEST_DATE))
    broken = plan_data / "plan" / "long-tasks" / "broken.json"
    broken.write_text("{oops", encoding="utf-8")

    resp = client.get(f"/api/plan/{TEST_DATE}", headers=auth_headers)

    assert resp.status_code == 200
    body = resp.json()
    assert [task["id"] for task in body["long_tasks_due"]] == ["lt_good"]
    assert len(body["warnings"]) == 1
    assert "broken.json" in body["warnings"][0]

    list_resp = client.get("/api/plan/long-tasks", headers=auth_headers)
    assert list_resp.status_code == 200
    assert [task["id"] for task in list_resp.json()["tasks"]] == ["lt_good"]


# ── GET /api/plan/{date}/effective (T13) ──────────────────────────

EFFECTIVE_KEYS = {
    "date",
    "master_version",
    "master",
    "overlay",
    "effective",
    "long_tasks_due",
    "warnings",
    "generated_at",
}
EFFECTIVE_VIEW_KEYS = {"items", "coverage"}


def _seed_master(root, entries, version=2, timezone="Asia/Shanghai"):
    return _write_json(
        root / "plan" / "master.json",
        {
            "schema": 1,
            "kind": "master-plan",
            "timezone": timezone,
            "version": version,
            "created_at": 1761500000,
            "updated_at": 1761600000,
            "entries": entries,
        },
    )


def _master_entry(entry_id, kind="fixed", schedule=None, **fields):
    entry = {
        "id": entry_id,
        "kind": kind,
        "title": entry_id,
        "enabled": True,
        "schedule": schedule or {"kind": "daily", "at": "08:00"},
        "created_at": 1761500000,
        "updated_at": 1761600000,
    }
    if kind == "long_term":
        entry.setdefault("status", "active")
        entry.setdefault("next_check", TEST_DATE)
    entry.update(fields)
    return entry


def _seed_overlay(root, payload, date=TEST_DATE):
    return _write_json(root / "daily" / date / f"plan-{date}.overlay.json", payload)


def test_effective_plan_merges_master_and_overlay(client, auth_headers, plan_data):
    coverage = {
        "profile": "merged_7",
        "checkpoints": ["cov-06"],
        "debt": ["cov-00"],
    }
    master_entries = [
        _master_entry("m_fixed", intent="晨间启动", window="08:00~08:30"),
        _master_entry(
            "m_monthly", schedule={"kind": "monthly", "days": [27], "at": "09:00"}
        ),
        _master_entry(
            "m_weekly_mon",
            schedule={"kind": "weekly", "days": ["mon"], "at": "09:00"},
        ),
        _master_entry("m_disabled", enabled=False),
        _master_entry(
            "m_long_due",
            kind="long_term",
            next_check="2026-10-20",
            schedule={"kind": "daily", "at": "20:00"},
        ),
        _master_entry(
            "m_long_future",
            kind="long_term",
            next_check="2026-11-01",
            schedule={"kind": "daily", "at": "20:00"},
        ),
        _master_entry("m_removed", schedule={"kind": "daily", "at": "12:00"}),
    ]
    overlay = {
        "schema": 1,
        "kind": "plan-overlay",
        "date": TEST_DATE,
        "base_version": 2,
        "version": 3,
        "status": "committed",
        "created_at": 1761600000,
        "updated_at": 1761605000,
        "ops": [
            {"op": "update", "id": "m_fixed", "patch": {"at": "08:30", "intent": "晨间更新"}},
            {"op": "remove", "id": "m_removed"},
            {
                "op": "add",
                "item": {
                    "id": "o_added",
                    "kind": "note",
                    "intent": "临时事项",
                    "status": "planned",
                },
            },
            {"op": "note", "text": "备注"},
            {"op": "update", "id": "m_ghost", "patch": {"intent": "不存在"}},
        ],
        "notes": ["今日备注"],
        "coverage": coverage,
    }
    _seed_master(plan_data, master_entries, version=2)
    _seed_overlay(plan_data, overlay)
    _seed_long_task(plan_data, _task("lt_due", TEST_DATE))
    _seed_long_task(plan_data, _task("lt_future", "2026-11-02"))

    before = int(time.time())
    resp = client.get(f"/api/plan/{TEST_DATE}/effective", headers=auth_headers)
    after = int(time.time())

    assert resp.status_code == 200
    body = resp.json()
    assert set(body.keys()) == EFFECTIVE_KEYS
    assert body["date"] == TEST_DATE
    assert body["master_version"] == 2
    assert body["master"] == {"timezone": "Asia/Shanghai", "entries": master_entries}
    assert body["overlay"] == overlay
    assert set(body["effective"].keys()) == EFFECTIVE_VIEW_KEYS
    assert body["effective"]["coverage"] == coverage
    items = body["effective"]["items"]
    assert [item["id"] for item in items] == [
        "m_fixed",
        "m_monthly",
        "m_long_due",
        "m_removed",
        "o_added",
    ]
    by_id = {item["id"]: item for item in items}
    assert by_id["m_fixed"]["at"] == "08:30"
    assert by_id["m_fixed"]["at_override"] is True
    assert by_id["m_fixed"]["intent"] == "晨间更新"
    assert by_id["m_fixed"]["source"] == "master"
    assert by_id["m_fixed"]["master_version"] == 2
    assert by_id["m_fixed"]["overlay_version"] == 3
    assert by_id["m_removed"]["suppressed"] is True
    assert by_id["o_added"]["source"] == "overlay"
    assert by_id["o_added"]["status"] == "planned"
    assert [task["id"] for task in body["long_tasks_due"]] == ["lt_due"]
    assert "orphan_update:m_ghost" in body["warnings"]
    assert isinstance(body["generated_at"], int)
    assert before <= body["generated_at"] <= after


def test_effective_plan_missing_files_returns_nulls_and_warnings(
    client, auth_headers, plan_data
):
    resp = client.get(f"/api/plan/{TEST_DATE}/effective", headers=auth_headers)

    assert resp.status_code == 200
    body = resp.json()
    assert body["master"] is None
    assert body["master_version"] is None
    assert body["overlay"] is None
    assert body["effective"] == {"items": [], "coverage": None}
    assert body["long_tasks_due"] == []
    assert len(body["warnings"]) == 2
    assert any("master.json" in warning for warning in body["warnings"])
    assert any("overlay.json" in warning for warning in body["warnings"])


def test_effective_plan_falls_back_to_legacy_plan(client, auth_headers, plan_data):
    coverage = {"profile": "merged_6", "checkpoints": ["cov-06"], "debt": []}
    plan = {
        "schema": 1,
        "date": TEST_DATE,
        "status": "draft",
        "version": 4,
        "items": [
            {
                "id": "legacy_item",
                "kind": "care",
                "intent": "旧计划条目",
                "status": "planned",
                "window": "09:00~10:00",
            }
        ],
        "coverage": coverage,
    }
    _seed_plan(plan_data, plan)
    _seed_long_task(plan_data, _task("lt_due", TEST_DATE))

    resp = client.get(f"/api/plan/{TEST_DATE}/effective", headers=auth_headers)

    assert resp.status_code == 200
    body = resp.json()
    assert body["master"] is None
    assert body["master_version"] is None
    assert body["overlay"] is None
    assert body["effective"]["coverage"] == coverage
    assert [item["id"] for item in body["effective"]["items"]] == ["legacy_item"]
    item = body["effective"]["items"][0]
    assert item["source"] == "overlay"
    assert item["overlay_version"] == 4
    assert item["window"] == "09:00~10:00"
    assert "legacy_fallback" in body["warnings"]
    assert [task["id"] for task in body["long_tasks_due"]] == ["lt_due"]


def test_effective_plan_overlay_without_master_returns_empty_view(
    client, auth_headers, plan_data
):
    overlay = {
        "schema": 1,
        "kind": "plan-overlay",
        "date": TEST_DATE,
        "base_version": 1,
        "version": 1,
        "status": "draft",
        "created_at": 1761600000,
        "updated_at": 1761600000,
        "ops": [
            {
                "op": "add",
                "item": {
                    "id": "o_added",
                    "kind": "note",
                    "intent": "孤立覆盖层",
                    "status": "planned",
                },
            }
        ],
        "notes": [],
        "coverage": {"profile": "merged_7", "checkpoints": ["cov-06"], "debt": []},
    }
    _seed_overlay(plan_data, overlay)

    resp = client.get(f"/api/plan/{TEST_DATE}/effective", headers=auth_headers)

    assert resp.status_code == 200
    body = resp.json()
    assert body["master"] is None
    assert body["master_version"] is None
    assert body["overlay"] == overlay
    assert body["effective"]["items"] == []
    assert body["effective"]["coverage"] == overlay["coverage"]
    assert any("master.json" in warning for warning in body["warnings"])


def test_effective_plan_requires_auth(client, plan_data):
    assert client.get(f"/api/plan/{TEST_DATE}/effective").status_code == 401


@pytest.mark.parametrize(
    "path",
    [
        "/api/plan/2026-13-01/effective",
        "/api/plan/2026-02-30/effective",
        "/api/plan/not-a-date/effective",
        "/api/plan/..%2F..%2Fetc%2Fpasswd/effective",
    ],
)
def test_effective_plan_invalid_date_returns_400(
    client, auth_headers, plan_data, path
):
    resp = client.get(path, headers=auth_headers)

    assert resp.status_code == 400
    assert _error_message(resp)


def test_effective_plan_corrupt_master_returns_500(client, auth_headers, plan_data):
    path = plan_data / "plan" / "master.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{not valid json", encoding="utf-8")

    resp = client.get(f"/api/plan/{TEST_DATE}/effective", headers=auth_headers)

    assert resp.status_code == 500
    detail = _error_message(resp)
    assert "母版文件损坏" in detail
    assert "master.json" in detail


def test_effective_plan_invalid_master_shape_returns_500(
    client, auth_headers, plan_data
):
    _write_json(
        plan_data / "plan" / "master.json",
        {
            "schema": 1,
            "kind": "master-plan",
            "timezone": "Asia/Shanghai",
            "version": 0,
            "entries": [],
        },
    )

    resp = client.get(f"/api/plan/{TEST_DATE}/effective", headers=auth_headers)

    assert resp.status_code == 500
    detail = _error_message(resp)
    assert "母版文件损坏" in detail
    assert "version" in detail


def test_effective_plan_corrupt_overlay_returns_500(client, auth_headers, plan_data):
    _seed_master(plan_data, [_master_entry("m_fixed")])
    overlay_path = (
        plan_data / "daily" / TEST_DATE / f"plan-{TEST_DATE}.overlay.json"
    )
    overlay_path.parent.mkdir(parents=True, exist_ok=True)
    overlay_path.write_text("{not valid json", encoding="utf-8")

    resp = client.get(f"/api/plan/{TEST_DATE}/effective", headers=auth_headers)

    assert resp.status_code == 500
    detail = _error_message(resp)
    assert "覆盖层文件损坏" in detail
    assert f"plan-{TEST_DATE}.overlay.json" in detail


def test_effective_plan_corrupt_legacy_plan_returns_500(
    client, auth_headers, plan_data
):
    legacy = plan_data / "daily" / TEST_DATE / f"plan-{TEST_DATE}.json"
    legacy.parent.mkdir(parents=True, exist_ok=True)
    legacy.write_text("{not valid json", encoding="utf-8")

    resp = client.get(f"/api/plan/{TEST_DATE}/effective", headers=auth_headers)

    assert resp.status_code == 500
    detail = _error_message(resp)
    assert "计划文件损坏" in detail
    assert f"plan-{TEST_DATE}.json" in detail
