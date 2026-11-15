"""Web 通道后端择路（W53 收敛：config.yaml 是唯一真源）。

历史（W30）：Web 对话管线用 ``ai/data/cache/web_backend.json`` 单独记录后端，
可以与顶层 ``ai_backend`` 不一致——同一部署里 SSE/健康探针看全局值、聊天端点
看状态文件，切换后两边不同步（2026-11-15 生产切 dsh 时就撞了两层判据）。

W53 起本模块不再持有第二真源：
- ``get_web_backend()`` 恒等于 ``get_ai_backend()``（顶层 ``ai_backend``）；
- 切换入口只在配置（系统配置页 / ``PUT /api/system/config``，写操作需密码
  二次校验）；旧的 ``POST /api/screen/backend`` 已退役（410），不提供任何
  绕过配置校验的旁路；
- 旧状态文件只做一次性归档留证（``deprecate_legacy_state``），不再参与择路。

边界不变：定时任务/脚本/语音等后台调用方仍经 ``services.ai_client_factory``
直接读全局配置；本模块只服务 Web 对话管线（``routers/session.py``、
``routers/model_config.py``、``routers/events.py``）的读取缝与客户端原语。

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
# 复用工厂的合法值域与类型面（_VALID_BACKENDS 是唯一取值真源）；
# 直接引各通道客户端的 acquire/get 原语（与 ai_client_factory 同款路由），
# 不 import routers——依赖方向恒为 routers -> services，杜绝环。
from services.ai_client_factory import AiClient, _VALID_BACKENDS, get_ai_backend
from services.dsh_client import acquire_dsh_client, get_dsh_client
from services.loom_client import acquire_loom_client, get_loom_client
from services.opencode_client import acquire_opencode_client, get_opencode_client

logger = logging.getLogger(__name__)

# GET /api/screen/backend 契约项（后端无写入面）：前端按此清单渲染/校验（勿改顺序语义）。
# 取值集合必须与 _VALID_BACKENDS 一致（测试锁死）；顺序只影响展示，dsh 放末位。
WEB_BACKEND_OPTIONS: tuple[str, ...] = ("opencode", "loom", "dsh")


def get_web_backend() -> str:
    """当前 AI 后端：与全局 ``ai_backend`` 同一取值（每次现读配置快照）。

    非法值照旧 fail-fast 抛 ValueError（``get_ai_backend`` 的语义），本层不吞
    配置错误——宁可不服务，也不默默退回旧通道造成双写。
    """
    return get_ai_backend()


def legacy_state_path() -> Path:
    """W30 遗留状态文件路径（每次现取，随配置漂移；测试以 monkeypatch 重定向）。"""
    return Path(get_config().WEB_BACKEND_STATE_PATH)


def deprecate_legacy_state() -> dict | None:
    """归档 W30 状态文件（一次性）：它已不参与择路，按数据保护约定改名留证。

    返回 ``None``（无文件）或 ``{"archived", "legacy", "effective"}``。读取/改名
    失败只告警不阻断启动——旧文件不影响任何判定，留下与否都不改变行为。
    """
    path = legacy_state_path()
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except OSError as exc:
        logger.warning(f"[WebBackend] 旧状态文件读取失败（忽略）: {exc}")
        return None

    legacy = None
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            legacy = parsed.get("backend")
    except (ValueError, TypeError):
        legacy = None

    stamp = time.strftime("%Y%m%d-%H%M%S")
    target = path.with_name(f"{path.name}.deprecated-{stamp}")
    counter = 1
    while target.exists():
        target = path.with_name(f"{path.name}.deprecated-{stamp}-{counter}")
        counter += 1
    try:
        os.replace(path, target)
    except OSError as exc:
        logger.warning(f"[WebBackend] 旧状态文件归档失败（忽略）: {exc}")
        return None

    try:
        effective = get_web_backend()
    except ValueError:
        effective = None
    logger.info(
        "[WebBackend] 旧状态文件已归档（config.yaml 才是唯一真源）: %s（legacy=%s, effective=%s）",
        target,
        legacy,
        effective,
    )
    return {"archived": str(target), "legacy": legacy, "effective": effective}


async def acquire_web_client() -> AiClient:
    """异步获取 Web 通道客户端单例（事件循环内用；与 acquire_ai_client 对称）。"""
    backend = get_web_backend()
    if backend == "dsh":
        return await acquire_dsh_client()
    if backend == "loom":
        return await acquire_loom_client()
    return await acquire_opencode_client()


def get_web_client() -> AiClient:
    """同步获取 Web 通道客户端单例（阻塞上下文专用；events hub 构造走此缝）。"""
    backend = get_web_backend()
    if backend == "dsh":
        return get_dsh_client()
    if backend == "loom":
        return get_loom_client()
    return get_opencode_client()


def web_agent_key(agent: str, backend: str) -> str:
    """智能体绑定键的 Web 命名空间：'<backend>:<agent>'（W30-B3 读写点统一经此构造）。"""
    return f"{backend}:{agent}"
