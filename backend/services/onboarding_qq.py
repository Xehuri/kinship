# -*- coding: utf-8 -*-
"""QQ 网关引导服务：只落配置与密钥文件，不启动网关。

边界：

- 校验阶段只读当前配置，不创建目录、不写文件、不探测网络。
- 应用阶段只调用 ``ConfigStore.save`` 一次；token 写入独立文件并记录
  ``*_file`` 绝对路径，绝不把 token 明文写回 ``config.yaml``。
- 响应/异常只含字段名与可读消息，不含 token 内容或 token 文件路径。
- 本模块不导入、不实例化 ``QQGatewayService``，网关要等引导 finish 后由
  launcher/lifespan 激活。
"""
from __future__ import annotations

import copy
import secrets
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Optional

from pydantic import BaseModel, ConfigDict, StrictBool, StrictInt, StrictStr, ValidationError

from config.paths import data_root, project_root
from config.store import get_config_store
from services.onboarding_secrets import (
    read_secret,
    secrets_directory,
    write_secret,
)
from services.qq_gateway.config import QQGatewayConfig

QQ_WS_TOKEN_FILENAME = "qq_ws_token"
QQ_MCP_TOKEN_FILENAME = "qq_mcp_token"

# 校验用的占位 token：mcp 启用但尚未生成 token 时，避免在写盘前误报。
_MCP_TOKEN_PLACEHOLDER = "__generated_on_apply__"
_COMPATIBLE_WS_SCHEMES = ("ws://", "wss://")


@dataclass(frozen=True)
class QQOnboardingPlan:
    """一次校验/应用所需的规范化结果。"""

    enabled: bool
    self_qq: str
    ws_url: str
    ws_token: Optional[str]
    regenerate_mcp_token: bool
    current_raw: dict[str, Any]


class QQConfigInvalid(Exception):
    """校验失败；``errors`` 为可安全外发的 ``[{field, message}]``。"""

    def __init__(self, errors: list[dict[str, str]]) -> None:
        super().__init__("QQ 网关配置无效")
        self.errors = errors


def _err(field: str, message: str) -> dict[str, str]:
    return {"field": field, "message": message}


class _QQPayload(BaseModel):
    model_config = ConfigDict(extra="ignore", frozen=True)

    enabled: StrictBool | None = None
    self_qq: StrictStr | StrictInt | None = None
    ws_url: StrictStr | None = None
    ws_token: StrictStr | None = None
    regenerate_mcp_token: StrictBool | None = None


def _current_raw() -> dict[str, Any]:
    """当前 qq_gateway 原始节（含 schema 默认值），副本可安全修改。"""
    snapshot = get_config_store().snapshot()
    section = snapshot.get("qq_gateway")
    return copy.deepcopy(section) if isinstance(section, Mapping) else {}


def _as_mapping(raw: Any) -> dict[str, Any]:
    return dict(raw) if isinstance(raw, Mapping) else {}


def _parse_payload(raw: Any) -> tuple[Optional[_QQPayload], list[dict[str, str]]]:
    if not isinstance(raw, Mapping):
        return None, [_err("body", "请求体必须是 JSON 对象")]
    try:
        parsed = _QQPayload.model_validate(dict(raw))
    except ValidationError as exc:
        errors = [
            _err(
                ".".join(str(part) for part in item.get("loc") or ()) or "body",
                "参数类型无效",
            )
            for item in exc.errors()
        ]
        return None, errors
    return parsed, []


def _error_field(problem: str) -> str:
    """从 QQGatewayConfig.validate 的可读消息提取稳定字段名。"""
    head = problem.split(" ", 1)[0].split("=", 1)[0]
    if head.startswith("qq_gateway."):
        head = head[len("qq_gateway.") :]
    if head == "account.ws_token":
        return "ws_token"
    if head == "account.ws_url":
        return "ws_url"
    if head == "account.self_qq":
        return "self_qq"
    if head == "mcp.enabled":
        return "mcp.token_file"
    if head.startswith("qzone.mode"):
        return "qzone.allow_read"
    return head or "qq_gateway"


def _dedupe_errors(
    errors: list[dict[str, str]],
) -> list[dict[str, str]]:
    seen: set[tuple[str, str]] = set()
    unique: list[dict[str, str]] = []
    for error in errors:
        key = (error.get("field", ""), error.get("message", ""))
        if key in seen:
            continue
        seen.add(key)
        unique.append(_err(*key))
    return unique


def _prepare(raw_payload: Any) -> tuple[Optional[QQOnboardingPlan], list[dict[str, str]]]:
    payload, errors = _parse_payload(raw_payload)
    if payload is None:
        return None, _dedupe_errors(errors)

    current_raw = _current_raw()
    current = QQGatewayConfig.from_dict(current_raw)
    enabled = current.enabled if payload.enabled is None else payload.enabled
    self_qq = (
        str(payload.self_qq) if payload.self_qq is not None else current.account.self_qq
    ).strip()
    ws_url = (
        payload.ws_url if payload.ws_url is not None else current.account.ws_url
    ).strip()

    prospective = copy.deepcopy(current_raw)
    prospective["enabled"] = enabled
    account = _as_mapping(prospective.get("account"))
    account["self_qq"] = self_qq
    account["ws_url"] = ws_url
    if payload.ws_token:
        account["ws_token"] = payload.ws_token
    prospective["account"] = account

    if enabled:
        if not self_qq.isdigit():
            errors.append(_err("self_qq", "self_qq 必须为纯数字"))
        if not ws_url.startswith(_COMPATIBLE_WS_SCHEMES):
            errors.append(
                _err("ws_url", "ws_url 必须以 ws:// 或 wss:// 开头")
            )

        prospective_config = QQGatewayConfig.from_dict(prospective)
        if prospective_config.mcp.enabled and not prospective_config.mcp.token:
            mcp = _as_mapping(prospective.get("mcp"))
            mcp["token"] = _MCP_TOKEN_PLACEHOLDER
            prospective["mcp"] = mcp

        for problem in QQGatewayConfig.from_dict(prospective).validate():
            errors.append(
                {"field": _error_field(problem), "message": problem}
            )

    plan = QQOnboardingPlan(
        enabled=enabled,
        self_qq=self_qq,
        ws_url=ws_url,
        ws_token=payload.ws_token or None,
        regenerate_mcp_token=bool(payload.regenerate_mcp_token),
        current_raw=current_raw,
    )
    return plan, _dedupe_errors(errors)


def validate_qq_config(raw_payload: Any) -> dict[str, Any]:
    """只做校验，不写任何文件。"""
    _plan, errors = _prepare(raw_payload)
    return {"valid": not errors, "errors": errors}


def _absolute_token_file(raw: str) -> str:
    text = str(raw or "").strip()
    if not text:
        return ""
    path = Path(text).expanduser()
    if not path.is_absolute():
        path = project_root() / path
    return str(path.resolve())


def _write_ws_token(plan: QQOnboardingPlan, changes: dict[str, Any], clear_keys: list[str]) -> None:
    if plan.ws_token:
        target = write_secret(
            secrets_directory(data_root()) / QQ_WS_TOKEN_FILENAME, plan.ws_token
        )
        changes["qq_gateway.account.ws_token_file"] = str(target)
        # 旧版内联 token 优先级高于 token_file；写入新 token 后必须清掉，
        # 否则新文件永远不会被读取。
        if str(_as_mapping(plan.current_raw.get("account")).get("ws_token") or ""):
            clear_keys.append("qq_gateway.account.ws_token")
        return

    current = QQGatewayConfig.from_dict(plan.current_raw)
    existing_file = _absolute_token_file(current.account.ws_token_file)
    if existing_file:
        changes["qq_gateway.account.ws_token_file"] = existing_file


def _write_mcp_token(plan: QQOnboardingPlan, changes: dict[str, Any], clear_keys: list[str]) -> None:
    current = QQGatewayConfig.from_dict(plan.current_raw)
    mcp_raw = _as_mapping(plan.current_raw.get("mcp"))
    legacy_inline = str(mcp_raw.get("token") or "").strip()
    existing_file = _absolute_token_file(current.mcp.token_file)
    existing_file_valid = bool(existing_file and read_secret(existing_file))

    if legacy_inline:
        if plan.regenerate_mcp_token:
            target = secrets_directory(data_root()) / QQ_MCP_TOKEN_FILENAME
            write_secret(target, secrets.token_urlsafe(32))
        elif existing_file_valid:
            target = Path(existing_file)
            write_secret(target, legacy_inline)
        else:
            target = secrets_directory(data_root()) / QQ_MCP_TOKEN_FILENAME
            write_secret(target, legacy_inline)
        changes["qq_gateway.mcp.token_file"] = str(target)
        clear_keys.append("qq_gateway.mcp.token")
        return

    if current.mcp.enabled:
        if existing_file_valid and not plan.regenerate_mcp_token:
            changes["qq_gateway.mcp.token_file"] = existing_file
            return
        target = secrets_directory(data_root()) / QQ_MCP_TOKEN_FILENAME
        write_secret(target, secrets.token_urlsafe(32))
        changes["qq_gateway.mcp.token_file"] = str(target)
        return

    if existing_file:
        changes["qq_gateway.mcp.token_file"] = existing_file


def apply_qq_config(raw_payload: Any) -> dict[str, Any]:
    """校验后一次性写入配置；不启动网关，也不调用配置应用器。"""
    plan, errors = _prepare(raw_payload)
    if plan is None or errors:
        raise QQConfigInvalid(errors or [
            {"field": "body", "message": "请求体必须是 JSON 对象"}
        ])

    if not plan.enabled:
        get_config_store().save({"qq_gateway.enabled": False})
        return inspect_status()

    changes: dict[str, Any] = {
        "qq_gateway.enabled": True,
        "qq_gateway.account.self_qq": plan.self_qq,
        "qq_gateway.account.ws_url": plan.ws_url,
    }
    clear_keys: list[str] = []

    _write_ws_token(plan, changes, clear_keys)
    _write_mcp_token(plan, changes, clear_keys)

    get_config_store().save(changes, clear_keys or None)
    return inspect_status()


def inspect_status() -> dict[str, Any]:
    """脱敏状态：只返回布尔与可读错误，永不返回 token/token_file。"""
    config = QQGatewayConfig.load()
    errors = [
        {"field": _error_field(problem), "message": problem}
        for problem in config.validate()
    ]
    return {
        "enabled": config.enabled,
        "self_qq": config.account.self_qq,
        "ws_url": config.account.ws_url,
        "ws_token_configured": bool(config.account.ws_token),
        "mcp_token_configured": bool(config.mcp.token),
        "valid": not errors,
        "errors": errors,
    }


def qq_finish_errors() -> list[str]:
    """完成引导前的只读检查：未启用=[]；启用时返回可读校验错误。"""
    config = QQGatewayConfig.load()
    if not config.enabled:
        return []
    return list(config.validate())


def password_from_payload(raw_payload: Any) -> Optional[str]:
    """供路由在鉴权前提取 ``current_password``，不参与配置写入。"""
    if not isinstance(raw_payload, Mapping):
        return None
    value = raw_payload.get("current_password")
    return value if isinstance(value, str) else None
