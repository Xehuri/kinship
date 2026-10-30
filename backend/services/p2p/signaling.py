from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import random
import time
from typing import Any, AsyncContextManager, Awaitable, Callable, Optional
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


try:  # websockets >= 12 的新 asyncio 客户端
    from websockets.asyncio.client import connect as _default_connect
except ImportError:  # pragma: no cover - 兼容旧版安装
    from websockets.client import connect as _default_connect


MAX_MESSAGE_SIZE = 65536
_HANDLED_TYPES = frozenset(
    {
        "registered",
        "peer_joined",
        "peer_left",
        "offer",
        "answer",
        "ice",
        "bye",
        "error",
        "pong",
    }
)

MessageCallback = Callable[[dict[str, Any]], Awaitable[None]]
TicketProvider = Callable[[], str]
Connector = Callable[..., AsyncContextManager[Any]]

logger = logging.getLogger(__name__)


async def log_signal_event(message: dict[str, Any]) -> None:
    message_type = str(message.get("type") or "")
    if message_type == "error":
        logger.warning("[P2P] signaling event type=%s", message_type)
    else:
        logger.info("[P2P] signaling event type=%s", message_type)


class SignalingClient:
    """信令 WebSocket 客户端（role=server）。

    连接 URI 含短时票据，任何日志都不得打印 URI、票据或 SDP/ICE 载荷。
    """

    def __init__(
        self,
        signal_url: str,
        room: str,
        server_id: str,
        ticket_provider: TicketProvider,
        on_message: Optional[MessageCallback] = None,
        *,
        connect: Optional[Connector] = None,
        ping_interval: float = 30.0,
        backoff_min: float = 1.0,
        backoff_max: float = 30.0,
        logger: Optional[logging.Logger] = None,
    ) -> None:
        self._signal_url = str(signal_url or "")
        self._room = str(room or "")
        self._server_id = str(server_id or "")
        self._ticket_provider = ticket_provider
        self._on_message = on_message
        self._connect = connect or _default_connect
        self._ping_interval = max(0.001, float(ping_interval))
        self._backoff_min = max(0.0, float(backoff_min))
        self._backoff_max = max(self._backoff_min, float(backoff_max))
        self._log = logger or logging.getLogger(__name__)

        self._state = "disconnected"
        self._stopped = False
        self._ever_connected = False
        self._ws: Any = None
        self._run_task: Optional[asyncio.Task] = None
        self._stop_event = asyncio.Event()
        self._last_pong = 0.0
        self._send_lock = asyncio.Lock()

    @property
    def state(self) -> str:
        return self._state

    @property
    def connected(self) -> bool:
        return self._state == "connected"

    @property
    def last_pong(self) -> float:
        return self._last_pong

    def build_url(self, ticket: str) -> str:
        parts = urlsplit(self._signal_url)
        path = parts.path or ""
        if not path.rstrip("/").endswith("/ws"):
            path = path.rstrip("/") + "/ws"
        query = dict(parse_qsl(parts.query, keep_blank_values=True))
        query.update(
            {
                "role": "server",
                "room": self._room,
                "device_id": self._server_id,
                "token": ticket,
            }
        )
        return urlunsplit(
            (parts.scheme, parts.netloc, path, urlencode(query), parts.fragment)
        )

    async def run(self) -> None:
        """连接并按指数退避重连，直到 stop() 被调用。"""
        self._run_task = asyncio.current_task()
        attempt = 0
        try:
            while not self._stopped:
                self._state = "reconnecting" if self._ever_connected else "connecting"
                try:
                    ticket = self._ticket_provider()
                    if not ticket:
                        raise ValueError("signal ticket provider returned empty ticket")
                    uri = self.build_url(ticket)
                    async with self._connect(
                        uri, max_size=MAX_MESSAGE_SIZE, ping_interval=None
                    ) as websocket:
                        self._ws = websocket
                        self._state = "connected"
                        self._ever_connected = True
                        attempt = 0
                        ping_task = asyncio.create_task(self._ping_loop(websocket))
                        try:
                            async for raw in websocket:
                                await self._dispatch(raw)
                        finally:
                            ping_task.cancel()
                            with contextlib.suppress(asyncio.CancelledError):
                                await ping_task
                            self._ws = None
                            if not self._stopped:
                                self._state = "disconnected"
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    # 异常文本可能携带连接 URI（含票据），只记录类型名。
                    self._log.warning(
                        "[P2P] signaling connection failed: %s", type(exc).__name__
                    )
                if self._stopped:
                    break
                self._state = "reconnecting"
                delay = self._backoff_delay(attempt)
                attempt += 1
                await self._sleep_or_stop(delay)
        finally:
            self._ws = None
            self._state = "stopped"

    async def stop(self) -> None:
        self._stopped = True
        self._stop_event.set()
        websocket = self._ws
        if websocket is not None:
            with contextlib.suppress(Exception):
                await websocket.close()
        task = self._run_task
        if task is not None and task is not asyncio.current_task():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        self._state = "stopped"

    async def send_message(self, message: dict[str, Any]) -> bool:
        """向信令服务发送一条消息；未连接或发送失败返回 False。

        只记录类型层面的失败原因，绝不打印消息载荷（SDP/ICE/票据）。
        """
        websocket = self._ws
        if websocket is None or self._state != "connected":
            return False
        try:
            payload = json.dumps(message)
        except (TypeError, ValueError):
            return False
        if len(payload) > MAX_MESSAGE_SIZE:
            logger.warning(
                "[P2P] 信令消息超过上限 type=%s size=%s",
                message.get("type"),
                len(payload),
            )
            return False
        async with self._send_lock:
            if self._ws is not websocket or self._state != "connected":
                return False
            try:
                await websocket.send(payload)
            except Exception:
                return False
        return True

    def _backoff_delay(self, attempt: int) -> float:
        base = min(self._backoff_max, self._backoff_min * (2 ** attempt))
        jitter = base * (0.8 + random.random() * 0.4)
        return max(0.0, jitter)

    async def _sleep_or_stop(self, delay: float) -> None:
        try:
            await asyncio.wait_for(self._stop_event.wait(), timeout=delay)
        except asyncio.TimeoutError:
            pass

    async def _ping_loop(self, websocket: Any) -> None:
        while not self._stopped:
            await asyncio.sleep(self._ping_interval)
            if self._stopped:
                return
            try:
                async with self._send_lock:
                    await websocket.send(json.dumps({"type": "ping"}))
            except Exception:
                return

    async def _dispatch(self, raw: Any) -> None:
        try:
            message = json.loads(raw)
        except (TypeError, ValueError):
            return
        if not isinstance(message, dict):
            return
        message_type = str(message.get("type") or "")
        if message_type == "pong":
            self._last_pong = time.monotonic()
        if message_type not in _HANDLED_TYPES:
            self._log.debug("[P2P] ignored signaling message type=%s", message_type)
            return
        if self._on_message is not None:
            await self._on_message(message)
