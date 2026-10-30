from __future__ import annotations

import asyncio  # noqa: ANYIO_OK - FastAPI lifespan and websockets.asyncio share asyncio
import contextlib
import logging
from dataclasses import replace
from typing import Any, Optional

from config.config import get_config
from services.p2p.config import P2PConfig
from services.p2p.devices import DeviceOperations
from services.p2p.errors import (
    P2PAccessError,
    P2PDisabledError,
    P2PError,
    P2PUnavailableError,
    P2PValidationError,
)
from services.p2p.protocol import AudioMeta, EventEnvelope
from services.p2p.records import DeviceRecord
from services.p2p.signaling import SignalingClient, log_signal_event
from services.p2p.store import DeviceStore, PairingCodes
from services.p2p.tokens import SignalTicketIssuer
from services.p2p.webrtc import (
    WebRtcPeerManager,
    WebRtcUnavailableError,
)


__all__ = [
    "P2PManager",
    "get_p2p_manager",
    "peek_p2p_manager",
    "stop_p2p_manager",
    "restart_p2p_manager",
    "reset_p2p_manager",
    "P2PError",
    "P2PDisabledError",
    "P2PValidationError",
    "P2PAccessError",
    "P2PUnavailableError",
]

logger = logging.getLogger(__name__)


def _load_config() -> P2PConfig:
    config = get_config()
    p2p_config = P2PConfig.from_dict(config.P2P)
    resolved_path = config.P2P_DEVICES_PATH
    if resolved_path:
        p2p_config = replace(p2p_config, devices_path=resolved_path)
    return p2p_config


class P2PManager:
    """P2P 生命周期编排：信令连接 + 设备操作门面。"""

    def __init__(
        self,
        config: P2PConfig,
        *,
        store: Optional[DeviceStore] = None,
        pairing: Optional[PairingCodes] = None,
        signaling: Optional[SignalingClient] = None,
        issuer: Optional[SignalTicketIssuer] = None,
    ) -> None:
        self.config = config
        self.devices = DeviceOperations(
            config, store=store, pairing=pairing, issuer=issuer
        )
        self._signaling = signaling
        self._task: Optional[asyncio.Task] = None
        self._webrtc: Optional[WebRtcPeerManager] = None

    @property
    def room(self) -> str:
        return self.devices.room

    @property
    def signal_connected(self) -> bool:
        return bool(self._signaling is not None and self._signaling.connected)

    async def start(self) -> None:
        if not self.config.enabled:
            logger.info("[P2P] 未启用（p2p.enabled=false），跳过后台服务")
            return
        problems = self.config.validate()
        if problems:
            logger.warning(
                "[P2P] 配置不完整，后台信令未启动: %s", "; ".join(problems)
            )
            return
        if not self.devices.room_is_usable:
            logger.warning("[P2P] room 非法（空或不符合标识符规则），后台信令未启动")
            return
        if self._task is not None and not self._task.done():
            return
        try:
            self.devices.ensure_store()
            issuer = self.devices.require_issuer()
            if self._signaling is None:
                self._signaling = SignalingClient(
                    signal_url=self.config.signal_url,
                    room=self.room,
                    server_id=self.config.server_id,
                    ticket_provider=self._server_ticket,
                    on_message=self._handle_signal,
                )
            self._ensure_webrtc()
            self._task = asyncio.create_task(
                self._signaling.run(), name="p2p-signaling"
            )
        except Exception as exc:  # noqa: BROAD_EXCEPT_OK - fail-open startup boundary
            logger.warning(
                "[P2P] 初始化失败，按 fail-open 继续: %s", type(exc).__name__
            )
            return
        logger.info(
            "[P2P] 信令后台任务已启动 room=%s server_id=%s ticket_ttl=%ss",
            self.room,
            self.config.server_id,
            issuer.ttl_seconds,
        )

    def _ensure_webrtc(self) -> None:
        if not self.config.webrtc_enabled or self._webrtc is not None:
            return
        try:
            self._webrtc = WebRtcPeerManager(
                self.config,
                self.devices.get_device,
                self._send_signal_message,
                self._ingest_audio,
                self._ingest_event,
            )
        except WebRtcUnavailableError:
            logger.warning(
                "[P2P] webrtc.enabled=true 但 aiortc 未安装，"
                "WebRTC 数据面未启动（Phase 1 信令继续工作）"
            )
        except Exception as exc:  # noqa: BROAD_EXCEPT_OK - optional data plane
            logger.warning(
                "[P2P] WebRTC 初始化失败，数据面未启动: %s", type(exc).__name__
            )

    async def _handle_signal(self, message: dict[str, Any]) -> None:
        await log_signal_event(message)
        webrtc = self._webrtc
        if webrtc is None:
            return
        await webrtc.handle_signal(message)

    async def _send_signal_message(self, message: dict[str, Any]) -> bool:
        signaling = self._signaling
        if signaling is None:
            return False
        send = getattr(signaling, "send_message", None)
        if send is None:
            return False
        try:
            return bool(await send(message))
        except Exception:  # noqa: BROAD_EXCEPT_OK - signaling is best-effort
            return False

    async def _ingest_audio(
        self, device_id: str, meta: AudioMeta, payload: bytes
    ) -> bool:
        if meta.start_ms <= 0:
            logger.warning(
                "[P2P] WebRTC 音频 start_ms 非法 device_id=%s", device_id
            )
            return False
        import base64

        from routers.perception import _handle_voice_session

        try:
            result = await _handle_voice_session(
                base64.b64encode(payload).decode("ascii"),
                meta.client_time,
                device_name=device_id,
                origin="upload",
                device_id=device_id,
                session_id=meta.session_id,
                seq=meta.seq,
                client_start_ms=meta.start_ms,
            )
        except Exception as exc:  # noqa: BROAD_EXCEPT_OK - ingest boundary
            logger.warning(
                "[P2P] WebRTC 音频入库失败 device_id=%s error=%s",
                device_id,
                type(exc).__name__,
            )
            return False
        if not isinstance(result, dict) or result.get("status") == "error":
            return False
        logger.info(
            "[P2P] WebRTC 音频已入库 device_id=%s session_id=%s seq=%s bytes=%s",
            device_id,
            meta.session_id,
            meta.seq,
            len(payload),
        )
        return True

    async def _ingest_event(self, device_id: str, event: EventEnvelope) -> bool:
        from routers.perception import (
            PerceptionEventRequest,
            perception_event,
        )

        try:
            result = await perception_event(
                PerceptionEventRequest(
                    type=event.event_type,
                    payload=event.payload,
                    ts=event.ts,
                )
            )
        except Exception as exc:  # noqa: BROAD_EXCEPT_OK - ingest boundary
            logger.warning(
                "[P2P] WebRTC 事件入库失败 device_id=%s error=%s",
                device_id,
                type(exc).__name__,
            )
            return False
        return isinstance(result, dict) and result.get("status") != "error"

    async def stop(self) -> None:
        webrtc, self._webrtc = self._webrtc, None
        if webrtc is not None:
            try:
                await webrtc.close()
            except Exception as exc:  # noqa: BROAD_EXCEPT_OK - shutdown cleanup
                logger.warning("[P2P] WebRTC 停止失败: %s", type(exc).__name__)
        if self._signaling is not None:
            try:
                await self._signaling.stop()
            except Exception as exc:  # noqa: BROAD_EXCEPT_OK - shutdown cleanup
                logger.warning("[P2P] 信令停止失败: %s", type(exc).__name__)
            self._signaling = None
        task = self._task
        if task is not None and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        self._task = None
        try:
            self.devices.save()
        except Exception as exc:  # noqa: BROAD_EXCEPT_OK - shutdown cleanup
            logger.warning("[P2P] 设备注册表持久化失败: %s", type(exc).__name__)

    def _server_ticket(self) -> str:
        ticket, _ = self.devices.require_issuer().issue(self.config.server_id)
        return ticket

    def status(self) -> dict[str, Any]:
        return {
            "enabled": bool(self.config.enabled),
            "signal_connected": self.signal_connected,
            "signal_url": self.config.signal_url,
            "webrtc_enabled": bool(self.config.webrtc_enabled),
            "room": self.room,
            "endpoints": dict(self.config.endpoints),
            "device_count": self.devices.device_count(),
            "server_id": self.config.server_id,
        }

    def issue_pairing_code(self, user_id: str) -> tuple[str, int]:
        return self.devices.issue_pairing_code(user_id)

    def enroll(
        self,
        code: str,
        device_id: str,
        device_name: str = "",
        platform: str = "",
    ) -> dict[str, Any]:
        return self.devices.enroll(code, device_id, device_name, platform)

    def issue_signal_ticket(
        self,
        user_id: str,
        device_id: str,
        *,
        allow_auto_enroll: bool = True,
    ) -> tuple[str, int]:
        return self.devices.issue_signal_ticket(
            user_id, device_id, allow_auto_enroll=allow_auto_enroll
        )

    def list_devices(self, user_id: Optional[str] = None) -> list[DeviceRecord]:
        return self.devices.list_devices(user_id)

    def get_device(self, device_id: str) -> Optional[DeviceRecord]:
        return self.devices.get_device(device_id)

    def revoke(self, device_id: str) -> int:
        return self.devices.revoke(device_id)

    async def revoke_device(self, device_id: str) -> int:
        revoked_tokens = self.devices.revoke(device_id)
        webrtc = self._webrtc
        if webrtc is not None:
            await webrtc.close_device(device_id)
        return revoked_tokens


_instance: Optional[P2PManager] = None
_restart_lock = asyncio.Lock()


def get_p2p_manager() -> P2PManager:
    global _instance
    if _instance is None:
        _instance = P2PManager(_load_config())
    return _instance


def peek_p2p_manager() -> Optional[P2PManager]:
    return _instance


async def stop_p2p_manager() -> None:
    global _instance
    if _instance is not None:
        await _instance.stop()
        _instance = None


async def restart_p2p_manager(
    new_config: Optional[P2PConfig] = None,
) -> dict[str, Any]:
    """按新配置原地重启 P2P 管理器；配置非法时保持现有实例不动。"""
    global _instance
    async with _restart_lock:
        config = new_config if new_config is not None else _load_config()
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
                    "[P2P] 重启时停止旧实例失败: %s", type(exc).__name__
                )
        manager = P2PManager(config)
        _instance = manager
        if config.enabled:
            try:
                await manager.start()
            except Exception as exc:  # noqa: BROAD_EXCEPT_OK - report to caller
                logger.warning(
                    "[P2P] 重启后启动失败: %s", type(exc).__name__
                )
                return {
                    "ok": False,
                    "enabled": config.enabled,
                    "errors": [f"{type(exc).__name__}: {exc}"],
                }
        return {"ok": True, "enabled": config.enabled, "state": manager.status()}


def reset_p2p_manager() -> None:
    """测试辅助：丢弃单例（不执行停止）。"""
    global _instance
    _instance = None
