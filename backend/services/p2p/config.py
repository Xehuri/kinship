from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Mapping
from urllib.parse import urlsplit

from services.p2p.tokens import IDENT_RE


_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
_TICKET_TTL_MIN = 60
_TICKET_TTL_MAX = 900
_PAIRING_TTL_MIN = 60
_PAIRING_TTL_MAX = 900
_WEBRTC_FRAME_MIN = 1024
_WEBRTC_FRAME_MAX = 65536
_WEBRTC_MESSAGE_MIN = 1024 * 1024
_WEBRTC_MESSAGE_MAX = 64 * 1024 * 1024
_WEBRTC_ACK_TIMEOUT_MIN = 5
_WEBRTC_ACK_TIMEOUT_MAX = 300
_DEFAULT_STUN_SERVERS = ("stun:stun.l.google.com:19302",)


def _as_bool(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        text = value.strip().lower()
        if text in {"1", "true", "yes", "on"}:
            return True
        if text in {"0", "false", "no", "off"}:
            return False
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return bool(value)
    return default


def _as_int(value: Any, default: int) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            return default
    return default


def _as_str(value: Any, default: str = "") -> str:
    if value is None:
        return default
    return str(value)


def _as_endpoints(value: Any) -> dict[str, str]:
    if not isinstance(value, Mapping):
        return {}
    endpoints: dict[str, str] = {}
    for key, endpoint in value.items():
        name = str(key).strip()
        url = str(endpoint).strip() if endpoint is not None else ""
        if name and url:
            endpoints[name] = url
    return endpoints


def _is_endpoint_url(value: str) -> bool:
    parsed = urlsplit(value)
    if not parsed.netloc:
        return False
    if parsed.scheme == "https":
        return True
    return parsed.scheme == "http" and (parsed.hostname or "").lower() in _LOCAL_HOSTS


def _as_str_tuple(value: Any, default: tuple[str, ...]) -> tuple[str, ...]:
    if value is None:
        return default
    if isinstance(value, str):
        items = value.split(",")
    elif isinstance(value, (list, tuple)):
        items = value
    else:
        return default
    result = tuple(
        str(item).strip() for item in items if str(item).strip()
    )
    return result


@dataclass(frozen=True, slots=True)
class P2PConfig:
    enabled: bool = False
    server_id: str = "home"
    room: str = ""
    signal_url: str = ""
    signal_secret_env: str = "P2P_SIGNAL_SECRET"
    signal_ticket_ttl_seconds: int = 600
    allow_shared_token: bool = False
    auto_enroll_user_devices: bool = True
    endpoints: dict[str, str] = field(default_factory=dict)
    pairing_code_ttl_seconds: int = 300
    pairing_max_attempts: int = 5
    devices_path: str = ""
    webrtc_enabled: bool = False
    webrtc_stun_servers: tuple[str, ...] = _DEFAULT_STUN_SERVERS
    webrtc_max_frame_bytes: int = 16384
    webrtc_max_message_bytes: int = 8_388_608
    webrtc_ack_timeout_seconds: int = 60

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "P2PConfig":
        if not isinstance(raw, Mapping):
            raw = {}
        server_id = _as_str(raw.get("server_id"), "home").strip()
        room = _as_str(raw.get("room")).strip() or server_id
        webrtc_raw = raw.get("webrtc")
        if not isinstance(webrtc_raw, Mapping):
            webrtc_raw = {}
        return cls(
            enabled=_as_bool(raw.get("enabled"), False),
            server_id=server_id,
            room=room,
            signal_url=_as_str(raw.get("signal_url")).strip(),
            signal_secret_env=_as_str(
                raw.get("signal_secret_env"), "P2P_SIGNAL_SECRET"
            ).strip(),
            signal_ticket_ttl_seconds=_as_int(
                raw.get("signal_ticket_ttl_seconds"), 600
            ),
            allow_shared_token=_as_bool(raw.get("allow_shared_token"), False),
            auto_enroll_user_devices=_as_bool(
                raw.get("auto_enroll_user_devices"), True
            ),
            endpoints=_as_endpoints(raw.get("endpoints")),
            pairing_code_ttl_seconds=_as_int(
                raw.get("pairing_code_ttl_seconds"), 300
            ),
            pairing_max_attempts=max(1, _as_int(raw.get("pairing_max_attempts"), 5)),
            devices_path=_as_str(raw.get("devices_path")).strip(),
            webrtc_enabled=_as_bool(webrtc_raw.get("enabled"), False),
            webrtc_stun_servers=_as_str_tuple(
                webrtc_raw.get("stun_servers"), _DEFAULT_STUN_SERVERS
            ),
            webrtc_max_frame_bytes=_as_int(
                webrtc_raw.get("max_frame_bytes"), 16384
            ),
            webrtc_max_message_bytes=_as_int(
                webrtc_raw.get("max_message_bytes"), 8_388_608
            ),
            webrtc_ack_timeout_seconds=_as_int(
                webrtc_raw.get("ack_timeout_seconds"), 60
            ),
        )

    def _validate_webrtc(self) -> list[str]:
        problems: list[str] = []
        for server in self.webrtc_stun_servers:
            if not server.startswith("stun:"):
                problems.append(
                    "p2p.webrtc.stun_servers entries must start with stun: "
                    "(TURN is not supported)"
                )
                break
        if not (
            _WEBRTC_FRAME_MIN
            <= self.webrtc_max_frame_bytes
            <= _WEBRTC_FRAME_MAX
        ):
            problems.append(
                f"p2p.webrtc.max_frame_bytes must be between "
                f"{_WEBRTC_FRAME_MIN} and {_WEBRTC_FRAME_MAX}"
            )
        if not (
            _WEBRTC_MESSAGE_MIN
            <= self.webrtc_max_message_bytes
            <= _WEBRTC_MESSAGE_MAX
        ):
            problems.append(
                f"p2p.webrtc.max_message_bytes must be between "
                f"{_WEBRTC_MESSAGE_MIN} and {_WEBRTC_MESSAGE_MAX}"
            )
        if not (
            _WEBRTC_ACK_TIMEOUT_MIN
            <= self.webrtc_ack_timeout_seconds
            <= _WEBRTC_ACK_TIMEOUT_MAX
        ):
            problems.append(
                f"p2p.webrtc.ack_timeout_seconds must be between "
                f"{_WEBRTC_ACK_TIMEOUT_MIN} and {_WEBRTC_ACK_TIMEOUT_MAX}"
            )
        return problems

    def validate(self) -> list[str]:
        problems: list[str] = []
        if self.webrtc_enabled:
            problems.extend(self._validate_webrtc())
        if not self.enabled:
            return problems

        effective_room = (self.room or self.server_id).strip()
        if not self.server_id:
            problems.append("p2p.server_id is empty")
        elif IDENT_RE.fullmatch(self.server_id) is None:
            problems.append("p2p.server_id must match [A-Za-z0-9_-]{1,64}")
        if not effective_room:
            problems.append("p2p.room is empty and p2p.server_id is empty")
        elif IDENT_RE.fullmatch(effective_room) is None:
            problems.append("p2p.room must match [A-Za-z0-9_-]{1,64}")

        if not self.signal_url:
            problems.append("p2p.signal_url is empty")
        else:
            parsed = urlsplit(self.signal_url)
            if parsed.scheme == "wss" and parsed.netloc:
                pass
            elif parsed.scheme == "ws" and (parsed.hostname or "").lower() in _LOCAL_HOSTS:
                pass
            else:
                problems.append(
                    "p2p.signal_url must use wss:// (ws:// is allowed only for localhost tests)"
                )

        if not self.endpoints:
            problems.append("p2p.endpoints is empty")
        for name, endpoint in self.endpoints.items():
            if not _is_endpoint_url(endpoint):
                problems.append(
                    f"p2p.endpoints.{name} must be https:// (http:// allowed only for loopback)"
                )

        if not self.signal_secret_env:
            problems.append("p2p.signal_secret_env is empty")
        elif not os.environ.get(self.signal_secret_env):
            problems.append(
                f"environment variable {self.signal_secret_env} is not set"
            )

        if not (_TICKET_TTL_MIN <= self.signal_ticket_ttl_seconds <= _TICKET_TTL_MAX):
            problems.append(
                f"p2p.signal_ticket_ttl_seconds must be between {_TICKET_TTL_MIN} and {_TICKET_TTL_MAX}"
            )
        if not (_PAIRING_TTL_MIN <= self.pairing_code_ttl_seconds <= _PAIRING_TTL_MAX):
            problems.append(
                f"p2p.pairing_code_ttl_seconds must be between {_PAIRING_TTL_MIN} and {_PAIRING_TTL_MAX}"
            )
        if not self.devices_path:
            problems.append("p2p.devices_path is empty")
        return problems

    def public_dict(self) -> dict[str, Any]:
        return {
            "enabled": bool(self.enabled),
            "server_id": self.server_id,
            "room": self.room or self.server_id,
            "signal_url": self.signal_url,
            "endpoints": dict(self.endpoints),
            "webrtc_enabled": bool(self.webrtc_enabled),
        }
