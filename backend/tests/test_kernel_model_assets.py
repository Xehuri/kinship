# -*- coding: utf-8 -*-
"""T7b: 内核模型状态与受控下载（零网络、零生产写入）。

所有目标都在 ``tmp_path`` 下，通过 ``config={"home": ...}`` 与临时 manifest
注入；上行下载使用假 opener，ModelScope/HuggingFace 使用假 runner。
"""
from __future__ import annotations

import hashlib
import io
import json
import re
import threading
import urllib.error
from pathlib import Path

import pytest

from services import kernel_model_assets as kma
from services import release_assets as ra
from services.kernel_model_manifest import parse_manifest


class FakeResponse:
    def __init__(self, body: bytes):
        self._body = io.BytesIO(body)
        self.status = 200
        self.headers = {"Content-Length": str(len(body))}

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
    import socket

    monkeypatch.setattr(socket, "create_connection", forbidden)
    monkeypatch.setattr(socket, "getaddrinfo", forbidden)


def _entry(**overrides) -> dict:
    base = {
        "id": "tiny",
        "tier": "required",
        "source": "modelscope",
        "repo": "iic/Tiny",
        "target": "~/models/tiny",
        "kind": "directory",
        "size_bytes": 10,
        "sha256": None,
        "md5": None,
        "gated": False,
        "required_files": ["config.yaml"],
        "url": None,
        "mirrors": [],
        "notes": "",
    }
    base.update(overrides)
    return base


def _manifest(*models: dict, version: str = "2026.10.26"):
    return parse_manifest(
        {
            "schema": 1,
            "product": "test-models",
            "version": version,
            "default_source": "modelscope",
            "models": list(models),
        }
    )


def _config(tmp_path: Path, **overrides) -> dict:
    config = {
        "home": str(tmp_path / "home"),
        "kernel_root": str(tmp_path / "kernel"),
        "model_tiers": ["required"],
    }
    config.update(overrides)
    return config


def _python(tmp_path: Path) -> Path:
    path = tmp_path / "kernel-python"
    path.write_text("#!/bin/sh\n", encoding="utf-8")
    return path


class FakeRunner:
    def __init__(self, files: dict[str, bytes] | None = None) -> None:
        self.calls: list[dict] = []
        self.files = files if files is not None else {"config.yaml": b"cfg"}

    def __call__(self, argv, *, env, timeout, cancel_event):
        self.calls.append(
            {"argv": list(argv), "env": dict(env), "timeout": timeout}
        )
        script = argv[-1]
        local = re.search(r"local_dir=(['\"])(.*?)\1", script)
        if local:
            root = Path(local.group(2))
            root.mkdir(parents=True, exist_ok=True)
            for name, data in self.files.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
        cache = re.search(r"cache_dir=(['\"])(.*?)\1", script)
        if cache:
            repo = re.search(r"repo_id=(['\"])(.*?)\1", script).group(2)
            repo_dir = Path(cache.group(2)) / ("models--" + repo.replace("/", "--"))
            snapshot = repo_dir / "snapshots" / "abcdef"
            snapshot.mkdir(parents=True, exist_ok=True)
            (snapshot / "config.yaml").write_text("cfg", encoding="utf-8")
            (repo_dir / "refs").mkdir(parents=True, exist_ok=True)
            (repo_dir / "refs" / "main").write_text("abcdef", encoding="utf-8")
        return 0


def _forbidden_runner(*args, **kwargs):
    raise AssertionError("runner must not be invoked (no download expected)")


_MODEL_ENV_KEYS = (
    "AXEUH_KERNEL_MODEL_DIR",
    "AXEUH_KERNEL_MODEL_DOWNLOAD_DIR",
    "MODELSCOPE_CACHE",
    "HF_HOME",
    "HF_HUB_CACHE",
    "HUGGINGFACE_HUB_CACHE",
    "TRANSFORMERS_CACHE",
    "TORCH_HOME",
)


def _clear_model_env(monkeypatch) -> None:
    for key in _MODEL_ENV_KEYS:
        monkeypatch.delenv(key, raising=False)


# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------


def test_status_reports_present_and_missing_without_network(tmp_path):
    payload = {
        "schema": 1,
        "product": "test-models",
        "version": "1.2.3",
        "default_source": "modelscope",
        "models": [
            _entry(id="one", target="~/models/one"),
            _entry(id="two", target="~/models/two", tier="optional"),
            _entry(
                id="bundle",
                source="bundled",
                target="<kernel>/models/bundle",
                tier="recommended",
            ),
        ],
    }
    manifest_file = tmp_path / "manifest.json"
    manifest_file.write_text(json.dumps(payload), encoding="utf-8")
    home = tmp_path / "home"
    (home / "models" / "one").mkdir(parents=True)
    (home / "models" / "one" / "config.yaml").write_text("x", encoding="utf-8")
    project = tmp_path / "project"

    result = kma.status(
        project_root=project,
        config={"manifest_path": str(manifest_file), "home": str(home)},
    )

    assert result["manifest_version"] == "1.2.3"
    by_id = {row["id"]: row for row in result["models"]}
    assert set(by_id["one"]) == {
        "id",
        "tier",
        "source",
        "repo",
        "target",
        "kind",
        "size_bytes",
        "gated",
        "present",
        "missing_files",
        "error",
    }
    assert by_id["one"]["present"] is True
    assert by_id["one"]["repo"] == "iic/Tiny"
    assert by_id["two"]["present"] is False
    assert by_id["two"]["error"] == "target_missing"
    assert by_id["bundle"]["present"] is False
    assert by_id["bundle"]["target"] == str(project / "kernel" / "models" / "bundle")
    assert result["total_size_bytes"] == 30
    assert result["required_size_bytes"] == 10
    assert [tier["id"] for tier in result["tiers"]] == [
        "required",
        "recommended",
        "optional",
    ]
    assert result["tiers"][0]["model_ids"] == ["one"]
    assert result["tiers"][0]["missing_size_bytes"] == 0
    assert result["tiers"][2]["missing_size_bytes"] == 10


def test_status_defaults_home_to_models_root(tmp_path, monkeypatch):
    models_root = tmp_path / "models-root"
    monkeypatch.setenv("AXEUH_MODELS_DIR", str(models_root))
    payload = {
        "schema": 1,
        "product": "test-models",
        "version": "1",
        "default_source": "modelscope",
        "models": [
            _entry(
                target="~/.cache/modelscope/hub/models/iic/Tiny",
                required_files=["config.yaml"],
            ),
            _entry(
                id="bundle",
                source="bundled",
                target="<kernel>/models/bundle",
                tier="recommended",
            ),
        ],
    }
    manifest_file = tmp_path / "manifest.json"
    manifest_file.write_text(json.dumps(payload), encoding="utf-8")
    project = tmp_path / "project"

    result = kma.status(
        project_root=project,
        config={"manifest_path": str(manifest_file)},
    )

    by_id = {row["id"]: row for row in result["models"]}
    assert by_id["tiny"]["target"] == str(
        models_root / ".cache" / "modelscope" / "hub" / "models" / "iic" / "Tiny"
    )
    assert by_id["bundle"]["target"] == str(project / "kernel" / "models" / "bundle")


def test_status_reports_missing_required_file(tmp_path):
    payload = {
        "schema": 1,
        "product": "test-models",
        "version": "1",
        "default_source": "modelscope",
        "models": [_entry(target="~/models/tiny")],
    }
    manifest_file = tmp_path / "manifest.json"
    manifest_file.write_text(json.dumps(payload), encoding="utf-8")
    home = tmp_path / "home"
    (home / "models" / "tiny").mkdir(parents=True)

    result = kma.status(
        config={"manifest_path": str(manifest_file), "home": str(home)}
    )

    row = result["models"][0]
    assert row["present"] is False
    assert row["missing_files"] == ["config.yaml"]
    assert row["error"] == "required_files_missing"


# ---------------------------------------------------------------------------
# selection
# ---------------------------------------------------------------------------


def test_select_defaults_to_configured_tiers():
    manifest = _manifest(
        _entry(id="req", tier="required"),
        _entry(id="rec", tier="recommended"),
        _entry(id="opt", tier="optional"),
    )

    selected = kma.select_models(manifest, config={"model_tiers": ["recommended"]})

    assert [model.id for model in selected] == ["rec"]


def test_select_rejects_empty_and_unknown():
    manifest = _manifest(_entry(id="req"))

    with pytest.raises(kma.KernelModelAssetError) as exc:
        kma.select_models(manifest, {"models": []})
    assert exc.value.code == "empty_selection"

    with pytest.raises(Exception) as exc:
        kma.select_models(manifest, {"models": ["nope"]})
    assert getattr(exc.value, "code", None) == "unknown_model_id"


# ---------------------------------------------------------------------------
# modelscope
# ---------------------------------------------------------------------------


def test_modelscope_command_construction_and_install(tmp_path):
    manifest = _manifest(_entry())
    runner = FakeRunner()
    python = _python(tmp_path)

    result = kma.download(
        manifest,
        {"models": ["tiny"]},
        tmp_path / "project",
        _config(tmp_path),
        runner=runner,
        kernel_python=str(python),
    )

    assert result["installed"] == ["tiny"]
    assert result["failed"] == []
    row = result["models"][0]
    assert row["status"] == "installed"
    assert row["verification"] == "modelscope"
    target = tmp_path / "home" / "models" / "tiny"
    assert (target / "config.yaml").is_file()
    assert len(runner.calls) == 1
    call = runner.calls[0]
    assert call["argv"][0] == str(python)
    assert call["argv"][1] == "-c"
    assert "modelscope.hub.snapshot_download" in call["argv"][2]
    assert "iic/Tiny" in call["argv"][2]
    assert call["timeout"] == kma.DEFAULT_TIMEOUT_S
    assert "HF_TOKEN" not in " ".join(call["argv"])
    assert call["env"].get("HF_TOKEN") is None
    assert list((tmp_path / "home" / "models").glob(".kernel-model-staging-*")) == []


def test_download_child_receives_models_root_cache_env(tmp_path, monkeypatch):
    models_root = tmp_path / "models-root"
    monkeypatch.setenv("AXEUH_MODELS_DIR", str(models_root))
    _clear_model_env(monkeypatch)
    runner = FakeRunner()

    result = kma.download(
        _manifest(_entry()),
        {"models": ["tiny"]},
        tmp_path / "project",
        _config(tmp_path),
        runner=runner,
        kernel_python=str(_python(tmp_path)),
    )

    assert result["installed"] == ["tiny"]
    env = runner.calls[0]["env"]
    default = models_root / ".cache" / "axeuh-kernel" / "models"
    cache = models_root / ".cache"
    assert env["AXEUH_KERNEL_MODEL_DIR"] == str(default)
    assert env["AXEUH_KERNEL_MODEL_DOWNLOAD_DIR"] == str(default)
    assert env["MODELSCOPE_CACHE"] == str(cache / "modelscope")
    assert env["HF_HOME"] == str(cache / "huggingface")
    assert env["HF_HUB_CACHE"] == str(cache / "huggingface" / "hub")
    assert env["HUGGINGFACE_HUB_CACHE"] == str(cache / "huggingface" / "hub")
    assert env["TRANSFORMERS_CACHE"] == str(cache / "huggingface" / "hub")
    assert env["TORCH_HOME"] == str(cache / "torch")


def test_download_preserves_operator_cache_env(tmp_path, monkeypatch):
    models_root = tmp_path / "models-root"
    monkeypatch.setenv("AXEUH_MODELS_DIR", str(models_root))
    _clear_model_env(monkeypatch)
    operator_hf = tmp_path / "operator-hf"
    operator_download = tmp_path / "operator-downloads"
    monkeypatch.setenv("HF_HOME", str(operator_hf))
    monkeypatch.setenv("AXEUH_KERNEL_MODEL_DOWNLOAD_DIR", str(operator_download))
    runner = FakeRunner()

    kma.download(
        _manifest(_entry()),
        {"models": ["tiny"]},
        tmp_path / "project",
        _config(tmp_path),
        runner=runner,
        kernel_python=str(_python(tmp_path)),
    )

    env = runner.calls[0]["env"]
    assert env["HF_HOME"] == str(operator_hf)
    assert env["HF_HUB_CACHE"] == str(models_root / ".cache" / "huggingface" / "hub")
    assert env["AXEUH_KERNEL_MODEL_DOWNLOAD_DIR"] == str(operator_download)


def test_modelscope_materializes_hf_cache_layout(tmp_path):
    manifest = _manifest(
        _entry(
            id="dia",
            repo="pyannote/speaker-diarization-3.1",
            target="~/hf/models--pyannote--speaker-diarization-3.1",
            required_files=["snapshots/*/config.yaml"],
        )
    )
    runner = FakeRunner({"config.yaml": b"cfg"})

    result = kma.download(
        manifest,
        {"models": ["dia"]},
        tmp_path / "project",
        _config(tmp_path),
        runner=runner,
        kernel_python=str(_python(tmp_path)),
    )

    assert result["installed"] == ["dia"]
    target = tmp_path / "home" / "hf" / "models--pyannote--speaker-diarization-3.1"
    snapshots = list((target / "snapshots").iterdir())
    assert len(snapshots) == 1
    assert len(snapshots[0].name) == 40
    assert (snapshots[0] / "config.yaml").read_text(encoding="utf-8") == "cfg"
    assert (target / "refs" / "main").read_text(encoding="utf-8") == snapshots[0].name
    assert result["models"][0]["verification"] == "modelscope+hf_layout"


def test_modelscope_failure_is_reported_without_install(tmp_path):
    manifest = _manifest(_entry())

    def failing(argv, *, env, timeout, cancel_event):
        raise kma.KernelModelAssetError("download_failed", "runner exploded")

    result = kma.download(
        manifest,
        {"models": ["tiny"]},
        tmp_path / "project",
        _config(tmp_path),
        runner=failing,
        kernel_python=str(_python(tmp_path)),
    )

    assert result["failed"] == ["tiny"]
    assert result["models"][0]["error"] == "download_failed"
    assert not (tmp_path / "home" / "models" / "tiny").exists()


# ---------------------------------------------------------------------------
# upstream
# ---------------------------------------------------------------------------


def _opener(body: bytes):
    calls: list[str] = []

    def open_url(request, timeout):
        calls.append(request.full_url)
        return FakeResponse(body)

    open_url.calls = calls
    return open_url


def _sequence_opener(responses: dict[str, object]):
    calls: list[str] = []
    timeouts: list[float] = []

    def open_url(request, timeout):
        calls.append(request.full_url)
        timeouts.append(timeout)
        item = responses[request.full_url]
        if isinstance(item, BaseException):
            raise item
        return FakeResponse(item)

    open_url.calls = calls
    open_url.timeouts = timeouts
    return open_url


def test_upstream_file_md5_verified(tmp_path):
    body = b"weights" * 100
    manifest = _manifest(
        _entry(
            id="cnn",
            source="upstream",
            repo="panns/Cnn14_16k",
            target="~/up/Cnn14.pth",
            kind="file",
            size_bytes=len(body),
            required_files=[],
            md5=hashlib.md5(body).hexdigest(),
            url="https://example.com/Cnn14.pth",
        )
    )
    opener = _opener(body)

    result = kma.download(
        manifest,
        {"models": ["cnn"]},
        tmp_path / "project",
        _config(tmp_path),
        opener=opener,
    )

    assert result["installed"] == ["cnn"]
    row = result["models"][0]
    assert row["verification"] == "md5"
    assert row["bytes"] == len(body)
    assert (tmp_path / "home" / "up" / "Cnn14.pth").read_bytes() == body
    assert opener.calls == ["https://example.com/Cnn14.pth"]


def test_upstream_md5_mismatch_deletes_partial_file(tmp_path):
    body = b"weights"
    manifest = _manifest(
        _entry(
            id="cnn",
            source="upstream",
            target="~/up/Cnn14.pth",
            kind="file",
            size_bytes=len(body),
            required_files=[],
            md5="0" * 32,
            url="https://example.com/Cnn14.pth",
        )
    )

    result = kma.download(
        manifest,
        {"models": ["cnn"]},
        tmp_path / "project",
        _config(tmp_path),
        opener=_opener(body),
    )

    assert result["failed"] == ["cnn"]
    assert result["models"][0]["error"] == "md5_mismatch"
    target = tmp_path / "home" / "up" / "Cnn14.pth"
    assert not target.exists()
    assert not target.with_name(target.name + ".part").exists()


def test_upstream_tar_size_verified_and_installed(tmp_path):
    import tarfile

    files = {
        "tokens.txt": b"tokens",
        "encoder.onnx": b"encoder" * 10,
    }
    archive_bytes = io.BytesIO()
    with tarfile.open(fileobj=archive_bytes, mode="w:gz") as tar:
        for name, data in files.items():
            info = tarfile.TarInfo("sherpa-kws/" + name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    body = archive_bytes.getvalue()
    installed_size = sum(len(data) for data in files.values())
    manifest = _manifest(
        _entry(
            id="kws",
            source="upstream",
            tier="recommended",
            target="~/kws/sherpa-kws",
            size_bytes=installed_size,
            required_files=["tokens.txt", "encoder.onnx"],
            url="https://example.com/sherpa-kws.tar.bz2",
        )
    )

    result = kma.download(
        manifest,
        {"tiers": ["recommended"]},
        tmp_path / "project",
        _config(tmp_path),
        opener=_opener(body),
    )

    assert result["installed"] == ["kws"]
    row = result["models"][0]
    assert row["verification"] == "size"
    assert row["bytes"] == installed_size
    assert (tmp_path / "home" / "kws" / "sherpa-kws" / "tokens.txt").read_bytes() == b"tokens"


def test_upstream_size_mismatch_is_reported(tmp_path):
    import tarfile

    archive_bytes = io.BytesIO()
    with tarfile.open(fileobj=archive_bytes, mode="w:gz") as tar:
        info = tarfile.TarInfo("sherpa-kws/tokens.txt")
        info.size = 3
        tar.addfile(info, io.BytesIO(b"abc"))
    manifest = _manifest(
        _entry(
            id="kws",
            source="upstream",
            target="~/kws/sherpa-kws",
            size_bytes=999,
            required_files=["tokens.txt"],
            url="https://example.com/kws.tar.bz2",
        )
    )

    result = kma.download(
        manifest,
        {"models": ["kws"]},
        tmp_path / "project",
        _config(tmp_path),
        opener=_opener(archive_bytes.getvalue()),
    )

    assert result["failed"] == ["kws"]
    assert result["models"][0]["error"] == "size_mismatch"
    assert not (tmp_path / "home" / "kws" / "sherpa-kws").exists()


def test_upstream_mirror_failure_falls_back_to_next_mirror(tmp_path):
    body = b"weights" * 100
    canonical = "https://example.com/Cnn14.pth"
    first = "https://mirror-one.example/Cnn14.pth"
    second = "https://mirror-two.example/Cnn14.pth"
    manifest = _manifest(
        _entry(
            id="cnn",
            source="upstream",
            target="~/up/Cnn14.pth",
            kind="file",
            size_bytes=len(body),
            required_files=[],
            sha256=hashlib.sha256(body).hexdigest(),
            mirrors=[first, second],
            url=canonical,
        )
    )
    opener = _sequence_opener(
        {first: urllib.error.URLError("boom"), second: body}
    )

    result = kma.download(
        manifest,
        {"models": ["cnn"]},
        tmp_path / "project",
        _config(tmp_path),
        opener=opener,
    )

    assert result["installed"] == ["cnn"]
    assert result["models"][0]["verification"] == "sha256"
    assert (tmp_path / "home" / "up" / "Cnn14.pth").read_bytes() == body
    assert opener.calls == [first, second]
    assert canonical not in opener.calls
    assert opener.timeouts == [600.0, 600.0]


def test_upstream_all_mirrors_fail_then_canonical_is_last_attempt(tmp_path):
    body = b"weights"
    canonical = "https://example.com/Cnn14.pth"
    first = "https://mirror-one.example/Cnn14.pth"
    second = "https://mirror-two.example/Cnn14.pth"
    manifest = _manifest(
        _entry(
            id="cnn",
            source="upstream",
            target="~/up/Cnn14.pth",
            kind="file",
            size_bytes=len(body),
            required_files=[],
            md5=hashlib.md5(body).hexdigest(),
            mirrors=[first, second],
            url=canonical,
        )
    )
    opener = _sequence_opener(
        {
            first: urllib.error.URLError("boom"),
            second: urllib.error.URLError("boom"),
            canonical: urllib.error.URLError("boom"),
        }
    )

    result = kma.download(
        manifest,
        {"models": ["cnn"]},
        tmp_path / "project",
        _config(tmp_path),
        opener=opener,
    )

    assert result["failed"] == ["cnn"]
    assert result["models"][0]["error"] == "download_failed"
    assert opener.calls == [first, second, canonical]
    target = tmp_path / "home" / "up" / "Cnn14.pth"
    assert not target.exists()
    assert not target.with_name(target.name + ".part").exists()
    assert list((tmp_path / "home" / "up").glob(".kernel-model-staging-*")) == []


def test_upstream_mirror_checksum_mismatch_falls_through(tmp_path):
    body = b"good-weights" * 50
    wrong = b"corrupted"
    canonical = "https://example.com/Cnn14.pth"
    first = "https://mirror-one.example/Cnn14.pth"
    second = "https://mirror-two.example/Cnn14.pth"
    manifest = _manifest(
        _entry(
            id="cnn",
            source="upstream",
            target="~/up/Cnn14.pth",
            kind="file",
            size_bytes=len(body),
            required_files=[],
            sha256=hashlib.sha256(body).hexdigest(),
            mirrors=[first, second],
            url=canonical,
        )
    )
    opener = _sequence_opener({first: wrong, second: body})

    result = kma.download(
        manifest,
        {"models": ["cnn"]},
        tmp_path / "project",
        _config(tmp_path),
        opener=opener,
    )

    assert result["installed"] == ["cnn"]
    assert (tmp_path / "home" / "up" / "Cnn14.pth").read_bytes() == body
    assert opener.calls == [first, second]
    assert canonical not in opener.calls


# ---------------------------------------------------------------------------
# gated / bundled / present / cancel
# ---------------------------------------------------------------------------


def test_gated_without_token_is_reported(tmp_path, monkeypatch):
    monkeypatch.delenv(kma.HF_TOKEN_ENV, raising=False)
    monkeypatch.delenv(kma.HF_TOKEN_FALLBACK_ENV, raising=False)
    manifest = _manifest(
        _entry(
            id="gated",
            source="huggingface_gated",
            gated=True,
            repo="pyannote/segmentation-3.0",
            target="~/hf/models--pyannote--segmentation-3.0",
            required_files=["snapshots/*/config.yaml"],
        )
    )

    result = kma.download(
        manifest,
        {"models": ["gated"]},
        tmp_path / "project",
        _config(tmp_path),
        runner=_forbidden_runner,
        kernel_python=str(_python(tmp_path)),
    )

    row = result["models"][0]
    assert row["status"] == "gated"
    assert row["error"] == "gated_token_required"
    assert result["gated"] == ["gated"]
    assert "secret" not in json.dumps(result).lower()
    assert not (tmp_path / "home" / "hf").exists()


def test_gated_requires_hf_cache_target_layout(tmp_path, monkeypatch):
    monkeypatch.setenv(kma.HF_TOKEN_ENV, "secret-token")
    manifest = _manifest(
        _entry(
            id="gated",
            source="huggingface_gated",
            gated=True,
            repo="pyannote/segmentation-3.0",
            target="~/models/flat",
            required_files=["config.yaml"],
        )
    )

    result = kma.download(
        manifest,
        {"models": ["gated"]},
        tmp_path / "project",
        _config(tmp_path),
        runner=_forbidden_runner,
        kernel_python=str(_python(tmp_path)),
    )

    row = result["models"][0]
    assert row["status"] == "unsupported"
    assert row["error"] == "unsupported_target_layout"
    assert "secret-token" not in json.dumps(result)


def test_gated_with_token_uses_env_not_argv(tmp_path, monkeypatch):
    monkeypatch.setenv(kma.HF_TOKEN_ENV, "secret-token")
    manifest = _manifest(
        _entry(
            id="gated",
            source="huggingface_gated",
            gated=True,
            repo="pyannote/segmentation-3.0",
            target="~/hf/models--pyannote--segmentation-3.0",
            required_files=["snapshots/*/config.yaml"],
        )
    )
    runner = FakeRunner({"config.yaml": b"cfg"})

    result = kma.download(
        manifest,
        {"models": ["gated"]},
        tmp_path / "project",
        _config(tmp_path),
        runner=runner,
        kernel_python=str(_python(tmp_path)),
    )

    assert result["installed"] == ["gated"]
    call = runner.calls[0]
    assert "secret-token" not in " ".join(call["argv"])
    assert call["env"]["HF_TOKEN"] == "secret-token"
    target = tmp_path / "home" / "hf" / "models--pyannote--segmentation-3.0"
    assert (target / "refs" / "main").is_file()


def test_gated_error_does_not_leak_token(tmp_path, monkeypatch):
    monkeypatch.setenv(kma.HF_TOKEN_ENV, "secret-token")
    manifest = _manifest(
        _entry(
            id="gated",
            source="huggingface_gated",
            gated=True,
            repo="pyannote/segmentation-3.0",
            target="~/hf/models--pyannote--segmentation-3.0",
            required_files=["snapshots/*/config.yaml"],
        )
    )

    def failing(argv, *, env, timeout, cancel_event):
        raise kma.KernelModelAssetError(
            "download_failed", "auth failed for secret-token"
        )

    result = kma.download(
        manifest,
        {"models": ["gated"]},
        tmp_path / "project",
        _config(tmp_path),
        runner=failing,
        kernel_python=str(_python(tmp_path)),
    )

    assert result["failed"] == ["gated"]
    assert "secret-token" not in json.dumps(result)
    assert "***" in result["models"][0]["message"]


def test_present_model_is_skipped(tmp_path):
    manifest = _manifest(_entry())
    target = tmp_path / "home" / "models" / "tiny"
    target.mkdir(parents=True)
    (target / "config.yaml").write_text("x", encoding="utf-8")

    result = kma.download(
        manifest,
        {"models": ["tiny"]},
        tmp_path / "project",
        _config(tmp_path),
        runner=_forbidden_runner,
        kernel_python=str(_python(tmp_path)),
    )

    assert result["present"] == ["tiny"]
    assert result["models"][0]["status"] == "present"


def test_bundled_model_is_never_downloaded(tmp_path):
    manifest = _manifest(
        _entry(
            id="bundle",
            source="bundled",
            target="<kernel>/models/bundle",
        )
    )

    result = kma.download(
        manifest,
        {"models": ["bundle"]},
        tmp_path / "project",
        _config(tmp_path),
        runner=_forbidden_runner,
    )

    row = result["models"][0]
    assert row["status"] == "bundled"
    assert row["error"] == "bundled_missing"
    assert result["bundled"] == ["bundle"]
    assert not (tmp_path / "project" / "kernel").exists()


def test_cancel_before_start_raises(tmp_path):
    manifest = _manifest(_entry())
    event = threading.Event()
    event.set()

    with pytest.raises(ra.DownloadCancelled):
        kma.download(
            manifest,
            {"models": ["tiny"]},
            tmp_path / "project",
            _config(tmp_path),
            runner=_forbidden_runner,
            cancel_event=event,
            kernel_python=str(_python(tmp_path)),
        )
    assert not (tmp_path / "home" / "models" / "tiny").exists()


def test_download_disabled_raises(tmp_path):
    manifest = _manifest(_entry())

    with pytest.raises(kma.KernelModelAssetError) as exc:
        kma.download(
            manifest,
            {"models": ["tiny"]},
            tmp_path / "project",
            _config(tmp_path, allow_model_download=False),
            runner=_forbidden_runner,
        )

    assert exc.value.code == "model_download_disabled"
