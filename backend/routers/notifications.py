"""手机 App 通知推送路由

AI 通过工具向用户手机发送系统通知：
  - 下行流式：写入历史后，经 component_manager 向在线 /ws 客户端实时推送；
  - 历史（/notification/history）作为持久可读来源保留。
"""

import asyncio
import time
import logging
from typing import Dict, List, Optional
from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from services.component_manager import component_manager
from services.event_loop_manager import get_main_loop

logger = logging.getLogger(__name__)

router = APIRouter(tags=["通知推送"])

# ── 内存通知历史 ──
# user_id -> [{id, title, content, created_at}]
_notification_history: Dict[str, list] = {}
MAX_HISTORY_PER_USER = 100
# 通知 id 单调基：以进程启动时刻的 epoch-秒起算（旧实现从 1 重启计数，
# 重启后新推送与上一世代 id 撞车，Android 端按 id 去重把新推送当重复吞掉、
# 卡片不更新）。兄弟提交将客户端去重键升级为 (id, ts) 双因子，与此改动配合
# 彻底关闭该缺陷。量纲锁定「秒」而非「毫秒」：epoch-毫秒约 1.79e12，会撑爆
# Int32 消费端（Android optInt("id") 与 nm.notify 的 int 偏移运算）。
# 上限注记：epoch-秒在 2038-01-19 (2^31-1) 超出 Int32，届时需协调客户端
# 一并迁移（如改 epoch-天或 64 位键），当前视为系统寿命内安全。
_next_id = int(time.time())

# WS 推送超时（秒）：慢客户端最多拖住 HTTP 响应这么久，超时后放弃推送
_WS_PUSH_TIMEOUT_SEC = 2.0


# ── 请求/响应模型 ──

class NotificationSendRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=200, description="通知标题")
    content: str = Field(..., max_length=2000, description="通知内容")
    user_id: Optional[str] = Field(None, description="目标用户，不传则发给当前用户")


class NotificationItem(BaseModel):
    id: int
    title: str
    content: str
    created_at: int  # unix timestamp


class NotificationHistoryResponse(BaseModel):
    notifications: List[NotificationItem]
    total: int


# ── API 端点 ──

@router.post("/notification/send", response_model=dict)
async def send_notification(req: NotificationSendRequest, request: Request):
    """AI 调用此接口给用户手机发送系统通知"""
    user_id = req.user_id or getattr(request.state, "user_id", None) or "default"
    notification = {
        "id": _get_next_id(),
        "title": req.title,
        "content": req.content,
        "created_at": int(time.time()),
    }
    _history = _notification_history.setdefault(user_id, [])
    _history.append(notification)
    # auto-prune oldest
    if len(_history) > MAX_HISTORY_PER_USER:
        _history[:len(_history) - MAX_HISTORY_PER_USER] = []
    logger.info(f"[Notification] 发送通知 user={user_id}: {req.title}")
    # 下行流式：写入 history 后，向在线客户端 WS 实时推送。
    # 推送为 best-effort，任何失败都不影响本接口的 HTTP 响应。
    await _push_notification_ws(user_id, notification)
    return {"status": "ok", "notification_id": notification["id"]}


@router.get("/notification/history", response_model=NotificationHistoryResponse)
async def get_notification_history(
    request: Request,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0)
):
    """获取通知历史（分页，按时间倒序）"""
    user_id = getattr(request.state, "user_id", None) or "default"
    history = _notification_history.get(user_id, [])
    total = len(history)
    page = list(reversed(history))[offset:offset + limit]
    return {"notifications": page, "total": total}


@router.delete("/notification/history/{notification_id}", response_model=dict)
async def delete_notification(notification_id: int, request: Request):
    """删除指定通知历史记录"""
    user_id = getattr(request.state, "user_id", None) or "default"
    history = _notification_history.get(user_id, [])
    for i, n in enumerate(history):
        if n["id"] == notification_id:
            history.pop(i)
            return {"status": "ok"}
    raise HTTPException(status_code=404, detail="Notification not found")


# ── 内部工具 ──

def _get_next_id() -> int:
    # 单调守卫：max(_next_id + 1, now) 保证同秒连发也严格递增；
    # 跨重启时 now 即新基，永不与上一世代撞 id。
    # 部署假设：单 worker 进程内内存态（_next_id 为模块全局）。多 worker 部署时
    # 各进程基不同、可互撞 id，需先换号段（按进程分片）或 DB 分配，勿直接扩容。
    global _next_id
    _next_id = max(_next_id + 1, int(time.time()))
    return _next_id


async def _push_notification_ws(user_id: str, notification: dict) -> None:
    """通过 component_manager 向在线客户端实时推送一条通知（best-effort）。

    设计要点：
      - 复用 /ws 注册表（component_manager.send_to_user），不新建注册表；
      - 正常 FastAPI 路由在主事件循环内，直接 await 并加超时；
      - 若当前循环与主事件循环不同（例如被后台线程调用），改用
        event_loop_manager.get_main_loop() + asyncio.run_coroutine_threadsafe
        投递，保证 WebSocket 在其所属循环上发送；
      - 任何异常（含超时）全部吞掉，绝不破坏 HTTP 响应。
    """
    message = {
        "type": "notification",
        "data": {
            "id": notification["id"],
            "title": notification["title"],
            "content": notification["content"],
            "ts": notification["created_at"],
        },
    }
    try:
        running_loop = asyncio.get_running_loop()
    except RuntimeError:
        running_loop = None

    main_loop = get_main_loop()
    try:
        if running_loop is None or (main_loop is not None and main_loop is not running_loop):
            # 不在主事件循环内：投递到主循环执行
            if main_loop is None or not main_loop.is_running():
                logger.debug("[Notification] 无可用主事件循环，跳过 WS 推送")
                return
            future = asyncio.run_coroutine_threadsafe(
                component_manager.send_to_user(user_id, message), main_loop
            )
            await asyncio.wrap_future(future)
        else:
            await asyncio.wait_for(
                component_manager.send_to_user(user_id, message),
                timeout=_WS_PUSH_TIMEOUT_SEC,
            )
        logger.info(f"[Notification] WS 推送完成 user={user_id} id={notification['id']}")
    except Exception as e:
        logger.warning(f"[Notification] WS 推送失败（已忽略，不影响 HTTP 响应）: {e}")

