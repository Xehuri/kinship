# -*- coding: utf-8 -*-
"""P2PConfig 与 Config.P2P / P2P_DEVICES_PATH。"""
from pathlib import Path

from config.config import Config
from services.p2p.config import P2PConfig

REPO_ROOT = Path(__file__).resolve().parents[2]

_BASE = {
    "opencode": {
        "default_model": "deepseek-flash",
        "default_provider": "deepseek",
        "default_agent": "main-task",
    }
}


def _config(p2p=None):
    data = dict(_BASE)
    if p2p is not None:
        data["p2p"] = p2p
    return Config(data)


def _enabled(**overrides):
    raw = {
        "enabled": True,
        "server_id": "home",
        "room": "home",
        "signal_url": "wss://signal.example.com",
        "signal_secret_env": "P2P_SIGNAL_SECRET",
        "signal_ticket_ttl_seconds": 600,
        "endpoints": {"frp": "https://home.example.com:8768"},
        "pairing_code_ttl_seconds": 300,
        "devices_path": "/tmp/p2p-devices.json",
    }
    raw.update(overrides)
    return P2PConfig.from_dict(raw)


def test_config_p2p_raw_and_devices_path():
    cfg = _config({"devices_path": "custom/devices.json"})

    assert cfg.P2P == {"devices_path": "custom/devices.json"}
    assert cfg.P2P_DEVICES_PATH == str(REPO_ROOT / "custom" / "devices.json")


def test_config_p2p_defaults_when_section_missing():
    cfg = _config()

    assert cfg.P2P == {}
    assert cfg.P2P_DEVICES_PATH == str(
        REPO_ROOT / "backend" / "data" / "p2p" / "devices.json"
    )


def test_config_p2p_ignores_non_mapping_section():
    cfg = _config("not-a-mapping")

    assert cfg.P2P == {}
    assert cfg.P2P_DEVICES_PATH.endswith("backend/data/p2p/devices.json")


def test_from_dict_coercions_and_room_fallback():
    cfg = P2PConfig.from_dict(
        {
            "enabled": "true",
            "server_id": "home",
            "signal_ticket_ttl_seconds": "120",
            "allow_shared_token": 1,
            "pairing_code_ttl_seconds": "300",
            "pairing_max_attempts": "7",
            "endpoints": {"lan": "https://192.168.1.2:8769"},
        }
    )

    assert cfg.enabled is True
    assert cfg.room == "home"
    assert cfg.signal_ticket_ttl_seconds == 120
    assert cfg.allow_shared_token is True
    assert cfg.pairing_code_ttl_seconds == 300
    assert cfg.pairing_max_attempts == 7
    assert cfg.endpoints == {"lan": "https://192.168.1.2:8769"}


def test_auto_enroll_user_devices_defaults_true_and_coerces():
    assert P2PConfig.from_dict({}).auto_enroll_user_devices is True
    assert P2PConfig.from_dict(
        {"auto_enroll_user_devices": "false"}
    ).auto_enroll_user_devices is False
    assert P2PConfig.from_dict(
        {"auto_enroll_user_devices": 0}
    ).auto_enroll_user_devices is False
    assert P2PConfig.from_dict(
        {"auto_enroll_user_devices": "true"}
    ).auto_enroll_user_devices is True
    assert P2PConfig.from_dict(
        {"auto_enroll_user_devices": 1}
    ).auto_enroll_user_devices is True


def test_disabled_config_has_no_requirements():
    assert P2PConfig.from_dict({}).validate() == []
    assert P2PConfig(enabled=False, signal_url="nonsense").validate() == []


def test_enabled_config_valid_with_secret_env(monkeypatch):
    monkeypatch.setenv("P2P_SIGNAL_SECRET", "secret")
    assert _enabled().validate() == []


def test_enabled_requires_secret_env(monkeypatch):
    monkeypatch.delenv("P2P_SIGNAL_SECRET", raising=False)
    problems = _enabled().validate()
    assert any("P2P_SIGNAL_SECRET" in problem for problem in problems)


def test_enabled_validates_signal_url_scheme(monkeypatch):
    monkeypatch.setenv("P2P_SIGNAL_SECRET", "secret")
    assert any("wss://" in problem for problem in _enabled(signal_url="https://x").validate())
    assert any("wss://" in problem for problem in _enabled(signal_url="ws://example.com").validate())


def test_enabled_allows_ws_only_for_localhost(monkeypatch):
    monkeypatch.setenv("P2P_SIGNAL_SECRET", "secret")
    assert _enabled(signal_url="ws://localhost:9000").validate() == []
    assert _enabled(signal_url="ws://127.0.0.1:9000").validate() == []


def test_enabled_validates_endpoints(monkeypatch):
    monkeypatch.setenv("P2P_SIGNAL_SECRET", "secret")
    assert any("endpoints is empty" in p for p in _enabled(endpoints={}).validate())
    assert any(
        "endpoints.lan" in p
        for p in _enabled(endpoints={"lan": "ftp://192.168.1.2"}).validate()
    )


def test_enabled_rejects_private_http_endpoint(monkeypatch):
    monkeypatch.setenv("P2P_SIGNAL_SECRET", "secret")

    problems = _enabled(endpoints={"lan": "http://192.168.1.2:8769"}).validate()

    assert any("endpoints.lan" in problem for problem in problems)


def test_enabled_accepts_https_and_loopback_http_endpoints(monkeypatch):
    monkeypatch.setenv("P2P_SIGNAL_SECRET", "secret")

    assert _enabled(
        endpoints={"ipv6": "https://home.example.com:23443"}
    ).validate() == []
    assert _enabled(
        endpoints={"lan": "http://localhost:8769"}
    ).validate() == []
    assert _enabled(
        endpoints={"lan": "http://127.0.0.1:8769"}
    ).validate() == []


def test_enabled_validates_ttls_and_devices_path(monkeypatch):
    monkeypatch.setenv("P2P_SIGNAL_SECRET", "secret")
    assert any("signal_ticket_ttl_seconds" in p for p in _enabled(signal_ticket_ttl_seconds=30).validate())
    assert any("signal_ticket_ttl_seconds" in p for p in _enabled(signal_ticket_ttl_seconds=901).validate())
    assert any("pairing_code_ttl_seconds" in p for p in _enabled(pairing_code_ttl_seconds=30).validate())
    assert any("pairing_code_ttl_seconds" in p for p in _enabled(pairing_code_ttl_seconds=901).validate())
    assert any("devices_path" in p for p in _enabled(devices_path="").validate())


def test_enabled_requires_server_id_or_room(monkeypatch):
    monkeypatch.setenv("P2P_SIGNAL_SECRET", "secret")
    problems = _enabled(server_id="", room="").validate()
    assert any("server_id" in problem for problem in problems)


def test_enabled_rejects_dotted_room(monkeypatch):
    monkeypatch.setenv("P2P_SIGNAL_SECRET", "secret")
    problems = _enabled(room="home.local").validate()
    assert any("must match [A-Za-z0-9_-]{1,64}" in problem for problem in problems)


def test_enabled_rejects_invalid_server_id(monkeypatch):
    monkeypatch.setenv("P2P_SIGNAL_SECRET", "secret")

    long_id = "a" * 65
    problems = _enabled(server_id=long_id, room=long_id).validate()

    assert any("server_id must match" in problem for problem in problems)
    assert any("room must match" in problem for problem in problems)


def test_enabled_requires_secret_env_name(monkeypatch):
    monkeypatch.setenv("P2P_SIGNAL_SECRET", "secret")
    problems = _enabled(signal_secret_env="").validate()
    assert any("signal_secret_env" in problem for problem in problems)


def test_public_dict_excludes_secrets(monkeypatch):
    monkeypatch.setenv("P2P_SIGNAL_SECRET", "secret")
    public = _enabled().public_dict()

    assert set(public) == {
        "enabled",
        "server_id",
        "room",
        "signal_url",
        "endpoints",
        "webrtc_enabled",
    }
    assert public["enabled"] is True
    assert public["room"] == "home"
    assert public["endpoints"] == {"frp": "https://home.example.com:8768"}
    assert public["webrtc_enabled"] is False
    assert "secret" not in str(public)


def test_webrtc_defaults_are_off_and_stun_only():
    cfg = P2PConfig.from_dict({})

    assert cfg.webrtc_enabled is False
    assert cfg.webrtc_stun_servers == ("stun:stun.l.google.com:19302",)
    assert cfg.webrtc_max_frame_bytes == 16384
    assert cfg.webrtc_max_message_bytes == 8_388_608
    assert cfg.webrtc_ack_timeout_seconds == 60


def test_webrtc_nested_mapping_parsing():
    cfg = P2PConfig.from_dict(
        {
            "enabled": True,
            "webrtc": {
                "enabled": "true",
                "stun_servers": ["stun:a.example.com:3478", "stun:b.example.com"],
                "max_frame_bytes": "32768",
                "max_message_bytes": "1048576",
                "ack_timeout_seconds": "30",
            },
        }
    )

    assert cfg.webrtc_enabled is True
    assert cfg.webrtc_stun_servers == (
        "stun:a.example.com:3478",
        "stun:b.example.com",
    )
    assert cfg.webrtc_max_frame_bytes == 32768
    assert cfg.webrtc_max_message_bytes == 1048576
    assert cfg.webrtc_ack_timeout_seconds == 30


def test_webrtc_accepts_comma_separated_stun_and_empty_list():
    assert P2PConfig.from_dict(
        {"webrtc": {"stun_servers": "stun:a, stun:b"}}
    ).webrtc_stun_servers == ("stun:a", "stun:b")
    assert P2PConfig.from_dict(
        {"webrtc": {"stun_servers": []}}
    ).webrtc_stun_servers == ()


def test_webrtc_validation_rejects_turn(monkeypatch):
    monkeypatch.setenv("P2P_SIGNAL_SECRET", "secret")
    problems = _enabled(
        webrtc={"enabled": True, "stun_servers": ["turn:turn.example.com"]}
    ).validate()

    assert any("TURN is not supported" in problem for problem in problems)


def test_webrtc_validation_bounds(monkeypatch):
    monkeypatch.setenv("P2P_SIGNAL_SECRET", "secret")

    def problems(**overrides):
        webrtc = {"enabled": True, "stun_servers": ["stun:a"]}
        webrtc.update(overrides)
        return _enabled(webrtc=webrtc).validate()

    assert any("max_frame_bytes" in p for p in problems(max_frame_bytes=1023))
    assert any("max_frame_bytes" in p for p in problems(max_frame_bytes=65537))
    assert any("max_message_bytes" in p for p in problems(max_message_bytes=1024 * 1024 - 1))
    assert any("max_message_bytes" in p for p in problems(max_message_bytes=64 * 1024 * 1024 + 1))
    assert any("ack_timeout_seconds" in p for p in problems(ack_timeout_seconds=4))
    assert any("ack_timeout_seconds" in p for p in problems(ack_timeout_seconds=301))
    assert problems(max_frame_bytes=1024, max_message_bytes=1024 * 1024, ack_timeout_seconds=5) == []


def test_webrtc_validation_only_when_enabled(monkeypatch):
    monkeypatch.setenv("P2P_SIGNAL_SECRET", "secret")

    assert _enabled(webrtc={"enabled": False, "stun_servers": ["turn:x"]}).validate() == []
