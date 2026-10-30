#!/usr/bin/env python3
"""Core validation for the append-only claims sidecar."""

from __future__ import annotations

import hashlib
import json
import re
from collections import Counter
from dataclasses import asdict, dataclass
from datetime import date, datetime
from pathlib import Path, PurePosixPath
from typing import Any, Final

CLAIM_ID_PATTERN: Final = re.compile(r"^claim_[0-9a-f]{12}$")
DATE_PATTERN: Final = re.compile(r"^\d{4}-\d{2}-\d{2}$")
STATUS_VALUES: Final = frozenset({"active", "superseded", "disputed", "retired"})
CONFIDENCE_VALUES: Final = frozenset({"certain", "probable", "uncertain"})
FIELD_ORDER: Final = (
    "claim_id", "version", "subject", "predicate", "object", "status",
    "confidence", "valid_from", "source", "supersedes", "projection_targets", "updated_at",
)
SOURCE_FIELDS: Final = ("path", "line", "quote")
DEFAULT_CLAIMS: Final = "ai/memory/claims/claims.jsonl"


@dataclass(frozen=True, slots=True)
class Finding:
    category: str
    message: str
    line: int | None = None
    claim_id: str | None = None


@dataclass(frozen=True, slots=True)
class ParsedClaim:
    line: int
    data: dict[str, Any]


@dataclass(frozen=True, slots=True)
class CheckResult:
    claims: tuple[ParsedClaim, ...]
    findings: tuple[Finding, ...]
    unsourced: int

    def summary(self) -> dict[str, Any]:
        counts = Counter(finding.category for finding in self.findings)
        active = sum(claim.data.get("status") == "active" for claim in self.claims)
        return {
            "ok": not self.findings, "claims": len(self.claims), "active": active,
            "unsourced": self.unsourced, "schema_errors": counts["schema"],
            "duplicate_ids": counts["duplicate"], "cycles": counts["supersede_cycle"],
            "errors": len(self.findings),
            "findings": [asdict(finding) for finding in self.findings],
        }


def derive_claim_id(subject: str, predicate: str, object_: str) -> str:
    material = "\x1f".join((subject, predicate, object_))
    return "claim_" + hashlib.sha256(material.encode("utf-8")).hexdigest()[:12]


def _claim_id_of(claim: ParsedClaim) -> str | None:
    value = claim.data.get("claim_id")
    return value if isinstance(value, str) else None


def _validate_scalars(claim: ParsedClaim) -> list[Finding]:
    row, line = claim.data, claim.line
    claim_id = _claim_id_of(claim)
    findings: list[Finding] = []

    def add(category: str, message: str) -> None:
        findings.append(Finding(category, message, line, claim_id))

    if tuple(row) != FIELD_ORDER:
        missing = [field for field in FIELD_ORDER if field not in row]
        extra = sorted(set(row) - set(FIELD_ORDER))
        detail = f"missing: {', '.join(missing) or 'none'}; extra: {', '.join(extra) or 'none'}"
        add("schema", f"schema fields/order mismatch ({detail})")

    if claim_id is None or not CLAIM_ID_PATTERN.fullmatch(claim_id):
        add("schema", "claim_id must match claim_ + 12 lowercase hex characters")

    version = row.get("version")
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        add("schema", "version must be an integer >= 1")

    values = [row.get(name) for name in ("subject", "predicate", "object")]
    for name, value in zip(("subject", "predicate", "object"), values, strict=True):
        if not isinstance(value, str) or not value.strip():
            add("schema", f"{name} must be a non-empty string")

    if row.get("status") not in STATUS_VALUES:
        add("schema", f"status must be one of {', '.join(sorted(STATUS_VALUES))}")

    if row.get("confidence") not in CONFIDENCE_VALUES:
        add("schema", f"confidence must be one of {', '.join(sorted(CONFIDENCE_VALUES))}")

    valid_from = row.get("valid_from")
    if not isinstance(valid_from, str) or not DATE_PATTERN.fullmatch(valid_from):
        add("schema", "valid_from must be a YYYY-MM-DD date")
    else:
        try:
            date.fromisoformat(valid_from)
        except ValueError:
            add("schema", "valid_from must be a real calendar date")

    updated_at = row.get("updated_at")
    if not isinstance(updated_at, str):
        add("schema", "updated_at must be an ISO-8601 datetime with timezone")
    else:
        try:
            parsed = datetime.fromisoformat(updated_at)
        except ValueError:
            add("schema", "updated_at must be an ISO-8601 datetime with timezone")
        else:
            if parsed.tzinfo is None:
                add("schema", "updated_at must include a timezone offset")

    supersedes = row.get("supersedes")
    if supersedes is not None and (
        not isinstance(supersedes, str) or not CLAIM_ID_PATTERN.fullmatch(supersedes)
    ):
        add("supersede", "supersedes must be null or a claim_id")

    targets = row.get("projection_targets")
    if not isinstance(targets, list) or not all(isinstance(t, str) and t.strip() for t in targets):
        add("schema", "projection_targets must be a list of non-empty strings")

    values_ok = all(isinstance(value, str) and value.strip() for value in values)
    if claim_id is not None and CLAIM_ID_PATTERN.fullmatch(claim_id) and values_ok:
        expected = derive_claim_id(values[0], values[1], values[2])
        if claim_id != expected:
            add("schema", f"claim_id is not deterministic; expected {expected}")

    return findings


def _resolve_source(root: Path, relative: str) -> Path | None:
    if "\\" in relative:
        return None
    pure = PurePosixPath(relative)
    if pure.is_absolute() or ".." in pure.parts:
        return None
    root_path = root.resolve()
    candidate = (root_path / pure).resolve()
    if candidate != root_path and root_path not in candidate.parents:
        return None
    return candidate


def _validate_source(claim: ParsedClaim, root: Path) -> list[Finding]:
    row, line = claim.data, claim.line
    claim_id = _claim_id_of(claim)
    findings: list[Finding] = []

    def add(message: str) -> None:
        findings.append(Finding("source", message, line, claim_id))

    source = row.get("source")
    if not isinstance(source, dict):
        add("source must be an object with path, line, quote")
        return findings
    if tuple(source) != SOURCE_FIELDS:
        add("source fields must be path, line, quote in that order")

    path_value = source.get("path")
    line_value = source.get("line")
    quote_value = source.get("quote")
    if not isinstance(path_value, str) or not path_value.strip():
        add("source.path must be a non-empty repo-relative path")
        path_value = None
    if not isinstance(line_value, int) or isinstance(line_value, bool) or line_value < 1:
        add("source.line must be an integer >= 1")
        line_value = None
    if not isinstance(quote_value, str) or not quote_value.strip():
        add("source.quote must be a non-empty string")
        quote_value = None
    if path_value is None or line_value is None or quote_value is None:
        return findings

    resolved = _resolve_source(root, path_value)
    if resolved is None:
        add(f"source.path must stay inside the repository: {path_value}")
        return findings
    if not resolved.is_file():
        add(f"source.path does not exist: {path_value}")
        return findings

    try:
        text = resolved.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        add(f"source.path cannot be read as UTF-8: {exc}")
        return findings

    lines = text.splitlines()
    if line_value > len(lines):
        add(f"source.line {line_value} is outside {path_value} (1..{len(lines)})")
        return findings
    if "\n" in quote_value or "\r" in quote_value:
        add("source.quote must be a single-line substring")
        return findings

    start = max(0, line_value - 3)
    end = min(len(lines), line_value + 2)
    if not any(quote_value in lines[index] for index in range(start, end)):
        add(f"source.quote not found in {path_value} lines {start + 1}..{end}")

    return findings


def _find_cycles(edges: dict[str, str]) -> list[list[str]]:
    cycles: list[list[str]] = []
    signatures: set[frozenset[str]] = set()
    for start in sorted(edges):
        path: list[str] = []
        current: str | None = start
        while current is not None and current in edges:
            if current in path:
                cycle = path[path.index(current) :]
                signature = frozenset(cycle)
                if signature not in signatures:
                    signatures.add(signature)
                    cycles.append(cycle)
                break
            path.append(current)
            current = edges[current]
    return cycles


def read_claims(path: Path) -> tuple[list[ParsedClaim], list[Finding]]:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return [], [Finding("io", f"cannot read {path}: {exc}")]

    parsed: list[ParsedClaim] = []
    findings: list[Finding] = []
    for number, raw in enumerate(text.splitlines(), 1):
        if not raw.strip():
            continue
        try:
            value = json.loads(raw)
        except json.JSONDecodeError as exc:
            findings.append(Finding("schema", f"invalid JSON: {exc.msg}", number))
            continue
        if not isinstance(value, dict):
            findings.append(Finding("schema", "claim row must be a JSON object", number))
            continue
        parsed.append(ParsedClaim(number, value))
    return parsed, findings


def check_claims(root: Path, claims_path: Path) -> CheckResult:
    parsed, parse_findings = read_claims(claims_path)
    findings = list(parse_findings)
    unsourced = 0

    for claim in parsed:
        findings.extend(_validate_scalars(claim))
        source_findings = _validate_source(claim, root)
        findings.extend(source_findings)
        unsourced += bool(source_findings)

    seen: dict[str, int] = {}
    ids: list[str] = []
    for claim in parsed:
        claim_id = _claim_id_of(claim)
        if claim_id is None:
            continue
        ids.append(claim_id)
        if claim_id in seen:
            message = f"claim_id also appears on line {seen[claim_id]}"
            findings.append(Finding("duplicate", message, claim.line, claim_id))
        else:
            seen[claim_id] = claim.line

    if ids != sorted(ids):
        findings.append(Finding("order", "claims are not sorted by claim_id"))

    all_ids = set(seen)
    edges: dict[str, str] = {}
    for claim in parsed:
        claim_id = _claim_id_of(claim)
        if claim_id is None:
            continue
        supersedes = claim.data.get("supersedes")
        if supersedes is None or not isinstance(supersedes, str):
            continue
        if supersedes not in all_ids:
            message = f"supersedes references missing claim_id {supersedes}"
            findings.append(Finding("supersede", message, claim.line, claim_id))
            continue
        edges[claim_id] = supersedes

    for cycle in _find_cycles(edges):
        path = " -> ".join(cycle + [cycle[0]])
        findings.append(Finding("supersede_cycle", f"supersede cycle: {path}"))

    return CheckResult(tuple(parsed), tuple(findings), unsourced)


def list_active(claims_path: Path) -> list[dict[str, Any]]:
    parsed, _ = read_claims(claims_path)
    return [claim.data for claim in parsed if claim.data.get("status") == "active"]
