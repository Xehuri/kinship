# -*- coding: utf-8 -*-
"""N11 配置热应用器：把 ConfigStore 变更分发到各运行中子系统。

设计约束：
- 注册顺序即依赖顺序：AI -> 音频/归档 -> 数据路径 -> 外部集成 -> 内核 ->
  监听/TLS。单个应用器抛出的异常由 ``ConfigStore.apply`` 如实记入 failed，
  绝不在此静默吞掉。
- 所有服务模块均在应用器函数内部懒加载，模块导入本身保持纯净（B5 启动
  链零重依赖）。
- 应用器幂等：同一变更重复应用只做等价重建/重绑，不叠出第二条后台线程。
"""
from __future__ import annotations

import asyncio
import inspect
import logging
import os
from collections.abc import Awaitable, Callable, Iterable, Mapping
from functools import partial
from pathlib import Path
from typing import Any

from config.config_schema import resolve_apply_strategy
from config.paths import project_root
from config.store import (
    ApplyReport,
    ConfigChange,
    ConfigStore,
    ConfigValidationError,
)
from core.redaction import redact_text

logger = logging.getLogger(__name__)

CorsRefresh = Callable[[], Any]
RegistrySink = Callable[[str, Any], None]
StrategyHook = Callable[[tuple[str, ...]], Awaitable[dict[str, Any]]]


def _touched(change: ConfigChange, *prefixes: str) -> bool:
    """变更路径是否命中任一精确路径或点分前缀。"""
    for path in change.changed_paths:
        for prefix in prefixes:
            base = prefix.rstrip(".")
            if path == base or path.startswith(f"{base}."):
                return True
    return False


def _restart_failure(label: str, result: Mapping[str, Any]) -> RuntimeError:
    errors = result.get("errors")
    detail = "、".join(str(item) for item in errors) if errors else str(result)
    return RuntimeError(redact_text(f"{label} 重启失败: {detail}"))


def _strategy_failure_text(exc: BaseException) -> str:
    detail = str(exc).strip()
    text = f"{type(exc).__name__}: {detail}" if detail else type(exc).__name__
    return redact_text(text)


# ── apply_strategy 执行分派 ────────────────────────────────


def _respawn_kernel_sync() -> dict[str, Any]:
    from services import kernel_client

    client = kernel_client.get_kernel_client()
    if getattr(client, "adopted", False):
        raise RuntimeError("当前内核为只读 adopt，拒绝重启")
    stop = kernel_client.stop_kernel_process()
    kernel_client.reset_kernel_client()
    fresh = kernel_client.get_kernel_client()
    fresh.ensure()
    return {"stop": stop, "base_url": fresh.base_url}


async def _respawn_kernel(paths: tuple[str, ...]) -> dict[str, Any]:
    return await asyncio.to_thread(_respawn_kernel_sync)


async def _respawn_watcher(paths: tuple[str, ...]) -> dict[str, Any]:
    from services.orchestrator.runtime import get_orchestrator

    service_id = "moss_watcher"
    orchestrator = get_orchestrator()
    if not orchestrator.enabled:
        raise RuntimeError("编排器未启用，无法重启 moss_watcher")
    stop = await orchestrator.stop(service_id)
    start = await orchestrator.start(service_id)
    state = str(start.get("state") or "")
    if state not in ("ready", "starting"):
        raise RuntimeError(
            f"{service_id} 重启后状态={state or 'unknown'}"
            f" reason={start.get('reason') or start.get('detail') or '-'}"
        )
    return {"stop": stop, "start": start}


async def _reconnect_qq_gateway(paths: tuple[str, ...]) -> dict[str, Any]:
    from services.qq_gateway.service import restart_qq_gateway

    result = await restart_qq_gateway()
    if not result.get("ok"):
        raise _restart_failure("QQ 网关", result)
    return result


async def _reconnect_p2p(paths: tuple[str, ...]) -> dict[str, Any]:
    from services.p2p.manager import restart_p2p_manager

    result = await restart_p2p_manager()
    if not result.get("ok"):
        raise _restart_failure("P2P 管理器", result)
    return result


async def _reconnect_moss(paths: tuple[str, ...]) -> dict[str, Any]:
    from services import moss_client

    return await moss_client.validate(timeout=1.5)


_RESPAWN_HOOKS: dict[str, StrategyHook] = {
    "kernel": _respawn_kernel,
    "moss": _respawn_watcher,
    "moss_watcher": _respawn_watcher,
    "qq_gateway": _reconnect_qq_gateway,
    "p2p": _reconnect_p2p,
}
_RECONNECT_HOOKS: dict[str, StrategyHook] = {
    "qq_gateway": _reconnect_qq_gateway,
    "p2p": _reconnect_p2p,
    "moss": _reconnect_moss,
}


async def _handle_hot(
    target: str, paths: tuple[str, ...]
) -> None:
    return None


async def _handle_respawn(
    target: str, paths: tuple[str, ...]
) -> dict[str, Any]:
    hook = _RESPAWN_HOOKS.get(target)
    if hook is None:
        raise RuntimeError(f"{target} 没有注册 respawn 重启钩子")
    return await hook(paths)


async def _handle_reconnect(
    target: str, paths: tuple[str, ...]
) -> dict[str, Any]:
    hook = _RECONNECT_HOOKS.get(target)
    if hook is None:
        raise RuntimeError(f"{target} 没有注册 reconnect 重连钩子")
    return await hook(paths)


def _deployment_entries(paths: tuple[str, ...]) -> tuple[dict[str, Any], ...]:
    return tuple(
        {
            "path": path,
            "strategy": "deployment",
            "requires_restart": True,
            "reason": (
                f"{path} 属于部署接线配置，apply 不执行；"
                "需重启后端或重建客户端后生效"
            ),
        }
        for path in paths
    )


async def _handle_deployment(
    target: str, paths: tuple[str, ...]
) -> tuple[dict[str, Any], ...]:
    return _deployment_entries(paths)


STRATEGY_HANDLERS: dict[str, Callable[..., Any]] = {
    "hot": _handle_hot,
    "respawn": _handle_respawn,
    "reconnect": _handle_reconnect,
    "deployment": _handle_deployment,
}
_STRATEGY_ORDER = {"reconnect": 0, "respawn": 1, "deployment": 2}


async def dispatch_apply_strategy(change: ConfigChange) -> ApplyReport:
    """按 apply_strategy 执行 respawn/reconnect，并登记 deployment 需重启项。"""
    groups: dict[tuple[str, str], list[str]] = {}
    for path in change.changed_paths:
        strategy = resolve_apply_strategy(path)
        if strategy in (None, "none", "hot"):
            continue
        target = path.split(".", 1)[0]
        groups.setdefault((strategy, target), []).append(path)

    applied: list[str] = []
    failed: dict[str, str] = {}
    deferred: list[dict[str, Any]] = []
    ordered = sorted(
        groups.items(),
        key=lambda item: (
            _STRATEGY_ORDER.get(item[0][0], 99),
            item[0][1],
        ),
    )
    for (strategy, target), paths in ordered:
        label = f"{strategy}:{target}"
        handler = STRATEGY_HANDLERS.get(strategy)
        if handler is None:
            failed[label] = f"未知 apply_strategy: {strategy}"
            continue
        try:
            result = handler(target, tuple(paths))
            if inspect.isawaitable(result):
                result = await result
        except Exception as exc:
            failed[label] = _strategy_failure_text(exc)
            continue
        if strategy == "deployment":
            deferred.extend(result or ())
        else:
            applied.append(label)

    return ApplyReport(
        applied=tuple(applied),
        failed=failed,
        deferred_restart=tuple(deferred),
    )


# ── 应用事务：按策略分组、部分失败可重试、只提交成功子集 ─────

_GROUP_ORDER: tuple[str, ...] = (
    "hot",
    "reconnect",
    "respawn",
    "deployment",
)
_INTERPRETER_PATHS: frozenset[str] = frozenset(
    {"kernel.python", "moss.python"}
)


def _interpreter_error(path: str, value: Any) -> str | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    candidate = Path(raw).expanduser()
    if not candidate.is_absolute():
        candidate = project_root() / candidate
    if not candidate.is_file():
        return redact_text(f"{path} 指向的解释器不存在: {raw}")
    if os.name != "nt" and not os.access(candidate, os.X_OK):
        return redact_text(f"{path} 指向的解释器不可执行: {raw}")
    return None


def _respawn_preflight(
    store: ConfigStore, paths: Iterable[str]
) -> dict[str, str]:
    """respawn 执行前校验解释器路径（内核解析链会静默回退，事务必须显式失败）。"""
    problems: dict[str, str] = {}
    for path in paths:
        if path not in _INTERPRETER_PATHS:
            continue
        error = _interpreter_error(path, store.get(path, ""))
        if error is not None:
            problems[path] = error
    return problems


async def _run_strategy_group(
    store: ConfigStore,
    strategy: str,
    paths: list[str],
    failures: dict[str, str],
) -> list[str]:
    runnable = list(paths)
    if strategy == "respawn":
        for path, error in _respawn_preflight(store, runnable).items():
            failures[path] = error
            runnable.remove(path)
    if not runnable:
        return []

    try:
        report = dispatch_apply_strategy(
            ConfigChange(old={}, new={}, changed_paths=tuple(runnable))
        )
        if inspect.isawaitable(report):
            report = await report
    except Exception as exc:
        error = _strategy_failure_text(exc)
        for path in runnable:
            failures[path] = error
        return []

    target_errors = {
        label.split(":", 1)[1]: text
        for label, text in report.failed.items()
        if ":" in label
    }
    applied: list[str] = []
    for path in runnable:
        error = target_errors.get(path.split(".", 1)[0])
        if error is None:
            applied.append(path)
        else:
            failures[path] = error
    return applied


async def apply_staged(
    store: ConfigStore | None = None,
    paths: Iterable[str] | None = None,
) -> dict[str, Any]:
    """按策略顺序执行草稿并只提交成功路径。

    组顺序固定为 ``hot -> reconnect -> respawn -> deployment``；单组失败
    不阻止后续组。执行期把本次选中的草稿子集发布为内存预览快照（不写盘），
    让 respawn/reconnect 钩子读到新值，结束后立即恢复已提交快照。落盘唯一
    通道是 ``commit(paths=applied_paths)``：失败键留在草稿可重试，坏值不会
    进入 config.yaml。返回
    ``{applied, failed, deferred_restart, partial}``。
    """
    if store is None:
        from config.store import get_config_store

        store = get_config_store()

    pending = store.pending()
    if paths is None:
        selected = list(pending)
    else:
        seen: set[str] = set()
        selected = []
        for raw_path in paths:
            path = str(raw_path)
            if path in pending and path not in seen:
                seen.add(path)
                selected.append(path)

    groups: dict[str, list[str]] = {name: [] for name in _GROUP_ORDER}
    inert: list[str] = []
    failures: dict[str, str] = {}
    for path in selected:
        strategy = resolve_apply_strategy(path)
        if strategy == "none":
            inert.append(path)
            continue
        if strategy not in groups:
            failures[path] = redact_text(
                f"未知 apply_strategy: {strategy!r}"
            )
            continue
        groups[strategy].append(path)

    applied: list[str] = []
    deferred: list[dict[str, Any]] = []
    executable = [
        path for name in _GROUP_ORDER for path in groups[name]
    ] + inert
    if executable:
        try:
            store.begin_preview(executable)
        except Exception as exc:
            detail = (
                redact_text(exc.message)
                if isinstance(exc, ConfigValidationError)
                else _strategy_failure_text(exc)
            )
            for path in executable:
                failures[path] = detail
        else:
            try:
                for strategy in _GROUP_ORDER:
                    group_paths = groups[strategy]
                    if not group_paths:
                        continue
                    try:
                        if strategy == "hot":
                            applied.extend(group_paths)
                        elif strategy == "deployment":
                            deferred.extend(
                                _deployment_entries(tuple(group_paths))
                            )
                            applied.extend(group_paths)
                        else:
                            applied.extend(
                                await _run_strategy_group(
                                    store,
                                    strategy,
                                    group_paths,
                                    failures,
                                )
                            )
                    except Exception as exc:
                        error = _strategy_failure_text(exc)
                        for path in group_paths:
                            failures[path] = error
                applied.extend(inert)
            finally:
                store.end_preview()

    if applied:
        outcome = store.commit(paths=applied)
        hot_paths = tuple(
            path
            for path in applied
            if resolve_apply_strategy(path) == "hot"
        )
        if hot_paths:
            try:
                report = await store.apply(
                    ConfigChange(
                        outcome.change.old,
                        outcome.change.new,
                        hot_paths,
                    )
                )
            except Exception as exc:
                logger.error(
                    "[Config] hot applier 分派异常（值已落盘）: %s",
                    _strategy_failure_text(exc),
                )
            else:
                for name, error in report.failed.items():
                    logger.error(
                        "[Config] hot applier %s 应用失败（值已落盘）: %s",
                        name,
                        error,
                    )

    return {
        "applied": applied,
        "failed": [
            {"path": path, "error": error}
            for path, error in failures.items()
        ],
        "deferred_restart": deferred,
        "partial": bool(applied) and bool(failures),
    }


# ── AI 通道 ────────────────────────────────────────────────


async def apply_ai(change: ConfigChange) -> None:
    """重新快照 AI 客户端静态配置；URL 变更时重建事件 hub。"""
    if not _touched(change, "ai_backend", "opencode", "loom"):
        return

    from services import loom_client, opencode_client

    opencode_client.reload_static_config()
    loom_client.reload_static_config()

    if _touched(change, "opencode.url", "loom.url"):
        from routers import events

        await events.reload_event_hubs()

    if _touched(change, "ai_backend"):
        from services import ai_client_factory

        ai_client_factory._reset_ai_client()


# ── 音频 / TTS / 归档 / 陌生人 ─────────────────────────────


def _sync_compressor_builtin() -> None:
    from config.config import get_config
    from services.audio_compressor import get_compressor
    from services.task_scheduler import get_task_scheduler

    cfg = get_config()
    scheduler = get_task_scheduler()
    if cfg.AUDIO_COMPRESSOR_ENABLED:
        compressor = get_compressor(
            keep_days=cfg.AUDIO_COMPRESSOR_KEEP_DAYS,
            ffmpeg_threads=cfg.AUDIO_COMPRESSOR_FFMPEG_THREADS,
            nice=cfg.AUDIO_COMPRESSOR_NICE,
        )
        scheduler.register_builtin(
            "audio_compressor_daily", "daily 00:05", compressor.compress_all
        )
    else:
        scheduler.storage.update_task(
            "builtin_audio_compressor_daily", enabled=False
        )


def _sync_unknown_cleanup_builtin() -> None:
    from main import _unknown_speaker_cleanup_once
    from services.task_scheduler import get_task_scheduler
    from services.unknown_speaker_config import get_unknown_speaker_config

    scheduler = get_task_scheduler()
    cfg = get_unknown_speaker_config()
    if cfg.get("enabled"):
        hour = int((cfg.get("lifecycle") or {}).get("cleanup_hour", 3))
        scheduler.register_builtin(
            "unknown_speaker_cleanup",
            f"daily {hour:02d}:00",
            _unknown_speaker_cleanup_once,
        )
    else:
        scheduler.storage.update_task(
            "builtin_unknown_speaker_cleanup", enabled=False
        )


async def apply_audio(
    change: ConfigChange, *, registry_sink: RegistrySink | None = None
) -> None:
    """刷新音频/陌生人配置缓存与模块快照，按子域重建后台资源。"""
    if not _touched(
        change, "audio", "tts", "unknown_speaker", "audio_compressor", "api.mimo_key"
    ):
        return

    from services import (
        audio_analysis_pipeline,
        audio_config,
        audio_ingest_session,
        audio_stream_session,
        unknown_speaker_config,
    )

    audio_config.invalidate_audio_config()
    unknown_speaker_config.invalidate_unknown_speaker_config()
    audio_analysis_pipeline.reload_audio_config_snapshot()
    audio_ingest_session.reload_audio_config_snapshot()
    audio_stream_session.reload_audio_config_snapshot()

    if _touched(change, "audio.stream.queue_maxsize"):
        from services.audio_analysis_queue import reset_analysis_queue

        reset_analysis_queue()

    if _touched(
        change,
        "audio.stream.stitch_enabled",
        "audio.stream.stitch.",
        "audio.stream.holdback_s",
        "audio.stream.min_flush_speech_ratio",
    ):
        from services.audio_ingest_registry import reset_audio_ingest_registry

        reset_audio_ingest_registry(registry_sink)

    if _touched(change, "tts", "api.mimo_key"):
        from services.tts_player import reset_tts_player

        reset_tts_player()

    if _touched(change, "audio_compressor"):
        from services.audio_compressor import reset_compressor

        reset_compressor()
        _sync_compressor_builtin()

    if _touched(change, "unknown_speaker"):
        _sync_unknown_cleanup_builtin()


# ── 数据路径 / 任务与脚本热重绑 ────────────────────────────


async def apply_data_paths(change: ConfigChange) -> None:
    """按新路径重算写侧根目录，并重绑会话/任务/脚本后台资源。"""
    if not _touched(change, "data", "scripts", "health.primary_user"):
        return

    from services import health_storage, perception_store

    perception_store.reload_paths()
    health_storage.reload_paths()

    if _touched(change, "data.sessions"):
        from services.stt_session_manager import reload_storage_path

        reload_storage_path()

    if _touched(change, "data.tasks"):
        from services.task_scheduler import get_task_scheduler

        result = await get_task_scheduler().rebind_storage()
        if result.get("ok") is False:
            raise RuntimeError(f"任务存储重绑失败: {result}")

    if _touched(change, "scripts.dir"):
        from services.script_runner import reload_scripts_dir

        result = await reload_scripts_dir()
        if result.get("ok") is False:
            warnings = "；".join(
                str(item) for item in result.get("warnings") or ()
            )
            raise RuntimeError(f"脚本目录重绑失败: {warnings or result}")


# ── 外部集成（健康云 / QQ / P2P）──────────────────────────


async def apply_integrations(
    change: ConfigChange, *, reconnects: bool = True
) -> None:
    """健康云缓存/开关/周期、QQ 网关与 P2P 管理器按新配置原地重启。"""
    if not _touched(
        change,
        "health.cloud",
        "health.cloud_poll_interval_min",
        "qq_gateway",
        "p2p",
    ):
        return

    cloud_changed = _touched(change, "health.cloud")
    poll_changed = _touched(change, "health.cloud_poll_interval_min")
    if cloud_changed or poll_changed:
        from config.config import get_config
        from services.health_cloud_service import get_health_cloud_service

        service = get_health_cloud_service()
        if cloud_changed:
            service.invalidate_source()
        if _touched(change, "health.cloud.enabled"):
            service.set_enabled(bool(get_config().HEALTH_CLOUD_ENABLED))
        if poll_changed:
            service.stop()
            service.start()

    if not reconnects:
        return

    if _touched(change, "qq_gateway"):
        from services.qq_gateway.service import restart_qq_gateway

        result = await restart_qq_gateway()
        if not result.get("ok"):
            raise _restart_failure("QQ 网关", result)

    if _touched(change, "p2p"):
        from services.p2p.manager import restart_p2p_manager

        result = await restart_p2p_manager()
        if not result.get("ok"):
            raise _restart_failure("P2P 管理器", result)


# ── 内核 ──────────────────────────────────────────────────


async def apply_kernel(
    change: ConfigChange, *, respawn: bool = True
) -> None:
    """按新 kernel.* 配置安全重启内核（同步客户端放线程池执行）。"""
    if not respawn or not _touched(change, "kernel"):
        return

    from services import kernel_client

    result = await asyncio.to_thread(kernel_client.restart_kernel)
    status = result.get("status") if isinstance(result, Mapping) else None
    if status == "error":
        raise RuntimeError(result)


# ── 监听 / TLS / CORS ─────────────────────────────────────


async def apply_listener(
    change: ConfigChange, *, cors_refresh: CorsRefresh | None = None
) -> None:
    """监听地址/端口/TLS 变更走 HotServer 原地重绑，并刷新 CORS 白名单。"""
    if not _touched(change, "server", "ssl"):
        return

    from core.hot_server import get_hot_server

    server = get_hot_server()
    if server is not None:
        result = await server.rebind_from_config()
        if not result.get("ok"):
            raise RuntimeError(result)

    if cors_refresh is not None:
        outcome = cors_refresh()
        if inspect.isawaitable(outcome):
            await outcome


# ── 注册入口 ─────────────────────────────────────────────


def register_default_appliers(
    store: ConfigStore,
    *,
    registry_sink: RegistrySink | None = None,
    cors_refresh: CorsRefresh | None = None,
) -> list[str]:
    """按依赖顺序注册六个领域应用器；重复调用幂等替换。"""
    appliers: list[
        tuple[str, Callable[[ConfigChange], Awaitable[Any]]]
    ] = [
        ("ai", apply_ai),
        ("audio", partial(apply_audio, registry_sink=registry_sink)),
        ("data_paths", apply_data_paths),
        ("integrations", partial(apply_integrations, reconnects=False)),
        ("kernel", partial(apply_kernel, respawn=False)),
        ("listener", partial(apply_listener, cors_refresh=cors_refresh)),
    ]
    for name, applier in appliers:
        store.register_applier(name, applier, replace=True)
    register_strategy = getattr(
        store, "register_strategy_dispatcher", None
    )
    if callable(register_strategy):
        register_strategy(dispatch_apply_strategy)
    return [name for name, _applier in appliers]


__all__ = [
    "STRATEGY_HANDLERS",
    "apply_ai",
    "apply_audio",
    "apply_data_paths",
    "apply_integrations",
    "apply_kernel",
    "apply_listener",
    "apply_staged",
    "dispatch_apply_strategy",
    "register_default_appliers",
]
