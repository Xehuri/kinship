"""陌生人自动识别 - 配置加载模块。

配置来源：``get_config()._data`` 的 live ``unknown_speaker`` 小节
（ConfigStore 屏蔽 YAML / JSON / SQLite / 环境变量 overlay 载体差异），
深合并到代码内置 ``DEFAULT_UNKNOWN_SPEAKER_CONFIG``。

注意：enabled 默认 False，因此无显式配置段的机器不会意外启用本功能，
      也不影响现有系统。需启用时在配置载体中显式写 enabled: true。
"""

import os
import copy
import threading
import logging

from config.config import get_config

logger = logging.getLogger(__name__)

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# 配置缓存: 每次音频处理链路会多次调用 get_unknown_speaker_config()
# (session_feed/pyannote/perception 各一次), 无缓存时每段音频都重复合并
# 快照 + 打 info 日志(每60s一条, 噪声大)。缓存 + 首载后日志降级。
_config_cache = None
_config_logged = False
_config_lock = threading.Lock()

# 代码内置默认配置（与 unknown_speaker 小节结构一致，作为兜底与可移植基础）
DEFAULT_UNKNOWN_SPEAKER_CONFIG = {
    "enabled": False,  # fail-safe：无显式配置时关闭
    "detection": {
        "max_vp_score": 0.30,
        "max_reg_sim": 0.45,
        "min_tokens": 3,
        "min_duration_sec": 1.5,
        "min_snr": 0.0,
        # 两步切分：VAD 子段后按 score_all_v2 滑窗提取区域
        "two_step": {
            "enabled": True,          # 两步切分开关（False 回退旧逻辑：整段拼接建档）
            "window_ms": 1500,        # 滑窗长度（实测最优 1500ms）
            "hop_ms": 750,            # 滑窗步长（实测最优 750ms）
            "user_score_threshold": 0.5,   # score_all_v2 > 该值 → 判定用户本人区域（剔除）
            "min_seg_sec": 1.0,       # 区域最小时长（短于该值不建档）
            "merge_gap_sec": 1.0,     # 高分/低分连续区域的合并间隙（<该值视为连续）
            "user_gap_max_sec": 2.5,  # 用户间隙合并：两侧都是用户高分区且长度≤该值的低分区 → 用户低分波动，不建档
        },
        # 多人环境感知：10s 滑窗统计中间档占比
        "env_estimation": {
            "enabled": True,
            "window_sec": 10.0,       # 滑窗时长
            "mid_low": 0.3,           # 中间档下界
            "mid_high": 0.7,          # 中间档上界
            "multi_threshold": 0.2,   # 中间档占比 > 该值 → 多人环境
        },
    },
    "matching": {
        "merge_threshold": 0.65,
        "centroid_method": "weighted_avg",
        # 支持向量集比例判定（第二重合并确认）：质心不足阈值但向量集相似时仍合并
        "sv_ratio_match": {
            "enabled": True,
            "ratio_threshold": 0.55,  # 两两余弦阈值（0.5→0.55 收紧，防不同人短句误并）
            "min_frac": 0.5,          # 达标对占比阈值
            "min_vectors": 5,         # 至少几个向量才启用（3→5 提高可靠性，防少量离群误判）
        },
    },
    # L1 收割: pyannote 实时切分（feature flag）
    "pyannote": {
        "enabled": False,            # 默认关(旧链路): 需要时在本地 config.yaml 显式开
        "model": "pyannote/speaker-diarization-3.1",
        "min_seg_sec": 0.5,
        "file_merge_threshold": 0.55,  # 同文件内 SPEAKER 段归并阈值
        "preload_on_start": True,
    },
    # L2 会话层: 在线滚动质心累积
    "session": {
        "enabled": False,            # 默认关(旧链路单块直配)
        "block_min_sec": 3.0,        # 三层过滤①: 块长≥3s
        "speech_ratio_min": 0.50,    # 三层过滤②: 文件VAD语音占比
        "merge_threshold": 0.60,     # 三层过滤③/滚入阈值
        "hard_reject": 0.55,         # 硬拒绝阈值(块vs候选轨道质心)
        "session_gap_sec": 60.0,     # 会话间隔判定
        "rolling_window": 12,        # 滚动窗口块数
        "min_blocks_per_session": 3, # 会话产出最少块数
        "cold_start_blocks": 3,      # 冷启动块数(前N块仅累积)
        "flush_idle_sec": 90.0,      # 轨道空闲封存
        "persist_every_blocks": 10,  # 每N块刷盘
    },
    # L3 档案层: 会话级匹配
    "profile": {
        "enabled": False,
        "open_threshold": 0.60,
        "open_threshold_strong": 0.80,  # 绝对高分: 超过此值无需 margin 直接并入
        "margin_min": 0.08,             # 相对显著性: top1 vs top2 最小差距(灰区不并)
        "open_min_sessions": 3,
        "internal_min_sim": 0.55,
        "internal_confirm_sim": 0.75,
        "multi_open_min_sessions": 5,
        "pending_ttl_hours": 24,
        "pending_max": 200,
        "pending_reverse_merge": 0.85,
    },
    "lifecycle": {
        "ttl_days": 30,
        "cleanup_hour": 3,
        "max_unknown_count": 200,
        "confirm_min_count": 5,
        "support_vectors_max": 50,
        # 动态 confirm：多人环境（中间档占比>阈值）使用 multi_confirm_min_count
        "dynamic_confirm": {
            "enabled": True,
            "single_confirm_min_count": 5,
            "multi_confirm_min_count": 8,
        },
    },
    "audio_archive": {
        "enabled": True,
        "root": "",                   # 空 = <AI_ROOT>/data/cache/unknown_audio
        "segment_archive": True,      # 归档子段音频而非 60s 整段
        "min_duration_sec": 1.0,      # 子段归档最小时长
    },
    "storage": {
        "unknown_db": "",             # 空 = <AI_ROOT>/data/cache/unknown_speakers.jsonl
        "audit_log": "",              # 空 = <AI_ROOT>/data/cache/unknown_audit.jsonl
        "scan_state": "",             # 空 = <AI_ROOT>/data/cache/unknown_scan_state.json
        "pending_db": "",             # 空 = <AI_ROOT>/data/cache/unknown_pending_sessions.jsonl
        "session_state": "",          # 空 = <AI_ROOT>/data/cache/unknown_session_state.json
    },
}


def _deep_merge(default: dict, override: dict) -> dict:
    """递归合并：override 覆盖 default 的同名键，嵌套字典递归。"""
    result = copy.deepcopy(default)
    for k, v in (override or {}).items():
        if k in result and isinstance(result[k], dict) and isinstance(v, dict):
            result[k] = _deep_merge(result[k], v)
        else:
            result[k] = v
    return result


def _ai_cache_dir() -> str:
    try:
        ai_root = str(get_config().AI_ROOT)
    except Exception:
        ai_root = os.path.join(_PROJECT_ROOT, "ai")
    return os.path.join(ai_root, "data", "cache")


def _apply_ai_default_paths(cfg: dict) -> dict:
    cache_dir = _ai_cache_dir()
    archive = cfg.get("audio_archive")
    if isinstance(archive, dict) and not str(archive.get("root") or "").strip():
        archive["root"] = os.path.join(cache_dir, "unknown_audio")
    storage = cfg.get("storage")
    if isinstance(storage, dict):
        for key, filename in (
            ("unknown_db", "unknown_speakers.jsonl"),
            ("audit_log", "unknown_audit.jsonl"),
            ("scan_state", "unknown_scan_state.json"),
            ("pending_db", "unknown_pending_sessions.jsonl"),
            ("session_state", "unknown_session_state.json"),
        ):
            if not str(storage.get(key) or "").strip():
                storage[key] = os.path.join(cache_dir, filename)
    return cfg


def get_unknown_speaker_config() -> dict:
    """加载 unknown_speaker 配置（live 快照覆盖 + 代码默认）。

    结果缓存（进程内首次加载后复用）。配置热更新由
    ``invalidate_unknown_speaker_config()`` 清缓存后按新快照重建。

    Returns:
        合并后的配置字典。无配置段时返回内置默认（enabled=False）。
    """
    global _config_cache, _config_logged
    if _config_cache is not None:
        return copy.deepcopy(_config_cache)

    with _config_lock:
        if _config_cache is not None:
            return copy.deepcopy(_config_cache)

        try:
            snapshot = get_config()._data
        except Exception as e:
            logger.warning(f"[UnknownSpeaker] 配置快照读取失败，使用内置默认: {e}")
            _config_cache = _apply_ai_default_paths(copy.deepcopy(DEFAULT_UNKNOWN_SPEAKER_CONFIG))
            return copy.deepcopy(_config_cache)

        file_cfg = (
            snapshot.get("unknown_speaker")
            if isinstance(snapshot, dict)
            else None
        )
        if not isinstance(file_cfg, dict) or not file_cfg:
            logger.info("[UnknownSpeaker] 配置小节不存在，使用内置默认 (enabled=False)")
            _config_cache = _apply_ai_default_paths(copy.deepcopy(DEFAULT_UNKNOWN_SPEAKER_CONFIG))
            return copy.deepcopy(_config_cache)

        _config_cache = _apply_ai_default_paths(_deep_merge(DEFAULT_UNKNOWN_SPEAKER_CONFIG, file_cfg))
        # 只打一次日志, 避免每段音频重复输出(60s 一次的感知链路噪音)
        if not _config_logged:
            _config_logged = True
            if _config_cache.get("enabled"):
                logger.info("[UnknownSpeaker] 配置已加载 (enabled=True)")
            else:
                logger.info("[UnknownSpeaker] 配置已加载 (enabled=False)")
        return copy.deepcopy(_config_cache)


def invalidate_unknown_speaker_config() -> None:
    """清空 unknown_speaker 配置缓存（ConfigStore 热重载钩子）。

    下一次 get_unknown_speaker_config() 从 ConfigStore 新快照重建；与首载共用同一把锁。
    """
    global _config_cache, _config_logged
    with _config_lock:
        _config_cache = None
        _config_logged = False


def get_project_root() -> str:
    """获取项目根目录路径（axeuh-health-monitor）。"""
    return _PROJECT_ROOT


def resolve_path(relative_path: str) -> str:
    """将相对路径拼接为绝对路径（相对于项目根目录）。"""
    return os.path.join(_PROJECT_ROOT, relative_path)
