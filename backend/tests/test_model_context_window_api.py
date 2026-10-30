# -*- coding: utf-8 -*-
"""GET /api/screen/model/context-window 契约测。

形状固定为 {success, backend, model, provider, contextWindow}：
- Loom 有值 → 三字段填真值；
- OpenCode 无该解析面 / 上游失败 / 解析器异常 → 200 + success:true + 三字段全 null
  （绝不 500，绝不猜窗口）。
无 Token → 中间件 401。路由面用真实客户端 + 桩传输，不触网。
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import routers.model_config as mc
import services.loom_client as lc
import services.opencode_client as oc


def _patch_backend(monkeypatch, backend, client):
    monkeypatch.setattr(mc, "get_web_backend", lambda: backend)

    async def _fake_acquire():
        return client

    monkeypatch.setattr(mc, "acquire_web_client", _fake_acquire)


def _loom_with(monkeypatch, status, body):
    client = lc.LoomClient(base_url="http://loom.test:5100")

    async def _fake_request(method, path, *, params=None, json_body=None, timeout=None):
        return status, body, {}

    monkeypatch.setattr(client, "_request", _fake_request)
    return client


def _get(client, headers):
    return client.get("/api/screen/model/context-window", headers=headers)


class TestContextWindowRoute:
    def test_route_shape_opencode_null(self, client, auth_headers, monkeypatch):
        # OpenCode 客户端没有该解析面：路由必须如实全 null，不猜窗口
        assert not hasattr(oc.OpenCodeClient, "get_active_model_context_window")
        _patch_backend(monkeypatch, "opencode",
                       oc.OpenCodeClient(base_url="http://127.0.0.1:5096"))
        resp = _get(client, auth_headers)
        assert resp.status_code == 200
        assert resp.json() == {
            "success": True,
            "backend": "opencode",
            "model": None,
            "provider": None,
            "contextWindow": None,
        }

    def test_loom_value_passthrough(self, client, auth_headers, monkeypatch):
        client_obj = _loom_with(monkeypatch, 200, {"models": [
            {"id": "active-main", "provider": "prov-a", "contextWindow": 128000},
        ], "count": 1})
        _patch_backend(monkeypatch, "loom", client_obj)
        resp = _get(client, auth_headers)
        assert resp.status_code == 200
        assert resp.json() == {
            "success": True,
            "backend": "loom",
            "model": "active-main",
            "provider": "prov-a",
            "contextWindow": 128000,
        }

    def test_upstream_failure_degrades_to_nulls(self, client, auth_headers, monkeypatch):
        client_obj = _loom_with(monkeypatch, 500, {"error": {"message": "boom"}})
        _patch_backend(monkeypatch, "loom", client_obj)
        resp = _get(client, auth_headers)
        assert resp.status_code == 200
        assert resp.json() == {
            "success": True,
            "backend": "loom",
            "model": None,
            "provider": None,
            "contextWindow": None,
        }

    def test_resolver_exception_degrades_to_nulls(self, client, auth_headers, monkeypatch):
        class _RaisingClient:
            async def get_active_model_context_window(self):
                raise RuntimeError("boom")

        _patch_backend(monkeypatch, "loom", _RaisingClient())
        resp = _get(client, auth_headers)
        assert resp.status_code == 200
        assert resp.json() == {
            "success": True,
            "backend": "loom",
            "model": None,
            "provider": None,
            "contextWindow": None,
        }

    def test_requires_auth(self, client):
        resp = client.get("/api/screen/model/context-window")
        assert resp.status_code == 401
        assert set(resp.json().keys()) == {"detail"}
