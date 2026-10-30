# -*- coding: utf-8 -*-
"""LoomClient 离线单测 - 协议映射/信封同构/显式缺面。

零触网：全部 HTTP 面经桩替换 LoomClient._request（异步 fake），
SSE 面由 test_ai_client_factory 的 LoomEventHub 用例单独覆盖。
本 venv 无 pytest-asyncio，统一以 asyncio.run 同步驱动（同 test_opencode_client_envelope 惯例）。
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest

from config.config import get_config
import services.opencode_client as oc
import services.loom_client as lc


def _make_client(monkeypatch, handler):
    """构造挂桩客户端：_request → handler(method, path, params, json_body) -> (status, data, headers)。"""
    client = lc.LoomClient(base_url="http://loom.test:5100")

    calls = []

    async def _fake(method, path, *, params=None, json_body=None, timeout=None):
        calls.append({"method": method, "path": path, "params": params, "json_body": json_body})
        return handler(method, path, params, json_body)

    monkeypatch.setattr(client, "_request", _fake)
    return client, calls


def _set_mock(enabled: bool):
    cfg = get_config()
    cfg._data.setdefault("features", {})["opencode_mock_enabled"] = enabled


class TestSessionLifecycle:
    def test_create_session_maps_201(self, monkeypatch):
        client, calls = _make_client(
            monkeypatch,
            lambda m, p, q, b: (201, {"sessionID": "abc_123", "status": "idle"}, {}),
        )
        r = asyncio.run(client.create_session(title="标题由本地维护"))
        assert r["ok"] is True
        assert r["data"]["session_id"] == "abc_123"
        assert calls[0]["method"] == "POST" and calls[0]["path"] == "/sessions"

    def test_list_sessions_uses_main_endpoint_only(self, monkeypatch):
        main = {"sessionID": "ses_main", "status": "idle", "createdAt": 1792000000000,
                "title": "主会话", "archived": False}
        client, calls = _make_client(
            monkeypatch, lambda m, p, q, b: (200, dict(main), {}),
        )
        r = asyncio.run(client.list_sessions(limit=5))
        assert r["ok"] is True
        s = r["data"]["sessions"][0]
        assert s["session_id"] == "ses_main" and s["id"] == "ses_main"
        assert s["sessionID"] == "ses_main"
        assert calls == [
            {"method": "GET", "path": "/sessions/main", "params": None, "json_body": None}
        ]
        assert all(c["path"] != "/sessions" for c in calls)

    def test_list_sessions_session_id_status_200_returns_single_row(self, monkeypatch):
        view = {"sessionID": "s1", "status": "busy", "lastError": None,
                "activeRuns": 1, "turns": 4}
        client, calls = _make_client(
            monkeypatch, lambda m, p, q, b: (200, dict(view), {}),
        )
        r = asyncio.run(client.list_sessions(session_id="s1"))
        assert r["ok"] is True
        assert r["data"]["sessions"] == [
            {**view, "session_id": "s1", "id": "s1"}
        ]
        assert [c["path"] for c in calls] == ["/sessions/s1/status"]

    def test_list_sessions_session_id_404_falls_back_to_main(self, monkeypatch):
        main = {"sessionID": "ses_main", "status": "idle", "createdAt": 1, "archived": False}

        def handler(m, p, q, b):
            if p == "/sessions/stale/status":
                return (404, {"error": {"code": "not_found",
                                        "message": "no session"}}, {})
            return (200, dict(main), {})

        client, calls = _make_client(monkeypatch, handler)
        r = asyncio.run(client.list_sessions(session_id="stale"))
        assert r["ok"] is True
        assert r["data"]["sessions"][0]["sessionID"] == "ses_main"
        assert [c["path"] for c in calls] == [
            "/sessions/stale/status", "/sessions/main",
        ]

    def test_list_sessions_session_id_503_fails_without_main_fallback(self, monkeypatch):
        client, calls = _make_client(
            monkeypatch,
            lambda m, p, q, b: (503, {"error": {"message": "loom down"}}, {}),
        )
        r = asyncio.run(client.list_sessions(session_id="s1"))
        assert r["ok"] is False and r["error"]["source"] == "loom"
        assert "HTTP 503" in r["error"]["detail"]
        assert len(calls) == 1 and calls[0]["path"] == "/sessions/s1/status"

    def test_list_sessions_session_id_transport_error_fails_envelope(self, monkeypatch):
        def _boom(m, p, q, b):
            raise ConnectionError("wire down")

        client, calls = _make_client(monkeypatch, _boom)
        r = asyncio.run(client.list_sessions(session_id="s1"))
        assert r["ok"] is False and r["error"]["source"] == "system"
        assert "wire down" in r["error"]["detail"]
        assert len(calls) == 1

    @pytest.mark.parametrize("status", [404, 503])
    def test_list_sessions_main_unavailable_fails_envelope(self, monkeypatch, status):
        client, _ = _make_client(
            monkeypatch,
            lambda m, p, q, b: (status, {"error": {"message": "no main"}}, {}),
        )
        r = asyncio.run(client.list_sessions())
        assert r["ok"] is False and r["error"]["source"] == "loom"
        assert f"HTTP {status}" in r["error"]["detail"]

    def test_list_sessions_main_transport_error_fails_envelope(self, monkeypatch):
        def _boom(m, p, q, b):
            raise ConnectionError("wire down")

        client, _ = _make_client(monkeypatch, _boom)
        r = asyncio.run(client.list_sessions())
        assert r["ok"] is False and r["error"]["source"] == "loom"
        assert "wire down" in r["error"]["detail"]

    def test_abort_returns_loom_real_aborted_flag(self, monkeypatch):
        client, calls = _make_client(
            monkeypatch,
            lambda m, p, q, b: (200, {"sessionID": "s1", "aborted": False, "status": "idle"}, {}),
        )
        r = asyncio.run(client.abort_session("s1"))
        assert r["ok"] is True
        # loom 语义如实透传：无在途轮 → aborted=False（opencode 恒 True，见 loom_client 模块头）
        assert r["data"]["aborted"] is False
        assert calls[0]["path"] == "/sessions/s1/abort"

    def test_session_status_pass_through(self, monkeypatch):
        view = {"sessionID": "s1", "status": "busy", "lastError": None, "activeRuns": 0, "turns": 3}
        client, _ = _make_client(monkeypatch, lambda m, p, q, b: (200, view, {}))
        r = asyncio.run(client.get_session_status("s1"))
        assert r["ok"] is True and r["data"] == view


class TestSendMessage:
    def test_message_keeps_home_system_envelope(self, monkeypatch):
        client, calls = _make_client(
            monkeypatch, lambda m, p, q, b: (202, {"accepted": True}, {})
        )
        r = asyncio.run(client.send_message("s1", "【场景】测试正文", agent="ignored"))
        assert r["ok"] is True
        body = calls[0]["json_body"]
        assert calls[0]["path"] == "/sessions/s1/messages"
        # 与 opencode 版逐字符同形的 <Axeuh-home-system> 信封（前端零改动依赖此形状）
        assert body["text"].startswith("<Axeuh-home-system>\n{\n  \"current_datetime\"")
        assert "</Axeuh-home-system>\n\n【场景】测试正文" in body["text"]

    def test_busy_409_fails_envelope(self, monkeypatch):
        client, _ = _make_client(
            monkeypatch,
            lambda m, p, q, b: (409, {"error": {"code": "session_busy",
                                                 "message": "session s1 has a turn in progress"}}, {}),
        )
        r = asyncio.run(client.send_message("s1", "hi"))
        assert r["ok"] is False
        assert r["error"]["source"] == "loom"
        assert "turn in progress" in r["error"]["detail"]

    def test_busy_queued_202_is_plain_ok_envelope(self, monkeypatch):
        """D1 钉（W29-A4/W16-F1 现实）：status=busy 且 queued=true 的 202=正常受理排队，
        信封照 ok 回——排队对调用方透明，不得被"严判"成失败（旧注释"409 显式背压"已作废）。

        W43 升级：断言扩展为 queued is True 且 ok——严格超集（queued 为纯增量透传键，
        202 恒 ok 的 D1 语义不变），钉住 _raw_send_message→信封 的排队标志透传链。"""
        client, _ = _make_client(
            monkeypatch,
            lambda m, p, q, b: (202, {"sessionID": "s1", "status": "busy",
                                      "accepted": True, "queued": True}, {}),
        )
        r = asyncio.run(client.send_message("s1", "hi"))
        assert r["ok"] is True and r["error"] is None
        assert r["data"] == {"sent": True, "session_id": "s1", "queued": True}

    def test_202_without_queued_key_envelope_queued_none(self, monkeypatch):
        """202 body 无 queued 键 → 信封 queued=None（未知≠未排队，如实缺省）。"""
        client, _ = _make_client(
            monkeypatch, lambda m, p, q, b: (202, {"accepted": True}, {}),
        )
        r = asyncio.run(client.send_message("s1", "hi"))
        assert r["ok"] is True
        assert r["data"] == {"sent": True, "session_id": "s1", "queued": None}

    def test_voice_uses_native_voice_endpoint(self, monkeypatch):
        """send_voice_to_opencode 走 loom 原生 /voice（先中止再发送），并沿用本地会话绑定。"""
        client, calls = _make_client(
            monkeypatch, lambda m, p, q, b: (202, {"accepted": True}, {})
        )
        # 桩会话管理器：main-task 已绑定 s9
        class _Mgr:
            def get_agent_session(self, agent):
                return "s9"
            def set_current_session(self, *a, **k):
                raise AssertionError("不应新建会话")
        monkeypatch.setattr("services.stt_session_manager.get_session_manager", lambda: _Mgr())
        ok = asyncio.run(client.send_voice_to_opencode("语音正文", agent="main-task"))
        assert ok is True
        assert calls[0]["path"] == "/sessions/s9/voice"
        body = calls[0]["json_body"]["text"]
        assert body.startswith("<Axeuh-home-system>")
        assert '"current_datetime"' in body
        assert body.endswith("\n\n语音正文")


class TestHistoryPagination:
    def test_history_transforms_pi_messages(self, monkeypatch):
        page = {
            "sessionID": "s1",
            "messages": [
                {"role": "user", "content": "<Axeuh-home-system>x</Axeuh-home-system>\n真实提问",
                 "timestamp": 1000},
                {"role": "assistant", "content": [{"type": "text", "text": "回答"}],
                 "model": "m", "provider": "p", "stopReason": "stop",
                 "usage": {"totalTokens": 9, "input": 5, "output": 4, "cacheRead": 1, "cacheWrite": 0},
                 "timestamp": 2000},
            ],
            "nextCursor": "Y3Vyc29y",
        }
        client, calls = _make_client(monkeypatch, lambda m, p, q, b: (200, page, {"x-next-cursor": "Y3Vyc29y"}))
        r = asyncio.run(client.get_session_messages("s1", limit=50, before="abc"))
        assert r["ok"] is True
        assert calls[0]["params"] == {"limit": 50, "before": "abc"}
        msgs = r["data"]["messages"]
        assert r["data"]["next_cursor"] == "Y3Vyc29y"
        # user：opencode {info,parts} 形状 + 毫秒时间戳（前端/剥离逻辑零改动的关键）
        assert msgs[0]["info"]["role"] == "user"
        assert msgs[0]["info"]["time"]["created"] == 1000
        assert msgs[0]["parts"][0]["type"] == "text"
        # assistant：tokens 六字段 + text part（W43 起 part 带稳定字段 id/messageID/sessionID）
        assert msgs[1]["info"]["tokens"]["total"] == 9
        assert msgs[1]["info"]["tokens"]["cache"] == {"read": 1, "write": 0}
        ap = msgs[1]["parts"][0]
        assert ap["type"] == "text" and ap["text"] == "回答"
        assert ap["id"] == "part_hist_2000_1_0"
        assert ap["messageID"] == msgs[1]["info"]["id"] == "msg_hist_2000_1"
        assert ap["sessionID"] == "s1"

    def test_history_merges_toolresult_into_tool_part(self, monkeypatch):
        """整链钉：history 页含 toolResult 时，信封侧可见 assistant tool part 带 output、
        且不再出现独立 toolResult 消息（用户可见 bug"bash 输出独立气泡"的回归面）。"""
        page = {
            "sessionID": "s1",
            "messages": [
                {"role": "assistant", "timestamp": 2000,
                 "content": [{"type": "thinking", "thinking": "想"},
                             {"type": "toolCall", "id": "c1", "name": "bash",
                              "arguments": {"command": "ls"}}]},
                {"role": "toolResult", "toolCallId": "c1", "toolName": "bash",
                 "content": "a.txt", "timestamp": 2100},
            ],
            "nextCursor": None,
        }
        client, _ = _make_client(monkeypatch, lambda m, p, q, b: (200, page, {}))
        r = asyncio.run(client.get_session_messages("s1"))
        msgs = r["data"]["messages"]
        assert [m["info"]["role"] for m in msgs] == ["assistant"]
        assert msgs[0]["parts"][0]["type"] == "reasoning"
        tool = msgs[0]["parts"][1]
        assert tool["callID"] == "c1"
        assert tool["state"]["output"] == "a.txt"
        assert tool["state"]["status"] == "completed"

    def test_messages_range_paginates_backwards(self, monkeypatch):
        """两页翻页：第二页游标来自 x-next-cursor；到早界（<start_ms）停止。"""
        def handler(m, p, q, b):
            if q and q.get("before") == "c1":
                return (200, {"messages": [{"role": "user", "content": "早", "timestamp": 50}],
                              "nextCursor": None}, {})
            return (200, {"messages": [{"role": "user", "content": "晚", "timestamp": 150}],
                          "nextCursor": "c1"}, {"x-next-cursor": "c1"})
        client, calls = _make_client(monkeypatch, handler)
        r = asyncio.run(client.get_session_messages_range("s1", start_ms=100))
        assert r["ok"] is True
        ts = [m["info"]["time"]["created"] for m in r["data"]["messages"]]
        assert ts == sorted(ts)  # 升序（旧→新）
        assert r["data"]["truncated"] is False


MAIN_VIEW = {"sessionID": "ses_main", "status": "idle", "createdAt": 1792000000000,
             "title": "主会话", "archived": False}


class TestMainSessionWire:
    """GET /sessions/main 是唯一会话发现面；GET /sessions 列表面已废弃（默认 404）。"""

    def test_raw_get_main_session_200(self, monkeypatch):
        client, calls = _make_client(monkeypatch, lambda m, p, q, b: (200, dict(MAIN_VIEW), {}))
        data, error = asyncio.run(client._raw_get_main_session())
        assert error is None and data == MAIN_VIEW
        assert calls == [
            {"method": "GET", "path": "/sessions/main", "params": None, "json_body": None}
        ]

    @pytest.mark.parametrize("status,body", [
        (404, {"error": {"message": "no main"}}),
        (503, "loom down"),
    ])
    def test_raw_get_main_session_non_200_returns_error(self, monkeypatch, status, body):
        client, _ = _make_client(monkeypatch, lambda m, p, q, b: (status, body, {}))
        data, error = asyncio.run(client._raw_get_main_session())
        assert data is None and f"HTTP {status}" in error

    def test_raw_get_main_session_200_without_session_id_is_error(self, monkeypatch):
        client, _ = _make_client(monkeypatch, lambda m, p, q, b: (200, {"status": "idle"}, {}))
        data, error = asyncio.run(client._raw_get_main_session())
        assert data is None and "HTTP 200" in error

    def test_raw_get_main_session_transport_error_returns_error(self, monkeypatch):
        def _boom(m, p, q, b):
            raise ConnectionError("transport down")

        client, _ = _make_client(monkeypatch, _boom)
        data, error = asyncio.run(client._raw_get_main_session())
        assert data is None and "transport down" in error

    def test_get_main_session_envelope_passthrough(self, monkeypatch):
        client, _ = _make_client(monkeypatch, lambda m, p, q, b: (200, dict(MAIN_VIEW), {}))
        r = asyncio.run(client.get_main_session())
        assert r == {"ok": True, "data": MAIN_VIEW, "error": None}

    def test_get_main_session_envelope_fails_on_non_200(self, monkeypatch):
        client, _ = _make_client(monkeypatch, lambda m, p, q, b: (404, {"error": {"message": "no main"}}, {}))
        r = asyncio.run(client.get_main_session())
        assert r["ok"] is False and r["error"]["source"] == "loom"

    def test_get_main_session_id_returns_id(self, monkeypatch):
        client, _ = _make_client(monkeypatch, lambda m, p, q, b: (200, dict(MAIN_VIEW), {}))
        assert asyncio.run(client.get_main_session_id()) == "ses_main"

    def test_get_main_session_id_raises_when_unavailable(self, monkeypatch):
        client, _ = _make_client(monkeypatch, lambda m, p, q, b: (404, {"error": {"message": "no main"}}, {}))
        with pytest.raises(ConnectionError):
            asyncio.run(client.get_main_session_id())

    def test_get_main_session_id_raises_on_transport_error(self, monkeypatch):
        def _boom(m, p, q, b):
            raise ConnectionError("transport down")

        client, _ = _make_client(monkeypatch, _boom)
        with pytest.raises(ConnectionError):
            asyncio.run(client.get_main_session_id())

    def test_list_helpers_are_removed(self):
        assert not hasattr(lc.LoomClient, "list_session_ids")
        assert not hasattr(lc.LoomClient, "_raw_list_sessions")

    def test_get_all_sessions_status_is_main_only(self, monkeypatch):
        client, calls = _make_client(monkeypatch, lambda m, p, q, b: (200, dict(MAIN_VIEW), {}))
        status_map, error = asyncio.run(client.get_all_sessions_status())
        assert error is None
        assert status_map == {"ses_main": {"state": "idle"}}
        assert [c["path"] for c in calls] == ["/sessions/main"]

    def test_get_active_sessions_is_main_only(self, monkeypatch):
        client, calls = _make_client(monkeypatch, lambda m, p, q, b: (200, dict(MAIN_VIEW), {}))
        r = asyncio.run(client.get_active_sessions())
        assert r["ok"] is True
        assert r["data"]["active_sessions"][0]["sessionID"] == "ses_main"
        assert [c["path"] for c in calls] == ["/sessions/main"]


class TestGetSessionChildrenTasks:
    """W29-A2（D3）：children 显式缺 → GET /tasks 全量+parent_session 客户端过滤。

    改写说明：旧钉 test_get_session_children_raises（NotImplementedError）作废合法——
    该假设出自 C02 冻结（loom 无 children 数据源），W23-C 任务面合流后 /tasks 在场，
    继续打穿=前端子面板静默降级（audit R4），必须给真信封。
    """

    def test_children_from_tasks_happy_path(self, monkeypatch):
        rows = {"tasks": [
            {"task_id": "t1", "agent_type": "explore", "workflow": "sub.explore",
             "parent_session": "s1", "session_id": "c1", "status": "running"},
            {"task_id": "t2", "agent_type": "librarian", "workflow": "sub.librarian",
             "parent_session": "other", "session_id": "c2", "status": "done"},
            {"task_id": "t4", "workflow": "sub.plan",
             "parent_session": "s1", "session_id": "c3", "status": "done"},
        ], "count": 3}
        client, calls = _make_client(monkeypatch, lambda m, p, q, b: (200, rows, {}))
        r = asyncio.run(client.get_session_children("s1"))
        assert r["ok"] is True
        kids = r["data"]["children"]
        assert [k["id"] for k in kids] == ["c1", "c3"]  # 只留 parent_session==s1
        assert kids[0]["title"] == "explore" and kids[0]["type"] == "explore"
        assert kids[0]["status"] == "running"  # status 逐字透传
        assert kids[1]["title"] == "sub.plan"  # agent_type 缺 → workflow 回填 title
        assert calls[0]["method"] == "GET" and calls[0]["path"] == "/tasks"

    def test_children_skips_ledger_only_gap_rows(self, monkeypatch):
        # session_id=null 的账本-only 行（任务已派生、子会话未落）不可入 children
        rows = {"tasks": [
            {"task_id": "t5", "agent_type": "explore", "parent_session": "s1",
             "session_id": None, "status": "queued"},
        ], "count": 1}
        client, _ = _make_client(monkeypatch, lambda m, p, q, b: (200, rows, {}))
        r = asyncio.run(client.get_session_children("s1"))
        assert r["ok"] is True and r["data"]["children"] == []

    def test_children_title_prefers_row_title_and_created_at_exact(self, monkeypatch):
        # W49.3：行内若带人读 title（W49.2 loom 侧注入）→ title 直接胜出；
        # dispatched_at（int 毫秒）原样转发为 createdAt，精确到毫秒不做任何加工
        rows = {"tasks": [
            {"task_id": "t9", "title": "数据检查-22点班", "agent_type": "data-checker",
             "workflow": "sub.check", "parent_session": "s1", "session_id": "c9",
             "status": "done", "dispatched_at": 1792072961364},
        ], "count": 1}
        client, _ = _make_client(monkeypatch, lambda m, p, q, b: (200, rows, {}))
        kid = asyncio.run(client.get_session_children("s1"))["data"]["children"][0]
        assert kid["title"] == "数据检查-22点班"  # title 优先，盖过 agent_type
        assert kid["type"] == "data-checker"      # type 仍取 agent_type，不随 title 换
        assert kid["createdAt"] == 1792072961364  # 毫秒整值逐字转发

    def test_children_title_fallback_byte_identical_without_title(self, monkeypatch):
        # 行内无 title / 无 dispatched_at（W49.2 未落地或字段缺）→
        # title 回退链与旧映射逐字节一致：agent_type 优先、缺省 workflow 回填
        rows = {"tasks": [
            {"task_id": "t10", "agent_type": "explore", "workflow": "sub.explore",
             "parent_session": "s1", "session_id": "c10", "status": "running"},
            {"task_id": "t11", "workflow": "sub.plan",
             "parent_session": "s1", "session_id": "c11", "status": "done"},
        ], "count": 2}
        client, _ = _make_client(monkeypatch, lambda m, p, q, b: (200, rows, {}))
        kids = asyncio.run(client.get_session_children("s1"))["data"]["children"]
        # 服务层不加排序：行序原样透传（排序归前端）
        assert [k["id"] for k in kids] == ["c10", "c11"]
        assert kids[0]["title"] == "explore"    # 旧回退值原样
        assert kids[1]["title"] == "sub.plan"   # agent_type 缺 → workflow 回填原样

    def test_children_created_at_key_present_null_when_missing(self, monkeypatch):
        # 行内无 dispatched_at → createdAt 键恒在、值为 None（前端按缺失处理）
        rows = {"tasks": [
            {"task_id": "t12", "agent_type": "explore", "parent_session": "s1",
             "session_id": "c12", "status": "queued"},
        ], "count": 1}
        client, _ = _make_client(monkeypatch, lambda m, p, q, b: (200, rows, {}))
        kid = asyncio.run(client.get_session_children("s1"))["data"]["children"][0]
        assert "createdAt" in kid and kid["createdAt"] is None

    def test_children_created_at_zero_forwarded_raw(self, monkeypatch):
        # dispatched_at=0 原样转发 0，绝不归 None（前端把 ≤0 一律当缺失）
        rows = {"tasks": [
            {"task_id": "t13", "agent_type": "explore", "parent_session": "s1",
             "session_id": "c13", "status": "done", "dispatched_at": 0},
        ], "count": 1}
        client, _ = _make_client(monkeypatch, lambda m, p, q, b: (200, rows, {}))
        kid = asyncio.run(client.get_session_children("s1"))["data"]["children"][0]
        assert kid["createdAt"] == 0


class TestSummarizeForwarding:
    """P5：Loom 手动压缩转发 POST /sessions/:id/compact，不再返回本地垫圈。"""

    def test_summarize_forwards_to_compact_endpoint(self, monkeypatch):
        client, calls = _make_client(
            monkeypatch,
            lambda method, path, params, body: (
                202,
                {"sessionID": "s1", "status": "compacting", "attemptId": "attempt-1"},
                {},
            ),
        )
        r = asyncio.run(client.summarize_session("s1", model_id="m", provider_id="p"))
        assert r["ok"] is True and r["error"] is None
        assert r["data"]["attemptId"] == "attempt-1"
        assert calls == [
            {"method": "POST", "path": "/sessions/s1/compact", "params": None, "json_body": {}}
        ]

    def test_summarize_maps_upstream_error(self, monkeypatch):
        client, _ = _make_client(
            monkeypatch,
            lambda *a: (409, {"error": {"message": "busy"}}, {}),
        )
        r = asyncio.run(client.summarize_session("s1"))
        assert r["ok"] is False
        assert r["error"]["code"] == 409
        assert "busy" in r["error"]["detail"]


class TestCatalogAndMock:
    def test_available_models_groups_by_provider(self, monkeypatch):
        monkeypatch.setattr(oc, "_model_config_loaded", True, raising=False)
        monkeypatch.setattr(oc, "_model_config_excluded", [], raising=False)
        monkeypatch.setattr(oc, "_model_config_data", {}, raising=False)
        client, calls = _make_client(
            monkeypatch,
            lambda m, p, q, b: (200, {"models": [
                {"id": "gpt-a", "provider": "openai"},
                {"id": "cl-b", "provider": "anthropic"},
            ], "count": 2}, {}),
        )
        r = asyncio.run(client.get_available_models())
        assert r["ok"] is True
        providers = r["data"]["providers"]
        assert calls[0]["path"] == "/catalog/models"
        assert {p["id"] for p in providers} == {"openai", "anthropic"}
        assert providers[0]["models"][0]["id"] in ("gpt-a", "cl-b")

    def test_mock_mode_short_circuits_transport(self, monkeypatch):
        _set_mock(True)
        try:
            client, calls = _make_client(monkeypatch, lambda *a: (_ for _ in ()).throw(AssertionError("不应触网")))
            r = asyncio.run(client.create_session())
            assert r["ok"] is True and r["data"]["session_id"].startswith("mock_ses_")
            assert calls == []
            s = asyncio.run(client.send_message("x", "y"))
            assert s["ok"] is True and s["data"]["sent"] is True
        finally:
            _set_mock(False)

    def test_bearer_header_present_when_token_configured(self, monkeypatch):
        cfg = get_config()
        saved = cfg._data.get("loom")
        cfg._data["loom"] = {"url": "http://loom.test:5100", "token": "tk-test"}
        try:
            headers = lc.LoomClient()._auth({"Accept": "application/json"})
            assert headers["Authorization"] == "Bearer tk-test"
        finally:
            cfg._data["loom"] = saved if saved is not None else {}


class TestActiveModelContextWindow:
    """GET /catalog/models → models[0] 上下文窗口（fail-open，任何异常/非法形状=None）。"""

    def test_returns_first_model_window_with_5s_budget(self, monkeypatch):
        captured = {}
        client = lc.LoomClient(base_url="http://loom.test:5100")

        async def _fake(method, path, *, params=None, json_body=None, timeout=None):
            captured.update(method=method, path=path,
                            total=timeout.total if timeout is not None else None)
            return 200, {"models": [
                {"id": "main-model", "provider": "prov-a", "contextWindow": 128000},
                {"id": "other", "provider": "prov-b", "contextWindow": 32000},
            ], "count": 2}, {}

        monkeypatch.setattr(client, "_request", _fake)
        got = asyncio.run(client.get_active_model_context_window())
        assert got == {"model": "main-model", "provider": "prov-a", "contextWindow": 128000}
        assert captured == {"method": "GET", "path": "/catalog/models", "total": 5}

    @pytest.mark.parametrize("first", [
        {"id": "m", "provider": "p"},                 # 缺 contextWindow
        {"id": "m", "provider": "p", "contextWindow": 0},   # 零
        {"id": "m", "provider": "p", "contextWindow": -1},  # 负
        {"id": "m", "provider": "p", "contextWindow": True},  # bool 不是正整数
        {"id": "m", "provider": "p", "contextWindow": "128000"},  # 字符串不猜
    ])
    def test_missing_or_invalid_window_is_none(self, monkeypatch, first):
        client, _ = _make_client(monkeypatch, lambda m, p, q, b: (200, {"models": [first]}, {}))
        assert asyncio.run(client.get_active_model_context_window()) is None

    def test_empty_or_non_dict_models_is_none(self, monkeypatch):
        client, _ = _make_client(monkeypatch, lambda m, p, q, b: (200, {"models": []}, {}))
        assert asyncio.run(client.get_active_model_context_window()) is None
        client, _ = _make_client(monkeypatch, lambda m, p, q, b: (200, {"models": ["x"]}, {}))
        assert asyncio.run(client.get_active_model_context_window()) is None

    def test_non_200_is_none(self, monkeypatch):
        client, _ = _make_client(monkeypatch, lambda m, p, q, b: (503, "loom down", {}))
        assert asyncio.run(client.get_active_model_context_window()) is None

    def test_offline_mode_returns_none_without_wire(self, monkeypatch):
        _set_mock(True)
        try:
            client, calls = _make_client(
                monkeypatch, lambda *a: (_ for _ in ()).throw(AssertionError("不应触网")))
            assert asyncio.run(client.get_active_model_context_window()) is None
            assert calls == []
        finally:
            _set_mock(False)

    def test_transport_exception_is_swallowed(self, monkeypatch):
        def _boom(m, p, q, b):
            raise asyncio.TimeoutError("5s budget spent")
        client, _ = _make_client(monkeypatch, _boom)
        assert asyncio.run(client.get_active_model_context_window()) is None


class TestCompactionSnapshotW51:
    """W51：GET /sessions/:id/compaction 核内压缩边界快照（fail-open=永不抛，失败=None）。"""

    SNAP = {
        "sessionID": "s1", "status": "active", "coveredCount": 337,
        "summaryText": "[auto-compacted summary of 337 earlier messages]",
        "anchorMessageId": "entry_9", "anchorTimestampMs": 1792000000000,
        "tailCount": 12, "totalMessages": 349,
    }

    def test_200_returns_parsed_snapshot(self, monkeypatch):
        client, calls = _make_client(monkeypatch, lambda m, p, q, b: (200, self.SNAP, {}))
        got = asyncio.run(client.get_session_compaction("s1"))
        assert got == self.SNAP
        assert calls[0] == {"method": "GET", "path": "/sessions/s1/compaction",
                            "params": None, "json_body": None}

    def test_wire_timeout_capped_short(self, monkeypatch):
        """历史页是 UI 热路径：超时预算钉死 2s（防慢引擎拖挂 messages 端点）。"""
        captured = {}
        client = lc.LoomClient(base_url="http://loom.test:5100")

        async def _fake(method, path, *, params=None, json_body=None, timeout=None):
            captured["total"] = timeout.total if timeout is not None else None
            return 200, self.SNAP, {}

        monkeypatch.setattr(client, "_request", _fake)
        assert asyncio.run(client.get_session_compaction("s1")) == self.SNAP
        assert captured["total"] == 2

    def test_non_200_is_none(self, monkeypatch):
        client, _ = _make_client(
            monkeypatch,
            lambda m, p, q, b: (404, {"error": {"code": "not_found",
                                                "message": "no session"}}, {}))
        assert asyncio.run(client.get_session_compaction("ghost")) is None

    def test_non_dict_body_is_none(self, monkeypatch):
        client, _ = _make_client(monkeypatch, lambda m, p, q, b: (200, "text/html", {}))
        assert asyncio.run(client.get_session_compaction("s1")) is None

    def test_transport_error_swallowed(self, monkeypatch):
        def _boom(m, p, q, b):
            raise asyncio.TimeoutError("2s budget spent")
        client, _ = _make_client(monkeypatch, _boom)
        assert asyncio.run(client.get_session_compaction("s1")) is None

    def test_mock_mode_returns_none_without_wire(self, monkeypatch):
        _set_mock(True)
        try:
            client, calls = _make_client(
                monkeypatch, lambda *a: (_ for _ in ()).throw(AssertionError("不应触网")))
            assert asyncio.run(client.get_session_compaction("s1")) is None
            assert calls == []
        finally:
            _set_mock(False)


class TestHealthCheck:
    def test_health_check_includes_version(self, monkeypatch):
        client, calls = _make_client(
            monkeypatch,
            lambda m, p, q, b: (200, {"status": "ok", "version": "d399298"}, {}),
        )
        result = asyncio.run(client.health_check())
        assert result["ok"] is True
        assert result["data"]["status"] == "online"
        assert result["data"]["version"] == "d399298"
        assert calls[0]["method"] == "GET"
        assert calls[0]["path"] == "/health"
