#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
MiMo 声音多模态分析工具

对指定日期的音频做 MiMo 音频理解（说话人/主题/事件/环境音），供 AI 子智能体补充细节。

【时间基准】（与事实-全天.md 严格对齐）
    音频文件命名：T = HHMMSS（段落起点），文件 T 覆盖 [T, T+60)。
    这与 fact_extractor 生成的事实文件完全一致：事实文件中的时间点 P 落在文件名 T <= P < T+60 的那个文件里。
    工具的所有选段逻辑均以此为基准：--time / --hours / --ranges 选取的窗口会被自动拆分为若干文件交集片段并拼接。

三种粒度:
    --time 13:05         精确到单段（无秒：窗口 [13:05:00, 13:06:00)；有秒：窗口 [13:05:SS, 13:05:SS+60s)）
    --hours 13:00~14:00  合并时段（ffmpeg 转 MP3，一次调用）
    --ranges 08:30;13:00~13:30;23:20   批量并发（分号分隔，支持单时间点与时段的混合）

安全流程:
    1. 复制/合并音频到 {AI目录}/data/cache/mimo_audio/ 临时目录
    2. 通过后端专用端点 /api/mimo/audio/{随机文件名} 签名暴露（短 TTL，仅临时目录）
    3. 调用 MiMo API 拉取分析
    4. 无论成功失败，清理临时文件

环境声确认:
    - 对于 ASR 没有内容（无对话 / 接近无声）的段，没必要跑 MiMo 判断对话内容（省 token）
    - 但可用 --time 单点确认环境声音状态（安静 / 底噪 / 环境声 / 场景类型），这类判断 MiMo 单点（前/后 30s 各一次）可信、幻觉风险低
    - 注意：此类段若无需确认环境状态，可跳过，避免浪费请求

配置（环境变量）:
    MIMO_API_BASE       MiMo API 基址，默认 https://token-plan-cn.xiaomimimo.com/v1
    MIMO_MODEL          模型名，默认 mimo-v2.6-flash
    MIMO_PUBLIC_BASE    后端公网基础 URL（必填），如 https://your-domain:8768
    MIMO_API_KEY        可选；缺省读后端配置 config.yaml
    AXEUH_BACKEND_DIR   可选；后端目录，缺省为 {项目根目录}/backend
    MIMO_MAX_TOKENS / MIMO_TIMEOUT / MIMO_RETRIES 也可按需覆盖

用法:
    python {AI目录}/analysis/audio_mimo_analyzer.py 2026-01-01 --time 13:05
    python {AI目录}/analysis/audio_mimo_analyzer.py 2026-01-01 --hours 13:00~14:00
    python {AI目录}/analysis/audio_mimo_analyzer.py 2026-01-01 --hours 13:00~14:00 --json
    python {AI目录}/analysis/audio_mimo_analyzer.py 2026-01-01 --ranges "08:30;13:00~13:30;23:20"
    python {AI目录}/analysis/audio_mimo_analyzer.py 2026-01-01 --ranges "08:30;13:00~13:30" --request 2

请求次数（--request）:
    - --request N(默认 2) ：对每个时段（--hours / 含 "~" 的 ranges token）重复调用 MiMo N 次
    - 单点模式（--time / 不含 "~" 的 ranges token）固定拆两段各请求 1 次，--request 不作用于单点
    - 每次请求独立计费/重试；某个请求失败时该次以 [失败: 原因] 占位，不影响其他请求

批量并发（--ranges）:
    - 分号分隔 token：无 "~" 为单时间点（把该时刻 60s wav 拆前/后 30s 各请求一次）；含 "~" 为时段（按 --window 切成短段并发分析）
    - --window 1m(默认) ：每个短段为一段 60s wav；--window 2m 起合并相邻 N 个 60s wav
    - --questions "q1;q2;q3" ：按 --ranges 顺序逐 token 指定问题，缺省回退默认问题
    - --concurrency 4   ：全局并发 worker 数
    - --output 缺省     ：自动生成 {AI目录}/data/cache/mimo_audio/输出-{date}-{简化ranges}.md，同名覆盖
    - --json 与 --ranges 组合：返回含逐段结果的 JSON 结构（date/segments/ok/failed）
    - 所有输出均不含 MiMo 的推理过程（reasoning_content），仅保留内容（content）
"""

import argparse
import os
import sys
import json
import shutil
import subprocess
import uuid
import time
import re
from concurrent.futures import ThreadPoolExecutor

import requests

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
AI_ROOT = os.path.normpath(os.path.join(SCRIPT_DIR, ".."))
PROJECT_ROOT = os.path.normpath(os.path.join(AI_ROOT, ".."))
BACKEND_DIR = os.environ.get("AXEUH_BACKEND_DIR") or os.path.join(PROJECT_ROOT, "backend")
sys.path.insert(0, BACKEND_DIR)

from config.config import get_config
# 后端短 TTL 签名 URL 工具：MiMo 音频端点使用签名校验，不再免认证裸文件名
from mimo_signing import build_signed_path

MIMO_API_BASE = os.environ.get(
    "MIMO_API_BASE", "https://token-plan-cn.xiaomimimo.com/v1"
).rstrip("/")
MIMO_MODEL = os.environ.get("MIMO_MODEL", "mimo-v2.6-flash")
MIMO_MAX_TOKENS = int(os.environ.get("MIMO_MAX_TOKENS", "4000"))
MIMO_TIMEOUT = int(os.environ.get("MIMO_TIMEOUT", "300"))
# 重试次数（初试 + MIMO_RETRIES 次重试），指数退避间隔见 RETRY_BACKOFF
MIMO_RETRIES = int(os.environ.get("MIMO_RETRIES", "3"))
RETRY_BACKOFF = [5, 15, 45]  # 秒，逐次递增（5s/15s/45s）

# 后端对外基址：用于把临时音频暴露给 MiMo 拉取（需公网可访问）。
# 通过环境变量 MIMO_PUBLIC_BASE 配置；未配置时 analyze() 会返回明确错误。
PUBLIC_BASE = os.environ.get("MIMO_PUBLIC_BASE", "{公网基础URL}").rstrip("/")


def _resolve_binary(name):
    """ffmpeg/ffprobe 跨平台解析：Windows 优先 backend/bin，其他平台用 PATH。

    不能只用 os.path.isfile 判断：Windows 的 PE 二进制在 Linux 上存在但不可执行。
    """
    if os.name == "nt":
        candidate = os.path.join(BACKEND_DIR, "bin", name + ".exe")
        return candidate if os.path.isfile(candidate) else name
    return shutil.which(name) or name


FFMPEG = _resolve_binary("ffmpeg")
FFPROBE = _resolve_binary("ffprobe")

# 声学异常检测阈值（单位 dB / 比例）
# 依据：手机麦克风在安静房间底噪约 -50~-45 dBFS；近静音（MiMo 幻觉高发区）max 多低于 -45 dB。
# 正常对话段 max 通常 > -25 dB；阈值留出缓冲。
# max_volume < -40 dB 或 mean_volume < -50 dB 或 silence_ratio > 0.90 即触发警告。
ACOUSTIC_MAX_DB_THRESHOLD = -40.0
ACOUSTIC_MEAN_DB_THRESHOLD = -50.0
ACOUSTIC_SILENCE_RATIO_THRESHOLD = 0.90

TMP_REL = os.path.join("cache", "mimo_audio")

_SYSTEM_PROMPT = "你是一个专业的音频分析助手。请基于音频内容回答，不确定的细节（说话人身份、具体数字、人名）标注为推测，不要编造。"


def _get_data_dir():
    return get_config().DATA_DIR


def _acoustic_stats(path):
    """用 ffmpeg volumedetect + silencedetect 分析音频，返回 dict 或 None（优雅降级）。"""
    if not os.path.isfile(path):
        return None
    try:
        p = subprocess.run(
            [FFMPEG, "-i", path,
             "-af", "volumedetect,silencedetect=noise=0.0001:d=0.5",
             "-f", "null", "-"],
            capture_output=True, text=True, timeout=30,
        )
        out = p.stderr + p.stdout
    except Exception:
        return None

    stats = {}
    for line in out.splitlines():
        if "mean_volume" in line:
            m = re.search(r"mean_volume:\s*([-\d.]+)\s*dB", line)
            if m:
                stats["mean_db"] = float(m.group(1))
        elif "max_volume" in line:
            m = re.search(r"max_volume:\s*([-\d.]+)\s*dB", line)
            if m:
                stats["max_db"] = float(m.group(1))
        elif "silence_duration" in line:
            m = re.search(r"silence_duration:\s*([\d.]+)", line)
            if m:
                stats["silence_sec"] = float(m.group(1))
        elif "silence_end" in line:
            m = re.search(r"silence_end:\s*[\d.]+\s*\|\s*silence_db:\s*([-\d.]+)", line)
            if m:
                stats["silence_end_db"] = float(m.group(1))

    if "max_db" not in stats:
        return None

    # 估算静音时长占比（总时长默认 60s，覆盖绝大多数采集段）
    total_sec = 60.0
    silence_sec = stats.get("silence_sec", 0.0)
    stats["silence_ratio"] = min(1.0, silence_sec / total_sec)
    return stats


def _is_acoustic_anomaly(stats):
    """根据声学统计判断是否异常，返回 (bool, str)，即 (是否异常, 原因)。

    判定策略：
    - 主要依据 max_db：真实有内容音频 max 通常 > -25 dB；近静音/纯噪声 max 多 < -40 dB
    - mean_db 作为辅助：仅与 max 联动（max 已极低时均值的极低值才计为异常）
    - silence_ratio 独立判断：占比极高时（>90%）说明几乎无有效声音
    """
    if not stats:
        return False, ""
    reasons = []
    max_db = stats.get("max_db", 0)
    mean_db = stats.get("mean_db", 0)

    # max_db 极低：近静音（主要判定）
    if max_db < ACOUSTIC_MAX_DB_THRESHOLD:
        reasons.append("max=%.1f dB" % max_db)
        # max 已极低时，mean 若也极低则标注更详细
        if mean_db < ACOUSTIC_MEAN_DB_THRESHOLD:
            reasons.append("均值=%.1f dB" % mean_db)
    # 静音占比极高（独立判定，不受 max_db 约束）
    if stats.get("silence_ratio", 0) > ACOUSTIC_SILENCE_RATIO_THRESHOLD:
        reasons.append("静音占比=%.0f%%" % (stats["silence_ratio"] * 100))

    if reasons:
        return True, " / ".join(reasons)
    return False, ""


def _tmp_dir():
    return os.path.join(_get_data_dir(), TMP_REL)


def _get_wav_duration(path):
    """用 ffprobe 读取音频时长（秒），失败返回 None。"""
    # ffprobe 直读容器时长；解析 ffmpeg -f null 的 time= 行在部分版本下会被微秒/换行差异打断
    try:
        p = subprocess.run(
            [FFPROBE, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", path],
            capture_output=True, text=True, timeout=30,
        )
        val = p.stdout.strip()
        if val and val.lower() != "n/a":
            return float(val)
    except Exception:
        pass
    return None


def _split_wav_to_halves(src_wav):
    """把单段 WAV 按实际时长均分为前半段 [0, dur/2) 和后半段 [dur/2, dur)。

    正常采集段 dur≈60s，即得到前/后各约 30s 的两段音频，用于分别请求 MiMo。
    返回: [(标签, 片段路径), ...]
    - 正常返回 2 个片段
    - 时长 < 1s：返回空列表（跳过）
    临时文件写到 _tmp_dir()，由调用方 finally 清理。
    """
    dur = _get_wav_duration(src_wav)
    if not dur or dur < 1.0:
        return []
    # 按实际时长均分（正常采集段 dur≈60s → 前/后各约 30s；不足 60s 时按实际时长均分）
    mid_sec = dur / 2.0
    out_files = []
    tmp = _tmp_dir()
    os.makedirs(tmp, exist_ok=True)
    for idx, (start, label) in enumerate([(0.0, "前半段"), (mid_sec, "后半段")]):
        out_path = os.path.join(tmp, uuid.uuid4().hex + "_h%d.wav" % idx)
        try:
            subprocess.run(
                [FFMPEG, "-y", "-i", src_wav,
                 "-ss", "%.3f" % start, "-t", "%.3f" % mid_sec,
                 "-acodec", "copy",
                 out_path],
                capture_output=True, timeout=30, check=True,
            )
            if os.path.isfile(out_path) and os.path.getsize(out_path) > 0:
                out_files.append((label, out_path))
        except Exception:
            pass
    return out_files


def _audio_dir(date_str):
    return os.path.join(_get_data_dir(), "daily", date_str, "audio")


def _load_api_key():
    return os.environ.get("MIMO_API_KEY") or get_config().MIMO_API_KEY


def _find_wavs(date_str):
    d = _audio_dir(date_str)
    if not os.path.isdir(d):
        return []
    # 双后缀（wav|flac）
    return sorted(f for f in os.listdir(d) if f.endswith((".wav", ".flac")))


def _wav_to_time(fname):
    m = re.match(r"^(\d{6})", fname)
    return m.group(1) if m else None


def _hhmmss_to_sec(h):
    """6 位 HHMMSS -> 秒。"""
    if not h or len(h) != 6:
        return 0
    return int(h[0:2]) * 3600 + int(h[2:4]) * 60 + int(h[4:6])


def _sec_to_hhmmss(sec):
    """秒 -> 6 位 HHMMSS。"""
    sec = int(sec)
    return "%02d%02d%02d" % (sec // 3600, (sec % 3600) // 60, sec % 60)


def _find_overlapping_wavs(date_str, win_start_hhmmss, win_end_hhmmss):
    """根据时间基准（文件名 T 覆盖 [T, T+60)）找所有与目标窗口相交的文件。

    返回: [(filename, file_start_sec, file_end_sec, overlap_start_sec, overlap_end_sec, offset_into_file_sec, overlap_dur_sec), ...]
    - win_start / win_end: 目标窗口 [win_start, win_end)（秒）
    - file_start_sec: 文件名 T 解析出的秒（段落起点）
    - file_end_sec: file_start_sec + 实际时长（从文件读取，正常 60s）
    - overlap_start_sec: max(win_start, file_start_sec)
    - overlap_end_sec: min(win_end, file_end_sec)
    - offset_into_file_sec: overlap_start - file_start（从文件第几秒开始裁）
    - overlap_dur_sec: overlap_end - overlap_start（裁多长时间）
    - 只返回 overlap_dur_sec > 0 的文件
    - 按 file_start_sec 排序
    - 自动读取每个文件的实际时长（容错：读失败则用 60s）
    """
    ws = _hhmmss_to_sec(win_start_hhmmss) if isinstance(win_start_hhmmss, str) else int(win_start_hhmmss)
    we = _hhmmss_to_sec(win_end_hhmmss) if isinstance(win_end_hhmmss, str) else int(win_end_hhmmss)
    if we <= ws:
        return []

    audio_dir = _audio_dir(date_str)
    if not os.path.isdir(audio_dir):
        return []

    results = []
    for fname in sorted(os.listdir(audio_dir)):
        # 双后缀（wav|flac）
        if not fname.endswith((".wav", ".flac")):
            continue
        t_str = _wav_to_time(fname)
        if not t_str:
            continue
        file_start = _hhmmss_to_sec(t_str)
        file_path = os.path.join(audio_dir, fname)
        file_dur = _get_wav_duration(file_path)
        if not file_dur or file_dur < 1.0:
            file_dur = 60.0
        file_end = file_start + file_dur

        # 窗口是否与文件覆盖区间相交
        ov_start = max(ws, file_start)
        ov_end = min(we, file_end)
        if ov_end <= ov_start:
            continue

        results.append({
            "fname": fname,
            "file_path": file_path,
            "file_start": file_start,
            "file_end": file_end,
            "overlap_start": ov_start,
            "overlap_end": ov_end,
            "offset_sec": ov_start - file_start,
            "duration_sec": ov_end - ov_start,
        })

    results.sort(key=lambda x: x["file_start"])
    return results


def _clip_and_concat_wavs(overlapping, out_path):
    """把重叠片段列表裁剪并拼接成一个音频文件。

    overlapping: _find_overlapping_wavs 的返回值
    out_path: 输出文件路径（.wav 或 .mp3）
    返回 (成功bool, 缺口描述str或"")
    """
    if not overlapping:
        return False, "无重叠文件"

    # 检查缺口
    gaps = []
    for i in range(len(overlapping) - 1):
        cur_end = overlapping[i]["overlap_end"]
        next_start = overlapping[i + 1]["overlap_start"]
        if next_start > cur_end:
            gaps.append("文件 %s 尾段(%.1fs) 到 文件 %s 头段(%.1fs) 缺口 %.1f 秒" % (
                overlapping[i]["fname"], cur_end,
                overlapping[i + 1]["fname"], next_start,
                next_start - cur_end,
            ))

    # 对每个片段用 ffmpeg 裁剪，再 concat
    tmp_clips = []
    tmp_dir = _tmp_dir()
    os.makedirs(tmp_dir, exist_ok=True)

    try:
        for item in overlapping:
            clip_path = os.path.join(tmp_dir, uuid.uuid4().hex + "_clip.wav")
            subprocess.run(
                [FFMPEG, "-y", "-i", item["file_path"],
                 "-ss", "%.3f" % item["offset_sec"],
                 "-t", "%.3f" % item["duration_sec"],
                 "-c:a", "pcm_s16le", clip_path],
                capture_output=True, timeout=60, check=True,
            )
            tmp_clips.append(clip_path)

        if len(tmp_clips) == 1:
            shutil.copy2(tmp_clips[0], out_path)
        else:
            concat_list = out_path + ".concat.txt"
            with open(concat_list, "w", encoding="utf-8") as f:
                for cp in tmp_clips:
                    f.write("file '%s'\n" % cp)
            subprocess.run(
                [FFMPEG, "-y", "-f", "concat", "-safe", "0", "-i", concat_list,
                 "-c:a", "pcm_s16le", out_path],
                capture_output=True, timeout=180, check=True,
            )
            if os.path.exists(concat_list):
                os.remove(concat_list)
    finally:
        for cp in tmp_clips:
            try:
                if os.path.isfile(cp):
                    os.remove(cp)
            except OSError:
                pass

    gap_desc = "；".join(gaps) if gaps else ""
    return os.path.isfile(out_path), gap_desc


def _build_window_from_time_str(time_str):
    """把 --time 参数（11:02 或 11:02:30）转为 (win_start_hhmmss, win_end_hhmmss, label)。"""
    t = time_str.replace(":", "")
    if len(t) == 4:
        t = t + "00"
    elif len(t) == 5:
        t = t + "0"
    if len(t) != 6 or not t.isdigit():
        return None, None, time_str

    start_hms = t  # e.g. "110200"
    start_sec = _hhmmss_to_sec(start_hms)
    end_sec = start_sec + 60
    end_hms = _sec_to_hhmmss(end_sec)

    label = "%s:%s:%s" % (start_hms[0:2], start_hms[2:4], start_hms[4:6])
    return start_hms, end_hms, label


def _single_wav(date_str, time_str):
    """根据 --time 参数构建窗口音频（自动跨文件裁剪拼接）。

    返回 (tmp_audio_path, metadata_dict) 或 (None, None)：
    - tmp_audio_path: 裁剪拼接后的临时 wav 路径
    - metadata: {"sources": [(fname, overlap_start_hms, overlap_end_hms, offset_sec, dur_sec), ...], "gap": str}
    """
    win_start, win_end, label = _build_window_from_time_str(time_str)
    if not win_start:
        return None, None

    overlapping = _find_overlapping_wavs(date_str, win_start, win_end)
    if not overlapping:
        return None, None

    out_path = os.path.join(_tmp_dir(), uuid.uuid4().hex + ".wav")
    ok, gap = _clip_and_concat_wavs(overlapping, out_path)
    if not ok:
        return None, None

    sources = [
        {
            "fname": item["fname"],
            "overlap_start": _sec_to_hhmmss(item["overlap_start"]),
            "overlap_end": _sec_to_hhmmss(item["overlap_end"]),
            "offset_sec": item["offset_sec"],
            "dur_sec": item["duration_sec"],
        }
        for item in overlapping
    ]
    metadata = {"sources": sources, "gap": gap, "window_start": win_start, "window_end": win_end}
    return out_path, metadata


def _merge_wavs_to_mp3(date_str, start, end, out_mp3):
    """根据文件名 T 覆盖 [T, T+60) 基准，找出与 [start, end) 窗口相交的文件并裁剪拼接。

    start / end: 6 位 HHMMSS 字符串。
    返回 (成功bool, gap描述str, metadata_dict)。
    """
    overlapping = _find_overlapping_wavs(date_str, start, end)
    if not overlapping:
        return False, "时段 %s~%s 无音频文件" % (start, end), {}

    out_path = out_mp3
    if not out_path.endswith(".mp3"):
        out_path = out_mp3 + ".mp3"
    ok, gap = _clip_and_concat_wavs(overlapping, out_path)

    sources = [
        {
            "fname": item["fname"],
            "overlap_start": _sec_to_hhmmss(item["overlap_start"]),
            "overlap_end": _sec_to_hhmmss(item["overlap_end"]),
            "offset_sec": item["offset_sec"],
            "dur_sec": item["duration_sec"],
        }
        for item in overlapping
    ]
    metadata = {"sources": sources, "gap": gap, "window_start": start, "window_end": end}
    return ok, gap, metadata


def _copy_to_tmp(src_path):
    os.makedirs(_tmp_dir(), exist_ok=True)
    fname = uuid.uuid4().hex + os.path.splitext(src_path)[1]
    dst = os.path.join(_tmp_dir(), fname)
    shutil.copy2(src_path, dst)
    return fname, dst


def _public_url(fname):
    return PUBLIC_BASE + build_signed_path(fname)


def _call_mimo(audio_url, question):
    api_key = _load_api_key()
    headers = {"api-key": api_key, "Content-Type": "application/json"}
    payload = {
        "model": MIMO_MODEL,
        "messages": [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": [
                {"type": "input_audio", "input_audio": {"data": audio_url}},
                {"type": "text", "text": question},
            ]},
        ],
        "max_tokens": MIMO_MAX_TOKENS,
    }
    last_err = None
    for attempt in range(MIMO_RETRIES + 1):
        try:
            r = requests.post(
                f"{MIMO_API_BASE}/chat/completions",
                headers=headers, json=payload,
                timeout=MIMO_TIMEOUT, proxies={"http": None, "https": None},
            )
            if r.status_code == 200:
                return r.json()
            last_err = f"HTTP {r.status_code}: {r.text[:200]}"
        except Exception as e:
            last_err = str(e)
        if attempt < MIMO_RETRIES:
            time.sleep(RETRY_BACKOFF[attempt] if attempt < len(RETRY_BACKOFF) else 60)
    return {"error": last_err}


def _default_question():
    return (
        "请分析这段音频，严格分四部分回答：\n"
        "1) 声音来源：是设备播放(音乐/视频/语音/TTS)、真人说话，还是纯环境音？若为播放，能辨认中英文和主题吗？\n"
        "2) 说话人：有几个不同的人？各自的性别/音色特征？多人时按人分别概括\"谁对谁说话\"。\n"
        "3) 场景：从 卧室/客厅/厨房/户外/交通工具/公共场所 选最可能，并给出依据(回声/底噪/特定响动)。\n"
        "4) 内容：按时间顺序概括。能确定的写，听不清的明确标\"无法辨识\"。\n"
        "\n"
        "纪律：不确定的(说话人身份/具体数字/人名)一律标注\"推测\"，绝不编造；整段无有效内容直接说\"无明显人声/内容\"。"
    )


def _format_source_info(src_meta):
    """把 src_meta 格式化为可读的标注行。"""
    if not src_meta:
        return ""
    ws = src_meta.get("window_start", "")
    we = src_meta.get("window_end", "")
    win_label = ""
    if ws and we:
        h1, m1, s1 = ws[0:2], ws[2:4], ws[4:6]
        h2, m2, s2 = we[0:2], we[2:4], we[4:6]
        win_label = "窗口 [%s:%s:%s~%s:%s:%s]" % (h1, m1, s1, h2, m2, s2)

    sources = src_meta.get("sources", [])
    src_parts = []
    for src in sources:
        fname = src["fname"]
        ov_start = src["overlap_start"]
        ov_end = src["overlap_end"]
        offset = src["offset_sec"]
        dur = src["dur_sec"]
        h1, m1, s1 = ov_start[0:2], ov_start[2:4], ov_start[4:6]
        h2, m2, s2 = ov_end[0:2], ov_end[2:4], ov_end[4:6]
        src_parts.append("%s(偏移%.1fs/%.1fs,截取%s:%s:%s~%s:%s:%s)" % (
            fname, offset, dur, h1, m1, s1, h2, m2, s2))

    gap = src_meta.get("gap", "")
    gap_part = " | 缺口: %s" % gap if gap else ""

    parts = [win_label] + src_parts + [gap_part]
    return "来源: " + " | ".join(p for p in parts if p)


def _to_markdown(result, date_str, label, request_count=2, acoustic_stats=None, src_meta=None):
    if "attempts" not in result and "error" in result:
        return f"# 声音理解 {date_str} {label}\n\n> 分析失败: {result['error']}\n"
    attempts = result.get("attempts", [])
    blocks = []
    src_line = _format_source_info(src_meta)
    for i, res in enumerate(attempts, start=1):
        fragment_label = res.get("fragment", "")
        req_label = "%s (%s)" % (label, fragment_label) if fragment_label else "%s (请求%d)" % (label, i)
        if "error" in res:
            blocks.append(
                f"# 声音理解 {date_str} {req_label}\n\n> 分析失败: {res['error']}\n")
            continue
        mimo_res = res.get("result", {})
        choices = mimo_res.get("choices", [])
        content = ""
        if choices:
            msg = choices[0].get("message", {})
            content = msg.get("content", "")
        usage = mimo_res.get("usage", {})
        lines = [
            f"# 声音理解 {date_str} {req_label}",
            "",
            f"> MiMo {MIMO_MODEL} 生成 | tokens: {usage.get('total_tokens', '?')}",
            "> 注意: 说话人数量/口音/具体数字可能不准确，主题级结论可信",
            "",
        ]
        if src_line:
            lines.insert(3, ">%s" % src_line)
            lines.insert(3, "")
        is_anomaly, reason = _is_acoustic_anomaly(acoustic_stats)
        if is_anomaly:
            lines.insert(3, (
                "> [声学警告] 本段音频接近静音（%s）——"
                "MiMo 输出极可能是幻觉，请勿采信，以 ASR / 行为链为准。"
                % reason
            ))
            lines.insert(3, "")  # 空行分隔
        if content:
            lines.append(content)
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)


# ---------- 批量并发（--ranges）辅助函数 ----------

def _normalize_hhmmss(time_str):
    """'08:30' / '0830' / '083000' -> '083000'（6位），解析失败返回空串。"""
    t = time_str.strip().replace(":", "")
    if len(t) == 4:
        t = t + "00"
    elif len(t) == 5:
        t = t + "0"
    return t if len(t) == 6 and t.isdigit() else ""


def _hhmmss_label(h):
    if not h or len(h) != 6:
        return h or ""
    return h[0:2] + ":" + h[2:4]


def _parse_window_minutes(s):
    """'1m'/'2'/'2m' -> 整数分钟数，默认 1。"""
    m = re.match(r"^(\d+)m?$", str(s).strip(), re.I)
    if not m:
        return 1
    return max(1, int(m.group(1)))


def _time_buckets(start, end, window_minutes):
    """把 6 位起止时间切成 [bucket_start, bucket_end) 的 6 位时间桶，按窗口分钟对齐。"""
    wm = max(1, int(window_minutes)) * 60
    s = _hhmmss_to_sec(start)
    e = _hhmmss_to_sec(end)
    if e <= s:
        return
    b = s
    while b < e:
        be = min(b + wm, e)
        yield _sec_to_hhmmss(b), _sec_to_hhmmss(be)
        b += wm


def _bucket_label(bs, be):
    return "%s-%s" % (_hhmmss_label(bs), _hhmmss_label(be))


def _simplify_ranges(ranges_str):
    """把 --ranges 压缩为文件系统安全标签：去冒号、波浪线换连字符、分号换下划线。"""
    s = ranges_str.strip()
    s = s.replace(":", "").replace("~", "-").replace(";", "_")
    s = re.sub(r"\s+", "", s)
    s = re.sub(r"[^0-9a-zA-Z_\-]", "", s)
    return s or "ranges"


def _default_output_path(date_str, ranges_str):
    return os.path.join(_tmp_dir(), "输出-%s-%s.md" % (date_str, _simplify_ranges(ranges_str)))


def _merge_wav_list(wav_paths, out_mp3):
    """把显式给定的音频列表按 concat 合并成 mp3。"""
    if not wav_paths:
        return False
    concat_list = out_mp3 + ".concat.txt"
    with open(concat_list, "w", encoding="utf-8") as f:
        for w in wav_paths:
            f.write("file '%s'\n" % w)
    try:
        subprocess.run(
            [FFMPEG, "-y", "-f", "concat", "-safe", "0", "-i", concat_list,
             "-c:a", "libmp3lame", "-b:a", "64k", out_mp3],
            capture_output=True, timeout=180, check=True,
        )
    finally:
        if os.path.exists(concat_list):
            os.remove(concat_list)
    return os.path.isfile(out_mp3)


def _segments_for_token(date_str, token, window_minutes):
    """把一个 --ranges token（单点或时段）拆成段 spec 列表。
    spec: {order_key, label, range_label, wavs:[abs路径], error:可选, src_meta:可选}。

    对于单点token：调用 _single_wav 获取窗口裁剪音频（自动跨文件拼接）。
    对于时段token：按时段基准（文件名T覆盖[T,T+60)）找到所有相交文件，
    再按时间桶窗口裁剪拼接。
    """
    specs = []
    if "~" in token:
        s, e = token.split("~", 1)
        start = _normalize_hhmmss(s)
        end = _normalize_hhmmss(e)
        if not start or not end or _hhmmss_to_sec(end) <= _hhmmss_to_sec(start):
            return [{"order_key": 0, "label": token, "range_label": token,
                     "wavs": [], "error": "无法解析时段 %s" % token}]

        for bs, be in _time_buckets(start, end, window_minutes):
            overlapping = _find_overlapping_wavs(date_str, bs, be)
            if not overlapping:
                continue
            out_path = os.path.join(_tmp_dir(), uuid.uuid4().hex + "_range.wav")
            ok, gap = _clip_and_concat_wavs(overlapping, out_path)
            if not ok:
                continue
            src_meta = {
                "sources": [
                    {
                        "fname": item["fname"],
                        "overlap_start": _sec_to_hhmmss(item["overlap_start"]),
                        "overlap_end": _sec_to_hhmmss(item["overlap_end"]),
                        "offset_sec": item["offset_sec"],
                        "dur_sec": item["duration_sec"],
                    }
                    for item in overlapping
                ],
                "gap": gap,
                "window_start": bs,
                "window_end": be,
            }
            specs.append({
                "order_key": _hhmmss_to_sec(bs),
                "label": _bucket_label(bs, be),
                "range_label": token,
                "wavs": [out_path],
                "src_meta": src_meta,
            })

        if not specs:
            specs.append({"order_key": _hhmmss_to_sec(start), "label": token,
                          "range_label": token, "wavs": [],
                          "error": "时段 %s 无音频文件" % token})
    else:
        start = _normalize_hhmmss(token)
        src_path, src_meta = _single_wav(date_str, token)
        specs.append({
            "order_key": _hhmmss_to_sec(start) if start else 0,
            "label": token,
            "range_label": token,
            "wavs": [src_path] if src_path else [],
            "error": None if src_path else "未找到 %s 的音频段" % token,
            "is_single_point": True,
            "src_meta": src_meta,
        })
    return specs


def _analyze_single_point(src_wav, question):
    """分析单点 60s WAV：拆前半段/后半段各请求一次 MiMo（并发执行）。

    返回 {"attempts": [...]} 或 {"error": reason}。
    前半段/后半段各带片段标签写入 attempts，格式:
        {"fragment": "前半段 00:00~00:30", "result": <mimo结果>}
    失败占位: {"fragment": "前半段 00:00~00:30", "error": reason}
    """
    fragments = _split_wav_to_halves(src_wav)
    if not fragments:
        return {"error": "音频过短，无法切分"}
    tmp_files = []
    try:
        for _, frag_path in fragments:
            tmp_files.append(frag_path)
        # 并发请求：前半段 -> attempts[0]，后半段 -> attempts[1]
        with ThreadPoolExecutor(max_workers=2) as ex:
            futures = [
                ex.submit(_call_mimo, _public_url(os.path.basename(frag_path)), question)
                for _, frag_path in fragments
            ]
            results = [f.result() for f in futures]
        attempts = []
        for (label, _), res in zip(fragments, results):
            if "error" in res:
                attempts.append({"fragment": label, "error": res["error"]})
            else:
                attempts.append({"fragment": label, "result": res})
        return {"attempts": attempts}
    finally:
        for f in tmp_files:
            try:
                if os.path.isfile(f):
                    os.remove(f)
            except OSError:
                pass


def _analyze_segment(date_str, spec, question, request_count=2):
    """分析单个段；对同一音频重复调用 MiMo request_count 次。
    成功返回 {"attempts": [res1, res2, ...]}（res 为原始 MiMo 结果 dict，失败为 {"error": reason}）。
    spec 级错误（无法解析/无音频）时仍快速短路返回 {"error": reason}。
    单点 spec（is_single_point=True）走 _analyze_single_point，固定拆两段各请求一次。
    """
    if spec.get("error"):
        return {"error": spec["error"]}
    wavs = spec.get("wavs") or []
    if not wavs:
        return {"error": "无音频文件"}
    # 单点走拆分逻辑
    if spec.get("is_single_point") and len(wavs) == 1:
        return _analyze_single_point(wavs[0], question)
    tmp_files = []
    try:
        if len(wavs) == 1:
            fname, dst = _copy_to_tmp(wavs[0])
            tmp_files.append(dst)
        else:
            dst = os.path.join(_tmp_dir(), uuid.uuid4().hex + ".mp3")
            if not _merge_wav_list(wavs, dst):
                return {"error": "合并音频失败"}
            tmp_files.append(dst)
            fname = os.path.basename(dst)
        url = _public_url(fname)
        # 并发执行 request_count 次独立请求
        with ThreadPoolExecutor(max_workers=request_count) as ex:
            futures = [ex.submit(_call_mimo, url, question) for _ in range(request_count)]
            attempts = [f.result() for f in futures]
        return {"attempts": attempts}
    finally:
        for f in tmp_files:
            try:
                if os.path.isfile(f):
                    os.remove(f)
            except OSError:
                pass


def _resolve_questions(questions_list, num_tokens):
    """按 --ranges 顺序为每个 token 分配问题；缺省回退默认问题。"""
    default = _default_question()
    resolved = []
    for i in range(num_tokens):
        if questions_list and i < len(questions_list) and questions_list[i].strip():
            resolved.append(questions_list[i].strip())
        else:
            resolved.append(default)
    return resolved


def _segment_markdown(result, date_str, label, request_count=2, acoustic_stats=None, src_meta=None):
    if "attempts" not in result and "error" in result:
        return "## %s\n\n[失败: %s]\n" % (label, result["error"])
    attempts = result.get("attempts", [])
    blocks = []
    src_line = _format_source_info(src_meta)
    for i, res in enumerate(attempts, start=1):
        fragment_label = res.get("fragment", "")
        req_label = "%s (%s)" % (label, fragment_label) if fragment_label else "%s (请求%d)" % (label, i)
        if "error" in res:
            blocks.append("## %s\n\n[失败: %s]\n" % (req_label, res["error"]))
            continue
        mimo_res = res.get("result", {})
        choices = mimo_res.get("choices", [])
        content = ""
        if choices:
            msg = choices[0].get("message", {})
            content = msg.get("content", "")
        usage = mimo_res.get("usage", {})
        lines = [
            "## %s" % req_label,
            "",
            "> MiMo %s 生成 | tokens: %s" % (MIMO_MODEL, usage.get("total_tokens", "?")),
            "",
        ]
        if src_line:
            lines.insert(3, ">%s" % src_line)
            lines.insert(3, "")
        is_anomaly, reason = _is_acoustic_anomaly(acoustic_stats)
        if is_anomaly:
            lines.insert(3, (
                "> [声学警告] 本段音频接近静音（%s）——"
                "MiMo 输出极可能是幻觉，请勿采信，以 ASR / 行为链为准。"
                % reason
            ))
            lines.insert(3, "")
        if content:
            lines.append(content)
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)


def _analyze_ranges(date_str, ranges_str, questions, window_minutes, concurrency, output, json_out, request_count=2):
    tokens = [t.strip() for t in ranges_str.split(";") if t.strip()]
    if not tokens:
        return {"error": "--ranges 为空"}
    qs = _resolve_questions(questions, len(tokens))

    all_specs = []
    for tok, q in zip(tokens, qs):
        segs = _segments_for_token(date_str, tok, window_minutes)
        for s in segs:
            s["question"] = q
        all_specs.extend(segs)
    if not all_specs:
        return {"error": "--ranges 没有任何可分析段"}
    all_specs.sort(key=lambda s: s.get("order_key", 0))

    results = {}
    workers = max(1, int(concurrency))
    if workers <= 1:
        for i, s in enumerate(all_specs):
            results[i] = _analyze_segment(date_str, s, s["question"], request_count)
    else:
        with ThreadPoolExecutor(max_workers=workers) as ex:
            futures = {ex.submit(_analyze_segment, date_str, s, s["question"], request_count): i
                       for i, s in enumerate(all_specs)}
            for fut in futures:
                i = futures[fut]
                try:
                    results[i] = fut.result()
                except Exception as e:
                    results[i] = {"error": str(e)}

    ok_cnt = sum(1 for i in range(len(all_specs)) if "error" not in results[i])
    failed_cnt = len(all_specs) - ok_cnt

    if json_out:
        segments = []
        for i, s in enumerate(all_specs):
            r = results[i]
            seg = {"label": s["label"], "range": s["range_label"]}
            if s.get("src_meta"):
                seg["source_info"] = s["src_meta"]
            if "attempts" in r:
                seg["status"] = "ok"
                seg["attempts"] = []
                for a in r["attempts"]:
                    if "error" in a:
                        item = {"status": "failed", "error": a["error"]}
                    elif "fragment" in a:
                        item = {"status": "ok", "result": a["result"]}
                    else:
                        item = {"status": "ok", "result": a}
                    if a.get("fragment"):
                        item["fragment"] = a["fragment"]
                    seg["attempts"].append(item)
            else:
                seg["status"] = "failed"
                seg["error"] = r.get("error", "失败")
            segments.append(seg)
        return {"date": date_str, "mode": "ranges", "ranges": tokens,
                "window_minutes": window_minutes, "request_count": request_count,
                "total_segments": len(all_specs),
                "ok": ok_cnt, "failed": failed_cnt, "segments": segments}

    for i, s in enumerate(all_specs):
        wavs = s.get("wavs") or []
        s["_acoustic_stats"] = _acoustic_stats(wavs[0]) if wavs and wavs[0] else None

    parts = ["# 声音理解 %s（%s）" % (date_str, ranges_str), "",
             "> 范围批量分析 | 并发 %d | 窗口 %dm | 请求/段 %d | 成功 %d | 失败 %d" % (
                 workers, window_minutes, request_count, ok_cnt, failed_cnt), ""]
    for i, s in enumerate(all_specs):
        parts.append(_segment_markdown(results[i], date_str, s["label"], request_count,
                                       s.get("_acoustic_stats"), s.get("src_meta")))
    md = "\n".join(parts)

    out_path = output or _default_output_path(date_str, ranges_str)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(md)
    summary = ("分析完成: %d 段 (成功 %d, 失败 %d)\n输出: %s"
               % (len(all_specs), ok_cnt, failed_cnt, out_path))
    return {"summary": summary, "output": out_path, "total": len(all_specs),
            "ok": ok_cnt, "failed": failed_cnt, "result": results}


def analyze(date_str, time_str=None, hours_str=None, ranges_str=None,
            question=None, questions=None, window_minutes=1, concurrency=4,
            output=None, json_out=False, request_count=2):
    if not PUBLIC_BASE or "{" in PUBLIC_BASE:
        return {"error": "未配置公网基础 URL：请设置环境变量 MIMO_PUBLIC_BASE"
                         "（例如 https://your-domain:8768）"}
    if ranges_str:
        return _analyze_ranges(date_str, ranges_str, questions, window_minutes,
                               concurrency, output, json_out, request_count)
    tmp_files = []
    result = None
    try:
        if time_str:
            src_path, src_meta = _single_wav(date_str, time_str)
            if not src_path:
                return {"error": f"未找到 {date_str} {time_str} 的音频段"}
            label = time_str
            if not question:
                question = _default_question()
            result = _analyze_single_point(src_path, question)
            _astats = _acoustic_stats(src_path)
            if json_out:
                if result.get("attempts"):
                    for a in result["attempts"]:
                        if "result" in a:
                            a["_source_info"] = src_meta
                return result
            md = _to_markdown(result, date_str, label, request_count, _astats, src_meta)
            if output:
                os.makedirs(os.path.dirname(output), exist_ok=True)
                with open(output, "w", encoding="utf-8") as f:
                    f.write(md)
            return {"content": md, "result": result}
        elif hours_str:
            start, end = hours_str.replace(":", ""), None
            if "~" in hours_str:
                s, e = hours_str.split("~")
                start, end = s.replace(":", ""), e.replace(":", "")
            dst = os.path.join(_tmp_dir(), uuid.uuid4().hex + ".mp3")
            ok, gap, src_meta = _merge_wavs_to_mp3(date_str, start, end, dst)
            if not ok:
                return {"error": src_meta.get("error", f"时段 {hours_str} 无音频文件")}
            fname = os.path.basename(dst)
            tmp_files.append(dst)
            label = hours_str
            if not question:
                question = _default_question()

            url = _public_url(fname)
            attempts = []
            for _ in range(request_count):
                attempts.append(_call_mimo(url, question))
            result = {"attempts": attempts}

            _astats = _acoustic_stats(tmp_files[0]) if tmp_files else None

            if json_out:
                if result.get("attempts"):
                    for a in result["attempts"]:
                        if "result" in a:
                            a["_source_info"] = src_meta
                return result

            md = _to_markdown(result, date_str, label, request_count, _astats, src_meta)
            if output:
                os.makedirs(os.path.dirname(output), exist_ok=True)
                with open(output, "w", encoding="utf-8") as f:
                    f.write(md)
            return {"content": md, "result": result}
        else:
            return {"error": "必须指定 --time 或 --hours"}
    finally:
        for f in tmp_files:
            try:
                if os.path.isfile(f):
                    os.remove(f)
            except OSError:
                pass


def main():
    # 顺带清理缓存孤儿（写入方负责，防膨胀）：清上一次运行遗留的过期中间音频；
    # .md 结果永不删、2 小时内在途文件保护，清理失败不影响本次分析
    try:
        from mimo_audio_sweep import sweep as _sweep
        _sweep(cache_dir=_tmp_dir(), verbose=False)
    except Exception:
        pass

    parser = argparse.ArgumentParser(
        description="MiMo 声音多模态分析工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("date", nargs="?", help="日期 YYYY-MM-DD")
    parser.add_argument("--time", dest="time_str", help="单段窗口，如 13:05 或 13:05:30")
    parser.add_argument("--hours", dest="hours_str", help="时段窗口，如 13:00~14:00")
    parser.add_argument("--ranges", dest="ranges_str",
                        help='批量窗口，分号分隔，如 "08:30;13:00~13:30"')
    parser.add_argument("--question", help="自定义问题（单段/时段）")
    parser.add_argument("--questions", help="按 --ranges 顺序逐 token 指定问题，分号分隔")
    parser.add_argument("--window", default="1m", help="ranges 时段切分窗口，如 1m/2m")
    parser.add_argument("--concurrency", type=int, default=4, help="并发 worker 数")
    parser.add_argument("--request", dest="request_count", type=int, default=2,
                        help="每个时段的重复请求次数")
    parser.add_argument("--output", help="Markdown 输出路径")
    parser.add_argument("--json", action="store_true", help="输出 JSON")
    args = parser.parse_args()

    if not args.date:
        parser.print_help()
        return 0
    if not (args.time_str or args.hours_str or args.ranges_str):
        print("错误: 必须指定 --time / --hours / --ranges 之一", file=sys.stderr)
        return 1

    questions = args.questions.split(";") if args.questions else None
    result = analyze(
        args.date, args.time_str, args.hours_str, args.ranges_str, args.question,
        questions, _parse_window_minutes(args.window), max(1, args.concurrency),
        args.output, args.json, max(1, args.request_count),
    )
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    elif "error" in result:
        print(f"错误: {result['error']}", file=sys.stderr)
        return 1
    elif "summary" in result:
        print(result["summary"])
    else:
        print(result["content"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
