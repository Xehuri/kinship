#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""投递 05:00/07:30 计划锚：先 reconcile，必要时回退旧唤醒消息。

Step 1: POST {loom}/plan/reconcile，请求体 {reason, anchor, date}；
        任意 2xx（优先 202）视为对账成功。
Step 2: 仅在 reconcile 连接失败或返回非 2xx 时，把 plan_wake.py 的旧唤醒文本
        POST 到 /sessions/{session_id}/messages，保证模型仍收到一次计划回合。
        对账成功时绝不发送回退消息。

日期按 IANA 时区解析（默认 Asia/Shanghai），缺省取当地今天。
配置与凭据解析顺序复用 plan_wake.py，token 也可由 --token/--token-file 显式给出。
仅使用标准库；--dry-run 打印两段 payload，不发任何网络请求。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

import plan_wake

ANCHORS = ("05:00", "07:30")
ANCHOR_REASONS = {"05:00": "anchor-0500", "07:30": "anchor-0730"}
LEGACY_TEXT = {"05:00": plan_wake.PLAN_TEXT, "07:30": plan_wake.REVIEW_TEXT}
DEFAULT_LOOM_URL = plan_wake.DEFAULT_LOOM_URL
DEFAULT_TIMEZONE = plan_wake.DEFAULT_TIMEZONE
DEFAULT_SESSION_ENV = plan_wake.DEFAULT_SESSION_ENV
DEFAULT_TOKEN_ENV = plan_wake.DEFAULT_TOKEN_ENV
DEFAULT_CREDENTIALS_FILE = str(
    Path(__file__).resolve().parents[1] / ".loom" / "plan-credentials.conf"
)
DEFAULT_TIMEOUT_SECONDS = 15.0


class AnchorError(Exception):
    """参数、配置或凭据错误（退出码 2，未完成对账）。"""


class AnchorHTTPError(AnchorError):
    """Loom 请求失败（退出码 1，已尝试发 HTTP）。"""


def _loom(config: dict) -> dict:
    value = config.get("loom") if isinstance(config, dict) else None
    return value if isinstance(value, dict) else {}


def resolve_session_id(args: argparse.Namespace, config: dict) -> str:
    """显式 --session-id > 环境变量 > config.yaml loom.plan_session_id；可为空。"""
    explicit = (args.session_id or "").strip()
    if explicit:
        return explicit
    env_name = (args.session_id_env or DEFAULT_SESSION_ENV).strip() or DEFAULT_SESSION_ENV
    return (os.environ.get(env_name) or "").strip() or str(
        _loom(config).get("plan_session_id") or ""
    ).strip()


def resolve_token(args: argparse.Namespace, config: dict) -> str:
    """显式 --token 优先；其余顺序复用 plan_wake（全缺时返回空串）。"""
    if args.token:
        return args.token.strip()
    try:
        return plan_wake.resolve_token(args, config)
    except plan_wake.PlanWakeError:
        # 用户显式给出 token 文件才算配置错误；其他情况允许匿名请求。
        if args.token_file or str(_loom(config).get("token_file") or "").strip():
            raise
        return ""


def message_url(loom_url: str, session_id: str) -> str:
    quoted = urllib.parse.quote(session_id, safe="")
    return f"{loom_url.rstrip('/')}/sessions/{quoted}/messages"


def fetch_main_session_id(
    *,
    loom_url: str,
    token: str,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> str:
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(
        f"{loom_url.rstrip('/')}/sessions/main",
        method="GET",
        headers=headers,
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = getattr(response, "status", None) or response.getcode()
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:300]
        raise AnchorHTTPError(f"HTTP {exc.code}: {detail}") from exc
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
        raise AnchorHTTPError(f"读取 /sessions/main 失败: {exc}") from exc
    if not 200 <= status < 300:
        raise AnchorHTTPError(f"HTTP {status}（期望 2xx）")
    session_id = payload.get("sessionID") if isinstance(payload, dict) else None
    if not isinstance(session_id, str) or not session_id.strip():
        raise AnchorError("/sessions/main 响应缺少 sessionID")
    return session_id.strip()


def reconcile_body(anchor: str, date_value: str) -> dict:
    return {"reason": ANCHOR_REASONS[anchor], "anchor": anchor, "date": date_value}


def _post_json(url: str, body: dict, *, token: str, timeout: float) -> int:
    """POST JSON；仅 2xx 受理，其余统一抛 AnchorHTTPError。"""
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(
        url,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        method="POST",
        headers=headers,
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = getattr(response, "status", None) or response.getcode()
            response.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:300]
        raise AnchorHTTPError(f"HTTP {exc.code}: {detail}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise AnchorHTTPError(f"连接失败: {getattr(exc, 'reason', exc)}") from exc
    if not 200 <= status < 300:
        raise AnchorHTTPError(f"HTTP {status}（期望 2xx）")
    return status


def post_reconcile(
    *,
    loom_url: str,
    anchor: str,
    date_value: str,
    token: str,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> int:
    return _post_json(
        f"{loom_url.rstrip('/')}/plan/reconcile",
        reconcile_body(anchor, date_value),
        token=token,
        timeout=timeout,
    )


def post_fallback(
    *,
    loom_url: str,
    session_id: str,
    anchor: str,
    token: str,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> int:
    return _post_json(
        message_url(loom_url, session_id),
        {"text": LEGACY_TEXT[anchor]},
        token=token,
        timeout=timeout,
    )


def dry_run_document(
    *,
    loom_url: str,
    anchor: str,
    date_value: str,
    session_id: str,
) -> dict:
    return {
        "dry_run": True,
        "anchor": anchor,
        "date": date_value,
        "reconcile": {
            "url": f"{loom_url.rstrip('/')}/plan/reconcile",
            "body": reconcile_body(anchor, date_value),
        },
        "fallback": {
            "url": message_url(loom_url, session_id) if session_id else None,
            "session_id": session_id or None,
            "body": {"text": LEGACY_TEXT[anchor]},
        },
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="投递 Loom 计划锚：先 /plan/reconcile，失败时回退旧唤醒消息。",
    )
    parser.add_argument("--anchor", required=True, choices=ANCHORS, help="锚点时刻")
    parser.add_argument("--date", default=None, help="YYYY-MM-DD；缺省按时区的今天")
    parser.add_argument(
        "--timezone", default=DEFAULT_TIMEZONE, help=f"IANA 时区（默认 {DEFAULT_TIMEZONE}）"
    )
    parser.add_argument("--session-id", default=None, help="回退消息的 Loom 会话 ID")
    parser.add_argument(
        "--session-id-env",
        default=DEFAULT_SESSION_ENV,
        help=f"会话 ID 环境变量（默认 {DEFAULT_SESSION_ENV}）",
    )
    parser.add_argument("--loom-url", default=None, help=f"默认 {DEFAULT_LOOM_URL}")
    parser.add_argument("--token", default=None, help="显式 Bearer token")
    parser.add_argument("--token-file", default=None, help="EnvironmentFile 形式的凭据文件")
    parser.add_argument(
        "--token-env", default=DEFAULT_TOKEN_ENV, help=f"token 环境变量（默认 {DEFAULT_TOKEN_ENV}）"
    )
    parser.add_argument(
        "--credentials-file",
        default=DEFAULT_CREDENTIALS_FILE,
        help=f"默认回退凭据文件（{DEFAULT_CREDENTIALS_FILE}）",
    )
    parser.add_argument("--config", default=None, help="config.yaml 路径（默认项目根）")
    parser.add_argument("--no-config", action="store_true", help="不读取 config.yaml")
    parser.add_argument(
        "--timeout",
        type=float,
        default=DEFAULT_TIMEOUT_SECONDS,
        help=f"HTTP 超时秒数（默认 {DEFAULT_TIMEOUT_SECONDS}）",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="只打印 reconcile 与 fallback 两段 payload，不发 HTTP",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.timeout <= 0:
            raise AnchorError("--timeout 必须大于 0")
        config = plan_wake.resolve_config(args)
        zone = plan_wake.load_timezone(args.timezone)
        target_date = plan_wake.resolve_event_date(args.date, zone).isoformat()
        loom_url = plan_wake.resolve_loom_url(args, config)
        session_id = resolve_session_id(args, config)

        if args.dry_run:
            document = dry_run_document(
                loom_url=loom_url,
                anchor=args.anchor,
                date_value=target_date,
                session_id=session_id,
            )
            print(json.dumps(document, ensure_ascii=False))
            return 0

        token = resolve_token(args, config)
        try:
            post_reconcile(
                loom_url=loom_url,
                anchor=args.anchor,
                date_value=target_date,
                token=token,
                timeout=args.timeout,
            )
        except AnchorHTTPError as exc:
            print(f"plan_anchor: reconcile 不可用（{exc}），回退旧唤醒", file=sys.stderr)
            if not session_id:
                try:
                    session_id = fetch_main_session_id(
                        loom_url=loom_url,
                        token=token,
                        timeout=args.timeout,
                    )
                except AnchorError as main_exc:
                    raise AnchorError(
                        "reconcile 失败且无法从 /sessions/main 解析主会话: "
                        f"{main_exc}"
                    ) from exc
            try:
                status = post_fallback(
                    loom_url=loom_url,
                    session_id=session_id,
                    anchor=args.anchor,
                    token=token,
                    timeout=args.timeout,
                )
            except AnchorHTTPError as fallback_exc:
                print(f"plan_anchor: 回退也失败: {fallback_exc}", file=sys.stderr)
                return 1
            print(
                json.dumps(
                    {
                        "reconciled": False,
                        "anchor": args.anchor,
                        "date": target_date,
                        "fallback": True,
                        "status": status,
                    },
                    ensure_ascii=False,
                )
            )
            return 0

        print(
            json.dumps(
                {"reconciled": True, "anchor": args.anchor, "date": target_date},
                ensure_ascii=False,
            )
        )
        return 0
    except AnchorHTTPError as exc:
        print(f"plan_anchor: {exc}", file=sys.stderr)
        return 1
    except (AnchorError, plan_wake.PlanWakeError) as exc:
        print(f"plan_anchor: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
