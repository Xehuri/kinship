"""Web 通道后端选择器（W30）——网页对话管线专属的热切换开关。

边界裁定（lead 冻结）：定时任务/脚本/语音等后台调用方永远跟随 config.yaml
全局 ai_backend（services.ai_client_factory 一行不动）；只有 Web 对话管线
（routers/session.py 的 web 端点 + routers/events.py 的 SSE hub）经本模块在
运行期按状态文件择路（opencode:5096 / loom:5100），切换即时生效、无需重启。
状态文件缺失/损坏一律回落全局 ai_backend——两条通道并跑是常态，Web 通道
只是"选哪条腿走"，不存在"无后端可用"的中间态。

web_agent_key：Web 端点的智能体绑定键走 "<backend>:<agent>" 命名空间，
与语音/任务站的裸键（"main-task"）隔离；读侧别名与严格隔离策略在
routers/session.py 调用点落实（opencode 先读命名键、缺则回落裸键保
语音<->web 会话连续；loom 只认命名键，绝不复用共享 current_session）。
"""

import json
import logging
import os
import time
from pathlib import Path

from config.config import get_config
# 复用工厂的合法值域与类型面（_VALID_BACKENDS 是双通道唯一取值真源）；
# 直接引两通道客户端的 acquire/get 原语（与 ai_client_factory 同款路由），
# 不 import routers——依赖方向恒为 routers -> services，杜绝环。
from services.ai_client_factory import AiClient, _VALID_BACKENDS, get_ai_backend
from services.loom_client import acquire_loom_client, get_loom_client
from services.opencode_client import acquire_opencode_client, get_opencode_client

logger = logging.getLogger(__name__)

# GET/POST /api/screen/backend 契约固定项：前端按此清单渲染开关（勿改顺序语义）
WEB_BACKEND_OPTIONS: tuple[str, ...] = ("opencode", "loom")


def _state_path() -> Path:
    """状态文件路径（每次现取，随配置漂移；测试以 monkeypatch 本缝重定向 tmp）。"""
    return Path(get_config().WEB_BACKEND_STATE_PATH)


def get_web_backend() -> str:
    """当前 Web 通道后端：每次调用现读状态文件（热切换语义），绝不进程内缓存。

    缺失 / JSON 损坏 / 非法取值 → 回落全局 ai_backend（get_ai_backend 对非法
    全局值照旧 fail-fast 抛 ValueError，本层不吞主链路的配置错误）。
    """
    try:
        with open(_state_path(), "r", encoding="utf-8") as f:
            backend = json.load(f)["backend"]
    except (OSError, ValueError, KeyError, TypeError):
        return get_ai_backend()
    if backend not in _VALID_BACKENDS:
        logger.warning(f"[WebBackend] 状态文件 backend 取值非法: {backend!r}，回落全局 ai_backend")
        return get_ai_backend()
    return backend


def set_web_backend(backend: str) -> str:
    """校验并原子落盘（tmp + os.replace），返回生效值。

    非法值抛 ValueError——端点层（routers/web_backend.py）捕获后转契约规定的
    400 {"ok":false,"error":...}；此处不返回响应形状，保持 services 层零 HTTP 语义。
    """
    if backend not in _VALID_BACKENDS:
        raise ValueError(
            f"web backend 取值非法: {backend!r}（合法: {'|'.join(_VALID_BACKENDS)}）"
        )
    path = _state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    payload = {"backend": backend, "updated_at": time.time()}
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    os.replace(tmp, path)
    logger.info(f"[WebBackend] Web 通道后端已切换为: {backend}")
    return backend


async def acquire_web_client() -> AiClient:
    """异步获取 Web 通道客户端单例（事件循环内用；与 acquire_ai_client 对称，仅后端来源不同）。"""
    if get_web_backend() == "loom":
        return await acquire_loom_client()
    return await acquire_opencode_client()


def get_web_client() -> AiClient:
    """同步获取 Web 通道客户端单例（阻塞上下文专用；events hub 构造走此缝）。"""
    if get_web_backend() == "loom":
        return get_loom_client()
    return get_opencode_client()


def web_agent_key(agent: str, backend: str) -> str:
    """智能体绑定键的 Web 命名空间：'<backend>:<agent>'（W30-B3 读写点统一经此构造）。"""
    return f"{backend}:{agent}"
