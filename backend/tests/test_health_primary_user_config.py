# -*- coding: utf-8 -*-
"""
health.primary_user 配置键测试（H4a）

架构文档 health-data-source-architecture.md 第 8 节要求：
  config.yaml 新增 health 节，primary_user 为主用户（其数据派生到 legacy 路径）；
  新增 backend/config/config.py 的 @property（照 MIMO_API_KEY 写法），
  并同步 config.example.yaml。

锁定契约：
  1. Config 从 health.primary_user 读出主用户标识
  2. 缺键 / health 节为 null 时回落到空字符串（falsy -> HealthStore 视为无主用户）
  3. config.example.yaml 含 health 节占位符 primary_user: Axeuh
"""
from pathlib import Path

import yaml

from config.config import Config


def _opencode_ok():
    """构造期必填的 opencode 节（与 fail-fast 校验对齐）"""
    return {
        "default_agent": "main-task",
        "default_model": "deepseek-flash",
        "default_provider": "deepseek",
    }


class TestHealthPrimaryUserProperty:
    def test_reads_health_primary_user(self):
        cfg = Config({"opencode": _opencode_ok(), "health": {"primary_user": "Axeuh"}})
        assert cfg.HEALTH_PRIMARY_USER == "Axeuh"

    def test_default_empty_when_key_missing(self):
        cfg = Config({"opencode": _opencode_ok(), "health": {}})
        assert cfg.HEALTH_PRIMARY_USER == ""

    def test_default_empty_when_section_missing(self):
        cfg = Config({"opencode": _opencode_ok()})
        assert cfg.HEALTH_PRIMARY_USER == ""

    def test_null_section_returns_empty(self):
        """yaml 里写 `health:` （空值）时安全回落，不抛 AttributeError"""
        cfg = Config({"opencode": _opencode_ok(), "health": None})
        assert cfg.HEALTH_PRIMARY_USER == ""


class TestConfigExampleYaml:
    def test_example_has_health_primary_user(self):
        """config.example.yaml 必须同步 health.primary_user 占位符（纳入 git 的模板）"""
        example = Path(__file__).resolve().parents[2] / "config.example.yaml"
        data = yaml.safe_load(example.read_text(encoding="utf-8"))
        health = data.get("health") or {}
        assert health.get("primary_user") == "Axeuh"
