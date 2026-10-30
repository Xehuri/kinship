# -*- coding: utf-8 -*-
"""单设备音频摄入会话：把时间连续的上传分段当作一条虚拟连续流分析。

背景
----
手机 App 按固定时长（默认 60s）把录音切成多个 WAV/FLAC 分段并逐个上传，文件
边界可能正好落在一句话中间。若每个分段各自独立分析，同一句话会被截断成两半，
ASR 结果割裂。

做法（C5：切分计算归内核，位置与编排归外层）
--------------------------------------------
本模块按 ``device_id`` 维护一条**虚拟连续音频流**：上传的 WAV/FLAC 只是"流的
一段"。时间连续（``B.start_ms <= A.end_ms + 容差``）的分段被追加到同一条流上，
**不在文件边界切分**。帧能量静音切分的计算已上移内核（D1=a / A6 segment 模式）：
每条流对应一条内核 ``/v1/stream`` ``mode:"segment"`` 切分通道
（:class:`services.segment_channel.SegmentChannel`），PCM 推入通道、
``segment.closed`` 的 artifact 取回即为切出的分析段；外层保留**镜像缓冲**
（已喂入尚未产出的 PCM），用于不连续/空闲冲刷与通道故障降级时的兜底产出。
产出 PCM 作为单个输入交给既有分析链路 ``services.audio_analysis_pipeline.analyze_audio_file``
（其内部 VAD 再做语义切分与 ASR），因此跨文件的一句话不会被切断。

流何时收尾（产出可供分析的分析段）
----------------------------------
1. **不连续**：新分段与当前流之间存在超过容差的时间间隙（丢文件 / 设备切换 /
   时间倒流）-> 先冲刷当前流（通道 stop 收尾段），再以新起点开新通道；
2. **静音端点 / 硬上限**：由内核按 ``silence_cut_s`` / ``min_chunk_s`` /
   ``max_chunk_s`` 判定，切点可能落在**文件中间**；
3. **空闲超时**：``holdback_s`` 内无新文件到达 -> ``session.stop`` 冲刷尾段
   （与旧的本地 flush 语义等价：内核把当前缓冲以尾段形式闭合送出）；
4. **显式收尾**：调用 :meth:`flush`（会话结束 / 需要立即收尾）。

失败降级（关键纪律：绝不回退本地切分——本地 segmenter 已删除）
--------------------------------------------------------------
切分通道建立失败 / 中途断连 / artifact 取回失败 -> 该**当前流**降级为
"逐段独立分析"（``stitch_enabled=false`` 的既有合法语义）：后续每个上传分段
整体即产出一个 chunk，不再合并；已送入内核但取不回的部分允许指针丢失
（artifact 字节仍在内核 state-dir，不被销毁）。整条流以镜像缓冲兜底冲刷
（**绝不丢音频字节**）。降级带冷却期（默认 120s），期满后的下一条新流重试内核。

连续与不连续都会记 INFO 日志（含两侧时间戳、间隙与判定结果），便于线上核对。

去重与水位
----------
保留 ``(device_id, session_id, seq, start_ms)`` 去重表（覆盖 App 重试与缓存
重放）与绝对时间轴水位：与已处理区间重叠的头部按水位裁剪（App 有 500ms 前滚
重叠，此处只裁掉这部分重叠），完全落在水位之内的分段安全丢弃。

职责边界
--------
- 本模块只做"单设备会话"：时间连续性判定、去重、水位、冲刷编排、镜像兜底。
- 跨设备映射与并发控制由 :mod:`services.audio_ingest_registry` 负责。
- 切分算法与 artifact 搬运由 :mod:`services.segment_channel`（内核通道）负责。
- 产出块的落盘与触达分析链路由调用方（上传路由）负责。
- 模块导入零重依赖（``segment_channel`` 仅标准库 + 惰性导入 kernel_client）。

依赖：Python 标准库 + :mod:`services.audio_config` + :mod:`services.segment_channel`。
"""

from __future__ import annotations

import io
import logging
import math
import sys
import threading
import time
import wave
from array import array
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple

from services.audio_codec import pcm_to_wav
from services.audio_config import get_audio_config
from services.kernel_segment_session import (
    KernelSegmentSessionBase,
    build_segment_channel,
)
from services.segment_channel import (
    SegmentChannel,
    SegmentChannelError,
    StopWithChunksError,
)

logger = logging.getLogger(__name__)

# 音频格式与通用参数（audio.stream.*；与 WS 流式路径共用同一份配置）
_STREAM_CFG: Dict[str, Any] = {}
# 无缝流参数（audio.stream.stitch.*）
_STITCH_CFG: Dict[str, Any] = {}

_DEFAULT_SAMPLE_RATE: int = 16000
_DEFAULT_BYTES_PER_SAMPLE: int = 2
_DEFAULT_HOLDBACK_S: float = 90.0
_DEFAULT_MIN_FLUSH_SPEECH_RATIO: float = 0.05
_DEFAULT_FRAME_MS: int = 30
_DEFAULT_RMS_THRESHOLD: float = 5.0

# 时间连续性容差（毫秒）：App 有 500ms 前滚重叠，正常分段首尾相接（间隙 <= 0），
# 容差只需吸收设备墙钟与样本数之间的漂移；1000ms 远小于"整个文件丢失"（约 60s）。
_DEFAULT_TOLERANCE_MS: int = 1000
# 单个分析段的硬上限（秒）：防止连续流无限累积；120s = 2 个上传文件周期。
_DEFAULT_MAX_CHUNK_S: float = 120.0
# 静音切分前的最短累积（秒）与静音端点判定阈值（秒），与 WS 流式路径同源。
_DEFAULT_MIN_CHUNK_S: float = 10.0
_DEFAULT_SILENCE_CUT_S: float = 1.5


def _load_audio_config_snapshot() -> None:
    """把最新 audio.stream 快照写入模块级默认参数（供新会话构造时读取）。"""
    global _STREAM_CFG, _STITCH_CFG
    global _DEFAULT_SAMPLE_RATE, _DEFAULT_BYTES_PER_SAMPLE
    global _DEFAULT_HOLDBACK_S, _DEFAULT_MIN_FLUSH_SPEECH_RATIO
    global _DEFAULT_FRAME_MS, _DEFAULT_RMS_THRESHOLD
    global _DEFAULT_TOLERANCE_MS, _DEFAULT_MAX_CHUNK_S
    global _DEFAULT_MIN_CHUNK_S, _DEFAULT_SILENCE_CUT_S

    _STREAM_CFG = get_audio_config().get("stream", {}) or {}
    _STITCH_CFG = _STREAM_CFG.get("stitch", {}) or {}

    _DEFAULT_SAMPLE_RATE = int(_STREAM_CFG.get("sample_rate", 16000))
    _DEFAULT_BYTES_PER_SAMPLE = int(_STREAM_CFG.get("bytes_per_sample", 2))
    _DEFAULT_HOLDBACK_S = float(_STREAM_CFG.get("holdback_s", 90.0))
    _DEFAULT_MIN_FLUSH_SPEECH_RATIO = float(
        _STREAM_CFG.get("min_flush_speech_ratio", 0.05)
    )
    _DEFAULT_FRAME_MS = int(_STREAM_CFG.get("frame_ms", 30))
    _DEFAULT_RMS_THRESHOLD = float(_STREAM_CFG.get("rms_threshold", 5.0))
    _DEFAULT_TOLERANCE_MS = int(_STITCH_CFG.get("tolerance_ms", 1000))
    _DEFAULT_MAX_CHUNK_S = float(_STITCH_CFG.get("max_chunk_s", 120.0))
    _DEFAULT_MIN_CHUNK_S = float(_STITCH_CFG.get("min_chunk_s", 10.0))
    _DEFAULT_SILENCE_CUT_S = float(_STITCH_CFG.get("silence_cut_s", 1.5))


def reload_audio_config_snapshot() -> None:
    """热重载摄入会话的模块级配置快照（幂等；现有会话保留构造时参数）。"""
    _load_audio_config_snapshot()


_load_audio_config_snapshot()

# 去重表容量上限：防止长时间运行（重试/缓存重放不断写入）导致内存无限增长
_DEDUP_MAX_ENTRIES = 2048

# 通道建立失败后的降级冷却（秒）：期内新流不再尝试内核（避免每条流都付
# spawn/握手超时的代价），期满重试。
_DEGRADED_COOLDOWN_S = 120.0


def _now_ms() -> int:
    """当前墙钟时间（epoch 毫秒）。"""
    return int(time.time() * 1000)


def _frame_rms(frame: bytes, bytes_per_sample: int = 2) -> float:
    """单帧 PCM 的 RMS 能量（纯标准库）。

    仅支持 16bit（App 上传契约固定 16kHz/单声道/16bit）；其他位宽返回 0，
    视为静音，绝不误判为语音。
    """
    if bytes_per_sample != 2:
        return 0.0
    usable = len(frame) - (len(frame) % 2)
    if usable <= 0:
        return 0.0
    samples = array("h")
    samples.frombytes(frame[:usable])
    if sys.byteorder != "little":
        # array("h") 使用本机字节序；PCM 约定为小端，非小端平台需交换
        samples.byteswap()
    n = len(samples)
    if n == 0:
        return 0.0
    return math.sqrt(sum(int(s) * int(s) for s in samples) / n)


@dataclass
class EmittedChunk:
    """由会话产出的、可供分析链路直接使用的完整音频段（原始 PCM）。"""

    pcm: bytes          # 原始 PCM 字节（16kHz/单声道/16bit 小端）
    start_ms: int       # 首样本绝对墙钟时间（epoch 毫秒）
    end_ms: int         # 末样本绝对墙钟时间
    sample_count: int   # 样本数（单声道样本计数）
    device_id: str = ""
    device_name: str = ""
    session_id: str = ""
    # 产出原因：cut（内核静音端点 / 硬上限切点）| discontinuity（时间不连续强制冲刷）
    #          | holdback（空闲超时冲刷）| flush（显式收尾冲刷）
    #          降级流的逐段产出也沿用当前流的 trigger 语义（append 即产即发）
    trigger: str = "cut"
    # T2: chunk 落盘格式（"wav" | "flac"）——由产出该 chunk 的上传分段格式决定
    fmt: str = "wav"


@dataclass
class IngestOutcome:
    """一次 :meth:`DeviceIngestSession.ingest` 的结果。"""

    emitted: List[EmittedChunk] = field(default_factory=list)
    duplicate: bool = False   # 命中 (device, session, seq, start_ms) 去重
    skipped: bool = False     # 完全落在已处理区间内（重放/过晚），安全丢弃


def stitch_options_from_config(stream_cfg: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """从 ``audio.stream`` 配置节提取无缝流参数（供注册表构造会话时透传）。

    ``config.example.yaml`` 中的 ``audio.stream.stitch`` 子块驱动时间连续性容差、
    单段硬上限、静音切分阈值；缺失的键回退到模块内置默认值。内核 segment 会话
    的切分参数（silence_cut/min_chunk/max_chunk/rms/frame）即取自本节映射。
    """
    stitch = (stream_cfg or {}).get("stitch", {}) or {}
    return {
        "tolerance_ms": int(stitch.get("tolerance_ms", _DEFAULT_TOLERANCE_MS)),
        "max_chunk_s": float(stitch.get("max_chunk_s", _DEFAULT_MAX_CHUNK_S)),
        "min_chunk_s": float(stitch.get("min_chunk_s", _DEFAULT_MIN_CHUNK_S)),
        "silence_cut_s": float(stitch.get("silence_cut_s", _DEFAULT_SILENCE_CUT_S)),
    }


def sniff_audio_fmt(data: bytes) -> str:
    """magic 嗅探音频格式：返回 "wav" | "flac" | "unknown"。

    不信任 Content-Type / 扩展名（delta: 裸 RIFF 也匹配 WebP/AVI，
    故 RIFF 必须配 8-11 位 WAVE）。
    """
    if not data or len(data) < 12:
        return "unknown"
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return "wav"
    if data[:4] == b"fLaC":
        return "flac"
    return "unknown"


def decode_audio_pcm(data: bytes) -> Optional[tuple[bytes, int, int, int]]:
    """解码 WAV/FLAC 字节为 ``(pcm, sample_rate, channels, bytes_per_sample)``。

    两种格式统一解到 16bit 小端 PCM；解码失败返回 None（调用方回退
    既有独立分析路径，绝不误切分）。FLAC 走 soundfile（生产依赖已在），
    不做重采样——非 16k 输入由调用方按既有逻辑拒绝接管。
    """
    if not data:
        return None
    fmt = sniff_audio_fmt(data)
    if fmt == "wav":
        try:
            with wave.open(io.BytesIO(data), "rb") as wf:
                pcm = wf.readframes(wf.getnframes())
                return (pcm, wf.getframerate(), wf.getnchannels(), wf.getsampwidth())
        except Exception:
            return None
    if fmt == "flac":
        try:
            import soundfile as sf
            import numpy as np
            with sf.SoundFile(io.BytesIO(data)) as f:
                rate = f.samplerate
                channels = f.channels
                arr = f.read(dtype="int16", always_2d=True)  # (frames, channels)
            # 交错 s16le：frames x channels -> interleaved bytes（与 wave 帧序一致）
            interleaved = np.ascontiguousarray(arr, dtype="<i2").tobytes()
            return (interleaved, rate, channels, 2)
        except Exception:
            return None
    return None


# 向后兼容别名：既有调用方（含测试）只解 WAV
decode_wav_pcm = decode_audio_pcm


def encode_audio_bytes(
    pcm: bytes,
    fmt: str = "wav",
    sample_rate: int = _DEFAULT_SAMPLE_RATE,
    channels: int = 1,
    bytes_per_sample: int = _DEFAULT_BYTES_PER_SAMPLE,
) -> bytes:
    """把原始 PCM 封装为指定格式字节（"wav" 默认 | "flac"）。

    FLAC 走 soundfile；编码失败回退 WAV（chunk 落盘绝不丢数据）。
    内核 segment 模式恒产 WAV，FLAC 档设备由本函数在外层重编码（IO 编码，
    非算法，符合 D1 边界）。
    """
    if fmt == "flac":
        try:
            import soundfile as sf
            import numpy as np
            arr = np.frombuffer(pcm, dtype="<i2")
            if channels > 1:
                arr = arr.reshape(-1, channels)
            buf = io.BytesIO()
            sf.write(buf, arr, sample_rate, format="FLAC", subtype="PCM_16")
            return buf.getvalue()
        except Exception as e:
            logger.warning(f"[Ingest] FLAC 编码失败，chunk 回退 WAV: {e}")
    return pcm_to_wav(pcm, sample_rate, channels)


def _default_channel_factory(start_ms: int, opts: Dict[str, Any]) -> SegmentChannel:
    """生产缺省切分通道工厂：新建一条内核 segment 通道（**不在此建连**——
    open 延迟到会话首帧喂入时，保证导入/构造会话永不触内核与 spawn）。
    """
    return build_segment_channel(
        name=str(opts.get("device_id") or ""),
        t0_ms=start_ms,
        sample_rate=opts.get("sample_rate", _DEFAULT_SAMPLE_RATE),
        bytes_per_sample=opts.get("bytes_per_sample", _DEFAULT_BYTES_PER_SAMPLE),
        rms_threshold=opts.get("rms_threshold", _DEFAULT_RMS_THRESHOLD),
        frame_ms=opts.get("frame_ms", _DEFAULT_FRAME_MS),
        silence_cut_s=opts.get("silence_cut_s", _DEFAULT_SILENCE_CUT_S),
        min_chunk_s=opts.get("min_chunk_s", _DEFAULT_MIN_CHUNK_S),
        max_chunk_s=opts.get("max_chunk_s", _DEFAULT_MAX_CHUNK_S),
    )


class DeviceIngestSession(KernelSegmentSessionBase):
    """单个设备的音频摄入会话：时间连续 = 同一条虚拟流。

    使用方式：对每个上传分段调用 :meth:`ingest`，接收本次产出的分析段；
    空闲时由 :meth:`sweep` 冲刷超时尾段；会话结束（或需要强制收尾）时调用
    :meth:`flush`。

    切分委托内核 segment 通道（每流一条，惰性建连）；通道不可用时该流降级为
    逐段独立产出（镜像兜底，冷却后新流重试）。镜像/降级/收割/消费原子件继承自
    :class:`KernelSegmentSessionBase`（V12 刀1：与 WS 流式会话共享单实现；
    本类并发模型 = 每设备实例 + 自身 RLock 于公开入口包裹，全部 ``_locked``
    内部件在持锁下调用基类原语，基类不持锁）。

    本类线程安全（内部互斥锁），允许 WS 与 HTTP 并发到达同一设备。
    """

    def __init__(
        self,
        device_id: str,
        *,
        stitch_enabled: bool = True,
        holdback_s: Optional[float] = None,
        min_flush_speech_ratio: Optional[float] = None,
        tolerance_ms: Optional[int] = None,
        max_chunk_s: Optional[float] = None,
        min_chunk_s: Optional[float] = None,
        silence_cut_s: Optional[float] = None,
        sample_rate: Optional[int] = None,
        bytes_per_sample: Optional[int] = None,
        frame_ms: Optional[int] = None,
        rms_threshold: Optional[float] = None,
        channel_factory: Optional[Callable[[int, Dict[str, Any]], Any]] = None,
        degraded_cooldown_s: float = _DEGRADED_COOLDOWN_S,
    ) -> None:
        """
        Args:
            channel_factory: 切分通道工厂 ``(start_ms, opts) -> channel``；
                None 用生产缺省（:func:`_default_channel_factory`）。测试注入
                假通道（鸭子接口：open/push/stop/drain_pending/close）。opts 含
                device_id 与全部切分参数。
            degraded_cooldown_s: 通道建立失败后的降级冷却时长（秒）。

        其余参数为 None 时取模块级配置快照：``reload_audio_config_snapshot()``
        之后新建的会话使用新值，既有会话保留构造时的值。
        """
        holdback_s = _DEFAULT_HOLDBACK_S if holdback_s is None else holdback_s
        min_flush_speech_ratio = (
            _DEFAULT_MIN_FLUSH_SPEECH_RATIO
            if min_flush_speech_ratio is None
            else min_flush_speech_ratio
        )
        tolerance_ms = _DEFAULT_TOLERANCE_MS if tolerance_ms is None else tolerance_ms
        max_chunk_s = _DEFAULT_MAX_CHUNK_S if max_chunk_s is None else max_chunk_s
        min_chunk_s = _DEFAULT_MIN_CHUNK_S if min_chunk_s is None else min_chunk_s
        silence_cut_s = (
            _DEFAULT_SILENCE_CUT_S if silence_cut_s is None else silence_cut_s
        )
        sample_rate = _DEFAULT_SAMPLE_RATE if sample_rate is None else sample_rate
        bytes_per_sample = (
            _DEFAULT_BYTES_PER_SAMPLE
            if bytes_per_sample is None
            else bytes_per_sample
        )
        frame_ms = _DEFAULT_FRAME_MS if frame_ms is None else frame_ms
        rms_threshold = (
            _DEFAULT_RMS_THRESHOLD if rms_threshold is None else rms_threshold
        )

        super().__init__()
        self.device_id = device_id
        self._stitch_enabled = bool(stitch_enabled)
        self._holdback_ms = max(0, int(float(holdback_s) * 1000))
        # 产出块的语音占比下限：低于此值视为无语音内容，不产出条目
        self._min_flush_speech_ratio = float(min_flush_speech_ratio)
        # 无缝流参数
        self._tolerance_ms = max(0, int(tolerance_ms))
        self._max_chunk_s = max(0.0, float(max_chunk_s))
        self._min_chunk_s = max(0.0, float(min_chunk_s))
        self._silence_cut_s = max(0.0, float(silence_cut_s))
        # 音频格式与能量判定参数
        self._sample_rate = int(sample_rate)
        self._bytes_per_sample = int(bytes_per_sample)
        self._frame_ms = int(frame_ms)
        self._rms_threshold = float(rms_threshold)
        # 切分通道工厂与降级冷却
        self._channel_factory = channel_factory or _default_channel_factory
        self._cooldown_s = max(0.0, float(degraded_cooldown_s))
        self._degraded_until = 0.0   # 冷却截止（monotonic 秒）；期内新流直接降级
        self._degraded = False       # 流降级标记（基类字段，reset 流时清除）

        self._lock = threading.RLock()

        # 去重表：key = (device_id, session_id, seq, start_ms) -> 首次接收时刻
        self._seen: Dict[Tuple[str, str, int, int], int] = {}

        # 绝对时间轴水位：已喂入音频的结束时间（epoch 毫秒）；None 表示尚未开始
        self._watermark_ms: Optional[int] = None

        # 当前虚拟流：起始绝对时间 + 已喂入样本数。
        # 流的结束时间由二者推算（不逐次累加毫秒，避免四舍五入漂移）。
        self._stream_start_ms: Optional[int] = None
        self._stream_samples: int = 0
        # 镜像缓冲 _mirror / _mirror_start_ms 与通道 _channel = 基类字段，
        # __init__ 已经 super() 初始化；镜像起点随产出消费前移，
        # 兜底冲刷时作为 chunk 起点（等价旧切分器的 _chunk_start_wall_ms）。

        # 空闲计时（holdback 依据：接收空闲时长，而非音频时间戳年龄——
        # 后者会让历史补传音频被立即冲刷、破坏拼接）
        self._idle_since_ms: Optional[int] = None

        self._last_device_name = ""
        self._last_session_id = ""
        # T2: 最近一次 ingest 的上传格式，决定产出 chunk 的落盘封装格式
        self._last_fmt = "wav"

    # ========== 只读状态 ==========

    @property
    def pending_samples(self) -> int:
        """当前流中尚未产出（镜像里仍待切出/冲刷）的采样数。"""
        with self._lock:
            return len(self._mirror) // self._bytes_per_sample

    @property
    def watermark_ms(self) -> int:
        """已处理音频的绝对结束时间（epoch 毫秒）；尚未开始时为 0。"""
        with self._lock:
            return int(self._watermark_ms or 0)

    def has_pending_tail(self) -> bool:
        """当前流中是否有待产出的音频。"""
        return self.pending_samples > 0

    @property
    def stream_degraded(self) -> bool:
        """当前流是否处于降级（无静音切分）模式。"""
        with self._lock:
            return self._degraded

    # ========== 公开接口 ==========

    def ingest(
        self,
        *,
        session_id: str = "",
        seq: Optional[int] = -1,
        start_ms: Optional[int],
        pcm: bytes,
        device_name: str = "",
        fmt: str = "wav",
        now_ms: Optional[int] = None,
    ) -> IngestOutcome:
        """把一个上传文件喂入会话（符合时间连续性则追加到当前流）。

        Args:
            session_id: 会话标识（App 未上报时为空串）。
            seq: 分段序号（App 未上报时为 -1）。
            start_ms: 本段首样本绝对墙钟时间（epoch 毫秒）。
            pcm: 本段原始 PCM 字节（16kHz/单声道/16bit）。
            device_name: 设备名（写入产出 chunk，供分析链路记录）。
            fmt: 上传格式（"wav" | "flac"），决定后续产出 chunk 的封装格式。
            now_ms: 当前接收时刻（可注入，便于测试）；默认取系统时间。

        Returns:
            本次产出（emitted 可能为空：音频先进内核累积，等静音端点/硬上限/
            超时才产出；降级流则每段即时产出）。
        """
        now = int(now_ms) if now_ms is not None else _now_ms()
        with self._lock:
            if start_ms is None:
                # 无绝对时间无法落到时间轴，交由调用方回退既有独立分析路径
                return IngestOutcome(skipped=True)

            start_raw = int(start_ms)
            # 1. 去重：同一 (device, session, seq, start_ms) 只处理一次，
            #    覆盖 App 重试与缓存重放两种重复来源。
            dedup_key = (
                self.device_id,
                str(session_id or ""),
                int(seq) if seq is not None else -1,
                start_raw,
            )
            if dedup_key in self._seen:
                logger.debug(
                    f"[AudioIngest] 命中去重，跳过重复分段 device={self.device_id} "
                    f"session={session_id!r} seq={seq} start={start_raw}"
                )
                return IngestOutcome(duplicate=True)
            self._record_seen(dedup_key, now)

            self._last_device_name = device_name or self._last_device_name
            self._last_session_id = str(session_id or "") or self._last_session_id
            # T2: 记录本段格式（chunk 封装用；PCM 层拼接与格式无关）
            self._last_fmt = fmt if fmt in ("wav", "flac") else "wav"

            data = bytes(pcm or b"")
            if not data:
                return IngestOutcome()

            # 2. 水位裁剪：App 有 500ms 前滚重叠，裁掉与已处理区间重叠的头部
            eff_start_ms = start_raw
            if self._watermark_ms is not None and eff_start_ms < self._watermark_ms:
                overlap_ms = self._watermark_ms - eff_start_ms
                trim_bytes = (
                    int(overlap_ms * self._sample_rate / 1000) * self._bytes_per_sample
                )
                if trim_bytes >= len(data):
                    # 整段都落在已处理区间内：重放/过晚分段，安全丢弃以防重复音频
                    logger.warning(
                        f"[AudioIngest] 分段完全落在已处理区间，丢弃 "
                        f"device={self.device_id} start={start_raw} "
                        f"watermark={self._watermark_ms}"
                    )
                    return IngestOutcome(skipped=True)
                data = data[trim_bytes:]
                eff_start_ms = self._watermark_ms

            emitted: List[EmittedChunk] = []
            prev_end_ms = self._stream_end_ms_locked()
            duration_ms = self._duration_ms(data)

            # 3. 时间连续性判定：B.start_ms <= A.end_ms + 容差
            if prev_end_ms is not None and eff_start_ms > prev_end_ms + self._tolerance_ms:
                logger.info(
                    f"[AudioIngest] 判定=不连续 device={self.device_id} "
                    f"当前流结束={prev_end_ms} 新分段起点={eff_start_ms} "
                    f"间隙={eff_start_ms - prev_end_ms}ms > 容差{self._tolerance_ms}ms "
                    f"-> 先冲刷当前流，再开新流"
                )
                emitted.extend(self._flush_locked("discontinuity"))
            else:
                if prev_end_ms is None:
                    logger.info(
                        f"[AudioIngest] 判定=新流 device={self.device_id} "
                        f"分段起点={eff_start_ms} 时长={duration_ms}ms"
                    )
                else:
                    gap_ms = max(0, eff_start_ms - prev_end_ms)
                    logger.info(
                        f"[AudioIngest] 判定=连续 device={self.device_id} "
                        f"当前流结束={prev_end_ms} 新分段起点={eff_start_ms} "
                        f"间隙={gap_ms}ms <= 容差{self._tolerance_ms}ms -> 追加到同一条流，不切分"
                    )
                    if gap_ms > 0:
                        # 容差内的间隙用静音补齐，保持绝对时间轴与样本数严格对齐
                        self._append_locked(
                            self._silence_pcm(gap_ms), prev_end_ms, emitted
                        )

            # 4. 追加本分段：跨文件不切分，切点由内核在流内静音端点/硬上限处给
            self._append_locked(data, eff_start_ms, emitted)

            # 5. 记账：水位推进到本分段的绝对结束时间；刷新空闲计时
            self._watermark_ms = max(self._watermark_ms or 0, eff_start_ms + duration_ms)
            self._idle_since_ms = now
            return IngestOutcome(emitted=emitted)

    def sweep(self, now_ms: Optional[int] = None) -> List[EmittedChunk]:
        """空闲超时冲刷：当前流在 ``holdback_s`` 内无新文件到达时强制产出。

        "保留时长"以**接收空闲时长**计（距最近一次成功 ingest 的时间），
        而非音频时间戳年龄——后者会让历史补传音频被立即冲刷、破坏拼接。
        冲刷 = 通道 ``session.stop``（内核把尾段以 segment.closed 送出），
        语义等价旧的本地 flush。
        """
        now = int(now_ms) if now_ms is not None else _now_ms()
        with self._lock:
            if not self._stitch_enabled:
                return []
            if self._stream_start_ms is None:
                return []
            if self._idle_since_ms is None:
                return []
            idle_ms = now - self._idle_since_ms
            if idle_ms < self._holdback_ms:
                return []
            if not self._mirror:
                # 流里没有待产出音频（例如全是静音已被内核切出且被占比过滤），仅重置状态
                self._reset_stream_locked()
                return []
            logger.info(
                f"[AudioIngest] 空闲超时冲刷尾段 device={self.device_id} "
                f"空闲={idle_ms}ms >= holdback={self._holdback_ms}ms"
            )
            return self._flush_locked("holdback")

    def flush(self) -> List[EmittedChunk]:
        """强制冲刷当前流的剩余音频（会话结束/需要立即收尾时调用）。"""
        with self._lock:
            if self._stream_start_ms is None:
                return []
            return self._flush_locked("flush")

    def close(self) -> None:
        """释放会话持有的内核切分通道（不发 stop、不产出——注册表 reset 用）。

        镜像中的音频由调用方负责：要么已 flush 产出，要么接受丢弃（进程级
        重启语义下由 App 重传/ checkpoint 兜底）。
        """
        with self._lock:
            ch, self._channel = self._channel, None
        if ch is not None:
            try:
                ch.close()
            except Exception:
                pass

    # ========== 内部实现：流生命周期 ==========

    def _stream_end_ms_locked(self) -> Optional[int]:
        """当前流的绝对结束时间（epoch 毫秒）；流为空时返回 None。"""
        if self._stream_start_ms is None:
            return None
        return self._stream_start_ms + int(
            round(self._stream_samples * 1000.0 / self._sample_rate)
        )

    def _silence_pcm(self, ms: int) -> bytes:
        """生成 ``ms`` 毫秒静音 PCM（用于补齐容差内的间隙）。"""
        samples = int(round(max(0, int(ms)) * self._sample_rate / 1000.0))
        return b"\x00" * (samples * self._bytes_per_sample)

    def _channel_opts_locked(self) -> Dict[str, Any]:
        """构造切分通道工厂的参数（config -> 内核 segment 参数映射）。"""
        return {
            "device_id": self.device_id,
            "sample_rate": self._sample_rate,
            "bytes_per_sample": self._bytes_per_sample,
            "rms_threshold": self._rms_threshold,
            "frame_ms": self._frame_ms,
            "silence_cut_s": self._silence_cut_s,
            "min_chunk_s": self._min_chunk_s,
            "max_chunk_s": self._max_chunk_s,
        }

    def _append_locked(
        self, pcm: bytes, wall_ms: int, out: List[EmittedChunk]
    ) -> None:
        """把一段音频追加到当前流：推入内核切分通道并收割切出的分析段。

        通道不可用（建立失败/中途死亡）时按纪律降级当前流为逐段独立产出，
        本段照常入库，**绝不因切分失败而丢音频**。
        """
        if not pcm:
            return
        if self._stream_start_ms is None:
            self._stream_start_ms = int(wall_ms)
            self._stream_samples = 0
            self._mirror_reset(wall_ms)
            # 冷却期内新流直接降级（不再付建连/超时成本），期满重试
            self._degraded = self._in_cooldown_locked()
        self._stream_samples += len(pcm) // self._bytes_per_sample
        self._mirror_extend(pcm, wall_ms)

        # 降级流：逐段独立产出（stitch=false 既有语义），无静音切分
        if self._degraded:
            self._drain_whole_mirror(out, "cut")
            return

        # 惰性建立通道（永不毁在构造路径，只毁在真正有音频要切的时刻）
        if self._channel is None:
            try:
                self._channel = self._channel_factory(
                    int(self._stream_start_ms), self._channel_opts_locked()
                )
                self._channel.open()
            except Exception as e:
                self._degrade(f"切分通道建立失败: {type(e).__name__}: {str(e)[:200]}")
                self._drain_whole_mirror(out, "cut")
                return

        # 通道已死（error 帧/读循环断开但 push 未触发异常）：先收割再降级
        if getattr(self._channel, "dead", False):
            self._harvest_into(out)
            self._degrade("切分通道已降级（dead）")
            self._drain_whole_mirror(out, "cut")
            return

        try:
            chunks = self._channel.push(bytes(pcm))
        except StopWithChunksError as e:
            # push 理论上不发 stop 帧；防御：异常带段则先收割
            for sc in e.chunks:
                self._consume_kernel_chunk(sc, out, "cut")
            self._harvest_into(out)
            self._degrade(f"通道推送异常: {str(e)[:150]}")
            self._drain_whole_mirror(out, "cut")
            return
        except SegmentChannelError as e:
            # 本段是否已进内核不可知；镜像兜底 + 后续降级。不在此冲刷镜像
            # （若内核实际收到了本段，close 弃连后其缓冲被内核丢弃，无重复）。
            self._harvest_into(out)
            self._degrade(f"通道推送失败: {type(e).__name__}: {str(e)[:200]}")
            return

        for sc in chunks:
            self._consume_kernel_chunk(sc, out, "cut")

    def _fallback_start_ms(self) -> int:
        return self._stream_start_ms or 0

    def _warn_mirror_mismatch(self, kernel_bytes: int, mirror_bytes: int) -> None:
        # 内核段长与镜像不一致（理论上不应发生）：以实际字节数消费，记 WARN
        logger.warning(
            f"[AudioIngest] 内核段与镜像记账不一致 device={self.device_id} "
            f"kernel_bytes={kernel_bytes} mirror_bytes={mirror_bytes}"
        )

    def _emit_consumed(self, pcm: bytes, start_ms: int, trigger: str,
                      out: List[EmittedChunk]) -> None:
        chunk = self._make_chunk(pcm, start_ms, trigger)
        if chunk is not None:
            logger.info(
                f"[AudioIngest] 流内切出一个分析段 device={self.device_id} "
                f"trigger={trigger} 起点={chunk.start_ms} "
                f"时长={chunk.sample_count * 1000 // self._sample_rate}ms"
            )
            out.append(chunk)

    def _emit_whole(self, pcm: bytes, start_ms: int, trigger: Optional[str],
                    out: List[EmittedChunk]) -> None:
        chunk = self._make_chunk(pcm, start_ms, trigger or "cut")
        if chunk is not None:
            logger.info(
                f"[AudioIngest] 兜底/降级产出 device={self.device_id} trigger={trigger} "
                f"起点={chunk.start_ms} "
                f"时长={chunk.sample_count * 1000 // self._sample_rate}ms"
            )
            out.append(chunk)

    def _warn_harvest_failure(self, exc: Exception) -> None:
        logger.warning(
            f"[AudioIngest] 收割通道未决段失败（镜像兜底） device={self.device_id}: "
            f"{type(exc).__name__}: {str(exc)[:150]}"
        )

    def _on_degraded(self, reason: str) -> None:
        self._degraded_until = time.monotonic() + self._cooldown_s
        logger.error(
            f"[AudioIngest] 设备流降级为逐段独立分析 device={self.device_id} "
            f"原因={reason}（冷却{int(self._cooldown_s)}s，期内新流不再尝试内核；"
            f"绝不回退本地切分）"
        )

    def _in_cooldown_locked(self) -> bool:
        return time.monotonic() < self._degraded_until

    def _reset_stream_locked(self) -> None:
        """重置当前流（冲刷完毕后调用）：关通道、清镜像与流状态。"""
        self._close_channel()
        self._stream_start_ms = None
        self._stream_samples = 0
        self._mirror_reset()
        self._degraded = False

    def _flush_locked(self, trigger: str) -> List[EmittedChunk]:
        """产出当前流的全部剩余音频（holdback/flush/discontinuity），并重置流。

        正常路径 = ``session.stop`` 让内核把尾段以 segment.closed 送出；
        降级/异常路径 = 收割未决帧后镜像整体兜底（绝不丢音频字节）。
        """
        out: List[EmittedChunk] = []
        ch = self._channel
        if not self._degraded and ch is not None:
            try:
                for sc in ch.stop():
                    self._consume_kernel_chunk(sc, out, trigger)
            except StopWithChunksError as e:
                for sc in e.chunks:
                    self._consume_kernel_chunk(sc, out, trigger)
            except Exception as e:
                logger.warning(
                    f"[AudioIngest] 通道 stop 失败，转镜像兜底 device={self.device_id}: "
                    f"{type(e).__name__}: {str(e)[:150]}"
                )
        self._harvest_into(out)
        self._drain_whole_mirror(out, trigger)
        had_stream = self._stream_start_ms is not None
        self._reset_stream_locked()
        if had_stream and not out:
            logger.info(
                f"[AudioIngest] 冲刷内容无语音/无剩余，跳过产出 "
                f"device={self.device_id} trigger={trigger}"
            )
        return out

    def _record_seen(self, key: Tuple[str, str, int, int], now_ms: int) -> None:
        """写入去重表，并在超容量时淘汰最旧的一批。"""
        self._seen[key] = now_ms
        if len(self._seen) > _DEDUP_MAX_ENTRIES:
            overflow = len(self._seen) - _DEDUP_MAX_ENTRIES
            for old_key in list(self._seen.keys())[:overflow]:
                self._seen.pop(old_key, None)

    def _duration_ms(self, pcm: bytes) -> int:
        """PCM 时长（毫秒，四舍五入）。"""
        if not pcm:
            return 0
        samples = len(pcm) // self._bytes_per_sample
        return int(round(samples * 1000.0 / self._sample_rate))

    def _speech_ratio(self, pcm: bytes) -> float:
        """计算 PCM 的有声帧占比（逐帧能量判定，不引入第三方依赖）。"""
        if not pcm:
            return 0.0
        frame_samples = max(1, self._frame_ms * self._sample_rate // 1000)
        frame_bytes = frame_samples * self._bytes_per_sample
        total = 0
        voiced = 0
        for offset in range(0, len(pcm) - frame_bytes + 1, frame_bytes):
            total += 1
            if _frame_rms(pcm[offset:offset + frame_bytes], self._bytes_per_sample) > self._rms_threshold:
                voiced += 1
        if total == 0:
            # 短于一帧：整段 RMS 兜底
            return 1.0 if _frame_rms(pcm, self._bytes_per_sample) > self._rms_threshold else 0.0
        return voiced / total

    def _make_chunk(
        self, pcm: bytes, start_ms: Optional[int], trigger: str
    ) -> Optional[EmittedChunk]:
        """把 PCM 封装为产出块；无语音内容（纯静音/极低占比）时返回 None。"""
        if not pcm or start_ms is None:
            return None
        ratio = self._speech_ratio(pcm)
        if ratio < self._min_flush_speech_ratio:
            logger.info(
                f"[AudioIngest] 产出块无语音内容，跳过 "
                f"device={self.device_id} trigger={trigger} "
                f"speech_ratio={ratio:.3f} < {self._min_flush_speech_ratio:.3f}"
            )
            return None
        sample_count = len(pcm) // self._bytes_per_sample
        start = int(start_ms)
        return EmittedChunk(
            pcm=bytes(pcm),
            start_ms=start,
            end_ms=start + self._duration_ms(pcm),
            sample_count=sample_count,
            device_id=self.device_id,
            device_name=self._last_device_name,
            session_id=self._last_session_id,
            trigger=trigger,
            fmt=self._last_fmt,
        )


__all__ = [
    "DeviceIngestSession",
    "EmittedChunk",
    "IngestOutcome",
    "decode_wav_pcm",
    "decode_audio_pcm",
    "encode_audio_bytes",
    "sniff_audio_fmt",
    "stitch_options_from_config",
    "reload_audio_config_snapshot",
]
