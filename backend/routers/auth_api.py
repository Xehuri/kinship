# -*- coding: utf-8 -*-
"""
认证 API 路由 — 登录/首次初始化/凭据修改/WS 票据
"""
import threading
import time

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from config.config import get_config
from auth import (
    LoginRequest,
    LoginResponse,
    ChangeCredentialsRequest,
    verify_password,
    check_user_password,
    create_token,
    get_auth_config,
    is_setup_required,
    create_first_user,
    change_credentials,
    create_ws_ticket,
    verify_setup_token,
)

router = APIRouter(tags=["auth"])


class VerifyPasswordRequest(BaseModel):
    """只读密码校验请求：仅密码，不包含用户名"""
    password: str


# ============ BE-SEC-M1: 登录失败速率限制 ============
# 按 "来源IP:用户名" 维度累计失败次数，达到阈值后临时锁定（退避）。
# 成功登录清零；状态存于进程内，线程安全。
LOGIN_MAX_FAILURES = 5
LOGIN_LOCKOUT_SECONDS = 60
_login_fail_lock = threading.Lock()
_login_failures: dict[str, dict] = {}  # key -> {"count": int, "locked_until": float}


def _login_rate_key(request: Request, username: str) -> str:
    """构造限流键：来源 IP + 规范化用户名。"""
    client = request.client.host if request.client else "unknown"
    return f"{client}:{(username or '').strip().lower()}"


def _login_allowed(key: str) -> tuple[bool, int]:
    """是否允许本次登录尝试；被锁定时返回剩余秒数。"""
    now = time.time()
    with _login_fail_lock:
        rec = _login_failures.get(key)
        if rec and rec.get("locked_until", 0.0) > now:
            return False, int(rec["locked_until"] - now) + 1
    return True, 0


def _record_login_failure(key: str):
    """记录一次登录失败，达到阈值则启动锁定。"""
    now = time.time()
    with _login_fail_lock:
        rec = _login_failures.setdefault(key, {"count": 0, "locked_until": 0.0})
        rec["count"] += 1
        if rec["count"] >= LOGIN_MAX_FAILURES:
            rec["locked_until"] = now + LOGIN_LOCKOUT_SECONDS
            rec["count"] = 0


def _reset_login_failures(key: str):
    """登录成功后清零该键的失败计数。"""
    with _login_fail_lock:
        _login_failures.pop(key, None)


def reset_login_rate_limit():
    """清空登录限流状态（测试用，避免用例间相互污染）。"""
    with _login_fail_lock:
        _login_failures.clear()


@router.post("/login", response_model=LoginResponse)
async def login(body: LoginRequest, request: Request):
    """登录（带失败速率限制）"""
    key = _login_rate_key(request, body.username)

    allowed, retry_after = _login_allowed(key)
    if not allowed:
        return JSONResponse(
            status_code=429,
            content={
                "success": False,
                "message": f"登录失败次数过多，请 {retry_after} 秒后再试",
            },
        )

    is_valid, user_id = verify_password(body.username, body.password)
    if is_valid and user_id:
        _reset_login_failures(key)
        token = create_token(user_id)
        config = get_auth_config()
        display_name = config.users[user_id].display_name
        return LoginResponse(success=True, token=token, user_id=user_id, display_name=display_name, message="登录成功")

    _record_login_failure(key)
    return LoginResponse(success=False, message="用户名或密码错误")


@router.post("/auth/verify-password")
async def verify_password_endpoint(request: Request, body: VerifyPasswordRequest):
    """只读校验当前登录用户的密码（引导向导入口一次验证）。

    - 仅接受 user Token；service/device Token 无权验证密码。
    - 校验成功只返回 {"valid": true}，不签发 Token、不回显密码。
    - 失败计数与登录共用 (来源 IP, user_id) 限流，5 次/60 秒。
    """
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        return JSONResponse(
            status_code=401,
            content={"code": "auth_required", "message": "未授权访问，请先登录"},
        )
    token_kind = getattr(request.state, "token_kind", "user")
    if token_kind != "user":
        return JSONResponse(
            status_code=403,
            content={
                "code": "token_kind_forbidden",
                "message": "该 Token 类型无权验证密码",
            },
        )

    key = _login_rate_key(request, user_id)
    allowed, retry_after = _login_allowed(key)
    if not allowed:
        return JSONResponse(
            status_code=429,
            content={
                "code": "rate_limited",
                "message": f"尝试次数过多，请 {retry_after} 秒后再试",
                "retry_after": retry_after,
            },
            headers={"Retry-After": str(retry_after)},
        )

    if check_user_password(user_id, body.password):
        _reset_login_failures(key)
        return {"valid": True}

    _record_login_failure(key)
    return JSONResponse(
        status_code=403,
        content={"code": "password_invalid", "message": "密码错误"},
    )


@router.get("/auth/setup-status")
async def setup_status():
    """查询是否需要首次初始化（公开端点，登录前调用）"""
    return {
        "needs_setup": is_setup_required(),
        "require_token": get_config().setup_require_token,
    }


@router.post("/auth/setup")
async def setup(body: LoginRequest, request: Request):
    """首次初始化：创建第一个用户并返回登录 Token。

    公开端点，仅系统无用户时可用。默认要求一次性引导令牌（Header
    `X-Setup-Token`，由后端首次启动时生成并写入
    `backend/config/.setup_token`，完整令牌在启动日志输出）；将
    auth.setup_require_token 显式设为 false 才会关闭该防护。
    """
    # 已有用户时禁止重复初始化
    if not is_setup_required():
        return JSONResponse(
            status_code=409,
            content={"success": False, "message": "系统已初始化，无法重复设置"},
        )

    # BE-SEC-H2: 抢注防护 —— 仅在开关开启时校验引导令牌
    if get_config().setup_require_token:
        setup_token = request.headers.get("X-Setup-Token", "")
        if not verify_setup_token(setup_token):
            return JSONResponse(
                status_code=403,
                content={"success": False, "message": "引导令牌无效，请在服务器上查看 .setup_token"},
            )

    ok, msg, token = create_first_user(body.username, body.password)
    if not ok:
        return JSONResponse(status_code=400, content={"success": False, "message": msg})

    username = body.username.strip()
    return LoginResponse(
        success=True,
        token=token,
        user_id=username,
        display_name=username,
        message=msg,
    )


@router.post("/auth/change-credentials")
async def change_credentials_endpoint(request: Request, body: ChangeCredentialsRequest):
    """修改当前登录用户的凭据（用户名/密码），需携带有效 Token"""
    # 中间件在认证通过后注入 user_id；缺失视为未授权
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        return JSONResponse(
            status_code=401,
            content={"success": False, "message": "未授权访问，请先登录"},
        )

    ok, msg, token = change_credentials(
        user_id, body.old_password, body.new_username, body.new_password
    )
    if ok:
        # 改名成功时返回最终用户名，未改名则返回原 user_id
        resulting_user_id = (body.new_username or user_id).strip() or user_id
        # 改密时返回新 Token（旧普通 Token 已失效，当前会话据此无缝延续）；
        # 仅改名时为 None，既有 Token 保持有效。
        return {
            "success": True,
            "message": msg,
            "user_id": resulting_user_id,
            "token": token,
        }

    # 用户名冲突返回 409，其余校验类失败返回 400
    status_code = 409 if msg == "用户名已存在" else 400
    return JSONResponse(status_code=status_code, content={"success": False, "message": msg})


@router.post("/auth/ws-ticket")
async def ws_ticket_endpoint(request: Request):
    """签发一次性长连接/文件凭证票据（需 Bearer 认证）。

    用于 <audio>、EventSource、WebSocket 等无法携带 Authorization 头的场景：
    前端先带 Bearer 换取 ticket，再以 `?ticket=<ticket>` 一次性使用（30 秒有效）。
    """
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        return JSONResponse(
            status_code=401,
            content={"success": False, "message": "未授权访问，请先登录"},
        )
    ticket, expires_in = create_ws_ticket(user_id)
    return {"ticket": ticket, "expires_in": expires_in}
