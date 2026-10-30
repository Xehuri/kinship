"""
AI 后端事件代理 - SSE事件流（双通道：opencode 单上游扇出 / loom 多会话扇出）
将上游事件流转发给前端。

BE-COR-M5：采用「单条上游 + 多客户端扇出」模型（opencode 通道）。
无论多少客户端订阅，整个进程只保持 1 条到 OpenCode 的 SSE 上游连接，
读取到的事件广播给所有订阅者；上游断网时按指数退避重连，并周期性发送心跳。

双通道（opencode / loom）：loom 无全局事件流（每个会话一棵原生扇出枢纽，
D33 修正一），本模块降级为其订阅者之一——LoomEventHub 为每个已发现会话保持
一条 SSE 上游、合流后仍走同一条广播管线；帧信封 {payload:{type,properties}}
两通道同构，_process_sse_line 与前端零改动。

W44 双活：hub 注册表按通道分槽（_hubs），opencode/loom 两 hub 并存共活；
/events/stream 一条订阅队列挂两 hub、交叠扇出双流帧，转发帧一律注入
properties.backend（"opencode"|"loom"）作唯一通道判别器——纯增量字段，老前端忽略。
Web 通道切换（POST /api/screen/backend）只落状态文件，不重建不停止任何 hub；
reset_event_hub 降级为测试/lifespan 关停专用的 teardown-all 工具。
"""
import asyncio
import aiohttp
import contextlib
import json
import logging
import re
import time
from typing import Dict, List, Optional, Set

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

logger = logging.getLogger(__name__)

router = APIRouter(tags=["events"])

# OpenCode事件流地址 — 从统一配置读取
from config.config import get_config
_cfg_ev = get_config()
OPENCODE_EVENT_URL = f"{_cfg_ev.OPENCODE_URL}/global/event"

# Loom 会话来源（列表面 GET /sessions 已废弃）：权威主会话 + 本地 loom: 绑定 + SSE 子会话帧
from services.loom_main_session import LOOM_MAIN_AGENT, resolve_loom_main_session
from services.stt_session_manager import get_session_manager
from services.web_backend_selector import web_agent_key

# 单行上限：超过则丢弃，避免超大 payload 撑爆内存
MAX_LINE_BYTES = 1024 * 1024
# 心跳间隔（秒）：keep-alive，防止中间代理断开空闲连接
HEARTBEAT_INTERVAL = 15.0
# 上游断线重连退避
INITIAL_BACKOFF = 1.0
MAX_BACKOFF = 30.0
# 单客户端队列上限
QUEUE_MAXSIZE = 1000


def get_session_source_map():
    """
    获取session_id到source的映射

    SSEForwarder 已移除（监督智能体清理），返回空映射
    """
    return {}


def _process_sse_line(line: str, backend: str) -> Optional[str]:
    """
    处理上游单行 SSE 文本，返回要下发给客户端的完整 SSE 片段。

    Args:
        line: 上游原始行（可含 data: 前缀）
        backend: 通道判别标（"opencode"|"loom"），写入 properties.backend——
            双流多路复用后前端据此判别帧来源（纯增量，老前端忽略）

    Returns:
        SSE 片段的文本；None 表示该行应被跳过
    """
    line = line.strip()
    if not line:
        return None

    # SSE 注释/心跳行（Loom 的 ": keepalive" 等）：原样透传会被包成
    # "data: : keepalive"，前端 JSON.parse 每 15s 报错，必须直接丢弃。
    if line.startswith(":"):
        return None

    # 跳过过大的行（超过1MB）
    if len(line) > MAX_LINE_BYTES:
        logger.warning(f"[EventProxy] Skipping large line: {len(line)} bytes")
        return None

    if line.startswith("data:"):
        data_str = line[5:].strip()
        try:
            data = json.loads(data_str)
            # 解析payload获取session_id
            payload = data.get('payload', {})
            properties = payload.get('properties', {})
            session_id = properties.get('sessionID', '')

            # W44：注入 backend 通道标（sessionID 提取后、重序列化前）。
            # properties 缺失 → 上面取到的是游离默认值，"properties" not in
            # payload，不注入不造壳；非 dict → 上方 .get 已抛 AttributeError
            # 进 except 直通分支。两种情况都是"不注入但帧照发"。
            if "properties" in payload:
                payload["properties"]["backend"] = backend

            # 添加source字段
            source_map = get_session_source_map()
            data['source'] = source_map.get(session_id, 'main')
            return f"data: {json.dumps(data)}\n\n"
        except (json.JSONDecodeError, TypeError, AttributeError):
            # 无法解析，直接转发
            return f"data: {data_str}\n\n"

    # 其他内容
    return f"data: {line}\n\n"


class EventHub:
    """
    事件中心：单条上游连接 + 多订阅者扇出。

    每个客户端通过 subscribe() 取得独立队列，事件由唯一的后台任务
    从上游读取后广播进各队列；上游断开时自动退避重连。
    """

    def __init__(
        self,
        url: str,
        heartbeat_interval: float = HEARTBEAT_INTERVAL,
        initial_backoff: float = INITIAL_BACKOFF,
        max_backoff: float = MAX_BACKOFF,
        queue_size: int = QUEUE_MAXSIZE,
    ):
        self._url = url
        self._heartbeat_interval = heartbeat_interval
        self._initial_backoff = initial_backoff
        self._max_backoff = max_backoff
        self._queue_size = queue_size

        self._subscribers: Set[asyncio.Queue] = set()
        self._task: Optional[asyncio.Task] = None
        self._lock = asyncio.Lock()

    @property
    def has_subscribers(self) -> bool:
        """当前是否存在订阅者。"""
        return bool(self._subscribers)

    async def subscribe(self, queue: Optional[asyncio.Queue] = None) -> asyncio.Queue:
        """
        注册一个客户端队列并返回它（未提供则新建专属队列）。

        首个订阅者会触发唯一的上游读取任务启动；后续订阅者复用同一条上游连接。
        W44：可选 queue 让多路复用客户端把同一条订阅队列挂到多个 hub 上
        （双流帧在同一队列交叠），新建队列仅是缺省行为。
        """
        if queue is None:
            queue = asyncio.Queue(maxsize=self._queue_size)
        async with self._lock:
            self._subscribers.add(queue)
            if self._task is None or self._task.done():
                self._task = asyncio.create_task(self._run())
        return queue

    async def unsubscribe(self, queue: asyncio.Queue) -> None:
        """注销客户端；当最后一个订阅者离开时停止上游任务。"""
        async with self._lock:
            self._subscribers.discard(queue)
            if not self._subscribers and self._task is not None and not self._task.done():
                self._task.cancel()
                self._task = None

    def _broadcast(self, text: str) -> None:
        """向所有订阅者队列投递消息（满队列时丢弃最旧一条，保证不阻塞上游）。"""
        for queue in list(self._subscribers):
            try:
                queue.put_nowait(text)
            except asyncio.QueueFull:
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                try:
                    queue.put_nowait(text)
                except asyncio.QueueFull:
                    pass

    async def _heartbeat_loop(self) -> None:
        """周期性向订阅者发送 SSE 注释行作为心跳。"""
        try:
            while True:
                await asyncio.sleep(self._heartbeat_interval)
                self._broadcast(": heartbeat\n\n")
        except asyncio.CancelledError:
            pass

    async def _run(self) -> None:
        """上游读取主循环：正常读取 + 断线指数退避重连。"""
        backoff = self._initial_backoff
        while True:
            hb_task = asyncio.create_task(self._heartbeat_loop())
            try:
                await self._stream_upstream()
                # 正常结束（上游 EOF）后重置退避
                backoff = self._initial_backoff
            except asyncio.CancelledError:
                hb_task.cancel()
                raise
            except Exception as e:
                logger.error(f"[EventProxy] 上游事件流异常: {e}")
            finally:
                hb_task.cancel()

            # 无订阅者则退出，等待下次订阅时重新启动
            if not self._subscribers:
                return

            self._broadcast(
                f"data: {json.dumps({'type': 'proxy.disconnected'})}\n\n"
            )
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, self._max_backoff)

    async def _stream_upstream(self) -> None:
        """建立并读取唯一一条上游 SSE 连接，读取到的行广播给所有订阅者。"""
        logger.debug("[EventProxy] Connecting to OpenCode event stream...")
        connector = aiohttp.TCPConnector()
        async with aiohttp.ClientSession(
            connector=connector,
            timeout=aiohttp.ClientTimeout(total=None, connect=30)
        ) as session:
            async with session.get(self._url) as response:
                if response.status != 200:
                    logger.error(f"[EventProxy] Failed to connect: {response.status}")
                    self._broadcast(
                        f"data: {json.dumps({'type': 'error', 'message': f'Connection failed: {response.status}'})}\n\n"
                    )
                    return

                logger.debug("[EventProxy] Connected to OpenCode event stream")
                self._broadcast(f"data: {json.dumps({'type': 'proxy.connected'})}\n\n")

                # 手动读取流，跳过过大的行
                buffer = b""
                async for chunk in response.content.iter_any():
                    if not chunk:
                        continue
                    buffer += chunk
                    while b'\n' in buffer:
                        line_bytes, buffer = buffer.split(b'\n', 1)
                        text = _process_sse_line(
                            line_bytes.decode('utf-8', errors='replace'), "opencode"
                        )
                        if text is not None:
                            self._broadcast(text)

                # 处理缓冲区中剩余的内容
                if buffer:
                    text = _process_sse_line(
                        buffer.decode('utf-8', errors='replace'), "opencode"
                    )
                    if text is not None:
                        self._broadcast(text)

    async def stream_for(self, queue: asyncio.Queue):
        """
        单个客户端的 SSE 生成器：先补发 connected，再从队列持续取值。

        BE-COR-M4：finally 中只做清理与日志，绝不 yield，
        避免客户端断开时出现 "async generator ignored GeneratorExit" 告警。
        """
        try:
            # 首个 yield 也放在 try 内，确保客户端在首块后立即断开也能退订
            yield f"data: {json.dumps({'type': 'proxy.connected'})}\n\n"
            while True:
                item = await queue.get()
                if item is None:
                    # 停机哨兵终检：hub 关停（_stop_hub）时本生成器干净结束（return），
                    # 响应随生成器关闭收尾；前端 EventSource 按既有
                    # [3,5,10,15,30]s 退避重连，重新订阅仍在跑的通道。
                    return
                yield item
        finally:
            await self.unsubscribe(queue)
            logger.debug("[EventProxy] 客户端断开，已退订")


# W44：per-backend 双活 hub 注册表——opencode / loom 各自一槽，两 hub 并存共活
# 是不变量；通道切换只改对话管线的路由，不再触碰任何 hub 的生命周期。
_hubs: Dict[str, Optional[EventHub]] = {"opencode": None, "loom": None}

# loom 通道：本地 loom: 绑定发现轮询间隔（秒）。loom 列表面 GET /sessions 已废弃，
# 会话来源只有三条——权威主会话（resolver）、本地 loom: 绑定、SSE session.children
# 帧；轮询兜底 /session/switch|/session/create 的绑定更新，5s 平衡时延与请求量。
LOOM_SESSION_REFRESH_INTERVAL = 5.0
# 起连补种：最多为 32 个在飞子会话各起一条读者，2s 预算拿不到就放弃（best-effort）
LOOM_CHILD_SEED_LIMIT = 32
LOOM_CHILD_SEED_TIMEOUT = 2.0
# 任务账本里仍算"在飞"的 status 词表（loom task-api RunViewStatus 子集）
LOOM_ACTIVE_TASK_STATUSES = frozenset({"queued", "admitted", "running"})
# 非主会话读者连续失败上限：超过即退役；后续绑定/children 帧可再次唤醒
LOOM_CHILD_MAX_FAILURES = 10
# 单会话读者重连退避：1s 起翻倍至 30s，收到任一行即归零
LOOM_READER_INITIAL_BACKOFF = 1.0
LOOM_READER_MAX_BACKOFF = 30.0
# 发现失败日志节流：瞬态失败只记一条，不投哨兵、不拖垮其他会话读者
LOOM_DISCOVERY_LOG_INTERVAL = 60.0
# resolver 自己持有的主会话绑定键（loom:main-task）；绑定轮询跳过，避免双主读者
LOOM_MAIN_BINDING_KEY = web_agent_key(LOOM_MAIN_AGENT, "loom")
# Loom 会话 id 合法字符（与 loom LOOM_ID_RE / UI registerChild 同口径）
_LOOM_ID_RE = re.compile(r"^[A-Za-z0-9_]+$")


def _extract_child_session_ids(line: str) -> List[str]:
    """从一带原始 SSE 行提取 session.children 帧里的子会话 id（去重、剔非法）。

    观测形状（axeuh-harness packages/server/src/events/project.ts projectToolEnd →
    childrenFromText，与 serve/harness-ui.ts 的 frame 消费面一致）：
    ``data:{"payload":{"type":"session.children","properties":{"sessionID":"<parent>",
    "children":[{"id":"ses_x","name":..,"type":..,"status":..}]}}}``。
    children 条目以 ``id`` 为真源；``sessionID`` 作防御性别名（旧形/未来形兼容）。
    父会话不参与判断：任意父会话的 children 帧都可发现子会话（嵌套子代理）。
    """
    line = line.strip()
    if not line or line.startswith(":") or len(line) > MAX_LINE_BYTES:
        return []
    if '"session.children"' not in line:
        return []  # 热路径短路：绝大多数帧不是 children 帧，免二次 JSON 解析
    if line.startswith("data:"):
        line = line[5:].strip()
    if not line.startswith("{"):
        return []
    try:
        frame = json.loads(line)
    except (json.JSONDecodeError, TypeError):
        return []
    if not isinstance(frame, dict):
        return []
    payload = frame.get("payload")
    if not isinstance(payload, dict) or payload.get("type") != "session.children":
        return []
    properties = payload.get("properties")
    if not isinstance(properties, dict):
        return []
    children = properties.get("children")
    if not isinstance(children, list):
        return []

    found: List[str] = []
    seen: Set[str] = set()
    for child in children:
        if not isinstance(child, dict):
            continue
        session_id = child.get("id") or child.get("sessionID")
        if not isinstance(session_id, str) or not _LOOM_ID_RE.match(session_id):
            continue
        if session_id in seen:
            continue
        seen.add(session_id)
        found.append(session_id)
    return found


class LoomEventHub(EventHub):
    """loom 上游事件中心：主会话 + 绑定会话 + 子会话，多流合流扇出。

    会话来源（hub 绝不调用已废弃的 GET /sessions）：
      1. 权威主会话 = resolve_loom_main_session（main-first；allow_create=False，
         解析失败上抛 ConnectionError 交父类 _run 退避重连，绝不建会话）；
      2. 本地 loom: 绑定 = list_agent_sessions() 中除 loom:main-task 外的键，
         覆盖 /session/switch|/session/create 的绑定更新（5s 轮询）；
      3. 子会话 = SSE session.children 帧（读者随时追加，无需轮询）。
    每会话一条 SSE 上游；单读者断线在协程内 1s→30s 退避自愈，非主会话读者
    连续 10 次失败退役（后续绑定/帧可重新唤醒），主会话读者恒不退场。
    """

    def __init__(self, client, **kwargs):
        super().__init__(url=client.base_url, **kwargs)
        self._client = client
        self._readers: Dict[str, asyncio.Task] = {}
        self._main_session_id: Optional[str] = None

    async def _seed_child_readers(self, main_session_id: str, spawn_reader) -> None:
        """起连补种在飞子会话读者（best-effort：无该方法/失败一律 debug 忽略）。"""
        fetch = getattr(self._client, "get_session_children", None)
        if not callable(fetch):
            return
        try:
            envelope = await asyncio.wait_for(
                fetch(main_session_id), timeout=LOOM_CHILD_SEED_TIMEOUT
            )
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.debug(f"[EventProxy][loom] 子会话补种失败（忽略）: {e}")
            return
        if not isinstance(envelope, dict) or not envelope.get("ok"):
            logger.debug("[EventProxy][loom] 子会话补种不可用（忽略）")
            return
        data = envelope.get("data")
        children = data.get("children") if isinstance(data, dict) else None
        if not isinstance(children, list):
            return

        seeded = 0
        for row in children:
            if seeded >= LOOM_CHILD_SEED_LIMIT:
                break
            if not isinstance(row, dict):
                continue
            if row.get("status") not in LOOM_ACTIVE_TASK_STATUSES:
                continue
            session_id = row.get("id") or row.get("sessionID")
            if not isinstance(session_id, str) or not _LOOM_ID_RE.match(session_id):
                continue
            if session_id == main_session_id:
                continue
            spawn_reader(session_id)
            seeded += 1
        logger.debug(f"[EventProxy][loom] 子会话补种: {seeded} 条在飞读者")

    async def _stream_upstream(self) -> None:
        logger.debug("[EventProxy] Connecting to Loom event streams...")
        line_queue: asyncio.Queue = asyncio.Queue()
        self._readers = {}
        main_state: Dict[str, Optional[str]] = {"session_id": None}

        async def _read_session(session_id: str) -> None:
            """单会话上游读取协程：1s→30s 退避自愈，行入合流队列。"""
            failures = 0
            while True:
                try:
                    async for line in self._client.stream_session_events(session_id):
                        failures = 0
                        await line_queue.put(line)
                    raise ConnectionError("loom SSE 流自然结束")
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    failures += 1
                    if (session_id != main_state["session_id"]
                            and failures >= LOOM_CHILD_MAX_FAILURES):
                        logger.debug(
                            "[EventProxy][loom] session=%s 连续 %d 次失败，退役读者: %s",
                            session_id, failures, e,
                        )
                        if self._readers.get(session_id) is asyncio.current_task():
                            self._readers.pop(session_id, None)
                        return
                    delay = min(
                        LOOM_READER_INITIAL_BACKOFF * (2 ** (failures - 1)),
                        LOOM_READER_MAX_BACKOFF,
                    )
                    logger.debug(
                        "[EventProxy][loom] session=%s 上游断开: %s，%.1fs 后重连",
                        session_id, e, delay,
                    )
                    await asyncio.sleep(delay)

        def _spawn_reader(session_id: str) -> None:
            if not isinstance(session_id, str) or not _LOOM_ID_RE.match(session_id):
                return
            current = self._readers.get(session_id)
            if current is not None and not current.done():
                return
            self._readers[session_id] = asyncio.create_task(
                _read_session(session_id)
            )

        # 首轮主会话解析：失败直接上抛（loom 不可达/无主会话），父类 _run 退避重连
        resolution = await resolve_loom_main_session(
            self._client, get_session_manager(), allow_create=False
        )
        if not resolution.ok or not _LOOM_ID_RE.match(resolution.session_id or ""):
            raise ConnectionError(
                f"loom 主会话不可用: {resolution.error or resolution.session_id!r}"
            )
        main_state["session_id"] = resolution.session_id
        self._main_session_id = resolution.session_id
        _spawn_reader(resolution.session_id)
        await self._seed_child_readers(resolution.session_id, _spawn_reader)
        logger.debug("[EventProxy] Connected to Loom event streams")
        self._broadcast(f"data: {json.dumps({'type': 'proxy.connected'})}\n\n")

        async def _discover_forever() -> None:
            last_logged = 0.0

            def _log_failure(message: str) -> None:
                nonlocal last_logged
                now = time.monotonic()
                if now - last_logged >= LOOM_DISCOVERY_LOG_INTERVAL:
                    last_logged = now
                    logger.warning(f"[EventProxy][loom] {message}")

            while True:
                await asyncio.sleep(LOOM_SESSION_REFRESH_INTERVAL)
                try:
                    current = await resolve_loom_main_session(
                        self._client, get_session_manager(), allow_create=False
                    )
                    if current.ok:
                        if current.session_id != main_state["session_id"]:
                            logger.info(
                                "[EventProxy][loom] 主会话切换: %s -> %s",
                                main_state["session_id"], current.session_id,
                            )
                            main_state["session_id"] = current.session_id
                            self._main_session_id = current.session_id
                            _spawn_reader(current.session_id)
                    else:
                        _log_failure(f"主会话解析失败（保留现有读者）: {current.error}")

                    for key, session_id in get_session_manager().list_agent_sessions().items():
                        if key == LOOM_MAIN_BINDING_KEY or not key.startswith("loom:"):
                            continue
                        _spawn_reader(session_id)
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    # 瞬态发现失败：只记日志（60s 节流），绝不投 None 哨兵拖垮全部读者
                    _log_failure(f"会话发现失败（保留现有读者）: {e}")

        discover_task = asyncio.create_task(_discover_forever())
        try:
            while True:
                item = await line_queue.get()
                # 子会话发现必须先于信封加工：帧照旧转发，额外唤醒对应读者
                for child_id in _extract_child_session_ids(item):
                    _spawn_reader(child_id)
                text = _process_sse_line(item, "loom")
                if text is not None:
                    self._broadcast(text)
        finally:
            discover_task.cancel()
            for task in self._readers.values():
                task.cancel()
            self._readers = {}


def _stop_hub(hub: EventHub) -> None:
    """单 hub 关停原语（供 reset_event_hub / 测试 teardown 使用）：哨兵退场 + 取消后台任务。

    W44 并存不变量：两 hub 可以同时在跑，本原语只终结传入的这一个 hub——
    哨兵仅投递到该 hub 自己的订阅队列，另一 hub 的扇出与任务不受影响。
    挂在共享队列上的多路复用流会被该哨兵终结，其 finally 负责两 hub 一并退订。

    1. 向每个订阅者队列投 None 哨兵——stream_for / event_generator 的终检让在途
       SSE 生成器干净 RETURN（响应收尾），前端 EventSource 按既有退避重连；
    2. 取消 hub 后台读取任务——EventHub 上游协程与 LoomEventHub 的发现/
       读者协程经各自既有 finally/cancel 链全灭。

    不 await 取消完成：同步语境只能发起；需要确定性收尾的调用方用 await
    reset_event_hub()（teardown-all）。
    """
    for queue in list(hub._subscribers):
        try:
            queue.put_nowait(None)
        except asyncio.QueueFull:
            # 满队列：丢最旧一帧腾位投哨兵——停机之后旧通道数据帧已无意义
            try:
                queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
            try:
                queue.put_nowait(None)
            except asyncio.QueueFull:
                pass
    if hub._task is not None and not hub._task.done():
        hub._task.cancel()


def get_event_hub(backend: str) -> EventHub:
    """按通道名取 hub（W44 双活注册表：分槽懒建、幂等、两槽互不影响）。

    opencode 槽：EventHub(OPENCODE_EVENT_URL)——OpenCode /global/event 全局流；
    loom 槽：LoomEventHub，客户端一律取 services.loom_client 模块单例
    （get_loom_client），绝不经 get_web_client()——hub 绑定通道本身而非 Web
    开关取值，通道切换只改对话管线路由，双流 hub 恒并活。
    """
    hub = _hubs.get(backend)
    if hub is None:
        if backend == "opencode":
            hub = EventHub(OPENCODE_EVENT_URL)
        elif backend == "loom":
            from services.loom_client import get_loom_client
            hub = LoomEventHub(get_loom_client())
        else:
            raise ValueError(
                f"未知事件通道: {backend!r}（合法: {'|'.join(_hubs)}）"
            )
        _hubs[backend] = hub
    return hub


async def reset_event_hub() -> None:
    """teardown-all 工具（仅测试隔离 / lifespan 关停用，W44 起与通道切换解耦）。

    停两槽每一个存活 hub、await 确认旧任务取消、清空全部槽位。
    POST /api/screen/backend 不再调用本函数——双活 hub 恒在线，切换不落 hub。
    """
    for key in list(_hubs):
        hub = _hubs[key]
        if hub is not None:
            _stop_hub(hub)
            task = hub._task
            if task is not None:
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await task
        _hubs[key] = None


async def reload_event_hubs() -> None:
    """配置热重载钩子：刷新 opencode 事件 URL，teardown 两槽 hub 后续重建。

    ``OPENCODE_EVENT_URL`` 在 import 时由配置快照拼接，这里先按实时配置重算，
    保证下一次 ``get_event_hub("opencode")`` 使用新地址；随后委派
    ``reset_event_hub`` 停 hub + await 取消 + 清槽。
    """
    global OPENCODE_EVENT_URL
    OPENCODE_EVENT_URL = f"{get_config().OPENCODE_URL}/global/event"
    await reset_event_hub()


def _opencode_enabled() -> bool:
    return bool(get_config().OPENCODE_ENABLED)


async def event_generator():
    """
    客户端 SSE 多路复用生成器（保持旧接口名以兼容调用方）。

    W44：双流都 ensure，一条共享订阅队列同时挂进两个 hub——opencode 与 loom
    的帧在同一队列交叠扇出，通道判别全靠帧内 properties.backend 标。
    None 哨兵（任一 hub 关停投递）终结本响应流，finally 两 hub 一并退订，
    绝不留孤儿队列挂在存活 hub 的订阅者集合上。
    """
    hub_loom = get_event_hub("loom")
    hub_opencode = get_event_hub("opencode") if _opencode_enabled() else None
    queue = await hub_loom.subscribe()
    if hub_opencode is not None:
        await hub_opencode.subscribe(queue)
    try:
        yield f"data: {json.dumps({'type': 'proxy.connected'})}\n\n"
        while True:
            item = await queue.get()
            if item is None:
                return
            yield item
    finally:
        if hub_opencode is not None:
            await hub_opencode.unsubscribe(queue)
        await hub_loom.unsubscribe(queue)
        logger.debug("[EventProxy] 客户端断开，已从两 hub 退订")


@router.get("/events/stream")
async def event_stream():
    """
    SSE事件流端点 - 多路复用 opencode / loom 双通道事件

    前端通过此端点接收两条 AI 通道的实时事件（每帧 properties.backend 标
    明通道）。每通道各自保持唯一上游连接，由对应 EventHub 扇出、共享队列合流。
    """
    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )
