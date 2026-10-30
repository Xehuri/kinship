# -*- coding: utf-8 -*-
"""DataChannel 帧协议：编码/解码/装配边界，无需 aiortc。"""
import json

import pytest

from services.p2p.protocol import (
    CHUNK_HEADER_SIZE,
    MAX_CHUNKS,
    AudioMeta,
    ChunkAssembler,
    EventEnvelope,
    ProtocolError,
    decode_chunk,
    encode_ack,
    encode_chunk,
    parse_ack,
    parse_json_object_safe,
)


def _meta(message_id=7, size=10, chunks=2, **overrides):
    raw = {
        "type": "audio_meta",
        "message_id": message_id,
        "session_id": "session-1",
        "seq": 3,
        "start_ms": 1_700_000_000_000,
        "client_time": "2026-10-23T12:00:00+08:00",
        "format": "wav",
        "size": size,
        "chunks": chunks,
    }
    raw.update(overrides)
    return AudioMeta.from_dict(raw)


def test_chunk_roundtrip_uses_big_endian_12_byte_header():
    payload = b"\x01\x02\x03"
    frame = encode_chunk(0x01020304, 1, 2, payload)

    assert len(frame) == CHUNK_HEADER_SIZE + len(payload)
    assert frame[:12] == b"\x01\x01\x00\x00\x01\x02\x03\x04\x00\x01\x00\x02"
    chunk = decode_chunk(frame)
    assert chunk.message_id == 0x01020304
    assert (chunk.chunk_index, chunk.chunk_count) == (1, 2)
    assert chunk.payload == payload


def test_chunk_limits_and_header_validation():
    with pytest.raises(ProtocolError):
        encode_chunk(1, 0, 1, b"")
    with pytest.raises(ProtocolError):
        encode_chunk(1, 0, 1, b"x" * 16385)
    with pytest.raises(ProtocolError):
        encode_chunk(1, 2, 2, b"x")
    with pytest.raises(ProtocolError):
        encode_chunk(1, 0, MAX_CHUNKS + 1, b"x")

    good = encode_chunk(1, 0, 1, b"x")
    for bad in (
        b"\x02" + good[1:],  # bad magic
        good[:1] + b"\x02" + good[2:],  # bad kind
        good[:2] + b"\x00\x01" + good[4:],  # reserved != 0
        good[:12] + b"y" * 16385,  # oversize payload
        good[:10] + b"\x00\x02",  # index == count
        good[:10] + b"\x00\x00",  # count == 0
    ):
        with pytest.raises(ProtocolError):
            decode_chunk(bad)
    with pytest.raises(ProtocolError):
        decode_chunk(good[:12])
    with pytest.raises(ProtocolError):
        decode_chunk("not-bytes")


def test_audio_meta_json_roundtrip_and_format_validation():
    meta = _meta(size=10, chunks=2)
    assert AudioMeta.from_json(meta.to_json()) == meta

    with pytest.raises(ProtocolError):
        _meta(format="mp3")
    with pytest.raises(ProtocolError):
        _meta(size=0)
    with pytest.raises(ProtocolError):
        _meta(chunks=0)
    with pytest.raises(ProtocolError):
        _meta(message_id=-1)
    with pytest.raises(ProtocolError):
        AudioMeta.from_json('{"type":"audio_meta"}')


def test_audio_meta_rejects_non_positive_start_ms():
    for start_ms in (0, -1):
        with pytest.raises(ProtocolError):
            _meta(start_ms=start_ms)
    assert _meta(start_ms=1).start_ms == 1
    with pytest.raises(ProtocolError):
        AudioMeta.from_json("[]")


def test_assembler_out_of_order_and_duplicate_chunks():
    assembler = ChunkAssembler()
    assembler.set_meta(_meta(size=6, chunks=2))

    second = encode_chunk(7, 1, 2, b"def")
    first = encode_chunk(7, 0, 2, b"abc")

    assert assembler.add(decode_chunk(second)) is None
    assert assembler.add(decode_chunk(second)) is None  # duplicate ignored
    result = assembler.add(decode_chunk(first))

    assert result is not None
    meta, payload = result
    assert meta.message_id == 7
    assert payload == b"abcdef"
    assert assembler.pending_count == 0


def test_assembler_duplicate_with_different_payload_is_rejected():
    assembler = ChunkAssembler()
    assembler.set_meta(_meta(size=6, chunks=2))
    assembler.add(decode_chunk(encode_chunk(7, 0, 2, b"abc")))

    with pytest.raises(ProtocolError):
        assembler.add(decode_chunk(encode_chunk(7, 0, 2, b"xyz")))


def test_assembler_requires_meta_and_matching_count():
    assembler = ChunkAssembler()
    with pytest.raises(ProtocolError):
        assembler.add(decode_chunk(encode_chunk(7, 0, 1, b"abc")))

    assembler.set_meta(_meta(size=6, chunks=2))
    with pytest.raises(ProtocolError):
        assembler.add(decode_chunk(encode_chunk(7, 0, 1, b"abc")))


def test_assembler_rejects_oversize_meta_and_size_mismatch():
    assembler = ChunkAssembler(max_frame_bytes=4, max_message_bytes=100)
    with pytest.raises(ProtocolError):
        assembler.set_meta(_meta(size=101, chunks=1))

    with pytest.raises(ProtocolError):
        assembler.set_meta(_meta(size=10, chunks=2))

    assembler.set_meta(_meta(size=5, chunks=2))
    assembler.add(decode_chunk(encode_chunk(7, 0, 2, b"abc")))
    with pytest.raises(ProtocolError):
        assembler.add(decode_chunk(encode_chunk(7, 1, 2, b"def")))
    assert assembler.pending_count == 0


def test_assembler_rejects_cumulative_bytes_above_limit():
    assembler = ChunkAssembler(max_frame_bytes=4, max_message_bytes=5)
    assembler.set_meta(_meta(size=5, chunks=2))
    assembler.add(decode_chunk(encode_chunk(7, 0, 2, b"abcd")))

    with pytest.raises(ProtocolError):
        assembler.add(decode_chunk(encode_chunk(7, 1, 2, b"ef")))
    assert assembler.pending_count == 0


def test_assembler_rejects_pending_bytes_above_session_cap():
    assembler = ChunkAssembler(max_frame_bytes=4, max_message_bytes=5)
    for message_id in (1, 2, 3):
        assembler.set_meta(_meta(message_id=message_id, size=5, chunks=2))
    assembler.add(decode_chunk(encode_chunk(1, 0, 2, b"abcd")))
    assembler.add(decode_chunk(encode_chunk(2, 0, 2, b"abcd")))

    with pytest.raises(ProtocolError):
        assembler.add(decode_chunk(encode_chunk(3, 0, 2, b"abcd")))


def test_assembler_expires_incomplete_assemblies():
    now = [100.0]
    assembler = ChunkAssembler(clock=lambda: now[0])
    assembler.set_meta(_meta(size=6, chunks=2))
    assembler.add(decode_chunk(encode_chunk(7, 0, 2, b"abc")))

    now[0] += 59.0
    assert assembler.expire() == 0
    now[0] += 2.0
    assert assembler.expire() == 1
    assert assembler.pending_count == 0
    with pytest.raises(ProtocolError):
        assembler.add(decode_chunk(encode_chunk(7, 1, 2, b"def")))


def test_assembler_limits_pending_messages():
    assembler = ChunkAssembler(max_pending=1)
    assembler.set_meta(_meta(message_id=1, size=1, chunks=1))
    with pytest.raises(ProtocolError):
        assembler.set_meta(_meta(message_id=2, size=1, chunks=1))


def test_event_roundtrip_and_validation():
    event = EventEnvelope.from_dict(
        {
            "type": "event",
            "event_type": "screen",
            "payload": {"on": True},
            "ts": "12:00:00",
        }
    )
    assert event.event_type == "screen"
    assert event.ts == "12:00:00"
    assert json.loads(event.to_json()) == {
        "type": "event",
        "event_type": "screen",
        "payload": {"on": True},
        "ts": "12:00:00",
    }

    with pytest.raises(ProtocolError):
        EventEnvelope.from_dict({"type": "event", "event_type": "", "payload": {}})
    with pytest.raises(ProtocolError):
        EventEnvelope.from_dict(
            {"type": "event", "event_type": "x", "payload": []}
        )
    with pytest.raises(ProtocolError):
        EventEnvelope.from_dict(
            {"type": "event", "event_type": "x", "payload": {}, "ts": 1}
        )


def test_ack_format_and_parsing():
    assert json.loads(encode_ack(3, True)) == {
        "type": "ack",
        "message_id": 3,
        "ok": True,
    }
    assert json.loads(encode_ack(3, False, "assembled size mismatch")) == {
        "type": "ack",
        "message_id": 3,
        "ok": False,
        "error": "assembled size mismatch",
    }
    assert parse_ack(encode_ack(3, True)) == (3, True, None)
    with pytest.raises(ProtocolError):
        parse_ack('{"type":"ack","message_id":1,"ok":"yes"}')


def test_parse_json_object_safe_returns_none_for_bad_input():
    assert parse_json_object_safe('{"type":"x"}') == {"type": "x"}
    assert parse_json_object_safe("not-json") is None
    assert parse_json_object_safe("[]") is None
    assert parse_json_object_safe(b'{"type":"x"}') == {"type": "x"}
