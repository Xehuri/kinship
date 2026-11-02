#!/usr/bin/env python3
"""Read-only normalized retrieval across the index, memory and chat layers.

Usage:
    python ai/analysis/query.py --scope all --from 2026-10-31 --to 2026-11-01 \
        --grep 修电脑 --format json

Scopes (layer order):
    event -> observation -> report -> evidence -> memory -> chat

`--scope all` covers event, observation, report, memory and chat; evidence is
opt-in because it is the rawest layer and usually duplicates card evidence.
"""

from __future__ import annotations

# allow: SIZE_OK — 任务指定单文件只读统一检索入口；分拆会改变交付路径与 CLI 契约。

import argparse
import hashlib
import json
import re
import sys
from dataclasses import dataclass, field
from datetime import date as date_type
from pathlib import Path
from typing import Any, Sequence

import memory_retrieve
import query_catalog
import query_reports

SCHEMA_VERSION = 1
LAYER_ORDER = ("event", "observation", "report", "evidence", "memory", "chat")
LAYER_PRIORITY = {scope: index for index, scope in enumerate(LAYER_ORDER)}
ALL_SCOPES = ("event", "observation", "report", "memory", "chat")
CARD_KINDS = {
    "event": ("event", "state", "decision"),
    "observation": ("observation", "finding"),
}
BLOCK_SOURCES = ("batch", "legacy", "review")
DEFAULT_BLOCK_SOURCES = frozenset({"batch", "legacy"})
MAX_EVIDENCE_SNIPPET = 800
MAX_REPORT_SNIPPET = 600
MAX_MEMORY_SNIPPET = 1200
MAX_CHAT_TITLE = 120
ELLIPSIS = "…"
TIME_HEADING_RE = re.compile(r"^(\d{2}:\d{2})")


class UsageError(Exception):
    """Bad CLI arguments or conflicting filters (exit 2)."""


class DataUnavailable(Exception):
    """A requested data layer is missing or unreachable (exit 1)."""


@dataclass
class Hit:
    scope: str
    type: str
    id: str
    title: str
    snippet: str
    date: str | None
    timestamp: str | None
    meta: dict[str, Any]
    evidence: list[dict[str, Any]] = field(default_factory=list)
    relations: list[dict[str, Any]] = field(default_factory=list)
    dedupe_keys: tuple[str, ...] = ()
    text_sha256: str = ""
    related_ids: list[str] = field(default_factory=list)
    text_tier: int = 3
    score: float = 0.0

    @property
    def layer_priority(self) -> int:
        return LAYER_PRIORITY[self.scope]

    @property
    def dedupe_key(self) -> str:
        return self.dedupe_keys[0] if self.dedupe_keys else f"{self.scope}:{self.id}"

    def payload(self) -> dict[str, Any]:
        return {
            "scope": self.scope,
            "type": self.type,
            "id": self.id,
            "title": self.title,
            "snippet": self.snippet,
            "date": self.date,
            "timestamp": self.timestamp,
            "rank": {
                "text_tier": self.text_tier,
                "layer_priority": self.layer_priority,
                "date_key": self.date or "",
                "score": round(self.score, 6),
            },
            "meta": self.meta,
            "evidence": self.evidence,
            "relations": self.relations,
            "dedupe_key": self.dedupe_key,
            "related_ids": list(self.related_ids),
        }


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _clip_utf8(text: str, limit: int) -> tuple[str, bool]:
    raw = text.encode("utf-8")
    if len(raw) <= limit:
        return text, False
    room = limit - len(ELLIPSIS.encode("utf-8"))
    if room <= 0:
        return "", True
    return raw[:room].decode("utf-8", "ignore") + ELLIPSIS, True


def _date_ordinal(value: str | None) -> int:
    if not value or len(value) < 10:
        return 0
    try:
        return date_type.fromisoformat(value[:10]).toordinal()
    except ValueError:
        return 0


def _valid_date(value: str) -> bool:
    try:
        date_type.fromisoformat(value)
    except ValueError:
        return False
    return len(value) == 10


def _in_range(value: str | None, start: str | None, end: str | None) -> bool:
    if start is None and end is None:
        return True
    if not value:
        return False
    day = value[:10]
    if start is not None and day < start:
        return False
    if end is not None and day > end:
        return False
    return True


def _block_timestamp(block: dict) -> str | None:
    day = block.get("date")
    if not day:
        return None
    match = TIME_HEADING_RE.match(str(block.get("heading") or ""))
    return f"{day}T{match.group(1)}" if match else str(day)


def _report_snippet(root: Path, row: dict, grep: str | None) -> str:
    title = str(row.get("title") or row.get("report_id") or "")
    if not grep:
        return title
    source = query_reports.resolve_source(root, str(row.get("file") or ""))
    if source is None:
        return title
    try:
        text = source.read_text(encoding="utf-8")
    except OSError:
        return title
    position = text.find(grep)
    if position < 0:
        return title
    start = max(0, position - 120)
    return _clip_utf8(text[start:position + MAX_REPORT_SNIPPET], MAX_REPORT_SNIPPET)[0]


def _source_text(root: Path, relative: str) -> str:
    source = query_reports.resolve_source(root, relative)
    if source is None:
        return ""
    try:
        return source.read_text(encoding="utf-8")
    except OSError:
        return ""


def _evidence_refs(card_id: str, card_blocks: list[dict], blocks: dict[str, dict],
                   root: Path, resolve: bool) -> list[dict[str, Any]]:
    refs: list[dict[str, Any]] = []
    for ref in card_blocks:
        if ref.get("card_id") != card_id:
            continue
        block = blocks.get(str(ref.get("block_id") or ""))
        if block is None:
            refs.append({"block_id": ref.get("block_id"), "broken": True})
            continue
        item: dict[str, Any] = {
            "block_id": block.get("block_id"),
            "file": block.get("file"),
            "line_start": block.get("line_start"),
            "line_end": block.get("line_end"),
            "text_sha256": block.get("text_sha256"),
            "role": ref.get("role"),
        }
        if resolve:
            excerpt = query_catalog.excerpt_for(root, block)
            if excerpt is None:
                item["broken"] = True
            else:
                item["excerpt"] = excerpt
        refs.append(item)
    return refs


def _report_refs(row: dict, blocks: dict[str, dict], root: Path,
                 resolve: bool) -> list[dict[str, Any]]:
    refs: list[dict[str, Any]] = []
    for block_id in row.get("block_ids") or []:
        block = blocks.get(str(block_id))
        if block is None:
            refs.append({"block_id": block_id, "broken": True})
            continue
        item: dict[str, Any] = {
            "block_id": block_id,
            "file": block.get("file"),
            "line_start": block.get("line_start"),
            "line_end": block.get("line_end"),
            "text_sha256": block.get("text_sha256"),
        }
        if resolve:
            excerpt = query_catalog.excerpt_for(root, block)
            if excerpt is None:
                item["broken"] = True
            else:
                item["excerpt"] = excerpt
        refs.append(item)
    return refs


def _rank(hit: Hit, grep: str | None) -> Hit:
    if not grep:
        hit.text_tier = 3
        hit.score = 0.0
        return hit
    title_hits = hit.title.count(grep)
    snippet_hits = hit.snippet.count(grep)
    meta_hits = json.dumps(hit.meta, ensure_ascii=False).count(grep)
    if title_hits:
        hit.text_tier = 0
    elif snippet_hits:
        hit.text_tier = 1
    elif meta_hits:
        hit.text_tier = 2
    else:
        hit.text_tier = 3
    hit.score = float(title_hits * 2 + snippet_hits + meta_hits)
    return hit


def _parse_slots(items: Sequence[str]) -> dict[str, str]:
    slots: dict[str, str] = {}
    for item in items:
        if "=" not in item:
            raise UsageError(f"bad --slot: {item} (expected KEY=VALUE)")
        key, value = item.split("=", 1)
        if not key:
            raise UsageError(f"bad --slot: {item} (empty key)")
        slots[key] = value
    return slots


def _parse_block_sources(value: str | None) -> frozenset[str]:
    if value is None:
        return DEFAULT_BLOCK_SOURCES
    parts = [part.strip() for part in value.split(",") if part.strip()]
    if not parts:
        raise UsageError("--block-source requires batch, legacy, review or all")
    if parts == ["all"]:
        return frozenset(BLOCK_SOURCES)
    unknown = [part for part in parts if part not in BLOCK_SOURCES]
    if unknown:
        raise UsageError(f"bad --block-source: {', '.join(unknown)}")
    return frozenset(parts)


def _load_tables(index_dir: Path) -> dict[str, Any]:
    if not index_dir.is_dir():
        raise DataUnavailable(f"index directory unavailable: {index_dir}")
    blocks = {
        str(row["block_id"]): row
        for row in query_catalog.load_jsonl(index_dir / "blocks.jsonl")
        if row.get("block_id")
    }
    return {
        "concepts": query_catalog.load_jsonl(index_dir / "concept_types.jsonl"),
        "blocks": blocks,
        "cards": query_catalog.load_jsonl(index_dir / "cards.jsonl"),
        "card_concepts": query_catalog.load_jsonl(index_dir / "card_concepts.jsonl"),
        "card_blocks": query_catalog.load_jsonl(index_dir / "card_blocks.jsonl"),
        "card_relations": query_catalog.load_jsonl(index_dir / "card_relations.jsonl"),
        "reports": query_catalog.load_jsonl(index_dir / "reports.jsonl"),
        "report_relations": query_catalog.load_jsonl(index_dir / "report_relations.jsonl"),
    }


def _concept_leaf_ids(concept: str | None, tables: dict[str, Any]) -> set[str] | None:
    if concept is None:
        return None
    leaves = query_catalog.descendant_leaves(concept, tables["concepts"])
    if not leaves:
        raise UsageError(f"unknown concept: {concept}")
    return leaves


def _card_hits(scope: str, args: argparse.Namespace, tables: dict[str, Any],
               leaves: set[str] | None) -> list[Hit]:
    hits: list[Hit] = []
    kinds = CARD_KINDS[scope]
    for card in tables["cards"]:
        card_id = str(card.get("card_id") or "")
        if not card_id or card.get("kind") not in kinds:
            continue
        if args.kind is not None and card.get("kind") != args.kind:
            continue
        if leaves is not None:
            concept_ids = {
                row.get("concept_id")
                for row in tables["card_concepts"]
                if row.get("card_id") == card_id
            }
            if not (concept_ids & leaves):
                continue
        if not query_catalog.range_matches(card, args.start, args.end):
            continue
        slots = card.get("slots") if isinstance(card.get("slots"), dict) else {}
        if any(str(slots.get(key)) != value for key, value in args.wanted_slots.items()):
            continue
        if args.grep is not None:
            haystack = "\n".join([
                str(card.get("title") or ""),
                str(card.get("statement") or ""),
                query_catalog.block_text(card_id, tables["card_blocks"], tables["blocks"]),
            ])
            if args.grep not in haystack:
                continue
        card_start, _ = query_catalog.card_range(card)
        statement = str(card.get("statement") or "")
        timestamp = None
        if card_start:
            timestamp = (
                f"{card_start}T{card['time']}" if card.get("time") else card_start
            )
        concept_ids = sorted({
            str(row.get("concept_id"))
            for row in tables["card_concepts"]
            if row.get("card_id") == card_id
        })
        relations = []
        if args.follow:
            relations = [
                row for row in tables["card_relations"]
                if row.get("from_card") == card_id or row.get("to_card") == card_id
            ]
        hit = Hit(
            scope=scope,
            type=str(card.get("kind") or ""),
            id=card_id,
            title=str(card.get("title") or ""),
            snippet=statement or str(card.get("title") or ""),
            date=card_start,
            timestamp=timestamp,
            meta={
                "kind": card.get("kind"),
                "confidence": card.get("confidence"),
                "status": card.get("status"),
                "slots": slots,
                "period_start": card.get("period_start"),
                "period_end": card.get("period_end"),
                "time": card.get("time"),
                "end_time": card.get("end_time"),
                "concepts": concept_ids,
            },
            evidence=_evidence_refs(
                card_id, tables["card_blocks"], tables["blocks"], args.root, args.resolve,
            ),
            relations=relations,
            dedupe_keys=(f"card:{card_id}",),
            text_sha256=_sha256(statement or str(card.get("title") or card_id)),
        )
        hits.append(_rank(hit, args.grep))
    return hits


def _report_hits(args: argparse.Namespace, tables: dict[str, Any]) -> list[Hit]:
    hits: list[Hit] = []
    for row in tables["reports"]:
        report_id = str(row.get("report_id") or "")
        if not report_id:
            continue
        if args.report_type is not None and row.get("report_type") != args.report_type:
            continue
        if args.report_layer is not None and row.get("layer") != args.report_layer:
            continue
        if not query_reports.overlaps(row, args.start, args.end):
            continue
        if args.grep is not None:
            haystack = "\n".join([
                str(row.get("report_id") or ""),
                str(row.get("title") or ""),
                str(row.get("file") or ""),
                _source_text(args.root, str(row.get("file") or "")),
            ])
            if args.grep not in haystack:
                continue
        period_start = str(row.get("period_start") or "") or None
        relations = []
        if args.follow:
            relations = [
                rel for rel in tables["report_relations"]
                if rel.get("from_report") == report_id
            ]
        hit = Hit(
            scope="report",
            type=str(row.get("report_type") or ""),
            id=report_id,
            title=str(row.get("title") or report_id),
            snippet=_report_snippet(args.root, row, args.grep),
            date=period_start,
            timestamp=period_start,
            meta={
                "report_type": row.get("report_type"),
                "layer": row.get("layer"),
                "period_start": row.get("period_start"),
                "period_end": row.get("period_end"),
                "file": row.get("file"),
                "line_count": row.get("line_count"),
                "block_count": len(row.get("block_ids") or []),
                "card_count": len(row.get("card_ids") or []),
                "status": row.get("status"),
            },
            evidence=_report_refs(row, tables["blocks"], args.root, args.resolve),
            relations=relations,
            dedupe_keys=(f"report:{report_id}",),
            text_sha256=str(row.get("text_sha256") or _sha256(report_id)),
        )
        hits.append(_rank(hit, args.grep))
    return hits


def _evidence_hits(args: argparse.Namespace, tables: dict[str, Any]) -> list[Hit]:
    hits: list[Hit] = []
    for block in tables["blocks"].values():
        block_id = str(block.get("block_id") or "")
        if not block_id:
            continue
        source_type = str(block.get("source_type") or "")
        if source_type not in args.block_sources:
            continue
        if not _in_range(block.get("date"), args.start, args.end):
            continue
        text = str(block.get("text") or "")
        if args.grep is not None:
            haystack = "\n".join([
                str(block.get("heading") or ""),
                str(block.get("file") or ""),
                text,
            ])
            if args.grep not in haystack:
                continue
        snippet, _ = _clip_utf8(text, MAX_EVIDENCE_SNIPPET)
        digest = str(block.get("text_sha256") or _sha256(text))
        location = (
            f"{block.get('file')}:{block.get('line_start')}:"
            f"{block.get('line_end')}:{digest}"
        )
        hit = Hit(
            scope="evidence",
            type=source_type,
            id=block_id,
            title=str(block.get("heading") or f"{block.get('file')}:{block.get('line_start')}"),
            snippet=snippet,
            date=str(block.get("date") or "") or None,
            timestamp=_block_timestamp(block),
            meta={
                "source_type": block.get("source_type"),
                "source_kind": block.get("source_kind"),
                "file": block.get("file"),
                "line_start": block.get("line_start"),
                "line_end": block.get("line_end"),
                "text_sha256": digest,
                "heading": block.get("heading"),
                "status": block.get("status"),
            },
            dedupe_keys=(f"evidence:{block_id}", f"evidence-loc:{location}"),
            text_sha256=digest,
        )
        hits.append(_rank(hit, args.grep))
    return hits


def _memory_hits(args: argparse.Namespace) -> list[Hit]:
    memory_root = args.root / "memory"
    if not memory_root.is_dir():
        raise DataUnavailable(f"memory directory unavailable: {memory_root}")
    if (args.start or args.end) and not args.include_undated_memory:
        return []
    max_items = (
        args.limit_per_scope if args.limit_per_scope is not None
        else (args.limit if args.limit is not None else 12)
    )
    budget = args.budget if args.budget is not None else 6000
    try:
        result = memory_retrieve.retrieve(
            str(memory_root), args.grep or "", budget=max(budget, 0),
            max_items=max(max_items, 1), context=1,
        )
    except memory_retrieve.RetrieveError as exc:
        raise DataUnavailable(f"memory retrieval failed: {exc}") from exc
    hits: list[Hit] = []
    for entry in result.get("items") or []:
        path = str(entry.get("path") or "")
        line = int(entry.get("line") or 0)
        text = str(entry.get("text") or "")
        digest = _sha256(text)
        snippet, _ = _clip_utf8(text, MAX_MEMORY_SNIPPET)
        hit = Hit(
            scope="memory",
            type="memory",
            id=f"{path}:{line}",
            title=str(entry.get("heading") or path),
            snippet=snippet,
            date=None,
            timestamp=None,
            meta={
                "path": path,
                "line": line,
                "heading": entry.get("heading"),
                "score": entry.get("score"),
            },
            dedupe_keys=(f"memory:{path}:{line}:{digest}",),
            text_sha256=digest,
        )
        hits.append(_rank(hit, args.grep))
    return hits


def _chatlog_module() -> Any:
    # Lazy import: query_chatlog 在 import 期只算路径，但其 main 会写缓存/存档。
    import query_chatlog

    return query_chatlog


def _chat_window(args: argparse.Namespace) -> tuple[str, str]:
    if args.start or args.end:
        first = args.start or args.end
        last = args.end or args.start
        return f"{first} 00:00:00", f"{last} 23:59:59"
    if args.grep:
        day = args.as_of or date_type.today().isoformat()
        return f"{day} 00:00:00", f"{day} 23:59:59"
    raise UsageError("chat scope requires --from/--to or --grep")


def _chat_hits(args: argparse.Namespace) -> list[Hit]:
    start, end = _chat_window(args)
    module = _chatlog_module()
    port = args.backend_port or module._probe_port()
    if not port:
        raise DataUnavailable("chat backend unavailable: no port")
    try:
        token = module._load_token()
    except SystemExit as exc:
        raise DataUnavailable(f"chat auth unavailable: {exc}") from exc
    except (OSError, ValueError, KeyError) as exc:
        raise DataUnavailable(f"chat auth unavailable: {exc}") from exc
    params = {"start": start, "end": end, "format": "json"}
    if args.include_children:
        params["include_children"] = "true"
    status, body = module._query_chatlog(port, token, params)
    if status is None:
        raise DataUnavailable(f"chat backend unavailable: {body}")
    if status != 200:
        raise DataUnavailable(f"chat backend HTTP {status}: {str(body)[:200]}")
    try:
        data = json.loads(body)
    except json.JSONDecodeError as exc:
        raise DataUnavailable(f"chat backend returned invalid JSON: {exc}") from exc
    session_id = str(data.get("session_id") or "")
    hits: list[Hit] = []
    for turn in data.get("turns") or []:
        if not isinstance(turn, dict):
            continue
        content = str(turn.get("content") or "")
        tools = turn.get("tools") or []
        if args.grep is not None:
            haystack = "\n".join([content, "\n".join(str(tool) for tool in tools)])
            if args.grep not in haystack:
                continue
        message_id = str(turn.get("id") or "")
        turn_session = str(turn.get("session_id") or session_id)
        time_str = str(turn.get("time_str") or "")
        day = time_str[:10] if len(time_str) >= 10 else None
        timestamp = time_str.replace(" ", "T") if time_str else None
        title, _ = _clip_utf8(content.splitlines()[0] if content else "", MAX_CHAT_TITLE)
        hit = Hit(
            scope="chat",
            type=str(turn.get("role") or "chat"),
            id=message_id or f"{turn_session}:{_sha256(content)[:12]}",
            title=title,
            snippet=content,
            date=day,
            timestamp=timestamp,
            meta={
                "session_id": turn_session,
                "role": turn.get("role"),
                "time_ms": turn.get("time_ms"),
                "tools": tools or None,
            },
            dedupe_keys=(
                f"chat:{turn_session}:{message_id}"
                if message_id else f"chat:{turn_session}:{_sha256(content)}",
            ),
            text_sha256=_sha256(content),
        )
        hits.append(_rank(hit, args.grep))
    return hits


def _sort_hits(hits: list[Hit], order: str, descending: bool) -> list[Hit]:
    if order == "relevance":
        return sorted(
            hits,
            key=lambda hit: (
                hit.text_tier,
                hit.layer_priority,
                -_date_ordinal(hit.date),
                hit.id,
            ),
        )
    dated = [hit for hit in hits if hit.timestamp or hit.date]
    undated = [hit for hit in hits if not (hit.timestamp or hit.date)]
    dated.sort(key=lambda hit: (hit.timestamp or hit.date or "", hit.id), reverse=descending)
    return dated + undated


def _dedupe(hits_by_scope: dict[str, list[Hit]]) -> tuple[list[Hit], int]:
    seen_keys: dict[str, Hit] = {}
    seen_hashes: dict[str, Hit] = {}
    kept: list[Hit] = []
    dropped = 0
    for scope in LAYER_ORDER:
        for hit in hits_by_scope.get(scope, []):
            duplicate = next(
                (seen_keys[key] for key in hit.dedupe_keys if key in seen_keys), None,
            )
            if duplicate is not None:
                dropped += 1
                continue
            previous = seen_hashes.get(hit.text_sha256) if hit.text_sha256 else None
            if previous is not None and previous.scope != hit.scope:
                previous.related_ids.append(hit.id)
                dropped += 1
                continue
            if hit.text_sha256:
                seen_hashes.setdefault(hit.text_sha256, hit)
            for key in hit.dedupe_keys:
                seen_keys[key] = hit
            kept.append(hit)
    return kept, dropped


def _round_robin(queues: dict[str, list[Hit]], limit: int | None) -> list[Hit]:
    selected: list[Hit] = []
    while limit is None or len(selected) < limit:
        progressed = False
        for scope in LAYER_ORDER:
            if limit is not None and len(selected) >= limit:
                break
            queue = queues.get(scope) or []
            if queue:
                selected.append(queue.pop(0))
                progressed = True
        if not progressed:
            break
    return selected


def _item_bytes(item: dict[str, Any]) -> int:
    return len(json.dumps(item, ensure_ascii=False).encode("utf-8"))


def _fit_budget(items: list[Hit], budget: int) -> tuple[list[dict[str, Any]], int, int, int]:
    payloads: list[dict[str, Any]] = []
    used = 0
    omitted = 0
    truncated = 0
    for hit in items:
        item = hit.payload()
        cost = _item_bytes(item)
        if used + cost <= budget:
            payloads.append(item)
            used += cost
            continue
        remaining = budget - used
        overhead = _item_bytes({**item, "snippet": ""})
        room = remaining - overhead - len(ELLIPSIS.encode("utf-8"))
        if room <= 0:
            omitted += 1
            continue
        snippet, clipped = _clip_utf8(item["snippet"], room)
        if not clipped or not snippet:
            omitted += 1
            continue
        item["snippet"] = snippet
        cost = _item_bytes(item)
        if used + cost > budget:
            omitted += 1
            continue
        payloads.append(item)
        used += cost
        truncated += 1
    return payloads, used, omitted, truncated


def _group_payloads(payloads: list[dict[str, Any]],
                    group_by: str) -> list[tuple[str | None, list[dict[str, Any]]]]:
    if group_by == "none":
        return [(None, payloads)]
    if group_by == "layer":
        groups: list[tuple[str | None, list[dict[str, Any]]]] = []
        for scope in LAYER_ORDER:
            members = [item for item in payloads if item["scope"] == scope]
            if members:
                groups.append((scope, members))
        return groups
    dates = sorted({str(item.get("date") or "") for item in payloads})
    ordered_dates = [day for day in reversed(dates) if day]
    if "" in dates:
        ordered_dates.append("")
    groups = []
    for day in ordered_dates:
        members = [item for item in payloads if str(item.get("date") or "") == day]
        members.sort(key=lambda item: (item.get("timestamp") or item.get("date") or "", item["id"]),
                     reverse=True)
        members.sort(key=lambda item: item["rank"]["layer_priority"])
        groups.append((day or "(undated)", members))
    return groups


def _render_table(groups: list[tuple[str | None, list[dict[str, Any]]]],
                  resolve: bool, follow: bool) -> None:
    for key, members in groups:
        if key is not None:
            print(f"## {key} ({len(members)})")
        for item in members:
            timestamp = item.get("timestamp") or item.get("date") or ""
            print(f"{item['id']} | {timestamp} | {item['type']} | {item['title']}")
            for ref in item.get("evidence") or []:
                if ref.get("broken"):
                    print(f"  -> {ref.get('block_id')} BROKEN")
                    continue
                print(
                    f"  -> {ref.get('block_id')} {ref.get('file')}:"
                    f"{ref.get('line_start')}-{ref.get('line_end')}"
                )
                if resolve and ref.get("excerpt"):
                    print("     " + ref["excerpt"].replace("\n", "\n     "))
            if resolve and item["scope"] == "evidence":
                meta = item["meta"]
                print(f"  -> {meta.get('file')}:{meta.get('line_start')}-{meta.get('line_end')}")
                print("     " + item["snippet"].replace("\n", "\n     "))
            elif resolve and item["scope"] == "memory":
                meta = item["meta"]
                print(f"  -> {meta.get('path')}:{meta.get('line')}")
                print("     " + item["snippet"].replace("\n", "\n     "))
            elif resolve and item["scope"] == "chat":
                print(f"  -> session {item['meta'].get('session_id')}")
            if follow:
                for relation in item.get("relations") or []:
                    if "from_report" in relation:
                        source = relation.get("from_report")
                        target = relation.get("to_report") or relation.get("to_card")
                    else:
                        source = relation.get("from_card")
                        target = relation.get("to_card")
                    print(f"  rel: {source} --{relation.get('relation')}--> {target}")


def _expand_scopes(values: Sequence[str]) -> list[str]:
    requested = set(values)
    expanded = set(ALL_SCOPES) if "all" in requested else set()
    expanded.update(scope for scope in requested if scope != "all")
    return [scope for scope in LAYER_ORDER if scope in expanded]


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Read-only normalized retrieval across index/memory/chat layers.")
    parser.add_argument("--root", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--index-dir", default=None)
    parser.add_argument(
        "--scope", action="append", choices=(*LAYER_ORDER, "all"), default=None,
        help="repeatable; default all",
    )
    parser.add_argument("--from", dest="start", default=None, help="YYYY-MM-DD (inclusive)")
    parser.add_argument("--to", dest="end", default=None, help="YYYY-MM-DD (inclusive)")
    parser.add_argument("--grep", default=None)
    parser.add_argument("--concept", default=None, help="parent concept expands to leaves")
    parser.add_argument("--kind", default=None)
    parser.add_argument("--slot", action="append", default=[], help="KEY=VALUE, repeatable")
    parser.add_argument("--report-type", default=None)
    parser.add_argument("--report-layer", default=None)
    parser.add_argument("--order", choices=("chrono", "relevance"), default=None)
    parser.add_argument("--asc", action="store_true")
    parser.add_argument("--desc", action="store_true")
    parser.add_argument("--group-by", choices=("layer", "date", "none"), default=None)
    parser.add_argument("--limit", type=int, default=50)
    parser.add_argument("--limit-per-scope", type=int, default=None)
    parser.add_argument("--budget", type=int, default=20000, help="UTF-8 byte budget")
    parser.add_argument("--resolve", action="store_true")
    parser.add_argument("--follow", action="store_true")
    parser.add_argument("--include-linked-evidence", action="store_true")
    parser.add_argument("--include-undated-memory", action="store_true")
    parser.add_argument("--block-source", default=None, help="batch,legacy | review | all")
    parser.add_argument("--include-children", action="store_true")
    parser.add_argument("--backend-port", type=int, default=None)
    parser.add_argument("--as-of", default=None, help="YYYY-MM-DD anchor for chat windows")
    parser.add_argument("--allow-full-scan", action="store_true")
    parser.add_argument("--format", choices=("table", "json"), default="table")
    return parser


def _validate_args(args: argparse.Namespace, requested: Sequence[str]) -> bool:
    for label, value in (("--from", args.start), ("--to", args.end), ("--as-of", args.as_of)):
        if value is not None and not _valid_date(value):
            raise UsageError(f"{label} must be YYYY-MM-DD: {value}")
    if args.start and args.end and args.start > args.end:
        raise UsageError("--from must be <= --to")
    if args.asc and args.desc:
        raise UsageError("--asc and --desc are mutually exclusive")
    if args.grep is not None and not args.grep.strip():
        raise UsageError("--grep must not be empty")
    if args.limit is not None and args.limit < 0:
        raise UsageError("--limit must be >= 0")
    if args.limit_per_scope is not None and args.limit_per_scope < 0:
        raise UsageError("--limit-per-scope must be >= 0")
    if args.budget is not None and args.budget < 0:
        raise UsageError("--budget must be >= 0")
    order = args.order or ("relevance" if args.grep else "chrono")
    if order == "relevance" and args.asc:
        raise UsageError("--order relevance conflicts with --asc")
    has_filter = any((
        args.start, args.end, args.grep, args.concept, args.kind,
        args.report_type, args.report_layer, args.slot, args.block_source,
        args.as_of,
    ))
    if not has_filter and not args.allow_full_scan:
        raise UsageError("refusing a full scan; add a filter or --allow-full-scan")
    all_mode = "all" in requested
    if "memory" in requested and not args.grep and not all_mode:
        raise UsageError("memory scope requires --grep")
    if "chat" in requested and not (args.start or args.end or args.grep) and not all_mode:
        raise UsageError("chat scope requires --from/--to or --grep")
    return all_mode


def _run(args: argparse.Namespace, requested: Sequence[str]) -> int:
    all_mode = _validate_args(args, requested)
    args.root = Path(args.root).resolve()
    index_dir = Path(args.index_dir).resolve() if args.index_dir else args.root / "data" / "index"
    args.wanted_slots = _parse_slots(args.slot)
    args.block_sources = _parse_block_sources(args.block_source)
    args.grep = args.grep.strip() if isinstance(args.grep, str) else args.grep
    order = args.order or ("relevance" if args.grep else "chrono")
    descending = not args.asc
    scopes = _expand_scopes(requested)
    warnings: list[str] = []

    if "memory" in scopes and not args.grep:
        if all_mode:
            scopes.remove("memory")
            warnings.append("memory skipped: --grep is required")
        else:
            raise UsageError("memory scope requires --grep")
    if "chat" in scopes and not (args.start or args.end or args.grep):
        if all_mode:
            scopes.remove("chat")
            warnings.append("chat skipped: --from/--to or --grep is required")
        else:
            raise UsageError("chat scope requires --from/--to or --grep")

    group_by = args.group_by or ("layer" if len(scopes) > 1 else "none")
    tables: dict[str, Any] | None = None
    index_scopes = {"event", "observation", "report", "evidence"}
    if index_scopes & set(scopes):
        tables = _load_tables(index_dir)

    leaves = _concept_leaf_ids(args.concept, tables) if tables is not None else None
    hits_by_scope: dict[str, list[Hit]] = {}
    attempted: set[str] = set()
    failed: set[str] = set()
    for scope in scopes:
        attempted.add(scope)
        try:
            if scope in CARD_KINDS:
                hits_by_scope[scope] = _card_hits(scope, args, tables, leaves)
            elif scope == "report":
                hits_by_scope[scope] = _report_hits(args, tables)
            elif scope == "evidence":
                hits_by_scope[scope] = _evidence_hits(args, tables)
            elif scope == "memory":
                hits_by_scope[scope] = _memory_hits(args)
            elif scope == "chat":
                hits_by_scope[scope] = _chat_hits(args)
        except DataUnavailable as exc:
            if not all_mode:
                raise
            failed.add(scope)
            warnings.append(f"{scope} unavailable: {exc}")
    if all_mode and attempted and attempted == failed:
        raise DataUnavailable("all requested layers are unavailable")

    candidates = sum(len(hits) for hits in hits_by_scope.values())
    for scope in hits_by_scope:
        hits_by_scope[scope] = _sort_hits(hits_by_scope[scope], order, descending)

    kept, deduped = _dedupe(hits_by_scope)
    queues: dict[str, list[Hit]] = {}
    for scope in LAYER_ORDER:
        scoped = [hit for hit in kept if hit.scope == scope]
        if args.limit_per_scope is not None:
            scoped = scoped[:args.limit_per_scope]
        queues[scope] = list(scoped)
    selected = _round_robin(queues, args.limit)
    omitted_by_limit = len(kept) - len(selected)
    if not args.include_linked_evidence and any(
        hit.scope == "evidence" for hit in selected
    ):
        cited = {
            str(ref.get("block_id"))
            for hit in selected
            if hit.scope in ("event", "observation")
            for ref in hit.evidence
            if ref.get("block_id")
        }
        retained = [
            hit for hit in selected
            if not (hit.scope == "evidence" and hit.id in cited)
        ]
        deduped += len(selected) - len(retained)
        selected = retained
    payload_items, used_bytes, omitted_by_budget, truncated = _fit_budget(
        selected, args.budget if args.budget is not None else 0,
    )

    groups = _group_payloads(payload_items, group_by)
    ordered_items = [item for _, members in groups for item in members]

    by_scope: dict[str, int] = {}
    for item in ordered_items:
        by_scope[item["scope"]] = by_scope.get(item["scope"], 0) + 1

    payload: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "query": {
            "scopes": scopes,
            "from": args.start,
            "to": args.end,
            "grep": args.grep,
            "concept": args.concept,
            "kind": args.kind,
            "slots": args.wanted_slots,
            "report_type": args.report_type,
            "report_layer": args.report_layer,
            "block_source": sorted(args.block_sources) if "evidence" in scopes else None,
            "order": order,
            "ascending": not descending,
            "group_by": group_by,
            "limit": args.limit,
            "limit_per_scope": args.limit_per_scope,
            "budget": args.budget,
            "as_of": args.as_of,
        },
        "counts": {
            "total": candidates,
            "returned": len(ordered_items),
            "by_scope": by_scope,
            "deduped": deduped,
            "omitted_by_limit": omitted_by_limit,
            "omitted_by_budget": omitted_by_budget,
            "truncated": truncated,
        },
        "groups": [
            {"key": key, "count": len(members), "ids": [item["id"] for item in members]}
            for key, members in groups
            if key is not None
        ],
        "items": ordered_items,
        "warnings": warnings,
        "bytes": used_bytes,
    }

    if args.format == "json":
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0
    _render_table(groups, args.resolve, args.follow)
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    requested = tuple(args.scope or ("all",))
    try:
        return _run(args, requested)
    except UsageError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except DataUnavailable as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
