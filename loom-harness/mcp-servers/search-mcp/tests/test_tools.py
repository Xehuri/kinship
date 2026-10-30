"""search_mcp 入口工具层测试：全离线，不触网、不碰真实 state 文件。

核心手法：import search_mcp 后用 monkeypatch 把模块级 router 替换为 FakeRouter
（工具函数在调用时才解析全局名 router，替换立即生效）。真实 router 的构建
（config.load_config + 两个 httpx.Client）在 import 期完成，但构造本身零网络。

覆盖：
1) list_tools 契约：恰好 3 个工具名 + web_search inputSchema 含 provider 属性；
2) 成功直通：NormalizedResult 在 MCP 边界渲染为紧凑纯文本（非 JSON dict）；
3) SearchUnavailable -> "web_search failed: ..." 文本（含指引，不抛）；
4) 入参非法 ValueError -> 失败文本；
5) ProviderError 家族（BadRequestError / QuotaExhaustedError）-> 失败文本；
6) provider_status / reset_cooldown 的快照渲染为逐行纯文本；
7) 空串参数归一为 None（provider/topic/time_range，用 fake 记录调用断言）；
8) MCP call_tool 协议边界：TextContent 文本与直接调用输出一致且不含 JSON 括号。
"""

import asyncio

import search_mcp
from providers.base import (
    BadRequestError,
    NormalizedResult,
    ProviderError,
    QuotaExhaustedError,
    SearchUnavailable,
)

# ---------- Fake 基础设施 ----------

_OK_RESULTS = [{"title": "标题", "url": "https://example.com/1", "content": "摘要",
                "score": 0.9, "published_date": None}]


def make_result(**overrides) -> NormalizedResult:
    """构造标准成功 NormalizedResult（可按需覆盖字段）。"""
    fields: dict = {
        "provider_used": "tavily",
        "fallback_applied": False,
        "results": list(_OK_RESULTS),
        "answer": None,
        "note": None,
        "meta": {"skipped_providers": []},
    }
    fields.update(overrides)
    return NormalizedResult(**fields)


class FakeRouter:
    """router 替身：三个方法记录调用、回放编程好的返回值或异常。"""

    def __init__(
        self,
        search_result: NormalizedResult | None = None,
        search_exc: BaseException | None = None,
        status_value: dict | None = None,
        status_exc: BaseException | None = None,
        reset_value: dict | None = None,
        reset_exc: BaseException | None = None,
    ) -> None:
        self.search_result = search_result if search_result is not None else make_result()
        self.search_exc = search_exc
        self.status_value = status_value if status_value is not None else {"providers": {}}
        self.status_exc = status_exc
        self.reset_value = reset_value if reset_value is not None else {"reset": "all", "providers": {}}
        self.reset_exc = reset_exc
        self.search_calls: list[dict] = []
        self.status_calls = 0
        self.reset_calls: list["str | None"] = []

    def search(self, query: str, **kwargs) -> NormalizedResult:
        self.search_calls.append({"query": query, **kwargs})
        if self.search_exc is not None:
            raise self.search_exc
        return self.search_result

    def status(self) -> dict:
        self.status_calls += 1
        if self.status_exc is not None:
            raise self.status_exc
        return self.status_value

    def reset(self, provider: "str | None" = None) -> dict:
        self.reset_calls.append(provider)
        if self.reset_exc is not None:
            raise self.reset_exc
        return self.reset_value


# ---------- 1) list_tools 契约 ----------


def test_list_tools_exactly_three_with_provider_property() -> None:
    """FastMCP.list_tools 为 async：恰好 3 个工具，web_search schema 含 provider。"""
    tools = asyncio.run(search_mcp.mcp.list_tools())
    assert {t.name for t in tools} == {"web_search", "provider_status", "reset_cooldown"}
    assert len(tools) == 3
    web = next(t for t in tools if t.name == "web_search")
    assert "provider" in web.inputSchema["properties"]


# ---------- 2) 成功路径：纯文本渲染 ----------


def test_web_search_success_plain_text(monkeypatch) -> None:
    """fake router 返回 NormalizedResult -> 紧凑纯文本，首行含 provider/fallback/条数。"""
    fake = FakeRouter(search_result=make_result(provider_used="exa", fallback_applied=True))
    monkeypatch.setattr(search_mcp, "router", fake)
    out = search_mcp.web_search("测试查询", provider="exa")
    assert isinstance(out, str)
    assert out.splitlines()[0] == "web_search provider=exa fallback=yes results=1"
    assert "1. 标题 — https://example.com/1" in out
    assert "   content: 摘要" in out
    assert '"provider_used"' not in out
    assert "score" not in out
    assert "{" not in out
    assert "}" not in out


def test_web_search_renders_optional_fields_and_omits_empty(monkeypatch) -> None:
    """published/content/answer/note/meta 有值才输出；空值整行省略。"""
    result = make_result(
        results=[
            {"title": "有值", "url": "https://a.example/1", "content": "第一行\n第二行  有空格",
             "score": 0.5, "published_date": "2026-10-01"},
            {"title": "全空", "url": "https://b.example/2", "content": "",
             "score": None, "published_date": None},
        ],
        answer="答案\n换行",
        note="旁路说明",
        meta={"skipped_providers": [{"provider": "exa", "state": "cooldown"}], "count": 1},
    )
    fake = FakeRouter(search_result=result)
    monkeypatch.setattr(search_mcp, "router", fake)
    out = search_mcp.web_search("q")
    assert out.splitlines()[0] == "web_search provider=tavily fallback=no results=2"
    assert "1. 有值 — https://a.example/1" in out
    assert "2. 全空 — https://b.example/2" in out
    assert "   published: 2026-10-01" in out
    assert "   content: 第一行 第二行 有空格" in out
    assert out.count("published:") == 1
    assert out.count("content:") == 1
    assert "answer: 答案 换行" in out
    assert "note: 旁路说明" in out
    assert "meta: skipped_providers=[provider=exa, state=cooldown], count=1" in out
    assert "score" not in out


def test_web_search_clips_long_fields(monkeypatch) -> None:
    """正文 1200 / answer 500 / note 500 / meta 300 字符上限。"""
    result = make_result(
        results=[{"title": "t", "url": "u", "content": "字" * 1500,
                  "score": None, "published_date": None}],
        answer="答" * 600,
        note="注" * 600,
        meta={"k": "v" * 400},
    )
    fake = FakeRouter(search_result=result)
    monkeypatch.setattr(search_mcp, "router", fake)
    out = search_mcp.web_search("q")
    assert "   content: " + "字" * 1200 in out
    assert "字" * 1201 not in out
    assert "answer: " + "答" * 500 in out
    assert "答" * 501 not in out
    assert "note: " + "注" * 500 in out
    assert "注" * 501 not in out
    assert "meta: k=" + "v" * 298 in out
    assert "v" * 299 not in out


def test_web_search_zero_results(monkeypatch) -> None:
    """无结果时首行为 results=0，且不出现结果行。"""
    fake = FakeRouter(search_result=make_result(results=[]))
    monkeypatch.setattr(search_mcp, "router", fake)
    out = search_mcp.web_search("q")
    assert out.splitlines()[0] == "web_search provider=tavily fallback=no results=0"
    assert "1. " not in out


# ---------- 3) SearchUnavailable -> 纯文本失败 ----------


def test_web_search_search_unavailable_returns_error_text(monkeypatch) -> None:
    """终态不可用：首行含 router 原文，note 含下一步指引，绝不向上抛。"""
    detail = "所有可用提供商均无法完成本次搜索：tavily 已冷却；exa 调用失败。"
    fake = FakeRouter(search_exc=SearchUnavailable(detail))
    monkeypatch.setattr(search_mcp, "router", fake)
    out = search_mcp.web_search("测试查询")
    assert isinstance(out, str)
    assert out.startswith("web_search failed: ")
    assert out.splitlines()[0] == "web_search failed: " + detail
    assert "provider_status" in out
    assert "reset_cooldown" in out
    assert "{" not in out


# ---------- 4) ValueError（非法 provider）-> 失败文本 ----------


def test_web_search_invalid_provider_returns_error_text(monkeypatch) -> None:
    fake = FakeRouter(search_exc=ValueError("provider非法：'google'。合法取值：'tavily'、'exa'。"))
    monkeypatch.setattr(search_mcp, "router", fake)
    out = search_mcp.web_search("测试查询", provider="google")
    assert out.startswith("web_search failed: ")
    assert "provider非法" in out
    assert "provider_status" in out


# ---------- 5) ProviderError 家族 -> 失败文本（永不外泄） ----------


def test_web_search_provider_error_family_returns_error_text(monkeypatch) -> None:
    """BadRequestError（router 原样透传）与 QuotaExhaustedError 都必须收口。"""
    for exc in (
        BadRequestError("tavily", "query 参数不合法", status=400),
        QuotaExhaustedError("exa", "本月额度已耗尽（402）", status=402),
    ):
        fake = FakeRouter(search_exc=exc)
        monkeypatch.setattr(search_mcp, "router", fake)
        out = search_mcp.web_search("测试查询")
        assert out.splitlines()[0] == "web_search failed: " + str(exc)
        assert isinstance(exc, ProviderError)


# ---------- 6) provider_status / reset_cooldown 文本渲染 ----------


def test_provider_status_renders_snapshot(monkeypatch) -> None:
    payload = {
        "providers": {"tavily": {"state": "ok"}, "exa": {"state": "cooldown"}},
        "default_provider": "tavily",
        "fallback_enabled": True,
        "cooldown_until": {"tavily": None, "exa": "2026-11-01T09:00:00+08:00"},
    }
    fake = FakeRouter(status_value=payload)
    monkeypatch.setattr(search_mcp, "router", fake)
    out = search_mcp.provider_status()
    assert out == "\n".join([
        "provider_status default=tavily fallback=on",
        "- tavily state=ok",
        "- exa state=cooldown until=2026-11-01T09:00:00+08:00",
    ])
    assert fake.status_calls == 1


def test_provider_status_renders_reason_quota_and_costs(monkeypatch) -> None:
    """k=v 顺序固定：state -> reason -> until -> quota -> month_cost -> budget；0 不省略。"""
    payload = {
        "providers": {
            "tavily": {
                "state": "ok",
                "reason": "",
                "quota": {
                    "key": {"usage": 12, "limit": 1000},
                    "account": {"current_plan": "dev", "plan_usage": 12, "plan_limit": 1000},
                },
                "quota_source": "cache",
            },
            "exa": {
                "state": "cooldown",
                "reason": "quota_exhausted",
                "month_cost_usd": 0.0,
                "monthly_budget_usd": 10.0,
            },
        },
        "default_provider": "exa",
        "fallback_enabled": False,
        "cooldown_until": {"tavily": None, "exa": "2026-11-01T09:00:00+08:00"},
    }
    fake = FakeRouter(status_value=payload)
    monkeypatch.setattr(search_mcp, "router", fake)
    out = search_mcp.provider_status()
    assert out == "\n".join([
        "provider_status default=exa fallback=off",
        "- tavily state=ok quota(plan=dev, used=12)",
        "- exa state=cooldown reason=quota_exhausted "
        "until=2026-11-01T09:00:00+08:00 month_cost_usd=0.0 monthly_budget_usd=10.0",
    ])


def test_provider_status_error收口(monkeypatch) -> None:
    fake = FakeRouter(status_exc=RuntimeError("state 文件损坏"))
    monkeypatch.setattr(search_mcp, "router", fake)
    out = search_mcp.provider_status()
    assert out == "provider_status failed: state 文件损坏"


def test_reset_cooldown_renders_payload_and_invalid(monkeypatch) -> None:
    payload = {
        "reset": "tavily",
        "providers": {"tavily": {"state": "ok", "until": None, "reason": "", "last_error": ""}},
    }
    fake = FakeRouter(reset_value=payload)
    monkeypatch.setattr(search_mcp, "router", fake)
    out = search_mcp.reset_cooldown("tavily")
    assert out == "\n".join(["reset_cooldown reset=tavily", "- tavily state=ok"])
    assert fake.reset_calls == ["tavily"]

    fake2 = FakeRouter(reset_exc=ValueError("provider非法：'x'。"))
    monkeypatch.setattr(search_mcp, "router", fake2)
    out2 = search_mcp.reset_cooldown("x")
    assert out2 == "reset_cooldown failed: provider非法：'x'。"


# ---------- 7) 空串参数归一为 None ----------


def test_web_search_empty_strings_normalized_to_none(monkeypatch) -> None:
    """provider/topic/time_range 传空串时，fake router 必须收到 None。"""
    fake = FakeRouter()
    monkeypatch.setattr(search_mcp, "router", fake)
    search_mcp.web_search("q", provider="", topic="", time_range="")
    call = fake.search_calls[0]
    assert call["query"] == "q"
    assert call["provider"] is None
    assert call["topic"] is None
    assert call["time_range"] is None
    # 非空串原样透传
    search_mcp.web_search("q", provider="exa", topic="news", time_range="week")
    call2 = fake.search_calls[1]
    assert (call2["provider"], call2["topic"], call2["time_range"]) == ("exa", "news", "week")


def test_reset_cooldown_empty_string_is_all(monkeypatch) -> None:
    """reset_cooldown 的空串 provider 归一为 None（= 清全部）。"""
    fake = FakeRouter()
    monkeypatch.setattr(search_mcp, "router", fake)
    out = search_mcp.reset_cooldown()
    assert out == "reset_cooldown reset=all"
    assert fake.reset_calls == [None]


# ---------- 8) MCP 协议边界 ----------


def test_mcp_call_tool_boundary_returns_same_plain_text(monkeypatch) -> None:
    """call_tool 返回的 TextContent 文本 == 直接调用输出，且不含 JSON 花括号。"""
    fake = FakeRouter(search_result=make_result(provider_used="exa", fallback_applied=True))
    monkeypatch.setattr(search_mcp, "router", fake)
    direct = search_mcp.web_search("q")
    blocks = asyncio.run(search_mcp.mcp.call_tool("web_search", {"query": "q"}))
    if isinstance(blocks, tuple):
        blocks = blocks[0]
    text = "".join(getattr(block, "text", "") for block in blocks)
    assert text == direct
    assert "{" not in text
    assert '"provider_used"' not in text
