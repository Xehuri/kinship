#!/usr/bin/env python3
"""Structural and source-pointer validation for the index-layer catalog."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import Counter
from pathlib import Path

ALLOWED_RELATIONS = {
    "derived_from",
    "supported_by",
    "precedes",
    "state_of",
    "triggered_by",
    "same_day",
    "supersedes",
    "contradicts",
}
TABLES = [
    "concept_types.jsonl",
    "blocks.jsonl",
    "cards.jsonl",
    "card_concepts.jsonl",
    "card_blocks.jsonl",
    "card_relations.jsonl",
]


def text_sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def load_table(path: Path) -> tuple[list[dict], list[str]]:
    rows: list[dict] = []
    issues: list[str] = []
    if not path.exists():
        return rows, [f"missing table: {path.name}"]
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        return rows, [f"cannot read {path.name}: {exc}"]
    for lineno, line in enumerate(text.splitlines(), 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as exc:
            issues.append(f"json parse {path.name}:{lineno}: {exc}")
            continue
        if not isinstance(row, dict):
            issues.append(f"json object expected {path.name}:{lineno}")
            continue
        rows.append(row)
    return rows, issues


def resolve_source(root: Path, relative: object) -> Path | None:
    if not isinstance(relative, str) or not relative:
        return None
    path = Path(relative)
    if path.is_absolute():
        return path if path.exists() else None
    for base in (root, root.parent):
        candidate = base / path
        if candidate.exists():
            return candidate
    return None


def depth_and_cycle(concept_id: str, by_id: dict[str, dict]) -> tuple[int | None, bool]:
    seen: set[str] = set()
    depth = 0
    current: str | None = concept_id
    while current is not None:
        if current in seen:
            return None, True
        seen.add(current)
        depth += 1
        row = by_id.get(current)
        if row is None:
            break
        parent = row.get("parent_id")
        current = parent if isinstance(parent, str) else None
    return depth, False


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Validate the index-layer catalog.")
    parser.add_argument("--root", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--index-dir", default=None)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    root = Path(args.root).resolve()
    index_dir = Path(args.index_dir).resolve() if args.index_dir else root / "data" / "index"
    if not index_dir.is_dir():
        message = f"index dir not found: {index_dir}"
        if args.json:
            print(json.dumps({"status": "ERROR", "issues": [message]}, ensure_ascii=False, indent=2))
        else:
            print(f"ERROR: {message}", file=sys.stderr)
        return 2

    tables: dict[str, list[dict]] = {}
    issues: list[str] = []
    for name in TABLES:
        rows, table_issues = load_table(index_dir / name)
        tables[name] = rows
        issues.extend(table_issues)

    concepts = tables["concept_types.jsonl"]
    blocks = tables["blocks.jsonl"]
    cards = tables["cards.jsonl"]
    card_concepts = tables["card_concepts.jsonl"]
    card_blocks = tables["card_blocks.jsonl"]
    relations = tables["card_relations.jsonl"]

    concept_by_id = {
        row["concept_id"]: row for row in concepts if isinstance(row.get("concept_id"), str)
    }
    block_by_id = {
        row["block_id"]: row for row in blocks if isinstance(row.get("block_id"), str)
    }
    card_by_id = {row["card_id"]: row for row in cards if isinstance(row.get("card_id"), str)}
    concept_ids = set(concept_by_id)
    block_ids = set(block_by_id)
    card_ids = set(card_by_id)

    for label, rows, unique in (
        ("concept_id", concepts, concept_ids),
        ("block_id", blocks, block_ids),
        ("card_id", cards, card_ids),
    ):
        if len(rows) != len(unique):
            issues.append(f"duplicate {label}")

    parent_ids = {
        row.get("parent_id")
        for row in concepts
        if isinstance(row.get("parent_id"), str)
    }
    for concept in concepts:
        concept_id = concept.get("concept_id")
        if not isinstance(concept_id, str) or not concept_id:
            issues.append("concept without concept_id")
            continue
        parent_id = concept.get("parent_id")
        if parent_id is not None and parent_id not in concept_ids:
            issues.append(f"missing parent: {concept_id} -> {parent_id}")
        depth, cycle = depth_and_cycle(concept_id, concept_by_id)
        if cycle:
            issues.append(f"cycle at {concept_id}")
        elif depth is not None and depth > 3:
            issues.append(f"depth > 3: {concept_id}")

    concept_cards = {row.get("card_id") for row in card_concepts}
    block_cards = {row.get("card_id") for row in card_blocks}
    primary_counts = Counter(
        row.get("card_id") for row in card_concepts if row.get("role") == "primary"
    )

    for row in card_concepts:
        card_id = row.get("card_id")
        concept_id = row.get("concept_id")
        if card_id not in card_ids:
            issues.append(f"unknown card in card_concepts: {card_id}")
        if concept_id not in concept_ids:
            issues.append(f"unknown concept in card_concepts: {concept_id}")
            continue
        if concept_id in parent_ids:
            issues.append(f"non-leaf tagged: {concept_id}")
        concept = concept_by_id.get(concept_id, {})
        card = card_by_id.get(card_id)
        if card is not None and concept.get("kind") != card.get("kind"):
            issues.append(
                f"kind mismatch: {card_id} card={card.get('kind')!r} concept={concept.get('kind')!r}"
            )

    for card in cards:
        card_id = card.get("card_id")
        if card_id not in concept_cards:
            issues.append(f"card has no concept: {card_id}")
        if card_id not in block_cards:
            issues.append(f"card has no block: {card_id}")
        if primary_counts.get(card_id, 0) != 1:
            issues.append(f"card needs exactly one primary concept: {card_id}")

    for block in blocks:
        block_id = block.get("block_id")
        text = block.get("text")
        if not isinstance(text, str):
            issues.append(f"block text is not a string: {block_id}")
            continue
        if text_sha256(text) != block.get("text_sha256"):
            issues.append(f"self sha mismatch: {block_id}")
        source = resolve_source(root, block.get("file"))
        if source is None:
            issues.append(f"source missing: {block_id}")
            continue
        try:
            lines = source.read_text(encoding="utf-8").splitlines()
        except OSError as exc:
            issues.append(f"cannot read source for {block_id}: {exc}")
            continue
        line_start = block.get("line_start")
        line_end = block.get("line_end")
        if (
            not isinstance(line_start, int)
            or not isinstance(line_end, int)
            or line_start < 1
            or line_end < line_start
            or line_end > len(lines)
        ):
            issues.append(f"bad line range: {block_id}")
            continue
        source_text = "\n".join(lines[line_start - 1:line_end])
        if source_text != text:
            issues.append(f"text mismatch: {block_id}")
        if text_sha256(source_text) != block.get("text_sha256"):
            issues.append(f"sha mismatch: {block_id}")

    seen_card_blocks: set[tuple[object, object]] = set()
    for row in card_blocks:
        card_id = row.get("card_id")
        block_id = row.get("block_id")
        key = (card_id, block_id)
        if key in seen_card_blocks:
            issues.append(f"duplicate card_blocks row: {key}")
        seen_card_blocks.add(key)
        if card_id not in card_ids:
            issues.append(f"unknown card in card_blocks: {card_id}")
        block = block_by_id.get(block_id)
        if block is None:
            issues.append(f"unknown block in card_blocks: {block_id}")
        elif row.get("quote_sha") != block.get("text_sha256"):
            issues.append(f"quote sha mismatch: {card_id} -> {block_id}")

    seen_relations: set[tuple[object, object, object]] = set()
    for row in relations:
        from_card = row.get("from_card")
        to_card = row.get("to_card")
        relation = row.get("relation")
        if from_card not in card_ids:
            issues.append(f"unknown from_card: {from_card}")
        if to_card not in card_ids:
            issues.append(f"unknown to_card: {to_card}")
        if relation not in ALLOWED_RELATIONS:
            issues.append(f"bad relation: {relation!r}")
        key = (from_card, to_card, relation)
        if key in seen_relations:
            issues.append(f"duplicate relation triplet: {key}")
        seen_relations.add(key)

    counts = {
        "concepts": len(concepts),
        "blocks": len(blocks),
        "cards": len(cards),
        "card_concepts": len(card_concepts),
        "card_blocks": len(card_blocks),
        "relations": len(relations),
    }
    status = "PASS" if not issues else "FAIL"

    if args.json:
        print(
            json.dumps(
                {"status": status, "counts": counts, "issues": issues},
                ensure_ascii=False,
                indent=2,
            )
        )
    else:
        print(" ".join(f"{key}={value}" for key, value in counts.items()))
        print(status)
        for issue in issues:
            print(" -", issue)
    return 1 if issues else 0


if __name__ == "__main__":
    raise SystemExit(main())
