from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

from .actions import ActionService
from .config import QQGatewayConfig
from .delivery import DeliveryWorker
from .forward import expand_forward_segment
from .ipc import IPCServer
from .media import MediaFetcher
from .qzone import QZoneService
from .render import render_segments
from .router import EventRouter
from .stickers import StickerService
from .store import EventStore
from .transport import NapCatTransport
from core.redaction import redact_text

Sender = Callable[[dict[str, Any]], Awaitable[bool]]
_PROJECT_ROOT = Path(__file__).resolve().parents[3]
logger = logging.getLogger(__name__)


class QQGatewayService:
    def __init__(self, config: QQGatewayConfig, send: Optional[Sender] = None,
                 session_id: str = "", logger: Optional[logging.Logger] = None) -> None:
        self.config = config
        self.send = send
        self.session_id = session_id
        self.log = logger or logging.getLogger(__name__)
        self.store: Optional[EventStore] = None
        self.transport: Optional[NapCatTransport] = None
        self.actions: Optional[ActionService] = None
        self.media: Optional[MediaFetcher] = None
        self.stickers: Optional[StickerService] = None
        self.qzone: Optional[QZoneService] = None
        self.router = EventRouter(config)
        self.delivery: Optional[DeliveryWorker] = None
        self.ipc: Optional[IPCServer] = None
        media_dir = Path(config.media.dir)
        self._media_dir = media_dir if media_dir.is_absolute() else _PROJECT_ROOT / media_dir
        self._stats: dict[str, Any] = {
            "events_seen": 0,
            "messages_seen": 0,
            "events_ignored": 0,
            "events_shadowed": 0,
            "events_queued": 0,
            "last_event_at": 0.0,
        }

    async def start(self) -> None:
        if not self.config.enabled:
            return
        problems = self.config.validate()
        if problems:
            raise ValueError("; ".join(problems))
        self._media_dir.mkdir(parents=True, exist_ok=True)
        db_path = self._media_dir.parent / "events.db"
        self.store = EventStore(str(db_path))
        self.transport = NapCatTransport(
            self.config.account, self.config.connection, self._on_event, self.log
        )
        self.actions = ActionService(
            self.transport, self.config.inbound, self.config.outbound, self.store, self.log
        )
        self.qzone = QZoneService(
            self.actions, self.config.qzone, self.config.outbound,
            self_qq=self.config.account.self_qq, logger=self.log,
        )
        self.media = MediaFetcher(
            str(self._media_dir), self.config.media.max_mb, self.config.media.gif_sniff, self.log
        )
        self.stickers = StickerService(self.actions, self.media, self.store)
        await self.transport.start()
        self.delivery = DeliveryWorker(
            self.store, self.send or self._send_to_loom, self.config.delivery, self.log
        )
        await self.delivery.start()
        self.ipc = IPCServer(self.config.mcp, self.actions, self.health,
                             stickers=self.stickers, logger=self.log,
                             qzone=self.qzone, store=self.store, media=self.media)
        try:
            await self.ipc.start()
        except Exception:
            await self.stop()
            raise

    async def stop(self) -> None:
        if self.ipc is not None:
            await self.ipc.stop()
        if self.delivery is not None:
            await self.delivery.stop()
        if self.qzone is not None:
            await self.qzone.close()
        if self.transport is not None:
            await self.transport.stop()
        if self.store is not None:
            self.store.close()

    async def _on_event(self, event: dict[str, Any]) -> None:
        self._stats["events_seen"] += 1
        self._stats["last_event_at"] = time.time()
        if str(event.get("post_type") or "") == "message":
            self._stats["messages_seen"] += 1
        decision = self.router.classify(event)
        if decision.kind in ("ignore", "meta"):
            self._stats["events_ignored"] += 1
            return
        if not decision.deliver or self.config.inbound.shadow:
            self._stats["events_shadowed"] += 1
            return
        message_id = decision.message_id
        if decision.kind == "message":
            segments = event.get("message") or []
            text = await render_segments(
                segments,
                media=self._resolve_media(message_id),
                forward=self._resolve_forward(),
            )
            sender = event.get("sender") or {}
            user_id = str(sender.get("user_id") or "")
            nickname = str(sender.get("card") or sender.get("nickname") or user_id)
            label = "群" if decision.chat_type == "group" else "私聊"
            clock = datetime.fromtimestamp(float(event.get("time") or time.time())).strftime("%H:%M")
            text = f"【QQ{label}】 {nickname}({user_id}) {clock}\n{text}"
        elif decision.kind == "notice":
            text = self._render_notice(event)
        else:
            text = self._render_request(event)
        await self.store.enqueue_event(
            account=str(event.get("self_id") or self.config.account.self_qq),
            kind=decision.kind,
            chat_type=decision.chat_type,
            target=decision.target,
            message_id=message_id,
            dedupe_key=decision.dedupe_key,
            text=text,
            payload=event,
        )
        self._stats["events_queued"] += 1

    def _resolve_media(self, message_id: str):
        async def resolve(segment: dict[str, Any], index: int) -> Optional[str]:
            if self.media is None or self.actions is None:
                return None
            return await self.media.fetch(segment, index, message_id, self.actions.call)
        return resolve

    def _resolve_forward(self):
        async def resolve(segment: dict[str, Any]) -> Optional[str]:
            if self.actions is None:
                return None
            return await expand_forward_segment(segment, self.actions.call, self.config.forward)
        return resolve

    @staticmethod
    def _render_notice(event: dict[str, Any]) -> str:
        notice_type = event.get("notice_type") or "notice"
        user_id = event.get("user_id") or ""
        group_id = event.get("group_id") or ""
        suffix = f" group={group_id}" if group_id else ""
        return f"[QQ通知] {notice_type} user={user_id}{suffix}"

    @staticmethod
    def _render_request(event: dict[str, Any]) -> str:
        request_type = event.get("request_type") or "request"
        user_id = event.get("user_id") or ""
        group_id = event.get("group_id") or ""
        flag = event.get("flag") or ""
        suffix = f" group={group_id}" if group_id else ""
        return f"[QQ请求] {request_type} user={user_id}{suffix} flag={flag}"

    async def _send_to_loom(self, row: dict[str, Any]) -> bool:
        session_id = self.session_id or self._resolve_session_id()
        if not session_id:
            self.log.warning("qq-gateway session not resolved; holding delivery")
            return False
        from services.loom_client import LoomClient

        result = await LoomClient().send_message(session_id, str(row.get("text") or ""))
        return bool(result.get("ok"))

    def _resolve_session_id(self) -> str:
        try:
            from config.config import get_config
            path = Path(get_config().DATA_DIR) / "cache" / "usersessions.json"
            data = json.loads(path.read_text(encoding="utf-8"))
            sessions = data.get("agent_sessions") or {}
            name = self.config.delivery.session
            return str(sessions.get(name) or sessions.get("loom:" + name) or "")
        except Exception:
            return ""

    def health(self) -> dict[str, Any]:
        counts = self.store.counts_sync() if self.store is not None else {}
        transport = self.transport
        return {
            "enabled": self.config.enabled,
            "connected": bool(transport and transport.connected),
            "reconnects": transport.reconnects if transport else 0,
            "pending_actions": transport.pending_count if transport else 0,
            "last_heartbeat_age": round(time.monotonic() - transport.last_heartbeat, 1) if transport else None,
            "queue": counts,
            "media_dir": str(self._media_dir),
            "qzone": self.qzone.status() if self.qzone is not None else {"enabled": False},
            "stats": dict(self._stats),
        }


_instance: Optional[QQGatewayService] = None
_restart_lock = asyncio.Lock()


def get_qq_gateway(config: Optional[QQGatewayConfig] = None) -> QQGatewayService:
    global _instance
    if _instance is None:
        _instance = QQGatewayService(config or QQGatewayConfig.load())
    return _instance


async def start_qq_gateway() -> QQGatewayService:
    service = get_qq_gateway()
    await service.start()
    return service


async def stop_qq_gateway() -> None:
    global _instance
    if _instance is not None:
        await _instance.stop()
        _instance = None


async def restart_qq_gateway(
    new_config: Optional[QQGatewayConfig] = None,
) -> dict[str, Any]:
    """按新配置原地重启网关；配置非法时保持现有实例不动。"""
    global _instance
    async with _restart_lock:
        config = new_config if new_config is not None else QQGatewayConfig.load()
        problems = config.validate()
        if problems:
            return {"ok": False, "errors": list(problems)}
        previous = _instance
        _instance = None
        if previous is not None:
            try:
                await previous.stop()
            except Exception as exc:  # noqa: BROAD_EXCEPT_OK - best-effort teardown
                logger.warning(
                    "[QQGateway] 重启时停止旧实例失败: %s", type(exc).__name__
                )
        service = QQGatewayService(config)
        _instance = service
        if config.enabled:
            try:
                await service.start()
            except Exception as exc:  # noqa: BROAD_EXCEPT_OK - report to caller
                logger.error(
                    "[QQGateway] 重启后启动失败: %s", type(exc).__name__
                )
                return {
                    "ok": False,
                    "enabled": config.enabled,
                    "errors": [redact_text(f"{type(exc).__name__}: {exc}")],
                }
        return {"ok": True, "enabled": config.enabled, "state": service.health()}
