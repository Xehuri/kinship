"""tests.test_tavily_errors —— TavilyProvider 的错误映射 / 请求构造 / 响应归一化测试。

全部用 httpx.MockTransport 注入响应，绝不发起真实网络请求。
验证要点：
- 错误映射只按 HTTP status（Tavily 官方明令勿匹配错误文本）；
- 异常必须带 provider="tavily" 与 status 码，且绝不泄露 api_key 明文；
- 请求体白名单：None 参数剔除、include_usage 恒 true、Bearer 头正确；
- deadline 预算耗尽时不发请求，直接 TransientError；
- published_date 的 RFC1123 -> ISO "YYYY-MM-DD" 防御解析，畸形/null 置 None 不抛。
"""

import json
import time
from typing import Any, Callable

import httpx
import pytest

from providers.base import (
    BadRequestError,
    ErrorKind,
    InvalidKeyError,
    NormalizedParams,
    ProviderResponse,
    QuotaExhaustedError,
    RateLimitedError,
    TransientError,
)
from providers.tavily import TavilyProvider

API_KEY = "tvly-FAKE-TEST-KEY-1234567890"

Handler = Callable[[httpx.Request], httpx.Response]


def make_provider(handler: Handler) -> tuple[TavilyProvider, list[httpx.Request]]:
    """构造注入 MockTransport 的 provider；captured 记录实际发出的请求。"""
    captured: list[httpx.Request] = []

    def _recording(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return handler(request)

    provider = TavilyProvider(api_key=API_KEY, transport=httpx.MockTransport(_recording))
    return provider, captured


def respond(status: int, payload: Any = None, headers: dict[str, str] | None = None) -> Handler:
    """返回一个固定响应 handler（payload=None 时给空 JSON 对象兜底）。"""
    def _handler(_request: httpx.Request) -> httpx.Response:
        if payload is None:
            return httpx.Response(status, content=b"{}", headers=headers)
        return httpx.Response(status, json=payload, headers=headers)
    return _handler


def run_search(provider: TavilyProvider, params: NormalizedParams | None = None) -> ProviderResponse:
    """以宽裕 deadline（30 秒后）执行一次搜索，供错误映射用例共用。"""
    return provider.search(params or NormalizedParams(query="openai"), time.monotonic() + 30.0)


SAMPLE_OK: dict[str, Any] = {
    "model_request_id": "fake-id",
    "query": "openai",
    "answer": "OpenAI 是一家 AI 研究与部署公司。",
    "results": [
        {
            "title": "OpenAI",
            "url": "https://openai.com/",
            "content": "OpenAI 致力于确保通用人工智能惠及全人类。",
            "score": 0.87,
            "published_date": "Tue, 11 Mar 2025 17:00:00 GMT",
        }
    ],
    "response_time": 0.42,
    "usage": {"credits": 1},
}


# ---------------------------------------------------------------------------
# 1) 200 正常：归一化 schema
# ---------------------------------------------------------------------------


def test_search_success_normalizes_result_schema() -> None:
    """成功响应逐字段归一化：title/url/content/score(float)/published_date(ISO)。"""
    provider, _ = make_provider(respond(200, SAMPLE_OK))
    resp = run_search(provider)

    assert isinstance(resp, ProviderResponse)
    assert resp.answer == SAMPLE_OK["answer"]
    assert resp.cost_usd is None  # Tavily 计 credits 非美元
    assert len(resp.results) == 1
    item = resp.results[0]
    assert set(item) == {"title", "url", "content", "score", "published_date"}
    assert item["title"] == "OpenAI"
    assert item["url"] == "https://openai.com/"
    assert item["content"].startswith("OpenAI")
    assert item["score"] == pytest.approx(0.87)
    assert item["published_date"] == "2025-03-11"  # RFC1123 -> ISO 日期


def test_search_missing_answer_is_none() -> None:
    """answer 字段缺失时防御式返回 None，不抛 KeyError。"""
    payload = {"results": []}
    provider, _ = make_provider(respond(200, payload))
    resp = run_search(provider)
    assert resp.answer is None
    assert resp.results == []


@pytest.mark.parametrize("raw", [None, "", "not-a-date", "11/03/2025", "Tue, 99 Xyz 2025"])
def test_published_date_defensive_never_raises(raw: Any) -> None:
    """published_date 为 null/空串/畸形格式时置 None，绝不抛异常。"""
    payload = {"results": [{"title": "t", "url": "u", "content": "c", "score": 0.5, "published_date": raw}]}
    provider, _ = make_provider(respond(200, payload))
    resp = run_search(provider)
    assert resp.results[0]["published_date"] is None


@pytest.mark.parametrize("raw, expected", [(7, 7.0), (None, None), ("0.5", 0.5), ("abc", None), (True, None)])
def test_score_normalized_to_float_or_none(raw: Any, expected: Any) -> None:
    """score 归一化为 float 或 None：int/数字字符串转 float，bool/非数字置 None。"""
    payload = {"results": [{"title": "t", "url": "u", "content": "c", "published_date": None, "score": raw}]}
    provider, _ = make_provider(respond(200, payload))
    resp = run_search(provider)
    assert resp.results[0]["score"] == expected


def test_search_skips_non_dict_items() -> None:
    """results 数组中的非 dict 项被跳过，dict 项正常归一化。"""
    payload = {"results": [{"title": "ok", "url": "u"}, 42, "junk"]}
    provider, _ = make_provider(respond(200, payload))
    resp = run_search(provider)
    assert len(resp.results) == 1
    assert resp.results[0]["title"] == "ok"


# ---------------------------------------------------------------------------
# 顶层 results 键缺失 / 非法响应 = 提供商故障
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("payload", [{"answer": "x"}, {"results": "oops"}, []])
def test_abnormal_success_body_is_transient(payload: Any) -> None:
    """200 但缺 results 键 / results 非数组 / 顶层非对象 -> TransientError（异常响应=提供商故障）。"""
    provider, _ = make_provider(respond(200, payload))
    with pytest.raises(TransientError) as ei:
        run_search(provider)
    assert ei.value.provider == "tavily"
    assert ei.value.status == 200


def test_non_json_success_body_is_transient() -> None:
    """200 但响应体不是 JSON -> TransientError，绝不抛 json 解析异常。"""
    provider, _ = make_provider(lambda r: httpx.Response(200, text="<html>not json</html>"))
    with pytest.raises(TransientError):
        run_search(provider)


# ---------------------------------------------------------------------------
# 2) 错误映射：只按 HTTP status
# ---------------------------------------------------------------------------


def test_401_maps_to_invalid_key_without_leaking_secret() -> None:
    """401 -> InvalidKeyError；kind/status/provider 齐备；异常文本不含 api_key 明文。"""
    provider, _ = make_provider(respond(401, {"detail": {"error": "Unauthorized"}}))
    with pytest.raises(InvalidKeyError) as ei:
        run_search(provider)
    err = ei.value
    assert err.provider == "tavily"
    assert err.status == 401
    assert err.kind is ErrorKind.INVALID_KEY
    assert API_KEY not in str(err)


def test_429_with_retry_after_header() -> None:
    """429 + Retry-After:3 -> RateLimitedError 且 retry_after_s == 3.0。"""
    provider, _ = make_provider(respond(429, {"detail": {"error": "Too Many Requests"}}, headers={"Retry-After": "3"}))
    with pytest.raises(RateLimitedError) as ei:
        run_search(provider)
    assert ei.value.retry_after_s == pytest.approx(3.0)
    assert ei.value.status == 429
    assert ei.value.kind is ErrorKind.RATE_LIMITED


@pytest.mark.parametrize("header", [None, "abc", "Wed, 21 Oct 2025 07:28:00 GMT", "-5"])
def test_429_retry_after_invalid_or_missing_is_none(header: str | None) -> None:
    """Retry-After 缺失/非法（非数字秒）-> retry_after_s 为 None；合法负数也拒绝。"""
    headers = {"Retry-After": header} if header is not None else None
    provider, _ = make_provider(respond(429, {"detail": {"error": "rate limited"}}, headers=headers))
    with pytest.raises(RateLimitedError) as ei:
        run_search(provider)
    assert ei.value.retry_after_s is None


@pytest.mark.parametrize("status", [432, 433, 403])
def test_quota_statuses_map_to_quota_exhausted(status: int) -> None:
    """432/433/403 -> QuotaExhaustedError（额度耗尽，切换信号），且绝不是 InvalidKeyError。"""
    payload = {"detail": {"error": "This request exceeds your plan's set usage limit. "
                                   "Please upgrade your plan or contact support@tavily.com"}}
    provider, _ = make_provider(respond(status, payload))
    with pytest.raises(QuotaExhaustedError) as ei:
        run_search(provider)
    err = ei.value
    assert err.provider == "tavily"
    assert err.status == status
    assert err.kind is ErrorKind.QUOTA_EXHAUSTED
    assert "exceeds your plan" in err.detail
    assert not isinstance(err, InvalidKeyError)
    assert API_KEY not in str(err)


def test_400_extracts_detail_dict_error_text() -> None:
    """400 的 detail 形如 {"error": str} -> BadRequestError，detail 文本提取正确。"""
    payload = {"detail": {"error": "Topic must be one of: general, news, finance"}}
    provider, _ = make_provider(respond(400, payload))
    with pytest.raises(BadRequestError) as ei:
        run_search(provider)
    assert ei.value.detail == "Topic must be one of: general, news, finance"
    assert ei.value.status == 400
    assert ei.value.kind is ErrorKind.BAD_REQUEST


def test_400_is_never_quota_exhausted() -> None:
    """400 场景显式断言不是 QuotaExhaustedError（防误冷却）。"""
    provider, _ = make_provider(respond(400, {"detail": {"error": "bad field"}}))
    with pytest.raises(BadRequestError) as ei:
        run_search(provider)
    assert not isinstance(ei.value, QuotaExhaustedError)


def test_422_array_detail_joins_messages() -> None:
    """422 的 detail 是数组（每项含 msg）-> 逐项拼接，BadRequestError 不崩。"""
    payload = {
        "detail": [
            {"loc": ["body", "query"], "msg": "field required", "type": "value_error"},
            {"loc": ["body", "max_results"], "msg": "ensure this value is at least 1"},
        ]
    }
    provider, _ = make_provider(respond(422, payload))
    with pytest.raises(BadRequestError) as ei:
        run_search(provider)
    assert "field required" in ei.value.detail
    assert "ensure this value is at least 1" in ei.value.detail
    assert ei.value.status == 422


@pytest.mark.parametrize("status", [400, 422])
def test_bad_request_detail_fallback_to_status_text(status: int) -> None:
    """detail 缺失/结构异常时用状态码兜底文本，不抛。"""
    provider, _ = make_provider(respond(status, {"something": "else"}))
    with pytest.raises(BadRequestError) as ei:
        run_search(provider)
    assert str(status) in ei.value.detail


@pytest.mark.parametrize("status", [500, 502, 503, 499, 418])
def test_server_and_unknown_statuses_are_transient(status: int) -> None:
    """>=500 与任何未知状态码（499/418）保守归为 TransientError，绝不误冷却。"""
    provider, _ = make_provider(respond(status, {"detail": {"error": "internal"}}))
    with pytest.raises(TransientError) as ei:
        run_search(provider)
    assert ei.value.status == status
    assert ei.value.provider == "tavily"
    assert not isinstance(ei.value, QuotaExhaustedError)


# ---------------------------------------------------------------------------
# 3) httpx 网络层异常 -> TransientError
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("exc", [httpx.ConnectTimeout("dial"), httpx.ReadTimeout("slow"), httpx.ConnectError("refused")])
def test_network_layer_exceptions_map_to_transient(exc: Exception) -> None:
    """httpx 超时/传输异常 -> TransientError（provider=tavily），原始异常不外泄。"""
    def _raise(_request: httpx.Request) -> httpx.Response:
        raise exc

    provider, _ = make_provider(_raise)
    with pytest.raises(TransientError) as ei:
        run_search(provider)
    assert ei.value.provider == "tavily"
    assert ei.value.status is None


# ---------------------------------------------------------------------------
# 4) 请求体白名单 + 鉴权头
# ---------------------------------------------------------------------------


def test_request_body_default_whitelist_and_headers() -> None:
    """默认参数：请求体恰为 {query,max_results,search_depth,include_usage}；include_usage 恒 true；Bearer 头正确。"""
    provider, captured = make_provider(respond(200, {"results": []}))
    run_search(provider, NormalizedParams(query="hello world"))

    assert len(captured) == 1
    request = captured[0]
    assert request.method == "POST"
    assert str(request.url) == "https://api.tavily.com/search"
    assert request.headers["Authorization"] == f"Bearer {API_KEY}"
    assert request.headers["Content-Type"] == "application/json"
    body = json.loads(request.content)
    assert set(body) == {"query", "max_results", "search_depth", "include_usage"}
    assert body["query"] == "hello world"
    assert body["max_results"] == 5
    assert body["search_depth"] == "basic"
    assert body["include_usage"] is True


def test_request_body_full_params_and_none_dropped() -> None:
    """全参数：topic/time_range/include_answer/include_raw_content 按入参携带；None 参数一律剔除。"""
    provider, captured = make_provider(respond(200, {"results": []}))
    params = NormalizedParams(
        query="q",
        max_results=8,
        depth="advanced",
        topic="news",
        time_range="week",
        include_content=True,
        include_answer=True,
    )
    run_search(provider, params)
    body = json.loads(captured[0].content)
    assert set(body) == {
        "query", "max_results", "search_depth", "topic", "time_range",
        "include_answer", "include_raw_content", "include_usage",
    }
    assert body["search_depth"] == "advanced"
    assert body["topic"] == "news"
    assert body["time_range"] == "week"
    assert body["include_answer"] is True
    assert body["include_raw_content"] is True
    assert body["include_usage"] is True


def test_request_body_has_no_non_whitelist_keys() -> None:
    """白名单外键（include_images/country 等）绝不出现在请求体。"""
    provider, captured = make_provider(respond(200, {"results": []}))
    run_search(provider)
    body = json.loads(captured[0].content)
    forbidden = {"include_images", "include_domains", "exclude_domains", "country", "chunks_per_source"}
    assert forbidden.isdisjoint(body.keys())


# ---------------------------------------------------------------------------
# 5) deadline 预算
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("offset", [-1.0, 0.0])
def test_deadline_exhausted_skips_request(offset: float) -> None:
    """预算 <= 0 时不发请求（handler 记录断言未被调用），直接 TransientError('请求时间预算耗尽')。"""
    provider, captured = make_provider(respond(200, {"results": []}))
    with pytest.raises(TransientError) as ei:
        provider.search(NormalizedParams(query="q"), time.monotonic() + offset)
    assert "预算" in ei.value.detail
    assert ei.value.provider == "tavily"
    assert captured == []  # mock handler 未被调用


def test_close_releases_client() -> None:
    """close() 关闭底层 httpx.Client，可安全重复调用场景之外的正常路径。"""
    provider, _ = make_provider(respond(200, {"results": []}))
    provider.close()  # 不应抛


# ---------------------------------------------------------------------------
# 6) usage()
# ---------------------------------------------------------------------------


def test_usage_ok_returns_defensive_snapshot() -> None:
    """usage 200 -> key/account 快照（全 .get 链），GET 请求带 Bearer 头。"""
    payload = {
        "key": {"usage": 3, "limit": 1000},
        "account": {"current_plan": "basic", "plan_usage": 3, "plan_limit": 1000},
    }
    provider, captured = make_provider(respond(200, payload))
    result = provider.usage()

    assert captured[0].method == "GET"
    assert str(captured[0].url) == "https://api.tavily.com/usage"
    assert captured[0].headers["Authorization"] == f"Bearer {API_KEY}"
    assert set(result) == {"key", "account"}
    assert set(result["key"]) == {"usage", "limit"}
    assert result["key"] == {"usage": 3, "limit": 1000}
    assert set(result["account"]) == {"current_plan", "plan_usage", "plan_limit"}
    assert result["account"]["current_plan"] == "basic"
    assert result["account"]["plan_limit"] == 1000


def test_usage_partial_payload_fills_none() -> None:
    """usage 响应字段缺失时防御式补 None，不抛。"""
    provider, _ = make_provider(respond(200, {"key": {"usage": 5}}))
    result = provider.usage()
    assert result["key"] == {"usage": 5, "limit": None}
    assert result["account"] == {"current_plan": None, "plan_usage": None, "plan_limit": None}


@pytest.mark.parametrize("status", [401, 432, 500])
def test_usage_non_200_returns_empty_never_raises(status: int) -> None:
    """usage 非 200 -> 返回 {}（供 provider_status 容错），绝不抛。"""
    provider, _ = make_provider(respond(status, {"detail": {"error": "nope"}}))
    assert provider.usage() == {}


def test_usage_network_error_returns_empty() -> None:
    """usage 遇网络异常 -> {} 不抛。"""
    def _raise(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    provider, _ = make_provider(_raise)
    assert provider.usage() == {}
