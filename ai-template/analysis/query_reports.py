#!/usr/bin/env python3
"""Read-only query surface for the report index."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPORT_TYPES = ("daily", "weekly", "biweekly", "program")


def load_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        raise SystemExit(f"error: missing {path}")
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


def resolve_source(root: Path, relative: str) -> Path | None:
    path = Path(relative)
    if path.is_absolute():
        return path if path.exists() else None
    for base in (root, root.parent):
        candidate = base / path
        if candidate.exists():
            return candidate
    return None


def overlaps(row: dict, start: str | None, end: str | None) -> bool:
    report_start = row.get("period_start")
    report_end = row.get("period_end")
    if not isinstance(report_start, str) or not isinstance(report_end, str):
        return False
    if start is not None and report_end < start:
        return False
    if end is not None and report_start > end:
        return False
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Query the report index by type/date/id/text.")
    parser.add_argument("--root", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--index-dir", default=None)
    parser.add_argument("--type", choices=REPORT_TYPES, dest="report_type", default=None)
    parser.add_argument("--layer", choices=("event", "observation"), default=None)
    parser.add_argument("--from", dest="start", default=None, help="YYYY-MM-DD")
    parser.add_argument("--to", dest="end", default=None, help="YYYY-MM-DD")
    parser.add_argument("--report-id", default=None)
    parser.add_argument("--grep", default=None, help="search metadata and report text")
    parser.add_argument("--follow", action="store_true", help="include report relations")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--format", choices=["table", "json"], default="table")
    args = parser.parse_args(argv)

    root = Path(args.root).resolve()
    index_dir = Path(args.index_dir).resolve() if args.index_dir else root / "data" / "index"
    rows = load_jsonl(index_dir / "reports.jsonl")
    relations = load_jsonl(index_dir / "report_relations.jsonl") if args.follow else []
    relations_by_report: dict[str, list[dict]] = {}
    for relation in relations:
        relations_by_report.setdefault(str(relation.get("from_report")), []).append(relation)

    selected: list[dict] = []
    for row in rows:
        if args.report_type is not None and row.get("report_type") != args.report_type:
            continue
        if args.layer is not None and row.get("layer") != args.layer:
            continue
        if not overlaps(row, args.start, args.end):
            continue
        if args.report_id is not None and row.get("report_id") != args.report_id:
            continue
        if args.grep is not None:
            haystack = "\n".join(
                [
                    str(row.get("report_id") or ""),
                    str(row.get("title") or ""),
                    str(row.get("file") or ""),
                ]
            )
            source = resolve_source(root, str(row.get("file") or ""))
            if source is not None:
                try:
                    haystack += "\n" + source.read_text(encoding="utf-8")
                except OSError:
                    pass
            if args.grep not in haystack:
                continue
        selected.append(row)

    selected.sort(key=lambda row: (str(row.get("period_start") or ""), str(row.get("report_id") or "")))
    if args.limit is not None:
        selected = selected[: max(args.limit, 0)]

    if args.format == "json":
        payload = {"count": len(selected), "reports": selected}
        if args.follow:
            payload["relations"] = [
                relation
                for report in selected
                for relation in relations_by_report.get(str(report.get("report_id")), [])
            ]
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    print(f"count={len(selected)}")
    for row in selected:
        print(
            f"{row.get('report_id')} | {row.get('report_type')} | {row.get('layer')} | "
            f"{row.get('period_start')}~{row.get('period_end')} | "
            f"cards={len(row.get('card_ids') or [])} blocks={len(row.get('block_ids') or [])} | "
            f"{row.get('file')}"
        )
        if args.follow:
            for relation in relations_by_report.get(str(row.get("report_id")), []):
                target = relation.get("to_report") or relation.get("to_card")
                print(f"  -> {relation.get('relation')} {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
