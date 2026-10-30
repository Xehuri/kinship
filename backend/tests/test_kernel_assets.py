# -*- coding: utf-8 -*-
"""T6: passive kernel inspection and guarded release-package install."""
from __future__ import annotations

import hashlib
import io
import json
import os
import subprocess
import tarfile
from pathlib import Path
from types import SimpleNamespace

import pytest

from services import kernel_assets as ka
from services import release_assets as ra
from services.release_assets import Asset, IntegrityError, ReleaseManifest


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


def _kernel_tar(version: str = "2026.10.26") -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        init = b"API_VERSION = '1.0.0'\n"
        info = tarfile.TarInfo("axeuh_kernel/__init__.py")
        info.size = len(init)
        tar.addfile(info, io.BytesIO(init))
        build = json.dumps({"package_version": version}).encode()
        info = tarfile.TarInfo("BUILD_INFO.json")
        info.size = len(build)
        tar.addfile(info, io.BytesIO(build))
    return buffer.getvalue()


def _manifest(blob: bytes, *, sha256: str | None = None, size: int | None = None) -> ReleaseManifest:
    asset = Asset(
        name="kernel",
        file="kernel.tar.gz",
        sha256=sha256 or hashlib.sha256(blob).hexdigest(),
        url="https://example.com/kernel.tar.gz",
        size=len(blob) if size is None else size,
    )
    return ReleaseManifest(
        schema=1,
        product="kinship",
        version="2026.10.26",
        assets={"kernel": asset},
        source="https://example.com/release-manifest.json",
        base_url="https://example.com/",
    )


def _opener(blob: bytes):
    def open_url(request, timeout):
        if request.full_url.endswith("kernel.tar.gz"):
            return FakeResponse(blob)
        raise AssertionError(f"unexpected URL: {request.full_url}")

    return open_url


def _fake_python(root: Path) -> Path:
    path = root / "kernel-python"
    path.write_text("#!/bin/sh\n")
    return path


def test_inspect_never_spawns(tmp_path, monkeypatch):
    fake_python = _fake_python(tmp_path)
    root = tmp_path / "project"
    package = root / "kernel" / "axeuh_kernel"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text("API_VERSION = '1.2.3'\n")
    models = tmp_path / "models"
    models.mkdir()

    def forbidden(*args, **kwargs):
        raise AssertionError("inspect must not spawn or call the kernel client")

    monkeypatch.setattr(subprocess, "Popen", forbidden)
    monkeypatch.setattr(subprocess, "run", forbidden)
    from services import kernel_client as kc

    monkeypatch.setattr(kc.KernelClient, "ensure", forbidden)
    monkeypatch.setattr(kc.KernelClient, "available", forbidden)

    result = ka.inspect(
        root,
        state_dir=tmp_path / "state",
        kernel_python=str(fake_python),
        model_dir=str(models),
        python_candidates=(),
        sys_executable=str(fake_python),
        disk_usage=lambda path: SimpleNamespace(free=10**9),
    )
    assert result["kernel"]["present"] is True
    assert result["kernel"]["source"] == "source"
    assert result["kernel"]["version"] == "1.2.3"
    assert result["kernel"]["installable"] is False
    assert result["kernel"]["install_blocked_reason"] == "kernel_install_forbidden_dev_checkout"
    assert result["python"]["path"] == str(fake_python)
    assert result["python"]["exists"] is True
    assert result["models"]["exists"] is True
    assert result["disk"]["free"] == 10**9
    assert result["health"]["found"] is False
    assert result["health"]["error"] == "pidfile_missing"


def test_inspect_default_model_dir_uses_models_root(tmp_path, monkeypatch):
    models_root = tmp_path / "models-root"
    monkeypatch.setenv("AXEUH_MODELS_DIR", str(models_root))
    root = tmp_path / "project"
    root.mkdir()
    fake_python = _fake_python(tmp_path)

    result = ka.inspect(
        root,
        state_dir=tmp_path / "state",
        kernel_python=str(fake_python),
        model_dir="",
        python_candidates=(),
        sys_executable=str(fake_python),
        disk_usage=lambda path: SimpleNamespace(free=10**9),
    )

    assert result["models"]["configured"] is False
    assert result["models"]["model_dir"] == str(
        models_root / ".cache" / "axeuh-kernel" / "models"
    )


def test_resolve_kernel_python_precedence(tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    configured = _fake_python(tmp_path)
    env_python = tmp_path / "env-python"
    env_python.write_text("")
    venv_python = tmp_path / "venv-python"
    venv_python.write_text("")
    backend = tmp_path / "backend-python"
    backend.write_text("")

    result = ka.resolve_kernel_python(
        root,
        configured=str(configured),
        env=str(env_python),
        candidates=(),
        sys_executable=str(backend),
    )
    assert result["source"] == "config"
    assert result["path"] == str(configured)

    result = ka.resolve_kernel_python(
        root,
        configured=str(tmp_path / "missing"),
        env=str(env_python),
        candidates=(),
        sys_executable=str(backend),
    )
    assert result["source"] == "env"
    assert result["path"] == str(env_python)

    result = ka.resolve_kernel_python(
        root,
        configured="",
        env="",
        candidates=(venv_python,),
        sys_executable=str(backend),
    )
    assert result["source"] == "default"
    assert result["path"] == str(venv_python)

    result = ka.resolve_kernel_python(
        root,
        configured=str(tmp_path / "missing"),
        env="",
        candidates=(),
        sys_executable=str(backend),
    )
    assert result["source"] == "backend"
    assert result["last_resort"] is True


def test_resolve_kernel_python_uses_project_venv_when_only_it_exists(tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    venv_python = (
        root / ".venv-kernel" / "Scripts" / "python.exe"
        if os.name == "nt"
        else root / ".venv-kernel" / "bin" / "python"
    )
    venv_python.parent.mkdir(parents=True)
    venv_python.write_text("")

    result = ka.resolve_kernel_python(
        root,
        configured="",
        env="",
        candidates=(),
        sys_executable=str(tmp_path / "missing-backend-python"),
    )

    assert result["source"] == "venv"
    assert result["exists"] is True
    assert Path(result["path"]) == venv_python
    assert result["last_resort"] is False


def test_inspect_disk_precheck_uses_manifest(tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    fake_python = _fake_python(tmp_path)
    manifest = _manifest(b"x" * 1000, size=1000)
    common = dict(
        manifest=manifest,
        state_dir=tmp_path / "state",
        kernel_python=str(fake_python),
        python_candidates=(),
        sys_executable=str(fake_python),
        model_dir=str(tmp_path / "models"),
    )
    tight = ka.inspect(root, disk_usage=lambda path: SimpleNamespace(free=1100), **common)
    assert tight["disk"]["required"] == 1200
    assert tight["disk"]["sufficient"] is False
    roomy = ka.inspect(root, disk_usage=lambda path: SimpleNamespace(free=5000), **common)
    assert roomy["disk"]["sufficient"] is True


def test_inspect_reads_pidfile_health(tmp_path, monkeypatch):
    root = tmp_path / "project"
    root.mkdir()
    fake_python = _fake_python(tmp_path)
    state = tmp_path / "state"
    state.mkdir()
    (state / "kernel.pid").write_text(
        json.dumps({"pid": os.getpid(), "port": 4567, "api_version": "1.0.0"})
    )
    seen: list[int] = []

    def probe(port: int) -> bool:
        seen.append(port)
        return True

    result = ka.inspect(
        root,
        state_dir=state,
        kernel_python=str(fake_python),
        model_dir=str(tmp_path / "models"),
        python_candidates=(),
        sys_executable=str(fake_python),
        health_probe=probe,
        disk_usage=lambda path: SimpleNamespace(free=10**9),
    )
    assert result["health"]["found"] is True
    assert result["health"]["alive"] is True
    assert result["health"]["healthy"] is True
    assert result["health"]["api_version"] == "1.0.0"
    assert seen == [4567]

    (state / "kernel.pid").write_text(json.dumps({"pid": 2**31 - 1, "port": 4567}))
    monkeypatch.setattr(ka, "_pid_alive", lambda pid: False)
    stale = ka.inspect(
        root,
        state_dir=state,
        kernel_python=str(fake_python),
        model_dir=str(tmp_path / "models"),
        python_candidates=(),
        sys_executable=str(fake_python),
        health_probe=probe,
        disk_usage=lambda path: SimpleNamespace(free=10**9),
    )
    assert stale["health"]["alive"] is False
    assert stale["health"]["error"] == "stale_pidfile"
    assert seen == [4567]


def test_kernel_install_guard_blocks_source_and_non_empty(tmp_path):
    source_root = tmp_path / "source"
    (source_root / "kernel" / "axeuh_kernel").mkdir(parents=True)
    (source_root / "kernel" / "axeuh_kernel" / "__init__.py").write_text("")
    assert ka.kernel_install_guard(source_root) == "kernel_install_forbidden_dev_checkout"

    other_root = tmp_path / "other"
    (other_root / "kernel").mkdir(parents=True)
    (other_root / "kernel" / "notes.txt").write_text("keep")
    assert ka.kernel_install_guard(other_root) == "kernel_install_target_not_empty"

    marked_root = tmp_path / "marked"
    (marked_root / "kernel").mkdir(parents=True)
    (marked_root / "kernel" / ka.INSTALL_MARKER).write_text("{}")
    assert ka.kernel_install_guard(marked_root) is None


def test_download_kernel_refuses_dev_checkout_before_network(tmp_path):
    root = tmp_path / "project"
    (root / "kernel" / "axeuh_kernel").mkdir(parents=True)
    (root / "kernel" / "axeuh_kernel" / "__init__.py").write_text("")
    with pytest.raises(ra.ReleaseAssetError) as excinfo:
        ka.download_kernel(_manifest(_kernel_tar()), root, retries=0)
    assert excinfo.value.code == "kernel_install_forbidden_dev_checkout"
    assert not (root / "kernel" / ka.INSTALL_MARKER).exists()


def test_download_kernel_disk_check_before_network(tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    with pytest.raises(ra.ReleaseAssetError) as excinfo:
        ka.download_kernel(
            _manifest(b"x" * 1000, size=1000),
            root,
            retries=0,
            disk_usage=lambda path: SimpleNamespace(free=10),
        )
    assert excinfo.value.code == "insufficient_disk"
    assert not (root / "kernel").exists()


def test_download_kernel_installs_and_cleans(tmp_path, monkeypatch):
    root = tmp_path / "project"
    root.mkdir()
    blob = _kernel_tar("2026.10.26")
    monkeypatch.setattr(ra, "_urlopen", _opener(blob))
    manifest = _manifest(blob)
    phases: list[str] = []
    result = ka.download_kernel(
        manifest,
        root,
        retries=0,
        sleep=lambda seconds: None,
        disk_usage=lambda path: SimpleNamespace(free=10**9),
        phase=phases.append,
    )
    assert phases == ["download", "verify", "extract", "install"]
    package = root / "kernel" / "axeuh_kernel" / "__init__.py"
    assert package.is_file()
    assert (root / "kernel" / ka.INSTALL_MARKER).is_file()
    assert result["sha256"] == manifest.assets["kernel"].sha256
    assert result["bytes"] == len(blob)
    assert ka.verify_kernel_installed(root)["installed"] is True
    assert ka.verify_kernel_installed(root)["version"] == "2026.10.26"
    assert not list(root.glob(".kernel-download-*"))


def test_download_kernel_sha_mismatch_does_not_install(tmp_path, monkeypatch):
    root = tmp_path / "project"
    root.mkdir()
    blob = _kernel_tar()
    monkeypatch.setattr(ra, "_urlopen", _opener(blob))
    manifest = _manifest(blob, sha256="0" * 64)
    with pytest.raises(IntegrityError):
        ka.download_kernel(
            manifest,
            root,
            retries=0,
            sleep=lambda seconds: None,
            disk_usage=lambda path: SimpleNamespace(free=10**9),
        )
    assert not (root / "kernel").exists()
    assert not list(root.glob(".kernel-download-*"))
