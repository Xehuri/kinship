#!/usr/bin/env python3
"""Check the public documentation surface.

Usage:
    python3 tools/docs-check/check_docs.py all
    python3 tools/docs-check/check_docs.py
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
PUBLIC_DOCS = ROOT / "docs/_meta/docs.public.json"
LINK_RE = re.compile(r"\[[^\]]*\]\(([^)]+)\)")
FENCE_RE = re.compile(r"^\s*```")


def markdown_files() -> list[Path]:
    files = [
        ROOT / "README.md",
        ROOT / "README.en.md",
        ROOT / "CONTRIBUTING.md",
        ROOT / "CHANGELOG.md",
        ROOT / "SECURITY.md",
    ]
    files.extend(sorted((ROOT / "docs").rglob("*.md")))
    return [p for p in files if p.is_file()]


def check_manifest() -> list[str]:
    errors: list[str] = []
    try:
        data = json.loads(PUBLIC_DOCS.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return [f"{PUBLIC_DOCS.relative_to(ROOT)}: {exc}"]
    for item in data.get("docs", []):
        rel = item.get("path")
        if not isinstance(rel, str):
            errors.append(f"{PUBLIC_DOCS.relative_to(ROOT)}: entry without path")
            continue
        if not (ROOT / "docs" / rel).is_file():
            errors.append(f"{PUBLIC_DOCS.relative_to(ROOT)}: missing docs/{rel}")
    return errors


def check_links(path: Path) -> list[str]:
    errors: list[str] = []
    in_fence = False
    for lineno, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
        if FENCE_RE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        for target in LINK_RE.findall(line):
            target = target.strip()
            if not target or target.startswith(("#", "http://", "https://", "mailto:", "tel:", "//")):
                continue
            if target.startswith("<") and target.endswith(">"):
                target = target[1:-1]
            parsed = urlsplit(target)
            if parsed.scheme:
                continue
            rel = parsed.path
            if not rel:
                continue
            candidate = ROOT / rel.lstrip("/") if rel.startswith("/") else path.parent / rel
            if not candidate.exists():
                errors.append(f"{path.relative_to(ROOT)}:{lineno}: missing link target {target}")
    return errors


def main(argv: list[str]) -> int:
    if len(argv) > 1 and argv[1] not in {"all", "check"}:
        print(f"unknown mode: {argv[1]}", file=sys.stderr)
        return 2
    errors = check_manifest()
    files = markdown_files()
    for path in files:
        errors.extend(check_links(path))
    if errors:
        print(f"docs-check: {len(errors)} error(s)", file=sys.stderr)
        for error in errors:
            print(f"  {error}", file=sys.stderr)
        return 1
    print(f"docs-check: ok ({len(files)} markdown files)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
