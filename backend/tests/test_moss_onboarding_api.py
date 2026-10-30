# -*- coding: utf-8 -*-
"""MOSS 引导 API：enabled/base_url/model 读写、认证与遗留键清理。

全部用例使用临时 ConfigStore，不触碰仓库 config.yaml、生产端口或任何
MOSS/systemd 服务。
"""
from __future__ import annotations

import subprocess
from types import SimpleNamespace
from typing import Optional

import pytest
import yaml
from fastapi import FastAPI
from fastapi.testclient import TestClient

from config.config import Config
from config.providers import YamlFileProvider
from config.store import ConfigStore
from routers import moss as router_module
from services import config_authz

BASE = "/api/system/onboarding/moss"
CONFIG_URL = f"{BASE}/config"
UNIT_FIELDS = ("manage_units", "units", "commands", "helper", "helper_configured")


def _setup(tmp_path, monkeypatch, document: Optional[dict] = None):
    path = tmp_path / "config.yaml"
    provider = YamlFileProvider(path)
    if document is not None:
        provider.save(document)
    store = ConfigStore(provider)
    monkeypatch.setattr(router_module, "get_config_store", lambda: store)
    monkeypatch.setattr(
        router_module, "get_config", lambda: Config(store.snapshot())
    )
    return SimpleNamespace(path=path, store=store)


def _client(monkeypatch, *, read=None, write=None) -> TestClient:
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


def _saved(path) -> dict:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


@pytest.fixture
def no_process_spawn(monkeypatch):
    """任何启停服务/子进程的尝试都必须让用例失败。"""

    def fail(*args, **kwargs):
        raise AssertionError("MOSS onboarding must never start or stop services")

    monkeypatch.setattr(subprocess, "Popen", fail)
    monkeypatch.setattr(subprocess, "run", fail)


class TestReadEndpoint:
    def test_get_returns_read_auth_error(self, monkeypatch):
        async def deny_read(request):
            raise config_authz.ConfigAuthError(
                401, "auth_required", "未授权访问，请先登录"
            )

        client = _client(monkeypatch, read=deny_read)
        response = client.get(BASE)

        assert response.status_code == 401
        assert response.json()["code"] == "auth_required"

    def test_get_returns_only_three_config_fields(self, tmp_path, monkeypatch):
        env = _setup(
            tmp_path,
            monkeypatch,
            {
                "moss": {
                    "enabled": True,
                    "base_url": "http://127.0.0.1:8100",
                    "model": "moss-audio-4b",
                }
            },
        )
        client = _client(monkeypatch)
        before = env.path.read_text(encoding="utf-8")

        response = client.get(BASE)

        assert response.status_code == 200
        assert response.json() == {
            "enabled": True,
            "base_url": "http://127.0.0.1:8100",
            "model": "moss-audio-4b",
        }
        assert env.path.read_text(encoding="utf-8") == before
        for field in UNIT_FIELDS:
            assert field not in response.text


class TestConfigEndpoint:
    def test_post_saves_three_keys_and_returns_sanitized_config(
        self, tmp_path, monkeypatch, no_process_spawn
    ):
        env = _setup(tmp_path, monkeypatch)
        client = _client(monkeypatch)

        response = client.post(
            CONFIG_URL,
            json={
                "enabled": True,
                "base_url": "http://192.0.2.5:9000",
                "model": "custom-model",
            },
        )

        assert response.status_code == 200
        assert response.json() == {
            "enabled": True,
            "base_url": "http://192.0.2.5:9000",
            "model": "custom-model",
            "starts_after_finish": True,
        }
        assert _saved(env.path)["moss"] == {
            "enabled": True,
            "base_url": "http://192.0.2.5:9000",
            "model": "custom-model",
        }
        for field in UNIT_FIELDS:
            assert field not in response.text

    def test_post_requires_write_auth_and_writes_nothing(self, tmp_path, monkeypatch):
        env = _setup(tmp_path, monkeypatch)

        async def deny_write(request, password):
            raise config_authz.ConfigAuthError(
                403, "password_required", "修改配置需要验证密码"
            )

        client = _client(monkeypatch, write=deny_write)

        response = client.post(
            CONFIG_URL,
            json={
                "enabled": True,
                "base_url": "http://127.0.0.1:8100",
                "model": "moss-audio-4b",
            },
        )

        assert response.status_code == 403
        assert response.json()["code"] == "password_required"
        assert env.path.exists() is False

    def test_post_receives_password_for_write_auth(self, tmp_path, monkeypatch):
        _setup(tmp_path, monkeypatch)
        passwords: list[Optional[str]] = []

        async def capture_write(request, password):
            passwords.append(password)
            return None

        client = _client(monkeypatch, write=capture_write)

        response = client.post(
            CONFIG_URL,
            json={
                "enabled": False,
                "base_url": "http://127.0.0.1:8100",
                "model": "moss-audio-4b",
                "current_password": "correct-password",
            },
        )

        assert response.status_code == 200
        assert passwords == ["correct-password"]

    @pytest.mark.parametrize(
        "base_url",
        [
            "ftp://127.0.0.1:8100",
            "",
            "http://user:super-secret@127.0.0.1:8100",
            "127.0.0.1:8100",
        ],
    )
    def test_post_rejects_invalid_base_url(
        self, base_url, tmp_path, monkeypatch
    ):
        env = _setup(tmp_path, monkeypatch)
        client = _client(monkeypatch)

        response = client.post(
            CONFIG_URL,
            json={"enabled": True, "base_url": base_url, "model": "moss-audio-4b"},
        )

        assert response.status_code == 422
        payload = response.json()
        assert payload["code"] == "moss_config_invalid"
        assert payload["errors"][0]["field"] == "base_url"
        assert "super-secret" not in response.text
        assert env.path.exists() is False

    def test_post_rejects_empty_model(self, tmp_path, monkeypatch):
        env = _setup(tmp_path, monkeypatch)
        client = _client(monkeypatch)

        response = client.post(
            CONFIG_URL,
            json={
                "enabled": True,
                "base_url": "http://127.0.0.1:8100",
                "model": "   ",
            },
        )

        assert response.status_code == 422
        payload = response.json()
        assert payload["code"] == "moss_config_invalid"
        assert payload["errors"] == [
            {"field": "model", "message": "MOSS 模型名不能为空"}
        ]
        assert env.path.exists() is False

    def test_post_clears_legacy_manage_units(self, tmp_path, monkeypatch):
        env = _setup(
            tmp_path,
            monkeypatch,
            {
                "moss": {
                    "base_url": "http://127.0.0.1:8100",
                    "model": "moss-audio-4b",
                    "manage_units": True,
                }
            },
        )
        client = _client(monkeypatch)

        response = client.post(
            CONFIG_URL,
            json={
                "enabled": True,
                "base_url": "http://127.0.0.1:9100",
                "model": "moss-test",
            },
        )

        assert response.status_code == 200
        saved = _saved(env.path)["moss"]
        assert saved == {
            "enabled": True,
            "base_url": "http://127.0.0.1:9100",
            "model": "moss-test",
        }
        assert "manage_units" not in saved

    def test_post_keeps_current_values_for_omitted_fields(self, tmp_path, monkeypatch):
        _setup(
            tmp_path,
            monkeypatch,
            {
                "moss": {
                    "enabled": True,
                    "base_url": "http://127.0.0.1:8100",
                    "model": "moss-audio-4b",
                }
            },
        )
        client = _client(monkeypatch)

        response = client.post(CONFIG_URL, json={"enabled": False})

        assert response.status_code == 200
        assert response.json()["enabled"] is False
        assert response.json()["base_url"] == "http://127.0.0.1:8100"
        assert response.json()["model"] == "moss-audio-4b"

    def test_removed_endpoints_are_not_routed(self, tmp_path, monkeypatch):
        _setup(tmp_path, monkeypatch)
        client = _client(monkeypatch)

        assert client.post(f"{BASE}/validate", json={}).status_code in {404, 405}
        assert client.post(f"{BASE}/apply", json={}).status_code in {404, 405}
