# -*- coding: utf-8 -*-
"""dsh SSE hub：单会话上游 -> 合流扇出 -> properties.backend="dsh" 通道标。

零触网：dsh 客户端经 services.dsh_client 模块单例缝注入桩；
event_generator 的通道选择用记录型 stub hub 验证（dsh 接管时不再连
Loom/OpenCode，非 dsh 时保持原双 hub 语义）。
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest

from config.config import get_config
import routers.events as events
import services.dsh_client as dc


class _FakeDsh:
    base_url = "http://dsh.test:18765"
    backend_name = "dsh"

    def __init__(self, session_id="dsh-1", main_error=None):
        self.session_id = session_id
        self.main_error = main_error
        self.started = []
        self.started_event = asyncio.Event()
        self.queues = {}

    def queue_for(self, session_id):
        return self.queues.setdefault(session_id, asyncio.Queue())

    async def get_main_session_id(self):
        if self.main_error:
            raise ConnectionError(self.main_error)
        return self.session_id

    async def stream_session_events(self, session_id):
        self.started.append(session_id)
        self.started_event.set()
        yield "retry: 3000"
        yield ""
        yield ": connected"
        queue = self.queue_for(session_id)
        while True:
            frame = await queue.get()
            if frame is None:
                return
            yield f"data: {json.dumps(frame)}"


def _frame_data(chunk):
    if not chunk.startswith("data:"):
        return None
    return json.loads(chunk.split("data:", 1)[1])


def _set_backend(value):
    cfg = get_config()
    old = cfg._data.get("ai_backend")
    cfg._data["ai_backend"] = value
    return old


@pytest.fixture(autouse=True)
def _clean_dsh_slot():
    events._hubs.pop("dsh", None)
    yield
    events._hubs.pop("dsh", None)


class TestDshHub:
    def test_single_session_stream_is_fanned_out_with_backend_label(self, monkeypatch):
        fake = _FakeDsh()
        monkeypatch.setattr(dc, "_dsh_client", fake)

        async def scenario():
            hub = events.get_event_hub("dsh")
            assert isinstance(hub, events.DshEventHub)
            assert hub._client is fake

            queue = await hub.subscribe()
            await asyncio.wait_for(fake.started_event.wait(), 2)
            assert fake.started == ["dsh-1"]
            connected = await asyncio.wait_for(queue.get(), 2)
            assert _frame_data(connected)["type"] == "proxy.connected"

            await fake.queue_for("dsh-1").put({
                "seq": 1,
                "payload": {"type": "turn/end",
                            "properties": {"turn": 1, "reason": {"kind": "completed"}}},
            })
            frame = await asyncio.wait_for(queue.get(), 2)
            data = _frame_data(frame)
            # dsh 原生事件被翻译成前端词表，并逐帧注入 sessionID/backend。
            assert data["payload"]["type"] == "session.status"
            assert data["payload"]["properties"]["status"] == {"type": "idle"}
            assert data["payload"]["properties"]["backend"] == "dsh"
            assert data["payload"]["properties"]["sessionID"] == "dsh-1"

            await fake.queue_for("dsh-1").put({
                "seq": 1.5,
                "payload": {
                    "type": "kinship/assistant-stream",
                    "properties": {
                        "session_id": "dsh-1",
                        "frame": {"type": "chunk", "turn": 1, "step": 1,
                                  "chunk": {"type": "text-delta", "index": 0, "text": "hi"}},
                    },
                },
            })
            live = _frame_data(await asyncio.wait_for(queue.get(), 2))
            assert live["payload"]["type"] == "message.part.updated"
            assert live["payload"]["properties"]["part"]["text"] == "hi"
            assert live["payload"]["properties"]["sessionID"] == "dsh-1"

            # 未映射的 dsh 事件不向前端透传。
            await fake.queue_for("dsh-1").put({
                "seq": 2,
                "payload": {"type": "request/header", "properties": {"header": {}}},
            })
            await fake.queue_for("dsh-1").put({
                "seq": 3,
                "payload": {"type": "turn/start", "properties": {"turn": 2}},
            })
            status = _frame_data(await asyncio.wait_for(queue.get(), 2))
            assert status["payload"]["type"] == "session.status"
            assert status["payload"]["properties"]["status"] == {"type": "busy"}

            await hub.unsubscribe(queue)

        asyncio.run(asyncio.wait_for(scenario(), 15))

    def test_unbound_session_raises_to_parent_backoff(self, monkeypatch):
        fake = _FakeDsh(main_error="dsh kinship 会话未绑定")
        monkeypatch.setattr(dc, "_dsh_client", fake)

        async def scenario():
            hub = events.get_event_hub("dsh")
            queue = await hub.subscribe()
            item = await asyncio.wait_for(queue.get(), 3)
            assert "proxy.disconnected" in item
            await hub.unsubscribe(queue)

        asyncio.run(asyncio.wait_for(scenario(), 15))

    def test_process_line_injects_dsh_label(self):
        line = "data: " + json.dumps({
            "payload": {"type": "session.status", "properties": {"sessionID": "s"}}
        })
        out = events._process_sse_line(line, "dsh")
        assert _frame_data(out)["payload"]["properties"]["backend"] == "dsh"


class _StubHub:
    def __init__(self, name):
        self.name = name
        self.subscribed = []
        self.unsubscribed = []

    async def subscribe(self, queue=None):
        queue = queue or asyncio.Queue()
        self.subscribed.append(queue)
        queue.put_nowait(None)
        return queue

    async def unsubscribe(self, queue):
        self.unsubscribed.append(queue)


class TestEventGeneratorChannelSelection:
    def test_dsh_backend_subscribes_only_dsh_hub(self, monkeypatch):
        old = _set_backend("dsh")
        hubs = {}

        def _hub(name):
            hubs.setdefault(name, _StubHub(name))
            return hubs[name]

        monkeypatch.setattr(events, "get_event_hub", _hub)
        try:
            async def scenario():
                chunks = [c async for c in events.event_generator()]
                assert _frame_data(chunks[0])["type"] == "proxy.connected"

            asyncio.run(asyncio.wait_for(scenario(), 10))
            assert set(hubs) == {"dsh"}
            assert hubs["dsh"].subscribed and hubs["dsh"].unsubscribed
        finally:
            _set_backend(old)

    def test_non_dsh_backend_keeps_loom_and_opencode_hubs(self, monkeypatch):
        old = _set_backend("loom")
        hubs = {}

        def _hub(name):
            hubs.setdefault(name, _StubHub(name))
            return hubs[name]

        monkeypatch.setattr(events, "get_event_hub", _hub)
        monkeypatch.setattr(events, "_opencode_enabled", lambda: True)
        try:
            async def scenario():
                [c async for c in events.event_generator()]

            asyncio.run(asyncio.wait_for(scenario(), 10))
            assert set(hubs) == {"loom", "opencode"}
        finally:
            _set_backend(old)
