# -*- coding: utf-8 -*-
"""
V6 characterization: /api/screen/session 9 个活端点的对外契约锁（改前录现状，改后逐键对拍）

覆盖端点（ routers/session.py ）:
  1. POST /session/switch
  2. POST /session/update-title
  3. POST /session/create
  4. POST /session/message
  5. GET  /session/list
  6. GET  /session/{id}/messages
  7. GET  /session/{id}/children
  8. POST /session/{id}/summarize
  9. GET  /session/chatlog

锁的对象是**剥壳后的对外 HTTP 形状**（前端 session.ts 消费面）：
  - 响应 JSON 键集合与嵌套键集
  - 错误语义：HTTPException 经 main.py 全局 handler（core/errors.http_exception_handler）
    重塑为统一信封 {"success": false, "data": null, "error": {"code", "message"}}；
    401 由 auth 中间件短路返回裸 {"detail": ...}（不经 handler，形状不同，一并锁死）。
  - children 端点的特殊现状：gateway 失败仍是 200 + {"children": [], "error": detail}
  - _strip_user_wrapper 清洗语义（messages 历史面）与 chatlog 的 turns 数组化/窗口对象

运行姿势：
  - client 信封用桩替换（session_router.acquire_opencode_client seam），绝不触网；
  - mock 开关分支走真实 client 信封（config features.opencode_mock_enabled=True），
    锁 mock 下的响应形状；
  - stt_session_manager 一律替换为 tmp_path 新实例，禁止读写真实 usersessions.json。

V6 重构（gateway 退役、router 直连 client）后本文件断言一字不改，seam
从网关工厂换为 acquire_opencode_client——形状即契约。
"""
import asyncio
import re
from typing import Any, Dict, List, Optional

import pytest

from config.config import get_config


# ============================================================
# 桩网关：返回与真实 OpenCodeGateway 逐键同构的信封
# ============================================================


class _StubClient:
    """client 信封桩（与信封公共层同名同构）。calls 记录调用参数，供透传断言。"""

    def __init__(self, fail: Optional[str] = None) -> None:
        # fail: 指定哪个方法返回错误信封（None=全部成功）
        self._fail = fail
        self.base_url = f"stub://contract/{id(self)}"
        self.calls: List[Dict[str, Any]] = []

    @staticmethod
    def _ok(data: Any) -> Dict[str, Any]:
        return {"ok": True, "data": data, "error": None}

    @staticmethod
    def _fail_env(detail: str) -> Dict[str, Any]:
        return {
            "ok": False,
            "data": None,
            "error": {"source": "opencode", "detail": detail, "code": 500},
        }

    async def create_session(self, title=None, directory=None):
        self.calls.append({"m": "create_session", "title": title, "directory": directory})
        if self._fail == "create_session":
            return self._fail_env("boom-create")
        return self._ok({"session_id": "ses_stub_1", "title": title or "语音交互会话"})

    async def send_message(self, session_id=None, message=None, agent=None, **kwargs):
        self.calls.append({"m": "send_message", "session_id": session_id,
                           "message": message, "agent": agent})
        if self._fail == "send_message":
            return self._fail_env("boom-send")
        return self._ok({"sent": True, "session_id": session_id})

    async def get_main_session(self):
        self.calls.append({"m": "get_main_session"})
        if self._fail == "get_main_session":
            return self._fail_env("HTTP 503: loom down")
        return self._ok({"sessionID": "ses_main_stub", "session_id": "ses_main_stub",
                         "id": "ses_main_stub", "status": "idle"})

    async def list_sessions(self, limit=20, session_id=None):
        entry: Dict[str, Any] = {"m": "list_sessions", "limit": limit}
        if session_id is not None:
            entry["session_id"] = session_id
        self.calls.append(entry)
        if self._fail == "list_sessions":
            return self._fail_env("boom-list")
        if session_id is not None:
            return self._ok({"sessions": [
                {"sessionID": session_id, "session_id": session_id,
                 "id": session_id, "status": "idle"},
            ]})
        # 桩返回"gateway 归一化后"的形状（id→session_id 补齐发生在网关层，
        # router 是原样透传；该归一化语义在 V6 下沉 client 后由 client 层测试锁）
        return self._ok({"sessions": [
            {"id": "oc_a", "session_id": "oc_a", "slug": "会话A", "created_at": 1},
            {"id": "oc_b", "session_id": "oc_b", "slug": "会话B"},
        ]})

    async def get_session_messages(self, session_id, limit=100, before=None):
        self.calls.append({"m": "get_session_messages", "session_id": session_id,
                           "limit": limit, "before": before})
        if self._fail == "get_session_messages":
            return self._fail_env("boom-msg")
        return self._ok({
            "messages": [_wrapped_user_msg(), _assistant_msg()],
            "session_id": session_id,
            "next_cursor": None,
        })

    async def get_session_children(self, session_id):
        self.calls.append({"m": "get_session_children", "session_id": session_id})
        if self._fail == "get_session_children":
            return self._fail_env("boom-children")
        return self._ok({"children": [{"id": "child_1", "title": "子会话1"}]})

    async def get_session_status(self, session_id):
        """W46 switch 收编腿核验原语。缺省=诚实"查无"（真实客户端非 2xx 同款
        "HTTP 404: " 前缀文案），锁 ghost→404 现状；fail 注入非404失败走 503 腿。"""
        self.calls.append({"m": "get_session_status", "session_id": session_id})
        if self._fail == "get_session_status":
            return self._fail_env("boom-status")
        return self._fail_env("HTTP 404: session not found")

    async def summarize_session(self, session_id, model_id=None, provider_id=None):
        self.calls.append({"m": "summarize_session", "session_id": session_id,
                           "model_id": model_id, "provider_id": provider_id})
        if self._fail == "summarize_session":
            return self._fail_env("boom-sum")
        return self._ok({"compacted": True, "session_id": session_id, "data": {}})

    async def get_session_messages_range(self, session_id, start_ms=None, end_ms=None,
                                         max_pages=50, page_size=200):
        self.calls.append({"m": "get_session_messages_range", "session_id": session_id,
                           "start_ms": start_ms, "end_ms": end_ms})
        if self._fail == "get_session_messages_range":
            return self._fail_env("boom-range")
        base = 1_720_000_000_000  # 2024-07-03 前后，仅用于排序/窗口判定
        messages = [
            # 窗口内 user（带系统包装，锁 chatlog 清洗语义）
            _wrapped_user_msg(ts=base + 1000),
            # 窗口内 assistant 带工具
            _assistant_msg(ts=base + 2000, tool="write"),
            # 窗口外（更晚）应被 _collect_session_turns 过滤
            _assistant_msg(ts=base + 9 * 86400 * 1000),
        ]
        return self._ok({"messages": messages, "truncated": False})


def _wrapped_user_msg(ts=None, msg_id="msg_u1"):
    parts_text = (
        "<Axeuh-home-system>\n{\n  \"current_datetime\": \"2026-10-08 10:00:00\"\n"
        "}\n</Axeuh-home-system>\n\n真实用户文本"
    )
    info = {"id": msg_id, "role": "user",
            "sessionID": "ses_stub_1", "time": {"created": ts or 1_720_000_001_000}}
    return {"info": info, "parts": [{"type": "text", "text": parts_text}]}


def _assistant_msg(ts=None, msg_id="msg_a1", tool=None):
    info = {"id": msg_id, "role": "assistant",
            "sessionID": "ses_stub_1", "time": {"created": ts or 1_720_000_002_000}}
    parts: List[Dict[str, Any]] = [{"type": "text", "text": "AI 回复内容"}]
    if tool:
        parts.append({"type": "tool", "tool": tool})
    return {"info": info, "parts": parts}


# ============================================================
# fixtures
# ============================================================

ERROR_ENVELOPE_KEYS = {"success", "data", "error"}
ERROR_DETAIL_KEYS = {"code", "message"}


def _assert_error_envelope(payload: Dict[str, Any], code: str, message: str = None):
    """锁 core/errors.http_exception_handler 的统一错误信封形状。"""
    assert set(payload.keys()) == ERROR_ENVELOPE_KEYS
    assert payload["success"] is False
    assert payload["data"] is None
    assert set(payload["error"].keys()) == ERROR_DETAIL_KEYS
    assert payload["error"]["code"] == code
    if message is not None:
        assert payload["error"]["message"] == message


@pytest.fixture
def tmp_manager(monkeypatch, tmp_path):
    """会话管理器隔离：router 里的 get_session_manager 换成 tmp 存储的新实例。"""
    from services.stt_session_manager import STTSessionManager

    mgr = STTSessionManager(storage_path=str(tmp_path / "usersessions.json"))
    from routers import session as session_router
    monkeypatch.setattr(session_router, "get_session_manager", lambda: mgr)
    return mgr


@pytest.fixture(autouse=True)
def _isolate_web_backend_state(tmp_path, monkeypatch):
    """W30：Web 通道状态文件一律重定向 tmp（缺文件=回落全局 ai_backend），
    绝不读写生产 ai/data/cache/web_backend.json。"""
    import services.web_backend_selector as wbs

    monkeypatch.setattr(wbs, "_state_path",
                        lambda: tmp_path / "web_backend.json")


@pytest.fixture(autouse=True)
def _pin_opencode_leg_active(monkeypatch):
    """生产 opencode.enabled=false 会停用聚合腿；本文件锁的是双腿活跃的契约
    形状，故固定腿开关。停腿语义由 test_session_dual_channel 的专测覆盖。"""
    from routers import session as session_router

    monkeypatch.setattr(
        session_router, "_opencode_leg_active", lambda current_backend: True,
        raising=False,
    )


@pytest.fixture(autouse=True)
def _reset_loom_main_cache():
    """T5 解析缓存跨用例隔离。"""
    import services.loom_main_session as lms

    lms.reset_loom_main_cache()
    yield
    lms.reset_loom_main_cache()


def _patch_client(monkeypatch, stub):
    """把 routers.session 的全部客户端缝（全局 acquire_opencode_client、
    W30-B3 web 缝 acquire_web_client、W44 两通道直调原语）同时指向桩对象：
    web 端点走 web 缝、chatlog 走全局缝、/session/list 双腿与显式 backend 路由
    走直调缝，桩一份即可锁全部现状形状（绝不触网）。"""
    from routers import session as session_router

    async def _fake_acquire():
        return stub

    monkeypatch.setattr(session_router, "acquire_opencode_client", _fake_acquire)
    monkeypatch.setattr(session_router, "acquire_web_client", _fake_acquire)
    monkeypatch.setattr(session_router, "acquire_opencode_client_direct", _fake_acquire)
    monkeypatch.setattr(session_router, "acquire_loom_client_direct", _fake_acquire)


@pytest.fixture
def stub_gw(monkeypatch):
    """默认成功桩客户端。测试可通过 stub_gw._fail 属性改注入失败方法。"""
    gw = _StubClient()
    _patch_client(monkeypatch, gw)
    return gw


@pytest.fixture
def mock_mode(monkeypatch):
    """gateway mock 开关：features.opencode_mock_enabled=True + 单例重置。

    测试结束后恢复原配置并再次重置，防止污染同 session 其他测试。
    """
    from services.opencode_client import _reset_opencode_client

    cfg = get_config()
    features = cfg._data.setdefault("features", {})
    old = features.get("opencode_mock_enabled")
    features["opencode_mock_enabled"] = True
    _reset_opencode_client()
    yield
    if old is None:
        features.pop("opencode_mock_enabled", None)
    else:
        features["opencode_mock_enabled"] = old
    _reset_opencode_client()


# ============================================================
# 1. switch
# ============================================================


class TestSwitchContract:
    def test_switch_success_shape(self, client, auth_headers, tmp_manager):
        tmp_manager.set_current_session("ses_x1", title="标题X")
        resp = client.post("/api/screen/session/switch",
                           json={"session_id": "ses_x1"}, headers=auth_headers)
        assert resp.status_code == 200
        payload = resp.json()
        assert set(payload.keys()) == {"status", "session_id", "title", "agent_sessions"}
        assert payload["status"] == "switched"
        assert payload["session_id"] == "ses_x1"
        assert payload["title"] == "标题X"
        assert payload["agent_sessions"] == {"main-task": "ses_x1"}

    def test_switch_missing_session_404_envelope(self, client, auth_headers, tmp_manager,
                                                 stub_gw):
        # W46：本地查无改为先向 engine 核验（_StubClient.get_session_status 缺省
        # "HTTP 404:"）→ 对外仍逐字节现状 404；挂 stub_gw 缝防核验腿触网。
        resp = client.post("/api/screen/session/switch",
                           json={"session_id": "ghost"}, headers=auth_headers)
        assert resp.status_code == 404
        _assert_error_envelope(resp.json(), "NOT_FOUND", "会话不存在")


# ============================================================
# 2. update-title
# ============================================================


class TestUpdateTitleContract:
    def test_update_success_shape(self, client, auth_headers, tmp_manager):
        tmp_manager.set_current_session("ses_y1", title="旧")
        resp = client.post("/api/screen/session/update-title",
                           json={"session_id": "ses_y1", "title": "新标题"},
                           headers=auth_headers)
        assert resp.status_code == 200
        payload = resp.json()
        assert set(payload.keys()) == {"status", "session_id", "title"}
        assert payload == {"status": "updated", "session_id": "ses_y1", "title": "新标题"}

    def test_update_missing_404_envelope(self, client, auth_headers, tmp_manager):
        resp = client.post("/api/screen/session/update-title",
                           json={"session_id": "ghost", "title": "x"},
                           headers=auth_headers)
        assert resp.status_code == 404
        _assert_error_envelope(resp.json(), "NOT_FOUND", "会话不存在")


# ============================================================
# 3. create
# ============================================================


class TestCreateContract:
    def test_create_success_shape(self, client, auth_headers, tmp_manager, stub_gw):
        _set_web("opencode")
        resp = client.post("/api/screen/session/create",
                           json={"title": "契约会话"}, headers=auth_headers)
        assert resp.status_code == 200
        payload = resp.json()
        assert set(payload.keys()) == {"status", "session_id", "title", "agent_sessions"}
        assert payload["status"] == "created"
        assert payload["session_id"] == "ses_stub_1"
        # 现状：title 来自 manager.set_current_session 后的 Session 对象
        assert payload["title"] == "契约会话"
        assert payload["agent_sessions"] == {"main-task": "ses_stub_1"}
        assert stub_gw.calls[0] == {"m": "create_session",
                                    "title": "契约会话", "directory": None}

    def test_create_gateway_failure_500_envelope(self, client, auth_headers,
                                                 tmp_manager, monkeypatch):
        _set_web("opencode")
        gw = _StubClient(fail="create_session")
        _patch_client(monkeypatch, gw)
        resp = client.post("/api/screen/session/create", json={}, headers=auth_headers)
        assert resp.status_code == 500
        _assert_error_envelope(resp.json(), "INTERNAL_ERROR", "boom-create")

    def test_create_mock_mode(self, client, auth_headers, tmp_manager, mock_mode):
        _set_web("opencode")
        resp = client.post("/api/screen/session/create",
                           json={"title": "mock契约"}, headers=auth_headers)
        assert resp.status_code == 200
        payload = resp.json()
        assert set(payload.keys()) == {"status", "session_id", "title", "agent_sessions"}
        assert payload["status"] == "created"
        assert payload["session_id"].startswith("mock_ses_")
        assert payload["title"] == "mock契约"

    def test_create_on_loom_returns_main_without_creating(
        self, client, auth_headers, tmp_manager, monkeypatch
    ):
        _set_web("loom")
        web_stub = _StubClient()
        _patch_web_only(monkeypatch, web_stub, _StubClient())
        tmp_manager.set_current_session("ses_voice", title="语音当前")

        resp = client.post(
            "/api/screen/session/create",
            json={"title": "loom新会话"},
            headers=auth_headers,
        )
        assert resp.status_code == 200
        assert resp.json() == {
            "status": "created", "session_id": "ses_main_stub",
            "title": "loom新会话", "agent_sessions": {"main-task": "ses_main_stub"},
        }
        assert not [c for c in web_stub.calls if c["m"] == "create_session"]
        assert tmp_manager.get_session_id() == "ses_voice"
        assert tmp_manager.list_agent_sessions() == {
            "loom:main-task": "ses_main_stub"}

    def test_create_on_loom_unavailable_503(
        self, client, auth_headers, tmp_manager, monkeypatch
    ):
        _set_web("loom")
        web_stub = _StubClient(fail="get_main_session")
        _patch_web_only(monkeypatch, web_stub, _StubClient())

        resp = client.post("/api/screen/session/create", json={},
                           headers=auth_headers)

        assert resp.status_code == 503
        _assert_error_envelope(resp.json(), "SERVICE_UNAVAILABLE")


# ============================================================
# 4. message
# ============================================================


class TestMessageContract:
    def test_send_with_explicit_session(self, client, auth_headers, tmp_manager, stub_gw):
        resp = client.post("/api/screen/session/message",
                           json={"message": "你好", "session_id": "ses_m1"},
                           headers=auth_headers)
        assert resp.status_code == 200
        payload = resp.json()
        assert set(payload.keys()) == {"status", "session_id", "to_agent", "source"}
        assert payload == {"status": "sent", "session_id": "ses_m1",
                           "to_agent": None, "source": "main-task"}
        call = stub_gw.calls[-1]
        assert call["m"] == "send_message"
        assert call["agent"] == "main-task"

    def test_send_to_agent_session(self, client, auth_headers, tmp_manager, stub_gw):
        # 现网 web_backend=loom（回落 ai_backend），loom 严格隔离不读裸键——本测试
        # 锁的是 opencode 腿"to_agent 裸键读别名"语义，诚实钉回通道态=opencode
        # 使其按原断言变绿（autouse fixture 已把通道状态文件重定向 tmp，零污染）。
        _set_web("opencode")
        tmp_manager.set_agent_session("reviewer", "ses_r1")
        resp = client.post("/api/screen/session/message",
                           json={"message": "查", "to_agent": "reviewer"},
                           headers=auth_headers)
        assert resp.status_code == 200
        payload = resp.json()
        assert payload["session_id"] == "ses_r1"
        assert payload["to_agent"] == "reviewer"
        assert payload["source"] == "reviewer"

    def test_send_creates_session_when_none(self, client, auth_headers,
                                            tmp_manager, stub_gw):
        # opencode 腿：无当前会话无 agent → create_session(title="手动消息会话")
        _set_web("opencode")
        resp = client.post("/api/screen/session/message",
                           json={"message": "首发"}, headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["session_id"] == "ses_stub_1"
        assert {"m": "create_session", "title": "手动消息会话",
                "directory": None} in stub_gw.calls

    def test_loom_send_without_binding_uses_main_no_duplicate(
        self, client, auth_headers, tmp_manager, stub_gw
    ):
        _set_web("loom")
        resp = client.post("/api/screen/session/message",
                           json={"message": "首发"}, headers=auth_headers)

        assert resp.status_code == 200
        assert resp.json()["session_id"] == "ses_main_stub"
        assert not [c for c in stub_gw.calls if c["m"] == "create_session"]
        assert stub_gw.calls[-1] == {
            "m": "send_message", "session_id": "ses_main_stub",
            "message": "首发", "agent": "main-task",
        }
        assert tmp_manager.list_agent_sessions() == {
            "loom:main-task": "ses_main_stub"}

    def test_send_gateway_failure_500_envelope(self, client, auth_headers,
                                               tmp_manager, monkeypatch):
        gw = _StubClient(fail="send_message")
        _patch_client(monkeypatch, gw)
        resp = client.post("/api/screen/session/message",
                           json={"message": "x", "session_id": "s"}, headers=auth_headers)
        assert resp.status_code == 500
        _assert_error_envelope(resp.json(), "INTERNAL_ERROR", "boom-send")

    def test_send_mock_mode(self, client, auth_headers, tmp_manager, mock_mode):
        resp = client.post("/api/screen/session/message",
                           json={"message": "mock发", "session_id": "s9"},
                           headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json() == {"status": "sent", "session_id": "s9",
                               "to_agent": None, "source": "main-task"}


# ============================================================
# 5. list
# ============================================================


class TestListContract:
    def test_list_shape(self, client, auth_headers, tmp_manager, stub_gw):
        tmp_manager.set_current_session("ses_cur", title="当前")
        resp = client.get("/api/screen/session/list", headers=auth_headers)
        assert resp.status_code == 200
        payload = resp.json()
        # W44 键并集：旧三键名形不动 + 新三键（sessions/loom_sessions/partial）
        assert set(payload.keys()) == {"local_sessions", "opencode_sessions",
                                       "current_session",
                                       "sessions", "loom_sessions", "partial"}
        assert payload["current_session"] == "ses_cur"
        assert isinstance(payload["local_sessions"], list)
        # 本地非空 → 展示本地；opencode_sessions 经网关层归一化后原样透传
        assert [s["session_id"] for s in payload["local_sessions"]] == ["ses_cur"]
        assert payload["opencode_sessions"] == [
            {"id": "oc_a", "session_id": "oc_a", "slug": "会话A", "created_at": 1},
            {"id": "oc_b", "session_id": "oc_b", "slug": "会话B"},
        ]

    def test_list_falls_back_to_opencode_when_local_empty(
        self, client, auth_headers, tmp_manager, stub_gw
    ):
        resp = client.get("/api/screen/session/list", headers=auth_headers)
        assert resp.status_code == 200
        payload = resp.json()
        assert payload["local_sessions"] == [
            {"session_id": "oc_a", "title": "会话A", "created_at": 1},
            {"session_id": "oc_b", "title": "会话B", "created_at": ""},
        ]

    def test_list_gateway_failure_degrades_to_empty(
        self, client, auth_headers, tmp_manager, monkeypatch
    ):
        gw = _StubClient(fail="list_sessions")
        _patch_client(monkeypatch, gw)
        resp = client.get("/api/screen/session/list", headers=auth_headers)
        # 现状：gateway 失败不抛错，opencode_sessions 直接置空
        assert resp.status_code == 200
        assert resp.json()["opencode_sessions"] == []

    def test_list_loom_leg_is_single_main_row(
        self, client, auth_headers, tmp_manager, monkeypatch
    ):
        _set_web("loom")
        stub = _StubClient()
        _patch_client(monkeypatch, stub)

        payload = client.get("/api/screen/session/list",
                             headers=auth_headers).json()

        assert len(payload["loom_sessions"]) == 1
        assert payload["loom_sessions"][0]["session_id"] == "ses_main_stub"
        list_calls = [c for c in stub.calls if c["m"] == "list_sessions"]
        assert sum(1 for c in list_calls
                   if c.get("session_id") == "ses_main_stub") == 1
        assert sum(1 for c in list_calls if "session_id" not in c) == 1

    def test_list_loom_resolver_failure_marks_partial(
        self, client, auth_headers, tmp_manager, monkeypatch
    ):
        _set_web("loom")
        stub = _StubClient(fail="get_main_session")
        _patch_client(monkeypatch, stub)

        resp = client.get("/api/screen/session/list", headers=auth_headers)

        assert resp.status_code == 200
        payload = resp.json()
        assert payload["partial"] == ["loom"]
        assert payload["loom_sessions"] == []
        assert payload["opencode_sessions"]


# ============================================================
# 6. {id}/messages
# ============================================================


class TestMessagesContract:
    def test_messages_shape_and_strip(self, client, auth_headers, stub_gw):
        resp = client.get("/api/screen/session/ses_z9/messages?limit=50",
                          headers=auth_headers)
        assert resp.status_code == 200
        payload = resp.json()
        assert set(payload.keys()) == {"session_id", "messages", "count", "next_cursor"}
        assert payload["session_id"] == "ses_z9"
        assert payload["count"] == 2
        assert payload["next_cursor"] is None
        user_msg, asst_msg = payload["messages"]
        # 现状锁：user 消息的 <Axeuh-home-system> 包装被剥离，只留真实文本
        assert user_msg["parts"][0]["text"] == "真实用户文本"
        assert asst_msg["parts"][0]["text"] == "AI 回复内容"
        call = stub_gw.calls[0]
        assert call == {"m": "get_session_messages", "session_id": "ses_z9",
                        "limit": 50, "before": None}

    def test_messages_before_cursor_forwarded(self, client, auth_headers, stub_gw):
        client.get("/api/screen/session/ses_z9/messages?limit=10&before=cur7",
                   headers=auth_headers)
        assert stub_gw.calls[0]["before"] == "cur7"
        assert stub_gw.calls[0]["limit"] == 10

    def test_messages_failure_500_envelope(self, client, auth_headers, monkeypatch):
        gw = _StubClient(fail="get_session_messages")
        _patch_client(monkeypatch, gw)
        resp = client.get("/api/screen/session/ses_z9/messages", headers=auth_headers)
        assert resp.status_code == 500
        _assert_error_envelope(resp.json(), "INTERNAL_ERROR", "boom-msg")


# ============================================================
# 7. {id}/children
# ============================================================


class TestChildrenContract:
    def test_children_shape(self, client, auth_headers, stub_gw):
        resp = client.get("/api/screen/session/ses_c1/children", headers=auth_headers)
        assert resp.status_code == 200
        payload = resp.json()
        assert payload == {"children": [{"id": "child_1", "title": "子会话1"}]}

    def test_children_failure_200_with_error_key(self, client, auth_headers, monkeypatch):
        """现状锁：children 失败不抛 500，而是 200 + {"children": [], "error": detail}"""
        gw = _StubClient(fail="get_session_children")
        _patch_client(monkeypatch, gw)
        resp = client.get("/api/screen/session/ses_c1/children", headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json() == {"children": [], "error": "boom-children"}


# ============================================================
# 8. {id}/summarize
# ============================================================


class TestSummarizeContract:
    def test_summarize_shape(self, client, auth_headers, stub_gw):
        resp = client.post("/api/screen/session/ses_s1/summarize",
                           json={"model_id": "mX", "provider_id": "pY"},
                           headers=auth_headers)
        assert resp.status_code == 200
        payload = resp.json()
        assert set(payload.keys()) == {"status", "session_id", "message"}
        assert payload == {"status": "compacting", "session_id": "ses_s1",
                           "message": "会话压缩已启动"}
        assert stub_gw.calls[0] == {"m": "summarize_session", "session_id": "ses_s1",
                                    "model_id": "mX", "provider_id": "pY"}

    def test_summarize_defaults_none(self, client, auth_headers, stub_gw):
        resp = client.post("/api/screen/session/ses_s2/summarize", json={},
                           headers=auth_headers)
        assert resp.status_code == 200
        assert stub_gw.calls[0] == {"m": "summarize_session", "session_id": "ses_s2",
                                    "model_id": None, "provider_id": None}

    def test_summarize_failure_500_envelope(self, client, auth_headers, monkeypatch):
        gw = _StubClient(fail="summarize_session")
        _patch_client(monkeypatch, gw)
        resp = client.post("/api/screen/session/ses_s3/summarize", json={},
                           headers=auth_headers)
        assert resp.status_code == 500
        _assert_error_envelope(resp.json(), "INTERNAL_ERROR", "boom-sum")


# ============================================================
# 9. chatlog
# ============================================================


class TestChatlogContract:
    def test_chatlog_json_shape(self, client, auth_headers, tmp_manager, stub_gw):
        base = 1_720_000_000_000
        start = "2024-07-03 00:00:00"
        end = "2024-07-05 00:00:00"
        resp = client.get("/api/screen/session/chatlog",
                          params={"start": start, "end": end,
                                  "session_id": "ses_cl1"},
                          headers=auth_headers)
        assert resp.status_code == 200
        payload = resp.json()
        assert set(payload.keys()) == {"session_id", "window", "include_children",
                                       "message_count", "truncated", "turns"}
        assert set(payload["window"].keys()) == {"start_ms", "end_ms", "start", "end"}
        assert payload["session_id"] == "ses_cl1"
        assert payload["include_children"] is False
        assert payload["truncated"] is False
        # 窗口过滤：3 条样本消息只有窗口内 2 条成 turns
        assert payload["message_count"] == 2
        assert len(payload["turns"]) == 2
        for t in payload["turns"]:
            assert set(t.keys()) == {"id", "role", "time_ms", "time_str",
                                     "content", "tools", "session_id"}
        user_turn, asst_turn = payload["turns"]
        assert user_turn["role"] == "user"
        assert user_turn["content"] == "真实用户文本"
        assert user_turn["tools"] is None
        assert asst_turn["role"] == "assistant"
        assert asst_turn["tools"] == ["write"]
        # 现状锁：turn.session_id 优先取消息 info.sessionID（桩消息携带），
        # fallback_sid（查询参数 session_id）仅在消息缺 sessionID 时生效
        assert asst_turn["session_id"] == "ses_stub_1"
        assert user_turn["session_id"] == "ses_stub_1"
        assert re.match(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$", asst_turn["time_str"])
        # start/end 解析为 UTC+8 毫秒并透传 range
        call = stub_gw.calls[0]
        assert call["m"] == "get_session_messages_range"
        assert call["start_ms"] == payload["window"]["start_ms"]
        assert payload["window"]["start"] == start
        assert payload["window"]["end"] == end

    def test_chatlog_text_format(self, client, auth_headers, tmp_manager, stub_gw):
        resp = client.get("/api/screen/session/chatlog",
                          params={"start": "2024-07-03", "end": "2024-07-05",
                                  "session_id": "ses_cl2", "format": "text"},
                          headers=auth_headers)
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/plain")
        body = resp.text
        assert body.startswith("# 会话对话 (")
        assert "真实用户文本" in body
        assert "[工具] write" in body

    def test_chatlog_children_traversal(self, client, auth_headers, tmp_manager, stub_gw):
        resp = client.get("/api/screen/session/chatlog",
                          params={"start": "2024-07-03", "end": "2024-07-05",
                                  "session_id": "ses_cl3",
                                  "include_children": "true"},
                          headers=auth_headers)
        assert resp.status_code == 200
        payload = resp.json()
        assert payload["include_children"] is True
        children_calls = [c for c in stub_gw.calls if c["m"] == "get_session_children"]
        assert children_calls == [{"m": "get_session_children",
                                   "session_id": "ses_cl3"}]

    def test_chatlog_bad_time_400_envelope(self, client, auth_headers, tmp_manager):
        resp = client.get("/api/screen/session/chatlog",
                          params={"start": "nonsense", "end": "2024-07-05"},
                          headers=auth_headers)
        assert resp.status_code == 400
        _assert_error_envelope(resp.json(), "INTERNAL_ERROR",
                               "时间格式无法解析，请用 YYYY-MM-DD HH:MM[:SS] 或 ISO8601")

    def test_chatlog_start_after_end_400(self, client, auth_headers, tmp_manager):
        resp = client.get("/api/screen/session/chatlog",
                          params={"start": "2024-07-05", "end": "2024-07-03"},
                          headers=auth_headers)
        assert resp.status_code == 400
        _assert_error_envelope(resp.json(), "INTERNAL_ERROR", "start 必须早于 end")

    def test_chatlog_no_session_404(self, client, auth_headers, tmp_manager):
        resp = client.get("/api/screen/session/chatlog",
                          params={"start": "2024-07-03", "end": "2024-07-05"},
                          headers=auth_headers)
        assert resp.status_code == 404
        _assert_error_envelope(resp.json(), "NOT_FOUND",
                               "未找到会话，请传入 session_id 或先绑定 main-task 会话")

    def test_chatlog_range_failure_500(self, client, auth_headers, tmp_manager,
                                       monkeypatch):
        gw = _StubClient(fail="get_session_messages_range")
        _patch_client(monkeypatch, gw)
        resp = client.get("/api/screen/session/chatlog",
                          params={"start": "2024-07-03", "end": "2024-07-05",
                                  "session_id": "s"},
                          headers=auth_headers)
        assert resp.status_code == 500
        _assert_error_envelope(resp.json(), "INTERNAL_ERROR", "boom-range")


# ============================================================
# 认证面（9 端点共用中间件行为，抽两条锁形状）
# ============================================================


class TestAuthContract:
    def test_unauthenticated_401_raw_detail(self, client):
        """401 由中间件短路：裸 {"detail": ...}，非统一信封（形状不同源，锁死）。"""
        resp = client.get("/api/screen/session/list")
        assert resp.status_code == 401
        assert resp.json() == {"detail": "未授权访问，请先登录"}

    def test_post_without_auth_401(self, client):
        resp = client.post("/api/screen/session/create", json={})
        assert resp.status_code == 401
        assert set(resp.json().keys()) == {"detail"}


# ============================================================
# 10. W30-B3：web 端点走 Web 通道择路 + 绑定命名空间 + 裸键迁移
# ============================================================


def _set_web(backend: str):
    """写 Web 通道状态（autouse fixture 已把状态文件重定向 tmp，零污染生产）。"""
    import services.web_backend_selector as wbs

    wbs.set_web_backend(backend)


def _patch_web_only(monkeypatch, web_stub, global_stub):
    """分缝桩：web 缝与全局缝各挂各的 stub，供"谁被调用"判别。
    W44 两通道直调缝各挂一份独立成功桩（绝不并入 global_stub——list 双源聚合
    走直调腿，若记入全局缝会污染"web 端点不碰全局工厂"判别钉；也绝不触网）。"""
    from routers import session as session_router

    async def _web():
        return web_stub

    async def _glob():
        return global_stub

    async def _oc_direct():
        return _StubClient()

    async def _loom_direct():
        return _StubClient()

    monkeypatch.setattr(session_router, "acquire_web_client", _web)
    monkeypatch.setattr(session_router, "acquire_opencode_client", _glob)
    monkeypatch.setattr(session_router, "acquire_opencode_client_direct", _oc_direct)
    monkeypatch.setattr(session_router, "acquire_loom_client_direct", _loom_direct)


class TestWebBackendSwapW30:
    def test_web_endpoints_use_web_client_chatlog_stays_global(
        self, client, auth_headers, tmp_manager, monkeypatch
    ):
        """web=loom：6 个 web 端点不碰全局工厂；chatlog 照旧走全局缝。"""
        _set_web("loom")
        web_stub = _StubClient()
        global_stub = _StubClient()
        _patch_web_only(monkeypatch, web_stub, global_stub)

        assert client.post("/api/screen/session/create", json={},
                           headers=auth_headers).status_code == 200
        assert client.post("/api/screen/session/message",
                           json={"message": "hi", "session_id": "s1"},
                           headers=auth_headers).status_code == 200
        assert client.get("/api/screen/session/list",
                          headers=auth_headers).status_code == 200
        assert client.get("/api/screen/session/s1/messages",
                          headers=auth_headers).status_code == 200
        assert client.get("/api/screen/session/s1/children",
                          headers=auth_headers).status_code == 200
        assert client.post("/api/screen/session/s1/summarize", json={},
                           headers=auth_headers).status_code == 200
        assert web_stub.calls and global_stub.calls == []

        assert client.get("/api/screen/session/chatlog",
                          params={"start": "2024-07-03", "end": "2024-07-05",
                                  "session_id": "s1"},
                          headers=auth_headers).status_code == 200
        assert global_stub.calls  # chatlog 仍经全局工厂缝（W30 红线）

    def test_loom_message_resolves_main_without_creating(
        self, client, auth_headers, tmp_manager, monkeypatch
    ):
        """loom 严格隔离：miss 只解析权威主会话，不另造会话、不碰裸键与 current。"""
        _set_web("loom")
        web_stub = _StubClient()
        global_stub = _StubClient()
        _patch_web_only(monkeypatch, web_stub, global_stub)
        tmp_manager.set_current_session("ses_voice", title="语音当前会话")

        resp = client.post("/api/screen/session/message",
                           json={"message": "首发"}, headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["session_id"] == "ses_main_stub"
        assert not [c for c in web_stub.calls if c["m"] == "create_session"]
        assert tmp_manager.list_agent_sessions() == {
            "loom:main-task": "ses_main_stub"}
        assert tmp_manager.get_session_id() == "ses_voice"
        assert web_stub.calls[-1] == {"m": "send_message",
                                      "session_id": "ses_main_stub",
                                      "message": "首发", "agent": "main-task"}

    def test_to_agent_on_loom_ignores_bare_and_cross_channel_keys(
        self, client, auth_headers, tmp_manager, monkeypatch
    ):
        """loom 读 to_agent 绑定：只认 "loom:<agent>"，裸键/opencode 命名键均不误读。"""
        _set_web("loom")
        web_stub = _StubClient()
        _patch_web_only(monkeypatch, web_stub, _StubClient())
        tmp_manager.set_agent_session("main-task", "ses_bare_main")
        tmp_manager.set_agent_session("opencode:helper", "ses_oc_helper")

        resp = client.post("/api/screen/session/message",
                           json={"message": "查", "to_agent": "helper"},
                           headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["session_id"] == "ses_main_stub"
        bindings = tmp_manager.list_agent_sessions()
        assert bindings["loom:main-task"] == "ses_main_stub"
        assert "loom:helper" not in bindings
        assert bindings["main-task"] == "ses_bare_main"  # 裸键零污染
        assert bindings["opencode:helper"] == "ses_oc_helper"  # 跨通道键零触碰

    def test_opencode_read_alias_reuses_bare_binding(
        self, client, auth_headers, tmp_manager, monkeypatch
    ):
        """opencode 读别名：命名键缺失时回落裸键（语音<->web 单会话连续），纯读零写。"""
        _set_web("opencode")
        web_stub = _StubClient()
        _patch_web_only(monkeypatch, web_stub, _StubClient())
        tmp_manager.set_agent_session("main-task", "ses_bare1")

        resp = client.post("/api/screen/session/message",
                           json={"message": "hi", "to_agent": "main-task"},
                           headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["session_id"] == "ses_bare1"
        assert web_stub.calls[-1]["m"] == "send_message"
        assert web_stub.calls[-1]["session_id"] == "ses_bare1"
        assert tmp_manager.get_agent_session("opencode:main-task") is None  # 读不改写

    def test_opencode_create_switch_write_namespaced(
        self, client, auth_headers, tmp_manager, monkeypatch
    ):
        """opencode 站点写一律命名键；裸键保持语音值不动；响应形状零漂移。"""
        _set_web("opencode")
        web_stub = _StubClient()
        _patch_web_only(monkeypatch, web_stub, _StubClient())
        tmp_manager.set_agent_session("main-task", "ses_voice_old")

        resp = client.post("/api/screen/session/create", json={"title": "新"},
                           headers=auth_headers)
        assert resp.status_code == 200
        # 前端契约形状不变（裸标签展示键）
        assert resp.json()["agent_sessions"] == {"main-task": "ses_stub_1"}
        assert tmp_manager.get_agent_session("opencode:main-task") == "ses_stub_1"
        assert tmp_manager.get_agent_session("main-task") == "ses_voice_old"
        assert tmp_manager.get_session_id() == "ses_stub_1"  # set_current_session 现状保留

        tmp_manager.set_current_session("ses_x1", title="标题X")
        resp2 = client.post("/api/screen/session/switch",
                            json={"session_id": "ses_x1"}, headers=auth_headers)
        assert resp2.status_code == 200
        assert tmp_manager.get_agent_session("opencode:main-task") == "ses_x1"
        assert tmp_manager.get_agent_session("main-task") == "ses_voice_old"

    def test_chatlog_default_target_stays_bare_when_web_loom(
        self, client, auth_headers, tmp_manager, monkeypatch
    ):
        """chatlog 缺省目标恒取裸 main-task 绑定（全局通道语义），无视 loom 命名键。"""
        _set_web("loom")
        web_stub = _StubClient()
        global_stub = _StubClient()
        _patch_web_only(monkeypatch, web_stub, global_stub)
        tmp_manager.set_agent_session("main-task", "ses_bare1")
        tmp_manager.set_agent_session("loom:main-task", "ses_loom1")

        resp = client.get("/api/screen/session/chatlog",
                          params={"start": "2024-07-03", "end": "2024-07-05"},
                          headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["session_id"] == "ses_bare1"
        assert global_stub.calls[0]["session_id"] == "ses_bare1"
        assert web_stub.calls == []


class TestBindingMigration:
    """stt_session_manager._load_data 一次性幂等迁移（裸 main-task -> opencode 命名键）。"""

    @staticmethod
    def _write(path, agent_sessions):
        import json

        path.write_text(json.dumps({
            "current_session": None, "history": [],
            "agent_sessions": agent_sessions,
        }), encoding="utf-8")
        return path

    def test_bare_copied_namespaced_coexist_after_load(self, tmp_path):
        from services.stt_session_manager import STTSessionManager

        f = self._write(tmp_path / "usersessions.json", {"main-task": "ses_A"})
        mgr = STTSessionManager(storage_path=str(f))
        assert mgr.list_agent_sessions() == {
            "main-task": "ses_A", "opencode:main-task": "ses_A",
        }

    def test_idempotent_second_load_never_overwrites(self, tmp_path):
        from services.stt_session_manager import STTSessionManager

        f = self._write(tmp_path / "usersessions.json",
                        {"main-task": "ses_A", "opencode:main-task": "ses_B"})
        mgr = STTSessionManager(storage_path=str(f))
        # 命名键在场：裸值绝不回填覆盖（web/语音合法分叉）
        assert mgr.list_agent_sessions() == {
            "main-task": "ses_A", "opencode:main-task": "ses_B",
        }
        # 再加载一次（模拟重启）：两条键原样共存
        mgr2 = STTSessionManager(storage_path=str(f))
        assert mgr2.list_agent_sessions() == {
            "main-task": "ses_A", "opencode:main-task": "ses_B",
        }

    def test_load_writes_nothing_to_disk(self, tmp_path):
        from services.stt_session_manager import STTSessionManager

        f = self._write(tmp_path / "usersessions.json", {"main-task": "ses_A"})
        before = f.read_bytes()
        STTSessionManager(storage_path=str(f))
        assert f.read_bytes() == before  # 内存复制，加载零落盘

    def test_no_bare_no_namespaced_invented(self, tmp_path):
        from services.stt_session_manager import STTSessionManager

        f = self._write(tmp_path / "usersessions.json", {"reviewer": "ses_R"})
        mgr = STTSessionManager(storage_path=str(f))
        # 只迁移 main-task 一条（其余 agent 由 opencode 读别名兜底，不预造键）
        assert mgr.list_agent_sessions() == {"reviewer": "ses_R"}
