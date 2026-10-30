# -*- coding: utf-8 -*-
"""N11 配置热应用器：依赖注册顺序、按变更路径分发、失败如实上报。

全部用例只 monkeypatch 目标模块的钩子，不触网、不重启生产服务、不写真实
配置文件；async applier 统一用 asyncio.run 驱动（本 venv 无 pytest-asyncio）。
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any, Callable

import pytest

import config.config as config_module
import main as main_module
from config.providers import ProviderInfo
from config.store import ConfigChange, ConfigStore
from services.config_reconciler import (
    apply_ai,
    apply_audio,
    apply_data_paths,
    apply_integrations,
    apply_kernel,
    apply_listener,
    register_default_appliers,
)


def _change(*paths: str) -> ConfigChange:
    return ConfigChange(old={}, new={}, changed_paths=tuple(paths))


def _cfg(**values: Any) -> SimpleNamespace:
    return SimpleNamespace(**values)


def _record(calls: list[tuple[str, Any]]) -> Callable[..., None]:
    def _hook(*args: Any, **kwargs: Any) -> None:
        calls.append(("call", (args, kwargs)))

    return _hook


class _FakeStorage:
    def __init__(self) -> None:
        self.updates: list[tuple[str, dict[str, Any]]] = []

    def update_task(self, task_id: str, **kwargs: Any) -> None:
        self.updates.append((task_id, dict(kwargs)))


class _FakeScheduler:
    def __init__(self) -> None:
        self.storage = _FakeStorage()
        self.builtins: list[tuple[str, str, Callable[[], Any]]] = []

    def register_builtin(
        self, name: str, schedule: str, coro_fn: Callable[[], Any]
    ) -> None:
        self.builtins.append((name, schedule, coro_fn))


class _FakeCompressor:
    def compress_all(self) -> None:
        return None


class _FakeCloudService:
    def __init__(self) -> None:
        self.invalidated = 0
        self.starts = 0
        self.stops = 0
        self.enabled: list[bool] = []

    def invalidate_source(self) -> None:
        self.invalidated += 1

    def start(self) -> None:
        self.starts += 1

    def stop(self) -> None:
        self.stops += 1

    def set_enabled(self, enabled: bool) -> None:
        self.enabled.append(bool(enabled))


class _FakeHotServer:
    def __init__(self, ok: bool = True) -> None:
        self.ok = ok
        self.calls = 0

    async def rebind_from_config(self) -> dict[str, Any]:
        self.calls += 1
        return {"ok": self.ok, "error": "" if self.ok else "bind failed"}


class _MemoryProvider:
    kind = "memory"

    def load(self) -> dict[str, Any]:
        return {}

    def save(
        self, document: dict[str, Any], *, expected_revision: str | None = None
    ) -> str:
        return "mem-1"

    def revision(self) -> str:
        return "mem-1"

    def describe(self) -> ProviderInfo:
        return ProviderInfo(
            kind="memory",
            location="memory://reconciler",
            writable=True,
            detail="test",
        )


# ---------------------------------------------------------------------------
# 注册契约
# ---------------------------------------------------------------------------


class _RegisteringStore:
    def __init__(self) -> None:
        self.registered: list[tuple[str, Callable[..., Any], bool]] = []

    def register_applier(
        self,
        name: str,
        fn: Callable[..., Any],
        *,
        replace: bool = False,
    ) -> None:
        self.registered.append((name, fn, replace))


def test_register_default_appliers_order_and_replace() -> None:
    store = _RegisteringStore()
    sink = lambda device_id, chunks: None  # noqa: E731
    refresh = lambda: None  # noqa: E731

    names = register_default_appliers(
        store, registry_sink=sink, cors_refresh=refresh
    )

    assert names == [
        "ai",
        "audio",
        "data_paths",
        "integrations",
        "kernel",
        "listener",
    ]
    assert [name for name, _fn, _replace in store.registered] == names
    assert all(replace for _name, _fn, replace in store.registered)


def test_touched_matches_exact_and_dotted_prefix() -> None:
    from services.config_reconciler import _touched

    change = _change(
        "server.https_port",
        "opencode.url",
        "ai_backend",
        "health.cloud.enabled",
    )

    assert _touched(change, "server")
    assert _touched(change, "server.https_port")
    assert _touched(change, "opencode.")
    assert _touched(change, "ai_backend")
    assert _touched(change, "health.cloud")
    assert not _touched(change, "serve")
    assert not _touched(change, "opencode.urls")
    assert not _touched(change, "health.cloud_poll_interval_min")
    assert not _touched(change, "kernel")


# ---------------------------------------------------------------------------
# AI
# ---------------------------------------------------------------------------


def test_ai_applier_reloads_both_channels_and_awaits_event_hubs(monkeypatch) -> None:
    import routers.events as events
    import services.ai_client_factory as factory
    import services.loom_client as loom_client
    import services.opencode_client as opencode_client

    calls: list[str] = []

    monkeypatch.setattr(
        opencode_client, "reload_static_config", lambda: calls.append("opencode")
    )
    monkeypatch.setattr(
        loom_client, "reload_static_config", lambda: calls.append("loom")
    )
    monkeypatch.setattr(factory, "_reset_ai_client", lambda: calls.append("reset"))

    async def _reload_hubs() -> None:
        calls.append("hubs")

    monkeypatch.setattr(events, "reload_event_hubs", _reload_hubs)

    asyncio.run(apply_ai(_change("opencode.url")))

    assert calls == ["opencode", "loom", "hubs"]


def test_ai_applier_resets_factory_only_when_backend_changes(monkeypatch) -> None:
    import routers.events as events
    import services.ai_client_factory as factory
    import services.loom_client as loom_client
    import services.opencode_client as opencode_client

    calls: list[str] = []
    monkeypatch.setattr(
        opencode_client, "reload_static_config", lambda: calls.append("opencode")
    )
    monkeypatch.setattr(
        loom_client, "reload_static_config", lambda: calls.append("loom")
    )
    monkeypatch.setattr(factory, "_reset_ai_client", lambda: calls.append("reset"))

    async def _reload_hubs() -> None:
        calls.append("hubs")

    monkeypatch.setattr(events, "reload_event_hubs", _reload_hubs)

    asyncio.run(apply_ai(_change("ai_backend")))

    assert calls == ["opencode", "loom", "reset"]


def test_ai_applier_ignores_unrelated_change(monkeypatch) -> None:
    import services.loom_client as loom_client
    import services.opencode_client as opencode_client

    calls: list[str] = []
    monkeypatch.setattr(
        opencode_client, "reload_static_config", lambda: calls.append("opencode")
    )
    monkeypatch.setattr(
        loom_client, "reload_static_config", lambda: calls.append("loom")
    )

    asyncio.run(apply_ai(_change("server.https_port")))

    assert calls == []


def test_reload_event_hubs_refreshes_opencode_event_url(monkeypatch) -> None:
    import routers.events as events

    monkeypatch.setattr(events, "OPENCODE_EVENT_URL", events.OPENCODE_EVENT_URL)
    monkeypatch.setattr(events, "_hubs", {"opencode": None, "loom": None})
    monkeypatch.setattr(
        events,
        "get_config",
        lambda: _cfg(OPENCODE_URL="http://127.0.0.1:4097"),
    )

    asyncio.run(events.reload_event_hubs())

    assert events.OPENCODE_EVENT_URL == "http://127.0.0.1:4097/global/event"
    hub = events.get_event_hub("opencode")
    assert hub._url == "http://127.0.0.1:4097/global/event"
    assert events._hubs["loom"] is None


# ---------------------------------------------------------------------------
# Audio
# ---------------------------------------------------------------------------


def _patch_audio(monkeypatch, scheduler: _FakeScheduler) -> dict[str, list[Any]]:
    import services.audio_analysis_pipeline as pipeline
    import services.audio_analysis_queue as queue
    import services.audio_compressor as compressor
    import services.audio_config as audio_config
    import services.audio_ingest_registry as registry
    import services.audio_ingest_session as ingest
    import services.audio_stream_session as stream
    import services.task_scheduler as task_scheduler
    import services.tts_player as tts
    import services.unknown_speaker_config as unknown

    calls: dict[str, list[Any]] = {
        "audio_cache": [],
        "unknown_cache": [],
        "pipeline": [],
        "ingest": [],
        "stream": [],
        "queue": [],
        "registry": [],
        "tts": [],
        "compressor_reset": [],
        "scheduler": [],
    }

    monkeypatch.setattr(
        audio_config, "invalidate_audio_config", _record(calls["audio_cache"])
    )
    monkeypatch.setattr(
        unknown,
        "invalidate_unknown_speaker_config",
        _record(calls["unknown_cache"]),
    )
    monkeypatch.setattr(
        pipeline, "reload_audio_config_snapshot", _record(calls["pipeline"])
    )
    monkeypatch.setattr(
        ingest, "reload_audio_config_snapshot", _record(calls["ingest"])
    )
    monkeypatch.setattr(
        stream, "reload_audio_config_snapshot", _record(calls["stream"])
    )
    monkeypatch.setattr(
        queue, "reset_analysis_queue", _record(calls["queue"])
    )
    monkeypatch.setattr(
        registry,
        "reset_audio_ingest_registry",
        lambda sink=None: calls["registry"].append(("reset", sink)),
    )
    monkeypatch.setattr(tts, "reset_tts_player", _record(calls["tts"]))
    monkeypatch.setattr(
        compressor, "reset_compressor", _record(calls["compressor_reset"])
    )
    monkeypatch.setattr(task_scheduler, "get_task_scheduler", lambda: scheduler)
    return calls


def test_audio_applier_resets_registry_on_split_change(monkeypatch) -> None:
    scheduler = _FakeScheduler()
    calls = _patch_audio(monkeypatch, scheduler)
    sink = lambda device_id, chunks: None  # noqa: E731

    asyncio.run(
        apply_audio(_change("audio.stream.stitch_enabled"), registry_sink=sink)
    )

    assert len(calls["audio_cache"]) == 1
    assert len(calls["unknown_cache"]) == 1
    assert len(calls["pipeline"]) == 1
    assert len(calls["ingest"]) == 1
    assert len(calls["stream"]) == 1
    assert calls["queue"] == []
    assert calls["registry"] == [("reset", sink)]
    assert calls["tts"] == []
    assert calls["compressor_reset"] == []
    assert scheduler.builtins == []
    assert scheduler.storage.updates == []


def test_audio_applier_resets_queue_only_on_maxsize_change(monkeypatch) -> None:
    scheduler = _FakeScheduler()
    calls = _patch_audio(monkeypatch, scheduler)

    asyncio.run(apply_audio(_change("audio.stream.queue_maxsize")))

    assert len(calls["queue"]) == 1
    assert calls["registry"] == []


def test_audio_applier_threshold_change_does_not_reset_runtime_resources(
    monkeypatch,
) -> None:
    scheduler = _FakeScheduler()
    calls = _patch_audio(monkeypatch, scheduler)

    asyncio.run(apply_audio(_change("audio.stream.silence_cut_s")))

    assert len(calls["pipeline"]) == 1
    assert len(calls["ingest"]) == 1
    assert len(calls["stream"]) == 1
    assert calls["queue"] == []
    assert calls["registry"] == []


def test_audio_applier_tts_change_resets_player_only(monkeypatch) -> None:
    scheduler = _FakeScheduler()
    calls = _patch_audio(monkeypatch, scheduler)

    asyncio.run(apply_audio(_change("tts.enabled")))

    assert len(calls["tts"]) == 1
    assert calls["queue"] == []
    assert calls["registry"] == []
    assert scheduler.builtins == []


def test_audio_applier_mimo_key_change_resets_tts_player(monkeypatch) -> None:
    scheduler = _FakeScheduler()
    calls = _patch_audio(monkeypatch, scheduler)

    asyncio.run(apply_audio(_change("api.mimo_key")))

    assert len(calls["tts"]) == 1
    assert calls["queue"] == []
    assert calls["registry"] == []
    assert scheduler.builtins == []


def test_audio_applier_re_registers_compressor_when_enabled(monkeypatch) -> None:
    scheduler = _FakeScheduler()
    calls = _patch_audio(monkeypatch, scheduler)
    import services.audio_compressor as compressor

    fake = _FakeCompressor()
    monkeypatch.setattr(compressor, "get_compressor", lambda **kwargs: fake)
    monkeypatch.setattr(
        config_module,
        "get_config",
        lambda: _cfg(
            AUDIO_COMPRESSOR_ENABLED=True,
            AUDIO_COMPRESSOR_KEEP_DAYS=4,
            AUDIO_COMPRESSOR_FFMPEG_THREADS=2,
            AUDIO_COMPRESSOR_NICE=5,
        ),
    )

    asyncio.run(apply_audio(_change("audio_compressor.keep_days")))

    assert len(calls["compressor_reset"]) == 1
    assert len(scheduler.builtins) == 1
    name, schedule, callback = scheduler.builtins[0]
    assert name == "audio_compressor_daily"
    assert schedule == "daily 00:05"
    assert getattr(callback, "__self__", None) is fake


def test_audio_applier_disables_compressor_builtin_when_off(monkeypatch) -> None:
    scheduler = _FakeScheduler()
    _patch_audio(monkeypatch, scheduler)
    monkeypatch.setattr(
        config_module,
        "get_config",
        lambda: _cfg(AUDIO_COMPRESSOR_ENABLED=False),
    )

    asyncio.run(apply_audio(_change("audio_compressor.enabled")))

    assert scheduler.builtins == []
    assert scheduler.storage.updates == [
        ("builtin_audio_compressor_daily", {"enabled": False})
    ]


def test_audio_applier_registers_unknown_cleanup_with_cleanup_hour(
    monkeypatch,
) -> None:
    scheduler = _FakeScheduler()
    _patch_audio(monkeypatch, scheduler)
    import services.unknown_speaker_config as unknown

    async def _cleanup() -> None:
        return None

    monkeypatch.setattr(main_module, "_unknown_speaker_cleanup_once", _cleanup)
    monkeypatch.setattr(
        unknown,
        "get_unknown_speaker_config",
        lambda: {"enabled": True, "lifecycle": {"cleanup_hour": 4}},
    )

    asyncio.run(apply_audio(_change("unknown_speaker.enabled")))

    assert [item[0] for item in scheduler.builtins] == ["unknown_speaker_cleanup"]
    name, schedule, callback = scheduler.builtins[0]
    assert name == "unknown_speaker_cleanup"
    assert schedule == "daily 04:00"
    assert callback is _cleanup


def test_audio_applier_disables_unknown_cleanup_when_off(monkeypatch) -> None:
    scheduler = _FakeScheduler()
    _patch_audio(monkeypatch, scheduler)
    import services.unknown_speaker_config as unknown

    monkeypatch.setattr(
        unknown,
        "get_unknown_speaker_config",
        lambda: {"enabled": False, "lifecycle": {"cleanup_hour": 3}},
    )

    asyncio.run(apply_audio(_change("unknown_speaker.enabled")))

    assert scheduler.builtins == []
    assert scheduler.storage.updates == [
        ("builtin_unknown_speaker_cleanup", {"enabled": False})
    ]


def test_audio_applier_ignores_unrelated_change(monkeypatch) -> None:
    scheduler = _FakeScheduler()
    calls = _patch_audio(monkeypatch, scheduler)

    asyncio.run(apply_audio(_change("server.https_port")))

    assert all(value == [] for value in calls.values())
    assert scheduler.builtins == []


# ---------------------------------------------------------------------------
# Data paths
# ---------------------------------------------------------------------------


def test_data_paths_reloads_roots(monkeypatch) -> None:
    import services.health_storage as health_storage
    import services.perception_store as perception_store

    calls: list[str] = []
    monkeypatch.setattr(
        perception_store, "reload_paths", lambda: calls.append("perception")
    )
    monkeypatch.setattr(
        health_storage, "reload_paths", lambda: calls.append("health")
    )

    asyncio.run(apply_data_paths(_change("data.dir")))

    assert calls == ["perception", "health"]


def test_data_paths_rebinds_sessions_tasks_scripts(monkeypatch) -> None:
    import services.health_storage as health_storage
    import services.perception_store as perception_store
    import services.script_runner as script_runner
    import services.stt_session_manager as stt
    import services.task_scheduler as task_scheduler

    calls: list[str] = []
    monkeypatch.setattr(
        perception_store, "reload_paths", lambda: calls.append("perception")
    )
    monkeypatch.setattr(
        health_storage, "reload_paths", lambda: calls.append("health")
    )
    monkeypatch.setattr(
        stt, "reload_storage_path", lambda: calls.append("stt")
    )

    class _Scheduler:
        async def rebind_storage(self) -> dict[str, Any]:
            calls.append("tasks")
            return {"ok": True}

    monkeypatch.setattr(task_scheduler, "get_task_scheduler", lambda: _Scheduler())

    async def _reload_scripts_dir() -> dict[str, Any]:
        calls.append("scripts")
        return {"ok": True}

    monkeypatch.setattr(script_runner, "reload_scripts_dir", _reload_scripts_dir)

    asyncio.run(
        apply_data_paths(
            _change(
                "data.sessions",
                "data.tasks",
                "scripts.dir",
            )
        )
    )

    assert calls == [
        "perception",
        "health",
        "stt",
        "tasks",
        "scripts",
    ]


def test_data_paths_primary_user_reloads_health(monkeypatch) -> None:
    import services.health_storage as health_storage
    import services.perception_store as perception_store
    import services.stt_session_manager as stt

    calls: list[str] = []
    monkeypatch.setattr(
        perception_store, "reload_paths", lambda: calls.append("perception")
    )
    monkeypatch.setattr(
        health_storage, "reload_paths", lambda: calls.append("health")
    )
    monkeypatch.setattr(
        stt, "reload_storage_path", lambda: calls.append("stt")
    )

    asyncio.run(apply_data_paths(_change("health.primary_user")))

    assert calls == ["perception", "health"]


# ---------------------------------------------------------------------------
# Integrations
# ---------------------------------------------------------------------------


def test_integrations_health_credentials_invalidate_source(monkeypatch) -> None:
    import services.health_cloud_service as cloud_module

    service = _FakeCloudService()
    monkeypatch.setattr(
        cloud_module, "get_health_cloud_service", lambda: service
    )

    asyncio.run(apply_integrations(_change("health.cloud.passtoken")))

    assert service.invalidated == 1
    assert service.starts == 0
    assert service.stops == 0
    assert service.enabled == []


def test_integrations_health_enabled_and_poll_interval(monkeypatch) -> None:
    import services.health_cloud_service as cloud_module

    service = _FakeCloudService()
    monkeypatch.setattr(
        cloud_module, "get_health_cloud_service", lambda: service
    )
    monkeypatch.setattr(
        config_module,
        "get_config",
        lambda: _cfg(HEALTH_CLOUD_ENABLED=True),
    )

    asyncio.run(
        apply_integrations(
            _change(
                "health.cloud.enabled",
                "health.cloud_poll_interval_min",
            )
        )
    )

    assert service.invalidated == 1
    assert service.enabled == [True]
    assert service.starts == 1
    assert service.stops == 1


def test_integrations_restarts_qq_and_p2p(monkeypatch) -> None:
    import services.p2p.manager as p2p_manager
    import services.qq_gateway.service as qq_service

    calls: list[str] = []

    async def _restart_qq() -> dict[str, Any]:
        calls.append("qq")
        return {"ok": True}

    async def _restart_p2p() -> dict[str, Any]:
        calls.append("p2p")
        return {"ok": True}

    monkeypatch.setattr(qq_service, "restart_qq_gateway", _restart_qq)
    monkeypatch.setattr(p2p_manager, "restart_p2p_manager", _restart_p2p)

    asyncio.run(
        apply_integrations(_change("qq_gateway.account.ws_url", "p2p.enabled"))
    )

    assert calls == ["qq", "p2p"]


def test_integrations_restart_failure_raises(monkeypatch) -> None:
    import services.qq_gateway.service as qq_service

    async def _restart_qq() -> dict[str, Any]:
        return {"ok": False, "errors": ["invalid ws token"]}

    monkeypatch.setattr(qq_service, "restart_qq_gateway", _restart_qq)

    with pytest.raises(RuntimeError, match="invalid ws token"):
        asyncio.run(apply_integrations(_change("qq_gateway.account.ws_token")))


def test_integrations_restart_failure_redacts_secret(monkeypatch) -> None:
    import services.qq_gateway.service as qq_service

    secret = "sk-live-restart-secret-0123456789"

    async def _restart_qq() -> dict[str, Any]:
        return {"ok": False, "errors": [f"Authorization: Bearer {secret}"]}

    monkeypatch.setattr(qq_service, "restart_qq_gateway", _restart_qq)

    with pytest.raises(RuntimeError) as exc_info:
        asyncio.run(apply_integrations(_change("qq_gateway.account.ws_token")))

    assert secret not in str(exc_info.value)


def test_integrations_ignores_unrelated_change(monkeypatch) -> None:
    import services.p2p.manager as p2p_manager
    import services.qq_gateway.service as qq_service

    calls: list[str] = []

    async def _restart_qq() -> dict[str, Any]:
        calls.append("qq")
        return {"ok": True}

    async def _restart_p2p() -> dict[str, Any]:
        calls.append("p2p")
        return {"ok": True}

    monkeypatch.setattr(qq_service, "restart_qq_gateway", _restart_qq)
    monkeypatch.setattr(p2p_manager, "restart_p2p_manager", _restart_p2p)

    asyncio.run(apply_integrations(_change("server.https_port")))

    assert calls == []


# ---------------------------------------------------------------------------
# Kernel
# ---------------------------------------------------------------------------


def test_kernel_applier_restarts_in_thread(monkeypatch) -> None:
    import services.kernel_client as kernel_client

    calls: list[dict[str, Any]] = []

    def _restart(**kwargs: Any) -> dict[str, Any]:
        calls.append(kwargs)
        return {"status": "restarted", "pid": 123}

    monkeypatch.setattr(kernel_client, "restart_kernel", _restart)

    asyncio.run(apply_kernel(_change("kernel.device")))

    assert len(calls) == 1


def test_kernel_applier_raises_on_error_result(monkeypatch) -> None:
    import services.kernel_client as kernel_client

    monkeypatch.setattr(
        kernel_client,
        "restart_kernel",
        lambda **kwargs: {"status": "error", "error": "kernel boom"},
    )

    with pytest.raises(RuntimeError, match="kernel boom"):
        asyncio.run(apply_kernel(_change("kernel.device")))


def test_kernel_applier_ignores_unrelated_change(monkeypatch) -> None:
    import services.kernel_client as kernel_client

    calls: list[str] = []
    monkeypatch.setattr(
        kernel_client,
        "restart_kernel",
        lambda **kwargs: calls.append("restart") or {"status": "restarted"},
    )

    asyncio.run(apply_kernel(_change("server.https_port")))

    assert calls == []


# ---------------------------------------------------------------------------
# Listener
# ---------------------------------------------------------------------------


def test_listener_applier_rebinds_and_refreshes_cors(monkeypatch) -> None:
    import core.hot_server as hot_server

    server = _FakeHotServer()
    monkeypatch.setattr(hot_server, "get_hot_server", lambda: server)
    cors_calls: list[str] = []

    asyncio.run(
        apply_listener(
            _change("server.https_port"),
            cors_refresh=lambda: cors_calls.append("cors"),
        )
    )

    assert server.calls == 1
    assert cors_calls == ["cors"]


def test_listener_applier_refreshes_cors_without_hot_server(monkeypatch) -> None:
    import core.hot_server as hot_server

    monkeypatch.setattr(hot_server, "get_hot_server", lambda: None)
    cors_calls: list[str] = []

    asyncio.run(
        apply_listener(
            _change("ssl.enabled"),
            cors_refresh=lambda: cors_calls.append("cors"),
        )
    )

    assert cors_calls == ["cors"]


def test_listener_applier_raises_when_rebind_fails(monkeypatch) -> None:
    import core.hot_server as hot_server

    server = _FakeHotServer(ok=False)
    monkeypatch.setattr(hot_server, "get_hot_server", lambda: server)
    cors_calls: list[str] = []

    with pytest.raises(RuntimeError, match="bind failed"):
        asyncio.run(
            apply_listener(
                _change("server.https_port"),
                cors_refresh=lambda: cors_calls.append("cors"),
            )
        )

    assert cors_calls == []


def test_listener_applier_ignores_unrelated_change(monkeypatch) -> None:
    import core.hot_server as hot_server

    server = _FakeHotServer()
    monkeypatch.setattr(hot_server, "get_hot_server", lambda: server)
    cors_calls: list[str] = []

    asyncio.run(
        apply_listener(
            _change("kernel.device"),
            cors_refresh=lambda: cors_calls.append("cors"),
        )
    )

    assert server.calls == 0
    assert cors_calls == []


# ---------------------------------------------------------------------------
# ConfigStore.apply 集成：异常不吞
# ---------------------------------------------------------------------------


def test_applier_failure_is_recorded_by_store_apply(monkeypatch) -> None:
    import services.kernel_client as kernel_client

    store = ConfigStore(_MemoryProvider())
    register_default_appliers(store)
    monkeypatch.setattr(
        kernel_client,
        "stop_kernel_process",
        lambda **kwargs: (_ for _ in ()).throw(RuntimeError("kernel boom")),
    )

    report = asyncio.run(store.apply(_change("kernel.device")))

    assert "respawn:kernel" in report.failed
    assert "kernel boom" in report.failed["respawn:kernel"]
    assert "ai" in report.applied
    assert "listener" in report.applied


def test_applier_is_idempotent_for_repeated_calls(monkeypatch) -> None:
    import services.perception_store as perception_store

    calls: list[str] = []
    monkeypatch.setattr(
        perception_store, "reload_paths", lambda: calls.append("perception")
    )

    asyncio.run(apply_data_paths(_change("data.dir")))
    asyncio.run(apply_data_paths(_change("data.dir")))

    assert calls == ["perception", "perception"]
