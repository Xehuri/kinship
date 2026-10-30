"""
查询 OpenCode 会话的请求数量、token 信息、花费估算、工具调用统计。

用法:
  python {AI目录}/analysis/query_session_stats.py <session_id>
  python {AI目录}/analysis/query_session_stats.py <session_id> --json
  python {AI目录}/analysis/query_session_stats.py <session_id> --price-file price.json

数据库: 当前用户数据目录下的 opencode.db（跨平台自动解析，可用 OPENCODE_DB 或 --db 覆盖）

价格: 内置表仅为示例（元/M tokens，flash/pro 两档，高峰/空闲两档）。
      可用 --price-file 或环境变量 SESSION_STATS_PRICE_FILE 指向自己的价格表：
      {"peak_hours": [[9, 12], [14, 18]],
       "tiers": {"flash": {"peak": {"miss": 0, "hit": 0, "out": 0},
                           "offpeak": {"miss": 0, "hit": 0, "out": 0}}}}

输出:
  - 会话基本信息 (agent/model/创建时间/耗时)
  - API 请求数量 (message 数)
  - token 汇总 (input 未命中 / cache_read 命中 / output)
  - 花费估算 (按模型 flash/pro 分档计价)
  - 工具调用类型与数量
"""

import argparse
import sqlite3
import json
import os
from collections import Counter
from datetime import datetime

# 跨平台解析 opencode.db：优先环境变量 OPENCODE_DB，否则按当前用户数据目录
def _default_db_path():
    env = os.environ.get("OPENCODE_DB")
    if env:
        return env
    if os.name == "nt":
        return os.path.expanduser(r"~\.local\share\opencode\opencode.db")
    xdg = os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")
    return os.path.join(xdg, "opencode", "opencode.db")

DB_PATH = _default_db_path()

# 计价示例（元/M tokens），分高峰/空闲两档。数值仅作演示，部署时替换为实际价格。
PEAK_HOURS = ((9, 12), (14, 18))
PRICE = {
    "flash": {
        "peak":   {"miss": 3.0, "hit": 0.10, "out": 9.0},
        "offpeak": {"miss": 1.5, "hit": 0.05, "out": 4.5},
    },
    "pro": {
        "peak":   {"miss": 9.0, "hit": 0.30, "out": 27.0},
        "offpeak": {"miss": 4.5, "hit": 0.15, "out": 13.5},
    },
}


def load_price_table(path=None):
    """加载价格表，返回 (tiers, peak_hours)；path 为空时使用内置示例。"""
    if not path:
        return PRICE, PEAK_HOURS
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise SystemExit(f"价格表格式错误: {path}")
    tiers = data.get("tiers")
    if not isinstance(tiers, dict):
        tiers = {k: v for k, v in data.items() if k != "peak_hours"}
    if not tiers:
        raise SystemExit(f"价格表为空: {path}")
    peak_hours = data.get("peak_hours") or PEAK_HOURS
    return tiers, tuple(tuple(p) for p in peak_hours)


def _fmt_ts(ts):
    """time_created 可能是毫秒或秒，统一转 datetime。"""
    ts = ts / 1000 if ts > 1e12 else ts
    try:
        return datetime.fromtimestamp(ts)
    except (OSError, ValueError, OverflowError):
        return None


def _model_tier(model_str):
    """根据模型名判断价格档位。"""
    if not model_str:
        return "flash"
    return "pro" if "pro" in model_str.lower() else "flash"


def _is_peak(ts, peak_hours=PEAK_HOURS):
    """判断时间戳（毫秒或秒）是否落在配置的高峰时段内。"""
    ts = ts / 1000 if ts > 1e12 else ts
    try:
        dt = datetime.fromtimestamp(ts)
    except (OSError, ValueError, OverflowError):
        return False
    return any(start <= dt.hour < end for start, end in peak_hours)


def query_session(session_id, db_path=None, price=None, peak_hours=PEAK_HOURS):
    """查询单个会话的全部统计，返回 dict。"""
    tiers = price or PRICE
    db = sqlite3.connect(db_path or DB_PATH)
    cur = db.cursor()

    # 会话基本信息
    row = cur.execute(
        "SELECT id, agent, model, time_created, time_updated, cost FROM session WHERE id = ?",
        (session_id,),
    ).fetchone()
    if row is None:
        db.close()
        raise SystemExit(f"会话不存在: {session_id}")

    sid, agent, model, t_created, t_updated, sess_cost = row
    # model 字段可能是 dict 或 JSON 字符串，统一提取 id（如 deepseek-flash）
    model_str = ""
    if isinstance(model, dict):
        model_str = model.get("id", "") or str(model)
    elif model:
        try:
            mdict = json.loads(model)
            if isinstance(mdict, dict):
                model_str = mdict.get("id", "") or str(model)
            else:
                model_str = str(mdict)
        except (json.JSONDecodeError, TypeError):
            model_str = str(model)

    tier = _model_tier(model_str)
    if tier not in tiers:
        tier = next(iter(tiers))

    # 消息（API 请求）与 token 汇总
    msgs = cur.execute(
        "SELECT m.data, m.time_created FROM message m WHERE m.session_id = ?", (session_id,)
    ).fetchall()

    req_count = 0
    total_in = total_hit = total_out = 0
    finish_counter = Counter()
    total_peak_cost = total_offpeak_cost = 0.0
    peak_reqs = offpeak_reqs = 0
    for (data, mts) in msgs:
        d = json.loads(data)
        t = d.get("tokens", {})
        if not t:
            continue
        req_count += 1
        total_in += t.get("input", 0)
        total_hit += t.get("cache", {}).get("read", 0)
        total_out += t.get("output", 0)
        tier_price = tiers[tier]["peak" if _is_peak(mts, peak_hours) else "offpeak"]
        c = t.get("input", 0) / 1e6 * tier_price["miss"] + t.get("cache", {}).get("read", 0) / 1e6 * tier_price["hit"] + t.get("output", 0) / 1e6 * tier_price["out"]
        if _is_peak(mts, peak_hours):
            total_peak_cost += c
            peak_reqs += 1
        else:
            total_offpeak_cost += c
            offpeak_reqs += 1
        finish = d.get("finish", "")
        if finish:
            finish_counter[finish] += 1

    # 工具调用统计
    parts = cur.execute(
        """SELECT p.data FROM part p WHERE p.session_id = ?
           AND json_extract(p.data, '$.type') = 'tool'""",
        (session_id,),
    ).fetchall()

    tool_counter = Counter()
    tool_error = Counter()
    for (pdata,) in parts:
        d = json.loads(pdata)
        tool = d.get("tool", "?")
        tool_counter[tool] += 1
        if d.get("state", {}).get("status") == "error":
            tool_error[tool] += 1

    # 花费估算
    cost = total_peak_cost + total_offpeak_cost

    # 时长
    start_dt = _fmt_ts(t_created)
    end_dt = _fmt_ts(t_updated) if t_updated else None
    duration_s = None
    if start_dt and end_dt:
        duration_s = int((end_dt - start_dt).total_seconds())

    db.close()
    return {
        "session_id": sid,
        "agent": agent,
        "model": model_str,
        "tier": tier,
        "created": start_dt.strftime("%Y-%m-%d %H:%M:%S") if start_dt else None,
        "duration_s": duration_s,
        "session_cost_field": sess_cost,
        "api_requests": req_count,
        "total_messages": len(msgs),
        "tokens": {"input": total_in, "cache_read": total_hit, "output": total_out},
        "cache_hit_rate": (total_hit / (total_in + total_hit)) if (total_in + total_hit) else None,
        "cost_estimate": cost,
        "cost_detail": {
            "peak": round(total_peak_cost, 4),
            "offpeak": round(total_offpeak_cost, 4),
            "peak_requests": peak_reqs,
            "offpeak_requests": offpeak_reqs,
        },
        "tool_calls": len(parts),
        "tools": dict(tool_counter.most_common()),
        "tool_errors": dict(tool_error.most_common()),
        "finish_reasons": dict(finish_counter.most_common()),
    }


def _fmt_num(n):
    return f"{n:,}"


def render_text(s):
    """文本输出。"""
    lines = []
    lines.append(f"===== 会话统计: {s['session_id']} =====")
    lines.append(f"agent: {s['agent']}  model: {s['model']}  (档位: {s['tier']})")
    lines.append(f"创建时间: {s['created']}")
    if s["duration_s"] is not None:
        m, sec = divmod(s["duration_s"], 60)
        lines.append(f"耗时: {m} 分 {sec} 秒")
    lines.append("")
    lines.append(f"API 请求数: {s['api_requests']}  (总消息: {s['total_messages']})")
    lines.append("Token 统计:")
    lines.append(f"  input(未命中): {_fmt_num(s['tokens']['input'])}")
    lines.append(f"  cache_read(命中): {_fmt_num(s['tokens']['cache_read'])}")
    lines.append(f"  output: {_fmt_num(s['tokens']['output'])}")
    if s["cache_hit_rate"] is not None:
        lines.append(f"  缓存命中率: {s['cache_hit_rate'] * 100:.1f}%")
    lines.append("")
    lines.append(f"花费估算({s['tier']}计价): ¥{s['cost_estimate']:.4f}")
    if s.get("cost_detail"):
        cd = s["cost_detail"]
        lines.append(f"  高峰 {cd['peak_requests']} 请求 ¥{cd['peak']:.4f} | 空闲 {cd['offpeak_requests']} 请求 ¥{cd['offpeak']:.4f}")
    if s["session_cost_field"] is not None:
        lines.append(f"(OpenCode cost 字段: {s['session_cost_field']:.6f})")
    lines.append("")
    lines.append(f"工具调用统计 ({s['tool_calls']}):")
    if s["tools"]:
        for tool, cnt in s["tools"].items():
            err = f"  (错误 {s['tool_errors'].get(tool, 0)})" if tool in s["tool_errors"] else ""
            lines.append(f"  {tool:32s} {cnt}{err}")
    else:
        lines.append("  (无)")
    if s["finish_reasons"]:
        lines.append("")
        lines.append(f"finish 原因: {dict(s['finish_reasons'])}")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="查询 OpenCode 会话统计")
    parser.add_argument("session_id", help="会话 ID")
    parser.add_argument("--json", action="store_true", help="输出 JSON")
    parser.add_argument("--db", help="opencode.db 路径（缺省读 OPENCODE_DB 或平台默认）")
    parser.add_argument("--price-file", default=os.environ.get("SESSION_STATS_PRICE_FILE"),
                        help="价格表 JSON 路径（缺省用内置示例价格）")
    args = parser.parse_args()

    tiers, peak_hours = load_price_table(args.price_file)
    s = query_session(args.session_id, db_path=args.db, price=tiers,
                      peak_hours=peak_hours)
    if args.json:
        print(json.dumps(s, ensure_ascii=False, indent=2))
    else:
        print(render_text(s))


if __name__ == "__main__":
    main()
