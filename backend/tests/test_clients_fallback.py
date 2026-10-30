# -*- coding: utf-8 -*-
"""Client catalog fallback chain: local -> configured -> manifest -> GitHub page."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from services import client_release_manifest, clients_catalog

MANIFEST_ANDROID_FILE = "Kinship-Android-1.4.2-debug.apk"
MANIFEST_DESKTOP_FILE = "Kinship-Desktop-Setup-1.0.0-x64.exe"
MANIFEST_ANDROID_SHA = "a" * 64
MANIFEST_DESKTOP_SHA = "b" * 64
MANIFEST_ANDROID_URL = (
    "https://github.com/Xehuri/kinship/releases/download/onboarding-v1.0.0/"
    + MANIFEST_ANDROID_FILE
)
MANIFEST_DESKTOP_URL = (
    "https://github.com/Xehuri/kinship/releases/download/onboarding-v1.0.0/"
    + MANIFEST_DESKTOP_FILE
)
PAGE_URL = "https://github.com/Xehuri/kinship/releases/tag/onboarding-v1.0.0"


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


def _manifest(
    *, include_android: bool = True, include_desktop: bool = True
) -> SimpleNamespace:
    assets: dict[str, SimpleNamespace] = {}
    if include_android:
        assets["android"] = SimpleNamespace(
            file=MANIFEST_ANDROID_FILE,
            url=MANIFEST_ANDROID_URL,
            size=59_178_057,
            sha256=MANIFEST_ANDROID_SHA,
        )
    if include_desktop:
        assets["desktop"] = SimpleNamespace(
            file=MANIFEST_DESKTOP_FILE,
            url=MANIFEST_DESKTOP_URL,
            size=129_351_432,
            sha256=MANIFEST_DESKTOP_SHA,
        )
    return SimpleNamespace(version="2026.10.26-r4", assets=assets)


def _write_apk(directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    apk = directory / "app-debug.apk"
    apk.write_bytes(b"FAKE-APK" * 1024)
    (directory / "output-metadata.json").write_text(
        json.dumps(
            {
                "elements": [
                    {
                        "versionName": "9.9.9",
                        "variantName": "debug",
                        "outputFile": "app-debug.apk",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    return apk


def _write_desktop(directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    installer = directory / "Kinship-Desktop-Setup-1.2.3-x64.exe"
    installer.write_bytes(b"FAKE-EXE" * 2048)
    return installer


@pytest.fixture(autouse=True)
def isolated_manifest_cache(monkeypatch):
    client_release_manifest.reset_cache()
    yield
    client_release_manifest.reset_cache()


@pytest.fixture
def fake_config(monkeypatch):
    def _apply(**overrides: object) -> SimpleNamespace:
        cfg = _cfg(**overrides)
        monkeypatch.setattr(clients_catalog, "get_config", lambda: cfg)
        return cfg

    return _apply


@pytest.fixture
def manifest_calls(monkeypatch):
    state = {"count": 0, "kwargs": []}

    def _loader(*args: object, **kwargs: object) -> SimpleNamespace:
        state["count"] += 1
        state["kwargs"].append(kwargs)
        return _manifest()

    monkeypatch.setattr(client_release_manifest, "_manifest_loader", _loader)
    return state


@pytest.fixture
def manifest_unavailable(monkeypatch):
    state = {"count": 0}

    def _loader(*args: object, **kwargs: object) -> SimpleNamespace:
        state["count"] += 1
        raise RuntimeError("manifest unreachable")

    monkeypatch.setattr(client_release_manifest, "_manifest_loader", _loader)
    return state


@pytest.fixture
def empty_assets(tmp_path, monkeypatch):
    ota = tmp_path / "ota-empty"
    release = tmp_path / "release-empty"
    ota.mkdir()
    release.mkdir()
    monkeypatch.setenv("OTA_FILE_DIR", str(ota))
    monkeypatch.setenv("KINSHIP_DESKTOP_RELEASE_DIR", str(release))
    return SimpleNamespace(ota=ota, release=release)


class TestPrecedence:
    def test_local_apk_wins_over_configured_and_manifest(
        self, tmp_path, monkeypatch, fake_config, manifest_calls
    ):
        apk = _write_apk(tmp_path / "ota")
        monkeypatch.setenv("OTA_FILE_DIR", str(tmp_path / "ota"))
        fake_config(
            CLIENTS_ANDROID_URL="https://example.test/configured.apk",
            CLIENTS_ANDROID_SHA256="c" * 64,
        )

        entry = clients_catalog.android_entry()

        assert entry["source"] == "local"
        assert entry["action"] == "download"
        assert entry["available"] is True
        assert entry["url"] == "/api/ota/download"
        assert entry["filename"] == "app-debug.apk"
        assert entry["download_filename"] == "Kinship-9.9.9-debug.apk"
        assert entry["expected_filename"] == "Kinship-9.9.9-debug.apk"
        assert entry["sha256"] == hashlib.sha256(apk.read_bytes()).hexdigest()
        assert entry["fallback_reason"] is None
        assert manifest_calls["count"] == 0

    def test_local_desktop_wins_over_configured(
        self, tmp_path, monkeypatch, fake_config, manifest_calls
    ):
        _write_desktop(tmp_path / "release")
        monkeypatch.setenv("KINSHIP_DESKTOP_RELEASE_DIR", str(tmp_path / "release"))
        fake_config(
            CLIENTS_DESKTOP_URL="https://example.test/Kinship-Desktop-Setup-9.9.9-x64.exe"
        )

        entry = clients_catalog.desktop_entry()

        assert entry["source"] == "local"
        assert entry["url"] == "/api/clients/desktop/download"
        assert entry["filename"] == "Kinship-Desktop-Setup-1.2.3-x64.exe"
        assert manifest_calls["count"] == 0

    def test_configured_url_wins_over_manifest(
        self, empty_assets, fake_config, manifest_calls
    ):
        fake_config(
            CLIENTS_ANDROID_URL="https://example.test/Kinship-Android-8.8.8.apk",
            CLIENTS_ANDROID_SHA256="D" * 64,
        )

        entry = clients_catalog.android_entry()

        assert entry["source"] == "configured"
        assert entry["action"] == "download"
        assert entry["url"] == "https://example.test/Kinship-Android-8.8.8.apk"
        assert entry["filename"] == "Kinship-Android-8.8.8.apk"
        assert entry["sha256"] == "d" * 64
        assert entry["version"] == "8.8.8"
        assert entry["fallback_reason"] == "local_missing"
        assert manifest_calls["count"] == 0


class TestManifest:
    def test_manifest_asset_used_when_local_and_configured_missing(
        self, empty_assets, fake_config, manifest_calls
    ):
        fake_config()

        entry = clients_catalog.android_entry()

        assert entry["source"] == "manifest"
        assert entry["action"] == "download"
        assert entry["available"] is True
        assert entry["url"] == MANIFEST_ANDROID_URL
        assert entry["filename"] == MANIFEST_ANDROID_FILE
        assert entry["download_filename"] == MANIFEST_ANDROID_FILE
        assert entry["expected_filename"] == MANIFEST_ANDROID_FILE
        assert entry["size"] == 59_178_057
        assert entry["sha256"] == MANIFEST_ANDROID_SHA
        assert entry["version"] == "1.4.2"
        assert entry["debug"] is True
        assert entry["label"] == "debug build"
        assert entry["page_url"] == PAGE_URL
        assert entry["fallback_reason"] == "local_missing,configured_missing"

    def test_manifest_loader_gets_bounded_timeout_and_no_retries(
        self, empty_assets, fake_config, manifest_calls
    ):
        fake_config()

        clients_catalog.android_entry()

        assert manifest_calls["count"] == 1
        assert manifest_calls["kwargs"][0]["timeout"] == 3.0
        assert manifest_calls["kwargs"][0]["retries"] == 0

    def test_positive_cache_prevents_refetch(
        self, empty_assets, fake_config, manifest_calls
    ):
        fake_config()

        first = clients_catalog.android_entry()
        second = clients_catalog.android_entry()

        assert first["source"] == "manifest"
        assert second["source"] == "manifest"
        assert manifest_calls["count"] == 1

    def test_negative_cache_prevents_refetch(
        self, empty_assets, fake_config, manifest_unavailable
    ):
        fake_config()

        first = clients_catalog.android_entry()
        second = clients_catalog.android_entry()

        assert first["source"] == "github"
        assert second["source"] == "github"
        assert manifest_unavailable["count"] == 1

    def test_manifest_missing_asset_falls_back_to_github(
        self, empty_assets, monkeypatch, fake_config
    ):
        fake_config()

        def _partial_loader(*args: object, **kwargs: object) -> SimpleNamespace:
            return _manifest(include_desktop=False)

        monkeypatch.setattr(
            client_release_manifest, "_manifest_loader", _partial_loader
        )

        entry = clients_catalog.desktop_entry()

        assert entry["source"] == "github"
        assert entry["fallback_reason"].endswith("manifest_asset_missing")


class TestFallbacks:
    def test_manifest_failure_falls_back_to_github_page(
        self, empty_assets, fake_config, manifest_unavailable
    ):
        fake_config()

        entry = clients_catalog.android_entry()

        assert entry["available"] is True
        assert entry["source"] == "github"
        assert entry["action"] == "external"
        assert entry["url"] == PAGE_URL
        assert entry["page_url"] == PAGE_URL
        assert entry["filename"] is None
        assert entry["download_filename"] is None
        assert entry["fallback_reason"].endswith("manifest_RuntimeError")

    def test_github_latest_when_tag_empty(
        self, empty_assets, fake_config, manifest_unavailable
    ):
        fake_config(CLIENTS_GITHUB_RELEASE_TAG="")

        entry = clients_catalog.desktop_entry()

        assert entry["source"] == "github"
        assert entry["page_url"] == "https://github.com/Xehuri/kinship/releases/latest"

    def test_none_state_keeps_github_page_url(
        self, empty_assets, fake_config, manifest_unavailable
    ):
        fake_config(CLIENTS_GITHUB_RELEASE_BASE="")

        entry = clients_catalog.android_entry()

        assert entry["available"] is False
        assert entry["source"] == "none"
        assert entry["action"] == "none"
        assert entry["url"] is None
        assert entry["page_url"] == "https://github.com/Xehuri/kinship/releases"
        assert entry["fallback_reason"].endswith("github_page_unavailable")

    def test_catalog_entries_expose_full_contract(self, tmp_path, monkeypatch, fake_config):
        _write_apk(tmp_path / "ota")
        _write_desktop(tmp_path / "release")
        monkeypatch.setenv("OTA_FILE_DIR", str(tmp_path / "ota"))
        monkeypatch.setenv("KINSHIP_DESKTOP_RELEASE_DIR", str(tmp_path / "release"))
        fake_config()

        result = clients_catalog.catalog()

        expected_keys = {
            "kind",
            "available",
            "action",
            "source",
            "url",
            "page_url",
            "filename",
            "download_filename",
            "expected_filename",
            "size",
            "sha256",
            "version",
            "variant",
            "debug",
            "label",
            "fallback_reason",
        }
        for kind in ("android", "desktop"):
            assert expected_keys <= set(result[kind])
            assert result[kind]["source"] == "local"
            assert result[kind]["page_url"] == PAGE_URL
