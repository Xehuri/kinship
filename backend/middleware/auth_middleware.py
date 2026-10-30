"""
认证中间件模块

提供 AuthMiddleware 和 get_current_user_id 函数，
用于多用户 Token 认证和用户 ID 注入。
"""

from typing import Optional

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

from auth import (
    TICKET_SCOPE_DOWNLOAD,
    TICKET_SCOPE_GENERIC,
    consume_ws_ticket,
    verify_token_full,
)


# 不需要认证的路径
# 安全原则: 所有涉及用户数据的端点(健康数据/文件/会话/事件流/OTA)一律需要 Token。
# 仅保留无数据暴露的系统级/页面级路径。
PUBLIC_PATHS = [
    "/",                # 根路径(无数据)
    "/favicon.ico",     # 图标
    "/health",          # 健康检查(无数据)
    "/login",           # 登录入口
    "/auth/setup-status",  # 首次初始化状态查询(登录前调用, 仅返回是否需要初始化)
    "/auth/setup",         # 首次初始化设置凭据(登录前调用, 仅系统无用户时生效)
    "/mobile",          # SPA 页面入口(页面本身无数据, 数据通过 API 拉取)
    "/mobile/",
    "/vaudit",          # 声纹审计平台页面入口(纯静态, 数据通过 /api/vaudit 拉取)
    "/vaudit/",
    "/preview",         # 音频处理预览台页面入口(纯静态, 数据通过 /api/preview 拉取)
    "/preview/",
    "/docs",            # API 文档路由(生产已关闭, 保留以返回 404 而非 401)
    "/openapi.json",
    "/redoc",
    "/api/p2p/enroll",  # P2P 设备配对(配对码即凭据; p2p 未启用时路由自身返回 404)
]

# 可选认证路径：GET/只读端点公开（配置未初始化时也能读取），写操作由路由层
# 按用户存在性分别要求引导令牌或 Bearer + 密码。这里只尝试注入 Bearer 身份，
# 缺失/无效时不拦截；这些路径同样不接受 query token。
OPTIONAL_AUTH_PATHS = {
    "/api/system/config",
    "/api/system/config/schema",
    "/api/system/config/status",
    "/api/system/config/validate",
    "/api/system/config/restart",
    "/api/system/onboarding/preflight",
    "/api/system/onboarding/status",
    "/api/system/onboarding/state",
    "/api/system/onboarding/action",
    "/api/system/onboarding/clients",
    "/api/system/onboarding/startup",
    "/api/system/onboarding/startup/attempt",
    "/api/system/onboarding/startup/validate",
    "/api/system/onboarding/startup/abort",
}


# 仅这些路径前缀接受查询参数凭证（?token= 或一次性 ?ticket=），
# 用于无法携带 Authorization 头的长连接/文件场景：
#   - EventSource / WebSocket 无法设置请求头
#   - 浏览器 <audio src> / <a download> / <img src> 无法设置请求头
# 其余端点一律忽略 query token（必须使用 Authorization 头）。
QUERY_CREDENTIAL_PATH_PREFIXES = (
    "/api/mimo/audio/",           # MiMo 音频(已按签名豁免, 列出以备扩展)
    "/api/vaudit/",               # 声纹审计平台音频流/试听
    "/api/preview/",              # 音频处理预览台音频/文件
    "/api/mobile/files",          # 手机端文件浏览/下载/原始内容
    "/api/ota/download",          # OTA 安装包下载(App 当前实现)
    "/api/clients/desktop/download",  # 桌面端安装包下载(浏览器 <a download> 无法带 header)
    "/api/pc-sensor/download",    # PC 采集端 exe 下载(设置页 <a download> 无法带 header)
    "/api/screen/events/stream",  # SSE 事件流(EventSource 无法带 header)
)


DOWNLOAD_TICKET_PATH_PREFIXES = (
    "/api/ota/download",
    "/api/clients/desktop/download",
)


def _accepts_query_credential(path: str) -> bool:
    """路径是否属于允许使用 query 凭证（token/ticket）白名单。"""
    return any(path.startswith(prefix) for prefix in QUERY_CREDENTIAL_PATH_PREFIXES)


def _required_ticket_scope(path: str) -> str:
    """下载端点只接受 download 票据，其余 query 凭证路径只接受 generic。

    generic 票据保持向后兼容（/auth/ws-ticket 默认签发），download 票据
    不能横向用于 SSE、文件浏览等其它 query 凭证路径。
    """
    if path.startswith(DOWNLOAD_TICKET_PATH_PREFIXES):
        return TICKET_SCOPE_DOWNLOAD
    return TICKET_SCOPE_GENERIC


# 【用途 B: 认证豁免判定】静态资源扩展名白名单。
# 仅当路径位于 /mobile/、/vaudit/、/preview/ 或 /static 前缀且以此处某个扩展名结尾时,
# 才跳过 Token 认证(页面壳/构建产物本身不含数据, 数据仍由受保护的 API 提供)。
# 注意(D9): 本表与 main.py 的 _ASSET_EXTS 用途不同 —— 那个用于 SPA fallback 判定
# (决定"资源缺失时是否回退 index.html")。二者刻意保持独立, 不合并;
# 本表额外含 .html/.map/.webmanifest/.txt 等构建产物扩展名。
# 具体差异由 tests/test_middleware_hardening.py 固化记录。
_STATIC_EXTS = (".js", ".css", ".html", ".png", ".ico", ".svg", ".woff", ".woff2", ".ttf", ".eot", ".map", ".webmanifest", ".txt")


class AuthMiddleware(BaseHTTPMiddleware):
    """认证中间件"""

    async def dispatch(self, request: Request, call_next):
        path = request.url.path

        # 检查是否是公开路径（BE-SEC-L1: 精确匹配，杜绝 /docsfoo 等前缀越权放行）
        if path in PUBLIC_PATHS:
            return await call_next(request)

        # 可选认证路径：只尝试注入身份，缺失/无效时交给路由层判定
        if path in OPTIONAL_AUTH_PATHS:
            auth_header = request.headers.get("Authorization", "")
            token = auth_header[7:] if auth_header.startswith("Bearer ") else ""
            if token:
                is_valid, user_id, token_kind, device_id = verify_token_full(token)
                if is_valid:
                    request.state.user_id = user_id
                    request.state.token_kind = token_kind or "user"
                    request.state.device_id = device_id
            return await call_next(request)

        # MiMo 音频拉取豁免: /api/mimo/audio/{文件名}
        # 该端点自带短 TTL 签名校验（HMAC-SHA256 + exp，见 routers/mimo.py），
        # MiMo 为外部服务无法携带 token，故此处按路径放行，由端点内部按签名拒绝。
        if path.startswith("/api/mimo/audio/"):
            return await call_next(request)

        # 静态资源豁免: 仅限 /mobile/ 前端构建产物、/vaudit/ 审计平台、/preview/ 预览台和 /static 前缀,
        # 且必须匹配模块级 _STATIC_EXTS 中的扩展名(含字体), 避免任何 API 路径被误豁免。
        if (path.startswith("/mobile/") or path.startswith("/vaudit/") or path.startswith("/preview/") or path.startswith("/static")) and path.endswith(_STATIC_EXTS):
            return await call_next(request)

        # Phase 2: 不再有 localhost 绕过 - 所有请求均需 Token 认证

        # 1) 优先标准 Authorization: Bearer 头
        auth_header = request.headers.get("Authorization", "")
        token = auth_header[7:] if auth_header.startswith("Bearer ") else ""

        is_valid = False
        user_id = None
        token_kind = ""
        device_id = ""

        if token:
            is_valid, user_id, token_kind, device_id = verify_token_full(token)
        elif _accepts_query_credential(path):
            # 2) 白名单路径：优先一次性 ticket，其次兼容 ?token=（长连接/文件场景）
            ticket = request.query_params.get("ticket") or ""
            if ticket:
                is_valid, user_id = consume_ws_ticket(
                    ticket, required_scope=_required_ticket_scope(path)
                )
                token_kind = "user" if is_valid else ""
            else:
                is_valid, user_id, token_kind, device_id = verify_token_full(
                    request.query_params.get("token") or ""
                )
        # 非白名单路径忽略 query token：无 Header 即视为未授权

        if not is_valid:
            return JSONResponse(
                status_code=401,
                content={"detail": "未授权访问，请先登录"}
            )

        request.state.user_id = user_id  # 注入 user_id
        request.state.token_kind = token_kind or "user"
        request.state.device_id = device_id
        return await call_next(request)


def get_current_user_id(request: Request) -> Optional[str]:
    """获取当前请求的用户ID"""
    return getattr(request.state, 'user_id', None)
