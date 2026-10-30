from __future__ import annotations

import contextlib
import hashlib
import logging
import os
from typing import Any, Optional

import auth
from services.p2p.config import P2PConfig
from services.p2p.errors import (
    P2PAccessError,
    P2PDisabledError,
    P2PUnavailableError,
    P2PValidationError,
)
from services.p2p.records import DeviceRecord
from services.p2p.store import (
    DeviceStore,
    PairingCodes,
    is_valid_device_id,
)
from services.p2p.tokens import IDENT_RE, SignalTicketIssuer


logger = logging.getLogger(__name__)


class DeviceOperations:
    """设备配对、设备 token 与信令票据的持久化与鉴权编排。"""

    def __init__(
        self,
        config: P2PConfig,
        *,
        store: Optional[DeviceStore] = None,
        pairing: Optional[PairingCodes] = None,
        issuer: Optional[SignalTicketIssuer] = None,
    ) -> None:
        self.config = config
        self._store = store
        self._pairing = pairing
        self._issuer = issuer

    @property
    def room(self) -> str:
        return (self.config.room or self.config.server_id).strip()

    @property
    def room_is_usable(self) -> bool:
        return IDENT_RE.fullmatch(self.room) is not None

    def ensure_store(self) -> DeviceStore:
        if self._store is None:
            if not self.config.devices_path:
                raise P2PUnavailableError("p2p.devices_path is not configured")
            self._store = DeviceStore(self.config.devices_path)
        return self._store

    def ensure_pairing(self) -> PairingCodes:
        if self._pairing is None:
            self._pairing = PairingCodes(
                ttl_seconds=self.config.pairing_code_ttl_seconds,
                max_attempts=self.config.pairing_max_attempts,
            )
        return self._pairing

    def store_or_none(self) -> Optional[DeviceStore]:
        if self._store is not None:
            return self._store
        if not self.config.enabled or not self.config.devices_path:
            return None
        try:
            return self.ensure_store()
        except Exception:  # noqa: BROAD_EXCEPT_OK - status probe is best-effort
            return None

    def ensure_issuer(self) -> Optional[SignalTicketIssuer]:
        if self._issuer is not None:
            return self._issuer
        secret = os.environ.get(self.config.signal_secret_env, "")
        if not secret or not self.room_is_usable:
            return None
        self._issuer = SignalTicketIssuer(
            secret=secret,
            ttl_seconds=self.config.signal_ticket_ttl_seconds,
            room=self.room,
        )
        return self._issuer

    def require_issuer(self) -> SignalTicketIssuer:
        issuer = self.ensure_issuer()
        if issuer is None:
            raise P2PUnavailableError("p2p signal secret is not configured")
        return issuer

    def save(self) -> None:
        if self._store is not None:
            self._store.save()

    def device_count(self) -> int:
        store = self.store_or_none()
        if store is None:
            return 0
        try:
            return len(store.list())
        except Exception:  # noqa: BROAD_EXCEPT_OK - status probe is best-effort
            return 0

    def issue_pairing_code(self, user_id: str) -> tuple[str, int]:
        if not self.config.enabled:
            raise P2PDisabledError("p2p is disabled")
        return self.ensure_pairing().issue(user_id)

    def enroll(
        self,
        code: str,
        device_id: str,
        device_name: str = "",
        platform: str = "",
    ) -> dict[str, Any]:
        if not self.config.enabled:
            raise P2PDisabledError("p2p is disabled")
        normalized_device_id = (device_id or "").strip()
        if not is_valid_device_id(normalized_device_id):
            raise P2PValidationError("invalid device_id")
        if not self.room_is_usable:
            raise P2PUnavailableError("p2p room is not usable")
        issuer = self.require_issuer()

        user_id = self.ensure_pairing().consume(code, normalized_device_id)
        if not user_id:
            raise P2PValidationError("invalid or expired pairing code")

        ticket, expires_at_ms = issuer.issue(normalized_device_id)
        token = auth.create_device_token(user_id, normalized_device_id)
        fingerprint = hashlib.sha256(token.encode("utf-8")).hexdigest()
        try:
            self.ensure_store().register(
                device_id=normalized_device_id,
                name=(device_name or normalized_device_id).strip(),
                platform=(platform or "").strip(),
                user_id=user_id,
                token_fingerprint=fingerprint,
            )
        except Exception:  # noqa: BROAD_EXCEPT_OK - revoke token on any write failure
            with contextlib.suppress(Exception):
                auth.logout(token)
            raise

        logger.info(
            "[P2P] 设备配对成功 device_id=%s user=%s", normalized_device_id, user_id
        )
        return {
            "device_id": normalized_device_id,
            "user_id": user_id,
            "device_token": token,
            "signal_url": self.config.signal_url,
            "room": self.room,
            "endpoints": dict(self.config.endpoints),
            "signal_ticket": ticket,
            "signal_ticket_expires_at": expires_at_ms,
        }

    def issue_signal_ticket(
        self,
        user_id: str,
        device_id: str,
        *,
        allow_auto_enroll: bool = True,
    ) -> tuple[str, int]:
        if not self.config.enabled:
            raise P2PDisabledError("p2p is disabled")
        normalized_device_id = (device_id or "").strip()
        if not is_valid_device_id(normalized_device_id):
            raise P2PValidationError("invalid device_id")
        if not self.room_is_usable:
            raise P2PUnavailableError("p2p room is not usable")
        issuer = self.require_issuer()
        store = self.ensure_store()
        record = store.get(normalized_device_id)
        if record is None:
            if not (allow_auto_enroll and self.config.auto_enroll_user_devices):
                raise P2PAccessError("device is not enrolled")
            record = store.register(
                device_id=normalized_device_id,
                name=normalized_device_id,
                platform="",
                user_id=user_id,
                token_fingerprint="",
            )
            logger.info(
                "[P2P] 设备自动注册 device_id=%s user=%s",
                normalized_device_id,
                user_id,
            )
        if record.revoked_at is not None:
            raise P2PAccessError("device is revoked")
        if record.user_id != user_id:
            raise P2PAccessError("device does not belong to user")
        ticket, expires_at_ms = issuer.issue(normalized_device_id)
        store.touch(normalized_device_id)
        return ticket, expires_at_ms

    def list_devices(self, user_id: Optional[str] = None) -> list[DeviceRecord]:
        store = self.store_or_none()
        if store is None:
            return []
        return store.list(user_id)

    def get_device(self, device_id: str) -> Optional[DeviceRecord]:
        store = self.store_or_none()
        if store is None:
            return None
        return store.get(device_id)

    def revoke(self, device_id: str) -> int:
        if not self.config.enabled:
            raise P2PDisabledError("p2p is disabled")
        revoked_tokens = auth.revoke_device_tokens(device_id)
        self.ensure_store().revoke(device_id)
        logger.info(
            "[P2P] 设备已撤销 device_id=%s revoked_tokens=%s",
            device_id,
            revoked_tokens,
        )
        return revoked_tokens
