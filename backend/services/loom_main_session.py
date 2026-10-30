"""Loom 主会话解析与缓存（T5）。

Loom 的主会话唯一真源 = ``GET /sessions/main``（候选单例）。后端 web 会话端点
（create/message/list）不得再经 ``GET /sessions`` 列表或自建随机会话获取 Loom
会话，本模块是唯一解析入口：

- 200：以返回的 sessionID 覆盖本地 ``loom:main-task`` 绑定（陈旧绑定自愈）；
- 404：Loom 无主会话，仅当 ``allow_create=True`` 时创建一次并绑定；
- 503/传输故障：降级复用既有 ``loom:main-task`` 绑定，绝不创建。

60s TTL 缓存按客户端 base_url 分键；创建路径由 ``asyncio.Lock`` 串行化并在锁内
二次查缓存，保证并发调用最多创建一个会话。裸 ``main-task`` 键属语音/QQ 链路，
本模块绝不读写。
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Any, Dict, Optional, Protocol, Tuple

from services.stt_session_manager import STTSessionManager
from services.web_backend_selector import web_agent_key

logger = logging.getLogger(__name__)

LOOM_MAIN_AGENT = "main-task"
MAIN_SESSION_CREATE_TITLE = "主会话"
CACHE_TTL_SECONDS = 60.0

SOURCE_LOOM_MAIN = "loom-main"
SOURCE_CREATED = "created"
SOURCE_BINDING = "binding"


class LoomMainClient(Protocol):
    """解析器所需的最小客户端面（LoomClient 与测试桩均可满足）。"""

    base_url: str

    async def get_main_session(self) -> Dict[str, Any]: ...

    async def create_session(
        self,
        title: Optional[str] = None,
        directory: Optional[str] = None,
    ) -> Dict[str, Any]: ...


@dataclass(frozen=True, slots=True)
class LoomMainResolution:
    """一次主会话解析结果：成功时 session_id 非空，失败时 error 非空。"""

    session_id: Optional[str]
    source: Optional[str]
    error: Optional[str]

    @property
    def ok(self) -> bool:
        return self.session_id is not None


# base_url -> (expires_at, resolution)；只缓存权威成功结果（loom-main/created），
# 降级绑定不缓存，Loom 恢复后下一次调用立即回到 main-first。
_cache: Dict[str, Tuple[float, LoomMainResolution]] = {}
_lock: Optional[asyncio.Lock] = None
_lock_loop: Optional[asyncio.AbstractEventLoop] = None


def _now() -> float:
    """缓存时钟（测试可 monkeypatch 本函数推进 TTL，不 sleep）。"""
    return time.monotonic()


def _cache_key(client: LoomMainClient) -> str:
    return str(getattr(client, "base_url", "") or "")


def _cache_get(key: str) -> Optional[LoomMainResolution]:
    entry = _cache.get(key)
    if entry is None:
        return None
    expires_at, resolution = entry
    if _now() >= expires_at:
        _cache.pop(key, None)
        return None
    return resolution


def _cache_put(key: str, resolution: LoomMainResolution) -> None:
    _cache[key] = (_now() + CACHE_TTL_SECONDS, resolution)


def invalidate_loom_main_cache(base_url: Optional[str] = None) -> None:
    """清除缓存：缺省清全部；给定 base_url 只清该键（switch/create 后调用）。"""
    if base_url is None:
        _cache.clear()
    else:
        _cache.pop(str(base_url), None)


def reset_loom_main_cache() -> None:
    """测试专用：清缓存并丢弃锁（避免跨事件循环复用 asyncio.Lock）。"""
    global _lock, _lock_loop
    _cache.clear()
    _lock = None
    _lock_loop = None


def _get_lock() -> asyncio.Lock:
    """取当前事件循环绑定的锁；asyncio.run 每次新循环时重建。"""
    global _lock, _lock_loop
    loop = asyncio.get_running_loop()
    if _lock is None or _lock_loop is not loop:
        _lock = asyncio.Lock()
        _lock_loop = loop
    return _lock


def _main_binding_key() -> str:
    return web_agent_key(LOOM_MAIN_AGENT, "loom")


def _get_binding(manager: STTSessionManager) -> Optional[str]:
    return manager.get_agent_session(_main_binding_key())


def _persist_binding(manager: STTSessionManager, session_id: str) -> None:
    """只写 ``loom:main-task``；裸 ``main-task``（语音/QQ）零触碰。"""
    manager.set_agent_session(_main_binding_key(), session_id)


def _error_detail(result: Dict[str, Any], fallback: str) -> str:
    error = result.get("error")
    if isinstance(error, dict) and error.get("detail"):
        return str(error["detail"])
    return fallback


def _is_missing_main(detail: str) -> bool:
    """Loom 自报主会话不存在（404）；其余失败一律按暂时不可用处理。"""
    return detail.startswith("HTTP 404")


async def _create_main_session(
    client: LoomMainClient,
    manager: STTSessionManager,
    cache_key: str,
) -> LoomMainResolution:
    """锁内二次查缓存后创建一次；并发 404 调用最多落一个会话。"""
    async with _get_lock():
        cached = _cache_get(cache_key)
        if cached is not None:
            return cached

        try:
            result = await client.create_session(title=MAIN_SESSION_CREATE_TITLE)
        except Exception as e:
            return LoomMainResolution(None, None, f"Loom 创建主会话异常: {e}")
        if not result.get("ok"):
            return LoomMainResolution(
                None, None, _error_detail(result, "Loom 创建主会话失败")
            )
        data = result.get("data")
        session_id = data.get("session_id") if isinstance(data, dict) else None
        if not session_id:
            return LoomMainResolution(None, None, "Loom 创建主会话响应缺少 session_id")

        _persist_binding(manager, session_id)
        resolution = LoomMainResolution(session_id, SOURCE_CREATED, None)
        _cache_put(cache_key, resolution)
        logger.info("[LoomMain] 主会话缺失，已创建并绑定: %s", session_id)
        return resolution


async def resolve_loom_main_session(
    client: LoomMainClient,
    manager: STTSessionManager,
    allow_create: bool,
) -> LoomMainResolution:
    """解析权威 Loom 主会话（main-first；404 可创建一次；故障降级绑定）。

    Args:
        client: Loom 客户端（需 ``get_main_session`` / ``create_session``）。
        manager: 会话管理器（只读写 ``loom:main-task`` 命名键）。
        allow_create: 404 时是否允许创建主会话。

    Returns:
        ``LoomMainResolution(session_id, source, error)``；source 取值
        ``loom-main`` / ``created`` / ``binding``。
    """
    cache_key = _cache_key(client)
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    try:
        result = await client.get_main_session()
    except Exception as e:
        result = {"ok": False, "data": None,
                  "error": {"detail": f"Loom 主会话请求异常: {e}"}}
    if result.get("ok"):
        data = result.get("data")
        session_id = data.get("sessionID") if isinstance(data, dict) else None
        if session_id:
            _persist_binding(manager, session_id)
            resolution = LoomMainResolution(session_id, SOURCE_LOOM_MAIN, None)
            _cache_put(cache_key, resolution)
            logger.debug("[LoomMain] 权威主会话: %s", session_id)
            return resolution
        detail = "Loom 主会话响应缺少 sessionID"
    else:
        detail = _error_detail(result, "Loom 主会话不可用")

    if _is_missing_main(detail):
        if not allow_create:
            return LoomMainResolution(None, None, detail)
        return await _create_main_session(client, manager, cache_key)

    binding = _get_binding(manager)
    if binding:
        logger.warning("[LoomMain] 主会话解析降级为本地绑定 %s: %s", binding, detail)
        return LoomMainResolution(binding, SOURCE_BINDING, None)
    return LoomMainResolution(None, None, detail)
