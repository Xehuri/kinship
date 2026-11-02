#!/usr/bin/env python3
"""Build card-level relations: same-day sequences and finding/observation support."""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from collections import defaultdict
from pathlib import Path

EXISTING = "card_relations.jsonl"


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


def card_range(card: dict) -> tuple[str | None, str | None]:
    start = card.get("period_start") or card.get("date")
    end = card.get("period_end") or card.get("date")
    return (start, end) if start and end else (None, None)


def overlaps(card: dict, start: str, end: str) -> bool:
    card_start, card_end = card_range(card)
    return card_start is not None and card_start <= end and card_end >= start


def is_automatic_relation(row: dict) -> bool:
    note = str(row.get("note") or "")
    return (
        note.endswith("same-day event sequence")
        or note.startswith("observation over ")
        or note.startswith("finding over ")
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build card relations.")
    parser.add_argument("--root", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--index-dir", default=None)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    root = Path(args.root).resolve()
    index_dir = Path(args.index_dir).resolve() if args.index_dir else root / "data" / "index"
    cards = read_jsonl(index_dir / "cards.jsonl")
    card_concepts_rows = read_jsonl(index_dir / "card_concepts.jsonl")
    existing = read_jsonl(index_dir / EXISTING)
    card_by_id = {str(c.get("card_id")): c for c in cards if c.get("card_id")}
    concepts_by_card: dict[str, set[str]] = defaultdict(set)
    for row in card_concepts_rows:
        if row.get("card_id") and row.get("concept_id"):
            concepts_by_card[str(row["card_id"])].add(str(row["concept_id"]))
    existing = [row for row in existing if not is_automatic_relation(row)]
    relations: dict[tuple[str, str, str], dict] = {}
    for row in existing:
        key = (str(row.get("from_card")), str(row.get("relation")), str(row.get("to_card")))
        relations[key] = row

    def add(from_card: str, to_card: str, relation: str, note: str) -> None:
        if from_card == to_card or from_card not in card_by_id or to_card not in card_by_id:
            return
        key = (from_card, relation, to_card)
        if key in relations:
            return
        relations[key] = {
            "from_card": from_card,
            "to_card": to_card,
            "relation": relation,
            "note": note,
        }

    # 1) Same-day event sequence: only adjacent events with explicit times.
    by_date: dict[str, list[dict]] = defaultdict(list)
    for card in cards:
        if card.get("kind") == "event" and card.get("date") and card.get("time"):
            by_date[str(card["date"])].append(card)
    for day, day_cards in by_date.items():
        day_cards.sort(key=lambda c: (str(c.get("time") or ""), str(c.get("card_id") or "")))
        for left, right in zip(day_cards, day_cards[1:]):
            if left.get("time") == right.get("time"):
                continue
            add(
                str(left["card_id"]),
                str(right["card_id"]),
                "precedes",
                f"{day} same-day event sequence",
            )

    # 2) Observation supports / finding derives from concept-compatible event cards.
    for card in cards:
        kind = card.get("kind")
        if kind not in ("observation", "finding"):
            continue
        start, end = card_range(card)
        if start is None:
            continue
        own_concepts = concepts_by_card.get(str(card.get("card_id")), set())
        if any(concept.startswith("OBSERVATION.STUDY") for concept in own_concepts):
            wanted = {"EVENT.STUDY.SELF_STUDY"}
        elif any(concept.startswith("FINDING.CAUSE.STUDY") or concept.startswith("FINDING.TREND.STUDY") for concept in own_concepts):
            wanted = {"EVENT.STUDY.SELF_STUDY"}
        elif "FINDING.CAUSE.REPAIR_FAIL" in own_concepts:
            wanted = {"EVENT.REPAIR.LAPTOP"}
        else:
            wanted = set()
        candidates = [
            candidate
            for candidate in cards
            if candidate.get("kind") == "event"
            and overlaps(candidate, start, end)
            and candidate.get("card_id") != card.get("card_id")
            and concepts_by_card.get(str(candidate.get("card_id")), set()) & wanted
        ]
        candidates.sort(key=lambda c: (str(c.get("date") or ""), str(c.get("time") or ""), str(c.get("card_id") or "")))
        relation = "supported_by" if kind == "observation" else "derived_from"
        for candidate in candidates[:2]:
            add(
                str(card["card_id"]),
                str(candidate["card_id"]),
                relation,
                f"{kind} over {start}~{end}",
            )

    rows = sorted(relations.values(), key=lambda row: (str(row.get("from_card")), str(row.get("relation")), str(row.get("to_card"))))
    if not args.dry_run:
        atomic_write_jsonl(index_dir / EXISTING, rows)
    summary = {
        "count": len(rows),
        "by_relation": {
            rel: sum(1 for row in rows if row.get("relation") == rel)
            for rel in sorted({str(row.get("relation")) for row in rows})
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
