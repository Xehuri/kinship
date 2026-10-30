# -*- coding: utf-8 -*-
"""T5 引导配置契约：schema 字段、示例占位、Loom token 优先级与掩码。"""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

import config.config as config_module
from config.config import Config
from config.config_schema import (
    CATEGORIES,
    defaults_document,
    get_field,
    has_blocking_errors,
    mask_document,
    validate_document,
)

ROOT = Path(__file__).resolve().parents[2]
EXAMPLE = ROOT / "config.example.yaml"


def _write_token_file(path: Path, content: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def test_new_categories_are_declared():
    categories = {item["id"]: item for item in CATEGORIES}

    for category_id in ("onboarding", "moss", "clients"):
        assert category_id in categories
        assert categories[category_id]["advanced"] is False
        assert categories[category_id]["title"]
        assert categories[category_id]["description"]


def test_new_fields_have_types_defaults_and_strategies():
    expected = {
        "onboarding.release_manifest_url": ("string", "", "hot"),
        "onboarding.release_base_url": ("string", "", "hot"),
        "onboarding.frontend_autodownload": ("bool", True, "hot"),
        "onboarding.kernel_release_tag": ("string", "", "hot"),
        "onboarding.allow_model_download": ("bool", True, "hot"),
        "onboarding.model_tiers": ("list", ["required", "recommended"], "hot"),
        "data.root": ("path", "", "hot"),
        "models.dir": ("path", "", "hot"),
        "kernel.python": ("path", "", "respawn"),
        "kernel.model_dir": ("path", "", "respawn"),
        "moss.enabled": ("bool", False, "respawn"),
        "moss.python": ("path", "", "respawn"),
        "moss.base_url": ("string", "http://127.0.0.1:8100", "reconnect"),
        "moss.model": ("string", "moss-audio-4b", "reconnect"),
        "clients.android_url": ("string", "", "hot"),
        "clients.android_sha256": ("string", "", "hot"),
        "clients.desktop_url": ("string", "", "hot"),
        "clients.desktop_sha256": ("string", "", "hot"),
        "clients.github_release_tag": ("string", "onboarding-v1.0.0", "hot"),
        "clients.github_release_base": (
            "string",
            "https://github.com/Xehuri/kinship",
            "hot",
        ),
        "loom.token_file": ("path", "", "hot"),
        "loom.credentials_file": ("path", "", "hot"),
        "loom.manage_config": ("bool", False, "hot"),
    }

    for path, (field_type, default, strategy) in expected.items():
        field = get_field(path)
        assert field is not None, path
        assert field.type == field_type, path
        assert field.default == default, path
        assert field.apply_strategy == strategy, path


def test_new_secret_paths_are_flagged_sensitive():
    assert get_field("loom.token").sensitive is True
    assert get_field("loom.token_file").sensitive is True
    assert get_field("loom.credentials_file").sensitive is True


def test_example_config_parses_and_defaults_validate():
    example = yaml.safe_load(EXAMPLE.read_text(encoding="utf-8"))

    assert example["onboarding"]["model_tiers"] == ["required", "recommended"]
    assert example["onboarding"]["frontend_autodownload"] is True
    assert example["onboarding"]["allow_model_download"] is True
    assert example["data"]["ai_root"] == "ai"
    assert example["data"]["dir"] == ""
    assert example["data"]["root"] == ""
    assert example["models"]["dir"] == ""
    assert example["kernel"]["python"] == ""
    assert example["kernel"]["model_dir"] == ""
    assert example["loom"]["token_file"] == ""
    assert example["loom"]["credentials_file"] == ""
    assert example["loom"]["manage_config"] is False
    assert example["moss"] == {
        "enabled": False,
        "python": "",
        "base_url": "http://127.0.0.1:8100",
        "model": "moss-audio-4b",
    }
    assert example["clients"] == {
        "android_url": "",
        "android_sha256": "",
        "desktop_url": "",
        "desktop_sha256": "",
        "github_release_tag": "onboarding-v1.0.0",
        "github_release_base": "https://github.com/Xehuri/kinship",
    }
    assert has_blocking_errors(validate_document(example, project_root=ROOT)) is False
    assert validate_document(defaults_document()) == []


def test_loom_token_precedence_config_over_env_over_token_file(
    tmp_path, monkeypatch
):
    token_file = _write_token_file(tmp_path / "loom.env", "LOOM_TOKEN=file-token\n")
    monkeypatch.setenv("LOOM_TOKEN", "env-token")

    cfg = Config({"loom": {"token": "config-token", "token_file": str(token_file)}})

    assert cfg.LOOM_TOKEN == "config-token"


def test_loom_token_falls_back_to_env_before_token_file(tmp_path, monkeypatch):
    token_file = _write_token_file(tmp_path / "loom.env", "LOOM_TOKEN=file-token\n")
    monkeypatch.setenv("LOOM_TOKEN", "env-token")

    cfg = Config({"loom": {"token_file": str(token_file)}})

    assert cfg.LOOM_TOKEN == "env-token"


def test_loom_token_reads_token_file_when_config_and_env_are_empty(
    tmp_path, monkeypatch
):
    token_file = _write_token_file(
        tmp_path / "credentials.conf",
        "# loom credentials\nexport LOOM_TOKEN='file-token'\n",
    )
    monkeypatch.delenv("LOOM_TOKEN", raising=False)

    cfg = Config({"loom": {"token": "", "token_file": str(token_file)}})

    assert cfg.LOOM_TOKEN == "file-token"


def test_loom_token_is_empty_without_any_source(tmp_path, monkeypatch):
    monkeypatch.delenv("LOOM_TOKEN", raising=False)

    cfg = Config({"loom": {"token": "", "token_file": str(tmp_path / "missing.env")}})

    assert cfg.LOOM_TOKEN == ""


def test_loom_token_file_relative_path_resolves_against_project_root(
    tmp_path, monkeypatch
):
    _write_token_file(tmp_path / "secrets" / "loom.env", "LOOM_TOKEN=relative-token\n")
    monkeypatch.setattr(config_module, "_resolve_base", lambda: tmp_path)
    monkeypatch.delenv("LOOM_TOKEN", raising=False)

    cfg = Config({"loom": {"token_file": "secrets/loom.env"}})

    assert cfg.LOOM_TOKEN_FILE == str(tmp_path / "secrets" / "loom.env")
    assert cfg.LOOM_TOKEN == "relative-token"


def test_loom_token_file_cache_sees_new_mtime_content(tmp_path, monkeypatch):
    token_file = _write_token_file(tmp_path / "loom.env", "LOOM_TOKEN=first-token\n")
    monkeypatch.delenv("LOOM_TOKEN", raising=False)
    cfg = Config({"loom": {"token_file": str(token_file)}})

    assert cfg.LOOM_TOKEN == "first-token"

    _write_token_file(token_file, "LOOM_TOKEN=second-token-rotated\n")

    assert cfg.LOOM_TOKEN == "second-token-rotated"


def test_mask_document_hides_token_and_credentials_file_paths():
    doc = {
        "loom": {
            "token": "plain-token",
            "token_file": "/etc/kinship-loom/token.env",
            "credentials_file": "/etc/kinship-loom/credentials.conf",
        }
    }

    masked = mask_document(doc)

    assert masked["loom"]["token"] == "***"
    assert masked["loom"]["token_file"] == "***"
    assert masked["loom"]["credentials_file"] == "***"
    assert "plain-token" not in yaml.safe_dump(masked)
    assert "/etc/kinship-loom" not in yaml.safe_dump(masked)
    assert doc["loom"]["token_file"] == "/etc/kinship-loom/token.env"


def test_config_defaults_for_new_properties():
    cfg = Config({})

    assert cfg.DATA_ROOT == ""
    assert cfg.MODELS_DIR == ""
    assert cfg.KERNEL_PYTHON == ""
    assert cfg.KERNEL_MODEL_DIR == ""
    assert cfg.LOOM_TOKEN_FILE == ""
    assert cfg.LOOM_CREDENTIALS_FILE == ""
    assert cfg.LOOM_MANAGE_CONFIG is False
    assert cfg.ONBOARDING_RELEASE_MANIFEST_URL == ""
    assert cfg.ONBOARDING_RELEASE_BASE_URL == ""
    assert cfg.ONBOARDING_FRONTEND_AUTODOWNLOAD is True
    assert cfg.ONBOARDING_KERNEL_RELEASE_TAG == ""
    assert cfg.ONBOARDING_ALLOW_MODEL_DOWNLOAD is True
    assert cfg.ONBOARDING_MODEL_TIERS == ["required", "recommended"]
    assert cfg.MOSS_ENABLED is False
    assert cfg.MOSS_BASE_URL == "http://127.0.0.1:8100"
    assert cfg.MOSS_MODEL == "moss-audio-4b"
    assert cfg.CLIENTS_ANDROID_URL == ""
    assert cfg.CLIENTS_ANDROID_SHA256 == ""
    assert cfg.CLIENTS_DESKTOP_URL == ""
    assert cfg.CLIENTS_DESKTOP_SHA256 == ""
    assert cfg.CLIENTS_GITHUB_RELEASE_TAG == "onboarding-v1.0.0"
    assert cfg.CLIENTS_GITHUB_RELEASE_BASE == "https://github.com/Xehuri/kinship"


def test_config_reads_explicit_values_and_resolves_kernel_model_dir(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(config_module, "_resolve_base", lambda: tmp_path)
    cfg = Config(
        {
            "onboarding": {
                "release_manifest_url": "https://example.invalid/manifest.json",
                "release_base_url": "https://example.invalid/assets",
                "frontend_autodownload": False,
                "kernel_release_tag": "kernel-v1.0.0",
                "allow_model_download": False,
                "model_tiers": ["required"],
            },
            "kernel": {"python": "/opt/kinship/.venv-kernel/bin/python", "model_dir": "models"},
            "loom": {"manage_config": True},
            "moss": {"enabled": True, "base_url": "http://127.0.0.1:9100", "model": "moss-test"},
            "clients": {
                "android_url": "https://example.invalid/app.apk",
                "android_sha256": "a" * 64,
                "desktop_url": "https://example.invalid/app.exe",
                "desktop_sha256": "b" * 64,
                "github_release_tag": "onboarding-v9.9.9",
                "github_release_base": "https://github.com/example/kinship",
            },
        }
    )

    assert cfg.ONBOARDING_RELEASE_MANIFEST_URL.endswith("/manifest.json")
    assert cfg.ONBOARDING_RELEASE_BASE_URL.endswith("/assets")
    assert cfg.ONBOARDING_FRONTEND_AUTODOWNLOAD is False
    assert cfg.ONBOARDING_KERNEL_RELEASE_TAG == "kernel-v1.0.0"
    assert cfg.ONBOARDING_ALLOW_MODEL_DOWNLOAD is False
    assert cfg.ONBOARDING_MODEL_TIERS == ["required"]
    assert cfg.KERNEL_PYTHON == "/opt/kinship/.venv-kernel/bin/python"
    assert cfg.KERNEL_MODEL_DIR == str(tmp_path / "models")
    assert cfg.LOOM_MANAGE_CONFIG is True
    assert cfg.MOSS_ENABLED is True
    assert cfg.MOSS_BASE_URL == "http://127.0.0.1:9100"
    assert cfg.MOSS_MODEL == "moss-test"
    assert cfg.CLIENTS_ANDROID_URL.endswith("/app.apk")
    assert cfg.CLIENTS_ANDROID_SHA256 == "a" * 64
    assert cfg.CLIENTS_DESKTOP_URL.endswith("/app.exe")
    assert cfg.CLIENTS_DESKTOP_SHA256 == "b" * 64
    assert cfg.CLIENTS_GITHUB_RELEASE_TAG == "onboarding-v9.9.9"
    assert cfg.CLIENTS_GITHUB_RELEASE_BASE == "https://github.com/example/kinship"


def test_config_resolves_data_root_and_models_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(config_module, "_resolve_base", lambda: tmp_path)
    cfg = Config({"data": {"root": "runtime"}, "models": {"dir": "weights"}})

    assert cfg.DATA_ROOT == str(tmp_path / "runtime")
    assert cfg.MODELS_DIR == str(tmp_path / "weights")


def test_config_keeps_absolute_root_paths(tmp_path, monkeypatch):
    monkeypatch.setattr(config_module, "_resolve_base", lambda: tmp_path / "project")
    data_root = tmp_path / "data-disk"
    models_dir = tmp_path / "models-disk"
    cfg = Config(
        {"data": {"root": str(data_root)}, "models": {"dir": str(models_dir)}}
    )

    assert cfg.DATA_ROOT == str(data_root)
    assert cfg.MODELS_DIR == str(models_dir)


def test_loom_validation_accepts_token_file_when_token_and_env_are_empty(monkeypatch):
    monkeypatch.delenv("LOOM_TOKEN", raising=False)
    doc = defaults_document()
    doc["ai_backend"] = "loom"
    doc["loom"]["token_file"] = "/etc/kinship-loom/token.env"

    errors = validate_document(doc)

    assert not any(error.path == "loom.token" for error in errors)


@pytest.mark.parametrize("sensitive_path", ["loom.token", "loom.token_file", "loom.credentials_file"])
def test_sensitive_paths_are_never_returned_in_clear_by_masked_config(sensitive_path):
    cfg = Config({"loom": {sensitive_path.split(".")[-1]: "clear-value"}})

    assert "clear-value" not in yaml.safe_dump(cfg.masked_config())
