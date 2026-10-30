# -*- coding: utf-8 -*-
"""
W44 双通道会话聚合契约锁（本波新语义，TDD 先红后绿）

协议冻结名（前端并行开发按同名消费）:
  - GET /session/list 键并集 = 旧三键（local_sessions/opencode_sessions/current_session
    名形不动）+ 新三键（sessions/loom_sessions/partial）
  - sessions 归一项 = {session_id, title, date, updated, backend}，backend ∈ {"opencode","loom"}
  - POST /session/message body.backend；GET messages/children query backend——
    可选显式路由，省略时逐字节现语义；非法值 400；None/"" 透传

钉死的语义:
  1. 双源聚合：sessions = 远端 opencode ∪ 远端 loom ∪ 仅本地 session_history；
     sid 去重远端元数据优先；updated 降序；opencode_sessions 恒 opencode 原始腿。
  2. 死键修复：opencode 真时间字段是 time.created/time.updated（ms epoch），顶层
     created_at 从不存在（archive/behavior/snapshots/session_list.get.json 为证）——
     聚合 date 与 local_sessions 空回退均优先读真字段，无顶层 created_at 的桩项也得非空 date。
  3. loom 腿仅 {sessionID,status}：title/时间 join 本地 session_history，缺回退"会话"。
  4. 单腿异常/信封失败 → 另一腿照列 + partial 记失败腿名，恒 200 绝不 500；
     双腿皆挂 → sessions 退纯本地 history + partial 双名。
  5. 显式 backend 直调通道原语（acquire_opencode_client_direct / acquire_loom_client_direct），
     绝不经 acquire_web_client 通道缝，也绝不经 ai_client_factory 全局缝（acquire_opencode_client 别名）。

W46 (h) 组追加锁（POST /session/switch 通道化 + engine 收编）:
  6. 有效通道 = request.backend（校验后）or get_web_backend()；本地 session_history 命中
     → 现路径逐字节不变；查无 → 有效通道 engine get_session_status 核验：存在 → 收编登记
     并 switch，"HTTP 404" → 照旧诚实 404，其余失败（连接炸/非404）→ 503。
  7. switch 成功命名键写 web_agent_key("main-task", 有效通道)——修"写错命名键"。
  8. 错误码裁定（仓内惯例 core/errors.py code_map 503→SERVICE_UNAVAILABLE，同 kernel
     不可达/声纹降级口径）：engine 不可达 503，非 502（502 无封闭码映射会塌成 INTERNAL_ERROR）。
"""
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import pytest


# ============================================================
# 通道桩（test_session_api_contract._StubClient 同款信封技术）
# ============================================================


class _ChanStub:
    """单通道客户端桩：calls 记录调用，list/children/status 可注入异常或错误信封。"""

    def __init__(self, name: str, sessions_items: Optional[List[Dict[str, Any]]] = None,
                 list_raises: bool = False, list_fail_env: bool = False,
                 children_fail: bool = False, status_found: bool = False,
                 status_title: Optional[str] = None,
                 status_detail: Optional[str] = None,
                 main_id: Optional[str] = None,
                 main_error: Optional[str] = None) -> None:
        self.name = name
        self.base_url = f"stub://{name}/{id(self)}"
        self._sessions_items = sessions_items if sessions_items is not None else []
        self._list_raises = list_raises
        self._list_fail_env = list_fail_env
        self._children_fail = children_fail
        # W46 switch 收编核验腿：status_found=True → 会话存在（信封 ok）；
        # 否则失败信封，detail=status_detail（缺省=真实客户端同款 "HTTP 404: " 前缀，
        # 语义=engine 自报不存在；注入连接炸文案如 "Cannot connect to host..." 走 503 腿）
        self._status_found = status_found
        self._status_title = status_title
        self._status_detail = status_detail
        # T5 主会话解析腿：main_id 非空 = GET /sessions/main 200；否则错误信封
        self._main_id = main_id
        self._main_error = main_error or "HTTP 404: main session not found"
        self.calls: List[Dict[str, Any]] = []

    @staticmethod
    def _ok(data: Any) -> Dict[str, Any]:
        return {"ok": True, "data": data, "error": None}

    @staticmethod
    def _fail_env(detail: str) -> Dict[str, Any]:
        return {"ok": False, "data": None,
                "error": {"source": "chan", "detail": detail, "code": 500}}

    async def get_main_session(self):
        self.calls.append({"m": "get_main_session"})
        if not self._main_id:
            return self._fail_env(self._main_error)
        return self._ok({"sessionID": self._main_id, "session_id": self._main_id,
                         "id": self._main_id, "status": "idle"})

    async def list_sessions(self, limit: int = 20, session_id: Optional[str] = None):
        entry: Dict[str, Any] = {"m": "list_sessions", "limit": limit}
        if session_id is not None:
            entry["session_id"] = session_id
        self.calls.append(entry)
        if self._list_raises:
            raise RuntimeError(f"{self.name}-boom")
        if self._list_fail_env:
            return self._fail_env(f"boom-list-{self.name}")
        if session_id is None:
            return self._ok({"sessions": self._sessions_items})
        hits = [s for s in self._sessions_items
                if (s.get("sessionID") or s.get("session_id") or s.get("id")) == session_id]
        if not hits:
            hits = [{"sessionID": session_id, "session_id": session_id,
                     "id": session_id, "status": "idle"}]
        return self._ok({"sessions": hits[:1]})

    async def create_session(self, title=None, directory=None):
        self.calls.append({"m": "create_session", "title": title, "directory": directory})
        return self._ok({"session_id": f"ses_new_{self.name}", "title": title or "语音交互会话"})

    async def send_message(self, session_id=None, message=None, agent=None, **kwargs):
        self.calls.append({"m": "send_message", "session_id": session_id,
                           "message": message, "agent": agent})
        return self._ok({"sent": True, "session_id": session_id})

    async def get_session_messages(self, session_id, limit=100, before=None):
        self.calls.append({"m": "get_session_messages", "session_id": session_id,
                           "limit": limit, "before": before})
        return self._ok({"messages": [], "session_id": session_id, "next_cursor": None})

    async def get_session_children(self, session_id):
        self.calls.append({"m": "get_session_children", "session_id": session_id})
        if self._children_fail:
            return self._fail_env(f"boom-children-{self.name}")
        return self._ok({"children": [{"id": "c1", "title": "子会话"}]})

    async def get_session_status(self, session_id):
        self.calls.append({"m": "get_session_status", "session_id": session_id})
        if self._status_found:
            data: Dict[str, Any] = {"session_id": session_id, "status": "idle"}
            if self._status_title is not None:
                data["title"] = self._status_title
            return self._ok(data)
        return self._fail_env(self._status_detail or "HTTP 404: session not found")


def _patch_channels(monkeypatch, *, oc=None, loom=None, web=None, glob=None):
    """四条缝分桩：两通道直调原语 + web 通道缝 + ai_client_factory 全局缝，
    供"谁被调用"判别（显式腿必须只碰对应直调桩）。"""
    from routers import session as session_router

    def _factory(target):
        async def _get():
            return target
        return _get

    if oc is not None:
        monkeypatch.setattr(session_router, "acquire_opencode_client_direct", _factory(oc))
    if loom is not None:
        monkeypatch.setattr(session_router, "acquire_loom_client_direct", _factory(loom))
    if web is not None:
        monkeypatch.setattr(session_router, "acquire_web_client", _factory(web))
    if glob is not None:
        monkeypatch.setattr(session_router, "acquire_opencode_client", _factory(glob))


def _set_web(backend: str):
    """写 Web 通道状态（autouse fixture 已把状态文件重定向 tmp，零污染生产）。"""
    import services.web_backend_selector as wbs

    wbs.set_web_backend(backend)


def _patch_opencode_enabled(monkeypatch, enabled: bool) -> None:
    """钉 OPENCODE_ENABLED：腿开关是 router 对 get_config() 的唯一读点。
    raising=False 让本文件在实现落地前的红阶段也能整体收集（不连坐既有用例）。"""
    from routers import session as session_router

    class _Cfg:
        OPENCODE_ENABLED = enabled

    monkeypatch.setattr(session_router, "get_config", lambda: _Cfg(), raising=False)


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
    """Web 通道状态文件一律重定向 tmp，绝不读写生产 ai/data/cache/web_backend.json。"""
    import services.web_backend_selector as wbs

    monkeypatch.setattr(wbs, "_state_path", lambda: tmp_path / "web_backend.json")


@pytest.fixture(autouse=True)
def _pin_opencode_leg_enabled(monkeypatch):
    """本文件的既有 W44 契约锁的是双腿活跃语义；生产 opencode.enabled=false，
    不能让断言随部署配置翻转。停腿语义由 TestOpencodeLegEnabledGate 显式覆盖。"""
    _patch_opencode_enabled(monkeypatch, True)


@pytest.fixture(autouse=True)
def _reset_loom_main_cache():
    """T5 解析缓存跨用例隔离（桩 base_url 已独立，仍显式清零防串味）。"""
    import services.loom_main_session as lms

    lms.reset_loom_main_cache()
    yield
    lms.reset_loom_main_cache()


# ============================================================
# 真形状样本（ground truth: archive/behavior/snapshots/session_list.get.json）
# ============================================================

OC_CREATED_MS = 1_781_423_021_724
OC_UPDATED_MS = 1_781_978_543_516

OC_ITEM = {  # 真实 opencode 归一项：无顶层 created_at，时间只存在于 time{}（ms）
    "id": "ses_oc_1",
    "session_id": "ses_oc_1",
    "slug": "swift-otter",
    "title": "OpenCode 主会话",
    "time": {"created": OC_CREATED_MS, "updated": OC_UPDATED_MS},
}

LOOM_ALPHA = {"sessionID": "loom_alpha", "session_id": "loom_alpha",
              "id": "loom_alpha", "status": "idle"}
LOOM_BETA = {"sessionID": "loom_beta", "session_id": "loom_beta",
             "id": "loom_beta", "status": "busy"}

# 期望 date 串独立算（不复用被测 _format_ts，避免自证）
EXPECTED_OC_DATE = datetime.fromtimestamp(
    OC_CREATED_MS / 1000, tz=timezone(timedelta(hours=8))
).strftime("%Y-%m-%d %H:%M:%S")

SESSION_ITEM_KEYS = {"session_id", "title", "date", "updated", "backend"}
LIST_KEYS = {"local_sessions", "opencode_sessions", "current_session",
             "sessions", "loom_sessions", "partial"}


def _entry(payload: Dict[str, Any], sid: str) -> Dict[str, Any]:
    hits = [s for s in payload["sessions"] if s["session_id"] == sid]
    assert len(hits) == 1, f"sessions 中 {sid} 应恰一条: {payload['sessions']}"
    return hits[0]


# ============================================================
# 1. 双源聚合 + backend 标记 + 死键修复 + 排序去重
# ============================================================


class TestListAggregation:
    def test_aggregates_both_channels_with_backend_marks(
        self, client, auth_headers, tmp_manager, monkeypatch
    ):
        # Given：远端两腿各给条目；本地 history 三条（含与远端 opencode 同 sid 的旧元数据、
        # loom_alpha 的本地标题、一条仅本地且有 loom: 命名键绑定）
        _set_web("opencode")
        tmp_manager.set_current_session("loom_alpha", title="Loom 本地标题")
        tmp_manager.set_current_session("ses_oc_1", title="本地旧标题")  # 去重时被远端覆盖
        tmp_manager.set_current_session("ses_local_only", title="仅本地")
        tmp_manager.set_agent_session("loom:agentA", "ses_local_only")
        # 钉死同 tick 并列 flake：time.time() 连续调用可落在同一时钟 tick（低分辨率
        # 环境实测复现），排序断言会随机翻转。把本地时间戳钉成与期望序一致的确定值，
        # 排序逻辑与断言本身零改动。
        _hist = {h["session_id"]: h for h in tmp_manager.session_history}
        _hist["ses_local_only"]["last_accessed"] = 1_782_000_000.0
        _hist["loom_alpha"]["last_accessed"] = 1_781_990_000.0
        oc = _ChanStub("oc", sessions_items=[OC_ITEM])
        loom = _ChanStub("loom", sessions_items=[LOOM_ALPHA, LOOM_BETA],
                         main_id="loom_alpha")
        _patch_channels(monkeypatch, oc=oc, loom=loom, web=_ChanStub("web"))

        # When
        resp = client.get("/api/screen/session/list", headers=auth_headers)

        # Then
        assert resp.status_code == 200
        payload = resp.json()
        assert set(payload.keys()) == LIST_KEYS
        assert payload["partial"] == []
        # 原始腿键：opencode_sessions 恒 opencode 腿原样；loom 腿只认权威主会话单行
        assert payload["opencode_sessions"] == [OC_ITEM]
        assert payload["loom_sessions"] == [LOOM_ALPHA]
        # 绝不拉远端全量列表：loom 腿的 list_sessions 必带解析出的主会话 id
        assert {"m": "list_sessions", "limit": 20, "session_id": "loom_alpha"} in loom.calls
        assert {"m": "list_sessions", "limit": 20} not in loom.calls

        assert {s["session_id"] for s in payload["sessions"]} == {
            "ses_oc_1", "loom_alpha", "ses_local_only"}
        for s in payload["sessions"]:
            assert set(s.keys()) == SESSION_ITEM_KEYS

        oc_entry = _entry(payload, "ses_oc_1")
        assert oc_entry["backend"] == "opencode"
        # 钉死键修复：桩项无顶层 created_at，date 仍来自 time.created 且非空
        assert oc_entry["date"] == EXPECTED_OC_DATE
        assert oc_entry["updated"] == OC_UPDATED_MS
        # 去重：远端元数据优先（本地"本地旧标题"不得覆盖远端 title）
        assert oc_entry["title"] == "OpenCode 主会话"

        alpha = _entry(payload, "loom_alpha")
        assert alpha["backend"] == "loom"
        # loom 条目 title join 本地 session_history
        assert alpha["title"] == "Loom 本地标题"
        assert "loom_beta" not in {s["session_id"] for s in payload["sessions"]}

        only = _entry(payload, "ses_local_only")
        assert only["backend"] == "loom"  # 仅本地条目经 loom: 命名键前缀归属

        # updated 降序（本地最新, loom 主会话, opencode）
        assert [s["session_id"] for s in payload["sessions"]] == [
            "ses_local_only", "loom_alpha", "ses_oc_1"]

        # 旧三键语义不动：本地非空 → local_sessions 展示 history；current_session 现值
        assert [s["session_id"] for s in payload["local_sessions"]] == [
            "loom_alpha", "ses_oc_1", "ses_local_only"]
        assert payload["current_session"] == "ses_local_only"

    def test_local_only_backend_attribution_rules(
        self, client, auth_headers, tmp_manager, monkeypatch
    ):
        # Given：仅本地四条——loom: 前缀→loom；opencode: 前缀→opencode；裸键→opencode；
        # 无绑定→当前 get_web_backend()
        _set_web("opencode")
        tmp_manager.set_current_session("h_loom", title="A")
        tmp_manager.set_current_session("h_ocns", title="B")
        tmp_manager.set_current_session("h_bare", title="C")
        tmp_manager.set_current_session("h_none", title="D")
        tmp_manager.set_agent_session("loom:agent", "h_loom")
        tmp_manager.set_agent_session("opencode:agent", "h_ocns")
        tmp_manager.set_agent_session("reviewer", "h_bare")
        oc = _ChanStub("oc", sessions_items=[])
        loom = _ChanStub("loom", sessions_items=[])
        _patch_channels(monkeypatch, oc=oc, loom=loom, web=_ChanStub("web"))

        payload = client.get("/api/screen/session/list", headers=auth_headers).json()

        assert {e["session_id"]: e["backend"] for e in payload["sessions"]} == {
            "h_loom": "loom", "h_ocns": "opencode", "h_bare": "opencode",
            "h_none": "opencode"}

    def test_local_empty_fallback_reads_real_time_created(
        self, client, auth_headers, tmp_manager, monkeypatch
    ):
        # Given：本地 history 空 + opencode 腿给真形状项（无顶层 created_at）
        oc = _ChanStub("oc", sessions_items=[OC_ITEM])
        loom = _ChanStub("loom", sessions_items=[])
        _patch_channels(monkeypatch, oc=oc, loom=loom, web=_ChanStub("web"))

        payload = client.get("/api/screen/session/list", headers=auth_headers).json()

        # Then：local_sessions 空回退死键修复——created_at 读 time.created（ms）非空
        assert payload["local_sessions"] == [
            {"session_id": "ses_oc_1", "title": "swift-otter", "created_at": OC_CREATED_MS}
        ]


# ============================================================
# 2. partial 降级，永不 500
# ============================================================


class TestListPartialDegradation:
    def test_opencode_leg_raises_loom_still_listed(
        self, client, auth_headers, tmp_manager, monkeypatch
    ):
        _set_web("opencode")
        oc = _ChanStub("oc", list_raises=True)
        loom = _ChanStub("loom", sessions_items=[LOOM_ALPHA], main_id="loom_alpha")
        _patch_channels(monkeypatch, oc=oc, loom=loom, web=_ChanStub("web"))

        resp = client.get("/api/screen/session/list", headers=auth_headers)

        assert resp.status_code == 200
        payload = resp.json()
        assert payload["partial"] == ["opencode"]
        assert payload["opencode_sessions"] == []
        assert payload["loom_sessions"] == [LOOM_ALPHA]
        assert {s["session_id"] for s in payload["sessions"]} == {"loom_alpha"}

    def test_loom_leg_raises_opencode_still_listed(
        self, client, auth_headers, tmp_manager, monkeypatch
    ):
        _set_web("opencode")
        oc = _ChanStub("oc", sessions_items=[OC_ITEM])
        loom = _ChanStub("loom", list_raises=True, main_id="loom_alpha")
        _patch_channels(monkeypatch, oc=oc, loom=loom, web=_ChanStub("web"))

        resp = client.get("/api/screen/session/list", headers=auth_headers)

        assert resp.status_code == 200
        payload = resp.json()
        assert payload["partial"] == ["loom"]
        assert payload["loom_sessions"] == []
        assert payload["opencode_sessions"] == [OC_ITEM]
        assert {s["session_id"] for s in payload["sessions"]} == {"ses_oc_1"}

    def test_leg_envelope_failure_also_marks_partial(
        self, client, auth_headers, tmp_manager, monkeypatch
    ):
        # 信封失败（ok=False，非异常）与异常同语义：该腿记入 partial，恒 200
        _set_web("opencode")
        oc = _ChanStub("oc", list_fail_env=True)
        loom = _ChanStub("loom", sessions_items=[LOOM_ALPHA], main_id="loom_alpha")
        _patch_channels(monkeypatch, oc=oc, loom=loom, web=_ChanStub("web"))

        resp = client.get("/api/screen/session/list", headers=auth_headers)

        assert resp.status_code == 200
        assert resp.json()["partial"] == ["opencode"]

    def test_resolver_failure_marks_partial_and_skips_remote_list(
        self, client, auth_headers, tmp_manager, monkeypatch
    ):
        _set_web("loom")
        oc = _ChanStub("oc", sessions_items=[])
        loom = _ChanStub("loom", sessions_items=[LOOM_ALPHA],
                         main_error="HTTP 503: loom down")
        _patch_channels(monkeypatch, oc=oc, loom=loom, web=_ChanStub("web"))

        resp = client.get("/api/screen/session/list", headers=auth_headers)

        assert resp.status_code == 200
        payload = resp.json()
        assert payload["partial"] == ["loom"]
        assert payload["loom_sessions"] == []
        assert not [c for c in loom.calls if c["m"] == "list_sessions"]

    def test_both_legs_down_degrades_to_pure_local(
        self, client, auth_headers, tmp_manager, monkeypatch
    ):
        _set_web("loom")
        tmp_manager.set_current_session("h_loom", title="甲")
        tmp_manager.set_current_session("h_bare", title="乙")
        tmp_manager.set_agent_session("opencode:agent", "h_bare")
        oc = _ChanStub("oc", list_raises=True)
        loom = _ChanStub("loom", list_raises=True, main_id="loom_alpha")
        _patch_channels(monkeypatch, oc=oc, loom=loom, web=_ChanStub("web"))

        resp = client.get("/api/screen/session/list", headers=auth_headers)

        assert resp.status_code == 200
        payload = resp.json()
        assert payload["partial"] == ["opencode", "loom"]
        assert payload["opencode_sessions"] == []
        assert payload["loom_sessions"] == []
        # sessions 退纯本地 history（含 backend 归属；无绑定 → 当前通道 loom）
        assert {e["session_id"]: e["backend"] for e in payload["sessions"]} == {
            "h_loom": "loom", "h_bare": "opencode"}


# ============================================================
# 2b. opencode.enabled 停腿门（未启用 ≠ 故障；当前通道例外）
# ============================================================


class TestOpencodeLegEnabledGate:
    """opencode.enabled=false 且当前 Web 通道不是 opencode → 该腿停用：
    恒空列表、绝不获取客户端、**不计入 partial**（部署本来没启用，不是数据不全）。
    当前 Web 通道=opencode 时腿必须保持活跃，否则当前通道会话凭空消失。"""

    @pytest.mark.parametrize("enabled,current,expected", [
        (False, "loom", False),
        (True, "loom", True),
        (False, "opencode", True),
        (True, "opencode", True),
    ])
    def test_leg_active_truth_table(self, monkeypatch, enabled, current, expected):
        from routers import session as session_router

        _patch_opencode_enabled(monkeypatch, enabled)

        assert session_router._opencode_leg_active(current) is expected

    def test_disabled_leg_skips_client_and_partial(
        self, client, auth_headers, tmp_manager, monkeypatch
    ):
        # Given：生产态 enabled=false + web=loom；opencode 桩一被调用即抛
        _set_web("loom")
        _patch_opencode_enabled(monkeypatch, False)
        oc = _ChanStub("oc", list_raises=True)
        loom = _ChanStub("loom", sessions_items=[LOOM_ALPHA], main_id="loom_alpha")
        _patch_channels(monkeypatch, oc=oc, loom=loom, web=_ChanStub("web"))

        # When
        resp = client.get("/api/screen/session/list", headers=auth_headers)

        # Then：停腿空列表、不算部分失败、客户端零获取；loom 腿照常
        assert resp.status_code == 200
        payload = resp.json()
        assert oc.calls == []
        assert payload["opencode_sessions"] == []
        assert payload["partial"] == []
        assert payload["loom_sessions"] == [LOOM_ALPHA]
        assert {s["session_id"] for s in payload["sessions"]} == {"loom_alpha"}

    def test_disabled_flag_keeps_active_channel_leg(
        self, client, auth_headers, tmp_manager, monkeypatch
    ):
        # enabled=false 但当前 Web 通道=opencode：停腿会让当前通道会话消失，必须活
        _set_web("opencode")
        _patch_opencode_enabled(monkeypatch, False)
        oc = _ChanStub("oc", sessions_items=[OC_ITEM])
        loom = _ChanStub("loom", sessions_items=[], main_id="ses_loom_aux")
        _patch_channels(monkeypatch, oc=oc, loom=loom, web=_ChanStub("web"))

        resp = client.get("/api/screen/session/list", headers=auth_headers)

        assert resp.status_code == 200
        payload = resp.json()
        assert oc.calls == [{"m": "list_sessions", "limit": 20}]
        assert payload["opencode_sessions"] == [OC_ITEM]
        assert payload["partial"] == []
        assert {s["session_id"] for s in payload["sessions"]} == {
            "ses_oc_1", "ses_loom_aux"}


# ============================================================
# 3. message 显式 backend 路由（跨通道投递）
# ============================================================


class TestMessageBackendRouting:
    def test_explicit_loom_routes_to_loom_client_even_for_opencode_sid(
        self, client, auth_headers, tmp_manager, monkeypatch
    ):
        # Given：web=opencode，请求显式 backend=loom + opencode 属主 sid
        _set_web("opencode")
        tmp_manager.set_agent_session("loom:main-task", "ses_known_main")
        oc, loom = _ChanStub("oc"), _ChanStub("loom")
        web, glob = _ChanStub("web"), _ChanStub("glob")
        _patch_channels(monkeypatch, oc=oc, loom=loom, web=web, glob=glob)

        resp = client.post("/api/screen/session/message",
                           json={"message": "查", "session_id": "ses_oc_1",
                                 "backend": "loom"}, headers=auth_headers)

        # Then：只有 loom 直调桩被投递；其余三缝零调用
        assert resp.status_code == 200
        assert resp.json() == {"status": "sent", "session_id": "ses_oc_1",
                               "to_agent": None, "source": "main-task"}
        assert loom.calls == [{"m": "send_message", "session_id": "ses_oc_1",
                               "message": "查", "agent": "main-task"}]
        assert oc.calls == [] and web.calls == [] and glob.calls == []

    def test_explicit_opencode_routes_to_opencode_client(
        self, client, auth_headers, tmp_manager, monkeypatch
    ):
        # 现网环境 web=loom；显式 backend=opencode 必须投 opencode 直调桩，
        # 绝不碰 web 缝（selector 会给出 loom）与全局工厂缝（ai_backend=loom 同样给 loom）
        _set_web("loom")
        oc, loom = _ChanStub("oc"), _ChanStub("loom")
        web, glob = _ChanStub("web"), _ChanStub("glob")
        _patch_channels(monkeypatch, oc=oc, loom=loom, web=web, glob=glob)

        resp = client.post("/api/screen/session/message",
                           json={"message": "发", "session_id": "loom_9",
                                 "backend": "opencode"}, headers=auth_headers)

        assert resp.status_code == 200
        assert resp.json()["session_id"] == "loom_9"
        assert oc.calls == [{"m": "send_message", "session_id": "loom_9",
                             "message": "发", "agent": "main-task"}]
        assert loom.calls == [] and web.calls == [] and glob.calls == []

    def test_explicit_opencode_keeps_current_session_fallback(
        self, client, auth_headers, tmp_manager, monkeypatch
    ):
        # opencode 腿照旧：无显式 sid / 无 agent 绑定时兜底全局 current_session
        _set_web("loom")
        tmp_manager.set_current_session("ses_voice", title="语音当前")
        oc = _ChanStub("oc")
        loom, web = _ChanStub("loom"), _ChanStub("web")
        _patch_channels(monkeypatch, oc=oc, loom=loom, web=web)

        resp = client.post("/api/screen/session/message",
                           json={"message": "回", "backend": "opencode"},
                           headers=auth_headers)

        assert resp.status_code == 200
        assert resp.json()["session_id"] == "ses_voice"
        assert oc.calls[-1]["m"] == "send_message" and loom.calls == [] and web.calls == []

    def test_loom_missing_target_binding_uses_main_without_create(
        self, client, auth_headers, tmp_manager, monkeypatch
    ):
        _set_web("opencode")
        tmp_manager.set_current_session("ses_voice", title="语音")
        oc = _ChanStub("oc")
        loom = _ChanStub("loom", main_id="ses_loom_main")
        web = _ChanStub("web")
        _patch_channels(monkeypatch, oc=oc, loom=loom, web=web)

        resp = client.post("/api/screen/session/message",
                           json={"message": "首发", "to_agent": "helper",
                                 "backend": "loom"}, headers=auth_headers)

        assert resp.status_code == 200
        assert resp.json()["session_id"] == "ses_loom_main"
        assert not [c for c in loom.calls if c["m"] == "create_session"]
        assert loom.calls == [
            {"m": "get_main_session"},
            {"m": "send_message", "session_id": "ses_loom_main",
             "message": "首发", "agent": "helper"},
        ]
        assert tmp_manager.list_agent_sessions() == {"loom:main-task": "ses_loom_main"}
        assert tmp_manager.get_session_id() == "ses_voice"
        assert oc.calls == [] and web.calls == []

    def test_loom_message_resolver_failure_503_without_create(
        self, client, auth_headers, tmp_manager, monkeypatch
    ):
        _set_web("loom")
        oc = _ChanStub("oc")
        loom = _ChanStub("loom", main_error="HTTP 503: loom down")
        web = _ChanStub("web")
        _patch_channels(monkeypatch, oc=oc, loom=loom, web=web)

        resp = client.post("/api/screen/session/message",
                           json={"message": "首发", "backend": "loom"},
                           headers=auth_headers)

        assert resp.status_code == 503
        assert resp.json()["error"]["code"] == "SERVICE_UNAVAILABLE"
        assert not [c for c in loom.calls if c["m"] in ("create_session", "send_message")]
        assert tmp_manager.list_agent_sessions() == {}
        assert oc.calls == [] and web.calls == []

    def test_explicit_opencode_new_session_sets_current(
        self, client, auth_headers, tmp_manager, monkeypatch
    ):
        # 有效通道=显式 opencode：新建兜底照旧走 set_current_session（opencode 腿语义）
        _set_web("loom")
        oc, loom = _ChanStub("oc"), _ChanStub("loom")
        web = _ChanStub("web")
        _patch_channels(monkeypatch, oc=oc, loom=loom, web=web)

        resp = client.post("/api/screen/session/message",
                           json={"message": "首发", "backend": "opencode"},
                           headers=auth_headers)

        assert resp.status_code == 200
        assert resp.json()["session_id"] == "ses_new_oc"
        assert tmp_manager.get_session_id() == "ses_new_oc"  # opencode 腿照旧
        assert "opencode:main-task" not in tmp_manager.list_agent_sessions()
        assert loom.calls == [] and web.calls == []

    def test_explicit_invalid_backend_400_no_side_effects(
        self, client, auth_headers, tmp_manager, monkeypatch
    ):
        _set_web("loom")
        oc, loom, web = _ChanStub("oc"), _ChanStub("loom"), _ChanStub("web")
        _patch_channels(monkeypatch, oc=oc, loom=loom, web=web)

        resp = client.post("/api/screen/session/message",
                           json={"message": "x", "session_id": "s",
                                 "backend": "garage"}, headers=auth_headers)

        assert resp.status_code == 400
        assert resp.json()["success"] is False
        assert oc.calls == [] and loom.calls == [] and web.calls == []

    def test_empty_string_backend_passthrough_to_web_channel(
        self, client, auth_headers, tmp_manager, monkeypatch
    ):
        # None/"" 透传：走现语义 web 缝，绝不当非法值 400
        _set_web("loom")
        oc, loom, web = _ChanStub("oc"), _ChanStub("loom"), _ChanStub("web")
        _patch_channels(monkeypatch, oc=oc, loom=loom, web=web)

        resp = client.post("/api/screen/session/message",
                           json={"message": "x", "session_id": "s",
                                 "backend": ""}, headers=auth_headers)

        assert resp.status_code == 200
        assert web.calls[-1]["m"] == "send_message"
        assert oc.calls == [] and loom.calls == []

    def test_no_backend_uses_current_web_channel(
        self, client, auth_headers, tmp_manager, monkeypatch
    ):
        # 回归钉：不带 backend = 当次 get_web_backend() 通道（web 缝），两直调腿零调用
        _set_web("opencode")
        oc, loom, web, glob = (_ChanStub("oc"), _ChanStub("loom"),
                               _ChanStub("web"), _ChanStub("glob"))
        _patch_channels(monkeypatch, oc=oc, loom=loom, web=web, glob=glob)

        resp = client.post("/api/screen/session/message",
                           json={"message": "x", "session_id": "s"},
                           headers=auth_headers)

        assert resp.status_code == 200
        assert web.calls[-1]["m"] == "send_message"
        assert oc.calls == [] and loom.calls == [] and glob.calls == []


# ============================================================
# 4. messages / children 的 ?backend= 同语义
# ============================================================


class TestMessagesChildrenBackend:
    def test_messages_routes_by_explicit_backend(self, client, auth_headers, monkeypatch):
        oc, loom, web = _ChanStub("oc"), _ChanStub("loom"), _ChanStub("web")
        _patch_channels(monkeypatch, oc=oc, loom=loom, web=web)

        resp = client.get("/api/screen/session/xyz/messages?backend=loom&limit=7&before=c1",
                          headers=auth_headers)

        assert resp.status_code == 200
        payload = resp.json()
        assert set(payload.keys()) == {"session_id", "messages", "count", "next_cursor"}
        assert payload["session_id"] == "xyz" and payload["count"] == 0
        assert loom.calls == [{"m": "get_session_messages", "session_id": "xyz",
                               "limit": 7, "before": "c1"}]
        assert oc.calls == [] and web.calls == []

    def test_messages_without_backend_uses_web_channel(self, client, auth_headers, monkeypatch):
        _set_web("loom")
        oc, loom, web = _ChanStub("oc"), _ChanStub("loom"), _ChanStub("web")
        _patch_channels(monkeypatch, oc=oc, loom=loom, web=web)

        resp = client.get("/api/screen/session/xyz/messages", headers=auth_headers)

        assert resp.status_code == 200
        assert web.calls[-1]["m"] == "get_session_messages"
        assert oc.calls == [] and loom.calls == []

    def test_messages_invalid_backend_400(self, client, auth_headers, monkeypatch):
        oc, loom, web = _ChanStub("oc"), _ChanStub("loom"), _ChanStub("web")
        _patch_channels(monkeypatch, oc=oc, loom=loom, web=web)

        resp = client.get("/api/screen/session/xyz/messages?backend=nope",
                          headers=auth_headers)

        assert resp.status_code == 400
        assert resp.json()["success"] is False
        assert oc.calls == [] and loom.calls == [] and web.calls == []

    def test_children_routes_by_explicit_backend(self, client, auth_headers, monkeypatch):
        oc, loom, web = _ChanStub("oc"), _ChanStub("loom"), _ChanStub("web")
        _patch_channels(monkeypatch, oc=oc, loom=loom, web=web)

        resp = client.get("/api/screen/session/xyz/children?backend=opencode",
                          headers=auth_headers)

        assert resp.status_code == 200
        assert resp.json() == {"children": [{"id": "c1", "title": "子会话"}]}
        assert oc.calls == [{"m": "get_session_children", "session_id": "xyz"}]
        assert loom.calls == [] and web.calls == []

    def test_children_without_backend_and_failure_shape(
        self, client, auth_headers, monkeypatch
    ):
        _set_web("opencode")
        loom_fail = _ChanStub("loom", children_fail=True)
        web = _ChanStub("web", children_fail=True)
        oc = _ChanStub("oc")
        _patch_channels(monkeypatch, oc=oc, loom=loom_fail, web=web)

        # 不带 backend：web 缝（剥壳/降级现状不动）
        resp = client.get("/api/screen/session/xyz/children", headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json() == {"children": [], "error": "boom-children-web"}
        assert web.calls == [{"m": "get_session_children", "session_id": "xyz"}]

        # 带 backend=loom：显式腿失败同样 200 + error 键（现语义复用）
        resp2 = client.get("/api/screen/session/xyz/children?backend=loom",
                           headers=auth_headers)
        assert resp2.status_code == 200
        assert resp2.json() == {"children": [], "error": "boom-children-loom"}
        assert oc.calls == []

    def test_children_invalid_backend_400(self, client, auth_headers, monkeypatch):
        oc, loom, web = _ChanStub("oc"), _ChanStub("loom"), _ChanStub("web")
        _patch_channels(monkeypatch, oc=oc, loom=loom, web=web)

        resp = client.get("/api/screen/session/xyz/children?backend=Loom",
                          headers=auth_headers)  # 精确匹配：大小写不合法

        assert resp.status_code == 400
        assert oc.calls == [] and loom.calls == [] and web.calls == []


# ============================================================
# 5. (h) W46 switch 通道化 + engine 存在即收编
# ============================================================


class TestSwitchChannelAdoption:
    """POST /session/switch 通道腿语义（协议冻结名：请求可选 backend；错误码 404/503）。

    判别基准：engine 失败信封 detail 以 "HTTP 404" 开头 = 会话不存在（诚实 404）；
    其余失败（连接炸/非404/系统异常）= engine 未能给可靠答案 → 503 SERVICE_UNAVAILABLE。
    """

    def test_unregistered_sid_explicit_loom_adopted(
        self, client, auth_headers, tmp_manager, monkeypatch
    ):
        # Given：web=opencode（与请求通道刻意分叉）；sid 未注册；loom engine 报告存在
        _set_web("opencode")
        tmp_manager.set_agent_session("main-task", "ses_voice")  # 裸键属语音，零触碰
        oc, web, glob = _ChanStub("oc"), _ChanStub("web"), _ChanStub("glob")
        loom = _ChanStub("loom", status_found=True, status_title="Loom 引擎标题")
        _patch_channels(monkeypatch, oc=oc, loom=loom, web=web, glob=glob)

        resp = client.post("/api/screen/session/switch",
                           json={"session_id": "ses_loom_new", "backend": "loom"},
                           headers=auth_headers)

        # Then：200 + 收编（history 登记 + current 切换 + 响应形状与本地路径同构）
        assert resp.status_code == 200
        assert resp.json() == {
            "status": "switched", "session_id": "ses_loom_new",
            "title": "Loom 引擎标题", "agent_sessions": {"main-task": "ses_loom_new"},
        }
        assert "ses_loom_new" in [h["session_id"] for h in tmp_manager.list_sessions()]
        assert tmp_manager.get_session_id() == "ses_loom_new"
        # 判别腿：只碰 loom 直调桩；opencode 直调/web 缝/全局缝零调用
        assert loom.calls == [{"m": "get_session_status", "session_id": "ses_loom_new"}]
        assert oc.calls == [] and web.calls == [] and glob.calls == []

    def test_adopted_sid_namespaced_key_lands_requested_channel(
        self, client, auth_headers, tmp_manager, monkeypatch
    ):
        # 命名键修案：web=opencode 但请求 backend=loom → 只写 "loom:main-task"，
        # "opencode:main-task" 绝不落该 sid（修"写错命名键"）
        _set_web("opencode")
        loom = _ChanStub("loom", status_found=True)
        _patch_channels(monkeypatch, oc=_ChanStub("oc"), loom=loom,
                        web=_ChanStub("web"), glob=_ChanStub("glob"))

        resp = client.post("/api/screen/session/switch",
                           json={"session_id": "ses_l2", "backend": "loom"},
                           headers=auth_headers)

        assert resp.status_code == 200
        assert resp.json()["title"] == "会话"  # 无请求 title、engine 无可读标题 → 兜底
        bindings = tmp_manager.list_agent_sessions()
        assert bindings["loom:main-task"] == "ses_l2"
        assert bindings.get("opencode:main-task") != "ses_l2"

    def test_engine_404_stays_honest_404(self, client, auth_headers, tmp_manager, monkeypatch):
        _set_web("opencode")
        oc = _ChanStub("oc")  # 缺省 status_found=False → "HTTP 404: ..." 信封
        loom, web, glob = _ChanStub("loom"), _ChanStub("web"), _ChanStub("glob")
        _patch_channels(monkeypatch, oc=oc, loom=loom, web=web, glob=glob)

        resp = client.post("/api/screen/session/switch",
                           json={"session_id": "ses_ghost", "backend": "opencode"},
                           headers=auth_headers)

        assert resp.status_code == 404
        payload = resp.json()
        assert payload["success"] is False
        assert payload["error"] == {"code": "NOT_FOUND", "message": "会话不存在"}
        # 查无 → 零副作用：不收编、不写绑定
        assert tmp_manager.list_sessions() == []
        assert tmp_manager.list_agent_sessions() == {}
        assert oc.calls == [{"m": "get_session_status", "session_id": "ses_ghost"}]
        assert loom.calls == [] and web.calls == [] and glob.calls == []

    def test_engine_connection_boom_503(self, client, auth_headers, tmp_manager, monkeypatch):
        # 连接炸（非 404）→ 503 SERVICE_UNAVAILABLE（本波钉死的错误码裁定），零收编
        _set_web("loom")
        loom = _ChanStub("loom", status_detail="Cannot connect to host 127.0.0.1:5100")
        _patch_channels(monkeypatch, oc=_ChanStub("oc"), loom=loom,
                        web=_ChanStub("web"), glob=_ChanStub("glob"))

        resp = client.post("/api/screen/session/switch",
                           json={"session_id": "ses_unreach", "backend": "loom"},
                           headers=auth_headers)

        assert resp.status_code == 503
        payload = resp.json()
        assert payload["error"]["code"] == "SERVICE_UNAVAILABLE"
        assert "Cannot connect to host" in payload["error"]["message"]
        assert tmp_manager.list_sessions() == []
        assert tmp_manager.list_agent_sessions() == {}

    def test_invalid_backend_400_zero_side_effects(
        self, client, auth_headers, tmp_manager, monkeypatch
    ):
        _set_web("opencode")
        oc, loom, web, glob = (_ChanStub("oc"), _ChanStub("loom"),
                               _ChanStub("web"), _ChanStub("glob"))
        _patch_channels(monkeypatch, oc=oc, loom=loom, web=web, glob=glob)

        resp = client.post("/api/screen/session/switch",
                           json={"session_id": "ses_x", "backend": "garage"},
                           headers=auth_headers)

        assert resp.status_code == 400
        assert resp.json()["success"] is False
        assert oc.calls == [] and loom.calls == [] and web.calls == [] and glob.calls == []
        assert tmp_manager.list_sessions() == []
        assert tmp_manager.list_agent_sessions() == {}

    def test_local_registered_no_backend_response_byte_identical(
        self, client, auth_headers, tmp_manager, monkeypatch
    ):
        # 回归金样：本地已注册 sid、不带 backend → 响应与改造前逐字节一致
        # （旧形状：四键 status/session_id/title/agent_sessions，无新增键）
        _set_web("opencode")
        tmp_manager.set_current_session("ses_gold", title="金样标题")
        tmp_manager.set_agent_session("main-task", "ses_voice_bare")
        oc, loom, web, glob = (_ChanStub("oc"), _ChanStub("loom"),
                               _ChanStub("web"), _ChanStub("glob"))
        _patch_channels(monkeypatch, oc=oc, loom=loom, web=web, glob=glob)

        resp = client.post("/api/screen/session/switch",
                           json={"session_id": "ses_gold"}, headers=auth_headers)

        assert resp.status_code == 200
        assert resp.json() == {
            "status": "switched", "session_id": "ses_gold",
            "title": "金样标题", "agent_sessions": {"main-task": "ses_gold"},
        }
        # 本地命中不核验 engine：四缝零调用
        assert oc.calls == [] and loom.calls == [] and web.calls == [] and glob.calls == []
        # 命名键 = 当前 web 通道（backend 缺省时语义不动），裸键零污染
        assert tmp_manager.get_agent_session("opencode:main-task") == "ses_gold"
        assert tmp_manager.get_agent_session("main-task") == "ses_voice_bare"

    def test_local_registered_explicit_backend_writes_right_channel_no_probe(
        self, client, auth_headers, tmp_manager, monkeypatch
    ):
        # 本地命中腿：backend="loom" 只改命名键落点（loom:main-task），
        # 响应形状不动、engine 核验零调用（本地注册表即真相）
        _set_web("opencode")
        tmp_manager.set_current_session("ses_lh", title="本地命中")
        oc, loom = _ChanStub("oc"), _ChanStub("loom")
        web, glob = _ChanStub("web"), _ChanStub("glob")
        _patch_channels(monkeypatch, oc=oc, loom=loom, web=web, glob=glob)

        resp = client.post("/api/screen/session/switch",
                           json={"session_id": "ses_lh", "backend": "loom"},
                           headers=auth_headers)

        assert resp.status_code == 200
        assert resp.json() == {
            "status": "switched", "session_id": "ses_lh",
            "title": "本地命中", "agent_sessions": {"main-task": "ses_lh"},
        }
        assert loom.calls == [] and oc.calls == [] and web.calls == [] and glob.calls == []
        assert tmp_manager.get_agent_session("loom:main-task") == "ses_lh"

    def test_empty_backend_passthrough_and_title_precedence(
        self, client, auth_headers, tmp_manager, monkeypatch
    ):
        # backend="" 透传 = 当前 web 通道（loom）核验；请求 title 优先于 engine 可读值
        _set_web("loom")
        loom = _ChanStub("loom", status_found=True, status_title="engine标题")
        _patch_channels(monkeypatch, oc=_ChanStub("oc"), loom=loom,
                        web=_ChanStub("web"), glob=_ChanStub("glob"))

        resp = client.post("/api/screen/session/switch",
                           json={"session_id": "ses_tp", "backend": "", "title": "请求标题"},
                           headers=auth_headers)

        assert resp.status_code == 200
        assert resp.json()["title"] == "请求标题"
        assert loom.calls == [{"m": "get_session_status", "session_id": "ses_tp"}]
        assert tmp_manager.get_agent_session("loom:main-task") == "ses_tp"

    def test_switch_invalidates_loom_main_cache(
        self, client, auth_headers, tmp_manager, monkeypatch
    ):
        _set_web("loom")
        tmp_manager.set_current_session("ses_local", title="本地")
        loom = _ChanStub("loom", sessions_items=[LOOM_ALPHA], main_id="loom_alpha")
        _patch_channels(monkeypatch, oc=_ChanStub("oc"), loom=loom,
                        web=_ChanStub("web"))

        client.get("/api/screen/session/list", headers=auth_headers)
        client.get("/api/screen/session/list", headers=auth_headers)
        assert [c["m"] for c in loom.calls].count("get_main_session") == 1

        resp = client.post("/api/screen/session/switch",
                           json={"session_id": "ses_local", "backend": "loom"},
                           headers=auth_headers)
        assert resp.status_code == 200

        client.get("/api/screen/session/list", headers=auth_headers)
        assert [c["m"] for c in loom.calls].count("get_main_session") == 2


class TestMessagesCursorPassthrough:
    """W50 回归: loom 页级合并(W43)使译后条数 < raw limit 是常态,
    "不满即截断"启发式曾把 next_cursor 掐死 → 前端回翻断链。
    新语义: 上游游标恒透传, 仅译后空页才截断(双通道零分支)。"""

    def test_merged_short_page_keeps_cursor(self, client, auth_headers, monkeypatch):
        oc, loom = _ChanStub("oc"), _ChanStub("loom")
        msgs = [{"info": {"id": f"msg_{i}", "role": "assistant",
                          "session_id": "xyz", "time": {"created": 1792000000000 + i}},
                 "parts": []} for i in range(3)]
        async def _msgs(session_id, limit=100, before=None):
            return loom._ok({"messages": msgs, "session_id": session_id,
                             "next_cursor": "cur9"})
        monkeypatch.setattr(loom, "get_session_messages", _msgs)
        _patch_channels(monkeypatch, oc=oc, loom=loom)
        resp = client.get("/api/screen/session/xyz/messages?backend=loom&limit=50",
                          headers=auth_headers)
        payload = resp.json()
        assert resp.status_code == 200
        # 3 < 50(合并压缩所致) 不再误判到头: 上游游标透传
        assert payload["next_cursor"] == "cur9", f"游标被截断: {payload['next_cursor']}"
        assert payload["count"] == 3

    def test_empty_page_still_truncates(self, client, auth_headers, monkeypatch):
        oc, loom = _ChanStub("oc"), _ChanStub("loom")
        async def _msgs(session_id, limit=100, before=None):
            return loom._ok({"messages": [], "session_id": session_id,
                             "next_cursor": "curX"})
        monkeypatch.setattr(loom, "get_session_messages", _msgs)
        _patch_channels(monkeypatch, oc=oc, loom=loom)
        resp = client.get("/api/screen/session/xyz/messages?backend=loom&limit=50",
                          headers=auth_headers)
        assert resp.status_code == 200
        # 译后空页(上游异常回空但带游标)才截断, 防前端空转死循环
        assert resp.json()["next_cursor"] is None
