# -*- coding: utf-8 -*-
"""config.providers 契约：YAML/JSON/SQLite/env 覆盖层/composed/启动选择。

约束：全部用例走 tmp_path；真实仓库 config.yaml 只做 mtime 守卫，绝不读写。
"""

from __future__ import annotations

import json
import stat
from pathlib import Path
from typing import Any

import pytest
import yaml

from config.providers import (
    PROVIDER_ENV_KEYS,
    ComposedProvider,
    EnvOverlay,
    JsonFileProvider,
    ProviderError,
    SqliteProvider,
    YamlFileProvider,
    build_provider,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
REPO_CONFIG = REPO_ROOT / "config.yaml"
FILE_PROVIDERS = (YamlFileProvider, JsonFileProvider)
YAML_MARK = "settings.yaml"
JSON_MARK = "settings.json"


def _mode(path: Path) -> int:
    return stat.S_IMODE(path.stat().st_mode)


def _fingerprint(path: Path) -> tuple[int, int] | None:
    try:
        st = path.stat()
    except FileNotFoundError:
        return None
    return (st.st_mtime_ns, st.st_size)


def _file_name(provider_cls: type) -> str:
    return YAML_MARK if provider_cls is YamlFileProvider else JSON_MARK


def _read_backup(path: Path, provider_cls: type) -> Any:
    text = path.read_text(encoding="utf-8")
    if provider_cls is YamlFileProvider:
        return yaml.safe_load(text)
    return json.loads(text)


@pytest.fixture(scope="module", autouse=True)
def _repo_config_guard():
    before = _fingerprint(REPO_CONFIG)
    yield
    assert _fingerprint(REPO_CONFIG) == before, "测试不得触碰仓库根 config.yaml"


# ── 文件 provider：YAML / JSON ──────────────────────────────


@pytest.mark.parametrize("provider_cls", FILE_PROVIDERS)
def test_file_roundtrip(tmp_path, provider_cls):
    path = tmp_path / _file_name(provider_cls)
    provider = provider_cls(path)
    document = {
        "server": {"host": "127.0.0.1", "port": 8768},
        "features": {"enabled": True, "names": ["小贺", "a"], "ratio": 0.5},
        "note": "中文值",
    }

    revision = provider.save(document)

    assert provider.load() == document
    assert provider.revision() == revision
    assert revision != "missing"
    assert _mode(path) == 0o600


@pytest.mark.parametrize("provider_cls", FILE_PROVIDERS)
def test_file_missing_returns_empty(tmp_path, provider_cls):
    provider = provider_cls(tmp_path / _file_name(provider_cls))

    assert provider.load() == {}
    assert provider.revision() == "missing"


@pytest.mark.parametrize("provider_cls", FILE_PROVIDERS)
def test_file_empty_returns_empty(tmp_path, provider_cls):
    path = tmp_path / _file_name(provider_cls)
    path.write_text("", encoding="utf-8")
    provider = provider_cls(path)

    assert provider.load() == {}
    assert provider.revision() != "missing"


@pytest.mark.parametrize(
    ("provider_cls", "payload"),
    [
        (YamlFileProvider, "server: [unclosed\n"),
        (JsonFileProvider, "{not-json"),
    ],
)
def test_file_invalid_content_raises_provider_error(tmp_path, provider_cls, payload):
    path = tmp_path / _file_name(provider_cls)
    path.write_text(payload, encoding="utf-8")

    with pytest.raises(ProviderError):
        provider_cls(path).load()


@pytest.mark.parametrize(
    ("provider_cls", "payload"),
    [
        (YamlFileProvider, "- a\n- b\n"),
        (JsonFileProvider, "[1, 2]"),
    ],
)
def test_file_non_mapping_raises_provider_error(tmp_path, provider_cls, payload):
    path = tmp_path / _file_name(provider_cls)
    path.write_text(payload, encoding="utf-8")

    with pytest.raises(ProviderError):
        provider_cls(path).load()


@pytest.mark.parametrize("provider_cls", FILE_PROVIDERS)
def test_file_load_returns_deep_copy(tmp_path, provider_cls):
    provider = provider_cls(tmp_path / _file_name(provider_cls))
    provider.save({"server": {"host": "base"}})

    loaded = provider.load()
    loaded["server"]["host"] = "mutated"

    assert provider.load() == {"server": {"host": "base"}}


@pytest.mark.parametrize("provider_cls", FILE_PROVIDERS)
def test_file_save_creates_backup_and_0600_files(tmp_path, provider_cls):
    name = _file_name(provider_cls)
    path = tmp_path / name
    provider = provider_cls(path)

    provider.save({"version": 1})
    provider.save({"version": 2})

    backups = sorted(tmp_path.glob(f"{name}.bak-*"))
    assert len(backups) == 1
    assert _mode(backups[0]) == 0o600
    assert _read_backup(backups[0], provider_cls) == {"version": 1}
    assert _mode(path) == 0o600


def test_yaml_save_preserves_key_order_and_unicode(tmp_path):
    path = tmp_path / "order.yaml"
    YamlFileProvider(path).save({"z_first": "中文", "a_second": 1})

    text = path.read_text(encoding="utf-8")
    assert '"' not in text.splitlines()[0]
    assert text.index("z_first:") < text.index("a_second:")
    assert "中文" in text


def test_json_save_preserves_key_order_and_unicode(tmp_path):
    path = tmp_path / "order.json"
    JsonFileProvider(path).save({"z_first": "中文", "a_second": 1})

    text = path.read_text(encoding="utf-8")
    assert text.index('"z_first"') < text.index('"a_second"')
    assert "中文" in text


@pytest.mark.parametrize("provider_cls", FILE_PROVIDERS)
def test_file_stale_expected_revision_rejected(tmp_path, provider_cls):
    provider = provider_cls(tmp_path / _file_name(provider_cls))
    revision = provider.save({"version": 1})

    with pytest.raises(ProviderError):
        provider.save({"version": 2}, expected_revision="stale-revision")

    assert provider.load() == {"version": 1}
    assert provider.revision() == revision
    assert provider.save({"version": 2}, expected_revision=revision) != revision


@pytest.mark.parametrize("provider_cls", FILE_PROVIDERS)
def test_file_symlink_target_rejected_on_save(tmp_path, provider_cls):
    target = tmp_path / f"real-{_file_name(provider_cls)}"
    provider_cls(target).save({"version": 1})
    link = tmp_path / f"link-{_file_name(provider_cls)}"
    link.symlink_to(target)

    with pytest.raises(ProviderError):
        provider_cls(link).save({"version": 2})

    assert provider_cls(target).load() == {"version": 1}


@pytest.mark.parametrize("provider_cls", FILE_PROVIDERS)
def test_file_describe_is_absolute_and_writable(tmp_path, provider_cls):
    provider = provider_cls(tmp_path / _file_name(provider_cls))
    info = provider.describe()

    assert info.kind == ("yaml" if provider_cls is YamlFileProvider else "json")
    assert info.location == str((tmp_path / _file_name(provider_cls)).resolve())
    assert info.writable is True


# ── SQLite provider ───────────────────────────────────────


def test_sqlite_missing_returns_empty_without_creating(tmp_path):
    db = tmp_path / "settings.db"
    provider = SqliteProvider(db)

    assert provider.load() == {}
    assert provider.revision() == "missing"
    assert not db.exists()


def test_sqlite_roundtrip_nested_and_revision(tmp_path):
    db = tmp_path / "settings.db"
    provider = SqliteProvider(db)
    document = {
        "server": {
            "host": "127.0.0.1",
            "port": 8768,
            "tags": ["a", "b"],
            "enabled": True,
            "ratio": 0.5,
            "empty": {},
        },
        "nothing": None,
        "note": "中文值",
    }

    assert provider.save(document) == "1"
    assert provider.load() == document
    assert provider.revision() == "1"
    assert _mode(db) == 0o600

    assert provider.save({"server": {"port": 9000}}) == "2"
    assert provider.revision() == "2"
    assert provider.load() == {"server": {"port": 9000}}


def test_sqlite_stale_revision_rejected(tmp_path):
    provider = SqliteProvider(tmp_path / "settings.db")
    provider.save({"version": 1})
    revision = provider.save({"version": 2})

    with pytest.raises(ProviderError):
        provider.save({"version": 3}, expected_revision="1")

    assert provider.load() == {"version": 2}
    assert provider.revision() == revision


def test_sqlite_expected_missing_allows_first_save(tmp_path):
    provider = SqliteProvider(tmp_path / "settings.db")

    assert provider.save({"a": 1}, expected_revision="missing") == "1"


def test_sqlite_invalid_database_raises(tmp_path):
    db = tmp_path / "broken.db"
    db.write_bytes(b"not a sqlite database" * 64)
    provider = SqliteProvider(db)

    with pytest.raises(ProviderError):
        provider.load()
    with pytest.raises(ProviderError):
        provider.revision()


def test_sqlite_dotted_key_rejected_without_creating(tmp_path):
    db = tmp_path / "settings.db"
    provider = SqliteProvider(db)

    with pytest.raises(ProviderError):
        provider.save({"server.host": "127.0.0.1"})

    assert not db.exists()


def test_sqlite_describe(tmp_path):
    provider = SqliteProvider(tmp_path / "settings.db")
    info = provider.describe()

    assert info.kind == "sqlite"
    assert info.location == str((tmp_path / "settings.db").resolve())
    assert info.writable is True


# ── Env overlay ──────────────────────────────────────────


def _env_overlay() -> EnvOverlay:
    return EnvOverlay(
        env={
            "AXEUH_SETTINGS__SERVER__HOST": "127.0.0.1",
            "AXEUH_SETTINGS__SERVER__PORT": "8768",
            "AXEUH_SETTINGS__FEATURES__ENABLED": "true",
            "AXEUH_SETTINGS__FEATURES__DISABLED": "false",
            "AXEUH_SETTINGS__FEATURES__LIST": "[1, 2]",
            "AXEUH_SETTINGS__FEATURES__LABEL": "hello world",
            "AXEUH_SETTINGS__FEATURES__NOTHING": "null",
            "AXEUH_SETTINGS__DEEP__A__B": "deep",
            "UNRELATED": "ignored",
        }
    )


def test_env_overlay_builds_nested_document_with_coercion():
    assert _env_overlay().load() == {
        "server": {"host": "127.0.0.1", "port": 8768},
        "features": {
            "enabled": True,
            "disabled": False,
            "list": [1, 2],
            "label": "hello world",
            "nothing": None,
        },
        "deep": {"a": {"b": "deep"}},
    }


def test_env_overlay_custom_prefix():
    overlay = EnvOverlay(prefix="CUSTOM__", env={"CUSTOM__A__B": "1", "AXEUH_SETTINGS__A__B": "2"})

    assert overlay.load() == {"a": {"b": 1}}


def test_env_overlay_is_read_only():
    overlay = _env_overlay()

    with pytest.raises(ProviderError, match="read-only"):
        overlay.save({"a": 1})

    info = overlay.describe()
    assert info.kind == "env"
    assert info.writable is False
    assert info.location.startswith("env:")


def test_env_overlay_revision_tracks_relevant_pairs():
    baseline = EnvOverlay(prefix="P__", env={"P__A": "1"}).revision()

    assert baseline == EnvOverlay(prefix="P__", env={"P__A": "1"}).revision()
    assert baseline == EnvOverlay(prefix="P__", env={"P__A": "1", "OTHER": "x"}).revision()
    assert baseline != EnvOverlay(prefix="P__", env={"P__A": "2"}).revision()


# ── Composed provider ────────────────────────────────────


def test_composed_overlay_wins_and_merges_nested(tmp_path):
    path = tmp_path / "settings.yaml"
    base = YamlFileProvider(path)
    base.save({"server": {"host": "base", "port": 1}, "keep": True})
    overlay = EnvOverlay(env={"AXEUH_SETTINGS__SERVER__HOST": "overlay"})
    provider = ComposedProvider(base, overlay)

    assert provider.load() == {"server": {"host": "overlay", "port": 1}, "keep": True}


def test_composed_save_delegates_to_base_only(tmp_path):
    path = tmp_path / "settings.yaml"
    base = YamlFileProvider(path)
    overlay = EnvOverlay(env={"AXEUH_SETTINGS__SERVER__HOST": "overlay"})
    provider = ComposedProvider(base, overlay)

    merged = {"server": {"host": "overlay", "port": 2}, "keep": True}
    revision = provider.save(merged)

    assert base.load() == merged
    assert revision == base.revision()
    assert provider.revision() == f"{base.revision()}+{overlay.revision()}"


def test_composed_stale_revision_reaches_base(tmp_path):
    base = YamlFileProvider(tmp_path / "settings.yaml")
    base.save({"version": 1})
    provider = ComposedProvider(base, EnvOverlay(env={}))

    with pytest.raises(ProviderError):
        provider.save({"version": 2}, expected_revision="stale")


def test_composed_describe_includes_both(tmp_path):
    base = YamlFileProvider(tmp_path / "settings.yaml")
    provider = ComposedProvider(base, EnvOverlay(env={"AXEUH_SETTINGS__A": "1"}))
    info = provider.describe()

    assert info.kind == "yaml"
    assert str((tmp_path / "settings.yaml").resolve()) in info.detail
    assert "env:" in info.detail


# ── build_provider 启动选择 ───────────────────────────────


def test_provider_env_keys_exported():
    assert "AXEUH_CONFIG_BACKEND" in PROVIDER_ENV_KEYS
    assert "AXEUH_CONFIG_PATH" in PROVIDER_ENV_KEYS
    assert "AXEUH_CONFIG_SQLITE_PATH" in PROVIDER_ENV_KEYS


def test_build_provider_explicit_yaml_applies_env_overlay(tmp_path):
    path = tmp_path / "settings.yaml"
    path.write_text("server:\n  host: base\n", encoding="utf-8")

    provider = build_provider(
        {
            "AXEUH_CONFIG_BACKEND": "yaml",
            "AXEUH_CONFIG_PATH": str(path),
            "AXEUH_SETTINGS__SERVER__HOST": "overlay",
        }
    )

    assert isinstance(provider, ComposedProvider)
    assert provider.describe().kind == "yaml"
    assert provider.load()["server"]["host"] == "overlay"


def test_build_provider_explicit_json(tmp_path):
    path = tmp_path / "settings.json"
    path.write_text('{"server": {"host": "base"}}', encoding="utf-8")

    provider = build_provider(
        {"AXEUH_CONFIG_BACKEND": "json", "AXEUH_CONFIG_PATH": str(path)}
    )

    assert provider.describe().kind == "json"
    assert provider.load() == {"server": {"host": "base"}}


def test_build_provider_auto_json_path(tmp_path):
    path = tmp_path / "settings.json"
    path.write_text("{}", encoding="utf-8")

    provider = build_provider({"AXEUH_CONFIG_PATH": str(path)})

    assert provider.describe().kind == "json"


def test_build_provider_sqlite(tmp_path):
    db = tmp_path / "settings.db"
    provider = build_provider(
        {
            "AXEUH_CONFIG_BACKEND": "sqlite",
            "AXEUH_CONFIG_SQLITE_PATH": str(db),
            "AXEUH_SETTINGS__SERVER__PORT": "9000",
        }
    )

    assert provider.describe().kind == "sqlite"
    provider.save({"server": {"port": 8768}})
    assert provider.load() == {"server": {"port": 9000}}
    assert SqliteProvider(db).revision() == "1"


def test_build_provider_auto_sqlite_when_only_sqlite_path_set(tmp_path):
    provider = build_provider({"AXEUH_CONFIG_SQLITE_PATH": str(tmp_path / "settings.db")})

    assert provider.describe().kind == "sqlite"


def test_build_provider_env_backend_is_read_only(tmp_path):
    provider = build_provider(
        {
            "AXEUH_CONFIG_BACKEND": "env",
            "AXEUH_CONFIG_PATH": str(tmp_path / "ignored.yaml"),
            "AXEUH_SETTINGS__SERVER__HOST": "envhost",
        }
    )

    assert provider.describe().writable is False
    assert provider.load() == {"server": {"host": "envhost"}}
    with pytest.raises(ProviderError, match="read-only"):
        provider.save({"server": {"host": "other"}})
    assert not (tmp_path / "ignored.yaml").exists()


def test_build_provider_rejects_unknown_backend():
    with pytest.raises(ProviderError):
        build_provider({"AXEUH_CONFIG_BACKEND": "toml"})


def test_build_provider_default_does_not_touch_repo_config():
    before = _fingerprint(REPO_CONFIG)

    provider = build_provider({})
    info = provider.describe()

    assert info.kind == "yaml"
    assert info.location.endswith("config.yaml")
    assert _fingerprint(REPO_CONFIG) == before
