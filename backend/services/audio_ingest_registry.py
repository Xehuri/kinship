# -*- coding: utf-8 -*-
"""音频摄入会话注册表（{device_id: DeviceIngestSession} 映射 + 并发控制）。

上传路由（HTTP）与流式链路（WebSocket）可能同时到达同一设备的分段，因此：

1. 会话映射用互斥锁保护，``get_or_create`` 保证同一设备只存在一个会话实例；
2. 每个 :class:`~services.audio_ingest_session.DeviceIngestSession` 自身线程安全，
   会话内部串行处理，映射锁不覆盖耗时操作；
3. 提供空闲冲刷（sweep）：后台守护线程周期性检查各设备当前流是否在
   ``holdback_s`` 内无新文件到达，超时则产出尾段并交给注册的 sink
   （由上传路由派发到分析链路）。

单例通过 :func:`get_audio_ingest_registry` 懒加载；参数（stitch_enabled /
holdback_s / min_flush_speech_ratio / stitch 等）在首次创建时从
``audio.stream.*`` 读取；:func:`reset_audio_ingest_registry` 可按当前配置热重建。
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Callable, Dict, List, Optional

from services.audio_config import get_audio_config
from services.audio_ingest_session import (
    DeviceIngestSession,
    EmittedChunk,
    IngestOutcome,
    stitch_options_from_config,
)

logger = logging.getLogger(__name__)

_DEFAULT_HOLDBACK_S = 90.0
# 产出块语音占比下限默认值（真正取值由 audio.stream.min_flush_speech_ratio 决定）
_DEFAULT_MIN_FLUSH_SPEECH_RATIO = 0.05
# 后台空闲冲刷周期（秒）：holdback_s 为 90 时，实际冲刷发生在 90~95 秒之间
_SWEEP_INTERVAL_S = 5.0

# 空闲冲刷回调：sink(device_id, chunks)
SweepSink = Callable[[str, List[EmittedChunk]], None]


class AudioIngestRegistry:
    """设备到音频摄入会话的映射注册表。

    Args:
        stitch_enabled: 是否启用跨文件无缝流（关闭时调用方应走既有独立分析路径）。
        holdback_s: 当前流空闲多久（秒）后强制冲刷尾段。
        min_flush_speech_ratio: 产出块语音占比下限（低于此值视为纯静音，不产出）。
        stitch: 无缝流参数（``tolerance_ms`` / ``max_chunk_s`` / ``min_chunk_s`` /
            ``silence_cut_s``）；缺省用内置默认。
        sample_rate: 音频采样率（Hz），透传给每个会话。
        bytes_per_sample: 每样本字节数，透传给每个会话。
        frame_ms: 能量判定帧长（毫秒），透传给每个会话。
        rms_threshold: 静音判定 RMS 阈值，透传给每个会话。
        start_sweeper: 是否启动后台空闲冲刷守护线程。
        channel_factory: 内核 segment 切分通道工厂（透传给每个
            :class:`DeviceIngestSession`；None 用生产缺省——惰性建内核通道，
            绝不在构造期 spawn）。单测注入假通道锁定编排语义。
        degraded_cooldown_s: 会话级通道降级冷却（秒），透传。
    """

    def __init__(
        self,
        *,
        stitch_enabled: bool = True,
        holdback_s: float = _DEFAULT_HOLDBACK_S,
        min_flush_speech_ratio: float = _DEFAULT_MIN_FLUSH_SPEECH_RATIO,
        stitch: Optional[Dict[str, Any]] = None,
        sample_rate: int = 16000,
        bytes_per_sample: int = 2,
        frame_ms: int = 30,
        rms_threshold: float = 5.0,
        start_sweeper: bool = False,
        channel_factory: Optional[Callable[[int, Dict[str, Any]], Any]] = None,
        degraded_cooldown_s: float = 120.0,
    ) -> None:
        self._stitch_enabled = bool(stitch_enabled)
        self._holdback_s = float(holdback_s)
        self._min_flush_speech_ratio = float(min_flush_speech_ratio)
        # 无缝流参数：缺省键由 stitch_options_from_config 补齐
        self._stitch = stitch_options_from_config({"stitch": dict(stitch or {})})
        self._sample_rate = int(sample_rate)
        self._bytes_per_sample = int(bytes_per_sample)
        self._frame_ms = int(frame_ms)
        self._rms_threshold = float(rms_threshold)
        # 切分通道工厂（C5：None = 生产缺省内核 segment 通道）
        self._channel_factory = channel_factory
        self._degraded_cooldown_s = float(degraded_cooldown_s)

        self._sessions: Dict[str, DeviceIngestSession] = {}
        self._lock = threading.Lock()

        self._sweep_sink: Optional[SweepSink] = None
        self._sweeper_started = False
        self._sweeper_stop = threading.Event()
        # P3-V17: 持有线程引用，stop_sweeper() 可 join（lifespan 收尾用）
        self._sweeper_thread: Optional[threading.Thread] = None

        if start_sweeper:
            self._ensure_sweeper()

    # ========== 会话生命周期 ==========

    @property
    def stitch_enabled(self) -> bool:
        return self._stitch_enabled

    def get_or_create(self, device_id: str) -> DeviceIngestSession:
        """获取或创建会话（同一设备只会创建一个实例）。"""
        with self._lock:
            session = self._sessions.get(device_id)
            if session is None:
                session = DeviceIngestSession(
                    device_id,
                    stitch_enabled=self._stitch_enabled,
                    holdback_s=self._holdback_s,
                    min_flush_speech_ratio=self._min_flush_speech_ratio,
                    sample_rate=self._sample_rate,
                    bytes_per_sample=self._bytes_per_sample,
                    frame_ms=self._frame_ms,
                    rms_threshold=self._rms_threshold,
                    channel_factory=self._channel_factory,
                    degraded_cooldown_s=self._degraded_cooldown_s,
                    **self._stitch,
                )
                self._sessions[device_id] = session
            return session

    # ========== 摄入与冲刷 ==========

    def ingest(
        self,
        device_id: str,
        *,
        device_name: str = "",
        session_id: str = "",
        seq: Optional[int] = -1,
        start_ms: Optional[int] = None,
        pcm: bytes = b"",
        fmt: str = "wav",
        now_ms: Optional[int] = None,
    ) -> IngestOutcome:
        """把一个上传分段喂入对应设备的会话。"""
        session = self.get_or_create(device_id)
        return session.ingest(
            session_id=session_id,
            seq=seq,
            start_ms=start_ms,
            pcm=pcm,
            device_name=device_name,
            fmt=fmt,
            now_ms=now_ms,
        )

    def sweep(self, now_ms: Optional[int] = None) -> Dict[str, List[EmittedChunk]]:
        """对所有设备做一次空闲冲刷，返回 ``{device_id: 产出块}``（仅含非空项）。"""
        now = int(now_ms) if now_ms is not None else int(time.time() * 1000)
        with self._lock:
            snapshot = list(self._sessions.items())

        result: Dict[str, List[EmittedChunk]] = {}
        for device_id, session in snapshot:
            try:
                chunks = session.sweep(now)
            except Exception as e:  # 单设备异常不影响其余设备
                logger.warning(f"[AudioIngestRegistry] 设备 {device_id} 空闲冲刷失败: {e}")
                continue
            if chunks:
                result[device_id] = chunks
        return result

    # ========== 空闲冲刷回调 ==========

    def set_sweep_sink(self, sink: Optional[SweepSink]) -> None:
        """注册空闲冲刷回调（由上传路由把产出块派发到分析链路）。"""
        self._sweep_sink = sink

    @property
    def sweeper_running(self) -> bool:
        """后台空闲冲刷线程是否存活（启动校验只读探针用）。"""
        thread = self._sweeper_thread
        return bool(thread is not None and thread.is_alive())

    def start_sweeper(self) -> None:
        """幂等启动/重启空闲冲刷线程（abort 后重试同一单例）。"""
        self._ensure_sweeper()

    def _ensure_sweeper(self) -> None:
        """懒启动后台空闲冲刷守护线程（线程死亡后可重启）。"""
        with self._lock:
            thread = self._sweeper_thread
            if thread is not None and thread.is_alive():
                return
            self._sweeper_stop = threading.Event()
            self._sweeper_started = True
            t = threading.Thread(
                target=self._sweep_loop, name="AudioIngestSweeper", daemon=True
            )
            self._sweeper_thread = t
            t.start()

    def _sweep_loop(self) -> None:
        while not self._sweeper_stop.wait(_SWEEP_INTERVAL_S):
            try:
                flushed = self.sweep()
            except Exception as e:
                logger.warning(f"[AudioIngestRegistry] 后台空闲冲刷异常: {e}")
                continue
            sink = self._sweep_sink
            if not sink or not flushed:
                continue
            for device_id, chunks in flushed.items():
                try:
                    sink(device_id, chunks)
                except Exception as e:
                    logger.warning(
                        f"[AudioIngestRegistry] 空闲冲刷派发失败 device={device_id}: {e}"
                    )

    def stop_sweeper(self, timeout: float = 5.0) -> None:
        """停止后台空闲冲刷线程并 join（lifespan 收尾/测试用，幂等）。

        _sweep_loop 以 ``Event.wait(_SWEEP_INTERVAL_S)`` 休眠，置位即刻唤醒；
        timeout 覆盖在途单轮 sweep+同步派发（秒级封顶）。线程本为 daemon，
        join 超时不影响进程退出，仅保证优雅收尾可观测。
        """
        self._sweeper_stop.set()
        t = self._sweeper_thread
        if t is not None and t.is_alive():
            t.join(timeout=timeout)


# ─── 单例 ───
_instance: Optional[AudioIngestRegistry] = None
_instance_lock = threading.Lock()
_reset_lock = threading.Lock()


def _create_audio_ingest_registry() -> AudioIngestRegistry:
    """按当前 audio.stream 配置创建注册表（sweeper 随实例启动）。"""
    stream_cfg = get_audio_config().get("stream", {}) or {}
    return AudioIngestRegistry(
        stitch_enabled=bool(stream_cfg.get("stitch_enabled", True)),
        holdback_s=float(stream_cfg.get("holdback_s", _DEFAULT_HOLDBACK_S)),
        min_flush_speech_ratio=float(
            stream_cfg.get("min_flush_speech_ratio", _DEFAULT_MIN_FLUSH_SPEECH_RATIO)
        ),
        stitch=stitch_options_from_config(stream_cfg),
        sample_rate=int(stream_cfg.get("sample_rate", 16000)),
        bytes_per_sample=int(stream_cfg.get("bytes_per_sample", 2)),
        frame_ms=int(stream_cfg.get("frame_ms", 30)),
        rms_threshold=float(stream_cfg.get("rms_threshold", 5.0)),
        start_sweeper=True,
    )


def get_audio_ingest_registry() -> AudioIngestRegistry:
    """获取进程级连续性摄入注册表单例（首次调用时从配置读取参数）。"""
    global _instance
    if _instance is None:
        with _instance_lock:
            if _instance is None:
                _instance = _create_audio_ingest_registry()
    return _instance


def reset_audio_ingest_registry(
    sink: Optional[SweepSink] = None,
) -> AudioIngestRegistry:
    """按当前配置重建注册表单例（幂等，未创建过也可调用）。

    先换单例再冲刷旧会话：冲刷可能阻塞在内核通道 stop 上，换单例后新到达
    的上传直接进入新注册表，不被旧会话收尾拖住。旧会话逐个 flush（尾段
    交给 sink 派发）后 close（释放通道）；单个失败只记警告，不阻断其余。

    Args:
        sink: 新注册表的空闲冲刷回调；None 时保持新注册表无回调（但旧会话
            flush 产出的尾段仍派发给旧 sink，避免丢音频）。

    Returns:
        新的注册表单例。
    """
    global _instance
    with _reset_lock:
        new = _create_audio_ingest_registry()
        if sink is not None:
            new.set_sweep_sink(sink)

        with _instance_lock:
            old = _instance
            _instance = new

        sessions: list[tuple[str, DeviceIngestSession]] = []
        if old is not None:
            old.stop_sweeper()
            with old._lock:
                sessions = list(old._sessions.items())
                old._sessions.clear()
            dispatch = sink if sink is not None else old._sweep_sink
        else:
            dispatch = None

        for device_id, session in sessions:
            try:
                chunks = session.flush()
            except Exception as e:
                logger.warning(
                    f"[AudioIngestRegistry] reset 冲刷会话失败 device="
                    f"{device_id}: {e}"
                )
                chunks = []
            if chunks and dispatch is not None:
                try:
                    dispatch(device_id, chunks)
                except Exception as e:
                    logger.warning(
                        f"[AudioIngestRegistry] reset 派发尾段失败 device="
                        f"{device_id}: {e}"
                    )
            try:
                session.close()
            except Exception as e:
                logger.warning(
                    f"[AudioIngestRegistry] reset 关闭会话失败 device="
                    f"{device_id}: {e}"
                )

    return new


def peek_audio_ingest_registry() -> Optional[AudioIngestRegistry]:
    """返回已创建的单例，绝不触发创建（P3-V17：lifespan shutdown 收尾专用）。"""
    return _instance


__all__ = [
    "AudioIngestRegistry",
    "get_audio_ingest_registry",
    "peek_audio_ingest_registry",
    "reset_audio_ingest_registry",
]
