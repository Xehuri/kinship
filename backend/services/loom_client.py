"""Loom Client - axeuh-harness（loom）API 交互客户端（与 opencode_client 同构双通道之一）。

对上层暴露与 services.opencode_client.OpenCodeClient **完全同构**的公共接口面
（同名方法/同签名/同元组协议/同 {"ok","data","error"} 信封），调用方经
services.ai_client_factory 按 config.yaml ai_backend 取值择一，零改其余代码。

协议面（loom 真源：axeuh-harness/packages/server/src/session-api/routes.ts、
events/route.ts、ops-api/routes.ts、http/auth.ts；端口/token 见 config loom 节）：
    POST /sessions                     201 {sessionID,status}
    GET  /sessions/main                200 {sessionID,status,createdAt,title?,archived}（主会话单例；
                                       列表面 GET /sessions 已废弃默认 404，本客户端不再调用）
    GET  /tasks                        200 {tasks:[TaskView],count}（无服务端过滤，客户端筛选）
    POST /sessions/:id/messages        202 受理（忙=202 queued:true FIFO 排队，仅队列溢出 409，W16-F1）
    POST /sessions/:id/voice           202 立接立回（abort→尾链后台执行，W16-F2）
    POST /sessions/:id/abort           200 {sessionID,aborted,status}
    GET  /sessions/:id/status          200 {sessionID,status,lastError,activeRuns,turns}
    GET  /sessions/:id/history         200 {sessionID,messages,nextCursor} + 头 x-next-cursor
    GET  /sessions/:id/compaction      200 核内自动压缩边界快照（W51 只读面，fail-open→None）
    GET  /events/stream?sessionId=     SSE（信封 {seq,payload:{type,properties}}，默认 message 事件）
    GET  /health /config /catalog/models
鉴权：全部请求 `Authorization: Bearer <LOOM_TOKEN>`（loom Router 无未鉴权路径）。

opencode 特有语义的映射决策（逐条）：
  - <Axeuh-home-system> 信封：保留注入（与 opencode 版逐字符同形）——前端零改动，
    routers/session.py 的历史剥离逻辑（_extract_user_text 按该标签截断）原样可用。
  - agent / model_id / provider_id / directory 参数：接受但忽略——loom 无 per-message
    agent/model 选择（模型由 loom.yaml 服务端配置，workspace 全局唯一）。
  - children（子会话列表）：loom 无 REST children 端点；W29-A2（D3）起数据源=
    GET /tasks 全量拉 + parent_session 客户端过滤（W23-C 任务面合流后账本在场）；
    SSE session.children 帧 + <task_metadata> 反解仍是实时面（前端侧 T32 改造面）。
  - summarize（上下文压缩）：loom compaction 在核内自动执行、无 HTTP 手动端点 →
    W29-A3（D4-A）summarize_session 返回 ok 垫圈信封（不抛错不触网；前端按钮
    静默无害，缺 session.compacted 帧=少一条分隔线属 D7 容忍；真触发面=loom W28-B 后置）。
  - abort 语义：opencode 200 恒 aborted=True（幂等中止）；loom 回真实值 aborted=
    是否有在途轮被中止。编排层（send_voice）不消费该布尔，信封如实透传。
  - send busy 语义（W16-F1 起对齐 opencode prompt_async）：loom 忙时回 202
    {accepted:true,queued:true} 入 FIFO 队列（上限 10），**仅队列溢出才 409**——
    文字路径与 opencode 同为"排队对调用方透明"，信封照常 ok（旧文"409 显式背压
    不伪装排队"系 C02 冻结假设，已作废）。语音路径 W16-F2 立接立回 202
    （abort→旧轮收尾→起轮全部后台链，同步受理零阻塞）。
  - 端口自动发现（幽灵进程避让）：不做——loom 固定 systemd 监听 5100，
    端口漂移场景不存在；探测函数在此域无对应物。
"""

# allow: SIZE_OK —— 单类同构契约（与 OpenCodeClient 逐一镜像的公共方法面 + 主会话专有
# get_main_session/get_main_session_id，不可跨文件拆分）；体积大头是任务冻结的"映射决策
# 逐条注释"文档面，代码本体约 450 行、无重复逻辑。

import aiohttp
import asyncio
import json
import logging
import uuid
from datetime import datetime
from typing import Optional, Dict, Any, List, Tuple

from config.config import get_config
from services.opencode_client import (
    OPENCODE_DEFAULT_AGENT,
    OPENCODE_DEFAULT_MODEL,
    OPENCODE_DEFAULT_PROVIDER,
    _is_model_excluded,
    load_model_config,
)
from services import loom_messages
from core.redaction import redact_text

logger = logging.getLogger(__name__)

_cfg = get_config()
LOOM_CONFIG_URL = _cfg.LOOM_URL

# token 缺失告警只打一次（与 opencode_client._auth_warned 同款防刷屏）
_token_warned = False


def _bearer_token() -> Optional[str]:
    """当前配置的 loom Bearer token；空值响亮告警一次（loom 强制鉴权，缺 token 必 401）。"""
    global _token_warned
    token = get_config().LOOM_TOKEN
    if not token:
        if not _token_warned:
            _token_warned = True
            logger.warning(
                "未配置 loom.token（且无 LOOM_TOKEN 环境变量）——"
                "loom Router 无未鉴权路径，全部请求将 401；"
                "生产按 axeuh-harness/docs/04 §6 经 systemd Environment=LOOM_TOKEN 注入"
            )
        return None
    return token


class LoomClient:
    """Loom API 客户端（接口面与 OpenCodeClient 同构，duck-type 可互换）。"""

    def __init__(self, base_url: str = LOOM_CONFIG_URL):
        self.base_url = base_url
        self.timeout = aiohttp.ClientTimeout(total=300)  # 与 opencode 客户端同预算
        self.directory = _cfg.OPENCODE_DIRECTORY  # 仅占位对齐属性面；loom 忽略（见模块头决策）

    def _auth(self, headers: Optional[Dict[str, str]] = None) -> Dict[str, str]:
        """合并 Bearer 认证头（覆盖本客户端全部 HTTP 请求点，含 SSE 上游）。"""
        out = dict(headers or {})
        token = _bearer_token()
        if token and "Authorization" not in out:
            out["Authorization"] = f"Bearer {token}"
        return out

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: Optional[Dict[str, Any]] = None,
        json_body: Optional[Dict[str, Any]] = None,
        timeout: Optional[aiohttp.ClientTimeout] = None,
    ) -> Tuple[int, Any, Dict[str, str]]:
        """一次 loom HTTP 调用 → (status, 解析后 body, headers)。

        body 非 JSON 时原样给 text；传输异常直接上抛，由 _raw_* 收口成元组错误
        （与 opencode_client 的每方法 try/except 风格一致）。
        """
        headers = self._auth({"Accept": "application/json"})
        if json_body is not None:
            headers["Content-Type"] = "application/json"
        async with aiohttp.ClientSession(timeout=timeout or self.timeout) as client:
            async with client.request(
                method, f"{self.base_url}{path}",
                params=params, json=json_body, headers=headers,
            ) as response:
                text = await response.text()
                data: Any = None
                if text:
                    try:
                        data = json.loads(text)
                    except json.JSONDecodeError:
                        data = text
                return response.status, data, dict(response.headers)

    @staticmethod
    def _error_detail(status: int, data: Any) -> str:
        """非 2xx 响应 → 错误文案（HTTP {status}: body 摘要），含 loom 的 {error:{code,message}} 体。"""
        if isinstance(data, dict):
            err = data.get("error")
            if isinstance(err, dict) and err.get("message"):
                return redact_text(f"HTTP {status}: {err['message']}")
            return redact_text(
                f"HTTP {status}: {json.dumps(data, ensure_ascii=False)[:300]}"
            )
        return redact_text(f"HTTP {status}: {str(data)[:300]}")

    # ==================== 裸传输层（_raw_*，元组协议，仅信封层消费） ====================

    async def _raw_create_session(
        self,
        title: Optional[str] = None,
        directory: Optional[str] = None
    ) -> Tuple[Optional[str], Optional[str]]:
        """POST /sessions。title/directory 被忽略（loom 无会话标题/目录概念；
        标题由后端 session_manager 本地维护并回显）。"""
        try:
            status, data, _ = await self._request("POST", "/sessions")
            if status == 201 and isinstance(data, dict) and data.get("sessionID"):
                session_id = data["sessionID"]
                logger.info(f"创建Loom会话成功: {session_id}")
                return session_id, None
            return None, self._error_detail(status, data)
        except Exception as e:
            logger.error("创建会话失败: %s", redact_text(str(e)))
            return None, redact_text(str(e))

    async def _raw_get_main_session(self) -> Tuple[Optional[Dict], Optional[str]]:
        """GET /sessions/main → 主会话对象 {sessionID,status,createdAt,title?,archived}。

        主会话单例是 loom 唯一会话真源（列表面 GET /sessions 已废弃默认 404），
        全部会话发现/列表语义收敛到本端点；仅 200 + dict + sessionID 视为成功。
        """
        try:
            status, data, _ = await self._request("GET", "/sessions/main")
            if status == 200 and isinstance(data, dict) and data.get("sessionID"):
                return data, None
            return None, self._error_detail(status, data)
        except Exception as e:
            logger.error("获取主会话失败: %s", redact_text(str(e)))
            return None, redact_text(str(e))

    @staticmethod
    def _format_message(message: str) -> str:
        cur_datetime = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        return f"""<Axeuh-home-system>
{json.dumps({"current_datetime": cur_datetime}, ensure_ascii=False, indent=2)}
</Axeuh-home-system>

{message}"""

    async def _raw_send_message(
        self,
        session_id: str,
        message: str,
        agent: str = None,
        model_id: str = None,
        provider_id: str = None,
        directory: Optional[str] = None
    ) -> Tuple[bool, Optional[str], Optional[bool]]:
        """POST /sessions/:id/messages（202 受理；忙=202 queued:true 入 FIFO 队列 W16-F1，
        409 仅在队列溢出时出现——202 恒成功信封，D1 语义不变）。

        返回 (success, error, queued)：queued 读 202 body 的 queued 键（W43 纯增量透传；
        键缺失=None"未知"，不猜测 False），供 send_message 信封带出、调用方自愿消费。
        消息与 opencode 版同款 <Axeuh-home-system> 时间信封（见模块头决策）；
        agent/model/provider/directory 参数接受但忽略。
        """
        formatted_message = self._format_message(message)
        logger.debug("[LOOM-REQ] POST /sessions/%s/messages content_chars=%d",
                     session_id, len(message))
        try:
            status, data, _ = await self._request(
                "POST", f"/sessions/{session_id}/messages",
                json_body={"text": formatted_message},
            )
            if status == 202:
                queued = (bool(data["queued"]) if isinstance(data, dict) and "queued" in data
                          else None)
                logger.debug("消息发送成功: session=%s, queued=%s, content_chars=%d",
                             session_id, queued, len(message))
                return True, None, queued
            return False, self._error_detail(status, data), None
        except Exception as e:
            logger.error("发送消息失败: %s", redact_text(str(e)))
            return False, redact_text(str(e)), None

    async def _raw_voice_send(
        self,
        session_id: str,
        message: str,
    ) -> Tuple[bool, Optional[str]]:
        """POST /sessions/:id/voice——loom 立接立回 202（W16-F2：abort→旧轮收尾→起轮
        在 loom 后台链执行，同步侧零阻塞；旧文"等旧轮收尾再发新轮"系冻结前假设）。

        正文与文本消息共用 <Axeuh-home-system> 时间信封（W2-T4 对齐 opencode 语音语义）。
        """
        try:
            status, data, _ = await self._request(
                "POST", f"/sessions/{session_id}/voice",
                json_body={"text": self._format_message(message)},
            )
            if status == 202:
                return True, None
            return False, self._error_detail(status, data)
        except Exception as e:
            logger.error("语音消息发送失败: %s", redact_text(str(e)))
            return False, redact_text(str(e))

    async def _raw_abort_session(
        self,
        session_id: str,
        directory: Optional[str] = None
    ) -> Tuple[bool, Optional[str]]:
        """POST /sessions/:id/abort（directory 忽略）。

        返回布尔 = loom 真实语义"是否有在途轮被中止"（opencode 恒 True 见模块头）。
        未知会话 404 → 错误元组（opencode 对未知会话 abort 也报错，语义一致）。
        """
        try:
            status, data, _ = await self._request(
                "POST", f"/sessions/{session_id}/abort",
                timeout=aiohttp.ClientTimeout(total=10),
            )
            if status == 200:
                aborted = bool(isinstance(data, dict) and data.get("aborted"))
                logger.debug(f"中止会话完成: {session_id} aborted={aborted}")
                return aborted, None
            return False, self._error_detail(status, data)
        except Exception as e:
            logger.error("中止会话失败: %s", redact_text(str(e)))
            return False, redact_text(str(e))

    async def _raw_get_session_status(self, session_id: str) -> Tuple[Optional[Dict], Optional[str]]:
        """GET /sessions/:id/status → {sessionID,status,lastError,activeRuns,turns}。

        消费方（task_executor）只用 ok 判会话有效性：loom 未知会话 404 → 错误元组，
        与 opencode"失效会话不可查"语义等价。
        """
        try:
            status, data, _ = await self._request("GET", f"/sessions/{session_id}/status")
            if status == 200 and isinstance(data, dict):
                return data, None
            return None, self._error_detail(status, data)
        except Exception as e:
            return None, redact_text(str(e))

    async def get_all_sessions_status(self) -> Tuple[Optional[Dict], Optional[str]]:
        """主会话状态映射 {session_id: {state}}（loom 主会话单例；列表面已废弃不调用）。

        opencode 版为全量会话聚合；loom 只有主会话，故返回单键映射，state 取
        busy/idle/error（lastActivity 无对应源，如实缺省）。
        """
        main, error = await self._raw_get_main_session()
        if error:
            logger.error(f"获取主会话状态失败: {error}")
            return None, error
        return {main["sessionID"]: {"state": main.get("status", "idle")}}, None

    async def _raw_get_session_messages(
        self,
        session_id: str,
        limit: int = 100,
        before: Optional[str] = None
    ) -> Tuple[Optional[List[Dict]], Optional[str]]:
        messages, _cursor, error = await self._raw_get_session_messages_page(
            session_id, limit=limit, before=before
        )
        return messages, error

    async def _raw_get_session_messages_page(
        self,
        session_id: str,
        limit: int = 200,
        before: Optional[str] = None,
    ) -> Tuple[Optional[List[Dict]], Optional[str], Optional[str]]:
        """GET /sessions/:id/history（升序旧→新，游标 before=x-next-cursor，与 opencode 同语义）。

        返回前把 pi-ai Message 形状转换成后端消费的 opencode {info,parts} 形状
        （纯函数在 services/loom_messages.py，映射决策见其模块头）。
        loom 单页硬上限 200，超发静默夹取（loom history.ts normalizeLimit 行为）。
        """
        try:
            params: Dict[str, Any] = {"limit": limit}
            if before:
                params["before"] = before
            status, data, headers = await self._request(
                "GET", f"/sessions/{session_id}/history", params=params
            )
            if status != 200:
                return None, None, self._error_detail(status, data)
            raw_msgs = data.get("messages") if isinstance(data, dict) else None
            msgs = loom_messages.to_opencode_messages(raw_msgs or [], session_id)
            next_cursor = headers.get("x-next-cursor") or headers.get("X-Next-Cursor") \
                or (data.get("nextCursor") if isinstance(data, dict) else None) or None
            return msgs, next_cursor, None
        except Exception as e:
            logger.error("获取会话消息分页失败: %s", redact_text(str(e)))
            return None, None, redact_text(str(e))

    async def get_providers(self) -> Tuple[Optional[Dict], Optional[str]]:
        """GET /catalog/models → 归一为 opencode /config/providers 形状供信封层复用。

        loom 模型目录是平表 [{id,provider,...}]；按 provider 分组成
        {"providers":[{id,name,models:{mid:{id,name}}}]}（无密钥字段，只取分组所需键）。
        """
        try:
            status, data, _ = await self._request(
                "GET", "/catalog/models", timeout=aiohttp.ClientTimeout(total=10)
            )
            if status != 200:
                return None, self._error_detail(status, data)
            models = data.get("models") if isinstance(data, dict) else None
            grouped: Dict[str, Dict[str, Any]] = {}
            for m in models or []:
                if not isinstance(m, dict) or not m.get("id"):
                    continue
                pid = str(m.get("provider") or "loom")
                slot = grouped.setdefault(pid, {"id": pid, "name": pid, "models": {}})
                slot["models"][m["id"]] = {"id": m["id"], "name": m.get("name") or m["id"]}
            return {"providers": list(grouped.values())}, None
        except Exception as e:
            logger.error("获取提供商列表失败: %s", redact_text(str(e)))
            return None, redact_text(str(e))

    async def get_active_model_context_window(self) -> Optional[Dict[str, Any]]:
        """GET /catalog/models → 当前主模型上下文窗口（前端 used/max 分母）。

        loom 主模型契约：`models[0]` 即生效主模型（axeuh-harness
        serve/model-source.ts 的 main 选择；catalog 按 config models[] 原序透出）。
        只认 200 + models 为非空 list + 首条为 dict + contextWindow 为正整数，
        其余一律 None（含 mock 态、传输异常、非法形状），**永不抛**——上下文窗口
        是纯展示增量，拿不到就退化为无上限展示。
        5s 短超时：设置页热路径，慢引擎不如先不回。
        """
        if self._offline_mode():
            return None
        try:
            status, data, _ = await self._request(
                "GET", "/catalog/models",
                timeout=aiohttp.ClientTimeout(total=5),
            )
            if status != 200 or not isinstance(data, dict):
                logger.debug(f"loom 模型目录不可得（上下文窗口降级为空）: status={status}")
                return None
            models = data.get("models")
            first = models[0] if isinstance(models, list) and models else None
            if not isinstance(first, dict):
                logger.debug("loom 模型目录无可识别条目（上下文窗口降级为空）")
                return None
            window = first.get("contextWindow")
            # bool 是 int 子类，显式排除；零/负数同样不可作分母
            if isinstance(window, bool) or not isinstance(window, int) or window <= 0:
                logger.debug(f"loom 主模型 contextWindow 非正整数: {window!r}")
                return None
            model = first.get("id")
            provider = first.get("provider")
            return {
                "model": model if isinstance(model, str) and model else None,
                "provider": provider if isinstance(provider, str) and provider else None,
                "contextWindow": window,
            }
        except Exception as e:
            logger.debug("loom 上下文窗口请求异常（降级为空）: %s", redact_text(str(e)))
            return None

    async def _raw_get_tasks(self) -> Tuple[Optional[List[Dict]], Optional[str]]:
        """GET /tasks → TaskView 平铺行（task-api/routes.ts:173-178 不读 searchParams，
        无服务端过滤——调用方全量拉后客户端筛选；行形状 {task_id,run_id,agent_type,
        parent_session,workflow,session_id,status,dispatched_at,title,...}，其中
        dispatched_at 为毫秒整值、title 为人读标题（W49.2 注入，行内可缺），
        字段可缺一律 .get 防御读）。"""
        try:
            status, data, _ = await self._request("GET", "/tasks")
            if status != 200:
                return None, self._error_detail(status, data)
            tasks = data.get("tasks") if isinstance(data, dict) else None
            if not isinstance(tasks, list):
                return [], None
            return tasks, None
        except Exception as e:
            logger.error("获取任务列表失败: %s", redact_text(str(e)))
            return None, redact_text(str(e))

    async def stream_session_events(self, session_id: str):
        """单会话 SSE 上游，逐行 yield 原始文本（不做信封加工，代理层统一处理）。

        loom 帧形如 `data:{seq,payload:{type,properties}}`（默认 message 事件、无 event: 行），
        与 opencode 信封同构，故 routers/events.py 的 _process_sse_line 双通道复用。
        连接失败/服务端结束流直接抛（断连重连与多会话扇出归 LoomEventHub 管理）。
        """
        headers = self._auth({"Accept": "text/event-stream"})
        timeout = aiohttp.ClientTimeout(total=None, connect=30)
        async with aiohttp.ClientSession(timeout=timeout, connector=aiohttp.TCPConnector()) as client:
            async with client.get(
                f"{self.base_url}/events/stream",
                params={"sessionId": session_id},
                headers=headers,
            ) as response:
                if response.status != 200:
                    raise ConnectionError(f"loom SSE 上游连接失败: HTTP {response.status}")
                buffer = b""
                async for chunk in response.content.iter_any():
                    if not chunk:
                        continue
                    buffer += chunk
                    while b"\n" in buffer:
                        line_bytes, buffer = buffer.split(b"\n", 1)
                        yield line_bytes.decode("utf-8", errors="replace")
                if buffer:
                    yield buffer.decode("utf-8", errors="replace")

    # ==================== 信封公共 API（与 OpenCodeClient 逐键同构） ====================

    @staticmethod
    def _ok(data: Any = None) -> Dict[str, Any]:
        return {"ok": True, "data": data, "error": None}

    @staticmethod
    def _fail(source: str, detail: str, code: int = 500) -> Dict[str, Any]:
        return {"ok": False, "data": None,
                "error": {"source": source, "detail": detail, "code": code}}

    @staticmethod
    def _offline_mode() -> bool:
        """mock 开关——两通道共用 features.opencode_mock_enabled
        （域级"不发真实请求"开关，改名会牵动现网配置，维持复用）。"""
        return get_config().OPENCODE_MOCK_ENABLED

    @staticmethod
    def _mock_session_id() -> str:
        return f"mock_ses_{uuid.uuid4().hex[:12]}"

    @classmethod
    def _mock_sessions(cls) -> List[Dict[str, Any]]:
        return [
            {"session_id": cls._mock_session_id(), "title": "模拟会话1", "created_at": 0, "last_accessed": 0},
            {"session_id": cls._mock_session_id(), "title": "模拟会话2", "created_at": 0, "last_accessed": 0},
        ]

    @classmethod
    def _mock_main_session(cls) -> Dict[str, Any]:
        sid = cls._mock_session_id()
        return {"sessionID": sid, "session_id": sid, "id": sid,
                "status": "idle", "createdAt": 0, "archived": False}

    def get_default_model(self) -> str:
        """默认模型：仍取后端本地真源（config.yaml opencode 节 + model_config.json）。

        决策：模型设置页展示与 prompt 组装用同一默认值，跨通道不漂移；
        loom 实际执行模型由 loom.yaml models[] 服务端配置，不受本值影响。
        """
        return OPENCODE_DEFAULT_MODEL

    def get_default_provider(self) -> str:
        return OPENCODE_DEFAULT_PROVIDER

    async def health_check(self) -> Dict[str, Any]:
        """检查 Loom 服务状态（GET /health；status=="ok" 视为在线）。"""
        if self._offline_mode():
            return self._ok({"status": "mock", "mode": "offline"})
        try:
            status, data, _ = await self._request(
                "GET", "/health", timeout=aiohttp.ClientTimeout(total=10)
            )
            if status == 200:
                payload = {"status": "online", "mode": "online"}
                if isinstance(data, dict):
                    version = data.get("version")
                    if isinstance(version, str) and version:
                        payload["version"] = version
                return self._ok(payload)
            return self._ok({"status": "offline", "mode": "online",
                             "detail": self._error_detail(status, data)})
        except Exception as e:
            return self._ok({"status": "offline", "mode": "online", "detail": redact_text(str(e))})

    async def create_session(self, title: Optional[str] = None,
                             directory: Optional[str] = None) -> Dict[str, Any]:
        """创建 Loom 会话（title 由后端本地会话管理器维护，loom 侧不落）。

        W40 回正（用户 2026-10-14"按后端实际指定的会话id来"）：会话 sid 的指定权在
        loom 后端（POST /sessions 返回什么就用什么）；loom 的会话执行面 registry.#ensure
        对任意 sid 同构（persona/roster/工具面共享），不存在"只有某 id 才是小贺"的
        单例约束——此前硬编码收敛属误诊撤回。
        """
        if self._offline_mode():
            return self._ok({"session_id": self._mock_session_id(), "title": title or "模拟会话"})
        try:
            session_id, error = await self._raw_create_session(title=title, directory=directory)
            if error:
                return self._fail("loom", error)
            return self._ok({"session_id": session_id, "title": title or "语音交互会话"})
        except Exception as e:
            return self._fail("system", f"create_session 异常: {e}")

    async def get_main_session(self) -> Dict[str, Any]:
        """主会话对象信封（GET /sessions/main；loom 专有，主会话单例语义）。"""
        if self._offline_mode():
            return self._ok(self._mock_main_session())
        try:
            data, error = await self._raw_get_main_session()
            if error:
                return self._fail("loom", error)
            return self._ok(data)
        except Exception as e:
            return self._fail("system", f"get_main_session 异常: {e}")

    async def get_main_session_id(self) -> str:
        """主会话 id；不可用即抛 ConnectionError（SSE 发现等 fail-loud 调用方）。"""
        if self._offline_mode():
            return self._mock_session_id()
        data, error = await self._raw_get_main_session()
        if error:
            raise ConnectionError(error)
        session_id = (data or {}).get("sessionID")
        if not session_id:
            raise ConnectionError("loom 主会话不可用: 响应缺少 sessionID")
        return session_id

    @staticmethod
    def _normalize_session_row(row: Dict[str, Any]) -> Dict[str, Any]:
        """归一补 session_id/id 双键（沿用旧 list_sessions 行形，主会话消息零改动消费）。"""
        if row.get("sessionID") and "session_id" not in row:
            row["session_id"] = row["sessionID"]
            row.setdefault("id", row["sessionID"])
        return row

    async def list_sessions(self, limit: int = 20,
                            session_id: Optional[str] = None) -> Dict[str, Any]:
        """列出 Loom 会话（主会话单例语义，绝不调用已废弃的 GET /sessions 列表面）。

        - 带 session_id：先 GET /sessions/{id}/status 探活；200 返回该会话单行；
          404（旧绑定已非主会话/已删除）回退 GET /sessions/main；传输/非 404 失败信封。
        - 不带 session_id：直接 GET /sessions/main 返回单行。
        行归一补 session_id/id 双键（旧 list_sessions 行为不变）。
        """
        if self._offline_mode():
            return self._ok({"sessions": self._mock_sessions()[:limit]})
        try:
            if session_id:
                status, data, _ = await self._request(
                    "GET", f"/sessions/{session_id}/status"
                )
                if status == 200 and isinstance(data, dict):
                    return self._ok({"sessions": [
                        self._normalize_session_row(data)
                    ][:limit]})
                if status != 404:
                    return self._fail("loom", self._error_detail(status, data))
            main, error = await self._raw_get_main_session()
            if error:
                return self._fail("loom", error)
            return self._ok({"sessions": [self._normalize_session_row(main)][:limit]})
        except Exception as e:
            return self._fail("system", f"list_sessions 异常: {e}")

    async def get_session_status(self, session_id: str) -> Dict[str, Any]:
        if self._offline_mode():
            return self._ok({"session_id": session_id, "status": "active"})
        try:
            data, error = await self._raw_get_session_status(session_id)
            if error:
                return self._fail("loom", error)
            return self._ok(data or {})
        except Exception as e:
            return self._fail("system", f"get_session_status 异常: {e}")

    async def abort_session(self, session_id: str,
                            directory: Optional[str] = None) -> Dict[str, Any]:
        if self._offline_mode():
            return self._ok({"aborted": True, "session_id": session_id})
        try:
            aborted, error = await self._raw_abort_session(session_id, directory=directory)
            if error:
                return self._fail("loom", error)
            return self._ok({"aborted": aborted, "session_id": session_id})
        except Exception as e:
            return self._fail("system", f"abort_session 异常: {e}")

    async def send_message(self, session_id: str, message: str,
                           agent: Optional[str] = None,
                           model_id: Optional[str] = None,
                           provider_id: Optional[str] = None,
                           directory: Optional[str] = None) -> Dict[str, Any]:
        """发送消息（agent/model/provider 参数被忽略，见模块头映射决策）。

        信封 data 含纯增量键 queued（W43：True=入 FIFO 队列，None=body 未带该键；
        排队对调用方透明的 D1 语义不变，ok 判定与 queued 无关）。
        """
        if self._offline_mode():
            return self._ok({"sent": True, "session_id": session_id, "queued": None,
                             "message": message[:50] + "..." if len(message) > 50 else message})
        try:
            logger.info("[LOOM-CLIENT] session=%s, message_chars=%d",
                        session_id, len(message))
            success, error, queued = await self._raw_send_message(
                session_id=session_id, message=message,
                agent=agent, model_id=model_id, provider_id=provider_id, directory=directory
            )
            if error:
                return self._fail("loom", error)
            return self._ok({"sent": success, "session_id": session_id, "queued": queued})
        except Exception as e:
            return self._fail("system", f"send_message 异常: {e}")

    async def send_voice_to_opencode(self, text: str, agent: str = "main-task") -> bool:
        """统一语音消息发送：获取/创建 agent 会话 → loom 原生 /voice（立接立回 202，
        W16-F2：abort→旧轮收尾→起轮在 loom 后台链跑）。

        方法名沿用 opencode 后缀（同构契约面，调用方零改名）。
        opencode 版的"abort + send"两步在 loom 是单端点即时受理语义（同步侧不等
        旧轮），会话绑定与回退逻辑逐行对齐 opencode 版。
        """
        from services.stt_session_manager import get_session_manager

        session_mgr = get_session_manager()

        session_id = session_mgr.get_agent_session(agent)
        logger.info(f"[LOOM-CLIENT] send_voice agent={agent}, found_session={session_id}")

        if not session_id:
            result = await self.create_session(title="语音交互会话")
            if result["ok"]:
                session_id = result["data"]["session_id"]
                session_mgr.set_agent_session(agent, session_id)
                session_mgr.set_current_session(session_id, "语音交互会话")
                logger.info(f"[LOOM-CLIENT] 为 agent={agent} 创建会话: {session_id}")
            else:
                logger.error(f"[LOOM-CLIENT] 创建会话失败: {result.get('error', {}).get('detail', '未知错误')}")
                return False

        success, error = await self._raw_voice_send(session_id, text)
        if error:
            logger.error(f"[LOOM-CLIENT] 发送语音消息失败: {error}")
            return False
        logger.info("[LOOM-CLIENT] 语音消息已发送到 agent=%s: text_chars=%d", agent, len(text))
        return True

    async def get_available_models(self) -> Dict[str, Any]:
        """可用模型列表（GET /catalog/models → 按 provider 分组，应用排除策略）。"""
        if self._offline_mode():
            return self._ok({"providers": [
                {"id": "mock-provider", "name": "模拟提供商", "models": [
                    {"id": OPENCODE_DEFAULT_MODEL, "name": OPENCODE_DEFAULT_MODEL}
                ]}
            ]})
        try:
            load_model_config()  # 排除清单/默认值真源与 opencode 通道同一份 model_config.json
            data, error = await self.get_providers()
            if error:
                logger.warning(f"从 Loom 获取模型目录失败: {error}，使用空列表")
                return self._ok({"providers": []})

            providers_out = []
            for pv in (data or {}).get("providers", []):
                if not isinstance(pv, dict):
                    continue
                pid = pv.get("id") or ""
                model_list = [
                    {"id": mid, "name": (m or {}).get("name") or mid}
                    for mid, m in (pv.get("models") or {}).items()
                    if not _is_model_excluded(pid, mid)
                ]
                if pid and model_list:
                    providers_out.append({"id": pid, "name": pv.get("name") or pid,
                                          "models": model_list})
            return self._ok({"providers": providers_out})
        except Exception as e:
            safe_error = redact_text(str(e))
            logger.error("get_available_models 异常: %s", safe_error)
            return self._fail("system", f"get_available_models 异常: {safe_error}")

    async def summarize_session(
        self,
        session_id: str,
        model_id: Optional[str] = None,
        provider_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """触发 Loom 手动压缩（worker 后台执行；model/provider 参数仅为接口同构保留）。"""
        if self._offline_mode():
            return self._ok({"status": "compacting", "session_id": session_id, "mock": True})
        try:
            status, data, _ = await self._request(
                "POST",
                f"/sessions/{session_id}/compact",
                json_body={},
                timeout=aiohttp.ClientTimeout(total=15),
            )
            if status in (200, 202) and isinstance(data, dict):
                return self._ok(data)
            return self._fail("loom", self._error_detail(status, data), code=status)
        except Exception as e:
            return self._fail("loom", f"summarize_session 异常: {e}", code=502)

    async def get_session_messages(self, session_id: str, limit: int = 100,
                                   before: Optional[str] = None) -> Dict[str, Any]:
        if self._offline_mode():
            return self._ok({"messages": [], "session_id": session_id, "next_cursor": None})
        try:
            messages, next_cursor, error = await self._raw_get_session_messages_page(
                session_id, limit=limit, before=before
            )
            if error:
                return self._fail("loom", error)
            return self._ok({
                "messages": messages or [],
                "session_id": session_id,
                "next_cursor": next_cursor,
            })
        except Exception as e:
            return self._fail("system", f"get_session_messages 异常: {e}")

    async def get_session_compaction(self, session_id: str) -> Optional[Dict[str, Any]]:
        """GET /sessions/:id/compaction → 核内自动压缩边界快照（W51，历史分隔线只读面）。

        loom 非 opencode 同构方法（opencode 手动压缩走 session.compacted 事件，
        无此查询面）；唯一消费方 = routers/session.py 历史路由的压缩分隔线注入。
        fail-open 契约：超时/连接炸/非 200/body 非 dict/mock 态一律 None + debug 日志，
        **永不抛**——失败=无分隔线=今日行为，绝不阻塞历史主链。
        2s 短超时：历史页是 UI 热路径，慢引擎不如降级无线。
        快照体形状（W51A 契约）：{sessionID, status:"active"|"none", coveredCount,
        summaryText, anchorMessageId, anchorTimestampMs, tailCount, totalMessages}。
        """
        if self._offline_mode():
            return None
        try:
            status, data, _ = await self._request(
                "GET", f"/sessions/{session_id}/compaction",
                timeout=aiohttp.ClientTimeout(total=2),
            )
            if status != 200 or not isinstance(data, dict):
                logger.debug(f"loom compaction 快照不可得（降级无分隔线）: "
                             f"session={session_id} status={status}")
                return None
            return data
        except Exception as e:
            logger.debug("loom compaction 快照请求异常（降级无分隔线）: "
                         "session=%s err=%s", session_id, redact_text(str(e)))
            return None

    async def get_session_children(self, session_id: str) -> Dict[str, Any]:
        """子会话列表（W29-A2/D3）：GET /tasks 全量 + parent_session 客户端过滤。

        信封键与 opencode_client.get_session_children 逐键同构（{"children": [...]}），
        routers/session.py:326 双通道零分支。映射（W49.3 补 createdAt，title 见下）：
        id<-session_id；title<-行内 title 优先（W49.2 loom 侧注入的人读标题，字段
        可缺），缺则 agent_type、再缺 workflow 回填——否则前端 API 源
        （优先级高于消息扫描真名，useSubAgents.ts:159）显示"子智能体"泛称；
        type<-agent_type；status<-status 逐字；createdAt<-dispatched_at 毫秒整值
        原样转发（行缺该键→None，键恒在；0 亦原样=前端把 ≤0 一律当缺失）。
        服务层不排序，行序原样透传（排序归前端）。session_id 为 null 的行=账本-only
        gap（任务已派生、子会话未落，无转录对象）跳过并 debug；/tasks 行字段
        可缺→全程 .get 防御读，绝不崩。
        """
        if self._offline_mode():
            return self._ok({"children": []})
        try:
            rows, error = await self._raw_get_tasks()
            if error:
                return self._fail("loom", error)
            children: List[Dict[str, Any]] = []
            for row in rows or []:
                if not isinstance(row, dict) or row.get("parent_session") != session_id:
                    continue
                child_sid = row.get("session_id")
                if not child_sid:
                    # 账本-only gap 行：无子会话 id 即无转录入口，前端消费不了
                    logger.debug(f"children 跳过 session_id 为空的账本行: task={row.get('task_id')}")
                    continue
                agent_type = row.get("agent_type") or ""
                children.append({
                    "id": child_sid,
                    "title": row.get("title") or agent_type or (row.get("workflow") or ""),
                    "type": agent_type,
                    "status": row.get("status"),
                    "createdAt": row.get("dispatched_at"),
                })
            return self._ok({"children": children})
        except Exception as e:
            return self._fail("system", f"get_session_children 异常: {e}")

    async def get_session_messages_range(
        self,
        session_id: str,
        start_ms: Optional[int] = None,
        end_ms: Optional[int] = None,
        max_pages: int = 50,
        page_size: int = 200,
    ) -> Dict[str, Any]:
        """时间窗内分页拉取（翻页/排序/截断语义与 opencode 版逐行一致）。

        消息已是 {info.time.created} 毫秒升序（loom_messages 转换保证），
        跨页从新到旧（before 游标翻更早）与 opencode 同形。
        """
        if self._offline_mode():
            return self._ok({"messages": [], "truncated": False})

        collected: List[Dict] = []
        before: Optional[str] = None
        truncated = False

        try:
            for _ in range(max_pages):
                page, next_cursor, error = await self._raw_get_session_messages_page(
                    session_id, limit=page_size, before=before
                )
                if error:
                    return self._fail("loom", error)
                if not page:
                    break

                collected.extend(page)

                first_ts = page[0].get("info", {}).get("time", {}).get("created")
                if start_ms is not None and isinstance(first_ts, (int, float)) and first_ts < start_ms:
                    break

                if not next_cursor:
                    break
                before = next_cursor
            else:
                truncated = True

            messages = sorted(
                collected,
                key=lambda m: (m.get("info", {}).get("time", {}).get("created") or 0),
            )
            return self._ok({"messages": messages, "truncated": truncated})
        except Exception as e:
            return self._fail("system", f"get_session_messages_range 异常: {e}")

    async def get_active_sessions(self) -> Dict[str, Any]:
        """活动会话列表（loom 主会话单例语义，绝不调用已废弃的列表面）。"""
        if self._offline_mode():
            return self._ok({"active_sessions": self._mock_sessions()})
        try:
            main, error = await self._raw_get_main_session()
            if error:
                return self._fail("loom", error)
            return self._ok({"active_sessions": [self._normalize_session_row(main)]})
        except Exception as e:
            return self._fail("system", f"get_active_sessions 异常: {e}")


# 单例实例（无端口探测：loom 固定监听，见模块头决策）
_loom_client: Optional[LoomClient] = None
_offline_client: Optional[LoomClient] = None


def get_loom_client() -> LoomClient:
    """获取 Loom 客户端单例（同步工厂，构造零 IO）。"""
    global _loom_client
    if _loom_client is None:
        _loom_client = LoomClient(base_url=get_config().LOOM_URL)
    return _loom_client


async def acquire_loom_client() -> LoomClient:
    """异步获取 Loom 客户端单例（mock 开关注离线实例，与 acquire_opencode_client 对称）。"""
    global _loom_client, _offline_client
    if _loom_client is not None:
        return _loom_client
    if get_config().OPENCODE_MOCK_ENABLED:
        if _offline_client is None:
            _offline_client = LoomClient(base_url=get_config().LOOM_URL)
        return _offline_client
    # 构造无阻塞 IO（无端口探测），直接在循环内建实例即可
    _loom_client = get_loom_client()
    return _loom_client


def _reset_loom_client() -> None:
    """重置客户端单例（仅测试用）。"""
    global _loom_client, _offline_client
    _loom_client = None
    _offline_client = None


def reload_static_config() -> None:
    """从 config 单例重新快照 loom 静态配置（ConfigStore 热重载钩子）。

    默认 agent/model/provider 是 import 期从 opencode_client 拷贝的绑定，必须在
    ``opencode_client.reload_static_config()`` **之后**调用本函数才能拿到新值。
    token 不在此快照：``_bearer_token()`` 每次现读 get_config().LOOM_TOKEN。
    """
    global _cfg, LOOM_CONFIG_URL
    global OPENCODE_DEFAULT_AGENT, OPENCODE_DEFAULT_MODEL, OPENCODE_DEFAULT_PROVIDER

    from services import opencode_client as opencode_module

    _cfg = get_config()
    LOOM_CONFIG_URL = _cfg.LOOM_URL
    OPENCODE_DEFAULT_AGENT = opencode_module.OPENCODE_DEFAULT_AGENT
    OPENCODE_DEFAULT_MODEL = opencode_module.OPENCODE_DEFAULT_MODEL
    OPENCODE_DEFAULT_PROVIDER = opencode_module.OPENCODE_DEFAULT_PROVIDER

    _reset_loom_client()
