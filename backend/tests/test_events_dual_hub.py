# -*- coding: utf-8 -*-
"""W44-T1：per-backend 双活 hub 注册表 + /events/stream 多路复用 + 帧 backend 通道标。

钉四条不变量（事故线：全局开关翻动 -> hub 重建 -> 前端旧 sid 打错后端 404；
本改造让"会话属于后端"而非"属于开关"）：
  (a) _process_sse_line(line, backend) 对 dict-properties 帧注入 properties.backend；
      properties 缺失/非 dict = 不注入但帧照发（纯增量字段，老前端忽略）；
  (b) opencode/loom 两槽各自 ensure 后并存共活，通道取值漂移不停任何一个；
  (c) 单条 event_generator 流同时出 A 流与 B 流帧（一个共享订阅队列挂两 hub）；
  (d) 停单 hub 的 None 哨兵只终结该 hub——另一 hub 的帧对专属订阅者继续投递。

零触网：loom 经 _FakeLoom 桩（挂 services.loom_client 模块单例缝）；opencode 上游
经 monkeypatch EventHub._stream_upstream（LoomEventHub 覆写不受影响）。
本 venv 无 pytest-asyncio，统一以 asyncio.run 同步驱动（test_ai_client_factory 先例）。
"""
import asyncio
import contextlib
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest

import routers.events as events
import services.loom_client as lc
import services.loom_main_session as lms
import services.web_backend_selector as wbs


class _FakeSessionManager:
    """内存绑定表（T6：hub 会话来源=主会话 resolver + loom: 绑定，不再列表面）。"""

    def __init__(self, bindings=None):
        self.bindings = dict(bindings or {})

    def get_agent_session(self, key):
        return self.bindings.get(key)

    def set_agent_session(self, key, session_id):
        self.bindings[key] = session_id

    def list_agent_sessions(self):
        return dict(self.bindings)


@pytest.fixture(autouse=True)
def _clean_hub_slots(monkeypatch):
    """槽位前后隔离：双槽清空，防跨用例/跨文件串扰；resolver 缓存同样复位。"""
    lms.reset_loom_main_cache()
    manager = _FakeSessionManager()
    monkeypatch.setattr(events, "get_session_manager", lambda: manager)
    monkeypatch.setattr(events, "_opencode_enabled", lambda: True)
    events._hubs["opencode"] = None
    events._hubs["loom"] = None
    yield manager
    events._hubs["opencode"] = None
    events._hubs["loom"] = None
    lms.reset_loom_main_cache()


class _FakeLoom:
    """桩 loom 客户端：权威主会话 + 每会话独立帧队列，零触网。

    方法面（get_main_session/stream_session_events/base_url）与
    services.loom_client.LoomClient 同构；不提供 list_session_ids，
    调用即 AttributeError（T6 钉死"hub 绝不走 GET /sessions"）。
    """

    base_url = "http://loom.test:5100"

    def __init__(self, main="s1"):
        self.main = main
        self.queues: dict = {}
        self.started: set = set()

    def queue_for(self, sid):
        return self.queues.setdefault(sid, asyncio.Queue())

    async def get_main_session(self):
        return {"ok": True, "error": None,
                "data": {"sessionID": self.main, "status": "idle"}}

    async def stream_session_events(self, session_id):
        self.started.add(session_id)
        queue = self.queue_for(session_id)
        while True:
            frame = await queue.get()
            if frame is None:
                return
            yield f"data: {json.dumps(frame)}"


async def _wait_until(cond, timeout=3.0):
    """有界等待条件达成（发现轮询 0.05s，正常远快于超时）。"""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while not cond():
        if loop.time() > deadline:
            raise AssertionError("条件在预算内未达成")
        await asyncio.sleep(0.02)


def _frame_data(chunk):
    """SSE 片段 -> payload dict（非 data 行返回 None）。"""
    if not chunk.startswith("data:"):
        return None
    return json.loads(chunk.split("data:", 1)[1])


# ============================================================
# (a) 帧通道标注入
# ============================================================

class TestBackendLabelInjection:
    def test_dict_properties_frame_carries_backend(self):
        """dict-properties 帧：sessionID 之后、重序列化之前注入 backend，既有字段零损。"""
        line = "data: " + json.dumps({
            "payload": {"type": "session.idle", "properties": {"sessionID": "s-9"}}
        })
        out = events._process_sse_line(line, backend="loom")
        data = _frame_data(out)
        assert data["payload"]["properties"]["backend"] == "loom"
        assert data["payload"]["properties"]["sessionID"] == "s-9"  # 既有键不动
        assert data["payload"]["type"] == "session.idle"
        assert data["source"] == "main"  # 原 source 行为保持

    def test_opencode_channel_label(self):
        line = "data: " + json.dumps({
            "payload": {"type": "t", "properties": {}}
        })
        out = events._process_sse_line(line, backend="opencode")
        data = _frame_data(out)
        assert data["payload"]["properties"]["backend"] == "opencode"

    def test_missing_properties_no_injection_frame_still_sent(self):
        """properties 缺失 = 不注入（绝不凭空造壳），帧照发。"""
        line = "data: " + json.dumps({"payload": {"type": "server.connected"}})
        out = events._process_sse_line(line, backend="loom")
        data = _frame_data(out)
        assert "properties" not in data["payload"]
        assert data["payload"]["type"] == "server.connected"

    def test_non_dict_properties_frame_still_sent_untouched(self):
        """properties 非 dict = 不注入但帧照发（形状原样）。"""
        payload = {"payload": {"type": "t", "properties": "junk"}}
        line = "data: " + json.dumps(payload)
        out = events._process_sse_line(line, backend="loom")
        assert out is not None
        data = _frame_data(out)
        assert data["payload"]["properties"] == "junk"
        assert "backend" not in json.dumps(data)

    def test_unparseable_data_line_forwarded_as_is(self):
        """坏 JSON 行进既有直通分支：不注入、照发（行为与 W30 逐字节一致）。"""
        out = events._process_sse_line("data: {broken", backend="loom")
        assert out == "data: {broken\n\n"

    def test_control_frames_without_properties_untouched(self):
        """hub 自产控制帧形态（{'type': ...}，无 payload）：无 properties 即无标。"""
        out = events._process_sse_line(
            "data: " + json.dumps({"type": "proxy.connected"}), backend="loom"
        )
        data = _frame_data(out)
        assert "payload" not in data
        assert "backend" not in json.dumps(data)


    def test_sse_comment_heartbeat_lines_are_skipped(self):
        """Loom 的 ": keepalive" 注释行不得包成 data:，否则前端 JSON.parse 每 15s 报错。"""
        assert events._process_sse_line(": keepalive", backend="loom") is None
        assert events._process_sse_line(": heartbeat", backend="opencode") is None


# ============================================================
# (b) 双槽并存共活
# ============================================================

class TestDualLiveSlots:
    def test_slots_coexist_and_drift_stops_neither(self, monkeypatch):
        """两槽各自 ensure 后并存；通道取值漂移不再停任何一个（get_event_hub 已不读开关）。"""
        monkeypatch.setattr(events, "LOOM_SESSION_REFRESH_INTERVAL", 0.05)
        fake = _FakeLoom()
        # loom 客户端必须经 services.loom_client 模块单例缝注入（绝不 get_web_client）
        monkeypatch.setattr(lc, "_loom_client", fake)
        current = {"backend": "loom"}
        monkeypatch.setattr(wbs, "get_web_backend", lambda: current["backend"])

        hub_loom = events.get_event_hub("loom")
        hub_open = events.get_event_hub("opencode")
        assert isinstance(hub_loom, events.LoomEventHub)
        assert hub_loom._client is fake
        assert type(hub_open) is events.EventHub
        assert hub_open._task is None  # opencode 槽只构造未订阅，不起任务零触网
        assert events._hubs["opencode"] is hub_open
        assert events._hubs["loom"] is hub_loom  # 两 hub 同时挂册=并存不变量

        # 取值漂移：两槽实例恒稳，无任何重建/停旧
        current["backend"] = "opencode"
        assert events.get_event_hub("loom") is hub_loom
        assert events.get_event_hub("opencode") is hub_open
        current["backend"] = "loom"
        assert events.get_event_hub("loom") is hub_loom
        assert events.get_event_hub("opencode") is hub_open

    def test_loom_hub_keeps_streaming_after_opencode_ensure(self, monkeypatch):
        """opencode 槽 ensure 之后，loom hub 的在途流照常出帧（漂移不停任何一个）。"""
        monkeypatch.setattr(events, "LOOM_SESSION_REFRESH_INTERVAL", 0.05)
        fake = _FakeLoom()
        monkeypatch.setattr(lc, "_loom_client", fake)

        async def scenario():
            hub_loom = events.get_event_hub("loom")
            queue = await hub_loom.subscribe()
            await _wait_until(lambda: "s1" in fake.started)
            first = await asyncio.wait_for(queue.get(), 2)
            assert _frame_data(first)["type"] == "proxy.connected"

            # 漂移场景：开关翻到 opencode，两 hub 各自 ensure
            events.get_event_hub("opencode")

            await fake.queue_for("s1").put(
                {"payload": {"type": "session.idle", "properties": {"sessionID": "s1"}}}
            )
            frame = await asyncio.wait_for(queue.get(), 2)
            data = _frame_data(frame)
            assert data["payload"]["properties"]["backend"] == "loom"
            assert not hub_loom._task.cancelled()
            assert hub_loom.has_subscribers

            await hub_loom.unsubscribe(queue)

        asyncio.run(asyncio.wait_for(scenario(), 15))

    def test_unknown_backend_fails_fast(self):
        with pytest.raises(ValueError):
            events.get_event_hub("lmao")


# ============================================================
# (c) 单条多路复用流：交叠双流帧
# ============================================================

class TestMultiplexedStream:
    def test_single_stream_carries_frames_from_both_hubs(self, monkeypatch):
        """一条 event_generator 订阅队列交叠 A/B 双流帧，每帧带各自 backend 标。"""
        monkeypatch.setattr(events, "LOOM_SESSION_REFRESH_INTERVAL", 0.05)
        fake = _FakeLoom()
        monkeypatch.setattr(lc, "_loom_client", fake)

        async def _fake_opencode_stream(self):
            # 注入一条 opencode 上游帧后挂住，模拟长连接持续在线
            self._broadcast(events._process_sse_line(
                "data: " + json.dumps({
                    "payload": {
                        "type": "session.idle",
                        "properties": {"sessionID": "oc-1"},
                    }
                }),
                "opencode",
            ))
            await asyncio.sleep(30)

        # patch 基类方法：EventHub 实例吃桩，LoomEventHub 覆写不受影响
        monkeypatch.setattr(events.EventHub, "_stream_upstream", _fake_opencode_stream)

        async def scenario():
            collected = []

            async def _consume():
                async for chunk in events.event_generator():
                    collected.append(chunk)

            consumer = asyncio.create_task(_consume())
            await _wait_until(lambda: "s1" in fake.started)
            await fake.queue_for("s1").put(
                {"payload": {"type": "session.status", "properties": {"sessionID": "s1"}}}
            )

            # 同一队列内两通道帧都到齐
            backends = set()
            deadline = asyncio.get_running_loop().time() + 3.0
            while backends != {"loom", "opencode"}:
                if asyncio.get_running_loop().time() > deadline:
                    raise AssertionError(f"双流帧未交叠到达: {collected!r}")
                await asyncio.sleep(0.02)
                backends = {
                    d["payload"]["properties"]["backend"]
                    for d in map(_frame_data, collected)
                    if d and d.get("payload", {}).get("properties", {}).get("backend")
                }

            # 每条 dict-properties 帧都带标且通道正确
            labeled = [
                d["payload"]["properties"]["backend"]
                for d in map(_frame_data, collected)
                if d and isinstance(d.get("payload", {}).get("properties"), dict)
            ]
            assert labeled and all(b in ("loom", "opencode") for b in labeled)

            # 客户端断开：共享队列从两 hub 同时退订（双流都 ensure 的对称收尾）
            consumer.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await consumer
            for hub in (events._hubs["opencode"], events._hubs["loom"]):
                assert not hub.has_subscribers

        asyncio.run(asyncio.wait_for(scenario(), 15))


# ============================================================
# (d) 单 hub 关停：哨兵只终结该 hub
# ============================================================

class TestSingleHubStop:
    def test_sentinel_ends_only_stopped_hub_other_keeps_streaming(self, monkeypatch):
        """_stop_hub(A)：A 的订阅队列收 None 终结；B 的专属订阅者帧继续、任务不死。

        多路复用流（共享队列）语义按 W44 钉：哨兵终结本响应流并两 hub 一并退订，
        前端 EventSource 按既有退避重连——绝不影响另一 hub 对其自有订阅者的扇出。
        """
        monkeypatch.setattr(events, "LOOM_SESSION_REFRESH_INTERVAL", 0.05)
        fake = _FakeLoom()
        monkeypatch.setattr(lc, "_loom_client", fake)

        async def _idle_opencode_stream(self):
            await asyncio.sleep(30)

        monkeypatch.setattr(events.EventHub, "_stream_upstream", _idle_opencode_stream)

        async def scenario():
            hub_a = events.get_event_hub("opencode")  # 被停的 hub
            hub_b = events.get_event_hub("loom")      # 继续活的 hub

            # 多路复用订阅者：一个共享队列挂两 hub（经 event_generator 建）
            got = []

            async def _consume():
                async for chunk in events.event_generator():
                    got.append(chunk)

            multiplex = asyncio.create_task(_consume())
            await _wait_until(lambda: "s1" in fake.started and got)

            # hub B 的专属订阅者（独立队列）
            q_b = await hub_b.subscribe()

            # 只停 A：哨兵进 A 的订阅者（共享队列），取消 A 任务
            a_task = hub_a._task
            events._stop_hub(hub_a)

            # 共享队列收到 None -> 多路复用流干净终结（return，非异常）
            await asyncio.wait_for(multiplex, 3)
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(a_task, 3)

            # finally 已把共享队列从两 hub 同时退订（不留孤儿队列）
            assert not hub_b._subscribers or q_b in hub_b._subscribers

            # 另一 hub 帧继续：广播对 B 的专属订阅者可见，任务不死
            hub_b._broadcast(events._process_sse_line(
                "data: " + json.dumps({
                    "payload": {"type": "session.idle", "properties": {"sessionID": "s1"}}
                }),
                "loom",
            ))
            frame = await asyncio.wait_for(q_b.get(), 2)
            assert _frame_data(frame)["payload"]["properties"]["backend"] == "loom"
            assert not hub_b._task.cancelled()

            await hub_b.unsubscribe(q_b)

        asyncio.run(asyncio.wait_for(scenario(), 15))
