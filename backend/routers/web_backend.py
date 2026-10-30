"""
Web 通道后端切换 API（W30-B2）—— /api/screen/backend。

切换只作用于网页对话管线的请求路由（routers/session.py 的 web 端点）；
SSE 事件流自 W44 起恒多路复用双通道（routers/events.py 双活 hub 注册表，
每帧带 properties.backend 标），本开关不重建不停止任何 hub；后台链路
（定时任务/脚本/语音）继续跟随全局 ai_backend，与本开关无关。
响应形状为前端已发货的固定契约（frontend/mobile/src/api/backend.ts），
勿增删字段：
  GET  -> 200 {"ok": true, "backend": <当前>, "options": ["opencode", "loom"]}
  POST {"backend": ...} -> 200 同 GET 形态；非法取值 -> 400 {"ok": false, "error": <文本>}
鉴权即标准 /api/screen Bearer 中间件（与 /api/screen/restart 先例同级），
不新增任何 auth 机制。
"""

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from services.web_backend_selector import (
    WEB_BACKEND_OPTIONS,
    get_web_backend,
    set_web_backend,
)

router = APIRouter(prefix="", tags=["web-backend"])


class WebBackendSwitchRequest(BaseModel):
    """切换请求体：{"backend": "loom"|"opencode"}（契约固定键）。"""

    backend: str


def _state_payload() -> dict:
    """GET/POST 共用的成功响应体（现读 selector，含刚生效值）。"""
    return {
        "ok": True,
        "backend": get_web_backend(),
        "options": list(WEB_BACKEND_OPTIONS),
    }


@router.get("/backend")
async def get_backend():
    """查询当前 Web 通道后端（状态文件每次现读，缺失/损坏回落全局 ai_backend）。"""
    return _state_payload()


@router.post("/backend")
async def switch_backend(request: WebBackendSwitchRequest):
    """切换 Web 通道后端：校验 -> 落盘 -> 响应（与 SSE hub 生命周期解耦，W44）。

    双活 hub 注册表恒并活、/events/stream 恒双流多路复用——切换不再重建/关停
    任何 hub，只改变对话请求的通道归属；在途事件流一帧不断，前端按帧内
    properties.backend 标分流。非法值按契约回 400 {"ok":false,"error":<文本>}，
    不走 HTTPException 统一信封（前端判定的错误形状即 {ok:false,error}）。
    """
    try:
        set_web_backend(request.backend)
    except ValueError as e:
        return JSONResponse(status_code=400, content={"ok": False, "error": str(e)})
    return _state_payload()
