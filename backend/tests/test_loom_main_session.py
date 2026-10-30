# -*- coding: utf-8 -*-
"""T5: Loom 主会话解析器单元契约。

锁死语义:
  - GET /sessions/main 是唯一权威；200 覆盖陈旧 loom:main-task 绑定；
  - 404 仅在 allow_create=True 时创建一次并持久化；
  - 503/传输故障降级复用既有绑定，绝不创建；
  - 60s TTL 缓存（base_url 分键）+ asyncio.Lock 防并发重复创建；
  - 裸 main-task 键（语音/QQ）零触碰。
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest

import services.loom_main_session as lms
from services.stt_session_manager import STTSessionManager

BARE_KEY = "main-task"
LOOM_KEY = "loom:main-task"
TEST_MAIN = "ses_test_main"
TEST_STALE = "ses_test_stale"
TEST_CREATED = "ses_test_created"


class _FakeClient:
    """Resolver 所需最小客户端面的可编程桩。"""

    def __init__(self, base_url="http://loom.test:5100", main_id=None,
                 main_error=None, main_raises=None,
                 create_id=TEST_CREATED, create_raises=False):
        self.base_url = base_url
        self._main_id = main_id
        self._main_error = main_error
        self._main_raises = main_raises
        self._create_id = create_id
        self._create_raises = create_raises
        self.get_main_calls = 0
        self.create_calls = 0
        self.create_titles = []

    async def get_main_session(self):
        self.get_main_calls += 1
        await asyncio.sleep(0)
        if self._main_raises:
            raise ConnectionError(self._main_raises)
        if self._main_id:
            return {"ok": True, "error": None,
                    "data": {"sessionID": self._main_id, "status": "idle"}}
        return {"ok": False, "data": None,
                "error": {"source": "loom",
                          "detail": self._main_error or "HTTP 404: no main",
                          "code": 404}}

    async def create_session(self, title=None, directory=None):
        self.create_calls += 1
        self.create_titles.append(title)
        await asyncio.sleep(0)
        if self._create_raises:
            raise ConnectionError("create wire down")
        return {"ok": True, "error": None,
                "data": {"session_id": self._create_id, "title": title}}


@pytest.fixture(autouse=True)
def _reset_cache():
    lms.reset_loom_main_cache()
    yield
    lms.reset_loom_main_cache()


@pytest.fixture
def manager(tmp_path):
    return STTSessionManager(storage_path=str(tmp_path / "usersessions.json"))


def _run(coro):
    return asyncio.run(coro)


def test_main_200_overwrites_stale_binding_and_keeps_bare_key(manager):
    manager.set_agent_session(LOOM_KEY, TEST_STALE)
    manager.set_agent_session(BARE_KEY, "ses_voice")
    client = _FakeClient(main_id=TEST_MAIN)

    res = _run(lms.resolve_loom_main_session(client, manager, allow_create=False))

    assert (res.session_id, res.source, res.error) == (TEST_MAIN, "loom-main", None)
    assert manager.get_agent_session(LOOM_KEY) == TEST_MAIN
    assert manager.get_agent_session(BARE_KEY) == "ses_voice"
    assert client.create_calls == 0


def test_main_404_with_allow_create_creates_once_and_persists(manager):
    manager.set_agent_session(BARE_KEY, "ses_voice")
    client = _FakeClient(main_id=None)

    res = _run(lms.resolve_loom_main_session(client, manager, allow_create=True))

    assert (res.session_id, res.source, res.error) == (TEST_CREATED, "created", None)
    assert client.create_calls == 1
    assert client.create_titles == ["主会话"]
    assert manager.get_agent_session(LOOM_KEY) == TEST_CREATED
    assert manager.get_agent_session(BARE_KEY) == "ses_voice"


def test_main_404_without_allow_create_errors_without_create(manager):
    client = _FakeClient(main_id=None)

    res = _run(lms.resolve_loom_main_session(client, manager, allow_create=False))

    assert res.session_id is None and res.source is None
    assert "HTTP 404" in res.error
    assert client.create_calls == 0
    assert manager.get_agent_session(LOOM_KEY) is None


def test_main_503_uses_existing_binding_without_create(manager):
    manager.set_agent_session(LOOM_KEY, TEST_STALE)
    client = _FakeClient(main_error="HTTP 503: loom down")

    res = _run(lms.resolve_loom_main_session(client, manager, allow_create=True))

    assert (res.session_id, res.source, res.error) == (TEST_STALE, "binding", None)
    assert client.create_calls == 0
    assert manager.get_agent_session(LOOM_KEY) == TEST_STALE


def test_main_503_without_binding_errors(manager):
    client = _FakeClient(main_error="HTTP 503: loom down")

    res = _run(lms.resolve_loom_main_session(client, manager, allow_create=True))

    assert res.session_id is None and res.source is None
    assert "HTTP 503" in res.error
    assert client.create_calls == 0


def test_transport_failure_uses_existing_binding_without_create(manager):
    manager.set_agent_session(LOOM_KEY, TEST_STALE)
    client = _FakeClient(main_raises="wire down")

    res = _run(lms.resolve_loom_main_session(client, manager, allow_create=True))

    assert (res.session_id, res.source, res.error) == (TEST_STALE, "binding", None)
    assert client.create_calls == 0


def test_concurrent_404_creates_at_most_one_session(manager):
    client = _FakeClient(main_id=None)

    async def _race():
        return await asyncio.gather(*[
            lms.resolve_loom_main_session(client, manager, allow_create=True)
            for _ in range(5)
        ])

    results = asyncio.run(_race())

    assert client.create_calls == 1
    assert {r.session_id for r in results} == {TEST_CREATED}
    assert manager.get_agent_session(LOOM_KEY) == TEST_CREATED


def test_cache_ttl_expires_and_requests_main_again(manager, monkeypatch):
    clock = {"t": 1000.0}
    monkeypatch.setattr(lms, "_now", lambda: clock["t"])
    client = _FakeClient(main_id=TEST_MAIN)

    first = _run(lms.resolve_loom_main_session(client, manager, allow_create=False))
    second = _run(lms.resolve_loom_main_session(client, manager, allow_create=False))
    assert first.session_id == second.session_id == TEST_MAIN
    assert client.get_main_calls == 1

    clock["t"] += lms.CACHE_TTL_SECONDS
    third = _run(lms.resolve_loom_main_session(client, manager, allow_create=False))
    assert third.session_id == TEST_MAIN
    assert client.get_main_calls == 2


def test_invalidate_cache_forces_refresh(manager, monkeypatch):
    clock = {"t": 1000.0}
    monkeypatch.setattr(lms, "_now", lambda: clock["t"])
    client = _FakeClient(main_id=TEST_MAIN)

    _run(lms.resolve_loom_main_session(client, manager, allow_create=False))
    lms.invalidate_loom_main_cache()
    _run(lms.resolve_loom_main_session(client, manager, allow_create=False))
    assert client.get_main_calls == 2

    lms.invalidate_loom_main_cache(client.base_url)
    _run(lms.resolve_loom_main_session(client, manager, allow_create=False))
    assert client.get_main_calls == 3


def test_cache_is_keyed_by_base_url(manager, monkeypatch):
    clock = {"t": 1000.0}
    monkeypatch.setattr(lms, "_now", lambda: clock["t"])
    client_a = _FakeClient(base_url="http://loom-a.test:5100", main_id="ses_a")
    client_b = _FakeClient(base_url="http://loom-b.test:5100", main_id="ses_b")

    assert _run(lms.resolve_loom_main_session(
        client_a, manager, allow_create=False)).session_id == "ses_a"
    assert _run(lms.resolve_loom_main_session(
        client_b, manager, allow_create=False)).session_id == "ses_b"
    assert client_a.get_main_calls == 1 and client_b.get_main_calls == 1
    assert manager.get_agent_session(LOOM_KEY) == "ses_b"
