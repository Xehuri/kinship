"""
TTS Player - TTS语音播放服务

功能：
- 调用MiMo TTS API生成语音
- 播放音频
- 支持打断
"""

import asyncio
import base64
import json
import logging
import os
import tempfile
import threading
import time
from typing import Optional, Callable
from dataclasses import dataclass
from pathlib import Path
from datetime import datetime

import aiohttp

logger = logging.getLogger(__name__)

# MiMo API配置
MIMO_API_BASE = "https://token-plan-cn.xiaomimimo.com/v1"

# 默认音色
DEFAULT_VOICE = "mimo_default"
DEFAULT_STYLE = None  # 可选：开心、悲伤、东北话等

# 音色映射（AI可能请求旧名称，映射到可用的音色）
_VOICE_MAP = {
    "xiaoyi": "mimo_default",
    "xiaoyun": "default_zh",
    "xiaogang": "default_zh",
    "zhimi": "default_zh",
    "azure": "default_zh",
    "default": "mimo_default",
}

def _map_voice(voice: str) -> str:
    """映射音色名称到API支持的音色"""
    if voice in ("mimo_default", "default_zh", "default_en"):
        return voice
    return _VOICE_MAP.get(voice.lower(), DEFAULT_VOICE)


@dataclass
class TTSConfig:
    """TTS配置"""
    voice: str = DEFAULT_VOICE
    style: Optional[str] = DEFAULT_STYLE
    format: str = "wav"


class TTSPlayer:
    """TTS播放器"""
    
    def __init__(self, api_key: Optional[str] = None):
        from config.config import get_config
        _cfg = get_config()
        self.api_key = api_key or os.environ.get("MIMO_API_KEY") or _cfg.MIMO_API_KEY
        self.is_playing = False
        self._stop_flag = False
        self._current_process = None
        self._play_thread: Optional[threading.Thread] = None
        
        # 回调
        self._on_play_start: Optional[Callable[[], None]] = None
        self._on_play_end: Optional[Callable[[], None]] = None
        self._on_stop: Optional[Callable[[], None]] = None
        
    def on_play_start(self, callback: Callable[[], None]):
        """设置播放开始回调"""
        self._on_play_start = callback
        
    def on_play_end(self, callback: Callable[[], None]):
        """设置播放结束回调"""
        self._on_play_end = callback
        
    def on_stop(self, callback: Callable[[], None]):
        """设置停止回调"""
        self._on_stop = callback
    
    def _notify_vad_tts_state(self, is_playing: bool):
        """通知VAD服务TTS播放状态"""
        try:
            from services.vad_asr_service import get_vad_service
            vad_service = get_vad_service()
            if vad_service is not None:
                vad_service.set_tts_playing(is_playing)
                
                # TTS播放时停止唤醒词检测
                if is_playing:
                    # 停止自定义CNN唤醒词检测
                    if vad_service._custom_cnn_model:
                        vad_service._custom_cnn_model.pause()
                    logger.info("[TTS] 已暂停唤醒词检测")
                else:
                    # 恢复唤醒词检测
                    if vad_service._custom_cnn_model:
                        vad_service._custom_cnn_model.resume()
                    logger.info("[TTS] 已恢复唤醒词检测")
        except ImportError:
            pass  # VAD服务未加载时忽略
        
    async def synthesize(
        self,
        text: str,
        voice: Optional[str] = None,
        style: Optional[str] = None,
        output_file: Optional[str] = None
    ) -> tuple[Optional[bytes], Optional[str]]:
        """
        合成语音
        
        Args:
            text: 要合成的文本
            voice: 音色
            style: 风格
            output_file: 输出文件路径
            
        Returns:
            (音频字节, 错误消息) - 如果output_file为None则返回音频字节，否则返回文件路径
        """
        print(f"[TTS] synthesize called, api_key={bool(self.api_key)}")
        
        if not self.api_key:
            print("[TTS] ERROR: no API key")
            return None, "MiMo API Key未配置"
            
        # 添加风格标签
        tts_text = text
        if style:
            tts_text = f"<{style}>{text}"
            
        payload = {
            "model": "mimo-v2.5-tts",
            "messages": [
                {"role": "user", "content": "Please read the following text."},
                {"role": "assistant", "content": tts_text}
            ],
            "audio": {
                "format": "wav",
                "voice": _map_voice(voice or DEFAULT_VOICE)
            }
        }
        
        headers = {
            "api-key": self.api_key,
            "Content-Type": "application/json"
        }
        
        try:
            timeout = aiohttp.ClientTimeout(total=60)
            async with aiohttp.ClientSession(timeout=timeout) as client:
                async with client.post(
                    f"{MIMO_API_BASE}/chat/completions",
                    headers=headers,
                    json=payload
                ) as response:
                    if response.status != 200:
                        text = await response.text()
                        return None, f"TTS API错误: {response.status} - {text}"
                        
                    result = await response.json()
                    
                    if "choices" not in result or len(result["choices"]) == 0:
                        return None, "无音频数据返回"
                        
                    message = result["choices"][0]["message"]
                    audio_data = message.get("audio", {})
                    
                    if not audio_data or "data" not in audio_data:
                        return None, "响应中无音频数据"
                        
                    # 解码音频
                    audio_bytes = base64.b64decode(audio_data["data"])
                    
                    # 确定输出路径
                    if not output_file:
                        # 如果没有指定输出文件，直接返回音频字节
                        logger.info("TTS合成成功 (返回音频字节)")
                        return audio_bytes, None
                        
                    # 写入文件并返回文件路径
                    with open(output_file, "wb") as f:
                        f.write(audio_bytes)
                        
                    logger.info(f"TTS合成成功: {output_file}")
                    return output_file, None
                    
        except Exception as e:
            logger.error(f"TTS合成失败: {e}")
            return None, str(e)
    
    async def synthesize_to_bytes(
        self,
        text: str,
        voice: Optional[str] = None,
        style: Optional[str] = None
    ) -> tuple[Optional[bytes], Optional[str]]:
        """
        合成语音并返回音频字节数据（不保存文件，不播放）
        
        用于WebSocket传输音频数据到前端播放
        
        Args:
            text: 要合成的文本
            voice: 音色
            style: 风格
            
        Returns:
            (音频字节, 错误消息)
        """
        return await self.synthesize(text, voice, style, output_file=None)
    
    def play_audio(self, file_path: str) -> bool:
        """
        播放音频文件（同步）
        
        使用系统播放器播放
        """
        import subprocess
        
        print(f"[TTS] play_audio called: {file_path}")
        print(f"[TTS] file exists: {os.path.exists(file_path)}")
        
        if not os.path.exists(file_path):
            logger.error(f"音频文件不存在: {file_path}")
            print(f"[TTS] ERROR: file not found")
            return False
            
        self.is_playing = True
        self._stop_flag = False
        
        # 通知VAD服务TTS开始播放
        self._notify_vad_tts_state(True)
        
        if self._on_play_start:
            self._on_play_start()
            
        try:
            # Windows使用powershell播放
            if os.name == 'nt':
                cmd = [
                    'powershell', '-c',
                    f'(New-Object Media.SoundPlayer "{file_path}").PlaySync()'
                ]
            else:
                # Linux/Mac使用aplay或afplay
                if os.path.exists('/usr/bin/aplay'):
                    cmd = ['aplay', file_path]
                elif os.path.exists('/usr/bin/afplay'):
                    cmd = ['afplay', file_path]
                else:
                    logger.error("未找到音频播放器")
                    return False
                    
            self._current_process = subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL
            )
            
            # 等待播放完成或被打断
            while self._current_process.poll() is None:
                if self._stop_flag:
                    self._current_process.terminate()
                    break
                time.sleep(0.1)
                
        except Exception as e:
            logger.error(f"播放失败: {e}")
            return False
        finally:
            self.is_playing = False
            self._current_process = None
            
            # 通知VAD服务TTS播放结束
            self._notify_vad_tts_state(False)
            
            if self._stop_flag and self._on_stop:
                self._on_stop()
            elif self._on_play_end:
                self._on_play_end()
                
        return True
        
    def stop(self):
        """停止播放"""
        if self.is_playing:
            self._stop_flag = True
            if self._current_process:
                try:
                    self._current_process.terminate()
                except:
                    pass
            logger.info("TTS播放已停止")
            
    def speak(
        self,
        text: str,
        voice: Optional[str] = None,
        style: Optional[str] = None
    ) -> bool:
        """
        同步播放TTS（阻塞）
        """
        import tempfile
        import os
        from datetime import datetime
        
        # 合成（创建临时文件）
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        output_file = os.path.join(tempfile.gettempdir(), f"tts_{timestamp}.wav")
        
        file_path, error = asyncio.run(self.synthesize(text, voice, style, output_file))
        if error:
            logger.error(f"TTS合成失败: {error}")
            return False
            
        # 播放
        return self.play_audio(file_path)
    async def speak_async(
        self,
        text: str,
        voice: Optional[str] = None,
        style: Optional[str] = None
    ) -> bool:
        """
        异步播放TTS
        """
        import tempfile
        import os
        from datetime import datetime
        
        # 合成（创建临时文件）
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        output_file = os.path.join(tempfile.gettempdir(), f"tts_{timestamp}.wav")
        
        file_path, error = await self.synthesize(text, voice, style, output_file)
        if error:
            logger.error(f"TTS合成失败: {error}")
            return False
            
        # 在线程中播放
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, self.play_audio, file_path)

# 单例实例
_tts_player: Optional[TTSPlayer] = None


def get_tts_player() -> TTSPlayer:
    """获取TTS播放器单例"""
    global _tts_player
    if _tts_player is None:
        _tts_player = TTSPlayer()
    return _tts_player


def reset_tts_player() -> None:
    """停止并丢弃 TTS 播放器单例（配置热重载钩子）。

    旧实例 best-effort ``stop()``：终止在播音频，后续 get_tts_player() 按新配置
    （api_key 等）重建。stop() 异常不阻断热重载，只记 WARNING。
    """
    global _tts_player
    player = _tts_player
    if player is not None:
        try:
            player.stop()
        except Exception as exc:
            logger.warning("[TTS] 旧实例停止失败（忽略，继续重建）: %s", exc)
    _tts_player = None
