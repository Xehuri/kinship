"""AI 提醒板路由（reminders 通道，v2 单文本板契约）

AI 经 MCP 工具（ai/mcp/ai_mcp.py 的 list_reminders/send_reminder）
读当前全文、编辑后**整块覆盖**写回，Android 桌面小部件轮询 GET 滚动渲染。
v1 逐条清单语义（id/done//{id}/done/DELETE）已整体废除，不再提供。

与通知历史的本质区别：数据经 services/reminders_store.py 持久化到
{DATA_DIR}/users/{user}/reminders.json，后端重启不丢。

冻结契约 v2（Android 侧同文本并行开发，禁止偏离）：
  GET  /api/reminders           → 200 {"text": str, "updated_at": int(unix秒，0=从未写入)}
    - text 可为空串；未知 query 参数（含遗留 status=）一律忽略不报错，
      旧版轮询 App 拿到的也是 200 v2 形状而非破坏性响应。
  POST /api/reminders {"text"} → 200 {"text", "updated_at"}——整块覆盖提醒板。
    - 值去首尾空白后落盘；空白串 = 合法清空（板置空，updated_at 刷为当前）；
    - 去首尾空白后长度 > 2000 → 400。
用户身份一律由认证中间件注入的 request.state.user_id 服务端推导，客户端不传 user_id。
"""

import logging

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from services.reminders_store import MAX_TEXT_LEN, get_reminders_board

logger = logging.getLogger(__name__)

router = APIRouter(tags=["提醒板"])


# ── 请求/响应模型 ──

class ReminderBoardWriteRequest(BaseModel):
    text: str = Field(
        ...,
        description=(
            f"提醒板全文（整块覆盖，去首尾空白后上限 {MAX_TEXT_LEN} 字符；"
            "空白内容 = 清空提醒板）"
        ),
    )


class ReminderBoardResponse(BaseModel):
    text: str          # 板内全文，可为空串（空 = 无内容）
    updated_at: int    # 最近一次成功写入的 unix 秒，0 = 从未写入


# ── 用户推导（与 notifications 历史同一口径：中间件注入，缺省 default）──

def _resolve_user(request: Request) -> str:
    """从认证中间件注入的 request.state.user_id 推导当前用户。"""
    return getattr(request.state, "user_id", None) or "default"


# ── API 端点（v2 仅两条：读板 / 整块覆盖）──

@router.get("/reminders", response_model=ReminderBoardResponse)
async def get_reminder_board(request: Request):
    """读当前用户提醒板全文。

    不声明任何 query 参数：未知参数（含 v1 遗留 status=）由 FastAPI 天然
    忽略，旧版轮询 App 也拿到 200 v2 形状。形状非 v2 / 损坏文件按空板返回。
    """
    user_id = _resolve_user(request)
    try:
        text, updated_at = get_reminders_board().get_board(user_id)
    except ValueError as e:
        # 用户标识异常（目录穿越等）→ 400（校验类失败，非服务器错误）
        raise HTTPException(status_code=400, detail=str(e))
    return {"text": text, "updated_at": updated_at}


@router.post("/reminders", response_model=ReminderBoardResponse)
async def put_reminder_board(req: ReminderBoardWriteRequest, request: Request):
    """整块覆盖当前用户提醒板（读-改-写循环的最后一步）。"""
    user_id = _resolve_user(request)
    try:
        text, updated_at = get_reminders_board().put_board(user_id, req.text)
    except ValueError as e:
        # 超 2000 字符 / 非字符串 / 用户标识非法 → 契约规定的 400
        raise HTTPException(status_code=400, detail=str(e))
    logger.info(
        f"[Reminders] 覆盖 user={user_id} len={len(text)} "
        f"{'(清空)' if not text else ''}"
    )
    return {"text": text, "updated_at": updated_at}
