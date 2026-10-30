# -*- coding: utf-8 -*-
"""N06 配置热重载钩子：AI 客户端 / TTS / 音频配置缓存 / 事件 hub。

钉住契约：
  (a) opencode reload_static_config 从 get_config() 重新快照模块全局，清空
      端口探测/认证告警/模型排除缓存并重置客户端单例；
  (b) loom reload_static_config 重新快照 LOOM_URL，默认 agent/model/provider
      跟随 opencode 模块的实时全局，token 保持每次现读；
  (c) TTS reset 先 best-effort stop 旧实例再丢弃单例；
  (d) audio / unknown_speaker 配置缓存失效后按 ConfigStore 新快照重建；
  (e) reload_event_hubs 委派 teardown-all。

零触网、零真实配置读取：get_config 全部打桩，事件 reset 用异步假函数。
本 venv 无 pytest-asyncio，统一 asyncio.run 同步驱动（test_events_dual_hub 先例）。
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest

import routers.events as events
import services.audio_config as audio_config
import services.loom_client as loom_client
import services.opencode_client as opencode_client
import services.tts_player as tts_player
import services.unknown_speaker_config as unknown_speaker_config

_OPENCODE_STATE = (
    "_cfg",
    "OPENCODE_CONFIG_URL",
    "OPENCODE_BASE_URL",
    "OPENCODE_DEFAULT_DIRECTORY",
    "OPENCODE_DEFAULT_AGENT",
    "OPENCODE_DEFAULT_MODEL",
    "OPENCODE_DEFAULT_PROVIDER",
    "_OPENCODE_DISCOVERED_URL",
    "_auth_warned",
    "_model_config_excluded",
    "_model_config_loaded",
    "_model_config_data",
    "_opencode_client",
    "_offline_client",
)
_LOOM_STATE = (
    "_cfg",
    "LOOM_CONFIG_URL",
    "OPENCODE_DEFAULT_AGENT",
    "OPENCODE_DEFAULT_MODEL",
    "OPENCODE_DEFAULT_PROVIDER",
    "_loom_client",
    "_offline_client",
    "_token_warned",
)


@pytest.fixture(autouse=True)
def _restore_ai_module_globals():
    """reload 钩子会原地重写模块全局；测试结束必须还原，避免污染后续用例。"""
    saved_opencode = {
        name: getattr(opencode_client, name) for name in _OPENCODE_STATE
    }
    saved_loom = {name: getattr(loom_client, name) for name in _LOOM_STATE}
    yield
    for name, value in saved_opencode.items():
        setattr(opencode_client, name, value)
    for name, value in saved_loom.items():
        setattr(loom_client, name, value)


class _FakeConfig:
    """只承载钩子会读取的属性面，避免任何真实 config.yaml 依赖。"""

    def __init__(self, **values):
        for key, value in values.items():
            setattr(self, key, value)


def _opencode_fake_config():
    return _FakeConfig(
        OPENCODE_URL="http://127.0.0.1:7101",
        OPENCODE_DIRECTORY="/tmp/hot-reload/ai",
        OPENCODE_DEFAULT_AGENT="hot-agent",
        OPENCODE_DEFAULT_MODEL="hot-model",
        OPENCODE_DEFAULT_PROVIDER="hot-provider",
        OPENCODE_SERVER_USERNAME="hot-user",
        OPENCODE_SERVER_PASSWORD="hot-pass",
    )


def test_reload_static_config_resnapshots_opencode_globals(monkeypatch):
    fake = _opencode_fake_config()
    monkeypatch.setattr(opencode_client, "get_config", lambda: fake)

    calls = []
    real_reset_model_cache = opencode_client.reset_model_config_cache

    def spy_reset_model_cache():
        calls.append("model_cache")
        real_reset_model_cache()

    real_reset_client = opencode_client._reset_opencode_client

    def spy_reset_client():
        calls.append("client")
        real_reset_client()

    monkeypatch.setattr(opencode_client, "reset_model_config_cache", spy_reset_model_cache)
    monkeypatch.setattr(opencode_client, "_reset_opencode_client", spy_reset_client)

    monkeypatch.setattr(opencode_client, "_OPENCODE_DISCOVERED_URL", "http://127.0.0.1:9999")
    monkeypatch.setattr(opencode_client, "_auth_warned", True)
    monkeypatch.setattr(opencode_client, "_model_config_excluded", ["stale/*"])
    monkeypatch.setattr(opencode_client, "_model_config_loaded", True)
    monkeypatch.setattr(opencode_client, "_model_config_data", {"stale": True})
    monkeypatch.setattr(opencode_client, "_opencode_client", object())
    monkeypatch.setattr(opencode_client, "_offline_client", object())

    opencode_client.reload_static_config()

    assert opencode_client.OPENCODE_CONFIG_URL == fake.OPENCODE_URL
    assert opencode_client.OPENCODE_BASE_URL == fake.OPENCODE_URL
    assert opencode_client.OPENCODE_DEFAULT_DIRECTORY == fake.OPENCODE_DIRECTORY
    assert opencode_client.OPENCODE_DEFAULT_AGENT == fake.OPENCODE_DEFAULT_AGENT
    assert opencode_client.OPENCODE_DEFAULT_MODEL == fake.OPENCODE_DEFAULT_MODEL
    assert opencode_client.OPENCODE_DEFAULT_PROVIDER == fake.OPENCODE_DEFAULT_PROVIDER
    assert opencode_client._OPENCODE_DISCOVERED_URL is None
    assert opencode_client._auth_warned is False
    assert opencode_client._model_config_excluded == []
    assert opencode_client._model_config_loaded is False
    assert opencode_client._model_config_data is None
    assert calls == ["model_cache", "client"]
    assert opencode_client._opencode_client is None
    assert opencode_client._offline_client is None
    # 新密码经 _cfg 快照立即生效（未重载时仍读旧 _cfg）
    assert opencode_client._basic_auth_value().startswith("Basic ")


def test_reload_static_config_resnapshots_loom_from_opencode_module(monkeypatch):
    fake = _FakeConfig(
        LOOM_URL="http://127.0.0.1:7102",
        OPENCODE_DIRECTORY="/tmp/hot-reload/ai",
        LOOM_TOKEN="hot-token",
    )
    monkeypatch.setattr(loom_client, "get_config", lambda: fake)
    monkeypatch.setattr(opencode_client, "OPENCODE_DEFAULT_AGENT", "fresh-agent")
    monkeypatch.setattr(opencode_client, "OPENCODE_DEFAULT_MODEL", "fresh-model")
    monkeypatch.setattr(opencode_client, "OPENCODE_DEFAULT_PROVIDER", "fresh-provider")
    monkeypatch.setattr(loom_client, "_loom_client", object())
    monkeypatch.setattr(loom_client, "_offline_client", object())

    loom_client.reload_static_config()

    assert loom_client.LOOM_CONFIG_URL == fake.LOOM_URL
    assert loom_client.OPENCODE_DEFAULT_AGENT == "fresh-agent"
    assert loom_client.OPENCODE_DEFAULT_MODEL == "fresh-model"
    assert loom_client.OPENCODE_DEFAULT_PROVIDER == "fresh-provider"
    assert loom_client._loom_client is None
    assert loom_client._offline_client is None
    # token 不参与快照，每次现读 get_config()
    assert loom_client._bearer_token() == "hot-token"


class _FakeTTSPlayer:
    """stop() 计数器桩，零真实播放。"""

    def __init__(self, error=None):
        self.stop_calls = 0
        self._error = error

    def stop(self):
        self.stop_calls += 1
        if self._error is not None:
            raise self._error


def test_reset_tts_player_stops_instance_and_drops_singleton(monkeypatch):
    fake = _FakeTTSPlayer()
    monkeypatch.setattr(tts_player, "_tts_player", fake)

    tts_player.reset_tts_player()

    assert fake.stop_calls == 1
    assert tts_player._tts_player is None


def test_reset_tts_player_survives_stop_failure(monkeypatch):
    fake = _FakeTTSPlayer(error=RuntimeError("stop boom"))
    monkeypatch.setattr(tts_player, "_tts_player", fake)

    tts_player.reset_tts_player()

    assert fake.stop_calls == 1
    assert tts_player._tts_player is None


def test_invalidate_audio_config_clears_cache_and_rereads_snapshot(monkeypatch):
    monkeypatch.setattr(audio_config, "_config_cache", {"sentinel": True})
    monkeypatch.setattr(audio_config, "_config_logged", True)

    audio_config.invalidate_audio_config()

    assert audio_config._config_cache is None
    assert audio_config._config_logged is False

    fake = _FakeConfig(_data={"audio": {"store": {"upload_ext": "flac"}}})
    monkeypatch.setattr(audio_config, "get_config", lambda: fake)

    loaded = audio_config.get_audio_config()

    assert loaded["store"]["upload_ext"] == "flac"
    assert audio_config._config_cache is not None
    assert audio_config._config_logged is True


def test_invalidate_unknown_speaker_config_clears_cache(monkeypatch):
    monkeypatch.setattr(unknown_speaker_config, "_config_cache", {"sentinel": True})
    monkeypatch.setattr(unknown_speaker_config, "_config_logged", True)

    unknown_speaker_config.invalidate_unknown_speaker_config()

    assert unknown_speaker_config._config_cache is None
    assert unknown_speaker_config._config_logged is False


def test_reload_event_hubs_delegates_to_reset(monkeypatch):
    calls = []

    async def fake_reset_event_hub():
        calls.append("reset")

    monkeypatch.setattr(events, "reset_event_hub", fake_reset_event_hub)

    asyncio.run(events.reload_event_hubs())

    assert calls == ["reset"]
