#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""从 coverage.yaml、任务 YAML 与 long-tasks 生成首版 Master Plan。

真源写到 ``{root}/plan/master.json``，同时渲染 ``{root}/plan/master.md``。
``--root`` 必须显式给出（生产为 {AI目录}/data），因此默认不会碰生产目录；
``--dry-run`` 只打印计划、不落盘。已存在的 master 默认拒绝覆盖，只有
``--force --expected-version N`` 才能按 CAS 语义重写。

用法::

    python {AI目录}/analysis/master_plan_seed.py --root {AI目录}/data
    python {AI目录}/analysis/master_plan_seed.py --root {AI目录}/data --dry-run
    python {AI目录}/analysis/master_plan_seed.py --root {AI目录}/data \
        --long-term-at lt_soak_7d=20:00
    python {AI目录}/analysis/master_plan_seed.py --root {AI目录}/data --force \
        --expected-version 1 --long-term-at lt_soak_7d=20:00
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError:  # pragma: no cover - 生产 venv 已装 PyYAML
    yaml = None

MASTER_SCHEMA = 1
COVERAGE_IDS = ("cov-00", "cov-06", "cov-08", "cov-12", "cov-16", "cov-20", "cov-22")
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
PHONE_RE = re.compile(r"(?<!\d)\d{10,11}(?!\d)")
LONG_TASK_ID_RE = re.compile(r"^lt_[a-z0-9_]{4,32}$")

TASK_FILES = {
    "plan.build": "05-plan-wake.yaml",
    "plan.review": "07-plan-review.yaml",
    "review.daily": "12-daily-review.yaml",
    "review.biweekly": "13-biweekly-review.yaml",
    "review.weekly": "14-weekly-summary.yaml",
    "audit.night": "15-night-audit.yaml",
    "weather.morning": "16-weather-morning.yaml",
    "probe.run": "99-loom-probe.yaml",
    "fleet.run": "100-loom-fleet.yaml",
}

WEATHER_INSTRUCTION = "按业务手册执行：{AI目录}/memory/self/tasks/天气播报.md（只播事实，不改写）。"

FIXED_SLOTS = (
    {
        "id": "daily-review",
        "action": "review.daily",
        "title": "今日复盘",
        "enabled": True,
        "schedule": {"kind": "daily", "at": "00:40"},
    },
    {
        "id": "night-audit",
        "action": "audit.night",
        "title": "夜间审计",
        "enabled": False,
        "schedule": {"kind": "daily", "at": "02:00"},
    },
    {
        "id": "weekly-review",
        "action": "review.weekly",
        "title": "周报总结",
        "enabled": True,
        "schedule": {"kind": "weekly", "days": ["mon"], "at": "03:00"},
    },
    {
        "id": "compactor",
        "action": "session.compact",
        "title": "会话压缩",
        "enabled": True,
        "schedule": {"kind": "daily", "at": "04:00"},
    },
    {
        "id": "loom-probe",
        "action": "probe.run",
        "title": "Loom 日常自检探针",
        "enabled": False,
        "schedule": {"kind": "daily", "at": "04:00"},
    },
    {
        "id": "weather",
        "action": "weather.morning",
        "title": "每日天气",
        "enabled": False,
        "schedule": {"kind": "daily", "at": "07:00"},
    },
    {
        "id": "loom-fleet",
        "action": "fleet.run",
        "title": "Loom 全功能 fleet 验收",
        "enabled": False,
        "schedule": {"kind": "daily", "at": "08:30"},
    },
    {
        "id": "biweekly",
        "action": "review.biweekly",
        "title": "双周深度回顾",
        "enabled": True,
        "schedule": {"kind": "monthly", "days": [1, 15], "at": "18:30"},
    },
    {
        "id": "plan-build",
        "action": "plan.build",
        "title": "日计划",
        "enabled": True,
        "schedule": {"kind": "daily", "at": "05:00"},
    },
    {
        "id": "plan-review",
        "action": "plan.review",
        "title": "计划复核",
        "enabled": True,
        "schedule": {"kind": "daily", "at": "07:30"},
    },
)


class SeedError(Exception):
    """输入/目标状态不允许生成 Master Plan。"""


def _load_yaml(path: Path) -> dict[str, Any]:
    if yaml is None:
        raise SeedError("需要 PyYAML 才能读取 YAML 输入")
    try:
        payload = yaml.safe_load(path.read_text(encoding="utf-8-sig"))
    except OSError as exc:
        raise SeedError(f"读取失败 {path}: {exc}") from exc
    except yaml.YAMLError as exc:
        raise SeedError(f"YAML 解析失败 {path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise SeedError(f"YAML 顶层必须是对象: {path}")
    return payload


def _sanitize_instruction(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    text = PHONE_RE.sub("[手机号已脱敏]", value).strip()
    return text or None


def _task_payload(root: Path, action: str) -> dict[str, Any]:
    filename = TASK_FILES.get(action)
    if filename is None:
        return {}
    path = root / "tasks" / filename
    if not path.exists():
        return {}
    return _load_yaml(path)


def _now_ms() -> int:
    return int(datetime.now(tz=timezone.utc).timestamp() * 1000)


def _iso_to_ms(value: Any, field: str) -> int:
    if not isinstance(value, str) or not value.strip():
        raise SeedError(f"{field} 必须是非空 ISO 时间字符串")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise SeedError(f"{field} 不是合法 ISO 时间: {value}") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return int(parsed.timestamp() * 1000)


def _require_time(value: Any, field: str) -> str:
    if not isinstance(value, str) or not TIME_RE.match(value):
        raise SeedError(f"{field} 必须是 HH:MM: {value!r}")
    return value


def _require_date(value: Any, field: str) -> str:
    if not isinstance(value, str) or not DATE_RE.match(value):
        raise SeedError(f"{field} 必须是 YYYY-MM-DD: {value!r}")
    try:
        date.fromisoformat(value)
    except ValueError as exc:
        raise SeedError(f"{field} 不是有效日期: {value}") from exc
    return value


def _build_fixed_entries(root: Path, now: int) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for slot in FIXED_SLOTS:
        task = _task_payload(root, str(slot["action"]))
        title = task.get("name") if isinstance(task.get("name"), str) else slot["title"]
        if slot["action"] == "weather.morning":
            instruction = WEATHER_INSTRUCTION
        else:
            instruction = _sanitize_instruction(task.get("prompt"))
        entry: dict[str, Any] = {
            "id": slot["id"],
            "kind": "fixed",
            "title": title or slot["title"],
            "enabled": slot["enabled"],
            "action": slot["action"],
            "schedule": slot["schedule"],
            "created_at": now,
            "updated_at": now,
        }
        if instruction is not None:
            entry["instruction"] = instruction
        entries.append(entry)
    return entries


def _build_coverage_entries(root: Path, now: int) -> list[dict[str, Any]]:
    coverage_path = root / "plan" / "coverage.yaml"
    if not coverage_path.exists():
        raise SeedError(f"缺少覆盖配置: {coverage_path}")
    coverage = _load_yaml(coverage_path)
    timezone_name = coverage.get("timezone")
    if not isinstance(timezone_name, str) or not timezone_name.strip():
        raise SeedError("coverage.yaml 缺少 timezone")
    profiles = coverage.get("profiles")
    if not isinstance(profiles, dict):
        raise SeedError("coverage.yaml 缺少 profiles")
    profile_name = coverage.get("default", "merged_7")
    profile = profiles.get(profile_name)
    if not isinstance(profile, dict):
        raise SeedError(f"coverage.yaml 缺少默认档位: {profile_name}")
    checkpoints = profile.get("checkpoints")
    if not isinstance(checkpoints, dict):
        raise SeedError(f"coverage.yaml 档位 {profile_name} 缺少 checkpoints")

    entries: list[dict[str, Any]] = []
    for checkpoint_id in COVERAGE_IDS:
        checkpoint = checkpoints.get(checkpoint_id)
        if not isinstance(checkpoint, dict):
            raise SeedError(f"coverage.yaml 缺少检查点: {checkpoint_id}")
        trigger = _require_time(checkpoint.get("trigger"), f"{checkpoint_id}.trigger")
        target_date = checkpoint.get("target_date")
        if target_date not in (None, "today", "previous_day"):
            raise SeedError(f"{checkpoint_id}.target_date 非法: {target_date!r}")
        if target_date is None:
            target_date = "previous_day" if checkpoint_id == "cov-00" else "today"
        window = checkpoint.get("window")
        if window is not None and not isinstance(window, str):
            raise SeedError(f"{checkpoint_id}.window 非法: {window!r}")
        entry: dict[str, Any] = {
            "id": checkpoint_id,
            "kind": "anchor",
            "title": f"覆盖检查点 {checkpoint_id}",
            "enabled": True,
            "action": "coverage.run",
            "schedule": {"kind": "daily", "at": trigger},
            "target_date": target_date,
            "created_at": now,
            "updated_at": now,
        }
        if window:
            entry["window"] = window
        entries.append(entry)
    return entries


def _coverage_timezone(root: Path) -> str:
    path = root / "plan" / "coverage.yaml"
    payload = _load_yaml(path)
    zone = payload.get("timezone")
    if not isinstance(zone, str) or not zone.strip():
        raise SeedError("coverage.yaml 缺少 timezone")
    return zone


def _parse_long_term_times(values: list[str]) -> dict[str, str]:
    times: dict[str, str] = {}
    for raw in values:
        if "=" not in raw:
            raise SeedError(f"--long-term-at 需要 id=HH:MM: {raw}")
        task_id, clock = raw.split("=", 1)
        if not LONG_TASK_ID_RE.match(task_id):
            raise SeedError(f"--long-term-at 的 id 非法: {task_id}")
        if task_id in times:
            raise SeedError(f"--long-term-at 重复指定: {task_id}")
        times[task_id] = _require_time(clock, f"--long-term-at {task_id}")
    return times


def _weekday_token(date_key: str) -> str:
    names = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
    return names[date.fromisoformat(date_key).weekday()]


def _build_long_term_entries(
    root: Path,
    now: int,
    long_term_times: dict[str, str],
) -> list[dict[str, Any]]:
    directory = root / "plan" / "long-tasks"
    if not directory.exists():
        return []
    paths = sorted(directory.glob("*.json"))
    if not paths:
        return []
    entries: list[dict[str, Any]] = []
    seen: set[str] = set()
    for path in paths:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise SeedError(f"读取长期任务失败 {path}: {exc}") from exc
        if not isinstance(payload, dict):
            raise SeedError(f"长期任务顶层必须是对象: {path}")
        task_id = payload.get("id")
        if not isinstance(task_id, str) or not LONG_TASK_ID_RE.match(task_id):
            raise SeedError(f"长期任务 id 非法: {path}")
        if task_id in seen:
            raise SeedError(f"长期任务 id 重复: {task_id}")
        seen.add(task_id)
        if task_id not in long_term_times:
            raise SeedError(f"缺少 --long-term-at {task_id}=HH:MM（不提供静默默认值）")
        next_check = _require_date(payload.get("next_check"), f"{task_id}.next_check")
        status = payload.get("status")
        if status not in ("active", "paused", "archived"):
            raise SeedError(f"{task_id}.status 非法: {status!r}")
        cadence = payload.get("cadence")
        at = long_term_times[task_id]
        if cadence == "daily":
            schedule: dict[str, Any] = {"kind": "daily", "at": at}
        elif cadence == "weekly":
            schedule = {"kind": "weekly", "days": [_weekday_token(next_check)], "at": at}
        elif cadence == "monthly":
            schedule = {
                "kind": "monthly",
                "days": [date.fromisoformat(next_check).day],
                "at": at,
            }
        elif cadence == "once":
            schedule = {"kind": "once", "date": next_check, "at": at}
        else:
            raise SeedError(f"{task_id}.cadence 非法: {cadence!r}")

        title = payload.get("title")
        intent = payload.get("intent")
        if not isinstance(title, str) or not title.strip():
            raise SeedError(f"{task_id}.title 必须是非空字符串")
        if not isinstance(intent, str) or not intent.strip():
            raise SeedError(f"{task_id}.intent 必须是非空字符串")
        created_at = _iso_to_ms(payload.get("created_at"), f"{task_id}.created_at")
        updated_at = _iso_to_ms(payload.get("updated_at"), f"{task_id}.updated_at")
        last_done = payload.get("last_done")
        if last_done is not None:
            last_done = _require_date(last_done, f"{task_id}.last_done")
        entry: dict[str, Any] = {
            "id": task_id,
            "kind": "long_term",
            "title": title,
            "intent": intent,
            "enabled": status == "active",
            "action": "longterm.due",
            "schedule": schedule,
            "created_at": created_at,
            "updated_at": updated_at,
            "status": status,
            "next_check": next_check,
            "legacy_long_task_id": task_id,
        }
        if last_done is not None:
            entry["last_done"] = last_done
        entries.append(entry)
    return entries


def build_master(
    root: Path,
    *,
    long_term_times: dict[str, str] | None = None,
    now: int | None = None,
    version: int = 1,
    created_at: int | None = None,
) -> dict[str, Any]:
    """构造 Master Plan 文档（不落盘）。"""
    stamp = _now_ms() if now is None else now
    timezone_name = _coverage_timezone(root)
    entries = _build_fixed_entries(root, stamp)
    entries.extend(_build_coverage_entries(root, stamp))
    entries.extend(_build_long_term_entries(root, stamp, long_term_times or {}))
    return {
        "schema": MASTER_SCHEMA,
        "kind": "master-plan",
        "timezone": timezone_name,
        "version": version,
        "created_at": stamp if created_at is None else created_at,
        "updated_at": stamp,
        "entries": entries,
    }


def _render_schedule(schedule: dict[str, Any]) -> str:
    kind = schedule.get("kind")
    if kind == "daily":
        return f"daily {schedule['at']}"
    if kind == "weekly":
        return f"weekly {','.join(str(day) for day in schedule['days'])} {schedule['at']}"
    if kind == "monthly":
        return f"monthly {','.join(str(day) for day in schedule['days'])} {schedule['at']}"
    return f"once {schedule['date']} {schedule['at']}"


def _render_timestamp(value: int) -> str:
    return (
        datetime.fromtimestamp(value / 1000, tz=timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def render_master_markdown(document: dict[str, Any]) -> str:
    lines = [
        "# Master Plan",
        "",
        f"- schema: {document['schema']}",
        "- kind: master-plan",
        f"- timezone: {document['timezone']}",
        f"- version: {document['version']}",
        f"- created_at: {_render_timestamp(document['created_at'])}",
        f"- updated_at: {_render_timestamp(document['updated_at'])}",
        f"- entries: {len(document['entries'])}",
        "",
        "## Entries",
        "",
    ]
    for entry in document["entries"]:
        lines.append(f"### {entry['id']} [{entry['kind']}] {entry['title']}")
        lines.append("")
        lines.append(f"- enabled: {str(entry['enabled']).lower()}")
        if "action" in entry:
            lines.append(f"- action: {entry['action']}")
        lines.append(f"- schedule: {_render_schedule(entry['schedule'])}")
        for key in (
            "target_date",
            "window",
            "intent",
            "done_when",
            "status",
            "next_check",
            "last_done",
            "legacy_long_task_id",
        ):
            if key in entry:
                lines.append(f"- {key}: {entry[key]}")
        if "instruction" in entry:
            text = str(entry["instruction"]).replace("\r\n", "\n").replace("\n", "\n  ")
            lines.append(f"- instruction: {text}")
        lines.append("")
    return "\n".join(lines) + "\n"


def _write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f"{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    except Exception:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


def _read_existing(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SeedError(f"现有 master 无法解析，拒绝覆盖 {path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise SeedError(f"现有 master 顶层不是对象: {path}")
    version = payload.get("version")
    if not isinstance(version, int) or version < 1:
        raise SeedError(f"现有 master version 非法: {version!r}")
    return payload


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="生成首版 Master Plan（默认不写生产）")
    parser.add_argument("--root", required=True, help="planRoot 绝对路径，生产为 {AI目录}/data")
    parser.add_argument("--dry-run", action="store_true", help="只构造并打印摘要，不落盘")
    parser.add_argument("--force", action="store_true", help="允许覆盖已存在 master")
    parser.add_argument("--expected-version", type=int, help="--force 时的 CAS 版本")
    parser.add_argument(
        "--long-term-at",
        action="append",
        default=[],
        metavar="ID=HH:MM",
        help="为每个 long-tasks/*.json 指定唤醒时刻（可重复）",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return int(exc.code or 0)

    root = Path(args.root).expanduser()
    if not root.is_absolute():
        root = (Path.cwd() / root).resolve()
    if args.force and args.expected_version is None:
        print("--force 需要同时给出 --expected-version N", file=sys.stderr)
        return 2
    if not args.force and args.expected_version is not None:
        print("--expected-version 只能与 --force 一起使用", file=sys.stderr)
        return 2
    if args.expected_version is not None and args.expected_version < 1:
        print("--expected-version 必须是 >=1 的整数", file=sys.stderr)
        return 2

    master_path = root / "plan" / "master.json"
    markdown_path = root / "plan" / "master.md"
    try:
        existing = _read_existing(master_path)
        if existing is not None:
            if args.force:
                if existing["version"] != args.expected_version:
                    raise SeedError(
                        f"版本冲突: expected {args.expected_version}, actual {existing['version']}"
                    )
            elif not args.dry_run:
                raise SeedError(f"master 已存在，拒绝覆盖: {master_path}（需要 --force --expected-version N）")
        long_term_times = _parse_long_term_times(list(args.long_term_at))
        document = build_master(
            root,
            long_term_times=long_term_times,
            version=1 if existing is None else existing["version"] + 1,
            created_at=None if existing is None else existing.get("created_at"),
        )
    except SeedError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    if args.dry_run:
        print(
            f"DRY RUN: would write {master_path} "
            f"version={document['version']} entries={len(document['entries'])}"
        )
        return 0

    try:
        _write_atomic(
            master_path,
            json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        )
        _write_atomic(markdown_path, render_master_markdown(document))
    except OSError as exc:
        print(f"写入失败: {exc}", file=sys.stderr)
        return 1
    print(f"Wrote {master_path} (version={document['version']}, entries={len(document['entries'])})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
