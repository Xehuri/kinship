# -*- coding: utf-8 -*-
"""Client catalog unit tests: local-first metadata, fallback, path safety."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from services import client_release_manifest, clients_catalog


def _cfg(**overrides: object) -> SimpleNamespace:
    values = {
        "CLIENTS_ANDROID_URL": "",
        "CLIENTS_ANDROID_SHA256": "",
        "CLIENTS_DESKTOP_URL": "",
        "CLIENTS_DESKTOP_SHA256": "",
        "CLIENTS_GITHUB_RELEASE_TAG": "onboarding-v1.0.0",
        "CLIENTS_GITHUB_RELEASE_BASE": "https://github.com/Xehuri/kinship",
        "ONBOARDING_RELEASE_MANIFEST_URL": "",
        "ONBOARDING_RELEASE_BASE_URL": "",
        "BACKEND_HOST": "0.0.0.0",
        "BACKEND_HTTPS_PORT": 8767,
        "BACKEND_HTTP_PORT": 8768,
        "SSL_ENABLED": True,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


@pytest.fixture(autouse=True)
def offline_manifest(monkeypatch):
    client_release_manifest.reset_cache()

    def _unavailable(*args: object, **kwargs: object) -> object:
        raise RuntimeError("network disabled in unit tests")

    monkeypatch.setattr(client_release_manifest, "_manifest_loader", _unavailable)
    yield
    client_release_manifest.reset_cache()


@pytest.fixture
def fake_config(monkeypatch):
    def _apply(**overrides: object) -> SimpleNamespace:
        cfg = _cfg(**overrides)
        monkeypatch.setattr(clients_catalog, "get_config", lambda: cfg)
        return cfg

    return _apply


def _write_apk(directory: Path, *, name: str = "app-debug.apk") -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    apk = directory / name
    apk.write_bytes(b"FAKE-APK" * 1024)
    (directory / "output-metadata.json").write_text(
        json.dumps(
            {
                "version": 3,
                "elements": [
                    {
                        "type": "SINGLE",
                        "attributes": [
                            {"key": "applicationId", "value": "com.xehuri.kinship"}
                        ],
                        "versionCode": 11,
                        "versionName": "9.9.9",
                        "variantName": "debug",
                        "outputFile": name,
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    return apk


class TestAndroid:
    def test_local_apk_metadata(self, monkeypatch, tmp_path, fake_config):
        fake_config()
        apk_dir = tmp_path / "ota"
        apk = _write_apk(apk_dir)
        monkeypatch.setenv("OTA_FILE_DIR", str(apk_dir))

        entry = clients_catalog.android_entry()

        assert entry["available"] is True
        assert entry["kind"] == "android"
        assert entry["action"] == "download"
        assert entry["source"] == "local"
        assert entry["url"] == "/api/ota/download"
        assert entry["page_url"].endswith("/releases/tag/onboarding-v1.0.0")
        assert entry["filename"] == "app-debug.apk"
        assert entry["download_filename"] == "Kinship-9.9.9-debug.apk"
        assert entry["expected_filename"] == "Kinship-9.9.9-debug.apk"
        assert entry["size"] == apk.stat().st_size
        assert entry["sha256"] == hashlib.sha256(apk.read_bytes()).hexdigest()
        assert entry["version"] == "9.9.9"
        assert entry["debug"] is True
        assert entry["label"] == "debug build"
        assert entry["fallback_reason"] is None

    def test_local_apk_wins_over_configured_url(self, monkeypatch, tmp_path, fake_config):
        apk_dir = tmp_path / "ota"
        _write_apk(apk_dir)
        monkeypatch.setenv("OTA_FILE_DIR", str(apk_dir))
        fake_config(
            CLIENTS_ANDROID_URL="https://example.test/kinship-8.8.8.apk",
            CLIENTS_ANDROID_SHA256="A" * 64,
        )

        entry = clients_catalog.android_entry()

        assert entry["source"] == "local"
        assert entry["url"] == "/api/ota/download"
        assert entry["filename"] == "app-debug.apk"

    def test_configured_url_used_when_local_missing(
        self, monkeypatch, tmp_path, fake_config
    ):
        empty = tmp_path / "empty"
        empty.mkdir()
        monkeypatch.setenv("OTA_FILE_DIR", str(empty))
        fake_config(
            CLIENTS_ANDROID_URL="https://example.test/kinship-8.8.8.apk",
            CLIENTS_ANDROID_SHA256="A" * 64,
        )

        entry = clients_catalog.android_entry()

        assert entry["source"] == "configured"
        assert entry["action"] == "download"
        assert entry["url"] == "https://example.test/kinship-8.8.8.apk"
        assert entry["filename"] == "kinship-8.8.8.apk"
        assert entry["sha256"] == "a" * 64
        assert entry["version"] == "8.8.8"

    def test_missing_apk_falls_back_to_github_page(
        self, monkeypatch, tmp_path, fake_config
    ):
        fake_config()
        empty = tmp_path / "empty"
        empty.mkdir()
        monkeypatch.setenv("OTA_FILE_DIR", str(empty))

        entry = clients_catalog.android_entry()

        assert entry["available"] is True
        assert entry["source"] == "github"
        assert entry["action"] == "external"
        assert entry["url"] == "https://github.com/Xehuri/kinship/releases/tag/onboarding-v1.0.0"
        assert entry["page_url"] == entry["url"]
        assert entry["filename"] is None
        assert entry["expected_filename"] is None
        assert entry["sha256"] is None
        assert entry["fallback_reason"].startswith("local_missing,configured_missing")


class TestDesktop:
    def test_local_desktop_metadata(self, monkeypatch, tmp_path, fake_config):
        fake_config()
        release = tmp_path / "release"
        release.mkdir()
        installer = release / "Kinship-Desktop-Setup-1.2.3-x64.exe"
        installer.write_bytes(b"FAKE-EXE" * 2048)
        (release / "Kinship-Desktop-Setup-1.2.3-x64.exe.blockmap").write_bytes(b"x")
        monkeypatch.setenv("KINSHIP_DESKTOP_RELEASE_DIR", str(release))

        entry = clients_catalog.desktop_entry()

        assert entry["available"] is True
        assert entry["kind"] == "desktop"
        assert entry["source"] == "local"
        assert entry["url"] == "/api/clients/desktop/download"
        assert entry["filename"] == "Kinship-Desktop-Setup-1.2.3-x64.exe"
        assert entry["download_filename"] == "Kinship-Desktop-Setup-1.2.3-x64.exe"
        assert entry["expected_filename"] == "Kinship-Desktop-Setup-1.2.3-x64.exe"
        assert entry["size"] == installer.stat().st_size
        assert entry["sha256"] == hashlib.sha256(installer.read_bytes()).hexdigest()
        assert entry["version"] == "1.2.3"

    def test_local_desktop_wins_over_configured_url(
        self, monkeypatch, tmp_path, fake_config
    ):
        release = tmp_path / "release"
        release.mkdir()
        (release / "Kinship-Desktop-Setup-1.2.3-x64.exe").write_bytes(b"EXE")
        monkeypatch.setenv("KINSHIP_DESKTOP_RELEASE_DIR", str(release))
        fake_config(
            CLIENTS_DESKTOP_URL="https://example.test/Kinship-Desktop-Setup-2.0.0-x64.exe"
        )

        entry = clients_catalog.desktop_entry()

        assert entry["source"] == "local"
        assert entry["url"] == "/api/clients/desktop/download"

    def test_configured_url_used_when_local_missing(
        self, monkeypatch, tmp_path, fake_config
    ):
        empty = tmp_path / "empty"
        empty.mkdir()
        monkeypatch.setenv("KINSHIP_DESKTOP_RELEASE_DIR", str(empty))
        fake_config(
            CLIENTS_DESKTOP_URL="https://example.test/Kinship-Desktop-Setup-2.0.0-x64.exe",
            CLIENTS_DESKTOP_SHA256="B" * 64,
        )

        entry = clients_catalog.desktop_entry()

        assert entry["source"] == "configured"
        assert entry["filename"] == "Kinship-Desktop-Setup-2.0.0-x64.exe"
        assert entry["sha256"] == "b" * 64
        assert entry["version"] == "2.0.0"

    def test_missing_desktop_falls_back_to_github_page(
        self, monkeypatch, tmp_path, fake_config
    ):
        fake_config()
        empty = tmp_path / "empty"
        empty.mkdir()
        monkeypatch.setenv("KINSHIP_DESKTOP_RELEASE_DIR", str(empty))

        entry = clients_catalog.desktop_entry()

        assert entry["available"] is True
        assert entry["source"] == "github"
        assert entry["action"] == "external"
        assert entry["page_url"] == (
            "https://github.com/Xehuri/kinship/releases/tag/onboarding-v1.0.0"
        )

    def test_escaping_symlink_ignored(self, monkeypatch, tmp_path, fake_config):
        fake_config()
        release = tmp_path / "release"
        release.mkdir()
        outside = tmp_path / "outside.exe"
        outside.write_bytes(b"secret")
        os.symlink(outside, release / "Kinship-Desktop-Setup-6.6.6-x64.exe")
        monkeypatch.setenv("KINSHIP_DESKTOP_RELEASE_DIR", str(release))

        entry = clients_catalog.desktop_entry()

        assert entry["source"] == "github"
        assert entry["filename"] is None


def test_catalog_has_no_pc_sensor_fields(monkeypatch, tmp_path, fake_config):
    fake_config()
    apk_dir = tmp_path / "ota"
    _write_apk(apk_dir)
    release = tmp_path / "release"
    release.mkdir()
    (release / "Kinship-Desktop-Setup-1.0.0-x64.exe").write_bytes(b"exe")
    monkeypatch.setenv("OTA_FILE_DIR", str(apk_dir))
    monkeypatch.setenv("KINSHIP_DESKTOP_RELEASE_DIR", str(release))

    result = clients_catalog.catalog()

    assert set(result) == {"android", "desktop", "connection"}
    assert "pc_sensor" not in json.dumps(result).lower()
    assert "pcsensor" not in json.dumps(result).lower()
