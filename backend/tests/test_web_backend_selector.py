# -*- coding: utf-8 -*-
"""W53 后端择路收敛：config.yaml 顶层 ai_backend 是唯一真源。

锁死五条语义：
  1. get_web_backend 恒等于 get_ai_backend——旧 web_backend.json 存在且取值
     不同也不参与择路（W30 两层判据的生产事故就此关死）；
  2. WEB_BACKEND_OPTIONS 取值集合 == _VALID_BACKENDS（前端契约清单只影响顺序）；
  3. 本模块不再提供写入面（切换入口只在配置，写操作由 config API 的密码校验守卫）；
  4. deprecate_legacy_state 把旧状态文件改名留档（坏 JSON 也归档、不阻断启动）；
  5. acquire/get 客户端按唯一后端路由；web_agent_key 命名空间格式不变。
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest

from config.config import get_config
import services.ai_client_factory as factory
import services.dsh_client as dc
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
def restore_backend():
    """用例结束后恢复 ai_backend 原值（含"原来就没有这个键"）。"""
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
    """旧状态文件路径重定向 tmp（绝不碰生产 ai/data/cache/web_backend.json）。"""
    path = tmp_path / "web_backend.json"
    monkeypatch.setattr(wbs, "legacy_state_path", lambda: path)
    return path


@pytest.fixture
def reset_clients():
    factory._reset_ai_client()
    yield
    factory._reset_ai_client()


class TestSingleTruth:
    def test_missing_legacy_file_reads_config(self, legacy_file, restore_backend):
        _set_global("loom")
        assert not legacy_file.exists()
        assert wbs.get_web_backend() == "loom"

    def test_missing_key_defaults_to_opencode(self, legacy_file, restore_backend):
        _set_global(None)
        assert wbs.get_web_backend() == "opencode"

    @pytest.mark.parametrize("stale", [
        json.dumps({"backend": "loom"}),
        json.dumps({"backend": "opencode"}),
        '{"backend": "lmao"}',
        "not json {{",
    ])
    def test_legacy_file_never_overrides_config(self, legacy_file, restore_backend, stale):
        """W30 的状态文件已退役：内容再"合法"也不参与择路。"""
        legacy_file.write_text(stale, encoding="utf-8")
        _set_global("dsh")
        assert wbs.get_web_backend() == "dsh"

    def test_invalid_config_value_still_fails_fast(self, legacy_file, restore_backend):
        _set_global("lmao")
        with pytest.raises(ValueError):
            wbs.get_web_backend()

    def test_options_match_valid_backends(self):
        assert set(wbs.WEB_BACKEND_OPTIONS) == set(factory._VALID_BACKENDS)
        # 前端 backend.ts 的固定清单（顺序即展示顺序，dsh 放末位）
        assert list(wbs.WEB_BACKEND_OPTIONS) == ["opencode", "loom", "dsh"]


class TestNoWriteSurface:
    """W53 红线：selector 只读；切换只能经配置写入（带密码二次校验）。"""

    def test_selector_exposes_no_config_writer(self):
        assert not hasattr(wbs, "set_web_backend")
        assert not hasattr(wbs, "_config_store")


class TestLegacyDeprecation:
    def test_no_file_is_noop(self, legacy_file, restore_backend):
        _set_global("dsh")
        assert wbs.deprecate_legacy_state() is None
        assert not legacy_file.exists()

    def test_file_is_archived_with_content(self, legacy_file, restore_backend):
        legacy_file.write_text(
            json.dumps({"backend": "loom", "updated_at": 1}), encoding="utf-8"
        )
        _set_global("dsh")
        result = wbs.deprecate_legacy_state()
        assert result is not None
        assert result["legacy"] == "loom"
        assert result["effective"] == "dsh"
        archived = legacy_file.with_name(os.path.basename(result["archived"]))
        assert archived.exists()
        assert not legacy_file.exists()
        payload = json.loads(archived.read_text(encoding="utf-8"))
        assert payload["backend"] == "loom"  # 留档内容逐字节语义不变

    def test_corrupt_file_is_still_archived(self, legacy_file, restore_backend):
        legacy_file.write_text("not json {{", encoding="utf-8")
        _set_global("opencode")
        result = wbs.deprecate_legacy_state()
        assert result is not None
        assert result["legacy"] is None
        assert not legacy_file.exists()

    def test_second_archive_gets_unique_suffix(self, legacy_file, restore_backend):
        _set_global("opencode")
        legacy_file.write_text('{"backend": "loom"}', encoding="utf-8")
        first = wbs.deprecate_legacy_state()
        legacy_file.write_text('{"backend": "loom"}', encoding="utf-8")
        second = wbs.deprecate_legacy_state()
        assert first is not None and second is not None
        assert first["archived"] != second["archived"]


class TestClientRouting:
    def test_get_client_routes_to_loom(self, legacy_file, reset_clients, restore_backend):
        _set_global("loom")
        assert wbs.get_web_client() is lc.get_loom_client()

    def test_get_client_routes_to_dsh(self, legacy_file, reset_clients, restore_backend):
        _set_global("dsh")
        assert wbs.get_web_client() is dc.get_dsh_client()

    def test_acquire_routes_to_opencode_stub_discovery(
        self, legacy_file, reset_clients, restore_backend, monkeypatch
    ):
        # 桩端口探测（零触网），与 test_ai_client_factory 同款
        monkeypatch.setattr(
            oc, "discover_opencode_url", lambda max_offset=10: "http://127.0.0.1:5096"
        )
        _set_global("opencode")
        client = asyncio.run(wbs.acquire_web_client())
        assert isinstance(client, oc.OpenCodeClient)

    def test_factory_and_web_share_one_value(
        self, legacy_file, reset_clients, restore_backend, monkeypatch
    ):
        """红线（W53）：Web 通道与全局工厂不再可能读到不同的后端。"""
        monkeypatch.setattr(
            oc, "discover_opencode_url", lambda max_offset=10: "http://127.0.0.1:5096"
        )
        _set_global("opencode")
        assert wbs.get_web_backend() == factory.get_ai_backend() == "opencode"
        assert isinstance(factory.get_ai_client(), oc.OpenCodeClient)


class TestAgentKeyNamespace:
    def test_key_format(self):
        assert wbs.web_agent_key("main-task", "loom") == "loom:main-task"
        assert wbs.web_agent_key("reviewer", "opencode") == "opencode:reviewer"
        assert wbs.web_agent_key("main-task", "dsh") == "dsh:main-task"
