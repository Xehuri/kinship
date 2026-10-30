# -*- coding: utf-8 -*-
"""QQ 网关引导 API：脱敏、零写入校验、密钥权限、迁移与不早启动。

全部用例使用临时 ConfigStore 与临时 ``AXEUH_DATA_ROOT``；不触碰仓库
config.yaml、生产端口或 QQ 网关实例。
"""
from __future__ import annotations

import stat
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
import yaml
from fastapi import FastAPI
from fastapi.testclient import TestClient

import config.config as config_module
from config.config import Config
from config.providers import YamlFileProvider
from config.store import ConfigStore
from middleware.onboarding_gate import OnboardingGateMiddleware, is_allowed_path
from routers import onboarding_qq as router_module
from services import config_authz
from services import onboarding_qq

BASE = "/api/system/onboarding/qq"
DATA_ROOT_ENV = "AXEUH_DATA_ROOT"


def _setup(tmp_path, monkeypatch, document=None):
    """隔离 data.root、config store 与 Config facade。"""
    data_root = tmp_path / "var"
    monkeypatch.setenv(DATA_ROOT_ENV, str(data_root))
    monkeypatch.delenv("NAPCAT_WS_TOKEN", raising=False)
    monkeypatch.delenv("QQ_GATEWAY_MCP_TOKEN", raising=False)

    path = tmp_path / "config.yaml"
    provider = YamlFileProvider(path)
    if document is not None:
        provider.save(document)
    store = ConfigStore(provider)

    monkeypatch.setattr(onboarding_qq, "get_config_store", lambda: store)
    monkeypatch.setattr(
        config_module, "get_config", lambda: Config(store.snapshot())
    )
    return SimpleNamespace(
        data_root=data_root,
        path=path,
        store=store,
    )


def _client(monkeypatch, *, read=None, write=None, gate=False):
    async def allow_read(request):
        return None

    async def allow_write(request, password):
        return None

    monkeypatch.setattr(
        router_module.config_authz, "require_config_read", read or allow_read
    )
    monkeypatch.setattr(
        router_module.config_authz, "require_config_write", write or allow_write
    )

    app = FastAPI()
    if gate:
        app.state.onboarding_state_completed = False
        app.add_middleware(OnboardingGateMiddleware)
    app.include_router(router_module.router)
    return TestClient(app)


def _mode(path: Path) -> int:
    return stat.S_IMODE(path.stat().st_mode)


def _saved(path: Path) -> dict:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def test_get_masks_tokens_and_reports_configured_booleans(tmp_path, monkeypatch):
    env = _setup(
        tmp_path,
        monkeypatch,
        {
            "qq_gateway": {
                "enabled": True,
                "account": {
                    "self_qq": "10001",
                    "ws_url": "ws://127.0.0.1:3001",
                    "ws_token": "inline-ws-secret",
                },
                "mcp": {"enabled": True, "token": "inline-mcp-secret"},
            }
        },
    )
    client = _client(monkeypatch)

    response = client.get(BASE)

    assert response.status_code == 200
    payload = response.json()
    assert payload == {
        "enabled": True,
        "self_qq": "10001",
        "ws_url": "ws://127.0.0.1:3001",
        "ws_token_configured": True,
        "mcp_token_configured": True,
        "valid": True,
        "errors": [],
    }
    assert response.headers["cache-control"] == "no-store"
    assert "inline-ws-secret" not in response.text
    assert "inline-mcp-secret" not in response.text
    assert "token_file" not in response.text
    assert str(env.path) not in response.text


def test_get_reports_unconfigured_tokens(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch, {"qq_gateway": {"enabled": False}})
    client = _client(monkeypatch)

    payload = client.get(BASE).json()

    assert payload["enabled"] is False
    assert payload["ws_token_configured"] is False
    assert payload["mcp_token_configured"] is False
    assert payload["valid"] is True
    assert payload["errors"] == []


def test_get_requires_read_auth(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)

    async def deny_read(request):
        raise config_authz.ConfigAuthError(
            401, "auth_required", "未授权访问，请先登录"
        )

    client = _client(monkeypatch, read=deny_read)

    response = client.get(BASE)

    assert response.status_code == 401
    assert response.json()["code"] == "auth_required"


def test_config_writes_private_files_and_absolute_paths(tmp_path, monkeypatch):
    env = _setup(
        tmp_path,
        monkeypatch,
        {"qq_gateway": {"enabled": False, "mcp": {"enabled": True}}},
    )
    from services.qq_gateway import service as qq_service

    start = AsyncMock()
    monkeypatch.setattr(qq_service.QQGatewayService, "start", start)
    client = _client(monkeypatch)

    response = client.post(
        BASE + "/config",
        json={
            "enabled": True,
            "self_qq": "10001",
            "ws_url": "wss://napcat.example.test/ws",
            "ws_token": "new-ws-secret",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["enabled"] is True
    assert payload["self_qq"] == "10001"
    assert payload["ws_url"] == "wss://napcat.example.test/ws"
    assert payload["ws_token_configured"] is True
    assert payload["mcp_token_configured"] is True
    assert payload["valid"] is True
    assert payload["starts_after_finish"] is True
    start.assert_not_called()
    assert "new-ws-secret" not in response.text
    assert "qq_ws_token" not in response.text
    assert "qq_mcp_token" not in response.text

    secrets_dir = env.data_root / "secrets"
    ws_path = secrets_dir / "qq_ws_token"
    mcp_path = secrets_dir / "qq_mcp_token"
    assert _mode(secrets_dir) == 0o700
    assert _mode(ws_path) == 0o600
    assert _mode(mcp_path) == 0o600
    assert ws_path.read_text(encoding="utf-8") == "new-ws-secret"
    assert len(mcp_path.read_text(encoding="utf-8")) >= 32

    saved = _saved(env.path)
    account = saved["qq_gateway"]["account"]
    mcp = saved["qq_gateway"]["mcp"]
    assert Path(account["ws_token_file"]).is_absolute()
    assert Path(mcp["token_file"]).is_absolute()
    assert account["ws_token_file"] == str(ws_path.resolve())
    assert mcp["token_file"] == str(mcp_path.resolve())
    assert "ws_token" not in account
    assert "token" not in mcp
    assert saved["qq_gateway"]["enabled"] is True
    assert saved["qq_gateway"]["account"]["self_qq"] == "10001"
    assert saved["qq_gateway"]["account"]["ws_url"] == "wss://napcat.example.test/ws"


@pytest.mark.parametrize(
    ("payload", "expected_field"),
    [
        (
            {
                "enabled": True,
                "self_qq": "12ab34",
                "ws_url": "ws://127.0.0.1:3001",
                "ws_token": "temp-token",
            },
            "self_qq",
        ),
        (
            {
                "enabled": True,
                "self_qq": "10001",
                "ws_url": "http://127.0.0.1:3001",
                "ws_token": "temp-token",
            },
            "ws_url",
        ),
        (
            {
                "enabled": True,
                "self_qq": "10001",
                "ws_url": "ws://127.0.0.1:3001",
            },
            "ws_token",
        ),
    ],
)
def test_invalid_payload_writes_nothing_and_keeps_revision(
    tmp_path, monkeypatch, payload, expected_field
):
    env = _setup(tmp_path, monkeypatch, {"qq_gateway": {"enabled": False}})
    before_revision = env.store.revision
    before_bytes = env.path.read_bytes()
    client = _client(monkeypatch)

    response = client.post(BASE + "/config", json=payload)

    assert response.status_code == 422
    body = response.json()
    assert body["code"] == "qq_config_invalid"
    assert any(error["field"] == expected_field for error in body["errors"])
    assert "temp-token" not in response.text
    assert env.store.revision == before_revision
    assert env.path.read_bytes() == before_bytes
    assert not (env.data_root / "secrets").exists()


def test_disabled_payload_saves_only_enabled_and_creates_no_token_files(
    tmp_path, monkeypatch
):
    env = _setup(tmp_path, monkeypatch)
    client = _client(monkeypatch)

    response = client.post(BASE + "/config", json={"enabled": False})

    assert response.status_code == 200
    payload = response.json()
    assert payload["enabled"] is False
    assert payload["ws_token_configured"] is False
    assert payload["mcp_token_configured"] is False
    assert _saved(env.path) == {"qq_gateway": {"enabled": False}}
    assert not (env.data_root / "secrets").exists()


def test_legacy_inline_mcp_token_is_migrated_and_cleared(tmp_path, monkeypatch):
    env = _setup(
        tmp_path,
        monkeypatch,
        {
            "qq_gateway": {
                "enabled": True,
                "account": {
                    "self_qq": "10001",
                    "ws_url": "ws://127.0.0.1:3001",
                    "ws_token": "inline-ws-secret",
                },
                "mcp": {"enabled": True, "token": "legacy-mcp-secret"},
            }
        },
    )
    client = _client(monkeypatch)

    response = client.post(
        BASE + "/config",
        json={
            "enabled": True,
            "self_qq": "10001",
            "ws_url": "ws://127.0.0.1:3001",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["ws_token_configured"] is True
    assert payload["mcp_token_configured"] is True
    assert "legacy-mcp-secret" not in response.text
    assert "inline-ws-secret" not in response.text

    saved = _saved(env.path)
    mcp = saved["qq_gateway"]["mcp"]
    mcp_path = env.data_root / "secrets" / "qq_mcp_token"
    assert "token" not in mcp
    assert Path(mcp["token_file"]).is_absolute()
    assert mcp["token_file"] == str(mcp_path.resolve())
    assert _mode(mcp_path) == 0o600
    assert mcp_path.read_text(encoding="utf-8") == "legacy-mcp-secret"
    assert saved["qq_gateway"]["account"]["ws_token"] == "inline-ws-secret"
    assert not (env.data_root / "secrets" / "qq_ws_token").exists()


def test_validate_endpoint_never_writes(tmp_path, monkeypatch):
    env = _setup(tmp_path, monkeypatch)
    before_revision = env.store.revision
    client = _client(monkeypatch)

    valid = client.post(
        BASE + "/validate",
        json={
            "enabled": True,
            "self_qq": "10001",
            "ws_url": "ws://127.0.0.1:3001",
            "ws_token": "temp-token",
        },
    )
    invalid = client.post(
        BASE + "/validate",
        json={
            "enabled": True,
            "self_qq": "bad-qq",
            "ws_url": "http://127.0.0.1:3001",
            "ws_token": "temp-token",
        },
    )

    assert valid.status_code == 200
    assert valid.json() == {"valid": True, "errors": []}
    assert invalid.status_code == 200
    assert invalid.json()["valid"] is False
    assert {error["field"] for error in invalid.json()["errors"]} >= {
        "self_qq",
        "ws_url",
    }
    assert env.store.revision == before_revision
    assert not env.path.exists()
    assert not (env.data_root / "secrets").exists()
    assert "temp-token" not in valid.text + invalid.text


def test_post_config_requires_write_auth(tmp_path, monkeypatch):
    env = _setup(tmp_path, monkeypatch)

    async def deny_write(request, password):
        raise config_authz.ConfigAuthError(
            403, "password_required", "修改配置需要验证密码"
        )

    client = _client(monkeypatch, write=deny_write)

    response = client.post(
        BASE + "/config",
        json={
            "enabled": True,
            "self_qq": "10001",
            "ws_url": "ws://127.0.0.1:3001",
            "ws_token": "temp-token",
        },
    )

    assert response.status_code == 403
    assert response.json()["code"] == "password_required"
    assert not env.path.exists()
    assert not (env.data_root / "secrets").exists()


def test_finish_errors_empty_when_disabled(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch, {"qq_gateway": {"enabled": False}})

    assert onboarding_qq.qq_finish_errors() == []


def test_finish_errors_when_enabled_but_invalid(tmp_path, monkeypatch):
    _setup(
        tmp_path,
        monkeypatch,
        {
            "qq_gateway": {
                "enabled": True,
                "account": {
                    "self_qq": "10001",
                    "ws_url": "ws://127.0.0.1:3001",
                },
                "mcp": {"enabled": False},
            }
        },
    )

    errors = onboarding_qq.qq_finish_errors()

    assert errors
    assert any("ws_token" in error for error in errors)


def test_finish_errors_empty_when_enabled_and_valid(tmp_path, monkeypatch):
    _setup(
        tmp_path,
        monkeypatch,
        {
            "qq_gateway": {
                "enabled": True,
                "account": {
                    "self_qq": "10001",
                    "ws_url": "ws://127.0.0.1:3001",
                    "ws_token": "inline-ws-secret",
                },
                "mcp": {"enabled": False},
            }
        },
    )

    assert onboarding_qq.qq_finish_errors() == []


def test_bootstrap_gate_allows_qq_onboarding(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch, {"qq_gateway": {"enabled": False}})
    client = _client(monkeypatch, gate=True)

    assert is_allowed_path(BASE) is True
    response = client.get(BASE)

    assert response.status_code == 200
    assert response.json()["enabled"] is False
