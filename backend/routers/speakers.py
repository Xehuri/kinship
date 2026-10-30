"""
声纹管理路由 — Speaker Registration & Identification API

K2 起注册/识别/清单/删除全部经内核（docs/kernel-design.md §4.6/§7 stage-2）：
- POST /api/screen/speakers/enroll — 注册声纹（外层 ffmpeg 解码 + AAC 通道模拟，
  音频经 audio_b64 送内核 /v1/voiceprint/enroll；成功后外层另存注册音频文件）
- GET  /api/screen/speakers — 列出所有已注册声纹（内核 GET /v1/voiceprint/speakers）
- DELETE /api/screen/speakers/{speaker_id} — 删除声纹（内核 DELETE /v1/voiceprint/speakers/{id}）
- POST /api/screen/speakers/identify — 识别音频中的说话人
- GET  /api/screen/speakers/{speaker_id}/audio — 注册音频文件（外层 DATA_DIR/voice/）

内核不可达 -> 503 {"error":{"code":"state.unavailable",...}}（封闭码，不崩外层）。
注册音频文件位置归外层：DATA_DIR/voice/{speaker_id}.wav（内核只持有向量/注册表）。
"""

import os
import asyncio
import base64
import tempfile
import logging
from typing import Optional, List
from fastapi import APIRouter, HTTPException, UploadFile, File, Form, Query
from fastapi.responses import FileResponse

from services import kernel_client
from services.kernel_client import (
    HEAVY_TIMEOUT,
    KernelHttpError,
    KernelUnavailable,
)
from services.audio_codec import ffmpeg_path
from services.audio_config import get_audio_config
from core.errors import kernel_http_response, kernel_unavailable_response

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/screen/speakers", tags=["speakers"])

# 注册音频文件目录（外层业务文件，位置归外层）
_VOICE_AUDIO_DIR_NAME = "voice"


def _voice_audio_dir() -> str:
    from config.config import get_config
    return os.path.join(get_config().DATA_DIR, _VOICE_AUDIO_DIR_NAME)


async def _decode_upload_to_wav(file: UploadFile) -> str:
    """上传文件落临时路径 + 非 WAV ffmpeg 解码 + AAC 通道模拟（外层媒体处理）。

    返回最终 WAV 临时路径；调用方负责 finally 清理。
    """
    ext = os.path.splitext(file.filename or "audio.wav")[1] or ".wav"
    suffix = ext if ext.startswith(".") else f".{ext}"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name

    _FFMPEG = ffmpeg_path()

    # 非 WAV 用 ffmpeg 解码（兼容 AAC/MP3 等）
    if ext.lower() not in ('.wav', '.wave') and os.path.exists(_FFMPEG):
        import subprocess
        wav_path = tmp_path + '.wav'
        try:
            subprocess.run(
                [_FFMPEG, '-y', '-i', tmp_path,
                 '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', wav_path],
                capture_output=True, timeout=30, check=True
            )
            os.unlink(tmp_path)
            tmp_path = wav_path
        except Exception as e:
            logger.warning(f"[Speakers] ffmpeg 解码失败，回退原始文件: {e}")

    # AAC 通道模拟：编码 AAC 64kbps → 解码回 WAV（与 DataCollector 链路对齐）
    if os.path.exists(_FFMPEG):
        import subprocess
        aac_path = tmp_path + '.aac'
        aac_wav_path = tmp_path + '_aac.wav'
        try:
            subprocess.run(
                [_FFMPEG, '-y', '-i', tmp_path,
                 '-c:a', 'aac', '-b:a', '64k', '-ar', '16000', '-ac', '1', aac_path],
                capture_output=True, timeout=30, check=True
            )
            subprocess.run(
                [_FFMPEG, '-y', '-i', aac_path,
                 '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', aac_wav_path],
                capture_output=True, timeout=30, check=True
            )
            os.unlink(aac_path)
            os.unlink(tmp_path)
            tmp_path = aac_wav_path
        except Exception as e:
            logger.warning(f"[Speakers] AAC 编码失败，回退原始 WAV: {e}")
            if os.path.exists(aac_path):
                os.unlink(aac_path)
            if os.path.exists(aac_wav_path):
                os.unlink(aac_wav_path)
    return tmp_path


def _read_wav_b64(tmp_path: str) -> str:
    with open(tmp_path, "rb") as f:
        return base64.b64encode(f.read()).decode("ascii")


def _save_enroll_audio(speaker_id: str, tmp_path: str) -> None:
    """注册成功后外层持久化注册音频（位置归外层，失败不阻断注册结果）。"""
    try:
        import shutil
        target_dir = _voice_audio_dir()
        os.makedirs(target_dir, exist_ok=True)
        shutil.copy2(tmp_path, os.path.join(target_dir, f"{speaker_id}.wav"))
    except Exception as e:
        logger.warning(f"[Speakers] 保存注册音频失败: {e}")


@router.post("/enroll")
async def enroll_speaker(
    file: UploadFile = File(...),
    name: str = Form(..., description="说话人姓名"),
    remark: Optional[str] = Form(None, description='备注（如客厅环境等）'),
    scene_tag: Optional[str] = Form(None, description='场景标注（L4 多锚点，如宿舍/教室/家里，可空）'),
):
    """
    注册声纹。

    上传一段清晰语音（3-10 秒），外层完成媒体解码后送内核提取声纹并落注册表。
    支持格式: wav/mp3/m4a/ogg/webm。

    L4 多锚点: 同一 name 用不同 scene_tag 多次注册 → 每个人多个场景锚点，
    识别时与任一锚点匹配即判定为该人（解决跨场景漂移）。
    """
    if not file.filename:
        raise HTTPException(status_code=400, detail="未选择文件")

    if not name or not name.strip():
        raise HTTPException(status_code=400, detail="姓名不能为空")

    tmp_path = None
    try:
        tmp_path = await _decode_upload_to_wav(file)
        audio_b64 = _read_wav_b64(tmp_path)

        result = await kernel_client.get_kernel_client().arequest(
            "POST",
            "/v1/voiceprint/enroll",
            json={
                "name": name.strip(),
                "audio_b64": audio_b64,
                "remark": remark or "",
                "scene_tag": scene_tag or "",
            },
            timeout=HEAVY_TIMEOUT,
        )
        facts = (result or {}).get("facts") or {}

        if not facts.get("enrolled"):
            reason = facts.get("reason", "")
            if reason == "missing_input":
                raise HTTPException(status_code=400, detail="声纹注册失败: 输入不完整")
            raise HTTPException(
                status_code=500,
                detail="声纹注册失败（内核未完成注册: %s）" % (reason or "unknown"),
            )

        speaker_id = str(facts.get("speaker_id") or "")
        # 注册音频文件位置归外层（内核只持有向量）
        if speaker_id:
            _save_enroll_audio(speaker_id, tmp_path)

        # V10（2026-10-08）：内核注册库为唯一真相源，外层 v4 镜像已退役——
        # 原 K4c 双写的镜像同步调用随镜像一并删除，分裂脑在结构上不可能再
        # 发生（读方全部走内核 HTTP 面：清单/计数/注册库快照）。

        speaker = {
            "speaker_id": speaker_id,
            "name": facts.get("name") or name,
            "remark": facts.get("remark") or remark or "",
            "scene_tag": facts.get("scene_tag") or scene_tag or "",
            "created_at": facts.get("created_at") or "",
            "embedding_dim": facts.get("embedding_dim") or 0,
            "segments_used": facts.get("segments_used") or 0,
            "duration_ms": facts.get("duration_ms") or 0,
        }
        return {
            "status": "ok",
            "message": f"声纹注册成功: {name}",
            "speaker": speaker,
            "quality_report": {},
        }

    except KernelUnavailable as e:
        logger.error(f"[Speakers] 注册失败（内核不可达）: {e}")
        return kernel_unavailable_response(e)
    except KernelHttpError as e:
        # 内核封闭错误码透传（如 model.unavailable -> 503）
        if e.status == 400:
            raise HTTPException(status_code=400, detail=f"声纹注册被拒绝: {e}")
        logger.error(f"[Speakers] 注册失败（内核错误）: {e}")
        return kernel_http_response(e)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[Speakers] 注册失败: {e}")
        raise HTTPException(status_code=500, detail=f"声纹注册失败: {str(e)}")
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


@router.get("")
async def list_speakers():
    """列出所有已注册声纹（内核注册表为唯一事实源）。"""
    try:
        result = await kernel_client.get_kernel_client().arequest(
            "GET", "/v1/voiceprint/speakers"
        )
    except KernelUnavailable as e:
        logger.error(f"[Speakers] 清单失败（内核不可达）: {e}")
        return kernel_unavailable_response(e)
    except KernelHttpError as e:
        return kernel_http_response(e)
    facts = (result or {}).get("facts") or {}
    speakers = facts.get("speakers") or []
    return {
        "status": "ok",
        "count": facts.get("count", len(speakers)),
        "speakers": speakers,
    }


@router.get("/{speaker_id}/audio")
async def get_speaker_audio(speaker_id: str):
    """获取注册声纹的音频文件（文件位置归外层 DATA_DIR/voice/）。"""
    audio_path = os.path.join(_voice_audio_dir(), f"{speaker_id}.wav")
    if not os.path.isfile(audio_path):
        raise HTTPException(status_code=404, detail="声纹音频不存在")
    return FileResponse(audio_path, media_type="audio/wav",
                        filename=f"{speaker_id}.wav")


@router.delete("/{speaker_id}")
async def delete_speaker(speaker_id: str):
    """删除声纹（内核注册表；缺席 id -> 404）。"""
    try:
        await kernel_client.get_kernel_client().arequest(
            "DELETE", f"/v1/voiceprint/speakers/{speaker_id}"
        )
    except KernelUnavailable as e:
        logger.error(f"[Speakers] 删除失败（内核不可达）: {e}")
        return kernel_unavailable_response(e)
    except KernelHttpError as e:
        if e.status == 404:
            raise HTTPException(status_code=404, detail="声纹不存在")
        return kernel_http_response(e)
    return {"status": "ok", "message": "声纹已删除"}


@router.post("/identify")
async def identify_speaker(
    file: UploadFile = File(...),
    threshold: float = Form(
        get_audio_config()["voiceprint"]["identify_threshold"],
        description="相似度阈值 (0-1)",
    ),
    top_k: int = Form(3, description="返回前 N 个匹配"),
):
    """
    识别音频中的说话人（内核打分）。

    返回相似度 >= threshold 的匹配结果（按相似度降序）。
    """
    if not file.filename:
        raise HTTPException(status_code=400, detail="未选择文件")

    tmp_path = None
    try:
        tmp_path = await _decode_upload_to_wav(file)
        audio_b64 = _read_wav_b64(tmp_path)

        result = await kernel_client.get_kernel_client().arequest(
            "POST",
            "/v1/voiceprint/identify",
            json={
                "audio_b64": audio_b64,
                "threshold": threshold,
                "top_k": max(int(top_k), 1),
            },
            timeout=HEAVY_TIMEOUT,
        )
        facts = (result or {}).get("facts") or {}
        # 内核 candidates 不做阈值过滤 -> 外层沿用旧契约：只回 >= threshold 的匹配
        candidates = facts.get("candidates") or []
        matches = [
            c for c in candidates
            if isinstance(c, dict)
            and (c.get("similarity") is not None)
            and float(c["similarity"]) >= threshold
        ][: max(int(top_k), 1)]
        return {
            "status": "ok",
            "count": len(matches),
            "matches": matches,
        }

    except KernelUnavailable as e:
        logger.error(f"[Speakers] 识别失败（内核不可达）: {e}")
        return kernel_unavailable_response(e)
    except KernelHttpError as e:
        if e.status == 503:
            raise HTTPException(status_code=503, detail="声纹模型未加载")
        return kernel_http_response(e)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[Speakers] 识别失败: {e}")
        raise HTTPException(status_code=500, detail=f"声纹识别失败: {str(e)}")
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
