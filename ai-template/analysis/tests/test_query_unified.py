"""query.py 统一只读检索回归测试（tmp_path 造最小索引/记忆，不碰生产数据）。"""

from __future__ import annotations

import hashlib
import io
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import query


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
        encoding="utf-8",
    )


def _append_jsonl(path: Path, rows: list[dict]) -> None:
    with path.open("a", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def _write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


@pytest.fixture()
def corpus(tmp_path: Path) -> SimpleNamespace:
    root = tmp_path / "ai"
    index = root / "data" / "index"
    index.mkdir(parents=True)

    concepts = [
        {"concept_id": "EVENT", "name": "事件", "kind": "event", "parent_id": None},
        {"concept_id": "EVENT.STUDY", "name": "学习", "kind": "event", "parent_id": "EVENT"},
        {"concept_id": "EVENT.STUDY.EXAM", "name": "考试", "kind": "event", "parent_id": "EVENT.STUDY"},
        {"concept_id": "EVENT.MAINT", "name": "维修", "kind": "event", "parent_id": "EVENT"},
        {"concept_id": "OBS", "name": "观察", "kind": "observation", "parent_id": None},
        {"concept_id": "OBS.SLEEP", "name": "睡眠观察", "kind": "observation", "parent_id": "OBS"},
    ]
    _write_jsonl(index / "concept_types.jsonl", concepts)

    batch_1031 = _write(
        root / "data" / "daily" / "2026-10-31" / "理解-2026-10-31-批次-16.md",
        "## 10:00~10:10\n修电脑，更换主板\n## 11:00~11:10\n观察：修电脑后风扇安静\n",
    )
    batch_1101 = _write(
        root / "data" / "daily" / "2026-11-01" / "理解-2026-11-01-批次-01.md",
        "## 09:00~09:10\n决定换电脑\n",
    )
    batch_1102 = _write(
        root / "data" / "daily" / "2026-11-02" / "理解-2026-11-02-批次-01.md",
        "## 08:00~08:10\n发现：睡眠不足\n",
    )
    legacy_1030 = _write(
        root / "data" / "daily" / "2026-10-30" / "理解-2026-10-30.md",
        "维修期间先用旧电脑\n",
    )
    weekly = _write(
        root / "data" / "reports" / "每周总结-2026-10-30~11-02.md",
        "# 每周总结\n每周总结：修电脑、换电脑与睡眠\n",
    )
    daily_report = _write(
        root / "data" / "daily" / "2026-10-31" / "复盘-2026-10-31.md",
        "日报：修电脑\n",
    )

    blocks = [
        {
            "block_id": "B-1", "source_type": "batch", "source_kind": "daily",
            "file": str(batch_1031.relative_to(root)), "date": "2026-10-31",
            "heading": "10:00~10:10", "line_start": 1, "line_end": 2,
            "text": "修电脑，更换主板", "text_sha256": _sha("修电脑，更换主板"), "status": "active",
        },
        {
            "block_id": "B-2", "source_type": "batch", "source_kind": "daily",
            "file": str(batch_1101.relative_to(root)), "date": "2026-11-01",
            "heading": "09:00~09:10", "line_start": 1, "line_end": 2,
            "text": "决定换电脑", "text_sha256": _sha("决定换电脑"), "status": "active",
        },
        {
            "block_id": "B-3", "source_type": "batch", "source_kind": "daily",
            "file": str(batch_1031.relative_to(root)), "date": "2026-10-31",
            "heading": "11:00~11:10", "line_start": 3, "line_end": 4,
            "text": "观察：修电脑后风扇安静", "text_sha256": _sha("观察：修电脑后风扇安静"),
            "status": "active",
        },
        {
            "block_id": "B-4", "source_type": "batch", "source_kind": "daily",
            "file": str(batch_1102.relative_to(root)), "date": "2026-11-02",
            "heading": "08:00~08:10", "line_start": 1, "line_end": 2,
            "text": "发现：睡眠不足", "text_sha256": _sha("发现：睡眠不足"), "status": "active",
        },
        {
            "block_id": "L-1", "source_type": "legacy", "source_kind": "daily",
            "file": str(legacy_1030.relative_to(root)), "date": "2026-10-30",
            "heading": "全天", "line_start": 1, "line_end": 1,
            "text": "维修期间先用旧电脑", "text_sha256": _sha("维修期间先用旧电脑"), "status": "active",
        },
        {
            "block_id": "R-1", "source_type": "review", "source_kind": "review",
            "file": str(weekly.relative_to(root)), "date": "2026-11-01",
            "heading": "周报", "line_start": 1, "line_end": 2,
            "text": "每周总结：修电脑、换电脑与睡眠",
            "text_sha256": _sha("每周总结：修电脑、换电脑与睡眠"), "status": "active",
        },
    ]
    _write_jsonl(index / "blocks.jsonl", blocks)

    cards = [
        {
            "card_id": "C-E1", "kind": "event", "title": "修电脑",
            "statement": "修电脑，更换主板。", "date": "2026-10-31", "time": "10:00",
            "slots": {"who": "H1"}, "confidence": "high", "status": "active", "version": 1,
        },
        {
            "card_id": "C-E2", "kind": "state", "title": "电脑维修状态",
            "statement": "维修期间先用旧电脑", "period_start": "2026-10-30",
            "period_end": "2026-11-02", "slots": {"who": "H1"}, "confidence": "mid",
            "status": "active", "version": 1,
        },
        {
            "card_id": "C-E3", "kind": "decision", "title": "决定升级设备",
            "statement": "决定换掉旧电脑", "date": "2026-11-01", "time": "09:00",
            "slots": {}, "confidence": "high", "status": "active", "version": 1,
        },
        {
            "card_id": "C-O1", "kind": "observation", "title": "修电脑观察",
            "statement": "观察到修电脑后风扇安静", "date": "2026-10-31",
            "slots": {}, "confidence": "mid", "status": "active", "version": 1,
        },
        {
            "card_id": "C-O2", "kind": "finding", "title": "睡眠发现",
            "statement": "发现睡眠不足", "date": "2026-11-02",
            "slots": {}, "confidence": "mid", "status": "active", "version": 1,
        },
    ]
    _write_jsonl(index / "cards.jsonl", cards)
    _write_jsonl(index / "card_concepts.jsonl", [
        {"card_id": "C-E1", "concept_id": "EVENT.STUDY.EXAM", "role": "primary"},
        {"card_id": "C-E2", "concept_id": "EVENT.MAINT", "role": "primary"},
        {"card_id": "C-E3", "concept_id": "EVENT.STUDY.EXAM", "role": "primary"},
        {"card_id": "C-O1", "concept_id": "OBS.SLEEP", "role": "primary"},
        {"card_id": "C-O2", "concept_id": "OBS.SLEEP", "role": "primary"},
    ])
    _write_jsonl(index / "card_blocks.jsonl", [
        {"card_id": "C-E1", "block_id": "B-1", "role": "evidence", "quote_sha": _sha("修电脑，更换主板")},
        {"card_id": "C-E2", "block_id": "L-1", "role": "evidence", "quote_sha": _sha("维修期间先用旧电脑")},
        {"card_id": "C-E3", "block_id": "B-2", "role": "evidence", "quote_sha": _sha("决定换电脑")},
        {"card_id": "C-O1", "block_id": "B-3", "role": "evidence", "quote_sha": _sha("观察：修电脑后风扇安静")},
        {"card_id": "C-O2", "block_id": "B-4", "role": "evidence", "quote_sha": _sha("发现：睡眠不足")},
    ])
    _write_jsonl(index / "card_relations.jsonl", [
        {"from_card": "C-E1", "to_card": "C-E3", "relation": "precedes", "note": "same day"},
    ])

    reports = [
        {
            "report_id": "D-20261031", "report_type": "daily", "layer": "event",
            "period_start": "2026-10-31", "period_end": "2026-10-31",
            "title": "日报-2026-10-31", "file": str(daily_report.relative_to(root)),
            "line_count": 1, "text_sha256": _sha("日报：修电脑"),
            "block_ids": [], "card_ids": ["C-E1"], "status": "active", "version": 1,
        },
        {
            "report_id": "W-20261102", "report_type": "weekly", "layer": "observation",
            "period_start": "2026-10-30", "period_end": "2026-11-02",
            "title": "每周总结-2026-10-30~11-02", "file": str(weekly.relative_to(root)),
            "line_count": 2, "text_sha256": _sha("每周总结：修电脑、换电脑与睡眠"),
            "block_ids": ["R-1"], "card_ids": ["C-E1", "C-O1"], "status": "active", "version": 1,
        },
    ]
    _write_jsonl(index / "reports.jsonl", reports)
    _write_jsonl(index / "report_relations.jsonl", [
        {"from_report": "W-20261102", "to_report": "D-20261031", "relation": "covers", "note": "weekly covers daily"},
    ])

    memory = root / "memory"
    memory_file = _write(
        memory / "topics" / "repair.md",
        "# 修电脑\n\n用户曾修电脑，更换主板。\n",
    )
    os.utime(memory_file, (1_700_000_000, 1_700_000_000))

    return SimpleNamespace(root=root, index=index, memory=memory, blocks=blocks, cards=cards)


def _args(corpus: SimpleNamespace, *extra: str) -> list[str]:
    return ["--root", str(corpus.root), "--index-dir", str(corpus.index), *extra]


def _run(capsys: pytest.CaptureFixture[str], *args: str) -> tuple[int, str, str]:
    rc = query.main(list(args))
    captured = capsys.readouterr()
    return rc, captured.out, captured.err


def _json(capsys: pytest.CaptureFixture[str], *args: str) -> tuple[int, dict, str]:
    rc, out, err = _run(capsys, *args)
    payload = json.loads(out) if out.strip() else {}
    return rc, payload, err


def _ids(payload: dict) -> list[str]:
    return [item["id"] for item in payload["items"]]


# ---------------------------------------------------------------- scopes


def test_scope_layer_order_and_default_all_excludes_evidence(corpus, capsys):
    rc, payload, err = _json(
        capsys, *_args(
            corpus, "--scope", "event", "--scope", "observation", "--scope", "report",
            "--from", "2026-10-31", "--to", "2026-11-01", "--grep", "修电脑",
            "--format", "json",
        ),
    )
    assert rc == 0, err
    assert [group["key"] for group in payload["groups"]] == ["event", "observation", "report"]
    assert {item["scope"] for item in payload["items"]} == {"event", "observation", "report"}

    _, all_payload, _ = _json(
        capsys, *_args(corpus, "--scope", "all", "--from", "2026-10-31",
                       "--to", "2026-11-01", "--grep", "修电脑", "--format", "json"),
    )
    assert all_payload["query"]["scopes"] == ["event", "observation", "report", "memory", "chat"]
    assert "evidence" not in all_payload["query"]["scopes"]


def test_scope_accepts_comma_and_slash_values(corpus, capsys):
    for value in ("event,observation", "event/observation"):
        rc, payload, err = _json(
            capsys, *_args(
                corpus, "--scope", value, "--from", "2026-10-31",
                "--to", "2026-11-01", "--format", "json",
            ),
        )
        assert rc == 0, err
        assert payload["query"]["scopes"] == ["event", "observation"]
        assert {item["scope"] for item in payload["items"]} <= {"event", "observation"}


def test_scope_rejects_unknown_comma_token(corpus):
    with pytest.raises(SystemExit) as exc:
        query.main(_args(
            corpus, "--scope", "event,bogus", "--from", "2026-10-31",
            "--to", "2026-11-01", "--format", "json",
        ))
    assert exc.value.code == 2


def test_all_include_linked_evidence_expands_evidence_layer(corpus, capsys):
    rc, payload, err = _json(
        capsys, *_args(
            corpus, "--scope", "all", "--allow-full-scan",
            "--include-linked-evidence", "--format", "json",
        ),
    )
    assert rc == 0, err
    assert payload["query"]["scopes"] == ["event", "observation", "report", "evidence"]
    assert payload["counts"]["by_scope"].get("evidence", 0) > 0
    assert any(item["scope"] == "evidence" for item in payload["items"])


def test_event_and_observation_scope_kind_semantics(corpus, capsys):
    _, event_payload, _ = _json(
        capsys, *_args(corpus, "--scope", "event", "--from", "2026-10-30",
                       "--to", "2026-11-02", "--format", "json"),
    )
    assert {item["type"] for item in event_payload["items"]} <= {"event", "state", "decision"}
    assert [item["id"] for item in event_payload["items"]] == ["C-E3", "C-E1", "C-E2"]

    _, obs_payload, _ = _json(
        capsys, *_args(corpus, "--scope", "observation", "--kind", "finding",
                       "--from", "2026-10-30", "--to", "2026-11-02", "--format", "json"),
    )
    assert _ids(obs_payload) == ["C-O2"]


def test_date_range_is_inclusive_and_period_cards_overlap(corpus, capsys):
    rc, payload, err = _json(
        capsys, *_args(corpus, "--scope", "event", "--from", "2026-11-01",
                       "--to", "2026-11-01", "--format", "json"),
    )
    assert rc == 0, err
    assert _ids(payload) == ["C-E3", "C-E2"]

    _, report_payload, _ = _json(
        capsys, *_args(corpus, "--scope", "report", "--from", "2026-11-01",
                       "--to", "2026-11-01", "--format", "json"),
    )
    assert _ids(report_payload) == ["W-20261102"]


def test_concept_parent_expands_to_descendant_leaves(corpus, capsys):
    _, root_payload, _ = _json(
        capsys, *_args(corpus, "--scope", "event", "--concept", "EVENT",
                       "--from", "2026-10-30", "--to", "2026-11-02", "--format", "json"),
    )
    assert set(_ids(root_payload)) == {"C-E1", "C-E2", "C-E3"}

    _, branch_payload, _ = _json(
        capsys, *_args(corpus, "--scope", "event", "--concept", "EVENT.STUDY",
                       "--from", "2026-10-30", "--to", "2026-11-02", "--format", "json"),
    )
    assert set(_ids(branch_payload)) == {"C-E1", "C-E3"}

    rc, _, err = _run(
        capsys, *_args(corpus, "--scope", "event", "--concept", "NOPE",
                       "--from", "2026-10-30", "--to", "2026-11-02", "--format", "json"),
    )
    assert rc == 2
    assert "unknown concept" in err


# ---------------------------------------------------------------- ordering


def test_chrono_defaults_to_desc_and_asc_reverses(corpus, capsys):
    _, desc_payload, _ = _json(
        capsys, *_args(corpus, "--scope", "event", "--from", "2026-10-30",
                       "--to", "2026-11-01", "--format", "json"),
    )
    assert _ids(desc_payload) == ["C-E3", "C-E1", "C-E2"]

    _, asc_payload, _ = _json(
        capsys, *_args(corpus, "--scope", "event", "--from", "2026-10-30",
                       "--to", "2026-11-01", "--order", "chrono", "--asc", "--format", "json"),
    )
    assert _ids(asc_payload) == ["C-E2", "C-E1", "C-E3"]


def test_relevance_prioritizes_title_tier_then_layer_then_date(corpus, capsys):
    _, payload, _ = _json(
        capsys, *_args(corpus, "--scope", "event", "--from", "2026-10-30",
                       "--to", "2026-11-01", "--grep", "电脑", "--order", "relevance",
                       "--format", "json"),
    )
    assert _ids(payload) == ["C-E1", "C-E2", "C-E3"]
    tiers = {item["id"]: item["rank"]["text_tier"] for item in payload["items"]}
    assert tiers["C-E1"] == 0
    assert tiers["C-E2"] == 0
    assert tiers["C-E3"] == 1


def test_relevance_with_asc_is_usage_error(corpus, capsys):
    rc, _, err = _run(
        capsys, *_args(corpus, "--scope", "event", "--from", "2026-10-30",
                       "--to", "2026-11-01", "--grep", "电脑", "--order", "relevance",
                       "--asc", "--format", "json"),
    )
    assert rc == 2
    assert "relevance" in err


# ---------------------------------------------------------------- grouping


def test_group_by_date_descending_and_layer_order_inside(corpus, capsys):
    _, payload, _ = _json(
        capsys, *_args(corpus, "--scope", "event", "--scope", "observation",
                       "--from", "2026-10-30", "--to", "2026-11-02",
                       "--group-by", "date", "--format", "json"),
    )
    assert [group["key"] for group in payload["groups"]] == [
        "2026-11-02", "2026-11-01", "2026-10-31", "2026-10-30",
    ]
    oct_31 = [item for item in payload["items"] if item["date"] == "2026-10-31"]
    assert [item["scope"] for item in oct_31] == ["event", "observation"]
    nov_2 = [item for item in payload["items"] if item["date"] == "2026-11-02"]
    assert [item["scope"] for item in nov_2] == ["observation"]


def test_group_by_none_has_empty_groups(corpus, capsys):
    _, payload, _ = _json(
        capsys, *_args(corpus, "--scope", "event", "--from", "2026-10-30",
                       "--to", "2026-11-02", "--group-by", "none", "--format", "json"),
    )
    assert payload["groups"] == []


# ---------------------------------------------------------------- dedupe


def test_card_and_evidence_dedupe_by_id_and_tuple(corpus, capsys):
    _append_jsonl(corpus.index / "cards.jsonl", [corpus.cards[0]])
    duplicate_block = dict(corpus.blocks[0], block_id="B-DUP")
    _append_jsonl(corpus.index / "blocks.jsonl", [duplicate_block])

    _, card_payload, _ = _json(
        capsys, *_args(corpus, "--scope", "event", "--from", "2026-10-30",
                       "--to", "2026-11-02", "--format", "json"),
    )
    assert card_payload["counts"]["deduped"] >= 1
    assert _ids(card_payload).count("C-E1") == 1

    _, block_payload, _ = _json(
        capsys, *_args(corpus, "--scope", "evidence", "--from", "2026-10-30",
                       "--to", "2026-11-02", "--format", "json"),
    )
    assert block_payload["counts"]["deduped"] >= 1
    assert len({"B-1", "B-DUP"} & set(_ids(block_payload))) == 1


def test_cross_scope_hash_keeps_higher_layer_and_records_relation(corpus, capsys):
    duplicate = {
        "card_id": "C-E9", "kind": "event", "title": "哈希重复卡",
        "statement": "修电脑，更换主板", "date": "2026-10-31", "time": "10:05",
        "slots": {}, "confidence": "high", "status": "active", "version": 1,
    }
    _append_jsonl(corpus.index / "cards.jsonl", [duplicate])
    _append_jsonl(corpus.index / "card_blocks.jsonl", [
        {"card_id": "C-E9", "block_id": "B-1", "role": "evidence",
         "quote_sha": _sha("修电脑，更换主板")},
    ])
    _, payload, _ = _json(
        capsys, *_args(corpus, "--scope", "event", "--scope", "evidence",
                       "--from", "2026-10-30", "--to", "2026-11-02", "--grep", "修电脑",
                       "--include-linked-evidence", "--format", "json"),
    )
    ids = _ids(payload)
    assert "C-E9" in ids
    assert "B-1" not in ids
    card = next(item for item in payload["items"] if item["id"] == "C-E9")
    assert "B-1" in card["related_ids"]


def test_evidence_survives_when_citing_card_is_not_returned(corpus, capsys):
    late_card = {
        "card_id": "C-LATE", "kind": "event", "title": "迟到卡片",
        "statement": "迟到卡片引用 B-4", "date": "2026-10-30", "time": "08:00",
        "slots": {}, "confidence": "mid", "status": "active", "version": 1,
    }
    _append_jsonl(corpus.index / "cards.jsonl", [late_card])
    _append_jsonl(corpus.index / "card_blocks.jsonl", [
        {"card_id": "C-LATE", "block_id": "B-4", "role": "evidence",
         "quote_sha": _sha("发现：睡眠不足")},
    ])
    _, payload, _ = _json(
        capsys, *_args(corpus, "--scope", "event", "--scope", "evidence",
                       "--from", "2026-10-30", "--to", "2026-11-02",
                       "--limit", "2", "--group-by", "none", "--format", "json"),
    )
    ids = _ids(payload)
    assert "C-LATE" not in ids
    assert "B-4" in ids


def test_linked_evidence_is_dropped_unless_requested(corpus, capsys):
    _, dropped_payload, _ = _json(
        capsys, *_args(corpus, "--scope", "event", "--scope", "observation",
                       "--scope", "evidence", "--from", "2026-10-30", "--to", "2026-11-02",
                       "--grep", "修电脑", "--format", "json"),
    )
    assert "B-1" not in _ids(dropped_payload)
    assert "B-3" not in _ids(dropped_payload)

    _, kept_payload, _ = _json(
        capsys, *_args(corpus, "--scope", "event", "--scope", "observation",
                       "--scope", "evidence", "--from", "2026-10-30", "--to", "2026-11-02",
                       "--grep", "修电脑", "--include-linked-evidence", "--format", "json"),
    )
    ids = _ids(kept_payload)
    assert "B-1" in ids and "B-3" in ids


# ---------------------------------------------------------------- limits/budget


def test_per_scope_limit_then_round_robin_global_limit(corpus, capsys):
    _, payload, _ = _json(
        capsys, *_args(corpus, "--scope", "event", "--scope", "observation",
                       "--from", "2026-10-30", "--to", "2026-11-02",
                       "--limit", "3", "--limit-per-scope", "2",
                       "--group-by", "none", "--format", "json"),
    )
    assert len(payload["items"]) == 3
    assert payload["counts"]["total"] == 5
    assert payload["counts"]["returned"] == 3
    assert payload["counts"]["omitted_by_limit"] == 2
    assert [item["scope"] for item in payload["items"]] == [
        "event", "observation", "event",
    ]


def test_budget_truncates_or_omits_and_reports_bytes(corpus, capsys):
    long_text = "长文本" * 300
    extra = []
    for number in range(3):
        body = f"{long_text}{number}"
        extra.append({
            "block_id": f"B-BUDGET-{number}", "source_type": "batch",
            "source_kind": "daily", "file": "data/cache/long.md",
            "date": "2026-10-31", "heading": "long", "line_start": number + 1,
            "line_end": number + 1, "text": body, "text_sha256": _sha(body),
            "status": "active",
        })
    _append_jsonl(corpus.index / "blocks.jsonl", extra)

    _, payload, _ = _json(
        capsys, *_args(corpus, "--scope", "evidence", "--from", "2026-10-31",
                       "--to", "2026-10-31", "--grep", "长文本", "--budget", "700",
                       "--limit", "3", "--format", "json"),
    )
    assert payload["bytes"] <= 700
    assert payload["counts"]["returned"] == len(payload["items"])
    assert payload["counts"]["truncated"] > 0 or payload["counts"]["omitted_by_budget"] > 0
    if payload["items"]:
        assert any(item["snippet"].endswith("…") for item in payload["items"])


# ---------------------------------------------------------------- filters/safety


def test_no_filter_exits_2_unless_allow_full_scan(corpus, capsys):
    rc, _, err = _run(
        capsys, *_args(corpus, "--scope", "event", "--format", "json"),
    )
    assert rc == 2
    assert "allow-full-scan" in err

    rc, payload, _ = _json(
        capsys, *_args(corpus, "--scope", "event", "--allow-full-scan", "--format", "json"),
    )
    assert rc == 0
    assert len(payload["items"]) == 3


def test_memory_and_chat_require_their_own_filters(corpus, capsys):
    rc, _, _ = _run(
        capsys, *_args(corpus, "--scope", "memory", "--from", "2026-10-31", "--format", "json"),
    )
    assert rc == 2
    rc, _, _ = _run(
        capsys, *_args(corpus, "--scope", "chat", "--allow-full-scan", "--format", "json"),
    )
    assert rc == 2


def test_block_source_defaults_to_batch_legacy_with_review_opt_in(corpus, capsys):
    _, default_payload, _ = _json(
        capsys, *_args(corpus, "--scope", "evidence", "--from", "2026-10-30",
                       "--to", "2026-11-02", "--format", "json"),
    )
    assert "R-1" not in _ids(default_payload)
    assert "L-1" in _ids(default_payload)

    _, all_payload, _ = _json(
        capsys, *_args(corpus, "--scope", "evidence", "--from", "2026-10-30",
                       "--to", "2026-11-02", "--block-source", "all", "--format", "json"),
    )
    assert "R-1" in _ids(all_payload)


def test_report_type_layer_and_follow(corpus, capsys):
    _, payload, _ = _json(
        capsys, *_args(corpus, "--scope", "report", "--report-type", "weekly",
                       "--from", "2026-10-30", "--to", "2026-11-02", "--follow",
                       "--format", "json"),
    )
    assert _ids(payload) == ["W-20261102"]
    relations = payload["items"][0]["relations"]
    assert relations and relations[0]["relation"] == "covers"

    _, event_layer, _ = _json(
        capsys, *_args(corpus, "--scope", "report", "--report-layer", "event",
                       "--from", "2026-10-30", "--to", "2026-11-02", "--format", "json"),
    )
    assert _ids(event_layer) == ["D-20261031"]


def test_invalid_dates_exit_2(corpus, capsys):
    rc, _, _ = _run(
        capsys, *_args(corpus, "--scope", "event", "--from", "2026-11-02",
                       "--to", "2026-10-31", "--format", "json"),
    )
    assert rc == 2
    rc, _, _ = _run(
        capsys, *_args(corpus, "--scope", "event", "--from", "2026-13-01",
                       "--to", "2026-11-01", "--format", "json"),
    )
    assert rc == 2


# ---------------------------------------------------------------- adapters


def test_memory_adapter_with_monkeypatch(corpus, capsys, monkeypatch):
    calls: list[tuple] = []

    def fake_retrieve(root, query_text, budget=6000, max_items=12, context=1,
                      include_cold=False):
        calls.append((root, query_text, budget, max_items, context, include_cold))
        return {"items": [{
            "path": "topics/repair.md", "line": 3, "heading": "修电脑",
            "score": 0.9, "text": "用户曾修电脑，更换主板。",
        }]}

    monkeypatch.setattr(query.memory_retrieve, "retrieve", fake_retrieve)
    rc, payload, err = _json(
        capsys, *_args(corpus, "--scope", "memory", "--grep", "修电脑",
                       "--include-undated-memory", "--format", "json"),
    )
    assert rc == 0, err
    assert calls and calls[0][1] == "修电脑"
    item = payload["items"][0]
    assert item["scope"] == "memory"
    assert item["id"] == "topics/repair.md:3"
    assert item["date"] is None
    assert item["dedupe_key"].startswith("memory:")

    # 有日期窗口且未显式包含无日期记忆时，memory 不进入结果。
    _, dated_payload, _ = _json(
        capsys, *_args(corpus, "--scope", "memory", "--grep", "修电脑",
                       "--from", "2026-10-31", "--to", "2026-10-31", "--format", "json"),
    )
    assert dated_payload["items"] == []


def test_memory_missing_root_is_data_unavailable(tmp_path, capsys):
    root = tmp_path / "ai"
    root.mkdir()
    rc, _, err = _run(
        capsys, "--root", str(root), "--index-dir", str(root / "nope"),
        "--scope", "memory", "--grep", "修电脑", "--format", "json",
    )
    assert rc == 1
    assert err


def test_chat_adapter_with_monkeypatch(corpus, capsys, monkeypatch):
    calls: list[dict] = []

    class FakeChatlog:
        @staticmethod
        def _probe_port():
            return 9999

        @staticmethod
        def _load_token():
            return "token"

        @staticmethod
        def _query_chatlog(port, token, params):
            calls.append({"port": port, "token": token, "params": dict(params)})
            turns = [
                {"id": "m1", "role": "user", "time_ms": 1,
                 "time_str": "2026-10-31 10:00:00", "content": "修电脑的记录",
                 "tools": None, "session_id": "ses_1"},
                {"id": "m1", "role": "user", "time_ms": 1,
                 "time_str": "2026-10-31 10:00:00", "content": "修电脑的记录",
                 "tools": None, "session_id": "ses_1"},
                {"id": "m2", "role": "assistant", "time_ms": 2,
                 "time_str": "2026-10-31 10:00:05", "content": "好的",
                 "tools": ["write"], "session_id": "ses_1"},
            ]
            return 200, json.dumps({
                "session_id": "ses_1", "window": {}, "include_children": True,
                "message_count": len(turns), "truncated": False, "turns": turns,
            }, ensure_ascii=False)

    monkeypatch.setattr(query, "_chatlog_module", lambda: FakeChatlog)
    rc, payload, err = _json(
        capsys, *_args(corpus, "--scope", "chat", "--from", "2026-10-31",
                       "--to", "2026-10-31", "--grep", "修电脑",
                       "--include-children", "--format", "json"),
    )
    assert rc == 0, err
    assert calls[0]["params"]["start"] == "2026-10-31 00:00:00"
    assert calls[0]["params"]["end"] == "2026-10-31 23:59:59"
    assert calls[0]["params"]["include_children"] == "true"
    assert calls[0]["params"]["format"] == "json"
    assert _ids(payload) == ["m1"]
    assert payload["counts"]["deduped"] == 1
    item = payload["items"][0]
    assert item["type"] == "user"
    assert item["timestamp"] == "2026-10-31T10:00:00"
    assert item["dedupe_key"] == "chat:ses_1:m1"


def test_chat_failure_degrades_in_all_mode_but_explicit_fails(corpus, capsys, monkeypatch):
    class DeadChatlog:
        @staticmethod
        def _probe_port():
            return None

    monkeypatch.setattr(query, "_chatlog_module", lambda: DeadChatlog)
    rc, payload, err = _json(
        capsys, *_args(corpus, "--scope", "all", "--from", "2026-10-31",
                       "--to", "2026-10-31", "--grep", "修电脑", "--format", "json"),
    )
    assert rc == 0, err
    assert payload["warnings"]
    assert payload["items"]

    rc, _, _ = _run(
        capsys, *_args(corpus, "--scope", "chat", "--from", "2026-10-31",
                       "--to", "2026-10-31", "--format", "json"),
    )
    assert rc == 1


# ---------------------------------------------------------------- output/read-only


def test_json_schema_and_item_shape(corpus, capsys):
    _, payload, _ = _json(
        capsys, *_args(corpus, "--scope", "event", "--scope", "report",
                       "--from", "2026-10-30", "--to", "2026-11-02", "--format", "json"),
    )
    assert set(payload) == {
        "schema_version", "query", "counts", "groups", "items", "warnings", "bytes",
    }
    assert payload["schema_version"] == query.SCHEMA_VERSION
    assert set(payload["counts"]) == {
        "total", "returned", "by_scope", "deduped", "omitted_by_limit",
        "omitted_by_budget", "truncated",
    }
    item = payload["items"][0]
    assert set(item) == {
        "scope", "type", "id", "title", "snippet", "date", "timestamp", "rank",
        "meta", "evidence", "relations", "dedupe_key", "related_ids",
    }
    assert set(item["rank"]) == {"text_tier", "layer_priority", "date_key", "score"}
    for group in payload["groups"]:
        assert set(group) == {"key", "count", "ids"}


def test_table_output_has_group_headers_and_resolved_lines(corpus, capsys):
    rc, out, err = _run(
        capsys, *_args(corpus, "--scope", "event", "--scope", "report",
                       "--from", "2026-10-31", "--to", "2026-10-31", "--grep", "修电脑",
                       "--resolve", "--follow", "--format", "table"),
    )
    assert rc == 0, err
    assert "## event (" in out
    assert "## report (" in out
    assert "C-E1 | 2026-10-31T10:00 | event | 修电脑" in out
    assert "  -> B-1 " in out
    assert "  rel: C-E1 --precedes--> C-E3" in out


def test_run_does_not_write_any_file(corpus, capsys, monkeypatch):
    class FakeChatlog:
        @staticmethod
        def _probe_port():
            return None

    monkeypatch.setattr(query, "_chatlog_module", lambda: FakeChatlog)

    def snapshot() -> dict[str, tuple[str, int]]:
        return {
            str(path): (hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_mtime_ns)
            for path in sorted(corpus.root.rglob("*"))
            if path.is_file()
        }

    before = snapshot()
    rc, payload, err = _json(
        capsys, *_args(corpus, "--scope", "all", "--from", "2026-10-30",
                       "--to", "2026-11-02", "--grep", "修电脑",
                       "--include-undated-memory", "--format", "json"),
    )
    assert rc == 0, err
    assert payload["items"]
    assert snapshot() == before


# ---------------------------------------------------------------- request mode


def _request(**payload):
    return json.dumps(payload, ensure_ascii=False)


def _request_args(corpus, **payload):
    body = dict(payload)
    body.setdefault("root", str(corpus.root))
    body.setdefault("index_dir", str(corpus.index))
    return ["--request", _request(**body)]


def test_request_inline_json_success(corpus, capsys):
    rc, payload, err = _json(
        capsys, *_request_args(
            corpus, scope=["event", "observation"],
            **{"from": "2026-10-31", "to": "2026-11-01"},
        ),
    )
    assert rc == 0, err
    assert payload["ok"] is True
    assert payload["query"]["scopes"] == ["event", "observation"]
    assert payload["counts"]["total"] > 0


def test_request_stdin_success(corpus, capsys, monkeypatch):
    body = _request(
        root=str(corpus.root), index_dir=str(corpus.index),
        scope="event", **{"from": "2026-10-30", "to": "2026-11-01"},
    )
    monkeypatch.setattr(sys, "stdin", io.StringIO(body))
    rc, payload, err = _json(capsys, "--request", "-")
    assert rc == 0, err
    assert payload["ok"] is True
    assert payload["query"]["scopes"] == ["event"]


def test_request_file_success(corpus, capsys, tmp_path):
    request_file = tmp_path / "request.json"
    request_file.write_text(
        _request(
            root=str(corpus.root), index_dir=str(corpus.index),
            scope="event/observation", **{"from": "2026-10-31", "to": "2026-11-01"},
        ),
        encoding="utf-8",
    )
    rc, payload, err = _json(capsys, "--request", f"@{request_file}")
    assert rc == 0, err
    assert payload["ok"] is True
    assert payload["query"]["scopes"] == ["event", "observation"]


def test_request_slots_and_asc(corpus, capsys):
    rc, payload, err = _json(
        capsys, *_request_args(
            corpus, scope="event", **{"from": "2026-10-30", "to": "2026-11-01"},
            slots={"who": "H1"}, asc=True,
        ),
    )
    assert rc == 0, err
    assert [item["id"] for item in payload["items"]] == ["C-E2", "C-E1"]


def test_request_unknown_key_returns_invalid_request_json(corpus, capsys):
    rc, payload, err = _json(
        capsys, *_request_args(corpus, scope="event", bogus=1),
    )
    assert rc == 2
    assert err == ""
    assert payload["ok"] is False
    assert payload["error"]["type"] == "InvalidRequest"
    assert payload["error"]["details"]["unknown_keys"] == ["bogus"]


def test_request_invalid_json_returns_invalid_request_json(corpus, capsys):
    rc, payload, err = _json(capsys, "--request", "{")
    assert rc == 2
    assert err == ""
    assert payload["ok"] is False
    assert payload["error"]["type"] == "InvalidRequest"


def test_request_non_object_and_type_errors_return_invalid_request(corpus, capsys):
    cases = [
        ["--request", "[]"],
        _request_args(corpus, limit="5"),
        _request_args(corpus, resolve="yes"),
        _request_args(corpus, scope=None),
    ]
    for args in cases:
        rc, payload, err = _json(capsys, *args)
        assert rc == 2, args
        assert err == "", args
        assert payload["error"]["type"] == "InvalidRequest", args


def test_request_alias_conflicts_return_invalid_request(corpus, capsys):
    cases = [
        _request_args(corpus, scope="event", scopes=["event"]),
        _request_args(corpus, scope="event", slot={"who": "H1"}, slots={"who": "H1"}),
        _request_args(corpus, scope="event", asc=True, desc=True),
    ]
    for args in cases:
        rc, payload, err = _json(capsys, *args)
        assert rc == 2
        assert err == ""
        assert payload["error"]["type"] == "InvalidRequest"


def test_request_rejects_mixed_cli_flags(corpus, capsys):
    body = _request(
        root=str(corpus.root), index_dir=str(corpus.index), scope="event",
    )
    rc, payload, err = _json(capsys, "--request", body, "--format", "table")
    assert rc == 2
    assert err == ""
    assert payload["error"]["type"] == "UsageError"

    rc, payload, err = _json(capsys, "--request", body, "--grep", "修电脑")
    assert rc == 2
    assert err == ""
    assert payload["error"]["type"] == "UsageError"


def test_request_preserves_safety_guards(corpus, capsys):
    rc, payload, err = _json(capsys, *_request_args(corpus, scope="event"))
    assert rc == 2
    assert payload["error"]["type"] == "UsageError"

    rc, payload, err = _json(
        capsys, *_request_args(corpus, scope="event", allow_full_scan=True),
    )
    assert rc == 0, err
    assert payload["ok"] is True


def test_request_data_unavailable_returns_json(corpus, capsys, tmp_path):
    missing = tmp_path / "missing-ai"
    rc, payload, err = _json(
        capsys, "--request", _request(
            root=str(missing), scope="event", allow_full_scan=True,
        ),
    )
    assert rc == 1
    assert err == ""
    assert payload["error"]["type"] == "DataUnavailable"


def test_request_mode_does_not_change_flag_mode_schema(corpus, capsys):
    _, payload, _ = _json(
        capsys, *_args(corpus, "--scope", "event", "--from", "2026-10-31",
                       "--to", "2026-10-31", "--format", "json"),
    )
    assert "ok" not in payload
    assert set(payload) == {
        "schema_version", "query", "counts", "groups", "items", "warnings", "bytes",
    }


def test_default_format_remains_table(corpus, capsys):
    rc, out, err = _run(
        capsys, *_args(corpus, "--scope", "event", "--from", "2026-10-31", "--to", "2026-10-31"),
    )
    assert rc == 0, err
    assert not out.lstrip().startswith("{")
    assert "event" in out
