"""
设备通道存储 - TTS 设备路由的"最近发送者"记录

语义：某用户的 TTS 语音回复只发到"最近发消息的那台设备"。
- 每台设备（device_id）发消息时刷新该用户通道的滑动 TTL；
- 新的发送者会抢占通道（同一用户只保留一个目标设备）；
- TTL 过期或从未记录时，调用方回退为广播给指定 client_type（默认 web）；
- 纯内存实现，不跨进程重启持久化（重启后自然走回退）。

threading.Lock 保证多线程（WS 回调线程 / 请求线程 / 后台任务）下的安全。
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Any, Dict, Optional, Tuple

logger = logging.getLogger(__name__)

# 复用 audio_config 的 tts 节；该模块由阶段 9 提供，故做防御性加载。
# 内置默认与方案 §8.2 对齐，保证 audio_config 缺失时行为仍可预测。
_DEFAULT_TTL_SECONDS = 3600
_DEFAULT_FALLBACK_CLIENT_TYPES = ["web"]


def get_tts_config() -> Dict[str, Any]:
    """读取 TTS 配置（audio_config 的 `tts` 节优先，缺失时用内置默认）。

    接口约定：`get_audio_config()["tts"]["device_channel_ttl_seconds"]`。
    audio_config 尚未就绪时不抛异常，退回内置默认值。
    """
    cfg: Dict[str, Any] = {
        "enabled": True,
        "device_channel_ttl_seconds": _DEFAULT_TTL_SECONDS,
        "fallback_client_types": list(_DEFAULT_FALLBACK_CLIENT_TYPES),
    }
    try:
        from services.audio_config import get_audio_config

        tts = get_audio_config().get("tts") or {}
        if isinstance(tts, dict):
            for key in cfg:
                value = tts.get(key)
                if value is not None:
                    cfg[key] = value
    except Exception as exc:  # noqa: BLE001 - 配置缺失不应中断服务
        logger.debug("[DeviceChannelStore] 读取 audio_config.tts 失败，使用内置默认: %s", exc)
    return cfg


class DeviceChannelStore:
    """用户 -> 最近发送设备 的内存通道表"""

    def __init__(self, ttl_seconds: Optional[int] = None):
        self._lock: threading.Lock = threading.Lock()
        # user_id -> {"device_id": str, "client_type": str, "expires_at": float}
        self._channels: Dict[str, Dict[str, Any]] = {}
        # 显式传入的 TTL（测试用）；None 时每次惰性读取配置
        self._ttl_override: Optional[int] = ttl_seconds

    def _ttl_seconds(self) -> int:
        """解析当前生效的 TTL（秒），非法值退回默认 3600。"""
        if self._ttl_override is not None:
            try:
                return max(1, int(self._ttl_override))
            except (TypeError, ValueError):
                return _DEFAULT_TTL_SECONDS
        raw = get_tts_config().get("device_channel_ttl_seconds", _DEFAULT_TTL_SECONDS)
        try:
            return max(1, int(raw))
        except (TypeError, ValueError):
            return _DEFAULT_TTL_SECONDS

    def mark_sender(self, user_id: str, device_id: str, client_type: str = "web") -> None:
        """记录一次消息发送：刷新 TTL 并抢占通道。

        同一用户只保留最新发送者，因此旧的 device_id 会被本次覆盖驱逐。
        """
        if not user_id or not device_id:
            return
        ttl = self._ttl_seconds()
        expires_at = time.time() + ttl
        with self._lock:
            self._channels[user_id] = {
                "device_id": device_id,
                "client_type": client_type or "web",
                "expires_at": expires_at,
            }
        logger.debug(
            "[DeviceChannelStore] 通道刷新 user=%s device=%s type=%s ttl=%ss",
            user_id, device_id, client_type or "web", ttl,
        )

    def resolve(self, user_id: str) -> Optional[Tuple[str, str]]:
        """返回 (device_id, client_type)；无记录或已过期返回 None（并惰性清理）。"""
        if not user_id:
            return None
        now = time.time()
        with self._lock:
            entry = self._channels.get(user_id)
            if not entry:
                return None
            if float(entry.get("expires_at", 0)) <= now:
                del self._channels[user_id]
                return None
            return str(entry.get("device_id", "")), str(entry.get("client_type", "web"))

    def clear(self, user_id: str) -> None:
        """清除指定用户的通道记录。"""
        if not user_id:
            return
        with self._lock:
            self._channels.pop(user_id, None)


# 全局单例
device_channel_store = DeviceChannelStore()
