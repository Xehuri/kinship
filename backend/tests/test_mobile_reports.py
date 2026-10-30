# -*- coding: utf-8 -*-
"""GET /api/mobile/reports 允许清单扫描器测试。

契约：只暴露 health/daily/weekly/review 四类用户面报告；
每行新增 family，顶层新增 total/counts/families；未知 family 返回 400。
"""

import os
from datetime import datetime

import pytest

import routers.mobile as mobile


@pytest.fixture()
def reports_root(tmp_path, monkeypatch):
    """临时 ai/ 根；扫描器只应访问其中的 data/daily 与 data/reports。"""
    root = tmp_path / "ai"
    monkeypatch.setattr(
        mobile, "_roots", lambda: (str(root), str(root / "data"))
    )
    return root


def _write_md(root, rel_path, body, mtime=None):
    path = root / rel_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")
    if mtime is not None:
        os.utime(path, (mtime, mtime))
    return path


def _get(client, headers, **params):
    resp = client.get("/api/mobile/reports", params=params, headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _paths(body):
    return [row["path"] for row in body["reports"]]


def test_reports_returns_only_allowlisted_families(
        client, auth_headers, reports_root):
    _write_md(
        reports_root, "data/daily/2026-10-01/健康清单-2026-10-01.md",
        "# 2026-10-01 健康清单\n\n正文\n",
    )
    _write_md(
        reports_root, "data/daily/2026-10-02/复盘-2026-10-02.md",
        "---\ndate: 2026-10-02\ntags: [复盘报告]\n---\n\n# 2026-10-02 复盘报告\n",
    )
    _write_md(
        reports_root, "data/reports/每周总结-2026-09-28~10-04.md",
        "# 每周总结：2026-09-28 ~ 10-04\n",
    )
    _write_md(
        reports_root,
        "data/reports/深度回顾-2026-09-02~2026-09-15.md",
        "---\ntags: [深度回顾]\n---\n\n# 深度回顾分析：2026-09-02 ~ 2026-09-15\n",
    )
    _write_md(
        reports_root, "data/reports/培训全程总结-2026-07-11~08-10.md",
        "# 南京培训全程总结：2026-07-11 ~ 2026-08-10\n",
    )

    body = _get(client, auth_headers)

    assert _paths(body) == [
        "data/reports/每周总结-2026-09-28~10-04.md",
        "data/daily/2026-10-02/复盘-2026-10-02.md",
        "data/daily/2026-10-01/健康清单-2026-10-01.md",
        "data/reports/深度回顾-2026-09-02~2026-09-15.md",
        "data/reports/培训全程总结-2026-07-11~08-10.md",
    ]
    assert [row["date"] for row in body["reports"]] == [
        "2026-10-04", "2026-10-02", "2026-10-01", "2026-09-15", "2026-08-10",
    ]
    assert [row["family"] for row in body["reports"]] == [
        "weekly", "daily", "health", "review", "review",
    ]
    assert [row["title"] for row in body["reports"]] == [
        "每周总结：2026-09-28 ~ 10-04",
        "2026-10-02 复盘报告",
        "2026-10-01 健康清单",
        "深度回顾分析：2026-09-02 ~ 2026-09-15",
        "南京培训全程总结：2026-07-11 ~ 2026-08-10",
    ]

    for row in body["reports"]:
        assert set(row) == {
            "path", "title", "date", "mtime", "tags", "size_bytes", "kind",
            "family",
        }
        assert isinstance(row["size_bytes"], int)
        assert isinstance(row["kind"], str) and row["kind"]

    assert body["total"] == 5
    assert body["counts"] == {
        "health": 1, "daily": 1, "weekly": 1, "review": 2,
    }
    assert body["families"] == [
        {"id": "health", "label": "健康清单", "count": 1},
        {"id": "daily", "label": "日报", "count": 1},
        {"id": "weekly", "label": "周报", "count": 1},
        {"id": "review", "label": "复盘", "count": 2},
    ]


def test_reports_excludes_non_report_noise(client, auth_headers, reports_root):
    noise = [
        "data/daily/2026-10-01/理解-2026-10-01-批次-06.md",
        "data/daily/2026-10-01/理解-2026-10-01.md",
        "data/daily/2026-10-01/孪生-理解-2026-10-01-批次-06.md",
        "data/daily/2026-10-01/事实-全天.md",
        "data/daily/2026-10-01/当日摘要-2026-10-01.md",
        "data/daily/2026-10-01/批次索引-2026-10-01.md",
        "data/daily/2026-10-01/天气-2026-10-01.md",
        "data/daily/2026-10-01/反馈-2026-10-01.md",
        "data/daily/2026-10-01/日志-2026-10-01.md",
        "data/daily/2026-10-01/新歌-2026-10-01.md",
        "data/daily/2026-10-01/学习数据-2026-10-01.md",
        "data/daily/2026-10-01/健康-同步事件-2026-10-01.md",
        "data/daily/2026-10-01/个人人生设计蓝图.md",
        "data/daily/2026-10-01/数据质量报告-2026-10-01.md",
        "data/daily/2026-10-01/数据备注-2026-10-01.md",
        "data/daily/2026-10-01/排查-非用户会话消耗.md",
        "data/daily/2026-10-01/MOSS质量评估-2026-10-01~18.md",
        "data/daily/2026-10-01/复盘-2026-10-01.md.bak",
        "data/daily/2026-10-01/cards/temp/健康清单-2026-10-01.md",
        "data/daily/2026-10-01/cards/卡片.md",
        "data/daily/2026-10-01/sub/复盘-2026-10-01.md",
        "data/reports/月度总结-2026-09.md",
        "data/reports/随手记-2026-10-01.md",
        "data/memory/长期记忆.md",
        "data/study/学习.md",
        "data/social/社交.md",
        "data/agents/data_checker.md",
        "data/skills/skill.md",
        "data/cache/缓存.md",
        "data/twin/孪生.md",
        "memory/长期记忆.md",
        "study/学习.md",
        "social/社交.md",
        "agents/data_checker.md",
        "skills/skill.md",
        "AGENTS.md",
        "健康清单-2026-10-01.md",
        "复盘-2026-10-01.md",
    ]
    for rel_path in noise:
        _write_md(reports_root, rel_path, "# 噪声标题\n\n正文\n")

    body = _get(client, auth_headers)

    assert body["reports"] == []
    assert body["total"] == 0
    assert body["counts"] == {
        "health": 0, "daily": 0, "weekly": 0, "review": 0,
    }
    assert [family["id"] for family in body["families"]] == [
        "health", "daily", "weekly", "review",
    ]
    assert all(family["count"] == 0 for family in body["families"])


def test_reports_family_filter(client, auth_headers, reports_root):
    _write_md(
        reports_root, "data/daily/2026-10-01/健康清单-2026-10-01.md",
        "# 健康\n",
    )
    _write_md(
        reports_root, "data/daily/2026-10-02/复盘-2026-10-02.md",
        "# 日报\n",
    )
    _write_md(
        reports_root, "data/reports/每周总结-2026-09-28~10-04.md",
        "# 周报\n",
    )

    weekly = _get(client, auth_headers, family="weekly")
    assert _paths(weekly) == ["data/reports/每周总结-2026-09-28~10-04.md"]
    assert weekly["total"] == 1
    assert weekly["counts"] == {
        "health": 0, "daily": 0, "weekly": 1, "review": 0,
    }
    assert [family["count"] for family in weekly["families"]] == [0, 0, 1, 0]

    daily = _get(client, auth_headers, family="daily")
    assert _paths(daily) == ["data/daily/2026-10-02/复盘-2026-10-02.md"]
    assert [row["family"] for row in daily["reports"]] == ["daily"]

    health = _get(client, auth_headers, family="health")
    assert _paths(health) == ["data/daily/2026-10-01/健康清单-2026-10-01.md"]


def test_reports_unknown_family_returns_400(client, auth_headers, reports_root):
    _write_md(
        reports_root, "data/reports/每周总结-2026-09-28~10-04.md",
        "# 周报\n",
    )

    for value in ("monthly", "Health", "bogus"):
        resp = client.get(
            "/api/mobile/reports",
            params={"family": value},
            headers=auth_headers,
        )
        assert resp.status_code == 400
        assert resp.json() == {"detail": "未知报告类别"}


def test_reports_date_parsing_handles_ranges_and_year_rollover(
        client, auth_headers, reports_root):
    _write_md(
        reports_root, "data/reports/每周总结-2026-12-28~01-03.md",
        "# 跨年周报\n",
    )
    _write_md(
        reports_root, "data/reports/每周总结-2026-09-28~10-04.md",
        "# 普通周报\n",
    )
    _write_md(
        reports_root, "data/reports/深度回顾-2026-09-16~2026-10-01.md",
        "# 双周回顾\n",
    )
    fallback_mtime = datetime(2026, 3, 4, 12, 0, 0).timestamp()
    _write_md(
        reports_root, "data/reports/每周总结-无日期.md",
        "无标题正文\n",
        mtime=fallback_mtime,
    )
    _write_md(
        reports_root, "data/reports/每周总结-2026-01-01~01-07.md",
        "---\ndate: 2026-02-02\ntags: []\n---\n\n# 前置日期优先\n",
    )

    body = _get(client, auth_headers)
    by_path = {row["path"]: row for row in body["reports"]}

    assert by_path["data/reports/每周总结-2026-12-28~01-03.md"]["date"] == "2027-01-03"
    assert by_path["data/reports/每周总结-2026-09-28~10-04.md"]["date"] == "2026-10-04"
    assert (
        by_path["data/reports/深度回顾-2026-09-16~2026-10-01.md"]["date"]
        == "2026-10-01"
    )
    assert by_path["data/reports/每周总结-无日期.md"]["date"] == "2026-03-04"
    assert (
        by_path["data/reports/每周总结-2026-01-01~01-07.md"]["date"]
        == "2026-02-02"
    )
    assert [row["date"] for row in body["reports"]] == [
        "2027-01-03", "2026-10-04", "2026-10-01", "2026-03-04", "2026-02-02",
    ]


def test_reports_title_is_first_h1_after_frontmatter(
        client, auth_headers, reports_root):
    _write_md(
        reports_root, "data/daily/2026-10-05/复盘-2026-10-05.md",
        "---\ndate: 2026-10-05\ntags: [复盘报告]\n---\n\n"
        "这是一段前言。\n\n## 不是一级标题\n\n# 真正的一级标题\n",
    )
    _write_md(
        reports_root, "data/daily/2026-10-06/复盘-2026-10-06.md",
        "---\ndate: 2026-10-06\ntags: [复盘报告]\n---\n\n没有一级标题的正文。\n",
    )

    body = _get(client, auth_headers)
    titles = {row["path"]: row["title"] for row in body["reports"]}

    assert titles["data/daily/2026-10-05/复盘-2026-10-05.md"] == "真正的一级标题"
    assert (
        titles["data/daily/2026-10-06/复盘-2026-10-06.md"] == "复盘-2026-10-06"
    )


def test_reports_tag_filter_still_works(client, auth_headers, reports_root):
    _write_md(
        reports_root, "data/daily/2026-10-01/复盘-2026-10-01.md",
        "---\ndate: 2026-10-01\ntags: [复盘报告]\n---\n\n# 日报\n",
    )
    _write_md(
        reports_root, "data/daily/2026-10-02/健康清单-2026-10-02.md",
        "# 健康\n",
    )

    body = _get(client, auth_headers, tag="复盘报告")

    assert _paths(body) == ["data/daily/2026-10-01/复盘-2026-10-01.md"]
    assert body["total"] == 1


def test_reports_requires_auth(client, reports_root):
    assert client.get("/api/mobile/reports").status_code == 401
