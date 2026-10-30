# -*- coding: utf-8 -*-
"""PC-M7：后端密码不再明文落盘。

覆盖点：
- 默认配置不含 password 字段，改用 backend_token 作为持久凭据
- 旧版含明文密码的配置在加载时迁移并擦除磁盘字段（仅内存保留）
- update_config 传入的密码只留在内存，绝不写入文件
- 敏感字段 backend_token 在配置接口中脱敏返回
- Uploader 优先使用静态 Token；401 时作废 Token 并重排队列（不静默丢弃）
"""

import json
import os
import time
from email.message import Message
from urllib.error import HTTPError

from pc_sensor.manager import DEFAULT_CONFIG, SensorManager
from pc_sensor.uploader import Uploader


def _write(tmp_path, cfg: dict) -> str:
    path = tmp_path / "pc_sensor_config.json"
    path.write_text(json.dumps(cfg), encoding="utf-8")
    return str(path)


def _read(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


# ============ 配置持久化 ============


def test_default_config_has_no_password_field():
    """默认配置不含明文密码字段，改为 backend_token。"""
    assert "password" not in DEFAULT_CONFIG
    assert DEFAULT_CONFIG.get("backend_token") == ""


def test_legacy_password_migrated_out_of_disk(tmp_path):
    """旧配置含明文密码：加载后从磁盘移除，但内存保留以维持本次登录。"""
    cfg_path = _write(tmp_path, {
        "enabled": False,
        "server_url": "",
        "username": "u",
        "password": "topsecret",
    })
    sm = SensorManager(config_path=cfg_path)

    # 内存中保留，供本次进程登录使用
    assert sm._password == "topsecret"
    # 磁盘上不再有 password 字段
    assert "password" not in _read(cfg_path)


def test_update_config_does_not_persist_password(tmp_path):
    """通过配置接口写入的密码只在内存，绝不落盘。"""
    cfg_path = _write(tmp_path, {"server_url": ""})
    sm = SensorManager(config_path=cfg_path)
    sm.update_config({"username": "u", "password": "newsecret"})

    assert sm._password == "newsecret"          # 内存生效
    saved = _read(cfg_path)
    assert "password" not in saved              # 绝不落盘
    assert saved.get("username") == "u"


def test_config_property_masks_backend_token_and_hides_password(tmp_path):
    cfg_path = _write(tmp_path, {"server_url": "", "backend_token": "tok-1234567890"})
    sm = SensorManager(config_path=cfg_path)

    cfg = sm.config
    assert cfg["backend_token"] == "******"
    assert "password" not in cfg


def test_update_config_keeps_masked_token(tmp_path):
    """收到掩码表示未修改，保留磁盘原 Token。"""
    cfg_path = _write(tmp_path, {"backend_token": "tok-abc"})
    sm = SensorManager(config_path=cfg_path)
    sm.update_config({"backend_token": "******", "username": "u"})

    assert sm._cfg["backend_token"] == "tok-abc"
    assert _read(cfg_path)["backend_token"] == "tok-abc"


def test_backend_token_persisted_and_passed_to_uploader(tmp_path):
    cfg_path = _write(tmp_path, {"backend_token": "static-tok"})
    sm = SensorManager(config_path=cfg_path)

    assert sm.uploader._auth_token == "static-tok"
    assert _read(cfg_path)["backend_token"] == "static-tok"


def test_example_config_has_no_password_field():
    """随仓库分发的示例配置不得包含明文密码字段。"""
    here = os.path.dirname(os.path.abspath(__file__))
    example = os.path.join(os.path.dirname(here), "pc_sensor_config.example.json")
    with open(example, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    assert "password" not in cfg
    assert "backend_token" in cfg


# ============ Uploader 认证 ============


def test_uploader_uses_static_token_without_password():
    """配置静态 Token 时直接生效，无需账号密码、无网络登录。"""
    up = Uploader("https://example.invalid", "", "", "agent", auth_token="static-token")
    assert up.has_token is True
    assert up._token == "static-token"
    assert up._token_expiry == float("inf")


def test_uploader_static_token_survives_force_relogin():
    up = Uploader("https://example.invalid", "u", "p", "agent", auth_token="static-token")
    assert up.force_relogin() is True
    assert up._token == "static-token"


def test_http_401_requeues_instead_of_dropping(monkeypatch):
    """401 视为可重试（作废 Token），不得按 4xx 丢弃数据。"""
    monkeypatch.setattr(Uploader, "_login", lambda self: True)
    up = Uploader("https://example.invalid", "u", "p", "agent")
    up._token = "tok"
    up._token_expiry = time.monotonic() + 3600

    def raise_401(req, timeout=None, context=None):
        raise HTTPError(req.full_url, 401, "Unauthorized", Message(), None)

    monkeypatch.setattr("pc_sensor.uploader.urlopen", raise_401)
    assert up._send_batch([{"i": 1}]) is False   # 可重试，调用方会重排队列
    assert up._token is None


def test_static_token_401_marks_rejected(monkeypatch):
    """静态 Token 被拒后置位标记，避免反复用同一失效 Token 重试。"""
    up = Uploader("https://example.invalid", "", "", "agent", auth_token="static-token")

    def raise_401(req, timeout=None, context=None):
        raise HTTPError(req.full_url, 401, "Unauthorized", Message(), None)

    monkeypatch.setattr("pc_sensor.uploader.urlopen", raise_401)
    assert up._send_batch([{"i": 1}]) is False
    assert up._auth_token_rejected is True
    assert up.has_token is False
