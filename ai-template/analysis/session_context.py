#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""子会话上下文读取工具 (session_context.py)

审计辅助: 通过 opencode.db (sqlite, 只读) 列出主会话派生的子智能体会话,
并导出选定会话的处理时间线, 用于审计"子智能体实际怎么干的"。

数据链路: session.parent_id = 主会话id 的行即子智能体会话;
  session(会话元信息) + message(轮次/tokens) + part(text/reasoning/tool)。

用法:
  python analysis/session_context.py --list --since 3d
  python analysis/session_context.py --list --since 2026-01-01 --until 2026-01-02 --agent data-checker
  python analysis/session_context.py --session-id ses_xxx --keep-tools bash
  python analysis/session_context.py --session-id ses_xxx --notifications   # 只抽已发通知原文
  python analysis/session_context.py --selftest

裁剪规则:
  - 默认工具 output 超 --max-out (500字) 裁为 头60%+尾40% + 裁剪标记
  - --keep-tools bash,rg  这些工具不裁剪 (审计要靠 bash 全文分析: 命令是否频繁报错/不会用)
  - 通知类工具 (含 notification) 永不裁剪 —— 它的 input 就是要核的真实通知原文
  - --no-trim 全不裁 (--max-chars 总预算仍生效)

退出码: 0 成功 / 1 会话未找到 / 2 用法或依赖错误 / 3 输出超总预算
"""

import argparse
import json
import os
import re
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

# 跨平台解析: 优先环境变量 OPENCODE_DB, 否则按当前用户数据目录（Windows/Linux 通用）
def _default_db_path():
    env = os.environ.get("OPENCODE_DB")
    if env:
        return env
    if os.name == "nt":
        return os.path.expanduser(r"~\.local\share\opencode\opencode.db")
    # Linux/macOS: 遵循 XDG_DATA_HOME
    xdg = os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")
    return os.path.join(xdg, "opencode", "opencode.db")

DB_DEFAULT = _default_db_path()
_AI_ROOT = Path(__file__).resolve().parent.parent
CHATLOG_CACHE = _AI_ROOT / "memory" / "self" / "chatlog_sessions.json"

MAX_OUT_DEFAULT = 500          # 单个工具 output 裁剪阈值 (字)
MAX_CHARS_DEFAULT = 120000     # 总输出预算
THINK_HEAD = 200               # reasoning 默认保留头 (字)
INPUT_VALUE_CAP = 160          # state.input 单值展示上限

# 输出编码: Windows 控制台 GBK 会炸中文, 统一 utf-8
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


# ---------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------

def _open_ro(db_path):
    """只读打开 sqlite; 失败抛 SystemExit(2)。WAL 下读不阻塞写。"""
    if not os.path.exists(db_path):
        print(f"错误: 数据库不存在: {db_path}", file=sys.stderr)
        sys.exit(2)
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5)
        con.execute("SELECT 1 FROM session LIMIT 1")
        return con
    except sqlite3.Error as e:
        print(f"错误: 无法读取数据库: {e}", file=sys.stderr)
        sys.exit(2)


def _resolve_parent(parent_arg, cache_path=CHATLOG_CACHE):
    """解析主会话ID: 'auto' 读 chatlog_sessions.json 的 main_history 最后一项。"""
    if parent_arg and parent_arg != "auto":
        return parent_arg
    try:
        cache = json.loads(Path(cache_path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        print(f"错误: 无法读取会话缓存 {cache_path}: {e}; 请显式传 --parent-id ses_xxx",
              file=sys.stderr)
        sys.exit(2)
    mh = cache.get("main_history") or []
    if not mh or not mh[-1].get("sid"):
        print("错误: main_history 为空, 无法解析主会话; 请显式传 --parent-id ses_xxx",
              file=sys.stderr)
        sys.exit(2)
    return mh[-1]["sid"]


def _parse_when(s):
    """'3d'/'24h'/'YYYY-MM-DD'/'YYYY-MM-DD HH:MM' -> ms epoch (本地时区)。失败 ValueError。"""
    s = (s or "").strip()
    if not s:
        raise ValueError("空时间")
    m = re.fullmatch(r"(\d+)([dh])", s)
    if m:
        n = int(m.group(1))
        delta = timedelta(days=n) if m.group(2) == "d" else timedelta(hours=n)
        return int((datetime.now() - delta).timestamp() * 1000)
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return int(datetime.strptime(s, fmt).timestamp() * 1000)
        except ValueError:
            continue
    raise ValueError(f"无法解析时间: {s}")


def _agent_from_title(title, agent_col):
    """标题 '@data-checker subagent' 提取 agent; 失败回退 session.agent 列。"""
    m = re.search(r"@([A-Za-z0-9_.-]+)\s+subagent", title or "")
    return m.group(1) if m else (agent_col or "-")


def _fmt_dt(ms, with_date=True):
    dt = datetime.fromtimestamp(ms / 1000)
    return dt.strftime("%Y-%m-%d %H:%M:%S" if with_date else "%H:%M:%S")


def _fmt_dur(ms_start, ms_end):
    secs = max(0, (ms_end - ms_start) // 1000)
    if secs >= 3600:
        return f"{secs // 3600}h{(secs % 3600) // 60:02d}m"
    return f"{secs // 60}m"


# ---------------------------------------------------------------
# 裁剪 (核心)
# ---------------------------------------------------------------

def _norm_keep(keep_tools, no_trim, warn_out=None):
    """归一化保留集合: 小写; grep/rg 互为别名; 未知名提示不报错。
    no_trim=True → 返回 None 表示全保留。"""
    if no_trim:
        return None
    names = set()
    for raw in (keep_tools or "").split(","):
        n = raw.strip().lower()
        if not n:
            continue
        names.add(n)
        if n in ("grep", "rg"):
            names.update(("grep", "rg"))
    return names


def _is_kept(tool_name, keep_set):
    """keep_set=None → 全保留; 否则按小写匹配。通知类永不裁剪。"""
    t = (tool_name or "").lower()
    if "notification" in t:
        return True
    if keep_set is None:
        return True
    return t in keep_set


def _trim_text(text, limit, keep):
    """返回 (rendered, n_trimmed)。keep=True 或未超限 → 原文。"""
    if text is None:
        return "", 0
    text = str(text)
    if keep or len(text) <= limit:
        return text, 0
    if limit <= 0:
        return "", len(text)
    head = max(1, int(limit * 0.6))
    tail = max(1, limit - head)
    cut = len(text) - head - tail
    rendered = f"{text[:head]}\n[...裁剪 {cut} 字...]\n{text[-tail:]}"
    return rendered, cut


def _tool_input_brief(state_input):
    """state.input 压成一行 k=v (单值 160 字)。"""
    if not isinstance(state_input, dict):
        return str(state_input)[:INPUT_VALUE_CAP] if state_input else ""
    parts = []
    for k, v in state_input.items():
        s = str(v).replace("\n", " ")
        if len(s) > INPUT_VALUE_CAP:
            s = s[:INPUT_VALUE_CAP] + "…"
        parts.append(f"{k}={s}")
    return " ".join(parts)


# ---------------------------------------------------------------
# 查询
# ---------------------------------------------------------------

def list_children(con, parent, since_ms=None, until_ms=None, agents=None):
    """主会话的子会话列表, 按创建时间倒序。agents=小写子串集合。"""
    sql = ("SELECT id, title, agent, time_created, time_updated, "
           "tokens_input, tokens_output FROM session WHERE parent_id=?")
    args = [parent]
    if since_ms:
        sql += " AND time_created>=?"
        args.append(since_ms)
    if until_ms:
        sql += " AND time_created<?"
        args.append(until_ms)
    sql += " ORDER BY time_created DESC"
    rows = []
    for r in con.execute(sql, args):
        agent = _agent_from_title(r[1], r[2])
        if agents and not any(a in agent.lower() for a in agents):
            continue
        rows.append({
            "id": r[0], "title": r[1] or "", "agent": agent,
            "created": r[3], "updated": r[4],
            "tokens_input": r[5] or 0, "tokens_output": r[6] or 0,
        })
    return rows


def get_session(con, sid):
    r = con.execute(
        "SELECT id, title, agent, time_created, time_updated, tokens_input, "
        "tokens_output, tokens_reasoning FROM session WHERE id=?", (sid,)).fetchone()
    if not r:
        return None
    return {"id": r[0], "title": r[1] or "", "agent": _agent_from_title(r[1], r[2]),
            "created": r[3], "updated": r[4], "tokens_input": r[5] or 0,
            "tokens_output": r[6] or 0, "tokens_reasoning": r[7] or 0}


def load_parts(con, sid, start_ms=None, end_ms=None):
    """按 (time_created, id) 升序取 part, 附 message.role。"""
    sql = ("SELECT p.time_created, p.id, p.data, json_extract(m.data,'$.role') "
           "FROM part p JOIN message m ON m.id=p.message_id "
           "WHERE p.session_id=?")
    args = [sid]
    if start_ms:
        sql += " AND p.time_created>=?"
        args.append(start_ms)
    if end_ms:
        sql += " AND p.time_created<?"
        args.append(end_ms)
    sql += " ORDER BY p.time_created, p.id"
    out = []
    for tc, _pid, data, role in con.execute(sql, args):
        try:
            pd = json.loads(data)
        except (json.JSONDecodeError, TypeError):
            continue
        out.append({"t": tc, "role": role or "?", "data": pd})
    return out


def count_messages(con, sid):
    return con.execute("SELECT COUNT(*) FROM message WHERE session_id=?", (sid,)).fetchone()[0]


def extract_notifications(parts):
    """抽通知类 tool part 的真实 input (title/content), 完整不裁。
    真实结构: input.params 为 JSON 字符串 {"title":..,"content":..} 或已解析的 dict;
    测试/旧数据也可能直接是 {"title","content"} — 三种都兼容。"""
    out = []
    for p in parts:
        d = p["data"]
        if d.get("type") != "tool":
            continue
        tool = str(d.get("tool", ""))
        if "notification" not in tool.lower():
            continue
        st = d.get("state") or {}
        inp = st.get("input") or {}
        title = inp.get("title", "")
        content = inp.get("content", "")
        # 兼容 params 嵌套 (ai-mcp_send_notification 实际形状):
        # ① JSON 字符串 ② 已解析的 dict ③ 无 params 的平铺
        if (not title and not content) or "params" in inp:
            inner = inp.get("params")
            if isinstance(inner, str):
                try:
                    inner = json.loads(inner)
                except (json.JSONDecodeError, TypeError):
                    inner = None
            if isinstance(inner, dict):
                title = inner.get("title", title)
                content = inner.get("content", content)
        out.append({
            "t": p["t"], "tool": tool,
            "title": title,
            "content": content,
            "status": st.get("status", ""),
        })
    return out


# ---------------------------------------------------------------
# 渲染
# ---------------------------------------------------------------

def render_list(rows, parent, since_desc, until_desc, agent_desc, fmt="text"):
    if fmt == "json":
        return json.dumps({
            "parent": parent, "since": since_desc, "until": until_desc,
            "agent": agent_desc, "count": len(rows), "sessions": rows,
        }, ensure_ascii=False, indent=2)
    lines = ["== 子会话列表 =="]
    cond = f"since={since_desc or '-'}" + (f" until={until_desc}" if until_desc else "")
    cond += f" agent={agent_desc or '全部'}"
    lines.append(f"主会话: {parent} | 条件: {cond} | 命中 {len(rows)} 个")
    lines.append("")
    if not rows:
        lines.append("无命中")
        return "\n".join(lines)
    lines.append(f"{'创建时间':<19}  {'会话ID':<31} {'智能体':<16} {'用量(入+出)':<22} {'时长':>6}  标题")
    for r in rows:
        dur = _fmt_dur(r["created"], r["updated"])
        tok = f"{r['tokens_input']}+{r['tokens_output']}"
        lines.append(f"{_fmt_dt(r['created']):<19}  {r['id']:<31} {r['agent']:<16} "
                     f"{tok:<22} {dur:>6}  {r['title'][:70]}")
    lines.append("")
    lines.append(f"共 {len(rows)} 个子会话; 查看处理过程: "
                 "python analysis/session_context.py --session-id <会话ID>")
    return "\n".join(lines)


def render_timeline(sess, parts, args, keep_set, fmt="text"):
    """渲染时间线。返回 (text, over_budget)。"""
    budget = args.max_chars
    notif_mode = getattr(args, "notifications", False)

    if notif_mode:
        notis = extract_notifications(parts)
        head = [f"== 会话通知原文 ({len(notis)} 条) ==",
                f"会话: {sess['id']}  标题: {sess['title']}", ""]
        if not notis:
            head.append("本会话无通知类工具调用")
            return "\n".join(head), False
        blocks = []
        for n in notis:
            blocks.append(f"[{_fmt_dt(n['t'], False)}] [通知] {n['tool']} status={n['status']}")
            blocks.append(f"  title: {n['title']}")
            blocks.append("  content:")
            for ln in str(n["content"]).splitlines() or [""]:
                blocks.append(f"    {ln}")
            blocks.append("")
        text = "\n".join(head + blocks)
        if len(text) > budget:
            return text[:budget] + f"\n[输出超预算截断, 原 {len(text)} 字]", True
        return text, False

    hit_desc = "不裁剪" if keep_set is None else (
        ",".join(sorted(keep_set)) if keep_set else f"默认{args.max_out}字")

    head = ["== 子会话上下文 ==",
            f"会话: {sess['id']}  标题: {sess['title']}",
            f"时间: {_fmt_dt(sess['created'])} ~ {_fmt_dt(sess['updated'])}  "
            f"时长 {_fmt_dur(sess['created'], sess['updated'])}  "
            f"用量 入{sess['tokens_input']}/出{sess['tokens_output']}  "
            f"消息 {count_messages(_CTX_CON, sess['id'])}  parts {len(parts)}",
            f"裁剪: 工具output>{args.max_out}字裁头尾 | 保留全文: {hit_desc or '无'} "
            f"(通知类恒为全文)",
            "----- 时间线 -----"]
    body = []
    over = False
    total = len("\n".join(head))

    def emit(block_lines):
        nonlocal total, over
        if over:
            return
        chunk = "\n".join(block_lines)
        if total + len(chunk) + 1 > budget:
            body.append(f"[输出超预算截断, 已输出 {total} 字; 可用 --start/--end 分段读]")
            over = True
            return
        body.extend(block_lines)
        total += len(chunk) + 1

    for p in parts:
        d = p["data"]
        ts = f"[{_fmt_dt(p['t'], False)}]"
        ptype = d.get("type")

        if ptype == "text":
            role = p["role"]
            tag = "user" if role == "user" else "assistant text"
            lines = [f"{ts} [{tag}]"]
            for ln in str(d.get("text", "")).splitlines() or [""]:
                lines.append(f"  {ln}")
            emit(lines)

        elif ptype == "reasoning":
            txt = str(d.get("text", ""))
            if args.full_reasoning:
                shown, cut = txt, 0
            else:
                if len(txt) > THINK_HEAD:
                    shown = txt[:THINK_HEAD] + f" […思考省略{len(txt) - THINK_HEAD}字]"
                else:
                    shown = txt
            emit([f"{ts} [thinking] {shown}"])

        elif ptype == "tool":
            tool = str(d.get("tool", ""))
            st = d.get("state") or {}
            status = st.get("status", "?")
            title = st.get("title") or _tool_input_brief(st.get("input"))
            header = f"{ts} [tool] {tool}  {title}"
            lines = [header]
            inp = st.get("input")
            if inp:
                lines.append(f"  input: {_tool_input_brief(inp)}")
            if status == "error":
                err, _ = _trim_text(str(st.get("error", "")), args.max_out,
                                    _is_kept(tool, keep_set))
                lines.append("  状态: error")
                for ln in (err or "(无 error 字段)").splitlines():
                    lines.append(f"    | {ln}")
            elif "output" in st or st.get("output") is not None:
                kept = _is_kept(tool, keep_set)
                out_str = str(st.get("output") or "")
                pre = st.get("metadata") or {}
                rendered, cut = _trim_text(out_str, args.max_out, kept)
                if kept:
                    mark = f"output[不裁剪{', exit=' + str(pre['exit']) if 'exit' in pre else ''}]（{len(out_str)}字）:"
                elif cut:
                    mark = f"output[裁剪 {len(out_str)}→{args.max_out}]:"
                else:
                    mark = f"output[{len(out_str)}字]:"
                if pre.get("truncated") is True:
                    mark = "output[opencode已截断]: " + mark.split(":", 1)[-1].strip()
                lines.append(f"  {mark}")
                for ln in rendered.splitlines():
                    lines.append(f"    | {ln}")
            emit(lines)

        elif ptype == "step-finish":
            reason = d.get("reason", "")
            toks = d.get("tokens") or {}
            emit([f"{ts} [step] finish reason={reason} "
                  f"tokens_total={toks.get('total', '-')}"])

    n_types = {}
    for p in parts:
        n_types[p["data"].get("type", "?")] = n_types.get(p["data"].get("type", "?"), 0) + 1
    foot = ["", "----- 小结 -----",
            "parts: " + " / ".join(f"{k} {v}" for k, v in sorted(n_types.items())),
            "提示: 大输出已裁剪; --keep-tools bash 保留命令全文; "
            "--notifications 只抽通知原文; --start/--end 分段读"]
    return "\n".join(head + body + foot), over


# 渲染时需要连数据库计数消息 —— 模块级上下文 (main 里赋值; 测试直接注入)
_CTX_CON = None


# ---------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------

def main(argv=None):
    parser = argparse.ArgumentParser(description="子会话上下文读取 (审计辅助)")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--list", action="store_true", help="列出主会话的子智能体会话")
    mode.add_argument("--session-id", help="导出该会话处理时间线")
    mode.add_argument("--selftest", action="store_true", help="运行内置测试后退出")
    parser.add_argument("--parent-id", default="auto",
                        help="主会话ID, auto=读 chatlog_sessions.json (默认 auto)")
    parser.add_argument("--since", default=None,
                        help="列表时间过滤: 3d / 24h / YYYY-MM-DD [HH:MM] (默认 3d)")
    parser.add_argument("--until", default=None, help="列表时间上界, 格式同 --since")
    parser.add_argument("--agent", default=None, help="按智能体子串过滤, 逗号分隔")
    parser.add_argument("--start", default=None, help="时间线内起始时间过滤")
    parser.add_argument("--end", default=None, help="时间线内结束时间过滤")
    parser.add_argument("--max-out", type=int, default=MAX_OUT_DEFAULT,
                        help=f"单工具output裁剪阈值字数 (默认 {MAX_OUT_DEFAULT})")
    parser.add_argument("--keep-tools", default="",
                        help="不裁剪的工具名, 逗号分隔 (如 bash,rg); 通知类恒不裁")
    parser.add_argument("--no-trim", action="store_true", help="全部不裁剪")
    parser.add_argument("--full-reasoning", action="store_true", help="思考全文输出")
    parser.add_argument("--notifications", action="store_true",
                        help="只导出该会话发出的通知原文 (配合 --session-id)")
    parser.add_argument("--max-chars", type=int, default=MAX_CHARS_DEFAULT,
                        help=f"总输出预算, 超出退出码3 (默认 {MAX_CHARS_DEFAULT})")
    parser.add_argument("--format", default="text", choices=["text", "json"])
    parser.add_argument("--db", default=DB_DEFAULT, help="opencode.db 路径")
    args = parser.parse_args(argv)

    if args.selftest:
        return _run_selftest()
    if args.notifications and not args.session_id:
        print("错误: --notifications 需配合 --session-id", file=sys.stderr)
        return 2
    if args.max_out < 0 or args.max_chars <= 0:
        print("错误: --max-out 须>=0, --max-chars 须>0", file=sys.stderr)
        return 2

    keep_set = _norm_keep(args.keep_tools, args.no_trim)
    con = _open_ro(args.db)
    global _CTX_CON
    _CTX_CON = con

    # ---- 列表模式 ----
    if args.list:
        parent = _resolve_parent(args.parent_id)
        since_ms = until_ms = None
        since_desc = args.since or "3d"
        try:
            since_ms = _parse_when(since_desc)
            if args.until:
                until_ms = _parse_when(args.until)
        except ValueError as e:
            print(f"错误: {e}", file=sys.stderr)
            return 2
        agents = {a.strip().lower() for a in args.agent.split(",") if a.strip()} if args.agent else None
        rows = list_children(con, parent, since_ms, until_ms, agents)
        until_desc = args.until or "-"
        print(render_list(rows, parent, since_desc, until_desc,
                          args.agent or "", args.format))
        return 0

    # ---- 时间线模式 ----
    sess = get_session(con, args.session_id)
    if not sess:
        print(f"未找到会话 {args.session_id} (用 --list 核对ID)", file=sys.stderr)
        return 1
    start_ms = end_ms = None
    try:
        if args.start:
            start_ms = _parse_when(args.start)
        if args.end:
            end_ms = _parse_when(args.end)
    except ValueError as e:
        print(f"错误: {e}", file=sys.stderr)
        return 2
    parts = load_parts(con, sess["id"], start_ms, end_ms)

    if args.format == "json":
        notis = extract_notifications(parts) if args.notifications else None
        payload = {"session": sess, "parts_count": len(parts)}
        if notis is not None:
            payload["notifications"] = notis
        else:
            payload["parts"] = [
                {"t": _fmt_dt(p["t"]), "role": p["role"],
                 "type": p["data"].get("type"),
                 "tool": p["data"].get("tool"),
                 "text": p["data"].get("text"),
                 "state": {k: v for k, v in (p["data"].get("state") or {}).items()
                           if k in ("status", "title", "input", "output", "error")}}
                for p in parts]
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    text, over = render_timeline(sess, parts, args, keep_set, "text")
    print(text)
    return 3 if over else 0


# ---------------------------------------------------------------
# 内置测试 (--selftest)
# ---------------------------------------------------------------

def _seed_db(path):
    """造一个最小 opencode.db 形状的库。"""
    con = sqlite3.connect(path)
    con.executescript("""
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT,
      slug TEXT, directory TEXT, title TEXT, version TEXT, share_url TEXT,
      summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
      summary_diffs TEXT, revert TEXT, permission TEXT,
      time_created INTEGER, time_updated INTEGER, time_compacting INTEGER,
      time_archived INTEGER, workspace_id TEXT, path TEXT, agent TEXT, model TEXT,
      cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
      tokens_cache_read INTEGER, tokens_cache_write INTEGER, metadata TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER,
      time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT,
      time_created INTEGER, time_updated INTEGER, data TEXT);
    """)
    base = 1790000000000
    con.execute("INSERT INTO session (id,parent_id,title,agent,time_created,time_updated,"
                "tokens_input,tokens_output,tokens_reasoning,tokens_cache_read,"
                "tokens_cache_write,cost,project_id,slug,directory,version) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,0,'p','s','d','v')",
                ("ses_child1", "ses_main",
                 "Data check demo (@data-checker subagent)",
                 "data-checker", base, base + 60000, 1000, 200, 30, 5000, 100))
    con.execute("INSERT INTO session (id,parent_id,title,agent,time_created,time_updated,"
                "tokens_input,tokens_output,tokens_reasoning,tokens_cache_read,"
                "tokens_cache_write,cost,project_id,slug,directory,version) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,0,'p','s','d','v')",
                ("ses_child2", "ses_main",
                 "Daily review demo (@reviewer subagent)",
                 "reviewer", base + 86400000, base + 86400000 + 30000,
                 900, 400, 50, 8000, 200))
    con.execute("INSERT INTO session (id,parent_id,title,agent,time_created,time_updated,"
                "tokens_input,tokens_output,tokens_reasoning,tokens_cache_read,"
                "tokens_cache_write,cost,project_id,slug,directory,version) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,0,'p','s','d','v')",
                ("ses_main", None, "主会话", "main-task", base, base, 0, 0, 0, 0, 0))
    con.execute("INSERT INTO message VALUES ('m1','ses_child1',?,?,?)",
                (base + 1000, base + 1000,
                 json.dumps({"role": "user", "tokens": {"total": 100}})))
    con.execute("INSERT INTO message VALUES ('m2','ses_child1',?,?,?)",
                (base + 2000, base + 2000,
                 json.dumps({"role": "assistant",
                             "tokens": {"total": 345678, "input": 100, "output": 50,
                                        "reasoning": 10, "cache": {"read": 345000, "write": 0}}})))
    con.execute("INSERT INTO part VALUES ('p1','m1','ses_child1',?,?,?)",
                (base + 1000, base + 1000, json.dumps({"type": "text", "text": "执行批次"})))
    big = "X" * 5000
    con.execute("INSERT INTO part VALUES ('p2','m2','ses_child1',?,?,?)",
                (base + 2000, base + 2000,
                 json.dumps({"type": "tool", "tool": "read", "callID": "c1",
                             "state": {"status": "completed",
                                       "input": {"filePath": "data/x.md"},
                                       "output": big,
                                       "metadata": {"preview": "p"}}})))
    con.execute("INSERT INTO part VALUES ('p3','m2','ses_child1',?,?,?)",
                (base + 3000, base + 3000,
                 json.dumps({"type": "tool", "tool": "bash", "callID": "c2",
                             "state": {"status": "completed",
                                       "input": {"command": "python t.py"},
                                       "output": "Y" * 4000,
                                       "metadata": {"exit": 0}}})))
    con.execute("INSERT INTO part VALUES ('p4','m2','ses_child1',?,?,?)",
                (base + 4000, base + 4000,
                 json.dumps({"type": "tool", "tool": "ai-mcp_send_notification",
                             "callID": "c3",
                             "state": {"status": "completed",
                                        "input": {"params": json.dumps(
                                            {"title": "测试通知",
                                             "content": "第一段。\n\n第二段。"},
                                           ensure_ascii=False)},
                                       "output": "ok"}})))
    con.execute("INSERT INTO part VALUES ('p5','m2','ses_child1',?,?,?)",
                (base + 5000, base + 5000,
                 json.dumps({"type": "tool", "tool": "read", "callID": "c4",
                             "state": {"status": "error", "error": "ENOENT 文件不存在",
                                       "input": {"filePath": "nope.md"}}})))
    con.execute("INSERT INTO part VALUES ('p6','m2','ses_child1',?,?,?)",
                (base + 6000, base + 6000, json.dumps({"type": "step-finish",
                                                        "reason": "stop",
                                                        "tokens": {"total": 345678}})))
    con.commit()
    con.close()
    return base


class _TrimCases(unittest.TestCase):
    def test_under_limit_no_cut(self):
        self.assertEqual(_trim_text("hello", 500, False), ("hello", 0))

    def test_head_tail_split(self):
        text = "A" * 400 + "B" * 400
        rendered, cut = _trim_text(text, 500, False)
        self.assertEqual(cut, 300)  # 800-500
        self.assertIn("[...裁剪 300 字...]", rendered)
        self.assertEqual(len("A" * 400), 400)

    def test_keep_flag_passthrough(self):
        self.assertEqual(_trim_text("Z" * 9999, 10, True), ("Z" * 9999, 0))

    def test_limit_zero(self):
        rendered, cut = _trim_text("abcdef", 0, False)
        self.assertEqual(cut, 6)

    def test_keep_set_alias_case(self):
        ks = _norm_keep("BASH,Rg", False)
        self.assertIn("bash", ks)
        self.assertIn("rg", ks)
        self.assertIn("grep", ks)  # 别名
        self.assertTrue(_is_kept("Bash", ks))

    def test_no_trim_means_all(self):
        ks = _norm_keep("", True)
        self.assertIsNone(ks)
        self.assertTrue(_is_kept("anything", ks))

    def test_notification_never_trimmed(self):
        ks = _norm_keep("", False)
        self.assertTrue(_is_kept("ai-mcp_send_notification", ks))

    def test_unknown_keep_name_harmless(self):
        ks = _norm_keep("nonexistent_tool", False)
        self.assertIn("nonexistent_tool", ks)


class _ParseCases(unittest.TestCase):
    def test_since_days_hours(self):
        now = datetime.now().timestamp() * 1000
        self.assertAlmostEqual(_parse_when("3d"), now - 3 * 86400000, delta=60000)
        self.assertAlmostEqual(_parse_when("24h"), now - 86400000, delta=60000)

    def test_absolute_datetime(self):
        expect = int(datetime.strptime("2026-01-01 18:00", "%Y-%m-%d %H:%M").timestamp() * 1000)
        self.assertEqual(_parse_when("2026-01-01 18:00"), expect)
        expect2 = int(datetime.strptime("2026-01-01", "%Y-%m-%d").timestamp() * 1000)
        self.assertEqual(_parse_when("2026-01-01"), expect2)

    def test_illegal_raises(self):
        with self.assertRaises(ValueError):
            _parse_when("yesterday")

    def test_agent_regex_and_fallback(self):
        self.assertEqual(_agent_from_title("X (@data-checker subagent)", "col"),
                         "data-checker")
        self.assertEqual(_agent_from_title("无标记标题", "reviewer"), "reviewer")
        self.assertEqual(_agent_from_title("", None), "-")


class _IntegrationCases(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp(prefix="sctx_")
        cls.db = os.path.join(cls.dir, "opencode.db")
        cls.base = _seed_db(cls.db)

    def test_list_time_and_agent_filter(self):
        con = _open_ro(self.db)
        rows = list_children(con, "ses_main",
                             since_ms=self.base + 43200000)  # 半天后
        self.assertEqual([r["id"] for r in rows], ["ses_child2"])
        rows2 = list_children(con, "ses_main", agents={"data-checker"})
        self.assertEqual([r["id"] for r in rows2], ["ses_child1"])
        self.assertEqual(rows2[0]["agent"], "data-checker")
        con.close()

    def test_list_empty_ok(self):
        con = _open_ro(self.db)
        rows = list_children(con, "ses_nobody")
        self.assertEqual(rows, [])
        con.close()

    def test_json_list_valid(self):
        con = _open_ro(self.db)
        rows = list_children(con, "ses_main")
        txt = render_list(rows, "ses_main", "3d", "-", "", "json")
        data = json.loads(txt)
        self.assertEqual(data["count"], 2)
        con.close()

    def test_timeline_trim_and_keep(self):
        global _CTX_CON
        con = _open_ro(self.db)
        _CTX_CON = con
        sess = get_session(con, "ses_child1")
        parts = load_parts(con, "ses_child1")
        self.assertEqual(parts[0]["data"]["type"], "text")  # 时序正确
        args = argparse.Namespace(max_out=500, full_reasoning=False,
                                  notifications=False, max_chars=120000)
        ks = _norm_keep("bash", False)   # 只保留 bash
        text, over = render_timeline(sess, parts, args, ks)
        self.assertFalse(over)
        self.assertIn("[裁剪 5000→500]", text)      # read 被裁
        self.assertIn("不裁剪", text)                # bash 未裁 (keep)
        self.assertIn("Y" * 4000, text)              # bash 全文在
        self.assertIn("第一段。", text)               # 通知 content 全文
        self.assertIn("ENOENT", text)                # error part 渲染
        ks_default = _norm_keep("", False)
        text2, _ = render_timeline(sess, parts, args, ks_default)
        self.assertNotIn("Y" * 4000, text2)          # 默认 bash 也被裁
        self.assertIn("[裁剪 4000→500]", text2)
        con.close()

    def test_notifications_extract(self):
        con = _open_ro(self.db)
        parts = load_parts(con, "ses_child1")
        notis = extract_notifications(parts)
        self.assertEqual(len(notis), 1)
        self.assertEqual(notis[0]["title"], "测试通知")
        self.assertIn("第二段", notis[0]["content"])
        con.close()

    def test_notifications_params_dict(self):
        # 真实数据形态: input.params 为已解析 dict (非 JSON 字符串) — 09-25 08 批实测
        parts = [{"t": "08:20", "data": {
            "type": "tool", "tool": "ai-mcp_send_notification",
            "state": {"status": "completed",
                      "input": {"params": {"title": "测试通知 | 06:00~08:00",
                                           "content": "第一段。\n\n第二段。"}},
                      "output": "通知已发送"}}}]
        notis = extract_notifications(parts)
        self.assertEqual(len(notis), 1)
        self.assertEqual(notis[0]["title"], "测试通知 | 06:00~08:00")
        self.assertIn("第二段", notis[0]["content"])
        # 平铺直给形态仍兼容
        parts2 = [{"t": "08:20", "data": {
            "type": "tool", "tool": "ai-mcp_send_notification",
            "state": {"status": "completed",
                      "input": {"title": "T2", "content": "C2"}}}}]
        self.assertEqual(extract_notifications(parts2)[0]["title"], "T2")

    def test_budget_cut_exit_flag(self):
        global _CTX_CON
        con = _open_ro(self.db)
        _CTX_CON = con
        sess = get_session(con, "ses_child1")
        parts = load_parts(con, "ses_child1")
        args = argparse.Namespace(max_out=500000, full_reasoning=True,
                                  notifications=False, max_chars=800)
        _text, over = render_timeline(sess, parts, args, None)
        self.assertTrue(over)
        con.close()

    def test_session_not_found(self):
        rc = main(["--session-id", "ses_missing", "--db", self.db])
        self.assertEqual(rc, 1)

    def test_missing_db_exit2(self):
        with self.assertRaises(SystemExit) as cm:
            _open_ro(os.path.join(self.dir, "nope.db"))
        self.assertEqual(cm.exception.code, 2)

    def test_mode_conflict_exit2(self):
        with self.assertRaises(SystemExit):
            main(["--list", "--session-id", "x", "--db", self.db])

    def test_notifications_requires_session(self):
        rc = main(["--list", "--notifications", "--db", self.db])
        self.assertEqual(rc, 2)

    def test_parent_auto_missing_file_exit2(self):
        with self.assertRaises(SystemExit) as cm:
            _resolve_parent("auto", cache_path=os.path.join(self.dir, "no.json"))
        self.assertEqual(cm.exception.code, 2)


def _run_selftest():
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()
    suite.addTests(loader.loadTestsFromTestCase(_TrimCases))
    suite.addTests(loader.loadTestsFromTestCase(_ParseCases))
    suite.addTests(loader.loadTestsFromTestCase(_IntegrationCases))
    runner = unittest.TextTestRunner(verbosity=1)
    result = runner.run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
