# -*- coding: utf-8 -*-
"""AI 双通道工厂 + LoomEventHub（SSE 代理 loom 上游）离线单测。

工厂：ai_backend 值→通道单例路由（含非法值 fail-fast）。
LoomEventHub：桩 loom 客户端（无真 5100），验证发现→逐会话订阅→合流扇出→
发现失败哨兵→退避重连 的完整管线，帧信封与 opencode 通道逐键同构。
本 venv 无 pytest-asyncio，统一以 asyncio.run 同步驱动。
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest

from config.config import get_config
import routers.events as events
import routers.model_config as model_config_router
import routers.session as session_router
import services.ai_client_factory as factory
import services.loom_client as lc
import services.loom_main_session as lms
import services.opencode_client as oc
import services.web_backend_selector as wbs


def _set_backend(value):
    cfg = get_config()
    if value is None:
        return cfg._data.pop("ai_backend", None)
    old = cfg._data.get("ai_backend")
    cfg._data["ai_backend"] = value
    return old


class TestFactoryRouting:
    def setup_method(self):
        factory._reset_ai_client()

    def teardown_method(self):
        factory._reset_ai_client()

    def test_default_is_opencode(self):
        # 现网 config.yaml 缺 ai_backend 键时必须落在 opencode 通道（热回退兜底语义）
        old = _set_backend(None)
        try:
            assert factory.get_ai_backend() == "opencode"
        finally:
            _set_backend(old)

    def test_explicit_loom_returns_loom_client(self):
        old = _set_backend("loom")
        try:
            client = factory.get_ai_client()
            assert isinstance(client, lc.LoomClient)
            assert factory.get_ai_client() is client  # 单例
        finally:
            _set_backend(old)

    def test_opencode_branch_reuses_existing_singleton(self, monkeypatch):
        # W44 修环境红：本钉原读真实 config.yaml（现网 ai_backend=loom）拿错通道。
        # 用 _set_backend 固定配置态为 opencode（同类他用例同款缝），
        # 断言语义不弱化——仍钉"opencode 分支返回复用的 OpenCodeClient 单例"。
        old = _set_backend("opencode")
        try:
            # 桩端口探测（零触网），行为与原 get_opencode_client 一致
            monkeypatch.setattr(oc, "discover_opencode_url", lambda max_offset=10: "http://127.0.0.1:5096")
            client = factory.get_ai_client()
            assert isinstance(client, oc.OpenCodeClient)
        finally:
            _set_backend(old)

    def test_acquire_async_routes_to_loom(self):
        old = _set_backend("loom")
        try:
            client = asyncio.run(factory.acquire_ai_client())
            assert isinstance(client, lc.LoomClient)
        finally:
            _set_backend(old)

    def test_invalid_backend_fails_fast(self):
        old = _set_backend("lmao")
        try:
            with pytest.raises(ValueError):
                factory.get_ai_client()
        finally:
            _set_backend(old)

    def test_router_seams_are_aliased_to_factory(self):
        """调用点别名缝：测试 monkeypatch 与旧符号名零改动，双通道只换实现。"""
        assert session_router.acquire_opencode_client is factory.acquire_ai_client
        assert model_config_router.acquire_opencode_client is factory.acquire_ai_client


class _FakeSessionManager:
    """内存绑定表（resolver 只读写 loom:main-task，hub 轮询读全部 loom: 键）。"""

    def __init__(self, bindings=None):
        self.bindings = dict(bindings or {})

    def get_agent_session(self, key):
        return self.bindings.get(key)

    def set_agent_session(self, key, session_id):
        self.bindings[key] = session_id

    def list_agent_sessions(self):
        return dict(self.bindings)


class _FakeLoom:
    """桩 loom 上游：主会话权威 + 每会话独立帧队列（跨会话不串，能证明订阅建立）。

    方法面 = LoomEventHub 的全部依赖（get_main_session / get_session_children /
    stream_session_events / base_url），与 services.loom_client.LoomClient 同构。
    故意不提供 list_session_ids：调用即 AttributeError，钉死"绝不走 GET /sessions"。
    """

    base_url = "http://loom.test:5100"

    def __init__(self, main="s1"):
        self.main = main
        self.main_error = None
        self.queues: dict = {}
        self.started: set = set()
        self.attempts: dict = {}
        self.children_rows: list = []

    def queue_for(self, sid):
        return self.queues.setdefault(sid, asyncio.Queue())

    async def get_main_session(self):
        if self.main_error:
            return {"ok": False, "data": None,
                    "error": {"source": "loom", "detail": self.main_error, "code": 500}}
        return {"ok": True, "error": None,
                "data": {"sessionID": self.main, "status": "idle"}}

    async def get_session_children(self, session_id):
        return {"ok": True, "error": None,
                "data": {"children": list(self.children_rows)}}

    async def stream_session_events(self, session_id):
        self.started.add(session_id)
        self.attempts[session_id] = self.attempts.get(session_id, 0) + 1
        queue = self.queue_for(session_id)
        while True:
            frame = await queue.get()
            if frame is None:
                return
            yield f"data: {json.dumps(frame)}"


async def _wait_until(cond, timeout=3.0):
    """有界等待订阅者协程就绪（发现轮询 0.05s，正常远快于超时）。"""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while not cond():
        if loop.time() > deadline:
            raise AssertionError("条件在预算内未达成")
        await asyncio.sleep(0.02)


class TestLoomEventHub:
    """T6：hub 从"GET /sessions 列表发现"改为 主会话 + loom: 绑定 + children 帧。"""

    @pytest.fixture(autouse=True)
    def _isolate_sources(self, monkeypatch):
        lms.reset_loom_main_cache()
        manager = _FakeSessionManager()
        monkeypatch.setattr(events, "get_session_manager", lambda: manager)
        yield manager
        lms.reset_loom_main_cache()

    def test_main_fanout_binding_discovery_and_main_reconnect(
        self, monkeypatch, _isolate_sources
    ):
        """主会话帧扇出；loom: 绑定 5s 内起读者；主会话断流自愈重连。"""
        monkeypatch.setattr(events, "LOOM_SESSION_REFRESH_INTERVAL", 0.05)
        monkeypatch.setattr(events, "LOOM_READER_INITIAL_BACKOFF", 0.02)
        fake = _FakeLoom(main="s1")
        hub = events.LoomEventHub(fake)

        async def scenario():
            queue = await hub.subscribe()
            # 1) 连接提示帧（与 opencode 通道同名事件，前端零改动）
            await _wait_until(lambda: "s1" in fake.started)
            first = await asyncio.wait_for(queue.get(), 2)
            assert json.loads(first.split("data:", 1)[1])["type"] == "proxy.connected"

            # 2) 主会话帧原样扇出（信封同构 + source 行为不变）
            await fake.queue_for("s1").put(
                {"payload": {"type": "session.idle", "properties": {"sessionID": "s1"}}}
            )
            frame = await asyncio.wait_for(queue.get(), 2)
            data = json.loads(frame.split("data:", 1)[1])
            assert data["payload"]["type"] == "session.idle"
            assert data["source"] == "main"

            # 3) 本地 loom: 绑定（/session/switch|/session/create 落点）→ 起 s2 读者
            _isolate_sources.bindings["loom:reviewer"] = "s2"
            await _wait_until(lambda: "s2" in fake.started)
            await fake.queue_for("s2").put(
                {"payload": {"type": "session.status", "properties": {"sessionID": "s2"}}}
            )
            frame2 = await asyncio.wait_for(queue.get(), 2)
            data2 = json.loads(frame2.split("data:", 1)[1])
            assert data2["payload"]["type"] == "session.status"
            assert data2["payload"]["properties"]["sessionID"] == "s2"

            # 4) 主会话流自然结束 → 读者自愈重连（非整体断线，不广播 disconnected）
            await fake.queue_for("s1").put(None)
            await _wait_until(lambda: fake.attempts.get("s1", 0) >= 2)
            await fake.queue_for("s1").put(
                {"payload": {"type": "session.idle", "properties": {"sessionID": "s1"}}}
            )
            frame3 = await asyncio.wait_for(queue.get(), 2)
            assert json.loads(frame3.split("data:", 1)[1])["payload"]["type"] == "session.idle"

            await hub.unsubscribe(queue)

        asyncio.run(asyncio.wait_for(scenario(), 15))

    def test_main_unavailable_raises_to_parent_backoff(self, monkeypatch):
        """无主会话 → ConnectionError 交父类退避重连，绝不创建会话。"""
        monkeypatch.setattr(events, "LOOM_SESSION_REFRESH_INTERVAL", 0.05)
        fake = _FakeLoom(main="s1")
        fake.main_error = "HTTP 404: no main session"
        hub = events.LoomEventHub(fake)

        async def scenario():
            queue = await hub.subscribe()
            item = await asyncio.wait_for(queue.get(), 3)
            assert "proxy.disconnected" in item
            assert hub._main_session_id is None
            await hub.unsubscribe(queue)

        asyncio.run(asyncio.wait_for(scenario(), 15))



def _reset_hub_globals():
    """双活槽位复位（_hubs 两槽清空，防串测试）。"""
    events._hubs["opencode"] = None
    events._hubs["loom"] = None


class TestEventHubDualLive:
    """W44：per-backend 双活 hub 注册表——分槽懒建并存共活，通道切换零影响 hub。

    取代 W30 互斥钉（漂移停旧建新）：事故线证明"开关驱动 hub 重建"会把会话
    指针从在途流下面抽走；双活后 get_event_hub(backend) 不再读开关取值，
    reset_event_hub 仅作 teardown-all（测试/lifespan）工具。loom 侧经
    services.loom_client 模块单例缝接 _FakeLoom 零触网；opencode 侧只构造
    不订阅（不起任务、零触网）。
    """

    def setup_method(self):
        _reset_hub_globals()

    def teardown_method(self):
        _reset_hub_globals()

    def test_per_backend_slots_build_lazily_and_coexist(self, monkeypatch):
        """两槽各自懒建后并存挂册；重复取用同实例（幂等）。"""
        fake = _FakeLoom()
        monkeypatch.setattr(lc, "_loom_client", fake)
        hub_loom = events.get_event_hub("loom")
        hub_open = events.get_event_hub("opencode")
        assert isinstance(hub_loom, events.LoomEventHub)
        assert hub_loom._client is fake  # loom 客户端经模块单例缝，绝不 get_web_client
        assert type(hub_open) is events.EventHub  # opencode 通道=基类（非 Loom 扇出）
        assert hub_open._task is None  # 未订阅不起任务
        assert events._hubs == {"opencode": hub_open, "loom": hub_loom}
        assert events.get_event_hub("loom") is hub_loom
        assert events.get_event_hub("opencode") is hub_open

    def test_selector_drift_no_longer_stops_any_hub(self, monkeypatch):
        """通道取值漂移：两 hub 实例恒稳、在途 loom 流不断帧、零哨兵零取消。"""
        monkeypatch.setattr(events, "LOOM_SESSION_REFRESH_INTERVAL", 0.05)
        fake = _FakeLoom()
        monkeypatch.setattr(lc, "_loom_client", fake)
        current = {"backend": "loom"}
        # get_event_hub 已不读 selector——本 patch 只证"漂移无副作用"
        monkeypatch.setattr(wbs, "get_web_backend", lambda: current["backend"])

        async def scenario():
            hub_loom = events.get_event_hub("loom")
            queue = await hub_loom.subscribe()
            old_task = hub_loom._task  # 退订竞态会置 None，先攥引用
            await _wait_until(lambda: "s1" in fake.started)
            first = await asyncio.wait_for(queue.get(), 2)
            assert json.loads(first.split("data:", 1)[1])["type"] == "proxy.connected"

            # 漂移 loom->opencode：opencode 槽懒建，loom hub 完整存活
            current["backend"] = "opencode"
            hub_open = events.get_event_hub("opencode")
            assert type(hub_open) is events.EventHub
            assert hub_open._task is None
            assert hub_loom._task is old_task and not old_task.cancelled()
            assert hub_loom.has_subscribers

            # 在途 loom 流继续出帧且带通道标
            await fake.queue_for("s1").put(
                {"payload": {"type": "session.idle", "properties": {"sessionID": "s1"}}}
            )
            frame = await asyncio.wait_for(queue.get(), 2)
            data = json.loads(frame.split("data:", 1)[1])
            assert data["payload"]["properties"]["backend"] == "loom"

            # 漂回：两槽各还原实例（不重建不停旧）
            current["backend"] = "loom"
            assert events.get_event_hub("loom") is hub_loom
            assert events.get_event_hub("opencode") is hub_open

            await hub_loom.unsubscribe(queue)
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(old_task, 3)

        asyncio.run(asyncio.wait_for(scenario(), 15))

    def test_same_backend_stable_and_unknown_fails_fast(self):
        """无漂移恒同实例；未知通道名 fail-fast。"""
        hub1 = events.get_event_hub("opencode")
        hub2 = events.get_event_hub("opencode")
        assert hub1 is hub2
        with pytest.raises(ValueError):
            events.get_event_hub("lmao")

    def test_reset_event_hub_tears_down_both_slots(self, monkeypatch):
        """teardown-all：reset 停两 hub、await 取消完成、两槽清空、多路复用订阅者哨兵收尾。"""
        monkeypatch.setattr(events, "LOOM_SESSION_REFRESH_INTERVAL", 0.05)
        fake = _FakeLoom()
        monkeypatch.setattr(lc, "_loom_client", fake)

        async def _idle_upstream(self):
            await asyncio.sleep(30)

        monkeypatch.setattr(events.EventHub, "_stream_upstream", _idle_upstream)

        async def scenario():
            hub_loom = events.get_event_hub("loom")
            hub_open = events.get_event_hub("opencode")
            q_loom = await hub_loom.subscribe()
            q_open = await hub_open.subscribe()
            task_loom, task_open = hub_loom._task, hub_open._task
            assert q_loom is not q_open  # 独立订阅各自建队列

            got = []

            async def _consume():
                async for chunk in events.event_generator():
                    got.append(chunk)

            consumer = asyncio.create_task(_consume())
            await _wait_until(lambda: "s1" in fake.started and got)

            await asyncio.wait_for(events.reset_event_hub(), 5)

            # 多路复用流收到哨兵干净终结；两槽确认清空、任务取消完成
            await asyncio.wait_for(consumer, 3)
            assert "proxy.connected" in got[0]
            assert events._hubs == {"opencode": None, "loom": None}
            assert task_loom.cancelled() and task_open.cancelled()

            # 无泄漏：取消传播给读者/心跳协程后（让出一轮调度）全部任务已结束
            await asyncio.sleep(0.05)
            leaked = [t for t in asyncio.all_tasks()
                      if t is not asyncio.current_task() and not t.done()]
            assert not leaked, leaked

        asyncio.run(asyncio.wait_for(scenario(), 15))
