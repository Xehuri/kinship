"""
TTS Router - TTS语音合成路由
"""
import asyncio
import base64
import logging
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from typing import Optional, Dict, Any

from services.tts_player import get_tts_player
from services.component_manager import component_manager
from services.device_channel_store import device_channel_store, get_tts_config
from core.redaction import redact_text

logger = logging.getLogger(__name__)

router = APIRouter(tags=["tts"])


def _fallback_client_types() -> list[str]:
    """回退目标连接类型（默认 ["web"]）"""
    try:
        types = get_tts_config().get("fallback_client_types") or ["web"]
    except Exception:  # noqa: BLE001 - 配置异常不应中断 TTS
        types = ["web"]
    if not isinstance(types, (list, tuple)) or not types:
        return ["web"]
    return [str(t) for t in types if str(t)]


async def _send_tts_message(user_id: Optional[str], message: Dict[str, Any]) -> int:
    """按设备路由发送单条 TTS 消息

    路由决策：
      1. DeviceChannelStore 命中（TTL 内）-> 只发该 (device_id, client_type)；
         设备离线则 send_to_device 返回 False，立即回退（不排队）。
      2. 未命中（过期 / 从未发送）-> 广播给 fallback_client_types（默认 web）。
      3. 回退也无目标在线 -> 静默丢弃（仅 debug 日志，不报错）。
    """
    resolved = device_channel_store.resolve(user_id) if user_id else None
    if resolved and user_id is not None:
        device_id, client_type = resolved
        if await component_manager.send_to_device(user_id, device_id, client_type, message):
            return 1
        logger.debug(
            "[TTS] 目标设备离线，立即回退: user=%s device=%s type=%s",
            user_id, device_id, client_type,
        )

    count = 0
    for ctype in _fallback_client_types():
        count += await component_manager.broadcast_to_type(message, ctype, user_id=user_id)
    if count == 0:
        logger.debug("[TTS] 无回退目标在线，静默丢弃: user=%s", user_id)
    return count


class TTSSpeakRequest(BaseModel):
    """TTS请求"""
    text: str
    voice: Optional[str] = None
    style: Optional[str] = None
    user_id: Optional[str] = None  # 目标用户ID，不传则广播
    send_audio: Optional[bool] = False  # 是否发送音频数据到前端


class TTSSynthesizeRequest(BaseModel):
    """TTS合成请求（仅合成，不播放）"""
    text: str
    voice: Optional[str] = None
    style: Optional[str] = None


class TTSSynthesizeResponse(BaseModel):
    """TTS合成响应"""
    status: str
    audio: Optional[str] = None  # Base64编码的音频数据
    error: Optional[str] = None


@router.post("/tts/speak")
async def tts_speak(tts_request: TTSSpeakRequest, fastapi_request: Request):
    """
    TTS语音合成并播放
    
    异步播放，立即返回，不等待播放完成
    如果send_audio=True，则广播音频数据到前端
    """
    # 优先取请求体中传入的user_id（AI工具可携带），否则从请求状态获取（AuthMiddleware注入）
    target_user_id = tts_request.user_id or (
        getattr(fastapi_request.state, 'user_id', None) if hasattr(fastapi_request, 'state') else None
    )
    
    player = get_tts_player()
    
    # 调试日志：打印收到的参数
    logger.info(
        "[TTS] 收到TTS请求: text_chars=%d, send_audio=%s",
        len(tts_request.text or ""),
        tts_request.send_audio,
    )
    
    if tts_request.send_audio:
        # 新模式：合成音频并发送到前端播放
        asyncio.create_task(synthesize_and_broadcast(
            player,
            tts_request.text,
            tts_request.voice,
            tts_request.style,
            target_user_id=target_user_id
        ))
    else:
        # 原有模式：本地播放
        # 通知前端TTS开始（按设备路由）
        await _send_tts_message(target_user_id, {
            "type": "tts_start",
            "text": tts_request.text if tts_request.text else ""
        })
        
        # 启动后台播放任务
        asyncio.create_task(play_tts_async(
            player, 
            tts_request.text, 
            tts_request.voice, 
            tts_request.style,
            target_user_id=target_user_id
        ))
    
    return {"status": "sent", "message": "TTS请求已发送"}


@router.post("/tts/synthesize", response_model=TTSSynthesizeResponse)
async def tts_synthesize(request: TTSSynthesizeRequest):
    """
    TTS合成（仅合成音频数据，不播放）
    
    返回Base64编码的WAV音频数据，供前端Web Audio API播放
    """
    player = get_tts_player()
    
    try:
        audio_bytes, error = await player.synthesize_to_bytes(
            text=request.text,
            voice=request.voice,
            style=request.style
        )
        
        if error:
            return TTSSynthesizeResponse(
                status="error",
                error=error
            )
        
        if audio_bytes:
            # 转换为Base64
            audio_base64 = base64.b64encode(audio_bytes).decode('utf-8')
            return TTSSynthesizeResponse(
                status="success",
                audio=audio_base64
            )
        else:
            return TTSSynthesizeResponse(
                status="error",
                error="音频合成失败"
            )
            
    except Exception as e:
        safe_error = redact_text(str(e))
        logger.error("TTS合成失败: %s", safe_error)
        return TTSSynthesizeResponse(
            status="error",
            error=safe_error
        )


async def synthesize_and_broadcast(player, text: str, voice: str = None, style: str = None, target_user_id: str = None):
    """合成完整文本为一段音频并按设备路由发送到前端（不再拆分句子，避免手机端音频叠加）"""
    try:
        logger.info(f"[TTS] 完整合成: 文本长度={len(text)}字")
        
        # 通知前端TTS开始（按设备路由）
        await _send_tts_message(target_user_id, {
            "type": "tts_start",
            "text": text if text else "",
            "chunk_total": 1,
            "stream": False
        })
        
        # 完整文本合成一次
        audio_bytes, error = await player.synthesize_to_bytes(
            text=text,
            voice=voice,
            style=style
        )
        
        if error:
            safe_error = redact_text(str(error))
            logger.error("[TTS] 合成失败: %s", safe_error)
            await _send_tts_message(target_user_id, {
                "type": "tts_error",
                "error": safe_error
            })
            return
        
        if audio_bytes:
            audio_base64 = base64.b64encode(audio_bytes).decode('utf-8')
            await _send_tts_message(target_user_id, {
                "type": "tts_audio",
                "text": text,
                "audio": audio_base64,
                "format": "wav"
            })
            logger.info(f"[TTS] 完整合成已发送: {len(audio_bytes)}字节")
        
        # 通知前端TTS结束
        await _send_tts_message(target_user_id, {"type": "tts_end"})
        logger.info("[TTS] 完整合成完成")
        
    except Exception as e:
        safe_error = redact_text(str(e))
        logger.error("[TTS] 完整合成失败: %s", safe_error)
        await _send_tts_message(target_user_id, {
            "type": "tts_error",
            "error": safe_error
        })


async def play_tts_async(player, text: str, voice: str = None, style: str = None, target_user_id: str = None):
    """后台播放TTS（原有本地播放模式；tts_end 按设备路由）"""
    try:
        success = await player.speak_async(
            text=text,
            voice=voice,
            style=style
        )
        
        # 通知前端TTS结束
        await _send_tts_message(target_user_id, {"type": "tts_end"})
        
    except Exception as e:
        safe_error = redact_text(str(e))
        logger.error("TTS播放失败: %s", safe_error)
        await _send_tts_message(target_user_id, {
            "type": "tts_error",
            "error": safe_error
        })