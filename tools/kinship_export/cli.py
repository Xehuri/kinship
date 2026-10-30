"""Fail-closed public export and verification commands.

Usage:

    python -m tools.kinship_export.cli export --dest PATH [--dry-run] [--fail-closed]
    python -m tools.kinship_export.cli verify --dest PATH [--fail-closed]

The source is always the git repository root. Only files returned by
``git ls-files`` are considered, and every one of them must pass the allowlist
and the content scanner before a single byte is written.
"""

from __future__ import annotations

import argparse
import os
import shutil
import stat
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Sequence

try:  # pragma: no cover - exercised by direct script imports
    from . import git_index, paths, policy, report, scanner
    from .paths import GateError
except ImportError:  # pragma: no cover
    import git_index  # type: ignore[no-redef]
    import paths  # type: ignore[no-redef]
    import policy  # type: ignore[no-redef]
    import report  # type: ignore[no-redef]
    import scanner  # type: ignore[no-redef]
    from paths import GateError  # type: ignore[no-redef]


def repo_root() -> Path:
    """Return the repository root that contains this package."""

    return Path(__file__).resolve().parents[2]


def export_tree(
    source: Path,
    dest: Path,
    *,
    dry_run: bool = False,
    allowlist: dict[str, Any] | None = None,
) -> report.GateReport:
    """Export every allowed tracked file, or fail without writing anything."""

    source_label = str(source)
    dest_label = str(dest)
    try:
        source_root = git_index.resolve_source(source)
        dest_path = paths.prepare_dest(
            source_root, dest, must_exist=False, require_empty=True
        )
        entries = git_index.tracked_entries(source_root)
        rules = allowlist if allowlist is not None else policy.load_allowlist()
    except (GateError, policy.AllowlistError) as exc:
        return report.failure(
            "export", source_label, dest_label, (str(exc),), dry_run=dry_run
        )

    hits: list[report.ScanHit] = []
    violations: list[report.Violation] = []
    planned: list[tuple[str, bytes, int, int, int]] = []
    allowed_count = 0
    denied_count = 0
    allowed_by_top: Counter[str] = Counter()
    denied_by_top: Counter[str] = Counter()

    for path, mode in entries:
        if not policy.is_public_path(path, rules):
            denied_count += 1
            denied_by_top[report.top_level(path)] += 1
            continue
        allowed_count += 1
        allowed_by_top[report.top_level(path)] += 1
        if mode == "120000":
            violations.append(report.Violation(path, "symlink"))
            continue
        if mode == "160000":
            violations.append(report.Violation(path, "submodule"))
            continue
        if mode not in {"100644", "100755"}:
            violations.append(report.Violation(path, "non-regular tracked entry"))
            continue
        source_file = source_root / path
        if paths.has_symlink_component(source_root, path):
            violations.append(report.Violation(path, "symlink in path"))
            continue
        try:
            info = source_file.lstat()
        except OSError:
            violations.append(
                report.Violation(path, "tracked file missing from working tree")
            )
            continue
        if stat.S_ISLNK(info.st_mode):
            violations.append(report.Violation(path, "symlink"))
            continue
        if not stat.S_ISREG(info.st_mode):
            violations.append(report.Violation(path, "not a regular file"))
            continue
        if info.st_size > scanner.MAX_SCAN_BYTES:
            violations.append(report.Violation(path, "file exceeds scanner size limit"))
            continue
        try:
            data = source_file.read_bytes()
        except OSError as exc:
            violations.append(
                report.Violation(
                    path, f"read failed: {exc.strerror or type(exc).__name__}"
                )
            )
            continue
        hits.extend(scanner.scan_bytes(data, path))
        file_mode = 0o755 if mode == "100755" else 0o644
        planned.append((path, data, file_mode, info.st_atime_ns, info.st_mtime_ns))

    errors: list[str] = []
    if allowed_count == 0:
        errors.append("no tracked files match the public allowlist")

    ok = not hits and not violations and not errors
    exported = 0
    bytes_written = 0
    dest_preexisted = dest_path.exists()
    if ok and not dry_run:
        try:
            dest_path.mkdir(parents=True, exist_ok=True)
            for path, data, mode, atime_ns, mtime_ns in planned:
                target = dest_path / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
                os.chmod(target, mode)
                os.utime(target, ns=(atime_ns, mtime_ns))
                exported += 1
                bytes_written += len(data)
        except OSError as exc:
            errors.append(f"write failed: {exc.strerror or type(exc).__name__}")
            ok = False
            shutil.rmtree(dest_path, ignore_errors=True)
            if dest_preexisted:
                dest_path.mkdir(parents=True, exist_ok=True)

    return report.GateReport(
        command="export",
        ok=ok,
        source=str(source_root),
        dest=str(dest_path),
        dry_run=dry_run,
        files_examined=len(entries),
        allowed_files=allowed_count,
        denied_files=denied_count,
        exported_files=exported,
        bytes_written=bytes_written,
        allowed_by_top_level=report.top_level_pairs(dict(allowed_by_top)),
        denied_by_top_level=report.top_level_pairs(dict(denied_by_top)),
        scanner_hits=tuple(hits),
        violations=tuple(violations),
        errors=tuple(errors),
    )


def verify_tree(
    dest: Path,
    *,
    source: Path | None = None,
    allowlist: dict[str, Any] | None = None,
) -> report.GateReport:
    """Verify a candidate public tree without writing anything."""

    source_root = (source or repo_root()).resolve()
    dest_label = str(dest)
    try:
        rules = allowlist if allowlist is not None else policy.load_allowlist()
        dest_path = paths.prepare_dest(
            source_root, dest, must_exist=True, require_empty=False
        )
    except (GateError, policy.AllowlistError) as exc:
        return report.failure("verify", str(source_root), dest_label, (str(exc),))

    hits: list[report.ScanHit] = []
    violations: list[report.Violation] = []
    files_examined = 0
    allowed_count = 0
    allowed_by_top: Counter[str] = Counter()

    for root, dirnames, filenames in os.walk(dest_path, followlinks=False):
        root_path = Path(root)
        for dirname in list(dirnames):
            directory = root_path / dirname
            rel = directory.relative_to(dest_path).as_posix()
            if dirname == ".git":
                dirnames.remove(dirname)
                continue
            if directory.is_symlink():
                violations.append(report.Violation(rel, "symlink directory"))
                dirnames.remove(dirname)
                continue
            reason = paths.forbidden_dir_reason(rel, dirname)
            if reason is not None:
                violations.append(report.Violation(rel, reason))
                dirnames.remove(dirname)

        for filename in filenames:
            file_path = root_path / filename
            rel = file_path.relative_to(dest_path).as_posix()
            files_examined += 1
            if file_path.is_symlink():
                violations.append(report.Violation(rel, "symlink"))
                continue
            if not file_path.is_file():
                violations.append(report.Violation(rel, "not a regular file"))
                continue
            reason = paths.forbidden_file_reason(rel)
            if reason is not None:
                violations.append(report.Violation(rel, reason))
                continue
            if not policy.is_public_path(rel, rules):
                violations.append(
                    report.Violation(rel, "path not allowed by public allowlist")
                )
                continue
            if file_path.stat().st_size > scanner.MAX_SCAN_BYTES:
                violations.append(report.Violation(rel, "file exceeds scanner size limit"))
                continue
            allowed_count += 1
            allowed_by_top[report.top_level(rel)] += 1
            try:
                data = file_path.read_bytes()
            except OSError as exc:
                violations.append(
                    report.Violation(
                        rel, f"read failed: {exc.strerror or type(exc).__name__}"
                    )
                )
                continue
            hits.extend(scanner.scan_bytes(data, rel))

    errors = () if files_examined else ("no files found in destination",)
    ok = not hits and not violations and not errors
    return report.GateReport(
        command="verify",
        ok=ok,
        source=str(source_root),
        dest=str(dest_path),
        files_examined=files_examined,
        allowed_files=allowed_count,
        denied_files=max(files_examined - allowed_count, 0),
        allowed_by_top_level=report.top_level_pairs(dict(allowed_by_top)),
        scanner_hits=tuple(hits),
        violations=tuple(violations),
        errors=errors,
    )


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m tools.kinship_export.cli")
    subparsers = parser.add_subparsers(dest="command", required=True)

    export_parser = subparsers.add_parser("export", help="export the public tree")
    export_parser.add_argument("--dest", required=True, type=Path)
    export_parser.add_argument("--dry-run", action="store_true")
    export_parser.add_argument(
        "--source", type=Path, default=None, help=argparse.SUPPRESS
    )

    verify_parser = subparsers.add_parser("verify", help="verify a candidate public tree")
    verify_parser.add_argument("--dest", required=True, type=Path)
    verify_parser.add_argument(
        "--source", type=Path, default=None, help=argparse.SUPPRESS
    )

    for command in (export_parser, verify_parser):
        command.add_argument(
            "--fail-closed",
            action="store_true",
            default=True,
            help="abort on any scanner or integrity finding (always enabled)",
        )

    args = parser.parse_args(argv)
    source = (args.source or repo_root()).resolve()
    if args.command == "export":
        result = export_tree(source, args.dest, dry_run=args.dry_run)
    else:
        result = verify_tree(args.dest, source=source)
    print(result.to_json())
    return 0 if result.ok else 1


if __name__ == "__main__":
    sys.exit(main())
