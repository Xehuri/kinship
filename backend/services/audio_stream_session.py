# -*- coding: utf-8 -*-
"""
音频流「每连接」会话。

每个 ``/ws/audio-stream`` WebSocket 连接对应一个 ``AudioStreamSession`` 实例
（非单例），天然支持多设备并发推流、互不干扰。会话内部（C5：切分计算上移内核）：

    PCM 帧 -> 内核 segment 切分通道(WS /v1/stream mode=segment) -> segment.closed
                                                                    -> 本地封 WAV -> perception_store 落盘
                                                                    -> 绝对路径入分析队列

落盘目标：流式音频一律以 ``origin="stream"`` 落 ``stream/{date}/audio``（daily 之外），
与上传音频的 ``daily/{date}/audio`` 隔离；分析侧同样按 origin 跳过 perception 写入，
故流式链路不产生任何按日增量数据。

时间戳约定（方案 6.5）：内核 segment 会话以 ``t0_ms = start_wall_ms`` 为轴锚，
按样本计数推算每段绝对墙钟（与旧的"起始时间 + 已见样本数"内部推轴逐位同源），
**全程不使用接收时间**，离线/延迟到达的音频时间戳仍为真实采集时间。

失败降级（与上传无缝流同一纪律，本地 segmenter 已删除、绝不回退本地切分）：
通道建立失败/中途断连 -> 本会话退化为"整条流单块"：PCM 只进镜像缓冲，
finish 时整体作为一个 WAV 落盘分析（无静音切分的退化形态，绝不丢音频），
记限频由路由/模块级共同保证不刷屏。

背压（方案 6.2/11.6）：有界缓冲，统计「已喂入但尚未成功入队」的 PCM 字节数；
超过 ``MAX_PENDING_BYTES``（5 分钟 PCM 约 9.6MB）时 ``feed`` 返回 ``"throttle"``，
由路由向客户端下发 ``{"type":"throttle"}``，要求其转本地缓存，禁止无界堆积。

依赖：标准库 + 轻量模块（segment_channel / perception_store）；
不在模块级导入任何重服务。注意 feed/finish 含阻塞网络 IO（投递到共享
asyncio 线程），WS 路由侧应经 ``asyncio.to_thread`` 调用以免卡事件循环。
"""

from __future__ import annotations

import logging
import os
import threading
import time
from typing import Any, Callable, Dict, Optional

from services.segment_channel import (
    SegmentChannel,
    SegmentChannelError,
    StopWithChunksError,
)
from services.perception_store import save_audio

from services.audio_codec import pcm_to_wav
from services.audio_config import get_audio_config
from services.kernel_segment_session import KernelSegmentSessionBase, build_segment_channel

logger = logging.getLogger(__name__)

# ─── 音频配置(模块级快照: 导入时加载, 热更新走 reload_audio_config_snapshot) ───
_AUDIO_CFG: Dict[str, Any] = {}
_STREAM_CFG: Dict[str, Any] = {}

# 音频格式约定：16000Hz / 单声道 / 16bit 小端(读配置 audio.stream.*)
_SAMPLE_RATE: int = 16000
_BITS_PER_SAMPLE: int = 16
_CHANNELS: int = 1

# 切分参数（映射到内核 session.start.segment；口径与旧本地 segmenter 一致）
_FRAME_MS: int = 30
_RMS_THRESHOLD: float = 5.0
_SILENCE_CUT_S: float = 1.5
_MIN_CHUNK_S: float = 10.0
_FORCE_CUT_S: float = 60.0

# 背压上限：max_pending_minutes 分钟 PCM(默认 5 分钟 ≈ 9.6MB)
_MAX_PENDING_BYTES: int = 0


def _load_audio_config_snapshot() -> None:
    """把最新 audio.stream 快照写入模块级参数（新会话/新帧按新值计算）。"""
    global _AUDIO_CFG, _STREAM_CFG
    global _SAMPLE_RATE, _BITS_PER_SAMPLE, _CHANNELS
    global _FRAME_MS, _RMS_THRESHOLD, _SILENCE_CUT_S, _MIN_CHUNK_S, _FORCE_CUT_S
    global _MAX_PENDING_BYTES

    _AUDIO_CFG = get_audio_config()
    _STREAM_CFG = _AUDIO_CFG.get("stream", {}) or {}

    _SAMPLE_RATE = int(_STREAM_CFG.get("sample_rate", 16000))
    _BITS_PER_SAMPLE = int(_STREAM_CFG.get("bytes_per_sample", 2)) * 8
    _CHANNELS = int(_STREAM_CFG.get("channels", 1))
    _FRAME_MS = int(_STREAM_CFG.get("frame_ms", 30))
    _RMS_THRESHOLD = float(_STREAM_CFG.get("rms_threshold", 5.0))
    _SILENCE_CUT_S = float(_STREAM_CFG.get("silence_cut_s", 1.5))
    _MIN_CHUNK_S = float(_STREAM_CFG.get("min_chunk_s", 10.0))
    _FORCE_CUT_S = float(_STREAM_CFG.get("force_cut_s", 60.0))
    _MAX_PENDING_BYTES = int(
        float(_STREAM_CFG.get("max_pending_minutes", 5))
        * 60 * _SAMPLE_RATE * (_BITS_PER_SAMPLE // 8) * _CHANNELS
    )


def reload_audio_config_snapshot() -> None:
    """热重载流式会话的模块级配置快照（幂等）。"""
    _load_audio_config_snapshot()


_load_audio_config_snapshot()

# 通道建立失败的进程级限频告警（每连接都失败时不许刷屏）
_degrade_warn_lock = threading.Lock()
_degrade_warn_ts = 0.0
_DEGRADE_WARN_INTERVAL_S = 60.0


def _warn_degraded(reason: str) -> None:
    """降级为"整条流单块"的限频 ERROR（整个进程 60s 最多一条）。"""
    global _degrade_warn_ts
    now = time.monotonic()
    with _degrade_warn_lock:
        if now - _degrade_warn_ts < _DEGRADE_WARN_INTERVAL_S:
            return
        _degrade_warn_ts = now
    logger.error(
        f"[AudioStreamSession] 内核切分通道不可用，流式会话降级为整条流单块"
        f"（限频60s，绝不回退本地切分）: {reason}"
    )


def _default_channel_factory(start_wall_ms: int, opts: Dict[str, Any]) -> SegmentChannel:
    """生产缺省通道工厂：本会话一条内核 segment 通道（惰性建连，绝不 import 时 spawn）。

    硬上限口径：WS 直播路径沿用 ``audio.stream.force_cut_s``（默认 60s），
    与上传无缝流的 stitch.max_chunk_s（120s）区分。
    """
    return build_segment_channel(
        name=str(opts.get("device_id") or "ws-stream"),
        t0_ms=start_wall_ms,
        sample_rate=_SAMPLE_RATE,
        bytes_per_sample=_BITS_PER_SAMPLE // 8,
        rms_threshold=_RMS_THRESHOLD,
        frame_ms=_FRAME_MS,
        silence_cut_s=_SILENCE_CUT_S,
        min_chunk_s=_MIN_CHUNK_S,
        max_chunk_s=_FORCE_CUT_S,
    )


class AudioStreamSession(KernelSegmentSessionBase):
    """单个 WebSocket 连接的音频流会话（每连接一个实例）。

    切分委托一条内核 segment 通道（首帧惰性建连）；通道不可用时降级为
    "整条流单块"（镜像缓冲 + finish 时整体落盘，绝不丢音频）。
    镜像/降级/收割/消费原子件继承自 :class:`KernelSegmentSessionBase`
    （V12 刀1：与上传无缝流会话共享单实现；本类并发模型 = 每连接对象 +
    自身 RLock 于 feed/finish 公开入口包裹，基类原语全程在锁内调用）。
    """

    def __init__(
        self,
        device_id: str,
        session_id: str,
        start_wall_ms: int,
        *,
        channel_factory: Optional[Callable[[int, Dict[str, Any]], Any]] = None,
    ) -> None:
        """
        Args:
            device_id: 设备标识（用于落盘文件名与感知条目）
            session_id: 会话标识（路由生成）
            start_wall_ms: 本会话音频首样本的绝对墙钟时间（epoch 毫秒），
                           由客户端 ``audio_start`` 消息携带；同时作为内核
                           segment 通道的 t0 轴锚
            channel_factory: 切分通道工厂 ``(start_wall_ms, opts) -> channel``；
                None 用生产缺省（内核 segment 通道）。测试注入假通道。
        """
        super().__init__()
        self._device_id = device_id
        self._session_id = session_id
        self._start_wall_ms = int(start_wall_ms)
        self._channel_factory = channel_factory or _default_channel_factory

        self._lock = threading.RLock()

        # 已喂入的累计样本数：降级路径 finish 单块的起点推算与背压口径用
        self._samples_seen: int = 0

        # 背压统计：已喂入但尚未成功入队的 PCM 字节数
        self._pending_bytes: int = 0

        # 对外暴露的 throttle 状态（路由可读取）
        self.throttle: bool = False

        # finish 幂等保护，避免断线与 audio_stop 各调一次导致重复冲刷
        self._finished: bool = False

        logger.info(
            f"[AudioStreamSession] 会话建立 session={session_id} "
            f"device={device_id} start_wall_ms={self._start_wall_ms}"
        )

    # ========== 公开接口 ==========

    def feed(self, pcm: bytes) -> str | None:
        """喂入一段 PCM：推入内核切分通道，收割切出的段落盘/入队。

        Args:
            pcm: 16kHz/单声道/16bit 小端 PCM 字节

        Returns:
            None 表示正常；``"throttle"`` 表示服务端过载，调用方应通知客户端转本地缓存。

        注意：含阻塞网络 IO（内核 WS 投递/artifact 取回），WS 路由侧请经
        ``asyncio.to_thread`` 调用。
        """
        if self._finished:
            logger.warning(f"[AudioStreamSession] 会话已结束，忽略 feed session={self._session_id}")
            return None
        if not pcm:
            return "throttle" if self.throttle else None

        with self._lock:
            # 关键：wall_ms 由起始时间 + 已见样本数内部推算，禁止使用接收时间
            bytes_per_sample = max(1, _BITS_PER_SAMPLE // 8)
            wall_ms = self._derived_wall_ms(self._samples_seen)

            # 计入背压（成功入队时才回减）
            self._pending_bytes += len(pcm)
            self._samples_seen += len(pcm) // bytes_per_sample
            self._mirror_extend(pcm, wall_ms)

            out_chunks = []
            if not self._degraded:
                # 首帧惰性建连（失败 -> 整会话降级，绝不回退本地切分）
                if self._channel is None:
                    try:
                        ch = self._channel_factory(
                            self._start_wall_ms, {"device_id": self._device_id}
                        )
                        self._channel = ch
                        ch.open()
                    except Exception as e:
                        self._degrade(f"通道建立失败: {type(e).__name__}: {str(e)[:150]}")
                if not self._degraded:
                    ch = self._channel
                    if ch is not None and getattr(ch, "dead", False):
                        self._harvest_into(out_chunks)
                        self._degrade("通道已降级（dead）")
                    elif ch is not None:
                        try:
                            # WS 直播帧约 100ms 一帧：first_wait=0 纯 drain，
                            # 切帧在下一帧到达时收割（<=100ms 延迟），不拖慢实时性
                            for sc in ch.push(bytes(pcm), first_wait=0.0):
                                self._consume_kernel_chunk(sc, out_chunks)
                        except StopWithChunksError as e:
                            for sc in e.chunks:
                                self._consume_kernel_chunk(sc, out_chunks)
                            self._harvest_into(out_chunks)
                            self._degrade("通道 push 异常（stop 语义失败）")
                        except SegmentChannelError as e:
                            self._harvest_into(out_chunks)
                            self._degrade(f"通道 push 失败: {type(e).__name__}")
            # 降级形态：PCM 留在镜像，finish 时整体产出（无静音切分，不丢音频）

            for chunk in out_chunks:
                self._persist_and_enqueue(*chunk)

            # 背压判定：超限即置位 throttle
            if self._pending_bytes > _MAX_PENDING_BYTES:
                self.throttle = True
            if self.throttle:
                return "throttle"
            return None

    def finish(self) -> None:
        """冲刷尾段并处理（断线/audio_stop 时调用），保证不丢尾部语音。

        正常路径 = 通道 ``session.stop``（内核把尾段闭合送出）；降级路径 =
        镜像整体作为一个 WAV 产出。含阻塞网络 IO，路由侧经 to_thread 调用。
        """
        with self._lock:
            if self._finished:
                return
            self._finished = True

            out_chunks = []
            ch = self._channel
            if not self._degraded and ch is not None:
                try:
                    for sc in ch.stop():
                        self._consume_kernel_chunk(sc, out_chunks)
                except StopWithChunksError as e:
                    for sc in e.chunks:
                        self._consume_kernel_chunk(sc, out_chunks)
                except Exception as e:
                    logger.warning(
                        f"[AudioStreamSession] 通道 stop 失败，转镜像兜底 "
                        f"session={self._session_id}: {type(e).__name__}: {str(e)[:150]}"
                    )
            self._harvest_into(out_chunks)
            self._drain_whole_mirror(out_chunks)

            if not out_chunks:
                logger.info(f"[AudioStreamSession] 无尾段可冲刷 session={self._session_id}")
                self._close_channel()
                return
            for chunk in out_chunks:
                logger.info(
                    f"[AudioStreamSession] 冲刷/产出 session={self._session_id} "
                    f"samples={len(chunk[0]) // max(1, _BITS_PER_SAMPLE // 8)}"
                )
                self._persist_and_enqueue(*chunk)
            self._close_channel()

    # ========== 内部实现 ==========

    def _derived_wall_ms(self, samples_before: int) -> int:
        """由起始时间 + 累计样本数推算绝对墙钟（绝不用接收时间）。"""
        return self._start_wall_ms + int(samples_before * 1000 / _SAMPLE_RATE)

    @staticmethod
    def _duration_ms(pcm: bytes) -> int:
        samples = len(pcm) // max(1, _BITS_PER_SAMPLE // 8)
        return int(round(samples * 1000.0 / _SAMPLE_RATE))

    def _fallback_start_ms(self) -> int:
        return self._start_wall_ms

    def _warn_mirror_mismatch(self, kernel_bytes: int, mirror_bytes: int) -> None:
        logger.warning(
            f"[AudioStreamSession] 内核段与镜像记账不一致 session={self._session_id} "
            f"kernel_bytes={kernel_bytes} mirror_bytes={mirror_bytes}"
        )

    def _emit_consumed(self, pcm: bytes, start_ms: int, trigger: str, out: list) -> None:
        out.append((pcm, start_ms, start_ms + self._duration_ms(pcm)))

    def _emit_whole(self, pcm: bytes, start_ms: int, trigger: Optional[str], out: list) -> None:
        out.append((pcm, start_ms, start_ms + self._duration_ms(pcm)))

    def _warn_harvest_failure(self, exc: Exception) -> None:
        logger.warning(
            f"[AudioStreamSession] 收割通道未决段失败（镜像兜底） "
            f"session={self._session_id}: {type(exc).__name__}"
        )

    def _on_degraded(self, reason: str) -> None:
        _warn_degraded(f"session={self._session_id} 原因={reason}")

    def _persist_and_enqueue(
        self, pcm: bytes, start_wall_ms: int, end_wall_ms: int
    ) -> None:
        """把已完成片段封成 WAV 落盘，再把绝对路径入分析队列。

        落盘失败（save_audio 返回 None）时跳过入队并告警，避免下游拿到空路径。
        """
        try:
            wav_bytes = pcm_to_wav(pcm, _SAMPLE_RATE, _CHANNELS)
            rel_path = save_audio(
                wav_bytes,
                start_ms=start_wall_ms,
                end_ms=end_wall_ms,
                device_id=self._device_id,
                origin="stream",
            )
            if rel_path is None:
                logger.warning(
                    f"[AudioStreamSession] WAV 落盘失败，跳过入队 session={self._session_id} "
                    f"start_ms={start_wall_ms}"
                )
                # 落盘失败也计入背压，促使客户端降速
                self.throttle = True
                return

            # save_audio 返回相对 DATA_DIR 的路径（stream/{date}/audio/...），入队前拼接为绝对路径
            from config.config import get_config

            abs_path = os.path.join(get_config().DATA_DIR, rel_path)

            from services.audio_analysis_queue import get_analysis_queue

            submitted = get_analysis_queue().submit(
                abs_path,
                start_epoch_ms=start_wall_ms,
                device_name=self._device_id,
                origin="stream",
            )
            if submitted:
                # 成功入队才回减背压计数（按产出 PCM 字节计）
                self._pending_bytes = max(0, self._pending_bytes - len(pcm))
            else:
                # 队列满：置位 throttle，等待上游下发后客户端转本地缓存
                self.throttle = True
                logger.warning(
                    f"[AudioStreamSession] 分析队列已满，本片段未入队: {abs_path}"
                )
        except Exception as e:
            logger.error(
                f"[AudioStreamSession] 片段处理失败 session={self._session_id}: {e}",
                exc_info=True,
            )


__all__ = ["AudioStreamSession", "reload_audio_config_snapshot"]
