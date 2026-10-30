from __future__ import annotations

import hmac
import json
import logging
from typing import Any, Awaitable, Callable, Optional

from aiohttp import web

from .config import MCPConfig
from .store import WATER_MODES, default_water_state

HealthFn = Callable[[], dict[str, Any]]


class IPCServer:
    def __init__(self, config: MCPConfig, actions: Any, health: HealthFn,
                 stickers: Any = None, logger: Optional[logging.Logger] = None,
                 qzone: Any = None, store: Any = None, media: Any = None) -> None:
        self.config = config
        self.actions = actions
        self.health = health
        self.stickers = stickers
        self.qzone = qzone
        self.store = store
        self.media = media
        self.log = logger or logging.getLogger(__name__)
        self._runner: Optional[web.AppRunner] = None
        self._site: Optional[web.TCPSite] = None
        self.port = config.port

    async def start(self) -> None:
        if not self.config.enabled:
            return
        if not self.config.token:
            raise ValueError("qq_gateway.mcp enabled but token is empty")
        app = web.Application(middlewares=[self._auth])
        app.router.add_get("/v1/health", self._handle_health)
        app.router.add_post("/v1/actions/{action}", self._handle_action)
        if self.stickers is not None:
            app.router.add_get("/v1/stickers", self._handle_stickers_list)
            app.router.add_post("/v1/stickers/send", self._handle_sticker_send)
            app.router.add_post("/v1/stickers/save", self._handle_sticker_save)
            app.router.add_post("/v1/stickers/update", self._handle_sticker_update)
            app.router.add_post("/v1/stickers/delete", self._handle_sticker_delete)
        if self.qzone is not None:
            app.router.add_get("/v1/qzone/feeds", self._handle_qzone_feeds)
            app.router.add_get("/v1/qzone/comments", self._handle_qzone_comments)
            app.router.add_post("/v1/qzone/comment", self._handle_qzone_comment)
            app.router.add_post("/v1/qzone/reply", self._handle_qzone_reply)
            app.router.add_post("/v1/qzone/delete_comment", self._handle_qzone_delete_comment)
            app.router.add_post("/v1/qzone/like", self._handle_qzone_like)
        if self.store is not None:
            app.router.add_get("/v1/read-state", self._handle_read_state_get)
            app.router.add_post("/v1/read-state", self._handle_read_state_post)
            app.router.add_get("/v1/water-state", self._handle_water_state_get)
            app.router.add_post("/v1/water-state", self._handle_water_state_post)
        if self.media is not None:
            app.router.add_post("/v1/media", self._handle_media)
        self._runner = web.AppRunner(app)
        await self._runner.setup()
        self._site = web.TCPSite(self._runner, self.config.host, self.config.port)
        await self._site.start()
        sockets = self._site._server.sockets
        if sockets:
            self.port = int(sockets[0].getsockname()[1])
        self.log.info("qq-gateway ipc listening on %s:%s", self.config.host, self.port)

    async def stop(self) -> None:
        if self._runner is not None:
            await self._runner.cleanup()
        self._runner = None
        self._site = None

    @web.middleware
    async def _auth(self, request: web.Request, handler: Callable[[web.Request], Awaitable[web.StreamResponse]]):
        header = request.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            raise web.HTTPUnauthorized(text="missing bearer token")
        if not hmac.compare_digest(header[7:], self.config.token):
            raise web.HTTPUnauthorized(text="invalid token")
        return await handler(request)

    async def _handle_health(self, _request: web.Request) -> web.Response:
        return web.json_response({"ok": True, "data": self.health()})

    async def _handle_action(self, request: web.Request) -> web.Response:
        action = request.match_info["action"]
        try:
            body = await request.json()
        except json.JSONDecodeError:
            body = {}
        params = body.get("params") if isinstance(body, dict) else {}
        mutating = body.get("mutating") if isinstance(body, dict) else None
        timeout = body.get("timeout") if isinstance(body, dict) else None
        try:
            result = await self.actions.call(action, params or {}, mutating=mutating, timeout=timeout)
            return web.json_response({"ok": True, "data": result})
        except Exception as exc:
            return self._error_response(exc, action)

    async def _handle_media(self, request: web.Request) -> web.Response:
        try:
            body = await request.json()
        except json.JSONDecodeError:
            return self._bad_request("invalid json body")
        if not isinstance(body, dict):
            return self._bad_request("invalid json body")
        segment = body.get("segment")
        if not isinstance(segment, dict):
            return self._bad_request("invalid segment")
        index = body.get("index", 0)
        if isinstance(index, bool) or not isinstance(index, int) or index < 0:
            return self._bad_request("invalid index")
        message_id = str(body.get("message_id") or "")
        if not message_id:
            return self._bad_request("invalid message_id")
        try:
            path = await self.media.fetch(segment, index, message_id, self.actions.call)
            return web.json_response({"ok": True, "data": {"path": path}})
        except Exception as exc:
            return self._error_response(exc, "media")

    async def _handle_stickers_list(self, request: web.Request) -> web.Response:
        try:
            count = int(request.query.get("count", "48"))
            data = await self.stickers.list(count)
            return web.json_response({"ok": True, "data": data})
        except Exception as exc:
            return self._error_response(exc, "list_stickers")

    async def _handle_sticker_send(self, request: web.Request) -> web.Response:
        try:
            body = await request.json()
            data = await self.stickers.send(
                str(body.get("message_type") or ""),
                str(body.get("target_id") or ""),
                res_id=body.get("res_id"),
                source_message_id=body.get("source_message_id"),
                file_path=body.get("file_path"),
            )
            return web.json_response({"ok": True, "data": data})
        except Exception as exc:
            return self._error_response(exc, "send_sticker")

    async def _handle_sticker_save(self, request: web.Request) -> web.Response:
        try:
            body = await request.json()
            data = await self.stickers.save(
                source_message_id=body.get("source_message_id"),
                file_path=body.get("file_path"),
                url=body.get("url"),
                is_mark_face=bool(body.get("is_mark_face", False)),
                note=str(body.get("note") or ""),
                usage=str(body.get("usage") or ""),
            )
            return web.json_response({"ok": True, "data": data})
        except Exception as exc:
            return self._error_response(exc, "save_sticker")

    async def _handle_sticker_update(self, request: web.Request) -> web.Response:
        try:
            body = await request.json()
            data = await self.stickers.update(
                str(body.get("res_id") or ""),
                note=body.get("note"),
                usage=body.get("usage"),
            )
            return web.json_response({"ok": True, "data": data})
        except Exception as exc:
            return self._error_response(exc, "update_sticker")

    async def _handle_sticker_delete(self, request: web.Request) -> web.Response:
        try:
            body = await request.json()
            data = await self.stickers.delete(str(body.get("res_id") or ""))
            return web.json_response({"ok": True, "data": data})
        except Exception as exc:
            return self._error_response(exc, "delete_sticker")

    async def _handle_qzone_feeds(self, request: web.Request) -> web.Response:
        try:
            data = await self.qzone.list_feeds(
                target_qq=str(request.query.get("target_qq") or ""),
                limit=int(request.query.get("limit", "20")),
            )
            return web.json_response({"ok": True, "data": data})
        except Exception as exc:
            return self._qzone_error_response(exc, "qzone_list_feeds")

    async def _handle_qzone_comments(self, request: web.Request) -> web.Response:
        try:
            data = await self.qzone.get_comments(
                target_qq=str(request.query.get("target_qq") or ""),
                tid=str(request.query.get("tid") or ""),
                scan=int(request.query.get("scan", "20")),
            )
            return web.json_response({"ok": True, "data": data})
        except Exception as exc:
            return self._qzone_error_response(exc, "qzone_get_comments")

    async def _handle_qzone_comment(self, request: web.Request) -> web.Response:
        try:
            body = await request.json()
            data = await self.qzone.comment(
                target_qq=str(body.get("target_qq") or ""),
                tid=str(body.get("tid") or ""),
                content=str(body.get("content") or ""),
            )
            return web.json_response({"ok": True, "data": data})
        except Exception as exc:
            return self._qzone_error_response(exc, "qzone_comment")

    async def _handle_qzone_reply(self, request: web.Request) -> web.Response:
        try:
            body = await request.json()
            comment_uin = body.get("comment_uin")
            comment_nick = body.get("comment_nick")
            data = await self.qzone.reply(
                target_qq=str(body.get("target_qq") or ""),
                tid=str(body.get("tid") or ""),
                comment_id=str(body.get("comment_id") or ""),
                content=str(body.get("content") or ""),
                comment_uin=str(comment_uin) if comment_uin not in (None, "") else None,
                comment_nick=str(comment_nick) if comment_nick not in (None, "") else None,
            )
            return web.json_response({"ok": True, "data": data})
        except Exception as exc:
            return self._qzone_error_response(exc, "qzone_reply")

    async def _handle_qzone_delete_comment(self, request: web.Request) -> web.Response:
        try:
            body = await request.json()
            comment_uin = body.get("comment_uin")
            data = await self.qzone.delete_comment(
                target_qq=str(body.get("target_qq") or ""),
                tid=str(body.get("tid") or ""),
                comment_id=str(body.get("comment_id") or ""),
                comment_uin=str(comment_uin) if comment_uin not in (None, "") else None,
            )
            return web.json_response({"ok": True, "data": data})
        except Exception as exc:
            return self._qzone_error_response(exc, "qzone_delete_comment")

    async def _handle_qzone_like(self, request: web.Request) -> web.Response:
        try:
            body = await request.json()
            data = await self.qzone.like(
                target_qq=str(body.get("target_qq") or ""),
                tid=str(body.get("tid") or ""),
            )
            return web.json_response({"ok": True, "data": data})
        except Exception as exc:
            return self._qzone_error_response(exc, "qzone_like")

    async def _handle_read_state_get(self, request: web.Request) -> web.Response:
        chat_type = str(request.query.get("chat_type") or "")
        target = str(request.query.get("target") or "")
        if chat_type not in ("group", "friend") or not target:
            return self._bad_request("invalid chat_type or target")
        row = await self.store.get_cursor("default", chat_type, target)
        data = {
            "chat_type": chat_type,
            "target": target,
            "last_time": float(row["last_time"]) if row else 0,
            "last_message_id": (row["last_message_id"] if row else "") or "",
        }
        return web.json_response({"ok": True, "data": data})

    async def _handle_read_state_post(self, request: web.Request) -> web.Response:
        try:
            body = await request.json()
        except json.JSONDecodeError:
            return self._bad_request("invalid json body")
        if not isinstance(body, dict):
            return self._bad_request("invalid json body")
        chat_type = str(body.get("chat_type") or "")
        target = str(body.get("target") or "")
        try:
            last_time = float(body.get("last_time") or 0)
        except (TypeError, ValueError):
            return self._bad_request("invalid last_time")
        last_message_id = str(body.get("last_message_id") or "")
        if chat_type not in ("group", "friend") or not target:
            return self._bad_request("invalid chat_type or target")
        await self.store.set_cursor("default", chat_type, target, last_time, last_message_id)
        data = {
            "chat_type": chat_type,
            "target": target,
            "last_time": last_time,
            "last_message_id": last_message_id,
        }
        return web.json_response({"ok": True, "data": data})

    async def _handle_water_state_get(self, request: web.Request) -> web.Response:
        group_id = str(request.query.get("group_id") or "")
        if not group_id:
            return web.json_response({"ok": True, "data": await self.store.list_water_states()})
        state = await self.store.get_water_state(group_id)
        return web.json_response({"ok": True, "data": state or default_water_state(group_id)})

    async def _handle_water_state_post(self, request: web.Request) -> web.Response:
        try:
            body = await request.json()
        except json.JSONDecodeError:
            return self._bad_request("invalid json body")
        if not isinstance(body, dict):
            return self._bad_request("invalid json body")
        group_id = str(body.get("group_id") or "")
        if not group_id:
            return self._bad_request("invalid group_id")
        mode = body.get("mode")
        if mode is not None and mode not in WATER_MODES:
            return self._bad_request("invalid mode")
        threshold = body.get("threshold")
        if threshold is not None and not self._valid_number(threshold, 0, 100):
            return self._bad_request("invalid threshold")
        water_until = body.get("water_until")
        if water_until is not None and not self._valid_number(water_until, 0):
            return self._bad_request("invalid water_until")
        last_wake_at = body.get("last_wake_at")
        if last_wake_at is not None and not self._valid_number(last_wake_at, 0):
            return self._bad_request("invalid last_wake_at")
        state = await self.store.upsert_water_state(
            group_id,
            mode=mode,
            threshold=threshold,
            water_until=water_until,
            last_wake_at=last_wake_at,
        )
        return web.json_response({"ok": True, "data": state})

    @staticmethod
    def _valid_number(value: Any, minimum: float, maximum: Optional[float] = None) -> bool:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return False
        if value < minimum:
            return False
        return maximum is None or value <= maximum

    @staticmethod
    def _bad_request(message: str) -> web.Response:
        return web.json_response(
            {"ok": False, "error": {"message": message, "retcode": 1400}},
            status=400,
        )

    @staticmethod
    def _qzone_error_response(exc: Exception, default_action: str) -> web.Response:
        return IPCServer._error_response(exc, default_action)

    @staticmethod
    def _error_response(exc: Exception, default_action: str) -> web.Response:
        return web.json_response({
            "ok": False,
            "error": {
                "code": getattr(exc, "action", default_action),
                "message": str(exc),
                "retcode": int(getattr(exc, "retcode", -1)),
            },
        })
