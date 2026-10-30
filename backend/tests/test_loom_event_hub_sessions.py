# -*- coding: utf-8 -*-
"""T6: LoomEventHub 会话来源收敛（主会话 + loom: 绑定 + session.children 帧）。

列表面 GET /sessions 已废弃（T4 删除 list_session_ids），本文件钉死新契约：
  (a) session.children 帧（children[].id 真源，sessionID 防御别名）唤醒子会话读者，
      子会话帧照常广播；任意父会话（含嵌套）的 children 帧都生效；
  (b) 非法/重复 id 不建读者；
  (c) hub 绝不调用已废弃的会话列表发现（桩上 list_session_ids 计数恒 0）；
  (d) 主会话断流由读者退避自愈，不拖垮 hub；
  (e) 起连补种只取 queued/admitted/running 且上限 32；
  (f) resolver 主会话切换后 5s 内为新主会话起读者。

零触网：loom 客户端与 session manager 均为内存桩。本 venv 无 pytest-asyncio，
统一以 asyncio.run 同步驱动（既有测试先例）。
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest

import routers.events as events
import services.loom_main_session as lms


class _FakeSessionManager:
    """内存绑定表（resolver 读写 loom:main-task；hub 轮询读全部 loom: 键）。"""

    def __init__(self, bindings=None):
        self.bindings = dict(bindings or {})
        self.fail_list = False

    def get_agent_session(self, key):
        return self.bindings.get(key)

    def set_agent_session(self, key, session_id):
        self.bindings[key] = session_id

    def list_agent_sessions(self):
        if self.fail_list:
            raise RuntimeError("bindings unreadable")
        return dict(self.bindings)


class _FakeLoom:
    """可编程 loom 上游桩：主会话权威、children 补种、逐会话帧队列、可注入持续失败。"""

    base_url = "http://loom.test:5100"

    def __init__(self, main="s1"):
        self.main = main
        self.main_error = None
        self.main_raises = False
        self.children_rows = []
        self.children_error = None
        self.queues = {}
        self.started = []
        self.attempts = {}
        self.fail_streams = set()
        self.list_session_ids_calls = 0

    def queue_for(self, sid):
        return self.queues.setdefault(sid, asyncio.Queue())

    async def get_main_session(self):
        if self.main_raises:
            raise ConnectionError("main wire down")
        if self.main_error:
            return {"ok": False, "data": None,
                    "error": {"source": "loom", "detail": self.main_error, "code": 500}}
        return {"ok": True, "error": None,
                "data": {"sessionID": self.main, "status": "idle"}}

    async def list_session_ids(self):
        self.list_session_ids_calls += 1
        raise AssertionError("LoomEventHub 不得调用已废弃的 GET /sessions 发现")

    async def get_session_children(self, session_id):
        if self.children_error:
            raise ConnectionError(self.children_error)
        return {"ok": True, "error": None,
                "data": {"children": list(self.children_rows)}}

    async def stream_session_events(self, session_id):
        self.started.append(session_id)
        self.attempts[session_id] = self.attempts.get(session_id, 0) + 1
        if session_id in self.fail_streams:
            raise ConnectionError("stream down")
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


def _children_frame(children, parent="ses_parent"):
    """真实观测形状：properties.children[].{id,name,type,status}。"""
    return {"payload": {"type": "session.children", "properties": {
        "sessionID": parent, "children": children,
    }}}


def _data(chunk):
    return json.loads(chunk.split("data:", 1)[1])


async def _next_frame_from(queue, session_id, timeout=2.0):
    """跳过控制帧/父帧，取下一条 sessionID 匹配的帧（有界等待）。"""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        chunk = await asyncio.wait_for(queue.get(), timeout)
        data = _data(chunk)
        properties = (data.get("payload") or {}).get("properties") or {}
        if properties.get("sessionID") == session_id:
            return chunk
    raise AssertionError(f"未收到 session={session_id} 的帧")


@pytest.fixture(autouse=True)
def _isolate_sources(monkeypatch):
    lms.reset_loom_main_cache()
    manager = _FakeSessionManager()
    monkeypatch.setattr(events, "get_session_manager", lambda: manager)
    monkeypatch.setattr(events, "LOOM_SESSION_REFRESH_INTERVAL", 0.05)
    monkeypatch.setattr(events, "LOOM_READER_INITIAL_BACKOFF", 0.01)
    monkeypatch.setattr(events, "LOOM_READER_MAX_BACKOFF", 0.01)
    yield manager
    lms.reset_loom_main_cache()


class TestChildDiscovery:
    def test_children_frame_spawns_readers_and_broadcasts_child_frames(self):
        fake = _FakeLoom()
        hub = events.LoomEventHub(fake)

        async def scenario():
            queue = await hub.subscribe()
            await _wait_until(lambda: "s1" in fake.started)
            await asyncio.wait_for(queue.get(), 2)  # proxy.connected

            await fake.queue_for("s1").put(_children_frame([
                {"id": "ses_child1", "name": "reviewer", "type": "reviewer", "status": "running"},
                {"sessionID": "ses_child2"},
            ]))
            await _wait_until(
                lambda: "ses_child1" in fake.started and "ses_child2" in fake.started
            )

            frame = await asyncio.wait_for(queue.get(), 2)
            assert _data(frame)["payload"]["type"] == "session.children"

            await fake.queue_for("ses_child1").put(
                {"payload": {"type": "session.status",
                             "properties": {"sessionID": "ses_child1"}}}
            )
            child = await asyncio.wait_for(queue.get(), 2)
            assert _data(child)["payload"]["properties"]["sessionID"] == "ses_child1"
            assert _data(child)["payload"]["properties"]["backend"] == "loom"

            # 嵌套：父会话不是主会话也生效
            await fake.queue_for("ses_child1").put(_children_frame(
                [{"id": "ses_grand"}], parent="ses_child1"
            ))
            await _wait_until(lambda: "ses_grand" in fake.started)

            await hub.unsubscribe(queue)

        asyncio.run(asyncio.wait_for(scenario(), 15))

    def test_invalid_and_duplicate_child_ids_ignored(self):
        fake = _FakeLoom()
        hub = events.LoomEventHub(fake)

        async def scenario():
            queue = await hub.subscribe()
            await _wait_until(lambda: "s1" in fake.started)
            await asyncio.wait_for(queue.get(), 2)

            await fake.queue_for("s1").put(_children_frame([
                {"id": "bad-id"},
                {"id": "has space"},
                {"id": ""},
                {"id": 123},
                {"id": "../evil"},
                {"foo": "bar"},
                "not-a-dict",
                {"sessionID": "alias_ok"},
                {"id": "dup_ok"},
                {"id": "dup_ok"},
            ]))
            await _wait_until(
                lambda: "alias_ok" in fake.started and "dup_ok" in fake.started
            )
            await asyncio.sleep(0.1)

            spawned = set(fake.started)
            assert spawned == {"s1", "alias_ok", "dup_ok"}
            assert set(hub._readers) == spawned
            await hub.unsubscribe(queue)

        asyncio.run(asyncio.wait_for(scenario(), 15))

    def test_hub_never_calls_deprecated_session_list(self):
        fake = _FakeLoom()
        hub = events.LoomEventHub(fake)

        async def scenario():
            queue = await hub.subscribe()
            await _wait_until(lambda: "s1" in fake.started)
            await fake.queue_for("s1").put(_children_frame([{"id": "ses_c"}]))
            await _wait_until(lambda: "ses_c" in fake.started)
            await asyncio.sleep(0.1)
            assert fake.list_session_ids_calls == 0
            await hub.unsubscribe(queue)

        asyncio.run(asyncio.wait_for(scenario(), 15))


class TestReaderLifecycle:
    def test_main_stream_end_reconnects_and_keeps_broadcasting(self):
        fake = _FakeLoom()
        hub = events.LoomEventHub(fake)

        async def scenario():
            queue = await hub.subscribe()
            await _wait_until(lambda: "s1" in fake.started)
            await asyncio.wait_for(queue.get(), 2)

            await fake.queue_for("s1").put(None)  # 流自然结束
            await _wait_until(lambda: fake.attempts.get("s1", 0) >= 2)

            await fake.queue_for("s1").put(
                {"payload": {"type": "session.idle", "properties": {"sessionID": "s1"}}}
            )
            frame = await asyncio.wait_for(queue.get(), 2)
            assert _data(frame)["payload"]["type"] == "session.idle"
            assert not hub._task.done()
            await hub.unsubscribe(queue)

        asyncio.run(asyncio.wait_for(scenario(), 15))

    def test_child_reader_retires_after_ten_failures_and_frame_revives(self):
        fake = _FakeLoom()
        fake.fail_streams.add("ses_bad")
        hub = events.LoomEventHub(fake)

        async def scenario():
            queue = await hub.subscribe()
            await _wait_until(lambda: "s1" in fake.started)
            await asyncio.wait_for(queue.get(), 2)

            await fake.queue_for("s1").put(_children_frame([{"id": "ses_bad"}]))
            await _wait_until(lambda: fake.attempts.get("ses_bad", 0) >= 10)
            await _wait_until(lambda: "ses_bad" not in hub._readers)

            fake.fail_streams.discard("ses_bad")
            await fake.queue_for("s1").put(_children_frame([{"id": "ses_bad"}]))
            await _wait_until(lambda: fake.attempts.get("ses_bad", 0) >= 11)
            await _wait_until(lambda: "ses_bad" in hub._readers)

            await fake.queue_for("ses_bad").put(
                {"payload": {"type": "session.idle",
                             "properties": {"sessionID": "ses_bad"}}}
            )
            frame = await _next_frame_from(queue, "ses_bad")
            assert _data(frame)["payload"]["properties"]["sessionID"] == "ses_bad"
            await hub.unsubscribe(queue)

        asyncio.run(asyncio.wait_for(scenario(), 15))


class TestSessionSources:
    def test_seed_only_active_statuses_capped_at_32(self):
        statuses = ["queued", "admitted", "running", "done"]
        fake = _FakeLoom()
        fake.children_rows = [
            {"id": f"ses_active_{i}", "status": statuses[i % len(statuses)]}
            for i in range(80)
        ]
        hub = events.LoomEventHub(fake)

        async def scenario():
            queue = await hub.subscribe()
            await _wait_until(lambda: len(fake.started) >= 33)  # 1 主 + 32 子
            await asyncio.wait_for(queue.get(), 2)

            seeded = {sid for sid in fake.started if sid.startswith("ses_active_")}
            assert len(seeded) == events.LOOM_CHILD_SEED_LIMIT
            assert all(
                row["status"] in events.LOOM_ACTIVE_TASK_STATUSES
                for row in fake.children_rows if row["id"] in seeded
            )
            await hub.unsubscribe(queue)

        asyncio.run(asyncio.wait_for(scenario(), 15))

    def test_seed_failure_is_ignored_and_hub_still_connects(self):
        fake = _FakeLoom()
        fake.children_error = "tasks endpoint down"
        hub = events.LoomEventHub(fake)

        async def scenario():
            queue = await hub.subscribe()
            await _wait_until(lambda: "s1" in fake.started)
            first = await asyncio.wait_for(queue.get(), 2)
            assert _data(first)["type"] == "proxy.connected"
            await hub.unsubscribe(queue)

        asyncio.run(asyncio.wait_for(scenario(), 15))

    def test_binding_keys_spawn_readers_except_resolver_owned_main_key(self):
        fake = _FakeLoom()
        hub = events.LoomEventHub(fake)

        async def scenario():
            queue = await hub.subscribe()
            await _wait_until(lambda: "s1" in fake.started)
            await asyncio.wait_for(queue.get(), 2)

            manager = events.get_session_manager()
            manager.bindings.update({
                "loom:main-task": "s1",
                "loom:reviewer": "ses_r",
                "opencode:reviewer": "ses_oc",
            })
            await _wait_until(lambda: "ses_r" in fake.started)
            await asyncio.sleep(0.1)
            assert "ses_oc" not in fake.started
            assert "s1" not in fake.started[1:]  # 主键不重复起读者
            await hub.unsubscribe(queue)

        asyncio.run(asyncio.wait_for(scenario(), 15))

    def test_transient_discovery_failure_keeps_readers_and_no_sentinel(self):
        fake = _FakeLoom()
        hub = events.LoomEventHub(fake)

        async def scenario():
            queue = await hub.subscribe()
            await _wait_until(lambda: "s1" in fake.started)
            await asyncio.wait_for(queue.get(), 2)

            manager = events.get_session_manager()
            manager.fail_list = True
            fake.main_raises = True
            lms.invalidate_loom_main_cache()
            await asyncio.sleep(0.2)  # 数轮发现均失败

            with pytest.raises(asyncio.TimeoutError):
                await asyncio.wait_for(queue.get(), 0.1)  # 无 disconnected 哨兵

            await fake.queue_for("s1").put(
                {"payload": {"type": "session.idle", "properties": {"sessionID": "s1"}}}
            )
            frame = await asyncio.wait_for(queue.get(), 2)
            assert _data(frame)["payload"]["type"] == "session.idle"
            assert "s1" in hub._readers
            await hub.unsubscribe(queue)

        asyncio.run(asyncio.wait_for(scenario(), 15))

    def test_main_switch_spawns_reader_for_new_main(self):
        fake = _FakeLoom()
        hub = events.LoomEventHub(fake)

        async def scenario():
            queue = await hub.subscribe()
            await _wait_until(lambda: "s1" in fake.started)
            await asyncio.wait_for(queue.get(), 2)

            fake.main = "ses_new_main"
            lms.invalidate_loom_main_cache()
            await _wait_until(lambda: "ses_new_main" in fake.started)
            assert hub._main_session_id == "ses_new_main"
            await hub.unsubscribe(queue)

        asyncio.run(asyncio.wait_for(scenario(), 15))
