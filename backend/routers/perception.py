# -*- coding: utf-8 -*-
"""
感知数据接收路由

手机 App (DataCollectorService) 通过此模块上报感知事件和音频数据。
感知事件写入 ai/data/daily/{date}/perception.jsonl，供 AI 分析系统消费。
"""

from typing import Optional, Dict, Any, List, TYPE_CHECKING
from fastapi import APIRouter, UploadFile, File, Form
from pydantic import BaseModel, Field
import logging

from core.redaction import redact_text

if TYPE_CHECKING:  # 仅用于类型标注，避免运行时导入开销
    from services.audio_ingest_session import EmittedChunk

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/screen/stt", tags=["perception"])


class PerceptionEventRequest(BaseModel):
    """感知事件独立上报"""
    type: str = Field(..., description="事件类型: notify/app/media/sensor/screen/input/device_env/heartbeat")
    payload: Dict[str, Any] = Field(..., description="事件数据")
    ts: Optional[str] = Field(None, description="事件时间，不传用 now")


@router.post("/perception-event")
async def perception_event(req: PerceptionEventRequest):
    """
    感知事件独立上报。
    App 在事件发生时立即调用，不等采集周期。
    """
    from services.perception_store import append_perception
    from datetime import datetime, timezone, timedelta
    try:
        ts = req.ts or datetime.now(timezone(timedelta(hours=8))).strftime("%H:%M:%S")

        # 通知事件唯一主写 perception.jsonl。脱敏由 App 侧 notify_blocklist 在上报前
        # 完成（NotificationCollector：黑名单包只上报 {package, ts, redacted:true}）。
        # 服务端曾有按 key 去重的 sidecar 副本存储（"写两份读零份"，生产零读取），
        # 2026-10-08 P0-U5 移除双写与脱敏调用。
        payload = req.payload

        entry = {"type": req.type, "t": ts}
        entry.update(payload)
        append_perception(entry, auto_type=False)

        payload_keys = sorted(str(key) for key in payload)[:12]
        logger.info(
            "[PerceptionEvent] type=%s ts=%s fields=%d keys=%s",
            req.type,
            ts,
            len(payload),
            ",".join(payload_keys),
        )

        return {"status": "ok", "type": req.type}
    except Exception as e:
        safe_error = redact_text(str(e))
        logger.error("[PerceptionEvent] 处理失败: %s", safe_error)
        return {"status": "error", "message": safe_error}


@router.post("/voice-session-multipart")
async def voice_session_multipart(
    file: UploadFile = File(None),
    client_time: str = Form(""),
    mode: str = Form("listen"),
    device_name: str = Form(""),
    device_id: str = Form(""),
    session_id: str = Form(""),
    seq: int = Form(-1),
    start_wall_ms: int = Form(-1),
):
    """
    接收手机端语音数据和感知上下文（multipart/form-data 格式）。

    device_id / session_id / seq 为可选的连续性标识（App 尚未上报时留空/-1）：
    用于把分段落到同一设备时间轴并做去重。本端点固定走"无缝流"入口：
    services.audio_ingest_registry 对每个设备维护一条虚拟连续流，时间连续
    （B.start_ms <= A.end_ms + 容差）的分段被追加到同一条流上，只在流的静音
    端点或硬上限处切分，合并后的 PCM 作为单个输入再交给分析链路。

    start_wall_ms: 选填的毫秒级起始墙钟时间（App 从 cacheJson 原样回传）。
        优先于秒级精度的 client_time 字符串，避免跨段裁剪因毫秒截断多裁真实音频。
        缺失（-1）时才回退解析 client_time。
    """
    audio_base64 = None
    if file and file.filename:
        try:
            audio_bytes = await file.read()
            if audio_bytes:
                import base64
                audio_base64 = base64.b64encode(audio_bytes).decode("utf-8")
        except Exception as e:
            logger.warning("[VoiceSession] 读取上传文件失败: %s", redact_text(str(e)))

    return await _handle_voice_session(
        audio_base64,
        client_time,
        device_name=device_name,
        origin="upload",
        device_id=device_id,
        session_id=session_id,
        seq=seq,
        client_start_ms=(start_wall_ms if start_wall_ms >= 0 else None),
    )


def _parse_client_time(value: Optional[str]):
    """解析客户端上报的时间。

    - multipart 路径的 ``client_time`` 为 ISO8601（带时区），如 2026-09-15T14:54:21+08:00
    - 兼容旧 JSON 路径遗留的 ``HH:MM:SS`` 形式（宽容解析保留，无害）
    - 无时区信息按东八区解释；无法解析返回 None（落盘回退为服务器当前时间）
    """
    if not value:
        return None
    from datetime import datetime, timezone, timedelta

    raw = value.strip()
    try:
        dt = datetime.fromisoformat(raw)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone(timedelta(hours=8)))
        return dt
    except ValueError:
        pass
    try:
        t = datetime.strptime(raw, "%H:%M:%S").time()
        today = datetime.now(timezone(timedelta(hours=8))).date()
        return datetime.combine(today, t, tzinfo=timezone(timedelta(hours=8)))
    except ValueError:
        return None


def _resolve_start(client_start_ms: Optional[int], value: Optional[str]):
    """解析音频起始时间，返回 ``(start_dt, start_ms)``。

    优先使用客户端显式上报的 ``start_wall_ms``（毫秒精度，契约明确、不受字符串
    格式影响）；缺失时才回退解析 ``client_time``/``ts`` 字符串（秒级精度，最多
    引入约 1s 的截断误差，会让跨段裁剪多裁真实新音频）。

    两者都不可用时返回 ``(None, None)``，由调用方回退服务器当前时间。
    """
    from datetime import datetime, timezone, timedelta

    if client_start_ms is not None and int(client_start_ms) >= 0:
        ms = int(client_start_ms)
        return (
            datetime.fromtimestamp(ms / 1000.0, tz=timezone(timedelta(hours=8))),
            ms,
        )
    dt = _parse_client_time(value)
    if dt is None:
        return None, None
    return dt, int(dt.timestamp() * 1000)


def _wav_duration_ms(wav_bytes: bytes) -> int:
    """从 WAV/FLAC 字节流解析时长（毫秒）——格式由 magic 嗅探，不信任扩展名。

    WAV 走 wave 模块；FLAC 走 soundfile（禁 len/32 数学——压缩流字节数≠时长）。
    解析失败时仅对 WAV 按 16kHz/16bit/单声道（32000 字节/秒）回退推算
    （与手机端 AudioCollector 采集参数一致）；FLAC 失败返回 0。
    """
    if not wav_bytes:
        return 0
    from services.audio_ingest_session import sniff_audio_fmt

    fmt = sniff_audio_fmt(wav_bytes)
    if fmt == "flac":
        try:
            import io
            import soundfile as sf

            with sf.SoundFile(io.BytesIO(wav_bytes)) as f:
                if f.samplerate > 0:
                    return int(f.frames * 1000 / f.samplerate)
        except Exception:
            pass
        return 0
    try:
        import io
        import wave

        with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
            rate = wf.getframerate()
            if rate > 0:
                return int(wf.getnframes() * 1000 / rate)
    except Exception:
        pass
    return int(len(wav_bytes) / 32)


async def _handle_voice_session(audio: Optional[str], ts: Optional[str],
                                device_name: str = "", origin: str = "upload",
                                device_id: str = "",
                                session_id: str = "", seq: int = -1,
                                client_start_ms: Optional[int] = None) -> Dict[str, Any]:
    """语音会话处理核心逻辑（multipart 专用；JSON 版 /voice-session 端点已移除，
    其 text 直写分支与 text/拼接开关形参已随 P0-U5 补验一并清除）

    origin: 音频来源标记，默认 "upload"；由调用方显式透传到分析链路，
        用于区分上传音频与流式音频（后者不写感知增量数据）。
    本函数恒走"流式仿真"连续性入口（原非拼接回退分支随 JSON 端点删除后
        恒不可达，开关形参已内联为恒真）：音频按设备绝对时间轴喂入连续性
        会话，跨文件拼接出语义完整的 chunk 再交给分析链路，避免固定切分把
        一句话截断在两个文件里。
    device_id / session_id / seq: 连续性标识（App 可选上报），用于会话归属与去重。
    client_start_ms: 客户端上报的毫秒级起始墙钟时间（multipart 的 start_wall_ms），
        优先于字符串解析；缺失时回退 ``ts``/``client_time`` 解析。
    """
    from services.perception_store import save_audio
    from datetime import datetime, timezone, timedelta
    import base64
    import asyncio
    import os

    try:
        # 客户端时间优先：毫秒级的 start_wall_ms 优先，其次 multipart 的 client_time
        # （ISO8601 带时区）。解析成功即用它推算音频真实起止时间——
        # save_audio 据此决定日期目录与文件名，避免沿用服务器当前时间导致跨零点写错
        # 日期、与流式块时间轴错位；精确到毫秒还能避免跨段裁剪多裁真实音频。
        start_dt, start_ms = _resolve_start(client_start_ms, ts)
        ts_val = (start_dt or datetime.now(timezone(timedelta(hours=8)))).strftime("%H:%M:%S")

        # 如果有音频数据（Base64），保存到文件
        audio_path = None
        audio_size_kb = 0
        ingested = False
        if audio:
            try:
                audio_bytes = base64.b64decode(audio)
                audio_size_kb = len(audio_bytes) // 1024
                end_ms = (
                    start_ms + _wav_duration_ms(audio_bytes)
                    if start_ms is not None
                    else None
                )
                # T2: magic 嗅探真实格式（RIFF+WAVE / fLaC），不信任 Content-Type
                from services.audio_ingest_session import sniff_audio_fmt
                from services.audio_config import get_upload_ext

                sniffed_fmt = sniff_audio_fmt(audio_bytes)
                # 嗅探未知回退 audio.store.upload_ext（默认 wav，非法值 loader 已归一）
                save_ext = sniffed_fmt if sniffed_fmt in ("wav", "flac") else get_upload_ext()
                # 无缝流入口：multipart 分段交由连续性会话，按设备绝对时间轴
                # 累积为一条虚拟连续流做跨文件合并。
                # 接管成功后不再对原始分段单独落盘/分析（避免固定切分截断与重复分析），
                # 完整 chunk 由 _dispatch_stitched_chunks 统一落盘并触发分析。
                if origin == "upload" and sniffed_fmt != "unknown":
                    ingested = _ingest_continuity(
                        audio_bytes=audio_bytes,
                        start_ms=start_ms,
                        device_name=device_name,
                        device_id=device_id,
                        session_id=session_id,
                        seq=seq,
                        fmt=save_ext,
                    )
                if not ingested:
                    # 既有路径（连续性不接管 / 格式不兼容时回退）：原样保存并独立分析
                    path = save_audio(
                        audio_data=audio_bytes,
                        device_id=(device_name or None),
                        start_ms=start_ms,
                        end_ms=end_ms,
                        ext=save_ext,
                    )
                    if path:
                        audio_path = path
            except Exception as e:
                logger.warning("[VoiceSession] 保存音频失败: %s", redact_text(str(e)))

        logger.debug(f"[VoiceSession] ts={ts_val} audio={audio_size_kb}KB")

        # 后台启动音频感知分析（不阻塞响应）
        if audio_path:
            from config.config import get_config
            abs_audio_path = os.path.join(get_config().DATA_DIR, audio_path)
            _trigger_audio_analysis(abs_audio_path, ts_val, device_name=device_name, origin=origin)

        return {
            "status": "ok",
            "audio_saved": bool(audio_path) or ingested,
        }
    except Exception as e:
        safe_error = redact_text(str(e))
        logger.error("[VoiceSession] 处理失败: %s", safe_error)
        return {"status": "error", "message": safe_error}


def _ingest_continuity(
    *,
    audio_bytes: bytes,
    start_ms: Optional[int],
    device_name: str,
    device_id: str,
    session_id: str,
    seq: int,
    fmt: str = "wav",
) -> bool:
    """把一段上传音频喂入跨文件连续性会话；成功接管返回 True。

    仅在音频为标准 16kHz/单声道/16bit（WAV 或 FLAC，统一解码到 PCM）且带
    绝对起始时间时接管，否则返回 False，由调用方回退既有独立分析路径
    （绝不误切分）。
    """
    if start_ms is None:
        # 无绝对时间无法落到时间轴，回退既有路径
        return False

    from services.audio_ingest_session import decode_audio_pcm

    decoded = decode_audio_pcm(audio_bytes)
    if decoded is None:
        logger.info("[VoiceSession] 音频无法解码为 PCM（WAV/FLAC），回退独立分析")
        return False
    pcm, rate, channels, width = decoded
    if (rate, channels, width) != (16000, 1, 2):
        logger.info(
            f"[VoiceSession] 音频格式 {rate}Hz/{channels}ch/{width * 8}bit "
            f"非 16k 单声道 16bit，回退独立分析"
        )
        return False
    if not pcm:
        return False

    from services.audio_ingest_registry import get_audio_ingest_registry

    registry = get_audio_ingest_registry()
    if not registry.stitch_enabled:
        return False

    device_key = device_id or device_name or "default"
    outcome = registry.ingest(
        device_key,
        device_name=device_name or device_key,
        session_id=session_id,
        seq=seq,
        start_ms=start_ms,
        pcm=pcm,
        fmt=fmt,
    )
    _dispatch_stitched_chunks(device_key, outcome.emitted)

    # 顺带冲刷各设备因空闲超时需产出的尾部残片；命中即派发。
    for swept_device, swept_chunks in registry.sweep().items():
        _dispatch_stitched_chunks(swept_device, swept_chunks)
    return True


def _dispatch_stitched_chunks(device_id: str, chunks: "List[EmittedChunk]") -> None:
    """把连续性会话产出的完整 chunk 落盘并触达分析链路（origin="upload"）。

    产出块已是原始 PCM（16kHz/单声道/16bit），按 chunk.fmt（上传格式）
    封装为 WAV/FLAC 并按绝对 start_ms 落 daily/{date}/audio，随后交给既有
    分析链路做 ASR/声纹等处理（分析侧经 _ensure_wav 旁路兼容两种格式）。
    """
    if not chunks:
        return

    from services.audio_ingest_session import encode_audio_bytes
    from services.perception_store import save_audio
    from config.config import get_config
    from datetime import datetime, timezone, timedelta
    import os

    data_dir = get_config().DATA_DIR
    for chunk in chunks:
        try:
            chunk_fmt = chunk.fmt if chunk.fmt in ("wav", "flac") else "wav"
            audio_bytes = encode_audio_bytes(chunk.pcm, fmt=chunk_fmt)
            rel_path = save_audio(
                audio_data=audio_bytes,
                device_id=(chunk.device_id or device_id),
                start_ms=chunk.start_ms,
                end_ms=chunk.end_ms,
                origin="upload",
                ext=chunk_fmt,
            )
            if not rel_path:
                continue
            abs_path = os.path.join(data_dir, rel_path)
            ts_val = datetime.fromtimestamp(
                chunk.start_ms / 1000.0, tz=timezone(timedelta(hours=8))
            ).strftime("%H:%M:%S")
            _trigger_audio_analysis(
                abs_path,
                ts_val,
                device_name=(chunk.device_name or device_id),
                start_epoch_ms=chunk.start_ms,
                origin="upload",
            )
        except Exception as e:
            logger.warning("[VoiceSession] 拼接块派发失败: %s", redact_text(str(e)))


def _on_registry_sweep(device_id: str, chunks: "List[EmittedChunk]") -> None:
    """注册表空闲冲刷回调：把超时残片派发到分析链路。

    P3-V17（2026-10-08）：本回调的接线从「模块 import 副作用」迁至 main.py
    lifespan（get_audio_ingest_registry().set_sweep_sink(this)）。函数本体
    不依赖单例，平迁保留在路由模块内——派发语义与上传路径同源
    （_dispatch_stitched_chunks）。multipart 上传一旦停止，最后一个尾部残片
    只能靠注册表后台空闲冲刷产出，该回调由 lifespan 在单例创建后接线。
    """
    _dispatch_stitched_chunks(device_id, chunks)


def _trigger_audio_analysis(
    audio_path: str,
    ts_val: str,
    device_name: str = "",
    start_epoch_ms: Optional[int] = None,
    origin: str = "upload",
) -> None:
    """在后台线程中运行完整音频感知分析（薄包装）。

    真正的分析逻辑已抽取到 services.audio_analysis_pipeline.analyze_audio_file，
    供单 worker 音频分析队列直接同步调用。本函数仅保留向后兼容所需的：
      1. 同一文件 60 秒内的内存去重缓存；
      2. 后台线程启动（新队列路径不走此处，直接同步调用 analyze_audio_file）。

    Args:
        audio_path: 音频文件绝对路径
        ts_val: 文件记录时刻（旧端点由客户端上报）
        device_name: 设备名
        start_epoch_ms: 音频起始绝对时间（epoch 毫秒），旧端点无此值时为 None
        origin: 音频来源标记（"upload" | "stream"），默认 "upload"；透传到分析链路
    """
    import threading

    # 去重：同一文件 60 秒内只分析一次
    _analyzed_cache: set = getattr(_trigger_audio_analysis, "_cache", set())
    _trigger_audio_analysis._cache = _analyzed_cache
    if audio_path in _analyzed_cache:
        return
    _analyzed_cache.add(audio_path)
    # 60 秒后从缓存移除
    threading.Timer(60, lambda: _analyzed_cache.discard(audio_path)).start()

    def _run():
        # 懒导入：避免拖慢后端启动
        from services.audio_analysis_pipeline import analyze_audio_file
        analyze_audio_file(
            audio_path,
            start_epoch_ms,
            device_name=device_name,
            ts_val=ts_val,
            origin=origin,
        )

    # 后台线程启动音频感知分析(修复: 原线程启动被 voice_summary 模块化提取时误删,
    # 导致音频保存后永远不触发分析 — 2026-09-05)
    threading.Thread(target=_run, name="AudioAnalysis", daemon=True).start()

