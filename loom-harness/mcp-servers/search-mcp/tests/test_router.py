"""router.SearchRouter 的契约测试（TDD：自造 FakeProvider，绝不 import providers.tavily/exa）。

覆盖（对应设计编号）：
- S3 显式/默认路由；参数归一化与白名单校验；
- S4 额度耗尽降级（tavily→exa、exa→tavily）、冷却期二次请求跳过、exa 预算记账；
- S5 双冷却 / 双 invalid_key 的 SearchUnavailable 终态描述；
- 429：tavily 原地重试一次（≤1 次）、exa 从不重试；
- 5xx：1s/2s 退避 ≤2 次、切换、绝不冷却；
- 400：原样上抛、另一家不被调用；
- deadline 预算：时钟大步前进时不无限重试；
- status()：usage live→cache 两级来源、异常兜底 none、无 key 时 none；
- reset()：透传 CooldownStore 与参数校验。

时间控制约定（router 实现方须提供）：
- SearchRouter._sleep（默认 time.sleep）、_mono（默认 time.monotonic）实例属性，
  测试直接覆盖为 FakeTime 的方法，绝不真实等待。
"""

from pathlib import Path
from typing import Optional

import pytest

from config import Config
from cooldown import CooldownStore
from providers.base import (
    BadRequestError,
    InvalidKeyError,
    ProviderResponse,
    QuotaExhaustedError,
    RateLimitedError,
    SearchUnavailable,
    TransientError,
)
from router import SearchRouter

# ---------- Fake 基础设施 ----------


def ok_response(cost_usd: Optional[float] = None) -> ProviderResponse:
    """构造一条标准成功响应。"""
    return ProviderResponse(
        results=[{"title": "结果一", "url": "https://example.com/1", "content": "c"}],
        answer="答案摘要",
        cost_usd=cost_usd,
    )


class FakeProvider:
    """可编程 fake provider：script 逐项弹出（异常实例则抛出），
    弹完后复用 default_response。calls 记录 .search 被调次数。
    """

    def __init__(self, script=(), default_response=None, usage_script=()):
        self.script = list(script)
        self.default_response = default_response if default_response is not None else ok_response()
        self.usage_script = list(usage_script)
        self.calls = 0
        self.usage_calls = 0
        self.last_params = None
        self.last_deadline = None

    def search(self, params, deadline_mono):
        self.calls += 1
        self.last_params = params
        self.last_deadline = deadline_mono
        item = self.script.pop(0) if self.script else self.default_response
        if isinstance(item, BaseException):
            raise item
        return item

    def usage(self):
        self.usage_calls += 1
        item = self.usage_script.pop(0) if self.usage_script else {"total_usage": self.usage_calls}
        if isinstance(item, BaseException):
            raise item
        return item


class FakeTime:
    """可控时钟：每次读 _mono 返回当前值并前进 step 秒；_sleep 只记录不推进。"""

    def __init__(self, start=0.0, step=0.0):
        self.t = start
        self.step = step
        self.sleeps = []

    def mono(self):
        now = self.t
        self.t += self.step
        return now

    def sleep(self, seconds):
        self.sleeps.append(seconds)


def both_config(**overrides) -> Config:
    """两家 key 齐全的默认配置（default=tavily，fallback 开，deadline 55s）。"""
    base = dict(
        default_provider="tavily",
        fallback_enabled=True,
        request_deadline_s=55.0,
        tavily_key="t-key",
        exa_key="e-key",
        config_path=Path("test-config.json"),
        exa_monthly_budget_usd=10.0,
    )
    base.update(overrides)
    return Config(**base)


@pytest.fixture
def store(tmp_path):
    """落盘在 tmp_path 的独立 CooldownStore（exa 预算 10.0）。"""
    return CooldownStore(tmp_path / "cooldown.json", monthly_budget_usd=10.0)


def make_router(store, config, providers, time_step=0.0):
    """装配 router 并注入 FakeTime（_sleep/_mono 为实例属性，测试专用）。"""
    router = SearchRouter(config, store, providers)
    fake_time = FakeTime(step=time_step)
    router._sleep = fake_time.sleep
    router._mono = fake_time.mono
    return router, fake_time


# ---------- S3 路由与参数校验 ----------


def test_显式路由exa时tavily不被调用(store):
    # Given: 两家均注册，显式指定 exa
    tavily, exa = FakeProvider(), FakeProvider()
    router, _ = make_router(store, both_config(), {"tavily": tavily, "exa": exa})
    # When: 显式 provider="exa"
    result = router.search("量子计算", provider="exa")
    # Then: 只有 exa 出手，无 fallback
    assert exa.calls == 1 and tavily.calls == 0
    assert result.provider_used == "exa"
    assert result.fallback_applied is False


def test_显式路由tavily时exa不被调用(store):
    # Given
    tavily, exa = FakeProvider(), FakeProvider()
    router, _ = make_router(store, both_config(), {"tavily": tavily, "exa": exa})
    # When: 显式 provider="tavily"（空串等价于不传，走默认，同样只碰 tavily）
    result = router.search("量子计算", provider="tavily")
    empty = router.search("量子计算", provider="")
    # Then
    assert tavily.calls == 2 and exa.calls == 0
    assert result.provider_used == "tavily"
    assert empty.provider_used == "tavily"


def test_provider参数非法抛ValueError并列出合法值(store):
    router, _ = make_router(store, both_config(), {"tavily": FakeProvider(), "exa": FakeProvider()})
    with pytest.raises(ValueError) as excinfo:
        router.search("q", provider="google")
    msg = str(excinfo.value)
    assert "google" in msg and "tavily" in msg and "exa" in msg


def test_默认路由tavily成功且fallback_applied为False(store):
    # Given: default=tavily，tavily 一次成功
    tavily, exa = FakeProvider(), FakeProvider()
    router, _ = make_router(store, both_config(), {"tavily": tavily, "exa": exa})
    # When
    result = router.search("聚合搜索")
    # Then: 后备 provider 完全不被触碰
    assert result.provider_used == "tavily"
    assert result.fallback_applied is False
    assert exa.calls == 0
    assert result.meta["skipped_providers"] == []
    assert result.note is None
    assert result.answer == "答案摘要"


def test_参数归一化_空串转None并夹紧max_results与裁剪query(store):
    tavily = FakeProvider()
    router, _ = make_router(store, both_config(), {"tavily": tavily, "exa": FakeProvider()})
    # When: 空串 topic/time_range、越界 max_results、带空白 query
    router.search("  聚合搜索  ", max_results=99, topic="", time_range="")
    p_hi = tavily.last_params
    router.search("q", max_results=0, depth="advanced", topic="news",
                  time_range="week", include_content=True, include_answer=True)
    p_lo = tavily.last_params
    # Then
    assert p_hi.query == "聚合搜索"
    assert p_hi.max_results == 20 and p_hi.topic is None and p_hi.time_range is None
    assert p_lo.max_results == 1
    assert p_lo.depth == "advanced" and p_lo.topic == "news" and p_lo.time_range == "week"
    assert p_lo.include_content is True and p_lo.include_answer is True
    # deadline 已注入：request_deadline_s=55，FakeTime 冻结 → provider 收到 55.0
    assert tavily.last_deadline == pytest.approx(55.0)


def test_depth_topic_time_range非法各抛ValueError(store):
    router, _ = make_router(store, both_config(), {"tavily": FakeProvider(), "exa": FakeProvider()})
    with pytest.raises(ValueError):
        router.search("q", depth="turbo")
    with pytest.raises(ValueError):
        router.search("q", topic="sports")
    with pytest.raises(ValueError):
        router.search("q", time_range="hour")
    with pytest.raises(ValueError):
        router.search("   ")


def test_构造时排除未配置key的provider(store):
    # Given: tavily_key=None，但 providers dict 里塞了 tavily 实例（构造应直接排除）
    tavily, exa = FakeProvider(), FakeProvider()
    cfg = both_config(default_provider="tavily", tavily_key=None)
    router, _ = make_router(store, cfg, {"tavily": tavily, "exa": exa})
    # When: 默认路由 tavily 未注册 → 记录跳过，后备 exa 出手
    result = router.search("q")
    # Then
    assert tavily.calls == 0 and exa.calls == 1
    assert result.provider_used == "exa"
    assert result.fallback_applied is True
    skipped = result.meta["skipped_providers"]
    assert skipped[0]["provider"] == "tavily"
    assert skipped[0]["state"] == "unconfigured"
    assert "tavily" in result.note


# ---------- S4 额度耗尽降级与冷却跳过 ----------


def test_tavily额度耗尽切exa且二次请求冷却跳过tavily(store):
    # Given: tavily 抛 QuotaExhausted（对应 Tavily 432/433）
    tavily = FakeProvider(script=[QuotaExhaustedError("tavily", "HTTP 432 额度耗尽", status=432)])
    exa = FakeProvider()
    router, _ = make_router(store, both_config(), {"tavily": tavily, "exa": exa})
    # When: 第一次 search：tavily 耗尽 → exa 成功
    result = router.search("q")
    # Then: fallback 生效，tavily 进入 cooldown 并落盘
    assert result.provider_used == "exa" and result.fallback_applied is True
    snap = store.snapshot()
    assert snap["providers"]["tavily"]["state"] == "cooldown"
    assert snap["providers"]["tavily"]["reason"] == "quota_exhausted"
    assert snap["providers"]["tavily"]["until"]  # 冷却时刻已写入
    # When: 第二次 search：冷却期 tavily 直接跳过，不再调用
    result2 = router.search("q")
    # Then: tavily 调用次数不再增加；note/meta 记录跳过原因
    assert tavily.calls == 1
    assert result2.provider_used == "exa"
    assert "tavily" in result2.note and "cooldown" in result2.note
    assert result2.meta["skipped_providers"] == [
        {"provider": "tavily", "state": "cooldown", "reason": "quota_exhausted"}
    ]


def test_exa额度耗尽切tavily_默认exa变体(store):
    # Given: default=exa，exa 抛 QuotaExhausted（对应 Exa 402）
    exa = FakeProvider(script=[QuotaExhaustedError("exa", "HTTP 402 credits exhausted", status=402)])
    tavily = FakeProvider()
    cfg = both_config(default_provider="exa")
    router, _ = make_router(store, cfg, {"tavily": tavily, "exa": exa})
    # When
    result = router.search("q")
    # Then: tavily 成功，exa 冷却
    assert result.provider_used == "tavily" and result.fallback_applied is True
    assert store.snapshot()["providers"]["exa"]["state"] == "cooldown"
    assert store.is_available("exa") is False


# ---------- S5 终态：SearchUnavailable ----------


def test_双冷却抛SearchUnavailable且detail提及两家与指引(store):
    # Given: 两家提前置 cooldown
    store.mark_exhausted("tavily", "quota_exhausted")
    store.mark_exhausted("exa", "budget_ledger")
    tavily, exa = FakeProvider(), FakeProvider()
    router, _ = make_router(store, both_config(), {"tavily": tavily, "exa": exa})
    # When / Then
    with pytest.raises(SearchUnavailable) as excinfo:
        router.search("q")
    detail = excinfo.value.detail
    assert "tavily" in detail and "exa" in detail
    assert "cooldown" in detail
    assert "provider_status" in detail and "reset_cooldown" in detail
    assert tavily.calls == 0 and exa.calls == 0


def test_双invalid_key置disabled后SearchUnavailable(store):
    # Given: 两家 key 均失效
    tavily = FakeProvider(script=[InvalidKeyError("tavily", "HTTP 401 key 无效", status=401)])
    exa = FakeProvider(script=[InvalidKeyError("exa", "HTTP 403 key 吊销", status=403)])
    router, _ = make_router(store, both_config(), {"tavily": tavily, "exa": exa})
    # When / Then
    with pytest.raises(SearchUnavailable) as excinfo:
        router.search("q")
    snap = store.snapshot()
    assert snap["providers"]["tavily"]["state"] == "disabled"
    assert snap["providers"]["exa"]["state"] == "disabled"
    assert snap["providers"]["tavily"]["until"] is None  # disabled 无冷却时刻，永不自动恢复
    detail = excinfo.value.detail
    assert "tavily" in detail and "exa" in detail and "disabled" in detail


# ---------- 429 限流策略 ----------


def test_tavily限流原地退避一次后成功(store):
    # Given: 第一次 429（retry_after 0.5s），第二次成功
    tavily = FakeProvider(
        script=[RateLimitedError("tavily", "HTTP 429", status=429, retry_after_s=0.5)]
    )
    exa = FakeProvider()
    router, fake_time = make_router(store, both_config(), {"tavily": tavily, "exa": exa})
    # When
    result = router.search("q")
    # Then: sleep 被记录且不超过 retry_after；重试一次即成功，不切换
    assert tavily.calls == 2 and exa.calls == 0
    assert len(fake_time.sleeps) == 1 and fake_time.sleeps[0] <= 0.5
    assert result.provider_used == "tavily" and result.fallback_applied is False


def test_tavily两次都429则切换exa且调用封顶两次(store):
    # Given: tavily 连续两次 429
    tavily = FakeProvider(
        script=[
            RateLimitedError("tavily", "HTTP 429 第一次", status=429, retry_after_s=0.5),
            RateLimitedError("tavily", "HTTP 429 第二次", status=429, retry_after_s=0.5),
        ]
    )
    exa = FakeProvider()
    router, fake_time = make_router(store, both_config(), {"tavily": tavily, "exa": exa})
    # When
    result = router.search("q")
    # Then: 原地重试仅一次（calls 封顶 2），随后切换 exa
    assert tavily.calls == 2 and exa.calls == 1
    assert len(fake_time.sleeps) == 1
    assert result.provider_used == "exa" and result.fallback_applied is True


def test_exa限流从不重试直接切换tavily(store):
    # Given: default=exa，exa 抛 429（Exa 官方 MCP 对 429 不重试）
    exa = FakeProvider(
        script=[RateLimitedError("exa", "HTTP 429 排队中", status=429, retry_after_s=2.0)]
    )
    tavily = FakeProvider()
    cfg = both_config(default_provider="exa")
    router, fake_time = make_router(store, cfg, {"tavily": tavily, "exa": exa})
    # When
    result = router.search("q")
    # Then: exa 只被调一次、未 sleep，tavily 接手
    assert exa.calls == 1 and tavily.calls == 1
    assert fake_time.sleeps == []
    assert result.provider_used == "tavily" and result.fallback_applied is True


# ---------- 5xx 瞬时故障 ----------


def test_瞬时错误退避两次后切换且绝不冷却(store):
    # Given: tavily 持续 503（script 耗尽后 default_response 也设为异常）
    tavily = FakeProvider(default_response=TransientError("tavily", "HTTP 503", status=503))
    exa = FakeProvider()
    router, fake_time = make_router(store, both_config(), {"tavily": tavily, "exa": exa})
    # When
    result = router.search("q")
    # Then: 1 次初始 + 2 次重试封顶；退避 1s、2s；exa 接手成功
    assert tavily.calls == 3 and exa.calls == 1
    assert fake_time.sleeps == [1.0, 2.0]
    assert result.provider_used == "exa" and result.fallback_applied is True
    # 临时故障不冷却：tavily 状态不是 cooldown，仍可被 is_available 放行
    state = store.snapshot()["providers"].get("tavily", {}).get("state")
    assert state != "cooldown"
    assert store.is_available("tavily") is True


def test_参数错误原样上抛另一家不被调用(store):
    # Given: tavily 抛 BadRequestError（400，自己的参数 bug）
    tavily = FakeProvider(script=[BadRequestError("tavily", "HTTP 400 参数非法", status=400)])
    exa = FakeProvider()
    router, _ = make_router(store, both_config(), {"tavily": tavily, "exa": exa})
    # When / Then: 原样上抛，不切换、不冷却、不记账
    with pytest.raises(BadRequestError):
        router.search("q")
    assert tavily.calls == 1 and exa.calls == 0


# ---------- Exa 预算记账 ----------


def test_exa预算记账第二次触顶本次仍成功第三次被跳过(store):
    # Given: default=exa，每次成功 cost_usd=6.0，预算 10.0
    exa = FakeProvider(default_response=ok_response(cost_usd=6.0))
    tavily = FakeProvider()
    cfg = both_config(default_provider="exa")
    router, _ = make_router(store, cfg, {"tavily": tavily, "exa": exa})
    # When: 第一次 6.0 < 10 → 无预算提示
    r1 = router.search("q")
    assert r1.provider_used == "exa" and r1.note is None
    # When: 第二次累计 12.0 ≥ 10 → 触顶，但本次成功照常返回且 note 含预算提示
    r2 = router.search("q")
    assert r2.provider_used == "exa"
    assert "预算" in r2.note
    assert store.snapshot()["providers"]["exa"]["state"] == "cooldown"
    assert store.snapshot()["providers"]["exa"]["reason"] == "budget_ledger"
    # When: 第三次 → exa 冷却被跳过，tavily 接手
    r3 = router.search("q")
    assert exa.calls == 2  # 第三次没有再调用 exa
    assert r3.provider_used == "tavily" and r3.fallback_applied is True
    assert "exa" in r3.note


# ---------- deadline 预算 ----------


def test_deadline预算不足时不无限重试终致SearchUnavailable(store):
    # Given: 时钟每读一次前进 30s（deadline 55s），两家持续瞬时故障
    tavily = FakeProvider(default_response=TransientError("tavily", "HTTP 500", status=500))
    exa = FakeProvider(default_response=TransientError("exa", "HTTP 500", status=500))
    cfg = both_config(request_deadline_s=55.0)
    router, fake_time = make_router(store, cfg, {"tavily": tavily, "exa": exa}, time_step=30.0)
    # When / Then: 有界重试后终止
    with pytest.raises(SearchUnavailable) as excinfo:
        router.search("q")
    assert len(fake_time.sleeps) <= 2  # 有界，绝不无限睡
    assert tavily.calls <= 3 and exa.calls <= 3
    detail = excinfo.value.detail
    assert "tavily" in detail and "exa" in detail


# ---------- status() ----------


def test_status_tavily用量先live后走缓存(store):
    # Given: usage() 返回可缓存的非空 dict
    tavily = FakeProvider(usage_script=[{"plan": "pro", "used": 123}])
    exa = FakeProvider()
    router, _ = make_router(store, both_config(), {"tavily": tavily, "exa": exa})
    # When: 第一次 status → live 查询并回写缓存
    s1 = router.status()
    assert s1["providers"]["tavily"]["quota_source"] == "live"
    assert s1["providers"]["tavily"]["quota"] == {"plan": "pro", "used": 123}
    assert tavily.usage_calls == 1
    # When: TTL（300s）内第二次 status → 命中缓存，不再调用 usage()
    s2 = router.status()
    assert s2["providers"]["tavily"]["quota_source"] == "cache"
    assert s2["providers"]["tavily"]["quota"] == {"plan": "pro", "used": 123}
    assert tavily.usage_calls == 1
    # Then: 顶层结构完整
    assert s2["default_provider"] == "tavily"
    assert s2["fallback_enabled"] is True
    assert set(s2["cooldown_until"]) == {"tavily", "exa"}
    assert s2["providers"]["exa"]["monthly_budget_usd"] == 10.0
    assert s2["providers"]["exa"]["month_cost_usd"] == 0.0
    assert s2["providers"]["exa"]["state"] == "ok"


def test_status_usage抛异常兜底为none不崩(store):
    tavily = FakeProvider(usage_script=[RuntimeError("usage 接口抖动")])
    router, _ = make_router(store, both_config(), {"tavily": tavily, "exa": FakeProvider()})
    s = router.status()
    assert s["providers"]["tavily"]["quota"] is None
    assert s["providers"]["tavily"]["quota_source"] == "none"


def test_status冷却状态与用量同屏展示(store):
    # Given: tavily 处于 cooldown（带 until）
    store.mark_exhausted("tavily", "quota_exhausted")
    tavily = FakeProvider(usage_script=[{"used": 999}])
    router, _ = make_router(store, both_config(), {"tavily": tavily, "exa": FakeProvider()})
    s = router.status()
    assert s["providers"]["tavily"]["state"] == "cooldown"
    assert s["providers"]["tavily"]["reason"] == "quota_exhausted"
    assert s["cooldown_until"]["tavily"] is not None
    assert s["cooldown_until"]["exa"] is None


def test_status无tavily_key时用量为none(store):
    # Given: 未配 tavily key（构造时被排除），status 不得尝试用量查询
    tavily = FakeProvider()
    cfg = both_config(tavily_key=None)
    router, _ = make_router(store, cfg, {"tavily": tavily, "exa": FakeProvider()})
    s = router.status()
    assert s["providers"]["tavily"]["quota"] is None
    assert s["providers"]["tavily"]["quota_source"] == "none"
    assert tavily.usage_calls == 0


# ---------- reset() ----------


def test_reset透传CooldownStore并含参数校验(store):
    # Given: 两家均被置 cooldown
    store.mark_exhausted("tavily", "quota_exhausted")
    store.mark_exhausted("exa", "budget_ledger")
    router, _ = make_router(store, both_config(), {"tavily": FakeProvider(), "exa": FakeProvider()})
    # When: 只清 tavily
    r1 = router.reset("tavily")
    # Then
    assert r1["reset"] == "tavily"
    assert r1["providers"]["tavily"]["state"] == "ok"
    assert store.is_available("tavily") is True and store.is_available("exa") is False
    # When: 空串等价 None，清全部
    r2 = router.reset("")
    assert r2["reset"] == "all"
    assert store.is_available("tavily") is True and store.is_available("exa") is True
    # When / Then: 非法值 ValueError
    with pytest.raises(ValueError):
        router.reset("bing")
