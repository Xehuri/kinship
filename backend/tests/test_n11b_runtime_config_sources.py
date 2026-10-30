# -*- coding: utf-8 -*-
"""N11b：运行期配置读取统一走 ConfigStore live 快照。

钉住契约：
  (a) audio_config 从 ``get_config()._data`` 的 audio / tts 小节深合并内置默认，
      不读取任何配置载体文件；
  (b) unknown_speaker_config 同样只读 live 快照；
  (c) 两个缓存失效钩子后，切换快照内容立即反映到下一次读取；
  (d) get_config 不可用时回落内置默认且不抛异常；
  (e) health_cloud.apply_credentials 经 ConfigStore.save 写点分键，不直写
      config.yaml，并保留 source 失效与运行时状态更新。

全部用例用内存 fake，不读/写仓库 config.yaml。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import services.audio_config as audio_config
import services.health_cloud_service as hcs
import services.unknown_speaker_config as unknown_speaker_config
from config.store import ConfigValidationError


_REPO_CONFIG = Path(__file__).resolve().parents[2] / "config.yaml"


def _config_fingerprint() -> tuple[int, int] | None:
    try:
        stat = _REPO_CONFIG.stat()
    except FileNotFoundError:
        return None
    return (stat.st_mtime_ns, stat.st_size)


@pytest.fixture(autouse=True)
def _repo_config_guard():
    before = _config_fingerprint()
    yield
    assert _config_fingerprint() == before, "测试不得写入仓库 config.yaml"


class _FakeConfig:
    """只承载 ``_data`` 的 live facade 替身。"""

    HEALTH_CLOUD_REGION = "cn"

    def __init__(self, data: dict) -> None:
        self._data = data


class _InlineThread:
    """同步执行 target 的 Thread 替身，避免首次拉取线程带来竞态。"""

    def __init__(self, target=None, name=None, daemon=None) -> None:
        self._target = target

    def start(self) -> None:
        if self._target is not None:
            self._target()


@pytest.fixture(autouse=True)
def _reset_config_caches():
    audio_config.invalidate_audio_config()
    unknown_speaker_config.invalidate_unknown_speaker_config()
    yield
    audio_config.invalidate_audio_config()
    unknown_speaker_config.invalidate_unknown_speaker_config()


# ── audio_config ─────────────────────────────────────────


def test_audio_config_reads_audio_and_tts_from_live_snapshot(monkeypatch):
    fake = _FakeConfig(
        {
            "audio": {
                "store": {"upload_ext": "flac"},
                "stream": {"queue_maxsize": 7},
            },
            "tts": {"enabled": False},
        }
    )
    monkeypatch.setattr(audio_config, "get_config", lambda: fake)

    cfg = audio_config.get_audio_config()

    assert cfg["store"]["upload_ext"] == "flac"
    assert cfg["stream"]["queue_maxsize"] == 7
    # 未覆盖的默认值保持不变
    assert cfg["stream"]["sample_rate"] == 16000
    assert cfg["tts"]["enabled"] is False
    assert cfg["tts"]["device_channel_ttl_seconds"] == 3600
    # 兼容别名与顶层键一致
    assert cfg["audio"]["store"]["upload_ext"] == "flac"


def test_audio_config_switches_after_invalidation(monkeypatch):
    fake = _FakeConfig({"audio": {"store": {"upload_ext": "flac"}}})
    monkeypatch.setattr(audio_config, "get_config", lambda: fake)

    assert audio_config.get_audio_config()["store"]["upload_ext"] == "flac"

    fake._data = {"audio": {"store": {"upload_ext": "wav"}}}
    # 缓存未失效：仍返回旧快照
    assert audio_config.get_audio_config()["store"]["upload_ext"] == "flac"

    audio_config.invalidate_audio_config()

    assert audio_config.get_audio_config()["store"]["upload_ext"] == "wav"


def test_audio_config_falls_back_to_defaults_when_get_config_fails(monkeypatch):
    def _boom():
        raise RuntimeError("store unavailable")

    monkeypatch.setattr(audio_config, "get_config", _boom)

    cfg = audio_config.get_audio_config()

    assert cfg["store"]["upload_ext"] == "wav"
    assert cfg["stream"]["sample_rate"] == 16000


# ── unknown_speaker_config ───────────────────────────────


def test_unknown_speaker_reads_live_snapshot_and_deep_merges(monkeypatch):
    fake = _FakeConfig(
        {
            "unknown_speaker": {
                "enabled": True,
                "detection": {"min_tokens": 9},
            }
        }
    )
    monkeypatch.setattr(
        unknown_speaker_config, "get_config", lambda: fake
    )

    cfg = unknown_speaker_config.get_unknown_speaker_config()

    assert cfg["enabled"] is True
    assert cfg["detection"]["min_tokens"] == 9
    assert cfg["detection"]["max_vp_score"] == 0.30


def test_unknown_speaker_switches_after_invalidation(monkeypatch):
    fake = _FakeConfig({"unknown_speaker": {"enabled": True}})
    monkeypatch.setattr(
        unknown_speaker_config, "get_config", lambda: fake
    )

    assert unknown_speaker_config.get_unknown_speaker_config()["enabled"] is True

    fake._data = {"unknown_speaker": {"enabled": False}}
    assert unknown_speaker_config.get_unknown_speaker_config()["enabled"] is True

    unknown_speaker_config.invalidate_unknown_speaker_config()

    assert unknown_speaker_config.get_unknown_speaker_config()["enabled"] is False


def test_unknown_speaker_falls_back_to_defaults_when_get_config_fails(monkeypatch):
    def _boom():
        raise RuntimeError("store unavailable")

    monkeypatch.setattr(unknown_speaker_config, "get_config", _boom)

    cfg = unknown_speaker_config.get_unknown_speaker_config()

    assert cfg["enabled"] is False
    assert cfg["detection"]["max_vp_score"] == 0.30


# ── health_cloud_service.apply_credentials ───────────────


class _FakeStore:
    def __init__(self) -> None:
        self.saved: list[dict] = []

    def save(self, changes: dict) -> None:
        self.saved.append(dict(changes))


class _FailingStore:
    def __init__(self, exc: Exception) -> None:
        self._exc = exc

    def save(self, changes: dict) -> None:
        raise self._exc


def _service(tmp_path: Path) -> hcs.HealthCloudService:
    service = hcs.HealthCloudService()
    service.state_path = lambda: str(tmp_path / "health_cloud_state.json")
    return service


def test_apply_credentials_saves_dotted_changes_through_config_store(
    tmp_path, monkeypatch
):
    store = _FakeStore()
    fake_cfg = _FakeConfig({"health": {"cloud": {"region": "us"}}})
    fake_cfg.HEALTH_CLOUD_REGION = "us"
    monkeypatch.setattr(hcs, "get_config_store", lambda: store)
    monkeypatch.setattr(hcs, "get_config", lambda: fake_cfg)
    monkeypatch.setattr(hcs.threading, "Thread", _InlineThread)
    service = _service(tmp_path)
    service._source = object()  # 模拟已缓存的拉取源
    pulled: list[bool] = []
    monkeypatch.setattr(service, "pull_once", lambda: pulled.append(True))

    service.apply_credentials("user-1", "secret-token")

    assert store.saved == [
        {
            "health.cloud.userid": "user-1",
            "health.cloud.passtoken": "secret-token",
            "health.cloud.region": "us",
        }
    ]
    assert service._source is None
    state = json.loads((tmp_path / "health_cloud_state.json").read_text("utf-8"))
    assert state["last_error"] == ""
    assert state["needs_login"] is False
    assert pulled == [True]


def test_apply_credentials_defaults_region_to_cn(tmp_path, monkeypatch):
    store = _FakeStore()
    fake_cfg = _FakeConfig({})
    fake_cfg.HEALTH_CLOUD_REGION = ""
    monkeypatch.setattr(hcs, "get_config_store", lambda: store)
    monkeypatch.setattr(hcs, "get_config", lambda: fake_cfg)
    service = _service(tmp_path)
    monkeypatch.setattr(service, "pull_once", lambda: None)

    service.apply_credentials("user-1", "secret-token")

    assert store.saved[0]["health.cloud.region"] == "cn"


def test_apply_credentials_maps_store_error_without_leaking_secrets(
    tmp_path, monkeypatch
):
    store = _FailingStore(ConfigValidationError([], "配置校验失败：1 项问题"))
    fake_cfg = _FakeConfig({})
    fake_cfg.HEALTH_CLOUD_REGION = "cn"
    monkeypatch.setattr(hcs, "get_config_store", lambda: store)
    monkeypatch.setattr(hcs, "get_config", lambda: fake_cfg)
    service = _service(tmp_path)

    with pytest.raises(RuntimeError) as excinfo:
        service.apply_credentials("user-1", "secret-token")

    message = str(excinfo.value)
    assert "secret-token" not in message
    assert "user-1" not in message
    assert "validation_failed" in message
    # 失败时不触发首次拉取、不写运行时状态
    assert not (tmp_path / "health_cloud_state.json").exists()
