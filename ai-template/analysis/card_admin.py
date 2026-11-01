#!/usr/bin/env python3
"""Write-side administration for index-layer cards.

All checks run before anything is written. The four card tables are written
with temp-file + os.replace under an advisory lock; a failed validation leaves
every table untouched.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import sys
import tempfile
from collections import Counter
from contextlib import contextmanager
from datetime import date
from pathlib import Path

KINDS = {"event", "observation", "finding", "state", "decision"}
RELATIONS = {
    "derived_from",
    "supported_by",
    "precedes",
    "state_of",
    "triggered_by",
    "same_day",
    "supersedes",
    "contradicts",
}
STATUSES = {"active", "deprecated", "superseded"}
TIME_RE = re.compile(r"^\d{2}:\d{2}$")

TABLE_CARDS = "cards.jsonl"
TABLE_CARD_CONCEPTS = "card_concepts.jsonl"
TABLE_CARD_BLOCKS = "card_blocks.jsonl"
TABLE_CARD_RELATIONS = "card_relations.jsonl"
TABLE_CONCEPTS = "concept_types.jsonl"
TABLE_BLOCKS = "blocks.jsonl"


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


def dedupe(rows: list[dict], fields: tuple[str, ...]) -> list[dict]:
    seen: dict[tuple[object, ...], dict] = {}
    for row in rows:
        key = tuple(row.get(field) for field in fields)
        previous = seen.get(key)
        if previous is not None and previous != row:
            raise SystemExit(f"error: conflicting duplicate row for {fields}: {key}")
        seen[key] = row
    return list(seen.values())


@contextmanager
def catalog_lock(index_dir: Path):
    index_dir.mkdir(parents=True, exist_ok=True)
    with (index_dir / ".catalog.lock").open("a+", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def valid_date(value: object) -> bool:
    if not isinstance(value, str):
        return False
    try:
        date.fromisoformat(value)
    except ValueError:
        return False
    return True


def valid_time(value: object) -> bool:
    if not isinstance(value, str) or TIME_RE.match(value) is None:
        return False
    hour, minute = (int(part) for part in value.split(":"))
    return 0 <= hour <= 23 and 0 <= minute <= 59


def slot_present(card: dict, name: str) -> bool:
    if name == "date":
        return bool(card.get("date"))
    if name == "time":
        return bool(card.get("time"))
    if name in ("period_start", "period_end"):
        return bool(card.get(name))
    value = card.get("slots", {}).get(name)
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (list, dict)):
        return bool(value)
    return True


class ValidationContext:
    def __init__(
        self,
        concepts: dict[str, dict],
        blocks: dict[str, dict],
        existing_card_ids: set[str],
        known_card_ids: set[str],
        duplicate_batch_ids: set[str],
        relation_keys: set[tuple[str, str, str]],
    ) -> None:
        self.concepts = concepts
        self.parent_ids = {
            concept.get("parent_id")
            for concept in concepts.values()
            if concept.get("parent_id") is not None
        }
        self.blocks = blocks
        self.existing_card_ids = existing_card_ids
        self.known_card_ids = known_card_ids
        self.duplicate_batch_ids = duplicate_batch_ids
        self.relation_keys = relation_keys


def validate_card(raw: object, ctx: ValidationContext) -> tuple[dict | None, list[str], list[dict]]:
    errors: list[str] = []
    relation_rows: list[dict] = []
    if not isinstance(raw, dict):
        return None, ["card must be a JSON object"], relation_rows

    card = dict(raw)
    card_id = card.get("card_id")
    if not isinstance(card_id, str) or not card_id.strip():
        errors.append("card_id is required")
        card_id = ""
    elif card_id in ctx.existing_card_ids:
        errors.append(f"duplicate card_id: {card_id}")
    elif card_id in ctx.duplicate_batch_ids:
        errors.append(f"duplicate card_id in input: {card_id}")

    kind = card.get("kind")
    if kind not in KINDS:
        errors.append(f"bad kind: {kind!r} (expected one of {sorted(KINDS)})")

    title = card.get("title")
    statement = card.get("statement")
    if not isinstance(title, str) or not title.strip():
        errors.append(f"{card_id or 'card'}: title is required")
    if not isinstance(statement, str) or not statement.strip():
        errors.append(f"{card_id or 'card'}: statement is required")

    slots = card.get("slots", {})
    if not isinstance(slots, dict):
        errors.append(f"{card_id or 'card'}: slots must be an object")
        slots = {}
    card["slots"] = slots

    for field in ("date", "period_start", "period_end"):
        value = card.get(field)
        if value is not None and not valid_date(value):
            errors.append(f"{card_id or 'card'}: bad {field}: {value!r}")
    for field in ("time", "end_time"):
        value = card.get(field)
        if value is not None and not valid_time(value):
            errors.append(f"{card_id or 'card'}: bad {field}: {value!r}")

    if card.get("date") is None and card.get("period_start") is None:
        errors.append(f"{card_id or 'card'}: date or period_start is required")
    if bool(card.get("period_start")) != bool(card.get("period_end")):
        errors.append(f"{card_id or 'card'}: period_start and period_end must be paired")
    if (
        card.get("period_start")
        and card.get("period_end")
        and isinstance(card["period_start"], str)
        and isinstance(card["period_end"], str)
        and card["period_start"] > card["period_end"]
    ):
        errors.append(f"{card_id or 'card'}: period_start is after period_end")

    concept_id = card.get("concept_id")
    concept = ctx.concepts.get(concept_id) if isinstance(concept_id, str) else None
    if concept is None:
        errors.append(f"{card_id or 'card'}: unknown concept_id: {concept_id!r}")
    else:
        if concept_id in ctx.parent_ids:
            errors.append(f"{card_id or 'card'}: concept is not a leaf: {concept_id}")
        if concept.get("kind") != kind:
            errors.append(
                f"{card_id or 'card'}: kind {kind!r} does not match concept kind {concept.get('kind')!r}"
            )
        for required in concept.get("required_slots") or []:
            if not slot_present(card, str(required)):
                errors.append(f"{card_id or 'card'}: missing required slot: {required}")

    block_ids = card.get("block_ids")
    if not isinstance(block_ids, list) or not block_ids:
        errors.append(f"{card_id or 'card'}: block_ids must be a non-empty array")
    else:
        if len(set(block_ids)) != len(block_ids):
            errors.append(f"{card_id or 'card'}: duplicate block_ids")
        for block_id in block_ids:
            if not isinstance(block_id, str) or block_id not in ctx.blocks:
                errors.append(f"{card_id or 'card'}: unknown block_id: {block_id!r}")

    derived = slots.get("derived_from")
    if isinstance(derived, str):
        derived = [derived]
    if derived is not None:
        if not isinstance(derived, list):
            errors.append(f"{card_id or 'card'}: slots.derived_from must be an array")
        else:
            for ref in derived:
                if not isinstance(ref, str) or ref not in ctx.known_card_ids:
                    errors.append(f"{card_id or 'card'}: unknown derived_from card: {ref!r}")
                elif ref == card_id:
                    errors.append(f"{card_id or 'card'}: derived_from cannot reference itself")

    relations = card.get("relations", [])
    if relations is None:
        relations = []
    if not isinstance(relations, list):
        errors.append(f"{card_id or 'card'}: relations must be an array")
    else:
        for index, relation in enumerate(relations):
            if not isinstance(relation, dict):
                errors.append(f"{card_id or 'card'}: relation #{index} must be an object")
                continue
            to_card = relation.get("to_card")
            name = relation.get("relation")
            note = relation.get("note", "")
            if name not in RELATIONS:
                errors.append(f"{card_id or 'card'}: bad relation: {name!r}")
                continue
            if not isinstance(to_card, str) or not to_card:
                errors.append(f"{card_id or 'card'}: relation #{index} needs to_card")
                continue
            if to_card not in ctx.known_card_ids:
                errors.append(f"{card_id or 'card'}: unknown relation target: {to_card}")
            if to_card == card_id:
                errors.append(f"{card_id or 'card'}: relation cannot target itself")
            key = (card_id, to_card, name)
            if key in ctx.relation_keys:
                errors.append(f"{card_id or 'card'}: duplicate relation: {key}")
            else:
                ctx.relation_keys.add(key)
                relation_rows.append(
                    {"from_card": card_id, "to_card": to_card, "relation": name, "note": note}
                )

    status = card.get("status", "active")
    if status not in STATUSES:
        errors.append(f"{card_id or 'card'}: bad status: {status!r}")
    confidence = card.get("confidence", "medium")
    if not isinstance(confidence, str) or not confidence.strip():
        errors.append(f"{card_id or 'card'}: confidence must be a non-empty string")
    version = card.get("version", 1)
    if not isinstance(version, int) or version < 1:
        errors.append(f"{card_id or 'card'}: version must be a positive integer")

    if errors:
        return None, errors, relation_rows

    normalized = {
        "card_id": card_id,
        "kind": kind,
        "title": title,
        "statement": statement,
    }
    for field in ("date", "time", "end_time", "period_start", "period_end"):
        if card.get(field) is not None:
            normalized[field] = card[field]
    normalized["slots"] = slots
    normalized["confidence"] = confidence
    normalized["status"] = status
    normalized["version"] = version
    return normalized, [], relation_rows


def load_payload(path: str) -> list[dict]:
    try:
        if path == "-":
            raw_text = sys.stdin.read()
        else:
            raw_text = Path(path).read_text(encoding="utf-8")
        payload = json.loads(raw_text)
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"error: cannot read JSON input: {exc}") from exc
    if isinstance(payload, dict):
        return [payload]
    if isinstance(payload, list):
        return payload
    raise SystemExit("error: input must be one card object or an array of cards")


def resolve_index(args: argparse.Namespace) -> Path:
    root = Path(args.root).resolve()
    return Path(args.index_dir).resolve() if args.index_dir else root / "data" / "index"


def add_cards(index_dir: Path, payload: list[dict], dry_run: bool) -> int:
    concept_rows = read_jsonl(index_dir / TABLE_CONCEPTS)
    block_rows = read_jsonl(index_dir / TABLE_BLOCKS)
    cards_rows = read_jsonl(index_dir / TABLE_CARDS)
    card_concept_rows = read_jsonl(index_dir / TABLE_CARD_CONCEPTS)
    card_block_rows = read_jsonl(index_dir / TABLE_CARD_BLOCKS)
    relation_rows = read_jsonl(index_dir / TABLE_CARD_RELATIONS)

    concepts = {row["concept_id"]: row for row in concept_rows if "concept_id" in row}
    blocks = {row["block_id"]: row for row in block_rows if "block_id" in row}
    existing_ids = {row["card_id"] for row in cards_rows if "card_id" in row}
    batch_ids = [row.get("card_id") for row in payload if isinstance(row, dict)]
    duplicate_batch_ids = {
        card_id for card_id, count in Counter(batch_ids).items() if card_id is not None and count > 1
    }
    known_ids = existing_ids | {card_id for card_id in batch_ids if isinstance(card_id, str)}
    relation_keys = {
        (row.get("from_card"), row.get("to_card"), row.get("relation")) for row in relation_rows
    }
    context = ValidationContext(
        concepts, blocks, existing_ids, known_ids, duplicate_batch_ids, relation_keys
    )

    errors: list[str] = []
    normalized: list[dict] = []
    new_relations: list[dict] = []
    for raw in payload:
        card, card_errors, card_relations = validate_card(raw, context)
        errors.extend(card_errors)
        if card is not None:
            normalized.append(card)
            new_relations.extend(card_relations)
    if errors:
        for message in errors:
            print(f"error: {message}", file=sys.stderr)
        return 1
    if len(normalized) != len(payload):
        print("error: some cards were not validated", file=sys.stderr)
        return 1

    if dry_run:
        print(
            json.dumps(
                {
                    "dry_run": True,
                    "validated": len(normalized),
                    "card_ids": [card["card_id"] for card in normalized],
                    "wrote": 0,
                },
                ensure_ascii=False,
            )
        )
        return 0

    cards = dedupe(cards_rows + normalized, ("card_id",))
    concepts_out = dedupe(
        card_concept_rows
        + [
            {"card_id": card["card_id"], "concept_id": raw["concept_id"], "role": "primary"}
            for card, raw in zip(normalized, payload)
        ],
        ("card_id", "concept_id"),
    )
    blocks_out = dedupe(
        card_block_rows
        + [
            {
                "card_id": card["card_id"],
                "block_id": block_id,
                "role": "evidence",
                "quote_sha": blocks[block_id]["text_sha256"],
            }
            for card, raw in zip(normalized, payload)
            for block_id in raw["block_ids"]
        ],
        ("card_id", "block_id"),
    )
    relations_out = dedupe(relation_rows + new_relations, ("from_card", "to_card", "relation"))

    cards.sort(key=lambda row: str(row.get("card_id") or ""))
    concepts_out.sort(key=lambda row: (str(row.get("card_id") or ""), str(row.get("concept_id") or "")))
    blocks_out.sort(key=lambda row: (str(row.get("card_id") or ""), str(row.get("block_id") or "")))
    relations_out.sort(
        key=lambda row: (
            str(row.get("from_card") or ""),
            str(row.get("to_card") or ""),
            str(row.get("relation") or ""),
        )
    )

    atomic_write_jsonl(index_dir / TABLE_CARDS, cards)
    atomic_write_jsonl(index_dir / TABLE_CARD_CONCEPTS, concepts_out)
    atomic_write_jsonl(index_dir / TABLE_CARD_BLOCKS, blocks_out)
    atomic_write_jsonl(index_dir / TABLE_CARD_RELATIONS, relations_out)
    print(
        json.dumps(
            {
                "dry_run": False,
                "validated": len(normalized),
                "card_ids": [card["card_id"] for card in normalized],
                "wrote": len(normalized),
                "tables": [TABLE_CARDS, TABLE_CARD_CONCEPTS, TABLE_CARD_BLOCKS, TABLE_CARD_RELATIONS],
            },
            ensure_ascii=False,
        )
    )
    return 0


def add_relation(index_dir: Path, from_card: str, to_card: str, relation: str, note: str, dry_run: bool) -> int:
    if relation not in RELATIONS:
        print(f"error: bad relation: {relation!r}", file=sys.stderr)
        return 1
    cards_rows = read_jsonl(index_dir / TABLE_CARDS)
    relation_rows = read_jsonl(index_dir / TABLE_CARD_RELATIONS)
    cards = {row["card_id"] for row in cards_rows if "card_id" in row}
    errors = []
    if from_card not in cards:
        errors.append(f"unknown from_card: {from_card}")
    if to_card not in cards:
        errors.append(f"unknown to_card: {to_card}")
    key = (from_card, to_card, relation)
    if any(
        (row.get("from_card"), row.get("to_card"), row.get("relation")) == key
        for row in relation_rows
    ):
        errors.append(f"duplicate relation: {key}")
    if errors:
        for message in errors:
            print(f"error: {message}", file=sys.stderr)
        return 1
    if dry_run:
        print(json.dumps({"dry_run": True, "relation": key, "wrote": 0}, ensure_ascii=False))
        return 0
    relation_rows.append({"from_card": from_card, "to_card": to_card, "relation": relation, "note": note})
    relation_rows = dedupe(relation_rows, ("from_card", "to_card", "relation"))
    relation_rows.sort(
        key=lambda row: (
            str(row.get("from_card") or ""),
            str(row.get("to_card") or ""),
            str(row.get("relation") or ""),
        )
    )
    atomic_write_jsonl(index_dir / TABLE_CARD_RELATIONS, relation_rows)
    print(json.dumps({"dry_run": False, "relation": key, "wrote": 1}, ensure_ascii=False))
    return 0


def deprecate_card(index_dir: Path, card_id: str, status: str, dry_run: bool) -> int:
    if status not in {"deprecated", "superseded"}:
        print(f"error: bad deprecate status: {status!r}", file=sys.stderr)
        return 1
    cards_rows = read_jsonl(index_dir / TABLE_CARDS)
    target = next((row for row in cards_rows if row.get("card_id") == card_id), None)
    if target is None:
        print(f"error: unknown card_id: {card_id}", file=sys.stderr)
        return 1
    changed = target.get("status") != status
    if dry_run:
        print(
            json.dumps(
                {"dry_run": True, "card_id": card_id, "status": status, "changed": changed, "wrote": 0},
                ensure_ascii=False,
            )
        )
        return 0
    target["status"] = status
    cards_rows.sort(key=lambda row: str(row.get("card_id") or ""))
    atomic_write_jsonl(index_dir / TABLE_CARDS, cards_rows)
    print(
        json.dumps(
            {"dry_run": False, "card_id": card_id, "status": status, "changed": changed, "wrote": 1},
            ensure_ascii=False,
        )
    )
    return 0


def run_locked(index_dir: Path, dry_run: bool, action):
    if dry_run:
        return action()
    with catalog_lock(index_dir):
        return action()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Administer index-layer cards.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    add = subparsers.add_parser("add-card", help="validate and append one card or an array")
    add.add_argument("--root", default=str(Path(__file__).resolve().parents[1]))
    add.add_argument("--index-dir", default=None)
    add.add_argument("--json", dest="json_path", required=True, help="JSON file, or - for stdin")
    add.add_argument("--dry-run", action="store_true")

    relation = subparsers.add_parser("add-relation", help="append one card relation")
    relation.add_argument("--root", default=str(Path(__file__).resolve().parents[1]))
    relation.add_argument("--index-dir", default=None)
    relation.add_argument("--from", dest="from_card", required=True)
    relation.add_argument("--to", dest="to_card", required=True)
    relation.add_argument("--relation", required=True)
    relation.add_argument("--note", default="")
    relation.add_argument("--dry-run", action="store_true")

    deprecate = subparsers.add_parser("deprecate-card", help="mark a card deprecated or superseded")
    deprecate.add_argument("--root", default=str(Path(__file__).resolve().parents[1]))
    deprecate.add_argument("--index-dir", default=None)
    deprecate.add_argument("--card-id", required=True)
    deprecate.add_argument("--status", choices=["deprecated", "superseded"], default="deprecated")
    deprecate.add_argument("--dry-run", action="store_true")

    args = parser.parse_args(argv)
    index_dir = resolve_index(args)

    if args.command == "add-card":
        payload = load_payload(args.json_path)
        return run_locked(index_dir, args.dry_run, lambda: add_cards(index_dir, payload, args.dry_run))
    if args.command == "add-relation":
        return run_locked(
            index_dir,
            args.dry_run,
            lambda: add_relation(
                index_dir, args.from_card, args.to_card, args.relation, args.note, args.dry_run
            ),
        )
    return run_locked(
        index_dir,
        args.dry_run,
        lambda: deprecate_card(index_dir, args.card_id, args.status, args.dry_run),
    )


if __name__ == "__main__":
    raise SystemExit(main())
