"""cooldown —— 提供商冷却状态的持久化存储（stdio 进程随客户端重启，状态必须落盘）。

设计要点：
- 固定东八区（TZ_CN）计算"每月 1 日 00:00 + 9 小时缓冲"的重置时刻，不依赖系统 tzdata；
  9 小时缓冲避开提供商按 UTC 月初重置的计数竞态。
- 原子写：临时文件 + os.replace，目录自动创建；文件缺失/损坏容错为空状态重建。
- 时间可注入：_now() / _now_ts() 为实例方法，测试用 monkeypatch 冻结时钟。
- 终态语义：cooldown 到期自愈回 ok；disabled（key 失效）永不自动恢复，只能 reset() 人工解除。
"""

import copy
import json
import os
import time
import warnings
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

# 固定 UTC+8，避免依赖 Windows/Linux 的 tzdata
TZ_CN = timezone(timedelta(hours=8))

# 本服务的提供商全集（reset(None) 与快照归一用）
_KNOWN_PROVIDERS = ("tavily", "exa")

# 月初重置缓冲：9 小时
_RESET_BUFFER = timedelta(hours=9)


def next_reset(now: datetime) -> datetime:
    """返回"下个月 1 日 00:00（TZ_CN）+ 9 小时缓冲"的 aware datetime。

    now 必须是 aware datetime；12 月调用会正确 rollover 到次年 1 月。
    """
    now = now.astimezone(TZ_CN)
    year, month = now.year, now.month
    if month == 12:
        year, month = year + 1, 1
    else:
        month = month + 1
    first_of_next = datetime(year, month, 1, tzinfo=TZ_CN)
    return first_of_next + _RESET_BUFFER


def _empty_state() -> dict[str, Any]:
    """空状态（schema 与持久化文件逐字一致）。"""
    return {
        "providers": {},
        "exa_ledger": {"month": "", "cost_usd": 0.0},
        "tavily_usage_cache": {"fetched_at": 0.0, "data": {}},
    }


class CooldownStore:
    """providers/exa_ledger/tavily_usage_cache 的落盘状态机。"""

    def __init__(
        self,
        path: Optional[Path] = None,
        monthly_budget_usd: float = 10.0,
    ) -> None:
        if path is None:
            path = Path(__file__).resolve().parent / "state" / "cooldown.json"
        self.path = Path(path)
        self.monthly_budget_usd = monthly_budget_usd
        self._state = self._load()

    # ---------- 可注入时钟（测试 monkeypatch 用） ----------

    def _now(self) -> datetime:
        """当前时间（东八区 aware）。"""
        return datetime.now(TZ_CN)

    def _now_ts(self) -> float:
        """当前 epoch 秒（缓存 TTL 用）。"""
        return time.time()

    # ---------- 读写持久化 ----------

    def _load(self) -> dict[str, Any]:
        """读盘；文件缺失或 JSON 损坏时重建空状态（告警不崩溃）。"""
        if not self.path.is_file():
            return _empty_state()
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            warnings.warn(
                f"冷却状态文件损坏，已重建为空状态：{self.path}（{exc}）",
                stacklevel=2,
            )
            return _empty_state()
        if not isinstance(data, dict):
            warnings.warn(
                f"冷却状态文件顶层非对象，已重建为空状态：{self.path}",
                stacklevel=2,
            )
            return _empty_state()
        state = _empty_state()
        if isinstance(data.get("providers"), dict):
            state["providers"] = data["providers"]
        if isinstance(data.get("exa_ledger"), dict):
            ledger = data["exa_ledger"]
            if isinstance(ledger.get("month"), str):
                state["exa_ledger"]["month"] = ledger["month"]
            cost = ledger.get("cost_usd")
            if isinstance(cost, (int, float)):
                state["exa_ledger"]["cost_usd"] = float(cost)
        if isinstance(data.get("tavily_usage_cache"), dict):
            cache = data["tavily_usage_cache"]
            fetched = cache.get("fetched_at")
            if isinstance(fetched, (int, float)):
                state["tavily_usage_cache"]["fetched_at"] = float(fetched)
            if isinstance(cache.get("data"), dict):
                state["tavily_usage_cache"]["data"] = cache["data"]
        return state

    def _save(self) -> None:
        """原子写：同目录临时文件 + os.replace；父目录自动创建。"""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(self.path.name + ".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self._state, f, ensure_ascii=False, indent=2)
        os.replace(tmp, self.path)

    # ---------- 提供商状态 ----------

    def _record(self, provider: str) -> dict[str, Any]:
        """取/建某 provider 的状态记录（默认 ok）。"""
        rec = self._state["providers"].get(provider)
        if not isinstance(rec, dict):
            rec = {"state": "ok", "until": None, "reason": "", "last_error": ""}
            self._state["providers"][provider] = rec
        return rec

    def is_available(self, provider: str) -> bool:
        """是否可用；cooldown 到期自愈回 ok 并落盘；disabled 恒 False。"""
        rec = self._state["providers"].get(provider)
        if not isinstance(rec, dict):
            return True
        state = rec.get("state")
        if state == "disabled":
            return False
        if state != "cooldown":
            return True
        until = rec.get("until")
        if isinstance(until, str):
            try:
                until_dt = datetime.fromisoformat(until)
            except ValueError:
                until_dt = None
            if until_dt is not None:
                if until_dt.tzinfo is None:
                    until_dt = until_dt.replace(tzinfo=TZ_CN)
                if self._now() < until_dt:
                    return False
        # until 缺失/损坏/已过期 → 自愈
        rec["state"] = "ok"
        rec["until"] = None
        rec["reason"] = ""
        self._save()
        return True

    def mark_exhausted(self, provider: str, reason: str, last_error: str = "") -> None:
        """额度耗尽：进入 cooldown，直到 next_reset。"""
        rec = self._record(provider)
        rec["state"] = "cooldown"
        rec["until"] = next_reset(self._now()).isoformat()
        rec["reason"] = reason
        rec["last_error"] = last_error
        self._save()

    def mark_disabled(self, provider: str, reason: str, last_error: str = "") -> None:
        """key 失效等永久错误：disabled，永不自动恢复。"""
        rec = self._record(provider)
        rec["state"] = "disabled"
        rec["until"] = None
        rec["reason"] = reason
        rec["last_error"] = last_error
        self._save()

    def reset(self, provider: Optional[str] = None) -> dict[str, Any]:
        """清回 ok。provider=None 时清全部（已知提供商 ∪ 状态中出现的）。返回受影响快照。"""
        names = (
            [provider]
            if provider is not None
            else sorted(set(_KNOWN_PROVIDERS) | set(self._state["providers"]))
        )
        affected: dict[str, Any] = {}
        for name in names:
            rec = self._record(name)
            rec["state"] = "ok"
            rec["until"] = None
            rec["reason"] = ""
            rec["last_error"] = ""
            affected[name] = copy.deepcopy(rec)
        self._save()
        return affected

    def snapshot(self) -> dict[str, Any]:
        """当前完整状态快照（深拷贝，不含任何敏感值）。"""
        return copy.deepcopy(self._state)

    # ---------- exa 月度记账 ----------

    def add_exa_cost(self, cost_usd: float) -> bool:
        """累计 exa 当月消费；跨月自动 roll。达到/超过预算 → mark_exhausted 并返回 True。"""
        month = self._now().strftime("%Y-%m")
        ledger = self._state["exa_ledger"]
        if ledger.get("month") != month:
            ledger["month"] = month
            ledger["cost_usd"] = 0.0
        base = ledger.get("cost_usd")
        ledger["cost_usd"] = (base if isinstance(base, (int, float)) else 0.0) + float(cost_usd)
        if ledger["cost_usd"] >= self.monthly_budget_usd:
            self.mark_exhausted("exa", "budget_ledger")
            return True
        self._save()
        return False

    # ---------- tavily usage 缓存 ----------

    def cache_tavily_usage(self, data: dict) -> None:
        """缓存 tavily 用量查询结果（降低对外 API 轮询频率）。"""
        self._state["tavily_usage_cache"] = {
            "fetched_at": self._now_ts(),
            "data": copy.deepcopy(data),
        }
        self._save()

    def get_cached_tavily_usage(self, max_age_s: float = 300.0) -> Optional[dict]:
        """读取缓存的 tavily 用量；无缓存或超过 max_age_s 返回 None。"""
        cache = self._state["tavily_usage_cache"]
        data = cache.get("data")
        fetched_at = cache.get("fetched_at")
        if not data or not isinstance(fetched_at, (int, float)):
            return None
        if self._now_ts() - fetched_at > max_age_s:
            return None
        return copy.deepcopy(data)
