# -*- coding: utf-8 -*-
"""W53 /api/screen/backend 端点契约测（conftest client + auth_headers）。

W30 契约形状保留，语义收敛：config.yaml 顶层 ai_backend 是唯一真源。
  - GET 200 {"ok":true,"backend":<config 值>,"options":["opencode","loom","dsh"]}
    直接读配置快照；旧 web_backend.json 即使存在也不影响结果。
  - POST 退役：410 {"ok":false,"error":<文本>}，零写入、零副作用——切换入口
    统一在配置（/api/system/config 的 ai_backend，写操作需密码二次校验）。
锁定"退役端点不会绕开配置写入授权"这条红线。
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest

from config.config import get_config
import routers.web_backend as web_backend_api
import services.web_backend_selector as wbs


def _set_global(value):
    """改全局 ai_backend（镜像 test_ai_client_factory._set_backend），返回旧值。"""
    cfg = get_config()
    if value is None:
        return cfg._data.pop("ai_backend", None)
    old = cfg._data.get("ai_backend")
    cfg._data["ai_backend"] = value
    return old


@pytest.fixture
def restore_backend():
    cfg = get_config()
    had = "ai_backend" in cfg._data
    old = cfg._data.get("ai_backend")
    yield
    if had:
        cfg._data["ai_backend"] = old
    else:
        cfg._data.pop("ai_backend", None)


@pytest.fixture
def legacy_file(monkeypatch, tmp_path):
    path = tmp_path / "web_backend.json"
    monkeypatch.setattr(wbs, "legacy_state_path", lambda: path)
    return path


class TestGetBackendContract:
    @pytest.mark.parametrize("backend", ["opencode", "loom", "dsh"])
    def test_shape_reflects_config(
        self, client, auth_headers, legacy_file, restore_backend, backend
    ):
        _set_global(backend)
        resp = client.get("/api/screen/backend", headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json() == {
            "ok": True,
            "backend": backend,
            "options": ["opencode", "loom", "dsh"],
        }

    def test_legacy_state_file_is_ignored(
        self, client, auth_headers, legacy_file, restore_backend
    ):
        legacy_file.write_text('{"backend": "loom"}', encoding="utf-8")
        _set_global("dsh")
        resp = client.get("/api/screen/backend", headers=auth_headers)
        assert resp.json()["backend"] == "dsh"


class TestPostRetired:
    def test_post_is_gone_with_error_envelope(
        self, client, auth_headers, legacy_file, restore_backend
    ):
        _set_global("opencode")
        resp = client.post(
            "/api/screen/backend", json={"backend": "loom"}, headers=auth_headers
        )
        assert resp.status_code == 410
        payload = resp.json()
        assert set(payload.keys()) == {"ok", "error"}
        assert payload["ok"] is False
        assert "配置" in payload["error"]
        # 退役端点绝不落盘：GET 仍是原取值
        assert client.get("/api/screen/backend", headers=auth_headers).json()[
            "backend"
        ] == "opencode"

    def test_post_has_no_config_writer_import(self):
        """红线：端点不得 import 任何配置写入原语（绕开密码校验的旁路）。"""
        from pathlib import Path

        source = Path(web_backend_api.__file__).read_text(encoding="utf-8")
        assert "set_web_backend" not in source
        assert "get_config_store" not in source
        assert "require_config_write" not in source


class TestBackendAuth:
    def test_get_without_token_401(self, client):
        resp = client.get("/api/screen/backend")
        assert resp.status_code == 401
        assert resp.json() == {"detail": "未授权访问，请先登录"}

    def test_post_without_token_401(self, client):
        resp = client.post("/api/screen/backend", json={"backend": "loom"})
        assert resp.status_code == 401
        assert set(resp.json().keys()) == {"detail"}
