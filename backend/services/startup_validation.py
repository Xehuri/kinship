# -*- coding: utf-8 -*-
"""Onboarding startup validation (Wave 2 T11).

Validation mode starts only the safe, in-process service subset. This module
turns the live services and conditional integrations into one stable report.
All probes are read-only: they never record onboarding progress, write config,
or open the onboarding gate. ``BootstrapRuntime.commit()`` remains the only
gate-opening transition.
"""
from __future__ import annotations

import asyncio
import copy
import inspect
import logging
import os
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from config.paths import data_root, models_root
from core.redaction import redact_text
from services import onboarding_service

logger = logging.getLogger(__name__)

MODE_VALIDATION = "validation"
REQUIRED_PROBES = (
    "config_store",
    "config_appliers",
    "config_watcher",
    "scheduler",
    "script_runner",
    "audio_ingest",
    "data_root",
    "models_root",
)
CONDITIONAL_PROBES = ("kernel", "loom")
DEFERRED_SUBSYSTEMS = ("health_cloud", "qq_gateway", "p2p")
_MAX_ERROR_CHARS = 300


@dataclass(frozen=True)
class ProbeResult:
    """Outcome of one read-only startup probe."""

    ok: bool
    detail: str = ""
    warnings: tuple[str, ...] = ()


def _safe(text: Any) -> str:
    return redact_text(str(text or ""))[:_MAX_ERROR_CHARS]


def _as_result(value: Any) -> ProbeResult:
    if isinstance(value, ProbeResult):
        return value
    if value is None:
        return ProbeResult(True)
    if isinstance(value, bool):
        return ProbeResult(value, "" if value else "probe returned false")
    if isinstance(value, str):
        return ProbeResult(True, value)
    if isinstance(value, Mapping):
        detail = str(value.get("detail") or value.get("message") or "")
        warnings = tuple(str(item) for item in value.get("warnings") or ())
        ok_value = value.get("ok")
        if ok_value is None:
            ok = bool(value.get("reachable") or value.get("online"))
        else:
            ok = bool(ok_value)
        return ProbeResult(ok, detail, warnings)
    raise TypeError(f"unsupported probe result: {type(value).__name__}")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _writable_error(path: Path) -> str | None:
    """Return an error when ``path`` is not writable; never creates anything."""

    candidate = path
    while not candidate.exists():
        parent = candidate.parent
        if parent == candidate:
            return f"{path} has no existing parent"
        candidate = parent
    if not candidate.is_dir():
        return f"{candidate} is not a directory"
    if not os.access(candidate, os.W_OK):
        return f"{candidate} is not writable"
    return None


def _probe_config_store() -> ProbeResult:
    from config.store import get_config_store

    store = get_config_store()
    snapshot = store.snapshot()
    if not isinstance(snapshot, Mapping) or not snapshot:
        raise RuntimeError("config store snapshot is empty")
    degraded = list(store.degraded)
    warning = ("config degraded: " + ", ".join(degraded),) if degraded else ()
    return ProbeResult(True, f"revision={store.revision}", warning)


def _probe_config_appliers() -> ProbeResult:
    from config.store import get_config_store

    names = get_config_store().applier_names
    if not names:
        raise RuntimeError("config appliers are not registered")
    return ProbeResult(True, "appliers=" + ",".join(names))


def _probe_config_watcher() -> ProbeResult:
    from config.store import get_config_store

    if not get_config_store().watcher_running:
        raise RuntimeError("config watcher is not running")
    return ProbeResult(True, "watcher running")


def _probe_script_runner() -> ProbeResult:
    from services.script_runner import get_script_runner

    runner = get_script_runner()
    if runner is None:
        raise RuntimeError("script runner is not initialized")
    if not runner.is_running():
        raise RuntimeError("script runner is not running")
    return ProbeResult(True, "runner running")


def _probe_audio_ingest() -> ProbeResult:
    from services.audio_ingest_registry import peek_audio_ingest_registry

    registry = peek_audio_ingest_registry()
    if registry is None:
        raise RuntimeError("audio ingest registry is not initialized")
    if not registry.sweeper_running:
        raise RuntimeError("audio ingest sweeper is not running")
    return ProbeResult(True, "registry and sweeper running")


def _probe_data_root() -> ProbeResult:
    path = data_root()
    error = _writable_error(path)
    if error is not None:
        raise RuntimeError(error)
    return ProbeResult(True, str(path))


def _probe_models_root() -> ProbeResult:
    path = models_root()
    error = _writable_error(path)
    if error is not None:
        raise RuntimeError(error)
    return ProbeResult(True, str(path))


def _probe_kernel() -> ProbeResult:
    from services import kernel_assets

    info = kernel_assets.inspect()
    kernel = info.get("kernel") or {}
    python = info.get("python") or {}
    if not kernel.get("present") or kernel.get("source") not in {"source", "release"}:
        raise RuntimeError("kernel assets are not installed")
    if not python.get("exists"):
        raise RuntimeError("kernel interpreter is unavailable")
    health = info.get("health") or {}
    if health.get("alive") and health.get("healthy"):
        return ProbeResult(True, f"kernel running pid={health.get('pid')}")
    if health.get("alive"):
        raise RuntimeError(f"kernel pid={health.get('pid')} is alive but unhealthy")
    return ProbeResult(
        True,
        "kernel installed (not running; lazy start)",
        ("kernel is not running; it starts on demand",),
    )


async def _probe_loom() -> ProbeResult:
    from services import loom_onboarding

    info = await loom_onboarding.inspect(timeout=2.0)
    if not info.get("found"):
        raise RuntimeError("Loom token not found")
    if not info.get("online"):
        codes = sorted(
            str(item.get("code"))
            for item in info.get("errors") or ()
            if isinstance(item, Mapping) and item.get("code")
        )
        suffix = f" ({','.join(codes)})" if codes else ""
        raise RuntimeError(f"Loom is not online{suffix}")
    return ProbeResult(True, "Loom online")


def _default_config() -> Any:
    from config.config import get_config

    return get_config()


def _string_set(value: Any) -> set[str]:
    if not isinstance(value, (list, tuple, set, frozenset)):
        return set()
    return {str(item) for item in value if isinstance(item, str)}


def _copy_errors(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    return [
        {"subsystem": str(item.get("subsystem") or ""), "error": _safe(item.get("error"))}
        for item in value
        if isinstance(item, Mapping)
    ]


class StartupValidation:
    """Run the startup probes and remember the last report."""

    def __init__(
        self,
        probes: Mapping[str, Callable[[], Any]] | None = None,
        *,
        state_reader: Callable[[], Mapping[str, Any]] | None = None,
        config_reader: Callable[[], Any] | None = None,
    ) -> None:
        self._state_reader = state_reader or onboarding_service.read_state_snapshot
        self._config_reader = config_reader or _default_config
        merged = self._default_probes()
        if probes:
            merged.update(dict(probes))
        self._probes = merged
        self._lock = threading.RLock()
        self._last_report: dict[str, Any] | None = None
        self._promoted = False

    def _default_probes(self) -> dict[str, Callable[[], Any]]:
        return {
            "config_store": _probe_config_store,
            "config_appliers": _probe_config_appliers,
            "config_watcher": _probe_config_watcher,
            "scheduler": self._probe_scheduler,
            "script_runner": _probe_script_runner,
            "audio_ingest": _probe_audio_ingest,
            "data_root": _probe_data_root,
            "models_root": _probe_models_root,
            "kernel": _probe_kernel,
            "loom": _probe_loom,
        }

    def _probe_scheduler(self) -> ProbeResult:
        from services.task_scheduler import get_task_scheduler

        scheduler = get_task_scheduler()
        if not scheduler.is_running():
            raise RuntimeError("scheduler is not running")
        if not scheduler.paused and not self._promoted:
            raise RuntimeError("scheduler is not paused in validation mode")
        return ProbeResult(
            True, "running and paused" if scheduler.paused else "running"
        )

    async def validate(
        self, attempt_report: Mapping[str, Any] | None = None
    ) -> dict[str, Any]:
        subsystems: dict[str, str] = {}
        checks: list[dict[str, Any]] = []
        errors: list[dict[str, str]] = []
        warnings: list[dict[str, str]] = []
        if isinstance(attempt_report, Mapping) and attempt_report.get("ok") is False:
            errors.extend(_copy_errors(attempt_report.get("errors")))
        state = self._read_state()
        for name in REQUIRED_PROBES:
            await self._run(name, "required", subsystems, checks, errors, warnings)
        conditions = {
            "kernel": self._kernel_required(state),
            "loom": self._loom_required(state),
        }
        for name in CONDITIONAL_PROBES:
            if conditions[name]:
                await self._run(
                    name, "conditional", subsystems, checks, errors, warnings
                )
            else:
                subsystems[name] = "skipped"
                checks.append(
                    self._check(name, "skipped", "conditional", "prerequisite not met")
                )
        for name in DEFERRED_SUBSYSTEMS:
            subsystems[name] = "deferred"
            checks.append(
                self._check(
                    name, "deferred", "deferred", "not started in validation mode"
                )
            )
        report = self._build(
            ok=not errors,
            state="validated" if not errors else "failed",
            subsystems=subsystems,
            checks=checks,
            errors=errors,
            warnings=warnings,
        )
        with self._lock:
            self._last_report = copy.deepcopy(report)
        logger.info(
            "[StartupValidation] ok=%s checks=%d errors=%d",
            report["ok"],
            len(checks),
            len(errors),
        )
        return report

    async def _run(
        self,
        name: str,
        kind: str,
        subsystems: dict[str, str],
        checks: list[dict[str, Any]],
        errors: list[dict[str, str]],
        warnings: list[dict[str, str]],
    ) -> None:
        probe = self._probes.get(name)
        if probe is None:
            error = f"probe {name!r} is not configured"
            subsystems[name] = "failed"
            errors.append({"subsystem": name, "error": error})
            checks.append(self._check(name, "failed", kind, error))
            return
        try:
            if inspect.iscoroutinefunction(probe):
                value = await probe()
            else:
                value = await asyncio.to_thread(probe)
            if inspect.isawaitable(value):
                value = await value
            result = _as_result(value)
        except Exception as exc:
            error = _safe(exc)
            subsystems[name] = "failed"
            errors.append({"subsystem": name, "error": error})
            checks.append(self._check(name, "failed", kind, error))
            return
        status = "ok" if result.ok else "failed"
        subsystems[name] = status
        detail = _safe(result.detail)
        if not result.ok:
            errors.append({"subsystem": name, "error": detail or "probe failed"})
        for warning in result.warnings:
            warnings.append({"subsystem": name, "warning": _safe(warning)})
        checks.append(self._check(name, status, kind, detail))

    @staticmethod
    def _check(name: str, status: str, kind: str, detail: str) -> dict[str, Any]:
        return {
            "id": name,
            "status": status,
            "kind": kind,
            "required": kind == "required",
            "detail": _safe(detail),
        }

    def _read_state(self) -> dict[str, Any]:
        try:
            state = self._state_reader()
            return dict(state) if isinstance(state, Mapping) else {}
        except Exception as exc:
            logger.warning("[StartupValidation] 引导状态读取失败: %s", _safe(exc))
            return {}

    def _kernel_required(self, state: Mapping[str, Any]) -> bool:
        completed = _string_set(state.get("completed_steps"))
        skipped = _string_set(state.get("skipped_steps"))
        return "kernel" in completed and "kernel" not in skipped

    def _loom_required(self, state: Mapping[str, Any]) -> bool:
        if "loom" in _string_set(state.get("completed_steps")):
            return True
        try:
            backend = str(getattr(self._config_reader(), "AI_BACKEND", "") or "")
        except Exception:
            backend = ""
        return backend.strip().lower() == "loom"

    def _build(
        self,
        *,
        ok: bool | None,
        state: str,
        subsystems: Mapping[str, str],
        checks: list[dict[str, Any]],
        errors: list[dict[str, str]],
        warnings: list[dict[str, str]],
    ) -> dict[str, Any]:
        return {
            "ok": ok,
            "state": state,
            "mode": MODE_VALIDATION,
            "subsystems": dict(subsystems),
            "checks": list(checks),
            "errors": list(errors),
            "warnings": list(warnings),
            "deferred": list(DEFERRED_SUBSYSTEMS),
            "generated_at": _now(),
        }

    @staticmethod
    def empty_report() -> dict[str, Any]:
        return {
            "ok": None,
            "state": "deferred",
            "mode": MODE_VALIDATION,
            "subsystems": {},
            "checks": [],
            "errors": [],
            "warnings": [],
            "deferred": list(DEFERRED_SUBSYSTEMS),
            "generated_at": None,
        }

    def report(self) -> dict[str, Any]:
        with self._lock:
            if self._last_report is not None:
                return copy.deepcopy(self._last_report)
        return self.empty_report()

    def record_attempt(self, report: Mapping[str, Any]) -> dict[str, Any]:
        failed = report.get("ok") is False
        with self._lock:
            base = self.empty_report()
            base["subsystems"] = dict(report.get("subsystems") or {})
            base["errors"] = _copy_errors(report.get("errors")) if failed else []
            base["ok"] = False if failed else None
            base["state"] = "failed" if failed else "attempted"
            base["generated_at"] = _now()
            self._promoted = False
            self._last_report = base
            return copy.deepcopy(base)

    def record_abort(self) -> dict[str, Any]:
        with self._lock:
            self._promoted = False
            if self._last_report is None:
                return self.empty_report()
            base = copy.deepcopy(self._last_report)
            base["ok"] = None
            base["state"] = "aborted"
            base["generated_at"] = _now()
            self._last_report = base
            return copy.deepcopy(base)

    def mark_promoted(self) -> None:
        with self._lock:
            self._promoted = True
