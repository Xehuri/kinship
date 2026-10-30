"""providers.exa —— Exa（exa.ai）神经搜索提供商适配器。

契约见 providers/base.py：只抛 ProviderError 子类，绝不外泄裸异常；
全同步（httpx.Client），transport 参数仅供测试注入 httpx.MockTransport。

Exa 事实要点（2026-10）：
- 免费档 $10/月，每月 1 日重置；团队级 10 QPS 限流；503 SERVICE_OVERLOADED 不计费；
- /search 响应 results[] 没有分数字段 —— score 恒为 None，严禁拿排名位置造假；
- 错误信封为 {"requestId", "error", "tag"}，解析全走 .get 防御式访问；
- 无公开用量端点：cost_usd 从每次响应 costDollars.total 读出，由 router 本地记账
  （CooldownStore.add_exa_cost，$10/月预算预热）。

请求体翻译对齐官方 MCP web_search_exa 行为；deprecated 字段（includeText/
excludeText/startCrawlDate/endCrawlDate 及 type=keyword|neural）一律禁发。
"""

import json
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import httpx

from .base import (
    BadRequestError,
    InvalidKeyError,
    NormalizedParams,
    ProviderError,
    ProviderResponse,
    QuotaExhaustedError,
    RateLimitedError,
    TransientError,
)

_EXA_SEARCH_URL = "https://api.exa.ai/search"
_PROVIDER_NAME = "exa"

# time_range → 往前回退的天数（startPublishedDate = 当前 UTC 日期 - N 天）
_TIME_RANGE_DAYS: dict[str, int] = {
    "day": 1,
    "week": 7,
    "month": 30,
    "year": 365,
}

# 403 中唯一按额度类处理的 tag（其余 403 tag 视为查询自身问题）
_FEATURE_DISABLED_TAG = "FEATURE_DISABLED"

# include_content=True 时请求的正文最大字符数（对齐官方 MCP 默认）
_MAX_TEXT_CHARS = 8000


class ExaProvider:
    """Exa /search 端点的 provider 实现（满足 providers/base.py 协议）。"""

    def __init__(
        self,
        api_key: str,
        timeout_s: float = 30.0,
        transport: Optional[httpx.BaseTransport] = None,
    ) -> None:
        # transport 仅测试注入 httpx.MockTransport 用，生产默认 None（真实网络）
        self._api_key = api_key
        self.timeout_s = timeout_s
        self._client = httpx.Client(timeout=timeout_s, transport=transport)

    def close(self) -> None:
        """释放底层连接池（router 关停时调用）。"""
        self._client.close()

    # ------------------------------------------------------------ 公共接口

    def search(self, params: NormalizedParams, deadline_mono: float) -> ProviderResponse:
        """执行一次 Exa 搜索；deadline_mono 为 time.monotonic() 截止时刻。

        预算 ≤0 时先抛 TransientError，绝不发出请求；
        单次请求 timeout 取 min(配置值, 剩余预算)，网络层异常一律 TransientError。
        """
        remaining = deadline_mono - time.monotonic()
        if remaining <= 0:
            raise TransientError(_PROVIDER_NAME, "请求时间预算耗尽")

        headers = {
            "x-api-key": self._api_key,  # Exa 用 x-api-key，不用 Authorization Bearer
            "Content-Type": "application/json",
        }
        try:
            response = self._client.post(
                _EXA_SEARCH_URL,
                json=self._build_body(params),
                headers=headers,
                timeout=min(self.timeout_s, remaining),
            )
        except httpx.TimeoutException as exc:
            raise TransientError(_PROVIDER_NAME, f"请求超时：{exc!r}") from exc
        except httpx.HTTPError as exc:
            raise TransientError(_PROVIDER_NAME, f"网络层错误：{exc!r}") from exc

        if response.status_code != 200:
            raise self._map_error(response)
        return self._parse_success(response, params)

    def usage(self) -> dict:
        """Exa 无公开用量端点：返回空 dict。

        实际花费由 router 用每次 search 返回的 cost_usd 做本地记账
        （CooldownStore.add_exa_cost，月度 $10 预算预热），本方法绝不抛异常。
        """
        return {}

    # ------------------------------------------------------------ 请求体翻译

    def _build_body(self, params: NormalizedParams) -> dict[str, Any]:
        """NormalizedParams → Exa /search 请求体（None/不适用字段一律剔除）。"""
        body: dict[str, Any] = {
            "query": params.query,
            "numResults": params.max_results,
            # advanced → "deep"；其余一律 "auto"（deprecated 的 keyword/neural 禁发）
            "type": "deep" if params.depth == "advanced" else "auto",
            "contents": self._build_contents(params),
        }
        if params.topic == "news":
            # general / finance 在 Exa 无对应 category，按契约省略该字段
            body["category"] = "news"
        if params.time_range is not None:
            days = _TIME_RANGE_DAYS.get(params.time_range)
            if days is not None:
                start = (self._utc_now() - timedelta(days=days)).strftime("%Y-%m-%d")
                # 只传 startPublishedDate，不传 endPublishedDate
                body["startPublishedDate"] = start
        return body

    @staticmethod
    def _build_contents(params: NormalizedParams) -> dict[str, Any]:
        """contents 组装：对齐官方 MCP web_search_exa 的默认行为。"""
        contents: dict[str, Any] = {}
        if params.include_content:
            contents["text"] = {"maxCharacters": _MAX_TEXT_CHARS}
        contents["highlights"] = True
        if params.include_answer:
            contents["summary"] = {"query": params.query}
        return contents

    def _utc_now(self) -> datetime:
        """日期接缝（可注入）：测试 monkeypatch 本方法冻结 UTC 时钟。"""
        return datetime.now(timezone.utc)

    # ------------------------------------------------------------ 错误映射

    def _map_error(self, response: httpx.Response) -> ProviderError:
        """status + 错误信封 tag → ProviderError 子类实例（由调用方 raise）。

        Exa 错误体 {"requestId","error","tag"}：全 .get 防御，信封缺失不致命。
        """
        status = response.status_code
        tag, error_text = self._read_envelope(response)
        detail = self._format_detail(status, tag, error_text)

        if status == 401:
            return InvalidKeyError(_PROVIDER_NAME, detail, status=status)
        if status == 402:
            # 无论 tag（含未知 tag）一律额度类：冷却至月初重置，detail 保留 tag 文本
            return QuotaExhaustedError(_PROVIDER_NAME, detail, status=status)
        if status == 403:
            if tag == _FEATURE_DISABLED_TAG:
                return QuotaExhaustedError(_PROVIDER_NAME, detail, status=status)
            # PROHIBITED_CONTENT / CONTENT_FILTER_ERROR / 其他：查询自身问题，不冷却不切换
            return BadRequestError(_PROVIDER_NAME, detail, status=status)
        if status == 429:
            retry_after = self._parse_retry_after(response.headers.get("Retry-After"))
            if response.headers.get("x-exa-queued") == "true":
                # 软信号：请求被排队，仅注记进 detail，不改变 RATE_LIMITED 分类
                detail = f"{detail}（x-exa-queued=true：请求已排队）"
            return RateLimitedError(
                _PROVIDER_NAME, detail, status=status, retry_after_s=retry_after
            )
        if status == 400:
            return BadRequestError(_PROVIDER_NAME, detail, status=status)
        # 500/502/503/504（503=SERVICE_OVERLOADED 官方明确不计费）及未知状态码兜底
        return TransientError(_PROVIDER_NAME, detail, status=status)

    @staticmethod
    def _read_envelope(response: httpx.Response) -> tuple[Optional[str], Optional[str]]:
        """防御式读取错误信封 (tag, error)：非法 JSON/非对象/缺键一律归 None。"""
        try:
            data = response.json()
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None, None
        if not isinstance(data, dict):
            return None, None
        tag = data.get("tag")
        error_text = data.get("error")
        return (
            tag if isinstance(tag, str) else None,
            error_text if isinstance(error_text, str) else None,
        )

    @staticmethod
    def _format_detail(status: int, tag: Optional[str], error_text: Optional[str]) -> str:
        """detail 规范："TAG: error 文本"；缺失部分降级省略，绝不含 api_key 明文。"""
        if tag and error_text:
            return f"{tag}: {error_text}"
        return tag or error_text or f"HTTP {status}"

    @staticmethod
    def _parse_retry_after(header_value: Optional[str]) -> Optional[float]:
        """Retry-After 头 → 秒数；Exa 不保证该头存在，缺失/非法一律 None。"""
        if header_value is None:
            return None
        try:
            return float(header_value)
        except ValueError:
            return None

    # ------------------------------------------------------------ 成功解析

    def _parse_success(self, response: httpx.Response, params: NormalizedParams) -> ProviderResponse:
        """200 响应 → ProviderResponse（results 归一化 dict 列表）。"""
        try:
            data = response.json()
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise TransientError(_PROVIDER_NAME, f"响应不是合法 JSON：{exc.msg}") from exc
        if not isinstance(data, dict):
            raise TransientError(_PROVIDER_NAME, "响应顶层不是 JSON 对象")

        raw_results = data.get("results")
        if not isinstance(raw_results, list):
            raise TransientError(_PROVIDER_NAME, "响应缺少 results 列表")

        items = [item for item in raw_results if isinstance(item, dict)]
        return ProviderResponse(
            results=[self._normalize_result(item) for item in items],
            answer=self._extract_answer(items, params),
            cost_usd=self._extract_cost(data),
        )

    @staticmethod
    def _normalize_result(item: dict[str, Any]) -> dict[str, Any]:
        """单条结果归一化：{"title","url","content","score","published_date"}。"""
        return {
            "title": item.get("title") if isinstance(item.get("title"), str) else None,
            "url": item.get("url") if isinstance(item.get("url"), str) else None,
            # content 取值链：text（请求了才有）→ highlights[0] → summary → None
            "content": ExaProvider._pick_content(item),
            # Exa /search 响应没有分数字段：score 恒 None，严禁用排名位置造假
            "score": None,
            "published_date": (
                item.get("publishedDate")
                if isinstance(item.get("publishedDate"), str)
                else None
            ),
        }

    @staticmethod
    def _pick_content(item: dict[str, Any]) -> Optional[str]:
        """按 text → highlights[0] → summary 的优先链取正文，缺失跳过空值。"""

        def _nonempty_str(value: object) -> Optional[str]:
            return value if isinstance(value, str) and value else None

        text = _nonempty_str(item.get("text"))
        if text is not None:
            return text
        highlights = item.get("highlights")
        if isinstance(highlights, list) and highlights:
            first = _nonempty_str(highlights[0])
            if first is not None:
                return first
        return _nonempty_str(item.get("summary"))

    @staticmethod
    def _extract_answer(items: list[dict[str, Any]], params: NormalizedParams) -> Optional[str]:
        """include_answer 时取首条结果的 summary 作为 answer，否则 None。"""
        if not params.include_answer or not items:
            return None
        summary = items[0].get("summary")
        return summary if isinstance(summary, str) and summary else None

    @staticmethod
    def _extract_cost(data: dict[str, Any]) -> Optional[float]:
        """costDollars.total → float|None（router 月度预算记账的唯一来源）。"""
        cost_dollars = data.get("costDollars")
        if not isinstance(cost_dollars, dict):
            return None
        total = cost_dollars.get("total")
        if isinstance(total, bool) or not isinstance(total, (int, float)):
            return None
        return float(total)
