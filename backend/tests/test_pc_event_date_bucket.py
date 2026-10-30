# -*- coding: utf-8 -*-
"""T5 PC 感知按事件日期分桶测试（跨午夜迟到批量上传场景）。

背景：PC 采集端批量上传可能迟到/跨午夜（见 t1-evidence.md 同一生产 bug），
若 append_perception 按服务器当前时间分桶会把事件写错日期。要求 pc/sync
用原始 event.t_iso（而非已兜底为 now 的 entry["t_iso"]）推导 date_str 传入：
  - t_iso 缺失 -> date_str=None（保持旧的今天分桶语义）
  - t_iso 合法 -> 事件日期 YYYY-MM-DD
  - t_iso 无法解析 -> date_str=None + 一条 warning（fail-soft 到今天）

注意：pc.py 是模块级 `from services.perception_store import append_perception`，
必须 patch 路由模块属性 routers.pc.append_perception，patch perception_store 无效。
"""
import logging

import pytest

from config.config import get_config

_TEST_HOST = f"localhost:{get_config().BACKEND_HTTPS_PORT}"


@pytest.fixture
def captured_appends(monkeypatch):
    """把 routers.pc.append_perception 换成捕获桩，记录每次调用的实参。"""
    captured = []

    def fake_append(entry, user_id="default", auto_type=True, date_str=None):
        captured.append({
            "entry": entry,
            "auto_type": auto_type,
            "date_str": date_str,
        })
        return True

    monkeypatch.setattr("routers.pc.append_perception", fake_append)
    return captured


class TestPcSyncEventDateBucket:
    """POST /api/pc/sync 按原始 t_iso 推导分桶日期"""

    def test_late_batch_lands_on_event_date_today_and_garbage_fall_back(
        self, client, auth_headers, captured_appends, caplog,
    ):
        # Given: 迟到批量上传——跨午夜旧事件 / 无 t_iso 事件 / 垃圾 t_iso 事件
        body = {
            "agent_id": "agent-t5",
            "agent_name": "T5 测试机",
            "events": [
                {
                    "type": "pc_window",
                    "t_iso": "2026-10-11T23:58:00+08:00",
                    "payload": {"process": "code.exe"},
                },
                {"type": "pc_idle", "payload": {"state": "idle", "idle_seconds": 120}},
                {"type": "pc_screen", "t_iso": "not-a-timestamp", "payload": {"state": "locked"}},
            ],
        }

        # When: 走真实端点同步
        with caplog.at_level(logging.WARNING, logger="routers.pc"):
            resp = client.post(
                "/api/pc/sync",
                json=body,
                headers={**auth_headers, "host": _TEST_HOST},
            )

        # Then: 端点成功接收全部 3 条
        assert resp.status_code == 200
        assert resp.json() == {"success": True, "count": 3, "total": 3}
        assert len(captured_appends) == 3
        # 全部沿用 auto_type=False（不回归旧行为）
        assert all(c["auto_type"] is False for c in captured_appends)

        # 1) 迟到事件：date_str 必须是事件自身日期，绝不能是今天
        late = captured_appends[0]
        assert late["date_str"] == "2026-10-11"
        # 推导必须来自原始 event.t_iso，而不是兜底后的 entry["t_iso"]
        assert late["entry"]["t_iso"] == "2026-10-11T23:58:00+08:00"

        # 2) 无 t_iso：date_str=None 走今天路径。
        #    若实现误用兜底后的 entry["t_iso"]（now）推导，这里会得到今天日期而非 None。
        no_ts = captured_appends[1]
        assert no_ts["date_str"] is None
        assert no_ts["entry"]["t_iso"] is not None  # entry 仍按旧逻辑兜底为 now

        # 3) 垃圾 t_iso：fail-soft 到 None（今天），且打且仅打一条 warning
        garbage = captured_appends[2]
        assert garbage["date_str"] is None
        warnings = [
            r for r in caplog.records
            if r.name == "routers.pc" and r.levelno == logging.WARNING
        ]
        assert len(warnings) == 1
