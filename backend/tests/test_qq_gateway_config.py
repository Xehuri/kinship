from __future__ import annotations

import asyncio

from services.qq_gateway.config import QQGatewayConfig


def test_config_parses_defaults_and_validation() -> None:
    config = QQGatewayConfig.from_dict({
        "enabled": True,
        "account": {"self_qq": "100", "ws_url": "ws://127.0.0.1:3001", "ws_token": "t"},
        "inbound": {"groups": True},
        "mcp": {"enabled": True, "token": "m"},
    })
    assert config.enabled is True
    assert config.account.self_qq == "100"
    assert "group_allowlist" in "; ".join(config.validate())
    assert config.forward.max_depth == 3


def test_config_disabled_has_no_problems() -> None:
    config = QQGatewayConfig.from_dict({"enabled": False})
    assert config.enabled is False
    assert config.validate() == []
