# -*- coding: utf-8 -*-
"""音频处理预览台 API — 每日时间线 + 单文件处理链详情。

用途: 可视化"最初始处理层"的效果, 让调参/诊断有直接观察依据:
- 每日时间线: 当天所有 60s 音频按状态着色, 紧凑形成一天视图;
  状态两态: "有语音内容"(VAD 检出段 / pyannote 可切块) vs "无有效内容"。
- 单文件详情: 该分钟音频的处理链 —
    VAD 输出(perception segs 即 VAD 段) + ASR 片段时间映射(不整段塞 60s)
    + pyannote 切块 + 每块注册库 top1 + 三引擎曲线 + 滑窗 ASR。
- 试听: 整段 mp3 / 按切分块 / 按 ASR 片段裁剪。

设计约束(与 voiceprint_audit 一致):
- 只读, 不改任何数据文件。
- 音频裁剪用 ffmpeg → cache/preview_tmp/, 响应后后台删除。
- ASR 片段必须带 start/end 时间映射, 前端按段展示, 不是整 60s 一段。
- B3: 音频算法全部经内核同步通道(inspect.* / voiceprint space), 本文件
  零本地 ML 模型/零向量触碰; 内核不可达则面板空 + reason, 不回退本地。
"""
import json
import logging
import os
import re
import subprocess
import uuid

from fastapi import APIRouter, BackgroundTasks, HTTPException
from fastapi.responses import FileResponse

from config.config import get_config
from services.audio_codec import ffmpeg_path, crop_mp3
from services import perception_reader

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/preview", tags=["preview"])

# 允许中文(新式文件名含设备名如"手机"), 拒路径分隔符与 ..
_SAFE_NAME = re.compile(r"^[A-Za-z0-9._\-\u4e00-\u9fff]+$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_TMP_REL = os.path.join("cache", "preview_tmp")
# 区间命名音频: 000145-000345_设备_ts.flac (感知链新式存储)
_RANGE_NAME_RE = re.compile(r"^(\d{6})-(\d{6})_")

# ─── 路径工具 ────────────────────────────────────────────


def _data_dir() -> str:
    return get_config().DATA_DIR


def _day_dir(date: str) -> str:
    return os.path.join(_data_dir(), "daily", date)


def _audio_dir(date: str) -> str:
    return os.path.join(_day_dir(date), "audio")


def _safe_filename(name: str) -> str:
    if not name or not _SAFE_NAME.match(name):
        raise HTTPException(status_code=400, detail=f"非法文件名: {name!r}")
    return name


def _check_date(date: str) -> str:
    if not _DATE_RE.match(date or ""):
        raise HTTPException(status_code=400, detail=f"非法日期: {date!r}")
    return date


def _tmp_dir() -> str:
    d = os.path.join(_data_dir(), "cache", "preview_tmp")
    os.makedirs(d, exist_ok=True)
    return d


# ─── 每日感知数据读取 ────────────────────────────────────

# 状态常量
ST_EMPTY = "empty"        # 无有效内容: 无语音段 / 纯环境
ST_VOICE = "voice"        # 有语音内容: VAD 检出说话人段(场景=说话声)
ST_UNKNOWN = "unknown"    # 有 voice 条目但非说话声(音乐/车辆/白噪等, 归入 empty 展示色)


def _voice_scene(text: str) -> str:
    """从场景字符串归一化: 说话声 → voice; 其他 → 具体标签。"""
    t = (text or "").strip()
    if not t:
        return "empty"
    if t == "说话声" or "Speech" in t:
        return "voice"
    return t  # 音乐/车辆/White noise/安静/... 具体展示


def _asr_preview(entry: dict) -> str:
    """拼接该 60s 条目全部可读 ASR 文本(供时间线悬浮预览, 显示全不截断)。"""
    parts = []
    for s in (entry.get("segs") or []):
        txt = (s.get("text") or "").strip()
        if txt and "<|nospeech|>" not in txt and "<|Event_UNK|>" not in txt:
            parts.append(txt)
    return " ".join(parts)


# ─── 内核调用（B3: 审计台算法全部经内核同步通道，外层零本地模型） ───
#
# 三引擎 VAD 曲线 / 滑窗 ASR / pyannote 切块 / 声纹空间 PCA 全部上移内核
# （A5 inspect + voiceprint/space）。外层只做取数/切片/形状映射，不再加载任何
# 本地 ML 模型。内核不可达 -> 该面板空 + reason（对齐"跳过不回退"语义，审计台
# 无降级义务）。共享客户端 kernel_client 由 B2 独占修改，本文件只用其现有
# srequest 通用封装。

# 内核 inspect/space 为同步重操作（首调可能加载 pyannote/SenseVoice 权重）
_KERNEL_TIMEOUT = 120.0
# diarize_blocks 首调需加载 pyannote diarization-3.1（比 VAD/ASR 更重，与后端
# 自身预加载的模型争用时可分钟级），单独放宽超时避免首调被误判为不可达。
_KERNEL_DIAR_TIMEOUT = 300.0


def _kernel_available() -> bool:
    """内核可达性快判（一次探活）。不可达则该面板空 + reason，不回退本地。"""
    from services import kernel_client
    return kernel_client.get_kernel_client().available()


def _kernel_facts(path: str, payload: dict, timeout: float = _KERNEL_TIMEOUT):
    """调内核同步端点取信封 facts。返回 (facts|None, reason|None)。

    内核不可达 -> (None, "state.unavailable")；内核业务错误（如 503
    model.unavailable）-> (None, 封闭码字符串)。测试打桩缝：monkeypatch
    本函数或 kernel_client.get_kernel_client 均可免真内核。
    """
    from services import kernel_client
    try:
        resp = kernel_client.get_kernel_client().srequest(
            "POST", path, json=payload, timeout=timeout)
    except kernel_client.KernelUnavailable:
        return None, "state.unavailable"
    except kernel_client.KernelHttpError as exc:
        body = exc.body if isinstance(exc.body, dict) else {}
        code = (body.get("error") or {}).get("code") or ("http_%d" % exc.status)
        return None, code
    facts = resp.get("facts") if isinstance(resp, dict) else None
    if not isinstance(facts, dict):
        return None, "invalid_response"
    return facts, None


def _kernel_audio_b64(path: str):
    """把音频编码为内核可解的 16k/mono/16bit WAV base64（内核只收标准 WAV）。

    标准 WAV 直读字节；FLAC / 非 16k 经 ffmpeg 转临时 WAV（失败返回 None）。
    仅做格式归一(解码)，不含任何算法。
    """
    import base64
    if path.lower().endswith(".wav"):
        try:
            import wave
            with wave.open(path, "rb") as wf:
                if (wf.getnchannels() == 1 and wf.getsampwidth() == 2
                        and wf.getframerate() == 16000):
                    with open(path, "rb") as f:
                        return base64.b64encode(f.read()).decode("ascii")
        except Exception:
            pass
    # 非标准 / 非 WAV(如 .flac) -> ffmpeg 归一为 16k 单声道 WAV
    tmp = os.path.join(_tmp_dir(), f"kin_{uuid.uuid4().hex[:10]}.wav")
    try:
        cmd = [ffmpeg_path(), "-y", "-i", path,
               "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", tmp]
        try:
            proc = subprocess.run(cmd, capture_output=True, timeout=120)
        except subprocess.TimeoutExpired:
            return None
        if proc.returncode != 0 or not os.path.isfile(tmp):
            return None
        with open(tmp, "rb") as f:
            return base64.b64encode(f.read()).decode("ascii")
    finally:
        try:
            if os.path.isfile(tmp):
                os.remove(tmp)
        except OSError:
            pass


def _read_pcm(path: str):
    """读音频为 (float32 mono, fs)，供声纹空间探针切窗（仅解码，非算法）。"""
    import numpy as np
    import soundfile as sf
    audio, fs = sf.read(path, dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    return np.asarray(audio, dtype=np.float32), int(fs or 16000)


def _pcm_b64(audio, fs: int) -> str:
    """numpy PCM -> 16k/mono/16bit WAV base64（内核探针输入）。"""
    import base64
    import io
    import numpy as np
    import soundfile as sf
    arr = np.asarray(audio)
    if arr.ndim > 1:
        arr = arr.mean(axis=1)
    if arr.dtype != np.float32:
        arr = arr.astype(np.float32)
    if fs != 16000 and len(arr):
        import soxr
        arr = soxr.resample(arr, fs, 16000)
        fs = 16000
    buf = io.BytesIO()
    sf.write(buf, arr, int(fs or 16000), format="WAV", subtype="PCM_16")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _curve_points(facts: dict) -> list:
    """内核 vad_curve facts -> 前端折线点 [{t,v}]（t 秒，按 step_ms 网格）。"""
    step_ms = int(facts.get("step_ms") or 100)
    return [{"t": round(i * step_ms / 1000.0, 3), "v": p}
            for i, p in enumerate(facts.get("points") or [])]


# ─── API: 日期列表 ───────────────────────────────────────


@router.get("/days")
def list_days():
    """有 perception.jsonl 的日期列表(倒序)。"""
    out = [n for n in perception_reader.day_dirs()
           if perception_reader.has_perception(n)]
    if not out:
        return {"days": []}
    return {"days": out[:30]}


# ─── API: 每日时间线 ─────────────────────────────────────

# 时间线两态配色(前端可覆盖):
#   voice  → 有语音内容
#   其他    → 无有效内容(含 安静/音乐/车辆/白噪/无条目)
#   missing→ 该分钟没有 wav(缺失)


@router.get("/timeline")
def timeline(date: str):
    """当天所有 60s 音频的状态时间线。

    返回按分钟(hhmmss)索引的条目:
      {time, status, scene, n_segs, has_pyannote_file_ratio?, asr}
    status ∈ {voice, empty, missing}
    """
    _check_date(date)
    adir = _audio_dir(date)
    if not os.path.isdir(adir):
        raise HTTPException(status_code=404, detail=f"日期无音频目录: {date}")

    # 1) 收集所有音频, 按分钟(hhmm)归组。兼容两种命名:
    #    新式(区间/flac):  hhmmss-hhmmss_设备_ts.flac (时长=命名差, 可跨日, 可跨分钟)
    #    旧式(整分/wav):   hhmmss_default.wav|.flac   (60s)
    minute_files = {}  # hhmm -> [文件名...]  (区间文件覆盖其跨过的所有分钟)
    def _hhmmss(sec):
        return (sec // 3600) % 24 * 100 + (sec % 3600) // 60
    for fn in os.listdir(adir):
        low = fn.lower()
        if not low.endswith((".wav", ".flac")) or len(fn) < 15:
            continue
        m = _RANGE_NAME_RE.match(fn)
        if m:
            s = int(m.group(1)[:2]) * 3600 + int(m.group(1)[2:4]) * 60 + int(m.group(1)[4:6])
            e = int(m.group(2)[:2]) * 3600 + int(m.group(2)[2:4]) * 60 + int(m.group(2)[4:6])
            if e <= s:
                e += 86400   # 跨日区间(如 235945-000145)
            # 按整分钟对齐展开: 覆盖 [s,e) 跨过的所有分钟格
            for mi in range(s // 60, (e - 1) // 60 + 1):
                sec = mi * 60
                minute_files.setdefault("%04d" % _hhmmss(sec), []).append(fn)
            continue
        if ("_default." in low and fn[:6].isdigit()):
            minute_files.setdefault(fn[:4], []).append(fn)

    # 2) 读 perception voice 条目, 双通道归组:
    #    a) t 字段(hh:mm:ss) → 分钟; b) audio basename → 该文件覆盖的分钟(新式无 t 对齐时兜底)
    by_time = {}
    file_minutes = {}  # basename -> [hhmm...] (由命名解析, 覆盖跨分钟文件)
    for hhmm, fns in minute_files.items():
        for fn in fns:
            file_minutes.setdefault(fn, []).append(hhmm)
    for entry in perception_reader.read_day(date, types=("voice",)):
        bucket = None
        t = (entry.get("t") or "").replace(":", "")
        if t.isdigit() and len(t) >= 6:
            bucket = t[:4]
        else:
            audio = entry.get("audio") or ""
            m = re.search(r"(\d{6})_default\.(?:wav|flac)", audio)
            if m:
                bucket = m.group(1)[:4]
        if bucket is not None:
            by_time.setdefault(bucket, []).append(entry)
            continue
        # 新式命名: 用 audio 路径的 basename 关联它覆盖的分钟
        base = os.path.basename((entry.get("audio") or "").replace("\\", "/"))
        for hm in file_minutes.get(base, []):
            by_time.setdefault(hm, []).append(entry)

    # 3) 合成时间线(按分钟; 每格 = 该分钟首个文件的代表性状态)
    items = []
    for minute in range(1440):
        hh = minute // 60
        mm = minute % 60
        hhmm = f"{hh:02d}{mm:02d}"
        fns = minute_files.get(hhmm)
        if not fns:
            continue  # 该分钟无音频(跳过)
        fns.sort()
        rep_file = fns[0]
        entries = by_time.get(hhmm) or []
        # 该分钟合并判定: 任一文件有语音内容 → voice; 否则取首个代表
        representative = None
        minute_voice = False
        for entry in entries:
            scene = _voice_scene(entry.get("scene") or "")
            segs = entry.get("segs") or []
            speech_segs = [s for s in segs
                           if (s.get("text") or "").strip()
                           and "<|nospeech|>" not in (s.get("text") or "")
                           and "<|Event_UNK|>" not in (s.get("text") or "")]
            if representative is None:
                representative = {"scene": scene if scene != "voice" else "说话声",
                                  "n_segs": len(speech_segs), "asr": _asr_preview(entry)}
            if scene == "voice" and speech_segs:
                minute_voice = True
                representative = {"scene": "说话声", "n_segs": len(speech_segs),
                                  "asr": _asr_preview(entry)}
                break
        if representative is None:
            items.append({"time": hhmm + "00", "file": rep_file, "status": "empty",
                          "scene": "", "n_segs": 0, "asr": ""})
            continue
        items.append({
            "time": hhmm + "00",
            "file": rep_file,
            "status": "voice" if minute_voice else "empty",
            "scene": representative["scene"],
            "n_segs": representative["n_segs"],
            "has_vp": False,
            "asr": representative["asr"],
        })

    # 4) 统计(音频文件去重计数 + 有内容的分钟格数)
    n_files = len({fn for fns in minute_files.values() for fn in fns})
    return {"date": date, "total": len(items), "n_wav": n_files, "items": items}


# ─── API: 单文件详情 ─────────────────────────────────────
#
# B3: 处理链详情全部经内核（inspect.* + voiceprint space）。
# D5 决策: sortformer 入口已从 preview 移除（engine 只剩 pyannote）；
# 后端 scripts/sortformer_server.py 作为独立可选工具保留，本文件不再引用。


@router.get("/file")
def file_detail(date: str, file: str, engine: str = "pyannote"):
    """单文件(60s)处理链详情(B3: 算法全部经内核)。

    - perception segs: VAD 段 = ASR 片段(带 start/end 时间映射)
    - 切分引擎: 仅 pyannote(内核 /v1/inspect/diarize_blocks)
    - 每切分块: 内核 AS-Norm top1(sim 单值; 旧 raw/双名富字段退化)
    内核不可达 -> 各面板空 + reason(不回退本地)。
    """
    _check_date(date)
    _safe_filename(file)
    adir = _audio_dir(date)
    wav = os.path.join(adir, file)
    if not os.path.isfile(wav):
        raise HTTPException(status_code=404, detail=f"音频不存在: {file}")

    engine = (engine or "").lower()
    if engine != "pyannote":
        raise HTTPException(status_code=400, detail="engine 仅支持 pyannote")

    # 1) perception 段(该文件) —— 纯数据读取, 不变
    entry = None
    for e in perception_reader.read_day(date, types=("voice",)):
        audio = (e.get("audio") or "").replace("\\", "/")
        if audio.endswith(file) or audio.endswith("daily/" + date + "/audio/" + file):
            entry = e
            break

    asr_segs = []
    if entry:
        for s in (entry.get("segs") or []):
            txt = (s.get("text") or "").strip()
            asr_segs.append({
                "start": s.get("start", 0),
                "end": s.get("end", 0),
                "text": txt,
                "emotion": (s.get("emotion") or ""),
                "event": (s.get("event") or ""),
            })
    scene = entry.get("scene", "") if entry else ""
    tag = entry.get("tag", "") if entry else ""

    # 2) 内核输入: 整文件一次编码, 五段复用; 内核不可达则各面板统一 reason
    audio_b64 = _kernel_audio_b64(wav)
    if audio_b64 is None:
        kernel_up, core_reason = False, "audio_decode_failed"
    elif not _kernel_available():
        kernel_up, core_reason = False, "state.unavailable"
    else:
        kernel_up, core_reason = True, None

    # 3) 滑窗 ASR(跳过 VAD, 5s 固定窗) -> inspect.asr_sliding
    asr_sliding, asr_sliding_reason = [], None
    if kernel_up:
        facts, err = _kernel_facts("/v1/inspect/asr_sliding",
                                   {"audio_b64": audio_b64, "window_ms": 5000})
        if facts is None:
            asr_sliding_reason = err
        else:
            for w in (facts.get("windows") or []):
                asr_sliding.append({
                    "start": round(int(w.get("start_ms") or 0) / 1000.0, 2),
                    "end": round(int(w.get("end_ms") or 0) / 1000.0, 2),
                    "text": w.get("text") or "",
                    "emotion": w.get("emotion") or "",
                    "event": w.get("event") or "",
                })
            if facts.get("reason") not in (None, "ok"):
                asr_sliding_reason = facts.get("reason")
    else:
        asr_sliding_reason = core_reason

    # 4) 三引擎 VAD 逐帧曲线 -> inspect.vad_curve(统一 frame_ms=100 网格)
    vad_curves, vad_curve_reason = [], None
    if kernel_up:
        for eng, name in (("silero", "Silero"), ("pyannote", "pyannote"),
                          ("funasr", "FunASR")):
            facts, err = _kernel_facts("/v1/inspect/vad_curve",
                                       {"audio_b64": audio_b64,
                                        "engine": eng, "frame_ms": 100})
            if facts is None:
                vad_curve_reason = err
                continue
            if facts.get("reason") not in (None, "ok"):
                vad_curve_reason = facts.get("reason")
            vad_curves.append({
                "name": name, "engine": facts.get("engine") or eng,
                "points": _curve_points(facts),
                "step_ms": facts.get("step_ms"),
                "decimated": facts.get("decimated"),
            })
    else:
        vad_curve_reason = core_reason

    # 5) pyannote 切分块 + 逐块注册库 top1 -> inspect.diarize_blocks
    #    内核 blocks 只四键 {start_ms,end_ms,speaker,sim}; 旧 raw_sim/raw_spk
    #    富字段不存在 -> 前端对应列退化为 "无数据"(见 B3 报告取舍)。
    diar: dict = {"engine": engine, "ready": False, "blocks": [], "reason": "",
                  "prod_track": [], "prod_win": [1500, 750],
                  "vad_probs": [], "blocks_truncated": False}
    if kernel_up:
        facts, err = _kernel_facts("/v1/inspect/diarize_blocks",
                                   {"audio_b64": audio_b64},
                                   timeout=_KERNEL_DIAR_TIMEOUT)
        if facts is None:
            diar["reason"] = err
        else:
            diar["ready"] = True
            diar["blocks"] = [{
                "start": round(int(b.get("start_ms") or 0) / 1000.0, 3),
                "end": round(int(b.get("end_ms") or 0) / 1000.0, 3),
                "speaker": b.get("speaker"),
                "sim": b.get("sim"),
                "sim_spk": b.get("speaker") or "",
                "raw_sim": None,
                "raw_spk": "",
            } for b in (facts.get("blocks") or [])]
            diar["n_cohort"] = facts.get("n_cohort")
            diar["as_norm_on"] = facts.get("as_norm_on")
            diar["blocks_truncated"] = bool(facts.get("blocks_truncated"))
            if facts.get("reason") not in (None, "ok"):
                diar["reason"] = facts.get("reason")
    else:
        diar["reason"] = core_reason

    # 6) silero 曲线 -> 多轨面板的 VAD 概率线(复用第 4 步结果, 0-1 定域)
    sil = next((c for c in vad_curves if c["name"] == "Silero"), None)
    if sil:
        diar["vad_probs"] = [{"t": p["t"], "p": p["v"]} for p in sil["points"]]

    # 7) 生产逻辑滑窗轨(两步切分参数): 每窗内核 score_all_v2(已达标, 不变)
    prod_track, prod_win = [], [1500, 750]
    if kernel_up:
        try:
            from services.unknown_speaker_config import get_unknown_speaker_config as _guc
            from services import kernel_client as _kc4
            import numpy as _np
            _ts = ((_guc().get("detection") or {}).get("two_step") or {})
            win_ms = int(_ts.get("window_ms", 1500))
            hop_ms = int(_ts.get("hop_ms", 750))
            prod_win = [win_ms, hop_ms]
            _audio, _fs = _read_pcm(wav)
            _total = len(_audio) / _fs if _fs else 0.0
            W = win_ms / 1000.0
            step = hop_ms / 1000.0
            s = 0.0
            while s + W <= _total + 1e-6:
                seg = _audio[int(s * _fs):min(int((s + W) * _fs), len(_audio))]
                if len(seg) >= int(0.3 * _fs):
                    rms = float(_np.sqrt(_np.mean(seg.astype(_np.float64) ** 2)))
                    if rms >= 0.002:
                        det = _kc4.score_all_v2(seg, sample_rate=_fs, detail=True)
                        sc = det.get("scores") or {}
                        raw = det.get("raw") or {}
                        top = list(sc.items())[0] if sc else ("", None)
                        rtop = list(raw.items())[0] if raw else ("", None)
                        prod_track.append({
                            "start": round(s, 2), "end": round(s + W, 2),
                            "raw_sim": round(float(rtop[1]), 4) if rtop[1] is not None else None,
                            "raw_spk": str(rtop[0]) if rtop[0] else "",
                            "sim": round(float(top[1]), 4) if top[1] is not None else None,
                            "sim_spk": str(top[0]) if top[0] else "",
                        })
                s += step
        except Exception as e:
            logger.debug(f"[Preview] 生产滑窗轨计算跳过: {e}")

    diar["prod_track"] = prod_track
    diar["prod_win"] = prod_win

    # 文件真实时长(区间命名推算; 失败回退 soundfile 探测, 再退 60s)
    duration = None
    m = _RANGE_NAME_RE.match(file)
    if m:
        s0 = int(m.group(1)[:2]) * 3600 + int(m.group(1)[2:4]) * 60 + int(m.group(1)[4:6])
        e0 = int(m.group(2)[:2]) * 3600 + int(m.group(2)[2:4]) * 60 + int(m.group(2)[4:6])
        duration = float(e0 - s0 if e0 > s0 else e0 + 86400 - s0)
    if not duration:
        try:
            import soundfile as _sf
            _i = _sf.info(wav)
            duration = round(_i.frames / max(int(_i.samplerate or 1), 1), 1)
        except Exception:
            duration = 60.0

    return {
        "date": date,
        "file": file,
        "duration": duration,
        "scene": scene,
        "tag": tag,
        "asr_segs": asr_segs,          # VAD段 = ASR片段(带时间映射)
        "asr_sliding": asr_sliding,    # 滑窗ASR(内核, 跳过VAD)
        "asr_sliding_reason": asr_sliding_reason,
        "vad_curves": vad_curves,      # 三引擎VAD逐帧分数曲线(内核)
        "vad_curve_reason": vad_curve_reason,
        "diar": diar,
        "engine": engine,
        "vad_total_segs": len(asr_segs),
    }


# ─── API: 音频试听 ───────────────────────────────────────


def _cleanup_tmp(path: str):
    """后台删除临时 mp3(延迟由 BackgroundTasks 执行)。"""
    try:
        if os.path.isfile(path):
            os.remove(path)
    except OSError:
        pass


@router.get("/audio")
def audio(date: str, file: str, start: float = 0.0, end: float = 60.0,
          bt: BackgroundTasks = None):
    """裁剪 [start,end] 输出 mp3 试听。区间命名文件可达 120s+, 上限不再钉死 60。"""
    _check_date(date)
    _safe_filename(file)
    wav = os.path.join(_audio_dir(date), file)
    if not os.path.isfile(wav):
        raise HTTPException(status_code=404, detail=f"音频不存在: {file}")
    if end <= start:
        raise HTTPException(status_code=400, detail="end 必须大于 start")
    # 裁剪到文件真实时长(flush 到命名差/探测值; ffmpeg -to 超界自动止于 EOF)
    dur_cap = 60.0
    m = _RANGE_NAME_RE.match(file)
    if m:
        s0 = int(m.group(1)[:2]) * 3600 + int(m.group(1)[2:4]) * 60 + int(m.group(1)[4:6])
        e0 = int(m.group(2)[:2]) * 3600 + int(m.group(2)[2:4]) * 60 + int(m.group(2)[4:6])
        dur_cap = float(e0 - s0 if e0 > s0 else e0 + 86400 - s0)
    mp3 = crop_mp3(wav, max(0.0, start), min(dur_cap, end), _tmp_dir(), "pv_")
    if bt is not None:
        bt.add_task(_cleanup_tmp, mp3)
    return FileResponse(mp3, media_type="audio/mpeg",
                        headers={"Content-Disposition": "inline"})


# ─── API: 滑窗审计(窗口长度 vs 声纹稳定性) ───────────────

_DEFAULT_WINDOWS = "0.5,1,1.5,2,2.5,3,3.5,4,4.5,5,6,7,8,9,10"


@router.get("/sliding")
def sliding_audit(date: str, file: str,
                  windows: str = _DEFAULT_WINDOWS,
                  max_per_win: int = 40):
    """滑窗审计: 用多档窗口长度切窗提 embedding, 返回每窗 raw/AS-Norm 分数。

    观察"窗口长度 vs 声纹稳定性"权衡:
      - 短窗(0.5-2s): 时间分辨率高但 embedding 抖动大
      - 长窗(5-10s): 稳定但时间分辨率粗
    _no_collect=True 避免审计污染 cohort 采集池。
    """
    _check_date(date)
    _safe_filename(file)
    wav = os.path.join(_audio_dir(date), file)
    if not os.path.isfile(wav):
        raise HTTPException(status_code=404, detail=f"音频不存在: {file}")

    from services import kernel_client
    if not kernel_client.get_kernel_client().available():
        # K2: 内核不可达 -> 降级 200(ready=false + 封闭码 reason), 绝不 503
        return {"ready": False, "reason": "state.unavailable"}

    import soundfile as sf
    import numpy as np
    audio, fs = sf.read(wav, dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    total = len(audio) / fs if fs else 0.0

    win_list = []
    for x in windows.split(","):
        try:
            w = float(x.strip())
            if w >= 0.3:
                win_list.append(w)
        except ValueError:
            pass

    out = []
    for W in win_list:
        step = max(0.25, W / 2.0)
        n_max = max(1, int((total - W) / step) + 1) if total > W else 0
        if n_max <= 0:
            out.append({"win": W, "step": round(step, 2), "points": []})
            continue
        idxs = (np.linspace(0, n_max - 1, max_per_win).astype(int)
                if n_max > max_per_win else np.arange(n_max))
        pts = []
        for k in idxs:
            s = float(k) * step
            s0 = int(s * fs)
            s1 = min(int((s + W) * fs), len(audio))
            seg = audio[s0:s1]
            if len(seg) < int(0.3 * fs):
                continue
            rms = float(np.sqrt(np.mean(seg.astype(np.float64) ** 2)))
            if rms < 0.002:   # 静音窗跳过(只记位置)
                pts.append({"start": round(s, 2), "end": round(s + W, 2),
                            "raw_sim": None, "asnorm": None, "top": ""})
                continue
            try:
                det = kernel_client.score_all_v2(seg, sample_rate=fs, detail=True)
            except Exception:
                det = {}
            sc = det.get("scores") or {}
            raw = det.get("raw") or {}
            top = list(sc.items())[0] if sc else ("", None)
            rtop = list(raw.items())[0] if raw else ("", None)
            pts.append({
                "start": round(s, 2), "end": round(s + W, 2),
                "raw_sim": round(float(rtop[1]), 4) if rtop[1] is not None else None,
                "asnorm": round(float(top[1]), 4) if top[1] is not None else None,
                "top": str(top[0]) if top[0] else "",
            })
        out.append({"win": W, "step": round(step, 2), "points": pts})
    return {"ready": True, "file": file, "total": round(total, 2), "windows": out}


# ─── API: 声纹空间 2D 投影 ───────────────────────────────


@router.get("/space")
def voice_space(date: str = "", file: str = "", max_cohort: int = 400,
                probe_win: float = 3.0):
    """声纹空间 2D 投影: cohort 池底图 + 注册质心 + (可选)当前文件滑窗探针。

    B3: PCA 与向量全部在内核(/v1/voiceprint/space 只回坐标), 外层零向量触碰、
    零本地模型。探针仍按 probe_win 切窗(切片是数据管理, 非算法)——每窗一次
    内核调用取该窗投影坐标, 保留旧"多窗漂移方向"审计语义。
    """
    if not _kernel_available():
        return {"ready": False, "reason": "state.unavailable"}

    base, err = _kernel_facts("/v1/voiceprint/space",
                              {"max_cohort": int(max_cohort)})
    if base is None:
        return {"ready": False, "reason": err}
    if base.get("reason") == "insufficient_samples":
        return {"ready": True, "points": [], "reason": "样本不足(需要>=3个向量)"}

    cohort = base.get("cohort") or []
    centroids = base.get("centroids") or []
    points = [{"x": c.get("x"), "y": c.get("y"), "kind": "cohort", "label": ""}
              for c in cohort]
    for c in centroids:
        points.append({"x": c.get("x"), "y": c.get("y"),
                       "kind": "anchor", "label": c.get("name") or ""})
    n_c = len(cohort)

    # 当前文件探针: 按 probe_win 切窗, 每窗送内核投影(保留多窗漂移审计)
    file_points = []
    if date and file:
        try:
            _check_date(date)
            _safe_filename(file)
            wav = os.path.join(_audio_dir(date), file)
            if os.path.isfile(wav):
                import numpy as np
                audio, fs = _read_pcm(wav)
                total = len(audio) / fs if fs else 0.0
                W = max(1.0, float(probe_win))
                step = W / 2.0
                s = 0.0
                while s + W <= total + 1e-6:
                    seg = audio[int(s * fs):min(int((s + W) * fs), len(audio))]
                    if len(seg) >= int(0.5 * fs):
                        rms = float(np.sqrt(np.mean(seg.astype(np.float64) ** 2)))
                        if rms >= 0.002:
                            facts, _e = _kernel_facts(
                                "/v1/voiceprint/space",
                                {"audio_b64": _pcm_b64(seg, fs),
                                 "max_cohort": int(max_cohort)})
                            probe = (facts or {}).get("probe")
                            if probe:
                                file_points.append({
                                    "x": probe.get("x"), "y": probe.get("y"),
                                    "start": round(s, 2),
                                    "end": round(s + W, 2)})
                    s += step
        except Exception as e:
            logger.debug(f"[Preview] 声纹空间探针跳过: {e}")

    explained = base.get("explained") or [None, None]
    return {"ready": True, "n_cohort": n_c,
            "anchors": [c.get("name") or "" for c in centroids],
            "points": points, "file_points": file_points,
            "explained_var": [explained[0], explained[1]]}
