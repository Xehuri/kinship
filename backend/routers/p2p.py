"""P2P 设备配对与短时信令票据 API（Phase 1）。

p2p.enabled=false 时整组端点返回 404；enroll 是唯一公开路径（配对码自身即凭据）。
任何日志都不得输出配对码、设备 token、信令票据或 SDP/ICE 载荷。
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field

from services.p2p.manager import (
    P2PAccessError,
    P2PDisabledError,
    P2PError,
    P2PManager,
    P2PUnavailableError,
    P2PValidationError,
    get_p2p_manager,
)


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/p2p", tags=["p2p"])


class _RateLimiter:
    """进程内固定窗口限流（按客户端 IP）。"""

    def __init__(self, limit: int, window: float, clock: Any = time.monotonic) -> None:
        self._limit = limit
        self._window = window
        self._clock = clock
        self._hits: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def allow(self, key: str) -> bool:
        now = self._clock()
        with self._lock:
            bucket = [
                timestamp
                for timestamp in self._hits.get(key, [])
                if now - timestamp < self._window
            ]
            if len(bucket) >= self._limit:
                self._hits[key] = bucket
                return False
            bucket.append(now)
            self._hits[key] = bucket
            if len(self._hits) > 4096:
                self._hits = {
                    client: stamps
                    for client, stamps in self._hits.items()
                    if stamps and now - stamps[-1] < self._window
                }
            return True

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


_enroll_limiter = _RateLimiter(limit=10, window=60.0)


class EnrollRequest(BaseModel):
    pairing_code: str = Field(..., min_length=1, max_length=16)
    device_id: str = Field(
        ..., min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$"
    )
    device_name: str = Field("", max_length=128)
    platform: str = Field("", max_length=32)


def _manager() -> P2PManager:
    return get_p2p_manager()


def _require_enabled(manager: P2PManager = Depends(_manager)) -> P2PManager:
    if not manager.config.enabled:
        raise HTTPException(status_code=404, detail="Not Found")
    return manager


def _current_user(request: Request) -> str:
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        raise HTTPException(status_code=401, detail="未授权访问，请先登录")
    return str(user_id)


def _device_public(record: Any) -> dict[str, Any]:
    return {
        "device_id": record.device_id,
        "name": record.name,
        "platform": record.platform,
        "user_id": record.user_id,
        "created_at": record.created_at,
        "last_seen": record.last_seen,
        "revoked_at": record.revoked_at,
        "revoked": record.revoked_at is not None,
    }


def _client_key(request: Request) -> str:
    forwarded = request.headers.get("X-Forwarded-For", "")
    if forwarded:
        first_hop = forwarded.split(",", 1)[0].strip()
        if first_hop:
            return first_hop
    real_ip = request.headers.get("X-Real-IP", "").strip()
    if real_ip:
        return real_ip
    if request.client is not None and request.client.host:
        return request.client.host
    return "unknown"


@router.post("/pairing-code")
async def create_pairing_code(
    request: Request, manager: P2PManager = Depends(_require_enabled)
) -> dict[str, Any]:
    user_id = _current_user(request)
    try:
        pairing_code, expires_at = manager.issue_pairing_code(user_id)
    except P2PDisabledError:
        raise HTTPException(status_code=404, detail="Not Found")
    except P2PError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    # 配对码本身不落日志。
    logger.info(
        "[P2P] 配对码已签发 user=%s expires_at=%s", user_id, expires_at
    )
    return {"pairing_code": pairing_code, "expires_at": expires_at}


@router.post("/enroll")
async def enroll_device(
    payload: EnrollRequest,
    request: Request,
    manager: P2PManager = Depends(_require_enabled),
) -> dict[str, Any]:
    client_key = _client_key(request)
    if not _enroll_limiter.allow(client_key):
        raise HTTPException(status_code=429, detail="too many requests")
    try:
        return manager.enroll(
            payload.pairing_code,
            payload.device_id,
            payload.device_name,
            payload.platform,
        )
    except P2PDisabledError:
        raise HTTPException(status_code=404, detail="Not Found")
    except P2PValidationError:
        # 统一措辞，不暴露配对码是否有效、设备是否已存在。
        raise HTTPException(status_code=400, detail="invalid or expired pairing code")
    except P2PUnavailableError:
        raise HTTPException(status_code=503, detail="p2p signaling is not configured")
    except P2PError:
        raise HTTPException(status_code=400, detail="enrollment failed")


@router.post("/signal-ticket")
async def create_signal_ticket(
    request: Request,
    x_device_id: Optional[str] = Header(default=None, alias="X-Device-Id"),
    manager: P2PManager = Depends(_require_enabled),
) -> dict[str, Any]:
    user_id = _current_user(request)
    token_kind = str(getattr(request.state, "token_kind", "user") or "user")
    token_device_id = str(getattr(request.state, "device_id", "") or "")
    header_device_id = (x_device_id or "").strip()

    if token_kind == "device":
        if (
            header_device_id
            and header_device_id != token_device_id
            and not manager.config.allow_shared_token
        ):
            raise HTTPException(
                status_code=403,
                detail="device token does not match X-Device-Id",
            )
        device_id = (
            header_device_id
            if manager.config.allow_shared_token and header_device_id
            else token_device_id
        )
    else:
        if not header_device_id:
            raise HTTPException(
                status_code=400, detail="X-Device-Id header is required"
            )
        device_id = header_device_id

    try:
        ticket, expires_at_ms = manager.issue_signal_ticket(
            user_id, device_id, allow_auto_enroll=token_kind != "device"
        )
    except P2PValidationError:
        raise HTTPException(status_code=400, detail="invalid device_id")
    except P2PAccessError:
        raise HTTPException(status_code=403, detail="device is not authorized")
    except P2PUnavailableError:
        raise HTTPException(status_code=503, detail="p2p signaling is not configured")
    except P2PError:
        raise HTTPException(status_code=403, detail="device is not authorized")
    return {
        "signal_ticket": ticket,
        "signal_ticket_expires_at": expires_at_ms,
    }


@router.get("/status")
async def get_status(
    manager: P2PManager = Depends(_require_enabled),
) -> dict[str, Any]:
    return manager.status()


@router.get("/devices")
async def list_devices(
    request: Request, manager: P2PManager = Depends(_require_enabled)
) -> dict[str, Any]:
    user_id = _current_user(request)
    return {"devices": [_device_public(record) for record in manager.list_devices(user_id)]}


@router.post("/devices/{device_id}/revoke")
async def revoke_device(
    device_id: str,
    request: Request,
    manager: P2PManager = Depends(_require_enabled),
) -> dict[str, Any]:
    user_id = _current_user(request)
    record = manager.get_device(device_id)
    if record is not None and record.user_id != user_id:
        raise HTTPException(status_code=403, detail="device is not authorized")
    try:
        revoked_tokens = await manager.revoke_device(device_id)
    except P2PDisabledError:
        raise HTTPException(status_code=404, detail="Not Found")
    except P2PUnavailableError:
        raise HTTPException(status_code=503, detail="p2p store is not configured")
    logger.info(
        "[P2P] 撤销请求 device_id=%s user=%s revoked_tokens=%s",
        device_id,
        user_id,
        revoked_tokens,
    )
    return {"ok": True, "revoked_tokens": revoked_tokens}
