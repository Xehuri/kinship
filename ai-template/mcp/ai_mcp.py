#!/usr/bin/env python3
"""
MCP Server for {项目名称}.

This server provides tools to interact with the backend AI system:
phone notifications, reminders, and TTS voice synthesis.

API Base: https://localhost:8768  (后端 HTTPS，端口从 config.yaml 读取)
WebSocket: wss://localhost:8768/ws

认证：优先读取 backend/config/auth.json 中的长期 service token（kind="service"），
若不存在则回退到 config.yaml 的 auth 用户名/密码登录（兼容旧配置）。
"""

from typing import Optional
from enum import Enum
import json
import threading
import time
import ssl
import httpx
from pydantic import BaseModel, Field, ConfigDict
from mcp.server.fastmcp import FastMCP

# Initialize MCP server
mcp = FastMCP("ai_mcp")

# Constants
# 从 config.yaml 读取端口
# ai_mcp.py 在 ai/mcp/ 下，需要上3层到项目根
import os
import yaml
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# 后端实际加载的是项目根 config.yaml（backend/config/config.yaml 不存在）
_CONFIG_PATH = os.path.join(_PROJECT_ROOT, "config.yaml")
try:
    with open(_CONFIG_PATH, "r", encoding="utf-8") as f:
        _cfg = yaml.safe_load(f)
    _PORT = _cfg.get("server", {}).get("https_port", 8768)
except Exception:
    _PORT = 8768  # 默认（与后端 config.yaml https_port 一致）

AGENT_API_BASE_URL = f"https://localhost:{_PORT}"

# 自定义 SSL context：信任自签名证书（httpx verify=False 在部分 Python 版本上 SSL 握手失败）
_INSECURE_SSL_CTX = ssl.create_default_context()
_INSECURE_SSL_CTX.check_hostname = False
_INSECURE_SSL_CTX.verify_mode = ssl.CERT_NONE

# 认证头缓存 + 过期时间（token 有效期 24h，提前 1h 刷新）
_AUTH_HEADERS_CACHE = None      # None=未尝试, {}=失败不缓存, 正常={"Authorization":..."}
_AUTH_HEADERS_LOCK = threading.Lock()
_AUTH_TOKEN_EXPIRY = 0.0        # token 过期时间戳

def _load_service_token() -> str:
    """从 backend/config/auth.json 读取长期 service token。

    优先选择 kind=="service" 的 token；若存在多个则取 expires_at 最晚的一个。
    没有 service token 时回退到 expires_at 最晚的任意 token；都没有则返回 ""。
    读取失败（文件不存在/JSON 损坏/IO 错误）返回 ""。
    """
    _auth_path = os.path.join(_PROJECT_ROOT, "backend", "config", "auth.json")
    try:
        with open(_auth_path, "r", encoding="utf-8") as f:
            _auth = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return ""
    _tokens = _auth.get("tokens", {})
    if not _tokens:
        return ""
    _service = [(tid, t) for tid, t in _tokens.items() if t.get("kind") == "service"]
    _pool = _service if _service else list(_tokens.items())
    # 取 expires_at 最晚的一条
    _best_id, _best = max(_pool, key=lambda kv: kv[1].get("expires_at", ""))
    return _best_id


def _get_auth_headers(force_refresh: bool = False) -> dict:
    """获取认证头，自动登录 + 过期刷新，失败不缓存永久"""
    global _AUTH_HEADERS_CACHE, _AUTH_TOKEN_EXPIRY
    # 有未过期 token 则直接返回
    if not force_refresh and _AUTH_HEADERS_CACHE and time.time() < _AUTH_TOKEN_EXPIRY:
        return _AUTH_HEADERS_CACHE
    with _AUTH_HEADERS_LOCK:
        if not force_refresh and _AUTH_HEADERS_CACHE and time.time() < _AUTH_TOKEN_EXPIRY:
            return _AUTH_HEADERS_CACHE
        # 优先使用 backend/config/auth.json 中的长期 service token
        _service_token = _load_service_token()
        if _service_token:
            _AUTH_HEADERS_CACHE = {"Authorization": f"Bearer {_service_token}"}
            _AUTH_TOKEN_EXPIRY = time.time() + 82800  # 23h
            return _AUTH_HEADERS_CACHE
        # 回退：config.yaml 用户名/密码登录（兼容旧配置）
        try:
            _username = _cfg.get("auth", {}).get("username", "")
            _password = _cfg.get("auth", {}).get("password", "")
            if _username and _password:
                with httpx.Client(transport=httpx.HTTPTransport(verify=_INSECURE_SSL_CTX), timeout=10) as _cli:
                    _resp = _cli.post(f"{AGENT_API_BASE_URL}/login",
                        json={"username": _username, "password": _password})
                if _resp.status_code == 200:
                    _token = _resp.json().get("token", "")
                    if _token:
                        _AUTH_HEADERS_CACHE = {"Authorization": f"Bearer {_token}"}
                        _AUTH_TOKEN_EXPIRY = time.time() + 82800  # 23h（token实际24h）
                        return _AUTH_HEADERS_CACHE
        except Exception:
            pass
    # 返回空但不缓存失败，下次调用重新尝试
    return {}

def _clear_auth_cache():
    """强制清除认证缓存（401时调用）"""
    global _AUTH_HEADERS_CACHE, _AUTH_TOKEN_EXPIRY
    _AUTH_HEADERS_CACHE = None
    _AUTH_TOKEN_EXPIRY = 0.0


# ============ Enums ============

class ResponseFormat(str, Enum):
    """Output format for tool responses."""
    MARKDOWN = "markdown"
    JSON = "json"


# ============ Shared Utilities ============

async def _make_api_request(
    endpoint: str,
    method: str = "GET",
    json_data: Optional[dict] = None,
    params: Optional[dict] = None,
    base_url: str = AGENT_API_BASE_URL
) -> dict:
    """Reusable function for all API calls. 自动处理401→重登录→重试。"""
    response = None
    for attempt in range(2):  # 最多重试1次
        transport = httpx.AsyncHTTPTransport(verify=_INSECURE_SSL_CTX)
        async with httpx.AsyncClient(transport=transport, timeout=30.0, headers=_get_auth_headers(force_refresh=(attempt > 0))) as client:
            url = f"{base_url}{endpoint}"
            response = await client.request(
                method,
                url,
                json=json_data,
                params=params
            )
            if response.status_code == 401 and attempt == 0:
                _clear_auth_cache()
                continue  # 清除缓存后重试
            response.raise_for_status()
            return response.json()
    # 重试后仍然401
    assert response is not None
    raise httpx.HTTPStatusError("401 after retry", request=response.request, response=response)


def _handle_api_error(e: Exception) -> str:
    """Consistent error formatting across all tools."""
    if isinstance(e, httpx.HTTPStatusError):
        if e.response.status_code == 401:
            return "Error: Authentication failed. Token may be expired."
        elif e.response.status_code == 404:
            return "Error: Resource not found. Please check the ID is correct."
        elif e.response.status_code == 403:
            return "Error: Permission denied. You don't have access to this resource."
        elif e.response.status_code == 429:
            return "Error: Rate limit exceeded. Please wait before making more requests."
        elif e.response.status_code == 500:
            return f"Error: Server error. The backend may not be running on localhost:{_PORT}."
        return f"Error: API request failed with status {e.response.status_code}"
    elif isinstance(e, httpx.ConnectError):
        return f"Error: Cannot connect to backend. Make sure the backend is running on https://localhost:{_PORT}"
    elif isinstance(e, httpx.TimeoutException):
        return "Error: Request timed out. Please try again."
    return f"Error: Unexpected error occurred: {type(e).__name__}"


# ── 手机 App 通知工具 ────────────────────────────

class NotificationInput(BaseModel):
    """发送手机通知的输入参数"""
    model_config = ConfigDict(extra="forbid")
    
    title: str = Field(..., description="通知标题，如'系统提醒'、'任务完成'")
    content: str = Field(..., description="通知正文，简要说明通知内容")
    
    response_format: ResponseFormat = Field(
        default=ResponseFormat.MARKDOWN,
        description="输出格式 (markdown/json)"
    )


@mcp.tool(
    name="send_notification",
    annotations={
        "title": "Send Phone Notification",
        "readOnlyHint": False,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True
    }
)
async def send_notification(params: NotificationInput) -> str:
    """给用户的手机发送一条系统通知。
    
    当你想提醒用户重要事项、系统状态、任务完成、倒计时等场景时使用。
    通知会推送至用户的 Android 手机并在通知栏显示。
    
    Args:
        params (NotificationInput): Validated input containing:
            - title: 通知标题 (required)
            - content: 通知正文 (required)
    
    Returns:
        str: 通知发送结果。
    """
    try:
        data = await _make_api_request(
            "/api/notification/send",
            method="POST",
            json_data={"title": params.title, "content": params.content},
            base_url=AGENT_API_BASE_URL
        )
        
        if params.response_format == ResponseFormat.JSON:
            return json.dumps(data, indent=2, ensure_ascii=False)
        
        status = data.get("status", "error")
        if status in ("ok", "sent"):
            return f"通知已发送: {params.title}"
        else:
            return f"通知发送失败: {data.get('message', '未知错误')}"
    
    except Exception as e:
        return _handle_api_error(e)


# ── AI 提醒板工具（v2 单文本板）─────────────────────
# 后端持久化存储（users/{user}/reminders.json，重启不丢），
# Android 桌面小部件轮询 GET /api/reminders 滚动渲染全文。
# 领域模型 = 每用户一块常驻文本板：无条目 id、无完成/删除生命周期，
# 标准工作流 = list_reminders 读全文 → 编辑 → send_reminder 整块覆盖（空串=清空）。
# 用户身份由服务端按认证 token 推导，此处不传 user_id。

# 全文上限（字符）：去首尾空白后校验，与后端 reminders_store.MAX_TEXT_LEN 保持一致
# （ai_mcp 为独立进程脚本，不 import 后端模块，数值在此单点重复并注明来源）
MAX_BOARD_TEXT_LEN = 2000


def _fmt_board_ts(ts) -> str:
    """unix 秒 → 可读时刻字符串（非法值回退原始字符串，绝不让渲染崩溃）。"""
    try:
        return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(int(ts)))
    except (TypeError, ValueError, OSError):
        return str(ts)


class ReminderSendInput(BaseModel):
    """整块覆盖提醒板的输入参数"""
    model_config = ConfigDict(extra="forbid")

    text: str = Field(
        ...,
        description=(
            f"提醒板全文（整块覆盖；去首尾空白后上限 {MAX_BOARD_TEXT_LEN} 字符；"
            "空串 = 清空整块提醒板）"
        ),
    )

    response_format: ResponseFormat = Field(
        default=ResponseFormat.MARKDOWN,
        description="输出格式 (markdown/json)"
    )


@mcp.tool(
    name="send_reminder",
    annotations={
        "title": "Overwrite Reminder Board",
        "readOnlyHint": False,
        "destructiveHint": False,
        "idempotentHint": False,
        "openWorldHint": True
    }
)
async def send_reminder(params: ReminderSendInput) -> str:
    """整块覆盖写入桌面"AI 提醒"板（单一文本板模型）。

    标准工作流：先用 list_reminders 读当前全文 → 在其基础上编辑（增改删）→
    send_reminder 写回整段（传空串 "" = 清空提醒板）。
    本工具是全量覆盖：没包含进 text 的旧内容会直接消失，务必先读后写。
    提醒板没有逐条完成/删除操作——"读-改-写回"循环就是它的整个生命周期。

    当用户让你记住某件事、交代待办、或要求增改删提醒内容时使用。
    与 send_notification 的区别：通知是一次性推送，提醒板是长期可见的当前待办全文。

    Args:
        params (ReminderSendInput): Validated input containing:
            - text: 提醒板全文 (required，整块覆盖)

    Returns:
        str: 写入结果（"提醒板已更新（时刻）"或"已清空"）或 JSON。
    """
    try:
        data = await _make_api_request(
            "/api/reminders",
            method="POST",
            json_data={"text": params.text},
            base_url=AGENT_API_BASE_URL
        )

        if params.response_format == ResponseFormat.JSON:
            return json.dumps(data, indent=2, ensure_ascii=False)

        if "text" not in data:
            return f"提醒板写入失败: {data.get('detail', data.get('message', '未知错误'))}"
        if data["text"] == "":
            return "提醒板已清空"
        return f"提醒板已更新（{_fmt_board_ts(data.get('updated_at', 0))}）"

    except Exception as e:
        return _handle_api_error(e)


class ReminderListInput(BaseModel):
    """读取提醒板的输入参数（v2：板只有一块，无任何过滤参数）"""
    model_config = ConfigDict(extra="forbid")

    response_format: ResponseFormat = Field(
        default=ResponseFormat.MARKDOWN,
        description="输出格式 (markdown/json)"
    )


@mcp.tool(
    name="list_reminders",
    annotations={
        "title": "Read Reminder Board",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True
    }
)
async def list_reminders(params: ReminderListInput) -> str:
    """读取当前用户"AI 提醒"板的全文（单一文本板，v1 清单/状态过滤已废除）。

    标准工作流第一步：send_reminder 整块覆盖之前必须先经本工具读回当前全文，
    在其基础上编辑后整段写回——否则没写回的旧内容会丢失。
    用户问"我现在的提醒/待办有哪些"时也用它。

    Args:
        params (ReminderListInput): Validated input containing:
            - response_format: markdown/json (optional)

    Returns:
        str: markdown 模式 = 围栏代码块原样包裹板内全文 + updated_at 行；
        JSON 模式 = 后端原始信封 {"text","updated_at"}。
    """
    try:
        data = await _make_api_request(
            "/api/reminders",
            method="GET",
            base_url=AGENT_API_BASE_URL
        )

        if params.response_format == ResponseFormat.JSON:
            return json.dumps(data, indent=2, ensure_ascii=False)

        text = data.get("text", "")
        ts = data.get("updated_at", 0)
        if not text:
            return f"提醒板当前为空（updated_at={ts}）"
        return (
            f"提醒板全文（updated_at={ts}，{_fmt_board_ts(ts)}）:\n"
            f"```\n{text}\n```"
        )

    except Exception as e:
        return _handle_api_error(e)


# ── TTS 语音合成工具 ─────────────────────────────

class TtsSpeakInput(BaseModel):
    """TTS语音合成输入参数"""
    model_config = ConfigDict(extra="forbid")
    
    text: str = Field(..., description="要朗读的文本内容")
    voice: str = Field(default="mimo_default", description="音色，默认mimo_default")
    style: Optional[str] = Field(default=None, description="风格，如开心、悲伤、东北话等")
    user_id: Optional[str] = Field(default=None, description="目标用户ID，不传则广播给所有用户")
    
    response_format: ResponseFormat = Field(
        default=ResponseFormat.MARKDOWN,
        description="输出格式 (markdown/json)"
    )


@mcp.tool(
    name="tts_speak",
    annotations={
        "title": "TTS Speak - Voice Synthesis",
        "readOnlyHint": False,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True
    }
)
async def tts_speak(params: TtsSpeakInput) -> str:
    """使用TTS语音合成并播放文本。
    
    当需要语音回复用户时使用此工具。
    工具在成功发送请求后立即返回，不等待播放完成。
    说话人会听到这段语音。
    
    Args:
        params (TtsSpeakInput): Validated input containing:
            - text: 要朗读的文本内容 (required)
            - voice: 音色，默认mimo_default (optional)
            - style: 风格，如开心、悲伤、东北话等 (optional)
            - user_id: 目标用户ID，不传则广播给所有用户 (optional)
    
    Returns:
        str: TTS语音发送结果。
    """
    try:
        payload = {
            "text": params.text,
            "voice": params.voice or "mimo_default",
            "send_audio": True
        }
        if params.style:
            payload["style"] = params.style
        if params.user_id:
            payload["user_id"] = params.user_id
        
        data = await _make_api_request(
            "/api/screen/tts/speak",
            method="POST",
            json_data=payload,
            base_url=AGENT_API_BASE_URL
        )
        
        if params.response_format == ResponseFormat.JSON:
            return json.dumps(data, indent=2, ensure_ascii=False)
        
        if data.get("status") in ("ok", "sent"):
            preview = params.text[:50] + ("..." if len(params.text) > 50 else "")
            return f"TTS语音已成功发送: \"{preview}\""
        else:
            return f"TTS发送失败: {data.get('message', '未知错误')}"
    
    except Exception as e:
        return _handle_api_error(e)


# ============ Main Entry ============

if __name__ == "__main__":
    mcp.run()
