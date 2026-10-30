# -*- coding: utf-8 -*-
"""T8 Loom 引导：只读巡检、结构校验、外部/托管应用、回滚与重启。"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import stat
from pathlib import Path
from typing import Any, Optional

import aiohttp
import pytest
import yaml
from fastapi import FastAPI
from fastapi.testclient import TestClient

from config.config import Config
from routers import loom_onboarding as router_module
from services import config_authz, loom_onboarding as loom, loom_runtime, loom_setup


TOKEN = "test-loom-token-never-returned"
MAIN_MODEL = {
    "id": "main-model",
    "provider": "prov-a",
    "contextWindow": 128000,
    "maxOutput": 8192,
    "vision": True,
    "timeout": 600000,
}
ALT_MODEL = {
    "id": "alt-model",
    "provider": "prov-b",
    "contextWindow": 64000,
    "maxOutput": 4096,
    "vision": False,
    "timeout": 300000,
}
CATALOG = {"models": [MAIN_MODEL, ALT_MODEL], "count": 2}
CONFIG_VIEW = {
    "server": {"port": 5100, "hostname": "127.0.0.1"},
    "workspace": "/tmp/ai",
    "modelIds": ["main-model", "alt-model"],
    "pricingProviders": ["prov-a", "prov-b"],
    "credentials": [
        {"name": "prov-a", "envRef": "${LOOM_KEY_A}"},
        {"name": "prov-b", "envRef": "resolved-secret-value"},
    ],
    "skills": None,
    "mcp": None,
    "bashShell": None,
    "effectiveVersionSha256": "sha-test",
}
HEALTH = {
    "status": "ok",
    "version": "loom-test",
    "uptimeMs": 1234,
    "startedAt": "2026-10-26T00:00:00.000Z",
}


def _cfg(tmp_path: Path, *, manage: bool = False, token: str = TOKEN) -> Config:
    return Config(
        {
            "loom": {
                "url": "http://loom.test:5100",
                "token": token,
                "manage_config": manage,
            },
            "data": {"ai_root": str(tmp_path / "ai")},
        }
    )


def _config_path(tmp_path: Path) -> Path:
    return tmp_path / "ai" / ".loom" / "config.yaml"


def _write_managed_config(tmp_path: Path) -> Path:
    path = _config_path(tmp_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        yaml.safe_dump(
            {
                "server": {"port": 5100, "hostname": "127.0.0.1"},
                "workspace": str(tmp_path / "ai"),
                "providers": [
                    {"provider": "prov-a", "baseUrl": "https://a.example/v1"},
                ],
                "models": [dict(MAIN_MODEL)],
                "pricing": {
                    "prov-a": {
                        "input": 1,
                        "output": 2,
                        "cacheRead": 0,
                        "cacheWrite": 0,
                    }
                },
                "credentials": {"prov-a": "${LOOM_KEY_A}"},
            },
            sort_keys=False,
            allow_unicode=True,
        ),
        encoding="utf-8",
    )
    return path


def _install_http(
    monkeypatch,
    *,
    validate_response: Optional[tuple[int, Any]] = None,
) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []

    async def fake_request(method, url, token, *, json_body=None, timeout=5.0):
        calls.append(
            {
                "method": method,
                "url": url,
                "json_body": json_body,
                "timeout": timeout,
            }
        )
        if url.endswith("/health"):
            return 200, HEALTH
        if url.endswith("/catalog/models"):
            return 200, CATALOG
        if url.endswith("/config/validate"):
            return validate_response or (404, {"error": {"code": "not_found"}})
        if url.endswith("/config"):
            return 200, CONFIG_VIEW
        return 404, {}

    monkeypatch.setattr(loom, "_request_json", fake_request)
    return calls


def _run(coro):
    return asyncio.run(coro)


def _selection(provider: str = "prov-a", model: str = "main-model", **kwargs) -> loom.Selection:
    return loom.Selection(provider=provider, model=model, **kwargs)


def _managed_alt_selection() -> loom.Selection:
    return loom.Selection(
        provider="prov-b",
        model="alt-model",
        base_url="https://b.example/v1",
        pricing={"input": 0.5, "output": 1.5, "cacheRead": 0, "cacheWrite": 0},
    )


class TestInspect:
    def test_returns_health_main_model_channels_and_safe_credentials(
        self, tmp_path, monkeypatch
    ):
        _install_http(monkeypatch)

        result = _run(loom.inspect(_cfg(tmp_path)))

        assert result["found"] is True
        assert result["source"] == loom.SOURCE_CONFIG
        assert result["fingerprint"] == loom.fingerprint(TOKEN)
        assert result["online"] is True
        assert result["health"]["status"] == "ok"
        assert result["main_model"]["id"] == "main-model"
        assert result["channels"][0] == {
            "provider": "prov-a",
            "model_count": 1,
            "models": ["main-model"],
            "credential_ref": "${LOOM_KEY_A}",
        }
        assert result["providers"] == result["channels"]
        assert result["credentials"] == [{"name": "prov-a", "env_ref": "${LOOM_KEY_A}"}]
        assert any(
            error["code"] == "credential_ref_invalid" for error in result["errors"]
        )
        serialized = json.dumps(result, ensure_ascii=False)
        assert TOKEN not in serialized
        assert "resolved-secret-value" not in serialized

    def test_missing_token_short_circuits_without_http(self, tmp_path, monkeypatch):
        calls = _install_http(monkeypatch)
        monkeypatch.delenv("LOOM_TOKEN", raising=False)

        result = _run(loom.inspect(_cfg(tmp_path, token="")))

        assert result["found"] is False
        assert result["reachable"] is False
        assert calls == []

    def test_http_failure_is_reported_without_body_dump(self, tmp_path, monkeypatch):
        async def fake_request(method, url, token, *, json_body=None, timeout=5.0):
            return 503, {"error": {"message": f"upstream down for {TOKEN}"}}

        monkeypatch.setattr(loom, "_request_json", fake_request)

        result = _run(loom.inspect(_cfg(tmp_path)))

        assert result["reachable"] is False
        assert result["errors"][0]["code"] == "loom_http_error"
        assert TOKEN not in json.dumps(result, ensure_ascii=False)


class TestValidate:
    def test_valid_selection_uses_structural_fallback(self, tmp_path, monkeypatch):
        calls = _install_http(monkeypatch)

        result = _run(loom.validate(_selection(), _cfg(tmp_path)))

        assert result["valid"] is True
        assert result["ok"] is True
        assert result["validation_mode"] == "structural"
        assert result["main_model"]["id"] == "main-model"
        assert not any(call["url"].endswith("/config/validate") for call in calls)

    def test_wrong_model_is_rejected(self, tmp_path, monkeypatch):
        _install_http(monkeypatch)

        result = _run(loom.validate(_selection(model="missing-model"), _cfg(tmp_path)))

        assert result["valid"] is False
        assert [error["code"] for error in result["errors"]] == ["model_not_found"]

    def test_wrong_provider_is_rejected(self, tmp_path, monkeypatch):
        _install_http(monkeypatch)

        result = _run(loom.validate(_selection(provider="missing"), _cfg(tmp_path)))

        assert result["valid"] is False
        assert [error["code"] for error in result["errors"]] == ["provider_not_found"]

    def test_external_mode_rejects_provider_model_mismatch(self, tmp_path, monkeypatch):
        _install_http(monkeypatch)

        result = _run(
            loom.validate(_selection(provider="prov-a", model="alt-model"), _cfg(tmp_path))
        )

        assert result["valid"] is False
        assert [error["code"] for error in result["errors"]] == [
            "model_provider_mismatch"
        ]

    def test_missing_token_is_rejected_without_http(self, tmp_path, monkeypatch):
        calls = _install_http(monkeypatch)
        monkeypatch.delenv("LOOM_TOKEN", raising=False)

        result = _run(loom.validate(_selection(), _cfg(tmp_path, token="")))

        assert result["valid"] is False
        assert [error["code"] for error in result["errors"]] == ["token_missing"]
        assert calls == []

    def test_managed_mode_calls_optional_loom_validate_when_available(
        self, tmp_path, monkeypatch
    ):
        _write_managed_config(tmp_path)
        calls = _install_http(monkeypatch, validate_response=(200, {"ok": True, "errors": []}))

        result = _run(loom.validate(_managed_alt_selection(), _cfg(tmp_path, manage=True)))

        assert result["valid"] is True
        assert result["validation_mode"] == "loom"
        validate_call = next(
            call for call in calls if call["url"].endswith("/config/validate")
        )
        assert "yaml_text" in validate_call["json_body"]
        assert TOKEN not in json.dumps(validate_call["json_body"], ensure_ascii=False)

    def test_managed_mode_remote_rejection_is_surfaced(self, tmp_path, monkeypatch):
        _write_managed_config(tmp_path)
        _install_http(
            monkeypatch,
            validate_response=(
                200,
                {"ok": False, "errors": [f"bad credentials ref for {TOKEN}"]},
            ),
        )

        result = _run(loom.validate(_managed_alt_selection(), _cfg(tmp_path, manage=True)))

        assert result["valid"] is False
        assert result["validation_mode"] == "loom"
        assert result["errors"][0]["code"] == "loom_validate_failed"
        assert TOKEN not in json.dumps(result, ensure_ascii=False)

    def test_managed_mode_missing_config_is_rejected(self, tmp_path, monkeypatch):
        _install_http(monkeypatch)

        result = _run(loom.validate(_selection(), _cfg(tmp_path, manage=True)))

        assert result["valid"] is False
        assert result["errors"][0]["code"] == "config_missing"


class TestApply:
    def test_external_mode_never_writes_or_restarts(self, tmp_path, monkeypatch):
        path = _config_path(tmp_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("sentinel: true\n", encoding="utf-8")
        _install_http(monkeypatch)

        result = _run(
            loom.apply(
                _selection(provider="prov-b", model="alt-model"),
                _cfg(tmp_path),
                restart=True,
            )
        )

        assert result["ok"] is True
        assert result["managed"] is False
        assert result["applied"] is False
        assert result["manual_required"] is True
        assert result["restart"]["performed"] is False
        assert result["restart"]["manual_required"] is True
        assert result["restart"]["command"] == loom.MANUAL_RESTART_COMMAND
        assert path.read_text(encoding="utf-8") == "sentinel: true\n"
        assert not list(path.parent.glob("*.bak-onboarding-*"))

    def test_managed_mode_backs_up_and_writes_primary_model(self, tmp_path, monkeypatch):
        path = _write_managed_config(tmp_path)
        original = path.read_text(encoding="utf-8")
        _install_http(monkeypatch)

        result = _run(
            loom.apply(
                _managed_alt_selection(),
                _cfg(tmp_path, manage=True),
                restart=False,
            )
        )

        assert result["ok"] is True
        assert result["managed"] is True
        assert result["applied"] is True
        assert result["restart"]["performed"] is False
        assert result["backup"] is not None
        backup = Path(result["backup"])
        assert backup.exists()
        assert backup.read_text(encoding="utf-8") == original

        written = yaml.safe_load(path.read_text(encoding="utf-8"))
        assert written["models"][0]["id"] == "alt-model"
        assert written["models"][0]["provider"] == "prov-b"
        assert [item["provider"] for item in written["providers"]] == ["prov-a", "prov-b"]
        assert written["providers"][1]["baseUrl"] == "https://b.example/v1"
        assert written["pricing"]["prov-b"] == {
            "input": 0.5,
            "output": 1.5,
            "cacheRead": 0,
            "cacheWrite": 0,
        }
        assert written["credentials"] == {"prov-a": "${LOOM_KEY_A}"}
        assert TOKEN not in json.dumps(result, ensure_ascii=False)

    def test_managed_new_provider_requires_pricing(self, tmp_path, monkeypatch):
        path = _write_managed_config(tmp_path)
        original = path.read_text(encoding="utf-8")
        _install_http(monkeypatch)
        selection = loom.Selection(
            provider="prov-b",
            model="alt-model",
            base_url="https://b.example/v1",
        )

        result = _run(
            loom.apply(selection, _cfg(tmp_path, manage=True), restart=False)
        )

        assert result["ok"] is False
        assert result["applied"] is False
        assert [error["code"] for error in result["errors"]] == ["pricing_required"]
        assert path.read_text(encoding="utf-8") == original
        assert not list(path.parent.glob("*.bak-onboarding-*"))

    def test_managed_apply_failure_restores_backup_and_restarts_old_config(
        self, tmp_path, monkeypatch
    ):
        path = _write_managed_config(tmp_path)
        original = path.read_text(encoding="utf-8")
        _install_http(monkeypatch)
        _install_restart(monkeypatch, health_results=[False, True])

        result = _run(
            loom.apply(
                _managed_alt_selection(),
                _cfg(tmp_path, manage=True),
                restart=True,
                restart_timeout=0.2,
            )
        )

        assert result["ok"] is False
        assert result["applied"] is False
        assert result["rollback"]["attempted"] is True
        assert result["rollback"]["restored"] is True
        assert result["rollback"]["restart"]["verified"] is True
        assert result["rollback"]["loom_down"] is False
        assert path.read_text(encoding="utf-8") == original

    def test_managed_retry_after_failed_apply_does_not_leak_token(
        self, tmp_path, monkeypatch, caplog
    ):
        _write_managed_config(tmp_path)
        _install_http(monkeypatch)
        with caplog.at_level(logging.INFO, logger=loom.__name__):
            result = _run(
                loom.apply(
                    _managed_alt_selection(),
                    _cfg(tmp_path, manage=True),
                    restart=False,
                )
            )

        assert result["ok"] is True
        assert TOKEN not in caplog.text
        assert TOKEN not in json.dumps(result, ensure_ascii=False)


class TestRestart:
    def test_manual_fallback_when_unit_or_pid_is_missing(self, tmp_path, monkeypatch):
        monkeypatch.setattr(loom_runtime, "detect_mode", lambda cfg: "systemd")
        monkeypatch.setattr(loom, "_systemd_show", lambda unit: {})

        result = _run(loom.restart_loom(_cfg(tmp_path), explicit=True))

        assert result["performed"] is False
        assert result["manual_required"] is True
        assert result["command"] == loom.MANUAL_RESTART_COMMAND

    def test_manual_fallback_when_pid_belongs_to_other_user(self, tmp_path, monkeypatch):
        monkeypatch.setattr(loom_runtime, "detect_mode", lambda cfg: "systemd")
        monkeypatch.setattr(
            loom,
            "_systemd_show",
            lambda unit: {
                "MainPID": "4242",
                "ActiveState": "active",
                "SubState": "running",
                "Restart": "always",
            },
        )
        monkeypatch.setattr(loom, "_process_uid", lambda pid: 0)
        called = []
        monkeypatch.setattr(loom, "_signal_pid", lambda pid, sig: called.append(pid))

        result = _run(loom.restart_loom(_cfg(tmp_path), explicit=True))

        assert result["manual_required"] is True
        assert called == []

    def test_requires_explicit_request(self, tmp_path, monkeypatch):
        called = []
        monkeypatch.setattr(loom, "_systemd_show", lambda unit: called.append(unit) or {})

        result = _run(loom.restart_loom(_cfg(tmp_path)))

        assert result["performed"] is False
        assert result["manual_required"] is True
        assert called == []

    def test_explicit_restart_waits_for_new_pid_and_health(self, tmp_path, monkeypatch):
        _install_restart(monkeypatch, health_results=[True])

        result = _run(loom.restart_loom(_cfg(tmp_path), explicit=True))

        assert result["ok"] is True
        assert result["performed"] is True
        assert result["verified"] is True
        assert result["old_pid"] == 1000
        assert result["new_pid"] == 1001

    def test_child_mode_delegates_to_runtime_restart(self, tmp_path, monkeypatch):
        cfg = _cfg(tmp_path)
        sentinel = {
            "ok": True,
            "mode": "child",
            "requested": True,
            "performed": True,
            "verified": True,
            "manual_required": False,
            "pid": 2001,
            "old_pid": 2000,
            "new_pid": 2001,
            "health": {"ok": True},
            "errors": [],
        }
        calls: list[tuple[Any, float]] = []

        def fake_detect_mode(config):
            assert config is cfg
            return "child"

        async def fake_restart(config, *, timeout):
            calls.append((config, timeout))
            return sentinel

        monkeypatch.setattr(loom_runtime, "detect_mode", fake_detect_mode)
        monkeypatch.setattr(loom_runtime, "restart", fake_restart)

        def forbidden_systemd(unit):
            raise AssertionError("child 模式不允许触碰 systemd")

        monkeypatch.setattr(loom, "_systemd_show", forbidden_systemd)

        result = _run(loom.restart_loom(cfg, explicit=True, timeout=7.5))

        assert calls == [(cfg, 7.5)]
        assert result is sentinel

    def test_none_mode_returns_manual_result_without_systemd(self, tmp_path, monkeypatch):
        monkeypatch.setattr(loom_runtime, "detect_mode", lambda cfg: "none")

        def forbidden(*args, **kwargs):
            raise AssertionError("none 模式不允许触碰生产")

        monkeypatch.setattr(loom, "_systemd_show", forbidden)
        monkeypatch.setattr(loom, "_signal_pid", forbidden)

        result = _run(loom.restart_loom(_cfg(tmp_path), explicit=True))

        assert result["performed"] is False
        assert result["verified"] is False
        assert result["manual_required"] is True
        assert result["command"] == loom.MANUAL_RESTART_COMMAND
        assert result["old_pid"] is None
        assert result["new_pid"] is None

    def test_managed_apply_with_restart_verifies_selection(self, tmp_path, monkeypatch):
        _write_managed_config(tmp_path)
        _install_http(monkeypatch)
        _install_restart(monkeypatch, health_results=[True])

        result = _run(
            loom.apply(
                _selection(),
                _cfg(tmp_path, manage=True),
                restart=True,
                restart_timeout=0.2,
            )
        )

        assert result["ok"] is True
        assert result["applied"] is True
        assert result["restart"]["performed"] is True
        assert result["restart"]["verified"] is True


def _install_restart(monkeypatch, *, health_results: list[bool]) -> dict[str, Any]:
    state = {"pid": 1000, "signals": [], "health_index": 0}

    def fake_show(unit: str) -> dict[str, str]:
        return {
            "MainPID": str(state["pid"]),
            "ActiveState": "active",
            "SubState": "running",
            "Restart": "always",
        }

    def fake_signal(pid: int, sig: int) -> None:
        state["signals"].append((pid, sig))
        if sig == signal.SIGTERM:
            state["pid"] += 1

    async def fake_wait_health(cfg, token, *, timeout):
        index = min(state["health_index"], len(health_results) - 1)
        state["health_index"] += 1
        return health_results[index]

    monkeypatch.setattr(loom_runtime, "detect_mode", lambda cfg: "systemd")
    monkeypatch.setattr(loom, "_systemd_show", fake_show)
    monkeypatch.setattr(loom, "_process_uid", lambda pid: os.getuid())
    monkeypatch.setattr(loom, "_signal_pid", fake_signal)
    monkeypatch.setattr(loom, "_wait_health", fake_wait_health)
    return state


class TestRouter:
    def _client(self, monkeypatch, *, read=None, write=None):
        async def allow_read(request):
            return None

        async def allow_write(request, password):
            return None

        monkeypatch.setattr(
            router_module.config_authz,
            "require_config_read",
            read or allow_read,
        )
        monkeypatch.setattr(
            router_module.config_authz,
            "require_config_write",
            write or allow_write,
        )
        app = FastAPI()
        app.include_router(router_module.router)
        return TestClient(app)

    def test_get_returns_read_auth_error(self, monkeypatch):
        async def deny_read(request):
            raise config_authz.ConfigAuthError(
                401, "auth_required", "未授权访问，请先登录"
            )

        client = self._client(monkeypatch, read=deny_read)
        response = client.get("/api/system/onboarding/loom")

        assert response.status_code == 401
        assert response.json()["code"] == "auth_required"

    def test_get_delegates_to_inspect_without_token(self, monkeypatch):
        async def fake_inspect(config=None, *, timeout=5.0):
            return {
                "found": True,
                "source": "config",
                "fingerprint": loom.fingerprint(TOKEN),
                "detail": "loom.token",
            }

        client = self._client(monkeypatch)
        monkeypatch.setattr(loom, "inspect", fake_inspect)

        response = client.get("/api/system/onboarding/loom")

        assert response.status_code == 200
        assert response.json()["fingerprint"] == loom.fingerprint(TOKEN)
        assert TOKEN not in response.text

    def test_validate_maps_pydantic_body_to_selection(self, monkeypatch):
        captured = []

        async def fake_validate(selection, config=None, *, config_path=None, timeout=5.0):
            captured.append(selection)
            return {"ok": True, "valid": True, "errors": []}

        client = self._client(monkeypatch)
        monkeypatch.setattr(loom, "validate", fake_validate)

        response = client.post(
            "/api/system/onboarding/loom/validate",
            json={
                "provider": "prov-a",
                "model": "main-model",
                "pricing": {"input": 1, "output": 2, "cacheRead": 0, "cacheWrite": 0},
            },
        )

        assert response.status_code == 200
        assert captured[0].provider == "prov-a"
        assert captured[0].model == "main-model"
        assert captured[0].pricing == {
            "input": 1.0,
            "output": 2.0,
            "cacheRead": 0.0,
            "cacheWrite": 0.0,
        }

    def test_apply_requires_write_auth_and_passes_restart_flag(self, monkeypatch):
        passwords = []
        captured = {}

        async def capture_write(request, password):
            passwords.append(password)
            return None

        async def fake_apply(selection, config=None, *, restart=False, **kwargs):
            captured["selection"] = selection
            captured["restart"] = restart
            return {"ok": True, "managed": False, "applied": False}

        client = self._client(monkeypatch, write=capture_write)
        monkeypatch.setattr(loom, "apply", fake_apply)

        response = client.post(
            "/api/system/onboarding/loom/apply",
            json={
                "provider": "prov-a",
                "model": "main-model",
                "restart": True,
                "current_password": "secret-password",
            },
        )

        assert response.status_code == 200
        assert passwords == ["secret-password"]
        assert captured["selection"].provider == "prov-a"
        assert captured["restart"] is True
        assert TOKEN not in response.text

    def test_apply_denies_without_password(self, monkeypatch):
        async def deny_write(request, password):
            raise config_authz.ConfigAuthError(
                403, "password_required", "修改配置需要验证密码"
            )

        called = []
        async def fake_apply(*args, **kwargs):
            called.append(True)
            return {"ok": True}

        client = self._client(monkeypatch, write=deny_write)
        monkeypatch.setattr(loom, "apply", fake_apply)

        response = client.post(
            "/api/system/onboarding/loom/apply",
            json={"provider": "prov-a", "model": "main-model"},
        )

        assert response.status_code == 403
        assert response.json()["code"] == "password_required"
        assert called == []

    def test_restart_requires_write_auth(self, monkeypatch):
        captured = {}

        async def fake_restart(*args, **kwargs):
            captured["called"] = True
            return {"ok": False, "manual_required": True}

        client = self._client(monkeypatch)
        monkeypatch.setattr(loom_runtime, "restart", fake_restart)

        response = client.post(
            "/api/system/onboarding/loom/restart",
            json={"current_password": "secret-password"},
        )

        assert response.status_code == 200
        assert captured["called"] is True

    def test_setup_requires_write_auth_before_running(self, monkeypatch):
        called: list[bool] = []

        async def deny_write(request, password):
            raise config_authz.ConfigAuthError(
                403, "password_required", "修改配置需要验证密码"
            )

        async def fake_setup(selection, options, *, config=None):
            called.append(True)
            return {"ok": True}

        client = self._client(monkeypatch, write=deny_write)
        monkeypatch.setattr(loom_setup, "setup", fake_setup)

        response = client.post(
            "/api/system/onboarding/loom/setup",
            json={
                "provider": "prov-a",
                "model": "main-model",
                "base_url": "https://a.example/v1",
                "port": 6000,
                "api_key": SETUP_KEY,
            },
        )

        assert response.status_code == 403
        assert called == []
        assert SETUP_KEY not in response.text

    def test_setup_maps_api_key_and_redacts_typed_error(self, monkeypatch):
        captured: dict[str, Any] = {}

        async def fake_setup(selection, options, *, config=None):
            captured["selection"] = selection
            captured["port"] = options.port
            raise loom_setup.SetupError(
                "loom_provider_auth_failed",
                "provider_probe",
                "供应商鉴权失败",
                field="api_key",
                details={"http_status": 401},
            )

        client = self._client(monkeypatch)
        monkeypatch.setattr(loom_setup, "setup", fake_setup)

        response = client.post(
            "/api/system/onboarding/loom/setup",
            json={
                "provider": "prov-a",
                "model": "main-model",
                "base_url": "https://a.example/v1",
                "port": 6000,
                "api_key": SETUP_KEY,
            },
        )

        body = response.json()
        assert response.status_code == 200
        assert body["ok"] is False
        assert body["code"] == "loom_provider_auth_failed"
        assert body["stage"] == "provider_probe"
        assert body["field"] == "api_key"
        assert captured["selection"].api_key == SETUP_KEY
        assert captured["port"] == 6000
        assert SETUP_KEY not in response.text


def _write_ai_template(project_root: Path) -> Path:
    template = project_root / "ai-template"
    (template / "agents").mkdir(parents=True)
    (template / "AGENTS.md").write_text("# AGENTS\n", encoding="utf-8")
    (template / "opencode.json").write_text("{}\n", encoding="utf-8")
    (template / "agents" / "main.md").write_text("# main\n", encoding="utf-8")
    return template


def _ensure_selection() -> loom.Selection:
    return loom.Selection(
        provider="prov-a",
        model="main-model",
        base_url="https://a.example/v1",
        pricing={"input": 1, "output": 2, "cacheRead": 0, "cacheWrite": 0},
    )


def _project_with_template(tmp_path: Path, monkeypatch) -> tuple[Path, Path]:
    project = tmp_path / "project"
    project.mkdir()
    _write_ai_template(project)
    monkeypatch.setenv("AXEUH_PROJECT_ROOT", str(project))
    return project, tmp_path / "ai"


class TestEnsureConfig:
    def test_managed_mode_creates_ai_instance_before_writing_config(
        self, tmp_path, monkeypatch
    ):
        _project, ai_root = _project_with_template(tmp_path, monkeypatch)
        cfg = _cfg(tmp_path, manage=True)

        result = loom_runtime.ensure_config(_ensure_selection(), cfg)

        assert result["ok"] is True
        assert result["managed"] is True
        assert result["created"] is True
        assert result["ai_instance"]["target"] == str(ai_root.resolve())
        assert result["ai_instance"]["created"] is True
        assert result["ai_instance"]["copied_files"] == 3
        assert (ai_root / "AGENTS.md").read_text(encoding="utf-8") == "# AGENTS\n"
        assert (ai_root / "opencode.json").is_file()
        assert (ai_root / "agents" / "main.md").is_file()

        config_path = _config_path(tmp_path)
        assert config_path.is_file()
        raw = config_path.read_text(encoding="utf-8")
        assert TOKEN not in raw
        written = yaml.safe_load(raw)
        assert written["workspace"] == str(ai_root.resolve())
        assert written["server"]["port"] == 5100
        assert written["credentials"]
        for value in written["credentials"].values():
            assert isinstance(value, str)
            assert value.startswith("${") and value.endswith("}")

    def test_external_mode_creates_nothing(self, tmp_path, monkeypatch):
        _project, ai_root = _project_with_template(tmp_path, monkeypatch)
        cfg = _cfg(tmp_path)

        result = loom_runtime.ensure_config(_ensure_selection(), cfg)

        assert result["ok"] is True
        assert result["managed"] is False
        assert result["manual_required"] is True
        assert result["ai_instance"] is None
        assert not ai_root.exists()
        assert not (ai_root / ".loom" / "config.yaml").exists()

    def test_existing_valid_config_is_not_overwritten(self, tmp_path, monkeypatch):
        _project, ai_root = _project_with_template(tmp_path, monkeypatch)
        path = _write_managed_config(tmp_path)
        original = path.read_text(encoding="utf-8")

        result = loom_runtime.ensure_config(
            _ensure_selection(), _cfg(tmp_path, manage=True)
        )

        assert result["ok"] is True
        assert result["created"] is False
        assert result["overwritten"] is False
        assert result["backup"] is None
        assert result["validation"] == "structural"
        assert path.read_text(encoding="utf-8") == original
        assert (ai_root / "AGENTS.md").is_file()
        assert result["ai_instance"]["created"] is False
        assert result["ai_instance"]["copied_files"] == 3


SETUP_KEY = "sk-setup-inline-key-never-returned"
SETUP_TOKEN = "setup-loom-token-never-returned"
SETUP_PREVIOUS_URL = "http://loom.test:5100"
SETUP_PROVIDER_OK = (200, {"data": [{"id": "main-model"}]})


def _setup_cfg(tmp_path: Path, *, token: str = SETUP_TOKEN) -> Config:
    return Config(
        {
            "loom": {
                "url": SETUP_PREVIOUS_URL,
                "token": token,
                "manage_config": True,
            },
            "data": {"ai_root": str(tmp_path / "ai")},
        }
    )


def _setup_selection(**overrides: Any) -> loom.Selection:
    values: dict[str, Any] = {
        "provider": "prov-a",
        "model": "main-model",
        "base_url": "https://a.example/v1",
        "api_key": SETUP_KEY,
    }
    values.update(overrides)
    return loom.Selection(**values)


def _setup_options(**overrides: Any) -> loom_setup.SetupOptions:
    values: dict[str, Any] = {
        "port": 6001,
        "probe_timeout": 0.1,
        "health_timeout": 1.0,
    }
    values.update(overrides)
    return loom_setup.SetupOptions(**values)


def _write_inline_config(tmp_path: Path, key: str = SETUP_KEY) -> Path:
    path = _write_managed_config(tmp_path)
    doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    doc["providers"][0]["apiKey"] = key
    doc["credentials"] = {}
    path.write_text(
        yaml.safe_dump(doc, sort_keys=False, allow_unicode=True), encoding="utf-8"
    )
    return path


class _SetupHarness:
    def __init__(
        self,
        monkeypatch,
        tmp_path: Path,
        *,
        provider=SETUP_PROVIDER_OK,
        health=(200, HEALTH),
        catalog=(200, CATALOG),
        provider_error=None,
        mode="child",
        port_in_use=False,
        provider_by_url=None,
    ):
        self.provider = provider
        self.provider_by_url = dict(provider_by_url or {})
        self.health_response = health
        self.catalog = catalog
        self.provider_error = provider_error
        self.mode = mode
        self.port_in_use = port_in_use
        self.calls: list[dict[str, Any]] = []
        self.persist_calls: list[dict[str, Any]] = []
        self.try_persist_calls: list[dict[str, Any]] = []
        self.restart_calls: list[Config] = []
        self.token_file = str(tmp_path / "secrets" / "loom.env")

        async def fake_request(method, url, token, *, json_body=None, timeout=5.0):
            self.calls.append({"method": method, "url": url, "token": token})
            if url in self.provider_by_url:
                return self.provider_by_url[url]
            if url.endswith("/catalog/models"):
                return self.catalog
            if url.endswith("/models"):
                if self.provider_error is not None:
                    raise self.provider_error
                return self.provider
            if url.endswith("/health"):
                return self.health_response
            return 404, {}

        def fake_persist(changes):
            self.persist_calls.append(dict(changes))

        def fake_try_persist(changes):
            self.try_persist_calls.append(dict(changes))
            return True

        async def fake_restart(config, *, timeout):
            self.restart_calls.append(config)
            return {
                "ok": True,
                "mode": self.mode,
                "requested": True,
                "performed": True,
                "verified": True,
                "manual_required": False,
                "health": {"ok": True},
                "errors": [],
            }

        monkeypatch.setattr(loom_setup, "_persist_settings", fake_persist)
        monkeypatch.setattr(loom_setup, "_try_persist_settings", fake_try_persist)
        monkeypatch.setattr(loom_setup, "_ensure_ai_instance", lambda cfg: None)
        monkeypatch.setattr(
            loom_setup,
            "_ensure_token",
            lambda cfg: (SETUP_TOKEN, self.token_file, False),
        )
        monkeypatch.setattr(loom_runtime, "detect_mode", lambda cfg: self.mode)
        monkeypatch.setattr(
            loom_runtime, "_mode_details", lambda: {"reasons": ["runtime_missing"]}
        )
        monkeypatch.setattr(loom_runtime, "restart", fake_restart)
        monkeypatch.setattr(
            loom_runtime,
            "_port_in_use",
            lambda port, host="127.0.0.1": self.port_in_use,
        )
        monkeypatch.setattr(loom, "_request_json", fake_request)


def _setup_error(
    selection: loom.Selection, options: loom_setup.SetupOptions, cfg: Config
) -> loom_setup.SetupError:
    with pytest.raises(loom_setup.SetupError) as info:
        _run(loom_setup.setup(selection, options, config=cfg))
    return info.value


class TestSelectionSecret:
    def test_public_and_repr_never_include_api_key(self):
        selection = loom.Selection(
            provider="prov-a", model="main-model", api_key=SETUP_KEY
        )

        public = selection.public()

        assert "api_key" not in public
        assert SETUP_KEY not in json.dumps(public, ensure_ascii=False)
        assert SETUP_KEY not in repr(selection)


class TestSetupSuccess:
    def test_inline_key_is_written_with_0600_modes_and_no_credentials_ref(
        self, tmp_path, monkeypatch, caplog
    ):
        path = _write_managed_config(tmp_path)
        original_doc = yaml.safe_load(path.read_text(encoding="utf-8"))
        assert "apiKey" not in original_doc["providers"][0]
        harness = _SetupHarness(monkeypatch, tmp_path)
        monkeypatch.delenv("LOOM_KEY_PROV_A", raising=False)

        with caplog.at_level(logging.INFO, logger=loom_setup.__name__):
            result = _run(
                loom_setup.setup(
                    _setup_selection(), _setup_options(), config=_setup_cfg(tmp_path)
                )
            )

        assert result["ok"] is True
        written = yaml.safe_load(path.read_text(encoding="utf-8"))
        assert written["providers"][0]["apiKey"] == SETUP_KEY
        assert written["providers"][0]["baseUrl"] == "https://a.example/v1"
        assert "prov-a" not in written["credentials"]
        assert written["server"]["port"] == 6001
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        backups = list(path.parent.glob("*.bak-onboarding-*"))
        assert len(backups) == 1
        assert stat.S_IMODE(backups[0].stat().st_mode) == 0o600

        assert harness.persist_calls[0] == {"loom.url": "http://127.0.0.1:6001"}
        final = harness.persist_calls[-1]
        assert final["ai_backend"] == "loom"
        assert final["loom.url"] == "http://127.0.0.1:6001"
        assert final["loom.token_file"] == harness.token_file
        assert result["api_key_configured"] is True
        assert result["token_configured"] is True
        assert result["catalog_verified"] is True

        serialized = json.dumps(result, ensure_ascii=False)
        assert SETUP_KEY not in serialized
        assert SETUP_TOKEN not in serialized
        assert SETUP_KEY not in caplog.text
        assert SETUP_TOKEN not in caplog.text
        probe = next(
            call
            for call in harness.calls
            if call["url"].endswith("/models")
            and not call["url"].endswith("/catalog/models")
        )
        assert probe["token"] == SETUP_KEY

    def test_preserves_unrelated_providers_models_and_pricing(self, tmp_path, monkeypatch):
        path = _write_managed_config(tmp_path)
        doc = yaml.safe_load(path.read_text(encoding="utf-8"))
        doc["providers"].append(
            {"provider": "prov-b", "baseUrl": "https://b.example/v1"}
        )
        doc["models"].append(dict(ALT_MODEL))
        doc["pricing"]["prov-b"] = {
            "input": 9,
            "output": 9,
            "cacheRead": 9,
            "cacheWrite": 9,
        }
        doc["credentials"]["prov-b"] = "${LOOM_KEY_B}"
        path.write_text(
            yaml.safe_dump(doc, sort_keys=False, allow_unicode=True), encoding="utf-8"
        )
        _SetupHarness(monkeypatch, tmp_path)

        result = _run(
            loom_setup.setup(
                _setup_selection(), _setup_options(), config=_setup_cfg(tmp_path)
            )
        )

        assert result["ok"] is True
        written = yaml.safe_load(path.read_text(encoding="utf-8"))
        assert [item["provider"] for item in written["providers"]] == [
            "prov-a",
            "prov-b",
        ]
        assert written["providers"][1] == {
            "provider": "prov-b",
            "baseUrl": "https://b.example/v1",
        }
        assert written["pricing"]["prov-b"] == {
            "input": 9,
            "output": 9,
            "cacheRead": 9,
            "cacheWrite": 9,
        }
        assert written["credentials"] == {"prov-b": "${LOOM_KEY_B}"}
        assert [item["id"] for item in written["models"]] == [
            "main-model",
            "alt-model",
        ]

    def test_context_window_limit_clamps_default_max_output(
        self, tmp_path, monkeypatch
    ):
        path = _write_managed_config(tmp_path)
        _SetupHarness(monkeypatch, tmp_path)

        result = _run(
            loom_setup.setup(
                _setup_selection(context_window=4096),
                _setup_options(),
                config=_setup_cfg(tmp_path),
            )
        )

        assert result["ok"] is True
        written = yaml.safe_load(path.read_text(encoding="utf-8"))
        model = next(item for item in written["models"] if item["id"] == "main-model")
        assert model["contextWindow"] == 4096
        assert model["maxOutput"] == 4096

    def test_blank_api_key_preserves_existing_inline_key(self, tmp_path, monkeypatch):
        path = _write_inline_config(tmp_path, key="old-inline-key-123456")
        _SetupHarness(monkeypatch, tmp_path)

        result = _run(
            loom_setup.setup(
                _setup_selection(api_key=""), _setup_options(), config=_setup_cfg(tmp_path)
            )
        )

        assert result["ok"] is True
        written = yaml.safe_load(path.read_text(encoding="utf-8"))
        assert written["providers"][0]["apiKey"] == "old-inline-key-123456"
        assert written["credentials"] == {}

    def test_blank_api_key_without_inline_key_is_rejected_before_io(
        self, tmp_path, monkeypatch
    ):
        path = _write_managed_config(tmp_path)
        original = path.read_text(encoding="utf-8")
        harness = _SetupHarness(monkeypatch, tmp_path)

        error = _setup_error(
            _setup_selection(api_key=""), _setup_options(), _setup_cfg(tmp_path)
        )

        assert error.code == "loom_api_key_missing"
        assert error.stage == "validate"
        assert error.to_response()["ok"] is False
        assert harness.calls == []
        assert harness.persist_calls == []
        assert path.read_text(encoding="utf-8") == original


class TestSetupValidation:
    @pytest.mark.parametrize("port", [5096, 65536, True])
    def test_invalid_port_is_rejected(self, tmp_path, port):
        error = _setup_error(
            _setup_selection(), _setup_options(port=port), _setup_cfg(tmp_path)
        )

        assert error.code == "loom_port_invalid"
        assert error.field == "port"

    def test_non_loom_listener_conflict_is_rejected(self, tmp_path, monkeypatch):
        harness = _SetupHarness(
            monkeypatch, tmp_path, port_in_use=True, health=(401, {})
        )

        error = _setup_error(
            _setup_selection(), _setup_options(), _setup_cfg(tmp_path)
        )

        assert error.code == "loom_port_conflict"
        assert error.stage == "port"
        assert harness.persist_calls == []
        assert not (tmp_path / "ai" / ".loom" / "config.yaml").exists()

    def test_existing_loom_listener_is_adopted(self, tmp_path, monkeypatch):
        harness = _SetupHarness(monkeypatch, tmp_path, port_in_use=True)

        result = _run(
            loom_setup.setup(
                _setup_selection(), _setup_options(), config=_setup_cfg(tmp_path)
            )
        )

        assert result["ok"] is True
        assert any(call["url"].endswith("/health") for call in harness.calls)


class TestProviderProbe:
    @pytest.mark.parametrize("status", [401, 403])
    def test_auth_failure_is_typed(self, tmp_path, monkeypatch, status):
        harness = _SetupHarness(monkeypatch, tmp_path, provider=(status, {"error": "no"}))

        error = _setup_error(
            _setup_selection(), _setup_options(), _setup_cfg(tmp_path)
        )

        assert error.code == "loom_provider_auth_failed"
        assert error.stage == "provider_probe"
        assert error.field == "api_key"
        assert error.details["http_status"] == status
        assert harness.persist_calls == []
        assert not (tmp_path / "ai" / ".loom" / "config.yaml").exists()

    def test_unreachable_provider_is_typed(self, tmp_path, monkeypatch):
        harness = _SetupHarness(
            monkeypatch,
            tmp_path,
            provider_error=aiohttp.ClientConnectionError("dns failure"),
        )

        error = _setup_error(
            _setup_selection(), _setup_options(), _setup_cfg(tmp_path)
        )

        assert error.code == "loom_provider_unreachable"
        assert error.field == "base_url"
        assert harness.persist_calls == []

    @pytest.mark.parametrize(
        "provider",
        [
            (404, {}),
            (405, {}),
            (200, "<html>not json</html>"),
        ],
    )
    def test_missing_or_unparseable_models_endpoint_is_skipped(
        self, tmp_path, monkeypatch, provider
    ):
        _SetupHarness(monkeypatch, tmp_path, provider=provider)

        result = _run(
            loom_setup.setup(
                _setup_selection(), _setup_options(), config=_setup_cfg(tmp_path)
            )
        )

        assert result["ok"] is True
        assert result["warnings"][0]["code"] == "loom_provider_models_unavailable"

    def test_root_html_provider_is_normalized_to_v1(self, tmp_path, monkeypatch):
        harness = _SetupHarness(
            monkeypatch,
            tmp_path,
            provider_by_url={
                "https://a.example/models": (200, "<html>New API</html>"),
                "https://a.example/v1/models": (200, {"data": [{"id": "main-model"}]}),
            },
        )
        selection = _setup_selection(base_url="https://a.example")

        result = _run(
            loom_setup.setup(selection, _setup_options(), config=_setup_cfg(tmp_path))
        )

        assert result["base_url"] == "https://a.example/v1"
        assert any(
            item["code"] == "loom_provider_v1_normalized"
            for item in result["warnings"]
        )
        path = tmp_path / "ai" / ".loom" / "config.yaml"
        doc = yaml.safe_load(path.read_text(encoding="utf-8"))
        assert doc["providers"][0]["baseUrl"] == "https://a.example/v1"
        assert harness.persist_calls

    def test_v1_provider_is_not_doubled(self, tmp_path, monkeypatch):
        harness = _SetupHarness(monkeypatch, tmp_path)
        selection = _setup_selection(base_url="https://a.example/v1/")

        _run(
            loom_setup.setup(selection, _setup_options(), config=_setup_cfg(tmp_path))
        )

        urls = [call["url"] for call in harness.calls]
        assert "https://a.example/v1/models" in urls
        assert not any("/v1/v1/" in url for url in urls)

    def test_model_absent_from_returned_list_is_rejected(self, tmp_path, monkeypatch):
        harness = _SetupHarness(
            monkeypatch, tmp_path, provider=(200, {"data": [{"id": "other-model"}]})
        )

        error = _setup_error(
            _setup_selection(), _setup_options(), _setup_cfg(tmp_path)
        )

        assert error.code == "loom_model_invalid"
        assert error.stage == "provider_probe"
        assert error.field == "model"
        assert error.details["model"] == "main-model"
        assert harness.persist_calls == []


class TestSetupRollback:
    def _assert_rolled_back(self, harness, path: Path, original: str) -> None:
        assert path.read_text(encoding="utf-8") == original
        assert harness.persist_calls[0] == {"loom.url": "http://127.0.0.1:6001"}
        assert all("ai_backend" not in call for call in harness.persist_calls)
        assert harness.try_persist_calls[-1] == {"loom.url": SETUP_PREVIOUS_URL}
        backups = list(path.parent.glob("*.bak-onboarding-*"))
        assert len(backups) == 1
        assert stat.S_IMODE(backups[0].stat().st_mode) == 0o600
        assert len(harness.restart_calls) == 2
        assert harness.restart_calls[-1].LOOM_URL == SETUP_PREVIOUS_URL

    def test_health_timeout_rolls_back_config_and_url(self, tmp_path, monkeypatch):
        path = _write_managed_config(tmp_path)
        original = path.read_text(encoding="utf-8")
        harness = _SetupHarness(monkeypatch, tmp_path, health=(503, {}))

        error = _setup_error(
            _setup_selection(),
            _setup_options(health_timeout=0.2),
            _setup_cfg(tmp_path),
        )

        assert error.code == "loom_health_timeout"
        assert error.stage == "health"
        self._assert_rolled_back(harness, path, original)

    def test_catalog_mismatch_rolls_back_config_and_url(self, tmp_path, monkeypatch):
        path = _write_managed_config(tmp_path)
        original = path.read_text(encoding="utf-8")
        harness = _SetupHarness(
            monkeypatch,
            tmp_path,
            catalog=(200, {"models": [{"id": "other-model", "provider": "prov-a"}]}),
        )

        error = _setup_error(
            _setup_selection(), _setup_options(), _setup_cfg(tmp_path)
        )

        assert error.code == "loom_model_invalid"
        assert error.stage == "catalog"
        self._assert_rolled_back(harness, path, original)

    def test_runtime_unavailable_rolls_back_without_restart(self, tmp_path, monkeypatch):
        path = _write_managed_config(tmp_path)
        original = path.read_text(encoding="utf-8")
        harness = _SetupHarness(monkeypatch, tmp_path, mode="none")

        error = _setup_error(
            _setup_selection(), _setup_options(), _setup_cfg(tmp_path)
        )

        assert error.code == "loom_runtime_unavailable"
        assert error.details["mode"] == "none"
        assert "command" not in error.details
        assert path.read_text(encoding="utf-8") == original
        assert all("ai_backend" not in call for call in harness.persist_calls)
        assert harness.restart_calls == []


class TestLoomProjection:
    def test_get_projection_is_sanitized(self, tmp_path, monkeypatch):
        path = _write_inline_config(tmp_path)
        _install_http(monkeypatch)
        monkeypatch.setattr(loom_runtime, "detect_mode", lambda cfg: "child")

        result = _run(loom.inspect(_cfg(tmp_path)))

        assert result["provider"] == "prov-a"
        assert result["base_url"] == "https://a.example/v1"
        assert result["model"] == "main-model"
        assert result["api_key_configured"] is True
        assert result["token_configured"] is True
        assert result["config_path"] == str(path)
        assert result["port"] == 5100
        assert result["runtime"] == {
            "mode": "child",
            "running": True,
            "health": {
                "status": "ok",
                "version": "loom-test",
                "uptime_ms": 1234,
                "started_at": "2026-10-26T00:00:00.000Z",
            },
        }
        serialized = json.dumps(result, ensure_ascii=False)
        assert SETUP_KEY not in serialized
        assert TOKEN not in serialized

    def test_projection_without_managed_config_reports_unconfigured_key(
        self, tmp_path, monkeypatch
    ):
        _install_http(monkeypatch)
        monkeypatch.setattr(loom_runtime, "detect_mode", lambda cfg: "none")

        result = _run(loom.inspect(_cfg(tmp_path)))

        assert result["provider"] is None
        assert result["model"] is None
        assert result["api_key_configured"] is False
        assert result["token_configured"] is True
        assert result["runtime"]["mode"] == "none"
