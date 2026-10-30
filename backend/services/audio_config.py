"""音频子系统统一配置加载模块。

配置来源：``get_config()._data`` 的 live 快照（``audio`` / ``tts`` 小节），
不直接读取任何配置载体文件。YAML / JSON / SQLite / 环境变量 overlay 的差异
全部由 ``ConfigStore`` 屏蔽；ConfigStore 热重载后由
``invalidate_audio_config()`` 触发下一次重建。

快照缺失或读取失败时回落到代码内置默认 ``DEFAULT_AUDIO_CONFIG``，保证可移植
与 fail-safe（无配置的部署照常启动，行为与历史硬编码值一致）。

小节结构（与 config.example.yaml 的 ``audio:`` / ``tts:`` 节对应）：
- ``stream``      音频流切分与队列（原 audio_stream_* / audio_analysis_queue 硬编码）
- ``vad``         pyannote VAD（原 vad_processor.py 硬编码）
- ``voiceprint``  声纹阈值 / 滑窗 / 身份分档 / 采集 / 注册质量门
- ``wake_word``   唤醒词（KWS + 录音状态机，纯新增）
- ``assistant``   语音助手历史常量（原服务已删，配置键保留兼容）
- ``tts``         设备路由（来自顶层 ``tts:`` 节，合并进返回值的 tts 键）

返回结构说明：``get_audio_config()`` 返回合并后的 ``audio`` 小节（顶层键为
stream / vad / voiceprint / wake_word / assistant / tts），与
``unknown_speaker_config.get_unknown_speaker_config()`` 语义一致；同时额外提供
一个 ``audio`` 别名键，使 ``get_audio_config()["audio"]["voiceprint"]`` 与
``get_audio_config()["voiceprint"]`` 两种写法均可工作。

本模块只依赖标准库，导入本身不会触发 torch / funasr 等重型依赖，
可在任意位置安全 import。

配置有进程内缓存：``ConfigStore`` 写入后调用 ``invalidate_audio_config()``
即可让下一次读取看到新快照。
"""

from __future__ import annotations

import copy
import logging
import os
import threading
from typing import Any

from config.config import get_config

logger = logging.getLogger(__name__)

_PROJECT_ROOT = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
)

# 代码内置默认配置（计划 §8.2 全量）。作为兜底与可移植基础：
# 默认值等于当前硬编码值，唯二有意变化为：
#   1. 声纹滑窗由 1000/750 统一为 1500/750（计划阶段 8）
#   2. wake_word.enabled / assistant.enabled 默认 False（新功能默认关闭）
DEFAULT_AUDIO_CONFIG = {
    # ---------- 存储格式（T2/T4 上传双档） ----------
    "store": {
        # 上传音频落盘默认扩展名（magic 嗅探未知时的回退）："wav" | "flac"。
        # 非法值一律回退 "wav"；生效格式由客户端上传内容决定（后端 magic sniff，
        # 不信任 Content-Type），本键只兜底无法嗅探的场景。
        "upload_ext": "wav",
    },
    # ---------- 音频流切分与队列 ----------
    "stream": {
        "sample_rate": 16000,          # 采样率（Hz）
        "bytes_per_sample": 2,         # 16bit = 2 字节/样本
        "channels": 1,                 # 单声道
        "min_chunk_s": 10.0,           # 最短块（除 flush 外不得更短）
        "silence_cut_s": 1.5,          # 静音优先切分
        "force_cut_s": 60.0,           # 硬上限强切
        "rms_threshold": 5.0,          # 静音判定 RMS
        "frame_ms": 30,                # 逐帧判定
        "queue_maxsize": 32,           # 分析队列上限
        "max_pending_minutes": 5,      # 背压上限（分钟）
        "session_max_s": 300,          # 背压上限（秒）= max_pending_minutes * 60
        "stitch_enabled": True,        # 上传分段无缝流（跨文件当作一条流分析）
        "holdback_s": 90.0,            # 当前流空闲多久（秒）后强制冲刷尾段
        "min_flush_speech_ratio": 0.05,  # 产出块语音占比下限（低于此值视为纯静音，不产出条目）
        "persist_perception": False,   # 流式音频是否也写 perception.jsonl（false=流式隔离）
        # 无缝流：时间连续性容差 / 硬上限 / 静音切分阈值，详见 audio_ingest_session.py
        "stitch": {
            "tolerance_ms": 1000,      # 时间连续判定容差（ms）：B.start <= A.end + 容差
            "max_chunk_s": 120.0,      # 单个分析段硬上限（s），防无限累积（= 2 个上传文件周期）
            "min_chunk_s": 10.0,       # 静音端点切分前的最短累积（s）
            "silence_cut_s": 1.5,      # 静音端点持续时长（s），达到即优先切分
        },
    },
    # ---------- VAD ----------
    "vad": {
        "engine": "pyannote",                     # pyannote | silero（替代 VAD_ENGINE 环境变量）
        "device": "cuda:0",                       # 推理设备
        "model": "pyannote/segmentation-3.0",
        "threshold": 0.5,                         # 语音概率阈值（接线 voiceprint.vad_threshold）
        "min_speech_ms": 200,                     # 最短语音段
        "min_silence_ms": 300,                    # 最短静音间隔
        "merge_gap_s": 0.3,                       # 二次合并间隙（独立于 min_silence）
        "reject_stationary_noise": True,          # 稳态噪声剔除
        "window_s": 10.0,                         # pyannote sliding duration
        "step_s": 0.5,                            # pyannote sliding step
        "bucket_ms": 100,                         # 概率曲线聚合桶
        "min_audio_ms": 100,                      # 短于此时长直接判空
        "min_wav_samples": 1600,                  # 短于此样本数（0.1s @16k）直接判空
        "dyn_min": 3.0,                           # 稳态噪声动态范围门（= stationary_noise.min_dynamic_db）
        "voiced_min": 0.08,                       # 稳态噪声有声占比门（= stationary_noise.min_voiced_ratio）
        "stationary_noise": {                     # 稳态噪声判据（原 _is_stationary_noise 魔数）
            "min_dynamic_db": 3.0,
            "min_voiced_ratio": 0.08,
            "frame_ms": 25,
            "low_percentile": 15,
            "high_percentile": 95,
            "energy_floor": 1.0e-5,
            "voiced_multiplier": 3.0,
            "skip_below_s": 0.5,                  # 短于此段不做噪声判别
        },
    },
    # ---------- 声纹 ----------
    "voiceprint": {
        "verify_threshold": 0.55,        # 验证默认阈值
        "identify_threshold": 0.45,      # 识别默认阈值
        "embedding_dim": 192,            # ERes2NetV2 输出维度
        # 以下 7 项与 cohort.* 同源（历史模块级常量，见计划 §9.2），
        # 顶层保留以兼容直接读 voiceprint.xxx 的旧调用点。
        "min_dur_sec": 2.0,              # cohort 采集最短时长
        "max_dur_sec": 55.0,             # cohort 采集最长（排 60s 整段）
        "min_rms": 0.008,
        "collect_sim_max": 0.25,         # 入池 raw sim 上限
        "dedup_min_dist": 0.01,
        "max_per_day_src": 5,
        "sim_max_internal": 0.60,        # 多样性冗余上限
        "as_norm": {
            "activate_min_cohort": 10,   # 域切换门：<10 用 raw cos，>=10 用 tanh(AS-Norm/scale)
            "scale": 3.0,                # tanh 缩放分母
            "min_cohort": 10,            # 兼容别名（计划 §8.2 命名）
            "tanh_scale": 3.0,           # 兼容别名（计划 §8.2 命名）
            "eps": 1.0e-5,               # 数值稳定 epsilon
        },
        "sliding": {                     # 段级声纹滑窗趋势
            "window_ms": 1500,           # 由 1000 改为 1500，与分析链路 two_step 对齐
            "hop_ms": 750,
            "label_threshold": 0.5,      # speaker 名标注阈值
        },
        "tag": {                         # 逐字/整段身份分档
            "registered_sim": 0.75,      # 判为 registered 的最低分
            "mixed_sim": 0.30,           # 判为 mixed 的最低分
            "self_pct": 0.90,            # 整段判 self
            "mixed_pct": 0.20,           # 整段判 mixed
        },
        "segment": {
            "min_speech_s": 0.5,         # 进入声纹分析的最短段
            "max_s": 55.0,               # 候选区/建档时长上限
            "vad_coverage": 0.4,         # VAD 覆盖不足回退整段的比例
        },
        "cohort": {
            "min_dur_s": 2.0,            # 采集最短时长
            "max_dur_s": 55.0,           # 采集最长（排 60s 整段）
            "collect_sim_max": 0.25,     # 入池 raw sim 上限
            "min_rms": 0.008,
            "dedup_min_dist": 0.01,
            "max_per_day_src": 5,
            "active_size": 500,          # 工作集上限（取代死配置 voiceprint.cohort_max_samples）
            "flush_batch": 100,
            "compact_interval": 5,
            "sim_max_internal": 0.60,
        },
        "enroll": {                      # 注册质量门
            "min_seg_s": 1.0,            # 逐段最小时长
            "min_seg_count": 2,          # 最少合格段
            "min_seg_snr": 1.0,          # 逐段 SNR 门（原 voiceprint.min_seg_snr）
            "min_consistency": 0.55,     # 段间一致性（原 voiceprint.min_consistency）
            "trigger_count": 3,          # 触发一致性过滤的段数
        },
    },
    # ---------- 唤醒（KWS + 录音状态机） ----------
    "wake_word": {
        "enabled": False,            # 默认关闭（功能未完成/未部署模型时为 fail-safe）
        "keywords_file": "",         # 空 = <AI_ROOT>/data/wake_word/keywords.txt
        "model_dir": "",             # 空 = <AI_ROOT>/data/wake_word/sherpa-onnx-kws-...
        "chunk": 8,                  # 8=160ms / 16=320ms
        "num_threads": 1,
        "keywords_score": 1.8,       # 2026-09-14 标定；2.5 经全天实测否决（误报 0→2）
        "keywords_threshold": 0.25,
        "pre_roll_ms": 1000,         # 唤醒命中前的预滚缓冲（防指令开头被截）
        "entry_score_cohort_ready": 0.75,   # 进门验证（cohort 就位）
        "entry_score_no_cohort": 0.5,       # 进门验证（cohort 未就位）
        "entry_threshold_ready": 0.75,      # 兼容别名（计划 §8.2 命名）
        "entry_threshold_cold": 0.5,        # 兼容别名（计划 §8.2 命名）
        "exit_threshold": 0.75,             # 停止判定：声纹低分门
        "exit_hold_ms": 3750,               # 声纹持续低分时长（约 5 窗 @750ms）
        "vad_silence_ms": 3000,             # 停止判定：VAD 静音时长
        "hard_limit_ms": 1800000,           # 硬上限 30 分钟（兜底）
        "max_record_ms": 1800000,           # 兼容别名（计划 §8.2 命名）
        "min_record_ms": 2500,              # 唤醒确认（进入录制态）后最短录音时长（防秒停）
        "weak_split": {                     # 弱切分（防 ASR 长音频质量下降）
            "enabled": True,
            "window_ms": 1500,
            "low_energy_win_ms": 1500,      # 找能量低谷的窗长
            "min_seg_ms": 2500,             # 子段下限（低于不切/回并）
            "max_seg_ms": 12000,            # 段长上限（超过强制切）
        },
    },
    # ---------- 语音助手历史常量（服务已删，配置键保留兼容） ----------
    "assistant": {
        "enabled": False,            # 默认关闭（历史服务，被唤醒链路取代）
        "sample_rate": 16000,
        "channels": 1,
        "bits_per_sample": 16,
        "rms_threshold": 5.0,        # 能量 VAD 阈值
        "min_speech_ms": 500,        # 最短语音段
        "silence_timeout_ms": 3000,  # 静音超时
        "voiceprint_window_ms": 1000,   # 声纹滑窗粒度
        "voiceprint_history_ms": 3000,  # 声纹历史窗口
        "voiceprint_threshold": 0.3,    # 声纹低分阈值
        "min_segment_ms": 500,          # 最短 ASR 段
        "max_buffer_seconds": 5,        # 主缓冲上限（秒）
    },
    # ---------- TTS 设备路由（来自顶层 tts: 节） ----------
    "tts": {
        "enabled": True,                       # 总开关；false 退化为原有广播行为
        "device_channel_ttl_seconds": 3600,    # 回传通道滑动 TTL（秒）
        "fallback_client_types": ["web"],      # 无定向目标时的回退客户端类型
    },
}

# 进程内缓存 + 首载锁（防止多线程并发重复构建）
_config_cache: "dict[str, Any] | None" = None
_config_logged = False
_config_lock = threading.Lock()


def _deep_merge(default: "dict[str, Any]", override: "dict[str, Any]") -> "dict[str, Any]":
    """递归合并：override 覆盖 default 的同名键，嵌套字典递归。"""
    result = copy.deepcopy(default)
    for k, v in (override or {}).items():
        if k in result and isinstance(result[k], dict) and isinstance(v, dict):
            result[k] = _deep_merge(result[k], v)
        else:
            result[k] = copy.deepcopy(v)
    return result


def _build_audio_config() -> "dict[str, Any]":
    """从 ConfigStore live 快照构建配置（仅在缓存未命中时调用）。

    只读 ``get_config()._data`` 的 ``audio`` / ``tts`` 小节，不与任何配置
    载体文件交互；快照不可用时使用内置默认。
    """
    file_cfg: "dict[str, Any]" = {}
    top_tts: "dict[str, Any]" = {}
    ai_root = os.path.join(_PROJECT_ROOT, "ai")
    try:
        snapshot = get_config()._data
    except Exception as e:
        logger.warning(f"[AudioConfig] 配置快照读取失败，使用内置默认: {e}")
        snapshot = {}
    try:
        ai_root = str(get_config().AI_ROOT or ai_root)
    except Exception:
        pass
    if isinstance(snapshot, dict):
        file_cfg = snapshot.get("audio") or {}
        top_tts = snapshot.get("tts") or {}

    if not isinstance(file_cfg, dict):
        file_cfg = {}
    if not isinstance(top_tts, dict):
        top_tts = {}

    merged = _deep_merge(DEFAULT_AUDIO_CONFIG, file_cfg)
    wake = merged.get("wake_word")
    if isinstance(wake, dict):
        if not str(wake.get("keywords_file") or "").strip():
            wake["keywords_file"] = os.path.join(ai_root, "data", "wake_word", "keywords.txt")
        if not str(wake.get("model_dir") or "").strip():
            wake["model_dir"] = os.path.join(
                ai_root,
                "data",
                "wake_word",
                "sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20",
            )
    # 顶层 tts: 节覆盖内置 tts 默认（也覆盖 audio.tts 内的同名键）
    if top_tts:
        merged["tts"] = _deep_merge(merged.get("tts") or {}, top_tts)

    # 兼容别名：使 get_audio_config()["audio"]["xxx"] 与 ["xxx"] 均可访问
    merged["audio"] = {k: v for k, v in merged.items() if k != "audio"}
    return merged


def get_audio_config() -> "dict[str, Any]":
    """加载 audio / tts 配置（live 快照覆盖 + 代码默认），结果进程内缓存。

    首次加载加锁；缓存命中仅打 debug 日志（避免音频链路高频读取刷屏）。
    配置热更新由 ``invalidate_audio_config()`` 清缓存。

    Returns:
        合并后的配置字典。无 audio 小节时返回内置默认。
    """
    global _config_cache, _config_logged
    cached = _config_cache
    if cached is not None:
        logger.debug("[AudioConfig] 命中进程内缓存")
        return copy.deepcopy(cached)

    with _config_lock:
        # 双检：可能已被其它线程填充
        cached = _config_cache
        if cached is None:
            cached = _build_audio_config()
            _config_cache = cached
            if not _config_logged:
                _config_logged = True
                logger.info(
                    "[AudioConfig] 配置已加载 (wake_word=%s, assistant=%s, tts=%s)",
                    bool(cached.get("wake_word", {}).get("enabled")),
                    bool(cached.get("assistant", {}).get("enabled")),
                    bool(cached.get("tts", {}).get("enabled")),
                )
    return copy.deepcopy(cached)


def invalidate_audio_config() -> None:
    """清空 audio/tts 配置缓存（ConfigStore 热重载钩子）。

    下一次 get_audio_config() 从 ConfigStore 新快照重建缓存；与首载共用同一把锁。
    """
    global _config_cache, _config_logged
    with _config_lock:
        _config_cache = None
        _config_logged = False


def get_upload_ext() -> str:
    """上传音频落盘默认扩展名（magic 嗅探未知时的回退）。

    仅接受 ``"wav"`` / ``"flac"``，其余（含缺失）一律回退 ``"wav"``。
    进程内缓存（改配置需重启后端，与 get_audio_config 同约定）。
    """
    ext = (get_audio_config().get("store") or {}).get("upload_ext", "wav")
    return ext if ext in ("wav", "flac") else "wav"


def get_project_root() -> str:
    """获取项目根目录路径（axeuh-health-monitor）。"""
    return _PROJECT_ROOT


def resolve_path(relative_path: str) -> str:
    """将相对路径拼接为绝对路径（相对于项目根目录）。"""
    return os.path.join(_PROJECT_ROOT, relative_path)
