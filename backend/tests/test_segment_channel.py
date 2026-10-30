# -*- coding: utf-8 -*-
"""C5 切分通道 services/segment_channel.py 单测（假内核 WS，零网络零 spawn）。

锁定：
  1. open 帧形状：session.start {device_id, sample_rate, mode:"segment",
     t0_ms, segment:{rms_threshold, frame_ms, silence_cut_s, min_chunk_s,
     max_chunk_s}}（与内核 A6 契约逐键对齐）；
  2. 奇数字节保护：残余 1 字节跨 push 拼接，绝不把奇数帧发给内核；
   3. push 收割：segment.closed -> GET artifact -> WAV 解码 PCM -> HTTP
      DELETE artifact（消费即删上移契约面 P3-V15；外层零文件系统接触，
      state-dir 经 AXEUH_KERNEL_STATE_DIR 指向 tmp 做反向锁）；
  4. error 帧 / transport 关闭 -> 置死；随后 push 抛 SegmentChannelError；
  5. artifact 取回失败 -> 帧放回队列 + 置死，drain_pending 可重试同一帧；
  6. stop：发 session.stop、静默收帧、close 连接；stop 发送失败但已有帧 ->
     StopWithChunksError 携带已取回段（不丢音频）；
  7. open 失败（客户端 None / 参数非法）-> dead + 抛错。

假 WS 经 client_provider 注入（鸭子 KernelStreamWs：send_json/send_bytes/
receive/close），入站帧用 deque + 轮询交接（避开跨线程 asyncio 原语绑定）。
"""

from __future__ import annotations

import base64
import io
import json
import time
import wave
from collections import deque
from typing import Any, Dict, List, Optional

import pytest

import services.kernel_client as kc
from services.segment_channel import (
    SegmentChannel,
    SegmentChannelError,
    StopWithChunksError,
)


# ─── 合成工具 ───────────────────────────────────────────────

def _wav_bytes(pcm: bytes, rate: int = 16000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(pcm)
    return buf.getvalue()


def _pcm(seconds: float = 0.1) -> bytes:
    return b"\x01\x00" * int(16000 * seconds)


def _seg_closed_frame(art: str, start_ms: int, end_ms: int, seq: int = 1) -> str:
    return json.dumps({
        "type": "segment.closed",
        "artifact": art,
        "start_ms": start_ms,
        "end_ms": end_ms,
        "seq": seq,
    })


def _wait_until(pred, timeout: float = 2.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pred():
            return True
        time.sleep(0.02)
    return pred()


class _FakeWs:
    """KernelStreamWs 鸭子替身：记录出站；入站用 deque 跨线程交接（轮询）。"""

    def __init__(self) -> None:
        self.sent_json: List[dict] = []
        self.sent_bytes: List[bytes] = []
        self.closed = False
        self.fail_send = False
        self.inbound: "deque[tuple[str, Any]]" = deque()

    def push_frame(self, kind: str, data) -> None:
        self.inbound.append((kind, data))

    async def send_json(self, payload: Dict[str, Any]) -> None:
        if self.fail_send:
            raise RuntimeError("fake send_json 故障")
        self.sent_json.append(payload)

    async def send_bytes(self, data: bytes) -> None:
        if self.fail_send:
            raise RuntimeError("fake send_bytes 故障")
        self.sent_bytes.append(data)

    async def receive(self, timeout: Optional[float] = None) -> "tuple[str, Any]":
        deadline = time.monotonic() + (timeout or 30.0)
        while time.monotonic() < deadline:
            if self.inbound:
                return self.inbound.popleft()
            await _async_sleep(0.01)
        return ("timeout", None)

    async def close(self) -> None:
        self.closed = True


async def _async_sleep(s: float) -> None:
    import asyncio

    await asyncio.sleep(s)


class _FakeClient:
    """KernelClient 鸭子替身：ws_connect_stream + srequest（artifact GET/DELETE 面）。"""

    def __init__(self, ws: Optional[_FakeWs]) -> None:
        self._ws = ws
        self.connect_calls = 0
        self.artifacts: Dict[str, bytes] = {}     # id -> WAV 字节
        self.artifact_fail: set = set()           # 模拟取回失败的 id
        self.get_calls: List[str] = []
        self.delete_calls: List[str] = []         # V15：DELETE 调用面断言
        self.delete_exc: Optional[Exception] = None  # 注入删除失败（405/503/传输）

    async def ws_connect_stream(self, *, timeout: float = 0.5):
        self.connect_calls += 1
        return self._ws

    def srequest(self, method: str, path: str, *, json=None, timeout: float = 30.0):
        assert method in ("GET", "DELETE") and path.startswith("/v1/artifacts/")
        art = path.rsplit("/", 1)[-1]
        if method == "DELETE":
            self.delete_calls.append(art)
            if self.delete_exc is not None:
                raise self.delete_exc
            existed = art in self.artifacts
            self.artifacts.pop(art, None)
            return {"id": art, "deleted": existed}   # 契约 §8.1 幂等 200 形状
        self.get_calls.append(art)
        if art in self.artifact_fail:
            raise kc.KernelUnavailable("fake artifact GET 失败")
        data = self.artifacts.get(art)
        if data is None:
            raise kc.KernelHttpError(404, {"error": {"code": "input.not_found"}})
        return {"id": art, "content_b64": base64.b64encode(data).decode("ascii")}


@pytest.fixture
def kernel_state_dir(monkeypatch, tmp_path):
    """把内核 state-dir 指到 tmp（V15：仅用于"外层不触文件系统"反向锁）。"""
    monkeypatch.setenv("AXEUH_KERNEL_STATE_DIR", str(tmp_path))
    (tmp_path / "artifacts").mkdir(parents=True, exist_ok=True)
    return tmp_path / "artifacts"


def _make_channel(ws: Optional[_FakeWs], **kw) -> SegmentChannel:
    client = _FakeClient(ws)
    opts: Dict[str, Any] = dict(
        name="dev-x", t0_ms=1_757_836_800_000,
        rms_threshold=5.0, frame_ms=30, silence_cut_s=1.5,
        min_chunk_s=10.0, max_chunk_s=120.0,
    )
    opts.update(kw)
    ch = SegmentChannel(client_provider=lambda: client, **opts)
    ch._test_client = client  # type: ignore[attr-defined]
    return ch


# ============================================================
# 1. open 帧形状
# ============================================================

def test_open_sends_segment_session_start(kernel_state_dir):
    ws = _FakeWs()
    ch = _make_channel(ws)
    ch.open()
    assert ch.is_open
    assert ws.sent_json == [{
        "type": "session.start",
        "device_id": "dev-x",
        "sample_rate": 16000,
        "mode": "segment",
        "segment": {
            "rms_threshold": 5.0,
            "frame_ms": 30,
            "silence_cut_s": 1.5,
            "min_chunk_s": 10.0,
            "max_chunk_s": 120.0,
        },
        "t0_ms": 1_757_836_800_000,
    }]
    ch.close()
    assert ws.closed is True


def test_open_failure_marks_dead(kernel_state_dir):
    ch = _make_channel(None)   # ws_connect_stream 返回 None = 不可达
    with pytest.raises(SegmentChannelError):
        ch.open()
    assert ch.dead is True
    with pytest.raises(SegmentChannelError):
        ch.push(_pcm())


def test_rejects_non_16k_format():
    with pytest.raises(SegmentChannelError):
        SegmentChannel(sample_rate=8000)


# ============================================================
# 2. 奇数字节保护
# ============================================================

def test_odd_tail_preserved_across_pushes(kernel_state_dir):
    ws = _FakeWs()
    ch = _make_channel(ws)
    ch.open()
    ch.push(b"\x01")             # 1 字节：全部攒着，不发
    assert ws.sent_bytes == []
    ch.push(b"\x02")             # 攒够 2 字节：发 1 个完整样本
    assert ws.sent_bytes == [b"\x01\x02"]
    ch.close()


# ============================================================
# 3. push 收割 + artifact 取回与 HTTP 删除（P3-V15 契约面，W2 根除锁）
# ============================================================

def test_push_harvests_segment_closed_and_deletes_via_http(kernel_state_dir):
    ws = _FakeWs()
    ch = _make_channel(ws)
    client = ch._test_client
    pcm = _pcm(0.5)
    client.artifacts["art_test1"] = _wav_bytes(pcm)
    # state-dir 里放同名"残留"文件：V15 后外层绝不直删，必须原样存活（W2 反向锁）
    (kernel_state_dir / "art_test1.bin").write_bytes(b"x")
    (kernel_state_dir / "art_test1.meta.json").write_text("{}")

    ch.open()
    ws.push_frame("text", _seg_closed_frame("art_test1", 100, 600))
    chunks = ch.push(_pcm(0.1))

    assert len(chunks) == 1
    got = chunks[0]
    assert got.pcm == pcm and got.start_ms == 100 and got.end_ms == 600
    assert got.sample_count == len(pcm) // 2
    assert client.get_calls == ["art_test1"]
    # 消费即删上移契约面：DELETE 调用面（id 与 artifact 一致）
    assert client.delete_calls == ["art_test1"]
    # 外层零文件系统接触：state-dir 的直操痕迹必须不存在
    assert (kernel_state_dir / "art_test1.bin").read_bytes() == b"x"
    assert (kernel_state_dir / "art_test1.meta.json").read_text() == "{}"
    ch.close()


def test_delete_failure_never_breaks_chunk_delivery(kernel_state_dir):
    """K2a 裁定 WARNING-only：405（旧内核）/503/传输失败——段照常交付、不置死。"""
    cases = [
        kc.KernelHttpError(405, {"detail": "Method Not Allowed"}),
        kc.KernelHttpError(403, {"error": {"code": "auth.failed"}}),
        kc.KernelHttpError(503, {"error": {"code": "state.unavailable", "retryable": True}}),
        kc.KernelUnavailable("fake DELETE transport"),
    ]
    for i, exc in enumerate(cases):
        ws = _FakeWs()
        ch = _make_channel(ws)
        client = ch._test_client
        art = f"art_del{i}"
        pcm = _pcm(0.2)
        client.artifacts[art] = _wav_bytes(pcm)
        client.delete_exc = exc
        ch.open()
        ws.push_frame("text", _seg_closed_frame(art, 1, 201))
        chunks = ch.push(b"")
        assert len(chunks) == 1 and chunks[0].pcm == pcm, f"{exc} 不得吞段"
        assert ch.dead is False, f"{exc} 不得置死通道"
        assert client.delete_calls == [art]
        ch.close()


# ============================================================
# 4. error 帧 / transport 关闭 -> dead
# ============================================================

def test_error_frame_marks_dead_on_next_collect(kernel_state_dir):
    ws = _FakeWs()
    ch = _make_channel(ws)
    ch.open()
    ws.push_frame("text", json.dumps(
        {"error": {"code": "state.unavailable", "message": "x", "retryable": True}}))
    # error 帧在读循环入队后，由下一次收割（空 push）消费并置死
    ch.push(b"")
    assert ch.dead is True
    with pytest.raises(SegmentChannelError):
        ch.push(_pcm())
    ch.close()


def test_transport_close_marks_dead(kernel_state_dir):
    ws = _FakeWs()
    ch = _make_channel(ws)
    ch.open()
    ws.push_frame("closed", None)
    ch.push(b"")   # 收割 _transport
    assert ch.dead is True
    with pytest.raises(SegmentChannelError):
        ch.push(_pcm())
    ch.close()


# ============================================================
# 5. artifact 取回失败：帧放回 + drain_pending 重试
# ============================================================

def test_artifact_fetch_failure_replayable_via_drain(kernel_state_dir):
    ws = _FakeWs()
    ch = _make_channel(ws)
    client = ch._test_client
    pcm = _pcm(0.4)
    client.artifacts["art_retry"] = _wav_bytes(pcm)
    client.artifact_fail.add("art_retry")

    ch.open()
    ws.push_frame("text", _seg_closed_frame("art_retry", 10, 410))
    chunks = ch.push(b"")        # 触发收割：取回失败 -> 无产出 + 置死 + 帧放回
    assert chunks == []
    assert ch.dead is True
    client.artifact_fail.clear()  # 恢复取回通道
    chunks = ch.drain_pending()   # 帧未丢，可重试
    assert len(chunks) == 1 and chunks[0].pcm == pcm
    ch.close()


# ============================================================
# 6. stop 语义
# ============================================================

def test_stop_sends_stop_and_harvests_tail(kernel_state_dir):
    ws = _FakeWs()
    ch = _make_channel(ws)
    client = ch._test_client
    tail = _pcm(0.3)
    client.artifacts["art_tail"] = _wav_bytes(tail)
    ch.open()

    orig_send_json = ws.send_json

    async def _send_json(payload):
        await orig_send_json(payload)
        if payload.get("type") == "session.stop":
            ws.push_frame("text", _seg_closed_frame("art_tail", 5000, 5300))

    ws.send_json = _send_json   # type: ignore[assignment]
    chunks = ch.stop()
    assert {"type": "session.stop"} in ws.sent_json
    assert len(chunks) == 1 and chunks[0].start_ms == 5000
    assert chunks[0].pcm == tail
    assert ws.closed is True


def test_stop_send_failure_carries_collected(kernel_state_dir):
    ws = _FakeWs()
    ch = _make_channel(ws)
    client = ch._test_client
    early = _pcm(0.2)
    client.artifacts["art_early"] = _wav_bytes(early)
    ch.open()
    ws.push_frame("text", _seg_closed_frame("art_early", 1, 201))
    ch.push(b"")                # 先让读循环消费入队
    # 上面 push(b"") 已把 art_early 收走；重来一条：再注入一帧未收的
    client.artifacts["art_early2"] = _wav_bytes(early)
    ws.push_frame("text", _seg_closed_frame("art_early2", 2, 202))
    assert _wait_until(lambda: ch._events.qsize() >= 1), "读循环未入队"
    ws.fail_send = True         # stop 帧发不出去
    with pytest.raises(StopWithChunksError) as ei:
        ch.stop()
    # stop 失败前的队列帧被收割携带（不丢音频）；art_early/early2 至少其一在外
    assert len(ei.value.chunks) >= 1
    assert ws.closed is True


# ============================================================
# 7. close 幂等 / drain 空队列
# ============================================================

def test_close_idempotent_and_drain_empty(kernel_state_dir):
    ch = _make_channel(_FakeWs())
    ch.open()
    ch.close()
    ch.close()
    assert ch.drain_pending() == []
