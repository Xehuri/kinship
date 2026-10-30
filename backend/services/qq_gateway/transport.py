from __future__ import annotations

import asyncio
import json
import logging
import random
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Mapping, Optional
from urllib.parse import urlsplit, urlunsplit

import aiohttp

from core.redaction import redact_text
from .config import AccountConfig, ConnectionConfig

EventHandler = Callable[[dict[str, Any]], Awaitable[None]]


def _redacted_ws_url(url: str) -> str:
    """日志用 ws 地址：去掉 query/fragment（token 常经 query 传入）。"""
    try:
        parsed = urlsplit(url)
    except ValueError:
        return redact_text(url)
    host = parsed.netloc.rsplit("@", 1)[-1]
    return redact_text(urlunsplit((parsed.scheme, host, parsed.path, "", "")))


class TransportClosed(RuntimeError):
    pass


class ActionTimeout(RuntimeError):
    pass


@dataclass
class ActionResponse:
    action: str
    status: str
    retcode: int
    data: Any
    message: str
    wording: str
    echo: str
    stream: str
    frames: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class _Pending:
    action: str
    future: asyncio.Future[ActionResponse]
    frames: list[dict[str, Any]] = field(default_factory=list)
    created_at: float = field(default_factory=time.monotonic)


class NapCatTransport:
    def __init__(self, account: AccountConfig, connection: ConnectionConfig,
                 on_event: EventHandler, logger: Optional[logging.Logger] = None) -> None:
        self.account = account
        self.connection = connection
        self.on_event = on_event
        self.log = logger or logging.getLogger(__name__)
        self._pending: dict[str, _Pending] = {}
        self._send_lock = asyncio.Lock()
        self._ws: Optional[aiohttp.ClientWebSocketResponse] = None
        self._task: Optional[asyncio.Task[None]] = None
        self._stop = asyncio.Event()
        self._generation = 0
        self._reconnects = 0
        self._last_heartbeat = 0.0
        self._last_error = ""

    @property
    def connected(self) -> bool:
        return self._ws is not None and not self._ws.closed

    @property
    def reconnects(self) -> int:
        return self._reconnects

    @property
    def last_heartbeat(self) -> float:
        return self._last_heartbeat

    @property
    def pending_count(self) -> int:
        return len(self._pending)

    async def start(self) -> None:
        if self._task is None:
            self._stop.clear()
            self._task = asyncio.create_task(self._run(), name="qq-gateway-transport")

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        await self._close_ws()

    async def call(self, action: str, params: Optional[Mapping[str, Any]] = None,
                   timeout: Optional[float] = None) -> ActionResponse:
        if not self.connected:
            raise TransportClosed("napcat websocket is not connected")
        echo = uuid.uuid4().hex
        future: asyncio.Future[ActionResponse] = asyncio.get_running_loop().create_future()
        self._pending[echo] = _Pending(action=action, future=future)
        payload = {"action": action, "params": dict(params or {}), "echo": echo}
        try:
            async with self._send_lock:
                ws = self._ws
                if ws is None or ws.closed:
                    raise TransportClosed("napcat websocket closed before send")
                await ws.send_str(json.dumps(payload, ensure_ascii=False))
            wait_for = timeout if timeout is not None else self.connection.action_timeout_sec
            return await asyncio.wait_for(future, timeout=wait_for)
        except asyncio.TimeoutError as exc:
            raise ActionTimeout(f"action {action} timed out") from exc
        finally:
            self._pending.pop(echo, None)

    async def _run(self) -> None:
        attempt = 0
        while not self._stop.is_set():
            try:
                await self._connect_once()
                attempt = 0
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._last_error = redact_text(str(exc))
                self.log.warning(
                    "qq-gateway transport disconnected: %s", self._last_error
                )
            finally:
                await self._close_ws()
                self._fail_pending(TransportClosed(self._last_error or "transport closed"))
            if self._stop.is_set():
                break
            attempt += 1
            delay = self._backoff(attempt)
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=delay)
            except asyncio.TimeoutError:
                pass

    async def _connect_once(self) -> None:
        timeout = aiohttp.ClientTimeout(total=None, sock_connect=10)
        ws_timeout = aiohttp.ClientWSTimeout(ws_receive=self.connection.heartbeat_timeout_sec)
        headers = {}
        if self.account.ws_token:
            headers["Authorization"] = f"Bearer {self.account.ws_token}"
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.ws_connect(
                self.account.ws_url,
                headers=headers,
                heartbeat=self.connection.heartbeat_interval_sec,
                autoping=True,
                max_msg_size=self.connection.max_msg_size_mb * 1024 * 1024,
                timeout=ws_timeout,
            ) as ws:
                self._ws = ws
                self._generation += 1
                generation = self._generation
                self._reconnects += 1
                self._last_heartbeat = time.monotonic()
                self.log.info(
                    "qq-gateway connected to %s", _redacted_ws_url(self.account.ws_url)
                )
                async for message in ws:
                    if self._stop.is_set() or generation != self._generation:
                        break
                    if message.type == aiohttp.WSMsgType.TEXT:
                        await self._handle_text(message.data)
                    elif message.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED,
                                          aiohttp.WSMsgType.ERROR):
                        break
                await ws.close()

    async def _handle_text(self, raw: str) -> None:
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            self.log.warning("qq-gateway received non-json frame")
            return
        if not isinstance(payload, dict):
            return
        self._last_heartbeat = time.monotonic()
        echo = payload.get("echo")
        if echo and echo in self._pending:
            self._resolve(echo, payload)
            return
        task = asyncio.create_task(self._dispatch_event(payload))
        task.add_done_callback(self._log_event_error)

    def _resolve(self, echo: str, payload: dict[str, Any]) -> None:
        pending = self._pending[echo]
        stream = str(payload.get("stream") or "")
        data = payload.get("data")
        stream_type = data.get("type") if isinstance(data, dict) else None
        if stream == "stream-action" or stream_type in {"stream", "reset", "response", "error"}:
            if stream_type == "stream":
                pending.frames.append(payload)
                return
            if stream_type == "reset":
                pending.frames.clear()
                return
        response = ActionResponse(
            action=pending.action,
            status=str(payload.get("status") or ""),
            retcode=int(payload.get("retcode") or 0),
            data=data,
            message=str(payload.get("message") or ""),
            wording=str(payload.get("wording") or ""),
            echo=echo,
            stream=stream,
            frames=pending.frames + [payload],
        )
        if not pending.future.done():
            pending.future.set_result(response)

    async def _dispatch_event(self, payload: dict[str, Any]) -> None:
        try:
            await self.on_event(payload)
        except Exception as exc:
            self.log.error(
                "qq-gateway event handler failed: %s",
                redact_text(str(exc)),
                exc_info=True,
            )

    def _log_event_error(self, task: asyncio.Task[None]) -> None:
        try:
            task.result()
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            self.log.error(
                "qq-gateway event task failed: %s",
                redact_text(str(exc)),
                exc_info=True,
            )

    def _fail_pending(self, exc: Exception) -> None:
        for pending in list(self._pending.values()):
            if not pending.future.done():
                pending.future.set_exception(exc)
        self._pending.clear()

    async def _close_ws(self) -> None:
        ws = self._ws
        self._ws = None
        if ws is not None and not ws.closed:
            try:
                await ws.close()
            except Exception:
                pass

    def _backoff(self, attempt: int) -> float:
        base = min(self.connection.reconnect_max_sec,
                   self.connection.reconnect_min_sec * (2 ** min(attempt, 8)))
        return base * (0.8 + random.random() * 0.4)
