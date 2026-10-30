"""router —— 聚合搜索路由器：额度降级状态机（本服务的灵魂）。

纯同步、零网络；网络逻辑在 providers/*，状态持久化在 cooldown.CooldownStore。
职责：入参边界归一化（parse, don't validate）；路由编排（显式选择 > 默认+后备）；
按错误语义降级（详见 SearchRouter._attempt）；Exa 月度预算记账；
全部候选失败时以 SearchUnavailable 输出中文终态描述。

# allow: SIZE_OK —— 不可再分的额度降级状态机：各方法与 _store/_providers/_mono/_sleep
# 共享内部状态，拆文件只会变成 mixin；行数主要花在任务强制的中文 docstring/错误文案上。
"""

import time
from typing import Any, Optional, Protocol

from config import Config
from cooldown import CooldownStore
from providers.base import (BadRequestError, InvalidKeyError, NormalizedParams, NormalizedResult,
                            ProviderError, ProviderResponse, QuotaExhaustedError,
                            RateLimitedError, SearchUnavailable, TransientError)


class Provider(Protocol):
    """router 依赖的最小 provider 协议（见 providers/base.py 模块 docstring）。"""

    def search(self, params: NormalizedParams, deadline_mono: float) -> ProviderResponse: ...


_VALID_PROVIDERS = ("tavily", "exa")
_VALID_DEPTH = ("basic", "advanced")
_VALID_TOPIC = ("general", "news", "finance")
_VALID_TIME_RANGE = ("day", "week", "month", "year")

_MAX_RESULTS_MIN = 1
_MAX_RESULTS_MAX = 20
# 瞬时错误指数退避：间隔 1s、2s，至多重试 2 次（单家最多 3 次调用）。
_MAX_TRANSIENT_RETRIES = 2
_BACKOFF_BASE_S = 1.0


def _choice_error(what: str, value: Any) -> ValueError:
    """构造 provider 参数非法的中文 ValueError（列出全部合法取值）。"""
    return ValueError(
        f"{what}非法：'{value}'。合法取值：None / ''（走默认路由）、"
        + "、".join(f"'{p}'" for p in _VALID_PROVIDERS)
        + "。"
    )


def _one_of(field: str, value: Optional[str], allowed: tuple[str, ...], optional: bool) -> Optional[str]:
    """白名单校验单值：optional 时 None/'' 归一为 None，否则 '' 也按非法抛中文 ValueError。"""
    if value in (None, "") and optional:
        return None
    if value not in allowed:
        choices = "、".join(f"'{a}'" for a in allowed)
        raise ValueError(f"{field}非法：'{value}'。合法取值：{choices}。")
    return value


def _str_field(rec: dict, key: str, default: str) -> str:
    """从 CooldownStore 记录里取字符串字段，非字符串（缺失/损坏）回退默认值。"""
    value = rec.get(key)
    return value if isinstance(value, str) else default


class SearchRouter:
    """聚合路由器。构造时按 config 的 API key 过滤 provider 注册表：
    未配置 key 的提供商直接排除（providers dict 缺对应 key 也允许）。
    """

    def __init__(
        self,
        config: Config,
        store: CooldownStore,
        providers: dict[str, Provider],
    ) -> None:
        self._config = config
        self._store = store
        api_keys = {"tavily": config.tavily_key, "exa": config.exa_key}
        self._providers: dict[str, Provider] = {
            name: p
            for name, p in providers.items()
            if name in api_keys and api_keys[name] and p is not None
        }
        # 可注入时钟与睡眠：测试 monkeypatch 实例属性，绝不真等
        self._sleep = time.sleep
        self._mono = time.monotonic

    # ---------- 主入口 ----------

    def search(
        self,
        query: str,
        provider: Optional[str] = None,
        max_results: int = 5,
        depth: str = "basic",
        topic: Optional[str] = None,
        time_range: Optional[str] = None,
        include_content: bool = False,
        include_answer: bool = False,
    ) -> NormalizedResult:
        """执行一次聚合搜索：参数归一 → 路由编排 → 逐家尝试（按错误语义降级）。

        失败对外只抛两种异常：ValueError（入参非法，调用方 bug）与
        SearchUnavailable（所有候选终态不可用）；BadRequestError 原样透传。
        """
        chosen = SearchRouter._validate_choice(provider)
        params = SearchRouter._build_params(
            query, max_results, depth, topic, time_range, include_content, include_answer
        )
        order = self._plan_order(chosen)
        deadline_mono = self._mono() + self._config.request_deadline_s

        skipped: list[dict[str, str]] = []  # 冷却/禁用/未注册而被跳过的成员
        failures: dict[str, str] = {}  # 尝试后终态失败的 provider -> 最后错误文本
        for name in order:
            available, skip = self._availability(name)
            if not available:
                assert skip is not None
                skipped.append(skip)
                continue
            try:
                resp = self._attempt(name, params, deadline_mono)
            except BadRequestError:
                # 400 = 本次请求自身的参数 bug，切换另一家毫无意义，原样上抛
                raise
            except ProviderError as exc:
                failures[name] = str(exc)
                continue
            return self._success_result(name, order, resp, skipped)

        raise SearchUnavailable(self._unavailable_detail(skipped, failures))

    # ---------- 单家尝试（含原地重试策略） ----------

    def _attempt(
        self, name: str, params: NormalizedParams, deadline_mono: float
    ) -> ProviderResponse:
        """按重试策略调用指定 provider；抛 ProviderError 表示该家终态失败。

        - QuotaExhausted → mark_exhausted（冷却到月初）后上抛；
        - InvalidKey → mark_disabled（永不自动恢复）后上抛；
        - RateLimited → 仅 tavily、仅首次、retry_after_s 存在且预算容得下时
          原地 sleep 后重试一次；其余情形上抛；
        - Transient → 1s/2s 退避至多重试 2 次，每步先查剩余预算，不足即停；
        - BadRequest → 不捕获，由调用方原样上抛。
        """
        provider = self._providers[name]
        rate_retried = False  # tavily 429 的原地重试额度（仅一次）
        transient_retries = 0
        while True:
            try:
                return provider.search(params, deadline_mono)
            except QuotaExhaustedError as exc:
                self._store.mark_exhausted(name, "quota_exhausted", last_error=str(exc))
                raise
            except InvalidKeyError as exc:
                self._store.mark_disabled(name, "invalid_key", str(exc))
                raise
            except RateLimitedError as exc:
                if rate_retried:
                    raise  # 429 重试预算已用完，再失败即切换下一家
                if (
                    name == "tavily"
                    and exc.retry_after_s is not None
                    and self._mono() + exc.retry_after_s < deadline_mono
                ):
                    remaining = deadline_mono - self._mono()
                    self._sleep(min(exc.retry_after_s, max(0.0, remaining)))
                    rate_retried = True
                    continue
                raise  # exa 不重试（官方策略）；无 retry_after 或预算不足也不重试
            except TransientError:
                # 临时故障绝不 mark_exhausted：不冷却，只退避重试
                if rate_retried or transient_retries >= _MAX_TRANSIENT_RETRIES:
                    raise
                delay = _BACKOFF_BASE_S * (2 ** transient_retries)  # 1s、2s
                if self._mono() + delay >= deadline_mono:
                    raise  # 剩余预算不足以再睡+再试，停止重试
                self._sleep(delay)
                transient_retries += 1
                continue

    # ---------- 结果组装 ----------

    def _success_result(
        self,
        name: str,
        order: list[str],
        resp: ProviderResponse,
        skipped: list[dict[str, str]],
    ) -> NormalizedResult:
        """成功路径：exa 预算记账 + note 汇总 + fallback 判定。"""
        notes: list[str] = []
        if name == "exa" and resp.cost_usd is not None:
            if self._store.add_exa_cost(resp.cost_usd):
                # 本次成功结果照常返回；预算已触顶，后续请求将自动跳过 exa
                notes.append("exa 本月预算已达上限，后续请求将直接使用其他提供商")
        if skipped:
            desc = "、".join(
                f"{s['provider']}（状态：{s['state']}，原因：{s['reason']}）"
                for s in skipped
            )
            notes.append(f"已跳过 {desc}")
        return NormalizedResult(
            provider_used=name,
            fallback_applied=name != order[0],
            results=resp.results,
            answer=resp.answer,
            note="；".join(notes) if notes else None,
            meta={"skipped_providers": skipped},
        )

    def _unavailable_detail(
        self, skipped: list[dict[str, str]], failures: dict[str, str]
    ) -> str:
        """SearchUnavailable 的中文终态描述：每家最终状态 + 最后错误 + 指引。"""
        parts: list[str] = []
        for s in skipped:
            parts.append(f"{s['provider']} 已跳过（状态：{s['state']}，原因：{s['reason']}）")
        snap_providers = self._store.snapshot()["providers"]
        for name, err in failures.items():
            state = _str_field(snap_providers.get(name, {}), "state", "ok")
            parts.append(f"{name} 调用失败（最终状态：{state}，最后错误：{err}）")
        return (
            "所有可用提供商均无法完成本次搜索："
            + "；".join(parts)
            + "。可调用 provider_status 查看用量，或 reset_cooldown 手动清除冷却。"
        )

    # ---------- 路由编排 ----------

    def _plan_order(self, chosen: Optional[str]) -> list[str]:
        """显式选择 → 仅此一家；否则默认提供商 +（允许后备且后备已注册）另一家。"""
        if chosen is not None:
            return [chosen]
        order = [self._config.default_provider]
        other = "exa" if self._config.default_provider == "tavily" else "tavily"
        if self._config.fallback_enabled and other in self._providers:
            order.append(other)
        return order

    def _availability(self, name: str) -> tuple[bool, Optional[dict[str, str]]]:
        """该 provider 本轮能否出手；不可用时给出 {provider,state,reason} 跳过记录。"""
        if name not in self._providers:
            configured = (
                self._config.tavily_key if name == "tavily" else self._config.exa_key
            )
            reason = "未配置 API key" if not configured else "provider 实例未注册"
            return False, {"provider": name, "state": "unconfigured", "reason": reason}
        if self._store.is_available(name):
            return True, None
        rec = self._store.snapshot()["providers"].get(name, {})
        return False, {
            "provider": name,
            "state": _str_field(rec, "state", "unknown"),
            "reason": _str_field(rec, "reason", ""),
        }

    # ---------- 参数边界 ----------

    @staticmethod
    def _validate_choice(provider: Optional[str]) -> Optional[str]:
        """provider ∈ {None, '', tavily, exa}；'' 归一为 None（走默认路由）。"""
        if provider is None or provider == "":
            return None
        if provider not in _VALID_PROVIDERS:
            raise _choice_error("provider", provider)
        return provider

    @staticmethod
    def _build_params(
        query: str,
        max_results: int,
        depth: str,
        topic: Optional[str],
        time_range: Optional[str],
        include_content: bool,
        include_answer: bool,
    ) -> NormalizedParams:
        """入参归一化：空串→None，范围校验/夹紧；非法值一律中文 ValueError。"""
        text = (query if isinstance(query, str) else str(query)).strip()
        if not text:
            raise ValueError("query 不能为空。")
        return NormalizedParams(
            query=text,
            max_results=max(_MAX_RESULTS_MIN, min(_MAX_RESULTS_MAX, int(max_results))),
            depth=_one_of("depth", depth, _VALID_DEPTH, optional=False),
            topic=_one_of("topic", topic, _VALID_TOPIC, optional=True),
            time_range=_one_of("time_range", time_range, _VALID_TIME_RANGE, optional=True),
            include_content=bool(include_content),
            include_answer=bool(include_answer),
        )

    # ---------- 状态查询（供 provider_status 工具） ----------

    def status(self) -> dict[str, Any]:
        """两家提供商的终态摘要：状态/原因/冷却时刻 + tavily 用量 + exa 预算账本。"""
        snap = self._store.snapshot()
        recs = snap["providers"]

        def _view(name: str) -> tuple[str, str, Any]:
            rec = recs.get(name, {})
            return _str_field(rec, "state", "ok"), _str_field(rec, "reason", ""), rec.get("until")

        t_state, t_reason, t_until = _view("tavily")
        e_state, e_reason, e_until = _view("exa")
        quota, quota_source = self._tavily_quota()
        month_cost = snap["exa_ledger"].get("cost_usd")
        return {
            "providers": {
                "tavily": {
                    "state": t_state,
                    "reason": t_reason,
                    "quota": quota,
                    "quota_source": quota_source,
                },
                "exa": {
                    "state": e_state,
                    "reason": e_reason,
                    "month_cost_usd": (
                        float(month_cost) if isinstance(month_cost, (int, float)) else 0.0
                    ),
                    "monthly_budget_usd": self._store.monthly_budget_usd,
                },
            },
            "default_provider": self._config.default_provider,
            "fallback_enabled": self._config.fallback_enabled,
            "cooldown_until": {"tavily": t_until, "exa": e_until},
        }

    def _tavily_quota(self) -> tuple[Optional[dict], str]:
        """tavily 用量：先读缓存（TTL 300s），miss 再 live 查询并回写缓存。

        用量是尽力而为的诊断信息：无实例/无 usage()/抛异常/返回非 dict 一律降级
        (None, "none")，绝不让 status() 崩溃。
        """
        cached = self._store.get_cached_tavily_usage()
        if cached is not None:
            return cached, "cache"
        provider = self._providers.get("tavily")
        if provider is None:
            return None, "none"
        usage = getattr(provider, "usage", None)
        if usage is None:
            return None, "none"
        try:
            data = usage()
        except Exception:
            # 契约缺口兜底：usage() 无类型承诺，任何异常都只降级不传播
            return None, "none"
        if not isinstance(data, dict):
            return None, "none"
        self._store.cache_tavily_usage(data)
        return data, "live"

    # ---------- 手动重置（供 reset_cooldown 工具） ----------

    def reset(self, provider: Optional[str] = None) -> dict[str, Any]:
        """清除冷却/禁用。provider=None 或 '' 清全部；非法值 ValueError。"""
        target = SearchRouter._validate_choice(provider)
        affected = self._store.reset(target)
        return {"reset": target or "all", "providers": affected}
