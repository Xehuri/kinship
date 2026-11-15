"""dsh Client —— Kinship 后端到 dsh kinship-bridge 插件的 HTTP 客户端。

对上层暴露与 services.loom_client.LoomClient / services.opencode_client.OpenCodeClient
同构的公共接口面（同名方法/同签名/同 {"ok","data","error"} 信封），调用方经
services.ai_client_factory 按 config.yaml ai_backend 择一，零改其余代码。

Bridge 契约（插件侧 127.0.0.1:18765；Bearer 取 config dsh.token > dsh.token_file
> DSH_TOKEN / KINSHIP_BRIDGE_TOKEN 环境变量）：
    GET  /v1/health              {ok,version,dsh,session_id,preset,status}
    GET  /v1/session             {session_id,preset,status,bound_at,policy}
    POST /v1/session/messages    {text,source?} -> 202 {accepted,message_id,session_id}
    POST /v1/session/abort       -> 202 {ok,session_id,was_running}
    GET  /v1/session/status      {session_id,status,running,last_turn_at}
    GET  /v1/session/messages?limit=&before= -> {messages,has_more,next_before}
                                 （before/next_before 是事件 seq 整数，非不透明游标）
    GET  /v1/session/children    -> {children}
    GET  /v1/models              {providers:[{id,name,models:[{id,name}]}]}（未绑定 409）
    GET  /v1/session/context     {session_id,provider,model,contextWindow,...}
    POST /v1/session/compact     空 body -> 202 {accepted,session_id,status:"compacting"}
                                 409 {error:"compaction_busy"} / 500 {error:"compaction_unavailable"}
    GET  /v1/session/compaction  {session_id,status:"none"|"active",covered_count,
                                  summary_text,anchor_message_id,anchor_timestamp_ms}
    GET  /v1/session/events      SSE `data: {seq,payload:{type,properties}}`
    POST /v1/inbox               （letter 投递，本客户端不实现，见下）

单会话架构映射决策：
  - create_session 返回 bridge 已绑定的会话（bind 由插件侧完成，后端不建会话）；
    list_sessions/get_active_sessions/get_main_session 恒只返回该单行。
  - 写/读/状态/子会话方法里的 session_id 是接口同构标签：bridge 只有唯一绑定
    会话，传值不等于当前绑定（切流后本地 usersessions.json 残留旧 id）时一律
    归一到绑定会话，响应回传真实 id；单会话后端不存在第二个投递目标。
    list_sessions(session_id=...) 例外：作为"该 id 是否属于本后端"的过滤面，
    不匹配返回空列表。
  - send_message 保留 <Axeuh-home-system> 当前时间信封（与 Loom/opencode 逐字符
    同形；bridge 契约未声明由插件注入，故后端继续拥有该包装）。
  - agent/model_id/provider_id/directory 参数接受但忽略：dsh preset kinship 的模型
    与工具面由 preset 决定，无 per-message 选择。
  - 手动压缩：summarize_session 以**空 body** 转发 POST /v1/session/compact；
    bridge 202=已受理（后台执行，完成经 SSE 事件回流），返回
    {session_id, status:"compacting"} 与 Loom 同构。409 compaction_busy（会话非
    idle）与 500 compaction_unavailable（该 harness 组合无手动压缩命令）原样透出
    状态码；未绑定 409 no_kinship_session 同走 409 分支。
  - 压缩快照：get_session_compaction 读 GET /v1/session/compaction，把 bridge 的
    snake_case 快照归一为 loom W51A **camelCase** 形状（唯一消费方
    routers/session.py 历史页分隔线逐键认这六个键）；fail-open：任何失败=None
    + debug 日志，**永不抛**，失败=无分隔线=原有行为。
  - 模型目录：get_available_models 读 GET /v1/models，按 opencode/loom 同款规则
    归一成 {"providers":[{id,name,models:[{id,name}]}]}（非法行丢弃、无有效模型的
    provider 不出现、model name 缺省回退 id）；请求失败/形状非法一律保持历史降级
    形态空 providers——模型设置页仍以本地 model_config 为真源。
  - 上下文窗口：get_active_model_context_window 读 GET /v1/session/context，只认
    contextWindow 为正整数，其余 None（纯展示增量，永不抛；契约与
    LoomClient 同名方法逐键同构）。
  - 收件箱 letter 仍无对应端点：send_letter/get_inbox_result/get_inbox_status
    故意不提供——调用方（task_executor/task_scheduler）以 getattr 守卫并按
    "当前后端不支持"降级，绝不留下假装可用的空实现。
"""

# noqa: SIZE_OK —— 单类同构契约（与 LoomClient/OpenCodeClient 逐一镜像的公共
# 方法面 + dsh 单会话映射），不可跨文件拆分；无可复用内部逻辑可再抽。

import json
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple, Union

import aiohttp

from config.config import get_config
from core.redaction import redact_text
from services import dsh_messages
from services.opencode_client import (
    OPENCODE_DEFAULT_MODEL,
    OPENCODE_DEFAULT_PROVIDER,
)

logger = logging.getLogger(__name__)


def _bearer_token() -> Optional[str]:
    """当前 dsh bridge Bearer token；空 = 不带头（bridge 可配置 loopback 免鉴权）。"""
    return get_config().DSH_TOKEN or None


class DshClient:
    """dsh kinship-bridge 客户端（接口面与 Loom/OpenCodeClient 同构）。"""

    backend_name = "dsh"

    def __init__(self, base_url: Optional[str] = None, timeout: Optional[float] = None):
        cfg = get_config()
        self.base_url = (base_url or cfg.DSH_URL).rstrip("/")
        self.timeout = float(timeout if timeout is not None else cfg.DSH_TIMEOUT_SECONDS)

    def _auth(self, headers: Optional[Dict[str, str]] = None) -> Dict[str, str]:
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
        timeout: Optional[float] = None,
    ) -> Tuple[int, Any, Dict[str, str]]:
        """一次 bridge HTTP 调用 -> (status, 解析后 body, headers)；传输异常上抛。"""
        headers = self._auth({"Accept": "application/json"})
        if json_body is not None:
            headers["Content-Type"] = "application/json"
        budget = aiohttp.ClientTimeout(total=timeout if timeout is not None else self.timeout)
        async with aiohttp.ClientSession(timeout=budget) as client:
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
        if isinstance(data, dict):
            err = data.get("error")
            if isinstance(err, dict) and err.get("message"):
                return redact_text(f"HTTP {status}: {err['message']}")
            return redact_text(f"HTTP {status}: {json.dumps(data, ensure_ascii=False)[:300]}")
        return redact_text(f"HTTP {status}: {str(data)[:300]}")

    @staticmethod
    def _ok(data: Any = None) -> Dict[str, Any]:
        return {"ok": True, "data": data, "error": None}

    @staticmethod
    def _fail(source: str, detail: str, code: int = 500) -> Dict[str, Any]:
        return {"ok": False, "data": None,
                "error": {"source": source, "detail": detail, "code": code}}

    @staticmethod
    def _format_message(message: str) -> str:
        cur_datetime = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        return f"""<Axeuh-home-system>
{json.dumps({"current_datetime": cur_datetime}, ensure_ascii=False, indent=2)}
</Axeuh-home-system>

{message}"""

    @staticmethod
    def _session_row(data: Dict[str, Any]) -> Dict[str, Any]:
        sid = str(data.get("session_id"))
        return {
            "sessionID": sid,
            "session_id": sid,
            "id": sid,
            "status": data.get("status") or "idle",
            "title": data.get("title") or "主会话",
            "createdAt": data.get("bound_at"),
            "bound_at": data.get("bound_at"),
            "preset": data.get("preset"),
            "policy": data.get("policy"),
        }

    async def _session(self) -> Tuple[Optional[Dict[str, Any]], Optional[str], int]:
        """GET /v1/session -> (归一单行, error, code)；未绑定按 404 语义上报。"""
        try:
            status, data, _ = await self._request("GET", "/v1/session")
        except Exception as e:
            return None, redact_text(f"dsh 会话查询异常: {e}"), 502
        if status != 200 or not isinstance(data, dict):
            return None, self._error_detail(status, data), status if status >= 400 else 502
        if not data.get("session_id"):
            return None, "HTTP 404: dsh kinship 会话未绑定", 404
        return self._session_row(data), None, 0

    async def _require_bound(self) -> Tuple[Optional[str], Optional[str], int]:
        """取 bridge 唯一绑定会话 id；未绑定/不可达 -> (None, detail, code)。

        单会话后端不存在第二目标：调用方传入的 session_id 仅作接口同构标签，
        方法层一律归一到本值（配置从 loom/opencode 切到 dsh 后，本地
        usersessions.json 仍带旧 id，硬失败只会让迁移后的首次消息无谓失败）。
        响应信封回传的始终是真实绑定 id。
        """
        row, error, code = await self._session()
        if error or row is None:
            return None, error or "dsh 会话不可用", code
        return row["sessionID"], None, 0

    async def _page(
        self, session_id: str, limit: int = 100,
        before: Optional[Union[str, int]] = None,
    ) -> Tuple[Optional[List[Dict[str, Any]]], Optional[Union[str, int]], Optional[str]]:
        params: Dict[str, Any] = {"limit": min(max(int(limit), 1), 200)}
        if before is not None:
            params["before"] = before
        status, data, _ = await self._request("GET", "/v1/session/messages", params=params)
        if status != 200 or not isinstance(data, dict):
            return None, None, self._error_detail(status, data)
        raw = data.get("messages")
        if not isinstance(raw, list):
            return None, None, "dsh 消息响应缺少 messages 列表"
        messages = dsh_messages.to_opencode_messages(raw, session_id)
        cursor = data.get("next_before")
        if cursor is None:
            cursor = data.get("next_cursor")
        if cursor is None:
            cursor = data.get("nextCursor")
        return messages, cursor, None

    async def stream_session_events(self, session_id: str):
        """单会话 SSE 上游，逐行 yield 原始文本（不做信封加工，代理层统一处理）。

        session_id 为接口同构保留：bridge 的 /v1/session/events 只服务已绑定会话，
        不按参数分路。连接失败/服务端结束流直接抛（重连归 DshEventHub 管理）。
        """
        headers = self._auth({"Accept": "text/event-stream"})
        timeout = aiohttp.ClientTimeout(total=None, connect=30)
        async with aiohttp.ClientSession(timeout=timeout) as client:
            async with client.get(
                f"{self.base_url}/v1/session/events", headers=headers
            ) as response:
                if response.status != 200:
                    raise ConnectionError(f"dsh SSE 上游连接失败: HTTP {response.status}")
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

    def get_default_model(self) -> str:
        return OPENCODE_DEFAULT_MODEL

    def get_default_provider(self) -> str:
        return OPENCODE_DEFAULT_PROVIDER

    async def health_check(self) -> Dict[str, Any]:
        try:
            status, data, _ = await self._request("GET", "/v1/health", timeout=10)
            if status == 200 and isinstance(data, dict):
                payload = {
                    "status": "online",
                    "mode": "online",
                    "version": data.get("version"),
                    "session_id": data.get("session_id"),
                }
                return self._ok(payload)
            return self._ok({"status": "offline", "mode": "online",
                             "detail": self._error_detail(status, data)})
        except Exception as e:
            return self._ok({"status": "offline", "mode": "online",
                             "detail": redact_text(str(e))})

    async def create_session(self, title: Optional[str] = None,
                             directory: Optional[str] = None) -> Dict[str, Any]:
        row, error, code = await self._session()
        if error or row is None:
            return self._fail("dsh", error or "dsh 会话不可用", code=code)
        return self._ok({"session_id": row["sessionID"], "title": title or row["title"]})

    async def get_main_session(self) -> Dict[str, Any]:
        row, error, code = await self._session()
        if error or row is None:
            return self._fail("dsh", error or "dsh 会话不可用", code=code)
        return self._ok(row)

    async def get_main_session_id(self) -> str:
        result = await self.get_main_session()
        if not result["ok"]:
            detail = (result.get("error") or {}).get("detail") or "dsh 主会话不可用"
            raise ConnectionError(str(detail))
        session_id = (result.get("data") or {}).get("sessionID")
        if not session_id:
            raise ConnectionError("dsh 主会话不可用: 响应缺少 session_id")
        return str(session_id)

    async def list_sessions(self, limit: int = 20,
                            session_id: Optional[str] = None) -> Dict[str, Any]:
        row, error, code = await self._session()
        if error or row is None:
            return self._fail("dsh", error or "dsh 会话不可用", code=code)
        sessions = [] if session_id and str(session_id) != row["sessionID"] else [row]
        return self._ok({"sessions": sessions[:limit]})

    async def get_session_status(self, session_id: str) -> Dict[str, Any]:
        bound_id, error, code = await self._require_bound()
        if error:
            return self._fail("dsh", error, code=code)
        try:
            status, data, _ = await self._request("GET", "/v1/session/status")
            if status != 200 or not isinstance(data, dict):
                return self._fail("dsh", self._error_detail(status, data),
                                  code=status if status >= 400 else 502)
            sid = str(data.get("session_id") or bound_id)
            return self._ok({"sessionID": sid, "session_id": sid, "id": sid,
                             "status": data.get("status") or "idle",
                             "running": bool(data.get("running")),
                             "last_turn_at": data.get("last_turn_at")})
        except Exception as e:
            return self._fail("system", f"get_session_status 异常: {e}")

    async def abort_session(self, session_id: str,
                            directory: Optional[str] = None) -> Dict[str, Any]:
        bound_id, error, code = await self._require_bound()
        if error:
            return self._fail("dsh", error, code=code)
        try:
            status, data, _ = await self._request("POST", "/v1/session/abort")
            if status not in (200, 202):
                return self._fail("dsh", self._error_detail(status, data),
                                  code=status if status >= 400 else 502)
            was_running = data.get("was_running") if isinstance(data, dict) else None
            aborted = bool(was_running) if isinstance(was_running, bool) else True
            return self._ok({"aborted": aborted, "session_id": bound_id})
        except Exception as e:
            return self._fail("system", f"abort_session 异常: {e}")

    async def send_message(self, session_id: str, message: str,
                           agent: Optional[str] = None,
                           model_id: Optional[str] = None,
                           provider_id: Optional[str] = None,
                           directory: Optional[str] = None) -> Dict[str, Any]:
        bound_id, error, code = await self._require_bound()
        if error:
            return self._fail("dsh", error, code=code)
        try:
            logger.info("[DSH-CLIENT] session=%s, message_chars=%d", bound_id, len(message))
            status, data, _ = await self._request(
                "POST", "/v1/session/messages",
                json_body={"text": self._format_message(message)},
            )
            accepted = isinstance(data, dict) and bool(data.get("accepted", True))
            if status == 202 and accepted:
                message_id = data.get("message_id") if isinstance(data, dict) else None
                return self._ok({"sent": True, "session_id": bound_id,
                                 "message_id": message_id, "queued": None})
            return self._fail("dsh", self._error_detail(status, data),
                              code=status if status >= 400 else 502)
        except Exception as e:
            return self._fail("system", f"send_message 异常: {e}")

    async def send_voice_to_opencode(self, text: str, agent: str = "main-task") -> bool:
        """语音投递：唯一绑定会话 abort（打断在途轮）后发消息，与 Loom /voice 语义对齐。"""
        try:
            session_id = await self.get_main_session_id()
        except ConnectionError as e:
            logger.error("[DSH-CLIENT] 语音投递失败（会话不可用）: %s", redact_text(str(e)))
            return False
        await self.abort_session(session_id)
        result = await self.send_message(session_id=session_id, message=text, agent=agent)
        if result["ok"]:
            logger.info("[DSH-CLIENT] 语音消息已发送: text_chars=%d", len(text))
            return True
        logger.error("[DSH-CLIENT] 语音消息发送失败: %s",
                     redact_text(str(result.get("error"))))
        return False

    async def get_available_models(self) -> Dict[str, Any]:
        """GET /v1/models -> 归一 opencode/loom 同构 providers（失败=空目录降级）。

        bridge 已把 harness 模型目录整成 [{id,name,models:[{id,name}]}]；本层按两
        通道同款规则防御过滤：非 dict 行 / 缺 id 的 provider / 缺 id 的 model 丢弃，
        无有效模型的 provider 不出现（与 LoomClient.get_available_models 一致），
        model name 缺省回退 id。任何失败（非 200 / body 非 dict / providers 非 list
        / 传输异常）一律保持历史降级形态 {"providers": []} 而非报错——模型设置页
        以本地 model_config 为真源，目录只影响下拉可选项。
        """
        try:
            status, data, _ = await self._request("GET", "/v1/models", timeout=10)
        except Exception as e:
            logger.warning("dsh 模型目录请求异常（降级空目录）: %s",
                           redact_text(str(e)))
            return self._ok({"providers": []})
        if status != 200 or not isinstance(data, dict):
            logger.warning("dsh 模型目录不可得（降级空目录）: %s",
                           self._error_detail(status, data))
            return self._ok({"providers": []})
        raw = data.get("providers")
        if not isinstance(raw, list):
            logger.warning("dsh 模型目录形状非法（降级空目录）: providers 非列表")
            return self._ok({"providers": []})
        providers: List[Dict[str, Any]] = []
        for row in raw:
            if not isinstance(row, dict):
                continue
            pid = row.get("id")
            if not isinstance(pid, str) or not pid:
                continue
            models: List[Dict[str, Any]] = []
            for model in row.get("models") or []:
                if not isinstance(model, dict):
                    continue
                mid = model.get("id")
                if not isinstance(mid, str) or not mid:
                    continue
                name = model.get("name")
                models.append({
                    "id": mid,
                    "name": name if isinstance(name, str) and name else mid,
                })
            if not models:
                continue
            pname = row.get("name")
            providers.append({
                "id": pid,
                "name": pname if isinstance(pname, str) and pname else pid,
                "models": models,
            })
        return self._ok({"providers": providers})

    async def get_active_model_context_window(self) -> Optional[Dict[str, Any]]:
        """GET /v1/session/context -> 当前生效模型上下文窗口（前端 used/max 分母）。

        契约与 LoomClient.get_active_model_context_window 逐键同构：只认 200 +
        body 为 dict + contextWindow 为正整数（bool 是 int 子类须显式排除），
        其余（未绑定 409 / 形状非法 / 传输异常）一律 None，**永不抛**——上下文
        窗口是纯展示增量，拿不到就退化为无上限展示。5s 短超时：设置页热路径，
        慢引擎不如先不回。
        """
        try:
            status, data, _ = await self._request(
                "GET", "/v1/session/context", timeout=5,
            )
            if status != 200 or not isinstance(data, dict):
                logger.debug("dsh 会话上下文不可得（上下文窗口降级为空）: status=%s", status)
                return None
            window = data.get("contextWindow")
            # bool 是 int 子类，显式排除；零/负数同样不可作分母
            if isinstance(window, bool) or not isinstance(window, int) or window <= 0:
                logger.debug("dsh 生效模型 contextWindow 非正整数: %r", window)
                return None
            model = data.get("model")
            provider = data.get("provider")
            return {
                "model": model if isinstance(model, str) and model else None,
                "provider": provider if isinstance(provider, str) and provider else None,
                "contextWindow": window,
            }
        except Exception as e:
            logger.debug("dsh 上下文窗口请求异常（降级为空）: %s", redact_text(str(e)))
            return None

    async def summarize_session(
        self,
        session_id: str,
        model_id: Optional[str] = None,
        provider_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """手动压缩：空 body POST /v1/session/compact（bridge 202=已受理，后台执行）。

        model_id/provider_id 仅为接口同构保留（dsh preset 自持模型选择权）。
        错误映射：409 compaction_busy（会话非 idle）/ 500 compaction_unavailable
        （该 harness 组合无手动压缩命令）透出原状态码；未绑定 409
        no_kinship_session 同走 409 分支；传输异常按 system 源上报。
        """
        try:
            status, data, _ = await self._request(
                "POST", "/v1/session/compact", timeout=15,
            )
        except Exception as e:
            return self._fail("system", f"summarize_session 异常: {e}")
        if status == 202:
            sid = data.get("session_id") if isinstance(data, dict) else None
            return self._ok({
                "session_id": sid if isinstance(sid, str) and sid else session_id,
                "status": "compacting",
            })
        return self._fail("dsh", self._error_detail(status, data),
                          code=status if status >= 400 else 502)

    async def get_session_compaction(self, session_id: str) -> Optional[Dict[str, Any]]:
        """GET /v1/session/compaction -> loom W51A camelCase 快照（历史页分隔线只读面）。

        唯一消费方 routers/session.py 的 _maybe_splice_compaction 逐键只认
        {sessionID,status,coveredCount,summaryText,anchorMessageId,anchorTimestampMs}，
        故 bridge 的 snake_case body 在此层一次归一；六键恒在（缺省 status="none"、
        coveredCount=0、summaryText=""、anchor*=None），下游 int()/切片零防御。
        fail-open 契约：超时/连接炸/非 200/body 非 dict 一律 None + debug 日志，
        **永不抛**——失败=无分隔线=原有行为，绝不阻塞历史主链。
        2s 短超时：历史页是 UI 热路径，慢引擎不如降级无线。
        """
        try:
            status, data, _ = await self._request(
                "GET", "/v1/session/compaction", timeout=2,
            )
            if status != 200 or not isinstance(data, dict):
                logger.debug("dsh 压缩快照不可得（降级无分隔线）: session=%s status=%s",
                             session_id, status)
                return None
            raw_sid = data.get("session_id")
            raw_status = data.get("status")
            raw_covered = data.get("covered_count")
            raw_summary = data.get("summary_text")
            raw_anchor_id = data.get("anchor_message_id")
            raw_anchor_ts = data.get("anchor_timestamp_ms")
            return {
                "sessionID": (raw_sid if isinstance(raw_sid, str) and raw_sid
                              else session_id),
                "status": "active" if raw_status == "active" else "none",
                "coveredCount": (raw_covered
                                 if isinstance(raw_covered, int)
                                 and not isinstance(raw_covered, bool) else 0),
                "summaryText": raw_summary if isinstance(raw_summary, str) else "",
                "anchorMessageId": (raw_anchor_id
                                    if isinstance(raw_anchor_id, str) and raw_anchor_id
                                    else None),
                "anchorTimestampMs": (raw_anchor_ts
                                      if isinstance(raw_anchor_ts, int)
                                      and not isinstance(raw_anchor_ts, bool) else None),
            }
        except Exception as e:
            logger.debug("dsh 压缩快照请求异常（降级无分隔线）: session=%s err=%s",
                         session_id, redact_text(str(e)))
            return None

    async def get_session_messages(self, session_id: str, limit: int = 100,
                                   before: Optional[str] = None) -> Dict[str, Any]:
        bound_id, error, code = await self._require_bound()
        if error:
            return self._fail("dsh", error, code=code)
        try:
            messages, next_cursor, error = await self._page(
                bound_id, limit=limit, before=before
            )
            if error:
                return self._fail("dsh", error)
            return self._ok({
                "messages": messages or [],
                "session_id": bound_id,
                "next_cursor": next_cursor,
            })
        except Exception as e:
            return self._fail("system", f"get_session_messages 异常: {e}")

    async def get_session_children(self, session_id: str) -> Dict[str, Any]:
        bound_id, error, code = await self._require_bound()
        if error:
            return self._fail("dsh", error, code=code)
        try:
            status, data, _ = await self._request("GET", "/v1/session/children")
            if status != 200 or not isinstance(data, dict):
                return self._fail("dsh", self._error_detail(status, data),
                                  code=status if status >= 400 else 502)
            raw = data.get("children")
            if not isinstance(raw, list):
                return self._fail("dsh", "dsh 子会话响应缺少 children 列表")
            return self._ok({"children": dsh_messages.to_children(raw, bound_id)})
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
        bound_id, error, code = await self._require_bound()
        if error:
            return self._fail("dsh", error, code=code)
        collected: List[Dict[str, Any]] = []
        before: Optional[Union[str, int]] = None
        truncated = False
        try:
            for _ in range(max_pages):
                page, next_cursor, page_error = await self._page(
                    bound_id, limit=page_size, before=before
                )
                if page_error:
                    return self._fail("dsh", page_error)
                if not page:
                    break
                collected.extend(page)
                first_ts = page[0].get("info", {}).get("time", {}).get("created")
                if (start_ms is not None
                        and isinstance(first_ts, (int, float))
                        and first_ts < start_ms):
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
        row, error, code = await self._session()
        if error or row is None:
            return self._fail("dsh", error or "dsh 会话不可用", code=code)
        return self._ok({"active_sessions": [row]})


_dsh_client: Optional[DshClient] = None


def get_dsh_client() -> DshClient:
    """获取 dsh 客户端单例（同步工厂，构造零 IO）。"""
    global _dsh_client
    if _dsh_client is None:
        cfg = get_config()
        _dsh_client = DshClient(base_url=cfg.DSH_URL, timeout=cfg.DSH_TIMEOUT_SECONDS)
    return _dsh_client


async def acquire_dsh_client() -> DshClient:
    """异步获取 dsh 客户端单例（无端口探测，与 acquire_loom_client 对称）。"""
    return get_dsh_client()


def _reset_dsh_client() -> None:
    """重置客户端单例（仅测试用）。"""
    global _dsh_client
    _dsh_client = None
