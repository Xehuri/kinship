"""
感知数据存储服务

每次 voice-session 完成后存储：
1. 原始音频 WAV → ai/data/daily/{date}/audio/{time}_{user}.wav
2. 感知分析结果 → ai/data/daily/{date}/perception.jsonl（逐行追加，增量）

数据策略:
  - 增量型（perception.jsonl）: 心率、GPS、电量、环境声音 — 保持完整时间线

目录结构:
    ai/data/daily/{YYYY-MM-DD}/
    ├── audio/
    │   ├── {HH}{MM}{SS}_{user}.wav                              # 旧格式（无真实时间）
    │   └── {起HHMMSS}-{止HHMMSS}_{device}_{startms}.wav          # 新格式（有真实时间）
    └── perception.jsonl           # 增量采样
"""

import os
import re
import json
import logging
import threading
from typing import Optional, Dict, Any
from datetime import datetime, timezone, timedelta

from core.redaction import redact_text

logger = logging.getLogger(__name__)

# 东八区
_CST = timezone(timedelta(hours=8))
from config.config import get_config

_paths_lock = threading.Lock()
_DATA_BASE = ""
_STREAM_AUDIO_BASE = ""


def reload_paths() -> None:
    """按当前配置重算每日根与流式根；写入方每次调用取一次快照。"""
    cfg = get_config()
    data_base = os.path.join(cfg.DATA_DIR, "daily")
    stream_base = cfg.STREAM_DIR
    global _DATA_BASE, _STREAM_AUDIO_BASE
    with _paths_lock:
        _DATA_BASE = data_base
        _STREAM_AUDIO_BASE = stream_base


def _paths_snapshot() -> tuple[str, str]:
    with _paths_lock:
        return _DATA_BASE, _STREAM_AUDIO_BASE


reload_paths()


def _today_str() -> str:
    """获取今天的日期字符串（东八区）"""
    return datetime.now(_CST).strftime("%Y-%m-%d")


# YYYY-MM-DD 形状（再经 strptime 校验真实日历日期）。
# 样式与 health/paths.py 的 _validate_date 一致；该函数是私有实现，
# 按约定不跨模块导入，此处在本模块内自备同等校验。
_DATE_STR_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _validate_date_str(date_str: str) -> None:
    """校验日期字符串为真实日历日期的 YYYY-MM-DD，否则抛 ValueError。"""
    if not isinstance(date_str, str) or not _DATE_STR_RE.match(date_str):
        raise ValueError(f"date_str 必须为 YYYY-MM-DD 格式: {date_str!r}")
    try:
        datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        raise ValueError(f"date_str 不是合法日历日期: {date_str!r}") from None


def _date_dir(date_str: str, data_base: Optional[str] = None) -> str:
    """获取某天的数据目录；data_base 缺省时读取当前根快照。"""
    base = _paths_snapshot()[0] if data_base is None else data_base
    d = os.path.join(base, date_str)
    os.makedirs(d, exist_ok=True)
    return d


def _now_time_str() -> str:
    """获取当前时间字符串用于文件名（东八区）"""
    return datetime.now(_CST).strftime("%H%M%S")


def save_audio(audio_data: bytes, user_id: str = "default",
               start_ms: Optional[int] = None, end_ms: Optional[int] = None,
               device_id: Optional[str] = None,
               origin: str = "upload",
               target_dir: Optional[str] = None,
               ext: str = "wav") -> Optional[str]:
    """
    保存原始音频到 ai/data/daily/{date}/audio/（默认），支持按来源改道。

    Args:
        audio_data: 音频字节（WAV 或 FLAC，与 ext 一致）
        user_id: 用户标识
        start_ms: 音频真实起始时间（epoch 毫秒，东八区换算日期）。
            提供时：日期目录与文件名由 start_ms 推算（不使用服务器当前时间），
            文件名格式为 {起HHMMSS}-{止HHMMSS}_{device}_{startms}.{ext}。
            为 None 时：保持旧行为（今天日期 + 服务器当前时间）。
        end_ms: 音频真实结束时间（epoch 毫秒）。仅当 start_ms 提供时生效；
            为 None 时止时间回退为起时间（向后兼容）。
        device_id: 设备标识。仅当 start_ms 提供时用于文件名；
            为 None 时回退使用 user_id。
        origin: 音频来源标记（"upload" | "stream"），默认 "upload" 保持既有行为。
            为 "stream" 且未指定 target_dir 时，落盘到 daily/ 之外的 stream/ 目录，
            与上传音频隔离（供下游按来源排除流式数据）。
        target_dir: 显式目标目录。相对路径按 DATA_DIR 解析；提供时优先于 origin 默认目录。
        ext: 文件扩展名（"wav" 默认 | "flac"），与 audio_data 实际格式一致；
            非法值回退 "wav"。

    Returns:
        相对存储路径（如 daily/2026-09-14/audio/120000-120030_pixel_1757836800000.flac；
        旧行为如 daily/2026-09-14/audio/120000_default.wav），失败返回 None
    """
    data_base, stream_base = _paths_snapshot()
    try:
        # T2: 扩展名白名单，防路径注入；默认 wav 保持旧行为
        ext = ext if ext in ("wav", "flac") else "wav"
        if start_ms is not None:
            # 有真实起始时间：日期与文件名全部按音频真实时间推算（东八区）
            # 这是离线补传场景的关键：绝不使用服务器当前时间
            start_dt = datetime.fromtimestamp(start_ms / 1000.0, _CST)
            date_str = start_dt.strftime("%Y-%m-%d")
            start_time_str = start_dt.strftime("%H%M%S")
            if end_ms is not None:
                end_dt = datetime.fromtimestamp(end_ms / 1000.0, _CST)
                end_time_str = end_dt.strftime("%H%M%S")
            else:
                end_time_str = start_time_str
            device = device_id or user_id
            filename = f"{start_time_str}-{end_time_str}_{device}_{start_ms}.{ext}"
        else:
            # 旧行为：服务器当前时间（保持完全向后兼容）
            date_str = _today_str()
            time_str = _now_time_str()
            filename = f"{time_str}_{user_id}.{ext}"

        # 目标目录选择（保持向后兼容）：
        #   1. 显式 target_dir 优先（相对路径按 DATA_DIR 解析）；
        #   2. origin="stream" 默认落 daily/ 之外的 stream/{date}/audio；
        #   3. 其余（upload）沿用既有 daily/{date}/audio 布局。
        _data_root = os.path.dirname(data_base)
        if target_dir:
            audio_dir = (
                target_dir if os.path.isabs(target_dir)
                else os.path.join(_data_root, target_dir)
            )
        elif origin == "stream":
            audio_dir = os.path.join(stream_base, date_str, "audio")
        else:
            audio_dir = os.path.join(_date_dir(date_str, data_base), "audio")
        os.makedirs(audio_dir, exist_ok=True)
        filepath = os.path.join(audio_dir, filename)

        with open(filepath, "wb") as f:
            f.write(audio_data)

        rel_path = os.path.relpath(filepath, _data_root).replace("\\", "/")
        logger.info(f"[PerceptionStore] 音频已保存: {rel_path} ({len(audio_data)} bytes)")
        return rel_path
    except Exception as e:
        logger.warning("[PerceptionStore] 音频保存失败: %s", redact_text(str(e)))
        return None


def append_perception(entry: Dict[str, Any], user_id: str = "default",
                      auto_type: bool = True,
                      date_str: Optional[str] = None) -> bool:
    """
    追加一条感知分析结果到指定日期桶的 jsonl 文件。

    Args:
        entry: 感知事件数据字典
        user_id: 用户标识（预留，目前统一文件）
        auto_type: 是否自动添加 type="sample"
        date_str: 事件日期（YYYY-MM-DD）。离线补传场景（手机数天后重传旧录音，
            分析今天才完成）由调用方传入事件真实日期，落入对应日期桶；
            取值方式沿用 save_audio "绝不使用服务器当前时间" 的先例。
            为 None 时保持旧行为（按今天分桶）。非法值抛 ValueError 到调用方。

    Returns:
        是否成功（写盘失败返回 False；日期非法直接抛异常，不返回）
    """
    # fail-loud：日期校验故意放在宽 try/except 之外。补传数据传错日期格式
    # 属调用方契约错误，必须大声抛出；若被下面 except 吞成 False，
    # 补传链路会静默丢数据或误分桶，无人察觉。
    if date_str is not None:
        _validate_date_str(date_str)
    data_base, _ = _paths_snapshot()
    try:
        bucket = date_str if date_str is not None else _today_str()
        filepath = os.path.join(_date_dir(bucket, data_base), "perception.jsonl")

        if auto_type and "type" not in entry:
            entry["type"] = "sample"

        with open(filepath, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

        # 构建可读摘要（只对重要事件输出 INFO，device_env 等用 DEBUG）
        entry_type = entry.get("type", "?")
        important_types = {"voice", "notify", "app", "media", "sensor", "input", "screen", "web_message"}
        if entry_type in important_types:
            summary_parts = [f"[PerceptionStore] {entry_type}"]
            if entry_type == "voice":
                # 新格式: text; 旧格式: asr_text
                asr = entry.get("text") or entry.get("asr_text", "") or ""
                segs = entry.get("segments", [])
                if asr:
                    summary_parts.append(f"asr_chars={len(asr)}")
                if segs:
                    summary_parts.append(f"segs={len(segs)}")
                if "vp" in entry:
                    summary_parts.append("fmt=new")
                scene = entry.get("scene", "")
                scene_label = ""
                if isinstance(scene, dict):
                    scene_label = scene.get("scene_primary", {}).get("label_cn", "") or scene.get("scene_primary", {}).get("label", "")
                elif isinstance(scene, str):
                    scene_label = scene
                if scene_label:
                    summary_parts.append(f"scene={scene_label}")
                spk = entry.get("speaker", {})
                if spk and isinstance(spk, dict):
                    sn = spk.get("name", "")
                    if sn:
                        summary_parts.append(f"speaker={sn}(sim={spk.get('similarity', 0):.3f})")
                # 新格式: emo.t/emo.p; 旧格式: emotion.tag/emotion.probability
                emo = entry.get("emo") or entry.get("emotion", {})
                if emo and isinstance(emo, dict):
                    et = emo.get("t") or emo.get("tag") or emo.get("dominant_emotion", "")
                    if et:
                        ep = emo.get("p") or emo.get("probability", 0)
                        summary_parts.append(f"emotion={et}({ep:.2f})")
            elif entry_type in ("notify", "app", "media", "sensor", "input"):
                payload_keys = list(entry.keys() - {"type", "t", "t_iso"})
                summary_parts.append(f"fields={','.join(payload_keys[:6])}")
            logger.info(" | ".join(summary_parts))
        else:
            logger.debug(f"[PerceptionStore] {entry_type}")
        return True
    except Exception as e:
        logger.warning("[PerceptionStore] 感知事件保存失败: %s", redact_text(str(e)))
        return False


def _reset_store():
    """测试用：重置模块状态"""
    pass
