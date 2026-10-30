# -*- coding: utf-8 -*-
"""
OpenCode 请求默认值配置化测试

历史问题：opencode 请求体的 agent/model/provider 默认值硬编码在
backend/services/opencode_client.py 与 backend/config/config.py 中
（kimi-for-coding / k2p5 / deepseek-v4-flash / anthropic 等），
且首行被次行覆盖形成死代码，请求可能在不被察觉时带上过期 provider。

本测试锁定改造后的契约：
  1. 缺 opencode 必填键不再 fail-fast，Config 暴露 MISSING_OPENCODE_KEYS 与 DEGRADED
  2. 配置完整时三个 property 返回配置值
  3. 源码中不再残留上述历史硬编码字面量
  4. opencode_client 模块级常量确实来自 config.yaml
"""
from pathlib import Path

import pytest

from config.config import Config, get_config


def _full_opencode():
    return {
        "default_agent": "main-task",
        "default_model": "deepseek-flash",
        "default_provider": "deepseek",
    }


class TestOpencodeDegraded:
    """必填项缺失属于可诊断的降级态，不再阻断启动"""

    def test_missing_whole_opencode_section_is_not_fatal(self):
        cfg = Config({})

        assert cfg.MISSING_OPENCODE_KEYS == [
            "default_model",
            "default_provider",
            "default_agent",
        ]
        assert cfg.DEGRADED is True
        assert cfg.UNCONFIGURED is True
        assert all("opencode." in reason for reason in cfg.DEGRADED_REASONS)

    @pytest.mark.parametrize(
        "missing_key",
        ["default_agent", "default_model", "default_provider"],
    )
    def test_missing_single_key_names_it(self, missing_key):
        opencode = _full_opencode()
        opencode.pop(missing_key)
        cfg = Config({"opencode": opencode})
        assert cfg.MISSING_OPENCODE_KEYS == [missing_key]
        assert any(
            f"opencode.{missing_key}" in reason for reason in cfg.DEGRADED_REASONS
        )

    @pytest.mark.parametrize("empty_value", ["", None])
    def test_empty_value_counts_as_missing(self, empty_value):
        opencode = _full_opencode()
        opencode["default_provider"] = empty_value
        cfg = Config({"opencode": opencode})
        assert cfg.MISSING_OPENCODE_KEYS == ["default_provider"]
        assert cfg.OPENCODE_DEFAULT_PROVIDER == ""

    def test_null_opencode_section(self):
        """opencode: null 安全回落为空节，不抛 TypeError/ValueError"""
        cfg = Config({"opencode": None})
        assert cfg.OPENCODE_DEFAULT_AGENT == ""
        assert cfg.MISSING_OPENCODE_KEYS == [
            "default_model",
            "default_provider",
            "default_agent",
        ]


class TestOpencodeDefaults:
    def test_properties_read_from_config(self):
        cfg = Config({"opencode": _full_opencode()})
        assert cfg.OPENCODE_DEFAULT_AGENT == "main-task"
        assert cfg.OPENCODE_DEFAULT_MODEL == "deepseek-flash"
        assert cfg.OPENCODE_DEFAULT_PROVIDER == "deepseek"

    def test_no_legacy_literals_in_source(self):
        """config.py / opencode_client.py 不得再出现历史硬编码字面量"""
        backend = Path(__file__).resolve().parent.parent
        targets = [
            backend / "config" / "config.py",
            backend / "services" / "opencode_client.py",
        ]
        legacy = [
            "kimi-for-coding",
            "k2p5",
            "deepseek-v4-flash",
            "claude-sonnet",
            "voice-interaction",
            "'anthropic'",
        ]
        for path in targets:
            text = path.read_text(encoding="utf-8")
            for literal in legacy:
                assert literal not in text, f"{path.name} 仍含硬编码字面量: {literal}"

    def test_client_constants_match_config(self):
        """opencode_client 的模块级默认值必须等于 config.yaml 的配置值"""
        import services.opencode_client as oc_client

        cfg = get_config()
        assert oc_client.OPENCODE_DEFAULT_AGENT == cfg.OPENCODE_DEFAULT_AGENT
        assert oc_client.OPENCODE_DEFAULT_MODEL == cfg.OPENCODE_DEFAULT_MODEL
        assert oc_client.OPENCODE_DEFAULT_PROVIDER == cfg.OPENCODE_DEFAULT_PROVIDER
