# -*- coding: utf-8 -*-
"""PC-M5：新装配置 token 为随机串（长度 >= 32），空/过短 token 自动轮换。"""

import json

import pc_sensor_app


def test_default_config_token_is_empty():
    """默认配置不再内置可预测 Token（首启随机生成）。"""
    assert pc_sensor_app.DEFAULT_AGENT_CONFIG["agent_token"] == ""
    assert pc_sensor_app.MIN_AGENT_TOKEN_LENGTH >= 32


def test_generates_random_token_and_persists(tmp_path, monkeypatch):
    cfg_path = tmp_path / "config.json"
    monkeypatch.setattr(pc_sensor_app, "CONFIG_PATH", str(cfg_path))

    cfg = {"agent_token": ""}
    token = pc_sensor_app._ensure_agent_token(cfg)

    assert len(token) >= 32
    assert cfg["agent_token"] == token
    # 已写回磁盘
    saved = json.loads(cfg_path.read_text(encoding="utf-8"))
    assert saved["agent_token"] == token
    # 再次调用保持稳定（不会反复轮换）
    assert pc_sensor_app._ensure_agent_token(cfg) == token


def test_rotates_short_predictable_token(tmp_path, monkeypatch):
    cfg_path = tmp_path / "config.json"
    monkeypatch.setattr(pc_sensor_app, "CONFIG_PATH", str(cfg_path))

    cfg = {"agent_token": "short"}
    token = pc_sensor_app._ensure_agent_token(cfg)

    assert token != "short"
    assert len(token) >= 32


def test_keeps_sufficiently_long_token(tmp_path, monkeypatch):
    cfg_path = tmp_path / "config.json"
    monkeypatch.setattr(pc_sensor_app, "CONFIG_PATH", str(cfg_path))

    existing = "a" * 32
    cfg = {"agent_token": existing}

    assert pc_sensor_app._ensure_agent_token(cfg) == existing
    # 无需持久化
    assert not cfg_path.exists()


def test_generated_tokens_are_distinct(tmp_path, monkeypatch):
    monkeypatch.setattr(pc_sensor_app, "CONFIG_PATH", str(tmp_path / "config.json"))
    t1 = pc_sensor_app._ensure_agent_token({"agent_token": ""})
    t2 = pc_sensor_app._ensure_agent_token({"agent_token": ""})
    assert t1 != t2
