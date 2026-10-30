from __future__ import annotations

import asyncio
import json
from typing import Any

from aiohttp import WSMsgType, web


class FakeNapCat:
    def __init__(self) -> None:
        self.app = web.Application()
        self.app.router.add_get("/", self._ws_handler)
        self.runner: web.AppRunner | None = None
        self.site: web.TCPSite | None = None
        self.port = 0
        self.received: list[dict[str, Any]] = []
        self.connections: list[web.WebSocketResponse] = []
        self.delay: dict[str, float] = {}
        self.fail_actions: set[str] = set()

    async def start(self) -> None:
        self.runner = web.AppRunner(self.app)
        await self.runner.setup()
        self.site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await self.site.start()
        sockets = self.site._server.sockets
        self.port = int(sockets[0].getsockname()[1])

    async def stop(self) -> None:
        for ws in list(self.connections):
            await ws.close()
        if self.runner is not None:
            await self.runner.cleanup()
        self.connections.clear()

    @property
    def url(self) -> str:
        return f"ws://127.0.0.1:{self.port}"

    async def broadcast(self, payload: dict[str, Any]) -> None:
        for ws in list(self.connections):
            await ws.send_json(payload)

    async def _ws_handler(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        self.connections.append(ws)
        async for message in ws:
            if message.type != WSMsgType.TEXT:
                continue
            payload = json.loads(message.data)
            self.received.append(payload)
            action = str(payload.get("action") or "")
            if action in self.fail_actions:
                await ws.send_json({
                    "status": "failed",
                    "retcode": 1200,
                    "data": None,
                    "message": "forced failure",
                    "echo": payload.get("echo"),
                })
                continue
            delay = self.delay.get(action, 0.0)
            if delay:
                await asyncio.sleep(delay)
            if action == "stream_test":
                for index in range(3):
                    await ws.send_json({
                        "status": "ok",
                        "retcode": 0,
                        "data": {"type": "stream", "index": index},
                        "echo": payload.get("echo"),
                        "stream": "stream-action",
                    })
                await ws.send_json({
                    "status": "ok",
                    "retcode": 0,
                    "data": {"type": "response", "ok": True},
                    "echo": payload.get("echo"),
                    "stream": "stream-action",
                })
                continue
            if action == "silent":
                continue
            await ws.send_json({
                "status": "ok",
                "retcode": 0,
                "data": {"action": action, "params": payload.get("params") or {}},
                "echo": payload.get("echo"),
            })
        if ws in self.connections:
            self.connections.remove(ws)
        return ws
