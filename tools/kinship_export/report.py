"""Machine-readable summaries for the Kinship export gate.

The report is deliberately lossy: it records a path, a scanner category, and a
count. It never records the bytes that matched a category, so a report can be
attached to an issue without leaking the finding itself.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from typing import Literal

Command = Literal["export", "verify"]


@dataclass(frozen=True, slots=True)
class ScanHit:
    """One scanner category observed in one file."""

    path: str
    category: str
    count: int


@dataclass(frozen=True, slots=True)
class Violation:
    """A path-level reason that makes the gate fail."""

    path: str
    reason: str


@dataclass(frozen=True, slots=True)
class GateReport:
    """Result of an export or verify run."""

    command: Command
    ok: bool
    source: str
    dest: str
    dry_run: bool = False
    files_examined: int = 0
    allowed_files: int = 0
    denied_files: int = 0
    exported_files: int = 0
    bytes_written: int = 0
    allowed_by_top_level: tuple[tuple[str, int], ...] = ()
    denied_by_top_level: tuple[tuple[str, int], ...] = ()
    scanner_hits: tuple[ScanHit, ...] = ()
    violations: tuple[Violation, ...] = ()
    errors: tuple[str, ...] = ()

    def scanner_totals(self) -> dict[str, int]:
        totals: dict[str, int] = {}
        for hit in self.scanner_hits:
            totals[hit.category] = totals.get(hit.category, 0) + hit.count
        return dict(sorted(totals.items()))

    def as_dict(self) -> dict[str, object]:
        return {
            "schema_version": 1,
            "command": self.command,
            "ok": self.ok,
            "source": self.source,
            "dest": self.dest,
            "dry_run": self.dry_run,
            "files_examined": self.files_examined,
            "allowed_files": self.allowed_files,
            "denied_files": self.denied_files,
            "exported_files": self.exported_files,
            "bytes_written": self.bytes_written,
            "allowed_by_top_level": dict(self.allowed_by_top_level),
            "denied_by_top_level": dict(self.denied_by_top_level),
            "scanner_hits": [
                asdict(hit)
                for hit in sorted(self.scanner_hits, key=lambda hit: (hit.path, hit.category))
            ],
            "scanner_totals": self.scanner_totals(),
            "violations": [
                asdict(violation)
                for violation in sorted(
                    self.violations, key=lambda violation: (violation.path, violation.reason)
                )
            ],
            "errors": list(self.errors),
        }

    def to_json(self) -> str:
        return json.dumps(self.as_dict(), ensure_ascii=False, sort_keys=True)


def top_level(path: str) -> str:
    """Return the repository-relative top-level component of *path*."""
    return path.split("/", 1)[0] or "."


def top_level_pairs(counts: dict[str, int]) -> tuple[tuple[str, int], ...]:
    """Return deterministic, non-zero top-level counts."""
    return tuple(sorted((key, value) for key, value in counts.items() if value))


def failure(
    command: Command,
    source: str,
    dest: str,
    errors: tuple[str, ...],
    *,
    dry_run: bool = False,
) -> GateReport:
    """Build a failed report without touching the filesystem."""

    return GateReport(
        command=command,
        ok=False,
        source=source,
        dest=dest,
        dry_run=dry_run,
        errors=errors,
    )
