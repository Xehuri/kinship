"""cooldown.next_reset / CooldownStore 的契约测试（TDD：先于实现编写）。

覆盖：跨月/跨年边界、+9h 缓冲、冷却自愈、disabled 不自愈、
reset 单家/全部、exa 按月记账与预算触顶、损坏文件容错、tavily 缓存 TTL。

时间控制约定（实现方须提供）：
- CooldownStore._now() -> datetime（TZ_CN aware），测试 monkeypatch 该方法
- CooldownStore._now_ts() -> float（time.time），测试 monkeypatch 该方法
"""

import json
from datetime import datetime, timedelta

import pytest

from cooldown import TZ_CN, CooldownStore, next_reset


def cn(y, mo, d=1, hh=0, mm=0):
    """构造东八区 aware datetime。"""
    return datetime(y, mo, d, hh, mm, tzinfo=TZ_CN)


@pytest.fixture
def clock():
    """可控时钟：fake.dt（datetime）与 fake.ts（epoch 秒）。"""

    class _Clock:
        def __init__(self):
            self.dt = cn(2026, 3, 15, 10, 0)
            self.ts = 1_000_000.0

    return _Clock()


@pytest.fixture
def store(tmp_path, monkeypatch, clock):
    """默认时钟冻结在 2026-03-15 10:00 TZ_CN 的 CooldownStore。"""
    monkeypatch.setattr(CooldownStore, "_now", lambda self: clock.dt)
    monkeypatch.setattr(CooldownStore, "_now_ts", lambda self: clock.ts)
    return CooldownStore(tmp_path / "cooldown.json")


# ---------- next_reset ----------


def test_next_reset_月中返回次月1日9点():
    got = next_reset(cn(2026, 3, 15, 10, 0))
    assert got == cn(2026, 4, 1, 9, 0)
    # 缓冲验证：应为次月 1 日 00:00 + 9 小时
    assert got == datetime(2026, 4, 1, tzinfo=TZ_CN) + timedelta(hours=9)
    assert got.utcoffset() == timedelta(hours=8)


def test_next_reset_12月跨年rollover():
    got = next_reset(cn(2026, 12, 31, 23, 59))
    assert got == cn(2027, 1, 1, 9, 0)


def test_next_reset_月末1日边界():
    # 1 日 00:30 触发 → 下月 1 日（当月 1 日已不是"下个月"）
    assert next_reset(cn(2026, 1, 1, 0, 30)) == cn(2026, 2, 1, 9, 0)
    # 12 月整月 → 次年 1 月
    assert next_reset(cn(2026, 12, 1, 0, 0)) == cn(2027, 1, 1, 9, 0)


# ---------- 冷却状态与自愈 ----------


def test_未知提供商默认可用(store):
    assert store.is_available("tavily") is True
    assert store.is_available("exa") is True


def test_mark_exhausted后不可用并落盘(store):
    store.mark_exhausted("exa", "credits_exhausted", "HTTP 402")
    assert store.is_available("exa") is False
    assert store.is_available("tavily") is True
    # 持久化：until 应为 next_reset(now)+缓冲 的 ISO
    raw = json.loads(store.path.read_text(encoding="utf-8"))
    rec = raw["providers"]["exa"]
    assert rec["state"] == "cooldown"
    assert rec["until"] == next_reset(cn(2026, 3, 15, 10, 0)).isoformat()
    assert rec["reason"] == "credits_exhausted"
    assert rec["last_error"] == "HTTP 402"


def test_until过期后is_available自愈并回写文件(tmp_path, monkeypatch):
    clock_dt = [cn(2026, 3, 15, 10, 0)]
    monkeypatch.setattr(CooldownStore, "_now", lambda self: clock_dt[0])
    p = tmp_path / "cooldown.json"
    s1 = CooldownStore(p)
    s1.mark_exhausted("tavily", "432")
    assert s1.is_available("tavily") is False

    # 把时钟推到 until 之后 1 分钟
    clock_dt[0] = next_reset(cn(2026, 3, 15, 10, 0)) + timedelta(minutes=1)
    assert s1.is_available("tavily") is True
    # 自愈必须回写磁盘（stdio 进程语义下另一实例读到的是 ok）
    raw = json.loads(p.read_text(encoding="utf-8"))
    assert raw["providers"]["tavily"]["state"] == "ok"
    assert raw["providers"]["tavily"]["until"] is None


def test_过期边界now等于until视为已恢复(store, clock):
    store.mark_exhausted("tavily", "432")
    clock.dt = next_reset(clock.dt)  # now == until
    assert store.is_available("tavily") is True


def test_未满不换回(store, clock):
    store.mark_exhausted("tavily", "432")
    clock.dt = cn(2026, 3, 31, 23, 59)  # 未到 until
    assert store.is_available("tavily") is False


def test_disabled永不自愈(store, clock):
    store.mark_disabled("exa", "invalid_key", "HTTP 401")
    assert store.is_available("exa") is False
    # 推到极远未来，disabled 仍不可用，也不得被清回 ok
    clock.dt = cn(2030, 1, 1, 0, 0)
    assert store.is_available("exa") is False
    snap = store.snapshot()
    assert snap["providers"]["exa"]["state"] == "disabled"
    assert snap["providers"]["exa"]["until"] is None


# ---------- reset ----------


def test_reset单家(store):
    store.mark_exhausted("tavily", "432")
    store.mark_exhausted("exa", "402")
    affected = store.reset("tavily")
    assert store.is_available("tavily") is True
    assert store.is_available("exa") is False
    assert "tavily" in affected
    assert affected["tavily"]["state"] == "ok"


def test_reset全部返回受影响快照(store):
    store.mark_exhausted("tavily", "432")
    store.mark_disabled("exa", "key revoked")
    affected = store.reset()
    assert set(affected) >= {"tavily", "exa"}
    assert all(rec["state"] == "ok" for rec in affected.values())
    assert store.is_available("tavily") is True
    assert store.is_available("exa") is True
    snap = store.snapshot()
    assert snap["providers"]["tavily"]["state"] == "ok"
    assert snap["providers"]["exa"]["state"] == "ok"


# ---------- exa 月度记账 ----------


def test_add_exa_cost未达预算返回False并累计(store):
    assert store.add_exa_cost(0.012) is False
    assert store.add_exa_cost(0.013) is False
    snap = store.snapshot()
    assert snap["exa_ledger"]["month"] == "2026-03"
    assert snap["exa_ledger"]["cost_usd"] == pytest.approx(0.025)


def test_add_exa_cost达到预算触发冷却(store):
    assert store.add_exa_cost(10.0) is True
    assert store.is_available("exa") is False
    snap = store.snapshot()
    assert snap["providers"]["exa"]["state"] == "cooldown"
    assert snap["providers"]["exa"]["reason"] == "budget_ledger"


def test_add_exa_cost跨月自动roll(store, clock):
    assert store.add_exa_cost(6.0) is False
    assert store.add_exa_cost(3.5) is False  # 9.5 < 10
    # 推进到下月：账本清零，重新累计
    clock.dt = cn(2026, 4, 2, 8, 0)
    assert store.add_exa_cost(3.0) is False
    snap = store.snapshot()
    assert snap["exa_ledger"]["month"] == "2026-04"
    assert snap["exa_ledger"]["cost_usd"] == pytest.approx(3.0)
    # 跨年 roll
    clock.dt = cn(2026, 12, 31, 23, 0)
    assert store.add_exa_cost(10.5) is True
    snap = store.snapshot()
    assert snap["exa_ledger"]["month"] == "2026-12"
    clock.dt = cn(2027, 1, 2, 0, 30)
    assert store.add_exa_cost(1.0) is False
    snap = store.snapshot()
    assert snap["exa_ledger"]["month"] == "2027-01"
    assert snap["exa_ledger"]["cost_usd"] == pytest.approx(1.0)


def test_add_exa_cost账本跨进程持久化(tmp_path, monkeypatch):
    clock_dt = [cn(2026, 3, 15, 10, 0)]
    monkeypatch.setattr(CooldownStore, "_now", lambda self: clock_dt[0])
    p = tmp_path / "cooldown.json"
    s1 = CooldownStore(p)
    s1.add_exa_cost(2.0)
    s2 = CooldownStore(p)  # 新实例读盘
    assert s2.snapshot()["exa_ledger"]["cost_usd"] == pytest.approx(2.0)
    assert s2.add_exa_cost(8.0) is True  # 基于持久化累计触顶


# ---------- 损坏文件容错 ----------


def test_损坏JSON容错为空状态重建(tmp_path, monkeypatch):
    clock_dt = [cn(2026, 3, 15, 10, 0)]
    monkeypatch.setattr(CooldownStore, "_now", lambda self: clock_dt[0])
    p = tmp_path / "cooldown.json"
    p.write_text("{[corrupted,,,]", encoding="utf-8")
    s = CooldownStore(p)
    assert s.is_available("exa") is True  # 空状态默认可用
    s.mark_exhausted("exa", "402")  # 写回后恢复合法结构
    raw = json.loads(p.read_text(encoding="utf-8"))
    assert raw["providers"]["exa"]["state"] == "cooldown"


def test_状态文件目录自动创建(tmp_path, monkeypatch):
    monkeypatch.setattr(CooldownStore, "_now", lambda self: cn(2026, 3, 15))
    deep = tmp_path / "state" / "nested" / "cooldown.json"
    s = CooldownStore(deep)
    s.mark_exhausted("tavily", "432")
    assert deep.is_file()
    # 原子写：目录里只留最终文件，无 .tmp 残留
    leftovers = [f.name for f in deep.parent.iterdir() if f.name != "cooldown.json"]
    assert leftovers == []


# ---------- tavily usage 缓存 ----------


def test_tavily_usage缓存在TTL内返回(store):
    store.cache_tavily_usage({"total_usage": 999})
    assert store.get_cached_tavily_usage() == {"total_usage": 999}


def test_tavily_usage缓存TTL过期返回None(store, clock):
    store.cache_tavily_usage({"total_usage": 999})
    clock.ts += 300.0 + 0.1  # 超过默认 max_age_s=300
    assert store.get_cached_tavily_usage() is None
    # 自定义 max_age 放宽后仍可读到
    assert store.get_cached_tavily_usage(max_age_s=600) == {"total_usage": 999}


def test_tavily_usage无缓存返回None(store):
    assert store.get_cached_tavily_usage() is None


def test_tavily_usage缓存跨进程持久化(tmp_path, monkeypatch):
    ts = [1_000_000.0]
    monkeypatch.setattr(CooldownStore, "_now", lambda self: cn(2026, 3, 15))
    monkeypatch.setattr(CooldownStore, "_now_ts", lambda self: ts[0])
    p = tmp_path / "cooldown.json"
    s1 = CooldownStore(p)
    s1.cache_tavily_usage({"used": 1234})
    s2 = CooldownStore(p)
    assert s2.get_cached_tavily_usage() == {"used": 1234}
