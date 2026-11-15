"""
AI 后端读取 API（W30 立项，W53 收敛为 config 唯一入口）—— /api/screen/backend。

历史（W30-B2）：本端点既读又写独立状态文件 web_backend.json，于是同一部署可能
出现「SSE/探针按全局 ai_backend、聊天端点按状态文件」的两层判据。W53 起：
  - 唯一真源 = config.yaml 顶层 ai_backend（系统配置页/`PUT /api/system/config`
    的同一条路径，写操作需要密码二次校验）；
  - GET 保留为只读镜像：前端用它给新建会话标注默认通道、给设置页回显；
  - POST 退役（410）：旧写入口若继续可用，等于绕开配置写入的密码校验并持久化
    一份与配置并列的真源，与"统一入口"背道而驰。
旧 web_backend.json 不参与择路，启动时归档留证（services.web_backend_selector）。

响应形状（GET 为前端已发货的固定契约，勿增删字段）：
  GET  -> 200 {"ok": true, "backend": <当前>, "options": ["opencode", "loom", "dsh"]}
  POST -> 410 {"ok": false, "error": <文本>}（已退役；切后端请改配置）
鉴权即标准 /api/screen Bearer 中间件（与 /api/screen/restart 先例同级），
不新增任何 auth 机制。
"""

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from services.web_backend_selector import WEB_BACKEND_OPTIONS, get_web_backend

router = APIRouter(prefix="", tags=["web-backend"])

RETIRED_MESSAGE = (
    "该端点已退役：AI 后端切换统一走系统配置（config.yaml 顶层 ai_backend，"
    "经 /api/system/config 写入并需密码二次校验），GET 仍可用于读取当前值。"
)


class WebBackendSwitchRequest(BaseModel):
    """旧切换请求体（仅为让 410 响应可解析，不再读取 backend 取值）。"""

    backend: str


def _state_payload() -> dict:
    """GET 响应体（现读配置快照，与系统配置页同一取值）。"""
    return {
        "ok": True,
        "backend": get_web_backend(),
        "options": list(WEB_BACKEND_OPTIONS),
    }


@router.get("/backend")
async def get_backend():
    """查询当前 AI 后端（直接读 config.yaml 快照，与系统配置页同一取值）。"""
    return _state_payload()


@router.post("/backend")
async def switch_backend(request: WebBackendSwitchRequest):
    """已退役：切换入口统一在配置（见模块文档与 RETIRED_MESSAGE）。

    返回 410 而非静默成功，避免旧客户端以为"切换生效了"却在配置里看不到。
    """
    return JSONResponse(
        status_code=410,
        content={"ok": False, "error": RETIRED_MESSAGE},
    )
