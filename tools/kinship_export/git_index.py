"""Git-index enumeration for the export gate.

Only tracked entries are considered. The export never walks the working tree,
so untracked files cannot leak into a public tree by accident.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

try:  # pragma: no cover - exercised by direct script imports
    from .paths import GateError
except ImportError:  # pragma: no cover
    from paths import GateError  # type: ignore[no-redef]


def resolve_source(source: Path) -> Path:
    """Require source to be the root of the containing git repository."""

    candidate = source.resolve()
    if not candidate.is_dir():
        raise GateError("source is not a directory")
    top = run_git(candidate, "rev-parse", "--show-toplevel").decode(
        "utf-8", "replace"
    ).strip()
    if not top or Path(top).resolve() != candidate:
        raise GateError("source must be the git repository root")
    return candidate


def tracked_entries(source: Path) -> list[tuple[str, str]]:
    """Return ``(path, git_mode)`` for every tracked index entry."""

    output = run_git(source, "ls-files", "-z", "-s")
    entries: list[tuple[str, str]] = []
    for record in output.split(b"\0"):
        if not record:
            continue
        metadata, separator, raw_path = record.partition(b"\t")
        if not separator:
            raise GateError("unexpected git ls-files record")
        mode = metadata.split(b" ", 1)[0].decode("ascii", "replace")
        entries.append((os.fsdecode(raw_path), mode))
    return entries


def run_git(source: Path, *args: str) -> bytes:
    completed = subprocess.run(
        ["git", "-C", str(source), *args],
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        message = completed.stderr.decode("utf-8", "replace").strip().splitlines()
        raise GateError(message[-1] if message else "git command failed")
    return completed.stdout
