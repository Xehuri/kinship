"""P2P DataChannel 帧协议（Phase 2）。

WebRTC 数据面是可选能力（依赖见 ``backend/requirements-p2p.txt``）；本模块只
依赖标准库，未安装 aiortc 时也可导入、可单测。协议边界：

- 文本帧：``audio_meta``、``ack``、``event``
- 二进制帧：12 字节大端头 + 音频分片

所有尺寸/数量上限都在解码与装配边界校验；超过上限一律抛 ``ProtocolError``，
由会话层回 NACK，不把畸形数据送进入库路径。
"""

from __future__ import annotations

# allow: SIZE_OK - 单一 DataChannel 线协议；分块编码/装配/ACK 共享同一组上限。

import json
import struct
import time
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Optional

DATACHANNEL_LABEL = "axeuh-data"
MESSAGE_TYPE_AUDIO_META = "audio_meta"
MESSAGE_TYPE_ACK = "ack"
MESSAGE_TYPE_EVENT = "event"

CHUNK_MAGIC = 1
CHUNK_KIND_AUDIO = 1
# 大端：magic(B) kind(B) reserved(H) message_id(I) chunk_index(H) chunk_count(H)
CHUNK_HEADER = struct.Struct(">BBHIHH")
CHUNK_HEADER_SIZE = CHUNK_HEADER.size

MAX_FRAME_BYTES = 16384
MAX_MESSAGE_BYTES = 8 * 1024 * 1024
MAX_CHUNKS = 4096
ASSEMBLY_TIMEOUT_SECONDS = 60.0
MAX_PENDING_ASSEMBLIES = 8

SUPPORTED_FORMATS = frozenset({"wav", "flac"})
_UINT32_MAX = 0xFFFF_FFFF
_INT64_MIN = -(2**63)
_INT64_MAX = 2**63 - 1


class ProtocolError(ValueError):
    """数据面帧非法（会话层据此回 NACK）。"""


def _require_int(value: Any, name: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ProtocolError(f"{name} must be an integer")
    if not (minimum <= value <= maximum):
        raise ProtocolError(f"{name} out of range")
    return value


def _parse_json_object(text: Any) -> dict[str, Any]:
    if isinstance(text, (bytes, bytearray)):
        try:
            text = bytes(text).decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ProtocolError("text frame is not utf-8") from exc
    if not isinstance(text, str):
        raise ProtocolError("text frame must be a string")
    try:
        data = json.loads(text)
    except (TypeError, ValueError) as exc:
        raise ProtocolError("invalid json") from exc
    if not isinstance(data, dict):
        raise ProtocolError("message must be an object")
    return data


def _dump_json(data: dict[str, Any]) -> str:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


def parse_json_object_safe(text: Any) -> Optional[dict[str, Any]]:
    """解析文本帧，非法 JSON/非对象返回 None（会话层只记录类型）。"""
    try:
        return _parse_json_object(text)
    except ProtocolError:
        return None


@dataclass(frozen=True, slots=True)
class AudioMeta:
    """一段音频的元数据（文本帧 ``audio_meta``）。"""

    message_id: int
    session_id: str
    seq: int
    start_ms: int
    client_time: str
    format: str
    size: int
    chunks: int

    @classmethod
    def from_dict(
        cls,
        data: Mapping[str, Any],
        *,
        max_message_bytes: int = MAX_MESSAGE_BYTES,
        max_chunks: int = MAX_CHUNKS,
    ) -> "AudioMeta":
        if not isinstance(data, Mapping):
            raise ProtocolError("audio_meta must be an object")
        if data.get("type") != MESSAGE_TYPE_AUDIO_META:
            raise ProtocolError("not an audio_meta message")
        session_id = data.get("session_id")
        client_time = data.get("client_time")
        fmt = data.get("format")
        if not isinstance(session_id, str):
            raise ProtocolError("session_id must be a string")
        if not isinstance(client_time, str):
            raise ProtocolError("client_time must be a string")
        if not isinstance(fmt, str) or fmt.lower() not in SUPPORTED_FORMATS:
            raise ProtocolError("format must be wav or flac")
        return cls(
            message_id=_require_int(
                data.get("message_id"), "message_id", 0, _UINT32_MAX
            ),
            session_id=session_id,
            seq=_require_int(data.get("seq"), "seq", _INT64_MIN, _INT64_MAX),
            start_ms=_require_int(
                data.get("start_ms"), "start_ms", 1, _INT64_MAX
            ),
            client_time=client_time,
            format=fmt.lower(),
            size=_require_int(data.get("size"), "size", 1, max_message_bytes),
            chunks=_require_int(data.get("chunks"), "chunks", 1, max_chunks),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "type": MESSAGE_TYPE_AUDIO_META,
            "message_id": self.message_id,
            "session_id": self.session_id,
            "seq": self.seq,
            "start_ms": self.start_ms,
            "client_time": self.client_time,
            "format": self.format,
            "size": self.size,
            "chunks": self.chunks,
        }

    @classmethod
    def from_json(cls, text: Any) -> "AudioMeta":
        return cls.from_dict(_parse_json_object(text))

    def to_json(self) -> str:
        return _dump_json(self.to_dict())


@dataclass(frozen=True, slots=True)
class AudioChunk:
    message_id: int
    chunk_index: int
    chunk_count: int
    payload: bytes


def encode_chunk(
    message_id: int,
    chunk_index: int,
    chunk_count: int,
    payload: bytes,
    *,
    max_frame_bytes: int = MAX_FRAME_BYTES,
    max_chunks: int = MAX_CHUNKS,
) -> bytes:
    """编码一个音频分片；参数非法时抛 ``ProtocolError``。"""
    message_id = _require_int(message_id, "message_id", 0, _UINT32_MAX)
    chunk_count = _require_int(chunk_count, "chunk_count", 1, max_chunks)
    chunk_index = _require_int(chunk_index, "chunk_index", 0, chunk_count - 1)
    if not isinstance(payload, (bytes, bytearray)):
        raise ProtocolError("payload must be bytes")
    payload = bytes(payload)
    if not payload or len(payload) > max_frame_bytes:
        raise ProtocolError("payload size out of range")
    header = CHUNK_HEADER.pack(
        CHUNK_MAGIC, CHUNK_KIND_AUDIO, 0, message_id, chunk_index, chunk_count
    )
    return header + payload


def decode_chunk(
    data: bytes,
    *,
    max_frame_bytes: int = MAX_FRAME_BYTES,
    max_chunks: int = MAX_CHUNKS,
) -> AudioChunk:
    """解码一个音频分片；头部或长度非法时抛 ``ProtocolError``。"""
    if not isinstance(data, (bytes, bytearray, memoryview)):
        raise ProtocolError("binary frame must be bytes")
    data = bytes(data)
    if len(data) <= CHUNK_HEADER_SIZE:
        raise ProtocolError("chunk is too short")
    magic, kind, reserved, message_id, chunk_index, chunk_count = CHUNK_HEADER.unpack(
        data[:CHUNK_HEADER_SIZE]
    )
    if magic != CHUNK_MAGIC:
        raise ProtocolError("bad chunk magic")
    if kind != CHUNK_KIND_AUDIO:
        raise ProtocolError("bad chunk kind")
    if reserved != 0:
        raise ProtocolError("reserved field must be zero")
    if not (1 <= chunk_count <= max_chunks):
        raise ProtocolError("chunk_count out of range")
    if chunk_index >= chunk_count:
        raise ProtocolError("chunk_index out of range")
    payload = data[CHUNK_HEADER_SIZE:]
    if len(payload) > max_frame_bytes:
        raise ProtocolError("chunk payload too large")
    return AudioChunk(message_id, chunk_index, chunk_count, payload)


@dataclass(frozen=True, slots=True)
class EventEnvelope:
    """感知事件文本帧（``event``）。``message_id`` 仅用于 ACK 关联。"""

    event_type: str
    payload: dict[str, Any]
    ts: Optional[str] = None
    message_id: int = 0

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "EventEnvelope":
        if not isinstance(data, Mapping):
            raise ProtocolError("event must be an object")
        if data.get("type") != MESSAGE_TYPE_EVENT:
            raise ProtocolError("not an event message")
        event_type = data.get("event_type")
        payload = data.get("payload")
        ts = data.get("ts")
        if not isinstance(event_type, str) or not event_type:
            raise ProtocolError("event_type must be a non-empty string")
        if len(event_type) > 64:
            raise ProtocolError("event_type is too long")
        if not isinstance(payload, dict):
            raise ProtocolError("payload must be an object")
        if ts is not None and not isinstance(ts, str):
            raise ProtocolError("ts must be a string or null")
        message_id = data.get("message_id", 0)
        return cls(
            event_type=event_type,
            payload=payload,
            ts=ts,
            message_id=_require_int(message_id, "message_id", 0, _UINT32_MAX),
        )

    @classmethod
    def from_json(cls, text: Any) -> "EventEnvelope":
        return cls.from_dict(_parse_json_object(text))

    def to_dict(self) -> dict[str, Any]:
        return {
            "type": MESSAGE_TYPE_EVENT,
            "event_type": self.event_type,
            "payload": dict(self.payload),
            "ts": self.ts,
        }

    def to_json(self) -> str:
        return _dump_json(self.to_dict())


def encode_ack(message_id: int, ok: bool, error: Optional[str] = None) -> str:
    """编码 ACK/NACK；失败时 ``error`` 只放稳定枚举，不带载荷内容。"""
    data: dict[str, Any] = {
        "type": MESSAGE_TYPE_ACK,
        "message_id": int(message_id),
        "ok": bool(ok),
    }
    if not ok:
        data["error"] = error or "failed"
    return _dump_json(data)


def parse_ack(text: Any) -> tuple[int, bool, Optional[str]]:
    data = _parse_json_object(text)
    if data.get("type") != MESSAGE_TYPE_ACK:
        raise ProtocolError("not an ack message")
    message_id = _require_int(
        data.get("message_id"), "message_id", 0, _UINT32_MAX
    )
    ok = data.get("ok")
    if not isinstance(ok, bool):
        raise ProtocolError("ok must be a boolean")
    error = data.get("error")
    if error is not None and not isinstance(error, str):
        raise ProtocolError("error must be a string")
    return message_id, ok, error


@dataclass(slots=True)
class _Assembly:
    meta: AudioMeta
    parts: dict[int, bytes]
    created: float
    received_bytes: int = 0


class ChunkAssembler:
    """按 ``message_id`` 装配乱序/重复到达的音频分片。"""

    def __init__(
        self,
        *,
        max_frame_bytes: int = MAX_FRAME_BYTES,
        max_message_bytes: int = MAX_MESSAGE_BYTES,
        max_chunks: int = MAX_CHUNKS,
        timeout_seconds: float = ASSEMBLY_TIMEOUT_SECONDS,
        max_pending: int = MAX_PENDING_ASSEMBLIES,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._max_frame_bytes = int(max_frame_bytes)
        self._max_message_bytes = int(max_message_bytes)
        self._max_chunks = int(max_chunks)
        self._timeout_seconds = float(timeout_seconds)
        self._max_pending = max(1, int(max_pending))
        self._max_pending_bytes = self._max_message_bytes * 2
        self._clock = clock
        self._pending: dict[int, _Assembly] = {}

    @property
    def pending_count(self) -> int:
        return len(self._pending)

    def has_meta(self, message_id: int) -> bool:
        return int(message_id) in self._pending

    def set_meta(self, meta: AudioMeta) -> None:
        self.expire()
        if meta.chunks > self._max_chunks:
            raise ProtocolError("chunks exceeds configured limit")
        if meta.size > self._max_message_bytes:
            raise ProtocolError("size exceeds configured limit")
        if meta.size > meta.chunks * self._max_frame_bytes:
            raise ProtocolError("size exceeds chunk capacity")
        if meta.message_id not in self._pending and len(self._pending) >= self._max_pending:
            raise ProtocolError("too many pending audio assemblies")
        self._pending[meta.message_id] = _Assembly(
            meta=meta, parts={}, created=self._clock()
        )

    def add(self, chunk: AudioChunk) -> Optional[tuple[AudioMeta, bytes]]:
        """加入分片；未收齐返回 None，收齐返回 ``(meta, payload)``。"""
        self.expire()
        assembly = self._pending.get(chunk.message_id)
        if assembly is None:
            raise ProtocolError("audio_meta not received")
        if chunk.chunk_count != assembly.meta.chunks:
            raise ProtocolError("chunk_count mismatch")
        previous = assembly.parts.get(chunk.chunk_index)
        if previous is not None:
            if previous != chunk.payload:
                raise ProtocolError("duplicate chunk payload mismatch")
            return None
        if assembly.received_bytes + len(chunk.payload) > self._max_message_bytes:
            self._pending.pop(chunk.message_id, None)
            raise ProtocolError("assembled bytes exceed configured limit")
        pending_bytes = sum(
            item.received_bytes for item in self._pending.values()
        )
        if pending_bytes + len(chunk.payload) > self._max_pending_bytes:
            self._pending.pop(chunk.message_id, None)
            raise ProtocolError("pending audio bytes exceed configured limit")
        assembly.parts[chunk.chunk_index] = chunk.payload
        assembly.received_bytes += len(chunk.payload)
        if len(assembly.parts) < assembly.meta.chunks:
            return None
        payload = b"".join(
            assembly.parts[index] for index in range(assembly.meta.chunks)
        )
        if len(payload) != assembly.meta.size:
            self._pending.pop(chunk.message_id, None)
            raise ProtocolError("assembled size mismatch")
        self._pending.pop(chunk.message_id, None)
        return assembly.meta, payload

    def discard(self, message_id: int) -> None:
        self._pending.pop(int(message_id), None)

    def expire(self, now: Optional[float] = None) -> int:
        """丢弃超时未收齐的装配；返回丢弃数量。"""
        current = self._clock() if now is None else now
        expired = [
            message_id
            for message_id, assembly in self._pending.items()
            if current - assembly.created > self._timeout_seconds
        ]
        for message_id in expired:
            self._pending.pop(message_id, None)
        return len(expired)
