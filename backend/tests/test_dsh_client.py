# -*- coding: utf-8 -*-
"""dsh bridge 客户端 / 配置 / 工厂 / 选择器 / QQ 投递 离线单测。

HTTP 面用本地 aiohttp TestServer 桩（零外部进程、真实流式语义），逐条钉
bridge 契约：Bearer 头、单会话视图、消息时间信封、绑定校验、分页/子会话
形状、SSE 原样行、手动压缩/压缩快照/模型目录/上下文窗口四能力（含各自
降级面）与 letter 家族的显式缺面。本 venv 无 pytest-asyncio，统一
asyncio.run 驱动（test_ai_client_factory 先例）。
"""
import asyncio
import contextlib
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer

from config.config import get_config
import services.ai_client_factory as factory
import services.web_backend_selector as wbs
from services.dsh_client import DshClient
from services.qq_gateway.config import QQGatewayConfig
from services.qq_gateway.service import QQGatewayService


class _Bridge:
    """最小 kinship-bridge 桩：单绑定会话 + 记录所有写入。

    新增四路由（/v1/models、/v1/session/{context,compact,compaction}）按契约
    正常应答；要验真实 bridge 的 409/500/非 JSON body 等降级面走 overrides。
    """

    def __init__(self, bound="dsh-sess-1"):
        self.bound = bound
        self.auth_headers = []
        self.sent = []
        self.aborts = 0
        self.requests = []
        # 路径级原样覆盖：{path: (status, body)}，body 非 dict/list 时按纯文本回
        # （用于模拟非 200、非 JSON body 等降级面；默认空=按各自契约正常应答）
        self.overrides = {}
        self.compacts = 0
        self.compact_body = None
        self.compact_status = "accepted"
        self.compaction = None
        self.models = [
            {"id": "prov-a", "name": "提供商 A",
             "models": [{"id": "m1", "name": "模型一"}]},
        ]
        self.context = {
            "session_id": bound, "provider": "prov-a", "model": "m1",
            "contextWindow": 128000, "usedTokens": 1024,
            "projectedTokens": 1100,
        }
        self.children = [
            {"id": "child-1", "parent_id": "parent-0", "depth": 1, "kind": "child",
             "mode": "reviewer", "name": "review", "label": "复盘子代理",
             "activity": "running", "created_at": 123},
            {"name": "无 id 行应被丢弃"},
        ]
        self.sse_frames = [
            {"seq": 1, "payload": {"type": "session.idle",
                                   "properties": {"sessionID": bound}}},
        ]

    def _session_payload(self):
        return {"session_id": self.bound, "preset": "kinship", "status": "idle",
                "bound_at": 111, "policy": {"max_turns": 3}}

    async def handle(self, request):
        self.auth_headers.append(request.headers.get("Authorization"))
        path = request.path
        self.requests.append((request.method, path))
        if path in self.overrides:
            status, body = self.overrides[path]
            if isinstance(body, (dict, list)):
                return web.json_response(body, status=status)
            return web.Response(text="" if body is None else str(body), status=status)

        if path == "/v1/health":
            return web.json_response({
                "ok": True, "version": "0.2.1", "dsh": True,
                "session_id": self.bound, "preset": "kinship", "status": "ok",
            })

        if path == "/v1/session":
            return web.json_response(self._session_payload())

        if path == "/v1/session/status":
            return web.json_response({
                "session_id": self.bound, "status": "idle",
                "running": False, "last_turn_at": 999,
            })

        if path == "/v1/session/abort":
            self.aborts += 1
            return web.json_response(
                {"ok": True, "session_id": self.bound, "was_running": True},
                status=202,
            )

        if path == "/v1/session/messages" and request.method == "POST":
            if not self.bound:
                return web.json_response({"error": {"message": "unbound"}}, status=409)
            body = await request.json()
            self.sent.append(body)
            return web.json_response(
                {"accepted": True, "message_id": "msg-9", "session_id": self.bound},
                status=202,
            )

        if path == "/v1/session/messages":
            if request.query.get("before") == "2":
                return web.json_response({
                    "session_id": self.bound,
                    "messages": [{
                        "id": "m0", "role": "user",
                        "content": [{"type": "text", "text": "older"}],
                        "text": "older", "created_at": 500, "seq": 1,
                        "source": {"kind": "user"},
                    }],
                    "has_more": False,
                    "next_before": None,
                })
            return web.json_response({
                "session_id": self.bound,
                "messages": [
                    {"id": "m1", "role": "user",
                     "content": [{"type": "text", "text": "hello"}],
                     "text": "hello", "created_at": 1000, "seq": 2,
                     "source": {"kind": "user"}},
                    {"id": "m1b", "role": "assistant",
                     "content": [
                         {"type": "text", "text": "hi"},
                         {"type": "tool-call", "id": "call-1", "name": "read",
                          "arguments": "{\"path\": \"/x\"}"},
                     ],
                     "text": "hi", "created_at": 1500, "seq": 3},
                    {"id": "m1c", "role": "tool",
                     "content": [{"type": "text", "text": "file body"}],
                     "text": "file body", "created_at": 1600, "seq": 4,
                     "tool_call_id": "call-1", "is_error": False},
                ],
                "has_more": True,
                "next_before": 2,
            })

        if path == "/v1/session/children":
            return web.json_response({"children": self.children})

        # 以下四路由钉 bridge 新端点契约。桩沿用"未绑定也回 200"的风格（真实
        # bridge 是 409 no_kinship_session）；要验 409/500/坏 body 用 overrides。
        if path == "/v1/models":
            return web.json_response({"providers": self.models})

        if path == "/v1/session/context":
            return web.json_response(self.context)

        if path == "/v1/session/compact":
            self.compacts += 1
            self.compact_body = await request.read()
            if self.compact_status == "busy":
                return web.json_response(
                    {"error": "compaction_busy",
                     "message": "Manual compaction needs an idle session."},
                    status=409,
                )
            if self.compact_status == "unavailable":
                return web.json_response(
                    {"error": "compaction_unavailable",
                     "message": "This harness composition has no manual compaction command."},
                    status=500,
                )
            return web.json_response(
                {"accepted": True, "session_id": self.bound, "status": "compacting"},
                status=202,
            )

        if path == "/v1/session/compaction":
            snapshot = self.compaction or {}
            return web.json_response({
                "session_id": self.bound,
                "status": snapshot.get("status", "none"),
                "covered_count": snapshot.get("covered_count", 0),
                "summary_text": snapshot.get("summary_text", ""),
                "anchor_message_id": snapshot.get("anchor_message_id"),
                "anchor_timestamp_ms": snapshot.get("anchor_timestamp_ms"),
            })

        if path == "/v1/session/events":
            response = web.StreamResponse(
                headers={"Content-Type": "text/event-stream"})
            await response.prepare(request)
            for frame in self.sse_frames:
                await response.write(f"data: {json.dumps(frame)}\n\n".encode())
            await response.write_eof()
            return response

        return web.json_response({"error": {"message": "not found"}}, status=404)


@contextlib.asynccontextmanager
async def _serve(bridge):
    app = web.Application()
    app.router.add_route("*", "/{tail:.*}", bridge.handle)
    server = TestServer(app)
    await server.start_server()
    try:
        yield f"http://127.0.0.1:{server.port}"
    finally:
        await server.close()


def _run(coro):
    return asyncio.run(asyncio.wait_for(coro, 20))


def _set_backend(value):
    cfg = get_config()
    if value is None:
        return cfg._data.pop("ai_backend", None)
    old = cfg._data.get("ai_backend")
    cfg._data["ai_backend"] = value
    return old


@pytest.fixture(autouse=True)
def _reset_singletons():
    factory._reset_ai_client()
    yield
    factory._reset_ai_client()


@pytest.fixture
def dsh_cfg(monkeypatch):
    """隔离 dsh 配置：默认空令牌/无 token 文件（令牌测试自行覆盖）。"""
    cfg = get_config()
    original = cfg._data.get("dsh")
    cfg._data["dsh"] = {"url": "http://127.0.0.1:18765", "token": "",
                        "token_file": "", "timeout_seconds": 30}
    monkeypatch.delenv("DSH_TOKEN", raising=False)
    monkeypatch.delenv("KINSHIP_BRIDGE_TOKEN", raising=False)
    yield cfg
    if original is None:
        cfg._data.pop("dsh", None)
    else:
        cfg._data["dsh"] = original


class TestConfig:
    def test_properties_defaults_and_timeout_fallback(self, dsh_cfg):
        assert dsh_cfg.DSH_URL == "http://127.0.0.1:18765"
        assert dsh_cfg.DSH_TOKEN == ""
        assert dsh_cfg.DSH_TOKEN_FILE == ""
        assert dsh_cfg.DSH_TIMEOUT_SECONDS == 30
        dsh_cfg._data["dsh"]["timeout_seconds"] = 0
        assert dsh_cfg.DSH_TIMEOUT_SECONDS == 30
        dsh_cfg._data["dsh"]["timeout_seconds"] = "45"
        assert dsh_cfg.DSH_TIMEOUT_SECONDS == 45

    def test_token_precedence_config_over_file_over_env(self, dsh_cfg, tmp_path, monkeypatch):
        token_file = tmp_path / "dsh.token"
        token_file.write_text("from-file\n", encoding="utf-8")
        dsh_cfg._data["dsh"]["token_file"] = str(token_file)
        monkeypatch.setenv("DSH_TOKEN", "from-env")
        assert dsh_cfg.DSH_TOKEN == "from-file"

        dsh_cfg._data["dsh"]["token_file"] = ""
        assert dsh_cfg.DSH_TOKEN == "from-env"

        dsh_cfg._data["dsh"]["token"] = "from-config"
        assert dsh_cfg.DSH_TOKEN == "from-config"

    def test_token_env_accepts_bridge_default_name(self, dsh_cfg, monkeypatch):
        monkeypatch.delenv("DSH_TOKEN", raising=False)
        monkeypatch.setenv("KINSHIP_BRIDGE_TOKEN", "bridge-env-token")
        assert dsh_cfg.DSH_TOKEN == "bridge-env-token"

    def test_token_file_accepts_single_line_raw_secret(self, dsh_cfg, tmp_path):
        token_file = tmp_path / "raw.token"
        token_file.write_text("  raw-secret-value\n", encoding="utf-8")
        dsh_cfg._data["dsh"]["token_file"] = str(token_file)
        assert dsh_cfg.DSH_TOKEN == "raw-secret-value"

    def test_ai_backend_accepts_dsh(self):
        old = _set_backend("dsh")
        try:
            assert get_config().AI_BACKEND == "dsh"
            assert factory.get_ai_backend() == "dsh"
        finally:
            _set_backend(old)


class TestEnvelopeContract:
    def test_health_and_bearer_auth(self, dsh_cfg, monkeypatch):
        monkeypatch.setenv("DSH_TOKEN", "secret-token")
        bridge = _Bridge()

        async def scenario():
            async with _serve(bridge) as url:
                client = DshClient(base_url=url, timeout=5)
                result = await client.health_check()
                assert result["ok"] is True
                assert result["data"]["status"] == "online"
                assert result["data"]["version"] == "0.2.1"
                assert bridge.auth_headers[0] == "Bearer secret-token"

        _run(scenario())

    def test_health_offline_returns_envelope_not_exception(self):
        async def scenario():
            client = DshClient(base_url="http://127.0.0.1:1", timeout=0.2)
            result = await client.health_check()
            assert result["ok"] is True
            assert result["data"]["status"] == "offline"

        _run(scenario())

    def test_single_session_views(self):
        bridge = _Bridge()

        async def scenario():
            async with _serve(bridge) as url:
                client = DshClient(base_url=url, timeout=5)
                main = await client.get_main_session()
                assert main["ok"] is True
                assert main["data"]["sessionID"] == "dsh-sess-1"
                assert main["data"]["session_id"] == "dsh-sess-1"
                assert main["data"]["id"] == "dsh-sess-1"
                assert main["data"]["preset"] == "kinship"
                assert await client.get_main_session_id() == "dsh-sess-1"

                listed = await client.list_sessions()
                assert [s["sessionID"] for s in listed["data"]["sessions"]] == ["dsh-sess-1"]
                active = await client.get_active_sessions()
                assert len(active["data"]["active_sessions"]) == 1
                created = await client.create_session(title="ignored")
                assert created["data"]["session_id"] == "dsh-sess-1"

        _run(scenario())

    def test_list_sessions_mismatch_returns_empty(self):
        bridge = _Bridge()

        async def scenario():
            async with _serve(bridge) as url:
                client = DshClient(base_url=url, timeout=5)
                listed = await client.list_sessions(session_id="other")
                assert listed["ok"] is True
                assert listed["data"]["sessions"] == []

        _run(scenario())

    def test_unbound_is_404_semantics(self):
        bridge = _Bridge(bound=None)

        async def scenario():
            async with _serve(bridge) as url:
                client = DshClient(base_url=url, timeout=5)
                main = await client.get_main_session()
                assert main["ok"] is False
                assert main["error"]["detail"].startswith("HTTP 404")
                with pytest.raises(ConnectionError):
                    await client.get_main_session_id()

        _run(scenario())

    def test_send_message_wraps_current_datetime(self):
        bridge = _Bridge()

        async def scenario():
            async with _serve(bridge) as url:
                client = DshClient(base_url=url, timeout=5)
                result = await client.send_message("dsh-sess-1", "你好")
                assert result["ok"] is True
                assert result["data"]["sent"] is True
                assert result["data"]["message_id"] == "msg-9"
                text = bridge.sent[0]["text"]
                assert text.startswith("<Axeuh-home-system>")
                assert "current_datetime" in text
                assert text.endswith("\n\n你好")

        _run(scenario())

    def test_stale_session_id_normalizes_to_bound_session(self):
        bridge = _Bridge()

        async def scenario():
            async with _serve(bridge) as url:
                client = DshClient(base_url=url, timeout=5)
                result = await client.send_message("stale-sess", "hi")
                assert result["ok"] is True
                assert result["data"]["session_id"] == "dsh-sess-1"
                assert len(bridge.sent) == 1

        _run(scenario())

    def test_abort_and_status(self):
        bridge = _Bridge()

        async def scenario():
            async with _serve(bridge) as url:
                client = DshClient(base_url=url, timeout=5)
                status = await client.get_session_status("dsh-sess-1")
                assert status["data"]["running"] is False
                assert status["data"]["last_turn_at"] == 999
                aborted = await client.abort_session("dsh-sess-1")
                assert aborted["data"]["aborted"] is True
                assert aborted["data"]["session_id"] == "dsh-sess-1"
                assert bridge.aborts == 1

                stale = await client.abort_session("other")
                assert stale["ok"] is True
                assert stale["data"]["session_id"] == "dsh-sess-1"

        _run(scenario())

    def test_messages_normalize_and_paginate(self):
        bridge = _Bridge()

        async def scenario():
            async with _serve(bridge) as url:
                client = DshClient(base_url=url, timeout=5)
                first = await client.get_session_messages("dsh-sess-1", limit=3)
                assert first["ok"] is True
                messages = first["data"]["messages"]
                assert first["data"]["next_cursor"] == 2
                assert [m["info"]["id"] for m in messages] == ["m1", "m1b"]

                assistant = messages[1]
                assert assistant["info"]["role"] == "assistant"
                assert assistant["info"]["time"]["created"] == 1500
                text_part, tool_part = assistant["parts"]
                assert text_part == {
                    "type": "text", "text": "hi",
                    "id": "part_hist_1500_1_0",
                    "messageID": "m1b", "sessionID": "dsh-sess-1",
                }
                assert tool_part["type"] == "tool"
                assert tool_part["callID"] == "call-1"
                assert tool_part["tool"] == "read"
                assert tool_part["state"] == {
                    "status": "completed",
                    "input": {"path": "/x"},
                    "output": "file body",
                }

                second = await client.get_session_messages(
                    "dsh-sess-1", limit=3, before="2")
                assert second["data"]["messages"][0]["info"]["id"] == "m0"
                assert second["data"]["next_cursor"] is None

                ranged = await client.get_session_messages_range("dsh-sess-1")
                ids = [m["info"]["id"] for m in ranged["data"]["messages"]]
                assert ids == ["m0", "m1", "m1b"]

        _run(scenario())

    def test_children_and_sse(self):
        bridge = _Bridge()

        async def scenario():
            async with _serve(bridge) as url:
                client = DshClient(base_url=url, timeout=5)
                children = await client.get_session_children("dsh-sess-1")
                assert children["ok"] is True
                rows = children["data"]["children"]
                assert rows == [{"id": "child-1", "title": "复盘子代理",
                                 "type": "reviewer", "status": "running",
                                 "parentID": "parent-0", "createdAt": 123}]

                lines = [line async for line in client.stream_session_events("dsh-sess-1")]
                frames = [json.loads(line.split("data:", 1)[1])
                          for line in lines if line.startswith("data:")]
                assert frames[0]["payload"]["type"] == "session.idle"
                assert frames[0]["payload"]["properties"]["sessionID"] == "dsh-sess-1"

        _run(scenario())

    def test_optional_capabilities_contract_after_bridge_upgrade(self):
        """bridge 补齐四端点后：压缩/快照/目录/窗口转正，letter 家族仍缺面。

        旧契约（压缩 501 + 快照恒 None + 空 providers + 无窗口方法）已随
        kinship-bridge 新增 /v1/models、/v1/session/{context,compact,compaction}
        整体退役；本用例锁新语义：桩端点正常应答时信封/归一键逐键正确。
        """
        bridge = _Bridge()
        bridge.compaction = {
            "status": "active", "covered_count": 7, "summary_text": "摘要",
            "anchor_message_id": "m7", "anchor_timestamp_ms": 1792000000000,
        }

        async def scenario():
            async with _serve(bridge) as url:
                client = DshClient(base_url=url, timeout=5)
                summary = await client.summarize_session("dsh-sess-1")
                assert summary["ok"] is True
                assert summary["data"] == {"session_id": "dsh-sess-1",
                                           "status": "compacting"}
                compaction = await client.get_session_compaction("dsh-sess-1")
                assert compaction["status"] == "active"
                assert compaction["coveredCount"] == 7
                models = await client.get_available_models()
                assert [p["id"] for p in models["data"]["providers"]] == ["prov-a"]
                context = await client.get_active_model_context_window()
                assert context["contextWindow"] == 128000
                # letter 类在 bridge 无对应端点：故意不提供（调用方 getattr 守卫）
                assert not hasattr(client, "send_letter")
                assert not hasattr(client, "get_inbox_result")
                assert not hasattr(client, "get_inbox_status")

        _run(scenario())

    def test_send_voice_aborts_then_sends(self):
        bridge = _Bridge()

        async def scenario():
            async with _serve(bridge) as url:
                client = DshClient(base_url=url, timeout=5)
                ok = await client.send_voice_to_opencode("语音指令")
                assert ok is True
                assert bridge.aborts == 1
                assert bridge.sent[0]["text"].endswith("语音指令")

        _run(scenario())


class TestManualCompaction:
    """POST /v1/session/compact：空 body 转发 + 202/409/500 映射。"""

    def test_accepted_202_returns_compacting_envelope(self):
        bridge = _Bridge()

        async def scenario():
            async with _serve(bridge) as url:
                client = DshClient(base_url=url, timeout=5)
                # model_id/provider_id 只是接口同构入参，不影响转发
                result = await client.summarize_session(
                    "stale-sess", model_id="m", provider_id="p")
                assert result["ok"] is True
                assert result["error"] is None
                # 响应回传 bridge 真实绑定 id，不是调用方传入的旧标签
                assert result["data"] == {"session_id": "dsh-sess-1",
                                          "status": "compacting"}
                assert bridge.compacts == 1
                assert ("POST", "/v1/session/compact") in bridge.requests
                assert bridge.compact_body == b""  # 契约：空 body

        _run(scenario())

    def test_busy_maps_409_dsh_source(self):
        bridge = _Bridge()
        bridge.compact_status = "busy"

        async def scenario():
            async with _serve(bridge) as url:
                client = DshClient(base_url=url, timeout=5)
                result = await client.summarize_session("dsh-sess-1")
                assert result["ok"] is False
                assert result["data"] is None
                assert result["error"]["source"] == "dsh"
                assert result["error"]["code"] == 409
                assert "compaction_busy" in result["error"]["detail"]

        _run(scenario())

    def test_unavailable_maps_500(self):
        bridge = _Bridge()
        bridge.compact_status = "unavailable"

        async def scenario():
            async with _serve(bridge) as url:
                client = DshClient(base_url=url, timeout=5)
                result = await client.summarize_session("dsh-sess-1")
                assert result["ok"] is False
                assert result["error"]["source"] == "dsh"
                assert result["error"]["code"] == 500
                assert "compaction_unavailable" in result["error"]["detail"]

        _run(scenario())

    def test_transport_error_is_system_source(self):
        client = DshClient(base_url="http://127.0.0.1:1", timeout=0.2)
        result = _run(client.summarize_session("dsh-sess-1"))
        assert result["ok"] is False
        assert result["error"]["source"] == "system"
        assert "summarize_session" in result["error"]["detail"]


class TestCompactionSnapshot:
    """GET /v1/session/compaction：snake_case -> loom W51A camelCase，fail-open。"""

    SNAP = {
        "status": "active", "covered_count": 337,
        "summary_text": "[auto-compacted summary of 337 earlier messages]",
        "anchor_message_id": "entry_9", "anchor_timestamp_ms": 1792000000000,
    }
    KEYS = {"sessionID", "status", "coveredCount", "summaryText",
            "anchorMessageId", "anchorTimestampMs"}

    def test_active_snapshot_maps_camel_case(self):
        bridge = _Bridge()
        bridge.compaction = dict(self.SNAP)

        async def scenario():
            async with _serve(bridge) as url:
                client = DshClient(base_url=url, timeout=5)
                got = await client.get_session_compaction("dsh-sess-1")
                assert set(got) == self.KEYS
                assert got == {
                    "sessionID": "dsh-sess-1",
                    "status": "active",
                    "coveredCount": 337,
                    "summaryText": "[auto-compacted summary of 337 earlier messages]",
                    "anchorMessageId": "entry_9",
                    "anchorTimestampMs": 1792000000000,
                }

        _run(scenario())

    def test_no_snapshot_returns_safe_defaults_with_all_keys(self):
        bridge = _Bridge()  # compaction=None -> bridge 回 status none / 全缺省

        async def scenario():
            async with _serve(bridge) as url:
                client = DshClient(base_url=url, timeout=5)
                got = await client.get_session_compaction("dsh-sess-1")
                assert got == {
                    "sessionID": "dsh-sess-1",
                    "status": "none",
                    "coveredCount": 0,
                    "summaryText": "",
                    "anchorMessageId": None,
                    "anchorTimestampMs": None,
                }

        _run(scenario())

    def test_malformed_values_fall_back_to_safe_defaults(self):
        """键恒在 + 类型安全：下游 int()/切片零防御。"""
        bridge = _Bridge()
        bridge.compaction = {
            "status": "running",          # 非 none/active -> none
            "covered_count": "7",         # 非 int -> 0
            "summary_text": None,         # 非 str -> ""
            "anchor_message_id": "",      # 空串 -> None
            "anchor_timestamp_ms": True,  # bool 不是 int -> None
        }

        async def scenario():
            async with _serve(bridge) as url:
                client = DshClient(base_url=url, timeout=5)
                got = await client.get_session_compaction("dsh-sess-1")
                assert got == {
                    "sessionID": "dsh-sess-1",
                    "status": "none",
                    "coveredCount": 0,
                    "summaryText": "",
                    "anchorMessageId": None,
                    "anchorTimestampMs": None,
                }

        _run(scenario())

    def test_non_200_is_none(self):
        bridge = _Bridge()
        bridge.overrides["/v1/session/compaction"] = (
            503, {"error": "unavailable", "message": "bridge down"})

        async def scenario():
            async with _serve(bridge) as url:
                client = DshClient(base_url=url, timeout=5)
                assert await client.get_session_compaction("dsh-sess-1") is None

        _run(scenario())

    def test_non_dict_body_is_none(self):
        bridge = _Bridge()
        bridge.overrides["/v1/session/compaction"] = (200, "text/html")

        async def scenario():
            async with _serve(bridge) as url:
                client = DshClient(base_url=url, timeout=5)
                assert await client.get_session_compaction("dsh-sess-1") is None

        _run(scenario())

    def test_transport_error_returns_none_without_raising(self):
        client = DshClient(base_url="http://127.0.0.1:1", timeout=0.2)
        assert _run(client.get_session_compaction("dsh-sess-1")) is None

    def test_wire_timeout_capped_at_2s(self, monkeypatch):
        captured = {}
        client = DshClient(base_url="http://dsh.test:18765")

        async def _fake(method, path, *, params=None, json_body=None, timeout=None):
            captured.update(method=method, path=path, total=timeout)
            return 200, {}, {}

        monkeypatch.setattr(client, "_request", _fake)
        assert _run(client.get_session_compaction("s1")) is not None
        assert captured == {"method": "GET", "path": "/v1/session/compaction",
                            "total": 2}


class TestModelCatalog:
    """GET /v1/models：归一 opencode/loom 同构 providers，失败降级空目录。"""

    def test_models_normalized_and_defensive(self):
        bridge = _Bridge()
        bridge.models = [
            {"id": "prov-a", "name": "提供商 A", "models": [
                {"id": "m1", "name": "模型一"},
                {"id": "m2"},                      # name 缺省回退 id
                {"name": "无 id 模型应丢弃"},
                "非 dict 模型行应丢弃",
            ]},
            {"id": "prov-empty", "name": "空目录",
             "models": []},                        # 无有效模型 -> 整个 provider 不出现
            {"name": "无 id provider 应丢弃"},
            "非 dict provider 行应丢弃",
        ]

        async def scenario():
            async with _serve(bridge) as url:
                client = DshClient(base_url=url, timeout=5)
                result = await client.get_available_models()
                assert result["ok"] is True
                assert result["error"] is None
                assert result["data"] == {"providers": [{
                    "id": "prov-a", "name": "提供商 A",
                    "models": [{"id": "m1", "name": "模型一"},
                               {"id": "m2", "name": "m2"}],
                }]}
                assert ("GET", "/v1/models") in bridge.requests

        _run(scenario())

    def test_provider_name_falls_back_to_id(self):
        bridge = _Bridge()
        bridge.models = [{"id": "prov-b", "models": [{"id": "m9", "name": "九"}]}]

        async def scenario():
            async with _serve(bridge) as url:
                client = DshClient(base_url=url, timeout=5)
                providers = (await client.get_available_models())["data"]["providers"]
                assert providers == [{"id": "prov-b", "name": "prov-b",
                                      "models": [{"id": "m9", "name": "九"}]}]

        _run(scenario())

    def test_non_200_degrades_to_empty_providers(self):
        bridge = _Bridge()
        bridge.overrides["/v1/models"] = (
            500, {"error": "catalog_failed", "message": "boom"})

        async def scenario():
            async with _serve(bridge) as url:
                client = DshClient(base_url=url, timeout=5)
                result = await client.get_available_models()
                # 降级不报错：仍是 ok 信封 + 空 providers（设置页照常用本地真源）
                assert result["ok"] is True
                assert result["data"] == {"providers": []}

        _run(scenario())

    def test_bad_shape_degrades_to_empty_providers(self):
        bridge = _Bridge()
        bridge.overrides["/v1/models"] = (200, {"providers": {"not": "a list"}})

        async def scenario():
            async with _serve(bridge) as url:
                client = DshClient(base_url=url, timeout=5)
                result = await client.get_available_models()
                assert result["ok"] is True
                assert result["data"] == {"providers": []}

        _run(scenario())

    def test_transport_error_degrades_to_empty_providers(self):
        client = DshClient(base_url="http://127.0.0.1:1", timeout=0.2)
        result = _run(client.get_available_models())
        assert result["ok"] is True
        assert result["data"] == {"providers": []}


class TestActiveModelContextWindow:
    """GET /v1/session/context：只认正整数窗口，其余 None 且永不抛。"""

    def test_positive_window_returns_route_triplet(self):
        bridge = _Bridge()

        async def scenario():
            async with _serve(bridge) as url:
                client = DshClient(base_url=url, timeout=5)
                got = await client.get_active_model_context_window()
                assert got == {"model": "m1", "provider": "prov-a",
                               "contextWindow": 128000}
                assert ("GET", "/v1/session/context") in bridge.requests

        _run(scenario())

    def test_null_model_or_provider_is_passthrough_none(self):
        bridge = _Bridge()
        bridge.context = {"session_id": "dsh-sess-1", "provider": None,
                          "model": None, "contextWindow": 64000,
                          "usedTokens": None, "projectedTokens": None}

        async def scenario():
            async with _serve(bridge) as url:
                client = DshClient(base_url=url, timeout=5)
                got = await client.get_active_model_context_window()
                assert got == {"model": None, "provider": None,
                               "contextWindow": 64000}

        _run(scenario())

    @pytest.mark.parametrize("window", [
        0,          # 零不可作分母
        -1,         # 负数
        True,       # bool 是 int 子类，显式排除
        "128000",   # 字符串不猜
        128000.5,   # 非整数
        None,       # 显式 null
    ])
    def test_non_positive_integer_window_is_none(self, window):
        bridge = _Bridge()
        bridge.context = dict(bridge.context, contextWindow=window)

        async def scenario():
            async with _serve(bridge) as url:
                client = DshClient(base_url=url, timeout=5)
                assert await client.get_active_model_context_window() is None

        _run(scenario())

    def test_missing_window_key_is_none(self):
        bridge = _Bridge()
        bridge.context = {"session_id": "dsh-sess-1", "provider": "p", "model": "m"}

        async def scenario():
            async with _serve(bridge) as url:
                client = DshClient(base_url=url, timeout=5)
                assert await client.get_active_model_context_window() is None

        _run(scenario())

    def test_unbound_409_is_none(self):
        """真实 bridge 未绑定回 409 no_kinship_session：降级为 None，不抛。"""
        bridge = _Bridge()
        bridge.overrides["/v1/session/context"] = (
            409, {"error": "no_kinship_session", "message": "no binding"})

        async def scenario():
            async with _serve(bridge) as url:
                client = DshClient(base_url=url, timeout=5)
                assert await client.get_active_model_context_window() is None

        _run(scenario())

    def test_non_dict_body_is_none(self):
        bridge = _Bridge()
        bridge.overrides["/v1/session/context"] = (200, "text/plain")

        async def scenario():
            async with _serve(bridge) as url:
                client = DshClient(base_url=url, timeout=5)
                assert await client.get_active_model_context_window() is None

        _run(scenario())

    def test_transport_error_returns_none_without_raising(self):
        client = DshClient(base_url="http://127.0.0.1:1", timeout=0.2)
        assert _run(client.get_active_model_context_window()) is None

    def test_wire_timeout_capped_at_5s(self, monkeypatch):
        captured = {}
        client = DshClient(base_url="http://dsh.test:18765")

        async def _fake(method, path, *, params=None, json_body=None, timeout=None):
            captured.update(method=method, path=path, total=timeout)
            return 200, {"provider": "p", "model": "m", "contextWindow": 128000}, {}

        monkeypatch.setattr(client, "_request", _fake)
        assert _run(client.get_active_model_context_window()) is not None
        assert captured == {"method": "GET", "path": "/v1/session/context",
                            "total": 5}


class TestFactoryAndSelector:
    def test_factory_routes_dsh_to_dsh_client(self):
        old = _set_backend("dsh")
        try:
            client = factory.get_ai_client()
            assert isinstance(client, DshClient)
            assert factory.get_ai_client() is client
            assert asyncio.run(factory.acquire_ai_client()) is client
        finally:
            _set_backend(old)

    def test_selector_accepts_dsh(self, monkeypatch, tmp_path, dsh_cfg):
        monkeypatch.setattr(wbs, "_state_path", lambda: tmp_path / "web_backend.json")
        sentinel = object()

        async def _acquire():
            return sentinel

        monkeypatch.setattr(wbs, "acquire_dsh_client", _acquire)
        monkeypatch.setattr(wbs, "get_dsh_client", lambda: sentinel)

        assert wbs.set_web_backend("dsh") == "dsh"
        assert wbs.get_web_backend() == "dsh"
        assert asyncio.run(wbs.acquire_web_client()) is sentinel
        assert wbs.get_web_client() is sentinel
        assert list(wbs.WEB_BACKEND_OPTIONS) == ["opencode", "loom"]

    def test_selector_falls_back_to_global_dsh_with_real_client(
        self, monkeypatch, tmp_path
    ):
        monkeypatch.setattr(wbs, "_state_path", lambda: tmp_path / "missing.json")
        old = _set_backend("dsh")
        try:
            assert wbs.get_web_backend() == "dsh"
            assert isinstance(wbs.get_web_client(), DshClient)
            assert asyncio.run(wbs.acquire_web_client()) is wbs.get_web_client()
        finally:
            _set_backend(old)


class _FakeSender:
    backend_name = "dsh"

    def __init__(self, ok=True):
        self.calls = []
        self.ok = ok

    async def send_message(self, session_id, message):
        self.calls.append((session_id, message))
        return {"ok": self.ok, "data": {}}

    async def get_main_session_id(self):
        return "dsh-main"


class TestQQGatewayDispatch:
    def test_uses_factory_client_and_session(self, monkeypatch):
        fake = _FakeSender()
        monkeypatch.setattr("services.ai_client_factory.get_ai_client", lambda: fake)
        service = QQGatewayService(QQGatewayConfig(), session_id="bound-1")

        assert asyncio.run(service._send_to_loom({"text": "qq payload"})) is True
        assert fake.calls == [("bound-1", "qq payload")]

    def test_dsh_resolves_bound_session_when_no_local_binding(self, monkeypatch):
        fake = _FakeSender()
        monkeypatch.setattr("services.ai_client_factory.get_ai_client", lambda: fake)
        service = QQGatewayService(QQGatewayConfig(), session_id="")
        monkeypatch.setattr(service, "_resolve_session_id", lambda: "")

        assert asyncio.run(service._send_to_loom({"text": "fallback"})) is True
        assert fake.calls == [("dsh-main", "fallback")]

    def test_failed_envelope_is_false(self, monkeypatch):
        fake = _FakeSender(ok=False)
        monkeypatch.setattr("services.ai_client_factory.get_ai_client", lambda: fake)
        service = QQGatewayService(QQGatewayConfig(), session_id="bound-1")

        assert asyncio.run(service._send_to_loom({"text": "x"})) is False
