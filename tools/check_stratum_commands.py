"""Validate every documented stratum command against the installed CLI parser."""

from __future__ import annotations

import argparse
import re
import shlex
import sys
from dataclasses import dataclass
from pathlib import Path

from stratum.cli import build_parser

ROOT = Path(".")
SCAN_FILES = (
    *sorted((ROOT / "ai-template" / "agents").glob("*.md")),
    *sorted((ROOT / "ai-template" / "contracts").glob("*.md")),
    ROOT / "ai-template" / "README.md",
    ROOT / "ai-template" / "系统初始化指南.md",
    ROOT / "README.md",
    ROOT / "README.en.md",
)
FENCE_RE = re.compile(r"```(?:bash|sh)?[ \t]*\n(.*?)```", re.DOTALL)
INLINE_RE = re.compile(r"`([^`\n]*stratum [^`\n]*)`")
TRAILING = "。；，,.;:!?"


@dataclass(frozen=True)
class CommandUse:
    path: Path
    line: int
    text: str


@dataclass(frozen=True)
class CommandFailure:
    use: CommandUse
    message: str


class ParserMap:
    def __init__(self) -> None:
        self.root = build_parser()

    def _subparsers(self, parser: argparse.ArgumentParser):
        for action in parser._actions:
            if isinstance(action, argparse._SubParsersAction):
                return action
        return None

    def _option(self, parser: argparse.ArgumentParser, token: str):
        for action in parser._actions:
            if token in action.option_strings:
                return action
        return None

    def validate(self, text: str) -> str | None:
        try:
            words = shlex.split(text)
        except ValueError as exc:
            return f"cannot tokenize command: {exc}"
        if not words or words[0] != "stratum":
            return "not a stratum command"
        parser = self.root
        index = 1
        while index < len(words):
            token = words[index].rstrip(TRAILING)
            if not token:
                index += 1
                continue
            if token.startswith("-"):
                action = self._option(parser, token)
                if action is None:
                    return f"unknown option {token!r}"
                if action.nargs == 0:
                    index += 1
                    continue
                if index + 1 >= len(words):
                    return f"option {token!r} is missing a value"
                value = words[index + 1].rstrip(TRAILING)
                if (
                    action.choices is not None
                    and not _is_placeholder(value)
                    and value not in action.choices
                ):
                    return f"invalid value {value!r} for {token!r}"
                index += 2
                continue
            subparsers = self._subparsers(parser)
            if subparsers is not None:
                if token in subparsers.choices:
                    parser = subparsers.choices[token]
                    index += 1
                    continue
                return f"not a concrete subcommand: {token!r}"
            index += 1
        return None


def _is_placeholder(value: str) -> bool:
    return (
        value.startswith(("{", "<", "$"))
        or value in {"...", "…"}
        or value.endswith(("...", "…"))
    )


def _commands(path: Path) -> list[CommandUse]:
    text = path.read_text(encoding="utf-8")
    found: list[CommandUse] = []
    seen: set[tuple[int, str]] = set()
    for match in FENCE_RE.finditer(text):
        block_start = text.count("\n", 0, match.start(1)) + 1
        for offset, line in enumerate(match.group(1).splitlines()):
            candidate = line.strip()
            if candidate.startswith("$ "):
                candidate = candidate[2:].strip()
            if not candidate.startswith("stratum "):
                continue
            key = (block_start + offset, candidate)
            if key not in seen:
                seen.add(key)
                found.append(CommandUse(path, key[0], candidate))
    for match in INLINE_RE.finditer(text):
        candidate = match.group(1).strip()
        if not candidate.startswith("stratum "):
            continue
        if re.fullmatch(r"stratum \d+\.\d+\.\d+", candidate):
            continue
        line = text.count("\n", 0, match.start(1)) + 1
        key = (line, candidate)
        if key not in seen:
            seen.add(key)
            found.append(CommandUse(path, line, candidate))
    return found


def _self_test(parser_map: ParserMap) -> None:
    good = (
        "stratum query --type claim --claim-type observation --status active",
        "stratum status --date 2026-01-05",
        "stratum lint --profile loom-weekly report.md",
    )
    bad = (
        "stratum query --type observation",
        "stratum status --bogus",
        "stratum review list/show/promote",
    )
    for text in good:
        problem = parser_map.validate(text)
        if problem is not None:
            raise SystemExit(f"self-test false positive: {text}: {problem}")
    for text in bad:
        if parser_map.validate(text) is None:
            raise SystemExit(f"self-test false negative: {text}")


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    parser_map = ParserMap()
    if "--self-test" in args:
        _self_test(parser_map)
        print("Stratum command self-test OK")
        return 0

    failures: list[CommandFailure] = []
    count = 0
    files: set[Path] = set()
    for path in SCAN_FILES:
        if not path.is_file():
            failures.append(CommandFailure(CommandUse(path, 0, ""), "missing file"))
            continue
        for use in _commands(path):
            count += 1
            files.add(path)
            problem = parser_map.validate(use.text)
            if problem is not None:
                failures.append(CommandFailure(use, problem))
    if failures:
        for failure in failures:
            print(
                f"{failure.use.path}:{failure.use.line}: "
                f"{failure.use.text}: {failure.message}",
                file=sys.stderr,
            )
        print(f"Stratum command contract FAILED: {len(failures)} issue(s)", file=sys.stderr)
        return 1
    print(f"OK: {count} commands validated across {len(files)} files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
