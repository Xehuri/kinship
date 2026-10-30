"""WebRTC 数据面（Phase 2，默认关闭）。

aiortc 只在真正构造会话/管理器时懒导入：未安装 aiortc（生产
``backend/requirements.txt`` 不含它）时本模块可正常导入，P2P 信令仍按 Phase 1
工作。需要 WebRTC 时安装 ``backend/requirements-p2p.txt``。

安全边界：不打印 SDP/ICE/candidate/音频内容，只记录设备与消息类型。
"""

from __future__ import annotations

# allow: SIZE_OK - aiortc session 与 peer 管理器共享连接/任务生命周期。

import asyncio
import contextlib
import logging
from typing import Any, Awaitable, Callable, Mapping, Optional

from services.p2p.config import P2PConfig
from services.p2p.protocol import (
    DATACHANNEL_LABEL,
    MAX_CHUNKS,
    AudioMeta,
    ChunkAssembler,
    EventEnvelope,
    ProtocolError,
    decode_chunk,
    encode_ack,
    parse_json_object_safe,
)

logger = logging.getLogger(__name__)

SignalSender = Callable[[dict[str, Any]], Awaitable[bool]]
AudioIngest = Callable[[str, AudioMeta, bytes], Awaitable[bool]]
EventIngest = Callable[[str, EventEnvelope], Awaitable[bool]]
DeviceLookup = Callable[[str], Any]

_MAX_SESSIONS = 16
_MAX_PENDING_ICE = 64

_aiortc_module: Any = None
_aiortc_unavailable = False


class WebRtcUnavailableError(RuntimeError):
    """aiortc 未安装（fail-open：保留 Phase 1 信令）。"""


def _load_aiortc() -> Any:
    global _aiortc_module, _aiortc_unavailable
    if _aiortc_module is not None:
        return _aiortc_module
    if _aiortc_unavailable:
        raise WebRtcUnavailableError("aiortc is not installed")
    try:
        import aiortc  # noqa: PLC0415 - optional dependency, lazy on purpose
    except ImportError as exc:
        _aiortc_unavailable = True
        raise WebRtcUnavailableError("aiortc is not installed") from exc
    _aiortc_module = aiortc
    return aiortc


def webrtc_available() -> bool:
    try:
        _load_aiortc()
    except WebRtcUnavailableError:
        return False
    return True


def _build_rtc_config(aiortc: Any, config: P2PConfig) -> Any:
    servers = list(config.webrtc_stun_servers)
    ice_servers = [aiortc.RTCIceServer(urls=servers)] if servers else []
    return aiortc.RTCConfiguration(iceServers=ice_servers)


def _extract_sdp(payload: Any) -> str:
    if isinstance(payload, str):
        return payload.strip()
    if isinstance(payload, Mapping):
        sdp = payload.get("sdp")
        if isinstance(sdp, str):
            return sdp.strip()
    return ""


def _ice_candidate_from_payload(payload: Mapping[str, Any]) -> Any:
    """把 Android 的 ``candidate:...`` 文本解析成 aiortc 候选对象。

    aiortc 1.15 的 ``RTCIceCandidate`` 只接受结构化字段，不接收原始文本，
    因此必须经 ``candidate_from_sdp`` 解析。解析失败统一转成
    ``ProtocolError``，调用方只记录设备与错误类。
    """
    from aiortc.sdp import candidate_from_sdp  # noqa: PLC0415 - optional dependency

    raw = payload.get("candidate")
    if not isinstance(raw, str):
        raise ProtocolError("ice candidate is not a string")
    text = raw.strip()
    if text.startswith("candidate:"):
        text = text[len("candidate:") :]
    try:
        candidate = candidate_from_sdp(text)
    except (AssertionError, IndexError, ValueError) as exc:
        raise ProtocolError("ice candidate is malformed") from exc
    sdp_mid = payload.get("sdpMid")
    if isinstance(sdp_mid, str) and sdp_mid:
        candidate.sdpMid = sdp_mid
    sdp_index = payload.get("sdpMLineIndex")
    if isinstance(sdp_index, int) and not isinstance(sdp_index, bool):
        candidate.sdpMLineIndex = sdp_index
    if candidate.sdpMid is None and candidate.sdpMLineIndex is None:
        raise ProtocolError("ice candidate missing sdpMid and sdpMLineIndex")
    return candidate


class WebRtcSession:
    """单个设备的一条 aiortc 连接。"""

    def __init__(
        self,
        device_id: str,
        send_signal: SignalSender,
        ingest_audio: AudioIngest,
        ingest_event: EventIngest,
        config: P2PConfig,
    ) -> None:
        aiortc = _load_aiortc()
        self.device_id = str(device_id)
        self._send_signal = send_signal
        self._ingest_audio = ingest_audio
        self._ingest_event = ingest_event
        self._max_frame_bytes = int(config.webrtc_max_frame_bytes)
        self._max_message_bytes = int(config.webrtc_max_message_bytes)
        self._assembler = ChunkAssembler(
            max_frame_bytes=self._max_frame_bytes,
            max_message_bytes=self._max_message_bytes,
            max_chunks=MAX_CHUNKS,
            timeout_seconds=float(config.webrtc_ack_timeout_seconds),
        )
        self._pc = aiortc.RTCPeerConnection(_build_rtc_config(aiortc, config))
        self._pc.on("icecandidate", self._on_ice_candidate)
        self._pc.on("datachannel", self._on_datachannel)
        self._pc.on("connectionstatechange", self._on_connection_state)
        self._channel: Any = None
        self._closed = False
        self._tasks: set[asyncio.Task[Any]] = set()
        self._remote_description_set = False
        self._pending_ice: list[Any] = []

    @property
    def closed(self) -> bool:
        return self._closed

    @property
    def remote_description_set(self) -> bool:
        return self._remote_description_set

    @property
    def pending_ice_count(self) -> int:
        return len(self._pending_ice)

    async def handle_offer(self, sdp: str) -> dict[str, str]:
        if self._closed:
            raise WebRtcUnavailableError("session is closed")
        if not isinstance(sdp, str) or not sdp.strip():
            raise ProtocolError("offer sdp is empty")
        aiortc = _load_aiortc()
        await self._pc.setRemoteDescription(
            aiortc.RTCSessionDescription(sdp=sdp, type="offer")
        )
        self._remote_description_set = True
        await self._drain_pending_ice()
        answer = await self._pc.createAnswer()
        await self._pc.setLocalDescription(answer)
        local = self._pc.localDescription
        return {"sdp": local.sdp, "type": "answer"}

    async def add_ice(self, payload: Mapping[str, Any]) -> None:
        if self._closed or not isinstance(payload, Mapping):
            return
        if not payload.get("candidate"):
            return
        try:
            candidate = _ice_candidate_from_payload(payload)
        except ProtocolError as exc:
            logger.warning(
                "[P2P] WebRTC ICE 候选非法 device_id=%s error=%s",
                self.device_id,
                type(exc.__cause__ or exc).__name__,
            )
            return
        if not self._remote_description_set:
            if len(self._pending_ice) >= _MAX_PENDING_ICE:
                raise ProtocolError("too many pending ice candidates")
            self._pending_ice.append(candidate)
            return
        await self._pc.addIceCandidate(candidate)

    async def _drain_pending_ice(self) -> None:
        pending, self._pending_ice = self._pending_ice, []
        for candidate in pending:
            if self._closed:
                return
            try:
                await self._pc.addIceCandidate(candidate)
            except Exception as exc:  # noqa: BROAD_EXCEPT_OK - aiortc boundary
                logger.warning(
                    "[P2P] WebRTC 排队 ICE 应用失败 device_id=%s error=%s",
                    self.device_id,
                    type(exc).__name__,
                )

    def _spawn(self, coro: Awaitable[Any]) -> None:
        task = asyncio.ensure_future(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    def _on_ice_candidate(self, candidate: Any) -> None:
        # aiortc 目前把候选直接写进 SDP（无 trickle 事件）；保留该钩子兼容
        # 未来版本或替身实现。
        if candidate is None or self._closed:
            return
        payload = {
            "candidate": candidate.candidate,
            "sdpMid": candidate.sdpMid,
            "sdpMLineIndex": candidate.sdpMLineIndex,
        }
        self._spawn(
            self._send_signal(
                {"type": "ice", "to": self.device_id, "payload": payload}
            )
        )

    def _on_datachannel(self, channel: Any) -> None:
        if channel.label != DATACHANNEL_LABEL:
            logger.warning(
                "[P2P] WebRTC 忽略非预期 DataChannel device_id=%s", self.device_id
            )
            with contextlib.suppress(Exception):
                channel.close()
            return
        self._channel = channel
        channel.on("message", self._on_message)
        logger.info("[P2P] WebRTC DataChannel 已建立 device_id=%s", self.device_id)

    def _on_connection_state(self) -> None:
        state = str(getattr(self._pc, "connectionState", "") or "")
        if state in {"failed", "closed"}:
            logger.info(
                "[P2P] WebRTC 连接结束 device_id=%s state=%s", self.device_id, state
            )
            if not self._closed:
                self._spawn(self.close())
        else:
            logger.debug(
                "[P2P] WebRTC 连接状态 device_id=%s state=%s", self.device_id, state
            )

    async def _on_message(self, message: Any) -> None:
        if self._closed:
            return
        try:
            if isinstance(message, (bytes, bytearray, memoryview)):
                await self._handle_chunk(bytes(message))
            elif isinstance(message, str):
                await self._handle_text(message)
            else:
                logger.warning(
                    "[P2P] WebRTC 收到不支持的消息类型 device_id=%s", self.device_id
                )
        except Exception as exc:  # noqa: BROAD_EXCEPT_OK - datachannel boundary
            logger.warning(
                "[P2P] WebRTC 消息处理失败 device_id=%s error=%s",
                self.device_id,
                type(exc).__name__,
            )

    async def _handle_text(self, text: str) -> None:
        data = parse_json_object_safe(text)
        if data is None:
            logger.warning(
                "[P2P] WebRTC 文本帧非法 device_id=%s", self.device_id
            )
            return
        kind = data.get("type")
        if kind == "audio_meta":
            await self._handle_meta(data)
        elif kind == "event":
            await self._handle_event(data)
        else:
            logger.debug(
                "[P2P] WebRTC 忽略文本帧 device_id=%s type=%s",
                self.device_id,
                kind if isinstance(kind, str) else "?",
            )

    async def _handle_meta(self, data: Mapping[str, Any]) -> None:
        try:
            meta = AudioMeta.from_dict(
                data,
                max_message_bytes=self._max_message_bytes,
                max_chunks=MAX_CHUNKS,
            )
            self._assembler.set_meta(meta)
        except ProtocolError as exc:
            raw_id = data.get("message_id")
            if isinstance(raw_id, int) and not isinstance(raw_id, bool):
                await self._send_ack(raw_id, False, str(exc))
            logger.warning(
                "[P2P] WebRTC audio_meta 非法 device_id=%s error=%s",
                self.device_id,
                str(exc),
            )

    async def _handle_chunk(self, data: bytes) -> None:
        try:
            chunk = decode_chunk(
                data,
                max_frame_bytes=self._max_frame_bytes,
                max_chunks=MAX_CHUNKS,
            )
        except ProtocolError as exc:
            logger.warning(
                "[P2P] WebRTC 音频分片非法 device_id=%s error=%s",
                self.device_id,
                str(exc),
            )
            return
        try:
            assembled = self._assembler.add(chunk)
        except ProtocolError as exc:
            await self._send_ack(chunk.message_id, False, str(exc))
            return
        if assembled is None:
            return
        meta, payload = assembled
        ok = await self._call_ingest_audio(meta, payload)
        await self._send_ack(
            meta.message_id, ok, None if ok else "ingest_failed"
        )

    async def _call_ingest_audio(self, meta: AudioMeta, payload: bytes) -> bool:
        try:
            return bool(await self._ingest_audio(self.device_id, meta, payload))
        except Exception as exc:  # noqa: BROAD_EXCEPT_OK - ingest boundary
            logger.warning(
                "[P2P] WebRTC 音频入库失败 device_id=%s error=%s",
                self.device_id,
                type(exc).__name__,
            )
            return False

    async def _handle_event(self, data: Mapping[str, Any]) -> None:
        try:
            event = EventEnvelope.from_dict(data)
        except ProtocolError as exc:
            logger.warning(
                "[P2P] WebRTC event 非法 device_id=%s error=%s",
                self.device_id,
                str(exc),
            )
            return
        try:
            ok = bool(await self._ingest_event(self.device_id, event))
        except Exception as exc:  # noqa: BROAD_EXCEPT_OK - ingest boundary
            logger.warning(
                "[P2P] WebRTC 事件入库失败 device_id=%s error=%s",
                self.device_id,
                type(exc).__name__,
            )
            ok = False
        await self._send_ack(
            event.message_id, ok, None if ok else "ingest_failed"
        )

    async def _send_ack(
        self, message_id: int, ok: bool, error: Optional[str]
    ) -> None:
        channel = self._channel
        if channel is None or getattr(channel, "readyState", "") != "open":
            return
        try:
            channel.send(encode_ack(message_id, ok, error))
        except Exception as exc:  # noqa: BROAD_EXCEPT_OK - best-effort ack
            logger.debug(
                "[P2P] WebRTC ACK 发送失败 device_id=%s error=%s",
                self.device_id,
                type(exc).__name__,
            )

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._pending_ice.clear()
        current = asyncio.current_task()
        tasks = [task for task in self._tasks if task is not current]
        self._tasks.clear()
        for task in tasks:
            task.cancel()
        for task in tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        channel, self._channel = self._channel, None
        if channel is not None:
            with contextlib.suppress(Exception):
                channel.close()
        with contextlib.suppress(Exception):
            await self._pc.close()


class WebRtcPeerManager:
    """按设备维护 WebRTC 会话，并把信令消息分派给对应会话。"""

    def __init__(
        self,
        config: P2PConfig,
        device_lookup: DeviceLookup,
        send_signal: SignalSender,
        ingest_audio: AudioIngest,
        ingest_event: EventIngest,
        *,
        max_sessions: int = _MAX_SESSIONS,
    ) -> None:
        _load_aiortc()
        self._config = config
        self._device_lookup = device_lookup
        self._send_signal = send_signal
        self._ingest_audio = ingest_audio
        self._ingest_event = ingest_event
        self._max_sessions = max(1, int(max_sessions))
        self._sessions: dict[str, WebRtcSession] = {}
        self._closed = False

    @property
    def session_count(self) -> int:
        return len(self._sessions)

    async def handle_signal(self, message: Mapping[str, Any]) -> None:
        if self._closed or not isinstance(message, Mapping):
            return
        kind = str(message.get("type") or "")
        try:
            if kind == "offer":
                await self._handle_offer(message)
            elif kind == "ice":
                await self._handle_ice(message)
            elif kind in {"bye", "peer_left"}:
                await self._handle_bye(message)
        except Exception as exc:  # noqa: BROAD_EXCEPT_OK - signaling boundary
            logger.warning(
                "[P2P] WebRTC 信令处理失败 type=%s error=%s",
                kind,
                type(exc).__name__,
            )
            return

    def _device_allowed(self, device_id: str) -> bool:
        try:
            record = self._device_lookup(device_id)
        except Exception:  # noqa: BROAD_EXCEPT_OK - lookup fails closed
            return False
        return record is not None and getattr(record, "revoked_at", None) is None

    async def _prune_closed(self) -> None:
        for device_id, session in list(self._sessions.items()):
            if session.closed:
                self._sessions.pop(device_id, None)
                await session.close()

    def _discard_session(self, device_id: str, session: WebRtcSession) -> None:
        if self._sessions.get(device_id) is session:
            self._sessions.pop(device_id, None)

    async def _handle_offer(self, message: Mapping[str, Any]) -> None:
        device_id = str(message.get("from") or "").strip()
        sdp = _extract_sdp(message.get("payload"))
        if not device_id or not sdp:
            return
        if not self._device_allowed(device_id):
            logger.warning(
                "[P2P] WebRTC offer 拒绝 device_id=%s reason=untrusted", device_id
            )
            await self._send_bye(device_id)
            return
        await self._prune_closed()
        if (
            device_id not in self._sessions
            and len(self._sessions) >= self._max_sessions
        ):
            logger.warning(
                "[P2P] WebRTC 会话数已达上限 device_id=%s max=%s",
                device_id,
                self._max_sessions,
            )
            await self._send_bye(device_id)
            return
        old = self._sessions.pop(device_id, None)
        if old is not None:
            await old.close()
        session = WebRtcSession(
            device_id,
            self._send_signal,
            self._ingest_audio,
            self._ingest_event,
            self._config,
        )
        # 先登记再协商：handle_offer 内的 ICE gathering 可能耗时数秒，期间到达的
        # trickle ICE 必须能找到会话（add_ice 会在远端描述就绪前排队）。
        self._sessions[device_id] = session
        try:
            answer = await session.handle_offer(sdp)
        except Exception:
            self._discard_session(device_id, session)
            await session.close()
            raise
        logger.info("[P2P] WebRTC 会话已建立 device_id=%s", device_id)
        try:
            sent = await self._send_signal(
                {"type": "answer", "to": device_id, "payload": answer}
            )
        except Exception:
            self._discard_session(device_id, session)
            await session.close()
            raise
        if sent:
            return
        self._discard_session(device_id, session)
        await session.close()
        logger.warning(
            "[P2P] WebRTC answer 发送失败，会话已关闭 device_id=%s", device_id
        )

    async def _handle_ice(self, message: Mapping[str, Any]) -> None:
        device_id = str(message.get("from") or "").strip()
        payload = message.get("payload")
        if not device_id or not isinstance(payload, Mapping):
            return
        if not self._device_allowed(device_id):
            logger.warning(
                "[P2P] WebRTC ice 拒绝 device_id=%s reason=untrusted", device_id
            )
            await self.close_device(device_id)
            return
        session = self._sessions.get(device_id)
        if session is not None:
            await session.add_ice(payload)

    async def close_device(self, device_id: str) -> None:
        session = self._sessions.pop(device_id, None)
        if session is not None:
            await session.close()

    async def _handle_bye(self, message: Mapping[str, Any]) -> None:
        device_id = str(
            message.get("from") or message.get("device_id") or ""
        ).strip()
        if not device_id:
            return
        session = self._sessions.pop(device_id, None)
        if session is not None:
            await session.close()
            logger.info("[P2P] WebRTC 会话已关闭 device_id=%s", device_id)

    async def _send_bye(self, device_id: str) -> None:
        # 客户端按「文本帧 + payload 对象」统一解析信令，bye 也必须带空对象。
        await self._send_signal(
            {"type": "bye", "to": device_id, "payload": {}}
        )

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        sessions = list(self._sessions.values())
        self._sessions.clear()
        if sessions:
            await asyncio.gather(
                *(session.close() for session in sessions),
                return_exceptions=True,
            )
