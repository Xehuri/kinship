# -*- coding: utf-8 -*-
"""内核切分会话「镜像缓冲 / 降级 / 收割 / 消费」共享基类（P1-V12 刀1）。

两条生产链各有一个内核 segment 切分会话，其镜像兜底家族此前逐行平行两份
（审计 raw/03 §3/§5.4 取证）：

- :class:`services.audio_stream_session.AudioStreamSession`（WS 直播流）
- :class:`services.audio_ingest_session.DeviceIngestSession`（上传无缝流）

本模块只收敛**语义逐行等价**的原子件（镜像记账、收割循环骨架、通道关闭、
降级置标）；编排差异（stream 的背压节流、ingest 的去重/水位/连续性判定）、
产出类型差异（元组 vs EmittedChunk + 语音占比过滤）、降级告警策略差异
（stream 进程级 60s 限频 vs ingest 即时 ERROR + 冷却期）**全部留在子类钩子**。

并发模型裁定（重要）：
    基类**不持锁、不建锁**。两个子类的既有纪律已经是"公开入口取自身 RLock
    后再调内部件"：

    - stream：每连接一个实例，自身 RLock 串行化 feed/finish（路由主循环
      与断线清理段可能交叠，含 asyncio.to_thread 跨线程）；
    - ingest：每设备一个实例、WS/HTTP 多线程并发到达，自身 RLock 串行化
      ingest/sweep/flush/close，``_locked`` 后缀 = "调用方已持锁"。

    因此基类原语一律为"外持锁"（lock-free）方法，由子类公开入口的既有锁
    包裹——两种并发模型天然容纳，锁域零变化、零新增同步语义。任何调用者
    必须先持有子类会话锁。

钩子契约由子类实现；行为与提取前逐字等价（日志文本、截断长度、消费/清理
次序的等价性论证见 backend/services/audio_ingest_session.py 头部注释与本
模块 docstring；表征锁测试：tests/test_kernel_mirror_degrade_lock.py）。
"""

from __future__ import annotations

from typing import Any, Optional

from services.segment_channel import SegmentChannel, SegmentChunk


def build_segment_channel(
    *,
    name: str,
    t0_ms: int,
    sample_rate: int,
    bytes_per_sample: int,
    rms_threshold: float,
    frame_ms: int,
    silence_cut_s: float,
    min_chunk_s: float,
    max_chunk_s: float,
) -> SegmentChannel:
    """内核 segment 通道的唯一构造点（V12 刀2：两处缺省工厂的组装样板合一）。

    仅做参数装配与类型归一；不建连（open 由会话首帧惰性触发，保证导入/
    构造会话永不触内核与 spawn）。硬上限口径是调用方参数：WS 直播流
    ``audio.stream.force_cut_s``（60s），上传无缝流 ``stitch.max_chunk_s``
    （120s）。
    """
    return SegmentChannel(
        name=str(name),
        t0_ms=int(t0_ms),
        sample_rate=int(sample_rate),
        bytes_per_sample=int(bytes_per_sample),
        rms_threshold=float(rms_threshold),
        frame_ms=int(frame_ms),
        silence_cut_s=float(silence_cut_s),
        min_chunk_s=float(min_chunk_s),
        max_chunk_s=float(max_chunk_s),
    )


class KernelSegmentSessionBase:
    """内核切分会话共享基类：镜像/降级/收割/消费原子件（全部"外持锁"方法）。

    子类状态字段（由基类 :meth:`__init__` 初始化）：

    - ``_channel``：当前内核切分通道（None = 尚未建立或已关闭）
    - ``_degraded``：降级标记（stream 会话级终态；ingest 流级态，重置流时清除）
    - ``_mirror``：镜像缓冲（已喂入尚未产出的 PCM 字节）
    - ``_mirror_start_ms``：镜像首样本绝对墙钟（epoch ms，随产出消费前移）
    """

    def __init__(self) -> None:
        self._channel: Optional[Any] = None
        self._degraded: bool = False
        self._mirror = bytearray()
        self._mirror_start_ms: Optional[int] = None

    # ========== 子类必须提供的钩子 ==========

    def _duration_ms(self, pcm: bytes) -> int:
        """PCM 时长（毫秒）。子类各自实现（常量源不同：模块级 vs 实例级）。"""
        raise NotImplementedError

    def _fallback_start_ms(self) -> int:
        """镜像起点为 None 时的回退绝对墙钟。

        - stream：``self._start_wall_ms``（会话首样本时刻，恒有值）
        - ingest：``self._stream_start_ms or 0``（当前流起点，无流则 0）
        """
        raise NotImplementedError

    def _warn_mirror_mismatch(self, kernel_bytes: int, mirror_bytes: int) -> None:
        """内核段长与镜像记账不一致的 WARN 日志（两侧文案不同，留子类）。"""
        raise NotImplementedError

    def _emit_consumed(self, pcm: bytes, start_ms: int, trigger: str, out: list) -> None:
        """把内核切出的段落成产出物并追加到 out。

        - stream：追加元组 ``(pcm, start_ms, end_ms)``
        - ingest：:meth:`_make_chunk`（可能因无语音被过滤为 None 而不追加）+ INFO
        """
        raise NotImplementedError

    def _emit_whole(self, pcm: bytes, start_ms: int, trigger: Optional[str], out: list) -> None:
        """把镜像整块落成产出物并追加到 out（产出类型/过滤差异留子类）。"""
        raise NotImplementedError

    def _warn_harvest_failure(self, exc: Exception) -> None:
        """收割通道未决段失败的 WARN 日志（截断口径两侧不同，留子类）。"""
        raise NotImplementedError

    def _on_degraded(self, reason: str) -> None:
        """降级置标之后的策略钩子。

        - stream：进程级 60s 限频 ERROR（绝不回退本地切分）
        - ingest：即时 ERROR + 设冷却截止 ``_degraded_until``
        """
        raise NotImplementedError

    # ========== 镜像缓冲原子件 ==========

    def _mirror_extend(self, pcm: bytes, wall_ms: int) -> None:
        """把一段 PCM 累积进镜像；镜像被消费空后重新攒段时起点取本段时刻。"""
        self._mirror.extend(pcm)
        if self._mirror_start_ms is None:
            self._mirror_start_ms = int(wall_ms)

    def _mirror_reset(self, start_ms: Optional[int] = None) -> None:
        """丢弃镜像 contents（开新流/复位流时重建缓冲；不产出、不记账）。"""
        self._mirror = bytearray()
        self._mirror_start_ms = int(start_ms) if start_ms is not None else None

    def _consume_kernel_chunk(self, sc: SegmentChunk, out: list,
                              trigger: str = "cut") -> None:
        """内核切出的一个段：镜像头部按字节消费、起点前移，再经钩子落产出物。

        记账次序与提取前等价（ingest 原实现先 _make_chunk 后清镜像；构造
        只读已切片字节与"最近上传元数据"，与镜像字段无依赖，挪至清理后
        无任何可观察差异；日志相对次序保持 warn -> info）。
        """
        n = min(len(sc.pcm), len(self._mirror))
        if n != len(sc.pcm):
            self._warn_mirror_mismatch(len(sc.pcm), len(self._mirror))
        pcm = bytes(sc.pcm[:n])
        start = int(sc.start_ms) or int(self._mirror_start_ms or self._fallback_start_ms())
        del self._mirror[:n]
        # 镜像起点前移：以内核绝对轴为权威（start + 消费字节时长），记账连续
        self._mirror_start_ms = (
            start + self._duration_ms(pcm) if self._mirror else None
        )
        self._emit_consumed(pcm, start, trigger, out)

    def _drain_whole_mirror(self, out: list, trigger: Optional[str] = None) -> bool:
        """镜像整体兜底产出（降级逐块 / 冲刷尾块）；空镜像返回 False 不动账。"""
        if not self._mirror:
            return False
        pcm = bytes(self._mirror)
        start = (
            int(self._mirror_start_ms) if self._mirror_start_ms is not None
            else self._fallback_start_ms()
        )
        self._mirror_reset()
        self._emit_whole(pcm, start, trigger, out)
        return True

    # ========== 通道收割/关闭与降级状态 ==========

    def _close_channel(self) -> None:
        """摘出通道并置 None，close 异常静默（尽力而为，不抛出）。"""
        ch, self._channel = self._channel, None
        if ch is not None:
            try:
                ch.close()
            except Exception:
                pass

    def _harvest_into(self, out: list) -> None:
        """尽力收割通道队列中已到达的段（drain 失败静默——镜像兜底），随后关通道。"""
        ch = self._channel
        if ch is None:
            return
        try:
            for sc in ch.drain_pending():
                self._consume_kernel_chunk(sc, out)
        except Exception as e:
            self._warn_harvest_failure(e)
        finally:
            self._close_channel()

    def _degrade(self, reason: str) -> None:
        """置降级标（绝不回退本地切分，只走镜像整块），再执行子类策略钩子。"""
        self._degraded = True
        self._on_degraded(reason)


__all__ = ["KernelSegmentSessionBase"]
