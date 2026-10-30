from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
EXAMPLE_PATH = REPO_ROOT / "config.example.yaml"

P2P_KEYS = {
    "enabled",
    "server_id",
    "room",
    "signal_url",
    "signal_secret_env",
    "signal_ticket_ttl_seconds",
    "allow_shared_token",
    "auto_enroll_user_devices",
    "endpoints",
    "pairing_code_ttl_seconds",
    "pairing_max_attempts",
    "devices_path",
    "webrtc",
}

WEBRTC_KEYS = {
    "enabled",
    "stun_servers",
    "max_frame_bytes",
    "max_message_bytes",
    "ack_timeout_seconds",
}


def _load_p2p():
    with EXAMPLE_PATH.open(encoding="utf-8") as handle:
        return yaml.safe_load(handle)["p2p"]


def test_example_p2p_contract_keys_exist():
    p2p = _load_p2p()

    assert P2P_KEYS <= set(p2p)
    assert WEBRTC_KEYS <= set(p2p["webrtc"])


def test_example_p2p_endpoints_are_https_ipv6_and_frp():
    endpoints = _load_p2p()["endpoints"]

    assert {"ipv6", "frp"} <= set(endpoints)
    for name, url in endpoints.items():
        assert url.startswith("https://"), name
