"""
Session Router - API endpoints for session management

从 main.py 和 stt.py 提取的所有会话相关端点。
V6 拍扁：三级栈（router→gateway→client）压成两级（router→client），
handler 直连 opencode_client 信封公共层，一处剥壳直出响应。
W30：web 对话端点（create/message/list/messages/children/summarize/switch）
改经 web_backend_selector 热切换通道，智能体绑定读写走 "<backend>:<agent>"
命名空间；chatlog 保持全局 ai_backend 择路 + 裸键绑定。
W44：/session/list 双源聚合（opencode∪loom∪仅本地，统一归一 + backend 标记 +
partial 降级永不 500）；message/messages/children 增可选 backend 显式路由
（直调通道原语，绝不经全局缝/通道缝）；local_sessions 空回退死键修复
（opencode 真时间字段是 time.created/time.updated ms，顶层 created_at 从不存在）。
W46：/session/switch 通道化+收编——请求可选 backend 定有效通道，本地注册表查无
时向有效通道 engine 核验存在（get_session_status），存在即收编登记并切换，
自报 404 照旧诚实 404、engine 不可达 503；命名键随有效通道（修"写错命名键"）。
"""

import asyncio

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel
from typing import Optional, Dict, Any, List
import logging
import re

# 双通道工厂（ai_backend 择路）：别名保留原符号名，调用点与测试 monkeypatch 缝零改动
# W30 后此缝仅 chatlog 与全局语义使用；web 对话端点改走 web_backend_selector（热切换通道）
from services.ai_client_factory import acquire_ai_client as acquire_opencode_client
from services.web_backend_selector import (
    WEB_BACKEND_OPTIONS,
    acquire_web_client,
    get_web_backend,
    web_agent_key,
)
# W44 显式通道直调原语（显式腿唯一入口）：不经 ai_client_factory 全局缝
# （ai_backend=loom 时该缝返回 loom 单例，显式 opencode 会投错引擎）、
# 不经 acquire_web_client 通道缝（热切换值≠显式请求值）。
from services.opencode_client import acquire_opencode_client as acquire_opencode_client_direct
from services.loom_client import acquire_loom_client as acquire_loom_client_direct
from services.loom_main_session import (
    invalidate_loom_main_cache,
    resolve_loom_main_session,
)
from services.stt_session_manager import get_session_manager
from services.device_channel_store import device_channel_store
from config.config import get_config

logger = logging.getLogger(__name__)

router = APIRouter(prefix="", tags=["session"])


def _unwrap_envelope(result: Dict[str, Any]) -> Any:
    """信封剥壳单点：失败 -> HTTPException(500, detail)。

    错误经 main.py 全局 handler 重塑为 {"success":false,...,"error":{"code":
    "INTERNAL_ERROR","message":detail}}，对外形状与拍扁前逐键一致。
    """
    if not result["ok"]:
        raise HTTPException(status_code=500, detail=result["error"]["detail"])
    return result["data"]


def _web_get_binding(manager, agent: str, backend: str) -> Optional[str]:
    """web 端点的智能体绑定读取（W30-B3 命名空间策略，两通道语义不同）：

    - opencode：先读 "opencode:<agent>"，缺则回落裸键 "<agent>"（读别名）。
      裸键属语音/任务站；回落让语音与 web 在 web 从未写过命名键前共用同一
      条会话，语音<->web 单会话连续性零破坏。
    - loom：只认 "loom:<agent>"，绝不读裸键/跨通道键（严格隔离）——loom
      会话 id 在 opencode 侧无意义，任何回落都是把消息投递进错误引擎。
    """
    if backend == "opencode":
        return (manager.get_agent_session(web_agent_key(agent, backend))
                or manager.get_agent_session(agent))
    return manager.get_agent_session(web_agent_key(agent, backend))


def _validate_explicit_backend(value: Optional[str]) -> Optional[str]:
    """W44 显式 backend 校验：None/"" 透传（返回 None=走现语义 web 通道）；
    精确匹配 WEB_BACKEND_OPTIONS 合法值原样返回；其余 400。"""
    if value is None or value == "":
        return None
    if value in WEB_BACKEND_OPTIONS:
        return value
    raise HTTPException(
        status_code=400,
        detail=f"backend 取值非法: {value!r}（合法: {'|'.join(WEB_BACKEND_OPTIONS)}，缺省=当前 Web 通道）",
    )


async def _acquire_client_by_backend(backend: str):
    """W44 显式通道客户端：直调两通道原语（backend 须已过校验）。

    与 _validate_explicit_backend 头注同理——全局缝/通道缝在环境值≠请求值时
    会静默给出错误引擎，显式腿唯一合法入口是这两个直调别名。
    """
    if backend == "loom":
        return await acquire_loom_client_direct()
    return await acquire_opencode_client_direct()


# ============ Pydantic Models ============


class SessionSwitchRequest(BaseModel):
    """会话切换请求"""
    session_id: str
    backend: Optional[str] = None  # W46 可选显式通道（opencode|loom）；缺省/"" 走现 Web 通道
    title: Optional[str] = None    # W46 收编登记用标题（可选；engine 可读值/"会话"兜底）


class SessionCreateRequest(BaseModel):
    """会话创建请求"""
    title: Optional[str] = None
    directory: Optional[str] = None


class MessageSendRequest(BaseModel):
    """发送消息请求"""
    message: str
    session_id: Optional[str] = None
    to_agent: Optional[str] = None
    backend: Optional[str] = None  # W44 可选显式通道（opencode|loom）；缺省/"" 走现 Web 通道


class SessionUpdateTitleRequest(BaseModel):
    """更新会话标题请求"""
    session_id: str
    title: str


class SummarizeSessionRequest(BaseModel):
    """会话压缩请求"""
    model_id: Optional[str] = None
    provider_id: Optional[str] = None
    backend: Optional[str] = None


# ============ Endpoints from stt.py ============


async def _adopt_engine_session(manager, request: "SessionSwitchRequest", backend: str):
    """W46 收编：本地 session_history 查无 → 向有效通道 engine 核验存在性再登记。

    核验原语 = 两通道信封公共层既有 get_session_status（opencode 腿
    GET /session/{sid}、loom 腿 GET /sessions/{sid}/status，经
    _acquire_client_by_backend 显式缝，不新建 HTTP 层）。失败分类（真实客户端
    _raw_* 对非 2xx 一律给 "HTTP {status}: ..." 文案）：
    - detail 以 "HTTP 404" 开头 → engine 自报会话不存在 → 照旧诚实 404；
    - 其余失败（连接炸/非404 HTTP/系统异常）→ engine 未能给出可靠答案，
      不可断言"不存在" → 503（core/errors.py code_map 503→SERVICE_UNAVAILABLE，
      与 kernel 不可达/声纹降级同款惯例；502 无封闭码映射会塌成 INTERNAL_ERROR，弃）。
    存在 → set_current_session 登记进 history 并设为当前（即收编+switch 一体），
    title 优先级：请求可选 title > engine 可读值（title/slug）> "会话"。
    """
    client = await _acquire_client_by_backend(backend)
    result = await client.get_session_status(request.session_id)

    if not result["ok"]:
        detail = str(result.get("error", {}).get("detail", ""))
        if detail.startswith("HTTP 404"):
            raise HTTPException(status_code=404, detail="会话不存在")
        raise HTTPException(
            status_code=503,
            detail=f"通道引擎不可用（{backend}）: {detail}",
        )

    data = result["data"] if isinstance(result["data"], dict) else {}
    title = request.title or data.get("title") or data.get("slug") or "会话"
    logger.info(f"engine 会话收编登记: {request.session_id} (backend={backend})")
    return manager.set_current_session(request.session_id, title=title)


@router.post("/session/switch")
async def switch_session(request: SessionSwitchRequest):
    """切换到指定会话（同时切换主智能体和监督智能体）。

    W46 通道化：有效通道 = request.backend（校验后）or get_web_backend()。
    - 本地 session_history 命中 → 现路径响应逐字节不变（不核验 engine，本地注册表
      即真相；backend 只改命名键落点）；
    - 本地查无 → engine 存在即收编（见 _adopt_engine_session），否则诚实 404；
    - 命名键写 web_agent_key("main-task", 有效通道)——修"写错命名键"（此前恒随
      全局热切换值漂移，engine 直建/未注册会话的 UI 点选曾被此盲区阻断）。
    """
    requested_backend = _validate_explicit_backend(request.backend)
    backend = requested_backend or get_web_backend()

    manager = get_session_manager()

    session = manager.switch_session(request.session_id)

    if session is None:
        session = await _adopt_engine_session(manager, request, backend)

    # 绑定主智能体到新会话（W30-B3：web 站点写一律命名键；响应形状仍用
    # 裸标签 "main-task"——那是前端契约展示键，与存储键解耦）
    manager.set_agent_session(
        web_agent_key("main-task", backend), request.session_id
    )

    logger.info(f"主智能体会话已切换到: {request.session_id}")

    # T5：切换成功后丢弃主会话缓存，下一次解析重新以 Loom /sessions/main 为准
    invalidate_loom_main_cache()

    return {
        "status": "switched",
        "session_id": session.session_id,
        "title": session.title,
        "agent_sessions": {
            "main-task": request.session_id
        }
    }


@router.post("/session/update-title")
async def update_session_title(request: SessionUpdateTitleRequest):
    """更新会话标题"""
    

    manager = get_session_manager()
    success = manager.update_session_title(request.session_id, request.title)

    if success:
        return {
            "status": "updated",
            "session_id": request.session_id,
            "title": request.title
        }
    else:
        raise HTTPException(status_code=404, detail="会话不存在")


@router.post("/session/create")
async def create_session(request: SessionCreateRequest):
    """创建新会话（Loom 通道解析并返回权威主会话，绝不另造随机会话）。"""
    

    manager = get_session_manager()
    backend = get_web_backend()
    client = await acquire_web_client()

    if backend == "loom":
        resolution = await resolve_loom_main_session(
            client, manager, allow_create=True
        )
        if not resolution.ok:
            raise HTTPException(
                status_code=503,
                detail=f"Loom 主会话不可用: {resolution.error or '未知错误'}",
            )
        session_id = resolution.session_id
        invalidate_loom_main_cache()
        title = request.title or f"STT会话_{session_id[:8]}"
        return {
            "status": "created",
            "session_id": session_id,
            "title": title,
            "agent_sessions": {
                "main-task": session_id
            }
        }

    # opencode 通道保持原语义：新建会话并登记为当前会话
    session_id = _unwrap_envelope(await client.create_session(
        title=request.title,
        directory=request.directory
    ))["session_id"]

    session = manager.set_current_session(
        session_id=session_id,
        title=request.title,
        directory=request.directory
    )
    title = session.title

    # 绑定主智能体到新会话（W30-B3：只写命名键，裸键留给语音/任务链）
    manager.set_agent_session(
        web_agent_key("main-task", backend), session_id
    )

    return {
        "status": "created",
        "session_id": session_id,
        "title": title,
        "agent_sessions": {
            "main-task": session_id
        }
    }


@router.post("/session/message")
async def send_session_message(request: MessageSendRequest, raw_request: Request):
    """
    发送消息到OpenCode

    支持指定会话ID或目标智能体
    （合并了 main.py 和 stt.py 的两个版本，使用更完整的 stt.py 实现）

    W44：可选 body.backend 显式指定投递通道；缺省时有效通道=当次 Web 热切换值，
    解析优先级/新建兜底/TTS 设备通道/发送/响应全部逐字节现语义。
    """
    # 非法 backend 先行 400（校验零副作用，失败不碰任何客户端/绑定）
    requested_backend = _validate_explicit_backend(request.backend)

    if requested_backend:
        # 显式腿：直调对应通道原语，绑定命名/投递同用有效通道=请求值
        client = await _acquire_client_by_backend(requested_backend)
        backend = requested_backend
    else:
        client = await acquire_web_client()
        backend = get_web_backend()
    manager = get_session_manager()

    # 发送目标 agent（绑定命名与消息投递同源用有效通道值）
    agent_name = request.to_agent if request.to_agent else "main-task"

    # 确定目标会话
    session_id = None

    # 优先使用传入的session_id
    if request.session_id:
        session_id = request.session_id
    # 如果指定了目标智能体，获取该智能体的会话（W30-B3：命名键+opencode 读别名）
    elif request.to_agent:
        session_id = _web_get_binding(manager, request.to_agent, backend)

    # opencode 保留全局通道兜底：无绑定时用当前会话（与语音共享，现状语义）；
    # loom 主会话唯一真源=GET /sessions/main：无显式 id 的主会话目标（含
    # to_agent=main-task）恒走解析器以覆盖陈旧绑定，其他 agent 有绑定则沿用；
    # 显式 id 照旧直投，仅在本地没有 main-task 绑定时顺带校验一次主会话
    # （fail-open，不改变投递目标）。
    if backend == "loom":
        if request.session_id:
            if not manager.get_agent_session(web_agent_key("main-task", backend)):
                try:
                    await resolve_loom_main_session(
                        client, manager, allow_create=False
                    )
                except Exception as e:
                    logger.debug(f"[Session] Loom 主会话校验失败（忽略）: {e}")
        elif not session_id or agent_name == "main-task":
            resolution = await resolve_loom_main_session(
                client, manager, allow_create=True
            )
            if not resolution.ok:
                raise HTTPException(
                    status_code=503,
                    detail=f"Loom 主会话不可用: {resolution.error or '未知错误'}",
                )
            session_id = resolution.session_id
    elif not session_id:
        session_id = manager.get_session_id()

    # 仍然没有会话 → 在有效通道新建（opencode 腿；loom 已由解析器兜底）
    if not session_id:
        result = await client.create_session(title="手动消息会话")
        if not result["ok"]:
            raise HTTPException(status_code=500, detail=f"创建会话失败: {result['error']['detail']}")
        session_id = result["data"]["session_id"]
        manager.set_current_session(session_id, "手动消息会话")

    # 设置source名称
    if request.to_agent:
        source_name = request.to_agent
    else:
        source_name = "main-task"

    # 刷新 TTS 设备通道：记录本次消息的发送设备（滑动 TTL，新发送者抢占通道）。
    # HTTP 请求无法感知连接类型，故由前端经 X-Client-Type 告知（缺省 web）。
    try:
        sender_device_id = (
            raw_request.headers.get("X-Device-Id")
            or raw_request.query_params.get("device_id")
        )
        sender_client_type = raw_request.headers.get("X-Client-Type") or "web"
        sender_user_id = getattr(raw_request.state, "user_id", None)
        if sender_user_id and sender_device_id:
            device_channel_store.mark_sender(
                sender_user_id, sender_device_id, sender_client_type
            )
    except Exception as e:
        logger.debug(f"[Session] 刷新 TTS 设备通道失败（不影响消息发送）: {e}")

    # 【2026-09-09 取消 web_message 感知记录】用户消息不再写入 perception.jsonl。
    # 需要查看用户主动交互内容时，用 ai/analysis/query_chatlog.py 调 /api/screen/session/chatlog 查询。
    # 如需恢复，取消下方注释即可。
    # 记录用户消息到感知数据（不含前缀），先于网关调用确保一定写入
    # try:
    #     from services.perception_store import append_perception
    #     from datetime import datetime, timezone, timedelta
    #     user_id = getattr(raw_request.state, 'user_id', None)
    #     entry = {
    #         "type": "web_message",
    #         "t": datetime.now(timezone(timedelta(hours=8))).strftime("%H:%M:%S"),
    #         "content": request.message,
    #         "source": "web_message",
    #     }
    #     if user_id:
    #         entry["user_qq"] = str(user_id)
    #     append_perception(entry, auto_type=False)
    #     logger.debug(f"[Session] 已记录消息到感知数据")
    # except Exception as e:
    #     logger.debug(f"[Session] 记录消息到感知数据异常（不影响消息发送）: {e}")

    send_result = await client.send_message(
        session_id=session_id,
        message=request.message,
        agent=agent_name
    )

    if not send_result["ok"]:
        raise HTTPException(status_code=500, detail=send_result["error"]["detail"])

    # 【2026-09-09 取消自动保存会话机制】
    # 每次发消息后不再把会话历史转 Markdown 存到 ai/data/daily/{date}/会话/
    # （已清理存量 1102 个文件。原 session_history_saver 模块已于 2026-10-08 P0-U2 删除）

    return {"status": "sent", "session_id": session_id, "to_agent": request.to_agent, "source": source_name}


# ============ W44 双源聚合归一（/session/list） ============


def _opencode_leg_active(current_backend: str) -> bool:
    """opencode 聚合腿是否参与本次列表。

    退役部署（opencode.enabled=false 且当前 Web 通道不是 opencode）不探活、
    不请求 5096；本地 session_history 仍按绑定归属照常列出。当前 Web 通道
    显式为 opencode 时腿必须保持活跃，否则当前通道的远端会话凭空消失。
    """
    return bool(get_config().OPENCODE_ENABLED) or current_backend == "opencode"


async def _list_channel_sessions(backend: str, active: bool = True,
                                 session_id: Optional[str] = None) -> Dict[str, Any]:
    """单腿客户端获取+列表拉取（异常原样上抛，由 gather return_exceptions 收编）。

    active=False 表示该通道已停用：直接回成功空信封，不获取客户端、不发请求；
    停用不是故障，调用方不得把它计入 partial。
    session_id 仅 Loom 腿使用：以权威主会话为过滤面，opencode 调用逐字节不变。
    """
    if not active:
        return {"ok": True, "data": {"sessions": []}, "error": None}
    client = await _acquire_client_by_backend(backend)
    if backend == "loom":
        return await client.list_sessions(session_id=session_id)
    return await client.list_sessions()


async def _list_loom_sessions(manager) -> Dict[str, Any]:
    """Loom 列表腿：先解析权威主会话，再按该 id 取单行（绝不返回远端全量列表）。

    解析失败（无主会话/引擎不可用）抛异常，由 gather 收编进 partial——该腿的
    数据不全必须让调用方看见，但绝不 500。
    """
    client = await _acquire_client_by_backend("loom")
    resolution = await resolve_loom_main_session(
        client, manager, allow_create=False
    )
    if not resolution.ok:
        raise RuntimeError(resolution.error or "Loom 主会话不可用")
    return await _list_channel_sessions("loom", session_id=resolution.session_id)


def _leg_sessions(res: Any, name: str, partial: List[str]) -> List[Dict[str, Any]]:
    """单腿结果拆壳：异常/信封失败/形状不符 → 记入 partial 并回空列表。

    聚合面吞掉全部单腿故障，绝不 500（partial 是前端感知数据不全的唯一信号）。
    """
    if isinstance(res, dict) and res.get("ok"):
        items = (res.get("data") or {}).get("sessions")
        if isinstance(items, list):
            return [s for s in items if isinstance(s, dict)]
    partial.append(name)
    return []


def _opencode_created_field(s: Dict[str, Any]) -> Any:
    """opencode 项时间读取（死键修复）：真字段是 time.created（ms epoch，见
    archive/behavior/snapshots/session_list.get.json）；顶层 created_at 在真实
    对象上从不存在、恒回空串——仅保留为历史桩/旧形状的兼容回落读。"""
    t = s.get("time")
    created = t.get("created") if isinstance(t, dict) else None
    if created is None:
        return s.get("created_at", "")
    return created


def _ms_to_date(ms: Any) -> str:
    """ms epoch → UTC+8 展示串；非数值/缺失/非正 → 空串。"""
    if isinstance(ms, (int, float)) and ms > 0:
        return _format_ts(int(ms))
    return ""


def _seconds_to_ms(v: Any) -> int:
    """本地 history 的 float 秒时间戳 → int ms；非数值 → 0。"""
    return int(v * 1000) if isinstance(v, (int, float)) else 0


def _norm_opencode_entry(s: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """远端 opencode 项 → 归一枚举（date/updated 来自 time.created/time.updated ms）。"""
    sid = s.get("session_id") or s.get("id")
    if not sid:
        return None
    created = _opencode_created_field(s)
    t = s.get("time") if isinstance(s.get("time"), dict) else {}
    updated = t.get("updated")
    if not isinstance(updated, (int, float)):
        updated = created if isinstance(created, (int, float)) else 0
    return {
        "session_id": sid,
        "title": s.get("title") or s.get("slug") or "会话",
        "date": _ms_to_date(created),
        "updated": int(updated),
        "backend": "opencode",
    }


def _norm_loom_entry(s: Dict[str, Any],
                     hist_by_sid: Dict[str, Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """远端 loom 项 → 归一枚举。loom 协议只有 {sessionID,status}：title/时间
    一律 join 本地 session_history，缺则标题回退"会话"、时间置空。"""
    sid = s.get("session_id") or s.get("sessionID") or s.get("id")
    if not sid:
        return None
    h = hist_by_sid.get(sid) or {}
    created_ms = _seconds_to_ms(h.get("created_at"))
    updated_ms = _seconds_to_ms(h.get("last_accessed")) or created_ms
    return {
        "session_id": sid,
        "title": h.get("title") or "会话",
        "date": _ms_to_date(created_ms),
        "updated": updated_ms,
        "backend": "loom",
    }


def _norm_local_entry(h: Dict[str, Any], backend: str) -> Optional[Dict[str, Any]]:
    """仅本地 session_history 条目 → 归一枚举（history 时间为 float 秒 → ms）。"""
    sid = h.get("session_id")
    if not sid:
        return None
    created_ms = _seconds_to_ms(h.get("created_at"))
    updated_ms = _seconds_to_ms(h.get("last_accessed")) or created_ms
    return {
        "session_id": sid,
        "title": h.get("title") or "会话",
        "date": _ms_to_date(created_ms),
        "updated": updated_ms,
        "backend": backend,
    }


def _local_entry_backend(sid: str, bindings: Dict[str, str],
                         current_backend: str) -> str:
    """仅本地条目的通道归属：扫绑定值==sid 的键——loom: 前缀→loom；
    opencode: 前缀或裸键→opencode（裸键属语音/任务站，恒为 opencode 主链）；
    查无→当前 Web 通道。两趟扫描保证 loom: 命中优先于同 sid 的其他键形。"""
    for key, val in bindings.items():
        if val == sid and key.startswith("loom:"):
            return "loom"
    for key, val in bindings.items():
        if val == sid:
            return "opencode"
    return current_backend


@router.get("/session/list")
async def list_sessions():
    """列出所有会话（W44 双源聚合，键并集=旧三键+新三键）。

    - local_sessions / opencode_sessions / current_session：旧三键名形不动；
      opencode_sessions 从此恒为 opencode 原始腿（W30 曾在 loom 通道下混装
      loom 列表，本波分账修正）；local_sessions 空回退死键修复见
      _opencode_created_field。
    - sessions：远端 opencode ∪ 远端 loom 主会话 ∪ 仅本地 session_history 条目，
      统一归一为 {session_id,title,date,updated,backend}；sid 去重远端元数据优先；
      updated 降序。
    - loom_sessions：loom 腿原始结果（T5 起恒为权威主会话单行或空，绝不远端全量）。
    - partial：本次失败的通道名（固定序 opencode→loom）；单腿故障 partial 降级，
      恒 200 绝不 500。opencode 停用（enabled=false 且当前 Web 通道非 opencode）
      时该腿恒空、不探活、不计入 partial——停用不是故障。
    """
    manager = get_session_manager()

    # 获取本地会话历史
    local_sessions = manager.list_sessions()

    # 当前 Web 通道一次取值：opencode 停腿判定与本地条目归属共用同一快照
    current_backend = get_web_backend()

    # 双腿并发直调通道原语（显式腿不经 web 通道缝）；return_exceptions 兜住
    # 通道宕机/端口探测失败等异常，统一进 partial 降级。opencode 停用时零请求。
    # Loom 腿经权威主会话解析后按 id 取单行（0/1 行），绝不拉远端列表。
    oc_res, loom_res = await asyncio.gather(
        _list_channel_sessions("opencode", active=_opencode_leg_active(current_backend)),
        _list_loom_sessions(manager),
        return_exceptions=True,
    )
    partial: List[str] = []
    oc_items = _leg_sessions(oc_res, "opencode", partial)
    loom_items = _leg_sessions(loom_res, "loom", partial)

    # 如果本地会话为空，从 OpenCode 会话中取最近 10 个展示
    display_sessions = local_sessions
    if not display_sessions and oc_items:
        display_sessions = [
            {"session_id": s.get("id"), "title": s.get("slug", "会话"),
             "created_at": _opencode_created_field(s)}
            for s in oc_items[:10]
        ]

    # 聚合归一：远端在前先占位（sid 去重远端元数据优先），仅本地条目后补
    hist_by_sid = {h.get("session_id"): h for h in local_sessions
                   if isinstance(h, dict) and h.get("session_id")}
    merged: Dict[str, Dict[str, Any]] = {}
    for s in oc_items:
        entry = _norm_opencode_entry(s)
        if entry:
            merged.setdefault(entry["session_id"], entry)
    for s in loom_items:
        entry = _norm_loom_entry(s, hist_by_sid)
        if entry:
            merged.setdefault(entry["session_id"], entry)
    bindings = manager.list_agent_sessions()
    for h in local_sessions:
        sid = h.get("session_id") if isinstance(h, dict) else None
        if not sid or sid in merged:
            continue
        merged[sid] = _norm_local_entry(
            h, _local_entry_backend(sid, bindings, current_backend))

    sessions = sorted(merged.values(), key=lambda e: e["updated"], reverse=True)

    return {
        "local_sessions": display_sessions,
        "opencode_sessions": oc_items,
        "current_session": manager.get_session_id(),
        "sessions": sessions,
        "loom_sessions": loom_items,
        "partial": partial,
    }


# ============ W51 loom 历史压缩分隔线注入（仅视图层，fail-open） ============


def _build_compaction_divider(session_id: str, compaction: Dict[str, Any]) -> Dict[str, Any]:
    """合成"压缩分隔线"条目（opencode {info,parts} 形状，前端 part type 'compaction' 已全链支持）。

    id 确定性 = f(msg_compaction_{sid}_{coveredCount})：同一压缩边界反复翻页命中同一 id，
    前端 getStableMessageId 去重环天然幂等（重复注入=覆盖同一条，不刷屏）。
    """
    covered = int(compaction.get("coveredCount") or 0)
    anchor_ts = int(compaction.get("anchorTimestampMs") or 0)
    msg_id = f"msg_compaction_{session_id}_{covered}"
    return {
        "info": {"id": msg_id, "role": "assistant", "sessionID": session_id,
                 "time": {"created": anchor_ts}},
        "parts": [{
            "id": f"part_compaction_{session_id}_{covered}",
            "type": "compaction",
            "text": f"上下文已压缩：前 {covered} 条消息已合并为一份摘要"
                    f"（模型侧生效，原始历史完整保留）",
            "summaryText": str(compaction.get("summaryText") or ""),
            "messageID": msg_id,
            "sessionID": session_id,
        }],
    }


def _compaction_insert_index(
    messages: List[Dict[str, Any]], compaction: Dict[str, Any]
) -> Optional[int]:
    """按锚规则给出分隔线插入下标（页为升序旧→新）；None = 边界不在本页、不注入。

    锚优先序：anchorMessageId 精确命中 loomEntryId（raw id 透传键，见 loom_messages）
    → 否则 anchorTimestampMs 落在首条 created >= 边界的消息之前；但整页严格新于边界
    （首条即 > 边界）时边界属更早页、整页严格旧（无条目 >= 边界）时属更晚页，均不注入。
    """
    anchor_id = compaction.get("anchorMessageId")
    if anchor_id:
        for i, m in enumerate(messages):
            if (m.get("info") or {}).get("loomEntryId") == anchor_id:
                return i
    raw_ts = compaction.get("anchorTimestampMs")
    if raw_ts is None:
        return None
    anchor_ts = int(raw_ts)
    first_ts = int(messages[0]["info"]["time"]["created"])
    for i, m in enumerate(messages):
        if int(m["info"]["time"]["created"]) >= anchor_ts:
            # i==0 且首条严格大于边界 = 整页比边界新（边界在更早页）→ 不注入
            return i if (i > 0 or first_ts <= anchor_ts) else None
    return None


async def _maybe_splice_opencode_compaction(
    session_id: str, client: Any, messages: List[Dict[str, Any]], initial: bool
) -> List[Dict[str, Any]]:
    """首次历史页注入 opencode 最新压缩摘要；只读、fail-open。"""
    if not initial or not messages:
        return messages
    try:
        infos = [m.get("info") or {} for m in messages if isinstance(m, dict)]
        if any(info.get("summary") is True for info in infos):
            return messages
        current_ids = {info.get("id") for info in infos if info.get("id")}
        data = await client.get_session_messages(session_id, limit=200)
        if not isinstance(data, dict) or not data.get("ok"):
            return messages
        payload = data.get("data") or {}
        rows = payload.get("messages") if isinstance(payload, dict) else None
        if not isinstance(rows, list):
            return messages
        summary = None
        for row in reversed(rows):
            if not isinstance(row, dict):
                continue
            info = row.get("info") if isinstance(row.get("info"), dict) else {}
            if info.get("summary") is True:
                summary = row
                break
        if summary is None:
            return messages
        summary_info = summary.get("info") or {}
        summary_id = summary_info.get("id")
        if summary_id and summary_id in current_ids:
            return messages
        text_parts = [
            part for part in (summary.get("parts") or [])
            if isinstance(part, dict) and part.get("type") == "text" and part.get("text")
        ]
        if not text_parts:
            return messages
        injected = {
            **summary,
            "info": {**summary_info, "summary": True, "mode": "compaction"},
            "parts": text_parts,
        }
        return [injected, *messages]
    except Exception as e:
        logger.debug(f"[W57] opencode 压缩摘要注入失败（忽略，原页返回）: "
                     f"session={session_id} err={e}")
        return messages


async def _maybe_splice_compaction(
    session_id: str, client: Any, messages: List[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    """loom 历史页注入至多一条压缩分隔线；全程 fail-open——任何异常只 debug 日志、原页返回。

    触发面（硬契约）：有效通道=loom 且页非空（调用方判）且快照 status=="active"。
    客户端缺 get_session_compaction 面（旧 harness / 桩 / 通道错配）视同 None，零副作用。
    锚不在本页（整页更新或更旧）→ 不注入；分隔线只出现在含锚页的锚点之前。
    """
    try:
        get_compaction = getattr(client, "get_session_compaction", None)
        if get_compaction is None:
            return messages
        compaction = await get_compaction(session_id)
        if not isinstance(compaction, dict) or compaction.get("status") != "active":
            return messages
        index = _compaction_insert_index(messages, compaction)
        if index is None:
            return messages
        out = list(messages)
        out.insert(index, _build_compaction_divider(session_id, compaction))
        return out
    except Exception as e:
        logger.debug(f"[W51] 压缩分隔线注入失败（忽略，原页返回）: "
                     f"session={session_id} err={e}")
        return messages


@router.get("/session/{session_id}/messages")
async def get_session_messages(
    session_id: str, limit: int = 50, before: Optional[str] = None,
    backend: Optional[str] = None,
):
    """
    获取指定会话的消息历史（分页）

    Args:
        session_id: 会话ID
        limit: 返回消息数量上限（默认50）
        before: 翻页游标，获取比该游标更早的一页（来自上一页的 next_cursor）
        backend: W44 可选显式通道（opencode|loom）；缺省走现 Web 通道
    """
    requested_backend = _validate_explicit_backend(backend)
    if requested_backend:
        client = await _acquire_client_by_backend(requested_backend)
    else:
        client = await acquire_web_client()
    data = _unwrap_envelope(
        await client.get_session_messages(session_id, limit=limit, before=before)
    )

    messages = data["messages"]
    next_cursor = data.get("next_cursor")

    # 历史接口也需要剥离 user 消息的 <Axeuh-home-system> 系统包装，
    # 与 chatlog 路径保持一致，避免前端 user 气泡显示 JSON 信封。
    for msg in messages:
        _strip_user_wrapper(msg)

    # 上游游标恒透传；仅译后空页才截断（W50 修正）：旧启发式"不满 limit=到头"
    # 假设 raw 条数≈译后条数，W43 页级合并把 loom raw 50 条并成 ~30 条后必误杀
    # 游标 → 前端回断链"只翻到最近一页"。opencode 通道译前译后 1:1 不受影响。
    if next_cursor and len(messages) == 0:
        next_cursor = None

    # W51：loom 核内自动压缩对用户不可见（摘要只进出站请求）——历史页注入一条
    # 合成"压缩分隔线"，对齐 opencode session.compacted 的可见痕迹。视图层注入，
    # 不改存储、不触 opencode；置于游标块之后：分隔线永不复活空页游标（W50 语义优先）。
    effective_backend = requested_backend or get_web_backend()
    if messages:
        if effective_backend == "loom":
            messages = await _maybe_splice_compaction(session_id, client, messages)
        elif effective_backend == "opencode":
            messages = await _maybe_splice_opencode_compaction(
                session_id, client, messages, before is None)

    return {
        "session_id": session_id,
        "messages": messages,
        "count": len(messages),
        "next_cursor": next_cursor,
    }


@router.get("/session/{session_id}/children")
async def get_session_children(session_id: str, backend: Optional[str] = None):
    """
    获取会话的子会话/子智能体列表

    调用 OpenCode API /session/{session_id}/children 获取
    子智能体(task工具)创建的子会话信息

    backend: W44 可选显式通道（opencode|loom）；缺省走现 Web 通道
    """
    requested_backend = _validate_explicit_backend(backend)
    if requested_backend:
        client = await _acquire_client_by_backend(requested_backend)
    else:
        client = await acquire_web_client()
    result = await client.get_session_children(session_id)

    if not result["ok"]:
        return {"children": [], "error": result.get("error", {}).get("detail", "未知错误")}
    return {"children": result["data"].get("children", [])}


@router.post("/session/{session_id}/summarize")
async def summarize_session(session_id: str, request: SummarizeSessionRequest):
    """
    触发会话上下文压缩（调用 OpenCode 原生 summarize）

    通过 OpenCode 的 /session/{session_id}/summarize API 对会话进行智能压缩，
    减少 token 占用。压缩完成后 OpenCode 会推送 session.compacted SSE 事件。
    """
    requested_backend = _validate_explicit_backend(request.backend)
    if requested_backend:
        client = await _acquire_client_by_backend(requested_backend)
    else:
        client = await acquire_web_client()
    _unwrap_envelope(await client.summarize_session(
        session_id=session_id,
        model_id=request.model_id,
        provider_id=request.provider_id,
    ))
    return {
        "status": "compacting",
        "session_id": session_id,
        "message": "会话压缩已启动"
    }


# ============ 会话对话日志（按时间段查询） ============


def _parse_dt_to_ms(value: str) -> Optional[int]:
    """解析时间字符串为毫秒时间戳（无时区按 UTC+8 处理）。

    支持格式: '2026-09-09T00:00:00+08:00' / '2026-09-09 00:00:00' / '2026-09-09 00:00'
    返回 None 表示解析失败。
    """
    from datetime import datetime, timezone, timedelta
    tz8 = timezone(timedelta(hours=8))
    text = value.strip().replace("T", " ")
    candidates = [
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%d",
    ]
    for fmt in candidates:
        try:
            dt = datetime.strptime(text, fmt).replace(tzinfo=tz8)
            return int(dt.timestamp() * 1000)
        except ValueError:
            continue
    # ISO8601 带时区（如 2026-09-09T00:00:00+08:00）
    try:
        from datetime import datetime as _dt
        dt = _dt.fromisoformat(value)
        return int(dt.timestamp() * 1000)
    except ValueError:
        return None


def _extract_user_text(raw: str) -> str:
    """清洗 user 消息的系统包装，提取真实对话文本。

    规则（2026-09-09 按用户要求）：以 <Axeuh-home-system> 标签为锚点——
    该标签及其之前的所有系统注入内容（Axeuh_bot 桥接、checkpoint、mode 块等）全部丢弃，
    只保留它之后的真实用户文本。
    若消息不含 <Axeuh-home-system> 标签，则退化为逐块剥离包装。
    """
    text = raw or ""

    # 主规则：截取最后一个 </Axeuh-home-system> 之后的内容（去掉标签及其前方一切）
    if "</Axeuh-home-system>" in text:
        text = text.split("</Axeuh-home-system>", 1)[-1]
        return text.strip()

    # 退化规则（无 home-system 标签时）：
    # 去掉 Axeuh 系桥接块（<Axeuh_bot>...）、mode 注入块，按标签名配对闭合
    text = re.sub(
        r"<(Axeuh[\w-]*|[\w-]+-system|ultrawork-mode|analyze-mode)>.*?</\1>",
        "", text, flags=re.DOTALL,
    )
    # 去掉以 [ 开头的系统指令行（如 [restore checkpoint...]、[SYSTEM DIRECTIVE...]）
    lines = [ln for ln in text.split("\n")
             if not (ln.strip().startswith("[") and "]" in ln)]
    return "\n".join(lines).strip()


def _strip_user_wrapper(message: Dict[str, Any]) -> Dict[str, Any]:
    """剥离单条 user 消息的系统包装（就地修改并返回）。

    只处理 role == 'user' 的消息：
    - 合并所有 text part 的文本，用 _extract_user_text 清洗；
    - 清洗后的真实文本写回第一个 text part，其余 text part 置空；
    - 非 text part（file 等）与 assistant 消息完全不动。
    """
    info = message.get("info", {})
    if info.get("role") != "user":
        return message

    parts = message.get("parts", [])
    if not isinstance(parts, list):
        return message

    text_parts = [
        p for p in parts
        if isinstance(p, dict) and p.get("type") == "text"
    ]
    if not text_parts:
        return message

    raw = "".join(p.get("text") or "" for p in text_parts)
    cleaned = _extract_user_text(raw)

    text_parts[0]["text"] = cleaned
    for p in text_parts[1:]:
        p["text"] = ""
    return message


def _format_ts(ms: int) -> str:
    """毫秒时间戳 → UTC+8 字符串 YYYY-MM-DD HH:MM:SS"""
    from datetime import datetime, timezone, timedelta
    return datetime.fromtimestamp(
        ms / 1000, tz=timezone(timedelta(hours=8))
    ).strftime("%Y-%m-%d %H:%M:%S")


def _msg_to_turn(msg: Dict[str, Any], fallback_sid: str) -> Optional[Dict[str, Any]]:
    """把一条 OpenCode 消息转为对话条目。

    只处理 user/assistant 消息，提取正文与工具名。
    返回 None 表示该消息不含可展示的对话内容。
    """
    info = msg.get("info", {})
    role = info.get("role")
    if role not in ("user", "assistant"):
        return None

    ts = info.get("time", {}).get("created")
    if not isinstance(ts, (int, float)):
        return None
    parts = msg.get("parts", [])

    # 提取正文（text parts）与工具名
    text_parts: List[str] = []
    tools: List[str] = []
    for p in parts:
        ptype = p.get("type")
        if ptype == "text":
            txt = p.get("text", "")
            if txt:
                text_parts.append(txt)
        elif ptype == "tool" and p.get("tool"):
            tname = p.get("tool")
            if tname not in tools:
                tools.append(tname)

    content = "".join(text_parts)
    if role == "user":
        content = _extract_user_text(content)
        # 纯系统注入的用户消息（清洗后为空）跳过
        if not content:
            return None
    else:
        if not content and not tools:
            return None
        if not content and tools:
            content = "[工具调用]"

    sid = msg.get("info", {}).get("sessionID") or fallback_sid
    return {
        "id": info.get("id", ""),
        "role": role,
        "time_ms": int(ts),
        "time_str": _format_ts(int(ts)),
        "content": content,
        "tools": tools or None,
        "session_id": sid,
    }


async def _collect_session_turns(
    client, session_id: str, start_ms: int, end_ms: int
) -> tuple[List[Dict[str, Any]], bool]:
    """拉取单个会话在时间窗内的对话条目，返回 (turns, truncated)。"""
    data = _unwrap_envelope(
        await client.get_session_messages_range(session_id, start_ms=start_ms, end_ms=end_ms)
    )
    messages = data["messages"]
    truncated = data.get("truncated", False)

    turns: List[Dict[str, Any]] = []
    for msg in messages:
        ts = msg.get("info", {}).get("time", {}).get("created")
        if not isinstance(ts, (int, float)):
            continue
        if ts < start_ms or ts > end_ms:
            continue
        turn = _msg_to_turn(msg, session_id)
        if turn:
            turns.append(turn)
    return turns, truncated


@router.get("/session/chatlog")
async def get_session_chatlog(
    start: str,
    end: str,
    session_id: Optional[str] = None,
    include_children: bool = False,
    format: str = "json",
):
    """
    按时间段查询 AI 与用户的对话日志。

    Args:
        start: 起始时间（ISO8601 或 YYYY-MM-DD HH:MM[:SS]，UTC+8）
        end: 结束时间
        session_id: 会话ID，缺省用当前 main-task 主会话
        include_children: 是否包含子会话（子智能体任务）
        format: json 结构化 或 text 纯文本时间线
    """
    # chatlog（运维查询面）固定走全局通道：ai_backend 择路 + 裸键绑定（W30 裁定
    # 不随 Web 热切换漂移——对话日志查的是主链路 opencode 历史，非 Web 试验通道）
    client = await acquire_opencode_client()
    manager = get_session_manager()

    start_ms = _parse_dt_to_ms(start)
    end_ms = _parse_dt_to_ms(end)
    if start_ms is None or end_ms is None:
        raise HTTPException(status_code=400, detail="时间格式无法解析，请用 YYYY-MM-DD HH:MM[:SS] 或 ISO8601")
    if start_ms >= end_ms:
        raise HTTPException(status_code=400, detail="start 必须早于 end")

    # 解析目标会话：缺省取 main-task 裸键（同上：语音/任务链共用的全局绑定）
    target_sid = session_id or manager.get_agent_session("main-task")
    if not target_sid:
        raise HTTPException(status_code=404, detail="未找到会话，请传入 session_id 或先绑定 main-task 会话")

    turns, truncated = await _collect_session_turns(client, target_sid, start_ms, end_ms)

    # 可选：递归子会话
    if include_children:
        try:
            children_result = await client.get_session_children(target_sid)
            if children_result["ok"]:
                for child in children_result["data"].get("children", []):
                    child_id = child.get("id") or child.get("session_id")
                    if not child_id:
                        continue
                    child_turns, child_trunc = await _collect_session_turns(client, child_id, start_ms, end_ms)
                    turns.extend(child_turns)
                    truncated = truncated or child_trunc
            # 全量按时间排序
            turns.sort(key=lambda t: t["time_ms"])
        except Exception as e:
            logger.warning(f"[Chatlog] 子会话拉取异常（忽略）: {e}")

    window = {
        "start_ms": start_ms,
        "end_ms": end_ms,
        "start": _format_ts(start_ms),
        "end": _format_ts(end_ms),
    }

    payload = {
        "session_id": target_sid,
        "window": window,
        "include_children": include_children,
        "message_count": len(turns),
        "truncated": truncated,
        "turns": turns,
    }

    # 纯文本时间线渲染（人读/AI直接消费）
    if format == "text":
        lines = []
        lines.append(f"# 会话对话 ({window['start']} ~ {window['end']})")
        if include_children:
            lines.append(f"会话: {target_sid} (含子会话)")
        else:
            lines.append(f"会话: {target_sid}")
        lines.append(f"共 {len(turns)} 条消息")
        lines.append("")
        for t in turns:
            lines.append(f"[{t['time_str'][11:]}] {'用户' if t['role'] == 'user' else 'AI'}: {t['content']}")
            if t.get("tools"):
                lines.append(f"    [工具] {', '.join(t['tools'])}")
        text_body = "\n".join(lines)
        return Response(content=text_body, media_type="text/plain; charset=utf-8")

    return payload
