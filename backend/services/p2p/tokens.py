from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets
import time
from typing import Callable, Optional


MAX_TICKET_TTL_SECONDS = 900
_TICKET_VERSION = "v1"

# 与 tools/axeuh-signal/signal_auth.py 保持一致，任一侧改动都会导致握手失败。
IDENT_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")
NONCE_RE = re.compile(r"[A-Za-z0-9_-]{16,64}")
SIG_RE = re.compile(r"[A-Za-z0-9_-]{43}")


class SignalTicketError(ValueError):
    """非法的票据密钥或标识符。"""


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _safe_equal(left: str, right: str) -> bool:
    try:
        return hmac.compare_digest(left.encode("utf-8"), right.encode("utf-8"))
    except (TypeError, UnicodeError):
        return False


class SignalTicketIssuer:
    """HMAC 短时信令票据。

    格式固定为 v1.<device_id>.<room>.<exp_ms>.<nonce>.<sig>，
    服务端 tools/axeuh-signal 按同一格式验签，不得单侧改动。
    """

    def __init__(
        self,
        secret: str,
        ttl_seconds: int = 600,
        room: str = "",
        clock: Callable[[], float] = time.time,
    ) -> None:
        if not secret:
            raise SignalTicketError("signal ticket secret is required")
        self._secret = secret.encode("utf-8")
        self._ttl_seconds = max(1, min(MAX_TICKET_TTL_SECONDS, int(ttl_seconds)))
        self._room = str(room or "")
        self._clock = clock

    @property
    def ttl_seconds(self) -> int:
        return self._ttl_seconds

    @property
    def room(self) -> str:
        return self._room

    def _sign(self, payload: str) -> str:
        digest = hmac.new(self._secret, payload.encode("utf-8"), hashlib.sha256).digest()
        return _b64url(digest)

    def issue(self, device_id: str) -> tuple[str, int]:
        if IDENT_RE.fullmatch(device_id) is None:
            raise SignalTicketError("invalid device_id for signal ticket")
        if IDENT_RE.fullmatch(self._room) is None:
            raise SignalTicketError("invalid room for signal ticket")
        expires_at_ms = int(self._clock() * 1000) + self._ttl_seconds * 1000
        nonce = _b64url(secrets.token_bytes(12))
        payload = (
            f"{_TICKET_VERSION}.{device_id}.{self._room}."
            f"{expires_at_ms}.{nonce}"
        )
        return f"{payload}.{self._sign(payload)}", expires_at_ms

    def verify(
        self,
        ticket: str,
        expected_device_id: str = "",
        expected_room: Optional[str] = None,
    ) -> bool:
        if not isinstance(ticket, str):
            return False
        parts = ticket.split(".")
        if len(parts) != 6:
            return False
        version, device_id, room, exp_text, nonce, signature = parts
        if version != _TICKET_VERSION:
            return False
        if IDENT_RE.fullmatch(device_id) is None or IDENT_RE.fullmatch(room) is None:
            return False
        if not exp_text.isdigit() or not exp_text.isascii() or len(exp_text) > 16:
            return False
        if NONCE_RE.fullmatch(nonce) is None or SIG_RE.fullmatch(signature) is None:
            return False

        payload = ".".join(parts[:5])
        if not _safe_equal(signature, self._sign(payload)):
            return False

        expires_at_ms = int(exp_text)
        now_ms = int(self._clock() * 1000)
        if expires_at_ms <= now_ms:
            return False
        if expires_at_ms > now_ms + MAX_TICKET_TTL_SECONDS * 1000:
            return False

        room_expected = self._room if expected_room is None else str(expected_room)
        if not _safe_equal(device_id, str(expected_device_id or "")):
            return False
        if not _safe_equal(room, room_expected):
            return False
        return True
