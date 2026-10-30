# -*- coding: utf-8 -*-
"""W30-B1 Web 通道后端选择器离线单测。

风格镜像 test_ai_client_factory.py：_set_global 改 cfg._data、asyncio.run 同步
驱动、零触网。锁死四条语义：
  1. 状态文件缺失/损坏/非法值 → 回落全局 ai_backend（Web 通道绝不因状态文件崩溃）；
  2. set→get 在 tmp 路径上闭环，且 Web 值覆盖全局值（两通道并跑时互不干扰）；
  3. set 校验 _VALID_BACKENDS，非法值抛 ValueError 且不污染既有状态文件；
  4. acquire/get 按 Web 值路由 loom/opencode 原语；web_agent_key 命名空间格式。
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest

from config.config import get_config
import services.ai_client_factory as factory
import services.loom_client as lc
import services.opencode_client as oc
import services.web_backend_selector as wbs


def _set_global(value):
    """改全局 ai_backend（None=删键回落缺省 opencode），返回旧值供恢复。"""
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
def reset_clients():
    """两通道单例重置（镜像 TestFactoryRouting setup/teardown，防单例串测试）。"""
    factory._reset_ai_client()
    yield
    factory._reset_ai_client()


class TestFallbackSemantics:
    def test_missing_file_falls_back_to_global(self, tmp_state):
        old = _set_global("loom")
        try:
            assert not tmp_state.exists()
            assert wbs.get_web_backend() == "loom"
        finally:
            _set_global(old)

    def test_missing_key_default_global_opencode(self, tmp_state):
        old = _set_global(None)
        try:
            assert wbs.get_web_backend() == "opencode"
        finally:
            _set_global(old)

    @pytest.mark.parametrize("raw", [
        "not json {{",                    # 截断/乱码
        '{"nope": 1}',                    # 合法 JSON 缺 backend 键
        '{"backend": 42}',                # backend 非字符串
        '{"backend": "lmao"}',            # 非法取值（响亮告警后回落，绝不抛）
        "[1, 2]",                         # 根节点不可下标（TypeError 路径）
    ])
    def test_corrupt_state_falls_back(self, tmp_state, raw):
        tmp_state.write_text(raw, encoding="utf-8")
        old = _set_global("opencode")
        try:
            assert wbs.get_web_backend() == "opencode"
        finally:
            _set_global(old)


class TestSetGetRoundtrip:
    def test_web_value_overrides_global(self, tmp_state):
        old = _set_global("opencode")
        try:
            assert wbs.set_web_backend("loom") == "loom"
            assert wbs.get_web_backend() == "loom"  # 全局仍 opencode，Web 通道独立
            state = json.loads(tmp_state.read_text(encoding="utf-8"))
            assert state["backend"] == "loom"
            assert "updated_at" in state
        finally:
            _set_global(old)

    def test_roundtrip_both_directions(self, tmp_state):
        old = _set_global("opencode")
        try:
            wbs.set_web_backend("loom")
            wbs.set_web_backend("opencode")  # 覆盖写不残留旧值
            assert wbs.get_web_backend() == "opencode"
        finally:
            _set_global(old)

    def test_invalid_value_rejected_without_touching_file(self, tmp_state):
        old = _set_global("opencode")
        try:
            wbs.set_web_backend("loom")
            with pytest.raises(ValueError):
                wbs.set_web_backend("lmao")
            assert wbs.get_web_backend() == "loom"  # 非法写入被拒，旧状态原样
        finally:
            _set_global(old)

    def test_tmp_file_not_left_behind(self, tmp_state):
        old = _set_global("opencode")
        try:
            wbs.set_web_backend("loom")
            assert not tmp_state.with_name(tmp_state.name + ".tmp").exists()
        finally:
            _set_global(old)


class TestClientRouting:
    def test_acquire_routes_to_loom(self, tmp_state, reset_clients):
        wbs.set_web_backend("loom")
        client = asyncio.run(wbs.acquire_web_client())
        assert isinstance(client, lc.LoomClient)

    def test_acquire_routes_to_opencode_stub_discovery(self, tmp_state, reset_clients, monkeypatch):
        # 桩端口探测（零触网），与 test_ai_client_factory:62 同款
        monkeypatch.setattr(oc, "discover_opencode_url",
                            lambda max_offset=10: "http://127.0.0.1:5096")
        wbs.set_web_backend("opencode")
        client = asyncio.run(wbs.acquire_web_client())
        assert isinstance(client, oc.OpenCodeClient)

    def test_get_web_client_sync_loom_singleton(self, tmp_state, reset_clients):
        wbs.set_web_backend("loom")
        assert wbs.get_web_client() is lc.get_loom_client()

    def test_global_factory_unaffected_by_web_state(self, tmp_state, reset_clients, monkeypatch):
        """红线：Web 状态文件绝不污染全局工厂（后台调用方仍按 ai_backend 择路）。"""
        monkeypatch.setattr(oc, "discover_opencode_url",
                            lambda max_offset=10: "http://127.0.0.1:5096")
        old = _set_global("opencode")
        try:
            wbs.set_web_backend("loom")
            assert wbs.get_web_backend() == "loom"
            assert factory.get_ai_backend() == "opencode"
            assert isinstance(factory.get_ai_client(), oc.OpenCodeClient)
        finally:
            _set_global(old)


class TestAgentKeyNamespace:
    def test_key_format(self):
        assert wbs.web_agent_key("main-task", "loom") == "loom:main-task"
        assert wbs.web_agent_key("reviewer", "opencode") == "opencode:reviewer"

    def test_options_contract_shape(self):
        # 前端 backend.ts 固定清单顺序：["opencode", "loom"]
        assert list(wbs.WEB_BACKEND_OPTIONS) == ["opencode", "loom"]
