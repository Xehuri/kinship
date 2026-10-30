# -*- coding: utf-8 -*-
"""ffmpeg 原语统一实现 — 路径解析 + mp3 裁剪 + PCM→WAV 封装。

P1-V2 收敛: 原先 preview / voiceprint_audit / speakers / audio_compressor
四处各有一份 _ffmpeg_path, preview 与 voiceprint_audit 又各有一份 _crop_mp3,
本文件为唯一实现（行为并集）。

crop_mp3 的临时目录与文件名前缀由调用方传入（preview 用 cache/preview_tmp
+ "pv_", voiceprint_audit 用 cache/vaudit_tmp + "crop_"）, 清理链语义不变。
"""
import logging
import os
import shutil
import struct
import subprocess
import sys
import uuid

from fastapi import HTTPException

logger = logging.getLogger(__name__)


def ffmpeg_path() -> str:
    """定位 ffmpeg: 优先 imageio-ffmpeg 落地的 backend/bin; 不可用时回退原有 PATH 解析。"""
    try:
        from services.ffmpeg_bootstrap import ensure_ffmpeg

        return str(ensure_ffmpeg())
    except Exception as exc:
        logger.warning("[audio_codec] ffmpeg bootstrap 不可用, 回退 PATH 解析: %s", exc)
    if sys.platform != "win32":
        return shutil.which("ffmpeg") or "ffmpeg"
    explicit = os.path.normpath(
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "bin", "ffmpeg.exe")
    )
    if os.path.exists(explicit):
        return explicit
    return "ffmpeg"


def crop_mp3(src_wav: str, start: float, end: float,
             tmp_dir: str, prefix: str = "crop_") -> str:
    """ffmpeg 裁剪 [start,end] 输出 mp3 到 tmp_dir, 返回临时文件路径。

    源文件缺失抛 404; end<=start 抛 400; 裁剪失败/超时抛 500。
    """
    if not os.path.isfile(src_wav):
        raise HTTPException(status_code=404, detail=f"源音频不存在: {os.path.basename(src_wav)}")
    start = max(0.0, float(start))
    end = float(end)
    if end <= start:
        raise HTTPException(status_code=400, detail="end 必须大于 start")
    os.makedirs(tmp_dir, exist_ok=True)
    out_path = os.path.join(tmp_dir, f"{prefix}{uuid.uuid4().hex[:12]}.mp3")
    cmd = [ffmpeg_path(), "-y", "-i", src_wav,
           "-ss", f"{start:.2f}", "-to", f"{end:.2f}",
           "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", "-f", "mp3", out_path]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=120)
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=500, detail="音频裁剪超时")
    if proc.returncode != 0 or not os.path.isfile(out_path):
        err = proc.stderr.decode("utf-8", "ignore")[-300:] if proc.stderr else ""
        logger.error(f"[audio_codec] ffmpeg 裁剪失败: {err}")
        raise HTTPException(status_code=500, detail=f"音频裁剪失败: {err[-120:]}")
    return out_path


def pcm_to_wav(pcm: bytes, sample_rate: int = 16000, channels: int = 1) -> bytes:
    """把 16bit 小端 PCM 包装为最小 RIFF/WAVE 字节流（44 字节标准 s16le 头，三处私有实现的统一版）。"""
    data_size = len(pcm)
    bits = 16
    byte_rate = sample_rate * channels * bits // 8
    block_align = channels * bits // 8
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF", 36 + data_size, b"WAVE",
        b"fmt ", 16, 1, channels, sample_rate,
        byte_rate, block_align, bits,
        b"data", data_size,
    )
    return header + pcm
