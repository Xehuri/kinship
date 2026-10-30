# -*- coding: utf-8 -*-
"""设备 Token 的签发、校验与定向吊销。"""
import json

import pytest

import auth


@pytest.fixture
def memory_auth(monkeypatch):
    config = auth.AuthConfig(
        users={"Axeuh": auth.UserInfo(password_hash="unused", display_name="Axeuh")},
        tokens={},
    )
    monkeypatch.setattr(auth, "get_auth_config", lambda: config)
    monkeypatch.setattr(auth, "save_auth_config", lambda _config: None)
    monkeypatch.setattr(auth, "_auth_config", config)
    return config


def test_user_token_remains_valid(memory_auth):
    token = auth.create_token("Axeuh")

    valid, user_id, kind, device_id = auth.verify_token_full(token)

    assert (valid, user_id, kind, device_id) == (True, "Axeuh", "user", "")
    assert auth.verify_token(token) == (True, "Axeuh")


def test_device_token_carries_kind_and_device_id(memory_auth):
    token = auth.create_device_token("Axeuh", "phone-1")

    valid, user_id, kind, device_id = auth.verify_token_full(token)

    assert valid is True
    assert user_id == "Axeuh"
    assert kind == "device"
    assert device_id == "phone-1"
    assert auth.verify_token(token) == (True, "Axeuh")


def test_revoke_only_target_device(memory_auth):
    user_token = auth.create_token("Axeuh")
    service_token = auth.ensure_service_token()
    phone_token = auth.create_device_token("Axeuh", "phone-1")
    laptop_token = auth.create_device_token("Axeuh", "laptop-1")

    removed = auth.revoke_device_tokens("phone-1")

    assert removed == 1
    assert auth.verify_token_full(phone_token)[0] is False
    assert auth.verify_token_full(laptop_token) == (True, "Axeuh", "device", "laptop-1")
    assert auth.verify_token_full(user_token) == (True, "Axeuh", "user", "")
    assert auth.verify_token_full(service_token)[2] == "service"
    assert "phone-1" not in str([info.device_id for info in memory_auth.tokens.values()])


def test_revoke_unknown_device_is_noop(memory_auth):
    user_token = auth.create_token("Axeuh")

    assert auth.revoke_device_tokens("missing") == 0
    assert auth.verify_token_full(user_token)[0] is True


def test_old_auth_json_without_device_id_loads(tmp_path, monkeypatch):
    auth_file = tmp_path / "auth.json"
    auth_file.write_text(
        json.dumps(
            {
                "users": {
                    "Axeuh": {
                        "password_hash": "unused",
                        "display_name": "Axeuh",
                    }
                },
                "tokens": {
                    "legacy-token": {
                        "user_id": "Axeuh",
                        "expires_at": "2099-01-01T00:00:00",
                    }
                },
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(auth, "AUTH_CONFIG_FILE", str(auth_file))

    loaded = auth.load_auth_config()

    assert loaded.tokens["legacy-token"].kind == "user"
    assert loaded.tokens["legacy-token"].device_id == ""


def test_expired_device_token_is_removed(memory_auth, monkeypatch):
    token = auth.create_device_token("Axeuh", "phone-1")
    memory_auth.tokens[token].expires_at = "2000-01-01T00:00:00"

    valid, _user_id, _kind, _device_id = auth.verify_token_full(token)

    assert valid is False
    assert token not in memory_auth.tokens
