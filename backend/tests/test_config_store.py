# -*- coding: utf-8 -*-
"""config.store（N02）契约：默认值启动、分层合并、原子热写、应用器与外部 watcher。

约束：全部用例走 tmp_path；仓库根 config.yaml 与 backend/config/auth.json 只做
指纹守卫，测试不得写入。FakeProvider 只用于隔离 provider 行为，读写语义由
test_config_providers.py 的真 provider 契约兜底。
"""

from __future__ import annotations

import asyncio
import contextlib
import copy
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any, Iterator

import pytest

import config.store as store_module
from config.providers import (
    ComposedProvider,
    EnvOverlay,
    ProviderError,
    ProviderInfo,
    YamlFileProvider,
    build_provider,
)
from config.store import (
    ConfigChange,
    ConfigEnvLocked,
    ConfigReadOnly,
    ConfigRevisionConflict,
    ConfigStore,
    ConfigStoreError,
    ConfigValidationError,
    ConfigWriteError,
    degraded_reasons,
    get_config_store,
    is_degraded,
    reset_config_store,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
REPO_CONFIG = REPO_ROOT / "config.yaml"
REPO_AUTH = REPO_ROOT / "backend" / "config" / "auth.json"


def _fingerprint(path: Path) -> tuple[int, int] | None:
    try:
        stat = path.stat()
    except FileNotFoundError:
        return None
    return (stat.st_mtime_ns, stat.st_size)


@pytest.fixture(scope="module", autouse=True)
def _repo_files_guard():
    before = (_fingerprint(REPO_CONFIG), _fingerprint(REPO_AUTH))
    yield
    assert (_fingerprint(REPO_CONFIG), _fingerprint(REPO_AUTH)) == before, (
        "测试不得触碰仓库 config.yaml / auth.json"
    )


@pytest.fixture(autouse=True)
def _reset_legacy_port_migration_warnings():
    with store_module._LEGACY_PORT_MIGRATION_LOCK:
        store_module._WARNED_LEGACY_PORT_MIGRATIONS.clear()
    yield


class FakeProvider:
    """单层内存 provider：可注入读/写/revision 失败，便于钉住错误映射。"""

    kind = "fake"

    def __init__(
        self,
        document: dict[str, Any] | None = None,
        *,
        writable: bool = True,
        save_error: Exception | None = None,
        revision_error: Exception | None = None,
        load_error: Exception | None = None,
    ):
        self.document = copy.deepcopy(document or {})
        self.writable = writable
        self.save_error = save_error
        self.revision_error = revision_error
        self.load_error = load_error
        self.revision_counter = 0
        self.save_calls: list[tuple[dict[str, Any], str | None]] = []

    def load(self) -> dict[str, Any]:
        if self.load_error is not None:
            raise self.load_error
        return copy.deepcopy(self.document)

    def save(
        self, document: dict[str, Any], *, expected_revision: str | None = None
    ) -> str:
        if self.save_error is not None:
            raise self.save_error
        if not self.writable:
            raise ProviderError("env overlay is read-only")
        if expected_revision is not None and expected_revision != self.revision():
            raise ProviderError(
                f"stale settings revision: expected {expected_revision!r}, "
                f"current {self.revision()!r}"
            )
        self.document = copy.deepcopy(document)
        self.revision_counter += 1
        self.save_calls.append((copy.deepcopy(document), expected_revision))
        return self.revision()

    def revision(self) -> str:
        if self.revision_error is not None:
            raise self.revision_error
        return f"fake-{self.revision_counter}"

    def describe(self) -> ProviderInfo:
        return ProviderInfo(
            kind="fake", location="memory://fake", writable=self.writable
        )


@contextlib.contextmanager
def _running_loop() -> Iterator[asyncio.AbstractEventLoop]:
    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()
    try:
        asyncio.run_coroutine_threadsafe(asyncio.sleep(0), loop).result(timeout=2.0)
        yield loop
    finally:
        loop.call_soon_threadsafe(loop.stop)
        thread.join(timeout=2.0)
        loop.close()


# ── 启动加载：缺失 / 损坏 / 默认值 ─────────────────────────


def test_missing_file_starts_from_defaults_without_raising(tmp_path):
    path = tmp_path / "settings.yaml"
    store = ConfigStore(YamlFileProvider(path))

    assert store.snapshot()["server"]["host"] == "0.0.0.0"
    assert store.snapshot()["server"]["port"] == 8768
    assert store.base_document() == {}
    assert "config_missing" in store.degraded
    assert store.revision == "missing"
    assert not path.exists()


def test_corrupt_yaml_degrades_and_keeps_defaults(tmp_path):
    path = tmp_path / "settings.yaml"
    path.write_text("server: [unclosed\n", encoding="utf-8")

    store = ConfigStore(YamlFileProvider(path))

    assert store.snapshot()["server"]["host"] == "0.0.0.0"
    assert any(reason.startswith("base_load_failed:") for reason in store.degraded)
    assert store.provider_info().kind == "yaml"


def test_load_migrates_legacy_dual_ports_to_https_when_tls_ready(tmp_path, caplog):
    cert = tmp_path / "cert.pem"
    key = tmp_path / "key.pem"
    cert.write_text("cert", encoding="utf-8")
    key.write_text("key", encoding="utf-8")
    path = tmp_path / "settings.yaml"
    path.write_text(
        "server:\n"
        "  host: 127.0.0.1\n"
        "  http_port: 8769\n"
        "  https_port: 8768\n"
        "ssl:\n"
        "  enabled: true\n"
        f"  cert: {str(cert)!r}\n"
        f"  key: {str(key)!r}\n"
        "data:\n"
        "  dir: keep-me\n",
        encoding="utf-8",
    )
    before = path.read_text(encoding="utf-8")

    with caplog.at_level(logging.WARNING, logger="config.store"):
        store = ConfigStore(YamlFileProvider(path))

    assert store.get("server.port") == 8768
    assert store.get("server.http_port") == 8769
    assert store.get("data.dir") == "keep-me"
    assert path.read_text(encoding="utf-8") == before
    assert "migrated" in caplog.text
    assert "server.https_port" in caplog.text


def test_load_migrates_legacy_dual_ports_to_http_when_tls_not_ready(tmp_path, caplog):
    path = tmp_path / "settings.yaml"
    path.write_text(
        "server:\n"
        "  http_port: 18769\n"
        "  https_port: 18768\n"
        "ssl:\n"
        "  enabled: true\n"
        "  cert: /nonexistent/cert.pem\n"
        "  key: /nonexistent/key.pem\n",
        encoding="utf-8",
    )

    with caplog.at_level(logging.WARNING, logger="config.store"):
        store = ConfigStore(YamlFileProvider(path))

    assert store.get("server.port") == 18769
    assert "migrated" in caplog.text
    assert "server.http_port" in caplog.text


def test_load_with_only_server_port_is_noop(tmp_path, caplog):
    path = tmp_path / "settings.yaml"
    path.write_text(
        "server:\n"
        "  port: 9999\n"
        "  http_port: 8769\n"
        "  https_port: 8768\n",
        encoding="utf-8",
    )
    before = path.read_text(encoding="utf-8")

    with caplog.at_level(logging.WARNING, logger="config.store"):
        store = ConfigStore(YamlFileProvider(path))

    assert store.get("server.port") == 9999
    assert "migrated" not in caplog.text
    assert path.read_text(encoding="utf-8") == before


def test_legacy_port_migration_warns_once_across_reloads(tmp_path, caplog):
    cert = tmp_path / "cert.pem"
    key = tmp_path / "key.pem"
    cert.write_text("cert", encoding="utf-8")
    key.write_text("key", encoding="utf-8")
    path = tmp_path / "settings.yaml"
    path.write_text(
        "server:\n"
        "  http_port: 28769\n"
        "  https_port: 28768\n"
        "ssl:\n"
        "  enabled: true\n"
        f"  cert: {str(cert)!r}\n"
        f"  key: {str(key)!r}\n",
        encoding="utf-8",
    )

    with caplog.at_level(logging.WARNING, logger="config.store"):
        store = ConfigStore(YamlFileProvider(path))
        base_mtime_ns = path.stat().st_mtime_ns
        for cycle in range(3):
            stamp = base_mtime_ns + (cycle + 1) * 1_000_000_000
            os.utime(path, ns=(stamp, stamp))
            assert store._poll_external_change() is not None

    migration_records = [
        record
        for record in caplog.records
        if record.name == "config.store" and "migrated" in record.getMessage()
    ]
    assert len(migration_records) == 1
    assert "server.https_port" in migration_records[0].getMessage()
    assert store.snapshot()["server"]["port"] == 28768


def test_base_load_error_degrades_to_defaults():
    provider = FakeProvider(
        {"server": {"host": "seed"}}, load_error=ProviderError("read boom")
    )

    store = ConfigStore(provider)

    assert any(reason.startswith("base_load_failed:") for reason in store.degraded)
    assert store.snapshot()["server"]["host"] == "0.0.0.0"
    assert store.base_document() == {}


def test_defaults_failure_degrades_without_raising(monkeypatch):
    def _explode() -> dict[str, Any]:
        raise RuntimeError("schema unavailable")

    monkeypatch.setattr(store_module, "defaults_document", _explode)

    store = ConfigStore(FakeProvider({"server": {"host": "seed"}}))

    assert any(reason.startswith("defaults_unavailable:") for reason in store.degraded)
    assert store.snapshot() == {"server": {"host": "seed"}}


def test_provider_build_failure_falls_back_to_repo_yaml(monkeypatch, tmp_path):
    fallback = tmp_path / "fallback.yaml"

    def _explode():
        raise ProviderError("backend boom")

    monkeypatch.setattr(store_module, "DEFAULT_CONFIG_PATH", fallback)
    monkeypatch.setattr(store_module, "build_provider", _explode)

    store = ConfigStore()

    assert any(reason.startswith("provider_build_failed:") for reason in store.degraded)
    assert "config_missing" in store.degraded
    assert store.provider_info().kind == "yaml"
    assert store.snapshot()["server"]["host"] == "0.0.0.0"
    assert not fallback.exists()


def test_revision_failure_falls_back_to_unknown():
    provider = FakeProvider(
        {"server": {"host": "seed"}},
        revision_error=ProviderError("revision boom"),
    )

    store = ConfigStore(provider)

    assert store.revision == "unknown"
    assert store.base_revision == "unknown"
    assert store.snapshot()["server"]["host"] == "seed"


def test_invalid_section_types_are_sanitized_with_warning_and_degraded(tmp_path):
    path = tmp_path / "settings.yaml"
    path.write_text("server: null\nopencode: 42\n", encoding="utf-8")

    store = ConfigStore(YamlFileProvider(path))

    assert store.snapshot()["server"] == {}
    assert store.snapshot()["opencode"] == {}
    assert any(
        reason.startswith("invalid_section: server") for reason in store.degraded
    )
    assert any(
        reason.startswith("invalid_section: opencode") for reason in store.degraded
    )
    assert {warning.severity for warning in store.warnings} == {"warning"}
    assert {warning.path for warning in store.warnings} >= {"server", "opencode"}
    assert "type_mismatch" in {warning.code for warning in store.warnings}


def test_section_sanitization_lifts_after_valid_save(tmp_path):
    path = tmp_path / "settings.yaml"
    path.write_text("server: null\n", encoding="utf-8")
    store = ConfigStore(YamlFileProvider(path))
    assert store.is_degraded() is True

    store.save({"server.host": "127.0.0.1"})

    assert store.is_degraded() is False
    assert store.snapshot()["server"]["host"] == "127.0.0.1"


def test_provider_info_falls_back_when_describe_fails(monkeypatch):
    provider = FakeProvider({"server": {"host": "seed"}})

    def _explode() -> ProviderInfo:
        raise RuntimeError("describe unavailable")

    monkeypatch.setattr(provider, "describe", _explode)

    store = ConfigStore(provider)
    info = store.provider_info()

    assert info.kind == "unknown"
    assert info.writable is False


# ── 分层合并与只读视图 ─────────────────────────────────────


def test_merge_order_is_defaults_then_base_then_overlay(tmp_path):
    path = tmp_path / "settings.yaml"
    YamlFileProvider(path).save(
        {
            "server": {"host": "base-host", "port": 9000},
            "data": {"dir": "base-data"},
        }
    )
    base = YamlFileProvider(path)
    overlay = EnvOverlay(
        env={
            "AXEUH_SETTINGS__SERVER__HOST": "overlay-host",
            "AXEUH_SETTINGS__DATA__DIR": "overlay-data",
        }
    )
    provider = ComposedProvider(base, overlay)

    store = ConfigStore(provider)

    assert store.provider is provider
    assert store.get("server.host") == "overlay-host"
    assert store.get("server.port") == 9000
    assert store.get("data.dir") == "overlay-data"
    assert store.get("auth.setup_require_token") is True
    assert store.base_document()["server"]["host"] == "base-host"
    assert store.overlay_document()["server"]["host"] == "overlay-host"


def test_composed_provider_exposes_base_and_overlay(tmp_path):
    base = YamlFileProvider(tmp_path / "settings.yaml")
    overlay = EnvOverlay(env={"AXEUH_SETTINGS__A": "1"})
    composed = ComposedProvider(base, overlay)
    single = ComposedProvider(base)

    assert composed.base is base
    assert composed.overlay is overlay
    assert single.base is base
    assert single.overlay is None


def test_documents_are_deep_copies_and_snapshot_is_live_reference(tmp_path):
    path = tmp_path / "settings.yaml"
    YamlFileProvider(path).save({"server": {"host": "file"}, "data": {"dir": "d"}})
    overlay = EnvOverlay(env={"AXEUH_SETTINGS__SERVER__HOST": "env"})
    store = ConfigStore(ComposedProvider(YamlFileProvider(path), overlay))

    base = store.base_document()
    base["server"]["host"] = "mutated"
    assert store.base_document()["server"]["host"] == "file"

    overlay_doc = store.overlay_document()
    overlay_doc["server"]["host"] = "mutated"
    assert store.overlay_document()["server"]["host"] == "env"

    assert store.snapshot() is store.snapshot()
    assert store.snapshot()["server"]["host"] == "env"


def test_get_returns_default_for_missing_paths():
    store = ConfigStore(FakeProvider({"server": {"host": "seed"}}))

    assert store.get("server.host") == "seed"
    assert store.get("server.missing", "fallback") == "fallback"
    assert store.get("server.host.deep", "fallback") == "fallback"


def test_masked_config_masks_sensitive_values(tmp_path):
    path = tmp_path / "settings.yaml"
    YamlFileProvider(path).save(
        {
            "api": {"mimo_key": "secret-value"},
            "loom": {"token": "token-value"},
            "server": {"host": "plain-host"},
        }
    )
    store = ConfigStore(YamlFileProvider(path))

    masked = store.masked_config()

    assert masked["api"]["mimo_key"] == "***"
    assert masked["loom"]["token"] == "***"
    assert masked["server"]["host"] == "plain-host"
    assert store.snapshot()["api"]["mimo_key"] == "secret-value"


def test_changed_paths_reports_added_removed_and_changed_leaves():
    store = ConfigStore(FakeProvider({"server": {"host": "seed"}}))
    old = {
        "server": {"host": "a", "https_port": 1},
        "data": {"dir": "x"},
        "gone": 1,
    }
    new = {
        "server": {"host": "b", "https_port": 1},
        "data": {"dir": "x"},
        "added": {"leaf": True},
    }

    assert store.changed_paths(old, new) == ("added.leaf", "gone", "server.host")
    assert store.changed_paths({"a": {"b": 1}}, {"a": 2}) == ("a", "a.b")


# ── 保存：只写 base / 校验 / 冲突 / 只读 / env 锁 ──────────


def test_save_persists_base_only_and_keeps_env_overlay_out_of_file(tmp_path):
    path = tmp_path / "settings.yaml"
    YamlFileProvider(path).save({"data": {"dir": "keep"}})
    overlay = EnvOverlay(env={"AXEUH_SETTINGS__SERVER__HOST": "envhost"})
    store = ConfigStore(ComposedProvider(YamlFileProvider(path), overlay))

    outcome = store.save({"server.port": 9100})

    persisted = YamlFileProvider(path).load()
    assert persisted == {"data": {"dir": "keep"}, "server": {"port": 9100}}
    assert "envhost" not in path.read_text(encoding="utf-8")
    assert store.base_document() == persisted
    assert store.overlay_document() == {"server": {"host": "envhost"}}
    assert store.snapshot()["server"]["host"] == "envhost"
    assert store.snapshot()["data"]["dir"] == "keep"
    assert store.snapshot()["server"]["port"] == 9100
    assert outcome.change.changed_paths == ("server.port",)
    assert outcome.revision == store.revision
    assert outcome.applied == ()
    assert outcome.failed == {}


def test_save_normalizes_nested_changes_to_dotted_paths(tmp_path):
    path = tmp_path / "settings.yaml"
    store = ConfigStore(YamlFileProvider(path))

    outcome = store.save({"server": {"port": 9000}})

    assert store.snapshot()["server"]["port"] == 9000
    assert outcome.change.changed_paths == ("server.port",)
    assert YamlFileProvider(path).load() == {"server": {"port": 9000}}


def test_save_clear_keys_removes_base_value_and_falls_back_to_default(tmp_path):
    path = tmp_path / "settings.yaml"
    YamlFileProvider(path).save({"server": {"port": 9100}})
    store = ConfigStore(YamlFileProvider(path))

    outcome = store.save({}, clear_keys=["server.port"])

    assert YamlFileProvider(path).load().get("server", {}).get("port") is None
    assert store.base_document().get("server", {}).get("port") is None
    assert store.snapshot()["server"]["port"] == 8768
    assert outcome.change.changed_paths == ("server.port",)


@pytest.mark.parametrize(
    ("changes", "expected_code"),
    [
        ({"nope.key": 1}, "unknown_key"),
        ({"server.port": "not-int"}, "type_mismatch"),
        ({"server.port": 80_000}, "out_of_range"),
        ({"ai_backend": "other"}, "enum_invalid"),
    ],
)
def test_save_validation_errors_block_write(tmp_path, changes, expected_code):
    path = tmp_path / "settings.yaml"
    store = ConfigStore(YamlFileProvider(path))

    with pytest.raises(ConfigValidationError) as exc:
        store.save(changes)

    assert isinstance(exc.value, ConfigStoreError)
    assert exc.value.code == "validation_failed"
    assert expected_code in {error.code for error in exc.value.errors}
    assert not path.exists()


def test_save_allows_warning_only_changes(tmp_path):
    path = tmp_path / "settings.yaml"
    store = ConfigStore(YamlFileProvider(path))

    outcome = store.save({"ssl.enabled": True})

    assert path.exists()
    assert outcome.warnings
    assert {warning.severity for warning in outcome.warnings} == {"warning"}
    assert any(warning.path in {"ssl.cert", "ssl.key"} for warning in outcome.warnings)
    assert store.snapshot()["ssl"]["enabled"] is True


def test_save_with_legacy_keys_in_base_is_not_blocked(tmp_path):
    path = tmp_path / "settings.yaml"
    YamlFileProvider(path).save(
        {
            "log": {"level": "INFO"},
            "voiceprint": {"min_snr": 15.0, "min_seg_snr": 1.0},
            "data": {"dir": "keep"},
        }
    )
    store = ConfigStore(YamlFileProvider(path))

    outcome = store.save({"tts.enabled": False})

    persisted = YamlFileProvider(path).load()
    assert persisted["tts"]["enabled"] is False
    assert persisted["log"]["level"] == "INFO"
    assert persisted["voiceprint"]["min_snr"] == 15.0
    assert store.snapshot()["tts"]["enabled"] is False
    assert all(warning.severity == "warning" for warning in outcome.warnings)
    assert any(warning.path == "log.level" for warning in outcome.warnings)


def test_save_clears_existing_legacy_keys(tmp_path):
    path = tmp_path / "settings.yaml"
    YamlFileProvider(path).save(
        {"log": {"level": "INFO"}, "voiceprint": {"min_snr": 15.0}}
    )
    store = ConfigStore(YamlFileProvider(path))

    store.save({}, clear_keys=["log", "voiceprint.min_snr"])

    persisted = YamlFileProvider(path).load()
    assert "log" not in persisted
    assert "min_snr" not in persisted.get("voiceprint", {})


def test_save_stale_expected_revision_conflicts(tmp_path):
    path = tmp_path / "settings.yaml"
    store_a = ConfigStore(YamlFileProvider(path))
    stale = store_a.revision
    store_b = ConfigStore(YamlFileProvider(path))

    store_b.save({"server.host": "first"})

    with pytest.raises(ConfigRevisionConflict) as exc:
        store_a.save({"server.host": "second"}, expected_revision=stale)

    assert exc.value.code == "revision_conflict"
    assert exc.value.current_revision == store_a.revision
    assert YamlFileProvider(path).load()["server"]["host"] == "first"


@pytest.mark.parametrize(
    ("message", "expected_cls", "expected_code"),
    [
        (
            "stale settings revision: expected 'a', current 'b'",
            ConfigRevisionConflict,
            "revision_conflict",
        ),
        ("env overlay is read-only", ConfigReadOnly, "read_only"),
        ("cannot save settings", ConfigWriteError, "write_failed"),
    ],
)
def test_save_maps_provider_errors(message, expected_cls, expected_code):
    provider = FakeProvider(
        {"server": {"host": "seed"}}, save_error=ProviderError(message)
    )
    store = ConfigStore(provider)

    with pytest.raises(expected_cls) as exc:
        store.save({"server.port": 9200})

    assert exc.value.code == expected_code
    assert store.snapshot()["server"]["port"] == 8768


def test_read_only_backend_rejects_save():
    provider = build_provider(
        {
            "AXEUH_CONFIG_BACKEND": "env",
            "AXEUH_SETTINGS__SERVER__HOST": "envhost",
        }
    )
    store = ConfigStore(provider)

    with pytest.raises(ConfigReadOnly) as exc:
        store.save({"server.host": "new"})

    assert exc.value.code == "read_only"


def test_env_locked_paths_rejected_for_changes_and_clears(tmp_path):
    path = tmp_path / "settings.yaml"
    YamlFileProvider(path).save(
        {"server": {"host": "filehost"}, "data": {"dir": "keep"}}
    )
    overlay = EnvOverlay(env={"AXEUH_SETTINGS__SERVER__HOST": "envhost"})
    store = ConfigStore(ComposedProvider(YamlFileProvider(path), overlay))
    before = path.read_bytes()

    with pytest.raises(ConfigEnvLocked) as change_exc:
        store.save({"server": {"host": "new"}})

    assert change_exc.value.code == "env_locked"
    assert change_exc.value.paths == ("server.host",)
    assert all(error.code == "env_locked" for error in change_exc.value.errors)

    with pytest.raises(ConfigEnvLocked) as clear_exc:
        store.save({}, clear_keys=["server.host"])

    assert clear_exc.value.paths == ("server.host",)
    assert path.read_bytes() == before


# ── 应用器 ─────────────────────────────────────────────────


def test_appliers_run_in_order_and_isolate_failures():
    store = ConfigStore(FakeProvider({"server": {"host": "seed"}}))
    calls: list[str] = []

    def first(change: ConfigChange) -> None:
        calls.append(f"first:{change.changed_paths[0]}")

    async def second(change: ConfigChange) -> None:
        calls.append("second:start")
        await asyncio.sleep(0)
        calls.append("second:end")

    def boom(change: ConfigChange) -> None:
        raise RuntimeError("kaput")

    def last(change: ConfigChange) -> None:
        calls.append("last")

    store.register_applier("first", first)
    store.register_applier("second", second)
    store.register_applier("boom", boom)
    store.register_applier("last", last)

    report = asyncio.run(store.apply(ConfigChange({}, {}, ("a",))))

    assert report.applied == ("first", "second", "last")
    assert report.failed == {"boom": "RuntimeError: kaput"}
    assert store.apply_failures == {"boom": "RuntimeError: kaput"}
    assert calls == ["first:a", "second:start", "second:end", "last"]


def test_register_applier_duplicate_requires_replace():
    store = ConfigStore(FakeProvider({"server": {"host": "seed"}}))
    calls: list[str] = []

    store.register_applier("probe", lambda change: calls.append("old"))

    with pytest.raises(ValueError):
        store.register_applier("probe", lambda change: calls.append("duplicate"))

    store.register_applier(
        "probe", lambda change: calls.append("new"), replace=True
    )

    asyncio.run(store.apply(ConfigChange({}, {}, ("a",))))

    assert calls == ["new"]


def test_apply_without_appliers_is_empty():
    store = ConfigStore(FakeProvider({"server": {"host": "seed"}}))

    report = asyncio.run(store.apply(ConfigChange({}, {}, ("a",))))

    assert report.applied == ()
    assert report.failed == {}
    assert store.apply_failures == {}


# ── 外部 watcher ───────────────────────────────────────────


def test_watcher_detects_external_yaml_change_and_applies(tmp_path):
    path = tmp_path / "settings.yaml"
    YamlFileProvider(path).save({"server": {"host": "before"}})
    store = ConfigStore(YamlFileProvider(path), watcher_interval_s=0.05)
    called = threading.Event()
    seen: list[tuple[str, ...]] = []

    def applier(change: ConfigChange) -> None:
        seen.append(change.changed_paths)
        called.set()

    store.register_applier("probe", applier)

    with _running_loop() as loop:
        store.start_watcher(loop, interval_s=0.05)
        try:
            YamlFileProvider(path).save({"server": {"host": "after"}})
            assert called.wait(1.5), "watcher 未在 1.5s 内触发应用器"
        finally:
            store.stop_watcher()
            store.stop_watcher()

    assert store.snapshot()["server"]["host"] == "after"
    assert store.revision == YamlFileProvider(path).revision()
    assert seen == [("server.host",)]


def test_watcher_keeps_snapshot_when_external_file_is_corrupt(tmp_path):
    path = tmp_path / "settings.yaml"
    YamlFileProvider(path).save({"server": {"host": "good"}})
    store = ConfigStore(YamlFileProvider(path), watcher_interval_s=0.05)

    with _running_loop() as loop:
        store.start_watcher(loop, interval_s=0.05)
        try:
            path.write_text("server: [unclosed\n", encoding="utf-8")
            deadline = time.monotonic() + 1.5
            while time.monotonic() < deadline:
                if any(
                    reason.startswith("external_reload_failed:")
                    for reason in store.degraded
                ):
                    break
                time.sleep(0.02)
        finally:
            store.stop_watcher()

    assert store.snapshot()["server"]["host"] == "good"
    assert any(
        reason.startswith("external_reload_failed:") for reason in store.degraded
    )


# ── 进程级单例 ─────────────────────────────────────────────


def test_singleton_lifecycle_uses_injected_provider(monkeypatch):
    monkeypatch.setattr(store_module, "_STORE", None)

    first = reset_config_store(FakeProvider({"server": {"host": "one"}}))

    assert get_config_store() is first
    assert first.snapshot()["server"]["host"] == "one"
    assert is_degraded() is False
    assert degraded_reasons() == []

    second = reset_config_store(FakeProvider({"server": {"host": "two"}}))

    assert second is not first
    assert get_config_store() is second
    assert get_config_store().snapshot()["server"]["host"] == "two"
