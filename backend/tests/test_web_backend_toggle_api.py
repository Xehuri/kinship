# -*- coding: utf-8 -*-
"""W30-B2 /api/screen/backend 切换端点契约测（conftest client + auth_headers）。

前端已发货的固定契约（frontend/mobile/src/api/backend.ts）逐形状锁死：
  GET  200 {"ok":true,"backend":<当前>,"options":["opencode","loom"]}
  POST 合法 200 同形态 + 状态文件已落盘（进程内现读，无需重启即生效）；
  POST 非法 400 {"ok":false,"error":<文本>} 且不落盘。
W44 解耦钉：POST（合法/非法）一律零触碰 events 双活 hub 注册表——切换只改
对话管线路由，SSE 恒双流多路复用，hub 生命周期与开关无关。
401 无 Token 形状抄 test_session_api_contract.TestAuthContract 先例
（中间件短路裸 {"detail":...}）。状态文件一律 monkeypatch 重定向 tmp。
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
def tmp_state(monkeypatch, tmp_path):
    """状态文件重定向 tmp（绝不写生产 ai/data/cache/web_backend.json）。"""
    path = tmp_path / "web_backend.json"
    monkeypatch.setattr(wbs, "_state_path", lambda: path)
    return path


@pytest.fixture
def global_opencode():
    """全局通道钉 opencode：验证 Web 开关独立于全局值。"""
    old = _set_global("opencode")
    yield
    _set_global(old)


class TestGetBackendContract:
    def test_shape_without_state_file_falls_back_global(
        self, client, auth_headers, tmp_state, global_opencode
    ):
        resp = client.get("/api/screen/backend", headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json() == {
            "ok": True, "backend": "opencode", "options": ["opencode", "loom"],
        }

    def test_shape_reflects_web_override_not_global(
        self, client, auth_headers, tmp_state, global_opencode
    ):
        wbs.set_web_backend("loom")
        resp = client.get("/api/screen/backend", headers=auth_headers)
        assert resp.json()["backend"] == "loom"  # 全局仍 opencode，Web 通道独立


class TestPostBackendContract:
    def test_valid_roundtrip_persisted_and_live(
        self, client, auth_headers, tmp_state, global_opencode
    ):
        resp = client.post("/api/screen/backend", json={"backend": "loom"},
                           headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json() == {
            "ok": True, "backend": "loom", "options": ["opencode", "loom"],
        }
        state = json.loads(tmp_state.read_text(encoding="utf-8"))
        assert state["backend"] == "loom"
        again = client.get("/api/screen/backend", headers=auth_headers)
        assert again.json()["backend"] == "loom"  # 现读生效，无重启语义

    def test_invalid_400_contract_shape(
        self, client, auth_headers, tmp_state, global_opencode
    ):
        resp = client.post("/api/screen/backend", json={"backend": "lmao"},
                           headers=auth_headers)
        assert resp.status_code == 400
        payload = resp.json()
        assert set(payload.keys()) == {"ok", "error"}
        assert payload["ok"] is False
        assert isinstance(payload["error"], str) and payload["error"]
        assert not tmp_state.exists()  # 非法值零落盘

    def test_valid_post_leaves_hub_registry_untouched(
        self, client, auth_headers, tmp_state, global_opencode, monkeypatch
    ):
        """W44 解耦钉（取代 W30 "POST 必 await reset" 钉）：切换只落状态文件，
        双活 hub 注册表零触碰——reset_event_hub 不再被调用、两槽对象原样保留。"""
        import routers.events as events_api

        calls = []

        async def _spy_reset():
            calls.append("reset")

        hubs_before = {"opencode": object(), "loom": object()}
        monkeypatch.setattr(events_api, "_hubs", hubs_before)
        monkeypatch.setattr(events_api, "reset_event_hub", _spy_reset)
        resp = client.post("/api/screen/backend", json={"backend": "loom"},
                           headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["backend"] == "loom"
        assert calls == []  # 切换与 hub 生命周期解耦
        assert events_api._hubs == hubs_before  # 两槽对象与键零变动
        assert not hasattr(web_backend_api, "reset_event_hub")  # import 面已摘除

    def test_invalid_post_keeps_hub_registry_untouched(
        self, client, auth_headers, tmp_state, global_opencode, monkeypatch
    ):
        """非法值第一步就 400，同样绝不惊动 hub（与合法路径同一不变量）。"""
        import routers.events as events_api

        hubs_before = {"opencode": object(), "loom": object()}
        monkeypatch.setattr(events_api, "_hubs", hubs_before)
        resp = client.post("/api/screen/backend", json={"backend": "nope"},
                           headers=auth_headers)
        assert resp.status_code == 400
        assert events_api._hubs == hubs_before


class TestBackendAuth:
    def test_get_without_token_401(self, client):
        resp = client.get("/api/screen/backend")
        assert resp.status_code == 401
        assert resp.json() == {"detail": "未授权访问，请先登录"}

    def test_post_without_token_401(self, client):
        resp = client.post("/api/screen/backend", json={"backend": "loom"})
        assert resp.status_code == 401
        assert set(resp.json().keys()) == {"detail"}
