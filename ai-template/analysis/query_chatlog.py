#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
按时间段查询 AI 与用户的对话日志。

数据链路: 本脚本 → 后端 /api/screen/session/chatlog → 后端转发 OpenCode。
AI 复盘/数据检查可用它了解"某时段用户主动问了什么、AI 回了什么、调了哪些工具"。

用法:
    python {AI目录}/analysis/query_chatlog.py --start "2026-01-01 14:00" --end "2026-01-01 18:00"
    python {AI目录}/analysis/query_chatlog.py --start "2026-01-01 00:00" --end "2026-01-01 23:59" --session_id ses_xxx
    python {AI目录}/analysis/query_chatlog.py --start ... --end ... --format json
    python {AI目录}/analysis/query_chatlog.py --start ... --end ... --include-children
    python {AI目录}/analysis/query_chatlog.py --list-sessions          # 查看历次命中的会话ID（含 main 绑定变更史）

默认行为:
  - 打印纯文本对话时间线（用户消息 / AI 正文 / 工具名）
  - 同时把本次查询的完整原始输出追加存档到 {AI目录}/data/cache/chatlog_tmp/（脚本数据内容，非 JSON）
  - 完成后打印存档文件路径
  - 每次成功查询后，把实际命中的会话ID自动缓存到 {AI目录}/memory/self/chatlog_sessions.json，
    并记录它是否为当时的 main-task 绑定。切换主会话后旧ID仍可从缓存找回，
    不再因后端缺省解析到新会话而丢失回溯能力。该文件随 git 备份（故不放 gitignore 的 cache 区）。

参数:
  --start 起始时间 YYYY-MM-DD HH:MM 或 ISO8601，UTC+8（查询时必填）
  --end   结束时间（查询时必填）
  --session_id  目标会话ID，缺省=当前 main-task 主会话
  --include-children  是否含子会话
  --format text|json  默认 text
  --no-archive  不写入临时存档
  --no-cache    不写入会话ID缓存
  --note        给本次命中的会话ID加一条备注（如"旧主会话"）
  --list-sessions  列出已缓存的会话ID（含历史 main 标记），不需要时间参数
  --backend-port 后端端口，缺省自动探测(默认候选 8768/8767/9787/9788)

依赖: 仅标准库
"""

import argparse
import json
import os
import ssl
import sys
import urllib.request
from datetime import datetime
from pathlib import Path

# 脚本位于 {AI目录}/analysis/，向上两级即 AI 目录与项目根
AI_ROOT = Path(__file__).resolve().parent.parent
PROJECT_ROOT = AI_ROOT.parent
BACKEND_DIR = Path(os.environ.get("AXEUH_BACKEND_DIR", PROJECT_ROOT / "backend"))
AUTH_FILE = BACKEND_DIR / "config" / "auth.json"
ARCHIVE_DIR = AI_ROOT / "data" / "cache" / "chatlog_tmp"
# 会话ID缓存：记录每次查询实际命中的会话，切换主会话后旧ID仍可找回。
# 放 {AI目录}/memory/self/ 而非 data/cache/：后者常被 .gitignore 忽略、不受 git 备份；
# 这把"打开历史会话的钥匙"若随 cache 丢失，回溯能力即失效，故与记忆导航同区、随 git 备份。
SESSION_CACHE_FILE = AI_ROOT / "memory" / "self" / "chatlog_sessions.json"

# 后端端口候选（默认列表；可用环境变量 BACKEND_PORTS 覆盖，逗号分隔）
DEFAULT_BACKEND_PORTS = (8768, 8767, 9787, 9788)
_env_ports = os.environ.get("BACKEND_PORTS", "")
BACKEND_PORTS = tuple(
    int(p) for p in _env_ports.split(",") if p.strip().isdigit()
) or DEFAULT_BACKEND_PORTS


def _load_token():
    """从后端 auth.json 读取最长有效期的 token。"""
    with open(AUTH_FILE, encoding="utf-8") as f:
        auth = json.load(f)
    tokens = auth.get("tokens", {})
    if not tokens:
        raise SystemExit("auth.json 中没有可用 token，请先登录")
    best = max(tokens.items(), key=lambda kv: kv[1].get("expires_at", ""))
    return best[0]


def _probe_port():
    """探测后端实际监听端口（HTTPS）。"""
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    for port in BACKEND_PORTS:
        try:
            req = urllib.request.Request(
                f"https://127.0.0.1:{port}/health",
                method="GET",
            )
            resp = urllib.request.urlopen(req, timeout=2, context=ctx)
            if resp.status == 200:
                return port
        except Exception:
            continue
    return None


def _query_chatlog(port, token, params):
    """调用后端 /api/screen/session/chatlog，返回 (status, body) 或 (None, 错误信息)。"""
    import urllib.parse
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    query = urllib.parse.urlencode(params)
    url = f"https://127.0.0.1:{port}/api/screen/session/chatlog?{query}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        resp = urllib.request.urlopen(req, timeout=60, context=ctx)
        return resp.status, resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")
    except Exception as e:
        return None, str(e)


def _today():
    return datetime.now().strftime("%Y-%m-%d")


def _extract_sid(fmt, body):
    """从后端响应里解析实际命中的会话ID（text 从『会话: xxx』行、json 从 session_id 字段）。"""
    import re
    if fmt == "json":
        try:
            return json.loads(body).get("session_id")
        except (json.JSONDecodeError, AttributeError):
            return None
    m = re.search(r"^会话:\s*(\S+)", body, re.MULTILINE)
    return m.group(1) if m else None


def _load_cache():
    try:
        return json.loads(SESSION_CACHE_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def _save_cache(cache):
    try:
        SESSION_CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = SESSION_CACHE_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, SESSION_CACHE_FILE)
        return True
    except OSError:
        return False


def _update_cache(resolved_sid, is_default, note, start, end):
    """把本次命中的会话ID写入缓存；is_default=True 表示该ID是当时的 main-task 绑定（记入 main_history）。
    切换主会话后旧ID仍留在缓存与 main_history，可凭 --session_id 继续回溯。"""
    if not resolved_sid:
        return False
    today = _today()
    cache = _load_cache()
    sessions = cache.setdefault("sessions", {})
    rec = sessions.get(resolved_sid) or {"first_seen": today, "seen_count": 0, "notes": []}
    rec["last_seen"] = today
    rec["seen_count"] = rec.get("seen_count", 0) + 1
    rec["last_window"] = [start, end]
    if is_default:
        rec["was_main"] = True
    if note:
        entry = f"{today} {note}"
        notes = rec.setdefault("notes", [])
        if entry not in notes:
            notes.append(entry)
    sessions[resolved_sid] = rec

    if is_default:
        mh = cache.setdefault("main_history", [])
        if not mh or mh[-1].get("sid") != resolved_sid:
            if mh and mh[-1].get("until") is None:
                mh[-1]["until"] = today
            mh.append({"sid": resolved_sid, "since": today, "until": None})

    cache["updated_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    return _save_cache(cache)


def _list_sessions():
    """打印已缓存的会话ID：main 绑定变更史 + 每个ID的可见窗口/备注，供切换会话后找回旧ID。"""
    cache = _load_cache()
    if not cache.get("sessions"):
        print("会话缓存为空（尚未成功查询过，或均用了 --no-cache）")
        return
    mh = cache.get("main_history", [])
    if mh:
        print("== main-task 绑定变更史 ==")
        for item in mh:
            span = f"{item.get('since','?')} ~ {item.get('until') or '当前'}"
            print(f"  {span}  {item.get('sid')}")
        print()
    print("== 已缓存会话ID（可 --session_id 继续查询） ==")
    for sid, rec in sorted(cache["sessions"].items(),
                           key=lambda kv: kv[1].get("first_seen", "")):
        tag = " [曾为main]" if rec.get("was_main") else ""
        span = f"{rec.get('first_seen','?')}~{rec.get('last_seen','?')}"
        print(f"  {sid}  命中{rec.get('seen_count',0)}次 {span}{tag}")
        for n in rec.get("notes", []):
            print(f"        · {n}")


def _archive(port, params, body):
    """把本次查询的原始内容追加存档到 chatlog_tmp（脚本数据内容，非 JSON）。"""
    try:
        ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
        # 文件名: 按会话与开始时间归档（缺省 main-task 时用 main 标识）
        sid_part = params.get("session_id", "main")
        if sid_part.startswith("ses_"):
            sid_part = sid_part[-8:]
        day = (params.get("start", "").split(" ")[0]).replace("-", "")
        fname = f"{day}_{sid_part}.log"
        fpath = ARCHIVE_DIR / fname
        header = (
            f"\n{'=' * 60}\n"
            f"[查询时间] {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n"
            f"[参数] start={params.get('start')} end={params.get('end')} "
            f"session_id={params.get('session_id') or 'main-task'}\n"
            f"{'=' * 60}\n"
        )
        with open(fpath, "a", encoding="utf-8") as f:
            f.write(header)
            f.write(body)
            if not body.endswith("\n"):
                f.write("\n")
        return fpath
    except OSError as e:
        return None


def main():
    parser = argparse.ArgumentParser(description="按时间段查询 AI 与用户的对话日志")
    parser.add_argument("--start", help="起始时间 YYYY-MM-DD HH:MM 或 ISO8601 (UTC+8)；--list-sessions 时可省")
    parser.add_argument("--end", help="结束时间；--list-sessions 时可省")
    parser.add_argument("--session_id", default=None, help="目标会话ID，缺省=main-task 主会话")
    parser.add_argument("--include-children", action="store_true", help="是否含子会话")
    parser.add_argument("--format", default="text", choices=["text", "json"], help="输出格式")
    parser.add_argument("--no-archive", action="store_true", help="不写入临时存档")
    parser.add_argument("--no-cache", action="store_true", help="不写入会话ID缓存")
    parser.add_argument("--note", default=None, help="给本次命中的会话ID加备注（如 '09-11前旧主会话'）")
    parser.add_argument("--list-sessions", action="store_true", help="列出已缓存的会话ID后退出")
    parser.add_argument("--backend-port", type=int, default=None, help="后端 HTTPS 端口")
    args = parser.parse_args()

    if args.list_sessions:
        _list_sessions()
        return

    if not args.start or not args.end:
        print("错误: 查询需要 --start 与 --end（或用 --list-sessions 查看会话缓存）", file=sys.stderr)
        sys.exit(2)

    # 探测后端端口
    port = args.backend_port or _probe_port()
    if not port:
        print("错误: 无法探测后端端口，请用 --backend-port 指定", file=sys.stderr)
        sys.exit(2)

    token = _load_token()

    params = {
        "start": args.start,
        "end": args.end,
        "format": args.format,
    }
    if args.session_id:
        params["session_id"] = args.session_id
    if args.include_children:
        params["include_children"] = "true"

    status, body = _query_chatlog(port, token, params)
    if status is None:
        print(f"错误: 调用后端失败: {body}", file=sys.stderr)
        sys.exit(2)
    if status != 200:
        print(f"后端返回 HTTP {status}: {body}", file=sys.stderr)
        sys.exit(1)

    # 打印输出
    if args.format == "json":
        # JSON 结构化输出（程序消费）
        try:
            data = json.loads(body)
            print(json.dumps(data, ensure_ascii=False, indent=2))
        except json.JSONDecodeError:
            print(body)
    else:
        print(body)

    # 会话ID缓存：记录本次实际命中的会话（缺省时=当前 main-task 绑定），切换会话后仍可回溯
    if not args.no_cache:
        resolved_sid = args.session_id or _extract_sid(args.format, body)
        if _update_cache(resolved_sid, args.session_id is None, args.note, args.start, args.end):
            hint = "" if args.session_id else "（缺省解析=当前main-task，已记入变更史）"
            print(f"[已缓存会话ID] {resolved_sid}{hint}", file=sys.stderr)

    # 临时存档（脚本数据内容，追加写）
    if not args.no_archive:
        fpath = _archive(port, params, body)
        if fpath:
            print(f"\n[已存档] {fpath}", file=sys.stderr)
        else:
            print("警告: 临时存档写入失败", file=sys.stderr)


if __name__ == "__main__":
    main()
