"""providers.base —— 聚合搜索 MCP server 的 provider 契约层。

本模块只定义数据结构与错误类型，不含任何网络逻辑。
providers/tavily.py 与 providers/exa.py 必须实现以下协议（router 依赖）：

    class SomeProvider:
        def __init__(self, api_key: str, timeout_s: float, transport=None):
            # transport 仅测试注入 httpx.MockTransport 用，生产默认 None（真实网络）

        def search(self, params: NormalizedParams, deadline_mono: float) -> ProviderResponse:
            # deadline_mono 为 time.monotonic() 的截止时刻；
            # 剩余预算不足时应抛 TransientError，而不是静默超期；
            # 只允许抛本模块定义的 ProviderError 子类，其余异常不得外泄。

        def usage(self) -> dict:
            # 可选方法：返回账户额度/用量快照（纯 dict，JSON 可序列化）。

错误语义约定（设计理由）：
- Tavily 432/433、Exa 402 均映射为 QUOTA_EXHAUSTED（额度耗尽，冷却到月初重置）；
- 429 是限流（RATE_LIMITED），不等于额度耗尽，只做退避重试；
- 两家提供商额度都按每月 1 日重置（见 cooldown.next_reset）。
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import ClassVar, Optional


class ErrorKind(str, Enum):
    """provider 错误分类（str 枚举，JSON 值可直接透传给调用方）。"""

    BAD_REQUEST = "bad_request"          # 请求参数不合法：不可重试
    INVALID_KEY = "invalid_key"          # API key 无效/吊销：应置 disabled，永不自动恢复
    RATE_LIMITED = "rate_limited"        # 限流：可退避重试，不代表额度耗尽
    QUOTA_EXHAUSTED = "quota_exhausted"  # 额度耗尽：冷却至下月重置
    TRANSIENT = "transient"              # 瞬时故障（超时/5xx/预算不足）：可短延迟重试


class ProviderError(Exception):
    """所有 provider 可预期失败的基类。子类通过 kind 类属性绑定错误分类。"""

    # 基类不绑定具体 kind；由五个子类各自覆盖（见下）
    kind: ClassVar[Optional[ErrorKind]] = None

    def __init__(
        self,
        provider: str,
        detail: str,
        status: Optional[int] = None,
        retry_after_s: Optional[float] = None,
    ) -> None:
        super().__init__(f"[{provider}] {detail}")
        self.provider = provider
        self.status = status
        self.kind = type(self).kind
        self.detail = detail
        self.retry_after_s = retry_after_s


class BadRequestError(ProviderError):
    """400 等参数错误：同一请求重试无意义。"""

    kind = ErrorKind.BAD_REQUEST


class InvalidKeyError(ProviderError):
    """401/403 鉴权失败：应 mark_disabled，永不自动恢复。"""

    kind = ErrorKind.INVALID_KEY


class RateLimitedError(ProviderError):
    """429 限流：retry_after_s 提示退避秒数。限流不等于额度耗尽。"""

    kind = ErrorKind.RATE_LIMITED


class QuotaExhaustedError(ProviderError):
    """额度耗尽（Tavily 432/433、Exa 402）：冷却至下月 1 日重置。"""

    kind = ErrorKind.QUOTA_EXHAUSTED


class TransientError(ProviderError):
    """瞬时故障：超时、5xx、或本次请求 deadline 预算不足。"""

    kind = ErrorKind.TRANSIENT


class SearchUnavailable(Exception):
    """两个提供商都不可用时的终态错误（Router 对外唯一抛出的失败类型）。"""

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


@dataclass
class NormalizedParams:
    """归一化搜索参数（router 与各 provider 之间的统一入参）。"""

    query: str
    max_results: int = 5
    depth: str = "basic"          # basic | advanced
    topic: Optional[str] = None   # general | news | finance
    time_range: Optional[str] = None  # day | week | month | year
    include_content: bool = False
    include_answer: bool = False


@dataclass
class ProviderResponse:
    """provider.search 的归一化返回值。

    results 中每个 dict 的键已归一化为：title, url, content, score, published_date。
    cost_usd 仅 Exa 有（美元），供月度预算记账；Tavily 为 None。
    """

    results: list[dict]
    answer: Optional[str] = None
    cost_usd: Optional[float] = None


@dataclass
class NormalizedResult:
    """MCP 工具对外的最终返回结构。全部字段必须 JSON 可序列化（FastMCP 直接返回）。"""

    provider_used: str
    fallback_applied: bool
    results: list
    answer: Optional[str] = None
    note: Optional[str] = None
    meta: dict = field(default_factory=dict)
