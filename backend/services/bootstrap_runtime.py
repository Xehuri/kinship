# -*- coding: utf-8 -*-
"""Bootstrap runtime: retryable lifecycle for the deferred service plane.

States: ``deferred -> attempted -> validated -> promoted -> committed``.
``active`` is the onboarding gate flag: True means the gate is closed
(bootstrap mode). ``commit`` is the only lifecycle transition that opens it.

Compatibility: ``activate`` keeps the historical finish contract (report shape
and gate release when the start callback raises), ``deactivate`` keeps the
shutdown contract, and ``mark_started`` keeps the full-mode contract.
"""
from __future__ import annotations

import asyncio
import copy
import inspect
import logging
import threading
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

logger = logging.getLogger(__name__)

_SERVICE_PLANE = "service_plane"
_VALIDATION = "validation"
_PROMOTION = "promotion"
_SUBSYSTEM_STATES = frozenset({"ok", "failed", "skipped", "deferred"})

STATE_DEFERRED = "deferred"
STATE_ATTEMPTED = "attempted"
STATE_VALIDATED = "validated"
STATE_PROMOTED = "promoted"
STATE_COMMITTED = "committed"

StartCallback = Callable[[], Awaitable[Mapping[str, Any] | None]]
StopCallback = Callable[[], Awaitable[None]]
ValidatorCallback = Callable[..., Any]
PromoteCallback = Callable[[], Awaitable[Mapping[str, Any] | None]]
Report = dict[str, Any]


def _normalise_subsystems(value: Any) -> dict[str, str]:
    if not isinstance(value, Mapping):
        return {}
    return {
        str(name): state if state in _SUBSYSTEM_STATES else "failed"
        for name, state in value.items()
    }


def _normalise_errors(value: Any, default_subsystem: str = _SERVICE_PLANE) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    result: list[dict[str, str]] = []
    for item in value:
        if isinstance(item, Mapping):
            result.append(
                {
                    "subsystem": str(item.get("subsystem") or default_subsystem),
                    "error": str(item.get("error") or ""),
                }
            )
        elif isinstance(item, str):
            result.append({"subsystem": default_subsystem, "error": item})
    return result


def _accepts_positional(fn: Callable[..., Any]) -> bool:
    try:
        signature = inspect.signature(fn)
    except (TypeError, ValueError):
        return True
    return any(
        parameter.kind
        in (
            inspect.Parameter.POSITIONAL_ONLY,
            inspect.Parameter.POSITIONAL_OR_KEYWORD,
            inspect.Parameter.VAR_POSITIONAL,
        )
        for parameter in signature.parameters.values()
    )


class BootstrapRuntime:
    """Owns the onboarding gate and drives the deferred service plane."""

    def __init__(
        self,
        active: bool,
        start: StartCallback | None = None,
        stop: StopCallback | None = None,
        validator: ValidatorCallback | None = None,
        promote: PromoteCallback | None = None,
        validate: ValidatorCallback | None = None,
    ) -> None:
        self._active = bool(active)
        self._default_active = bool(active)
        self._start = start
        self._stop = stop
        self._validator = validator if validator is not None else validate
        self._promote_callback = promote
        self._lock = threading.RLock()
        self._activation_lock = asyncio.Lock()
        self._state = STATE_DEFERRED
        self._started = False
        self._start_called = False
        self._attempt_ok: bool | None = None
        self._validated_ok: bool | None = None
        self._promoted_ok: bool | None = None
        self._promote_called = False
        self._attempt_report: Report | None = None
        self._validation_report: Report | None = None
        self._promotion_report: Report | None = None
        self._commit_report: Report | None = None
        self._activated_report: Report | None = None
        self._report: Report | None = None

    @property
    def active(self) -> bool:
        with self._lock:
            return self._active

    @property
    def started(self) -> bool:
        with self._lock:
            return self._started

    @property
    def state(self) -> str:
        with self._lock:
            return self._state

    @property
    def committed(self) -> bool:
        with self._lock:
            return self._state == STATE_COMMITTED

    def report(self) -> Report:
        with self._lock:
            if self._report is not None:
                return copy.deepcopy(self._report)
            return self._snapshot(reason="", ok=None, activated=self._started)

    # ------------------------------------------------------------------
    # Lifecycle transitions
    # ------------------------------------------------------------------

    async def attempt(self, reason: str = "manual") -> Report:
        async with self._activation_lock:
            return copy.deepcopy(await self._attempt(reason))

    async def validate(self) -> Report:
        async with self._activation_lock:
            return copy.deepcopy(await self._validate())

    async def promote(self, reason: str = "manual") -> Report:
        async with self._activation_lock:
            return copy.deepcopy(await self._promote(reason))

    async def commit(self, reason: str = "manual") -> Report:
        async with self._activation_lock:
            return copy.deepcopy(await self._commit(reason))

    async def abort(self, reason: str = "manual") -> Report:
        async with self._activation_lock:
            return copy.deepcopy(await self._abort(reason))

    async def _attempt(self, reason: str) -> Report:
        with self._lock:
            if self._start_called or self._state == STATE_COMMITTED:
                if self._attempt_report is not None:
                    cached = self._refresh_report(self._attempt_report)
                    cached["idempotent"] = True
                    return cached
                return self._snapshot(
                    reason=reason,
                    ok=True,
                    status="already_committed",
                    idempotent=True,
                    extra={"requested_reason": reason},
                )
            self._start_called = True
            self._started = True
            self._state = STATE_ATTEMPTED

        subsystems: dict[str, str] = {}
        errors: list[dict[str, str]] = []
        ok = True
        status = "ok"
        try:
            result = await self._start() if self._start is not None else None
        except Exception as exc:
            logger.exception("[Bootstrap] 服务面启动失败")
            ok = False
            status = "start_failed"
            errors.append({"subsystem": _SERVICE_PLANE, "error": str(exc)})
        else:
            if result is not None and not isinstance(result, Mapping):
                ok = False
                status = "invalid_report"
                errors.append(
                    {
                        "subsystem": _SERVICE_PLANE,
                        "error": "start callback returned a non-mapping report",
                    }
                )
            elif isinstance(result, Mapping):
                subsystems = _normalise_subsystems(result.get("subsystems"))
                errors = _normalise_errors(result.get("errors"))

        with self._lock:
            self._attempt_ok = ok
            report = self._snapshot(
                reason=reason,
                ok=ok,
                status=status,
                subsystems=subsystems,
                errors=errors,
                extra={"requested_reason": reason},
            )
            self._attempt_report = copy.deepcopy(report)
            self._report = copy.deepcopy(report)
        logger.info("[Bootstrap] 服务面启动 reason=%s ok=%s errors=%d", reason, ok, len(errors))
        return report

    async def _validate(self) -> Report:
        with self._lock:
            if not self._start_called or self._attempt_report is None:
                report = self._snapshot(
                    reason="not_attempted",
                    ok=False,
                    status="not_attempted",
                    extra={"validated": False},
                )
                self._report = copy.deepcopy(report)
                return report
            if self._state == STATE_COMMITTED and self._validation_report is not None:
                cached = self._refresh_report(self._validation_report)
                cached["idempotent"] = True
                return cached
            attempt_ok = bool(self._attempt_ok)
            attempt_errors = self._attempt_errors()

        validator_ok, validator_errors, validator_subsystems, detail = await self._run_validator()
        ok = attempt_ok and validator_ok
        errors = _merge_errors(attempt_errors, validator_errors)
        with self._lock:
            self._validated_ok = ok
            if ok:
                if self._state == STATE_ATTEMPTED:
                    self._state = STATE_VALIDATED
            elif self._state in (STATE_ATTEMPTED, STATE_VALIDATED):
                self._state = STATE_ATTEMPTED
            status = "ok" if ok else ("attempt_failed" if not attempt_ok else "invalid")
            report = self._snapshot(
                reason="validate",
                ok=ok,
                status=status,
                subsystems=validator_subsystems,
                errors=errors,
                extra={"validated": ok, "validation": detail},
            )
            self._validation_report = copy.deepcopy(report)
            self._report = copy.deepcopy(report)
        logger.info("[Bootstrap] 服务面校验 ok=%s state=%s", ok, self._state)
        return report

    async def _promote(self, reason: str) -> Report:
        with self._lock:
            if not self._start_called or self._attempt_report is None:
                report = self._snapshot(
                    reason="not_attempted",
                    ok=False,
                    status="not_attempted",
                    extra={"promoted": False},
                )
                self._report = copy.deepcopy(report)
                return report
            if self._state == STATE_COMMITTED:
                if self._promotion_report is not None:
                    cached = self._refresh_report(self._promotion_report)
                    cached["idempotent"] = True
                    return cached
                return self._snapshot(
                    reason=reason,
                    ok=True,
                    status="already_committed",
                    idempotent=True,
                    extra={"promoted": True},
                )
            first_call = not self._promote_called
            self._promote_called = True

        promotion_ok = True
        promotion_errors: list[dict[str, str]] = []
        promotion_subsystems: dict[str, str] = {}
        if first_call and self._promote_callback is not None:
            try:
                result = await self._promote_callback()
            except Exception as exc:
                logger.exception("[Bootstrap] 延迟集成启动失败")
                promotion_ok = False
                promotion_errors.append({"subsystem": _PROMOTION, "error": str(exc)})
            else:
                if isinstance(result, Mapping):
                    promotion_subsystems = _normalise_subsystems(result.get("subsystems"))
                    promotion_errors = _normalise_errors(result.get("errors"), _PROMOTION)
                    promotion_ok = not promotion_errors
                elif result is not None:
                    promotion_ok = False
                    promotion_errors.append(
                        {"subsystem": _PROMOTION, "error": "promote callback returned a non-mapping report"}
                    )

        validation = await self._validate()
        ok = bool(validation.get("ok")) and promotion_ok
        errors = _merge_errors(validation.get("errors"), promotion_errors)
        with self._lock:
            self._promoted_ok = ok
            if ok:
                self._state = STATE_PROMOTED
            elif self._validated_ok:
                self._state = STATE_VALIDATED
            else:
                self._state = STATE_ATTEMPTED
            report = self._snapshot(
                reason=reason,
                ok=ok,
                status="promoted" if ok else "promotion_failed",
                subsystems=dict(validation.get("subsystems") or {}, **promotion_subsystems),
                errors=errors,
                extra={"promoted": ok},
            )
            self._promotion_report = copy.deepcopy(report)
            self._report = copy.deepcopy(report)
        logger.info("[Bootstrap] 服务面提升 reason=%s ok=%s", reason, ok)
        return report

    async def _commit(self, reason: str) -> Report:
        with self._lock:
            if self._state == STATE_COMMITTED:
                if self._commit_report is not None:
                    cached = self._refresh_report(self._commit_report)
                    cached["idempotent"] = True
                    return cached
                report = self._snapshot(
                    reason=reason,
                    ok=True,
                    activated=True,
                    status="already_committed",
                    idempotent=True,
                )
                self._commit_report = copy.deepcopy(report)
                self._report = copy.deepcopy(report)
                return report
            if not self._start_called or self._attempt_report is None:
                report = self._snapshot(reason="not_attempted", ok=False, status="not_attempted")
                self._report = copy.deepcopy(report)
                return report
            if self._attempt_ok is not True:
                report = self._snapshot(
                    reason=reason,
                    ok=False,
                    status="attempt_failed",
                    errors=self._attempt_errors(),
                )
                self._report = copy.deepcopy(report)
                return report
            if self._validator is not None and self._validated_ok is not True:
                report = self._snapshot(reason=reason, ok=False, status="not_validated")
                self._report = copy.deepcopy(report)
                return report
            if self._promote_callback is not None and self._promoted_ok is not True:
                report = self._snapshot(reason=reason, ok=False, status="not_promoted")
                self._report = copy.deepcopy(report)
                return report

            errors = _merge_errors(
                self._attempt_errors(),
                self._validation_report,
                self._promotion_report,
            )
            subsystems = dict(self._attempt_report.get("subsystems") or {})
            subsystems.update((self._validation_report or {}).get("subsystems") or {})
            subsystems.update((self._promotion_report or {}).get("subsystems") or {})
            self._active = False
            self._state = STATE_COMMITTED
            if self._validated_ok is None:
                self._validated_ok = True
            if self._promoted_ok is None:
                self._promoted_ok = True
            report = self._snapshot(
                reason=reason,
                ok=True,
                activated=True,
                status="committed",
                subsystems=subsystems,
                errors=errors,
                extra={"requested_reason": reason},
            )
            self._commit_report = copy.deepcopy(report)
            self._activated_report = copy.deepcopy(report)
            self._report = copy.deepcopy(report)
        logger.info("[Bootstrap] 门禁已开启 reason=%s", reason)
        return report

    async def _abort(self, reason: str) -> Report:
        with self._lock:
            had_activity = self._start_called or self._state != STATE_DEFERRED
            stop = self._stop if self._started else None
            self._started = False

        stop_error: str | None = None
        if stop is not None:
            try:
                await stop()
            except Exception as exc:
                logger.exception("[Bootstrap] 服务面停止失败")
                stop_error = str(exc)

        with self._lock:
            self._start_called = False
            self._started = False
            self._state = STATE_DEFERRED
            self._attempt_ok = None
            self._validated_ok = None
            self._promoted_ok = None
            self._promote_called = False
            self._attempt_report = None
            self._validation_report = None
            self._promotion_report = None
            self._commit_report = None
            self._activated_report = None
            self._active = self._default_active
            errors = (
                [{"subsystem": _SERVICE_PLANE, "error": stop_error}]
                if stop_error is not None
                else []
            )
            report = self._snapshot(
                reason=reason,
                ok=not errors,
                status="aborted" if had_activity else "noop",
                idempotent=not had_activity,
                errors=errors,
            )
            self._report = copy.deepcopy(report)
        logger.info("[Bootstrap] 生命周期回退 reason=%s state=%s", reason, self._state)
        return report

    # ------------------------------------------------------------------
    # Compatibility surface
    # ------------------------------------------------------------------

    async def activate(self, reason: str = "manual") -> Report:
        """Legacy finish wrapper: attempt + validate + promote + commit.

        A start exception keeps the historical finish contract: the gate is
        released and ``activated`` stays True so onboarding cannot deadlock.
        Direct lifecycle callers should use ``commit`` for strict gate safety.
        """
        async with self._activation_lock:
            with self._lock:
                if self._state == STATE_COMMITTED:
                    if self._commit_report is not None:
                        cached = self._refresh_report(self._commit_report)
                        cached["idempotent"] = True
                        return cached
                    return copy.deepcopy(self._legacy_already_active(reason))
                if self._activated_report is not None:
                    cached = self._refresh_report(self._activated_report)
                    cached["idempotent"] = True
                    return cached
                if not self._active:
                    return copy.deepcopy(self._legacy_already_active(reason))

            attempt = await self._attempt(reason)
            if not attempt.get("ok"):
                return copy.deepcopy(await self._legacy_finish_release(reason, attempt))

            validation = await self._validate()
            if not validation.get("ok"):
                return copy.deepcopy(self._remember_failure(reason, validation))

            promotion = await self._promote(reason)
            if not promotion.get("ok"):
                return copy.deepcopy(self._remember_failure(reason, promotion))
            return copy.deepcopy(await self._commit(reason))

    async def deactivate(self) -> None:
        """Shutdown contract: always open the gate, stop a started plane once."""
        async with self._activation_lock:
            with self._lock:
                self._active = False
                stop = self._stop if self._started else None
                self._started = False
            if stop is None:
                return
            try:
                await stop()
            except Exception:
                logger.exception("[Bootstrap] 服务面停止失败")

    def mark_started(self) -> None:
        """Record a service plane started by the lifespan itself (full mode)."""
        with self._lock:
            self._started = True
            self._start_called = True
            self._attempt_ok = True
            self._active = False
            self._state = STATE_COMMITTED

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _attempt_errors(self) -> list[dict[str, str]]:
        if self._attempt_report is None:
            return []
        return _copy_errors(self._attempt_report.get("errors"))

    async def _run_validator(
        self,
    ) -> tuple[bool, list[dict[str, str]], dict[str, str], Any]:
        if self._validator is None:
            return True, [], {}, None
        try:
            if _accepts_positional(self._validator):
                result = self._validator(copy.deepcopy(self._attempt_report or {}))
            else:
                result = self._validator()
            if inspect.isawaitable(result):
                result = await result
        except Exception as exc:
            logger.exception("[Bootstrap] 服务面校验异常")
            return False, [{"subsystem": _VALIDATION, "error": str(exc)}], {}, None
        if result is None:
            return True, [], {}, None
        if isinstance(result, bool):
            errors = [] if result else [{"subsystem": _VALIDATION, "error": "validator returned false"}]
            return result, errors, {}, result
        if isinstance(result, Mapping):
            errors = _normalise_errors(result.get("errors"), _VALIDATION)
            ok_value = result.get("ok")
            ok = (not errors) if ok_value is None else bool(ok_value)
            if not ok and not errors:
                errors = [
                    {
                        "subsystem": _VALIDATION,
                        "error": str(result.get("reason") or "validation failed"),
                    }
                ]
            return ok, errors, _normalise_subsystems(result.get("subsystems")), dict(result)
        return (
            False,
            [
                {
                    "subsystem": _VALIDATION,
                    "error": f"validator returned unsupported type {type(result).__name__}",
                }
            ],
            {},
            result,
        )

    def _legacy_already_active(self, reason: str) -> Report:
        with self._lock:
            report: Report = {
                "activated": False,
                "active": False,
                "reason": "already_active",
                "requested_reason": reason,
                "subsystems": {},
                "errors": [],
                "idempotent": False,
                "ok": True,
                "state": self._state,
                "gate_open": True,
                "committed": self._state == STATE_COMMITTED,
                "validated": self._validated_ok is True,
                "promoted": self._state in (STATE_PROMOTED, STATE_COMMITTED),
                "started": self._started,
                "status": "already_active",
            }
            self._report = copy.deepcopy(report)
            self._activated_report = copy.deepcopy(report)
            return report

    async def _legacy_finish_release(self, reason: str, attempt: Report) -> Report:
        with self._lock:
            self._active = False
            report: Report = {
                "activated": True,
                "active": False,
                "reason": reason,
                "requested_reason": reason,
                "subsystems": copy.deepcopy(attempt.get("subsystems") or {}),
                "errors": _copy_errors(attempt.get("errors")),
                "idempotent": False,
                "ok": False,
                "state": self._state,
                "gate_open": True,
                "committed": False,
                "validated": False,
                "promoted": False,
                "started": self._started,
                "status": "start_failed",
                "legacy_finish_release": True,
            }
            self._report = copy.deepcopy(report)
            self._activated_report = copy.deepcopy(report)
            return report

    def _remember_failure(self, reason: str, failed: Report) -> Report:
        with self._lock:
            report = self._snapshot(
                reason=reason,
                ok=False,
                status=failed.get("status") or "activate_failed",
                subsystems=failed.get("subsystems") or {},
                errors=_copy_errors(failed.get("errors")),
                extra={"requested_reason": reason},
            )
            self._report = copy.deepcopy(report)
            return report

    def _refresh_report(self, report: Report) -> Report:
        refreshed = copy.deepcopy(report)
        refreshed["active"] = self._active
        refreshed["state"] = self._state
        refreshed["gate_open"] = not self._active
        refreshed["committed"] = self._state == STATE_COMMITTED
        refreshed["validated"] = self._validated_ok is True
        refreshed["promoted"] = self._state in (STATE_PROMOTED, STATE_COMMITTED)
        refreshed["started"] = self._started
        return refreshed

    def _snapshot(
        self,
        *,
        reason: str,
        ok: bool | None,
        activated: bool = False,
        idempotent: bool = False,
        status: str = "",
        subsystems: Mapping[str, Any] | None = None,
        errors: list[dict[str, str]] | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> Report:
        report: Report = {
            "activated": bool(activated),
            "active": self._active,
            "reason": reason,
            "subsystems": copy.deepcopy(dict(subsystems or {})),
            "errors": copy.deepcopy(list(errors or [])),
            "idempotent": bool(idempotent),
            "ok": ok,
            "state": self._state,
            "gate_open": not self._active,
            "committed": self._state == STATE_COMMITTED,
            "validated": self._validated_ok is True,
            "promoted": self._state in (STATE_PROMOTED, STATE_COMMITTED),
            "started": self._started,
        }
        if status:
            report["status"] = status
        if extra:
            report.update(copy.deepcopy(dict(extra)))
        return report


def _copy_errors(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    return copy.deepcopy(value)


def _report_errors(report: Report | None) -> list[dict[str, str]]:
    return _copy_errors(report.get("errors")) if report is not None else []


def _merge_errors(*groups: Any) -> list[dict[str, str]]:
    seen: set[tuple[str, str]] = set()
    merged: list[dict[str, str]] = []
    for group in groups:
        entries = _copy_errors(group if isinstance(group, list) else _report_errors(group))
        for entry in entries:
            key = (entry["subsystem"], entry["error"])
            if key in seen:
                continue
            seen.add(key)
            merged.append(entry)
    return merged
