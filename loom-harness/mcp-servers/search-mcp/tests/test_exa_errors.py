"""tests.test_exa_errors —— ExaProvider 错误映射与请求体翻译测试。

全部使用 httpx.MockTransport，绝不真实联网。日期时钟注入依赖
ExaProvider._utc_now 接缝（与 cooldown.py 的时间可注入惯例同款）。
"""

import json
import time
from datetime import datetime, timezone

import httpx
import pytest

from providers.base import (
    BadRequestError,
    InvalidKeyError,
    NormalizedParams,
    ProviderError,
    QuotaExhaustedError,
    RateLimitedError,
    TransientError,
)
from providers.exa import ExaProvider

API_KEY = "exa-test-key-abc123"

# 最小合法成功响应（results 存在、含 costDollars.total）
MINIMAL_OK = {
    "results": [{"title": "t", "url": "https://e.com/1"}],
    "costDollars": {"total": 0.001},
}

# 固定时钟：2026-03-05 08:00 UTC（2026 非闰年，2 月 28 天）
FIXED_UTC = datetime(2026, 3, 5, 8, 0, 0, tzinfo=timezone.utc)


def make_provider(handler, recorded=None):
    """构造注入 MockTransport 的 ExaProvider；recorded 列表收集请求体。"""

    def _handler(request: httpx.Request) -> httpx.Response:
        if recorded is not None:
            recorded.append(request)
        return handler(request)

    return ExaProvider(api_key=API_KEY, timeout_s=30.0, transport=httpx.MockTransport(_handler))


def search_once(handler, params=None, deadline_ahead=30.0, recorded=None):
    """一次 search 调用，返回 (provider, response)；异常直接向上冒泡给断言。"""
    provider = make_provider(handler, recorded)
    try:
        return provider, provider.search(
            params or NormalizedParams(query="q"), time.monotonic() + deadline_ahead
        )
    finally:
        provider.close()


def resp(payload, status=200, headers=None):
    return httpx.Response(status, json=payload, headers=headers)


def envelope(tag, error="some error"):
    """Exa 错误信封：{"requestId","error","tag"}。"""
    return {"requestId": "req-1", "error": error, "tag": tag}


# ---------------------------------------------------------------- 成功解析


def test_search_200_normalizes_results_and_cost():
    """200：title/url/content 归一化、score 恒 None、cost_usd 读 costDollars.total。"""
    payload = {
        "results": [
            {
                "title": "OpenAI 发布新模型",
                "url": "https://exa.ai/a",
                "text": "正文全文内容",
                "publishedDate": "2026-03-01",
            }
        ],
        "costDollars": {"search": 0.004, "total": 0.004},
    }
    _, out = search_once(lambda r: resp(payload))
    assert out.results == [
        {
            "title": "OpenAI 发布新模型",
            "url": "https://exa.ai/a",
            "content": "正文全文内容",
            "score": None,  # Exa /search 无分数字段，严禁用排名造假
            "published_date": "2026-03-01",
        }
    ]
    assert out.cost_usd == pytest.approx(0.004)
    assert out.answer is None


@pytest.mark.parametrize(
    "item, expected",
    [
        # 取值链：text → highlights[0] → summary → None
        ({"text": "T", "highlights": ["H"], "summary": "S"}, "T"),
        ({"highlights": ["H1", "H2"], "summary": "S"}, "H1"),
        ({"summary": "S"}, "S"),
        ({"url": "https://e.com/x"}, None),
    ],
)
def test_content_fallback_chain(item, expected):
    """content 取值链三态（外加多 highlights 只取首条）。"""
    _, out = search_once(lambda r: resp({"results": [item]}))
    assert out.results[0]["content"] == expected
    assert out.results[0]["score"] is None


def test_answer_reads_first_summary_when_include_answer():
    """include_answer=True 时 answer 取首条结果的 summary。"""
    payload = {"results": [{"title": "a", "summary": "总结答案"}, {"summary": "第二条"}]}
    _, out = search_once(
        lambda r: resp(payload),
        params=NormalizedParams(query="q", include_answer=True),
    )
    assert out.answer == "总结答案"


def test_missing_results_field_is_transient():
    """响应里没有 results 字段 → TransientError。"""
    with pytest.raises(TransientError):
        search_once(lambda r: resp({"costDollars": {"total": 0.1}}))


def test_non_json_body_is_transient():
    """200 但响应不是合法 JSON → TransientError，不得抛裸异常。"""
    with pytest.raises(TransientError):
        search_once(lambda r: httpx.Response(200, text="not json"))


# ---------------------------------------------------------------- 错误映射


def test_401_maps_invalid_key_and_never_leaks_api_key():
    with pytest.raises(InvalidKeyError) as ei:
        search_once(lambda r: resp(envelope("INVALID_API_KEY"), status=401))
    assert ei.value.provider == "exa"
    assert ei.value.status == 401
    # 异常文本绝不包含 api_key 明文
    assert API_KEY not in str(ei.value)


@pytest.mark.parametrize(
    "tag", ["NO_MORE_CREDITS", "API_KEY_BUDGET_EXCEEDED", "TEAM_BUDGET_EXCEEDED"]
)
def test_402_known_quota_tags_all_map_quota_exhausted(tag):
    with pytest.raises(QuotaExhaustedError) as ei:
        search_once(lambda r: resp(envelope(tag, "credits used up"), status=402))
    assert tag in ei.value.detail
    assert "credits used up" in ei.value.detail
    assert ei.value.provider == "exa"


def test_402_unknown_tag_still_quota_exhausted():
    """402 无论 tag 是什么（含未知 tag / 无信封）一律额度类。"""
    with pytest.raises(QuotaExhaustedError):
        search_once(lambda r: resp(envelope("SOMETHING_NEW"), status=402))
    with pytest.raises(QuotaExhaustedError):
        search_once(lambda r: httpx.Response(402, text=""))


def test_403_feature_disabled_maps_quota_exhausted():
    with pytest.raises(QuotaExhaustedError) as ei:
        search_once(lambda r: resp(envelope("FEATURE_DISABLED"), status=403))
    assert "FEATURE_DISABLED" in ei.value.detail


@pytest.mark.parametrize("tag", ["PROHIBITED_CONTENT", "CONTENT_FILTER_ERROR", "UNKNOWN_403"])
def test_403_other_tags_map_bad_request_not_quota(tag):
    """403 非 FEATURE_DISABLED：查询自身问题，BadRequestError（不冷却不切换）。"""
    with pytest.raises(BadRequestError) as ei:
        search_once(lambda r: resp(envelope(tag), status=403))
    assert type(ei.value) is BadRequestError  # 显式区分：不得是额度类
    assert not isinstance(ei.value, QuotaExhaustedError)


def test_429_with_retry_after_header():
    with pytest.raises(RateLimitedError) as ei:
        search_once(
            lambda r: resp(envelope("RATE_LIMITED"), status=429, headers={"Retry-After": "17"}),
        )
    assert ei.value.retry_after_s == pytest.approx(17.0)


def test_429_without_retry_after_header_is_none():
    """Exa 不保证有 Retry-After：缺失时 retry_after_s 必须为 None。"""
    with pytest.raises(RateLimitedError) as ei:
        search_once(lambda r: resp(envelope("RATE_LIMITED"), status=429))
    assert ei.value.retry_after_s is None


def test_429_queued_header_appends_soft_signal_note():
    """x-exa-queued=true 时在 detail 追加软限流注记。"""
    with pytest.raises(RateLimitedError) as ei:
        search_once(
            lambda r: resp(
                envelope("QUEUED"), status=429, headers={"x-exa-queued": "true"}
            )
        )
    assert "x-exa-queued" in ei.value.detail


def test_429_malformed_retry_after_is_none():
    with pytest.raises(RateLimitedError) as ei:
        search_once(
            lambda r: resp(envelope("RATE_LIMITED"), status=429, headers={"Retry-After": "abc"})
        )
    assert ei.value.retry_after_s is None


def test_400_bad_request_carries_tag():
    with pytest.raises(BadRequestError) as ei:
        search_once(lambda r: resp(envelope("INVALID_NUM_RESULTS"), status=400))
    assert "INVALID_NUM_RESULTS" in ei.value.detail
    assert ei.value.status == 400


@pytest.mark.parametrize("status", [500, 502, 503, 504])
def test_5xx_maps_transient(status):
    """503=SERVICE_OVERLOADED 官方明确不计费，与其余 5xx 一样可重试。"""
    with pytest.raises(TransientError) as ei:
        search_once(lambda r: resp(envelope("SERVICE_OVERLOADED"), status=status))
    assert ei.value.status == status
    assert ei.value.provider == "exa"


def test_unknown_status_code_maps_transient():
    """未知状态码（418）兜底 TransientError，绝不静默或裸异常。"""
    with pytest.raises(TransientError):
        search_once(lambda r: resp(envelope("TEAPOT"), status=418))


@pytest.mark.parametrize(
    "exc", [httpx.ConnectError("connection refused"), httpx.ReadTimeout("read timed out")]
)
def test_network_layer_httpx_errors_map_transient(exc):
    """网络层 httpx 异常一律 TransientError（provider=exa，不泄露底层裸异常）。"""

    def _raise(_request):
        raise exc

    with pytest.raises(TransientError) as ei:
        search_once(_raise)
    assert ei.value.provider == "exa"
    assert isinstance(ei.value, ProviderError)


# ---------------------------------------------------------------- 请求体翻译


def body_of(params, recorded):
    """执行一次成功 search，返回捕获的请求体 dict。"""
    provider = make_provider(lambda r: resp(MINIMAL_OK), recorded)
    provider.search(params, time.monotonic() + 30.0)
    provider.close()
    return json.loads(recorded[-1].content)


@pytest.mark.parametrize(
    "depth, expected_type",
    [("advanced", "deep"), ("basic", "auto"), (None, "auto")],
)
def test_depth_maps_type_advanced_deep_otherwise_auto(depth, expected_type):
    """type 只允许 auto|deep：deprecated 的 keyword/neural 绝不外发。"""
    recorded = []
    kw = {} if depth is None else {"depth": depth}
    body = body_of(NormalizedParams(query="q", **kw), recorded)
    assert body["type"] == expected_type


@pytest.mark.parametrize(
    "topic, expected",
    [("news", "news"), ("general", None), ("finance", None), (None, None)],
)
def test_topic_news_becomes_category_others_omitted(topic, expected):
    body = body_of(NormalizedParams(query="q", topic=topic), [])
    if expected is None:
        assert "category" not in body
    else:
        assert body["category"] == expected


@pytest.mark.parametrize(
    "time_range, expected_date",
    [
        # 固定时钟 2026-03-05 UTC：day=1/week=7/month=30/year=365 天
        ("day", "2026-03-04"),
        ("week", "2026-02-26"),
        ("month", "2026-02-03"),
        ("year", "2025-03-05"),
    ],
)
def test_time_range_maps_start_published_date(monkeypatch, time_range, expected_date):
    """time_range → startPublishedDate（UTC 往前推），且不传 endPublishedDate。"""
    monkeypatch.setattr(ExaProvider, "_utc_now", lambda self: FIXED_UTC)
    body = body_of(NormalizedParams(query="q", time_range=time_range), [])
    assert body["startPublishedDate"] == expected_date
    assert "endPublishedDate" not in body


def test_no_time_range_omits_start_published_date(monkeypatch):
    monkeypatch.setattr(ExaProvider, "_utc_now", lambda self: FIXED_UTC)
    body = body_of(NormalizedParams(query="q"), [])
    assert "startPublishedDate" not in body


def test_contents_include_content_true():
    body = body_of(NormalizedParams(query="q", include_content=True), [])
    assert body["contents"] == {"text": {"maxCharacters": 8000}, "highlights": True}


def test_contents_default_is_highlights_only():
    """include_content=False：对齐官方 MCP web_search_exa，仍请求 highlights。"""
    body = body_of(NormalizedParams(query="q"), [])
    assert body["contents"] == {"highlights": True}


def test_contents_include_answer_appends_summary():
    body = body_of(NormalizedParams(query="比特币", include_answer=True), [])
    assert body["contents"] == {"highlights": True, "summary": {"query": "比特币"}}


def test_contents_both_flags_merge():
    body = body_of(
        NormalizedParams(query="q", include_content=True, include_answer=True), []
    )
    assert body["contents"] == {
        "text": {"maxCharacters": 8000},
        "highlights": True,
        "summary": {"query": "q"},
    }


@pytest.mark.parametrize(
    "params",
    [
        NormalizedParams(query="q"),
        NormalizedParams(query="q", depth="advanced", topic="news", time_range="day"),
        NormalizedParams(query="q", include_content=True, include_answer=True),
        NormalizedParams(
            query="q", depth="advanced", topic="finance", time_range="year",
            max_results=10, include_content=True,
        ),
        NormalizedParams(query="q", topic="general", time_range="week", include_answer=True),
        NormalizedParams(query="q", depth="basic", max_results=1),
    ],
)
def test_forbidden_fields_never_sent(params):
    """禁发字段硬断言：递归扫描请求体，六组参数组合全覆盖。"""
    forbidden_keys = {
        "includeText", "excludeText", "startCrawlDate", "endCrawlDate", "endPublishedDate",
    }

    def _walk(node):
        if isinstance(node, dict):
            yield from node.keys()
            for child in node.values():
                yield from _walk(child)
        elif isinstance(node, list):
            for child in node:
                yield from _walk(child)

    body = body_of(params, [])
    assert forbidden_keys.isdisjoint(set(_walk(body)))
    assert body["type"] not in {"keyword", "neural"}


# ---------------------------------------------------------------- 头部与预算


def test_headers_use_x_api_key_and_no_bearer():
    recorded = []
    body_of(NormalizedParams(query="q"), recorded)
    request = recorded[-1]
    assert request.headers["x-api-key"] == API_KEY
    assert "authorization" not in request.headers  # Bearer 绝不出现
    assert request.headers["content-type"] == "application/json"
    assert request.url == "https://api.exa.ai/search"
    assert request.method == "POST"


def test_deadline_exhausted_raises_transient_without_request():
    """预算 ≤0：TransientError（时间预算耗尽），且 handler 绝不被调用。"""
    called = []

    def _handler(request):
        called.append(request)
        return resp(MINIMAL_OK)

    provider = make_provider(_handler)
    try:
        with pytest.raises(TransientError) as ei:
            provider.search(NormalizedParams(query="q"), time.monotonic() - 0.001)
        assert "预算" in ei.value.detail
        assert called == []
    finally:
        provider.close()


def test_usage_returns_empty_dict_and_never_raises():
    """Exa 无公开用量端点：usage() 返回 {}，由 router 本地记账。"""
    provider = make_provider(lambda r: resp(MINIMAL_OK))
    try:
        assert provider.usage() == {}
    finally:
        provider.close()
