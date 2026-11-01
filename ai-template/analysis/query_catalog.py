#!/usr/bin/env python3
"""Read-only query surface for the index-layer catalog."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def load_jsonl(path: Path) -> list[dict]:
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


def resolve_source(root: Path, relative: str) -> Path | None:
    path = Path(relative)
    if path.is_absolute():
        return path if path.exists() else None
    for base in (root, root.parent):
        candidate = base / path
        if candidate.exists():
            return candidate
    return None


def descendant_leaves(concept_id: str, concepts: list[dict]) -> set[str]:
    by_parent: dict[str | None, list[dict]] = {}
    for concept in concepts:
        by_parent.setdefault(concept.get("parent_id"), []).append(concept)
    found = any(concept.get("concept_id") == concept_id for concept in concepts)
    if not found:
        return set()
    leaves: set[str] = set()

    def walk(node: dict) -> None:
        children = by_parent.get(node["concept_id"], [])
        if not children:
            leaves.add(node["concept_id"])
            return
        for child in children:
            walk(child)

    for concept in concepts:
        if concept.get("concept_id") == concept_id:
            walk(concept)
            break
    return leaves


def card_range(card: dict) -> tuple[str | None, str | None]:
    if card.get("period_start"):
        start = card["period_start"]
        return start, card.get("period_end") or start
    value = card.get("date")
    return (value, value) if value else (None, None)


def range_matches(card: dict, start: str | None, end: str | None) -> bool:
    card_start, card_end = card_range(card)
    if card_start is None:
        return start is None and end is None
    if start is not None and card_end is not None and card_end < start:
        return False
    if end is not None and card_start > end:
        return False
    return True


def block_text(card_id: str, card_blocks: list[dict], blocks: dict[str, dict]) -> str:
    parts = []
    for ref in card_blocks:
        if ref.get("card_id") != card_id:
            continue
        block = blocks.get(ref.get("block_id"))
        if block is not None:
            parts.append(str(block.get("text") or ""))
    return "\n".join(parts)


def excerpt_for(root: Path, block: dict) -> str | None:
    source = resolve_source(root, str(block.get("file") or ""))
    if source is None:
        return None
    try:
        lines = source.read_text(encoding="utf-8").splitlines()
        line_start = int(block["line_start"])
        line_end = int(block["line_end"])
    except (OSError, KeyError, TypeError, ValueError):
        return None
    end = min(line_end, line_start + 2)
    return "\n".join(lines[line_start - 1:end])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Query index-layer cards by concept/date/slot/text.")
    parser.add_argument("--root", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--index-dir", default=None)
    parser.add_argument("--concept", default=None, help="concept id; parents expand to descendant leaves")
    parser.add_argument("--kind", default=None, choices=["event", "observation", "finding", "state", "decision"])
    parser.add_argument("--from", dest="start", default=None, help="YYYY-MM-DD")
    parser.add_argument("--to", dest="end", default=None, help="YYYY-MM-DD")
    parser.add_argument("--slot", action="append", default=[], help="key=value, repeatable")
    parser.add_argument("--grep", default=None)
    parser.add_argument("--order", choices=["asc", "desc"], default=None)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--sum", dest="sum_field", default=None)
    parser.add_argument("--resolve", action="store_true")
    parser.add_argument("--follow", action="store_true")
    parser.add_argument("--format", choices=["table", "json"], default="table")
    args = parser.parse_args(argv)

    root = Path(args.root).resolve()
    index_dir = Path(args.index_dir).resolve() if args.index_dir else root / "data" / "index"

    concepts = load_jsonl(index_dir / "concept_types.jsonl")
    blocks = {row["block_id"]: row for row in load_jsonl(index_dir / "blocks.jsonl") if "block_id" in row}
    cards = load_jsonl(index_dir / "cards.jsonl")
    card_concepts = load_jsonl(index_dir / "card_concepts.jsonl")
    card_blocks = load_jsonl(index_dir / "card_blocks.jsonl")
    relations = load_jsonl(index_dir / "card_relations.jsonl")

    concept_ids: set[str] | None = None
    if args.concept:
        concept_ids = descendant_leaves(args.concept, concepts)
        if not concept_ids:
            print(f"unknown concept: {args.concept}", file=sys.stderr)
            return 2

    wanted_slots: dict[str, str] = {}
    for item in args.slot:
        if "=" not in item:
            print(f"bad --slot: {item}", file=sys.stderr)
            return 2
        key, value = item.split("=", 1)
        wanted_slots[key] = value

    selected: list[dict] = []
    for card in cards:
        if concept_ids is not None:
            ids = {
                row.get("concept_id")
                for row in card_concepts
                if row.get("card_id") == card.get("card_id")
            }
            if not (ids & concept_ids):
                continue
        if args.kind is not None and card.get("kind") != args.kind:
            continue
        if not range_matches(card, args.start, args.end):
            continue
        slots = card.get("slots") if isinstance(card.get("slots"), dict) else {}
        if any(str(slots.get(key)) != value for key, value in wanted_slots.items()):
            continue
        if args.grep is not None:
            haystack = "\n".join(
                [
                    str(card.get("title") or ""),
                    str(card.get("statement") or ""),
                    block_text(str(card.get("card_id") or ""), card_blocks, blocks),
                ]
            )
            if args.grep not in haystack:
                continue
        selected.append(card)

    if args.order is not None:
        selected.sort(
            key=lambda card: (
                card_range(card)[0] or "",
                str(card.get("time") or card_range(card)[1] or ""),
                str(card.get("card_id") or ""),
            ),
            reverse=args.order == "desc",
        )
    if args.limit is not None:
        selected = selected[: max(args.limit, 0)]

    sum_info = None
    if args.sum_field is not None:
        total = 0
        missing = 0
        for card in selected:
            slots = card.get("slots") if isinstance(card.get("slots"), dict) else {}
            value = slots.get(args.sum_field)
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                missing += 1
            else:
                total += value
        sum_info = {"field": args.sum_field, "total": total, "missing": missing}

    results: list[dict] = []
    for card in selected:
        card_id = card.get("card_id")
        ids = [
            row.get("concept_id")
            for row in card_concepts
            if row.get("card_id") == card_id
        ]
        refs: list[dict] = []
        for ref in card_blocks:
            if ref.get("card_id") != card_id:
                continue
            block = blocks.get(ref.get("block_id"))
            if block is None:
                refs.append({"block_id": ref.get("block_id"), "broken": True})
                continue
            item = {
                "block_id": block.get("block_id"),
                "file": block.get("file"),
                "line_start": block.get("line_start"),
                "line_end": block.get("line_end"),
                "text_sha256": block.get("text_sha256"),
                "role": ref.get("role"),
            }
            if args.resolve:
                excerpt = excerpt_for(root, block)
                if excerpt is None:
                    item["broken"] = True
                else:
                    item["excerpt"] = excerpt
            refs.append(item)

        item = {
            "card_id": card_id,
            "kind": card.get("kind"),
            "title": card.get("title"),
            "statement": card.get("statement"),
            "date": card.get("date"),
            "time": card.get("time"),
            "end_time": card.get("end_time"),
            "period_start": card.get("period_start"),
            "period_end": card.get("period_end"),
            "slots": card.get("slots", {}),
            "confidence": card.get("confidence"),
            "status": card.get("status"),
            "concepts": ids,
            "blocks": refs,
        }
        if args.follow:
            item["relations"] = [
                row
                for row in relations
                if row.get("from_card") == card_id or row.get("to_card") == card_id
            ]
        results.append(item)

    if args.format == "json":
        payload = {"count": len(results), "results": results}
        if sum_info is not None:
            payload["sum"] = sum_info
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    print(f"count={len(results)}")
    if sum_info is not None:
        print(f"sum {sum_info['field']}={sum_info['total']} missing={sum_info['missing']}")
    for item in results:
        when = item["date"] or item["period_start"] or ""
        if item["time"]:
            when = f"{when} {item['time']}"
        print(f"{item['card_id']} | {item['kind']} | {item['concepts']} | {when} | {item['title']}")
        print(f"  {item['statement']}")
        for ref in item["blocks"]:
            if ref.get("broken"):
                print(f"  -> {ref.get('block_id')} BROKEN")
                continue
            print(
                f"  -> {ref['block_id']} {ref['file']}:{ref['line_start']}-{ref['line_end']} "
                f"sha={ref['text_sha256']} ({ref.get('role')})"
            )
            if args.resolve and ref.get("excerpt"):
                print("     " + ref["excerpt"].replace("\n", "\n     "))
        for relation in item.get("relations", []):
            print(
                f"  rel: {relation.get('from_card')} --{relation.get('relation')}--> "
                f"{relation.get('to_card')}"
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
