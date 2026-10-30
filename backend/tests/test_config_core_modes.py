# -*- coding: utf-8 -*-
"""N04: Config 作为 ConfigStore 的稳定 live facade。

契约：
  1. 无配置文件 / YAML 损坏 / 顶层节类型错误都不再 fail-fast，按默认值降级；
  2. 同一 facade 的属性读取始终反映 ConfigStore 当前快照（热生效）；
  3. get_config() 仍是 lru_cache 单例，cache_clear() 仍可用；
  4. set_config_path() 运行期切换 provider，缺失路径只降级不抛异常；
  5. _resolve_base() 恒为仓库根，配置载体位置不再改变相对路径语义；
  6. Config({...}) 静态模式保留给单测，不读 store、不校验必填项。
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest
import yaml

import config.config as config_module
import config.store as store_module
from config.config import Config, get_config, set_config_path

REPO_ROOT = Path(__file__).resolve().parents[2]
OPENCODE_KEYS = ["default_model", "default_provider", "default_agent"]


def _write_config(path: Path, data: dict) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        yaml.safe_dump(data, allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )
    return path


def _full_opencode() -> dict[str, str]:
    return {
        "default_model": "test-model",
        "default_provider": "test-provider",
        "default_agent": "test-agent",
    }


def _live(path: Path) -> Config:
    set_config_path(str(path))
    get_config.cache_clear()
    return get_config()


@pytest.fixture(autouse=True)
def _restore_config_state():
    """每个用例结束后恢复模块全局路径、环境变量与进程级 store。"""
    module_path = config_module._CONFIG_PATH
    env_snapshot = {
        key: os.environ.get(key)
        for key in ("AXEUH_CONFIG_PATH", "AXEUH_CONFIG_BACKEND")
    }
    get_config.cache_clear()
    yield
    get_config.cache_clear()
    for key, value in env_snapshot.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value
    config_module._CONFIG_PATH = module_path
    store_module.reset_config_store()


# ── 启动降级：缺文件 / 损坏 / 节类型错误 ─────────────────────


def test_missing_config_file_starts_degraded_with_core_defaults(tmp_path):
    missing = tmp_path / "missing.yaml"

    cfg = _live(missing)

    assert cfg.BACKEND_HOST == "0.0.0.0"
    assert cfg.BACKEND_HTTPS_PORT == 8768
    assert cfg.BACKEND_HTTP_PORT == 8768
    assert cfg.DEGRADED is True
    assert cfg.UNCONFIGURED is True
    assert any(reason == "config_missing" for reason in cfg.DEGRADED_REASONS)
    status = cfg.CONFIG_STATUS
    assert status["degraded"] is True
    assert status["revision"].startswith("missing")
    assert Path(status["config_path"]) == missing.resolve()
    assert status["provider"]["kind"] == "yaml"


def test_corrupt_yaml_starts_degraded_without_raising(tmp_path):
    path = tmp_path / "corrupt.yaml"
    path.write_text("server: [unclosed\n", encoding="utf-8")

    cfg = _live(path)

    assert cfg.BACKEND_HOST == "0.0.0.0"
    assert cfg.DEGRADED is True
    assert any(
        reason.startswith("base_load_failed:") for reason in cfg.DEGRADED_REASONS
    )


def test_invalid_top_level_section_types_do_not_crash(tmp_path):
    path = _write_config(tmp_path / "invalid.yaml", {"server": None, "opencode": None})

    cfg = _live(path)

    assert cfg.BACKEND_HOST == "0.0.0.0"
    assert isinstance(cfg.BACKEND_HTTPS_PORT, int)
    assert cfg.OPENCODE_DEFAULT_MODEL == ""
    assert cfg.MISSING_OPENCODE_KEYS == OPENCODE_KEYS
    assert cfg.DEGRADED is True
    assert cfg.UNCONFIGURED is True
    warnings = cfg.CONFIG_WARNINGS
    assert any(
        warning["path"] == "opencode" and warning["severity"] == "warning"
        for warning in warnings
    )
    assert any(
        warning["path"] == "server" and warning["code"] == "type_mismatch"
        for warning in warnings
    )


def test_static_mode_with_invalid_sections_reads_fallbacks():
    cfg = Config({"server": None, "opencode": None})

    assert cfg.BACKEND_HOST == "0.0.0.0"
    assert cfg.OPENCODE_DEFAULT_PROVIDER == ""
    assert cfg.MISSING_OPENCODE_KEYS == OPENCODE_KEYS
    assert cfg.DEGRADED is True


# ── 热读与稳定身份 ───────────────────────────────────────────


def test_live_facade_sees_store_save_immediately(tmp_path):
    path = _write_config(
        tmp_path / "live.yaml",
        {"server": {"port": 9100}, "opencode": _full_opencode()},
    )
    cfg = _live(path)
    store = store_module.get_config_store()
    assert cfg.BACKEND_HTTPS_PORT == 9100

    store.save({"server.port": 9876})

    assert cfg.BACKEND_HTTPS_PORT == 9876
    assert cfg.revision() == store.revision


def test_get_config_is_stable_and_cache_clear_keeps_live_reads(tmp_path):
    path = _write_config(
        tmp_path / "identity.yaml",
        {"server": {"port": 9200}, "opencode": _full_opencode()},
    )
    set_config_path(str(path))
    get_config.cache_clear()

    first = get_config()
    assert get_config() is first

    get_config.cache_clear()
    second = get_config()

    assert second is not first
    assert second.BACKEND_HTTPS_PORT == 9200
    store_module.get_config_store().save({"server.port": 9201})
    assert second.BACKEND_HTTPS_PORT == 9201


def test_set_config_path_switches_provider_at_runtime(tmp_path):
    path_a = _write_config(
        tmp_path / "a.yaml",
        {"server": {"port": 9301}, "opencode": _full_opencode()},
    )
    path_b = _write_config(
        tmp_path / "b.yaml",
        {"server": {"port": 9302}, "opencode": _full_opencode()},
    )
    cfg = _live(path_a)
    assert cfg.BACKEND_HTTPS_PORT == 9301

    set_config_path(str(path_b))

    assert cfg.BACKEND_HTTPS_PORT == 9302
    assert Path(cfg.current_config_path()) == path_b.resolve()
    assert Path(cfg.config_path()) == path_b.resolve()
    assert cfg.provider_info_dict()["location"] == cfg.current_config_path()

    get_config.cache_clear()
    assert get_config().BACKEND_HTTPS_PORT == 9302


def test_set_config_path_accepts_missing_path_without_raising(tmp_path):
    missing = tmp_path / "absent.yaml"

    set_config_path(str(missing))

    cfg = get_config()
    assert cfg.DEGRADED is True
    assert Path(cfg.current_config_path()) == missing.resolve()


# ── 兼容函数语义 ─────────────────────────────────────────────


def test_resolve_base_is_repo_root_regardless_of_config_path(tmp_path):
    assert config_module._resolve_base() == REPO_ROOT

    path = _write_config(
        tmp_path / "elsewhere" / "backend" / "config" / "config.yaml",
        {"server": {"port": 9400}},
    )
    set_config_path(str(path))

    assert config_module._resolve_base() == REPO_ROOT


def test_load_yaml_returns_base_document_without_defaults(tmp_path):
    path = _write_config(
        tmp_path / "base.yaml", {"server": {"port": 9500}}
    )
    set_config_path(str(path))

    base = config_module._load_yaml()

    assert base == {"server": {"port": 9500}}
    assert "data" not in base


def test_load_yaml_does_not_raise_for_missing_or_corrupt(tmp_path):
    set_config_path(str(tmp_path / "missing.yaml"))
    assert config_module._load_yaml() == {}

    corrupt = tmp_path / "corrupt.yaml"
    corrupt.write_text("server: [unclosed\n", encoding="utf-8")
    set_config_path(str(corrupt))
    assert config_module._load_yaml() == {}


# ── 静态模式与状态视图 ───────────────────────────────────────


def test_static_mode_reads_document_and_reports_missing_keys():
    full = Config({"opencode": _full_opencode()})

    assert full.OPENCODE_DEFAULT_MODEL == "test-model"
    assert full.MISSING_OPENCODE_KEYS == []
    assert full.DEGRADED is False
    assert full.UNCONFIGURED is False
    assert full.CONFIG_WARNINGS == []
    assert full.DEGRADED_REASONS == []
    assert full.revision() == "static"
    assert full.provider_info().kind == "static"
    assert full.CONFIG_STATUS["degraded"] is False

    empty = Config({})
    assert empty.MISSING_OPENCODE_KEYS == OPENCODE_KEYS
    assert empty.DEGRADED is True
    assert all(
        reason.startswith("opencode.") for reason in empty.DEGRADED_REASONS
    )


def test_config_status_has_documented_shape(tmp_path):
    path = _write_config(
        tmp_path / "status.yaml",
        {"server": {"port": 9600}, "opencode": _full_opencode()},
    )
    cfg = _live(path)

    status = cfg.CONFIG_STATUS

    assert set(status) == {
        "revision",
        "provider",
        "degraded",
        "warnings",
        "apply_failures",
        "config_path",
    }
    assert set(status["provider"]) == {"kind", "location", "writable", "detail"}
    assert status["revision"] == cfg.revision()
    assert status["config_path"] == cfg.current_config_path()
    assert status["warnings"] == []
    assert status["apply_failures"] == {}
    assert status["degraded"] is False


def test_provider_info_and_dict_agree(tmp_path):
    path = _write_config(
        tmp_path / "provider.yaml",
        {"opencode": _full_opencode()},
    )
    cfg = _live(path)

    info = cfg.provider_info()
    info_dict = cfg.provider_info_dict()

    assert info.kind == "yaml"
    assert isinstance(info.writable, bool)
    assert info_dict == {
        "kind": info.kind,
        "location": info.location,
        "writable": info.writable,
        "detail": info.detail,
    }


def test_masked_config_masks_sensitive_values(tmp_path):
    path = _write_config(
        tmp_path / "masked.yaml",
        {
            "opencode": _full_opencode(),
            "loom": {"token": "loom-token", "url": "http://127.0.0.1:5100"},
            "api": {"mimo_key": "mimo-key"},
            "server": {"host": "127.0.0.1"},
        },
    )
    cfg = _live(path)

    masked = cfg.masked_config()

    assert masked["loom"]["token"] == "***"
    assert masked["api"]["mimo_key"] == "***"
    assert masked["loom"]["url"] == "http://127.0.0.1:5100"
    assert masked["server"]["host"] == "127.0.0.1"
    assert cfg.LOOM_TOKEN == "loom-token"
    assert cfg.MIMO_API_KEY == "mimo-key"

    static_masked = Config(
        {"loom": {"token": "static-token"}, "api": {"mimo_key": "static-key"}}
    ).masked_config()
    assert static_masked["loom"]["token"] == "***"
    assert static_masked["api"]["mimo_key"] == "***"
