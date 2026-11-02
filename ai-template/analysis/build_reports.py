#!/usr/bin/env python3
"""Build the report index from daily, weekly, biweekly and program reports."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_blocks import review_end_date

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
START_DATE_RE = re.compile(r"(\d{4})-(\d{2})-(\d{2})")
TYPE_PREFIX = {"daily": "D", "weekly": "W", "biweekly": "B", "program": "P"}
REPORT_TYPES = ("daily", "weekly", "biweekly", "program")
REPORT_LAYERS = {
    "daily": "event",
    "weekly": "observation",
    "biweekly": "observation",
    "program": "observation",
}


def text_sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    rows: list[dict] = []
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as exc:
            raise SystemExit(f"error: {path}:{lineno}: {exc}") from exc
        if not isinstance(row, dict):
            raise SystemExit(f"error: {path}:{lineno}: expected a JSON object")
        rows.append(row)
    return rows


def atomic_write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=path.name + ".", dir=str(path.parent))
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            for row in rows:
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def relative_path(path: Path, root: Path) -> str:
    return path.resolve().relative_to(root.resolve()).as_posix()


def period_for(path: Path) -> tuple[str, str, str] | None:
    name = path.name
    if name.startswith("复盘-") and name.endswith(".md"):
        day = path.parent.name
        if DATE_RE.match(day):
            return "daily", day, day
        return None
    if name.startswith("每周总结-"):
        kind = "weekly"
    elif name.startswith("深度回顾-"):
        kind = "biweekly"
    elif name.startswith("培训全程总结-"):
        kind = "program"
    else:
        return None
    match = START_DATE_RE.search(name)
    if match is None:
        return None
    start = f"{int(match.group(1)):04d}-{int(match.group(2)):02d}-{int(match.group(3)):02d}"
    end = review_end_date(path)
    if end is None:
        return None
    return kind, start, end


def card_range(card: dict) -> tuple[str | None, str | None]:
    start = card.get("period_start") or card.get("date")
    end = card.get("period_end") or card.get("date")
    return (start, end) if start and end else (None, None)


def overlaps(card: dict, start: str, end: str) -> bool:
    card_start, card_end = card_range(card)
    if card_start is None:
        return False
    return card_start <= end and card_end >= start


def collect(root: Path, index_dir: Path) -> list[dict]:
    daily = root / "data" / "daily"
    reports = root / "data" / "reports"
    paths: list[Path] = []
    if daily.is_dir():
        paths.extend(daily.glob("*/复盘-*.md"))
    if reports.is_dir():
        paths.extend(path for path in reports.glob("*.md") if path.name != "README.md")

    blocks = read_jsonl(index_dir / "blocks.jsonl")
    cards = read_jsonl(index_dir / "cards.jsonl")
    block_ids_by_file: dict[str, list[str]] = {}
    for block in blocks:
        rel = str(block.get("file") or "")
        if rel:
            block_ids_by_file.setdefault(rel, []).append(str(block.get("block_id") or ""))

    rows: list[dict] = []
    for path in sorted(paths):
        period = period_for(path)
        if period is None:
            continue
        report_type, start, end = period
        if start > end:
            raise SystemExit(f"error: report period inverted: {path}")
        rel = relative_path(path, root)
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as exc:
            raise SystemExit(f"error: cannot read {path}: {exc}") from exc
        report_id = f"{TYPE_PREFIX[report_type]}-{end.replace('-', '')}"
        if report_type == "daily":
            card_ids = sorted(
                str(card.get("card_id"))
                for card in cards
                if card.get("date") == start
            )
        else:
            card_ids = sorted(
                str(card.get("card_id"))
                for card in cards
                if overlaps(card, start, end)
            )
        rows.append(
            {
                "report_id": report_id,
                "report_type": report_type,
                "layer": REPORT_LAYERS[report_type],
                "period_start": start,
                "period_end": end,
                "title": path.stem,
                "file": rel,
                "line_count": len(text.splitlines()),
                "text_sha256": text_sha256(text),
                "block_ids": sorted(set(block_ids_by_file.get(rel, []))),
                "card_ids": card_ids,
                "status": "active",
                "version": 1,
            }
        )
    rows.sort(key=lambda row: (row["period_start"], row["report_id"]))
    return rows


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build the report index.")
    parser.add_argument("--root", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--index-dir", default=None)
    parser.add_argument("--out", default=None)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    root = Path(args.root).resolve()
    index_dir = Path(args.index_dir).resolve() if args.index_dir else root / "data" / "index"
    destination = Path(args.out).resolve() if args.out else index_dir / "reports.jsonl"
    rows = collect(root, index_dir)
    if not args.dry_run:
        atomic_write_jsonl(destination, rows)
    summary = {
        "count": len(rows),
        "by_type": {
            kind: sum(1 for row in rows if row["report_type"] == kind)
            for kind in REPORT_TYPES
        },
        "destination": str(destination),
        "dry_run": bool(args.dry_run),
    }
    if args.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    else:
        print(f"count={summary['count']} by_type={summary['by_type']} dry_run={summary['dry_run']}")
        print(f"destination={destination}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
