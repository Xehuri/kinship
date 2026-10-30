#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""构建并投递 Loom 日计划唤醒（05:00）与晨间复核（07:30）。

05:00：向 Loom 主会话发一条内部消息（【系统通知·日计划】），静默，不发用户手机。
07:30：--kind review 构建【检查点 review-0730】，同样是 Loom 会话内部消息。

HTTP 端点与后端 LoomClient 相同：POST {loom.url}/sessions/{id}/messages，
请求体 {"text": ...}。消息正文不在前面加 <{项目名称}-system> 信封，确保
【系统通知·日计划】/【检查点 review-0730】仍是本轮 user 消息的第一个 token
（设计文档 §5.6 / §11.4 的触发键）。

配置来源（与后端 loom 节同序）：config.yaml loom.url / loom.token /
loom.token_file，环境变量 LOOM_URL / LOOM_TOKEN，以及 systemd 常用的
EnvironmentFile（默认回退 {AI目录}/.loom/credentials.conf）。

仅使用标准库；PyYAML 可用时才读取 config.yaml。临时文件/测试不得触网。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG_PATH = PROJECT_ROOT / "config.yaml"
DEFAULT_LOOM_URL = "http://127.0.0.1:5100"
DEFAULT_TIMEZONE = "Asia/Shanghai"
DEFAULT_SESSION_ENV = "LOOM_PLAN_SESSION_ID"
DEFAULT_TOKEN_ENV = "LOOM_TOKEN"
_AI_DIR = Path(__file__).resolve().parents[1]
DEFAULT_CREDENTIALS_FILE = str(_AI_DIR / ".loom" / "credentials.conf")
DEFAULT_TIMEOUT_SECONDS = 15.0

PLAN_CHECKPOINT = "plan-0500"
PLAN_PAYLOAD_KIND = "plan_wake"
PLAN_TEXT = (
    "【系统通知·日计划】05:00 到了。\n"
    "先读昨日计划并收口，再看今日 brief，最后 plan commit。"
)

REVIEW_CHECKPOINT = "review-0730"
REVIEW_PAYLOAD_KIND = "plan_review"
REVIEW_TEXT = (
    "【检查点 review-0730】07:30–08:00 晨间复核。\n"
    "plan read；检查睡眠是否补齐、天气、课程、用户是否醒着。\n"
    "必要时 plan revise；然后决定说不说话。"
)

KINDS = ("plan", "review")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class PlanWakeError(Exception):
    """参数、配置或会话解析错误（退出码 2，绝不发 HTTP）。"""


class PlanWakeHTTPError(PlanWakeError):
    """Loom 请求失败（退出码 1，已尝试发 HTTP）。"""


def load_timezone(name: str | None) -> ZoneInfo:
    """解析 IANA 时区；不硬编码 UTC+8。"""
    raw = (name or DEFAULT_TIMEZONE).strip() or DEFAULT_TIMEZONE
    try:
        return ZoneInfo(raw)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise PlanWakeError(f"未知时区: {raw!r}（需要 IANA 名称，如 Asia/Shanghai）") from exc


def parse_date(value: str) -> date:
    """严格解析 YYYY-MM-DD；拒绝非零填充与非日期。"""
    raw = str(value).strip()
    if not DATE_RE.match(raw):
        raise PlanWakeError(f"--date 非法: {value!r}（需要 YYYY-MM-DD）")
    try:
        return date.fromisoformat(raw)
    except ValueError as exc:
        raise PlanWakeError(f"--date 非法: {value!r}（需要 YYYY-MM-DD）") from exc


def resolve_event_date(
    value: str | date | None,
    zone: ZoneInfo,
    *,
    now: datetime | None = None,
) -> date:
    """显式日期优先；否则按目标时区取“今天”。"""
    if isinstance(value, date):
        return value
    if value:
        return parse_date(value)
    reference = now or datetime.now(timezone.utc)
    if reference.tzinfo is None:
        raise PlanWakeError("内部时间必须带时区，拒绝 naive datetime")
    return reference.astimezone(zone).date()


def build_payload(
    *,
    kind: str,
    date_value: str | date | None,
    session_id: str,
    timezone_name: str | None = DEFAULT_TIMEZONE,
    now: datetime | None = None,
) -> dict:
    """构建待投递 payload；05:00 与 07:30 共用同一形状。"""
    if kind not in KINDS:
        raise PlanWakeError(f"--kind 非法: {kind!r}（合法: {'|'.join(KINDS)}）")
    target_session = (session_id or "").strip()
    if not target_session:
        raise PlanWakeError(
            "缺少 Loom 目标会话: 用 --session-id 指定，或设置 "
            f"{DEFAULT_SESSION_ENV}/config.yaml loom.plan_session_id"
        )

    zone = load_timezone(timezone_name)
    tz_name = (timezone_name or DEFAULT_TIMEZONE).strip() or DEFAULT_TIMEZONE
    event_date = resolve_event_date(date_value, zone, now=now)

    if kind == "plan":
        payload_kind = PLAN_PAYLOAD_KIND
        checkpoint = PLAN_CHECKPOINT
        clock = time(5, 0)
        text = PLAN_TEXT
    else:
        payload_kind = REVIEW_PAYLOAD_KIND
        checkpoint = REVIEW_CHECKPOINT
        clock = time(7, 30)
        text = REVIEW_TEXT

    scheduled_at = datetime.combine(event_date, clock, tzinfo=zone)
    return {
        "kind": payload_kind,
        "checkpoint": checkpoint,
        "date": event_date.isoformat(),
        "previous_date": (event_date - timedelta(days=1)).isoformat(),
        "timezone": tz_name,
        "scheduled_at": scheduled_at.isoformat(),
        "target_session": target_session,
        "delivery": "loom_session",
        "user_notification": False,
        "text": text,
    }


def _loom_section(config: dict) -> dict:
    value = config.get("loom") if isinstance(config, dict) else None
    return value if isinstance(value, dict) else {}


def read_env_value(path: str | Path, key: str) -> str:
    """读取 EnvironmentFile 风格的 KEY=VALUE；找不到返回空串。"""
    target = Path(path)
    try:
        text = target.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        raise PlanWakeError(f"无法读取 {target}: {exc}") from exc
    for line in text.splitlines():
        candidate = line.strip()
        if not candidate or candidate.startswith("#"):
            continue
        if candidate.startswith("export "):
            candidate = candidate[len("export "):].lstrip()
        name, separator, value = candidate.partition("=")
        if separator and name.strip() == key:
            return value.strip().strip("'\"")
    return ""


def load_config(path: str | Path) -> dict:
    """读取项目 config.yaml；PyYAML 缺失时明确失败，不猜 YAML。"""
    config_path = Path(path)
    if not config_path.is_file():
        raise PlanWakeError(f"配置文件不存在: {config_path}")
    try:
        import yaml
    except ImportError as exc:
        raise PlanWakeError(
            "读取 --config 需要 PyYAML；可改用环境变量或 --no-config"
        ) from exc
    try:
        data = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise PlanWakeError(f"无法解析配置文件 {config_path}: {exc}") from exc
    if data is None:
        return {}
    if not isinstance(data, dict):
        raise PlanWakeError(f"配置文件顶层必须是 mapping: {config_path}")
    return data


def resolve_config(args: argparse.Namespace) -> dict:
    """--no-config 跳过；显式 --config 缺失报错；默认 config.yaml 缺失视为空。"""
    if args.no_config:
        if args.config:
            raise PlanWakeError("--config 与 --no-config 不能同时使用")
        return {}
    if args.config:
        return load_config(args.config)
    if DEFAULT_CONFIG_PATH.is_file():
        return load_config(DEFAULT_CONFIG_PATH)
    return {}


def resolve_session_id(args: argparse.Namespace, config: dict) -> str:
    explicit = (args.session_id or "").strip()
    if explicit:
        return explicit
    env_name = (args.session_id_env or DEFAULT_SESSION_ENV).strip() or DEFAULT_SESSION_ENV
    env_value = (os.environ.get(env_name) or "").strip()
    if env_value:
        return env_value
    configured = str(_loom_section(config).get("plan_session_id") or "").strip()
    if configured:
        return configured
    raise PlanWakeError(
        f"缺少 Loom 目标会话: 用 --session-id 指定，或设置 {env_name}/config.yaml loom.plan_session_id"
    )


def resolve_loom_url(args: argparse.Namespace, config: dict) -> str:
    raw = (args.loom_url or "").strip()
    if not raw:
        raw = (os.environ.get("LOOM_URL") or "").strip()
    if not raw:
        raw = str(_loom_section(config).get("url") or "").strip()
    if not raw:
        raw = DEFAULT_LOOM_URL
    parts = urllib.parse.urlsplit(raw)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise PlanWakeError(f"loom URL 非法: {raw!r}（需要 http(s)://host:port）")
    return raw.rstrip("/")


def resolve_token(args: argparse.Namespace, config: dict) -> str:
    """与后端同序：显式 token 文件 > loom.token > 环境变量 > loom.token_file > 凭据文件。"""
    if args.token_file:
        value = read_env_value(args.token_file, DEFAULT_TOKEN_ENV)
        if value:
            return value
        raise PlanWakeError(f"--token-file 中没有 LOOM_TOKEN=: {args.token_file}")

    loom = _loom_section(config)
    token = str(loom.get("token") or "").strip()
    if token:
        return token

    env_name = (args.token_env or DEFAULT_TOKEN_ENV).strip() or DEFAULT_TOKEN_ENV
    env_value = (os.environ.get(env_name) or "").strip()
    if env_value:
        return env_value

    token_file = str(loom.get("token_file") or "").strip()
    if token_file:
        path = Path(token_file)
        if not path.is_absolute():
            path = PROJECT_ROOT / path
        value = read_env_value(path, DEFAULT_TOKEN_ENV)
        if value:
            return value
        raise PlanWakeError(f"loom.token_file 中没有 LOOM_TOKEN=: {path}")

    if args.credentials_file:
        path = Path(args.credentials_file)
        if path.is_file():
            value = read_env_value(path, DEFAULT_TOKEN_ENV)
            if value:
                return value

    raise PlanWakeError(
        f"缺少 Loom token: 设置 {env_name}、config.yaml loom.token，"
        "或提供已存在的 --credentials-file/--token-file"
    )


def send_payload(
    payload: dict,
    *,
    loom_url: str,
    token: str,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> dict:
    """POST /sessions/:id/messages；仅 202 视为受理。"""
    session_id = payload["target_session"]
    url = (
        f"{loom_url.rstrip('/')}/sessions/"
        f"{urllib.parse.quote(session_id, safe='')}/messages"
    )
    body = json.dumps({"text": payload["text"]}, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = getattr(response, "status", None) or response.getcode()
            raw = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:300]
        raise PlanWakeHTTPError(f"loom HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise PlanWakeHTTPError(f"loom 连接失败 {loom_url}: {exc.reason}") from exc
    except OSError as exc:
        raise PlanWakeHTTPError(f"loom 请求失败 {loom_url}: {exc}") from exc

    if status != 202:
        raise PlanWakeHTTPError(f"loom HTTP {status}（期望 202）: {raw[:300]}")
    try:
        parsed = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        parsed = raw
    return {"status": status, "body": parsed}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="构建/投递 Loom 日计划唤醒（05:00）与晨间复核（07:30）。",
    )
    parser.add_argument(
        "--kind",
        choices=KINDS,
        default="plan",
        help="plan=05:00 日计划唤醒；review=07:30 晨间复核（默认 plan）",
    )
    parser.add_argument("--date", default=None, help="YYYY-MM-DD；缺省按 --timezone 的今天")
    parser.add_argument(
        "--timezone",
        default=DEFAULT_TIMEZONE,
        help=f"IANA 时区（默认 {DEFAULT_TIMEZONE}）",
    )
    parser.add_argument("--session-id", default=None, help="Loom 目标会话 ID")
    parser.add_argument(
        "--session-id-env",
        default=DEFAULT_SESSION_ENV,
        help=f"从该环境变量读取会话 ID（默认 {DEFAULT_SESSION_ENV}）",
    )
    parser.add_argument("--loom-url", default=None, help=f"默认 {DEFAULT_LOOM_URL}")
    parser.add_argument(
        "--token-env",
        default=DEFAULT_TOKEN_ENV,
        help=f"从该环境变量读取 Bearer token（默认 {DEFAULT_TOKEN_ENV}）",
    )
    parser.add_argument("--token-file", default=None, help="EnvironmentFile 形式的 token 文件")
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
        help="只打印 JSON payload，不发 HTTP、不要求 token",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.timeout <= 0:
            raise PlanWakeError("--timeout 必须大于 0")
        config = resolve_config(args)
        session_id = resolve_session_id(args, config)
        payload = build_payload(
            kind=args.kind,
            date_value=args.date,
            session_id=session_id,
            timezone_name=args.timezone,
        )
        if args.dry_run:
            print(json.dumps(payload, ensure_ascii=False, indent=2))
            return 0

        loom_url = resolve_loom_url(args, config)
        token = resolve_token(args, config)
        result = send_payload(
            payload,
            loom_url=loom_url,
            token=token,
            timeout=args.timeout,
        )
        print(
            json.dumps(
                {
                    "sent": True,
                    "status": result["status"],
                    "kind": payload["kind"],
                    "date": payload["date"],
                    "target_session": payload["target_session"],
                },
                ensure_ascii=False,
            )
        )
        return 0
    except PlanWakeHTTPError as exc:
        print(f"plan_wake: {exc}", file=sys.stderr)
        return 1
    except PlanWakeError as exc:
        print(f"plan_wake: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
