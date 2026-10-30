"""计划板只读路由（Plan API v1）。

为前端 PlanView 提供只读数据：日计划、覆盖契约、到期长期任务。
数据全部经 ``_cfg.DATA_DIR`` 从文件系统读取，本模块**不写任何文件**。

冻结契约：
  GET /api/plan/long-tasks
      → 200 {"tasks": [...], "generated_at": int(unix 秒)}
  GET /api/plan/{date}（YYYY-MM-DD）
      → 200 {"date", "plan", "coverage", "long_tasks_due",
             "warnings", "generated_at"}
      - 计划文件不存在 → plan: null（不是 404）；
      - coverage.yaml 不存在 → coverage: null；
      - 计划 JSON 损坏 → 500（明确 detail），绝不返回半成品；
      - 单个长期任务 JSON 损坏 → 记入 warnings 并跳过，不拖垮整个请求。
  GET /api/plan/{date}/effective（T13，只读）
      → 200 {"date", "master_version", "master", "overlay",
             "effective": {"items", "coverage"}, "long_tasks_due",
             "warnings", "generated_at"}
      - master.json / 覆盖层缺失 → null / 空视图 + warnings（不是错误）；
      - 覆盖层缺失但有 v1 计划 → 有效条目回退 v1（只读）；
      - 母版或覆盖层损坏 → 500（明确 detail）；
      - 本端点绝不写文件，v1 两个端点形状保持不变。

静态路由 ``long-tasks`` 与 ``{date}/effective`` 必须声明在 ``{date:path}`` 之前，保证其不被当成日期参数。
``{date:path}`` 使用 path 转换器捕获含 ``../`` 的穿越路径，统一由日期校验
返回 400，而不是交给路由层返回 404。
"""

import json
import logging
import re
import time
from datetime import date as _date
from pathlib import Path
from typing import Any

import yaml
from fastapi import APIRouter, HTTPException

from config.config import get_config

logger = logging.getLogger(__name__)

router = APIRouter(tags=["计划"])

_cfg = get_config()

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _validate_date(value: str) -> str:
    """校验 YYYY-MM-DD 且必须是真实存在的日历日期，否则 400。"""
    if not _DATE_RE.fullmatch(value):
        raise HTTPException(status_code=400, detail="日期格式必须为 YYYY-MM-DD")
    try:
        _date.fromisoformat(value)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"无效日期: {value}")
    return value


def _data_dir() -> Path:
    return Path(_cfg.DATA_DIR)


def _plan_file(date_str: str) -> Path:
    return _data_dir() / "daily" / date_str / f"plan-{date_str}.json"


def _read_plan(date_str: str) -> Any | None:
    """读取日计划；文件不存在返回 None，JSON 损坏返回 500。"""
    path = _plan_file(date_str)
    if not path.is_file():
        return None
    try:
        with path.open("r", encoding="utf-8") as fh:
            return json.load(fh)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise HTTPException(
            status_code=500,
            detail=f"计划文件损坏: {path.name} ({exc})",
        )
    except OSError as exc:
        raise HTTPException(
            status_code=500,
            detail=f"计划文件读取失败: {path.name} ({exc})",
        )


def _read_coverage(warnings: list[str]) -> Any | None:
    """读取覆盖契约；不存在返回 None，损坏记 warning 并按 None 返回。"""
    path = _data_dir() / "plan" / "coverage.yaml"
    if not path.is_file():
        return None
    try:
        with path.open("r", encoding="utf-8") as fh:
            return yaml.safe_load(fh)
    except yaml.YAMLError as exc:
        warnings.append(f"coverage.yaml 解析失败，已忽略: {exc}")
    except (OSError, UnicodeDecodeError) as exc:
        warnings.append(f"coverage.yaml 读取失败，已忽略: {exc}")
    return None


def _read_long_tasks(warnings: list[str] | None) -> list[dict[str, Any]]:
    """读取全部长期任务，按 next_check、id 升序排序。

    单个文件不是合法 JSON / 不是对象时：warnings 非 None 则追加警告，
    随后跳过，绝不让整个请求失败。
    """
    directory = _data_dir() / "plan" / "long-tasks"
    if not directory.is_dir():
        return []

    tasks: list[dict[str, Any]] = []
    for path in sorted(directory.glob("*.json")):
        try:
            with path.open("r", encoding="utf-8") as fh:
                record = json.load(fh)
        except (json.JSONDecodeError, UnicodeDecodeError, OSError) as exc:
            if warnings is not None:
                warnings.append(f"长期任务文件无效，已跳过: {path.name} ({exc})")
            continue
        if not isinstance(record, dict):
            if warnings is not None:
                warnings.append(f"长期任务文件不是对象，已跳过: {path.name}")
            continue
        task = dict(record)
        task.setdefault("id", path.stem)
        tasks.append(task)

    tasks.sort(key=lambda task: (str(task.get("next_check") or ""), str(task.get("id") or "")))
    return tasks


def _due_tasks(tasks: list[dict[str, Any]], date_str: str) -> list[dict[str, Any]]:
    """active 且 next_check <= date（与 Loom 侧字符串比较口径一致）。"""
    return [
        task
        for task in tasks
        if task.get("status") == "active"
        and isinstance(task.get("next_check"), str)
        and task["next_check"] <= date_str
    ]


# ── 有效视图（母版 + 当日覆盖层，只读投影，T13） ──────────────────

_MASTER_KINDS = {"fixed", "anchor", "long_term"}
_OVERLAY_STATUSES = {"draft", "committed", "closed"}
_OVERLAY_OPS = {"add", "update", "remove", "note"}
_PLAN_ITEM_STATUSES = {"planned", "done", "skipped", "carried", "blocked"}
_PATCH_KEYS = (
    "at",
    "action",
    "payload",
    "intent",
    "window",
    "done_when",
    "note",
    "status",
    "evidence",
    "done_at",
)
_WEEKDAY_TOKENS = {
    "sun": 0,
    "sunday": 0,
    "mon": 1,
    "monday": 1,
    "tue": 2,
    "tues": 2,
    "tuesday": 2,
    "wed": 3,
    "wednesday": 3,
    "thu": 4,
    "thur": 4,
    "thurs": 4,
    "thursday": 4,
    "fri": 5,
    "friday": 5,
    "sat": 6,
    "saturday": 6,
}


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _master_file() -> Path:
    return _data_dir() / "plan" / "master.json"


def _overlay_file(date_str: str) -> Path:
    return _data_dir() / "daily" / date_str / f"plan-{date_str}.overlay.json"


def _read_json_object(path: Path, label: str) -> dict[str, Any]:
    """读取 JSON 对象；损坏/根节点非对象统一 500（明确 detail）。"""
    try:
        with path.open("r", encoding="utf-8") as fh:
            payload = json.load(fh)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise HTTPException(
            status_code=500,
            detail=f"{label}损坏: {path.name} ({exc})",
        )
    except OSError as exc:
        raise HTTPException(
            status_code=500,
            detail=f"{label}读取失败: {path.name} ({exc})",
        )
    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=500,
            detail=f"{label}损坏: {path.name} (根节点不是对象)",
        )
    return payload


def _validate_master(payload: dict[str, Any], path: Path) -> dict[str, Any]:
    """母版文档最小校验；损坏一律 500，绝不返回半成品。"""

    def fail(message: str) -> None:
        raise HTTPException(
            status_code=500,
            detail=f"母版文件损坏: {path.name} ({message})",
        )

    if payload.get("schema") != 1:
        fail("schema 必须为 1")
    if payload.get("kind") != "master-plan":
        fail('kind 必须为 "master-plan"')
    version = payload.get("version")
    if not _is_int(version) or version < 1:
        fail("version 必须是 >=1 的整数")
    timezone = payload.get("timezone")
    if not isinstance(timezone, str) or not timezone.strip():
        fail("timezone 必须是非空字符串")
    entries = payload.get("entries")
    if not isinstance(entries, list):
        fail("entries 必须是数组")
    seen: set[str] = set()
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            fail(f"entries[{index}] 必须是对象")
        entry_id = entry.get("id")
        if not isinstance(entry_id, str) or not entry_id:
            fail(f"entries[{index}].id 必须是非空字符串")
        if entry.get("kind") not in _MASTER_KINDS:
            fail(f"entries[{index}].kind 必须是 fixed | anchor | long_term 之一")
        if entry_id in seen:
            fail(f"entries.id 重复: {entry_id}")
        seen.add(entry_id)
    return payload


def _validate_overlay(
    payload: dict[str, Any], path: Path, date_str: str
) -> dict[str, Any]:
    """覆盖层文档最小校验；损坏一律 500。"""

    def fail(message: str) -> None:
        raise HTTPException(
            status_code=500,
            detail=f"覆盖层文件损坏: {path.name} ({message})",
        )

    if payload.get("schema") != 1:
        fail("schema 必须为 1")
    if payload.get("kind") != "plan-overlay":
        fail('kind 必须为 "plan-overlay"')
    if payload.get("date") != date_str:
        fail(f"date 必须是 {date_str}")
    version = payload.get("version")
    if not _is_int(version) or version < 1:
        fail("version 必须是 >=1 的整数")
    base_version = payload.get("base_version")
    if not _is_int(base_version) or base_version < 1:
        fail("base_version 必须是 >=1 的整数")
    if payload.get("status") not in _OVERLAY_STATUSES:
        fail("status 必须是 draft | committed | closed 之一")
    ops = payload.get("ops")
    if not isinstance(ops, list):
        fail("ops 必须是数组")
    for index, op in enumerate(ops):
        if not isinstance(op, dict):
            fail(f"ops[{index}] 必须是对象")
        if op.get("op") not in _OVERLAY_OPS:
            fail(f"ops[{index}].op 必须是 add | update | remove | note 之一")
    coverage = payload.get("coverage")
    if coverage is not None and not isinstance(coverage, dict):
        fail("coverage 必须是对象")
    return payload


def _weekday_index(value: Any) -> int | None:
    """周几归一为 0=周日..6=周六（与 Loom/JS getUTCDay 口径一致）。"""
    if _is_int(value):
        if value == 7:
            return 0
        return value if 0 <= value <= 6 else None
    if isinstance(value, str):
        token = value.strip().lower()
        if token.isdigit():
            numeric = int(token)
            if numeric == 7:
                return 0
            return numeric if 0 <= numeric <= 6 else None
        return _WEEKDAY_TOKENS.get(token)
    return None


def _schedule_matches(schedule: Any, date_str: str) -> bool:
    if not isinstance(schedule, dict):
        return False
    kind = schedule.get("kind")
    day = _date.fromisoformat(date_str)
    if kind == "daily":
        return True
    if kind == "weekly":
        days = schedule.get("days")
        if not isinstance(days, list):
            return False
        weekday = day.isoweekday() % 7  # 周一=1..周日=7 -> 0..6, 周日=0
        return any(_weekday_index(item) == weekday for item in days)
    if kind == "monthly":
        days = schedule.get("days")
        if not isinstance(days, list):
            return False
        return any(
            (_is_int(item) and item == day.day)
            or (isinstance(item, str) and item.isdigit() and int(item) == day.day)
            for item in days
        )
    if kind == "once":
        return schedule.get("date") == date_str
    return False


def _materialize_master(
    master: dict[str, Any] | None, date_str: str
) -> list[dict[str, Any]]:
    if master is None:
        return []
    due: list[dict[str, Any]] = []
    for entry in master.get("entries") or []:
        if not entry.get("enabled"):
            continue
        if entry.get("kind") == "long_term":
            if entry.get("status") != "active":
                continue
            next_check = entry.get("next_check")
            if not isinstance(next_check, str) or next_check > date_str:
                continue
        if not _schedule_matches(entry.get("schedule"), date_str):
            continue
        due.append(entry)
    return due


def _base_effective_item(
    item_id: str,
    kind: str,
    status: str,
    source: str,
    master_version: int | None,
    overlay_version: int | None,
) -> dict[str, Any]:
    return {
        "id": item_id,
        "kind": kind,
        "status": status,
        "at_override": False,
        "source": source,
        "suppressed": False,
        "master_version": master_version,
        "overlay_version": overlay_version,
    }


def _master_item(
    entry: dict[str, Any], master_version: int, overlay_version: int | None
) -> dict[str, Any]:
    item = _base_effective_item(
        entry["id"],
        str(entry.get("kind") or "fixed"),
        "planned",
        "master",
        master_version,
        overlay_version,
    )
    item["title"] = entry.get("title") or entry["id"]
    schedule = entry.get("schedule")
    if isinstance(schedule, dict) and isinstance(schedule.get("at"), str):
        item["at"] = schedule["at"]
    for key in (
        "intent",
        "action",
        "payload",
        "instruction",
        "window",
        "done_when",
        "target_date",
    ):
        if key in entry:
            item[key] = entry[key]
    return item


def _overlay_item(
    entry: dict[str, Any], master_version: int | None, overlay_version: int
) -> dict[str, Any]:
    item = _base_effective_item(
        entry["id"],
        str(entry.get("kind") or "note"),
        str(entry.get("status") or "planned"),
        "overlay",
        master_version,
        overlay_version,
    )
    item["intent"] = entry.get("intent") or ""
    for key in (
        "at",
        "action",
        "payload",
        "window",
        "done_when",
        "target_date",
        "checkpoint_id",
        "not_do",
        "note",
        "evidence",
        "done_at",
    ):
        if key in entry:
            item[key] = entry[key]
    return item


def _apply_patch(item: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    updated = dict(item)
    for key in _PATCH_KEYS:
        if key not in patch:
            continue
        value = patch[key]
        if value is None:
            updated.pop(key, None)
            continue
        if key == "status" and value not in _PLAN_ITEM_STATUSES:
            continue
        updated[key] = value
    if patch.get("at") is not None:
        updated["at_override"] = True
    else:
        updated["at_override"] = False
    return updated


def _legacy_item(item: dict[str, Any], master_version: int | None, version: int) -> dict[str, Any]:
    entry = _base_effective_item(
        str(item.get("id") or ""),
        str(item.get("kind") or "note"),
        str(item.get("status") or "planned"),
        "overlay",
        master_version,
        version,
    )
    entry["intent"] = item.get("intent") or entry["id"]
    for key in ("target_date", "window", "checkpoint_id", "done_when", "not_do", "note"):
        if key in item:
            entry[key] = item[key]
    return entry


def _effective_items(
    master: dict[str, Any] | None,
    overlay: dict[str, Any] | None,
    legacy_plan: dict[str, Any] | None,
    date_str: str,
    warnings: list[str],
) -> list[dict[str, Any]]:
    """母版物化 + 覆盖层 op 的只读投影；绝不写文件。"""
    master_version = master.get("version") if master is not None else None

    if overlay is None:
        if legacy_plan is None:
            return []
        warnings.append("legacy_fallback")
        legacy_version = legacy_plan.get("version")
        version = legacy_version if _is_int(legacy_version) else 0
        raw_items = legacy_plan.get("items")
        if not isinstance(raw_items, list):
            return []
        return [
            _legacy_item(item, master_version, version)
            for item in raw_items
            if isinstance(item, dict) and item.get("id")
        ]

    overlay_version = overlay["version"]
    if master is None:
        warnings.append("master_missing: 覆盖层无法合并，有效条目为空")
        return []

    items = [
        _master_item(entry, master["version"], overlay_version)
        for entry in _materialize_master(master, date_str)
    ]
    index = {item["id"]: position for position, item in enumerate(items)}

    if overlay["base_version"] != master["version"]:
        warnings.append(
            f"base_stale:{overlay['base_version']}!={master['version']}"
        )

    for op in overlay.get("ops") or []:
        kind = op.get("op")
        if kind == "add":
            entry = op.get("item")
            if not isinstance(entry, dict) or not isinstance(entry.get("id"), str):
                continue
            if entry["id"] in index:
                warnings.append(f"add_collision:{entry['id']}")
                continue
            items.append(_overlay_item(entry, master["version"], overlay_version))
            index[entry["id"]] = len(items) - 1
        elif kind in ("update", "remove"):
            target_id = op.get("id")
            position = index.get(target_id) if isinstance(target_id, str) else None
            if position is None:
                warnings.append(f"orphan_{kind}:{target_id}")
                continue
            if kind == "remove":
                items[position] = {**items[position], "suppressed": True}
                continue
            patch = op.get("patch")
            if isinstance(patch, dict):
                items[position] = _apply_patch(items[position], patch)
    return items


def _effective_coverage(
    overlay: dict[str, Any] | None, legacy_plan: dict[str, Any] | None
) -> Any | None:
    if overlay is not None:
        coverage = overlay.get("coverage")
        return coverage if isinstance(coverage, dict) else None
    if legacy_plan is not None:
        coverage = legacy_plan.get("coverage")
        return coverage if isinstance(coverage, dict) else None
    return None


@router.get("/plan/long-tasks")
async def list_long_tasks():
    """列出全部长期任务（静态路由，必须先于 /plan/{date} 声明）。"""
    return {
        "tasks": _read_long_tasks(None),
        "generated_at": int(time.time()),
    }


@router.get("/plan/{date}/effective")
async def get_effective_plan(date: str):
    """母版 + 当日覆盖层的有效视图（只读；必须先于 /plan/{date:path} 声明）。"""
    date_str = _validate_date(date)
    warnings: list[str] = []

    master: dict[str, Any] | None = None
    master_path = _master_file()
    if master_path.is_file():
        master = _validate_master(
            _read_json_object(master_path, "母版文件"), master_path
        )
    else:
        warnings.append(f"{master_path.name} 不存在，母版条目为空")

    overlay: dict[str, Any] | None = None
    overlay_path = _overlay_file(date_str)
    if overlay_path.is_file():
        overlay = _validate_overlay(
            _read_json_object(overlay_path, "覆盖层文件"), overlay_path, date_str
        )
    else:
        warnings.append(f"{overlay_path.name} 不存在，覆盖层为空")

    legacy_plan: dict[str, Any] | None = None
    if overlay is None:
        raw_legacy = _read_plan(date_str)
        if raw_legacy is not None:
            if not isinstance(raw_legacy, dict):
                raise HTTPException(
                    status_code=500,
                    detail=f"计划文件损坏: plan-{date_str}.json (根节点不是对象)",
                )
            legacy_plan = raw_legacy

    items = _effective_items(master, overlay, legacy_plan, date_str, warnings)
    tasks = _read_long_tasks(warnings)
    return {
        "date": date_str,
        "master_version": master.get("version") if master is not None else None,
        "master": (
            {"timezone": master["timezone"], "entries": master["entries"]}
            if master is not None
            else None
        ),
        "overlay": overlay,
        "effective": {
            "items": items,
            "coverage": _effective_coverage(overlay, legacy_plan),
        },
        "long_tasks_due": _due_tasks(tasks, date_str),
        "warnings": warnings,
        "generated_at": int(time.time()),
    }


@router.get("/plan/{date:path}")
async def get_plan(date: str):
    """读取指定日期的计划、覆盖契约与到期长期任务。"""
    date_str = _validate_date(date)
    warnings: list[str] = []
    plan = _read_plan(date_str)
    coverage = _read_coverage(warnings)
    tasks = _read_long_tasks(warnings)
    return {
        "date": date_str,
        "plan": plan,
        "coverage": coverage,
        "long_tasks_due": _due_tasks(tasks, date_str),
        "warnings": warnings,
        "generated_at": int(time.time()),
    }
