#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""夜间审计采集器 (audit_collector.py)

系统自审计: 机械检查规范执行情况、待办时效、文件膨胀、调度与数据链路健康。
脚本只产出事实 (格式化文本 + PASS/FAIL/WARN/SKIP 状态), 判断解释由审计子智能体完成。

用法:
    python analysis/audit_collector.py                  # 默认审昨日
    python analysis/audit_collector.py YYYY-MM-DD       # 指定审计目标日
    python analysis/audit_collector.py YYYY-MM-DD --out data/daily/YYYY-MM-DD/audit-YYYY-MM-DD.txt

退出码:
    0 = 无 FAIL (可有 WARN)
    1 = 存在 FAIL
    2 = 脚本自身错误

设计要点:
    - 一个检查项 = 一个函数, 注册进 CHECKS 表, 带判据来源(source)与生效日(effective)
    - scope=historical 的检查审 target 日的历史数据, 判据未生效时输出 SKIP (不拿新规矩审旧数据)
    - scope=current 的检查审"此刻"的系统状态 (待办/膨胀/frontmatter), 不受 effective 约束
    - 判据修改必须同步改 source 注释并单独 commit (防悄悄放水)

依赖: 标准库 + 同目录 check_coverage (复用 voice 管线检查)
"""

import argparse
import json
import os
import re
import sqlite3
import subprocess
import sys
from datetime import datetime, date, timedelta

# 复用同目录 check_coverage 的 voice 检查
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _SCRIPT_DIR)
try:
    from check_coverage import check_voice_pipeline, format_voice_line
except ImportError:  # pragma: no cover
    check_voice_pipeline = None
    format_voice_line = None

# opencode.db 路径单一真源在 session_context.py, 此处兜底
try:
    from session_context import DB_DEFAULT as OPENCODE_DB
except ImportError:  # pragma: no cover
    import os as _os
    _xdg = _os.environ.get("XDG_DATA_HOME") or _os.path.expanduser("~/.local/share")
    OPENCODE_DB = _os.path.join(_xdg, "opencode", "opencode.db")

AI_ROOT = os.path.normpath(os.path.join(_SCRIPT_DIR, '..'))
REPO_ROOT = os.path.normpath(os.path.join(AI_ROOT, '..'))
AI_REL_PATH = os.path.relpath(AI_ROOT, REPO_ROOT).replace('\\', '/')
DEFAULT_DAILY = os.path.join(AI_ROOT, 'data', 'daily')

# 单文件软上限：300 行 / 20KB，到线按分片键拆；全域生效（含 agents/ 规范文件）
SOFT_LINES = 300
SOFT_BYTES = 20 * 1024

# 膨胀扫描范围 (相对 AI 根), archive/ 排除 (归档区不参与治理)
MEM_SCAN_DIRS = ['agents', 'memory/self', 'memory/profile', 'memory/fact', 'data/tasks']

# 数据检查排班窗口（小时）：与 data/tasks/data_check_scheduler.py 的 7 窗一致。
SCHED_WINDOWS = [0, 6, 8, 12, 16, 20, 22]

# 判据基线日：模板首次启用日。实例应按自己的判据生效日逐项调整。
DEFAULT_EFFECTIVE = '2026-01-01'


class Check:
    """一个检查项的定义"""

    def __init__(self, cid, domain, fn, source, effective, scope='historical'):
        self.id = cid
        self.domain = domain
        self.fn = fn
        self.source = source
        self.effective = effective       # str YYYY-MM-DD
        self.scope = scope               # historical=审target日数据 / current=审当前状态


def _d(s):
    return datetime.strptime(s, '%Y-%m-%d').date()


# ============================================================
# AUD-TODO 待办时效
# ============================================================

def check_todo_anchor(target, **kw):
    """三元锚: 未完成待办是否带 到期/观察至/触发+兜底, 以及是否过期"""
    path = os.path.join(AI_ROOT, 'memory', 'self', '任务.md')
    out = []
    if not os.path.exists(path):
        return [('FAIL', 'AUD-TODO-00 任务.md 不存在')]
    lines = open(path, encoding='utf-8').read().splitlines()
    open_items = [l for l in lines if l.startswith('- [ ]')]
    if not open_items:
        return [('PASS', 'AUD-TODO-01 无未完成待办')]

    today = date.today()
    no_anchor, expired, watch_expired, trigger_due = [], [], [], []
    for l in open_items:
        # 标题: 取前 80 字符做标识
        title = re.sub(r'^- \[ \]\s*', '', l)[:60]
        m_due = re.search(r'到期[:：]\s*(\d{4}-\d{2}-\d{2})', l)
        m_watch = re.search(r'观察至[:：]\s*(\d{4}-\d{2}-\d{2})', l)
        m_trap = re.search(r'兜底[:：]\s*(\d{4}-\d{2}-\d{2})', l)
        if m_due:
            if _d(m_due.group(1)) < today:
                expired.append(f'{title} ... (到期 {m_due.group(1)})')
        elif m_watch:
            if _d(m_watch.group(1)) < today:
                watch_expired.append(f'{title} ... (观察至 {m_watch.group(1)} 已过)')
        elif m_trap:
            if _d(m_trap.group(1)) < today:
                trigger_due.append(f'{title} ... (兜底 {m_trap.group(1)} 已到, 触发条件未满足)')
        else:
            no_anchor.append(title)

    out.append(('FAIL' if no_anchor else 'PASS',
                f'AUD-TODO-01 三元锚缺失: {len(no_anchor)}/{len(open_items)} 条无 到期/观察至/兜底'))
    for t in no_anchor:
        out.append(('FAIL', f'    无锚: {t}'))
    if expired:
        out.append(('FAIL', f'AUD-TODO-02 已过期未销: {len(expired)} 条'))
        for t in expired:
            out.append(('FAIL', f'    过期: {t}'))
    else:
        out.append(('PASS', 'AUD-TODO-02 无过期待办'))
    if watch_expired:
        out.append(('FAIL', f'AUD-TODO-03 观察期已过未处置: {len(watch_expired)} 条'))
        for t in watch_expired:
            out.append(('FAIL', f'    逾期观察: {t}'))
    if trigger_due:
        out.append(('FAIL', f'AUD-TODO-04 触发兜底已到未处置: {len(trigger_due)} 条'))
        for t in trigger_due:
            out.append(('FAIL', f'    兜底到期: {t}'))
    return out


# ============================================================
# AUD-GIT 提交规范
# ============================================================

def _git(args):
    r = subprocess.run(['git'] + args, cwd=REPO_ROOT, capture_output=True, text=True, encoding='utf-8')
    return r.returncode, (r.stdout or '') + (r.stderr or '')


# 只查数据检查批次提交 (01 步骤6 要求 ## 任务概要 的对象)
# 其他会话的提交 (T5:/K2b:/H5:/feat: 等后端重构) 不归本判据管
AI_BATCH_PREFIX = '数据检查:'


def check_git_summary(target, **kw):
    """target 日 数据检查: 前缀提交是否含 ## 任务概要"""
    ds = target.strftime('%Y-%m-%d')
    rc, out = _git(['log', f'--since={ds} 00:00', f'--until={ds} 23:59',
                    '--format=%H%x00%s', '--', AI_REL_PATH])
    if rc != 0:
        return [('WARN', f'AUD-GIT-01 git 查询失败: {out[:100]}')]
    commits = [l.split('\x00') for l in out.strip().splitlines() if l.strip()]
    # 过滤: 只管数据检查批次的主体提交; "执行日志"追行是批次收尾的独立小提交, 实践中不带任务概要 (01 步骤6 针对主体提交)
    batches = [(h, s) for h, s in commits
               if s.startswith(AI_BATCH_PREFIX) and '执行日志' not in s]
    if not batches:
        return [('WARN', f'AUD-GIT-01 {ds} 无 {AI_BATCH_PREFIX} 批次提交')]
    bad = []
    for h, subj in batches:
        rc2, body = _git(['log', '-1', '--format=%B', h])
        if '## 任务概要' not in body:
            bad.append(f'{h[:8]} {subj[:50]}')
    if bad:
        res = [('FAIL', f'AUD-GIT-01 批次提交缺 ## 任务概要: {len(bad)}/{len(batches)}')]
        for b in bad:
            res.append(('FAIL', f'    {b}'))
        return res
    return [('PASS', f'AUD-GIT-01 批次提交全部含 ## 任务概要 ({len(batches)}/{len(batches)})')]


# ============================================================
# AUD-NOTIFY 通知文风
# ============================================================

NOTIFY_FORBIDDEN = re.compile(r'\*\*(数据汇报|值得关注|值得关注的|我的看法)\*\*|【数据汇报】|【值得关注】')


def check_notify_style(target, **kw):
    """事实文件中的通知行是否出现旧式栏目标签。"""
    ds = target.strftime('%Y-%m-%d')
    path = os.path.join(DEFAULT_DAILY, ds, '事实-全天.md')
    if not os.path.exists(path):
        return [('WARN', f'AUD-NOTIFY-01 事实文件不存在: {path}')]
    hits = []
    try:
        with open(path, encoding='utf-8', errors='replace') as f:
            for i, line in enumerate(f, 1):
                m = NOTIFY_FORBIDDEN.search(line)
                if m:
                    hits.append(f'事实-全天.md:{i} 出现「{m.group(0)}」')
    except OSError as e:
        return [('WARN', f'AUD-NOTIFY-01 读取失败: {e}')]
    if hits:
        res = [('FAIL', f'AUD-NOTIFY-01 通知含旧式栏目标签: {len(hits)} 处')]
        for h in hits:
            res.append(('FAIL', f'    {h}'))
        return res
    return [('PASS', 'AUD-NOTIFY-01 通知未见旧式栏目标签')]


# ============================================================
# AUD-MEM 文件膨胀 (current)
# ============================================================

def check_mem膨胀(target, **kw):
    """软上限 300 行 / 20KB, 全域生效 (含 agents/)"""
    over = []
    total = 0
    for d in MEM_SCAN_DIRS:
        base = os.path.join(AI_ROOT, d)
        if not os.path.isdir(base):
            continue
        for root, _dirs, files in os.walk(base):
            for fn in files:
                if not fn.endswith('.md'):
                    continue
                p = os.path.join(root, fn)
                total += 1
                try:
                    with open(p, encoding='utf-8', errors='replace') as f:
                        data = f.read()
                except OSError:
                    continue
                lc = data.count('\n') + 1
                bc = len(data.encode('utf-8'))
                if lc > SOFT_LINES or bc > SOFT_BYTES:
                    rel = os.path.relpath(p, AI_ROOT).replace('\\', '/')
                    over.append(f'{rel} ({lc} 行 / {bc // 1024}KB)')
    if over:
        res = [('FAIL', f'AUD-MEM-01 超软上限 {SOFT_LINES}行/{SOFT_BYTES // 1024}KB: {len(over)}/{total} 个文件')]
        for o in sorted(over):
            res.append(('FAIL', f'    {o}'))
        return res
    return [('PASS', f'AUD-MEM-01 全部 {total} 个 md 未超软上限')]


# ============================================================
# AUD-SCHED 调度状态
# ============================================================

def check_sched_state(target, **kw):
    """调度状态: .data_check_state.json 语义是 last_triggered(最后一次触发日),
    无法回溯历史日 (同一点位次日触发即覆盖昨日记录) → 只审今日, 历史日 SKIP。
    历史日的批次完整性由 AUD-DATA-05 批次数管。
    """
    import json as _json
    if target != date.today():
        return [('SKIP', f'AUD-SCHED-01 state 为 last_triggered 语义不可回溯, 仅审今日, {target} 跳过 (历史完整性看 AUD-DATA-05)')]
    path = os.path.join(AI_ROOT, 'data', 'tasks', '.data_check_state.json')
    if not os.path.exists(path):
        return [('FAIL', 'AUD-SCHED-01 调度状态文件不存在')]
    try:
        state = _json.load(open(path, encoding='utf-8'))
    except Exception as e:
        return [('FAIL', f'AUD-SCHED-01 状态文件解析失败: {e}')]
    ds = target.strftime('%Y-%m-%d')
    now = datetime.now()
    checkable = []
    for h in SCHED_WINDOWS:
        if datetime(target.year, target.month, target.day, h, 0) > now:
            continue  # 今日尚未到点
        checkable.append(h)
    missing = [h for h in checkable if state.get(str(h)) != ds]
    stale = [k for k in state if not k.isdigit() or int(k) not in SCHED_WINDOWS]
    res = []
    if missing:
        res.append(('FAIL', f'AUD-SCHED-01 {ds} 应触发未触发: {sorted(missing)} 点'))
    else:
        res.append(('PASS', f'AUD-SCHED-01 {ds} 已到点的排班位全部有触发记录 ({len(checkable)} 窗)'))
    if stale:
        res.append(('WARN', f'AUD-SCHED-02 状态文件含废弃键: {stale} (不在 SCHED_WINDOWS)'))
    return res


# ============================================================
# AUD-DATA 覆盖与 voice (复用 check_coverage)
# ============================================================

def check_data_coverage(target, **kw):
    """调 check_coverage 拿覆盖与 voice 结果 (子进程, 不触发其退出码)"""
    ds = target.strftime('%Y-%m-%d')
    res = []
    try:
        r = subprocess.run([sys.executable, os.path.join(_SCRIPT_DIR, 'check_coverage.py'), ds],
                           capture_output=True, text=True, encoding='utf-8', timeout=120)
        out = (r.stdout or '') + (r.stderr or '')
        if r.returncode == 0:
            m = re.search(r'缺口:\s*0s', out)
            res.append(('PASS', f'AUD-DATA-01 覆盖检查通过 (check_coverage 退出 0)'))
        else:
            res.append(('FAIL', f'AUD-DATA-01 覆盖检查未过 (退出 {r.returncode})'))
            for line in out.strip().splitlines()[-6:]:
                res.append(('FAIL', f'    {line.strip()}'))
        m = re.search(r'voice 管线:.*', out)
        if m:
            line = m.group(0)
            st = 'FAIL' if '疑似' in line else 'PASS'
            res.append((st, f'AUD-DATA-02 {line}'))
    except Exception as e:
        res.append(('WARN', f'AUD-DATA-01 check_coverage 调用失败: {e}'))
    # 当日关键产物存在性
    ds_dir = os.path.join(DEFAULT_DAILY, ds)
    for fname, cid in [(f'复盘-{ds}.md', 'AUD-DATA-03'),
                       (f'当日摘要-{ds}.md', 'AUD-DATA-04')]:
        p = os.path.join(ds_dir, fname)
        if os.path.exists(p):
            res.append(('PASS', f'{cid} {fname} 存在'))
        else:
            # 审计跑在 02:00, 复盘 00:30 应已完成; 当日摘要由批次维护
            res.append(('FAIL', f'{cid} {fname} 缺失'))
    # 批次数: 每个排班窗口应有一个理解文件
    expect_batches = len(SCHED_WINDOWS)
    got = len([f for f in os.listdir(ds_dir) if f.startswith(f'理解-{ds}-批次-')]) if os.path.isdir(ds_dir) else 0
    st = 'PASS' if got >= expect_batches else 'FAIL'
    res.append((st, f'AUD-DATA-05 理解批次数 {got}/{expect_batches}'))
    return res


# ============================================================
# AUD-BIZ 业务定义完整性 (current)
# ============================================================

def check_biz_frontmatter(target, **kw):
    """memory/self/tasks/*.md 的 触发/执行 字段完整性"""
    base = os.path.join(AI_ROOT, 'memory', 'self', 'tasks')
    if not os.path.isdir(base):
        return [('WARN', 'AUD-BIZ-01 业务目录不存在')]
    res = []
    files = [f for f in os.listdir(base) if f.endswith('.md')]
    if not files:
        return [('WARN', 'AUD-BIZ-01 无业务文件')]
    for fn in sorted(files):
        txt = open(os.path.join(base, fn), encoding='utf-8').read()
        has_trig = bool(re.search(r'^触发:', txt, re.M))
        has_exec = bool(re.search(r'^执行:', txt, re.M))
        if has_trig and has_exec:
            res.append(('PASS', f'AUD-BIZ-01 {fn} frontmatter 完整'))
        else:
            miss = [k for k, ok in [('触发', has_trig), ('执行', has_exec)] if not ok]
            res.append(('FAIL', f'AUD-BIZ-01 {fn} 缺字段: {miss}'))
    return res


# ============================================================
# AUD-SCRIPT 判据新鲜度 (current)
# ============================================================

def check_judgement_age(target, **kw):
    """判据新鲜度: 最老生效日距今多久 (判据长期不更新=规范可能已滞后)"""
    today = date.today()
    ages = sorted((c.id, _d(c.effective)) for c in CHECKS)
    oldest_id, oldest_d = ages[0]
    days = (today - oldest_d).days
    if days > 180:
        return [('WARN', f'AUD-SCRIPT-01 最老判据 {oldest_id} 生效于 {oldest_d} ({days} 天前), 疑滞后')]
    return [('PASS', f'AUD-SCRIPT-01 判据最老 {oldest_id} = {oldest_d} ({days} 天), 共 {len(CHECKS)} 项')]


# ============================================================
# AUD-CTX 上下文 / 缓存命中 / token 消耗 (historical, opencode.db 只读)
# ============================================================
# 阈值（按实例体量与模型窗口调整）：
#   峰值上下文 WARN 400k / FAIL 600k
#   缓存命中 <85% WARN
#   单会话 output ≥80k WARN
# 明细：主会话树（含孙会话）逐会话画像：标题/工具调用与失败/请求数/耗时/
#   最大上下文/命中率/总消耗；异常项交给审计子智能体深挖。
CTX_PEAK_WARN = 400_000
CTX_PEAK_FAIL = 600_000
CTX_HIT_MIN = 0.85
CTX_SESSION_OUTPUT_WARN = 80_000
CTX_DETAIL_MAX = 40          # 明细行防御性上限 (当日树内活跃会话数)

_DEPTH_LABEL = ['主', '子', '孙', '曾孙']


def _fmt_k(n):
    """数字缩写: 593888→594k, 4100000→4.1M"""
    if n >= 1_000_000:
        return f'{n / 1_000_000:.1f}M'
    if n >= 1000:
        return f'{n / 1000:.0f}k'
    return str(n)


def _fmt_dur(ms):
    """时长缩写: 9000→9s, 540000→9m, 45300000→12h35m"""
    if ms <= 0:
        return '0s'
    s = ms // 1000
    if s < 60:
        return f'{s}s'
    m = s // 60
    if m < 60:
        return f'{m}m'
    return f'{m // 60}h{m % 60:02d}m'


def _main_session_ids():
    """解析主会话 id 列表 = 当前 + 历史主会话 (chatlog_sessions.json main_history 全量,
    与 session_context._resolve_parent 同源; 压缩换 id 后旧主会话仍要纳入树)。
    失败返回 []。"""
    p = os.path.join(AI_ROOT, 'memory', 'self', 'chatlog_sessions.json')
    try:
        cache = json.loads(open(p, encoding='utf-8').read())
        return [h.get('sid') for h in (cache.get('main_history') or []) if h.get('sid')]
    except (OSError, json.JSONDecodeError):
        return []


def check_session_context(target, **kw):
    """上下文峰值 / 缓存命中 / output 消耗 + 主会话树(含孙)逐会话明细画像"""
    if not os.path.exists(OPENCODE_DB):
        return [('WARN', f'AUD-CTX-00 opencode.db 不存在, 本域跳过: {OPENCODE_DB}')]
    try:
        con = sqlite3.connect(f'file:{OPENCODE_DB}?mode=ro', uri=True, timeout=5)
        con.execute('SELECT 1 FROM message LIMIT 1')
    except sqlite3.Error as e:
        return [('WARN', f'AUD-CTX-00 opencode.db 打不开, 本域跳过: {e}')]

    # 毫秒时间戳窗口 (本地时区午夜, 与写入端 Date.now 同一 epoch)
    day0 = int(datetime(target.year, target.month, target.day).timestamp() * 1000)
    day1 = day0 + 86400000

    try:
        # ---- 会话元信息 (全库) ----
        meta = {}           # sid -> {title, parent, tc, tu}
        children = {}       # parent -> [sid]
        for sid, title, parent, tc, tu in con.execute(
                'SELECT id, title, parent_id, time_created, time_updated FROM session'):
            meta[sid] = {'title': title or '', 'parent': parent,
                         'tc': tc or 0, 'tu': tu or 0}
            if parent:
                children.setdefault(parent, []).append(sid)

        # ---- 主会话树 BFS (当前+历史主会话全部起跳, 含孙及更深) ----
        # 树外会话(其他项目/其他根)一律不统计，审计只管本系统
        main_ids = [s for s in _main_session_ids() if s in meta]
        tree_depth = {}     # sid -> 深度 (0=主会话本身)
        tree_warn = None
        if main_ids:
            stack = [(sid, 0) for sid in main_ids]
            while stack:
                sid, d = stack.pop()
                if sid in tree_depth and tree_depth[sid] <= d:
                    continue
                tree_depth[sid] = d
                for ch in children.get(sid, []):
                    stack.append((ch, d + 1))
        else:
            tree_warn = f'主会话 id 解析失败({main_ids}), 统计退化为全库当日会话'

        # ---- 消息聚合 (当日, 按会话, 仅树内) ----
        # peak=最大上下文 / req=请求数(assistant 消耗行) / in,cr,cw,out=token 分量
        stats = {}
        g_peak = g_req = g_n = 0
        g_read = g_denom = 0
        for sid, data in con.execute(
                'SELECT session_id, data FROM message WHERE time_created>=? AND time_created<?',
                (day0, day1)):
            if tree_depth and sid not in tree_depth:
                continue
            try:
                d = json.loads(data) if data else {}
            except json.JSONDecodeError:
                continue
            st = stats.get(sid)
            if st is None:
                st = stats[sid] = {'peak': 0, 'req': 0, 'in': 0, 'cr': 0, 'cw': 0, 'out': 0}
            if d.get('role') == 'assistant':
                st['req'] += 1
                g_req += 1
            tok = d.get('tokens') or {}
            total = tok.get('total') or 0
            if not total:
                continue
            g_n += 1
            if total > st['peak']:
                st['peak'] = total
            if total > g_peak:
                g_peak = total
            cache = tok.get('cache') or {}
            inp, cr, cw = tok.get('input') or 0, cache.get('read') or 0, cache.get('write') or 0
            outv = tok.get('output') or 0
            st['in'] += inp; st['cr'] += cr; st['cw'] += cw; st['out'] += outv
            g_read += cr
            g_denom += inp + cr + cw

        # ---- 工具调用聚合 (当日 tool part, 按会话, 仅树内) ----
        tools = {}          # sid -> [calls, failed]  非 completed 一律计失败
        for sid, data in con.execute(
                'SELECT session_id, data FROM part WHERE time_created>=? AND time_created<?',
                (day0, day1)):
            if tree_depth and sid not in tree_depth:
                continue
            if '"type": "tool"' not in data and '"type":"tool"' not in data:
                continue
            try:
                d = json.loads(data)
            except json.JSONDecodeError:
                continue
            if d.get('type') != 'tool':
                continue
            t = tools.get(sid)
            if t is None:
                t = tools[sid] = [0, 0]
            t[0] += 1
            status = (d.get('state') or {}).get('status')
            if status != 'completed':
                t[1] += 1
    finally:
        con.close()

    if g_n == 0:
        return [('WARN', 'AUD-CTX-01 主会话树当日无含 token 的消息 (会话未运行或 db 滞后)')]

    out = []
    # 全局上下文峰值
    if g_peak >= CTX_PEAK_FAIL:
        out.append(('FAIL', f'AUD-CTX-01 上下文峰值 {g_peak} >= {CTX_PEAK_FAIL} (大上下文, 立即处理)'))
    elif g_peak >= CTX_PEAK_WARN:
        out.append(('WARN', f'AUD-CTX-01 上下文峰值 {g_peak} >= {CTX_PEAK_WARN} (接近大上下文线, {g_n} 条消息)'))
    else:
        out.append(('PASS', f'AUD-CTX-01 上下文峰值 {g_peak} < {CTX_PEAK_WARN} ({g_n} 条消息)'))

    # 全局缓存命中率
    if g_denom > 0:
        rate = g_read / g_denom
        if rate < CTX_HIT_MIN:
            out.append(('WARN', f'AUD-CTX-02 缓存命中 {rate:.1%} < {CTX_HIT_MIN:.0%} (read {g_read} / {g_denom})'))
        else:
            out.append(('PASS', f'AUD-CTX-02 缓存命中 {rate:.1%} (read {g_read} / {g_denom})'))
    else:
        out.append(('WARN', 'AUD-CTX-02 无输入侧 token, 命中率不可计算'))

    # 单会话 output 消耗 (带标题)
    heavy = sorted(((s, st['out']) for s, st in stats.items()
                    if st['out'] >= CTX_SESSION_OUTPUT_WARN), key=lambda x: -x[1])
    if heavy:
        out.append(('WARN', f'AUD-CTX-03 单会话 output >= {CTX_SESSION_OUTPUT_WARN}: {len(heavy)} 个'))
        for s, o in heavy[:8]:
            title = (meta.get(s, {}).get('title') or '?')[:56]
            out.append(('WARN', f'    {s} output={o} "{title}"'))
    else:
        mx = max((st['out'] for st in stats.values()), default=0)
        out.append(('PASS', f'AUD-CTX-03 单会话 output 均 < {CTX_SESSION_OUTPUT_WARN} (最大 {mx})'))

    # ---- 逐会话明细: 主会话树当日活跃 (当前+历史主会话的树, 含孙) ----
    active = {sid for sid, m in meta.items() if m['tu'] >= day0 and m['tc'] < day1}
    if tree_depth:
        rows = sorted((sid for sid in tree_depth if sid in active),
                      key=lambda s: meta[s]['tc'])
        scope = (f'主会话树(当前+历史共 {len(main_ids)} 个根)当日活跃 {len(rows)} 会话, '
                 f'树全量 {len(tree_depth)}, 最深 L{max(tree_depth.values())}, '
                 f'库内当日活跃 {len(active)} (树外 {len(active) - len(rows)} 已过滤)')
    else:
        rows = sorted(active, key=lambda s: meta[s]['tc'])[:CTX_DETAIL_MAX]
        scope = f'全库当日活跃 {len(active)} 会话 (树解析失败, 截 {len(rows)} 行)'
    out.append(('PASS', f'AUD-CTX-04 会话明细: {scope}'))
    if tree_warn:
        out.append(('WARN', f'AUD-CTX-04 {tree_warn}'))

    shown = 0
    for sid in rows:
        if shown >= CTX_DETAIL_MAX:
            out.append(('INFO', f'  …(余 {len(rows) - shown} 会话省略)'))
            break
        m = meta[sid]
        st = stats.get(sid)
        tl = tools.get(sid, [0, 0])
        depth = tree_depth.get(sid, -1)
        tag = (f'L{depth} {_DEPTH_LABEL[min(depth, len(_DEPTH_LABEL) - 1)]}'
               if depth >= 0 else '树外')
        if st:
            hit = f'{st["cr"] / (st["in"] + st["cr"] + st["cw"]):.0%}' \
                if (st['in'] + st['cr'] + st['cw']) else '-'
            row = (f'  {tag} {sid} "{m["title"][:60]}" | '
                   f'工具{tl[0]}(失败{tl[1]}) | 请求{st["req"]} | '
                   f'耗时{_fmt_dur(m["tu"] - m["tc"])} | 峰值{_fmt_k(st["peak"])} | '
                   f'命中{hit} | 消耗入{_fmt_k(st["in"] + st["cr"] + st["cw"])}'
                   f'/出{_fmt_k(st["out"])}')
        else:
            row = (f'  {tag} {sid} "{m["title"][:60]}" | '
                   f'工具{tl[0]}(失败{tl[1]}) | 请求0 | '
                   f'耗时{_fmt_dur(m["tu"] - m["tc"])} | 当日无 message')
        out.append(('INFO', row))
        shown += 1
    return out


# ============================================================
# 注册表：加新检查项在这里登记, 必须填 source 与 effective
# ============================================================

CHECKS = [
    # (id, domain, fn, source, effective, scope)
    # source 写判据依据；effective 写该判据在实例中的生效日（模板统一用基线日）。
    Check('AUD-TODO-01', 'TODO', check_todo_anchor,
          '待办须带三元锚（到期/观察至/触发+兜底）', DEFAULT_EFFECTIVE, 'current'),
    Check('AUD-GIT-01', 'GIT', check_git_summary,
          '数据检查规范: commit body 须含 ## 任务概要', DEFAULT_EFFECTIVE, 'historical'),
    Check('AUD-NOTIFY-01', 'NOTIFY', check_notify_style,
          '通知文风: 第一人称、有人味，禁旧式栏目标签', DEFAULT_EFFECTIVE, 'historical'),
    Check('AUD-MEM-01', 'MEM', check_mem膨胀,
          '单文件软上限 300 行/20KB，全域生效（含 agents）', DEFAULT_EFFECTIVE, 'current'),
    Check('AUD-SCHED-01', 'SCHED', check_sched_state,
          '数据检查排班窗口 SCHED_WINDOWS', DEFAULT_EFFECTIVE, 'historical'),
    Check('AUD-DATA-01', 'DATA', check_data_coverage,
          'check_coverage.py 覆盖/voice 不变量 + 复盘产物存在性', DEFAULT_EFFECTIVE, 'historical'),
    Check('AUD-BIZ-01', 'BIZ', check_biz_frontmatter,
          '业务卡片 frontmatter 须含 触发/执行', DEFAULT_EFFECTIVE, 'current'),
    Check('AUD-CTX-01', 'CTX', check_session_context,
          '上下文峰值/缓存命中/token 消耗阈值（按实例调整）', DEFAULT_EFFECTIVE, 'historical'),
    Check('AUD-SCRIPT-01', 'SCRIPT', check_judgement_age,
          '判据须标来源并保持新鲜', DEFAULT_EFFECTIVE, 'current'),
]


def load_prev_fail(target):
    """读昨日 audit 文本里的 FAIL id, 用于追踪节"""
    prev = target - timedelta(days=1)
    p = os.path.join(DEFAULT_DAILY, prev.strftime('%Y-%m-%d'),
                     f'audit-{prev.strftime("%Y-%m-%d")}.txt')
    if not os.path.exists(p):
        return None
    ids = set()
    for line in open(p, encoding='utf-8', errors='replace'):
        m = re.match(r'\[FAIL\]\s+(AUD-\w+-\d+)', line)
        if m:
            ids.add(m.group(1))
    return ids


def run(target):
    now = datetime.now()
    lines = []
    lines.append(f'[audit] 审计 {target.strftime("%Y-%m-%d")}（{now.strftime("%Y-%m-%d %H:%M")} 运行, audit_collector v1）')
    if target >= date.today():
        lines.append('**注意: 目标日为今日/未完结, 批次与复盘未到点, 部分结果仅供参考 (正式审计应审昨日)**')
    effs = sorted(_d(c.effective) for c in CHECKS)
    lines.append(f'判据: {len(CHECKS)} 项, 最新生效 {effs[-1]}, 最老 {effs[0]} ({(date.today() - effs[0]).days} 天)')
    lines.append('')

    counts = {'PASS': 0, 'FAIL': 0, 'WARN': 0, 'SKIP': 0}
    all_results = []  # (domain, status, line)

    for c in CHECKS:
        # historical 且判据未生效 → SKIP (不拿新规矩审旧数据)
        if c.scope == 'historical' and target < _d(c.effective):
            all_results.append((c.domain, 'SKIP',
                                f'[SKIP] {c.id} 判据 {c.effective} 生效, 不审 {target}'))
            counts['SKIP'] += 1
            continue
        try:
            results = c.fn(target)
        except Exception as e:
            all_results.append((c.domain, 'FAIL', f'[FAIL] {c.id} 检查执行异常: {e}'))
            counts['FAIL'] += 1
            continue
        for status, line in results:
            # 函数返回的行可能不带 [STATUS] 前缀
            if not line.startswith('['):
                line = f'[{status}] {line}'
            all_results.append((c.domain, status, line))
            counts[status] = counts.get(status, 0) + 1

    # 分节输出: 按域分组, TODO 置顶 (用户要求过期待办永远第一节)
    domain_order = ['TODO', 'GIT', 'NOTIFY', 'MEM', 'SCHED', 'DATA', 'CTX', 'BIZ', 'SCRIPT']
    for dom in domain_order:
        rows = [r for r in all_results if r[0] == dom]
        if not rows:
            continue
        lines.append(f'== {dom} ==')
        for _d0, _s, line in rows:
            lines.append(line)
        lines.append('')

    # 昨日 FAIL 追踪
    lines.append('== 昨日 FAIL 追踪 ==')
    prev_fail = load_prev_fail(target)
    if prev_fail is None:
        lines.append('(无昨日 audit 文本, 首次运行或昨日未审计)')
    else:
        cur_fail = {r[2].split()[1] for r in all_results
                    if r[1] == 'FAIL' and r[2].startswith('[') and len(r[2].split()) > 1}
        still = sorted(prev_fail & cur_fail)
        fixed = sorted(prev_fail - cur_fail)
        if not prev_fail:
            lines.append('(昨日无 FAIL)')
        else:
            lines.append(f'昨日 FAIL {len(prev_fail)} 项: 已修复 {len(fixed)}, 仍 FAIL {len(still)}')
            for i in still:
                lines.append(f'  [仍FAIL] {i}')
            for i in fixed:
                lines.append(f'  [已修复] {i}')
    lines.append('')

    lines.append(f'汇总: FAIL {counts.get("FAIL", 0)} | WARN {counts.get("WARN", 0)} | '
                 f'PASS {counts.get("PASS", 0)} | SKIP {counts.get("SKIP", 0)}')
    return '\n'.join(lines), counts.get('FAIL', 0)


def main():
    parser = argparse.ArgumentParser(description='夜间审计采集器')
    parser.add_argument('date', nargs='?', default=None,
                        help='审计目标日 YYYY-MM-DD (默认昨日)')
    parser.add_argument('--out', default=None, help='结果写入文件 (同时仍打印)')
    args = parser.parse_args()

    if args.date:
        target = _d(args.date)
    else:
        target = date.today() - timedelta(days=1)

    try:
        text, fail_count = run(target)
    except Exception as e:
        print(f'[audit] 脚本异常: {e}', file=sys.stderr)
        sys.exit(2)

    print(text)
    if args.out:
        os.makedirs(os.path.dirname(args.out), exist_ok=True)
        with open(args.out, 'w', encoding='utf-8') as f:
            f.write(text + '\n')

    sys.exit(1 if fail_count else 0)


if __name__ == '__main__':
    main()
