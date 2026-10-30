"""AI 后端统一入口工厂（双通道：loom 转正 + opencode 兜底热回退）。

调用点只依赖本模块（acquire_ai_client / get_ai_client），具体通道由
config.yaml 顶层 `ai_backend` 决定；切流=编排者手改配置并重启后端，
把该键改回 opencode 即热回退（opencode 链路一行不删，随时可回）。

两通道客户端 duck-type 同构（公共方法面/签名/信封逐键一致，
契约真源 = services/opencode_client.py 的信封公共层）。
"""

from typing import Union

from config.config import get_config
from services.loom_client import (
    LoomClient,
    acquire_loom_client,
    get_loom_client,
    _reset_loom_client,
)
from services.opencode_client import (
    OpenCodeClient,
    acquire_opencode_client,
    get_opencode_client,
    _reset_opencode_client,
)

_VALID_BACKENDS = ("loom", "opencode")
AiClient = Union[OpenCodeClient, LoomClient]


def get_ai_backend() -> str:
    """当前 AI 通道（每次调用动态读配置，与 mock 开关同款语义）。

    非法值 fail-fast：抛 ValueError 让配置错误在取用点响亮暴露
    （宁可不服务，不许默默退回旧通道造成双写）。
    """
    backend = get_config().AI_BACKEND
    if backend not in _VALID_BACKENDS:
        raise ValueError(
            f"config.yaml ai_backend 取值非法: {backend!r}（合法: {'|'.join(_VALID_BACKENDS)}）"
        )
    return backend


def get_ai_client() -> AiClient:
    """同步获取当前通道客户端单例（阻塞上下文专用，事件循环内用 acquire_ai_client）。"""
    backend = get_ai_backend()
    if backend == "loom":
        return get_loom_client()
    return get_opencode_client()


async def acquire_ai_client() -> AiClient:
    """异步获取当前通道客户端单例（opencode 分支含线程池端口探测，loom 分支纯构造）。"""
    backend = get_ai_backend()
    if backend == "loom":
        client: AiClient = await acquire_loom_client()
        return client
    return await acquire_opencode_client()


def _reset_ai_client() -> None:
    """重置两通道单例（仅测试用；生产切换配置走重启，不做运行期重置）。"""
    _reset_loom_client()
    _reset_opencode_client()
