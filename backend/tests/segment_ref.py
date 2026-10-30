# -*- coding: utf-8 -*-
"""测试专用：物理切分算法参考实现 + 内核 segment 通道的本地仿真。

- :class:`RefSegmenter` —— ``git show pre-outer-stripping:backend/services/audio_stream_segmenter.py``
  （Wave A6 内核化时的外层实现，265 行）逐逻辑移植进测试域；运行时
  （backend/services）零本地切分实现（C5/D1 纪律），本文件只存在于 tests/，
  用作"内核 segment 模式 == 原外层算法"golden 对拍的参考侧。
- :class:`RefSegmentChannel` —— 仿真 :class:`services.segment_channel.SegmentChannel`
  的对外行为（open/push/stop/drain_pending/close、t0 绝对轴推帧），供 ingest
  会话/流式会话单测注入，锁定编排语义而不触真实内核。
- :class:`BrokenChannel` —— 任何操作即抛错的通道（测试降级路径）。

wall_ms 口径（对照 kernel/axeuh_kernel/stream/session.py::_handle_bytes_segment）：
每帧首样本绝对墙钟 = ``t0_ms + 累计样本数*1000//sample_rate``；切分器仅在块空
时取用该值定 start_wall_ms，块内时间由样本数推算。
"""

from __future__ import annotations

import math
import sys
from array import array
from dataclasses import dataclass
from typing import List, Optional

from services.segment_channel import SegmentChannelError, SegmentChunk


@dataclass
class FinishedChunk:
    """一个已完成（物理闭合）的音频片段（原外层 dataclass 形状）。"""

    pcm: bytes
    start_wall_ms: int
    end_wall_ms: int
    sample_count: int


class RefSegmenter:
    """连续 PCM 流的物理切分器（pre-outer-stripping 外层实现原样逻辑）。

    切分规则：
    1. 累积时长达到 ``force_cut_s`` 时强制切分（硬上限）；
    2. 累积时长达到 ``min_chunk_s`` 且处于不短于 ``silence_cut_s`` 的静音游程
       中时，在静音边界切分；
    3. 除 ``flush`` 外绝不输出短于 ``min_chunk_s`` 的片段；
    4. 奇数残余字节跨 push 保留。
    """

    def __init__(
        self,
        *,
        sample_rate: int = 16000,
        bytes_per_sample: int = 2,
        force_cut_s: float = 60.0,
        silence_cut_s: float = 1.5,
        min_chunk_s: float = 10.0,
        rms_threshold: float = 5.0,
        frame_ms: int = 30,
    ) -> None:
        self.SAMPLE_RATE = int(sample_rate)
        self.BYTES_PER_SAMPLE = int(bytes_per_sample)
        self.FORCE_CUT_S = float(force_cut_s)
        self.SILENCE_CUT_S = float(silence_cut_s)
        self.MIN_CHUNK_S = float(min_chunk_s)
        self.RMS_THRESHOLD = float(rms_threshold)
        self.FRAME_MS = int(frame_ms)

        self._chunk_buf: bytearray = bytearray()
        self._chunk_samples: int = 0
        self._chunk_start_wall_ms: Optional[int] = None
        self._leftover: bytes = b""
        self._frame_cursor: int = 0
        self._silence_run_frames: int = 0

    @property
    def pending_samples(self) -> int:
        return self._chunk_samples

    def push(self, pcm: bytes, wall_ms: int) -> "list[FinishedChunk]":
        finished: "list[FinishedChunk]" = []
        if not pcm:
            return finished

        if self._leftover:
            pcm = self._leftover + pcm
            self._leftover = b""
        if len(pcm) % self.BYTES_PER_SAMPLE != 0:
            self._leftover = pcm[-1:]
            pcm = pcm[:-1]
        if not pcm:
            return finished

        if self._chunk_start_wall_ms is None:
            self._chunk_start_wall_ms = int(wall_ms)

        self._chunk_buf.extend(pcm)
        self._chunk_samples += len(pcm) // self.BYTES_PER_SAMPLE

        frame_bytes = self._frame_bytes()
        while len(self._chunk_buf) - self._frame_cursor >= frame_bytes:
            frame = bytes(
                self._chunk_buf[self._frame_cursor:self._frame_cursor + frame_bytes]
            )
            if self._calculate_rms(frame) > self.RMS_THRESHOLD:
                self._silence_run_frames = 0
            else:
                self._silence_run_frames += 1
            self._frame_cursor += frame_bytes

            processed_samples = self._frame_cursor // self.BYTES_PER_SAMPLE
            duration_ms = processed_samples * 1000.0 / self.SAMPLE_RATE
            silence_ms = self._silence_run_frames * self.FRAME_MS

            if (
                duration_ms >= self.MIN_CHUNK_S * 1000
                and silence_ms >= self.SILENCE_CUT_S * 1000
            ):
                finished.append(self._take_chunk(self._frame_cursor))
                continue

            if duration_ms >= self.FORCE_CUT_S * 1000:
                finished.append(self._take_chunk(self._frame_cursor))
                continue

        return finished

    def flush(self, wall_ms: Optional[int] = None) -> "Optional[FinishedChunk]":
        if self._chunk_samples <= 0:
            return None
        if self._chunk_start_wall_ms is None:
            self._chunk_start_wall_ms = int(wall_ms) if wall_ms is not None else 0
        return self._take_chunk(len(self._chunk_buf))

    def _frame_bytes(self) -> int:
        samples = self.SAMPLE_RATE * self.FRAME_MS // 1000
        return samples * self.BYTES_PER_SAMPLE

    @staticmethod
    def _calculate_rms(pcm_bytes: bytes) -> float:
        usable = len(pcm_bytes) - (len(pcm_bytes) % 2)
        if usable <= 0:
            return 0.0
        samples = array("h")
        samples.frombytes(pcm_bytes[:usable])
        if sys.byteorder != "little":
            samples.byteswap()
        n = len(samples)
        if n == 0:
            return 0.0
        sum_sq = sum(int(s) * int(s) for s in samples)
        return math.sqrt(sum_sq / n)

    def _take_chunk(self, cut_bytes: int) -> FinishedChunk:
        cut_bytes -= cut_bytes % self.BYTES_PER_SAMPLE
        if cut_bytes <= 0:
            cut_bytes = 0

        pcm = bytes(self._chunk_buf[:cut_bytes])
        remainder = self._chunk_buf[cut_bytes:]
        sample_count = cut_bytes // self.BYTES_PER_SAMPLE

        start_wall_ms = self._chunk_start_wall_ms or 0
        duration_ms = int(round(sample_count * 1000.0 / self.SAMPLE_RATE))
        end_wall_ms = start_wall_ms + duration_ms

        chunk = FinishedChunk(
            pcm=pcm,
            start_wall_ms=start_wall_ms,
            end_wall_ms=end_wall_ms,
            sample_count=sample_count,
        )

        self._chunk_buf = bytearray(remainder)
        self._chunk_samples = len(remainder) // self.BYTES_PER_SAMPLE
        self._frame_cursor = 0
        self._silence_run_frames = 0
        self._chunk_start_wall_ms = end_wall_ms if remainder else None

        return chunk


def _to_segment_chunk(c: FinishedChunk) -> SegmentChunk:
    return SegmentChunk(
        pcm=c.pcm,
        start_ms=c.start_wall_ms,
        end_ms=c.end_wall_ms,
        sample_count=c.sample_count,
    )


class RefSegmentChannel:
    """SegmentChannel 的本地仿真（鸭子接口，纯内存，绝不触内核）。

    行为对齐 kernel/axeuh_kernel/stream/session.py 的 segment 模式：
    - ``push`` 按 ``t0 + 累计样本数`` 推每帧首样本绝对墙钟喂 RefSegmenter；
    - 切出的段以 :class:`SegmentChunk` 返回；
    - ``stop`` 冲刷尾段（允许短于 min_chunk）并关闭；
    - ``raise_on_push_after`` 达到后 push 抛错（仿真中途断连）。
    """

    def __init__(
        self,
        t0_ms: int,
        opts: Optional[dict] = None,
        *,
        raise_on_open: bool = False,
        raise_on_push_after: Optional[int] = None,
    ) -> None:
        o = dict(opts or {})
        self._t0 = int(t0_ms)
        self._sample_rate = int(o.get("sample_rate", 16000))
        self._bps = int(o.get("bytes_per_sample", 2))
        self._seg = RefSegmenter(
            sample_rate=self._sample_rate,
            bytes_per_sample=self._bps,
            # 内核 segment 模式硬上限键名是 max_chunk_s（= 外层 force_cut 语义）
            force_cut_s=float(o.get("max_chunk_s", 120.0)),
            silence_cut_s=float(o.get("silence_cut_s", 1.5)),
            min_chunk_s=float(o.get("min_chunk_s", 10.0)),
            rms_threshold=float(o.get("rms_threshold", 5.0)),
            frame_ms=int(o.get("frame_ms", 30)),
        )
        self._total_samples = 0
        self._odd = b""
        self.opened = False
        self.stopped = False
        self.closed = False
        self.push_calls = 0
        self.dead = False
        self.open_failures = 0
        self._raise_on_open = raise_on_open
        self._raise_on_push_after = raise_on_push_after

    def open(self) -> None:
        if self._raise_on_open:
            self.open_failures += 1
            raise SegmentChannelError("仿真通道：open 故意失败")
        self.opened = True

    def push(self, pcm: bytes, *, first_wait: float = 0.0) -> List[SegmentChunk]:
        if self.dead:
            raise SegmentChannelError("仿真通道已降级")
        self.push_calls += 1
        if (
            self._raise_on_push_after is not None
            and self.push_calls > self._raise_on_push_after
        ):
            self.dead = True
            raise SegmentChannelError("仿真通道：push 故意失败（断连）")
        buf = self._odd + bytes(pcm)
        self._odd = b""
        if len(buf) % self._bps:
            self._odd = buf[-1:]
            buf = buf[:-1]
        if not buf:
            return []
        wall = self._t0 + self._total_samples * 1000 // self._sample_rate
        self._total_samples += len(buf) // self._bps
        return [_to_segment_chunk(c) for c in self._seg.push(buf, wall)]

    def stop(self, *, budget_s: float = 0.0) -> List[SegmentChunk]:
        if self.dead:
            raise SegmentChannelError("仿真通道已降级")
        self.stopped = True
        out: List[SegmentChunk] = []
        tail = self._seg.flush(
            self._t0 + self._total_samples * 1000 // self._sample_rate
        )
        if tail is not None:
            out.append(_to_segment_chunk(tail))
        self.close()
        return out

    def drain_pending(self) -> List[SegmentChunk]:
        return []

    def close(self) -> None:
        self.closed = True


class BrokenChannel:
    """任何操作即抛错的通道（覆盖"建立失败/中途死亡"两类降级分支）。"""

    def __init__(self, *args, **kwargs) -> None:
        self.dead = False
        self.closed = False

    def open(self) -> None:
        raise SegmentChannelError("BrokenChannel: open 必炸")

    def push(self, pcm: bytes, *, first_wait: float = 0.0):
        self.dead = True
        raise SegmentChannelError("BrokenChannel: push 必炸")

    def stop(self, *, budget_s: float = 0.0):
        raise SegmentChannelError("BrokenChannel: stop 必炸")

    def drain_pending(self):
        return []

    def close(self) -> None:
        self.closed = True


def make_channel_factory(**channel_kwargs):
    """构造注入用工厂：``(start_ms, opts) -> RefSegmentChannel(**channel_kwargs)``。"""
    def _factory(start_ms: int, opts: dict) -> RefSegmentChannel:
        return RefSegmentChannel(start_ms, opts, **channel_kwargs)

    return _factory


__all__ = [
    "FinishedChunk",
    "RefSegmenter",
    "RefSegmentChannel",
    "BrokenChannel",
    "make_channel_factory",
]
