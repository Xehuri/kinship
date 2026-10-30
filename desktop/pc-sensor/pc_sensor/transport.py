# -*- coding: utf-8 -*-
"""上报端点候选与健康探测选择。

Windows Phase 1 P2P 传输底座（本阶段不做 WebRTC / TUN）：
- 允许同时配置 IPv6 直连与 frp 两个候选端点；
- 按优先级探测 GET /health，优先 IPv6，失败回退 frp；
- 选中结果缓存 5 分钟（时钟可注入），避免每次上报都探测；
- 未配置候选时完全沿用原有 server_url 行为。

只使用标准库 urllib，不引入任何新依赖。
"""

import logging
import ssl
import threading
import time
from dataclasses import dataclass
from typing import Callable, Iterable, Mapping, Optional
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

logger = logging.getLogger("pc_sensor.transport")

# 选中结果缓存时长（秒）
CACHE_TTL_SECONDS = 300.0
# 健康探测超时（秒）：同时作为连接与读取超时
PROBE_TIMEOUT_SECONDS = 2.0
# 仅回环地址允许使用 http://（其余一律要求 https://）
LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}


class CandidateError(ValueError):
    """endpoint_candidates 配置无效（仅含用户可读信息，不含凭据）。"""


def build_ssl_context(ssl_verify: bool = True, ssl_ca_file: str = "") -> ssl.SSLContext:
    """构建 SSL 上下文（与 Uploader 原有语义一致）。

    默认使用系统信任库做完整校验（verify_mode=CERT_REQUIRED、
    check_hostname=True）。自签名证书可通过 ssl_ca_file 指定 CA bundle；
    只有在显式 ssl_verify=False 时才关闭校验（会记录警告）。
    """
    if ssl_ca_file:
        ctx = ssl.create_default_context(cafile=ssl_ca_file)
    else:
        ctx = ssl.create_default_context()

    if not ssl_verify:
        logger.warning(
            "已禁用 TLS 证书校验（ssl_verify=False），连接不受中间人攻击保护，"
            "仅应在自签名且无法提供 CA 的场景临时使用"
        )
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE

    return ctx


def _default_priority(name: str) -> int:
    """按端点名给出默认优先级：数字越小越先尝试。"""
    lowered = name.strip().lower()
    if "ipv6" in lowered or lowered in {"v6", "direct6"}:
        return 10
    if "lan" in lowered or "local" in lowered:
        return 20
    if "frp" in lowered:
        return 90
    return 50


def _normalize_url(name: str, raw_url: object) -> str:
    """校验并规范化单个端点 URL。"""
    url = str(raw_url or "").strip().rstrip("/")
    if not url:
        raise CandidateError(f"端点 {name} 的 url 为空")
    parsed = urlsplit(url)
    if parsed.scheme not in ("http", "https"):
        raise CandidateError(f"端点 {name} 仅支持 http/https")
    host = (parsed.hostname or "").strip().lower()
    if not host:
        raise CandidateError(f"端点 {name} 缺少主机名")
    if parsed.username or parsed.password:
        raise CandidateError(f"端点 {name} 不能在 URL 中包含账号密码")
    if parsed.scheme == "http" and host not in LOOPBACK_HOSTS:
        raise CandidateError(f"端点 {name} 必须使用 https（仅 localhost 允许 http）")
    return url


def normalize_candidates(raw: object) -> list[dict]:
    """把配置中的 endpoint_candidates 规范化为有序列表。

    支持两种写法：
    - [{"name": "ipv6", "url": "https://...", "priority": 10}, ...]
    - {"ipv6": "https://...", "frp": "https://..."}

    返回按优先级（其次按书写顺序）排序的 {name,url,priority} 列表。
    校验失败抛 CandidateError。
    """
    if raw in (None, "", {}):
        return []

    items: list[dict] = []
    if isinstance(raw, Mapping):
        for name, url in raw.items():
            items.append({"name": str(name), "url": url})
    elif isinstance(raw, (list, tuple)):
        for index, item in enumerate(raw):
            if isinstance(item, str):
                items.append({"name": f"endpoint{index + 1}", "url": item})
            elif isinstance(item, Mapping):
                items.append(dict(item))
            else:
                raise CandidateError("endpoint_candidates 列表元素必须是对象或字符串")
    else:
        raise CandidateError("endpoint_candidates 必须是列表或对象")

    normalized: list[dict] = []
    for index, item in enumerate(items):
        name = str(item.get("name") or f"endpoint{index + 1}").strip()
        url = _normalize_url(name, item.get("url"))
        raw_priority = item.get("priority")
        if raw_priority is None or isinstance(raw_priority, bool):
            priority = _default_priority(name)
        else:
            try:
                priority = int(raw_priority)
            except (TypeError, ValueError):
                raise CandidateError(f"端点 {name} 的 priority 必须是整数") from None
        normalized.append(
            {"name": name, "url": url, "priority": priority, "_index": index}
        )

    normalized.sort(key=lambda entry: (entry["priority"], entry["_index"]))
    for entry in normalized:
        entry.pop("_index", None)
    return normalized


@dataclass(frozen=True)
class EndpointCandidate:
    """单个上报端点候选。"""

    name: str
    url: str
    priority: int = 50

    @property
    def base_url(self) -> str:
        return self.url.rstrip("/")


class TransportSelector:
    """按健康检查结果选择上报端点，并缓存选择结果。"""

    def __init__(
        self,
        candidates: Iterable[EndpointCandidate] | object = (),
        ssl_verify: bool = True,
        ssl_ca_file: str = "",
        fallback_url: str = "",
        cache_ttl: float = CACHE_TTL_SECONDS,
        clock: Optional[Callable[[], float]] = None,
        probe_timeout: float = PROBE_TIMEOUT_SECONDS,
        server_url: str = "",
    ):
        if isinstance(candidates, Mapping) or (
            isinstance(candidates, (list, tuple))
            and candidates
            and not all(isinstance(item, EndpointCandidate) for item in candidates)
        ):
            raw_list = normalize_candidates(candidates)
        else:
            raw_list = [
                {"name": c.name, "url": _normalize_url(c.name, c.url), "priority": int(c.priority)}
                for c in candidates or []
            ]
            raw_list.sort(key=lambda entry: entry["priority"])

        candidates = tuple(
            EndpointCandidate(name=entry["name"], url=entry["url"], priority=entry["priority"])
            for entry in raw_list
        )
        self._fallback_url = str(fallback_url or server_url or "").strip().rstrip("/")
        # 显式传入的 server_url 代表调用方选中的当前端点，优先于候选优先级探测；
        # 仅当它仍存在于候选列表时生效，探测失败仍按原顺序回退其他候选。
        if self._fallback_url:
            preferred = next(
                (c for c in candidates if c.base_url == self._fallback_url), None
            )
            if preferred is not None:
                candidates = (preferred,) + tuple(
                    c for c in candidates if c is not preferred
                )
        self._candidates = candidates
        self._cache_ttl = float(cache_ttl)
        self._clock = clock or time.monotonic
        self._probe_timeout = float(probe_timeout)
        self._ssl_ctx = build_ssl_context(ssl_verify, ssl_ca_file)
        self._lock = threading.Lock()
        self._cached_url: Optional[str] = None
        self._cached_at = 0.0

    @property
    def candidates(self) -> tuple[EndpointCandidate, ...]:
        return self._candidates

    @property
    def has_candidates(self) -> bool:
        return bool(self._candidates)

    @property
    def ssl_context(self) -> ssl.SSLContext:
        return self._ssl_ctx

    @property
    def current_url(self) -> str:
        """当前端点：已选中的缓存值，否则最高优先级候选，再否则回退地址。

        该属性不发起网络探测，供状态展示等非阻塞场景使用。
        """
        with self._lock:
            if self._cached_url is not None:
                return self._cached_url
        if self._candidates:
            return self._candidates[0].base_url
        return self._fallback_url

    def select(self, force: bool = False) -> str:
        """探测并返回选中的基地址；force=True 时忽略缓存重新探测。"""
        with self._lock:
            now = self._clock()
            if (
                not force
                and self._cached_url is not None
                and (now - self._cached_at) < self._cache_ttl
            ):
                return self._cached_url

            if not self._candidates:
                self._cached_url = self._fallback_url
                self._cached_at = now
                return self._cached_url

            for candidate in self._candidates:
                if self._probe(candidate):
                    url = candidate.base_url
                    if url != self._cached_url:
                        logger.info("已选择上报端点: %s (%s)", candidate.name, url)
                    self._cached_url = url
                    self._cached_at = now
                    return url

            if self._cached_url is not None:
                # 保留上次成功选中（或已缓存）的端点，探测全失败不构成降级依据；
                # 同时刷新时间戳，非 force 调用在本轮 TTL 内继续复用该端点。
                logger.warning(
                    "所有上报端点探测失败，保留上次选中端点 %s", self._cached_url
                )
                self._cached_at = now
                return self._cached_url

            fallback = self._fallback_url or self._candidates[0].base_url
            logger.warning("所有上报端点探测失败，回退到 %s", fallback)
            self._cached_url = fallback
            self._cached_at = now
            return fallback

    def _probe(self, candidate: EndpointCandidate) -> bool:
        url = candidate.base_url + "/health"
        req = Request(
            url,
            headers={"User-Agent": "AxeuhPCSensor/transport"},
            method="GET",
        )
        try:
            with urlopen(req, timeout=self._probe_timeout, context=self._ssl_ctx) as resp:
                status = int(getattr(resp, "status", 0) or 0)
                return 200 <= status < 300
        except Exception as e:  # noqa: BLE001 - 单个端点探测失败只影响候选排序
            logger.debug("端点探测失败 %s: %s", candidate.name, e)
            return False
