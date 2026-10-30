# -*- coding: utf-8 -*-
"""配置写入授权：常规模式密码二次校验，引导模式强制引导令牌。"""
import logging
from dataclasses import dataclass
from typing import Literal

from fastapi import Request
from fastapi.responses import JSONResponse

import auth

logger = logging.getLogger(__name__)

SETUP_USER_ID = "__setup__"


def _is_bootstrap_mode() -> bool:
    """系统是否处于首次启动引导模式（尚无任何用户）。

    唯一判据是用户存在性：配置对象是否 UNCONFIGURED、auth.setup_require_token
    是否开启都不参与判定。用户已存在时即使配置降级也走常规密码路径。
    """
    return bool(auth.is_setup_required())


@dataclass
class ConfigWriteAuth:
    user_id: str
    method: Literal["password", "setup_token"]
    token_kind: str


@dataclass
class ConfigReadAuth:
    user_id: str
    token_kind: str


class ConfigAuthError(Exception):
    status_code: int
    code: str
    message: str

    def __init__(self, status_code: int, code: str, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


def config_auth_error_response(exc: ConfigAuthError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"code": exc.code, "message": exc.message},
    )


def _read_existing_setup_token() -> str:
    """读取既有引导令牌文件内容；文件不存在或不可读时返回空串。"""
    try:
        with open(auth.SETUP_TOKEN_FILE, "r", encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


def ensure_bootstrap_token() -> str:
    """启动时确保引导模式下的 setup token 已生成。

    返回令牌文件路径。引导模式下完整令牌只写入一条 INFO 启动日志
    （来源=文件/新生成），供管理员在服务器上查看；HTTP 路径不返回也不
    记录令牌。存在用户时返回空串，也不触碰令牌文件。
    """
    if not auth.is_setup_required():
        return ""
    existing = _read_existing_setup_token()
    token = auth.get_or_create_setup_token()
    if not token:
        return ""
    source = "文件" if existing and existing == token else "新生成"
    logger.info(
        "[Auth] 初始化令牌（首次配置用，配置完成后失效，来源=%s）: %s",
        source,
        token,
    )
    return auth.SETUP_TOKEN_FILE


async def require_config_read(request: Request) -> ConfigReadAuth:
    """配置读取授权：引导模式放行，已有用户时仅接受 user Token（免密码）。"""
    if _is_bootstrap_mode():
        return ConfigReadAuth(user_id=SETUP_USER_ID, token_kind="setup")

    token_kind = getattr(request.state, "token_kind", "user")
    if token_kind != "user":
        raise ConfigAuthError(403, "token_kind_forbidden", "该 Token 类型无权读取配置")

    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        raise ConfigAuthError(401, "auth_required", "未授权访问，请先登录")

    return ConfigReadAuth(user_id=user_id, token_kind="user")


async def require_config_write(
    request: Request,
    password: str | None = None,
) -> ConfigWriteAuth:
    if _is_bootstrap_mode():
        token = request.headers.get("X-Setup-Token") or ""
        if not token.strip():
            raise ConfigAuthError(
                403, "setup_token_required", "需要提供引导令牌（X-Setup-Token）"
            )
        if not auth.verify_setup_token(token):
            raise ConfigAuthError(403, "setup_token_invalid", "引导令牌无效")
        return ConfigWriteAuth(
            user_id=SETUP_USER_ID, method="setup_token", token_kind="setup"
        )

    token_kind = getattr(request.state, "token_kind", "user")
    if token_kind != "user":
        raise ConfigAuthError(403, "token_kind_forbidden", "该 Token 类型无权修改配置")

    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        raise ConfigAuthError(401, "auth_required", "未授权访问，请先登录")

    if not password:
        raise ConfigAuthError(403, "password_required", "修改配置需要验证密码")

    ok, resolved_user = auth.verify_password(user_id, password)
    if not ok:
        raise ConfigAuthError(403, "password_invalid", "密码错误")

    return ConfigWriteAuth(
        user_id=resolved_user or user_id, method="password", token_kind="user"
    )
