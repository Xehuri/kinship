# -*- coding: utf-8 -*-
"""T6: release manifest, verified download and safe extraction."""
from __future__ import annotations

import hashlib
import io
import json
import logging
import tarfile
import threading
import urllib.error
from pathlib import Path

import pytest

from services import release_assets as ra


class FakeResponse:
    def __init__(self, body: bytes, status: int = 200, headers: dict | None = None):
        self._body = io.BytesIO(body)
        self.status = status
        self.headers = headers or {}

    def read(self, size: int = -1) -> bytes:
        return self._body.read(size)

    def close(self) -> None:
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


class ChunkedResponse(FakeResponse):
    def __init__(self, chunks: list[bytes], status: int = 200, headers: dict | None = None):
        super().__init__(b"", status=status, headers=headers)
        self._chunks = list(chunks)
        self.reads = 0

    def read(self, size: int = -1) -> bytes:
        self.reads += 1
        if not self._chunks:
            return b""
        chunk = self._chunks.pop(0)
        if size >= 0:
            chunk = chunk[:size]
        return chunk


@pytest.fixture(autouse=True)
def _forbid_real_network(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("real network access is forbidden in tests")

    monkeypatch.setattr(ra, "_urlopen", forbidden)


def _manifest_payload(body: bytes, **overrides) -> dict:
    asset = {
        "file": "asset.tar.gz",
        "sha256": hashlib.sha256(body).hexdigest(),
        "size": len(body),
    }
    asset.update(overrides)
    return {
        "schema": 1,
        "product": "kinship",
        "version": "2026.10.26",
        "assets": {"frontend": asset},
    }


def _open_routes(routes: dict[str, bytes], calls: list[str] | None = None):
    def opener(request, timeout):
        url = request.full_url
        if calls is not None:
            calls.append(url)
        clean = url.split("?", 1)[0]
        for suffix, body in routes.items():
            if clean.endswith(suffix):
                return FakeResponse(body)
        raise AssertionError(f"unexpected URL: {url}")

    return opener


def _asset(body: bytes, *, url: str = "https://example.com/asset.tar.gz") -> ra.Asset:
    return ra.Asset(
        name="frontend",
        file="asset.tar.gz",
        sha256=hashlib.sha256(body).hexdigest(),
        url=url,
        size=len(body),
    )


def _make_tar(path: Path, members: list[tuple[str, bytes | None, str, str]]) -> Path:
    with tarfile.open(path, "w:gz") as tar:
        for name, data, kind, linkname in members:
            info = tarfile.TarInfo(name)
            if kind == "dir":
                info.type = tarfile.DIRTYPE
                info.mode = 0o755
                tar.addfile(info)
            elif kind == "sym":
                info.type = tarfile.SYMTYPE
                info.linkname = linkname
                tar.addfile(info)
            elif kind == "hard":
                info.type = tarfile.LNKTYPE
                info.linkname = linkname
                tar.addfile(info)
            else:
                payload = data or b""
                info.size = len(payload)
                tar.addfile(info, io.BytesIO(payload))
    return path


def test_load_manifest_resolves_asset_urls(monkeypatch):
    body = b"payload"
    manifest_url = "https://example.com/releases/v1/release-manifest.json"
    monkeypatch.setattr(
        ra, "_urlopen", _open_routes({"release-manifest.json": json.dumps(_manifest_payload(body)).encode()})
    )
    manifest = ra.load_manifest(manifest_url)
    assert manifest.product == "kinship"
    assert manifest.version == "2026.10.26"
    asset = manifest.assets["frontend"]
    assert asset.url == "https://example.com/releases/v1/asset.tar.gz"
    assert asset.sha256 == hashlib.sha256(body).hexdigest()
    assert "source" not in manifest.public()


def test_load_manifest_base_url_uses_default_name(monkeypatch):
    calls: list[str] = []
    body = b"payload"
    monkeypatch.setattr(
        ra,
        "_urlopen",
        _open_routes(
            {"release-manifest.json": json.dumps(_manifest_payload(body)).encode()},
            calls,
        ),
    )
    manifest = ra.load_manifest(base_url="https://example.com/releases/v1/")
    assert calls == ["https://example.com/releases/v1/release-manifest.json"]
    assert manifest.assets["frontend"].url == "https://example.com/releases/v1/asset.tar.gz"


def test_load_manifest_404_clear_error(monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger=ra.__name__)

    def opener(request, timeout):
        raise urllib.error.HTTPError(request.full_url, 404, "not found", {}, io.BytesIO())

    monkeypatch.setattr(ra, "_urlopen", opener)
    with pytest.raises(ra.ManifestError) as excinfo:
        ra.load_manifest("https://example.com/release-manifest.json", retries=0)
    assert excinfo.value.code == "manifest_not_found"
    assert "result=failed" in caplog.text
    assert "https://" not in caplog.text


def test_load_manifest_requires_https():
    with pytest.raises(ra.ReleaseConfigError) as excinfo:
        ra.load_manifest("http://example.com/release-manifest.json")
    assert excinfo.value.code == "insecure_url"


def test_load_manifest_uses_builtin_default(monkeypatch):
    body = b"payload"
    calls: list[str] = []
    monkeypatch.setattr(
        ra,
        "_urlopen",
        _open_routes(
            {"release-manifest.json": json.dumps(_manifest_payload(body)).encode()},
            calls,
        ),
    )
    manifest = ra.load_manifest(None)
    assert calls == [ra.DEFAULT_MANIFEST_URL]
    assert (
        ra.DEFAULT_MANIFEST_URL
        == "https://github.com/Xehuri/kinship/releases/latest/download/release-manifest.json"
    )
    assert (
        manifest.assets["frontend"].url
        == "https://github.com/Xehuri/kinship/releases/latest/download/asset.tar.gz"
    )


def test_resolve_manifest_url_keeps_explicit_precedence():
    url, base = ra.resolve_manifest_url(
        "https://mirror.example.com/releases/v2/release-manifest.json",
        "https://assets.example.com/v2",
    )
    assert url == "https://mirror.example.com/releases/v2/release-manifest.json"
    assert base == "https://assets.example.com/v2/"
    default_url, default_base = ra.resolve_manifest_url(None, None)
    assert default_url == ra.DEFAULT_MANIFEST_URL
    assert default_base == "https://github.com/Xehuri/kinship/releases/latest/download/"


def test_resolve_manifest_url_preserves_nested_mirror_double_slash():
    manifest_url = (
        "https://ghfast.top/https://github.com/Xehuri/kinship/releases/"
        "latest/download/release-manifest.json"
    )
    url, base = ra.resolve_manifest_url(manifest_url)
    assert url == manifest_url
    assert base == (
        "https://ghfast.top/https://github.com/Xehuri/kinship/releases/"
        "latest/download/"
    )


def test_load_manifest_nested_mirror_name_resolves_asset_to_github_path(monkeypatch):
    body = b"payload"
    manifest_url = (
        "https://ghfast.top/https://github.com/Xehuri/kinship/releases/"
        "latest/download/release-manifest.json"
    )
    calls: list[str] = []
    monkeypatch.setattr(
        ra,
        "_urlopen",
        _open_routes(
            {"release-manifest.json": json.dumps(_manifest_payload(body)).encode()},
            calls,
        ),
    )
    manifest = ra.load_manifest(manifest_url, retries=0)
    assert calls == [manifest_url]
    asset = manifest.assets["frontend"]
    assert asset.url == (
        "https://ghfast.top/https://github.com/Xehuri/kinship/releases/"
        "latest/download/asset.tar.gz"
    )
    assert asset.mirror_urls == ()


def test_load_manifest_default_falls_back_to_ghfast(monkeypatch):
    body = b"payload"
    official = ra.DEFAULT_MANIFEST_URL
    ghfast = "https://ghfast.top/" + official
    calls: list[str] = []
    delays: list[float] = []

    def opener(request, timeout):
        calls.append(request.full_url)
        if request.full_url == ghfast:
            return FakeResponse(json.dumps(_manifest_payload(body)).encode())
        raise urllib.error.URLError("github unreachable")

    monkeypatch.setattr(ra, "_urlopen", opener)
    manifest = ra.load_manifest(None, sleep=delays.append)
    assert calls == [official, ghfast]
    assert delays == []
    assert manifest.source == ghfast
    assert manifest.assets["frontend"].url == (
        "https://ghfast.top/https://github.com/Xehuri/kinship/releases/"
        "latest/download/asset.tar.gz"
    )


@pytest.mark.parametrize(
    "overrides",
    [
        {"sha256": "not-a-hash"},
        {"file": "../escape.tar.gz"},
        {"size": -1},
        {"file": "/absolute.tar.gz"},
    ],
)
def test_parse_manifest_rejects_invalid_schema(overrides):
    payload = _manifest_payload(b"payload", **overrides)
    with pytest.raises(ra.ManifestError) as excinfo:
        ra.parse_manifest(payload, source="https://example.com/release-manifest.json")
    assert excinfo.value.code == "manifest_invalid_schema"


def test_download_verifies_sha_and_cleans_part(monkeypatch, tmp_path):
    body = b"x" * (300 * 1024)
    asset = _asset(body)
    monkeypatch.setattr(ra, "_urlopen", _open_routes({asset.file: body}))
    dest = tmp_path / "asset.bin"
    result = ra.download_asset(asset, dest, retries=0)
    assert result["bytes"] == len(body)
    assert result["sha256"] == asset.sha256
    assert dest.read_bytes() == body
    assert not dest.with_name(dest.name + ".part").exists()


def test_download_sha_mismatch_deletes_and_does_not_install(monkeypatch, tmp_path):
    body = b"payload"
    asset = ra.Asset(
        name="frontend",
        file="asset.tar.gz",
        sha256=hashlib.sha256(b"different").hexdigest(),
        url="https://example.com/asset.tar.gz",
        size=len(body),
    )
    monkeypatch.setattr(ra, "_urlopen", _open_routes({asset.file: body}))
    dest = tmp_path / "asset.bin"
    with pytest.raises(ra.IntegrityError) as excinfo:
        ra.download_asset(asset, dest, retries=0)
    assert excinfo.value.code == "sha256_mismatch"
    assert not dest.exists()
    assert not dest.with_name(dest.name + ".part").exists()
    assert not any(tmp_path.iterdir())


def test_download_size_mismatch_rejected(monkeypatch, tmp_path):
    body = b"actual"
    asset = ra.Asset(
        name="frontend",
        file="asset.tar.gz",
        sha256=hashlib.sha256(body).hexdigest(),
        url="https://example.com/asset.tar.gz",
        size=len(body) + 1,
    )
    monkeypatch.setattr(ra, "_urlopen", _open_routes({asset.file: body}))
    dest = tmp_path / "asset.bin"
    with pytest.raises(ra.IntegrityError) as excinfo:
        ra.download_asset(asset, dest, retries=0)
    assert excinfo.value.code == "size_mismatch"
    assert not dest.exists()


def test_download_cancel_stops_within_one_chunk(monkeypatch, tmp_path):
    chunks = [b"a" * (ra.CHUNK_SIZE), b"b" * (ra.CHUNK_SIZE)]
    body = b"".join(chunks)
    asset = _asset(body)
    response = ChunkedResponse(chunks)
    monkeypatch.setattr(ra, "_urlopen", lambda request, timeout: response)
    cancel = threading.Event()
    dest = tmp_path / "asset.bin"

    def progress(done, total):
        cancel.set()

    with pytest.raises(ra.DownloadCancelled):
        ra.download_asset(
            asset, dest, progress=progress, cancel_event=cancel, retries=0
        )
    assert response.reads == 1
    assert not dest.exists()
    assert not dest.with_name(dest.name + ".part").exists()


def test_download_progress_logs_have_no_url_or_secret(monkeypatch, tmp_path, caplog):
    caplog.set_level(logging.INFO, logger=ra.__name__)
    body = b"secret-body"
    asset = ra.Asset(
        name="frontend",
        file="asset.tar.gz",
        sha256=hashlib.sha256(body).hexdigest(),
        url="https://example.com/asset.tar.gz?token=SUPERSECRET",
        size=len(body),
    )
    monkeypatch.setattr(ra, "_urlopen", _open_routes({asset.file: body}))
    ra.download_asset(asset, tmp_path / "asset.bin", retries=0)
    assert "phase=download asset=frontend" in caplog.text
    assert "bytes=11/11" in caplog.text
    assert "pct=100" in caplog.text
    assert "result=ok" in caplog.text
    assert "SUPERSECRET" not in caplog.text
    assert "Authorization" not in caplog.text


class FailingStreamResponse(FakeResponse):
    def __init__(self, chunks: list[bytes], error: Exception):
        super().__init__(b"")
        self._chunks = list(chunks)
        self._error = error

    def read(self, size: int = -1) -> bytes:
        if not self._chunks:
            raise self._error
        chunk = self._chunks[0]
        if size >= 0 and len(chunk) > size:
            self._chunks[0] = chunk[size:]
            return chunk[:size]
        return self._chunks.pop(0)


def test_download_partial_stream_failure_logs_snapshot_and_cleans_part(
    monkeypatch, tmp_path, caplog
):
    caplog.set_level(logging.INFO, logger=ra.__name__)
    body = b"x" * (2 * 1024 * 1024)
    asset = _asset(body)
    response = FailingStreamResponse(
        [b"x" * (1024 * 1024)], ConnectionResetError("connection reset")
    )
    monkeypatch.setattr(ra, "_urlopen", lambda request, timeout: response)
    dest = tmp_path / "asset.bin"

    with pytest.raises(ra.DownloadError) as excinfo:
        ra.download_asset(asset, dest, retries=0)

    assert excinfo.value.code == "download_stream_failed"
    assert excinfo.value.downloaded_bytes == 1024 * 1024
    assert excinfo.value.total_bytes == len(body)
    assert not dest.exists()
    assert not dest.with_name(dest.name + ".part").exists()
    assert "snapshot=已下载 1.00 MB / 总 2.00 MB" in caplog.text
    assert "url=https://example.com/asset.tar.gz" in caplog.text
    assert "error=download_stream_failed" in caplog.text
    assert "detail=stream failed: ConnectionResetError" in caplog.text


def test_download_retries_transient_error(monkeypatch, tmp_path):
    body = b"retry-body"
    asset = _asset(body)
    attempts = {"count": 0}

    def opener(request, timeout):
        attempts["count"] += 1
        if attempts["count"] == 1:
            raise urllib.error.URLError("temporary")
        return FakeResponse(body)

    monkeypatch.setattr(ra, "_urlopen", opener)
    dest = tmp_path / "asset.bin"
    ra.download_asset(
        asset, dest, retries=1, backoff=(0,), sleep=lambda seconds: None
    )
    assert attempts["count"] == 2
    assert dest.read_bytes() == body


def _mirror_asset(body: bytes, mirror_count: int = 2) -> tuple[ra.Asset, str, tuple[str, ...]]:
    canonical = (
        "https://github.com/Xehuri/kinship/releases/latest/download/asset.tar.gz"
    )
    mirrors = tuple(
        prefix + canonical for prefix in ra.GITHUB_MIRROR_PREFIXES[:mirror_count]
    )
    asset = ra.Asset(
        name="frontend",
        file="asset.tar.gz",
        sha256=hashlib.sha256(body).hexdigest(),
        url=canonical,
        size=len(body),
        mirror_urls=mirrors,
    )
    return asset, canonical, mirrors


def test_download_asset_prefers_mirror_and_skips_canonical(monkeypatch, tmp_path):
    body = b"mirror-body"
    asset, _canonical, mirrors = _mirror_asset(body)
    calls: list[str] = []

    def opener(request, timeout):
        calls.append(request.full_url)
        if request.full_url == mirrors[0]:
            return FakeResponse(body)
        raise AssertionError(f"unexpected URL: {request.full_url}")

    monkeypatch.setattr(ra, "_urlopen", opener)
    dest = tmp_path / "asset.bin"
    result = ra.download_asset(asset, dest, retries=3)
    assert calls == [mirrors[0]]
    assert dest.read_bytes() == body
    assert result["source"] == "ghfast.top"
    assert not dest.with_name(dest.name + ".part").exists()


def test_download_asset_falls_back_to_canonical(monkeypatch, tmp_path, caplog):
    caplog.set_level(logging.INFO, logger=ra.__name__)
    body = b"canonical-body"
    asset, canonical, mirrors = _mirror_asset(body)
    calls: list[str] = []

    def opener(request, timeout):
        calls.append(request.full_url)
        if request.full_url == canonical:
            return FakeResponse(body)
        raise urllib.error.URLError("mirror down")

    monkeypatch.setattr(ra, "_urlopen", opener)
    dest = tmp_path / "asset.bin"
    result = ra.download_asset(asset, dest, retries=3, sleep=lambda seconds: None)
    assert calls == [*mirrors, canonical]
    assert dest.read_bytes() == body
    assert result["source"] == "github.com"
    assert "result=fallback" in caplog.text
    assert "host=ghfast.top" in caplog.text
    assert "https://" not in caplog.text
    assert not dest.with_name(dest.name + ".part").exists()


def test_download_asset_mirror_checksum_mismatch_falls_through(monkeypatch, tmp_path):
    body = b"good-body"
    corrupt = b"evil-body"
    assert len(corrupt) == len(body)
    asset, _canonical, mirrors = _mirror_asset(body)
    calls: list[str] = []

    def opener(request, timeout):
        calls.append(request.full_url)
        if request.full_url == mirrors[0]:
            return FakeResponse(corrupt)
        if request.full_url == mirrors[1]:
            return FakeResponse(body)
        raise AssertionError(f"unexpected URL: {request.full_url}")

    monkeypatch.setattr(ra, "_urlopen", opener)
    dest = tmp_path / "asset.bin"
    result = ra.download_asset(asset, dest, retries=0)
    assert calls == [mirrors[0], mirrors[1]]
    assert dest.read_bytes() == body
    assert result["source"] == "gh-proxy.com"
    assert not dest.with_name(dest.name + ".part").exists()


def test_extract_tarball_atomic(tmp_path):
    archive = _make_tar(
        tmp_path / "asset.tar.gz",
        [
            ("dist", None, "dir", ""),
            ("dist/index.html", b"<html>ok</html>", "file", ""),
        ],
    )
    dest = tmp_path / "installed"
    result = ra.extract_tarball(archive, dest)
    assert result["files"] == 1
    assert (dest / "dist" / "index.html").read_text() == "<html>ok</html>"
    assert not any(tmp_path.glob(".installed.staging-*"))


def test_extract_skips_root_directory_entry(tmp_path):
    archive = _make_tar(
        tmp_path / "asset.tar.gz",
        [
            (".", None, "dir", ""),
            ("./dist/index.html", b"<html>ok</html>", "file", ""),
        ],
    )
    dest = tmp_path / "installed"
    ra.extract_tarball(archive, dest)
    assert (dest / "dist" / "index.html").read_text() == "<html>ok</html>"


def test_extract_rejects_traversal(tmp_path):
    archive = _make_tar(
        tmp_path / "asset.tar.gz", [("../escape.txt", b"owned", "file", "")]
    )
    dest = tmp_path / "installed"
    with pytest.raises(ra.ExtractionError) as excinfo:
        ra.extract_tarball(archive, dest)
    assert excinfo.value.code == "archive_path_traversal"
    assert not (tmp_path / "escape.txt").exists()
    assert not dest.exists()
    assert not any(tmp_path.glob(".installed.staging-*"))


def test_extract_rejects_absolute_path(tmp_path):
    archive = _make_tar(
        tmp_path / "asset.tar.gz", [("/tmp/owned", b"owned", "file", "")]
    )
    with pytest.raises(ra.ExtractionError) as excinfo:
        ra.extract_tarball(archive, tmp_path / "installed")
    assert excinfo.value.code == "archive_absolute_path"


def test_extract_rejects_symlink_escape(tmp_path):
    archive = _make_tar(
        tmp_path / "asset.tar.gz",
        [("link", None, "sym", "../../etc/passwd")],
    )
    dest = tmp_path / "installed"
    with pytest.raises(ra.ExtractionError) as excinfo:
        ra.extract_tarball(archive, dest)
    assert excinfo.value.code == "archive_symlink_escape"
    assert not dest.exists()


def test_extract_rejects_size_limit(tmp_path):
    archive = _make_tar(
        tmp_path / "asset.tar.gz", [("big.bin", b"x" * 100, "file", "")]
    )
    with pytest.raises(ra.ExtractionError) as excinfo:
        ra.extract_tarball(archive, tmp_path / "installed", max_bytes=10)
    assert excinfo.value.code == "archive_too_large"


def test_extract_never_overwrites_by_default(tmp_path):
    dest = tmp_path / "installed"
    dest.mkdir()
    (dest / "keep.txt").write_text("keep")
    archive = _make_tar(tmp_path / "asset.tar.gz", [("new.txt", b"new", "file", "")])
    with pytest.raises(ra.ExtractionError) as excinfo:
        ra.extract_tarball(archive, dest)
    assert excinfo.value.code == "destination_exists"
    assert (dest / "keep.txt").read_text() == "keep"
    assert not (dest / "new.txt").exists()
