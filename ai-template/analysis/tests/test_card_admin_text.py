"""Plain-text card drafts for card_admin add-card."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import card_admin


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
        encoding="utf-8",
    )


@pytest.fixture()
def index(tmp_path: Path) -> Path:
    root = tmp_path / "ai"
    index = root / "data" / "index"
    index.mkdir(parents=True)
    write_jsonl(index / "concept_types.jsonl", [
        {"concept_id": "EVENT", "name": "事件", "kind": "event", "parent_id": None},
        {
            "concept_id": "EVENT.TEST", "name": "测试事件", "kind": "event",
            "parent_id": "EVENT", "level": 2, "required_slots": ["date", "time"],
        },
    ])
    write_jsonl(index / "blocks.jsonl", [{
        "block_id": "B-1", "text": "测试块", "text_sha256": sha("测试块"),
    }])
    for name in ("cards.jsonl", "card_concepts.jsonl", "card_blocks.jsonl", "card_relations.jsonl"):
        write_jsonl(index / name, [])
    return index


def test_parse_text_cards_multiple_and_fields():
    text = """# 两张卡
card_id: C-1
kind: event
title: 第一张
statement: 第一张测试
date: 2026-11-01
time: 10:00
concept: EVENT.TEST
blocks: B-1, B-2
slot: who=H1
version: 2
---
card_id: C-2
kind: event
title: 第二张
statement: 第二张测试
date: 2026-11-01
time: 11:00
concept_id: EVENT.TEST
block: B-1
"""
    cards = card_admin.parse_text_cards(text)
    assert [card["card_id"] for card in cards] == ["C-1", "C-2"]
    assert cards[0]["block_ids"] == ["B-1", "B-2"]
    assert cards[0]["slots"] == {"who": "H1"}
    assert cards[0]["version"] == 2
    assert cards[1]["concept_id"] == "EVENT.TEST"


def test_text_add_card_dry_run_output_is_text(index: Path, tmp_path: Path, capsys):
    draft = tmp_path / "cards.txt"
    draft.write_text(
        """card_id: C-TEXT-1
kind: event
title: 文本卡
statement: 文本卡测试
date: 2026-11-01
time: 10:00
concept: EVENT.TEST
blocks: B-1
confidence: high
""",
        encoding="utf-8",
    )
    rc = card_admin.main([
        "add-card", "--index-dir", str(index), "--text", str(draft), "--dry-run",
    ])
    out, err = capsys.readouterr()
    assert rc == 0, err
    assert out.startswith("dry-run: validated 1 card(s)")
    assert "C-TEXT-1" in out
    assert not out.lstrip().startswith("{")


def test_text_unknown_field_fails():
    with pytest.raises(SystemExit) as exc:
        card_admin.parse_text_cards(
            "card_id: C-1\nkind: event\ntitle: x\nstatement: y\nunknown: z\n"
        )
    assert "unknown field" in str(exc.value)


def _seed_card(index: Path) -> None:
    write_jsonl(index / "cards.jsonl", [{"card_id": "C-1", "kind": "event"}])


def _read_rows(path: Path) -> list[dict]:
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def test_add_evidence_dry_run_then_write(index: Path, capsys):
    _seed_card(index)
    args = [
        "add-evidence", "--index-dir", str(index),
        "--card-id", "C-1", "--block-id", "B-1",
    ]

    rc = card_admin.main([*args, "--dry-run"])
    out, err = capsys.readouterr()
    assert rc == 0, err
    assert out.startswith("dry-run: C-1 <- B-1 (corroboration); wrote 0")
    assert _read_rows(index / "card_blocks.jsonl") == []

    rc = card_admin.main([*args, "--note", "报告佐证"])
    out, err = capsys.readouterr()
    assert rc == 0, err
    assert out.startswith("wrote evidence: C-1 <- B-1 (corroboration)")
    assert _read_rows(index / "card_blocks.jsonl") == [{
        "card_id": "C-1",
        "block_id": "B-1",
        "role": "corroboration",
        "quote_sha": sha("测试块"),
        "note": "报告佐证",
    }]


def test_add_evidence_rejects_duplicate_and_unknown_refs(index: Path, capsys):
    _seed_card(index)
    base = ["add-evidence", "--index-dir", str(index), "--block-id", "B-1"]

    rc = card_admin.main([*base, "--card-id", "C-1"])
    assert rc == 0
    capsys.readouterr()

    rc = card_admin.main([*base, "--card-id", "C-1"])
    _, err = capsys.readouterr()
    assert rc == 1
    assert "duplicate card_blocks row" in err

    rc = card_admin.main([*base, "--card-id", "C-NOPE"])
    _, err = capsys.readouterr()
    assert rc == 1
    assert "unknown card_id" in err

    rc = card_admin.main([
        "add-evidence", "--index-dir", str(index),
        "--card-id", "C-1", "--block-id", "B-NOPE",
    ])
    _, err = capsys.readouterr()
    assert rc == 1
    assert "unknown block_id" in err
