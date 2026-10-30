# -*- coding: utf-8 -*-
"""Phi-4-multimodal 音频理解测试端点（挂在 preview 命名空间下，复用其鉴权豁免）。

供 frontend/preview/index.html 的"Phi-4 音频理解测试"面板使用:
- GET  /api/preview/phi4/files?date=   枚举当天音频(新式区间命名+旧式 _default 全兼容)
- POST /api/preview/phi4/start         显式拉起常驻服务(冷加载 ~15-20s)
- GET  /api/preview/phi4/status        非阻塞探活(down / loading / ready)
- POST /api/preview/phi4/run           {date,file,start,end,prompt,max_new_tokens} -> 推理
- GET  /api/preview/phi4/audio         {date,file,start,end} -> 裁剪 wav 试听

存储现状: 感知链已切 flac(区间命名 hhmmss-hhmmss_设备_ts.flac, 时长=命名差,
可跨日), 本模块枚举/时长探测全按后缀白名单, 不依赖 _default 过滤。
推理在 tools/phi4_serve/serve.py 独立进程(conda phi4mm)。服务不可达一律
200+{ready:false, reason}(与 preview 内核降级约定一致)。
"""
import logging
import os
import re
import threading

from fastapi import APIRouter, Body, HTTPException
from fastapi.responses import Response

from config.config import get_config

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/preview", tags=["preview-phi4"])

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
# 文件名白名单: 中文字母数字下划线点横线(设备名为中文), 拒路径分隔符
_SAFE_NAME = re.compile(r"^[\w.\-\u4e00-\u9fff]+$")
_EXT = (".flac", ".wav", ".m4a", ".mp3", ".ogg", ".opus")
# 区间命名: 000145-000345_设备_ts.flac
_RANGE_RE = re.compile(r"^(\d{6})-(\d{6})_")
# 旧命名: 000934_default.wav
_DEF_RE = re.compile(r"^(\d{6})_default\.")

_starting = threading.Event()

_HHMMSS = lambda s: int(s[:2]) * 3600 + int(s[2:4]) * 60 + int(s[4:6])


def _audio_dir(date: str) -> str:
    return os.path.join(get_config().DATA_DIR, "daily", date, "audio")


def _resolve(date: str, file: str) -> str:
    """日期/文件名校验 + 路径穿越防护, 返回绝对路径。"""
    if not _DATE_RE.match(date or ""):
        raise HTTPException(status_code=400, detail=f"非法日期: {date!r}")
    if not file or not _SAFE_NAME.match(file) or ".." in file:
        raise HTTPException(status_code=400, detail=f"非法文件名: {file!r}")
    if not file.lower().endswith(_EXT):
        raise HTTPException(status_code=400, detail="不支持的音频格式")
    adir = _audio_dir(date)
    path = os.path.realpath(os.path.join(adir, file))
    root = os.path.realpath(adir)
    try:
        ok = os.path.commonpath([root, path]) == root
    except ValueError:
        ok = False
    if not ok or not os.path.isfile(path):
        raise HTTPException(status_code=404, detail=f"音频不存在: {file}")
    return path


def _listed_duration(fn: str):
    """从命名推时长(秒); 区间式跨日补 24h; 旧式返回 None(交给探测)。"""
    m = _RANGE_RE.match(fn)
    if m:
        d = _HHMMSS(m.group(2)) - _HHMMSS(m.group(1))
        if d < 0:
            d += 86400
        return float(d)
    return None


@router.get("/phi4/files")
def phi4_files(date: str):
    """当天全部音频列表(按起始时刻排序): [{file, t0, dur}]。"""
    if not _DATE_RE.match(date or ""):
        raise HTTPException(status_code=400, detail="非法日期")
    adir = _audio_dir(date)
    if not os.path.isdir(adir):
        return {"files": []}
    from services import phi4_client
    out = []
    for fn in os.listdir(adir):
        if not fn.lower().endswith(_EXT) or ("_default." not in fn and not _RANGE_RE.match(fn)):
            continue
        m = _RANGE_RE.match(fn) or _DEF_RE.match(fn)
        t0 = (m.group(1)[:4] + "00") if m else "000000"
        dur = _listed_duration(fn)
        if dur is None:
            dur = phi4_client.probe_duration(os.path.join(adir, fn))
        out.append({"file": fn, "t0": t0, "dur": dur or 60.0})
    out.sort(key=lambda x: x["t0"])
    return {"files": out}


def _do_start():
    from services import phi4_client
    try:
        phi4_client.get_phi4_client().ensure()
    except Exception as e:
        logger.warning("phi4 background start failed: %s", e)
    finally:
        _starting.clear()


@router.post("/phi4/start")
def phi4_start():
    """异步拉起常驻服务(前端轮 /phi4/status 直到 ready)。"""
    from services import phi4_client
    if phi4_client.get_phi4_client().available():
        return {"ready": True, "state": "ready"}
    if not _starting.is_set():
        _starting.set()
        threading.Thread(target=_do_start, daemon=True, name="phi4-spawn").start()
    return {"ready": False, "state": "loading"}


@router.get("/phi4/status")
def phi4_status():
    """非阻塞状态: ready / loading / down(不 spawn)。"""
    from services import phi4_client
    try:
        if phi4_client.get_phi4_client().available():
            return {"ready": True, "state": "ready"}
    except Exception as e:
        logger.warning("phi4 status probe error: %s", e)
    if _starting.is_set():
        return {"ready": False, "state": "loading"}
    return {"ready": False, "state": "down"}


@router.post("/phi4/run")
def phi4_run(body: dict = Body(...)):
    """裁剪 [start,end] -> Phi-4 推理 -> {text, seconds, ...}。"""
    path = _resolve(str(body.get("date") or ""), str(body.get("file") or ""))
    try:
        start = float(body.get("start") or 0.0)
        end = float(body.get("end") or 60.0)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="start/end 必须是数字")
    if end <= start:
        raise HTTPException(status_code=400, detail="end 必须大于 start")
    prompt = str(body.get("prompt") or "").strip()
    max_new = max(16, min(int(body.get("max_new_tokens") or 512), 2048))

    from services import phi4_client
    try:
        pcm = phi4_client.crop_wav_16k_mono(path, start, end)
        try:
            phi4_client.get_phi4_client().ensure()
        except phi4_client.Phi4Unavailable as e:
            return {"ready": False, "reason": str(e)[:300]}
        out = phi4_client.get_phi4_client().infer_wav_bytes(pcm, prompt, max_new)
        out["ready"] = True
        out["range"] = [round(start, 1), round(end, 1)]
        return out
    except phi4_client.Phi4Unavailable as e:
        return {"ready": False, "reason": str(e)[:300]}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("phi4 run failed")
        return {"ready": False, "reason": ("服务端异常: %s" % e)[:300]}


# ─── 试听: flac/wav 内存裁剪(不依赖 ffmpeg) ──────────────

@router.get("/phi4/audio")
def phi4_audio(date: str, file: str, start: float = 0.0, end: float = 60.0):
    """裁剪 [start,end] 返回 16k mono wav 字节流试听。"""
    path = _resolve(date, file)
    from services import phi4_client
    try:
        pcm = phi4_client.crop_wav_16k_mono(path, max(0.0, start), end)
    except phi4_client.Phi4Unavailable as e:
        raise HTTPException(status_code=400, detail=str(e)[:300])
    return Response(
        content=pcm, media_type="audio/wav",
        headers={"Content-Disposition": "inline"})
