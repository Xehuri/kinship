# -*- coding: utf-8 -*-
"""Onboarding gate: block non-onboarding traffic until onboarding completes.

The gate keys on ``onboarding_state.completed`` (single startup path: the
service plane always runs, so ``bootstrap_runtime.active`` is never a valid
signal). A missing state file falls back to auth setup requirement, which keeps
legacy installs (users exist, no state file) pass-through. The middleware is
registered outside AuthMiddleware so blocked requests get 503 without a token.
"""
from __future__ import annotations

import logging

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

logger = logging.getLogger(__name__)

REQUIRED_BODY = {
    "code": "onboarding_required",
    "message": "Complete onboarding first",
}

_EXACT_ALLOWED = frozenset(
    {
        "/",
        "/favicon.ico",
        "/health",
        "/login",
        "/auth",
        "/mobile",
        "/api/system/onboarding",
        "/api/system/config",
        "/api/config",
        "/api/ota",
        "/api/clients",
        "/static",
    }
)

_PREFIX_ALLOWED = (
    "/auth/",
    "/mobile/",
    "/static/",
    "/api/system/onboarding/",
    "/api/system/config/",
    "/api/config/",
    "/api/ota/",
    "/api/clients/",
)


def is_allowed_path(path: str) -> bool:
    """Return True when the onboarding gate must not block this HTTP path."""
    if path in _EXACT_ALLOWED:
        return True
    return any(path.startswith(prefix) for prefix in _PREFIX_ALLOWED)


def _explicit_completion(scope: Scope):
    app = scope.get("app")
    state = getattr(app, "state", None)
    override = getattr(state, "onboarding_state_completed", None)
    return override if isinstance(override, bool) else None


def _gate_closed(scope: Scope) -> bool:
    explicit = _explicit_completion(scope)
    if explicit is not None:
        return not explicit
    try:
        from services import onboarding_service

        return onboarding_service.gate_should_block()
    except Exception:  # noqa: BLE001 - 状态不可读时保持旧门禁的纯放行语义
        logger.warning("[OnboardingGate] 引导状态不可读，放行请求", exc_info=True)
        return False


class OnboardingGateMiddleware:
    """ASGI gate for HTTP and WebSocket scopes."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket") or not _gate_closed(scope):
            await self.app(scope, receive, send)
            return
        if is_allowed_path(scope.get("path", "")):
            await self.app(scope, receive, send)
            return
        if scope["type"] == "websocket":
            await send(
                {
                    "type": "websocket.close",
                    "code": 1013,
                    "reason": "onboarding_required",
                }
            )
            return
        response = JSONResponse(REQUIRED_BODY, status_code=503)
        await response(scope, receive, send)
