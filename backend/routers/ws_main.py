"""
WebSocket 主路由 - /ws 端点
"""

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
import json
import logging
import uuid
from typing import Optional

from auth import TICKET_SCOPE_GENERIC, verify_token, consume_ws_ticket
from core.redaction import redact_text
from services.component_manager import component_manager

logger = logging.getLogger(__name__)

router = APIRouter()


@router.websocket("/ws")
async def websocket_endpoint(
    websocket: WebSocket,
    token: Optional[str] = None,
    device_id: Optional[str] = None,
    client: Optional[str] = None,
):
    """Main WebSocket endpoint - 支持文本和二进制消息

    握手可选参数：
      - `device_id`：客户端持久化的设备标识（缺省时为本连接生成唯一回退值）
      - `client`：连接类型 `web` | `native`（缺省 `web`）
    """
    client_host = websocket.client.host if websocket.client else "external"

    ws_user_id = None  # WebSocket 关联的 user_id

    # 先验证凭证，未通过则不完成握手，直接以 1008（policy violation）关闭。
    # 优先一次性 ticket（?ticket=），其次兼容 ?token=（BE-SEC-H1）。
    ticket = websocket.query_params.get("ticket") or ""
    if ticket:
        is_valid, ws_user_id = consume_ws_ticket(
            ticket, required_scope=TICKET_SCOPE_GENERIC
        )
    else:
        is_valid, ws_user_id = verify_token(token or "")
    if not is_valid:
        await websocket.close(code=1008)
        return

    # 设备维度注册：同一 device_id 可同时存在 web / native 两条连接
    resolved_device_id = device_id or f"ws-{uuid.uuid4().hex[:8]}"
    resolved_client_type = "native" if (client or "").strip().lower() == "native" else "web"

    await websocket.accept()
    component_manager.add_ws_client(
        websocket,
        user_id=ws_user_id,
        device_id=resolved_device_id,
        client_type=resolved_client_type,
    )

    try:
        await websocket.send_json({
            "type": "connected",
            "message": "WebSocket connected"
        })

        await websocket.send_json({
            "type": "initial_state",
            "components": component_manager.get_all(user_id=ws_user_id)
        })

        while True:
            # 接收消息（支持文本和二进制）
            message = await websocket.receive()

            # 忽略内部断开事件（Starlette 有时会下发 websocket.disconnect）
            if isinstance(message, dict) and message.get("type") == "websocket.disconnect":
                break

            # 调试：记录首次收到的消息类型
            if not hasattr(websocket_endpoint, '_first_msg_logged'):
                websocket_endpoint._first_msg_logged = True
                logger.info(f"[WS] 首次收到消息，类型: {message.get('type', 'unknown')}, keys: {list(message.keys())}")

            if "text" in message:
                # 文本消息（JSON控制消息）
                try:
                    data = json.loads(message["text"])
                    await handle_ws_message(websocket, data, ws_user_id)
                except json.JSONDecodeError:
                    await websocket.send_json({
                        "type": "error",
                        "message": "Invalid JSON"
                    })

            else:
                raw_bytes = message.get("bytes") if isinstance(message, dict) else None
                logger.warning(
                    "[WS] 收到未知类型消息: type=%s bytes=%d",
                    message.get("type", "unknown") if isinstance(message, dict) else type(message).__name__,
                    len(raw_bytes) if isinstance(raw_bytes, (bytes, bytearray)) else 0,
                )

        # 连接结束，清理
        component_manager.remove_ws_client(websocket)

    except WebSocketDisconnect:
        component_manager.remove_ws_client(websocket)
        logger.info("[WS] WebSocket disconnected")
    except Exception as e:
        logger.error("[WS] WebSocket error: %s", redact_text(str(e)))
        component_manager.remove_ws_client(websocket)


async def handle_ws_message(websocket: WebSocket, message: dict, user_id: Optional[str] = None):
    """Handle WebSocket message"""
    msg_type = message.get("type")

    if msg_type == "ping":
        await websocket.send_json({"type": "pong"})

    elif msg_type == "get_components":
        await websocket.send_json({
            "type": "components_list",
            "components": component_manager.get_all(user_id=user_id)
        })

    # 注：terminal_input 分支已移除。
    # 终端会话（TerminalProcess）依赖 PowerShell 交互式进程，但全仓库已无任何
    # 创建终端会话的调用方，该分支始终是 no-op；删除以收敛潜在的命令执行面。

    elif msg_type in ("audio_start", "audio_stop", "force_wake", "force_sleep"):
        # 阶段 0 清理：这些分支依赖已删除的旧语音服务（VAD+ASR），走到即 ImportError。
        # 语音链路已迁移到 /ws/audio-stream，此处仅显式回执，不再加载该模块。
        logger.warning("[WS] 收到已下线的语音消息类型: %s", msg_type)
        await websocket.send_json({
            "type": "error",
            "message": f"消息类型已下线（语音链路请使用 /ws/audio-stream）: {msg_type}"
        })

    elif msg_type == "tts_playback_complete":
        # 阶段 0 清理：原实现依赖已删除的 stt 路由，属死分支；显式忽略。
        logger.debug("[WS] 忽略 tts_playback_complete（continue_chat 流程已下线）")

    else:
        await websocket.send_json({
            "type": "error",
            "message": f"Unknown message type: {msg_type}"
        })
