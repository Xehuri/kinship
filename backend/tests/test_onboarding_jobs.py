# -*- coding: utf-8 -*-
"""T6: onboarding job registry and HTTP job surface."""
from __future__ import annotations

import threading
import time
from pathlib import Path

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

import auth
from routers import system_onboarding
from services import onboarding_jobs, onboarding_service
from services.onboarding_jobs import JobAlreadyRunning, JobManager, JobNotFound
from services.release_assets import ManifestError, ReleaseConfigError


def _wait(predicate, timeout: float = 3.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


def test_job_done_and_progress():
    manager = JobManager()

    def runner(job):
        job.set_current("asset")
        job.update_progress(5, 10)
        job.log("[OnboardingAssets] phase=download asset=kernel bytes=5/10 pct=50 result=progress")
        return {"path": "/tmp/kernel"}

    job = manager.start("download:kernel", runner, asset="kernel")
    assert job.wait(3)
    snapshot = job.snapshot()
    assert snapshot["state"] == "done"
    assert snapshot["progress"]["pct"] == 100
    assert snapshot["result"] == {"path": "/tmp/kernel"}
    assert snapshot["logs_tail"]
    assert snapshot["cancel_requested"] is False


def test_one_active_download_globally():
    manager = JobManager()
    gate = threading.Event()
    started = threading.Event()

    def blocking(job):
        started.set()
        gate.wait(3)
        return {"ok": True}

    first = manager.start("download:kernel", blocking)
    assert started.wait(2)
    with pytest.raises(JobAlreadyRunning):
        manager.start("download:frontend", lambda job: None)
    gate.set()
    assert first.wait(3)
    assert first.snapshot()["state"] == "done"

    second = manager.start("download:kernel", lambda job: {"ok": True})
    assert second.wait(3)
    assert second.snapshot()["state"] == "done"


def test_failure_redacts_secrets():
    manager = JobManager()

    def runner(job):
        raise RuntimeError("boom https://example.com/x?token=SUPERSECRET")

    job = manager.start("download:kernel", runner)
    assert job.wait(3)
    snapshot = job.snapshot()
    assert snapshot["state"] == "failed"
    assert snapshot["error"]
    assert "SUPERSECRET" not in snapshot["error"]
    assert "***" in snapshot["error"]


def test_cancel_running_job():
    manager = JobManager()
    started = threading.Event()

    def runner(job):
        started.set()
        while not job.cancel_event.is_set():
            time.sleep(0.005)
        return {"stopped": True}

    job = manager.start("download:kernel", runner)
    assert started.wait(2)
    snapshot = manager.cancel(job.id)
    assert snapshot["cancel_requested"] is True
    assert job.wait(3)
    final = job.snapshot()
    assert final["state"] == "cancelled"
    assert final["error"] == "cancelled"


def test_cancel_terminal_job_is_noop():
    manager = JobManager()
    job = manager.start("download:kernel", lambda job: {"ok": True})
    assert job.wait(3)
    snapshot = manager.cancel(job.id)
    assert snapshot["state"] == "done"
    assert snapshot["cancel_requested"] is False


def test_unknown_job_raises():
    manager = JobManager()
    with pytest.raises(JobNotFound):
        manager.snapshot("missing")
    with pytest.raises(JobNotFound):
        manager.cancel("missing")


def test_logs_tail_is_bounded():
    manager = JobManager(max_logs=3)
    job = manager.start("download:kernel", lambda job: {"ok": True})
    for index in range(6):
        job.log(f"line-{index}")
    assert job.wait(3)
    tail = job.snapshot()["logs_tail"]
    assert len(tail) == 3
    assert tail[-1] == "line-5"


def _build_app() -> FastAPI:
    app = FastAPI()

    @app.middleware("http")
    async def inject_identity(request: Request, call_next):
        request.state.user_id = "alice"
        request.state.token_kind = "user"
        return await call_next(request)

    app.include_router(system_onboarding.router)
    return app


class _FakeManifest:
    def __init__(self, assets=None):
        self.assets = assets or {}

    def public(self):
        return {
            "schema": 1,
            "product": "kinship",
            "version": "2026.10.26",
            "assets": {
                name: {
                    "name": name,
                    "file": asset.file,
                    "sha256": asset.sha256,
                    "size": asset.size,
                    "url": asset.url,
                    "api_version": "",
                    "tiers": [],
                }
                for name, asset in self.assets.items()
            },
        }


class _FakeAsset:
    def __init__(self, name="kernel"):
        self.name = name
        self.file = f"{name}.tar.gz"
        self.sha256 = "0" * 64
        self.size = 10
        self.url = f"https://example.com/{name}.tar.gz"


@pytest.fixture
def api_env(tmp_path: Path, monkeypatch):
    root = _mark_dev_checkout(tmp_path / "project")
    manager = JobManager()
    manifest = _FakeManifest({"kernel": _FakeAsset("kernel")})
    calls: list[dict] = []

    monkeypatch.setattr(auth, "is_setup_required", lambda: True)
    monkeypatch.setattr(auth, "verify_setup_token", lambda token: token == "setup-token")
    monkeypatch.setattr(system_onboarding, "_project_root", lambda: root)
    monkeypatch.setattr(onboarding_jobs, "get_job_manager", lambda: manager)
    monkeypatch.setattr(
        system_onboarding.release_assets,
        "load_manifest",
        lambda *args, **kwargs: manifest,
    )

    def fake_bootstrap(root_arg, **kwargs):
        job = kwargs.get("job")
        if job is not None:
            job.set_current("kernel_build")
            job.update_progress(1, 3)
            job.log("[KernelBootstrap] phase=build result=ok")
        calls.append({"root": root_arg, **kwargs})
        return {
            "ok": True,
            "built": True,
            "artifact_bytes": 10,
            "venv_python": str(root_arg / ".venv-kernel" / "bin" / "python"),
        }

    monkeypatch.setattr(
        system_onboarding.kernel_bootstrap, "bootstrap_kernel", fake_bootstrap
    )
    monkeypatch.setattr(
        system_onboarding.onboarding_service,
        "ensure_ai_instance",
        lambda **kwargs: {
            "action": "ensure_ai_instance",
            "created": False,
            "copied_files": 0,
            "existing_files": 0,
            "errors": [],
        },
    )
    client = TestClient(_build_app())
    yield client, manager, calls, root, monkeypatch
    client.close()


def test_router_job_lifecycle(api_env):
    client, manager, calls, root, monkeypatch = api_env
    headers = {"X-Setup-Token": "setup-token"}

    denied = client.post("/api/system/onboarding/assets/download", json={"asset": "kernel"})
    assert denied.status_code == 403
    assert denied.json()["code"] == "setup_token_required"

    started = client.post(
        "/api/system/onboarding/assets/download",
        json={"asset": "kernel"},
        headers=headers,
    )
    assert started.status_code == 202
    job_id = started.json()["job"]["id"]
    assert _wait(
        lambda: client.get(f"/api/system/onboarding/jobs/{job_id}").json()["job"]["state"]
        == "done"
    )
    snapshot = client.get(f"/api/system/onboarding/jobs/{job_id}").json()["job"]
    assert snapshot["kind"] == "download:kernel"
    assert snapshot["result"]["built"] is True
    assert snapshot["result"]["artifact_bytes"] == 10
    assert calls
    assert calls[0]["root"] == root
    assert any(
        "[OnboardingAssets] phase=kernel_bootstrap result=ok" in line
        for line in snapshot["logs_tail"]
    )

    missing = client.get("/api/system/onboarding/jobs/does-not-exist")
    assert missing.status_code == 404
    assert missing.json()["code"] == "job_not_found"
    missing_cancel = client.post(
        "/api/system/onboarding/jobs/does-not-exist/cancel", headers=headers
    )
    assert missing_cancel.status_code == 404


def test_router_assets_manifest(api_env):
    client, *_ = api_env
    response = client.get("/api/system/onboarding/assets")
    assert response.status_code == 200
    body = response.json()
    assert body["configured"] is True
    assert body["version"] == "2026.10.26"
    assert "kernel" in body["assets"]


def test_router_assets_config_error_still_configured(api_env, monkeypatch):
    client, *_ = api_env
    monkeypatch.setattr(
        system_onboarding.release_assets,
        "load_manifest",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            ReleaseConfigError("release_manifest_not_configured", "missing")
        ),
    )
    response = client.get("/api/system/onboarding/assets")
    assert response.status_code == 200
    assert response.json()["configured"] is True


def test_router_assets_manifest_error(api_env, monkeypatch):
    client, *_ = api_env
    monkeypatch.setattr(
        system_onboarding.release_assets,
        "load_manifest",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            ManifestError("manifest_not_found", "missing")
        ),
    )
    response = client.get("/api/system/onboarding/assets")
    assert response.status_code == 200
    body = response.json()
    assert body["configured"] is True
    assert body["manifest"] is None
    assert body["error"] == "manifest_not_found"
    assert body["dependencies"] is not None


def test_router_rejects_models_and_unsupported(api_env):
    client, *_ = api_env
    headers = {"X-Setup-Token": "setup-token"}
    models = client.post(
        "/api/system/onboarding/assets/download",
        json={"asset": "models"},
        headers=headers,
    )
    assert models.status_code == 400
    assert models.json()["code"] == "model_download_not_implemented"
    unknown = client.post(
        "/api/system/onboarding/assets/download",
        json={"asset": "android"},
        headers=headers,
    )
    assert unknown.status_code == 400
    assert unknown.json()["code"] == "unsupported_asset"


def test_router_rejects_present_frontend_dist(api_env):
    client, manager, calls, root, monkeypatch = api_env
    dist = root / "frontend" / "mobile" / "dist"
    dist.mkdir(parents=True)
    (dist / "index.html").write_text("present")
    response = client.post(
        "/api/system/onboarding/assets/download",
        json={"asset": "frontend"},
        headers={"X-Setup-Token": "setup-token"},
    )
    assert response.status_code == 409
    assert response.json()["code"] == "frontend_dist_present"
    assert calls == []


def test_router_one_active_download(api_env):
    client, manager, calls, root, monkeypatch = api_env
    gate = threading.Event()

    def blocking(root_arg, **kwargs):
        gate.wait(3)
        return {
            "ok": True,
            "built": True,
            "venv_python": str(root_arg / ".venv-kernel" / "bin" / "python"),
        }

    monkeypatch.setattr(
        system_onboarding.kernel_bootstrap, "bootstrap_kernel", blocking
    )
    headers = {"X-Setup-Token": "setup-token"}
    first = client.post(
        "/api/system/onboarding/assets/download",
        json={"asset": "kernel"},
        headers=headers,
    )
    assert first.status_code == 202
    job_id = first.json()["job"]["id"]
    assert _wait(
        lambda: client.get(f"/api/system/onboarding/jobs/{job_id}").json()["job"]["state"]
        == "running"
    )
    second = client.post(
        "/api/system/onboarding/assets/download",
        json={"asset": "kernel"},
        headers=headers,
    )
    assert second.status_code == 409
    assert second.json()["code"] == "download_in_progress"
    gate.set()
    assert _wait(
        lambda: client.get(f"/api/system/onboarding/jobs/{job_id}").json()["job"]["state"]
        == "done"
    )


def _mark_dev_checkout(root: Path) -> Path:
    package = root / "kernel" / "axeuh_kernel"
    package.mkdir(parents=True, exist_ok=True)
    (package / "__init__.py").write_text("API_VERSION = '1.0.0'\n", encoding="utf-8")
    return root


def _record_ensure(monkeypatch, events, calls):
    def fake_ensure(**kwargs):
        calls.append(kwargs)
        events.append("ensure")
        return {
            "action": "ensure_ai_instance",
            "created": False,
            "copied_files": 2,
            "existing_files": 1,
            "errors": [],
        }

    monkeypatch.setattr(
        system_onboarding.onboarding_service, "ensure_ai_instance", fake_ensure
    )
    return fake_ensure


def test_kernel_bootstrap_ensures_ai_instance_once_before_build(
    monkeypatch, tmp_path
):
    root = _mark_dev_checkout(tmp_path / "project")
    events: list[str] = []
    ensure_calls: list[dict] = []

    _record_ensure(monkeypatch, events, ensure_calls)

    def fake_bootstrap(root_arg, **kwargs):
        events.append("bootstrap")
        return {
            "ok": True,
            "built": True,
            "venv_python": str(root_arg / ".venv-kernel" / "bin" / "python"),
        }

    monkeypatch.setattr(
        system_onboarding.kernel_bootstrap, "bootstrap_kernel", fake_bootstrap
    )

    manager = JobManager()
    job = manager.start(
        "download:kernel",
        system_onboarding._download_runner(root, "kernel"),
        asset="kernel",
    )

    assert job.wait(3)
    snapshot = job.snapshot()
    assert snapshot["state"] == "done"
    assert ensure_calls == [{"project_root": root}]
    assert events == ["ensure", "bootstrap"]
    assert any(
        "[OnboardingAssets] phase=ai_instance result=ok copied=2" in line
        for line in snapshot["logs_tail"]
    )


def test_kernel_bootstrap_not_started_when_ai_instance_fails(
    monkeypatch, tmp_path
):
    root = _mark_dev_checkout(tmp_path / "project")
    downloads: list[str] = []
    manifests: list[str] = []

    def fake_ensure(**kwargs):
        raise onboarding_service.OnboardingActionInvalid(
            "template_missing", "private detail at /secret/template"
        )

    def fake_bootstrap(*args, **kwargs):
        downloads.append("bootstrap")
        return {"ok": True, "built": True}

    monkeypatch.setattr(
        system_onboarding.onboarding_service, "ensure_ai_instance", fake_ensure
    )
    monkeypatch.setattr(
        system_onboarding.kernel_bootstrap, "bootstrap_kernel", fake_bootstrap
    )

    manager = JobManager()
    job = manager.start(
        "download:kernel",
        system_onboarding._download_runner(root, "kernel"),
        asset="kernel",
    )

    assert job.wait(3)
    snapshot = job.snapshot()
    assert snapshot["state"] == "failed"
    assert manifests == []
    assert downloads == []
    assert any(
        "phase=ai_instance result=error code=template_missing" in line
        for line in snapshot["logs_tail"]
    )
    assert not any("/secret/template" in line for line in snapshot["logs_tail"])


def test_model_download_ensures_ai_instance_once_before_download(
    monkeypatch, tmp_path
):
    root = tmp_path / "project"
    root.mkdir()
    events: list[str] = []
    ensure_calls: list[dict] = []
    selection: list[dict] = []

    _record_ensure(monkeypatch, events, ensure_calls)

    def fake_load_manifest(path):
        events.append("manifest")
        return {"models": []}

    def fake_download(manifest_arg, selection_arg, root_arg, **kwargs):
        events.append("download")
        selection.append(selection_arg)
        return {
            "failed": [],
            "unsupported": [],
            "gated": [],
            "installed": ["model-a"],
            "present": [],
        }

    monkeypatch.setattr(
        system_onboarding.kernel_model_manifest, "load_manifest", fake_load_manifest
    )
    monkeypatch.setattr(
        system_onboarding.kernel_model_assets, "download", fake_download
    )

    manager = JobManager()
    job = manager.start(
        "download:models",
        system_onboarding._model_download_runner(root, ["model-a"], None),
        asset="models",
    )

    assert job.wait(3)
    snapshot = job.snapshot()
    assert snapshot["state"] == "done"
    assert ensure_calls == [{"project_root": root}]
    assert events == ["ensure", "manifest", "download"]
    assert selection == [{"models": ["model-a"], "tiers": None}]


def test_model_download_fails_without_download_when_ai_instance_fails(
    monkeypatch, tmp_path
):
    root = tmp_path / "project"
    root.mkdir()
    downloads: list[str] = []

    def fake_ensure(**kwargs):
        raise RuntimeError("unexpected ensure failure")

    def fake_download(*args, **kwargs):
        downloads.append("download")
        return {
            "failed": [],
            "unsupported": [],
            "gated": [],
            "installed": [],
            "present": [],
        }

    monkeypatch.setattr(
        system_onboarding.onboarding_service, "ensure_ai_instance", fake_ensure
    )
    monkeypatch.setattr(
        system_onboarding.kernel_model_manifest,
        "load_manifest",
        lambda path: {"models": []},
    )
    monkeypatch.setattr(
        system_onboarding.kernel_model_assets, "download", fake_download
    )

    manager = JobManager()
    job = manager.start(
        "download:models",
        system_onboarding._model_download_runner(root, None, None),
        asset="models",
    )

    assert job.wait(3)
    snapshot = job.snapshot()
    assert snapshot["state"] == "failed"
    assert downloads == []
    assert any(
        "phase=ai_instance result=error code=ai_instance_failed" in line
        for line in snapshot["logs_tail"]
    )


def test_frontend_download_does_not_ensure_ai_instance(monkeypatch, tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    ensure_calls: list[dict] = []
    installs: list[str] = []

    def fake_ensure(**kwargs):
        ensure_calls.append(kwargs)
        return {"copied_files": 0}

    def fake_install(asset, root_arg, **kwargs):
        installs.append(asset.name)
        return {"path": str(root_arg / "frontend"), "bytes": 10}

    monkeypatch.setattr(
        system_onboarding.onboarding_service, "ensure_ai_instance", fake_ensure
    )
    monkeypatch.setattr(
        system_onboarding.release_assets,
        "load_manifest",
        lambda *args, **kwargs: _FakeManifest({"frontend": _FakeAsset("frontend")}),
    )
    monkeypatch.setattr(
        system_onboarding.release_assets, "install_frontend_asset", fake_install
    )

    manager = JobManager()
    job = manager.start(
        "download:frontend",
        system_onboarding._download_runner(root, "frontend"),
        asset="frontend",
    )

    assert job.wait(3)
    assert job.snapshot()["state"] == "done"
    assert installs == ["frontend"]
    assert ensure_calls == []


def test_kernel_bootstrap_failure_marks_job_failed_with_stable_code(
    monkeypatch, tmp_path
):
    root = _mark_dev_checkout(tmp_path / "project")

    monkeypatch.setattr(
        system_onboarding.onboarding_service,
        "ensure_ai_instance",
        lambda **kwargs: {"copied_files": 0},
    )

    def failing(*args, **kwargs):
        return {
            "ok": False,
            "built": False,
            "error": {"code": "build_failed", "detail": "compiler exploded"},
        }

    monkeypatch.setattr(
        system_onboarding.kernel_bootstrap, "bootstrap_kernel", failing
    )

    manager = JobManager()
    job = manager.start(
        "download:kernel",
        system_onboarding._download_runner(root, "kernel"),
        asset="kernel",
    )

    assert job.wait(3)
    snapshot = job.snapshot()
    assert snapshot["state"] == "failed"
    assert "build_failed" in (snapshot["error"] or "")
    assert any(
        "phase=kernel_bootstrap result=error code=build_failed" in line
        for line in snapshot["logs_tail"]
    )


def test_kernel_runner_builds_dev_checkout_and_skips_release_download(
    monkeypatch, tmp_path
):
    root = _mark_dev_checkout(tmp_path / "project")
    events: list[str] = []

    monkeypatch.setattr(
        system_onboarding.onboarding_service,
        "ensure_ai_instance",
        lambda **kwargs: {"copied_files": 0},
    )

    def fake_bootstrap(root_arg, **kwargs):
        events.append("bootstrap")
        return {"ok": True, "built": True, "venv_python": "python"}

    def forbidden(*args, **kwargs):
        raise AssertionError("release download must not run for a dev checkout")

    monkeypatch.setattr(
        system_onboarding.kernel_bootstrap, "bootstrap_kernel", fake_bootstrap
    )
    monkeypatch.setattr(system_onboarding.release_assets, "load_manifest", forbidden)
    monkeypatch.setattr(
        system_onboarding.kernel_assets, "download_kernel", forbidden
    )

    manager = JobManager()
    job = manager.start(
        "download:kernel",
        system_onboarding._download_runner(root, "kernel"),
        asset="kernel",
    )

    assert job.wait(3)
    snapshot = job.snapshot()
    assert snapshot["state"] == "done"
    assert events == ["bootstrap"]
    assert any(
        "phase=kernel_source result=dev_checkout" in line
        for line in snapshot["logs_tail"]
    )


def test_kernel_runner_downloads_release_when_kernel_absent(monkeypatch, tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    manifest = _FakeManifest({"kernel": _FakeAsset("kernel")})
    calls: dict = {}

    monkeypatch.setattr(
        system_onboarding,
        "_release_settings",
        lambda: ("https://example.com/release-manifest.json", ""),
    )
    monkeypatch.setattr(
        system_onboarding.onboarding_service,
        "ensure_ai_instance",
        lambda **kwargs: {"copied_files": 0},
    )
    monkeypatch.setattr(
        system_onboarding.release_assets,
        "load_manifest",
        lambda *args, **kwargs: manifest,
    )

    def fake_download(manifest_arg, root_arg, **kwargs):
        calls["manifest"] = manifest_arg
        calls["root"] = root_arg
        calls["progress"] = kwargs.get("progress")
        calls["phase"] = kwargs.get("phase")
        calls["cancel_event"] = kwargs.get("cancel_event")
        return {
            "path": str(root_arg / "kernel"),
            "asset": "kernel",
            "version": "2026.10.26",
            "sha256": "0" * 64,
            "bytes": 1234,
        }

    monkeypatch.setattr(
        system_onboarding.kernel_assets, "download_kernel", fake_download
    )
    monkeypatch.setattr(
        system_onboarding.kernel_bootstrap,
        "gpu_classify",
        lambda **kwargs: ("cpu", "stub"),
    )
    monkeypatch.setattr(
        system_onboarding.kernel_bootstrap,
        "ensure_kernel_venv",
        lambda *args, **kwargs: {
            "venv_dir": str(root / ".venv-kernel"),
            "venv_python": str(root / ".venv-kernel" / "bin" / "python"),
            "torch": "cpu",
            "torch_cpu_fallback": False,
            "deps_mode": "requirements",
            "requirements_file": str(root / "kernel" / "requirements.txt"),
        },
    )
    monkeypatch.setattr(
        system_onboarding.kernel_bootstrap,
        "verify_kernel_runtime",
        lambda *args, **kwargs: {"command": ["python", "-m", "axeuh_kernel", "--help"]},
    )

    manager = JobManager()
    job = manager.start(
        "download:kernel",
        system_onboarding._download_runner(root, "kernel"),
        asset="kernel",
    )

    assert job.wait(3)
    snapshot = job.snapshot()
    assert snapshot["state"] == "done"
    assert snapshot["result"]["version"] == "2026.10.26"
    assert calls["manifest"] is manifest
    assert calls["root"] == root
    assert callable(calls["progress"])
    assert callable(calls["phase"])
    assert any(
        "phase=manifest asset=kernel result=ok" in line
        for line in snapshot["logs_tail"]
    )


def test_kernel_release_runner_maps_progress_and_phase_labels(monkeypatch, tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    manifest = _FakeManifest({"kernel": _FakeAsset("kernel")})
    seen: dict = {}

    monkeypatch.setattr(
        system_onboarding,
        "_release_settings",
        lambda: ("https://example.com/release-manifest.json", ""),
    )
    monkeypatch.setattr(
        system_onboarding.onboarding_service,
        "ensure_ai_instance",
        lambda **kwargs: {"copied_files": 0},
    )
    monkeypatch.setattr(
        system_onboarding.release_assets,
        "load_manifest",
        lambda *args, **kwargs: manifest,
    )
    monkeypatch.setattr(
        system_onboarding.kernel_bootstrap,
        "gpu_classify",
        lambda **kwargs: ("cpu", "nvidia-smi unavailable"),
    )
    monkeypatch.setattr(
        system_onboarding.kernel_bootstrap,
        "ensure_kernel_venv",
        lambda *args, **kwargs: {
            "venv_dir": str(root / ".venv-kernel"),
            "venv_python": str(root / ".venv-kernel" / "bin" / "python"),
            "torch": "cpu",
            "torch_cpu_fallback": False,
            "deps_mode": "requirements",
            "requirements_file": str(root / "kernel" / "requirements.txt"),
        },
    )
    monkeypatch.setattr(
        system_onboarding.kernel_bootstrap,
        "verify_kernel_runtime",
        lambda *args, **kwargs: {
            "command": ["python", "-m", "axeuh_kernel", "--help"]
        },
    )

    job = onboarding_jobs.Job("download:kernel", asset="kernel")

    def fake_download(
        manifest_arg, root_arg, *, progress=None, phase=None, cancel_event=None
    ):
        phase("download")
        progress(512, 1024)
        snapshot = job.snapshot()
        seen["download_current"] = snapshot["current"]
        seen["progress"] = snapshot["progress"]
        for name in ("verify", "extract", "install"):
            phase(name)
            seen[name] = job.snapshot()["current"]
        return {
            "path": str(root_arg / "kernel"),
            "asset": "kernel",
            "version": "2026.10.26",
            "sha256": "0" * 64,
            "bytes": 1024,
        }

    monkeypatch.setattr(
        system_onboarding.kernel_assets, "download_kernel", fake_download
    )

    result = system_onboarding._kernel_release_runner(root, job)

    runtime_bytes = system_onboarding.kernel_bootstrap.runtime_download_bytes(
        ("cpu", "")
    )
    assert result["bytes"] == 1024
    assert seen["download_current"] == "download"
    assert seen["progress"]["bytes"] == 512
    assert seen["progress"]["total"] == 1024 + runtime_bytes
    assert seen["verify"] == "verify"
    assert seen["extract"] == "extract"
    assert seen["install"] == "install"
    assert result["venv_python"].endswith(("bin/python", "Scripts/python.exe"))
    assert result["deps_mode"] == "requirements"


def test_kernel_release_runner_provisions_runtime_after_download(
    monkeypatch, tmp_path
):
    root = tmp_path / "project"
    root.mkdir()
    manifest = _FakeManifest({"kernel": _FakeAsset("kernel")})
    events: list[str] = []
    seen: dict = {}

    monkeypatch.setattr(
        system_onboarding,
        "_release_settings",
        lambda: ("https://example.com/release-manifest.json", ""),
    )
    monkeypatch.setattr(
        system_onboarding.onboarding_service,
        "ensure_ai_instance",
        lambda **kwargs: {"copied_files": 0},
    )
    monkeypatch.setattr(
        system_onboarding.release_assets,
        "load_manifest",
        lambda *args, **kwargs: manifest,
    )
    monkeypatch.setattr(
        system_onboarding.kernel_bootstrap,
        "gpu_classify",
        lambda **kwargs: ("cuda", "driver 580.65.06 (>=550)"),
    )
    monkeypatch.setattr(
        system_onboarding.kernel_bootstrap,
        "torch_index_url",
        lambda cfg, classification: "https://example.invalid/cu128",
    )

    job = onboarding_jobs.Job("download:kernel", asset="kernel")

    def fake_download(
        manifest_arg, root_arg, *, progress=None, phase=None, cancel_event=None
    ):
        events.append("download")
        progress(10, 10)
        return {
            "path": str(root_arg / "kernel"),
            "asset": "kernel",
            "version": "2026.10.26",
            "sha256": "0" * 64,
            "bytes": 10,
        }

    def fake_ensure(root_arg, **kwargs):
        events.append("ensure")
        seen["requirements_file"] = kwargs.get("requirements_file")
        seen["classification"] = kwargs.get("classification")
        seen["torch_index"] = kwargs.get("torch_index")
        phase = kwargs.get("phase")
        for name in ("venv", "torch", "deps"):
            phase(name)
            state = job.snapshot()
            seen[name] = (state["current"], state["progress"]["pct"])
        return {
            "venv_dir": str(root_arg / ".venv-kernel"),
            "venv_python": str(root_arg / ".venv-kernel" / "bin" / "python"),
            "torch": "cuda",
            "torch_cpu_fallback": False,
            "deps_mode": "requirements",
            "requirements_file": str(root_arg / "kernel" / "requirements.txt"),
        }

    def fake_verify(venv_python, kernel_dir, **kwargs):
        events.append("verify")
        seen["verify"] = (job.snapshot()["current"], venv_python, kernel_dir)
        return {"command": [venv_python, "-m", "axeuh_kernel", "--help"]}

    monkeypatch.setattr(
        system_onboarding.kernel_assets, "download_kernel", fake_download
    )
    monkeypatch.setattr(
        system_onboarding.kernel_bootstrap, "ensure_kernel_venv", fake_ensure
    )
    monkeypatch.setattr(
        system_onboarding.kernel_bootstrap, "verify_kernel_runtime", fake_verify
    )

    result = system_onboarding._kernel_release_runner(root, job)

    assert events == ["download", "ensure", "verify"]
    assert seen["requirements_file"] == root / "kernel" / "requirements.txt"
    assert seen["classification"] == ("cuda", "driver 580.65.06 (>=550)")
    assert seen["torch_index"] == "https://example.invalid/cu128"
    assert [seen[name][0] for name in ("venv", "torch", "deps")] == [
        "kernel_venv",
        "kernel_torch",
        "kernel_deps",
    ]
    assert seen["verify"][0] == "kernel_verify"
    assert seen["verify"][1] == str(root / ".venv-kernel" / "bin" / "python")
    assert seen["verify"][2] == root / "kernel"
    percentages = [seen[name][1] for name in ("venv", "torch", "deps")]
    assert percentages == sorted(percentages)
    assert result["torch"] == "cuda"
    assert result["runtime_venv"] == str(root / ".venv-kernel")
    assert job.snapshot()["progress"]["pct"] == 100
    assert any(
        "phase=kernel_deps" in line and "result=progress" in line
        for line in job.snapshot()["logs_tail"]
    )


def test_release_settings_env_manifest_overrides_config(monkeypatch):
    monkeypatch.setenv(
        "KERNEL_MANIFEST_URL", "https://example.com/env-release-manifest.json"
    )

    manifest_url, _base_url = system_onboarding._release_settings()

    assert manifest_url == "https://example.com/env-release-manifest.json"


def test_kernel_release_runner_keeps_package_when_runtime_fails(
    monkeypatch, tmp_path
):
    root = tmp_path / "project"
    root.mkdir()
    manifest = _FakeManifest({"kernel": _FakeAsset("kernel")})

    monkeypatch.setattr(
        system_onboarding,
        "_release_settings",
        lambda: ("https://example.com/release-manifest.json", ""),
    )
    monkeypatch.setattr(
        system_onboarding.onboarding_service,
        "ensure_ai_instance",
        lambda **kwargs: {"copied_files": 0},
    )
    monkeypatch.setattr(
        system_onboarding.release_assets,
        "load_manifest",
        lambda *args, **kwargs: manifest,
    )
    monkeypatch.setattr(
        system_onboarding.kernel_bootstrap,
        "gpu_classify",
        lambda **kwargs: ("cpu", "nvidia-smi unavailable"),
    )

    job = onboarding_jobs.Job("download:kernel", asset="kernel")

    def fake_download(
        manifest_arg, root_arg, *, progress=None, phase=None, cancel_event=None
    ):
        package = root_arg / "kernel" / "axeuh_kernel"
        package.mkdir(parents=True, exist_ok=True)
        (package / "__init__.py").write_text("API_VERSION = '1.0.0'\n")
        return {
            "path": str(root_arg / "kernel"),
            "asset": "kernel",
            "version": "2026.10.26",
            "sha256": "0" * 64,
            "bytes": 10,
        }

    def fake_ensure(root_arg, **kwargs):
        kwargs["phase"]("deps")
        raise system_onboarding.kernel_bootstrap.KernelBootstrapError(
            "kernel_deps_install_failed", "pip install -r failed"
        )

    monkeypatch.setattr(
        system_onboarding.kernel_assets, "download_kernel", fake_download
    )
    monkeypatch.setattr(
        system_onboarding.kernel_bootstrap, "ensure_kernel_venv", fake_ensure
    )

    with pytest.raises(system_onboarding.kernel_bootstrap.KernelBootstrapError) as excinfo:
        system_onboarding._kernel_release_runner(root, job)

    assert excinfo.value.code == "kernel_deps_install_failed"
    assert (root / "kernel" / "axeuh_kernel" / "__init__.py").is_file()
    assert job.snapshot()["current"] == "kernel_deps"
    assert any(
        "phase=kernel_runtime result=error code=kernel_deps_install_failed" in line
        for line in job.snapshot()["logs_tail"]
    )



def test_kernel_runner_fails_fast_when_release_not_configured(monkeypatch, tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    events: list[str] = []

    monkeypatch.setattr(system_onboarding, "_release_settings", lambda: ("", ""))
    monkeypatch.setattr(
        system_onboarding.onboarding_service,
        "ensure_ai_instance",
        lambda **kwargs: events.append("ensure") or {"copied_files": 0},
    )
    monkeypatch.setattr(
        system_onboarding.release_assets,
        "load_manifest",
        lambda *args, **kwargs: events.append("manifest"),
    )
    monkeypatch.setattr(
        system_onboarding.kernel_assets,
        "download_kernel",
        lambda *args, **kwargs: events.append("download"),
    )

    manager = JobManager()
    job = manager.start(
        "download:kernel",
        system_onboarding._download_runner(root, "kernel"),
        asset="kernel",
    )

    assert job.wait(3)
    snapshot = job.snapshot()
    assert snapshot["state"] == "failed"
    assert "kernel_release_not_configured" in (snapshot["error"] or "")
    assert "未配置内核发行清单" in (snapshot["error"] or "")
    assert events == []
    assert any(
        "phase=manifest asset=kernel result=error code=kernel_release_not_configured"
        in line
        for line in snapshot["logs_tail"]
    )


def test_router_kernel_precheck_allows_dev_checkout(api_env):
    client, *_ = api_env
    started = client.post(
        "/api/system/onboarding/assets/download",
        json={"asset": "kernel"},
        headers={"X-Setup-Token": "setup-token"},
    )
    assert started.status_code == 202
    assert started.json()["job"]["asset"] == "kernel"
    job_id = started.json()["job"]["id"]
    assert _wait(
        lambda: client.get(f"/api/system/onboarding/jobs/{job_id}").json()["job"][
            "state"
        ]
        == "done"
    )


def test_router_kernel_precheck_blocks_other_guards(api_env, monkeypatch):
    client, *_, monkeypatch = api_env
    monkeypatch.setattr(
        system_onboarding.kernel_assets,
        "kernel_install_guard",
        lambda root: "kernel_install_target_not_empty",
    )
    response = client.post(
        "/api/system/onboarding/assets/download",
        json={"asset": "kernel"},
        headers={"X-Setup-Token": "setup-token"},
    )
    assert response.status_code == 409
    assert response.json()["code"] == "kernel_install_target_not_empty"
