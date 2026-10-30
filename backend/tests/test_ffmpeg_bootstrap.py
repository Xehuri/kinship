# -*- coding: utf-8 -*-
"""ffmpeg_bootstrap: wheel 复制、幂等、缺失依赖报错与目录覆盖。"""
from __future__ import annotations

import stat
import sys
from pathlib import Path

import pytest

from services import ffmpeg_bootstrap


class _FakeImageio:
    def __init__(self, exe: Path) -> None:
        self.exe = exe
        self.calls = 0

    def get_ffmpeg_exe(self) -> str:
        self.calls += 1
        return str(self.exe)


def _stageable_source(tmp_path: Path) -> Path:
    name = "ffmpeg.exe" if sys.platform == "win32" else "ffmpeg"
    source = tmp_path / "wheel" / name
    source.parent.mkdir(parents=True)
    source.write_bytes(b"#!/bin/sh\necho fake-ffmpeg\n")
    if sys.platform != "win32":
        source.chmod(0o644)
    return source


def _staged_path(bin_dir: Path) -> Path:
    return bin_dir / ("ffmpeg.exe" if sys.platform == "win32" else "ffmpeg")


def test_first_call_copies_then_second_call_is_noop(tmp_path, monkeypatch):
    monkeypatch.delenv(ffmpeg_bootstrap.BIN_DIR_ENV, raising=False)
    source = _stageable_source(tmp_path)
    fake = _FakeImageio(source)
    bin_dir = tmp_path / "bin"

    first = ffmpeg_bootstrap.ensure_ffmpeg(bin_dir=bin_dir, imageio_ffmpeg_module=fake)

    assert first == _staged_path(bin_dir)
    assert first.read_bytes() == source.read_bytes()
    assert fake.calls == 1
    if sys.platform != "win32":
        assert first.stat().st_mode & stat.S_IXUSR

    mtime = first.stat().st_mtime_ns
    second = ffmpeg_bootstrap.ensure_ffmpeg(bin_dir=bin_dir, imageio_ffmpeg_module=fake)

    assert second == first
    assert fake.calls == 1
    assert first.stat().st_mtime_ns == mtime


def test_existing_executable_is_returned_without_touching_wheel(tmp_path, monkeypatch):
    monkeypatch.delenv(ffmpeg_bootstrap.BIN_DIR_ENV, raising=False)
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    existing = _staged_path(bin_dir)
    existing.write_bytes(b"#!/bin/sh\nexit 0\n")
    existing.chmod(0o755)
    fake = _FakeImageio(tmp_path / "missing-source")

    got = ffmpeg_bootstrap.ensure_ffmpeg(bin_dir=bin_dir, imageio_ffmpeg_module=fake)

    assert got == existing
    assert fake.calls == 0


def test_missing_module_raises_readable_ffmpeg_missing(tmp_path, monkeypatch):
    monkeypatch.delenv(ffmpeg_bootstrap.BIN_DIR_ENV, raising=False)
    real_import_module = ffmpeg_bootstrap.importlib.import_module

    def _boom(name: str, package=None):
        if name == "imageio_ffmpeg":
            raise ImportError(f"No module named {name!r}")
        return real_import_module(name, package)

    monkeypatch.setattr(ffmpeg_bootstrap.importlib, "import_module", _boom)

    with pytest.raises(ffmpeg_bootstrap.FFmpegMissing) as excinfo:
        ffmpeg_bootstrap.ensure_ffmpeg(bin_dir=tmp_path / "bin")

    message = str(excinfo.value)
    assert message.startswith("ffmpeg_missing:")
    assert "imageio-ffmpeg" in message


def test_env_override_redirects_staging_dir(tmp_path, monkeypatch):
    source = _stageable_source(tmp_path)
    fake = _FakeImageio(source)
    bin_dir = tmp_path / "override-bin"
    monkeypatch.setenv(ffmpeg_bootstrap.BIN_DIR_ENV, str(bin_dir))

    got = ffmpeg_bootstrap.ensure_ffmpeg(imageio_ffmpeg_module=fake)

    assert got == _staged_path(bin_dir)
    assert got.is_file()
