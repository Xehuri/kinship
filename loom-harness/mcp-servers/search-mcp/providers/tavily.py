"""providers.tavily —— Tavily 搜索提供商适配器（契约见 providers/base.py）。

错误映射**只依据 HTTP status**（Tavily 官方文档明令勿匹配错误文本）：
- 401              -> InvalidKeyError（key 失效，router 永久禁用）
- 429              -> RateLimitedError（读 Retry-After 头原地退避，不代表额度耗尽）
- 432 / 433 / 403  -> QuotaExhaustedError（额度耗尽 = 切换信号，冷却至每月 1 日重置）
- 400 / 422        -> BadRequestError（参数错误，router 直接上抛不切换）
- >=500 与任何未知状态码、httpx 网络层异常 -> TransientError（保守归类，绝不误冷却）

计费事实：basic search 每次 1 credit；免费档 1000 credits/月、每月 1 日重置。
cost_usd 恒为 None（Tavily 计 credits 而非美元），请求恒定携带 include_usage=true，
响应 usage.credits 可供上层日志记账。

全同步实现；httpx.Client 复用连接，transport 参数仅供测试注入 httpx.MockTransport。
"""

import email.utils
import time
from typing import Any, Optional

import httpx

from providers.base import (
    BadRequestError,
    InvalidKeyError,
    NormalizedParams,
    ProviderError,
    ProviderResponse,
    QuotaExhaustedError,
    RateLimitedError,
    TransientError,
)

SEARCH_URL = "https://api.tavily.com/search"
USAGE_URL = "https://api.tavily.com/usage"

# 额度耗尽状态码集合（403 在 Tavily 语境下同样是额度/权限耗尽，非 key 失效）
_QUOTA_STATUSES = frozenset({432, 433, 403})
# 参数错误状态码集合（422 的 detail 是数组，400 的是 {"detail": {"error": str}}）
_BAD_REQUEST_STATUSES = frozenset({400, 422})


def _extract_detail(payload: Any, status: int) -> str:
    """从 Tavily 错误体提取可读 detail 文本，缺失时用状态码兜底，绝不抛。

    兼容三种形态：detail 为 dict -> .get("error")；detail 为数组（422）-> 逐项 msg 拼接；
    detail 为字符串 -> 原样。
    """
    if isinstance(payload, dict):
        detail = payload.get("detail")
        if isinstance(detail, dict):
            error = detail.get("error")
            if isinstance(error, str) and error:
                return error
        elif isinstance(detail, list):
            msgs = [str(item["msg"]) for item in detail if isinstance(item, dict) and item.get("msg")]
            if msgs:
                return "; ".join(msgs)
        elif isinstance(detail, str) and detail:
            return detail
    return f"HTTP {status} 请求失败"


def _parse_retry_after(response: httpx.Response) -> Optional[float]:
    """解析 Retry-After 响应头：仅接受非负秒数；非法（HTTP-date/文字/负数）或缺失返回 None。"""
    raw = response.headers.get("Retry-After")
    if raw is None:
        return None
    try:
        seconds = float(raw)
    except ValueError:
        return None
    if seconds < 0:
        return None
    return seconds


def _to_float(value: Any) -> Optional[float]:
    """score 归一化：数字/数字字符串转 float；bool 与其余畸形值置 None。"""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return None
    return None


def _rfc1123_to_iso(value: Any) -> Optional[str]:
    """RFC1123 时间（如 "Tue, 11 Mar 2025 17:00:00 GMT"）转 ISO "YYYY-MM-DD"。

    null / 非字符串 / 解析失败一律返回 None，绝不向调用方抛异常。
    """
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if parsed is None:
        return None
    return parsed.date().isoformat()


def _normalize_result(item: dict[str, Any]) -> dict[str, Any]:
    """把单条 Tavily 结果归一化为契约规定的五键 dict。"""
    return {
        "title": item.get("title"),
        "url": item.get("url"),
        "content": item.get("content"),
        "score": _to_float(item.get("score")),
        "published_date": _rfc1123_to_iso(item.get("published_date")),
    }


class TavilyProvider:
    """Tavily REST 适配器：实现 base.py 协议（search / usage / close）。"""

    def __init__(
        self,
        api_key: str,
        timeout_s: float = 30.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._api_key = api_key
        self.timeout_s = timeout_s
        # transport 仅为测试注入 httpx.MockTransport；生产默认 None（真实网络）。
        # Client 常驻实例复用连接池；每次请求再按剩余预算收窄 timeout。
        self._client = httpx.Client(transport=transport, timeout=timeout_s)

    # ------------------------------------------------------------------
    # search
    # ------------------------------------------------------------------

    def search(self, params: NormalizedParams, deadline_mono: float) -> ProviderResponse:
        """执行一次 Tavily 搜索；只抛 ProviderError 子类，其余异常不外泄。"""
        budget = deadline_mono - time.monotonic()
        if budget <= 0:
            raise TransientError(provider=self._name, detail="请求时间预算耗尽")
        try:
            response = self._client.post(
                SEARCH_URL,
                json=self._build_body(params),
                headers=self._auth_headers(json_content=True),
                timeout=min(self.timeout_s, budget),
            )
        except httpx.TimeoutException as exc:
            raise TransientError(
                provider=self._name, detail=f"网络超时：{type(exc).__name__}"
            ) from exc
        except httpx.TransportError as exc:
            raise TransientError(
                provider=self._name, detail=f"网络传输异常：{type(exc).__name__}"
            ) from exc

        if response.status_code == 200:
            return self._parse_success(response)
        raise self._map_error(response)

    @staticmethod
    def _build_body(params: NormalizedParams) -> dict[str, Any]:
        """按白名单构造请求体：None 值剔除；include_answer / include_raw_content 仅 True 时携带。"""
        raw: dict[str, Any] = {
            "query": params.query,
            "max_results": params.max_results,
            "search_depth": params.depth,
            "topic": params.topic,
            "time_range": params.time_range,
            "include_answer": True if params.include_answer else None,
            "include_raw_content": True if params.include_content else None,
            "include_usage": True,  # 恒定携带：响应 usage.credits 供上层日志
        }
        return {key: value for key, value in raw.items() if value is not None}

    def _map_error(self, response: httpx.Response) -> ProviderError:
        """HTTP status -> ProviderError 子类（唯一分类依据，不看响应体文本）。"""
        status = response.status_code
        detail = _extract_detail(self._safe_json(response), status)
        if status == 401:
            return InvalidKeyError(provider=self._name, detail=detail, status=status)
        if status == 429:
            return RateLimitedError(
                provider=self._name, detail=detail, status=status,
                retry_after_s=_parse_retry_after(response),
            )
        if status in _QUOTA_STATUSES:
            return QuotaExhaustedError(provider=self._name, detail=detail, status=status)
        if status in _BAD_REQUEST_STATUSES:
            return BadRequestError(provider=self._name, detail=detail, status=status)
        # >=500 或任何未知状态码：保守归为瞬时故障，绝不误冷却
        return TransientError(provider=self._name, detail=detail, status=status)

    def _parse_success(self, response: httpx.Response) -> ProviderResponse:
        """解析 200 响应；结构异常（缺 results / 非对象）视为提供商故障 -> TransientError。"""
        data = self._safe_json(response)
        if not isinstance(data, dict) or "results" not in data:
            raise TransientError(
                provider=self._name, detail="响应缺少顶层 results 键（异常响应=提供商故障）", status=200
            )
        raw_results = data["results"]
        if not isinstance(raw_results, list):
            raise TransientError(provider=self._name, detail="results 字段不是数组", status=200)
        answer = data.get("answer")
        return ProviderResponse(
            results=[_normalize_result(item) for item in raw_results if isinstance(item, dict)],
            answer=answer if isinstance(answer, str) else None,
            cost_usd=None,  # Tavily 按 credits 计费，无美元成本
        )

    # ------------------------------------------------------------------
    # usage
    # ------------------------------------------------------------------

    def usage(self) -> dict:
        """GET /usage 的账户额度快照；任何失败返回 {}（供 provider_status 容错，绝不抛）。"""
        try:
            response = self._client.get(USAGE_URL, headers=self._auth_headers(json_content=False), timeout=self.timeout_s)
            if response.status_code != 200:
                return {}
            data = self._safe_json(response)
            if not isinstance(data, dict):
                return {}
            key: dict[str, Any] = data.get("key") if isinstance(data.get("key"), dict) else {}
            account: dict[str, Any] = data.get("account") if isinstance(data.get("account"), dict) else {}
            return {
                "key": {"usage": key.get("usage"), "limit": key.get("limit")},
                "account": {
                    "current_plan": account.get("current_plan"),
                    "plan_usage": account.get("plan_usage"),
                    "plan_limit": account.get("plan_limit"),
                },
            }
        except (httpx.TimeoutException, httpx.TransportError):
            return {}

    # ------------------------------------------------------------------
    # 公共辅助
    # ------------------------------------------------------------------

    _name: str = "tavily"

    def close(self) -> None:
        """关闭底层 httpx.Client，释放连接池。"""
        self._client.close()

    def _auth_headers(self, json_content: bool) -> dict[str, str]:
        """Bearer 鉴权头；POST（JSON 请求体）时附带 Content-Type。"""
        headers = {"Authorization": f"Bearer {self._api_key}"}
        if json_content:
            headers["Content-Type"] = "application/json"
        return headers

    @staticmethod
    def _safe_json(response: httpx.Response) -> Any:
        """尽力解析响应 JSON；不是合法 JSON 时返回 None（由调用方兜底）。"""
        try:
            return response.json()
        except ValueError:
            return None
