#!/usr/bin/env python3
"""Build relations between reports and cards/reports."""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from pathlib import Path

REPORTS = "reports.jsonl"
OUTPUT = "report_relations.jsonl"
REPORT_RELATIONS = {"covers", "observes", "reports_event"}


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


def overlaps(start_a: str, end_a: str, start_b: str, end_b: str) -> bool:
    return start_a <= end_b and end_a >= start_b


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build report relations.")
    parser.add_argument("--root", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--index-dir", default=None)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    root = Path(args.root).resolve()
    index_dir = Path(args.index_dir).resolve() if args.index_dir else root / "data" / "index"
    reports = read_jsonl(index_dir / REPORTS)
    report_by_id = {row["report_id"]: row for row in reports if row.get("report_id")}
    relations: dict[tuple[str, str, str], dict] = {}

    def add(from_report: str, relation: str, *, to_report: str | None = None, to_card: str | None = None, note: str = "") -> None:
        if relation not in REPORT_RELATIONS:
            raise SystemExit(f"error: bad report relation: {relation}")
        if bool(to_report) == bool(to_card):
            raise SystemExit("error: report relation needs exactly one target")
        if from_report not in report_by_id:
            return
        key = (from_report, relation, to_report or to_card or "")
        if key in relations:
            return
        row = {"from_report": from_report, "relation": relation, "note": note}
        if to_report:
            row["to_report"] = to_report
        else:
            row["to_card"] = to_card
        relations[key] = row

    for report in reports:
        report_id = report["report_id"]
        report_type = report.get("report_type")
        relation = "reports_event" if report_type == "daily" else "observes"
        for card_id in report.get("card_ids") or []:
            add(report_id, relation, to_card=card_id, note=f"{report_type} report link")

    for weekly in reports:
        if weekly.get("report_type") != "weekly":
            continue
        for daily in reports:
            if daily.get("report_type") != "daily":
                continue
            if overlaps(weekly["period_start"], weekly["period_end"], daily["period_start"], daily["period_end"]):
                add(weekly["report_id"], "covers", to_report=daily["report_id"], note="weekly covers daily")

    for biweekly in reports:
        if biweekly.get("report_type") != "biweekly":
            continue
        for weekly in reports:
            if weekly.get("report_type") != "weekly":
                continue
            if overlaps(biweekly["period_start"], biweekly["period_end"], weekly["period_start"], weekly["period_end"]):
                add(biweekly["report_id"], "covers", to_report=weekly["report_id"], note="biweekly covers weekly")

    for program in reports:
        if program.get("report_type") != "program":
            continue
        for report in reports:
            if report["report_id"] == program["report_id"]:
                continue
            if overlaps(program["period_start"], program["period_end"], report["period_start"], report["period_end"]):
                add(program["report_id"], "covers", to_report=report["report_id"], note="program covers report")

    rows = sorted(relations.values(), key=lambda row: (row["from_report"], row["relation"], row.get("to_report") or row.get("to_card") or ""))
    if not args.dry_run:
        atomic_write_jsonl(index_dir / OUTPUT, rows)
    summary = {
        "count": len(rows),
        "by_relation": {
            relation: sum(1 for row in rows if row.get("relation") == relation)
            for relation in sorted({row["relation"] for row in rows})
        },
        "dry_run": bool(args.dry_run),
    }
    if args.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    else:
        print(f"count={summary['count']} by_relation={summary['by_relation']} dry_run={summary['dry_run']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
