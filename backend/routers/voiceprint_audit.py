"""声纹识别系统 审计/测试平台 API

提供每日感知数据、cohort 冒名者队列、unknown_speaker 建档、声纹注册库
的只读审计端点 + 实时音频裁剪测试能力。配套前端: frontend/vaudit/(纯静态)。

设计要点:
- 数据列表一律剔除大数组字段(embedding/centroid/support_vectors), 控制响应体积。
- 音频播放端点依赖中间件"Query token"能力: <audio src="...?token=xxx"> 可播。
- ffmpeg 裁剪输出 mp3(16k/mono/64k) 到 cache/vaudit_tmp/, 响应后后台删除。
- 全部只读, 不改动任何数据文件。

访问约定:
- 静态页面:  http://<host>:<port>/vaudit/   (免认证)
- 数据列表:  /api/vaudit/*  (Bearer token 或 ?token=)
"""

import asyncio
import json
import logging
import os
import re
import subprocess
import uuid

from fastapi import APIRouter, HTTPException, BackgroundTasks
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from config.config import get_config
from services.audio_codec import ffmpeg_path, crop_mp3
from services import perception_reader

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/vaudit", tags=["vaudit"])

# ─── 工具函数 ────────────────────────────────────────────

_SAFE_NAME = re.compile(r"^[A-Za-z0-9._-]+$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_CROP_TMP_REL = os.path.join("cache", "vaudit_tmp")


def _data_dir() -> str:
    return get_config().DATA_DIR


def _daily_dir(date: str) -> str:
    return os.path.join(_data_dir(), "daily", date)


def _safe_filename(name: str) -> bool:
    return bool(name) and bool(_SAFE_NAME.match(name)) and ".." not in name


def _crop_tmp_dir() -> str:
    d = os.path.join(_data_dir(), _CROP_TMP_REL)
    os.makedirs(d, exist_ok=True)
    return d


# 保存延迟清理任务的强引用：asyncio 事件循环只持有 Task 的弱引用，
# 若不显式保存，任务可能在 30 秒 sleep 结束前就被 GC 回收，导致临时文件泄漏。
_cleanup_tasks: set = set()


def _cleanup_later(path: str):
    """延迟删除临时文件(给 FileResponse 流式输出留时间)。"""
    async def _rm():
        await asyncio.sleep(30)
        try:
            if os.path.isfile(path):
                os.unlink(path)
        except OSError:
            pass
    task = asyncio.create_task(_rm())
    _cleanup_tasks.add(task)
    task.add_done_callback(_cleanup_tasks.discard)


def _merge_windows(wins, gap=1.5):
    """合并相邻/近邻的 [start,end] 窗口: 间隔<gap秒的合并为一段。

    wins: [(start,end),...] (已按start排序)。返回合并后区间列表。
    """
    if not wins:
        return []
    wins = sorted(wins)
    merged = [list(wins[0])]
    for s, e in wins[1:]:
        if s - merged[-1][1] <= gap:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    return [(round(a, 1), round(b, 1)) for a, b in merged]


def _find_unk_windows(date: str, src_file: str, unk_id: str):
    """扫描 daily/{date}/perception.jsonl 中 src_file 的 segs。

    两级定位该 unk_id 在该文件的语音窗口:
      ① seg.vp.ws_spk 含 unk_id → 取 ws 标记的 750ms 窗口(精确)
      ② seg.spk.unk_id == unk_id → 整个 seg 段(较粗但覆盖)

    返回合并前 [start,end] 窗口列表(秒)。文件存在但无任何标记返回 None。
    """
    if not perception_reader.has_perception(date):
        return None
    wins = []
    found_file = False
    for row in perception_reader.read_day(date, types=("voice",)):
        audio_rel = row.get("audio", "") or ""
        if src_file not in audio_rel:
            continue
        found_file = True
        for seg in row.get("segs") or []:
            seg_start = float(seg.get("start", 0))
            seg_end = float(seg.get("end", 0))
            seg_dur = seg_end - seg_start
            # ① seg.spk.unk_id 直接命中 → 整个 seg
            spk = seg.get("spk") or {}
            if spk.get("unk_id") == unk_id:
                if seg_dur > 0.3 and seg_dur < 55:
                    wins.append((seg_start, seg_end))
                continue
            # ② vp.ws_spk 命中 → 精确 750ms 窗口
            vp = seg.get("vp") or {}
            ws = vp.get("ws") or []
            wspk = vp.get("ws_spk") or []
            if not ws or not wspk:
                continue
            for i, sp in enumerate(wspk):
                if sp != unk_id:
                    continue
                if i * 2 + 1 >= len(ws):
                    continue
                off_s = float(ws[i * 2]) / 1000.0
                wins.append((seg_start + off_s, seg_start + off_s + 0.75))
    if not found_file:
        return None
    return wins


def _crop_concat_mp3(src_wav: str, ranges, pad=0.15):
    """对同一源文件多个 [start,end] 区间各裁剪 mp3 再 concat 拼接。

    返回合并后的 mp3 路径。ranges 为空时抛 400。
    """
    if not ranges:
        raise HTTPException(status_code=400, detail="无有效裁剪区间")
    ffmpeg = ffmpeg_path()
    tmp_dir = _crop_tmp_dir()
    part_files = []
    try:
        for idx, (s0, e0) in enumerate(ranges):
            s0 = max(0.0, float(s0) - pad)
            e0 = min(60.0, float(e0) + pad)
            if e0 <= s0:
                continue
            part = os.path.join(tmp_dir, f"unk_{uuid.uuid4().hex[:10]}_{idx}.mp3")
            cmd = [ffmpeg, "-y", "-i", src_wav, "-ss", f"{s0:.2f}", "-to", f"{e0:.2f}",
                   "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", "-f", "mp3", part]
            proc = subprocess.run(cmd, capture_output=True, timeout=120)
            if proc.returncode != 0 or not os.path.isfile(part):
                continue
            part_files.append(part)
        if not part_files:
            raise HTTPException(status_code=500, detail="所有片段裁剪失败")
        if len(part_files) == 1:
            return part_files[0]
        # 多个片段: 生成 concat list 文件并用 ffmpeg concat demuxer 拼接
        list_path = os.path.join(tmp_dir, f"unk_concat_{uuid.uuid4().hex[:10]}.txt")
        out_path = os.path.join(tmp_dir, f"unk_{uuid.uuid4().hex[:12]}.mp3")
        with open(list_path, "w", encoding="utf-8") as lf:
            for p in part_files:
                # concat 文件路径含反斜杠/空格需转义
                p_norm = os.path.normpath(p).replace("\\", "/").replace("'", "'\\''")
                lf.write(f"file '{p_norm}'\n")
        cmd = [ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", list_path,
               "-c", "copy", out_path]
        proc = subprocess.run(cmd, capture_output=True, timeout=120)
        for p in part_files:
            try:
                os.unlink(p)
            except OSError:
                pass
        try:
            os.unlink(list_path)
        except OSError:
            pass
        if proc.returncode != 0 or not os.path.isfile(out_path):
            err = proc.stderr.decode("utf-8", "ignore")[-200:] if proc.stderr else ""
            raise HTTPException(status_code=500, detail=f"片段拼接失败: {err[-100:]}")
        return out_path
    except HTTPException:
        for p in part_files:
            try:
                os.unlink(p)
            except OSError:
                pass
        raise


# ─── 1. 每日数据 ─────────────────────────────────────────

@router.get("/days")
async def list_days():
    """列出有感知数据的日期目录, 附 voice 段统计。按日期降序。"""
    daily_root = os.path.join(_data_dir(), "daily")
    days = []
    if os.path.isdir(daily_root):
        for name in sorted(os.listdir(daily_root), reverse=True):
            if not _DATE_RE.match(name):
                continue
            day_dir = os.path.join(daily_root, name)
            if not os.path.isdir(day_dir):
                continue
            voice_count = 0
            first_t = last_t = None
            for row in perception_reader.read_day(name, types=("voice",)):
                voice_count += 1
                t = row.get("t", "")
                if not first_t or (t and t < first_t):
                    first_t = t
                if t and (not last_t or t > last_t):
                    last_t = t
            audio_dir = os.path.join(day_dir, "audio")
            audio_count = len([x for x in os.listdir(audio_dir)
                               if x.endswith((".wav", ".flac"))]) if os.path.isdir(audio_dir) else 0
            if voice_count or audio_count:
                days.append({
                    "date": name,
                    "voice_count": voice_count,
                    "audio_count": audio_count,
                    "first_t": first_t,
                    "last_t": last_t,
                })
    return {"status": "ok", "days": days, "total_days": len(days)}


@router.get("/day/{date}")
async def get_day(date: str, offset: int = 0, limit: int = 200):
    """某天全部 voice 段精简列表(不展开 segs)。"""
    if not _DATE_RE.match(date):
        raise HTTPException(status_code=400, detail="日期格式须为 YYYY-MM-DD")
    if not perception_reader.has_perception(date):
        raise HTTPException(status_code=404, detail=f"该日期无感知数据: {date}")
    voices = []
    for row in perception_reader.read_day(date, types=("voice",)):
        segs = row.get("segs") or []
        primary_spk = primary_sim = None
        best_dur = -1
        # 有效语音范围: 收集非"整文件占位"的 segs 起止(去掉 [0,dur] 或 dur>55s 的占位段)
        seg_bounds = []
        for seg in segs:
            s_start = float(seg.get("start", 0))
            s_end = float(seg.get("end", 0))
            seg_dur = s_end - s_start
            if seg_dur > best_dur:
                best_dur = seg_dur
                vp = seg.get("vp") or {}
                primary_spk = vp.get("spk")
                primary_sim = vp.get("sim")
            # 占位段(近似整文件)不参与裁剪范围计算
            if seg_dur < 55.0 and s_end > s_start + 0.2:
                seg_bounds.append((s_start, s_end))
        audio_rel = row.get("audio", "")
        audio_file = os.path.basename(audio_rel) if audio_rel else ""
        ac = row.get("ac") or {}
        # 音频URL: 有精确语音段 → 自动裁剪到 [min_start-0.3, max_end+0.3]
        audio_url = None
        if audio_file:
            if seg_bounds:
                c_start = max(0.0, min(b[0] for b in seg_bounds) - 0.3)
                c_end = min(60.0, max(b[1] for b in seg_bounds) + 0.3)
                audio_url = (f"/api/vaudit/audio/crop?date={date}&file={audio_file}"
                             f"&start={c_start:.1f}&end={c_end:.1f}")
            else:
                audio_url = f"/api/vaudit/day/{date}/audio/{audio_file}"
        voices.append({
            "t": row.get("t"),
            "dur": row.get("dur"),
            "tag": row.get("tag"),
            "text": row.get("text", ""),
            "scene": row.get("scene", ""),
            "env": row.get("env", ""),
            "device_name": row.get("device_name", ""),
            "segs_count": len(segs),
            "primary_spk": primary_spk,
            "primary_sim": primary_sim,
            "ac_db": ac.get("db"),
            "ac_spk": ac.get("spk"),
            "audio_url": audio_url,
            "audio_cropped": bool(seg_bounds),
            "seg_range": [round(min(b[0] for b in seg_bounds), 1),
                          round(max(b[1] for b in seg_bounds), 1)] if seg_bounds else None,
        })
    total = len(voices)
    page = voices[offset: offset + limit]
    return {"status": "ok", "date": date, "total": total,
            "offset": offset, "limit": limit, "voices": page}


@router.get("/day/{date}/audio/{filename}")
async def get_day_audio(date: str, filename: str):
    """返回某天原始音频文件(FileResponse 原生支持 Range/seek)。"""
    if not _DATE_RE.match(date) or not _safe_filename(filename):
        raise HTTPException(status_code=400, detail="非法参数")
    abs_path = os.path.normpath(os.path.join(_daily_dir(date), "audio", filename))
    if not abs_path.startswith(os.path.normpath(os.path.join(_data_dir(), "daily"))):
        raise HTTPException(status_code=403, detail="路径越界")
    if not os.path.isfile(abs_path):
        raise HTTPException(status_code=404, detail="音频不存在")
    # T5: MIME 按扩展名（wav/flac 双档，抄 mimo._MEDIA_TYPES 语义）
    media = "audio/flac" if abs_path.lower().endswith(".flac") else "audio/wav"
    return FileResponse(abs_path, media_type=media)


# ─── 2. Cohort 冒名者队列 ────────────────────────────────

# 内核 audit 端点 limit 上限（kernel voiceprint.py clamp），外层同口径收敛
_COHORT_KERNEL_LIMIT_MAX = 1000


def _cohort_attach_audio_url(item: dict) -> dict:
    """按条目溯源字段拼试听裁剪 URL（外层业务，内核不含音频文件语义）。"""
    t = item.get("t", "")
    date = t[:10] if t else ""
    src = item.get("src", "")
    ss = item.get("src_start", 0)
    se = item.get("src_end", 0)
    item["audio_url"] = (f"/api/vaudit/cohort/audio?date={date}&src={src}"
                         f"&start={ss}&end={se}") if date and src else None
    return item


def _cohort_kernel_error(exc: Exception, what: str = "cohort") -> HTTPException:
    """内核不可达/内核错误 -> 503/透传（vaudit 端点惯例: detail 字符串）。

    数据源已迁内核 state-dir，外层 ai/data/cache 旧文件是 9-22 断供快照，
    绝不回退读取（防分裂脑），故失败一律以 HTTPException 呈现。
    """
    from services import kernel_client as _kc
    if isinstance(exc, _kc.KernelUnavailable):
        _kc.log_down_once(str(exc))
        return HTTPException(status_code=503,
                             detail=f"{what} 数据源不可用（内核不可达）")
    if isinstance(exc, _kc.KernelHttpError):
        detail = f"{what} 查询失败（内核 {exc.status}）"
        body = exc.body if isinstance(exc.body, dict) else {}
        code = ((body.get("error") or {}).get("code")) or ""
        if code:
            detail += f": {code}"
        status = exc.status if 400 <= exc.status < 600 else 503
        return HTTPException(status_code=status, detail=detail)
    return HTTPException(status_code=500, detail=f"{what} 查询异常: {exc}")


def _cohort_kernel_get(path: str, params: dict) -> dict:
    """同步 GET 内核并取 facts（信封 {schema_version, facts, provenance}）。"""
    from urllib.parse import urlencode

    from services import kernel_client
    query = ("?" + urlencode(params)) if params else ""
    result = kernel_client.get_kernel_client().srequest(
        "GET", path + query, timeout=15.0
    )
    facts = (result or {}).get("facts") if isinstance(result, dict) else None
    return facts if isinstance(facts, dict) else {}


def _sim_stats(sims):
    if not sims:
        return {}
    s = sorted(sims)
    n = len(s)
    med = s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2
    return {"n": n, "mean": round(sum(sims) / n, 4), "median": round(med, 4),
            "min": round(s[0], 4), "max": round(s[-1], 4)}


def _cohort_pool_metrics() -> dict:
    """cohort 池质量参数——经内核 GET /v1/voiceprint/cohort/metrics 中继。

    K2: 向量绝不出内核；外层只转发内核 facts（imp 分布/池内相似度/AS-Norm 参照）。
    内核不可达 -> {"status":"unavailable","reason":"state.unavailable"}（端点仍 200）。
    """
    try:
        from services import kernel_client
        result = kernel_client.get_kernel_client().srequest(
            "GET", "/v1/voiceprint/cohort/metrics", timeout=15.0
        )
        facts = (result or {}).get("facts") or {}
        return facts if isinstance(facts, dict) else {
            "status": "error", "reason": "内核响应格式异常"
        }
    except Exception as e:
        try:
            from services import kernel_client as _kc
            if isinstance(e, _kc.KernelUnavailable):
                _kc.log_down_once(str(e))
                return {"status": "unavailable", "reason": "state.unavailable"}
            logger.warning(f"[vaudit] cohort 指标获取失败: {e}")
            return {"status": "error", "reason": str(e)}
        except Exception:
            logger.warning(f"[vaudit] cohort 指标获取失败: {e}")
            return {"status": "error", "reason": str(e)}


@router.get("/cohort/metrics")
async def cohort_metrics():
    """cohort 池实时质量参数(imp_mean/imp_std 分布, 池内相似度, AS-Norm 参照)。"""
    return {"status": "ok", "metrics": _cohort_pool_metrics()}


@router.get("/cohort")
async def list_cohort(source: str = "active", offset: int = 0, limit: int = 300,
                      date: str = "", sim_min: float = -1.0):
    """cohort 列表。source=active|audit。数据源 = 内核 state-dir（唯一真相源）。

    B4 迁移：外层不再直读 ai/data/cache/cohort_*.jsonl（9-22 断供历史快照），
    改走内核只读端点。响应形状向后兼容（status/source/total/offset/limit/
    stats/voices 键不变，voices 条目为元数据 + audio_url，无 embedding）。

    - audit -> GET /v1/voiceprint/cohort/audit（内核侧 date/sim_min 过滤 +
      offset/limit 分页 + stats，limit 被内核 clamp 到 [1,1000]；缺文件 = 200 零计数）。
    - active -> GET /v1/voiceprint/cohort（工作集全量 <=500 条，过滤/分页/统计
      在外层内存完成，与旧实现语义一致）。
    内核不可达 -> 503（绝不回退旧文件，防分裂脑）。
    """
    if source not in ("active", "audit"):
        raise HTTPException(status_code=400, detail="source 须为 active 或 audit")
    offset = max(0, int(offset))
    limit = min(max(1, int(limit)), _COHORT_KERNEL_LIMIT_MAX)
    try:
        if source == "audit":
            facts = _cohort_kernel_get("/v1/voiceprint/cohort/audit", {
                "offset": offset, "limit": limit, "date": date, "sim_min": sim_min})
            page = [_cohort_attach_audio_url(dict(it))
                    for it in (facts.get("items") or []) if isinstance(it, dict)]
            stats = facts.get("stats")
            if not isinstance(stats, dict):
                stats = {}
            return {"status": "ok", "source": source,
                    "total": int(facts.get("total") or 0),
                    "offset": int(facts.get("offset") or offset),
                    "limit": int(facts.get("limit") or limit),
                    "stats": stats, "voices": page}
        # active: 内核工作集清单（白名单元数据，永不带向量）
        facts = _cohort_kernel_get("/v1/voiceprint/cohort", {})
        items = [dict(it) for it in (facts.get("items") or []) if isinstance(it, dict)]
        if date:
            items = [it for it in items if str(it.get("t", "")).startswith(date)]
        if sim_min > -1.0:
            items = [it for it in items if float(it.get("sim", 0) or 0) >= sim_min]
        # stats 按过滤后集合计算（与内核 audit 端点口径一致；旧实现按全池算
        # 与展示的 total 口径打架，本次一并对齐）
        sims = [float(it.get("sim", 0) or 0) for it in items]
        total = len(items)
        page = [_cohort_attach_audio_url(it) for it in items[offset: offset + limit]]
        return {"status": "ok", "source": source, "total": total,
                "offset": offset, "limit": limit,
                "stats": _sim_stats(sims), "voices": page}
    except HTTPException:
        raise
    except Exception as e:
        logger.warning(f"[vaudit] cohort 列表获取失败: {e}")
        raise _cohort_kernel_error(e) from e


def _serve_crop(date: str, file: str, start: float, end: float,
                background_tasks: BackgroundTasks = None,
                download_name: str = ""):
    """裁剪唯一实现(P1-V4): 校验 → ffmpeg 裁剪 [start,end] → 返回 mp3 FileResponse。

    GET /audio/crop 与 GET /cohort/audio(合一 handler)、POST /crop 全部委派至此。
    file 参数语义: 纯文件名(daily/{date}/audio/ 下)或相对路径均校验防穿越。
    download_name 非空时响应附 Content-Disposition 附件名(仅 POST /crop 使用)。
    """
    if not _DATE_RE.match(date) or not _safe_filename(file):
        raise HTTPException(status_code=400, detail="非法参数")
    src_wav = os.path.normpath(os.path.join(_daily_dir(date), "audio", file))
    if not src_wav.startswith(os.path.normpath(os.path.join(_data_dir(), "daily"))):
        raise HTTPException(status_code=403, detail="路径越界")
    out = crop_mp3(src_wav, start, end, _crop_tmp_dir(), "crop_")
    if background_tasks is not None:
        def _rm(p):
            try:
                os.unlink(p)
            except OSError:
                pass
        background_tasks.add_task(_rm, out)
    else:
        _cleanup_later(out)
    kw = {"media_type": "audio/mpeg"}
    if download_name:
        kw["filename"] = download_name
    return FileResponse(out, **kw)


@router.get("/audio/crop")
@router.get("/cohort/audio")
async def serve_crop(date: str = "", file: str = "", src: str = "",
                     start: float = 0.0, end: float = 60.0,
                     background_tasks: BackgroundTasks = None):
    """通用裁剪(P1-V4 合一: 一个 handler 挂两条路径): daily/{date}/audio/{x} 裁剪 mp3。

    /audio/crop 参数名 file(daily 页 audio_url 模板下发),
    /cohort/audio 参数名 src(cohort 页模板下发)——语义同源, 薄适配 file or src,
    两兼容路径均不退役。
    """
    return _serve_crop(date, file or src, start, end, background_tasks)


# ─── 3. Unknown Speaker 建档(簇审计) ─────────────────────

_UNKNOWN_DB_CANDIDATES = [
    # (标签, 相对路径)  按优先级
    ("current", os.path.join("cache", "unknown_speakers.jsonl")),
    ("legacy", os.path.join("cache", "unknown_speakers.legacy_20260905_152732.jsonl")),
    ("bak_0901", os.path.join("cache", "unknown_speakers_backup_20260901_193226.jsonl")),
    ("bak_0904", os.path.join("cache", "unknown_speakers_backup_20260904_1224.jsonl")),
]


def _resolve_files(raw):
    """audio_files 字段可能是 json 字符串或 list。"""
    if isinstance(raw, str):
        try:
            v = json.loads(raw.replace("'", '"'))
            return v if isinstance(v, list) else [raw]
        except Exception:
            return [raw]
    return list(raw or [])


def _resolve_env_stats(raw):
    if isinstance(raw, str):
        try:
            return json.loads(raw.replace("'", '"'))
        except Exception:
            return {}
    return raw or {}


def _load_unknown_db(source):
    """读取指定来源的 unknown 建档库。source: current/legacy/all/文件名。"""
    if source in ("current", "legacy", "bak_0901", "bak_0904"):
        rel = dict(_UNKNOWN_DB_CANDIDATES)[source]
    elif source == "all":
        rows = []
        for _label, rel in _UNKNOWN_DB_CANDIDATES:
            p = os.path.join(_data_dir(), rel)
            if os.path.isfile(p):
                rows.extend(_read_unknown_rows(p, _label))
        return rows
    else:
        # 任意相对路径(安全)
        if not _safe_filename(source):
            raise HTTPException(status_code=400, detail="非法 source")
        rel = source
    p = os.path.join(_data_dir(), rel)
    if not os.path.isfile(p):
        raise HTTPException(status_code=404, detail=f"unknown 库不存在: {rel}")
    label = source
    return _read_unknown_rows(p, label)


def _read_unknown_rows(path, origin):
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            row["_origin"] = origin
            rows.append(row)
    return rows


def _find_unk_in_db(unk_id):
    """在全部库里找该 unk, 返回 (row, origin)。"""
    for _label, rel in _UNKNOWN_DB_CANDIDATES:
        p = os.path.join(_data_dir(), rel)
        if not os.path.isfile(p):
            continue
        for line in open(p, encoding="utf-8"):
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if row.get("unk_id") == unk_id:
                return row, _label
    return None, None


@router.get("/unknown")
async def list_unknown(source: str = "all", confirmed_only: bool = False):
    """unknown 建档簇审计列表。

    source: current(新链路) | legacy(旧链路全量) | bak_0901 | bak_0904 | all
    每簇附 samples: 该簇关联的音频文件清单(去重)与每个文件的可试听信息。
    """
    rows = _load_unknown_db(source)
    items = []
    for row in rows:
        unk_id = row.get("unk_id", "")
        arch_dir = os.path.join(_data_dir(), "cache", "unknown_audio", unk_id)
        arch_wavs = []
        if os.path.isdir(arch_dir):
            arch_wavs = sorted(
                x for x in os.listdir(arch_dir)
                if x.endswith((".wav", ".flac")) and not x.endswith(".json")
            )
        has_arch = len(arch_wavs) > 0
        files = _resolve_files(row.get("audio_files"))
        # 样本: 归档 wav 优先(真实裁剪好的会话音频, 新链路建档 audio_files 为空);
        # 无归档才回退 audio_files(旧链路, 去 daily 目录按日期找源文件)。
        seen = set()
        samples = []
        fs_date = str(row.get("first_seen", ""))[:10]
        if arch_wavs:
            # 归档样本: 附 sidecar 元数据(会话时长/块数/时间)
            for w in arch_wavs:
                if w in seen:
                    continue
                seen.add(w)
                side = {}
                # splitext 兼容 .wav(4字符) 与 .flac(5字符)——切 4 位会破坏 flac 基名
                sj = os.path.join(arch_dir, os.path.splitext(w)[0] + ".json")
                if os.path.isfile(sj):
                    try:
                        with open(sj, encoding="utf-8") as _f:
                            side = json.load(_f)
                    except Exception:
                        side = {}
                samples.append({
                    "idx": len(samples),
                    "file": w,
                    "source": "archive",
                    "archived": True,
                    "block_count": side.get("block_count"),
                    "dur_s": side.get("archived_dur_s") or side.get("total_dur_s"),
                    "session_id": side.get("session_id", ""),
                    "available": True,
                    "audio_url": f"/api/vaudit/unknown/{unk_id}/archive/{w}",
                })
        else:
            for i, f in enumerate(files):
                if f in seen:
                    continue
                seen.add(f)
                available = False
                if fs_date:
                    p = os.path.normpath(os.path.join(_daily_dir(fs_date), "audio", str(f)))
                    available = os.path.isfile(p)
                samples.append({
                    "idx": len(samples),
                    "file": f,
                    "source": "daily",
                    "archived": False,
                    "available": available,
                    "audio_url": f"/api/vaudit/unknown/{unk_id}/sample/{len(samples)}",
                })
        items.append({
            "unk_id": unk_id,
            "count": row.get("count") or row.get("session_count"),
            "session_count": row.get("session_count"),
            "status": row.get("status"),
            "origin": row.get("_origin", ""),
            "first_seen": row.get("first_seen"),
            "last_seen": row.get("last_seen"),
            "scenes": row.get("scenes"),
            "devices": row.get("devices"),
            "env_stats": _resolve_env_stats(row.get("env_stats")),
            "internal_med": row.get("internal_med"),
            "session_ids": (row.get("session_ids") or [])[:20],
            "has_archived": has_arch,
            "sample_count": len(samples),
            "samples_available": sum(1 for s in samples if s["available"]),
            "samples": samples,
            "audio_url": f"/api/vaudit/unknown/{unk_id}/audio",
        })
    if confirmed_only:
        items = [it for it in items if it["status"] == "confirmed"]
    # 排序: confirmed 优先, 再按 last_seen 降序
    items.sort(key=lambda x: (0 if x["status"] == "confirmed" else 1,
                              str(x["last_seen"] or "")), reverse=True)
    confirmed = sum(1 for it in items if it["status"] == "confirmed")
    return {"status": "ok", "source": source, "total": len(items),
            "confirmed_n": confirmed,
            "pending_n": len(items) - confirmed,
            "unknowns": items}


def _resolve_unk_row_files(unk_id):
    """查 unk 在库中的行 + 该行音频文件清单, 返回 (date, files)。"""
    row, origin = _find_unk_in_db(unk_id)
    if row is None:
        return None, None, None
    date = str(row.get("first_seen", ""))[:10]
    files = _resolve_files(row.get("audio_files"))
    # 去重保序
    seen = set()
    uniq = [f for f in files if not (f in seen or seen.add(f))]
    return row, date, uniq


@router.get("/unknown/{unk_id}/audio")
async def get_unknown_audio(unk_id: str, file_idx: int = -1,
                            background_tasks: BackgroundTasks = None):
    """试听 unknown 样本(自动裁剪到该说话人窗口)。

    策略(按优先级):
      ① 该样本文件在 daily perception 中有此 unk_id 的 ws_spk 窗口
         → 自动裁剪并拼接成该人语音段(mp3)
      ② 有归档音频 → 播归档
      ③ 否则源文件整段回退。
    """
    if not _safe_filename(unk_id):
        raise HTTPException(status_code=400, detail="非法 unk_id")
    row, date, files = _resolve_unk_row_files(unk_id)
    if not date or not files:
        # 无库记录 → 尝试归档目录
        return _serve_unknown_archive(unk_id, None)
    # 定位目标文件
    if file_idx >= 0 and file_idx < len(files):
        target = str(files[file_idx])
    else:
        target = None
        for f in files:
            p = os.path.normpath(os.path.join(_daily_dir(date), "audio", str(f)))
            if os.path.isfile(p):
                target = str(f)
                break
    if not target:
        return _serve_unknown_archive(unk_id, None)
    src_wav = os.path.normpath(os.path.join(_daily_dir(date), "audio", target))
    if not os.path.isfile(src_wav):
        return _serve_unknown_archive(unk_id, None)
    # ① 扫该文件里 unk 的 ws_spk 窗口 → 自动裁剪
    wins = _find_unk_windows(date, target, unk_id)
    if wins:
        merged = _merge_windows(wins, gap=2.0)
        # 若窗口覆盖文件 >85% 说明整段都是此人 → 直接整文件
        total_win = sum(e - s for s, e in merged)
        if total_win < float(row.get("dur") or 60.0) * 0.85:
            try:
                out = _crop_concat_mp3(src_wav, merged, pad=0.2)
                if background_tasks is not None:
                    def _rm(p):
                        try:
                            os.unlink(p)
                        except OSError:
                            pass
                    background_tasks.add_task(_rm, out)
                else:
                    _cleanup_later(out)
                return FileResponse(out, media_type="audio/mpeg",
                                    headers={"X-Source": "unk-window",
                                             "X-File": target,
                                             "X-Windows": str(len(merged))})
            except HTTPException:
                pass  # 裁剪失败降级整文件
    # ②/③ 整文件
    media = "audio/flac" if src_wav.lower().endswith(".flac") else "audio/wav"
    return FileResponse(src_wav, media_type=media,
                        headers={"X-Source": "fallback-full",
                                 "X-File": target})


def _serve_unknown_archive(unk_id: str, _unused):
    """归档音频回退。"""
    arch_dir = os.path.join(_data_dir(), "cache", "unknown_audio", unk_id)
    if os.path.isdir(arch_dir):
        audio_files = sorted(x for x in os.listdir(arch_dir)
                             if x.endswith((".wav", ".flac")))
        if audio_files:
            first = os.path.join(arch_dir, audio_files[0])
            media = "audio/flac" if first.lower().endswith(".flac") else "audio/wav"
            return FileResponse(first, media_type=media,
                                headers={"X-Source": "archive"})
    raise HTTPException(status_code=404, detail="该 unknown 档无可试听音频")


@router.get("/unknown/{unk_id}/sample/{idx}")
async def get_unknown_sample(unk_id: str, idx: int,
                             background_tasks: BackgroundTasks = None):
    """试听 unknown 簇的第 idx 个样本文件(与列表 samples[].idx 对应)。"""
    return await get_unknown_audio(unk_id, file_idx=idx,
                                   background_tasks=background_tasks)


@router.get("/unknown/{unk_id}/archive/{wav_name}")
async def get_unknown_archive_wav(unk_id: str, wav_name: str):
    """直读 unknown 归档会话音频(新链路建档样本, unknown_audio/{unk_id}/)。"""
    if not _safe_filename(unk_id):
        raise HTTPException(status_code=400, detail="非法 unk_id")
    if not _safe_filename(wav_name) or not wav_name.endswith((".wav", ".flac")):
        raise HTTPException(status_code=400, detail="非法文件名")
    arch_dir = os.path.join(_data_dir(), "cache", "unknown_audio", unk_id)
    p = os.path.join(arch_dir, wav_name)
    if not os.path.isfile(p):
        raise HTTPException(status_code=404, detail="归档音频不存在")
    media = "audio/flac" if wav_name.lower().endswith(".flac") else "audio/wav"
    return FileResponse(p, media_type=media,
                        headers={"X-Source": "archive", "X-Unk": unk_id})


# ─── 4. 注册声纹库 ───────────────────────────────────────

def _voice_audio_path(speaker_id: str):
    """注册音频规范文件定位（T5 flac 兼容: 按 .wav/.flac 双后缀探测）。"""
    for ext in (".wav", ".flac"):
        cand = os.path.join(_data_dir(), "voice", f"{speaker_id}{ext}")
        if os.path.isfile(cand):
            return cand
    return None


@router.get("/voices")
async def list_voices():
    """注册声纹概览（V10: 数据源 = 内核 GET /v1/voiceprint/registry 元数据快照）。

    响应键集与外层镜像时代逐键一致（status/version/updated_at/model/
    speakers/centroids；speakers 条目 8 键、centroids 条目 3 键）：
    - centroids 展示块由快照条目按 name 分组派生（n_samples=该名字册数,
      method=l2_norm_mean）；质心向量恒在内核内构建，§5 红线永不外带。
    - audio_url 按外层规范文件 DATA_DIR/voice/{id}(.wav/.flac) 存在性给出
      （注册音频位置归外层 _save_enroll_audio，不依赖镜像 audio_path）。
    - 内核不可达 -> 503（vaudit 惯例，绝不回退读冻结镜像文件）。
    """
    try:
        facts = _cohort_kernel_get("/v1/voiceprint/registry", {})
    except Exception as e:
        raise _cohort_kernel_error(e, what="声纹库")

    entries = [s for s in (facts.get("speakers") or []) if isinstance(s, dict)]
    speakers = []
    n_by_name: dict = {}
    for spk in entries:
        sid = spk.get("speaker_id", "")
        n_by_name[spk.get("name") or "unknown"] = \
            n_by_name.get(spk.get("name") or "unknown", 0) + 1
        has_audio = bool(sid and _voice_audio_path(sid))
        audio_url = f"/api/vaudit/voice/{sid}/audio" if has_audio else None
        speakers.append({
            "speaker_id": sid,
            "name": spk.get("name"),
            "remark": spk.get("remark"),
            "created_at": spk.get("created_at"),
            "snr": spk.get("snr"),
            "speech_ratio": spk.get("speech_ratio"),
            "duration_sec": spk.get("duration_sec"),
            "audio_url": audio_url,
        })
    centroids = [{"name": name, "n_samples": n, "method": "l2_norm_mean"}
                 for name, n in n_by_name.items()]
    created = [s["created_at"] for s in entries if s.get("created_at")]
    return {"status": "ok", "version": 4,
            "updated_at": max(created) if created else None,
            "model": "eres2netv2(kernel)",
            "speakers": speakers, "centroids": centroids}


@router.get("/voice/{speaker_id}/audio")
async def get_voice_audio(speaker_id: str):
    """返回注册声纹音频（文件位置归外层 DATA_DIR/voice/{id}, 与 GET
    /api/screen/speakers/{id}/audio 同源；镜像 audio_path 已随 V10 退役，
    音频文件源不变）。T5 flac 兼容: 按扩展名分流 MIME, 不硬编码。"""
    if not _safe_filename(speaker_id):
        raise HTTPException(status_code=400, detail="非法 speaker_id")
    path = _voice_audio_path(speaker_id)
    if not path:
        raise HTTPException(status_code=404, detail="该声纹无音频")
    media = "audio/flac" if path.lower().endswith(".flac") else "audio/wav"
    return FileResponse(path, media_type=media,
                        filename=os.path.basename(path))


# ─── 5. 测试工具: 通用裁剪 ───────────────────────────────


class CropRequest(BaseModel):
    date: str = Field(..., description="YYYY-MM-DD")
    file: str = Field(..., description="audio 文件名, 如 000048_default.wav")
    start: float = Field(0.0, ge=0, description="起始秒")
    end: float = Field(60.0, gt=0, description="结束秒")


@router.post("/crop")
async def crop_audio(req: CropRequest, background_tasks: BackgroundTasks = None):
    """通用裁剪测试: 对指定日期某音频文件裁剪 [start,end] 返回 mp3。

    P1-V4 收敛: 函数体不再复制 _serve_crop 逻辑, 直接复用共享实现;
    CropRequest 的 pydantic 校验面(start>=0/end>0 越界 422)与
    下载文件名(与 GET 的差异形状)保持现状不变。
    """
    return _serve_crop(req.date, req.file, req.start, req.end, background_tasks,
                       download_name=f"crop_{req.date}_{req.file}_{req.start}-{req.end}.mp3")
