# -*- coding: utf-8 -*-
"""N13: /api/system 配置 HTTP 契约。

测试把 ``routers.system_config`` 挂在一次性 FastAPI 应用上，身份由测试中间件
注入，写授权与 ConfigStore 全部替换为内存替身：不读写仓库 config.yaml /
auth.json，不启 watcher，不发网络请求。

GET 掩码用例使用真实 ``ConfigStore`` + 内存 provider，以验证 ``masked_config``
而不是替身自证的掩码；PUT 用例使用 FakeStore，逐项钉住 save/apply 调用与错误映射。
"""
from __future__ import annotations

import copy
from types import SimpleNamespace
from typing import Any, Iterator

import pytest
import yaml
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from config.config_schema import SchemaError, defaults_document, validate_changes
from config.providers import ProviderInfo, YamlFileProvider
from config.store import (
    REPO_ROOT,
    ApplyReport,
    ConfigChange,
    ConfigEnvLocked,
    ConfigReadOnly,
    ConfigRevisionConflict,
    ConfigSaveOutcome,
    ConfigStore,
    ConfigValidationError,
    ConfigWriteError,
)
from routers import system_config
import services.config_authz as config_authz
from services.config_authz import ConfigAuthError

CONFIG_URL = "/api/system/config"
SCHEMA_URL = "/api/system/config/schema"
STATUS_URL = "/api/system/config/status"
VALIDATE_URL = "/api/system/config/validate"
RESTART_URL = "/api/system/config/restart"

DEPLOYMENT_COMMAND = "sudo systemctl restart axeuh-health"


class MemoryProvider:
    """最小可写 provider：只服务 GET 掩码用例，不触碰文件系统。"""

    kind = "memory"

    def __init__(self, document: dict[str, Any] | None = None) -> None:
        self._document = copy.deepcopy(document or {})
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


class FakeStore:
    """ConfigStore 替身：固定快照/应用结果，可注入 save 异常。"""

    def __init__(
        self,
        *,
        base: dict[str, Any] | None = None,
        revision: str = "rev-1",
        outcome: ConfigSaveOutcome | None = None,
        save_error: Exception | None = None,
        apply_report: ApplyReport | None = None,
        degraded: list[str] | None = None,
    ) -> None:
        self._base = copy.deepcopy(base if base is not None else defaults_document())
        self._revision = revision
        self._outcome = outcome
        self._save_error = save_error
        self._apply_report = apply_report or ApplyReport()
        self._degraded = list(degraded or [])
        self._warnings: list[SchemaError] = []
        self.save_calls: list[dict[str, Any]] = []
        self.apply_calls: list[ConfigChange] = []
        self.apply_failures: dict[str, str] = {}

    @property
    def revision(self) -> str:
        return self._revision

    @property
    def degraded(self) -> list[str]:
        return list(self._degraded)

    @property
    def warnings(self) -> list[SchemaError]:
        return list(self._warnings)

    def base_document(self) -> dict[str, Any]:
        return copy.deepcopy(self._base)

    def snapshot(self) -> dict[str, Any]:
        return copy.deepcopy(self._base)

    def masked_config(self) -> dict[str, Any]:
        return copy.deepcopy(self._base)

    def provider_info(self) -> ProviderInfo:
        return ProviderInfo(
            kind="fake",
            location="/tmp/fake-config.yaml",
            writable=True,
            detail="fake provider",
        )

    def save(
        self,
        changes: dict[str, Any],
        clear_keys: list[str] | None = None,
        *,
        expected_revision: str | None = None,
    ) -> ConfigSaveOutcome:
        self.save_calls.append(
            {
                "changes": copy.deepcopy(changes),
                "clear_keys": list(clear_keys or ()),
                "expected_revision": expected_revision,
            }
        )
        if self._save_error is not None:
            raise self._save_error
        if self._outcome is not None:
            return self._outcome
        old = copy.deepcopy(self._base)
        merged, _errors = validate_changes(
            old, changes, clear_keys, project_root=REPO_ROOT, strict=False
        )
        self._base = merged
        return ConfigSaveOutcome(
            change=ConfigChange(
                old=old,
                new=merged,
                changed_paths=ConfigStore.changed_paths(old, merged),
            ),
            revision=self._revision,
            warnings=[],
        )

    async def apply(self, change: ConfigChange) -> ApplyReport:
        self.apply_calls.append(change)
        self.apply_failures = dict(self._apply_report.failed)
        return self._apply_report


def _build_app() -> FastAPI:
    app = FastAPI()

    @app.middleware("http")
    async def _inject_identity(request: Request, call_next):
        user_id = request.headers.get("X-Test-User", "").strip()
        if user_id:
            request.state.user_id = user_id
            request.state.token_kind = request.headers.get("X-Test-Kind", "user")
        return await call_next(request)

    app.include_router(system_config.router)
    return app


@pytest.fixture
def client(monkeypatch) -> Iterator[TestClient]:
    async def _allow(request: Request, password: str | None = None):
        return SimpleNamespace(user_id="tester", method="password", token_kind="user")

    monkeypatch.setattr(system_config, "require_config_write", _allow)
    with TestClient(_build_app()) as test_client:
        yield test_client


def _install_store(monkeypatch, store: Any) -> None:
    monkeypatch.setattr(system_config, "get_config_store", lambda: store)


def _real_store() -> ConfigStore:
    return ConfigStore(
        MemoryProvider(
            {
                "server": {"port": 9443},
                "loom": {"token": "totally-secret-token"},
                "api": {
                    "mimo_key": "mimo-secret",
                    "dashscope_key": "dashscope-secret",
                },
                "tts": {"enabled": False},
            }
        ),
        watcher_interval_s=0.01,
    )


# ---------------------------------------------------------------------------
# GET /config, /config/schema, /config/status
# ---------------------------------------------------------------------------


def test_get_config_masks_secrets_and_reports_runtime_shape(client, monkeypatch):
    store = _real_store()
    _install_store(monkeypatch, store)
    monkeypatch.setattr(config_authz.auth, "is_setup_required", lambda: False)

    response = client.get(CONFIG_URL, headers={"X-Test-User": "alice"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["revision"] == store.revision
    assert payload["path"] == "memory://test"
    assert payload["provider"] == {
        "kind": "memory",
        "location": "memory://test",
        "writable": True,
        "detail": "in-memory test provider",
    }
    assert payload["config"]["loom"]["token"] == "***"
    assert payload["config"]["api"]["mimo_key"] == "***"
    assert payload["config"]["api"]["dashscope_key"] == "***"
    assert payload["config"]["server"]["port"] == 9443
    assert "totally-secret-token" not in response.text
    assert "mimo-secret" not in response.text
    assert "dashscope-secret" not in response.text
    assert response.headers["cache-control"] == "no-store"
    assert payload["degraded"] == []
    assert payload["warnings"] == []
    assert payload["apply_failures"] == {}
    assert payload["schema_version"] == "1"


def test_get_config_hides_legacy_opencode_sections(client, monkeypatch):
    store = ConfigStore(
        MemoryProvider(
            {
                "ai_backend": "loom",
                "opencode": {"enabled": True, "url": "http://127.0.0.1:4096"},
                "features": {"opencode_mock_enabled": True, "keep": True},
                "launcher": {"opencode_cmd": "opencode", "conda_python": "python"},
            }
        ),
        watcher_interval_s=0.01,
    )
    _install_store(monkeypatch, store)
    monkeypatch.setattr(config_authz.auth, "is_setup_required", lambda: True)

    response = client.get(CONFIG_URL)

    assert response.status_code == 200
    config = response.json()["config"]
    assert "opencode" not in config
    assert config["features"] == {"keep": True}
    assert config["launcher"] == {"conda_python": "python"}


def test_get_config_requires_user_token_when_users_exist(client, monkeypatch):
    _install_store(monkeypatch, _real_store())
    monkeypatch.setattr(config_authz.auth, "is_setup_required", lambda: False)

    anonymous = client.get(CONFIG_URL)
    assert anonymous.status_code == 401
    assert anonymous.json()["code"] == "auth_required"

    user = client.get(CONFIG_URL, headers={"X-Test-User": "alice"})
    assert user.status_code == 200

    for kind in ("service", "device"):
        denied = client.get(
            CONFIG_URL,
            headers={"X-Test-User": "alice", "X-Test-Kind": kind},
        )
        assert denied.status_code == 403
        assert denied.json()["code"] == "token_kind_forbidden"


def test_get_config_allowed_without_auth_in_bootstrap_mode(client, monkeypatch):
    _install_store(monkeypatch, _real_store())
    monkeypatch.setattr(config_authz.auth, "is_setup_required", lambda: True)

    response = client.get(CONFIG_URL)

    assert response.status_code == 200
    assert response.json()["config"]["loom"]["token"] == "***"


def test_config_read_endpoints_require_user_after_setup(client, monkeypatch):
    _install_store(monkeypatch, FakeStore())
    monkeypatch.setattr(config_authz.auth, "is_setup_required", lambda: False)

    for method, url in (
        ("get", SCHEMA_URL),
        ("get", STATUS_URL),
        ("post", VALIDATE_URL),
    ):
        request = getattr(client, method)
        response = request(url, json={"changes": {}}) if method == "post" else request(url)
        assert response.status_code == 401
        assert response.json()["code"] == "auth_required"

    assert client.get(
        SCHEMA_URL, headers={"X-Test-User": "alice"}
    ).status_code == 200
    assert client.get(
        STATUS_URL, headers={"X-Test-User": "alice"}
    ).status_code == 200
    assert client.post(
        VALIDATE_URL,
        headers={"X-Test-User": "alice"},
        json={"changes": {}},
    ).status_code == 200


def test_config_read_endpoints_allow_bootstrap_schema_validate_submit(
    client, monkeypatch
):
    store = FakeStore()
    _install_store(monkeypatch, store)
    monkeypatch.setattr(config_authz.auth, "is_setup_required", lambda: True)
    monkeypatch.setattr(
        config_authz.auth, "verify_setup_token", lambda token: token == "setup-test"
    )
    monkeypatch.setattr(
        system_config, "require_config_write", config_authz.require_config_write
    )

    schema = client.get(SCHEMA_URL)
    validate = client.post(
        VALIDATE_URL,
        json={"changes": {"server.host": "127.0.0.1"}},
    )
    submit = client.put(
        CONFIG_URL,
        headers={"X-Setup-Token": "setup-test"},
        json={
            "revision": "rev-1",
            "changes": {"server.host": "127.0.0.1"},
        },
    )

    assert schema.status_code == 200
    assert validate.status_code == 200
    assert submit.status_code == 200
    assert store.save_calls
    assert store.apply_calls
    assert schema.headers["cache-control"] == "no-store"
    assert validate.headers["cache-control"] == "no-store"


def test_get_schema_exposes_core_advanced_and_apply_strategy(client):
    response = client.get(SCHEMA_URL, headers={"X-Test-User": "alice"})

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    payload = response.json()
    assert payload["schema_version"] == "1"

    categories = {item["id"]: item for item in payload["categories"]}
    assert categories["server"]["advanced"] is False
    assert categories["launcher"]["advanced"] is True

    fields = {item["path"]: item for item in payload["fields"]}
    port = fields["server.port"]
    assert port["type"] == "int"
    assert port["core"] is True
    assert port["advanced"] is False
    assert port["apply_strategy"] == "hot"
    assert port["min"] == 1
    assert port["max"] == 65535
    assert port["enum"] == []

    assert "opencode.enabled" not in fields
    assert "features.opencode_mock_enabled" not in fields
    assert "launcher.opencode_cmd" not in fields
    assert fields["ai_backend"]["enum"] == ["loom"]
    assert fields["ai_backend"]["default"] == "loom"
    assert fields["api.mimo_key"]["sensitive"] is True

    advanced = [item for item in payload["fields"] if item["advanced"]]
    assert advanced
    assert all(item["core"] is False for item in advanced)


def test_get_status_reports_degraded_warnings_and_apply_failures(client, monkeypatch):
    store = FakeStore(
        revision="rev-7",
        degraded=["config_missing"],
    )
    store._warnings = [
        SchemaError("server.host", "required_missing", "server.host 不能为空", "warning")
    ]
    store.apply_failures = {"ai_clients": "boom"}
    _install_store(monkeypatch, store)

    response = client.get(STATUS_URL, headers={"X-Test-User": "alice"})

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    payload = response.json()
    assert set(payload) == {
        "revision",
        "path",
        "provider",
        "degraded",
        "warnings",
        "apply_failures",
    }
    assert payload["revision"] == "rev-7"
    assert payload["path"] == "/tmp/fake-config.yaml"
    assert payload["provider"]["kind"] == "fake"
    assert payload["degraded"] == ["config_missing"]
    assert payload["warnings"] == [
        {
            "path": "server.host",
            "code": "required_missing",
            "message": "server.host 不能为空",
            "severity": "warning",
        }
    ]
    assert payload["apply_failures"] == {"ai_clients": "boom"}


def test_get_status_redacts_secrets_in_apply_failures(client, monkeypatch):
    secret = "sk-live-apply-secret-0123456789"
    store = FakeStore(revision="rev-8")
    store.apply_failures = {"ai_clients": f"Authorization: Bearer {secret}"}
    _install_store(monkeypatch, store)

    response = client.get(STATUS_URL, headers={"X-Test-User": "alice"})

    assert response.status_code == 200
    assert secret not in response.text
    assert response.json()["apply_failures"]["ai_clients"] != f"Authorization: Bearer {secret}"


# ---------------------------------------------------------------------------
# POST /config/validate
# ---------------------------------------------------------------------------


def test_validate_returns_200_with_warnings(client, monkeypatch):
    store = FakeStore()
    _install_store(monkeypatch, store)

    response = client.post(
        VALIDATE_URL,
        headers={"X-Test-User": "alice"},
        json={"changes": {}, "clear_keys": ["opencode.default_agent"]},
    )

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    payload = response.json()
    assert payload["ok"] is True
    assert any(
        warning["path"] == "opencode.default_agent"
        and warning["code"] == "required_missing"
        and warning["severity"] == "warning"
        for warning in payload["warnings"]
    )
    assert store.save_calls == []


@pytest.mark.parametrize(
    ("changes", "expected_code"),
    [
        ({"not.a.key": 1}, "unknown_key"),
        ({"server.port": "9000"}, "type_mismatch"),
        ({"server.port": 80_000}, "out_of_range"),
    ],
)
def test_validate_returns_422_with_schema_errors(
    client, monkeypatch, changes, expected_code
):
    store = FakeStore()
    _install_store(monkeypatch, store)

    response = client.post(
        VALIDATE_URL,
        headers={"X-Test-User": "alice"},
        json={"changes": changes},
    )

    assert response.status_code == 422
    payload = response.json()
    assert payload["code"] == "validation_failed"
    assert payload["message"]
    errors = payload["errors"]
    assert any(error["code"] == expected_code for error in errors)
    assert all(
        set(error) == {"path", "code", "message", "severity"} for error in errors
    )
    assert store.save_calls == []


# ---------------------------------------------------------------------------
# PUT /config
# ---------------------------------------------------------------------------


def _success_outcome() -> tuple[dict[str, Any], ConfigSaveOutcome]:
    old = defaults_document()
    new = copy.deepcopy(old)
    new["tts"]["enabled"] = False
    outcome = ConfigSaveOutcome(
        change=ConfigChange(
            old=old,
            new=new,
            changed_paths=("tts.enabled",),
        ),
        revision="rev-2",
        warnings=[
            SchemaError(
                "server.port",
                "cross_field",
                "示例警告",
                "warning",
            )
        ],
    )
    return old, outcome


def test_put_success_saves_and_applies_hot(client, monkeypatch):
    _old, outcome = _success_outcome()
    store = FakeStore(
        revision="rev-1",
        outcome=outcome,
        apply_report=ApplyReport(
            applied=("ai_clients", "audio_cache"),
            failed={"audio_ingest": "kernel down"},
        ),
        degraded=["apply_failed: audio_ingest"],
    )
    _install_store(monkeypatch, store)

    response = client.put(
        CONFIG_URL,
        json={
            "revision": "rev-1",
            "current_password": "pw",
            "changes": {"tts.enabled": False},
        },
        headers={"X-Test-User": "alice"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload == {
        "ok": True,
        "revision": "rev-2",
        "changed": ["tts.enabled"],
        "applied": ["ai_clients", "audio_cache"],
        "failed": {"audio_ingest": "kernel down"},
        "degraded": ["apply_failed: audio_ingest"],
        "warnings": [
            {
                "path": "server.port",
                "code": "cross_field",
                "message": "示例警告",
                "severity": "warning",
            }
        ],
        "dry_run": False,
    }
    assert store.save_calls == [
        {
            "changes": {"tts.enabled": False},
            "clear_keys": [],
            "expected_revision": "rev-1",
        }
    ]
    assert len(store.apply_calls) == 1
    assert store.apply_calls[0].changed_paths == ("tts.enabled",)


def test_put_with_real_store_hot_writes_and_advances_revision(
    client, monkeypatch, tmp_path
):
    config_file = tmp_path / "config.yaml"
    config_file.write_text(
        yaml.safe_dump(defaults_document(), allow_unicode=True),
        encoding="utf-8",
    )
    store = ConfigStore(
        YamlFileProvider(config_file), watcher_interval_s=0.01
    )
    _install_store(monkeypatch, store)
    before = store.revision

    response = client.put(
        CONFIG_URL,
        json={
            "revision": before,
            "current_password": "pw",
            "changes": {"tts.enabled": False},
        },
        headers={"X-Test-User": "alice"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["changed"] == ["tts.enabled"]
    assert payload["applied"] == []
    assert payload["failed"] == {}
    assert payload["revision"] != before
    persisted = yaml.safe_load(config_file.read_text(encoding="utf-8"))
    assert persisted["tts"]["enabled"] is False


@pytest.mark.parametrize(
    ("changes", "expected_changed"),
    [
        ({"tts.enabled": False}, ["tts.enabled"]),
        ({"tts": {"enabled": False}}, ["tts.enabled"]),
    ],
)
def test_put_dry_run_validates_without_save(
    client, monkeypatch, changes, expected_changed
):
    store = FakeStore(revision="rev-1")
    _install_store(monkeypatch, store)

    response = client.put(
        CONFIG_URL,
        json={
            "revision": "rev-1",
            "changes": changes,
            "dry_run": True,
        },
        headers={"X-Test-User": "alice"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert payload["revision"] == "rev-1"
    assert payload["changed"] == expected_changed
    assert payload["applied"] == []
    assert payload["failed"] == {}
    assert payload["dry_run"] is True
    assert store.save_calls == []
    assert store.apply_calls == []


@pytest.mark.parametrize(
    "changes",
    [
        {"opencode.enabled": False},
        {"launcher.conda_python": "python3"},
        {"opencode": {"enabled": False}},
    ],
)
def test_put_rejects_deployment_wiring_changes(client, monkeypatch, changes):
    store = FakeStore()
    _install_store(monkeypatch, store)

    response = client.put(
        CONFIG_URL,
        json={
            "revision": "rev-1",
            "current_password": "pw",
            "changes": changes,
        },
        headers={"X-Test-User": "alice"},
    )

    assert response.status_code == 409
    payload = response.json()
    assert payload["code"] == "deployment_required"
    assert payload["command"] == DEPLOYMENT_COMMAND
    assert payload["errors"]
    assert store.save_calls == []


def test_put_rejects_apply_strategy_none_with_422(client, monkeypatch):
    store = FakeStore()
    _install_store(monkeypatch, store)

    response = client.put(
        CONFIG_URL,
        json={
            "revision": "rev-1",
            "current_password": "pw",
            "changes": {"log.level": "DEBUG"},
        },
        headers={"X-Test-User": "alice"},
    )

    assert response.status_code == 422
    payload = response.json()
    assert payload["code"] == "unsupported_change"
    assert any(error["path"] == "log.level" for error in payload["errors"])
    assert store.save_calls == []


def test_put_allows_clearing_existing_deprecated_key(client, monkeypatch):
    store = FakeStore(base={**defaults_document(), "log": {"level": "INFO"}})
    _install_store(monkeypatch, store)

    response = client.put(
        CONFIG_URL,
        json={
            "revision": "rev-1",
            "current_password": "pw",
            "changes": {},
            "clear_keys": ["log.level"],
        },
        headers={"X-Test-User": "alice"},
    )

    assert response.status_code == 200
    assert store.save_calls
    assert store.save_calls[0]["clear_keys"] == ["log.level"]
    assert "level" not in store.snapshot().get("log", {})


def test_put_auth_error_maps_config_authz_response(client, monkeypatch):
    store = FakeStore()
    _install_store(monkeypatch, store)

    async def _deny(request: Request, password: str | None = None):
        raise ConfigAuthError(403, "password_invalid", "密码错误")

    monkeypatch.setattr(system_config, "require_config_write", _deny)

    response = client.put(
        CONFIG_URL,
        json={
            "revision": "rev-1",
            "current_password": "wrong",
            "changes": {"tts.enabled": False},
        },
        headers={"X-Test-User": "alice"},
    )

    assert response.status_code == 403
    assert response.json() == {"code": "password_invalid", "message": "密码错误"}
    assert store.save_calls == []


def test_put_revision_conflict_returns_current_revision(client, monkeypatch):
    store = FakeStore(save_error=ConfigRevisionConflict("rev-9"))
    _install_store(monkeypatch, store)

    response = client.put(
        CONFIG_URL,
        json={
            "revision": "rev-1",
            "current_password": "pw",
            "changes": {"tts.enabled": False},
        },
        headers={"X-Test-User": "alice"},
    )

    assert response.status_code == 409
    payload = response.json()
    assert payload["code"] == "revision_conflict"
    assert payload["current_revision"] == "rev-9"
    assert len(store.save_calls) == 1


def test_put_env_locked_returns_paths_and_errors(client, monkeypatch):
    store = FakeStore(save_error=ConfigEnvLocked(["server.port"]))
    _install_store(monkeypatch, store)

    response = client.put(
        CONFIG_URL,
        json={
            "revision": "rev-1",
            "current_password": "pw",
            "changes": {"server.port": 9443},
        },
        headers={"X-Test-User": "alice"},
    )

    assert response.status_code == 409
    payload = response.json()
    assert payload["code"] == "env_locked"
    assert payload["paths"] == ["server.port"]
    assert payload["errors"][0]["path"] == "server.port"
    assert payload["errors"][0]["code"] == "env_locked"


def test_put_read_only_returns_409(client, monkeypatch):
    store = FakeStore(save_error=ConfigReadOnly("配置后端只读"))
    _install_store(monkeypatch, store)

    response = client.put(
        CONFIG_URL,
        json={
            "revision": "rev-1",
            "current_password": "pw",
            "changes": {"tts.enabled": False},
        },
        headers={"X-Test-User": "alice"},
    )

    assert response.status_code == 409
    assert response.json()["code"] == "read_only"


def test_put_validation_failure_returns_422_errors(client, monkeypatch):
    store = FakeStore(
        save_error=ConfigValidationError(
            [SchemaError("server.port", "out_of_range", "端口越界")]
        )
    )
    _install_store(monkeypatch, store)

    response = client.put(
        CONFIG_URL,
        json={
            "revision": "rev-1",
            "current_password": "pw",
            "changes": {"server.port": 80_000},
        },
        headers={"X-Test-User": "alice"},
    )

    assert response.status_code == 422
    payload = response.json()
    assert payload["code"] == "validation_failed"
    assert payload["errors"][0]["code"] == "out_of_range"


def test_put_write_error_returns_500(client, monkeypatch):
    store = FakeStore(save_error=ConfigWriteError("disk full"))
    _install_store(monkeypatch, store)

    response = client.put(
        CONFIG_URL,
        json={
            "revision": "rev-1",
            "current_password": "pw",
            "changes": {"tts.enabled": False},
        },
        headers={"X-Test-User": "alice"},
    )

    assert response.status_code == 500
    assert response.json()["code"] == "write_failed"


# ---------------------------------------------------------------------------
# POST /config/restart
# ---------------------------------------------------------------------------


def test_restart_is_deployment_only_and_never_restarts(client, monkeypatch):
    store = FakeStore()
    _install_store(monkeypatch, store)

    response = client.post(
        RESTART_URL,
        json={"revision": "rev-1", "current_password": "pw"},
        headers={"X-Test-User": "alice"},
    )

    assert response.status_code == 409
    payload = response.json()
    assert payload["code"] == "deployment_required"
    assert payload["command"] == DEPLOYMENT_COMMAND
    assert "热生效" in payload["message"]
    assert store.save_calls == []
    assert store.apply_calls == []


def test_restart_requires_auth_before_rejecting(client, monkeypatch):
    store = FakeStore()
    _install_store(monkeypatch, store)

    async def _deny(request: Request, password: str | None = None):
        raise ConfigAuthError(401, "auth_required", "未授权访问，请先登录")

    monkeypatch.setattr(system_config, "require_config_write", _deny)

    response = client.post(
        RESTART_URL,
        json={"revision": "rev-1", "current_password": "pw"},
    )

    assert response.status_code == 401
    assert response.json()["code"] == "auth_required"
