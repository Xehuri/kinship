# -*- coding: utf-8 -*-
"""T6: frontend dist self-heal (missing -> background download, never overwrite)."""
from __future__ import annotations

import asyncio
import hashlib
import io
import json
import logging
import tarfile
import urllib.error
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI

import main
from services import release_assets as ra


class FakeResponse:
    def __init__(self, body: bytes, status: int = 200):
        self._body = io.BytesIO(body)
        self.status = status
        self.headers = {}

    def read(self, size: int = -1) -> bytes:
        return self._body.read(size)

    def close(self) -> None:
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


@pytest.fixture(autouse=True)
def _forbid_real_network(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("real network access is forbidden in tests")

    monkeypatch.setattr(ra, "_urlopen", forbidden)


def _frontend_tar() -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        payload = b"<!doctype html><title>Kinship</title>"
        info = tarfile.TarInfo("dist/index.html")
        info.size = len(payload)
        tar.addfile(info, io.BytesIO(payload))
        info = tarfile.TarInfo("dist/assets/app.js")
        info.size = 4
        tar.addfile(info, io.BytesIO(b"app!"))
    return buffer.getvalue()


def _manifest_body(blob: bytes) -> bytes:
    return json.dumps(
        {
            "schema": 1,
            "product": "kinship",
            "version": "2026.10.26",
            "assets": {
                "frontend": {
                    "file": "frontend.tar.gz",
                    "sha256": hashlib.sha256(blob).hexdigest(),
                    "size": len(blob),
                }
            },
        }
    ).encode()


def _opener(manifest: bytes, blob: bytes):
    def open_url(request, timeout):
        if request.full_url.endswith("release-manifest.json"):
            return FakeResponse(manifest)
        if request.full_url.endswith("frontend.tar.gz"):
            return FakeResponse(blob)
        raise AssertionError(f"unexpected URL: {request.full_url}")

    return open_url


def test_existing_dist_is_present_and_untouched(tmp_path):
    dist = tmp_path / "frontend" / "mobile" / "dist"
    dist.mkdir(parents=True)
    (dist / "index.html").write_text("original")
    result = ra.ensure_frontend_dist(tmp_path)
    assert result["status"] == "present"
    assert (dist / "index.html").read_text() == "original"
    assert not (dist / "assets").exists()


def test_env_kill_switch_disables_download(tmp_path, monkeypatch):
    monkeypatch.setenv(ra.FRONTEND_ENV_KILL_SWITCH, "0")
    result = ra.ensure_frontend_dist(tmp_path)
    assert result["status"] == "disabled"
    assert result["reason"] == "env"
    assert not (tmp_path / "frontend" / "mobile" / "dist").exists()


def test_config_switch_disables_download(tmp_path, monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger=ra.__name__)
    monkeypatch.delenv(ra.FRONTEND_ENV_KILL_SWITCH, raising=False)
    monkeypatch.setattr(
        "config.config.get_config",
        lambda: SimpleNamespace(ONBOARDING_FRONTEND_AUTODOWNLOAD=False),
    )
    result = ra.ensure_frontend_dist(tmp_path)
    assert result["status"] == "disabled"
    assert result["reason"] == "config_disabled"
    assert "[FrontendAssets] missing" in caplog.text
    assert not (tmp_path / "frontend" / "mobile" / "dist").exists()


def test_missing_dist_downloads_and_installs(tmp_path, monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger=ra.__name__)
    blob = _frontend_tar()
    monkeypatch.setattr(ra, "_urlopen", _opener(_manifest_body(blob), blob))
    result = ra.ensure_frontend_dist(
        tmp_path,
        manifest_url="https://example.com/release-manifest.json",
        retries=0,
        sleep=lambda seconds: None,
    )
    dist = tmp_path / "frontend" / "mobile" / "dist"
    assert result["status"] == "ok"
    assert (dist / "index.html").is_file()
    assert (dist / "assets" / "app.js").read_bytes() == b"app!"
    assert "[FrontendAssets] missing" in caplog.text
    assert "attempt=1" in caplog.text
    assert "result=ok" in caplog.text
    assert not list((tmp_path / "frontend" / "mobile").glob(".dist-download-*"))


def test_missing_dist_failure_leaves_api_only(tmp_path, monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger=ra.__name__)

    def failing(request, timeout):
        raise urllib.error.HTTPError(request.full_url, 500, "boom", {}, io.BytesIO())

    monkeypatch.setattr(ra, "_urlopen", failing)
    result = ra.ensure_frontend_dist(
        tmp_path,
        manifest_url="https://example.com/release-manifest.json",
        retries=1,
        backoff=(0,),
        sleep=lambda seconds: None,
    )
    assert result["status"] == "failed"
    assert result["api_only"] is True
    assert result["error"] == "manifest_http_error"
    assert "[FrontendAssets] result=failed" in caplog.text
    assert not (tmp_path / "frontend" / "mobile" / "dist").exists()


def test_install_disk_precheck_fails_early(tmp_path, monkeypatch):
    asset = ra.Asset(
        name="frontend",
        file="frontend.tar.gz",
        sha256="0" * 64,
        url="https://example.com/frontend.tar.gz",
        size=1000,
    )
    monkeypatch.setattr(
        ra.shutil, "disk_usage", lambda path: SimpleNamespace(free=10)
    )
    with pytest.raises(ra.ReleaseAssetError) as excinfo:
        ra.install_frontend_asset(asset, tmp_path)
    assert excinfo.value.code == "insufficient_disk"
    assert not (tmp_path / "frontend" / "mobile" / "dist").exists()


def test_install_refuses_existing_dist(tmp_path):
    dist = tmp_path / "frontend" / "mobile" / "dist"
    dist.mkdir(parents=True)
    (dist / "index.html").write_text("keep-me")
    asset = ra.Asset(
        name="frontend",
        file="frontend.tar.gz",
        sha256="0" * 64,
        url="https://example.com/frontend.tar.gz",
        size=10,
    )
    with pytest.raises(ra.ReleaseAssetError) as excinfo:
        ra.install_frontend_asset(asset, tmp_path)
    assert excinfo.value.code == "frontend_dist_present"
    assert (dist / "index.html").read_text() == "keep-me"


def test_missing_frontend_asset_fails_without_writes(tmp_path, monkeypatch):
    manifest = json.dumps(
        {
            "schema": 1,
            "product": "kinship",
            "version": "1",
            "assets": {
                "kernel": {
                    "file": "kernel.tar.gz",
                    "sha256": "0" * 64,
                    "size": 1,
                }
            },
        }
    ).encode()
    monkeypatch.setattr(ra, "_urlopen", _opener(manifest, b""))
    result = ra.ensure_frontend_dist(
        tmp_path,
        manifest_url="https://example.com/release-manifest.json",
        retries=0,
        sleep=lambda seconds: None,
    )
    assert result["status"] == "failed"
    assert result["error"] == "frontend_asset_missing"
    assert not (tmp_path / "frontend" / "mobile" / "dist").exists()


def test_main_hook_registers_background_task(monkeypatch):
    sentinel = object()
    monkeypatch.setattr(ra, "start_frontend_self_heal", lambda: sentinel)
    app = FastAPI()
    asyncio.run(main._start_frontend_self_heal(app))
    assert app.state.frontend_self_heal_task is sentinel
