# -*- coding: utf-8 -*-
"""把 Kinship 后端内部地址 + 长期 service token 推给 dsh bridge（工具回调凭据）。

dsh 侧原生工具（通知 / 提醒板 / TTS）需要回调 Kinship 后端。bridge 新增
``POST /v1/kinship/tool-auth`` 收一次推送后把 base_url/token 只放内存（不落盘，
GET 只回脱敏状态），工具调用时据此拼回后端请求——后端在生命周期点主动推送，
dsh 侧无需任何显式配置。

契约（bridge 路由由 dsh 侧并行落地，本模块只从调用方一侧钉形状）：

    POST {DSH_URL}/v1/kinship/tool-auth
    Authorization: Bearer <dsh.token>（与 /v1/kinship/paths 同一鉴权）
    {"schema":1,"base_url":"https://127.0.0.1:8768","token":"<service token>",
     "source":"kinship-backend","generated_at":<epoch ms>}
    200 -> {"ok":true,...}；非 200 视为失败。

行为约定：
- **token 经 ``auth.ensure_service_token()`` 幂等取得**（已存在即原样返回；尚无
  用户时返回 None）。取不到 token 时**绝不发请求**：不伪造、不空串发送，结果
  ``ok=False`` 且 ``error="service_token_missing"``。
- **base_url 恒指本机回环**：host 固定 127.0.0.1（bridge 与后端同机），端口与
  scheme 取实际监听设置——scheme 直接复用 ``core.hot_server`` 的监听判定，
  「ssl.enabled 打开但证书/私钥文件缺失时按 HTTP 监听」的回退语义在那里是唯一
  实现，本模块不复制一份判定，避免两处口径漂移；handler 始终与真实监听一致。
- **永不抛**：``push_tool_auth`` 把一切异常（传输/构造/配置）收成
  ``{"ok": False, "error": ...}``；失败详情过 ``core.redaction.redact_text``，
  并把本次 token 字面量再兜底抹掉——**token 绝不进日志、绝不进错误串**。
- **合并**：与 dsh_paths 同款——同一在途任务期间或 1 秒内的连续调用只产生一次
  推送；无运行中事件循环（同步脚本/测试上下文）时 no-op，只记 debug。
- 诊断面 ``last_push()`` 只回状态（reason/status/at/error），**不含 token**。
"""

import asyncio
import json
import logging
import time
from typing import Any, Dict, Optional

from core.redaction import redact_text
from services.dsh_client import get_dsh_client

logger = logging.getLogger(__name__)

PAYLOAD_SCHEMA = 1
SOURCE = "kinship-backend"
# bridge 与后端同机：回调只会走回环，不暴露网卡地址
TOOL_HOST = "127.0.0.1"
# 合并窗口：启动期多个钩子在同一秒内连发，只保留首个 reason
MIN_INTERVAL_S = 1.0
# 无 service token（尚未建号）时的结果错误码：调用方按此判定“不需要重试”
SERVICE_TOKEN_MISSING = "service_token_missing"

_last_push: Optional[Dict[str, Any]] = None
_task: Optional[asyncio.Task] = None
_scheduled_at: Optional[float] = None


def _now_ms() -> int:
    """当前墙钟毫秒（契约字段 generated_at/at 的单位）。"""
    return int(time.time() * 1000)


def _base_url() -> str:
    """本机回环 base_url：host 固定 127.0.0.1，端口/scheme 取实际监听设置。

    监听设置复用 ``core.hot_server.read_listener_settings()``（纯配置读取）：
    它已包含 ssl.enabled + 证书/私钥文件存在性 + 端口合法性的完整回退语义，
    这里只把 host 覆盖为回环——bridge 与后端同机，回环地址不会因网卡/防火墙
    配置而失效。
    """
    from core.hot_server import read_listener_settings

    settings = read_listener_settings()
    scheme = "https" if settings.ssl_enabled else "http"
    return f"{scheme}://{TOOL_HOST}:{settings.port}"


def _service_token() -> Optional[str]:
    """长期 service token；无用户/空串一律归 None（不伪造、不空串发送）。

    惰性导入 auth：保持本模块 import 面纯净（auth 侧有文件锁与持久化逻辑），
    且测试可经 ``auth.ensure_service_token`` 单点注入。
    """
    from auth import ensure_service_token

    token = ensure_service_token()
    return token if isinstance(token, str) and token else None


def build_tool_auth_payload() -> Dict[str, Any]:
    """按当前配置构造推送体（只读配置/文件存在性，不发请求、不写日志）。

    ``token`` 在无可用 service token 时为 None——调用方必须先判空再发送；
    本函数绝不填占位符或空串（空串会被 dsh 侧当成合法凭据存下来）。
    """
    return {
        "schema": PAYLOAD_SCHEMA,
        "base_url": _base_url(),
        "token": _service_token(),
        "source": SOURCE,
        "generated_at": _now_ms(),
    }


def _error_detail(status: int, body: Any) -> str:
    """失败详情：状态码 + 截断 body，统一过 redact（凭据形态不外泄）。"""
    if isinstance(body, str):
        text = body
    else:
        try:
            text = json.dumps(body, ensure_ascii=False)
        except (TypeError, ValueError):
            text = str(body)
    return redact_text(f"HTTP {status}: {text[:300]}")


def _scrub_token(text: str, token: Optional[str]) -> str:
    """兜底抹掉本次 token 字面量。

    redact_text 覆盖 Authorization 头/查询凭据等已知形态，但不认识“裸 token
    被原样拼进异常消息”（例如第三方库把请求体打进 repr）；这里按本次实际值
    再替换一次，保证任何异常文本都不会带走凭据。
    """
    if token:
        text = text.replace(token, "***")
    return text


def _remember(result: Dict[str, Any]) -> None:
    global _last_push
    _last_push = dict(result)


async def push_tool_auth(reason: str) -> Dict[str, Any]:
    """推送一次工具回调凭据；返回 ``{"ok","status","reason","error","at"}``，绝不抛。

    reason 只作诊断标签（boot/ai_surface/health/setup），不影响载荷。无 service
    token 时直接返回 ``ok=False, error=service_token_missing``，**不发 HTTP**；
    bridge 未起/401/非 200/传输异常一律 ok=False + 脱敏 detail，由调用方决定
    是否刷屏——本函数自身只打一条 warning（成功为 info，且只记 base_url）。
    """
    at = _now_ms()
    token: Optional[str] = None
    try:
        payload = build_tool_auth_payload()
        token = payload.get("token")
        if not token:
            result: Dict[str, Any] = {
                "ok": False,
                "status": None,
                "reason": reason,
                "error": SERVICE_TOKEN_MISSING,
                "at": at,
            }
            _remember(result)
            logger.warning(
                "[DshToolAuth] 无 service token，跳过推送 reason=%s", reason
            )
            return result
        client = get_dsh_client()
        status, body, _headers = await client.push_tool_auth(payload)
    except Exception as e:
        error = _scrub_token(redact_text(str(e)), token)
        result = {
            "ok": False,
            "status": None,
            "reason": reason,
            "error": error,
            "at": at,
        }
        _remember(result)
        logger.warning("[DshToolAuth] push failed reason=%s: %s", reason, error)
        return result

    ok = status == 200
    error = None if ok else _scrub_token(_error_detail(status, body), token)
    result = {"ok": ok, "status": status, "reason": reason, "error": error, "at": at}
    _remember(result)
    if ok:
        logger.info("[DshToolAuth] pushed base_url=%s reason=%s", payload["base_url"], reason)
    else:
        logger.warning("[DshToolAuth] push failed reason=%s: %s", reason, error)
    return result


async def _run(reason: str) -> None:
    """任务体：push_tool_auth 自身永不抛，这里只兜底不可预期异常，防孤儿告警。"""
    try:
        await push_tool_auth(reason)
    except Exception as e:  # pragma: no cover - push_tool_auth 已收敛全部异常
        logger.warning(
            "[DshToolAuth] push task crashed reason=%s: %s",
            reason,
            redact_text(str(e)),
        )


def schedule_push(reason: str) -> None:
    """fire-and-forget 推送调度（同步入口，交给当前事件循环执行）。

    - 无运行中事件循环（同步工具/测试/脚本上下文）：no-op，只记 debug；
    - 已有在途任务，或距上次调度不足 ``MIN_INTERVAL_S``：合并掉本次调用；
    - 否则在当前循环 create_task，结果只进日志与 ``last_push()``。
    """
    global _task, _scheduled_at
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        logger.debug("[DshToolAuth] no running loop, skip push reason=%s", reason)
        return
    if _task is not None and not _task.done():
        logger.debug("[DshToolAuth] push in flight, coalesce reason=%s", reason)
        return
    now = time.monotonic()
    if _scheduled_at is not None and now - _scheduled_at < MIN_INTERVAL_S:
        logger.debug(
            "[DshToolAuth] push coalesced (<%.1fs) reason=%s", MIN_INTERVAL_S, reason
        )
        return
    _scheduled_at = now
    _task = loop.create_task(_run(reason), name=f"dsh-tool-auth-push:{reason}")


def last_push() -> Optional[Dict[str, Any]]:
    """最近一次推送结果快照（诊断用，不含 token）；从未推送返回 None。"""
    return dict(_last_push) if _last_push is not None else None


def _reset_state() -> None:
    """清空模块状态（仅测试用）。"""
    global _last_push, _task, _scheduled_at
    _last_push = None
    _task = None
    _scheduled_at = None
