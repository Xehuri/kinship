# -*- coding: utf-8 -*-
"""
V5 characterization: /api/screen/model 契约锁 + model_config 双缓存语义漂移记录

本域改前零测试覆盖（计划 F4）。本文件锁死对外契约，供 V5 收敛重构前后对照：
  1. GET 响应 JSON 键集合与类型（App SettingsViewModel.loadModels 逐键解析：
     success / current.{model,provider} / providers[].{id,name,models[].{id,name}}）
  2. POST 合法/非法 model 的响应码与体
  3. POST 后 GET 立即可见变更
  4. 认证行为（无 token 401 / Bearer 头通过）
  5. 语义漂移锁（F3，改前以 xfail(strict) 记录、V5 收敛后转正为回归网）：
     POST 写入后 services.opencode_client.load_model_config() 必须读到新默认。
     改前缺陷：router 写 backend/config/model_config.json，client 三路径探测
     不含该位置且缓存不随 POST 失效。

测试隔离：写路径重定向到 tmp_path，绝不落真实 backend/config/ 或 ai/config/；
gateway 的 provider 清单以桩数据替换（被测对象是 model_config 缓存/读写，
不是 OpenCode 网络层，桩不算 mock 掉真逻辑）。
"""
import json

import pytest

from config.config import get_config


# 桩 provider 清单：与 client 信封 get_available_models 归一化后的形状一致
# （list[{id,name,models:[{id,name}]}]），m2 故意缺 name → 锁 name 回退 m["id"] 语义
_CANNED_PROVIDERS = [
    {
        "id": "testprov",
        "name": "Test 提供商",
        "models": [
            {"id": "m1", "name": "模型一"},
            {"id": "m2"},
        ],
    },
    {
        "id": "testprov2",
        "name": "Test 提供商二",
        "models": [{"id": "m3", "name": "模型三"}],
    },
]


@pytest.fixture
def stub_gateway(monkeypatch):
    """client.get_available_models 信封桩：固定返回可用模型信封。

    V6 拍扁后 model_config 直连 opencode_client（acquire_opencode_client），
    桩 seam 随之落在路由模块的 acquire 引用上。
    """
    import services.opencode_client as oc
    import routers.model_config as mc

    client = oc.OpenCodeClient(base_url="http://127.0.0.1:5096")

    async def _fake():
        return {"ok": True, "data": {"providers": [dict(p) for p in _CANNED_PROVIDERS]}, "error": None}

    monkeypatch.setattr(client, "get_available_models", _fake)

    async def _fake_acquire():
        return client

    monkeypatch.setattr(mc, "acquire_opencode_client", _fake_acquire)
    return client


@pytest.fixture
def isolated_model_config(tmp_path, monkeypatch):
    """把 model_config.json 读写与 client 缓存隔离到 tmp，前后各清一次缓存。"""
    cfg_file = tmp_path / "config" / "model_config.json"

    # 单一 seam：router 写与 client 读共用 opencode_client.model_config_path
    monkeypatch.setattr(
        "services.opencode_client.model_config_path", lambda: cfg_file
    )

    import services.opencode_client as oc

    # load_model_config() 会把文件值写回模块级 OPENCODE_DEFAULT_MODEL/PROVIDER，
    # 必须快照还原，否则污染同 session 后续 test_opencode_defaults_config 等用例
    _snap_model = oc.OPENCODE_DEFAULT_MODEL
    _snap_provider = oc.OPENCODE_DEFAULT_PROVIDER
    oc.reset_model_config_cache()
    yield cfg_file
    oc.reset_model_config_cache()
    oc.OPENCODE_DEFAULT_MODEL = _snap_model
    oc.OPENCODE_DEFAULT_PROVIDER = _snap_provider


@pytest.fixture
def post_headers(client, auth_headers, stub_gateway, isolated_model_config):
    """聚合全部前置：认证头 + gateway 桩 + 配置隔离。"""
    return auth_headers


def _assert_response_shape(payload):
    """锁 GET/POST 响应 JSON 逐键形状（App 解析面，不得漂移）。"""
    assert set(payload.keys()) == {"success", "current", "providers"}
    assert payload["success"] is True
    cur = payload["current"]
    assert set(cur.keys()) == {"model", "provider"}
    assert isinstance(cur["model"], str) and isinstance(cur["provider"], str)
    assert isinstance(payload["providers"], list)
    for p in payload["providers"]:
        assert set(p.keys()) == {"id", "name", "models"}
        assert isinstance(p["id"], str) and isinstance(p["name"], str)
        assert isinstance(p["models"], list)
        for m in p["models"]:
            assert set(m.keys()) == {"id", "name"}
            assert isinstance(m["id"], str) and isinstance(m["name"], str)


class TestGetModelContract:
    def test_get_shape_and_types(self, client, post_headers):
        resp = client.get("/api/screen/model", headers=post_headers)
        assert resp.status_code == 200
        payload = resp.json()
        _assert_response_shape(payload)

    def test_get_provider_models_and_name_fallback(self, client, post_headers):
        resp = client.get("/api/screen/model", headers=post_headers)
        payload = resp.json()
        by_id = {p["id"]: p for p in payload["providers"]}
        assert set(by_id) == {"testprov", "testprov2"}
        assert by_id["testprov"]["name"] == "Test 提供商"
        assert by_id["testprov"]["models"] == [
            {"id": "m1", "name": "模型一"},
            {"id": "m2", "name": "m2"},  # 缺 name → 回退 id
        ]

    def test_get_default_from_config_when_no_file(self, client, post_headers):
        """文件不存在时 current = config.yaml 默认（F3 现状：GET 走 config.yaml）。"""
        cfg = get_config()
        resp = client.get("/api/screen/model", headers=post_headers)
        cur = resp.json()["current"]
        assert cur["model"] == cfg.OPENCODE_DEFAULT_MODEL
        assert cur["provider"] == cfg.OPENCODE_DEFAULT_PROVIDER

    def test_get_requires_auth(self, client, stub_gateway):
        resp = client.get("/api/screen/model")
        assert resp.status_code == 401


class TestPostModelContract:
    def test_post_valid_200_and_visible_on_get(self, client, post_headers):
        resp = client.post(
            "/api/screen/model",
            json={"model": "m2", "provider": "testprov"},
            headers=post_headers,
        )
        assert resp.status_code == 200
        payload = resp.json()
        _assert_response_shape(payload)
        assert payload["current"] == {"model": "m2", "provider": "testprov"}

        resp2 = client.get("/api/screen/model", headers=post_headers)
        assert resp2.status_code == 200
        assert resp2.json()["current"] == {"model": "m2", "provider": "testprov"}

    def test_post_writes_canonical_json_file(self, client, post_headers, isolated_model_config):
        client.post(
            "/api/screen/model",
            json={"model": "m1", "provider": "testprov"},
            headers=post_headers,
        )
        assert isolated_model_config.exists()
        data = json.loads(isolated_model_config.read_text(encoding="utf-8"))
        assert data == {"default_model": "m1", "default_provider": "testprov"}

    def test_post_invalid_model_400(self, client, post_headers):
        resp = client.post(
            "/api/screen/model",
            json={"model": "nope", "provider": "testprov"},
            headers=post_headers,
        )
        assert resp.status_code == 400
        # 现状：HTTPException 经 main.py 全局 handler 重塑为统一信封
        # （core/errors.http_exception_handler，400 不在 code_map → INTERNAL_ERROR）
        assert resp.json() == {
            "success": False,
            "data": None,
            "error": {"code": "INTERNAL_ERROR", "message": "Invalid model or provider"},
        }

    def test_post_invalid_provider_400(self, client, post_headers):
        resp = client.post(
            "/api/screen/model",
            json={"model": "m1", "provider": "ghostprov"},
            headers=post_headers,
        )
        assert resp.status_code == 400
        assert resp.json() == {
            "success": False,
            "data": None,
            "error": {"code": "INTERNAL_ERROR", "message": "Invalid model or provider"},
        }

    def test_post_requires_auth(self, client, stub_gateway):
        resp = client.post(
            "/api/screen/model",
            json={"model": "m1", "provider": "testprov"},
        )
        assert resp.status_code == 401


class TestCacheConvergence:
    """F3 语义漂移锁（V5 后转正）：router 写后 client 必须立即读到新默认。

    改前该用例以 xfail(strict) 记录缺陷：router 写 backend/config/model_config.json，
    而 client 三路径探测不含该位置且缓存不随 POST 失效。
    V5 收敛为 config 驱动的单一真源路径 + POST 后失效 client 缓存，用例转正为回归网。
    """

    def test_post_invalidates_client_cache(self, client, post_headers):
        import services.opencode_client as oc

        client.post(
            "/api/screen/model",
            json={"model": "m2", "provider": "testprov"},
            headers=post_headers,
        )
        cfg = oc.load_model_config()
        assert cfg["default_model"] == "m2"
        assert cfg["default_provider"] == "testprov"
