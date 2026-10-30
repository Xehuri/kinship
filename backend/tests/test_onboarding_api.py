# -*- coding: utf-8 -*-
"""N14: onboarding HTTP API contract.

The router is mounted on a tiny throwaway FastAPI app whose middleware injects
``request.state.user_id`` / ``request.state.token_kind`` from test headers, so the
real AuthMiddleware and production auth files are never involved. Every state and
config path is redirected into ``tmp_path``.
"""
from __future__ import annotations

import asyncio
import copy
import json
import shutil
import socket
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Iterator

import pytest
import yaml
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

import auth
from config import config as config_module
from config.providers import ProviderInfo
from config.store import ConfigStore
from middleware.auth_middleware import AuthMiddleware
from routers import system_config, system_onboarding
from services import config_reconciler, onboarding_service
from services.bootstrap_runtime import BootstrapRuntime


BASE_CONFIG = {
    "server": {"port": 28768},
    "ssl": {"enabled": False},
    "ai_backend": "opencode",
    "opencode": {
        "default_model": "test-model",
        "default_provider": "test-provider",
        "default_agent": "test-agent",
        "url": "http://127.0.0.1:4999",
    },
}

STATE_URL = "/api/system/onboarding/state"
ACTION_URL = "/api/system/onboarding/action"
STATUS_URL = "/api/system/onboarding/status"
PREFLIGHT_URL = "/api/system/onboarding/preflight"
ASSETS_URL = "/api/system/onboarding/assets"

CHECK_IDS = [
    "python",
    "config",
    "frontend_dist",
    "ai_dir",
    "disk",
    "ports",
    "ssl",
    "kernel",
    "kernel_models",
    "loom",
    "ai_backend",
]


def _model_rows() -> list[dict]:
    required = (
        "eres2netv2",
        "sensevoice",
        "fsmn-vad",
        "pyannote-segmentation",
        "pyannote-diarization",
        "wespeaker",
    )
    return [
        {
            "id": model_id,
            "tier": "required",
            "present": True,
            "size_bytes": 1_000_000,
            "error": None,
        }
        for model_id in required
    ]

USER_HEADERS = {"X-Test-User": "alice", "X-Test-Kind": "user"}


class _MemoryProvider:
    kind = "memory"

    def __init__(self, document: dict[str, Any]) -> None:
        self._document = copy.deepcopy(document)
        self._revision = 0

    def load(self) -> dict[str, Any]:
        return copy.deepcopy(self._document)

    def save(
        self, document: dict[str, Any], *, expected_revision: str | None = None
    ) -> str:
        self._document = copy.deepcopy(document)
        self._revision += 1
        return self.revision()

    def revision(self) -> str:
        return f"mem-{self._revision}"

    def describe(self) -> ProviderInfo:
        return ProviderInfo(
            kind="memory",
            location="memory://test",
            writable=True,
            detail="in-memory test provider",
        )


def _build_app() -> FastAPI:
    app = FastAPI()

    @app.middleware("http")
    async def _inject_identity(request: Request, call_next):
        user_id = request.headers.get("X-Test-User", "").strip()
        if user_id:
            request.state.user_id = user_id
            request.state.token_kind = request.headers.get("X-Test-Kind", "user")
        return await call_next(request)

    app.include_router(system_onboarding.router)
    app.include_router(system_config.router)
    app.include_router(system_config.draft_router)
    return app


def _make_project(root: Path) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    dist = root / "frontend" / "mobile" / "dist"
    dist.mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html>", encoding="utf-8")
    (root / "ai").mkdir()
    (root / "ai" / "AGENTS.md").write_text("# ai", encoding="utf-8")
    package = root / "kernel" / "axeuh_kernel"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text('__version__ = "0.0.0"\n', encoding="utf-8")
    template = root / "ai-template"
    (template / "data" / "tasks").mkdir(parents=True)
    (template / "AGENTS.md").write_text("# template", encoding="utf-8")
    (template / "data" / "tasks" / "sample.yaml").write_text(
        "name: sample\n", encoding="utf-8"
    )
    return root


@pytest.fixture
def env(tmp_path, monkeypatch) -> Iterator[SimpleNamespace]:
    state_file = tmp_path / "state" / "onboarding_state.json"
    monkeypatch.setenv("AEUH_ONBOARDING_STATE", str(state_file))

    config_file = tmp_path / "config.yaml"
    config_file.write_text(
        yaml.safe_dump(BASE_CONFIG, allow_unicode=True), encoding="utf-8"
    )
    monkeypatch.setenv("CONFIG_PATH", str(config_file))
    original_config_path = config_module._CONFIG_PATH
    config_module.set_config_path(str(config_file))
    config_module.get_config.cache_clear()

    project_root = _make_project(tmp_path / "project")
    monkeypatch.setattr(
        system_onboarding, "_project_root", lambda: project_root
    )
    store = ConfigStore(
        _MemoryProvider(BASE_CONFIG),
        draft_path=tmp_path / "config_draft.json",
    )
    monkeypatch.setattr(system_onboarding, "get_config_store", lambda: store)
    monkeypatch.setattr(system_config, "get_config_store", lambda: store)
    monkeypatch.setattr(
        onboarding_service, "_probe_store_status", lambda: None
    )
    monkeypatch.setattr(
        onboarding_service, "_load_live_config", lambda: None
    )
    monkeypatch.setattr(
        onboarding_service.shutil,
        "disk_usage",
        lambda _path: SimpleNamespace(free=10 * 1024 ** 3),
    )
    monkeypatch.setattr(
        onboarding_service,
        "_kernel_models_rows",
        lambda _root: _model_rows(),
    )
    monkeypatch.setattr(
        onboarding_service.kernel_assets,
        "inspect",
        lambda _root: {
            "kernel": {"present": True, "source": "source", "version": "0.0.0"},
            "python": {"exists": True, "source": "default", "last_resort": False},
            "models": {"model_dir": "/tmp/models", "configured": False, "exists": False},
            "disk": {"path": "/tmp", "free": 10**10, "required": 0, "sufficient": True},
            "health": {
                "found": False,
                "alive": False,
                "healthy": False,
                "error": "pidfile_missing",
            },
        },
    )
    monkeypatch.setattr(
        onboarding_service,
        "_inspect_loom_for_preflight",
        lambda: {
            "found": True,
            "source": "config",
            "fingerprint": "abc12345",
            "reachable": True,
            "online": True,
            "errors": [],
        },
    )

    monkeypatch.setattr(auth, "is_setup_required", lambda: False)
    monkeypatch.setattr(
        auth, "verify_setup_token", lambda token: token == "good-token"
    )
    monkeypatch.setattr(
        auth,
        "verify_password",
        lambda user_id, password: (password == "correct-password", user_id),
    )

    app = _build_app()
    with TestClient(app) as client:
        try:
            yield SimpleNamespace(
                client=client,
                tmp_path=tmp_path,
                state_file=state_file,
                config_file=config_file,
                project_root=project_root,
                store=store,
                config_path=config_file,
            )
        finally:
            config_module.set_config_path(original_config_path or "")
            config_module.get_config.cache_clear()


def _checks(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {check["id"]: check for check in payload["checks"]}


def _steps(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {step["id"]: step for step in payload["steps"]}


def _use_missing_config(env: SimpleNamespace, monkeypatch) -> Path:
    missing = env.tmp_path / "absent.yaml"
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        free_port = probe.getsockname()[1]
    monkeypatch.setenv("AXEUH_SETTINGS__SERVER__PORT", str(free_port))
    monkeypatch.setenv("CONFIG_PATH", str(missing))
    config_module.set_config_path(str(missing))
    config_module.get_config.cache_clear()
    return missing


_FINISH_SEQUENCE = (
    ("account", "completed"),
    ("dependencies", "completed"),
    ("kernel", "skipped"),
    ("kernel_models", "skipped"),
    ("xiaomi", "skipped"),
    ("qq", "skipped"),
    ("moss", "skipped"),
    ("loom", "skipped"),
    ("clients", "completed"),
    ("finish", "completed"),
)


def _record_finish_sequence(client: TestClient, *, assert_ok: bool = True):
    response = None
    for step_id, status in _FINISH_SEQUENCE:
        response = client.post(
            STATE_URL,
            json={"step_id": step_id, "status": status},
            headers=USER_HEADERS,
        )
        if assert_ok:
            assert response.status_code == 200, response.text
    return response


def _attach_validated_runtime(client: TestClient, *, promote=None):
    calls: list[str] = []

    async def start():
        calls.append("start")
        return {"subsystems": {"scheduler": "ok"}, "errors": []}

    runtime = BootstrapRuntime(True, start, validator=lambda: True, promote=promote)

    async def _prepare():
        await runtime.attempt("test")
        await runtime.validate()

    asyncio.run(_prepare())
    client.app.state.bootstrap_runtime = runtime
    client.app.state.startup_validation = SimpleNamespace(
        report=lambda: {"ok": True, "state": "validated"}
    )
    return runtime, calls


PRIOR_TO_FINISH = (
    "welcome",
    "account",
    "dependencies",
    "kernel",
    "kernel_models",
    "xiaomi",
    "qq",
    "moss",
    "loom",
    "clients",
)


def _seed_state(
    state_file: Path,
    *,
    completed: tuple[str, ...],
    skipped: tuple[str, ...] = (),
) -> None:
    state_file.parent.mkdir(parents=True, exist_ok=True)
    state_file.write_text(
        json.dumps(
            {
                "version": 4,
                "completed_steps": list(completed),
                "skipped_steps": list(skipped),
            }
        ),
        encoding="utf-8",
    )


def _gate_result(
    *, blocking: tuple[str, ...] = (), soft: tuple[str, ...] = ()
) -> dict:
    hard_ids = {"python", "config", "frontend_dist", "disk", "ports", "ssl"}
    checks = []
    for check_id in CHECK_IDS:
        if check_id in blocking:
            status = "fail"
        elif check_id in soft:
            status = "warn"
        else:
            status = "pass"
        checks.append(
            {
                "id": check_id,
                "label": check_id,
                "status": status,
                "blocking": check_id in hard_ids,
                "category": "test",
                "detail": check_id,
                "fix": "",
            }
        )
    return {
        "checks": checks,
        "can_proceed": not blocking,
        "blocking_failures": list(blocking),
        "soft_failures": list(soft),
        "summary": {
            "pass": sum(1 for check in checks if check["status"] == "pass"),
            "warn": sum(1 for check in checks if check["status"] == "warn"),
            "fail": sum(1 for check in checks if check["status"] == "fail"),
        },
    }


# ---------------------------------------------------------------------------
# POST /state
# ---------------------------------------------------------------------------


def test_state_bootstrap_requires_setup_token(env, monkeypatch):
    monkeypatch.setattr(auth, "is_setup_required", lambda: True)
    body = {"step_id": "welcome", "status": "completed"}

    missing = env.client.post(STATE_URL, json=body)
    assert missing.status_code == 403
    assert missing.json()["code"] == "setup_token_required"
    assert not env.state_file.exists()

    invalid = env.client.post(
        STATE_URL, json=body, headers={"X-Setup-Token": "bad-token"}
    )
    assert invalid.status_code == 403
    assert invalid.json()["code"] == "setup_token_invalid"
    assert not env.state_file.exists()

    accepted = env.client.post(
        STATE_URL, json=body, headers={"X-Setup-Token": "good-token"}
    )
    assert accepted.status_code == 200
    payload = accepted.json()
    assert payload["recorded"] is True
    assert payload["state"]["completed_steps"] == ["welcome"]
    assert payload["state"]["current_step"] == "account"

    persisted = json.loads(env.state_file.read_text(encoding="utf-8"))
    assert persisted["completed_steps"] == ["welcome"]


def test_state_bootstrap_dry_run_does_not_persist(env, monkeypatch):
    monkeypatch.setattr(auth, "is_setup_required", lambda: True)

    response = env.client.post(
        STATE_URL,
        json={"step_id": "welcome", "status": "completed", "dry_run": True},
        headers={"X-Setup-Token": "good-token"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["recorded"] is False
    assert payload["state"]["completed_steps"] == ["welcome"]
    assert not env.state_file.exists()


def test_state_users_requires_user_bearer(env):
    body = {"step_id": "welcome", "status": "completed"}

    missing = env.client.post(STATE_URL, json=body)
    assert missing.status_code == 401
    assert missing.json()["code"] == "auth_required"

    service_token = env.client.post(
        STATE_URL,
        json=body,
        headers={"X-Test-User": "alice", "X-Test-Kind": "service"},
    )
    assert service_token.status_code == 403
    assert service_token.json()["code"] == "token_kind_forbidden"

    accepted = env.client.post(STATE_URL, json=body, headers=USER_HEADERS)
    assert accepted.status_code == 200
    assert accepted.json()["recorded"] is True
    assert env.state_file.is_file()


def test_state_step_ordering_and_resume(env, monkeypatch):
    monkeypatch.setattr(auth, "is_setup_required", lambda: True)
    headers = {"X-Setup-Token": "good-token"}

    first = env.client.post(
        STATE_URL,
        json={"step_id": "welcome", "status": "completed"},
        headers=headers,
    )
    assert first.status_code == 200

    out_of_order = env.client.post(
        STATE_URL,
        json={"step_id": "finish", "status": "completed"},
        headers=headers,
    )
    assert out_of_order.status_code == 409
    assert out_of_order.json()["code"] == "step_out_of_order"

    resumed = env.client.post(
        STATE_URL, json={"step_id": "account", "status": "completed"}, headers=headers
    )
    assert resumed.status_code == 200
    assert resumed.json()["state"]["current_step"] == "dependencies"

    status = env.client.get(STATUS_URL)
    assert status.status_code == 200
    state = status.json()["state"]
    assert state["completed_steps"] == ["welcome", "account"]
    assert state["skipped_steps"] == []
    assert state["current_step"] == "dependencies"


def test_state_invalid_step_and_status_are_json_errors(env, monkeypatch):
    monkeypatch.setattr(auth, "is_setup_required", lambda: True)
    headers = {"X-Setup-Token": "good-token"}

    unknown = env.client.post(
        STATE_URL, json={"step_id": "bogus", "status": "completed"}, headers=headers
    )
    assert unknown.status_code == 422
    assert unknown.json()["code"] == "invalid_step"

    bad_status = env.client.post(
        STATE_URL, json={"step_id": "welcome", "status": "done"}, headers=headers
    )
    assert bad_status.status_code == 422
    assert bad_status.json()["code"] == "invalid_request"

    non_skippable = env.client.post(
        STATE_URL,
        json={"step_id": "dependencies", "status": "skipped"},
        headers=headers,
    )
    assert non_skippable.status_code == 422
    assert non_skippable.json()["code"] == "invalid_step"


# ---------------------------------------------------------------------------
# Finish activation
# ---------------------------------------------------------------------------


def test_finish_activates_bootstrap_runtime_once(env):
    runtime, calls = _attach_validated_runtime(env.client)

    first = _record_finish_sequence(env.client)
    payload = first.json()
    assert payload["recorded"] is True
    assert payload["activation"]["activated"] is True
    assert payload["activation"]["idempotent"] is False
    assert payload["activation"]["subsystems"] == {"scheduler": "ok"}
    assert runtime.active is False
    assert runtime.committed is True

    second = env.client.post(
        STATE_URL,
        json={"step_id": "finish", "status": "completed"},
        headers=USER_HEADERS,
    )
    assert second.status_code == 200
    assert second.json()["activation"]["idempotent"] is True
    assert calls == ["start"]


def test_finish_commit_failure_returns_409(env):
    async def promote():
        raise RuntimeError("promotion exploded")

    runtime, _calls = _attach_validated_runtime(env.client, promote=promote)

    response = _record_finish_sequence(env.client, assert_ok=False)

    assert response.status_code == 409
    payload = response.json()
    assert payload["code"] == "activation_failed"
    assert payload["activation"]["status"] == "not_promoted"
    assert payload["activation"]["committed"] is False
    assert runtime.active is True
    assert runtime.committed is False
    assert "finish" not in onboarding_service.get_state()["completed_steps"]


def test_steps_stage_drafts_until_finish_applies_once(env, monkeypatch):
    async def respawn_ok(paths):
        return {"ok": True}

    monkeypatch.setitem(config_reconciler._RESPAWN_HOOKS, "kernel", respawn_ok)
    config_before = env.config_path.read_bytes()
    pending_headers = {**USER_HEADERS, "X-Config-Password": "correct-password"}
    models_dir = str(env.tmp_path / "models")
    kernel_python_path = env.tmp_path / ".venv-kernel" / "bin" / "python"
    kernel_python_path.parent.mkdir(parents=True)
    kernel_python_path.write_text("#!/usr/bin/env python\n", encoding="utf-8")
    kernel_python_path.chmod(0o755)
    kernel_python = str(kernel_python_path)

    account = env.client.post(
        STATE_URL,
        json={"step_id": "account", "status": "completed"},
        headers=USER_HEADERS,
    )
    assert account.status_code == 200
    dependencies = env.client.post(
        STATE_URL,
        json={
            "step_id": "dependencies",
            "status": "completed",
            "data": {
                "choice": "decline",
                "tiers": ["required"],
                "models_dir": models_dir,
            },
        },
        headers=USER_HEADERS,
    )
    assert dependencies.status_code == 200
    assert dependencies.json()["staged"]["pending"] >= 3

    pending = env.client.get("/api/config/pending", headers=pending_headers)
    assert pending.status_code == 200
    assert pending.json()["count"] >= 3
    assert env.config_path.read_bytes() == config_before
    live = env.client.get("/api/system/config", headers=USER_HEADERS).json()[
        "config"
    ]
    assert live["models"]["dir"] in ("", None)
    assert live["onboarding"]["allow_model_download"] is True

    kernel = env.client.post(
        STATE_URL,
        json={
            "step_id": "kernel",
            "status": "completed",
            "data": {"python": kernel_python},
        },
        headers=USER_HEADERS,
    )
    assert kernel.status_code == 200

    for step_id, status in (
        ("kernel_models", "skipped"),
        ("xiaomi", "skipped"),
        ("qq", "skipped"),
        ("moss", "skipped"),
        ("loom", "skipped"),
        ("clients", "completed"),
    ):
        response = env.client.post(
            STATE_URL,
            json={"step_id": step_id, "status": status},
            headers=USER_HEADERS,
        )
        assert response.status_code == 200, response.text

    runtime, _calls = _attach_validated_runtime(env.client)
    finish = env.client.post(
        STATE_URL,
        json={"step_id": "finish", "status": "completed"},
        headers=USER_HEADERS,
    )
    assert finish.status_code == 200, finish.text
    body = finish.json()
    assert body["recorded"] is True
    assert body["apply"]["failed"] == []
    assert "onboarding.model_tiers" in body["apply"]["applied"]
    assert runtime.committed is True

    after = env.client.get("/api/config/pending", headers=pending_headers)
    assert after.status_code == 200
    assert after.json()["count"] == 0
    final = env.client.get("/api/system/config", headers=USER_HEADERS).json()[
        "config"
    ]
    assert final["models"]["dir"] == models_dir
    assert final["onboarding"]["allow_model_download"] is False
    assert final["onboarding"]["model_tiers"] == ["required"]
    assert final["kernel"]["python"] == kernel_python


def test_invalid_step_config_is_rejected_before_recording(env):
    account = env.client.post(
        STATE_URL,
        json={"step_id": "account", "status": "completed"},
        headers=USER_HEADERS,
    )
    assert account.status_code == 200
    dependencies = env.client.post(
        STATE_URL,
        json={"step_id": "dependencies", "status": "completed"},
        headers=USER_HEADERS,
    )
    assert dependencies.status_code == 200

    response = env.client.post(
        STATE_URL,
        json={
            "step_id": "kernel",
            "status": "completed",
            "data": {"device": "bogus-device"},
        },
        headers=USER_HEADERS,
    )

    assert response.status_code == 422
    payload = response.json()
    assert payload["code"] == "validation_failed"
    assert payload["errors"][0]["path"] == "kernel.device"
    state = json.loads(env.state_file.read_text(encoding="utf-8"))
    assert "kernel" not in state["completed_steps"]
    assert env.store.pending() == {}


# ---------------------------------------------------------------------------
# POST /action
# ---------------------------------------------------------------------------


def test_action_users_requires_current_password(env):
    body = {"action": "copy_ai_template"}

    no_password = env.client.post(ACTION_URL, json=body, headers=USER_HEADERS)
    assert no_password.status_code == 403
    assert no_password.json()["code"] == "password_required"

    wrong = env.client.post(
        ACTION_URL,
        json={**body, "current_password": "wrong-password"},
        headers=USER_HEADERS,
    )
    assert wrong.status_code == 403
    assert wrong.json()["code"] == "password_invalid"

    shutil.rmtree(env.project_root / "ai", ignore_errors=True)
    accepted = env.client.post(
        ACTION_URL,
        json={**body, "current_password": "correct-password"},
        headers=USER_HEADERS,
    )
    assert accepted.status_code == 200
    payload = accepted.json()
    assert payload["ok"] is True
    assert payload["result"]["action"] == "copy_ai_template"
    assert (env.project_root / "ai" / "AGENTS.md").is_file()

    conflict = env.client.post(
        ACTION_URL,
        json={**body, "current_password": "correct-password"},
        headers=USER_HEADERS,
    )
    assert conflict.status_code == 409
    assert conflict.json()["code"] == "already_exists"


def test_action_bootstrap_requires_setup_token(env, monkeypatch):
    monkeypatch.setattr(auth, "is_setup_required", lambda: True)
    body = {"action": "copy_ai_template"}

    missing = env.client.post(ACTION_URL, json=body)
    assert missing.status_code == 403
    assert missing.json()["code"] == "setup_token_required"

    shutil.rmtree(env.project_root / "ai", ignore_errors=True)
    accepted = env.client.post(
        ACTION_URL, json=body, headers={"X-Setup-Token": "good-token"}
    )
    assert accepted.status_code == 200
    assert accepted.json()["ok"] is True
    assert (env.project_root / "ai" / "AGENTS.md").is_file()


@pytest.mark.skipif(
    shutil.which("openssl") is None, reason="openssl unavailable"
)
def test_action_generate_self_signed_cert(env):
    response = env.client.post(
        ACTION_URL,
        json={
            "action": "generate_self_signed_cert",
            "current_password": "correct-password",
        },
        headers=USER_HEADERS,
    )

    assert response.status_code == 200
    result = response.json()["result"]
    assert Path(result["cert"]).is_file()
    assert Path(result["key"]).is_file()


def test_action_invalid_action_is_422(env):
    response = env.client.post(
        ACTION_URL,
        json={"action": "rm_rf", "current_password": "correct-password"},
        headers=USER_HEADERS,
    )

    assert response.status_code == 422
    assert response.json()["code"] == "invalid_request"


# ---------------------------------------------------------------------------
# GET /preflight
# ---------------------------------------------------------------------------


def test_preflight_missing_config_is_warning_not_blocker(env, monkeypatch):
    _use_missing_config(env, monkeypatch)

    response = env.client.get(PREFLIGHT_URL, headers=USER_HEADERS)

    assert response.status_code == 200
    payload = response.json()
    checks = _checks(payload)
    assert [check["id"] for check in payload["checks"]] == CHECK_IDS
    assert checks["config"]["status"] == "warn"
    assert "降级" in checks["config"]["detail"]
    assert checks["ssl"]["status"] == "warn"
    assert checks["ai_backend"]["status"] == "warn"
    assert payload["blocking_failures"] == []
    assert payload["soft_failures"] == ["ai_backend"]
    assert payload["can_proceed"] is True


def test_preflight_schema_exposes_eleven_checks_and_summary(env):
    response = env.client.get(PREFLIGHT_URL, headers=USER_HEADERS)

    assert response.status_code == 200
    payload = response.json()
    assert set(payload) == {
        "checks",
        "can_proceed",
        "blocking_failures",
        "soft_failures",
        "summary",
    }
    assert [check["id"] for check in payload["checks"]] == CHECK_IDS
    assert len({check["id"] for check in payload["checks"]}) == 11
    for check in payload["checks"]:
        assert set(check) == {
            "id",
            "label",
            "status",
            "blocking",
            "category",
            "detail",
            "fix",
        }
        assert check["status"] in {"pass", "warn", "fail"}
        assert isinstance(check["blocking"], bool)
    assert payload["can_proceed"] is True
    assert payload["blocking_failures"] == []
    assert payload["soft_failures"] == []
    assert payload["summary"] == {"pass": 11, "warn": 0, "fail": 0}


def test_preflight_is_public_in_bootstrap_and_has_no_secret_values(env, monkeypatch):
    monkeypatch.setattr(auth, "is_setup_required", lambda: True)

    response = env.client.get(PREFLIGHT_URL)

    assert response.status_code == 200
    assert "test-model" not in json.dumps(response.json(), ensure_ascii=False)


def test_preflight_requires_read_auth_after_setup(env):
    unauthorized = env.client.get(PREFLIGHT_URL)
    assert unauthorized.status_code == 401
    assert unauthorized.json()["code"] == "auth_required"

    response = env.client.get(PREFLIGHT_URL, headers=USER_HEADERS)
    assert response.status_code == 200
    assert [check["id"] for check in response.json()["checks"]] == CHECK_IDS


def test_assets_requires_read_auth_and_returns_dependencies(env, monkeypatch):
    async def _missing_manifest():
        raise system_onboarding.release_assets.ReleaseConfigError(
            "release_manifest_not_configured", "not configured"
        )

    monkeypatch.setattr(system_onboarding, "_fetch_manifest", _missing_manifest)

    unauthorized = env.client.get(ASSETS_URL)
    assert unauthorized.status_code == 401

    response = env.client.get(ASSETS_URL, headers=USER_HEADERS)

    assert response.status_code == 200
    payload = response.json()
    assert payload["configured"] is True
    assert payload["assets"] == {}
    dependencies = payload["dependencies"]
    assert set(dependencies) == {
        "kernel",
        "python",
        "models",
        "disk",
        "health",
    }


def test_finish_record_hard_failure_returns_409(env, monkeypatch):
    _seed_state(env.state_file, completed=PRIOR_TO_FINISH)
    monkeypatch.setattr(
        onboarding_service,
        "run_preflight",
        lambda *args, **kwargs: _gate_result(blocking=("frontend_dist",)),
    )

    response = env.client.post(
        STATE_URL,
        json={"step_id": "finish", "status": "completed"},
        headers=USER_HEADERS,
    )

    assert response.status_code == 409
    payload = response.json()
    assert payload["code"] == "preflight_blocked"
    assert [check["id"] for check in payload["checks"]] == CHECK_IDS
    assert payload["blocking_failures"] == ["frontend_dist"]
    assert payload["can_proceed"] is False
    assert "finish" not in onboarding_service.get_state()["completed_steps"]


def test_finish_record_soft_failure_requires_ack(env, monkeypatch):
    _seed_state(env.state_file, completed=PRIOR_TO_FINISH)
    _attach_validated_runtime(env.client)
    monkeypatch.setattr(
        onboarding_service,
        "run_preflight",
        lambda *args, **kwargs: _gate_result(soft=("ai_dir",)),
    )

    refused = env.client.post(
        STATE_URL,
        json={"step_id": "finish", "status": "completed"},
        headers=USER_HEADERS,
    )

    assert refused.status_code == 409
    assert refused.json()["code"] == "degraded_requires_ack"
    assert refused.json()["soft_failures"] == ["ai_dir"]

    accepted = env.client.post(
        STATE_URL,
        json={
            "step_id": "finish",
            "status": "completed",
            "data": {"allow_degraded": True},
        },
        headers=USER_HEADERS,
    )

    assert accepted.status_code == 200
    state = accepted.json()["state"]
    assert "finish" in state["completed_steps"]
    assert state["completed"] is True
    assert state["step_data"]["finish"]["allow_degraded"] is True
    assert state["step_data"]["finish"]["soft_failures"] == ["ai_dir"]


def test_finish_hard_failure_returns_409(env, monkeypatch):
    _seed_state(env.state_file, completed=PRIOR_TO_FINISH)
    monkeypatch.setattr(
        onboarding_service,
        "run_preflight",
        lambda *args, **kwargs: _gate_result(blocking=("disk",)),
    )

    response = env.client.post(
        STATE_URL,
        json={
            "step_id": "finish",
            "status": "completed",
            "data": {"allow_degraded": True},
        },
        headers=USER_HEADERS,
    )

    assert response.status_code == 409
    assert response.json()["code"] == "preflight_blocked"
    assert "finish" not in onboarding_service.get_state()["completed_steps"]


def test_finish_soft_failure_requires_ack_then_records(env, monkeypatch):
    _seed_state(env.state_file, completed=PRIOR_TO_FINISH)
    _attach_validated_runtime(env.client)
    monkeypatch.setattr(
        onboarding_service,
        "run_preflight",
        lambda *args, **kwargs: _gate_result(soft=("loom",)),
    )

    refused = env.client.post(
        STATE_URL,
        json={"step_id": "finish", "status": "completed"},
        headers=USER_HEADERS,
    )
    assert refused.status_code == 409
    assert refused.json()["code"] == "degraded_requires_ack"

    accepted = env.client.post(
        STATE_URL,
        json={
            "step_id": "finish",
            "status": "completed",
            "data": {"allow_degraded": True},
        },
        headers=USER_HEADERS,
    )

    assert accepted.status_code == 200
    assert accepted.json()["state"]["completed"] is True


def test_removed_step_ids_are_rejected(env):
    preflight = env.client.post(
        STATE_URL,
        json={"step_id": "preflight", "status": "completed"},
        headers=USER_HEADERS,
    )
    startup = env.client.post(
        STATE_URL,
        json={"step_id": "startup", "status": "completed"},
        headers=USER_HEADERS,
    )

    assert preflight.status_code == 422
    assert preflight.json()["code"] == "invalid_step"
    assert startup.status_code == 422
    assert startup.json()["code"] == "invalid_step"


def test_finish_promotes_deferred_integrations_once_then_commits(env):
    promoted: list[str] = []

    async def promote():
        promoted.append("promote")
        return {"subsystems": {"health_cloud": "ok"}, "errors": []}

    runtime, _calls = _attach_validated_runtime(env.client, promote=promote)

    response = _record_finish_sequence(env.client)

    assert response.status_code == 200
    payload = response.json()
    assert payload["recorded"] is True
    assert payload["activation"]["activated"] is True
    assert payload["activation"]["committed"] is True
    assert payload["activation"]["promoted"] is True
    assert payload["activation"]["subsystems"] == {
        "scheduler": "ok",
        "health_cloud": "ok",
    }
    assert promoted == ["promote"]
    assert runtime.state == "committed"
    assert runtime.active is False


def test_finish_without_validated_runtime_returns_structured_409(env, monkeypatch):
    _seed_state(env.state_file, completed=PRIOR_TO_FINISH)
    monkeypatch.setattr(
        onboarding_service,
        "run_preflight",
        lambda *args, **kwargs: _gate_result(),
    )

    response = env.client.post(
        STATE_URL,
        json={"step_id": "finish", "status": "completed"},
        headers=USER_HEADERS,
    )

    assert response.status_code == 409
    payload = response.json()
    assert payload["code"] == "startup_required"
    assert payload["startup"] == {}
    assert payload["runtime"] == {}
    assert "finish" not in onboarding_service.get_state()["completed_steps"]


def test_finish_with_failed_validation_returns_409_with_report(env, monkeypatch):
    _seed_state(env.state_file, completed=PRIOR_TO_FINISH)
    monkeypatch.setattr(
        onboarding_service,
        "run_preflight",
        lambda *args, **kwargs: _gate_result(),
    )
    env.client.app.state.bootstrap_runtime = BootstrapRuntime(True)
    env.client.app.state.startup_validation = SimpleNamespace(
        report=lambda: {
            "ok": False,
            "state": "failed",
            "errors": [{"subsystem": "scheduler", "error": "not running"}],
        }
    )

    response = env.client.post(
        STATE_URL,
        json={"step_id": "finish", "status": "completed"},
        headers=USER_HEADERS,
    )

    assert response.status_code == 409
    payload = response.json()
    assert payload["code"] == "startup_failed"
    assert payload["startup"]["errors"] == [
        {"subsystem": "scheduler", "error": "not running"}
    ]
    assert payload["runtime"]["state"] == "deferred"
    assert "finish" not in onboarding_service.get_state()["completed_steps"]


# ---------------------------------------------------------------------------
# GET /status
# ---------------------------------------------------------------------------


def test_status_legacy_complete_for_users_without_state_file(env):
    response = env.client.get(STATUS_URL, headers=USER_HEADERS)

    assert response.status_code == 200
    payload = response.json()
    assert set(payload) == {
        "state",
        "needs_setup",
        "degraded",
        "onboarding_complete",
        "config_revision",
        "steps",
        "bootstrap",
        "state_version",
        "legacy_upgraded",
        "degraded_reasons",
    }
    assert payload["needs_setup"] is False
    assert payload["degraded"] is False
    assert payload["onboarding_complete"] is True
    assert payload["state"]["completed"] is False
    assert isinstance(payload["config_revision"], str)
    assert not env.state_file.exists()

    assert payload["bootstrap"] is False
    assert payload["state_version"] == 4
    assert payload["legacy_upgraded"] is False
    assert payload["degraded_reasons"] == []
    assert [step["id"] for step in payload["steps"]] == [
        "welcome",
        "account",
        "dependencies",
        "kernel",
        "kernel_models",
        "xiaomi",
        "qq",
        "moss",
        "loom",
        "clients",
        "finish",
    ]
    steps = _steps(payload)
    assert steps["welcome"]["state"] == "current"
    assert steps["welcome"]["required"] is True
    assert steps["welcome"]["skippable"] is False
    assert steps["welcome"]["write_auth"] == "bearer"
    assert steps["xiaomi"]["required"] is True
    assert steps["xiaomi"]["skippable"] is True
    assert steps["xiaomi"]["auth"] == "password"
    assert steps["qq"]["required"] is True
    assert steps["qq"]["skippable"] is True
    assert steps["moss"]["required"] is True
    assert steps["moss"]["skippable"] is True
    assert steps["finish"]["auth"] == "bearer"
    assert steps["finish"]["state"] == "pending"


def test_status_after_admin_created_before_first_step_stays_incomplete(
    env, monkeypatch
):
    monkeypatch.delenv("AXEUH_ONBOARDING_BOOTSTRAP", raising=False)
    monkeypatch.setattr(auth, "is_setup_required", lambda: True)
    assert onboarding_service.ensure_fresh_state() is True
    monkeypatch.setattr(auth, "is_setup_required", lambda: False)

    payload = env.client.get(STATUS_URL, headers=USER_HEADERS).json()

    assert payload["needs_setup"] is False
    assert payload["onboarding_complete"] is False
    assert payload["bootstrap"] is True
    assert payload["state"]["completed"] is False
    assert env.state_file.is_file()


def test_status_incomplete_without_users(env, monkeypatch):
    monkeypatch.setattr(auth, "is_setup_required", lambda: True)

    payload = env.client.get(STATUS_URL).json()

    assert payload["needs_setup"] is True
    assert payload["onboarding_complete"] is False
    assert payload["bootstrap"] is True
    assert _steps(payload)["welcome"]["state"] == "current"


def test_status_incomplete_when_users_exist_but_config_degraded(env, monkeypatch):
    runtime = onboarding_service.ConfigRuntimeStatus(
        degraded=True,
        revision="rev-degraded",
        provider="yaml",
        detail="test",
    )
    monkeypatch.setattr(
        onboarding_service, "read_config_runtime_status", lambda: runtime
    )

    payload = env.client.get(STATUS_URL, headers=USER_HEADERS).json()

    assert payload["degraded"] is True
    assert payload["config_revision"] == "rev-degraded"
    assert payload["onboarding_complete"] is False
    assert payload["bootstrap"] is False
    assert payload["degraded_reasons"] == ["test"]


def test_status_migrates_v1_state_and_exposes_step_states(env):
    env.state_file.parent.mkdir(parents=True, exist_ok=True)
    env.state_file.write_text(
        json.dumps(
            {
                "version": 1,
                "completed_steps": ["preflight", "server", "admin"],
                "skipped_steps": ["integrations", "finish"],
                "completed": False,
            }
        ),
        encoding="utf-8",
    )

    payload = env.client.get(STATUS_URL, headers=USER_HEADERS).json()

    assert payload["state_version"] == 4
    assert payload["legacy_upgraded"] is True
    assert payload["state"]["completed_steps"] == [
        "welcome",
        "account",
        "dependencies",
    ]
    assert payload["state"]["skipped_steps"] == ["xiaomi", "qq", "moss"]
    steps = _steps(payload)
    assert steps["welcome"]["state"] == "completed"
    assert steps["account"]["state"] == "completed"
    assert steps["dependencies"]["state"] == "completed"
    assert steps["moss"]["state"] == "skipped"
    assert steps["kernel"]["state"] == "current"


def test_status_bootstrap_redacts_step_data(env, monkeypatch):
    monkeypatch.setattr(auth, "is_setup_required", lambda: True)
    env.state_file.parent.mkdir(parents=True, exist_ok=True)
    env.state_file.write_text(
        json.dumps(
            {
                "version": 3,
                "completed_steps": ["welcome", "account"],
                "skipped_steps": [],
                "step_data": {"account": {"username": "bootstrap-admin"}},
                "legacy_step_data": {"admin": {"username": "legacy-admin"}},
            }
        ),
        encoding="utf-8",
    )

    response = env.client.get(STATUS_URL)

    assert response.status_code == 200
    payload = response.json()
    assert "step_data" not in payload["state"]
    assert "legacy_step_data" not in payload["state"]
    body = json.dumps(payload, ensure_ascii=False)
    assert "bootstrap-admin" not in body
    assert "legacy-admin" not in body


def test_status_requires_read_auth_after_setup(env):
    env.state_file.parent.mkdir(parents=True, exist_ok=True)
    env.state_file.write_text(
        json.dumps(
            {
                "version": 4,
                "completed_steps": ["welcome"],
                "skipped_steps": [],
                "step_data": {"account": {"username": "configured-admin"}},
            }
        ),
        encoding="utf-8",
    )

    unauthorized = env.client.get(STATUS_URL)
    assert unauthorized.status_code == 401
    assert unauthorized.json()["code"] == "auth_required"

    response = env.client.get(STATUS_URL, headers=USER_HEADERS)
    assert response.status_code == 200
    assert response.json()["state"]["step_data"] == {
        "account": {"username": "configured-admin"}
    }


# ---------------------------------------------------------------------------
# AuthMiddleware integration for optional-auth write paths
# ---------------------------------------------------------------------------


def _build_app_with_real_auth_middleware() -> FastAPI:
    app = FastAPI()
    app.add_middleware(AuthMiddleware)
    app.include_router(system_onboarding.router)
    return app


def test_real_auth_middleware_injects_user_bearer(env, monkeypatch):
    from middleware import auth_middleware

    monkeypatch.setattr(
        auth_middleware,
        "verify_token_full",
        lambda token: (
            (True, "alice", "user", "")
            if token == "user-token"
            else (False, None, "", "")
        ),
    )
    body = {"step_id": "welcome", "status": "completed"}
    app = _build_app_with_real_auth_middleware()

    with TestClient(app) as client:
        anonymous = client.get(STATUS_URL)
        assert anonymous.status_code == 401
        assert client.get(
            STATUS_URL, headers={"Authorization": "Bearer user-token"}
        ).status_code == 200
        assert client.post(STATE_URL, json=body).status_code == 401
        accepted = client.post(
            STATE_URL,
            json=body,
            headers={"Authorization": "Bearer user-token"},
        )
        assert accepted.status_code == 200


def test_real_auth_middleware_allows_setup_token_without_bearer(env, monkeypatch):
    monkeypatch.setattr(auth, "is_setup_required", lambda: True)
    app = _build_app_with_real_auth_middleware()

    with TestClient(app) as client:
        accepted = client.post(
            STATE_URL,
            json={"step_id": "welcome", "status": "completed"},
            headers={"X-Setup-Token": "good-token"},
        )

    assert accepted.status_code == 200
    assert accepted.json()["recorded"] is True
