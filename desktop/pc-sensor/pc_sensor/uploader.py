# -*- coding: utf-8 -*-
"""
数据上传模块

认证方式（PC-M7 起）：
- 优先使用预配置的长期 Token（backend_token），直接作为 Bearer Token 上报；
- 未配置 Token 时才用后端账号密码登录获取 token（账号密码仅在内存中使用，绝不落盘）。
token 有效期为 24 小时，提前 1 小时刷新。
使用 urllib 实现，不依赖外部 HTTP 库。
"""

import json
import logging
import threading
import time
import ssl
from typing import Optional
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError
from urllib.parse import urljoin

from .transport import TransportSelector, build_ssl_context

logger = logging.getLogger("pc_sensor.uploader")

# 认证失败原因（面向用户的可读文案）。错误串只含固定文案或后端消息，
# 绝不拼接密码与 Token，便于状态接口与设置页直接展示。
AUTH_ERROR_MISSING_CREDENTIALS = "未配置后端账号密码或访问令牌，无法登录"
AUTH_ERROR_NO_SERVER = "未配置服务器地址"
AUTH_ERROR_BAD_CREDENTIALS = "用户名或密码错误"
AUTH_ERROR_UNREACHABLE = "无法连接服务器"
AUTH_ERROR_SERVER_RESPONSE = "登录失败：服务器响应异常"
AUTH_ERROR_TOKEN_REJECTED = "后端 Token 已被拒绝"


class Uploader:
    """数据上传器

    启动时先用账号密码登录获取 token，上报数据时自动携带。
    token 过期前自动刷新。
    """

    # PC-M2：失败重排队列的最大长度，避免网络长期不可用时内存无界增长
    MAX_BUFFER = 1000

    def __init__(
        self,
        server_url: str,
        username: str,
        password: str,
        agent_id: str,
        agent_name: str = "",
        ssl_verify: bool = True,
        ssl_ca_file: str = "",
        auth_token: str = "",
        transport: Optional[TransportSelector] = None,
    ):
        """
        Args:
            server_url: 后端服务器地址，默认为 https://localhost:8767
            username: 后端登录用户名（无静态 Token 时用于登录）
            password: 后端登录密码。PC-M7：仅在内存中使用，绝不落盘。
            agent_id: Agent ID，用于后端标记数据来源
            agent_name: 设备显示名（可选），随数据上报供后端识别设备
            ssl_verify: 是否校验证书。默认 True（完整校验）。
                仅在明确知晓风险时才可设为 False。
            ssl_ca_file: 自定义 CA 证书（bundle）路径，用于自签名证书场景。
                留空时使用系统默认信任库。
            auth_token: 预配置的后端 Bearer Token（PC-M7）。非空时直接使用，
                不再用账号密码登录，适合配置长期有效的服务 Token。
            transport: 端点选择器（可选）。提供时按健康探测结果选择上报基地址；
                未提供时完全沿用 server_url 行为。
        """
        self.server_url = server_url.rstrip("/")
        self.username = username
        self.password = password
        self.agent_id = agent_id
        self.agent_name = (agent_name or "").strip()
        self.ssl_verify = bool(ssl_verify)
        self.ssl_ca_file = ssl_ca_file or ""
        self._auth_token = (auth_token or "").strip()
        # 静态 Token 被服务端拒绝后置位，避免反复用它无效重试
        self._auth_token_rejected = False
        self.transport = transport

        self._token: Optional[str] = None
        self._token_expiry: float = 0  # time.monotonic 值
        self._auth_error = ""
        self._buffer: list[dict] = []
        self._lock = threading.Lock()
        self._flush_interval = 5.0

        self._ssl_ctx = (
            transport.ssl_context
            if transport is not None
            else self._build_ssl_context()
        )

        # 启动时认证：优先用静态 Token，否则用账号密码登录
        self._login()

    def _build_ssl_context(self) -> ssl.SSLContext:
        """构建 SSL 上下文（语义与 TransportSelector 共用）。"""
        return build_ssl_context(self.ssl_verify, self.ssl_ca_file)

    # ---- 端点选择 ----

    @property
    def destination_configured(self) -> bool:
        """是否具备上报目标：已有 server_url，或配置了候选端点。"""
        if self.server_url:
            return True
        return self.transport is not None and self.transport.has_candidates

    def _base_url(self, force: bool = False) -> str:
        """返回本次请求使用的基地址；有选择器时先探测/复用缓存。"""
        if self.transport is None:
            return self.server_url
        selected = self.transport.select(force=force)
        if selected:
            # 让实例上的 server_url 始终反映当前生效端点（状态展示/排障用）
            self.server_url = selected
        return self.server_url

    def _reselect(self) -> bool:
        """强制重新探测端点；没有候选配置时返回 False。"""
        if self.transport is None or not self.transport.has_candidates:
            return False
        self.transport.select(force=True)
        return True

    @property
    def current_endpoint(self) -> str:
        """当前生效端点（不触发网络探测）。"""
        if self.transport is not None:
            return self.transport.current_url or self.server_url
        return self.server_url

    # ---- Token 管理 ----

    def _login(self) -> bool:
        """获取 Bearer token。

        PC-M7：优先使用预配置的静态 Token（无需密码）；否则才用账号密码登录。
        账号密码仅在内存中使用，绝不写入配置。
        配置了多个端点时，登录失败会强制重新探测并重试一次。
        """
        if self._auth_token and not self._auth_token_rejected:
            self._token = self._auth_token
            self._token_expiry = float("inf")  # 静态 Token 视为长期有效
            self._auth_error = ""
            logger.info("使用预配置的后端 Token 进行上报")
            return True

        if not self.username or not self.password:
            if self._auth_token and self._auth_token_rejected:
                self._auth_error = AUTH_ERROR_TOKEN_REJECTED
                logger.warning("后端 Token 已被拒绝，且未配置账号密码，无法重新登录")
            else:
                self._auth_error = AUTH_ERROR_MISSING_CREDENTIALS
                logger.warning("服务器地址/用户名/密码未配置，无法登录")
            return False

        if self._login_once():
            return True
        if self._reselect():
            logger.info("登录失败，已切换上报端点后重试")
            return self._login_once()
        return False

    def _login_once(self) -> bool:
        base_url = self._base_url()
        if not base_url:
            self._auth_error = AUTH_ERROR_NO_SERVER
            logger.warning("服务器地址/用户名/密码未配置，无法登录")
            return False

        try:
            payload = json.dumps({
                "username": self.username,
                "password": self.password,
            }, ensure_ascii=False).encode("utf-8")

            url = urljoin(base_url, "/login")
            req = Request(
                url,
                data=payload,
                headers={"Content-Type": "application/json"},
                method="POST",
            )

            with urlopen(req, timeout=10, context=self._ssl_ctx) as resp:
                body = json.loads(resp.read())
                if body.get("success") and body.get("token"):
                    self._token = body["token"]
                    # token 24h 有效，提前 1h 刷新
                    self._token_expiry = time.monotonic() + 23 * 3600
                    self._auth_error = ""
                    logger.info("登录成功（%s），token 已获取", body.get("user_id", ""))
                    return True
                message = self._sanitize_auth_message(body.get("message"))
                self._auth_error = message or AUTH_ERROR_BAD_CREDENTIALS
                logger.warning("登录失败: %s", self._auth_error)
                return False

        except URLError as e:
            self._auth_error = AUTH_ERROR_UNREACHABLE
            logger.info("登录失败（网络不可达，稍后重试）: %s", e)
            return False
        except Exception as e:
            self._auth_error = AUTH_ERROR_SERVER_RESPONSE
            logger.warning("登录异常: %s", e)
            return False

    def _sanitize_auth_message(self, message: object) -> str:
        """清理后端返回的登录消息：抹掉密码/Token，并限制长度。"""
        text = str(message or "").strip()
        for secret in (self.password, self._auth_token, self._token or ""):
            if secret:
                text = text.replace(secret, "******")
        return text[:200]

    def _ensure_token(self):
        """确保 token 有效，需要时重新登录"""
        if not self._token or time.monotonic() >= self._token_expiry:
            self._login()

    def auth_token_snapshot(self) -> dict[str, str | int | None]:
        """返回当前 Bearer Token 快照，供桌面壳复用。

        - 尚未取得 Token：token 为空串，expires_in 为 0；
        - 静态 Token：长期有效，expires_in 为 None；
        - 登录取得的 Token：expires_in 为剩余秒数（非负整数）。

        绝不记录 Token 本身。
        """
        if not self._token:
            return {"token": "", "expires_in": 0}
        if self._token_expiry == float("inf"):
            return {"token": self._token, "expires_in": None}
        return {
            "token": self._token,
            "expires_in": max(0, int(self._token_expiry - time.monotonic())),
        }

    def force_relogin(self) -> bool:
        """强制重新认证（供配置界面测试连接用）。

        PC-M7：重置被拒标记后重试；配置了静态 Token 则重新应用，否则用账号密码登录。
        """
        self._token = None
        self._token_expiry = 0
        self._auth_token_rejected = False
        return self._login()

    # ---- 数据上传 ----

    def enqueue(self, data: dict):
        """将一条数据加入发送队列"""
        if not self.destination_configured:
            return
        with self._lock:
            self._buffer.append(data)

    def flush(self):
        """批量发送队列中所有数据；失败时把整批放回队首等待重试。"""
        if not self.destination_configured:
            return

        with self._lock:
            if not self._buffer:
                return
            batch = self._buffer[:]
            self._buffer.clear()

        if not self._send_batch(batch):
            # PC-M2：发送失败不丢数据，整批放回队首，并限制队列上限
            with self._lock:
                self._buffer = batch + self._buffer
                overflow = len(self._buffer) - self.MAX_BUFFER
                if overflow > 0:
                    logger.warning(
                        "待发队列超过上限 %d，丢弃最旧的 %d 条数据",
                        self.MAX_BUFFER,
                        overflow,
                    )
                    del self._buffer[:overflow]

    @property
    def buffer_size(self) -> int:
        with self._lock:
            return len(self._buffer)

    @property
    def has_token(self) -> bool:
        return self._token is not None

    @property
    def auth_error(self) -> str:
        return self._auth_error

    def _send_batch(self, batch: list[dict]) -> bool:
        """发送一批数据到后端；配置多端点时失败会切换端点重试一次。

        返回 True 表示该批已处理完毕（成功，或服务端明确拒绝无需重试）；
        返回 False 表示可恢复失败，调用方应把 batch 放回队列重试。
        """
        if self._send_batch_once(batch):
            return True
        if self._reselect():
            logger.info("上报失败，已切换上报端点后重试一次")
            return self._send_batch_once(batch)
        return False

    def _send_batch_once(self, batch: list[dict]) -> bool:
        self._ensure_token()
        if not self._token:
            logger.debug("无有效 token，暂存 %d 条数据等待重试", len(batch))
            return False

        try:
            payload = json.dumps({
                "agent_id": self.agent_id,
                "agent_name": self.agent_name,
                "events": batch,
            }, ensure_ascii=False).encode("utf-8")

            url = urljoin(self._base_url(), "/api/pc/sync")
            req = Request(
                url,
                data=payload,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {self._token}",
                },
                method="POST",
            )

            with urlopen(req, timeout=10, context=self._ssl_ctx) as resp:
                if resp.status == 200:
                    logger.debug("已上报 %d 条 PC 感知数据", len(batch))
                    return True
                logger.warning("上报失败: HTTP %d", resp.status)
                return False

        except HTTPError as e:
            if e.code == 401:
                # PC-M7：鉴权失效（Token 过期/被撤销）时作废当前 Token 并重试，
                # 绝不静默丢弃数据。若配置了账号密码，下次 flush 会自动重新登录；
                # 若用的是静态 Token，则标记被拒，等待配置更新。
                self._token = None
                self._token_expiry = 0
                self._auth_error = AUTH_ERROR_TOKEN_REJECTED
                if self._auth_token:
                    self._auth_token_rejected = True
                logger.warning("上报鉴权失败（HTTP 401），Token 已作废，等待重新认证")
                return False
            # 其余 4xx 多为请求/数据本身问题，重试无意义，丢弃避免毒丸阻塞队列
            if 400 <= e.code < 500:
                logger.warning("上报被拒（HTTP %d），丢弃 %d 条数据", e.code, len(batch))
                return True
            logger.debug("上报失败（HTTP %d，可重试）: %s", e.code, e)
            return False
        except URLError as e:
            logger.debug("上报失败（网络可恢复，稍后重试）: %s", e)
            return False
        except Exception as e:  # noqa: BLE001 - 未知异常按可重试处理，由队列上限兜底
            logger.warning("上报异常（稍后重试）: %s", e)
            return False

    # ---- 数据拉取 ----

    def fetch_perception_events(self, date: str) -> list[dict]:
        """拉取指定日期(daily/{date}/perception.jsonl)的全部事件；失败返回 []。"""
        if not self.destination_configured:
            logger.debug("未配置 server_url，无法拉取感知数据")
            return []

        self._ensure_token()
        if not self._token:
            logger.debug("无有效 token，无法拉取感知数据")
            return []

        try:
            url = urljoin(
                self._base_url(),
                f"/api/mobile/files/content?path=daily/{date}/perception.jsonl",
            )
            req = Request(
                url,
                headers={"Authorization": f"Bearer {self._token}"},
                method="GET",
            )

            with urlopen(req, timeout=15, context=self._ssl_ctx) as resp:
                body = json.loads(resp.read())

            if not isinstance(body, dict):
                logger.debug("拉取感知数据返回非对象: %s", type(body).__name__)
                return []
            objects = body.get("objects", [])
            return objects if isinstance(objects, list) else []

        except URLError as e:
            logger.debug("拉取感知数据失败（网络可恢复）: %s", e)
            return []
        except Exception as e:  # noqa: BLE001 - 拉取失败绝不抛出
            logger.warning("拉取感知数据异常: %s", e)
            return []
