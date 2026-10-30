"""Fail-closed tests for ``verify`` and scanner integration."""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path

import pytest

from tools.kinship_export import cli, paths, policy

from .support import (
    aws_access_key,
    bearer_token,
    database_url,
    github_token,
    google_api_key,
    gps_coord,
    home_path,
    id_card_number,
    jwt_token,
    make_repo,
    openai_key,
    personal_email,
    personal_literal,
    phone_number,
    private_key_block,
    qq_number,
    slack_token,
    strong_password,
    windows_drive_path,
    windows_user_path,
    write_tree,
    wsl_path,
    wsl_user_path,
)


@pytest.mark.parametrize(
    "rel",
    [
        "ai/data/daily/x.jsonl",
        "validation/voiceprint/x.wav",
        "archive/behavior/verify.py",
        "kernel/axeuh_kernel/main.py",
        "models/weights.safetensors",
        "backend/models/weights.bin",
        "app/build/outputs/apk/app-debug.apk",
        "desktop/pc-sensor/dist/Kinship-PCSensor.exe",
        "backend/config/auth.json",
        "backend/config/agents.json",
        "desktop/pc-sensor/config.json",
        "tools/public-sync/sync.py",
        "frontend/mobile/public/circuitjs1/x.js",
        "docs/migration/pii.md",
        "docs/archive/old.md",
        "backend/data/health.json",
        "loom-harness/state/fleet/x.md",
        "release/kinship.tar.gz",
        "config.yaml",
        ".env",
        "mystery/notes.txt",
    ],
)
def test_verify_rejects_forbidden_paths(tmp_path: Path, rel: str) -> None:
    dest = tmp_path / "stage"
    write_tree(dest, {rel: "x\n"})

    result = cli.verify_tree(dest)

    assert not result.ok
    assert any(
        v.path == rel
        or v.path in rel.split("/")
        or rel.startswith(v.path + "/")
        for v in result.violations
    )


def test_gradle_wrapper_jar_is_the_only_trusted_binary() -> None:
    assert paths.forbidden_file_reason("gradle/wrapper/gradle-wrapper.jar") is None
    assert paths.forbidden_file_reason("gradle/evil.jar") == "forbidden artifact suffix: .jar"


@pytest.mark.parametrize(
    "rel",
    ["/etc/passwd", "../outside.txt", "backend/../outside.txt", "C:/Users/x"],
)
def test_absolute_and_traversal_paths_are_denied(rel: str) -> None:
    assert policy.is_public_path(rel) is False


def test_verify_accepts_clean_export(tmp_path: Path) -> None:
    repo = make_repo(
        tmp_path,
        {
            "README.md": "hello\n",
            "backend/main.py": "value = 1\n",
            "docs/guide.md": "# guide\n",
        },
    )
    dest = tmp_path / "stage"
    exported = cli.export_tree(repo, dest)
    assert exported.ok, exported.to_json()

    result = cli.verify_tree(dest)

    assert result.ok, result.to_json()
    assert result.files_examined == 3


def test_verify_rejects_symlink_file(tmp_path: Path) -> None:
    dest = tmp_path / "stage"
    write_tree(dest, {"README.md": "hello\n"})
    link = dest / "backend/link.py"
    link.parent.mkdir()
    link.symlink_to(dest / "README.md")

    result = cli.verify_tree(dest)

    assert not result.ok
    assert any(v.path == "backend/link.py" and v.reason == "symlink" for v in result.violations)


def test_verify_rejects_symlink_directory(tmp_path: Path) -> None:
    dest = tmp_path / "stage"
    write_tree(dest, {"README.md": "hello\n"})
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("secret", encoding="utf-8")
    link = dest / "backend"
    link.symlink_to(outside, target_is_directory=True)

    result = cli.verify_tree(dest)

    assert not result.ok
    assert any(v.path == "backend" and v.reason == "symlink directory" for v in result.violations)


def test_verify_ignores_git_directory(tmp_path: Path) -> None:
    dest = tmp_path / "stage"
    write_tree(dest, {"README.md": "hello\n"})
    (dest / ".git").mkdir()

    result = cli.verify_tree(dest)

    assert result.ok
    assert result.files_examined == 1


def test_verify_rejects_empty_tree(tmp_path: Path) -> None:
    dest = tmp_path / "stage"
    dest.mkdir()

    result = cli.verify_tree(dest)

    assert not result.ok
    assert any("no files" in error for error in result.errors)


def test_verify_rejects_missing_destination(tmp_path: Path) -> None:
    result = cli.verify_tree(tmp_path / "absent")

    assert not result.ok
    assert any("does not exist" in error for error in result.errors)


def test_verify_rejects_non_directory_destination(tmp_path: Path) -> None:
    dest = tmp_path / "stage"
    dest.write_text("not a directory", encoding="utf-8")

    result = cli.verify_tree(dest)

    assert not result.ok
    assert any("not a directory" in error for error in result.errors)


def test_verify_rejects_destination_inside_source(tmp_path: Path) -> None:
    repo = make_repo(tmp_path, {"README.md": "hello\n"})
    dest = repo / "stage"
    write_tree(dest, {"README.md": "hello\n"})

    result = cli.verify_tree(dest, source=repo)

    assert not result.ok
    assert any("outside the source" in error for error in result.errors)


def test_verify_rejects_secret_hit_without_leaking_value(tmp_path: Path) -> None:
    secret = aws_access_key()
    dest = tmp_path / "stage"
    write_tree(dest, {"backend/leak.py": b'KEY = "' + secret + b'"\n'})

    result = cli.verify_tree(dest)

    assert not result.ok
    assert any(
        hit.path == "backend/leak.py" and hit.category == "aws_access_key"
        for hit in result.scanner_hits
    )
    assert secret.decode("ascii") not in result.to_json()


@pytest.mark.parametrize(
    ("builder", "category"),
    [
        (aws_access_key, "aws_access_key"),
        (github_token, "github_token"),
        (slack_token, "slack_token"),
        (google_api_key, "google_api_key"),
        (openai_key, "openai_key"),
        (jwt_token, "jwt"),
        (bearer_token, "bearer_token"),
        (database_url, "database_url_credentials"),
        (qq_number, "qq_number"),
        (private_key_block, "private_key"),
        (strong_password, "password_assignment"),
        (phone_number, "phone_cn"),
        (personal_email, "email_personal"),
        (id_card_number, "id_card_cn"),
        (home_path, "home_path"),
        (windows_user_path, "windows_user_path"),
        (windows_drive_path, "windows_drive_path"),
        (wsl_user_path, "wsl_user_path"),
        (wsl_path, "wsl_path"),
        (gps_coord, "gps_coord"),
        (personal_literal, "personal_literal"),
    ],
)
def test_verify_detects_scanner_categories(
    tmp_path: Path, builder: Callable[[], bytes], category: str
) -> None:
    value = builder()
    if category == "password_assignment":
        content = b'password = "' + value + b'"\n'
    else:
        content = value + b"\n"
    dest = tmp_path / "stage"
    write_tree(dest, {"backend/leak.py": content})

    result = cli.verify_tree(dest)

    assert not result.ok
    assert category in {hit.category for hit in result.scanner_hits}
    assert value.decode("utf-8") not in result.to_json()


def test_verify_report_is_machine_readable(tmp_path: Path) -> None:
    dest = tmp_path / "stage"
    write_tree(dest, {"README.md": "hello\n"})

    result = cli.verify_tree(dest)
    payload = json.loads(result.to_json())

    assert payload["command"] == "verify"
    assert payload["ok"] is True
    assert payload["scanner_hits"] == []
    assert payload["violations"] == []
