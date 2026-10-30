"""
OpenCode Client - OpenCode API交互客户端（V6 起为 session/任务域唯一入口）

功能：
- 裸传输层（_raw_* 系列，元组协议）：创建/切换/列表会话、发消息(prompt_async)、
  中止任务、消息分页、会话状态、providers
- 信封公共层（原 OpenCodeGateway 下沉拍扁）：mock 开关分支、
  {"ok","data","error"} 统一信封、默认模型/提供商注入、语音投递编排
- 消息格式封装（<Axeuh-home-system> 信封在 _raw_send_message 内）
"""

import aiohttp
import asyncio
import json
import logging
import uuid
from datetime import datetime
import os
import fnmatch
import socket
from typing import Optional, Dict, Any, List, Tuple
from dataclasses import dataclass
import base64
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

# OpenCode配置
# 默认 agent/model/provider 全部取自 config.yaml：本模块不再保留任何内置默认值，
# opencode 节缺键时 get_config() 会在启动阶段直接 fail-fast（见 Config._validate_opencode）。
# 其中 model/provider 仍可被 load_model_config() 读到的 model_config.json 覆盖
# （前端"模型设置"页写入），config.yaml 提供的是初始值。
from config.config import get_config
from core.redaction import redact_text
_cfg = get_config()
OPENCODE_CONFIG_URL = _cfg.OPENCODE_URL
OPENCODE_DEFAULT_DIRECTORY = _cfg.OPENCODE_DIRECTORY
OPENCODE_DEFAULT_AGENT = _cfg.OPENCODE_DEFAULT_AGENT
OPENCODE_DEFAULT_MODEL = _cfg.OPENCODE_DEFAULT_MODEL
OPENCODE_DEFAULT_PROVIDER = _cfg.OPENCODE_DEFAULT_PROVIDER

# OPENCODE_BASE_URL 在模块加载后由 discover_opencode_url() 重写为探测到的可用端口
OPENCODE_BASE_URL = OPENCODE_CONFIG_URL

# ============ 端口自动发现 ============

_OPENCODE_DISCOVERED_URL: Optional[str] = None


def _probe_tcp_port(host: str, port: int, timeout: float = 0.3) -> bool:
    """同步探测 TCP 端口是否开放（超时短，避免阻塞启动）"""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        return sock.connect_ex((host, port)) == 0
    finally:
        sock.close()


def discover_opencode_url(max_offset: int = 10) -> str:
    """
    探测 OpenCode 实际端口（从配置端口开始逐+1）
    
    当默认端口被幽灵进程占用时，自动切换到下一个可用端口。
    结果会缓存并更新全局 OPENCODE_BASE_URL，避免重复探测。
    
    Args:
        max_offset: 最大尝试偏移量（默认 +10）
        
    Returns:
        发现的有效 URL，未发现则返回配置默认值
    """
    global _OPENCODE_DISCOVERED_URL, OPENCODE_BASE_URL
    if _OPENCODE_DISCOVERED_URL is not None:
        return _OPENCODE_DISCOVERED_URL
    
    parsed = urlparse(OPENCODE_CONFIG_URL)
    base_port = parsed.port or 5096
    host = parsed.hostname or "127.0.0.1"
    scheme = parsed.scheme or "http"
    
    for offset in range(max_offset):
        port = base_port + offset
        if port == 5100:
            # 5100 是 Loom，绝不能把助手宿主误认成 OpenCode。
            continue
        if _probe_tcp_port(host, port):
            url = f"{scheme}://{host}:{port}"
            if offset > 0:
                logger.warning(
                    f"OpenCode 默认端口 {base_port} 不可用，"
                    f"发现端口 {port}，自动切换至: {url}"
                )
            _OPENCODE_DISCOVERED_URL = url
            OPENCODE_BASE_URL = url  # 更新全局引用
            return url
    
    logger.warning(
        f"OpenCode 端口 {base_port}~{base_port + max_offset - 1} 均无响应，"
        f"使用配置默认: {OPENCODE_CONFIG_URL}"
    )
    _OPENCODE_DISCOVERED_URL = OPENCODE_CONFIG_URL
    return OPENCODE_CONFIG_URL


# 运行时配置缓存
_model_config_loaded = False
_model_config_excluded: List[str] = []
_model_config_data: Dict[str, Any] | None = None

# fail-open 未配置密码的告警只打一次（避免每个请求刷屏）
_auth_warned = False


def _basic_auth_value() -> Optional[str]:
    """按当前配置构造 HTTP Basic 认证头值；未配置密码返回 None（fail-open）。

    密码来源 OPENCODE_SERVER_PASSWORD（config.yaml opencode.server_password 优先，
    其次环境变量 OPENCODE_SERVER_PASSWORD）。配置了密码才带 Authorization 头——
    老部署（未配置）请求形状与改造前完全一致，向后兼容不阻断。
    未配置时打一次 WARNING 提醒本机其他进程可直连 OpenCode。
    """
    global _auth_warned
    password = _cfg.OPENCODE_SERVER_PASSWORD
    if not password:
        if not _auth_warned:
            _auth_warned = True
            logger.warning(
                '未配置 opencode.server_password（且无 OPENCODE_SERVER_PASSWORD 环境变量），'
                'OpenCode loopback 请求不带认证——本机其他进程可直连 :5096；'
                '生产建议在 config.yaml 配置 opencode.server_password'
            )
        return None
    username = _cfg.OPENCODE_SERVER_USERNAME or 'opencode'
    raw = base64.b64encode(f'{username}:{password}'.encode('utf-8')).decode('ascii')
    return f'Basic {raw}'


def model_config_path() -> str:
    """model_config.json 单一真源路径（config 驱动，V5 双缓存收敛）。

    router 写路径与 client 读路径共用此函数，消除"写 backend/config/、
    读三处探测目录"的语义漂移（原探测顺序第一优先位 = opencode.directory/config/）。
    """
    return get_config().MODEL_CONFIG_PATH


def load_model_config() -> Dict[str, Any]:
    """懒加载模型配置，供默认模型/提供商及排除列表使用"""
    global _model_config_loaded, _model_config_excluded, _model_config_data
    global OPENCODE_DEFAULT_MODEL, OPENCODE_DEFAULT_PROVIDER

    if _model_config_loaded:
        return _model_config_data or {}

    # V5 收敛：单一 config 驱动路径（原三处目录探测与 router 写路径分裂，
    # 导致 POST 写入的文件 client 永远读不到）
    p = model_config_path()
    cfg = {}
    if os.path.exists(p):
        try:
            with open(p, "r", encoding="utf-8") as f:
                cfg = json.load(f)
        except Exception as e:
            logger.error(f"加载模型配置失败: {e}")
            cfg = {}

    default_model = cfg.get("default_model") or OPENCODE_DEFAULT_MODEL
    default_provider = cfg.get("default_provider") or OPENCODE_DEFAULT_PROVIDER
    excluded = cfg.get("excluded_models") or []

    _model_config_data = {
        "default_model": default_model,
        "default_provider": default_provider,
        "excluded_models": excluded,
    }
    OPENCODE_DEFAULT_MODEL = default_model
    OPENCODE_DEFAULT_PROVIDER = default_provider
    _model_config_excluded = list(excluded)
    _model_config_loaded = True
    return _model_config_data


def reset_model_config_cache():
    """清除模型配置缓存，强制下次 load_model_config() 重新读取文件"""
    global _model_config_loaded, _model_config_data
    _model_config_loaded = False
    _model_config_data = None


def _is_model_excluded(provider_id: str, model_id: str) -> bool:
    """根据模型排除模式进行判断，模式支持 fnmatch 的通配匹配"""
    patterns = _model_config_excluded or []
    key = f"{provider_id}/{model_id}"
    for pat in patterns:
        if fnmatch.fnmatch(key, pat) or fnmatch.fnmatch(provider_id, pat) or fnmatch.fnmatch(model_id, pat):
            return True
    return False


@dataclass
class OpenCodeSession:
    """OpenCode会话信息"""
    session_id: str
    title: str
    created_at: float
    last_accessed: float
    directory: str = OPENCODE_DEFAULT_DIRECTORY


class OpenCodeClient:
    """OpenCode API客户端"""
    
    def __init__(self, base_url: str = OPENCODE_BASE_URL):
        self.base_url = base_url
        self.timeout = aiohttp.ClientTimeout(total=300)  # 5分钟超时
        self.directory = OPENCODE_DEFAULT_DIRECTORY
        # 模型配置懒加载标记
        self._model_config_loaded = False
        
    def _auth(self, headers: Optional[Dict[str, str]] = None) -> Dict[str, str]:
        """合并 loopback Basic 认证头（配置了 server_password 才带；fail-open）。

        覆盖本客户端全部 HTTP 请求点——包括原本不带任何自定义头的
        list/status/message/children/providers 等直连端点。
        """
        out = dict(headers or {})
        value = _basic_auth_value()
        if value and 'Authorization' not in out:
            out['Authorization'] = value
        return out

    def _get_headers(self, session_id: str = None) -> Dict[str, str]:
        """获取请求头"""
        directory_b64 = base64.b64encode(self.directory.encode()).decode()
        # 每次请求都会调到此方法，降为 DEBUG 避免日志噪声
        logger.debug(f"[OpenCodeClient] x-opencode-directory: {self.directory} (b64: {directory_b64})")
        
        headers = {
            "Accept": "*/*",
            "Accept-Encoding": "gzip, deflate, br",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Content-Type": "application/json",
            "Origin": self.base_url,
            "x-opencode-directory": self.directory
        }
        
        if session_id:
            headers["Referer"] = f"{self.base_url}/{directory_b64}/session/{session_id}"
        else:
            headers["Referer"] = f"{self.base_url}/{directory_b64}/session"
            
        return self._auth(headers)
    
    async def _raw_create_session(
        self, 
        title: Optional[str] = None,
        directory: Optional[str] = None
    ) -> Tuple[Optional[str], Optional[str]]:
        """
        创建新会话
        
        Returns:
            (session_id, error_message)
        """
        if directory:
            self.directory = directory
            
        session_title = title or "语音交互会话"
        
        try:
            async with aiohttp.ClientSession(timeout=self.timeout) as client:
                async with client.post(
                    f"{self.base_url}/session",
                    headers=self._get_headers(),
                    json={"title": session_title}
                ) as response:
                    if response.status == 200:
                        data = await response.json()
                        session_id = data.get("id")
                        logger.info(f"创建OpenCode会话成功: {session_id}")
                        return session_id, None
                    else:
                        text = await response.text()
                        return None, f"HTTP {response.status}: {text}"
        except Exception as e:
            logger.error(f"创建会话失败: {e}")
            return None, str(e)
    
    async def _raw_list_sessions(self, limit: int = 20) -> Tuple[Optional[List[Dict]], Optional[str]]:
        """
        列出所有会话
        
        Returns:
            (sessions_list, error_message)
        """
        try:
            async with aiohttp.ClientSession(timeout=self.timeout) as client:
                async with client.get(
                    f"{self.base_url}/session",
                    params={"limit": limit},
                    headers=self._auth()
                ) as response:
                    if response.status == 200:
                        data = await response.json()
                        if isinstance(data, dict) and "sessions" in data:
                            return data["sessions"], None
                        elif isinstance(data, list):
                            return data, None
                        return [], None
                    else:
                        text = await response.text()
                        return None, f"HTTP {response.status}: {text}"
        except Exception as e:
            logger.error(f"列出会话失败: {e}")
            return None, str(e)
    
    async def _raw_send_message(
        self,
        session_id: str,
        message: str,
        agent: str = None,
        model_id: str = None,
        provider_id: str = None,
        directory: Optional[str] = None
    ) -> Tuple[bool, Optional[str]]:
        """
        发送消息到OpenCode (使用prompt_async端点)

        消息统一包装为 <Axeuh-home-system> 信封，信封内只含当前时间；
        场景标识由正文首行的 【场景】 前缀承载（见 ai/AGENTS.md 场景前缀契约）。

        Args:
            session_id: 会话ID
            message: 消息内容（正文，含【场景】前缀）
            agent: 代理名称
            model_id: 模型ID
            provider_id: 提供商ID
            directory: 工作目录
        """
        if directory:
            self.directory = directory

        cur_datetime = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        formatted_message = f"""<Axeuh-home-system>
{json.dumps({"current_datetime": cur_datetime}, ensure_ascii=False, indent=2)}
</Axeuh-home-system>

{message}"""
        
        # 构建请求体
        body = {
            "agent": agent or OPENCODE_DEFAULT_AGENT,
            "model": {
                "modelID": model_id or OPENCODE_DEFAULT_MODEL,
                "providerID": provider_id or OPENCODE_DEFAULT_PROVIDER
            },
            "parts": [
                {
                    "type": "text",
                    "text": formatted_message
                }
            ]
        }
        
        # 每请求都会打印的明细，降为 DEBUG
        logger.debug(f"[OPENCODE-REQ] POST /session/{session_id}/prompt_async")
        logger.debug(f"[OPENCODE-REQ] agent={agent or OPENCODE_DEFAULT_AGENT}")
        logger.debug(f"[OPENCODE-REQ] model={model_id or OPENCODE_DEFAULT_MODEL}, provider={provider_id or OPENCODE_DEFAULT_PROVIDER}")
        logger.debug(
            "[OPENCODE-REQ] body_chars=%d",
            len(json.dumps(body, ensure_ascii=False)),
        )
        try:
            async with aiohttp.ClientSession(timeout=self.timeout) as client:
                async with client.post(
                    f"{self.base_url}/session/{session_id}/prompt_async",
                    headers=self._get_headers(session_id),
                    json=body
                ) as response:
                    # HTTP 200或204都表示成功
                    if response.status in (200, 204):
                        logger.debug(
                            "消息发送成功: session=%s, agent=%s, content_chars=%d",
                            session_id,
                            agent or OPENCODE_DEFAULT_AGENT,
                            len(message),
                        )
                        return True, None
                    else:
                        safe_text = redact_text(await response.text())
                        logger.error(
                            "消息发送失败: HTTP %s, %s", response.status, safe_text
                        )
                        return False, f"HTTP {response.status}: {safe_text}"
        except Exception as e:
            logger.error("发送消息失败: %s", redact_text(str(e)))
            return False, redact_text(str(e))
    async def _raw_abort_session(
        self, 
        session_id: str,
        directory: Optional[str] = None
    ) -> Tuple[bool, Optional[str]]:
        """
        中止会话当前任务
        
        Returns:
            (success, error_message)
        """
        work_dir = directory or OPENCODE_DEFAULT_DIRECTORY
        directory_b64 = base64.b64encode(work_dir.encode()).decode()
        logger.debug(f"[OpenCodeClient] abort x-opencode-directory: {work_dir} (b64: {directory_b64})")
        
        headers = {
            "Content-Type": "application/json",
            "Referer": f"{self.base_url}/{directory_b64}/session/{session_id}",
            "x-opencode-directory": work_dir
        }
        
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as client:
                async with client.post(
                    f"{self.base_url}/session/{session_id}/abort",
                    headers=self._auth(headers)
                ) as response:
                    if response.status == 200:
                        logger.debug(f"中止会话成功: {session_id}")
                        return True, None
                    else:
                        text = await response.text()
                        return False, f"HTTP {response.status}: {text}"
        except Exception as e:
            logger.error(f"中止会话失败: {e}")
            return False, str(e)
    
    async def _raw_get_session_status(self, session_id: str) -> Tuple[Optional[Dict], Optional[str]]:
        """获取会话状态"""
        try:
            async with aiohttp.ClientSession(timeout=self.timeout) as client:
                async with client.get(
                    f"{self.base_url}/session/{session_id}",
                    headers=self._auth()
                ) as response:
                    if response.status == 200:
                        return await response.json(), None
                    else:
                        text = await response.text()
                        return None, f"HTTP {response.status}: {text}"
        except Exception as e:
            return None, str(e)

    async def get_all_sessions_status(self) -> Tuple[Optional[Dict], Optional[str]]:
        """获取所有会话的状态映射
        
        调用 GET /session/status 返回 {session_id: {state, lastActivity}}
        
        Returns:
            (status_map, error_message)
        """
        try:
            async with aiohttp.ClientSession(timeout=self.timeout) as client:
                async with client.get(
                    f"{self.base_url}/session/status",
                    headers=self._auth()
                ) as response:
                    if response.status == 200:
                        data = await response.json()
                        return data, None
                    else:
                        text = await response.text()
                        return None, f"HTTP {response.status}: {text}"
        except Exception as e:
            logger.error(f"获取所有会话状态失败: {e}")
            return None, str(e)

    async def _raw_get_session_messages(
        self,
        session_id: str,
        limit: int = 100,
        before: Optional[str] = None
    ) -> Tuple[Optional[List[Dict]], Optional[str]]:
        """
        获取会话消息历史

        Args:
            session_id: 会话ID
            limit: 返回消息数量上限
            before: 分页游标，获取此消息之前的记录

        Returns:
            (messages_list, error_message)
        """
        try:
            params = {"limit": limit}
            if before:
                params["before"] = before

            async with aiohttp.ClientSession(timeout=self.timeout) as client:
                async with client.get(
                    f"{self.base_url}/session/{session_id}/message",
                    params=params,
                    headers=self._auth()
                ) as response:
                    if response.status == 200:
                        data = await response.json()
                        # 兼容不同返回格式
                        if isinstance(data, dict):
                            msgs = data.get("messages") or data.get("data") or []
                        elif isinstance(data, list):
                            msgs = data
                        else:
                            msgs = []
                        return msgs, None
                    else:
                        text = await response.text()
                        return None, f"HTTP {response.status}: {text}"
        except Exception as e:
            logger.error(f"获取会话消息失败: {e}")
            return None, str(e)

    async def _raw_get_session_messages_page(
        self,
        session_id: str,
        limit: int = 200,
        before: Optional[str] = None,
    ) -> Tuple[Optional[List[Dict]], Optional[str], Optional[str]]:
        """
        获取一页会话消息（带分页游标）

        与 get_session_messages 的区别：额外返回 x-next-cursor 响应头值，
        供调用方翻到更早一页。OpenCode 消息按时间升序返回（旧→新），
        x-next-cursor 作为 before 参数可获取该页更早的消息。

        Args:
            session_id: 会话ID
            limit: 单页消息数量上限
            before: 分页游标（来自上一页响应的 x-next-cursor）

        Returns:
            (messages_list, next_cursor, error_message)
            - next_cursor: 翻更早页的游标；None 表示没有更多更早消息
        """
        try:
            params = {"limit": limit}
            if before:
                params["before"] = before

            async with aiohttp.ClientSession(timeout=self.timeout) as client:
                async with client.get(
                    f"{self.base_url}/session/{session_id}/message",
                    params=params,
                    headers=self._auth()
                ) as response:
                    if response.status == 200:
                        data = await response.json()
                        # 兼容不同返回格式
                        if isinstance(data, dict):
                            msgs = data.get("messages") or data.get("data") or []
                        elif isinstance(data, list):
                            msgs = data
                        else:
                            msgs = []
                        # 分页游标：OpenCode 返回 x-next-cursor 头（base64 不透明游标）
                        next_cursor = response.headers.get("x-next-cursor") or None
                        return msgs, next_cursor, None
                    else:
                        text = await response.text()
                        return None, None, f"HTTP {response.status}: {text}"
        except Exception as e:
            logger.error(f"获取会话消息分页失败: {e}")
            return None, None, str(e)

    async def _raw_get_session_children(self, session_id: str) -> Tuple[Optional[List[Dict]], Optional[str]]:
        """获取会话的子会话列表"""
        try:
            async with aiohttp.ClientSession(timeout=self.timeout) as client:
                async with client.get(
                    f"{self.base_url}/session/{session_id}/children",
                    headers=self._auth()
                ) as response:
                    if response.status == 200:
                        data = await response.json()
                        children = data if isinstance(data, list) else data.get("children", [])
                        return children, None
                    else:
                        text = await response.text()
                        return None, f"HTTP {response.status}: {text}"
        except Exception as e:
            return None, str(e)

    async def _raw_summarize_session(
        self,
        session_id: str,
        provider_id: Optional[str] = None,
        model_id: Optional[str] = None,
    ) -> Tuple[Optional[Dict], Optional[str]]:
        """
        压缩会话上下文：调用 OpenCode /session/{session_id}/summarize

        POST /session/{session_id}/summarize
        Body: { "providerID": "deepseek", "modelID": "deepseek-v4-pro" }

        Args:
            session_id: 会话ID
            provider_id: 提供商ID（默认使用全局配置）
            model_id: 模型ID（默认使用全局配置）

        Returns:
            (response_data, error_message)
        """
        body = {
            "providerID": provider_id or OPENCODE_DEFAULT_PROVIDER,
            "modelID": model_id or OPENCODE_DEFAULT_MODEL,
        }
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=1200)) as client:
                async with client.post(
                    f"{self.base_url}/session/{session_id}/summarize",
                    headers=self._get_headers(session_id),
                    json=body
                ) as response:
                    if response.status == 200:
                        data = await response.json()
                        logger.info(f"会话压缩成功: {session_id}")
                        return data, None
                    else:
                        safe_text = redact_text(await response.text())
                        logger.error(
                            "会话压缩失败: HTTP %s, %s", response.status, safe_text
                        )
                        return None, f"HTTP {response.status}: {safe_text}"
        except Exception as e:
            logger.error("会话压缩异常: %s", redact_text(str(e)))
            return None, redact_text(str(e))

    async def get_providers(self) -> Tuple[Optional[Dict], Optional[str]]:
        """获取OpenCode提供商和模型列表

        调用 GET /config/providers 获取所有可用提供商及其模型列表

        Returns:
            (providers_data, error_message)
        """
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as client:
                async with client.get(
                    f"{self.base_url}/config/providers",
                    headers=self._auth({"Accept": "application/json"})
                ) as response:
                    if response.status == 200:
                        data = await response.json()
                        return data, None
                    else:
                        text = await response.text()
                        return None, f"HTTP {response.status}: {text}"
        except Exception as e:
            logger.error(f"获取提供商列表失败: {e}")
            return None, str(e)

    async def _raw_get_available_models(self) -> Tuple[Optional[List[Dict[str, Any]]], Optional[str]]:
        """从 OpenCode /config/providers 获取可用模型清单，并应用排除策略"""
        # 确保模型配置已加载（懒加载行为）
        load_model_config()
        try:
            async with aiohttp.ClientSession(timeout=self.timeout) as client:
                async with client.get(f"{self.base_url}/config/providers", headers=self._get_headers()) as response:
                    if response.status != 200:
                        text = await response.text()
                        return None, f"HTTP {response.status}: {text}"
                    data = await response.json()
                    providers: List[Dict[str, Any]] = []
                    # 兼容多种返回结构
                    items = []
                    if isinstance(data, dict):
                        items = data.get("providers") or data.get("providers_list") or []
                    elif isinstance(data, list):
                        items = data
                    if not isinstance(items, list):
                        items = []

                    for prov in items:
                        if not isinstance(prov, dict):
                            continue
                        provider_id = (prov.get("provider_id") or prov.get("providerId") or prov.get("id") or prov.get("name"))
                        provider_name = (prov.get("provider_name") or prov.get("providerName") or prov.get("name"))
                        models_raw = prov.get("models") or {}
                        # 支持两种格式：列表格式[{"id":..., "name":...}] 或字典格式{"model_id": {"id":..., "name":...}}
                        if isinstance(models_raw, dict):
                            # 字典格式: {"deepseek-chat": {"id": "deepseek-chat", "name": "DeepSeek Chat", ...}}
                            models_iter = models_raw.items()
                        elif isinstance(models_raw, list):
                            # 列表格式: [{"id":..., "name":...}, ...]
                            models_iter = [(m.get("id"), m) for m in models_raw if isinstance(m, dict)]
                        else:
                            models_iter = []
                        
                        for model_id, m in models_iter:
                            if not isinstance(m, dict):
                                continue
                            # 从模型对象中提取信息
                            model_id = (m.get("model_id") or m.get("modelId") or m.get("id") or model_id)
                            model_name = (m.get("model_name") or m.get("modelName") or m.get("name"))
                            if not provider_id or not model_id:
                                continue
                            if _is_model_excluded(provider_id, model_id):
                                continue
                            providers.append({
                                "provider_id": provider_id,
                                "provider_name": provider_name or provider_id,
                                "model_id": model_id,
                                "model_name": model_name or model_id,
                            })
                    return providers, None
        except Exception as e:
            return None, str(e)

    # ==================== 信封公共 API（V6：原 OpenCodeGateway 下沉拍扁） ====================
    # 返回 dict 与原 gateway 逐键同构：{"ok", "data", "error": None | {"source","detail","code"}}。
    # mock 开关（features.opencode_mock_enabled）分支与默认模型/提供商注入在此层完成；
    # 裸传输方法为上方的 _raw_* 系列（元组协议，仅本层消费）。
    # 裁定（计划 V6）：gateway 文件退役，其全部方法并入 client；调用方统一
    # `client = await acquire_opencode_client()` 后直调本层，三级栈压成两级。

    @staticmethod
    def _ok(data: Any = None) -> Dict[str, Any]:
        """构造成功响应信封"""
        return {"ok": True, "data": data, "error": None}

    @staticmethod
    def _fail(source: str, detail: str, code: int = 500) -> Dict[str, Any]:
        """构造错误响应信封"""
        return {"ok": False, "data": None,
                "error": {"source": source, "detail": detail, "code": code}}

    @staticmethod
    def _offline_mode() -> bool:
        """mock 开关（每次调用动态读配置）。

        原 gateway 在构造期快照该标志并靠 _reset_gateway 重读；平迁后动态读取，
        生产配置运行期不变，语义等价，测试不再需要重置单例。
        """
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

    def get_default_model(self) -> str:
        return OPENCODE_DEFAULT_MODEL

    def get_default_provider(self) -> str:
        return OPENCODE_DEFAULT_PROVIDER

    async def health_check(self) -> Dict[str, Any]:
        """检查 OpenCode 服务状态"""
        if self._offline_mode():
            return self._ok({"status": "mock", "mode": "offline"})
        try:
            result, error = await self._raw_list_sessions(limit=1)
            if error:
                return self._ok({"status": "offline", "mode": "online", "detail": error})
            return self._ok({"status": "online", "mode": "online"})
        except Exception as e:
            return self._ok({"status": "offline", "mode": "online", "detail": str(e)})

    async def create_session(self, title: Optional[str] = None,
                             directory: Optional[str] = None) -> Dict[str, Any]:
        """创建 OpenCode 会话"""
        if self._offline_mode():
            return self._ok({"session_id": self._mock_session_id(), "title": title or "模拟会话"})
        try:
            session_id, error = await self._raw_create_session(title=title, directory=directory)
            if error:
                return self._fail("opencode", error)
            return self._ok({"session_id": session_id, "title": title or "语音交互会话"})
        except Exception as e:
            return self._fail("system", f"create_session 异常: {e}")

    async def list_sessions(self, limit: int = 20) -> Dict[str, Any]:
        """列出 OpenCode 会话"""
        if self._offline_mode():
            return self._ok({"sessions": self._mock_sessions()})
        try:
            sessions, error = await self._raw_list_sessions(limit=limit)
            if error:
                return self._fail("opencode", error)
            # 统一 session_id 字段
            normalized = []
            for s in (sessions or []):
                if isinstance(s, dict) and "id" in s and "session_id" not in s:
                    s["session_id"] = s["id"]
                normalized.append(s)
            return self._ok({"sessions": normalized})
        except Exception as e:
            return self._fail("system", f"list_sessions 异常: {e}")

    async def get_session_status(self, session_id: str) -> Dict[str, Any]:
        """获取会话状态"""
        if self._offline_mode():
            return self._ok({"session_id": session_id, "status": "active"})
        try:
            data, error = await self._raw_get_session_status(session_id)
            if error:
                return self._fail("opencode", error)
            return self._ok(data or {})
        except Exception as e:
            return self._fail("system", f"get_session_status 异常: {e}")

    async def abort_session(self, session_id: str,
                            directory: Optional[str] = None) -> Dict[str, Any]:
        """中止会话任务"""
        if self._offline_mode():
            return self._ok({"aborted": True, "session_id": session_id})
        try:
            success, error = await self._raw_abort_session(session_id, directory=directory)
            if error:
                return self._fail("opencode", error)
            return self._ok({"aborted": success, "session_id": session_id})
        except Exception as e:
            return self._fail("system", f"abort_session 异常: {e}")

    async def send_message(self, session_id: str, message: str,
                           agent: Optional[str] = None,
                           model_id: Optional[str] = None,
                           provider_id: Optional[str] = None,
                           directory: Optional[str] = None) -> Dict[str, Any]:
        """发送消息到 OpenCode（默认模型/提供商注入在此解析）"""
        if self._offline_mode():
            return self._ok({"sent": True, "session_id": session_id,
                             "message": message[:50] + "..." if len(message) > 50 else message})
        try:
            m_id = model_id or OPENCODE_DEFAULT_MODEL
            p_id = provider_id or OPENCODE_DEFAULT_PROVIDER
            agent_name = agent or OPENCODE_DEFAULT_AGENT
            logger.info(f"[CLIENT] agent={agent_name}, model={m_id}, provider={p_id}, "
                        f"session={session_id}, message_chars={len(message)}")
            success, error = await self._raw_send_message(
                session_id=session_id, message=message,
                agent=agent_name,
                model_id=m_id, provider_id=p_id, directory=directory
            )
            if error:
                return self._fail("opencode", error)
            return self._ok({"sent": success, "session_id": session_id})
        except Exception as e:
            return self._fail("system", f"send_message 异常: {e}")

    async def send_voice_to_opencode(self, text: str, agent: str = "main-task") -> bool:
        """
        统一语音消息发送：获取/创建 agent 会话 → abort → send

        所有语音路径（STT路由/WebSocket音频/继续聊天）都调用此方法，
        确保与文字消息路径共享同一 agent 会话。
        （V6 平迁自 gateway.send_voice_to_opencode，编排逻辑逐行不变。）
        """
        from services.stt_session_manager import get_session_manager

        session_mgr = get_session_manager()

        # 1. 优先使用 agent 绑定的会话（与文字消息路径一致）
        session_id = session_mgr.get_agent_session(agent)
        logger.info(f"[CLIENT] send_voice_to_opencode agent={agent}, found_session={session_id}")

        # 2. 无会话 → 创建新会话并绑定到 agent
        if not session_id:
            result = await self.create_session(title="语音交互会话")
            if result["ok"]:
                session_id = result["data"]["session_id"]
                session_mgr.set_agent_session(agent, session_id)
                session_mgr.set_current_session(session_id, "语音交互会话")
                logger.info(f"[CLIENT] 为 agent={agent} 创建会话: {session_id}")
            else:
                logger.error(
                    "[CLIENT] 创建会话失败: %s",
                    redact_text(str(result.get("error", {}).get("detail", "未知错误"))),
                )
                return False

        # 3. 中止当前 AI 任务
        await self.abort_session(session_id)

        # 4. 发送消息
        send_result = await self.send_message(
            session_id=session_id,
            message=text,
            agent=agent
        )

        if send_result["ok"]:
            logger.info(
                "[CLIENT] 语音消息已发送到 agent=%s: text_chars=%d", agent, len(text)
            )
            return True
        else:
            logger.error(
                "[CLIENT] 发送语音消息失败: %s",
                redact_text(str(send_result.get("error", {}))),
            )
            return False

    async def get_available_models(self) -> Dict[str, Any]:
        """获取可用模型列表（从 OpenCode 实时获取，按 provider 分组归一化）"""
        if self._offline_mode():
            return self._ok({"providers": [
                {"id": "mock-provider", "name": "模拟提供商", "models": [
                    {"id": OPENCODE_DEFAULT_MODEL, "name": OPENCODE_DEFAULT_MODEL}
                ]}
            ]})
        try:
            data, error = await self.get_providers()
            if error:
                logger.warning(f"从 OpenCode 获取模型列表失败: {error}，使用空列表")
                return self._ok({"providers": []})

            providers_raw = (data or {}).get("providers", [])
            providers_out = []

            for pv in providers_raw:
                if not isinstance(pv, dict):
                    continue
                pid = pv.get("id") or ""
                pname = pv.get("name") or pid
                models_raw = pv.get("models") or {}
                model_list = []

                if isinstance(models_raw, dict):
                    # models 是 {modelId: modelObj} 格式
                    for mid, mobj in models_raw.items():
                        if isinstance(mobj, dict):
                            model_list.append({
                                "id": mobj.get("id") or mid,
                                "name": mobj.get("name") or mobj.get("id") or mid
                            })
                elif isinstance(models_raw, list):
                    # models 是 [{id, name}] 格式
                    for mobj in models_raw:
                        if isinstance(mobj, dict) and mobj.get("id"):
                            model_list.append({
                                "id": mobj["id"],
                                "name": mobj.get("name") or mobj["id"]
                            })

                if pid and model_list:
                    providers_out.append({
                        "id": pid,
                        "name": pname,
                        "models": model_list
                    })

            return self._ok({"providers": providers_out})

        except Exception as e:
            logger.error(f"get_available_models 异常: {e}")
            return self._fail("system", f"get_available_models 异常: {e}")

    async def summarize_session(
        self,
        session_id: str,
        model_id: Optional[str] = None,
        provider_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """触发会话上下文压缩（调用 OpenCode 原生 /summarize 端点）"""
        if self._offline_mode():
            return self._ok({"compacted": True, "session_id": session_id, "mock": True})
        try:
            p_id = provider_id or OPENCODE_DEFAULT_PROVIDER
            m_id = model_id or OPENCODE_DEFAULT_MODEL
            data, error = await self._raw_summarize_session(
                session_id=session_id,
                provider_id=p_id,
                model_id=m_id,
            )
            if error:
                return self._fail("opencode", error)
            return self._ok({"compacted": True, "session_id": session_id, "data": data})
        except Exception as e:
            return self._fail("system", f"summarize_session 异常: {e}")

    async def get_session_messages(self, session_id: str, limit: int = 100,
                                   before: Optional[str] = None) -> Dict[str, Any]:
        """获取会话消息历史（含翻页游标）

        before 为上一页返回的 next_cursor（OpenCode 的 x-next-cursor 不透明游标），
        传入后获取该游标更早的一页；返回 data.next_cursor 供继续往更早翻页。
        """
        if self._offline_mode():
            return self._ok({"messages": [], "session_id": session_id, "next_cursor": None})
        try:
            # 使用 page 版本以拿到 x-next-cursor 响应头作为翻页游标
            messages, next_cursor, error = await self._raw_get_session_messages_page(
                session_id, limit=limit, before=before
            )
            if error:
                return self._fail("opencode", error)
            return self._ok({
                "messages": messages or [],
                "session_id": session_id,
                "next_cursor": next_cursor,
            })
        except Exception as e:
            return self._fail("system", f"get_session_messages 异常: {e}")

    async def get_session_children(self, session_id: str) -> Dict[str, Any]:
        """获取会话的子会话列表"""
        if self._offline_mode():
            return self._ok({"children": []})
        try:
            children, error = await self._raw_get_session_children(session_id)
            if error:
                return self._fail("opencode", error)
            return self._ok({"children": children or []})
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
        """
        分页拉取会话消息，覆盖 [start_ms, end_ms] 时间范围。

        OpenCode 消息按时间升序返回（每页内旧→新），首页为最新一批；
        通过响应头 x-next-cursor 作为 before 游标逐页往更早翻。
        当某页最旧消息（页内第一条）早于 start_ms 时即可停止。

        Args:
            session_id: 会话ID
            start_ms: 起始毫秒时间戳（含），None 表示不限早界
            end_ms: 结束毫秒时间戳（含），None 表示不限晚界
            max_pages: 翻页硬上限保护
            page_size: 单页大小

        Returns:
            {"ok": True, "data": {"messages": [...按时间升序...], "truncated": bool}}
            messages 元素为 OpenCode 原始消息 dict
        """
        if self._offline_mode():
            return self._ok({"messages": [], "truncated": False})

        collected: List[Dict] = []  # 暂存所有页（跨页整体从新到旧）
        before: Optional[str] = None
        truncated = False

        try:
            for _ in range(max_pages):
                page, next_cursor, error = await self._raw_get_session_messages_page(
                    session_id, limit=page_size, before=before
                )
                if error:
                    return self._fail("opencode", error)
                if not page:
                    break

                collected.extend(page)

                # 页内按时间升序：第一条是最旧的，若已早于 start_ms 则无需再翻
                first_ts = page[0].get("info", {}).get("time", {}).get("created")
                if start_ms is not None and isinstance(first_ts, (int, float)) and first_ts < start_ms:
                    break

                if not next_cursor:
                    break
                before = next_cursor
            else:
                # 达到 max_pages 仍未翻完
                truncated = True

            # 统一按时间升序排列（collected 跨页从新到旧）
            messages = sorted(
                collected,
                key=lambda m: (m.get("info", {}).get("time", {}).get("created") or 0),
            )
            return self._ok({"messages": messages, "truncated": truncated})
        except Exception as e:
            return self._fail("system", f"get_session_messages_range 异常: {e}")

    async def get_active_sessions(self) -> Dict[str, Any]:
        """获取活跃会话列表"""
        if self._offline_mode():
            return self._ok({"active_sessions": self._mock_sessions()})
        try:
            sessions, error = await self._raw_list_sessions(limit=50)
            if error:
                return self._fail("opencode", error)
            return self._ok({"active_sessions": sessions or []})
        except Exception as e:
            return self._fail("system", f"get_active_sessions 异常: {e}")


# 单例实例
_opencode_client: Optional[OpenCodeClient] = None
_offline_client: Optional[OpenCodeClient] = None


def get_opencode_client() -> OpenCodeClient:
    """获取OpenCode客户端单例（自动探测可用端口）。

    同步工厂：端口探测（socket.connect_ex）是阻塞调用——事件循环上下文
    请改用 acquire_opencode_client()（原 gateway._ensure_client 语义，BE-COR-M11）。
    """
    global _opencode_client
    if _opencode_client is None:
        discovered = discover_opencode_url()
        _opencode_client = OpenCodeClient(base_url=discovered)
    return _opencode_client


async def acquire_opencode_client() -> OpenCodeClient:
    """异步获取客户端单例（V6 拍扁：原 gateway._ensure_client 平迁至此）。

    mock 开关开启时返回离线实例（信封方法命中 mock 分支不触网，也不做端口探测）；
    否则把阻塞式端口探测放进线程池延迟执行，不占用事件循环（BE-COR-M11）。
    """
    global _opencode_client, _offline_client
    if _opencode_client is not None:
        return _opencode_client
    if get_config().OPENCODE_MOCK_ENABLED:
        if _offline_client is None:
            _offline_client = OpenCodeClient(base_url=OPENCODE_BASE_URL)
        return _offline_client
    loop = asyncio.get_running_loop()
    _opencode_client = await loop.run_in_executor(None, get_opencode_client)
    return _opencode_client


def _reset_opencode_client() -> None:
    """重置客户端单例（仅测试用，对应原 gateway 的 _reset_gateway）。"""
    global _opencode_client, _offline_client
    _opencode_client = None
    _offline_client = None


def reload_static_config() -> None:
    """从 config 单例重新快照模块级静态配置（ConfigStore 热重载钩子）。

    ConfigStore 原地替换 ``Config._data``，get_config() 返回的 facade 对象不变；
    本函数把 import 期快照到模块全局的值重新拉取，并清空端口探测/认证告警/
    模型排除缓存与客户端单例，使下一次请求使用新配置。幂等，可重复调用。
    """
    global _cfg
    global OPENCODE_CONFIG_URL, OPENCODE_BASE_URL
    global OPENCODE_DEFAULT_DIRECTORY, OPENCODE_DEFAULT_AGENT
    global OPENCODE_DEFAULT_MODEL, OPENCODE_DEFAULT_PROVIDER
    global _OPENCODE_DISCOVERED_URL, _auth_warned, _model_config_excluded

    _cfg = get_config()
    OPENCODE_CONFIG_URL = _cfg.OPENCODE_URL
    OPENCODE_BASE_URL = OPENCODE_CONFIG_URL
    OPENCODE_DEFAULT_DIRECTORY = _cfg.OPENCODE_DIRECTORY
    OPENCODE_DEFAULT_AGENT = _cfg.OPENCODE_DEFAULT_AGENT
    OPENCODE_DEFAULT_MODEL = _cfg.OPENCODE_DEFAULT_MODEL
    OPENCODE_DEFAULT_PROVIDER = _cfg.OPENCODE_DEFAULT_PROVIDER

    _OPENCODE_DISCOVERED_URL = None
    _auth_warned = False
    _model_config_excluded = []

    reset_model_config_cache()
    _reset_opencode_client()
