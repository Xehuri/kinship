from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from collections import defaultdict, deque
from typing import Any, Mapping, Optional

from .config import InboundConfig, OutboundConfig
from .store import EventStore
from .transport import ActionResponse, ActionTimeout, NapCatTransport, TransportClosed

READ_ACTIONS = {
    "get_login_info", "get_status", "get_version_info", "get_msg", "get_forward_msg",
    "get_group_msg_history", "get_friend_msg_history", "get_image", "get_file",
    "get_group_list", "get_friend_list", "get_group_member_list", "get_stranger_info",
    "fetch_custom_face", "fetch_custom_face_detail", "get_cookies",
}
MUTATING_ACTIONS = {
    "send_private_msg", "send_group_msg", "send_msg", "send_forward_msg",
    "send_group_forward_msg", "send_private_forward_msg", "upload_group_file",
    "upload_private_file", "delete_msg", "send_poke", "group_poke", "friend_poke",
    "set_msg_emoji_like", "set_group_ban", "set_group_kick", "set_group_card",
    "add_custom_face", "delete_custom_face", "set_custom_face_desc",
}
ALLOWED_ACTIONS = READ_ACTIONS | MUTATING_ACTIONS


class ActionError(RuntimeError):
    def __init__(self, action: str, message: str, retcode: int = -1) -> None:
        super().__init__(message)
        self.action = action
        self.retcode = retcode


class IndeterminateActionError(ActionError):
    pass


class RateLimiter:
    def __init__(self, per_minute: int, min_interval_ms: int) -> None:
        self.per_minute = max(1, per_minute)
        self.min_interval = max(0, min_interval_ms) / 1000.0
        self._events: dict[str, deque[float]] = defaultdict(deque)

    def acquire(self, key: str) -> None:
        now = time.monotonic()
        bucket = self._events[key]
        while bucket and now - bucket[0] > 60:
            bucket.popleft()
        if len(bucket) >= self.per_minute:
            raise ActionError("rate_limit", f"rate limit exceeded for {key}", 1200)
        if bucket and now - bucket[-1] < self.min_interval:
            raise ActionError("rate_limit", f"send too fast for {key}", 1200)
        bucket.append(now)


class ActionService:
    def __init__(self, transport: NapCatTransport, inbound: InboundConfig,
                 outbound: OutboundConfig, store: Optional[EventStore] = None,
                 logger: Optional[logging.Logger] = None) -> None:
        self.transport = transport
        self.inbound = inbound
        self.outbound = outbound
        self.store = store
        self.log = logger or logging.getLogger(__name__)
        self.limiter = RateLimiter(outbound.send_rate_per_min, outbound.min_interval_ms)

    async def call(self, action: str, params: Optional[Mapping[str, Any]] = None,
                   *, mutating: Optional[bool] = None,
                   timeout: Optional[float] = None) -> Any:
        if action not in ALLOWED_ACTIONS:
            raise ActionError(action, f"action not allowed: {action}", 1404)
        if mutating is None:
            mutating = action in MUTATING_ACTIONS
        if mutating and not self.outbound.enabled:
            raise ActionError(action, "outbound is disabled", 1403)
        if mutating:
            self._check_target(action, params or {})
        if mutating and self.outbound.dry_run:
            return {"dry_run": True, "action": action, "params": dict(params or {})}
        if mutating:
            target = str((params or {}).get("group_id") or (params or {}).get("user_id") or "")
            self.limiter.acquire(action + ":" + target)
        try:
            response = await self.transport.call(action, params, timeout=timeout)
        except (TransportClosed, ActionTimeout) as exc:
            if mutating:
                raise IndeterminateActionError(action, f"mutating action outcome unknown: {exc}", 0) from exc
            raise ActionError(action, str(exc), 0) from exc
        if response.status != "ok" or response.retcode != 0:
            raise ActionError(action, response.message or response.wording or "action failed",
                              response.retcode)
        await self._record(action, params, response)
        return response.data

    def _check_target(self, action: str, params: Mapping[str, Any]) -> None:
        group_id = params.get("group_id")
        user_id = params.get("user_id")
        if group_id not in (None, "", 0, "0"):
            if not self.outbound.groups:
                raise ActionError(action, "group outbound is disabled", 1403)
            if self.outbound.group_allowlist and str(group_id) not in self.outbound.group_allowlist:
                raise ActionError(action, "group not allowed", 1403)
            return
        if user_id not in (None, "", 0, "0") and not self.outbound.private:
            raise ActionError(action, "private outbound is disabled", 1403)

    async def _record(self, action: str, params: Optional[Mapping[str, Any]],
                      response: ActionResponse) -> None:
        if self.store is None:
            return
        params_hash = hashlib.sha256(
            json.dumps(dict(params or {}), sort_keys=True, ensure_ascii=False).encode("utf-8")
        ).hexdigest()
        await self.store.record_action(response.echo, action, params_hash)
        await self.store.finish_action(response.echo, "ok", {"retcode": response.retcode})

    async def send_message(self, message_type: str, target_id: str | int,
                           message: Any, auto_escape: bool = False,
                           delay_seconds: float = 0.0) -> Any:
        if delay_seconds > 0:
            await asyncio.sleep(delay_seconds)
        if message_type == "private":
            action = "send_private_msg"
            params = {"user_id": target_id, "message": message, "auto_escape": auto_escape}
        elif message_type == "group":
            action = "send_group_msg"
            params = {"group_id": target_id, "message": message, "auto_escape": auto_escape}
        else:
            raise ActionError("send", f"unsupported message_type: {message_type}", 1400)
        return await self.call(action, params, mutating=True)

    async def send_file(self, target_id: str | int, file: str, name: str,
                        message_type: str = "private", group_id: str | int | None = None) -> Any:
        if message_type == "group" or group_id is not None:
            return await self.call("upload_group_file", {
                "group_id": group_id or target_id, "file": file, "name": name,
            }, mutating=True)
        return await self.call("upload_private_file", {
            "user_id": target_id, "file": file, "name": name,
        }, mutating=True)

    async def send_poke(self, user_id: str | int, group_id: str | int | None = None) -> Any:
        params: dict[str, Any] = {"user_id": user_id}
        if group_id is not None:
            params["group_id"] = group_id
        return await self.call("send_poke", params, mutating=True)

    async def set_msg_emoji_like(self, message_id: str | int, emoji_id: str | int,
                                 set_: bool = True) -> Any:
        return await self.call("set_msg_emoji_like", {
            "message_id": str(message_id), "emoji_id": str(emoji_id), "set": set_,
        }, mutating=True)

    async def get_forward_msg(self, message_id: str | int) -> Any:
        return await self.call("get_forward_msg", {"message_id": str(message_id)})

    async def get_msg(self, message_id: str | int) -> Any:
        return await self.call("get_msg", {"message_id": str(message_id)})

    async def get_group_msg_history(self, group_id: str | int, count: int = 20) -> Any:
        return await self.call("get_group_msg_history", {"group_id": group_id, "count": count})

    async def get_friend_msg_history(self, user_id: str | int, count: int = 50) -> Any:
        return await self.call("get_friend_msg_history", {"user_id": user_id, "count": count})

    async def get_login_info(self) -> Any:
        return await self.call("get_login_info", {})

    async def get_status(self) -> Any:
        return await self.call("get_status", {})
