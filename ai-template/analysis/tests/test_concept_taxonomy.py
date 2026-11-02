"""Concept taxonomy contract tests for the event expansion in concept_types.jsonl."""

import json
import shutil
from collections import Counter
from pathlib import Path

import pytest

AI_ROOT = Path(__file__).resolve().parents[2]
INDEX_DIR = AI_ROOT / "data" / "index"

NEW_L2_IDS = {
    "EVENT.SLEEP",
    "EVENT.FOOD",
    "EVENT.EXERCISE",
    "EVENT.HEALTH",
    "EVENT.ENTERTAINMENT",
    "EVENT.CHORE",
    "EVENT.WORK",
    "EVENT.ADMIN",
}

NEW_L3_IDS = {
    "EVENT.SLEEP.WAKE",
    "EVENT.SLEEP.NAP",
    "EVENT.FOOD.MEAL",
    "EVENT.FOOD.ORDER",
    "EVENT.EXERCISE.WALK",
    "EVENT.EXERCISE.WORKOUT",
    "EVENT.HEALTH.SYMPTOM",
    "EVENT.HEALTH.MEDICAL",
    "EVENT.ENTERTAINMENT.VIDEO",
    "EVENT.ENTERTAINMENT.GAME",
    "EVENT.CHORE.HOUSEHOLD",
    "EVENT.WORK.PROJECT",
    "EVENT.ADMIN.APPLICATION",
    "EVENT.ADMIN.DOCUMENT",
    "EVENT.STUDY.CLASS",
    "EVENT.STUDY.EXAM",
    "EVENT.TRAVEL.OUTING",
}

NEW_IDS = NEW_L2_IDS | NEW_L3_IDS

EXPECTED_REQUIRED_SLOTS = {
    "EVENT.SLEEP": [],
    "EVENT.FOOD": [],
    "EVENT.EXERCISE": [],
    "EVENT.HEALTH": [],
    "EVENT.ENTERTAINMENT": [],
    "EVENT.CHORE": [],
    "EVENT.WORK": [],
    "EVENT.ADMIN": [],
    "EVENT.SLEEP.WAKE": ["date", "time"],
    "EVENT.SLEEP.NAP": ["date", "time"],
    "EVENT.FOOD.MEAL": ["date", "time"],
    "EVENT.FOOD.ORDER": ["date", "time"],
    "EVENT.EXERCISE.WALK": ["date", "time"],
    "EVENT.EXERCISE.WORKOUT": ["date", "time"],
    "EVENT.HEALTH.SYMPTOM": ["date", "symptom"],
    "EVENT.HEALTH.MEDICAL": ["date", "object"],
    "EVENT.ENTERTAINMENT.VIDEO": ["date", "time"],
    "EVENT.ENTERTAINMENT.GAME": ["date", "time"],
    "EVENT.CHORE.HOUSEHOLD": ["date", "object"],
    "EVENT.WORK.PROJECT": ["date", "object"],
    "EVENT.ADMIN.APPLICATION": ["date", "object"],
    "EVENT.ADMIN.DOCUMENT": ["date", "object"],
    "EVENT.STUDY.CLASS": ["date", "time", "subject"],
    "EVENT.STUDY.EXAM": ["date", "time", "subject"],
    "EVENT.TRAVEL.OUTING": ["date", "from", "to"],
}


@pytest.fixture()
def concepts(tmp_path: Path) -> list[dict]:
    source = INDEX_DIR / "concept_types.jsonl"
    snapshot = tmp_path / "concept_types.jsonl"
    shutil.copyfile(source, snapshot)
    rows = []
    for lineno, line in enumerate(snapshot.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        row = json.loads(line)
        assert isinstance(row, dict), f"line {lineno} is not a JSON object"
        rows.append(row)
    return rows


@pytest.fixture()
def by_id(concepts: list[dict]) -> dict[str, dict]:
    return {row["concept_id"]: row for row in concepts}


def concept_depth(concept_id: str, by_id: dict[str, dict]) -> int:
    depth = 0
    current = concept_id
    seen = set()
    while current is not None:
        assert current not in seen, f"cycle at {concept_id}"
        seen.add(current)
        depth += 1
        row = by_id[current]
        current = row.get("parent_id")
    return depth


def test_row_count_within_target(concepts: list[dict]) -> None:
    assert 48 <= len(concepts) <= 53


def test_level_counts(concepts: list[dict]) -> None:
    counts = Counter(row["level"] for row in concepts)
    parent_ids = {row["parent_id"] for row in concepts if row.get("parent_id")}
    l3_leaves = [
        row
        for row in concepts
        if row["level"] == 3 and row["concept_id"] not in parent_ids
    ]
    assert counts[1] == 5
    assert counts[2] == 18
    assert 28 <= len(l3_leaves) <= 30
    assert counts[3] == len(l3_leaves)


def test_concept_ids_are_unique(concepts: list[dict]) -> None:
    ids = [row["concept_id"] for row in concepts]
    assert len(ids) == len(set(ids))


def test_parent_and_level_consistency(concepts: list[dict], by_id: dict[str, dict]) -> None:
    for row in concepts:
        depth = concept_depth(row["concept_id"], by_id)
        assert row["level"] == depth, row["concept_id"]
        if row["level"] == 1:
            assert row["parent_id"] is None, row["concept_id"]
            continue
        parent = by_id[row["parent_id"]]
        assert parent["level"] == row["level"] - 1, row["concept_id"]


def test_depth_at_most_three(concepts: list[dict], by_id: dict[str, dict]) -> None:
    for row in concepts:
        assert concept_depth(row["concept_id"], by_id) <= 3, row["concept_id"]


def test_new_leaves_are_terminal(concepts: list[dict], by_id: dict[str, dict]) -> None:
    parent_ids = {row["parent_id"] for row in concepts if row.get("parent_id")}
    for concept_id in NEW_L3_IDS:
        assert concept_id in by_id
        assert concept_id not in parent_ids, concept_id
    for concept_id in NEW_L2_IDS:
        assert concept_id in by_id
        assert concept_id in parent_ids, concept_id
        assert by_id[concept_id]["level"] == 2


def test_expected_new_ids_present(concepts: list[dict], by_id: dict[str, dict]) -> None:
    assert NEW_IDS <= set(by_id)
    owners = {
        row["concept_id"]
        for row in concepts
        if row.get("owner") == "2026-11-02-expansion"
    }
    assert owners == NEW_IDS


def test_new_rows_follow_event_contract(by_id: dict[str, dict]) -> None:
    for concept_id in NEW_IDS:
        row = by_id[concept_id]
        assert row["kind"] == "event"
        assert row["status"] == "active"
        assert row["version"] == 1
        assert row["owner"] == "2026-11-02-expansion"
        assert row["level"] == (2 if concept_id in NEW_L2_IDS else 3)
        assert isinstance(row["definition"], str) and row["definition"].strip()
        for field in ("includes", "excludes", "required_slots", "aliases"):
            assert isinstance(row[field], list)
        assert row["required_slots"] == EXPECTED_REQUIRED_SLOTS[concept_id]
        if concept_id in NEW_L3_IDS:
            assert row["includes"]
            assert row["excludes"]
            assert row["aliases"]


def test_no_duplicate_names_or_alias_collisions(
    concepts: list[dict], by_id: dict[str, dict]
) -> None:
    names: dict[str, str] = {}
    alias_owner: dict[str, str] = {}
    for row in concepts:
        concept_id = row["concept_id"]
        assert row["name"] not in names, row["name"]
        names[row["name"]] = concept_id
        local_aliases = set()
        for alias in row["aliases"]:
            assert alias not in local_aliases, (concept_id, alias)
            local_aliases.add(alias)
            assert alias not in alias_owner, (concept_id, alias)
            alias_owner[alias] = concept_id
    for alias, owner in alias_owner.items():
        if alias in names:
            assert names[alias] == owner, (alias, owner, names[alias])
    for concept_id in NEW_IDS:
        for alias in by_id[concept_id]["aliases"]:
            assert alias not in names, (concept_id, alias)
