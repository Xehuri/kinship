# -*- coding: utf-8 -*-
"""T8 Loom token 自动发现：优先级、指纹、无泄漏。"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

import config.config as config_module
from config.config import Config
from services import loom_onboarding as loom


@pytest.fixture(autouse=True)
def _clear_token_cache():
    config_module._LOOM_TOKEN_FILE_CACHE.clear()
    yield
    config_module._LOOM_TOKEN_FILE_CACHE.clear()


def _write(path: Path, content: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def _expected_fingerprint(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()[:8]


def test_config_token_wins_over_env_and_files(tmp_path, monkeypatch):
    token_file = _write(tmp_path / "token.env", "LOOM_TOKEN=file-token\n")
    credentials = _write(tmp_path / "credentials.conf", "LOOM_TOKEN=credentials-token\n")
    monkeypatch.setenv("LOOM_TOKEN", "env-token")
    cfg = Config(
        {
            "loom": {
                "token": "config-token",
                "token_file": str(token_file),
                "credentials_file": str(credentials),
            }
        }
    )

    found = loom.discover_token(cfg)

    assert found.found is True
    assert found.source == loom.SOURCE_CONFIG
    assert found.fingerprint == _expected_fingerprint("config-token")


def test_env_wins_over_token_file_and_credentials_file(tmp_path, monkeypatch):
    token_file = _write(tmp_path / "token.env", "LOOM_TOKEN=file-token\n")
    credentials = _write(tmp_path / "credentials.conf", "LOOM_TOKEN=credentials-token\n")
    monkeypatch.setenv("LOOM_TOKEN", "env-token")
    cfg = Config(
        {
            "loom": {
                "token": "",
                "token_file": str(token_file),
                "credentials_file": str(credentials),
            }
        }
    )

    found = loom.discover_token(cfg)

    assert found.source == loom.SOURCE_ENV
    assert found.fingerprint == _expected_fingerprint("env-token")


def test_token_file_wins_over_credentials_file(tmp_path, monkeypatch):
    token_file = _write(tmp_path / "token.env", "LOOM_TOKEN=file-token\n")
    credentials = _write(tmp_path / "credentials.conf", "LOOM_TOKEN=credentials-token\n")
    monkeypatch.delenv("LOOM_TOKEN", raising=False)
    cfg = Config(
        {
            "loom": {
                "token_file": str(token_file),
                "credentials_file": str(credentials),
            }
        }
    )

    found = loom.discover_token(cfg)

    assert found.source == loom.SOURCE_TOKEN_FILE
    assert found.fingerprint == _expected_fingerprint("file-token")


def test_credentials_file_used_when_other_sources_absent(tmp_path, monkeypatch):
    credentials = _write(
        tmp_path / "credentials.conf",
        "# systemd EnvironmentFile\nexport LOOM_TOKEN='credentials-token'\nLOOM_KEY_A=ignored\n",
    )
    monkeypatch.delenv("LOOM_TOKEN", raising=False)
    cfg = Config(
        {
            "loom": {
                "token": "",
                "token_file": str(tmp_path / "missing.env"),
                "credentials_file": str(credentials),
            }
        }
    )

    found = loom.discover_token(cfg)

    assert found.source == loom.SOURCE_CREDENTIALS_FILE
    assert found.fingerprint == _expected_fingerprint("credentials-token")


def test_missing_token_returns_missing_source(tmp_path, monkeypatch):
    monkeypatch.delenv("LOOM_TOKEN", raising=False)
    cfg = Config(
        {
            "loom": {
                "token": "",
                "token_file": str(tmp_path / "missing.env"),
                "credentials_file": str(tmp_path / "missing.conf"),
            }
        }
    )

    found = loom.discover_token(cfg)

    assert found.found is False
    assert found.source == loom.SOURCE_MISSING
    assert found.fingerprint == ""
    assert found.detail


def test_public_shape_contains_fingerprint_only(tmp_path, monkeypatch):
    secret = "super-secret-loom-token-value"
    _write(tmp_path / "token.env", f"LOOM_TOKEN={secret}\n")
    monkeypatch.delenv("LOOM_TOKEN", raising=False)
    cfg = Config({"loom": {"token_file": str(tmp_path / "token.env")}})

    found = loom.discover_token(cfg)
    payload = found.public()
    serialized = json.dumps(payload, ensure_ascii=False)

    assert payload["found"] is True
    assert payload["fingerprint"] == _expected_fingerprint(secret)
    assert set(payload) == {"found", "source", "fingerprint", "detail"}
    assert secret not in serialized
    assert secret not in repr(found)


def test_relative_token_file_resolves_against_project_root(tmp_path, monkeypatch):
    _write(tmp_path / "secrets" / "loom.env", "LOOM_TOKEN=relative-token\n")
    monkeypatch.setattr(config_module, "_resolve_base", lambda: tmp_path)
    monkeypatch.delenv("LOOM_TOKEN", raising=False)
    cfg = Config({"loom": {"token_file": "secrets/loom.env"}})

    found = loom.discover_token(cfg)

    assert found.source == loom.SOURCE_TOKEN_FILE
    assert found.fingerprint == _expected_fingerprint("relative-token")


def test_relative_credentials_file_resolves_against_project_root(tmp_path, monkeypatch):
    _write(
        tmp_path / "secrets" / "credentials.conf",
        "LOOM_TOKEN=relative-credentials-token\n",
    )
    monkeypatch.setattr(config_module, "_resolve_base", lambda: tmp_path)
    monkeypatch.delenv("LOOM_TOKEN", raising=False)
    cfg = Config({"loom": {"credentials_file": "secrets/credentials.conf"}})

    found = loom.discover_token(cfg)

    assert found.source == loom.SOURCE_CREDENTIALS_FILE
    assert found.fingerprint == _expected_fingerprint("relative-credentials-token")


def test_unreadable_files_fall_through_without_raising(tmp_path, monkeypatch):
    monkeypatch.delenv("LOOM_TOKEN", raising=False)
    cfg = Config(
        {
            "loom": {
                "token_file": str(tmp_path / "no-such-token.env"),
                "credentials_file": str(tmp_path / "no-such-credentials.conf"),
            }
        }
    )

    found = loom.discover_token(cfg)

    assert found.found is False
    assert found.source == loom.SOURCE_MISSING


def test_fingerprint_is_eight_hex_chars():
    assert len(loom.fingerprint("a-token")) == 8
    int(loom.fingerprint("a-token"), 16)
