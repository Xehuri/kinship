"""Behavioral tests for the fail-closed export command."""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path

import pytest

from tools.kinship_export import cli

from .support import Symlink, aws_access_key, git, make_repo


def test_export_copies_only_allowed_tracked_files(tmp_path: Path) -> None:
    repo = make_repo(
        tmp_path,
        {
            "README.md": "hello\n",
            "backend/main.py": "value = 1\n",
            "mystery/notes.txt": "not public\n",
            "ai/data/daily/x.jsonl": "{}\n",
        },
    )
    dest = tmp_path / "stage"

    result = cli.export_tree(repo, dest)

    assert result.ok, result.to_json()
    assert (dest / "README.md").read_text(encoding="utf-8") == "hello\n"
    assert (dest / "backend/main.py").is_file()
    assert not (dest / "mystery").exists()
    assert not (dest / "ai").exists()
    assert result.files_examined == 4
    assert result.allowed_files == 2
    assert result.exported_files == 2


def test_deny_wins_inside_an_allowed_tree(tmp_path: Path) -> None:
    repo = make_repo(
        tmp_path,
        {
            "backend/services/health.py": "value = 1\n",
            "backend/config/auth.json": "{}\n",
        },
    )
    dest = tmp_path / "stage"

    result = cli.export_tree(repo, dest)

    assert result.ok, result.to_json()
    assert result.allowed_files == 1
    assert result.denied_files == 1
    assert dict(result.denied_by_top_level) == {"backend": 1}
    assert (dest / "backend/services/health.py").is_file()
    assert not (dest / "backend/config/auth.json").exists()


def test_export_accepts_an_existing_empty_destination(tmp_path: Path) -> None:
    repo = make_repo(tmp_path, {"README.md": "hello\n"})
    dest = tmp_path / "stage"
    dest.mkdir()

    result = cli.export_tree(repo, dest)

    assert result.ok, result.to_json()
    assert (dest / "README.md").is_file()


def test_dry_run_does_not_create_destination(tmp_path: Path) -> None:
    repo = make_repo(tmp_path, {"README.md": "hello\n", "backend/main.py": "x\n"})
    dest = tmp_path / "stage"

    result = cli.export_tree(repo, dest, dry_run=True)

    assert result.ok, result.to_json()
    assert not dest.exists()
    assert result.exported_files == 0
    assert result.allowed_files == 2


def test_export_preserves_relative_paths_and_executable_mode(tmp_path: Path) -> None:
    repo = make_repo(tmp_path, {"scripts/run.sh": "#!/bin/sh\nexit 0\n"})
    script = repo / "scripts/run.sh"
    os.chmod(script, 0o755)
    git(repo, "add", "--", "scripts/run.sh")
    dest = tmp_path / "stage"

    result = cli.export_tree(repo, dest)

    assert result.ok, result.to_json()
    copied = dest / "scripts/run.sh"
    assert copied.is_file()
    assert stat.S_IMODE(copied.stat().st_mode) == 0o755
    assert copied.stat().st_mtime_ns == script.stat().st_mtime_ns


def test_export_rejects_non_empty_destination(tmp_path: Path) -> None:
    repo = make_repo(tmp_path, {"README.md": "hello\n"})
    dest = tmp_path / "stage"
    dest.mkdir()
    marker = dest / "keep.txt"
    marker.write_text("keep", encoding="utf-8")

    result = cli.export_tree(repo, dest)

    assert not result.ok
    assert any("not empty" in error for error in result.errors)
    assert marker.read_text(encoding="utf-8") == "keep"


def test_export_rejects_destination_inside_source(tmp_path: Path) -> None:
    repo = make_repo(tmp_path, {"README.md": "hello\n"})

    result = cli.export_tree(repo, repo / "stage")

    assert not result.ok
    assert any("outside the source" in error for error in result.errors)
    assert not (repo / "stage").exists()


def test_export_rejects_destination_with_parent_traversal(tmp_path: Path) -> None:
    repo = make_repo(tmp_path, {"README.md": "hello\n"})

    result = cli.export_tree(repo, tmp_path / "repo" / ".." / "stage")

    assert not result.ok
    assert any(".." in error for error in result.errors)


def test_export_rejects_symlink_destination(tmp_path: Path) -> None:
    repo = make_repo(tmp_path, {"README.md": "hello\n"})
    target = tmp_path / "real"
    target.mkdir()
    link = tmp_path / "link"
    link.symlink_to(target, target_is_directory=True)

    result = cli.export_tree(repo, link)

    assert not result.ok
    assert any("symlink" in error for error in result.errors)


def test_export_rejects_tracked_symlink(tmp_path: Path) -> None:
    repo = make_repo(
        tmp_path,
        {
            "backend/main.py": "x = 1\n",
            "backend/link.py": Symlink("main.py"),
        },
    )
    dest = tmp_path / "stage"

    result = cli.export_tree(repo, dest)

    assert not result.ok
    assert any(v.path == "backend/link.py" and v.reason == "symlink" for v in result.violations)
    assert not dest.exists()


def test_export_rejects_symlink_parent_directory(tmp_path: Path) -> None:
    repo = make_repo(tmp_path, {"backend/main.py": "inside\n"})
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "main.py").write_text("outside\n", encoding="utf-8")
    backend = repo / "backend"
    for child in backend.iterdir():
        child.unlink()
    backend.rmdir()
    backend.symlink_to(outside, target_is_directory=True)
    dest = tmp_path / "stage"

    result = cli.export_tree(repo, dest)

    assert not result.ok
    assert any(
        v.path == "backend/main.py" and v.reason == "symlink in path"
        for v in result.violations
    )
    assert not dest.exists()


def test_export_rejects_scanner_hit_without_leaking_value(tmp_path: Path) -> None:
    secret = aws_access_key()
    repo = make_repo(
        tmp_path,
        {
            "README.md": "ok\n",
            "backend/leak.py": b'KEY = "' + secret + b'"\n',
        },
    )
    dest = tmp_path / "stage"

    result = cli.export_tree(repo, dest)

    assert not result.ok
    assert any(
        hit.path == "backend/leak.py" and hit.category == "aws_access_key"
        for hit in result.scanner_hits
    )
    payload = result.to_json()
    assert secret.decode("ascii") not in payload
    assert not dest.exists()


def test_export_ignores_untracked_forbidden_file(tmp_path: Path) -> None:
    repo = make_repo(tmp_path, {"README.md": "hello\n"})
    leak = repo / "backend/leak.py"
    leak.parent.mkdir(parents=True)
    leak.write_bytes(b'KEY = "' + aws_access_key() + b'"\n')
    dest = tmp_path / "stage"

    result = cli.export_tree(repo, dest)

    assert result.ok, result.to_json()
    assert (dest / "README.md").is_file()
    assert not (dest / "backend").exists()


def test_export_fails_when_tracked_file_is_missing(tmp_path: Path) -> None:
    repo = make_repo(tmp_path, {"README.md": "hello\n"})
    (repo / "README.md").unlink()
    dest = tmp_path / "stage"

    result = cli.export_tree(repo, dest)

    assert not result.ok
    assert any("missing from working tree" in violation.reason for violation in result.violations)
    assert not dest.exists()


def test_export_requires_at_least_one_allowed_file(tmp_path: Path) -> None:
    repo = make_repo(tmp_path, {"mystery/notes.txt": "not public\n"})

    result = cli.export_tree(repo, tmp_path / "stage")

    assert not result.ok
    assert any("no tracked files" in error for error in result.errors)


def test_export_report_is_json_serialisable(tmp_path: Path) -> None:
    repo = make_repo(tmp_path, {"README.md": "hello\n"})

    result = cli.export_tree(repo, tmp_path / "stage", dry_run=True)
    payload = json.loads(result.to_json())

    assert payload["schema_version"] == 1
    assert payload["command"] == "export"
    assert payload["dry_run"] is True
    assert payload["ok"] is True
    assert payload["allowed_by_top_level"] == {"README.md": 1}
    assert payload["denied_files"] == 0
    assert payload["denied_by_top_level"] == {}
    assert payload["scanner_hits"] == []


def test_main_accepts_fail_closed_flag(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    repo = make_repo(tmp_path, {"README.md": "hello\n"})
    dest = tmp_path / "stage"

    code = cli.main(
        [
            "export",
            "--dest",
            str(dest),
            "--source",
            str(repo),
            "--dry-run",
            "--fail-closed",
        ]
    )
    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is True
    assert payload["dry_run"] is True
    assert not dest.exists()


def test_main_verify_accepts_fail_closed_flag(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    repo = make_repo(tmp_path, {"README.md": "hello\n"})
    dest = tmp_path / "stage"
    assert cli.export_tree(repo, dest).ok

    code = cli.main(
        ["verify", "--dest", str(dest), "--source", str(repo), "--fail-closed"]
    )

    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["command"] == "verify"
    assert payload["ok"] is True


def test_verify_ignores_git_metadata(tmp_path: Path) -> None:
    repo = make_repo(tmp_path, {"README.md": "hello\n"})
    dest = tmp_path / "stage"
    assert cli.export_tree(repo, dest).ok
    (dest / ".git").mkdir()
    (dest / ".git" / "config").write_text("[core]\n", encoding="utf-8")

    result = cli.verify_tree(dest, source=repo)

    assert result.ok is True
    assert result.files_examined == 1


def test_main_returns_non_zero_when_destination_is_not_empty(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    repo = make_repo(tmp_path, {"README.md": "hello\n"})
    dest = tmp_path / "stage"
    dest.mkdir()
    (dest / "keep.txt").write_text("keep", encoding="utf-8")

    code = cli.main(["export", "--dest", str(dest), "--source", str(repo)])

    assert code == 1
    captured = capsys.readouterr()
    assert json.loads(captured.out)["ok"] is False
