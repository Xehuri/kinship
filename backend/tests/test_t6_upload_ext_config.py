# -*- coding: utf-8 -*-
"""T6: audio.store.upload_ext 配置键 loader 测试。

契约:
  1. DEFAULT_AUDIO_CONFIG 含 store.upload_ext="wav"（内置默认）;
  2. get_upload_ext() 缺省返回 "wav";
  3. 非法值（ogg/mp3/空）一律回退 "wav"（fail-safe）;
  4. 合法值 "flac" 原样返回;
  5. config.example.yaml 模板含 audio.store.upload_ext 键（防漂移）。
"""

import copy
import os

import pytest

import services.audio_config as ac


@pytest.fixture(autouse=True)
def _reset_cache():
    """每个测试前清进程缓存，测完还原（防污染同进程后续测试）。"""
    old = ac._config_cache
    ac._config_cache = None
    yield
    ac._config_cache = old


def test_default_store_section_exists():
    """内置默认含 store.upload_ext=wav。"""
    store = ac.DEFAULT_AUDIO_CONFIG.get("store")
    assert store is not None, "DEFAULT_AUDIO_CONFIG 须含 store 节"
    assert store.get("upload_ext") == "wav"


def test_get_upload_ext_default_wav(monkeypatch):
    """无文件覆盖时 get_upload_ext 返回 wav。"""
    monkeypatch.setattr(ac, "_build_audio_config", lambda: copy.deepcopy(ac.DEFAULT_AUDIO_CONFIG))
    assert ac.get_upload_ext() == "wav"


def test_get_upload_ext_flac_passthrough():
    """合法 flac 原样返回。"""
    ac._config_cache = {"store": {"upload_ext": "flac"}}
    assert ac.get_upload_ext() == "flac"


@pytest.mark.parametrize("bad", ["ogg", "mp3", "", "WAV", "Flac", None, 123])
def test_get_upload_ext_invalid_falls_back_wav(bad):
    """非法值（含大小写、None、非字符串）一律回退 wav。"""
    ac._config_cache = {"store": {"upload_ext": bad}}
    assert ac.get_upload_ext() == "wav"


def test_get_upload_ext_missing_store_section():
    """store 节整体缺失也回退 wav。"""
    ac._config_cache = {}
    assert ac.get_upload_ext() == "wav"


def test_config_example_has_upload_ext():
    """config.example.yaml 模板含 audio.store.upload_ext 键（防模板漂移）。"""
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    path = os.path.join(root, "config.example.yaml")
    assert os.path.isfile(path), "config.example.yaml 不存在"
    with open(path, encoding="utf-8") as f:
        text = f.read()
    assert "upload_ext:" in text, "config.example.yaml 须含 upload_ext 键"


def test_deep_merge_store_override():
    """文件覆盖 store 节经 _deep_merge 生效且不丢默认结构。"""
    merged = ac._deep_merge(
        copy.deepcopy(ac.DEFAULT_AUDIO_CONFIG),
        {"store": {"upload_ext": "flac"}},
    )
    assert merged["store"]["upload_ext"] == "flac"
    # 其余节不受影响
    assert "stream" in merged and "vad" in merged
