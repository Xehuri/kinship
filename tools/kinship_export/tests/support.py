"""Test helpers for the export gate tests.

Sample secrets are assembled at runtime so this file itself stays clean when the
real repository is scanned by ``export --dry-run``.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping


@dataclass(frozen=True, slots=True)
class Symlink:
    target: str


def git(root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(root), *args],
        check=True,
        capture_output=True,
        text=True,
    )


def make_repo(tmp_path: Path, files: Mapping[str, str | bytes | Symlink]) -> Path:
    root = tmp_path / "repo"
    root.mkdir()
    git(root, "init", "-q")
    paths: list[str] = []
    for rel, content in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, Symlink):
            path.symlink_to(content.target)
        elif isinstance(content, bytes):
            path.write_bytes(content)
        else:
            path.write_text(content, encoding="utf-8")
        paths.append(rel)
    if paths:
        git(root, "add", "--", *paths)
    return root


def write_tree(root: Path, files: Mapping[str, str | bytes]) -> None:
    root.mkdir(parents=True, exist_ok=True)
    for rel, content in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            path.write_bytes(content)
        else:
            path.write_text(content, encoding="utf-8")


def aws_access_key() -> bytes:
    return b"AKIA" + b"ABCDEFGHIJKLMNOP"


def github_token() -> bytes:
    return b"ghp_" + b"A" * 36


def slack_token() -> bytes:
    return b"xoxb-" + b"1234567890-" + b"abcdefghij"


def google_api_key() -> bytes:
    return b"AIza" + b"A" * 35


def openai_key() -> bytes:
    return b"sk-" + b"A" * 48


def jwt_token() -> bytes:
    return b"eyJ" + b"A" * 12 + b"." + b"B" * 12 + b"." + b"C" * 12


def bearer_token() -> bytes:
    return b"Bearer " + b"a" * 24


def qq_number() -> bytes:
    return b"QQ: " + b"123456789"


def database_url() -> bytes:
    return b"postgres://user:" + b"p" * 12 + b"@db.local/app"


def private_key_block() -> bytes:
    return b"-----BEGIN " + b"PRIVATE KEY-----"


def strong_password() -> bytes:
    return b"Zx9!" + b"mQ2#" + b"vL7@" + b"pR4$"


def phone_number() -> bytes:
    return b"139" + b"28475613"


def personal_email() -> bytes:
    return b"zhangsan" + b"@" + b"qq.com"


def id_card_number() -> bytes:
    return b"110101" + b"19900101" + b"1234"


def home_path() -> bytes:
    return b"/home/" + b"realperson/"


def windows_user_path() -> bytes:
    return b"C:\\" + b"Users\\" + b"realperson"


def windows_drive_path() -> bytes:
    return b"D:\\" + b"ProgramData\\miniconda3\\python.exe"


def wsl_user_path() -> bytes:
    return b"/mnt/" + b"d/Users/" + b"realperson/Desktop"


def wsl_path() -> bytes:
    return b"/mnt/" + b"d/tmp-opencode/project"


def gps_coord() -> bytes:
    return b"31." + b"77392,120." + b"04417"


def personal_literal() -> bytes:
    return "\u73cd\u59ae".encode("utf-8")
