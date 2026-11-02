#!/usr/bin/env python3
"""Build index-layer blocks from daily batches and review reports.

A block is a derived copy of one ATX ``##`` section. The source markdown stays
the truth; every block carries a root-relative pointer, an exact text copy and
a sha256 of that copy.
"""

from __future__ import annotations

import argparse
import calendar
import hashlib
import json
import os
import re
import sys
import tempfile
from datetime import date
from pathlib import Path

HEADING_RE = re.compile(r"^##\s+(.+?)\s*$")
TIME_START_RE = re.compile(r"^(\d{1,2}):\d{2}")
BATCH_NO_RE = re.compile(r"批次-(\d{1,2})\.md$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
START_DATE_RE = re.compile(r"(\d{4})-(\d{2})-(\d{2})")
FULL_END_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")
MONTH_DAY_END_RE = re.compile(r"^(\d{2})-(\d{2})$")
DAY_END_RE = re.compile(r"^(\d{2})$")


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


def heading_sections(path: Path) -> list[dict]:
    lines = path.read_text(encoding="utf-8").splitlines()
    marks = [
        (index, match)
        for index, line in enumerate(lines)
        if (match := HEADING_RE.match(line)) is not None
    ]
    sections: list[dict] = []
    for position, (index, match) in enumerate(marks):
        next_index = marks[position + 1][0] if position + 1 < len(marks) else len(lines)
        sections.append(
            {
                "heading": match.group(1),
                "line_start": index + 1,
                "line_end": next_index,
                "text": "\n".join(lines[index:next_index]),
            }
        )
    return sections


def relative_path(path: Path, root: Path) -> str:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError as exc:
        raise SystemExit(f"error: source outside root: {path}") from exc


def review_end_date(path: Path) -> str | None:
    stem = path.stem
    if "~" not in stem:
        return None
    start_part, end_part = stem.split("~", 1)
    match = START_DATE_RE.search(start_part)
    if match is None:
        return None
    year, month, day = (int(part) for part in match.groups())
    end_part = end_part.strip()

    full = FULL_END_RE.match(end_part)
    if full is not None:
        return f"{int(full.group(1)):04d}-{int(full.group(2)):02d}-{int(full.group(3)):02d}"

    month_day = MONTH_DAY_END_RE.match(end_part)
    if month_day is not None:
        end_month, end_day = (int(part) for part in month_day.groups())
        end_year = year
        if (end_month, end_day) < (month, day):
            end_year += 1
        return f"{end_year:04d}-{end_month:02d}-{end_day:02d}"

    day_only = DAY_END_RE.match(end_part)
    if day_only is None:
        return None
    end_day = int(day_only.group(1))
    end_year, end_month = year, month
    if end_day < day:
        end_month += 1
        if end_month > 12:
            end_month = 1
            end_year += 1
    last_day = calendar.monthrange(end_year, end_month)[1]
    if end_day > last_day:
        return None
    return f"{end_year:04d}-{end_month:02d}-{end_day:02d}"


def batch_files(root: Path, date_filter: str | None) -> tuple[list[str], list[Path]]:
    daily = root / "data" / "daily"
    if date_filter is not None:
        days = [date_filter]
    elif daily.is_dir():
        days = sorted(path.name for path in daily.iterdir() if path.is_dir() and DATE_RE.match(path.name))
    else:
        days = []
    files: list[Path] = []
    for day in days:
        folder = daily / day
        if folder.is_dir():
            files.extend(sorted(folder.glob(f"理解-{day}-批次-*.md")))
    return days, sorted(files)


def build_batch(root: Path, date_filter: str | None, include_meta: bool = False) -> tuple[set[str], list[dict]]:
    days, files = batch_files(root, date_filter)
    if date_filter is not None and not files:
        raise SystemExit(f"error: no batch files for {date_filter}")
    counters: dict[tuple[str, str], int] = {}
    rows: list[dict] = []
    for path in files:
        day = path.parent.name
        batch_match = BATCH_NO_RE.search(path.name)
        fallback_hour = f"{int(batch_match.group(1)):02d}" if batch_match else "00"
        rel = relative_path(path, root)
        for section in heading_sections(path):
            time_match = TIME_START_RE.match(section["heading"])
            if time_match is None and not include_meta:
                continue
            hour = f"{int(time_match.group(1)):02d}" if time_match else fallback_hour
            key = (day, hour)
            counters[key] = counters.get(key, 0) + 1
            text = section["text"]
            rows.append(
                {
                    "block_id": f"B-{day.replace('-', '')}-{hour}-{counters[key]:02d}",
                    "source_type": "batch",
                    "source_kind": "daily",
                    "file": rel,
                    "date": day,
                    "heading": section["heading"],
                    "line_start": section["line_start"],
                    "line_end": section["line_end"],
                    "text": text,
                    "text_sha256": text_sha256(text),
                    "status": "active",
                }
            )
    return set(days), rows


def legacy_files(root: Path, date_filter: str | None) -> tuple[list[str], list[Path]]:
    """Return monolithic 理解 files for days that have no batch files."""
    daily = root / "data" / "daily"
    if date_filter is not None:
        days = [date_filter]
    elif daily.is_dir():
        days = sorted(path.name for path in daily.iterdir() if path.is_dir() and DATE_RE.match(path.name))
    else:
        days = []
    files: list[Path] = []
    for day in days:
        folder = daily / day
        if not folder.is_dir():
            continue
        if list(folder.glob(f"理解-{day}-批次-*.md")):
            continue
        path = folder / f"理解-{day}.md"
        if path.is_file():
            files.append(path)
    return days, files


def build_legacy(root: Path, date_filter: str | None) -> tuple[set[str], list[dict]]:
    """Build blocks from pre-batch monolithic 理解 files."""
    days, files = legacy_files(root, date_filter)
    counters: dict[tuple[str, str], int] = {}
    rows: list[dict] = []
    for path in files:
        day = path.parent.name
        rel = relative_path(path, root)
        for section in heading_sections(path):
            time_match = TIME_START_RE.match(section["heading"])
            if time_match is None:
                continue
            hour = f"{int(time_match.group(1)):02d}"
            key = (day, hour)
            counters[key] = counters.get(key, 0) + 1
            text = section["text"]
            rows.append(
                {
                    "block_id": f"L-{day.replace('-', '')}-{hour}-{counters[key]:02d}",
                    "source_type": "legacy",
                    "source_kind": "daily",
                    "file": rel,
                    "date": day,
                    "heading": section["heading"],
                    "line_start": section["line_start"],
                    "line_end": section["line_end"],
                    "text": text,
                    "text_sha256": text_sha256(text),
                    "status": "active",
                }
            )
    return set(days), rows


def build_review(root: Path, date_filter: str | None) -> tuple[set[str], list[dict]]:
    reports = root / "data" / "reports"
    candidates: list[Path] = []
    if reports.is_dir():
        candidates.extend(reports.glob("每周总结-*.md"))
        candidates.extend(reports.glob("深度回顾-*.md"))
    entries: list[tuple[str, Path, str]] = []
    for path in candidates:
        end_date = review_end_date(path)
        if end_date is None:
            continue
        if date_filter is not None and end_date != date_filter:
            continue
        source_kind = "biweekly" if path.name.startswith("深度回顾-") else "weekly"
        entries.append((end_date, path, source_kind))
    entries.sort(key=lambda entry: (entry[0], entry[1].name))
    counters: dict[str, int] = {}
    rows: list[dict] = []
    for end_date, path, source_kind in entries:
        rel = relative_path(path, root)
        for section in heading_sections(path):
            counters[end_date] = counters.get(end_date, 0) + 1
            text = section["text"]
            rows.append(
                {
                    "block_id": f"R-{end_date.replace('-', '')}-{counters[end_date]:02d}",
                    "source_type": "review",
                    "source_kind": source_kind,
                    "file": rel,
                    "date": end_date,
                    "heading": section["heading"],
                    "line_start": section["line_start"],
                    "line_end": section["line_end"],
                    "text": text,
                    "text_sha256": text_sha256(text),
                    "status": "active",
                }
            )
    return {entry[0] for entry in entries}, rows


def merge_scope(existing: list[dict], built: list[dict], source: str) -> list[dict]:
    dates = {row.get("date") for row in built}
    if source == "batch":
        types = {"batch"}
    elif source == "legacy":
        types = {"legacy"}
    elif source == "review":
        types = {"review"}
    else:
        types = {"batch", "legacy", "review"}
    kept = [
        row
        for row in existing
        if not (row.get("source_type") in types and row.get("date") in dates)
    ]
    return kept + built


def dedupe_blocks(rows: list[dict]) -> list[dict]:
    by_id: dict[str, dict] = {}
    for row in rows:
        block_id = row.get("block_id")
        if not isinstance(block_id, str) or not block_id:
            raise SystemExit("error: block without block_id")
        previous = by_id.get(block_id)
        if previous is not None and previous != row:
            raise SystemExit(f"error: conflicting duplicate block_id: {block_id}")
        by_id[block_id] = row
    return list(by_id.values())


def output_path(index_dir: Path, out: str | None) -> Path:
    if out is None:
        return index_dir / "blocks.jsonl"
    target = Path(out)
    if target.suffix.lower() == ".jsonl":
        return target
    return target / "blocks.jsonl"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build index-layer blocks from batches/reviews.")
    parser.add_argument("--root", default=str(Path(__file__).resolve().parents[1]), help="AI root (default: parent of analysis/)")
    parser.add_argument("--index-dir", default=None, help="index directory (default: ROOT/data/index)")
    parser.add_argument("--date", default=None, help="YYYY-MM-DD; omit to scan every available date")
    parser.add_argument("--source", choices=["batch", "legacy", "review", "all"], default="batch")
    parser.add_argument("--out", default=None, help="output directory, or a .jsonl file path")
    parser.add_argument("--include-meta", action="store_true", help="also index non-time batch sections such as availability and defect notes")
    parser.add_argument("--dry-run", action="store_true", help="validate and report, write nothing")
    parser.add_argument("--json", action="store_true", help="print a JSON summary")
    args = parser.parse_args(argv)

    if args.date is not None and not DATE_RE.match(args.date):
        parser.error("--date must be YYYY-MM-DD")
    root = Path(args.root).resolve()
    index_dir = Path(args.index_dir).resolve() if args.index_dir else root / "data" / "index"
    destination = output_path(index_dir, args.out)

    rows: list[dict] = []
    scanned: set[str] = set()
    if args.source in ("batch", "all"):
        _, files = batch_files(root, args.date)
        if files or args.source == "batch":
            days, batch_rows = build_batch(root, args.date, include_meta=args.include_meta)
            scanned |= days
            rows.extend(batch_rows)
    if args.source in ("legacy", "all"):
        days, legacy_rows = build_legacy(root, args.date)
        scanned |= days
        rows.extend(legacy_rows)
    if args.source in ("review", "all"):
        days, review_rows = build_review(root, args.date)
        scanned |= days
        rows.extend(review_rows)
    if args.date is not None and not rows and args.source != "review":
        raise SystemExit(f"error: no blocks found for {args.date}")

    existing = read_jsonl(destination) if destination.exists() else []
    combined = dedupe_blocks(merge_scope(existing, rows, args.source))
    combined.sort(
        key=lambda row: (
            str(row.get("date") or ""),
            str(row.get("file") or ""),
            int(row.get("line_start") or 0),
            str(row.get("block_id") or ""),
        )
    )

    summary = {
        "source": args.source,
        "date": args.date or "all",
        "count": len(rows),
        "total_after_merge": len(combined),
        "out": str(destination),
        "dry_run": bool(args.dry_run),
        "sample": [
            {
                "block_id": row["block_id"],
                "file": row["file"],
                "line_start": row["line_start"],
                "line_end": row["line_end"],
                "heading": row["heading"],
            }
            for row in rows[:3]
        ],
    }

    if not args.dry_run:
        atomic_write_jsonl(destination, combined)
        summary["wrote"] = len(combined)
    else:
        summary["wrote"] = 0

    if args.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    else:
        print(
            f"count={summary['count']} source={summary['source']} date={summary['date']} "
            f"total={summary['total_after_merge']} dry_run={summary['dry_run']}"
        )
        for item in summary["sample"]:
            print(
                f"  {item['block_id']} | {item['file']}:{item['line_start']}-{item['line_end']} "
                f"| {item['heading']}"
            )
        if args.dry_run:
            print(f"dry-run: wrote nothing (would write {destination})")
        else:
            print(f"wrote {summary['wrote']} rows to {destination}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
