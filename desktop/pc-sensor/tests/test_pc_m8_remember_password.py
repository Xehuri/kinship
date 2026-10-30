# -*- coding: utf-8 -*-
"""PC-M8：勾选"记住密码"后用 Windows DPAPI 加密持久化，重启自动登录。

覆盖点：
- DPAPI 加解密往返（本机可用时）
- remember_password=True + 提供密码 → 磁盘只写 password_enc 密文，绝无明文
- 新进程加载同一配置 → 自动恢复密码（无需手动输入）
- 关闭 remember_password → 一并清除密文
- 配置接口不返回密文，且拒绝前端注入 password_enc
- 未勾选记住密码时行为与 PC-M7 一致（密码只在内存）

注意：DPAPI 依赖 Windows 用户凭据，非 Windows 环境相关用例自动跳过。
"""

import json

import pytest

from pc_sensor import secret_store
from pc_sensor.manager import DEFAULT_CONFIG, ENCRYPTED_PASSWORD_KEY, SensorManager

requires_dpapi = pytest.mark.skipif(
    not secret_store.is_available(), reason="DPAPI 仅 Windows 可用"
)


def _write(tmp_path, cfg: dict) -> str:
    path = tmp_path / "pc_sensor_config.json"
    path.write_text(json.dumps(cfg), encoding="utf-8")
    return str(path)


def _read(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


# ============ 默认配置与 DPAPI 基础 ============


def test_default_config_has_remember_flag():
    """默认配置新增 remember_password，且仍不含明文密码字段。"""
    assert DEFAULT_CONFIG.get("remember_password") is False
    assert "password" not in DEFAULT_CONFIG


@requires_dpapi
def test_dpapi_roundtrip():
    """protect / unprotect 往返一致，且密文不等于明文。"""
    encrypted = secret_store.protect("s3cret-pwd")
    assert encrypted and encrypted != "s3cret-pwd"
    assert secret_store.unprotect(encrypted) == "s3cret-pwd"


@requires_dpapi
def test_dpapi_rejects_invalid_blob():
    """非法密文解密返回 None，不抛异常。"""
    assert secret_store.unprotect("not-a-valid-base64-blob") is None
    assert secret_store.unprotect("") is None


# ============ 记住密码：持久化与自动登录 ============


@requires_dpapi
def test_remember_password_persists_ciphertext_and_autologin(tmp_path):
    """勾选记住密码后：磁盘只有密文，重启加载可自动恢复密码。"""
    cfg_path = _write(tmp_path, {"server_url": ""})
    sm = SensorManager(config_path=cfg_path)
    sm.update_config({"username": "u", "password": "topsecret", "remember_password": True})

    saved = _read(cfg_path)
    assert "password" not in saved                       # 明文绝不落盘
    assert saved["remember_password"] is True
    assert saved[ENCRYPTED_PASSWORD_KEY]                 # 密文已写入
    assert secret_store.unprotect(saved[ENCRYPTED_PASSWORD_KEY]) == "topsecret"

    # 模拟重启：新实例加载同一配置，无需再输入密码
    sm2 = SensorManager(config_path=cfg_path)
    assert sm2._password == "topsecret"


@requires_dpapi
def test_disable_remember_password_clears_ciphertext(tmp_path):
    """关闭记住密码后清除密文，重启不再自动登录。"""
    cfg_path = _write(tmp_path, {"server_url": ""})
    sm = SensorManager(config_path=cfg_path)
    sm.update_config({"password": "p1", "remember_password": True})
    assert ENCRYPTED_PASSWORD_KEY in _read(cfg_path)

    sm.update_config({"remember_password": False})
    assert ENCRYPTED_PASSWORD_KEY not in _read(cfg_path)
    assert ENCRYPTED_PASSWORD_KEY not in sm._cfg

    sm2 = SensorManager(config_path=cfg_path)
    assert sm2._password == ""


@requires_dpapi
def test_decrypt_failure_degrades_to_manual_input(tmp_path, monkeypatch):
    """解密失败（换 Windows 账户/机器）时降级为需手动输入，不抛异常。"""
    cfg_path = _write(tmp_path, {"server_url": ""})
    sm = SensorManager(config_path=cfg_path)
    sm.update_config({"password": "p", "remember_password": True})

    monkeypatch.setattr(secret_store, "unprotect", lambda blob: None)
    sm2 = SensorManager(config_path=cfg_path)
    assert sm2._password == ""


# ============ 与 PC-M7 行为保持一致 ============


def test_without_remember_password_stays_in_memory(tmp_path):
    """未勾选记住密码：密码只在内存，磁盘既无明文也无密文。"""
    cfg_path = _write(tmp_path, {"server_url": ""})
    sm = SensorManager(config_path=cfg_path)
    sm.update_config({"username": "u", "password": "ephemeral"})

    assert sm._password == "ephemeral"
    saved = _read(cfg_path)
    assert "password" not in saved
    assert ENCRYPTED_PASSWORD_KEY not in saved


@requires_dpapi
def test_config_hides_ciphertext_and_rejects_injection(tmp_path):
    """配置接口不返回密文；前端注入的 password_enc 被忽略。"""
    cfg_path = _write(tmp_path, {"server_url": ""})
    sm = SensorManager(config_path=cfg_path)
    sm.update_config({"password": "p", "remember_password": True})

    cfg = sm.config
    assert ENCRYPTED_PASSWORD_KEY not in cfg
    assert "password" not in cfg
    assert cfg["remember_password"] is True

    original = _read(cfg_path)[ENCRYPTED_PASSWORD_KEY]
    sm.update_config({ENCRYPTED_PASSWORD_KEY: "injected-by-client"})
    assert _read(cfg_path)[ENCRYPTED_PASSWORD_KEY] == original


@requires_dpapi
def test_remember_password_survives_unrelated_config_update(tmp_path):
    """仅改其它配置（不带密码）时，已保存的密文应保留。"""
    cfg_path = _write(tmp_path, {"server_url": ""})
    sm = SensorManager(config_path=cfg_path)
    sm.update_config({"password": "keepme", "remember_password": True})
    original = _read(cfg_path)[ENCRYPTED_PASSWORD_KEY]

    sm.update_config({"agent_name": "我的电脑"})
    assert _read(cfg_path)[ENCRYPTED_PASSWORD_KEY] == original
    assert SensorManager(config_path=cfg_path)._password == "keepme"
