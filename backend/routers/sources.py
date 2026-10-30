"""数据源健康路由：GET /api/sources/health。

鉴权沿用全局 Bearer 中间件（该路径不在 PUBLIC_PATHS，也不接受 ?token=）。
单个数据源采集失败只降级为 unknown，不拖垮整个响应。

错误响应直接返回 {"detail": ...}，不套用项目的 success/error 信封：
本端点契约按任务要求固定为 detail 形状（401/500）。
"""

import logging

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from services import source_health

logger = logging.getLogger(__name__)

router = APIRouter(tags=["sources"])


@router.get("/sources/health")
def sources_health(request: Request):
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        return JSONResponse(
            status_code=401, content={"detail": "未授权访问，请先登录"}
        )
    try:
        return source_health.collect_all(user_id)
    except Exception as exc:
        logger.exception("[Sources] 数据源健康检查失败: %s", exc)
        return JSONResponse(
            status_code=500, content={"detail": "数据源健康检查失败"}
        )
