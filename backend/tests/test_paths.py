# -*- coding: utf-8 -*-
"""运行时数据根 / 模型根解析：默认位、env 优先级、config 相对路径与 Windows 语义。"""

from __future__ import annotations

from pathlib import Path, PureWindowsPath

import pytest

import config.config as config_module
from config import paths
from config.config import Config


@pytest.fixture(autouse=True)
def _clear_root_env(monkeypatch):
    for key in ("AXEUH_DATA_ROOT", "AXEUH_MODELS_DIR", "AXEUH_PROJECT_ROOT"):
        monkeypatch.delenv(key, raising=False)


def _use_config(monkeypatch, cfg: Config, base: Path | None = None) -> None:
    monkeypatch.setattr(config_module, "get_config", lambda: cfg)
    if base is not None:
        monkeypatch.setattr(config_module, "_resolve_base", lambda: base)


def test_default_roots_live_under_project_var(monkeypatch, tmp_path):
    _use_config(monkeypatch, Config({}))
    project = tmp_path / "project"
    monkeypatch.setenv("AXEUH_PROJECT_ROOT", str(project))

    assert paths.data_root() == (project / "var").resolve()
    assert paths.models_root() == (project / "var" / "models").resolve()


def test_derived_dirs_follow_data_root(monkeypatch, tmp_path):
    data_root = tmp_path / "data-disk"
    monkeypatch.setenv("AXEUH_DATA_ROOT", str(data_root))

    assert paths.secrets_dir() == data_root / "secrets"
    assert paths.runtime_dir() == data_root / "run"
    assert paths.logs_dir() == data_root / "logs"


def test_env_data_root_overrides_config(monkeypatch, tmp_path):
    cfg = Config({"data": {"root": "from-config"}})
    _use_config(monkeypatch, cfg, tmp_path / "project")
    env_root = tmp_path / "env-data"
    monkeypatch.setenv("AXEUH_DATA_ROOT", str(env_root))

    assert paths.data_root() == env_root.resolve()


def test_env_relative_root_resolves_against_project_root(monkeypatch, tmp_path):
    _use_config(monkeypatch, Config({}))
    project = tmp_path / "project"
    monkeypatch.setenv("AXEUH_PROJECT_ROOT", str(project))
    monkeypatch.setenv("AXEUH_DATA_ROOT", "runtime-data")

    assert paths.data_root() == (project / "runtime-data").resolve()


def test_config_data_root_resolves_relative_to_project_root(monkeypatch, tmp_path):
    base = tmp_path / "project"
    _use_config(monkeypatch, Config({"data": {"root": "runtime-data"}}), base)

    assert paths.data_root() == (base / "runtime-data").resolve()


def test_config_absolute_data_root_is_kept(monkeypatch, tmp_path):
    absolute = tmp_path / "absolute-data"
    _use_config(monkeypatch, Config({"data": {"root": str(absolute)}}))

    assert paths.data_root() == absolute.resolve()


def test_models_root_defaults_to_data_root_models(monkeypatch, tmp_path):
    _use_config(monkeypatch, Config({}))
    data_root = tmp_path / "data-disk"
    monkeypatch.setenv("AXEUH_DATA_ROOT", str(data_root))

    assert paths.models_root() == (data_root / "models").resolve()


def test_config_models_dir_resolves_relative_to_project_root(monkeypatch, tmp_path):
    base = tmp_path / "project"
    cfg = Config({"data": {"root": "runtime-data"}, "models": {"dir": "weights"}})
    _use_config(monkeypatch, cfg, base)

    assert paths.models_root() == (base / "weights").resolve()


def test_env_models_dir_overrides_config(monkeypatch, tmp_path):
    cfg = Config({"models": {"dir": "from-config"}})
    _use_config(monkeypatch, cfg, tmp_path / "project")
    env_models = tmp_path / "env-models"
    monkeypatch.setenv("AXEUH_MODELS_DIR", str(env_models))

    assert paths.models_root() == env_models.resolve()


def test_windows_path_semantics_are_platform_aware():
    assert paths._is_absolute_path(r"D:\Kinship\Data", windows=True) is True
    assert paths._is_absolute_path("D:/Kinship/Data", windows=True) is True
    assert paths._is_absolute_path(r"\\nas\share", windows=True) is True
    assert paths._is_absolute_path(r"models\qwen", windows=True) is False
    assert paths._is_absolute_path(r"D:\Kinship\Data", windows=False) is False
    assert paths._is_absolute_path("/mnt/data", windows=False) is True


class _FakeWindowsPath:
    def __init__(self, value: str | PureWindowsPath) -> None:
        self._value = PureWindowsPath(value)

    def expanduser(self) -> "_FakeWindowsPath":
        return self

    def is_absolute(self) -> bool:
        return self._value.is_absolute()

    def resolve(self) -> "_FakeWindowsPath":
        return self

    def __truediv__(self, child: str) -> "_FakeWindowsPath":
        return _FakeWindowsPath(self._value / child)

    def __str__(self) -> str:
        return str(self._value)


def test_default_roots_use_windows_drive_when_host_is_windows(monkeypatch):
    _use_config(monkeypatch, Config({}))
    monkeypatch.setattr(paths, "Path", _FakeWindowsPath)
    monkeypatch.setattr(paths, "project_root", lambda: _FakeWindowsPath("C:/project"))

    assert str(paths.data_root()) == r"C:\project\var"
    assert str(paths.models_root()) == r"C:\project\var\models"
