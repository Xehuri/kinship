#!/usr/bin/env python3
"""Generate projection candidates from the claims sidecar (dry run only).

Reads ``ai/memory/claims/claims.jsonl`` plus every supported projection source:
``self/必读.md``, ``profile/core-lite.md``, ``topics/INDEX.md`` and each
``profile/semantic/**.md`` file referenced by an active claim. Candidates are
written into an output directory. Sources stay read-only: there is no
``--apply`` mode, and copying a candidate into ``ai/memory/`` is a separate
explicit step.

A present claim is untouched. A missing claim is merged into the existing
predicate line when one exists; otherwise it adds ``- {object}`` under its
heading without deleting prose. Claim ids stay in the sidecar/status, never in
human prose. Claims sort by ``claim_id``; targets
follow ``TARGETS`` order and then semantic sources sorted by path. Unknown
targets or unsupported files warn and skip the whole claim; a missing base
target file fails loudly. Status: ``schema_version``, ``built_at``,
``claims_path``, ``claims_hash``, ``source_hashes``, ``stale``,
``changed_lines``, ``candidate_paths``, ``warnings``.
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import re
import sys
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Sequence

from memory_claims_lib import read_claims

SCHEMA_VERSION = 1
DEFAULT_CLAIMS = "ai/memory/claims/claims.jsonl"
DEFAULT_MEMORY_DIR = "ai/memory"
STATUS_NAME = "projection-status.json"
DIFF_NAME = "diff.patch"
HEADING_RE = re.compile(r"^(#{1,6})\s+(.*?)\s*$")


class ProjectionError(RuntimeError):
    """Raised when a projection run cannot proceed safely."""


@dataclass(frozen=True, slots=True)
class Doc:
    raw: bytes
    text: str
    lines: list[str]
    headings: tuple[tuple[int, str], ...]


TARGETS: tuple[tuple[str, str], ...] = (
    ("self/必读.md", "必读.candidate.md"),
    ("profile/core-lite.md", "core-lite.candidate.md"),
    ("topics/INDEX.md", "INDEX.candidate.md"),
)
BASE_TARGETS = dict(TARGETS)
SEMANTIC_PREFIX = "profile/semantic/"
CANDIDATE_SUFFIX = ".candidate.md"
Pending = dict[str, dict[int, tuple[int, list[tuple[str, str, str]]]]]
Updates = dict[str, dict[int, tuple[str, str, str]]]

PREDICATE_HINTS: dict[str, tuple[str, ...]] = {
    "communication_style": ("说话方式",),
    "deployment_scope": ("系统",),
    "intended_recipient": ("系统",),
    "weekday_wake_window": ("起床锚",),
    "dorm_area": ("住处片区",),
    "night_spo2_pattern": ("SpO2",),
    "source_of_truth": ("cloud.json",),
}
PREDICATE_COVER_TERMS: dict[str, tuple[str, ...]] = {
    "communication_style": ("可爱", "温柔", "表情包"),
    "deployment_scope": ("服务",),
}


def _slug(title: str) -> str:
    kept = "".join(ch for ch in title.strip().lower() if ch.isalnum() or ch in " -_")
    return kept.replace(" ", "-")


def _is_semantic_source(source: str) -> bool:
    if not source.startswith(SEMANTIC_PREFIX) or not source.endswith(".md"):
        return False
    pure = PurePosixPath(source)
    return not pure.is_absolute() and ".." not in pure.parts and "\\" not in source


def _candidate_name(source: str) -> str:
    if source in BASE_TARGETS:
        return BASE_TARGETS[source]
    return source[: -len(".md")] + CANDIDATE_SUFFIX


def _supported_source(source: str) -> bool:
    return source in BASE_TARGETS or _is_semantic_source(source)


def _read_doc(memory_root: Path, source: str) -> Doc:
    path = memory_root / source
    if not path.is_file():
        raise ProjectionError(f"missing target file: {path}")
    raw = path.read_bytes()
    text = raw.decode("utf-8")
    lines = text.splitlines(keepends=True)
    headings = tuple(
        (index, _slug(match.group(2)))
        for index, line in enumerate(lines)
        if (match := HEADING_RE.match(line.rstrip("\r\n")))
    )
    return Doc(raw, text, lines, headings)


def _section(
    lines: Sequence[str], headings: Sequence[tuple[int, str]], slug: str
) -> tuple[int, int] | None:
    for position, (index, heading_slug) in enumerate(headings):
        if heading_slug == slug:
            end = headings[position + 1][0] if position + 1 < len(headings) else len(lines)
            return index + 1, end
    return None


def _compact(text: str) -> str:
    return "".join(
        ch for ch in text if not ch.isspace() and not unicodedata.category(ch).startswith("P")
    )


def _claim_present(claim: dict[str, Any], section: str) -> bool:
    if claim["object"] in section:
        return True
    compact_section = _compact(section)
    if _compact(claim["object"]) in compact_section:
        return True
    source = claim.get("source")
    quote = source.get("quote") if isinstance(source, dict) else None
    return isinstance(quote, str) and bool(quote) and _compact(quote) in compact_section


def _predicate_line(
    lines: Sequence[str], start: int, end: int, predicate: str
) -> int | None:
    hints = PREDICATE_HINTS.get(predicate)
    if not hints:
        return None
    for index in range(start, end):
        line = lines[index]
        if all(hint in line for hint in hints):
            return index
    return None


def _line_covers_predicate(line: str, predicate: str) -> bool:
    terms = PREDICATE_COVER_TERMS.get(predicate)
    return terms is not None and all(term in line for term in terms)


def _insert_block(
    lines: list[str], start: int, end: int, entries: Sequence[tuple[str, str, str]]
) -> list[str]:
    insert_at = end
    while insert_at > start and not lines[insert_at - 1].strip():
        insert_at -= 1
    block = [f"- {object_}\n" for _claim_id, object_, _target in entries]
    prefix: list[str] = []
    if insert_at > 0 and not lines[insert_at - 1].endswith(("\n", "\r")):
        prefix.append("\n")
    if insert_at == start or not lines[insert_at - 1].lstrip().startswith(("- ", "* ", "+ ")):
        prefix.append("\n")
    tail = lines[insert_at:]
    suffix = ["\n"] if tail and tail[0].strip() else []
    return lines[:insert_at] + prefix + block + suffix + tail


def _load_claims(path: Path) -> list[dict[str, Any]]:
    parsed, findings = read_claims(path)
    if findings:
        details = "; ".join(f"{item.category}: {item.message}" for item in findings)
        raise ProjectionError(f"invalid claims file {path}: {details}")
    rows = sorted(
        (claim.data for claim in parsed if claim.data.get("status") == "active"),
        key=lambda row: row["claim_id"],
    )
    ids = [row.get("claim_id") for row in rows]
    if not all(isinstance(item, str) and item for item in ids) or len(ids) != len(set(ids)):
        raise ProjectionError("active claims have a missing or duplicate claim_id")
    for row in rows:
        object_, targets = row.get("object"), row.get("projection_targets")
        if not isinstance(object_, str) or not object_.strip() or "\n" in object_:
            raise ProjectionError(f"claim {row['claim_id']} has an invalid object")
        if not isinstance(targets, list) or not all(
            isinstance(item, str) and item.strip() for item in targets
        ):
            raise ProjectionError(f"claim {row['claim_id']} has invalid projection_targets")
    return rows


def _discover_semantic_sources(claims: Sequence[dict[str, Any]]) -> list[str]:
    discovered: set[str] = set()
    for claim in claims:
        for target in claim["projection_targets"]:
            source, separator, _slug_value = target.rpartition("#")
            if separator and _is_semantic_source(source):
                discovered.add(source)
    return sorted(discovered)


def _unknown_reason(target: str, docs: dict[str, Doc]) -> str:
    source, separator, _slug_value = target.rpartition("#")
    if separator and _is_semantic_source(source) and source not in docs:
        return f"missing projection target file {source} for {target}"
    return f"unknown projection target {target}"


def _plan_claim(
    claim: dict[str, Any], docs: dict[str, Doc], pending: Pending, updates: Updates
) -> list[str]:
    claim_id = claim["claim_id"]
    planned: list[tuple[str, str, int, int]] = []
    unknown: list[str] = []
    for target in dict.fromkeys(claim["projection_targets"]):
        source, separator, slug = target.rpartition("#")
        if not separator or not _supported_source(source) or not slug:
            unknown.append(target)
            continue
        doc = docs.get(source)
        if doc is None:
            unknown.append(target)
            continue
        section = _section(doc.lines, doc.headings, slug)
        if section is None:
            unknown.append(target)
            continue
        planned.append((target, source, section[0], section[1]))
    if unknown:
        return [
            f"claim {claim_id}: {_unknown_reason(target, docs)}; claim skipped"
            for target in unknown
        ]
    for target, source, start, end in planned:
        if _claim_present(claim, "".join(docs[source].lines[start:end])):
            continue
        predicate_line = _predicate_line(
            docs[source].lines, start, end, claim["predicate"]
        )
        if predicate_line is not None:
            if _line_covers_predicate(docs[source].lines[predicate_line], claim["predicate"]):
                continue
            updates[source][predicate_line] = (
                claim_id,
                claim["object"],
                target,
            )
            continue
        bucket = pending[source].setdefault(start, (end, []))[1]
        if not any(entry[0] == claim_id for entry in bucket):
            bucket.append((claim_id, claim["object"], target))
    return []


def _render(
    docs: dict[str, Doc],
    pending: Pending,
    updates: Updates,
    sources: Sequence[str],
) -> tuple[dict[str, str], list[dict[str, str]], int]:
    candidates: dict[str, str] = {}
    stale: list[dict[str, str]] = []
    changed = 0
    for source in sources:
        lines = list(docs[source].lines)
        for index in sorted(updates[source], reverse=True):
            claim_id, object_, target = updates[source][index]
            ending = "\n" if lines[index].endswith(("\n", "\r")) else ""
            lines[index] = f"{lines[index].rstrip(chr(13) + chr(10))}（{object_}）{ending}"
            stale.append({"claim_id": claim_id, "target": target, "object": object_})
            changed += 1
        for start in sorted(pending[source], reverse=True):
            end, entries = pending[source][start]
            lines = _insert_block(lines, start, end, entries)
            stale.extend(
                {"claim_id": claim_id, "target": target, "object": object_}
                for claim_id, object_, target in entries
            )
            changed += len(entries)
        candidates[source] = "".join(lines)
    return candidates, sorted(stale, key=lambda item: (item["claim_id"], item["target"])), changed


def _display_path(root: Path, path: Path) -> str:
    resolved = path.resolve()
    relative = resolved.relative_to(root) if root in resolved.parents else resolved
    return relative.as_posix()


def _normalise_built_at(value: str | None) -> str:
    if value is None:
        return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        raise ProjectionError("--built-at must include a timezone offset")
    return parsed.isoformat()


def _unified_diff(source: str, old: str, new: str) -> str:
    repo_path = f"{DEFAULT_MEMORY_DIR}/{source}"
    text = "".join(
        difflib.unified_diff(
            old.splitlines(keepends=True), new.splitlines(keepends=True),
            fromfile=f"a/{repo_path}", tofile=f"b/{repo_path}",
        )
    )
    return text + ("\n" if text and not text.endswith("\n") else "")


def _resolve(base: Path, value: str | Path) -> Path:
    path = Path(value)
    return path if path.is_absolute() else base / path


def generate(
    root: str | Path,
    claims_path: str | Path,
    out_dir: str | Path,
    built_at: str | None = None,
) -> dict[str, Any]:
    """Build candidates in ``out_dir`` and return the status payload."""
    root_path = Path(root).resolve()
    claims = _resolve(root_path, claims_path)
    out = _resolve(root_path, out_dir)
    memory_root = (root_path / DEFAULT_MEMORY_DIR).resolve()
    resolved_out = out.resolve()
    if resolved_out == memory_root or memory_root in resolved_out.parents:
        raise ProjectionError(f"output directory must stay outside {DEFAULT_MEMORY_DIR}")
    if not claims.is_file():
        raise ProjectionError(f"missing claims file: {claims}")
    claims_raw = claims.read_bytes()
    claims_rows = _load_claims(claims)
    docs = {source: _read_doc(memory_root, source) for source in BASE_TARGETS}
    for source in _discover_semantic_sources(claims_rows):
        if (memory_root / source).is_file():
            docs[source] = _read_doc(memory_root, source)
    sources = list(docs)
    pending: Pending = {source: {} for source in sources}
    updates: Updates = {source: {} for source in sources}
    warnings: list[str] = []
    for claim in claims_rows:
        warnings.extend(_plan_claim(claim, docs, pending, updates))

    candidates, stale, changed_lines = _render(docs, pending, updates, sources)
    diff_text = "".join(
        _unified_diff(source, docs[source].text, candidates[source])
        for source in sources
        if docs[source].text != candidates[source]
    )
    status: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "built_at": _normalise_built_at(built_at),
        "claims_path": _display_path(root_path, claims),
        "claims_hash": hashlib.sha256(claims_raw).hexdigest(),
        "source_hashes": {
            source: hashlib.sha256(docs[source].raw).hexdigest() for source in sources
        },
        "stale": stale,
        "changed_lines": changed_lines,
        "candidate_paths": {source: _candidate_name(source) for source in sources},
        "warnings": warnings,
    }
    out.mkdir(parents=True, exist_ok=True)
    for source in sources:
        candidate = out / _candidate_name(source)
        candidate.parent.mkdir(parents=True, exist_ok=True)
        candidate.write_text(candidates[source], encoding="utf-8", newline="\n")
    (out / STATUS_NAME).write_text(
        json.dumps(status, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n"
    )
    (out / DIFF_NAME).write_text(diff_text, encoding="utf-8", newline="\n")
    return status


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="memory_project.py", description="Generate read-only projection candidates."
    )
    parser.add_argument("--root", default=".", help="repository root")
    parser.add_argument("--claims", default=DEFAULT_CLAIMS, help="claims JSONL path")
    parser.add_argument("--out", required=True, help="output directory for candidates")
    parser.add_argument("--built-at", default=None, help="fixed ISO-8601 timestamp")
    args = parser.parse_args(argv)
    try:
        status = generate(args.root, args.claims, args.out, args.built_at)
    except (ProjectionError, OSError, UnicodeDecodeError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    summary = {
        key: status[key]
        for key in ("changed_lines", "stale", "candidate_paths", "warnings")
    }
    summary["out"] = str(args.out)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
