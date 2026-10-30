from __future__ import annotations

import asyncio
import tempfile
import time
from pathlib import Path

import aiohttp

from services.qq_gateway.config import MCPConfig
from services.qq_gateway.ipc import IPCServer
from services.qq_gateway.store import EventStore


class FakeActions:
    async def call(self, action: str, params: dict, mutating=None, timeout=None):
        return {"action": action, "params": params, "mutating": mutating}


class FakeMedia:
    def __init__(self) -> None:
        self.calls: list[tuple[dict, int, str, object]] = []

    async def fetch(self, segment, index, message_id, call_action=None):
        self.calls.append((segment, index, message_id, call_action))
        return "/tmp/qq_media/" + str(message_id) + "_" + str(index) + ".png"


class FakeQZone:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    async def list_feeds(self, target_qq, limit):
        self.calls.append(("list_feeds", {"target_qq": target_qq, "limit": limit}))
        return {"feeds": [{"tid": "feed-1"}]}

    async def get_comments(self, target_qq, tid, scan):
        self.calls.append(
            ("get_comments", {"target_qq": target_qq, "tid": tid, "scan": scan})
        )
        return {"comments": [{"tid": "comment-1", "content": "hello"}]}

    async def comment(self, target_qq, tid, content):
        self.calls.append(
            ("comment", {"target_qq": target_qq, "tid": tid, "content": content})
        )
        return {"comment_id": "new-comment"}

    async def reply(self, target_qq, tid, comment_id, content,
                    comment_uin=None, comment_nick=None):
        self.calls.append((
            "reply",
            {
                "target_qq": target_qq,
                "tid": tid,
                "comment_id": comment_id,
                "content": content,
                "comment_uin": comment_uin,
                "comment_nick": comment_nick,
            },
        ))
        return {"comment_id": "new-reply"}

    async def delete_comment(self, target_qq, tid, comment_id, comment_uin=None):
        self.calls.append((
            "delete_comment",
            {
                "target_qq": target_qq,
                "tid": tid,
                "comment_id": comment_id,
                "comment_uin": comment_uin,
            },
        ))
        return {"deleted": comment_id}

    async def like(self, target_qq, tid):
        self.calls.append(("like", {"target_qq": target_qq, "tid": tid}))
        return {"liked": True}


class QZoneUpstreamError(Exception):
    def __init__(self, message: str, action: str, retcode: int) -> None:
        super().__init__(message)
        self.action = action
        self.retcode = retcode


class FailingQZone(FakeQZone):
    async def comment(self, target_qq, tid, content):
        raise QZoneUpstreamError("upstream rejected", "qzone_comment", 1403)

    async def like(self, target_qq, tid):
        raise RuntimeError("plain failure")

    async def delete_comment(self, target_qq, tid, comment_id, comment_uin=None):
        raise RuntimeError("delete failure")


def test_ipc_auth_and_action() -> None:
    async def scenario() -> None:
        server = IPCServer(
            MCPConfig(enabled=True, host="127.0.0.1", port=0, token="secret"),
            FakeActions(),
            lambda: {"connected": True},
        )
        await server.start()
        base = f"http://127.0.0.1:{server.port}"
        async with aiohttp.ClientSession() as session:
            unauthorized = await session.get(base + "/v1/health")
            assert unauthorized.status == 401
            headers = {"Authorization": "Bearer secret"}
            health = await session.get(base + "/v1/health", headers=headers)
            assert health.status == 200
            action = await session.post(
                base + "/v1/actions/get_login_info",
                headers=headers,
                json={"params": {"x": 1}},
            )
            payload = await action.json()
            assert payload["ok"] is True
            assert payload["data"]["action"] == "get_login_info"
        await server.stop()

    asyncio.run(scenario())


def test_ipc_qzone_routes() -> None:
    async def scenario() -> None:
        qzone = FakeQZone()
        server = IPCServer(
            MCPConfig(enabled=True, host="127.0.0.1", port=0, token="secret"),
            FakeActions(),
            lambda: {"connected": True},
            qzone=qzone,
        )
        await server.start()
        base = f"http://127.0.0.1:{server.port}"
        headers = {"Authorization": "Bearer secret"}
        try:
            async with aiohttp.ClientSession() as session:
                unauthorized = [
                    await session.get(base + "/v1/qzone/feeds"),
                    await session.get(base + "/v1/qzone/comments"),
                    await session.post(base + "/v1/qzone/comment", json={}),
                    await session.post(base + "/v1/qzone/reply", json={}),
                    await session.post(base + "/v1/qzone/delete_comment", json={}),
                    await session.post(base + "/v1/qzone/like", json={}),
                ]
                assert [response.status for response in unauthorized] == [401] * 6

                feeds = await session.get(
                    base + "/v1/qzone/feeds",
                    headers=headers,
                    params={"target_qq": "123", "limit": "5"},
                )
                assert await feeds.json() == {
                    "ok": True,
                    "data": {"feeds": [{"tid": "feed-1"}]},
                }

                comments = await session.get(
                    base + "/v1/qzone/comments",
                    headers=headers,
                    params={"target_qq": "123", "tid": "feed-1", "scan": "3"},
                )
                assert await comments.json() == {
                    "ok": True,
                    "data": {"comments": [{"tid": "comment-1", "content": "hello"}]},
                }

                comment = await session.post(
                    base + "/v1/qzone/comment",
                    headers=headers,
                    json={"target_qq": "123", "tid": "feed-1", "content": "hi"},
                )
                assert await comment.json() == {
                    "ok": True,
                    "data": {"comment_id": "new-comment"},
                }

                reply = await session.post(
                    base + "/v1/qzone/reply",
                    headers=headers,
                    json={
                        "target_qq": "123",
                        "tid": "feed-1",
                        "comment_id": "comment-1",
                        "content": "reply text",
                        "comment_uin": "456",
                        "comment_nick": "nick",
                    },
                )
                assert await reply.json() == {
                    "ok": True,
                    "data": {"comment_id": "new-reply"},
                }

                delete = await session.post(
                    base + "/v1/qzone/delete_comment",
                    headers=headers,
                    json={
                        "target_qq": "123",
                        "tid": "feed-1",
                        "comment_id": "comment-1",
                        "comment_uin": "456",
                    },
                )
                assert await delete.json() == {
                    "ok": True,
                    "data": {"deleted": "comment-1"},
                }

                like = await session.post(
                    base + "/v1/qzone/like",
                    headers=headers,
                    json={"target_qq": "123", "tid": "feed-1"},
                )
                assert await like.json() == {"ok": True, "data": {"liked": True}}

                assert qzone.calls == [
                    ("list_feeds", {"target_qq": "123", "limit": 5}),
                    ("get_comments", {"target_qq": "123", "tid": "feed-1", "scan": 3}),
                    ("comment", {"target_qq": "123", "tid": "feed-1", "content": "hi"}),
                    (
                        "reply",
                        {
                            "target_qq": "123",
                            "tid": "feed-1",
                            "comment_id": "comment-1",
                            "content": "reply text",
                            "comment_uin": "456",
                            "comment_nick": "nick",
                        },
                    ),
                    (
                        "delete_comment",
                        {
                            "target_qq": "123",
                            "tid": "feed-1",
                            "comment_id": "comment-1",
                            "comment_uin": "456",
                        },
                    ),
                    ("like", {"target_qq": "123", "tid": "feed-1"}),
                ]
        finally:
            await server.stop()

    asyncio.run(scenario())


def test_ipc_qzone_error_envelope() -> None:
    async def scenario() -> None:
        server = IPCServer(
            MCPConfig(enabled=True, host="127.0.0.1", port=0, token="secret"),
            FakeActions(),
            lambda: {"connected": True},
            qzone=FailingQZone(),
        )
        await server.start()
        base = f"http://127.0.0.1:{server.port}"
        headers = {"Authorization": "Bearer secret"}
        try:
            async with aiohttp.ClientSession() as session:
                comment = await session.post(
                    base + "/v1/qzone/comment",
                    headers=headers,
                    json={"target_qq": "123", "tid": "feed-1", "content": "hi"},
                )
                assert await comment.json() == {
                    "ok": False,
                    "error": {
                        "code": "qzone_comment",
                        "message": "upstream rejected",
                        "retcode": 1403,
                    },
                }

                like = await session.post(
                    base + "/v1/qzone/like",
                    headers=headers,
                    json={"target_qq": "123", "tid": "feed-1"},
                )
                assert await like.json() == {
                    "ok": False,
                    "error": {
                        "code": "qzone_like",
                        "message": "plain failure",
                        "retcode": -1,
                    },
                }

                delete = await session.post(
                    base + "/v1/qzone/delete_comment",
                    headers=headers,
                    json={
                        "target_qq": "123",
                        "tid": "feed-1",
                        "comment_id": "comment-1",
                    },
                )
                assert await delete.json() == {
                    "ok": False,
                    "error": {
                        "code": "qzone_delete_comment",
                        "message": "delete failure",
                        "retcode": -1,
                    },
                }
        finally:
            await server.stop()

    asyncio.run(scenario())


def test_ipc_water_state_routes() -> None:
    async def scenario() -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = EventStore(str(Path(tmp) / "events.db"))
            server = IPCServer(
                MCPConfig(enabled=True, host="127.0.0.1", port=0, token="secret"),
                FakeActions(),
                lambda: {"connected": True},
                store=store,
            )
            await server.start()
            base = f"http://127.0.0.1:{server.port}"
            headers = {"Authorization": "Bearer secret"}
            try:
                async with aiohttp.ClientSession() as session:
                    missing = await session.get(
                        base + "/v1/water-state",
                        headers=headers,
                        params={"group_id": "g1"},
                    )
                    assert await missing.json() == {
                        "ok": True,
                        "data": {
                            "group_id": "g1",
                            "mode": "mentions",
                            "threshold": 12,
                            "water_until": 0,
                            "last_wake_at": 0,
                            "updated_at": 0,
                        },
                    }

                    written = await session.post(
                        base + "/v1/water-state",
                        headers=headers,
                        json={"group_id": "g1", "mode": "water", "threshold": 8},
                    )
                    assert written.status == 200
                    written_payload = await written.json()
                    assert written_payload["ok"] is True
                    assert written_payload["data"]["group_id"] == "g1"
                    assert written_payload["data"]["mode"] == "water"
                    assert written_payload["data"]["threshold"] == 8
                    assert written_payload["data"]["water_until"] == 0
                    assert written_payload["data"]["last_wake_at"] == 0
                    assert written_payload["data"]["updated_at"] > 0

                    current = await session.get(
                        base + "/v1/water-state",
                        headers=headers,
                        params={"group_id": "g1"},
                    )
                    assert await current.json() == written_payload

                    listed = await session.get(base + "/v1/water-state", headers=headers)
                    assert listed.status == 200
                    listed_payload = await listed.json()
                    assert listed_payload["ok"] is True
                    assert listed_payload["data"] == [written_payload["data"]]

                    for body in (
                        {"group_id": "g1", "mode": "loud"},
                        {"group_id": "g1", "threshold": 101},
                        {"group_id": "g1", "threshold": -1},
                        {"group_id": "g1", "water_until": -5},
                        {"group_id": ""},
                    ):
                        invalid = await session.post(
                            base + "/v1/water-state",
                            headers=headers,
                            json=body,
                        )
                        assert invalid.status == 400
                        invalid_payload = await invalid.json()
                        assert invalid_payload["ok"] is False
                        assert invalid_payload["error"]["retcode"] == 1400
                        assert invalid_payload["error"]["message"]
            finally:
                await server.stop()
                store.close()

    asyncio.run(scenario())


def test_ipc_read_state_routes() -> None:
    async def scenario() -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = EventStore(str(Path(tmp) / "events.db"))
            server = IPCServer(
                MCPConfig(enabled=True, host="127.0.0.1", port=0, token="secret"),
                FakeActions(),
                lambda: {"connected": True},
                store=store,
            )
            await server.start()
            base = f"http://127.0.0.1:{server.port}"
            headers = {"Authorization": "Bearer secret"}
            try:
                async with aiohttp.ClientSession() as session:
                    unauthorized = await session.get(
                        base + "/v1/read-state",
                        params={"chat_type": "group", "target": "10003"},
                    )
                    assert unauthorized.status == 401

                    missing = await session.get(
                        base + "/v1/read-state",
                        headers=headers,
                        params={"chat_type": "group", "target": "10003"},
                    )
                    assert await missing.json() == {
                        "ok": True,
                        "data": {
                            "chat_type": "group",
                            "target": "10003",
                            "last_time": 0,
                            "last_message_id": "",
                        },
                    }

                    written = await session.post(
                        base + "/v1/read-state",
                        headers=headers,
                        json={
                            "chat_type": "group",
                            "target": "10003",
                            "last_time": 1700000000,
                            "last_message_id": "42",
                        },
                    )
                    assert written.status == 200
                    assert await written.json() == {
                        "ok": True,
                        "data": {
                            "chat_type": "group",
                            "target": "10003",
                            "last_time": 1700000000,
                            "last_message_id": "42",
                        },
                    }

                    current = await session.get(
                        base + "/v1/read-state",
                        headers=headers,
                        params={"chat_type": "group", "target": "10003"},
                    )
                    assert await current.json() == {
                        "ok": True,
                        "data": {
                            "chat_type": "group",
                            "target": "10003",
                            "last_time": 1700000000,
                            "last_message_id": "42",
                        },
                    }

                    invalid = await session.post(
                        base + "/v1/read-state",
                        headers=headers,
                        json={"chat_type": "private", "target": "10003"},
                    )
                    assert invalid.status == 400
                    payload = await invalid.json()
                    assert payload["ok"] is False
                    assert payload["error"]["retcode"] == 1400
            finally:
                await server.stop()
                store.close()

    asyncio.run(scenario())


def test_ipc_media_route() -> None:
    async def scenario() -> None:
        media = FakeMedia()
        server = IPCServer(
            MCPConfig(enabled=True, host="127.0.0.1", port=0, token="secret"),
            FakeActions(),
            lambda: {"connected": True},
            media=media,
        )
        await server.start()
        base = f"http://127.0.0.1:{server.port}"
        headers = {"Authorization": "Bearer secret"}
        try:
            async with aiohttp.ClientSession() as session:
                unauthorized = await session.post(
                    base + "/v1/media",
                    json={"segment": {}, "index": 0, "message_id": "1001"},
                )
                assert unauthorized.status == 401

                fetched = await session.post(
                    base + "/v1/media",
                    headers=headers,
                    json={
                        "segment": {"type": "image", "data": {"file_id": "f1"}},
                        "index": 1,
                        "message_id": "1001",
                    },
                )
                assert fetched.status == 200
                assert await fetched.json() == {
                    "ok": True,
                    "data": {"path": "/tmp/qq_media/1001_1.png"},
                }
                assert media.calls[0][0] == {
                    "type": "image",
                    "data": {"file_id": "f1"},
                }
                assert media.calls[0][1] == 1
                assert media.calls[0][2] == "1001"

                invalid_bodies = [
                    {"segment": "image", "message_id": "1001"},
                    {"segment": {}, "index": -1, "message_id": "1001"},
                    {"segment": {}, "index": True, "message_id": "1001"},
                    {"segment": {}, "index": 0, "message_id": ""},
                ]
                for body in invalid_bodies:
                    invalid = await session.post(
                        base + "/v1/media", headers=headers, json=body
                    )
                    assert invalid.status == 400
                    payload = await invalid.json()
                    assert payload["ok"] is False
                    assert payload["error"]["retcode"] == 1400

                bad_json = await session.post(
                    base + "/v1/media",
                    headers={**headers, "Content-Type": "application/json"},
                    data="not-json",
                )
                assert bad_json.status == 400
                assert await bad_json.json() == {
                    "ok": False,
                    "error": {"message": "invalid json body", "retcode": 1400},
                }
        finally:
            await server.stop()

    asyncio.run(scenario())
