# -*- coding: utf-8 -*-
"""N07: 音频子系统配置快照热重载 + 后台资源重置。

覆盖：
  1. 管线 / 摄入会话 / 流式会话的模块级配置快照可重载且幂等；
  2. 摄入注册表 reset：旧会话 flush+close、单例替换、sink 重挂、sweeper 重启；
  3. 分析队列 reset：旧 worker 退出、新队列按当前配置重建、无孤儿线程；
  4. 压缩器 reset：清空单例；
  5. 所有 reload/reset 在子系统尚未创建时安全可用。

测试不触碰真实音频文件、内核、网络或仓库配置：配置一律 monkeypatch，
后台线程在 teardown 统一收停。
"""

from __future__ import annotations

import importlib
import threading
from typing import Any, Dict, List

import pytest


# ── 模块级快照名（测试结束逐名还原，避免污染同进程其它用例） ──
_SNAPSHOT_NAMES: Dict[str, List[str]] = {
    "services.audio_analysis_pipeline": [
        "_AUDIO_CFG",
        "_VP_AUDIO_CFG",
        "_SLIDING_CFG",
        "_SEG_CFG",
        "_AS_NORM_CFG",
        "_TAG_CFG",
        "_SLIDING_WINDOW_MS",
        "_SLIDING_HOP_MS",
        "_SPK_LABEL_THR",
        "_MIN_SPEECH_S",
        "_AS_NORM_MIN_COHORT",
        "_TAG_REGISTERED_SIM",
        "_TAG_MIXED_SIM",
        "_TAG_SELF_PCT",
        "_TAG_MIXED_PCT",
        "_PERSIST_STREAM_PERCEPTION",
    ],
    "services.audio_ingest_session": [
        "_STREAM_CFG",
        "_STITCH_CFG",
        "_DEFAULT_SAMPLE_RATE",
        "_DEFAULT_BYTES_PER_SAMPLE",
        "_DEFAULT_HOLDBACK_S",
        "_DEFAULT_MIN_FLUSH_SPEECH_RATIO",
        "_DEFAULT_FRAME_MS",
        "_DEFAULT_RMS_THRESHOLD",
        "_DEFAULT_TOLERANCE_MS",
        "_DEFAULT_MAX_CHUNK_S",
        "_DEFAULT_MIN_CHUNK_S",
        "_DEFAULT_SILENCE_CUT_S",
    ],
    "services.audio_stream_session": [
        "_AUDIO_CFG",
        "_STREAM_CFG",
        "_SAMPLE_RATE",
        "_BITS_PER_SAMPLE",
        "_CHANNELS",
        "_FRAME_MS",
        "_RMS_THRESHOLD",
        "_SILENCE_CUT_S",
        "_MIN_CHUNK_S",
        "_FORCE_CUT_S",
        "_MAX_PENDING_BYTES",
    ],
}


@pytest.fixture(autouse=True)
def _restore_audio_snapshots():
    """还原被 reload 直接改写的模块级全局（monkeypatch 不覆盖 global 赋值）。"""
    saved: Dict[str, Dict[str, Any]] = {}
    for mod_name, names in _SNAPSHOT_NAMES.items():
        mod = importlib.import_module(mod_name)
        saved[mod_name] = {name: getattr(mod, name) for name in names}
    yield
    for mod_name, values in saved.items():
        mod = importlib.import_module(mod_name)
        for name, value in values.items():
            setattr(mod, name, value)


@pytest.fixture(autouse=True)
def _stop_background_singletons():
    """测试期间替换/新建的队列与注册表单例，结束后停线程并恢复原单例。"""
    import services.audio_analysis_queue as queue_mod
    import services.audio_ingest_registry as registry_mod

    orig_queue = queue_mod._queue_instance
    orig_registry = registry_mod._instance

    yield

    current_queue = queue_mod._queue_instance
    if current_queue is not None and current_queue is not orig_queue:
        current_queue.stop(timeout=5.0)
    queue_mod._queue_instance = orig_queue

    current_registry = registry_mod._instance
    if current_registry is not None and current_registry is not orig_registry:
        current_registry.stop_sweeper(timeout=5.0)
    registry_mod._instance = orig_registry


# ============================================================
# 1. 管线配置快照
# ============================================================


def _pipeline_cfg(
    window_ms: int = 2222, hop_ms: int = 1111
) -> Dict[str, Any]:
    return {
        "voiceprint": {
            "sliding": {
                "window_ms": window_ms,
                "hop_ms": hop_ms,
                "label_threshold": 0.66,
            },
            "segment": {"min_speech_s": 0.77},
            "as_norm": {"min_cohort": 42},
            "tag": {
                "registered_sim": 0.81,
                "mixed_sim": 0.41,
                "self_pct": 0.95,
                "mixed_pct": 0.31,
            },
        },
        "stream": {"persist_perception": True},
    }


def test_pipeline_reload_snapshot_reads_config_and_is_idempotent(monkeypatch):
    import services.audio_analysis_pipeline as mod

    monkeypatch.setattr(mod, "get_audio_config", lambda: _pipeline_cfg())
    mod.reload_audio_config_snapshot()

    assert mod._SLIDING_WINDOW_MS == 2222
    assert mod._SLIDING_HOP_MS == 1111
    assert mod._SPK_LABEL_THR == 0.66
    assert mod._MIN_SPEECH_S == 0.77
    assert mod._AS_NORM_MIN_COHORT == 42
    assert mod._TAG_REGISTERED_SIM == 0.81
    assert mod._TAG_MIXED_SIM == 0.41
    assert mod._TAG_SELF_PCT == 0.95
    assert mod._TAG_MIXED_PCT == 0.31
    assert mod._PERSIST_STREAM_PERCEPTION is True

    # 每次 reload 都重新读配置（不是复用首次快照）
    monkeypatch.setattr(
        mod, "get_audio_config", lambda: _pipeline_cfg(3333, 2222)
    )
    mod.reload_audio_config_snapshot()
    assert mod._SLIDING_WINDOW_MS == 3333
    assert mod._SLIDING_HOP_MS == 2222

    # 二次 reload 结果一致（幂等）
    mod.reload_audio_config_snapshot()
    assert mod._SLIDING_WINDOW_MS == 3333
    assert mod._SLIDING_HOP_MS == 2222
    assert mod._PERSIST_STREAM_PERCEPTION is True


# ============================================================
# 2. 摄入会话配置快照
# ============================================================


def _ingest_cfg() -> Dict[str, Any]:
    return {
        "stream": {
            "sample_rate": 8000,
            "bytes_per_sample": 1,
            "holdback_s": 12.5,
            "min_flush_speech_ratio": 0.5,
            "frame_ms": 20,
            "rms_threshold": 9.5,
            "stitch": {
                "tolerance_ms": 250,
                "max_chunk_s": 45.0,
                "min_chunk_s": 2.5,
                "silence_cut_s": 0.75,
            },
        }
    }


def test_ingest_reload_snapshot_applies_to_new_sessions_only(monkeypatch):
    import services.audio_ingest_session as mod

    # reload 前创建的会话：保留旧参数（现有会话不受影响）
    old_session = mod.DeviceIngestSession(
        "dev-old",
        holdback_s=90.0,
        sample_rate=16000,
        bytes_per_sample=2,
        frame_ms=30,
        rms_threshold=5.0,
    )

    monkeypatch.setattr(mod, "get_audio_config", lambda: _ingest_cfg())
    mod.reload_audio_config_snapshot()

    assert mod._DEFAULT_SAMPLE_RATE == 8000
    assert mod._DEFAULT_BYTES_PER_SAMPLE == 1
    assert mod._DEFAULT_HOLDBACK_S == 12.5
    assert mod._DEFAULT_MIN_FLUSH_SPEECH_RATIO == 0.5
    assert mod._DEFAULT_FRAME_MS == 20
    assert mod._DEFAULT_RMS_THRESHOLD == 9.5
    assert mod._DEFAULT_TOLERANCE_MS == 250
    assert mod._DEFAULT_MAX_CHUNK_S == 45.0
    assert mod._DEFAULT_MIN_CHUNK_S == 2.5
    assert mod._DEFAULT_SILENCE_CUT_S == 0.75

    # 新会话用新快照
    new_session = mod.DeviceIngestSession("dev-new")
    assert new_session._holdback_ms == 12500
    assert new_session._sample_rate == 8000
    assert new_session._bytes_per_sample == 1
    assert new_session._frame_ms == 20
    assert new_session._rms_threshold == 9.5
    assert new_session._tolerance_ms == 250
    assert new_session._max_chunk_s == 45.0
    assert new_session._min_chunk_s == 2.5
    assert new_session._silence_cut_s == 0.75

    # 旧会话参数不变
    assert old_session._holdback_ms == 90000
    assert old_session._sample_rate == 16000
    assert old_session._bytes_per_sample == 2
    assert old_session._frame_ms == 30
    assert old_session._rms_threshold == 5.0

    # 幂等
    mod.reload_audio_config_snapshot()
    assert mod._DEFAULT_SAMPLE_RATE == 8000
    assert mod._DEFAULT_HOLDBACK_S == 12.5


# ============================================================
# 3. 流式会话配置快照
# ============================================================


def _stream_cfg() -> Dict[str, Any]:
    return {
        "stream": {
            "sample_rate": 8000,
            "bytes_per_sample": 1,
            "channels": 2,
            "frame_ms": 20,
            "rms_threshold": 7.5,
            "silence_cut_s": 2.5,
            "min_chunk_s": 3.0,
            "force_cut_s": 40.0,
            "max_pending_minutes": 1,
        }
    }


def test_stream_reload_snapshot_reads_config_and_is_idempotent(monkeypatch):
    import services.audio_stream_session as mod

    monkeypatch.setattr(mod, "get_audio_config", lambda: _stream_cfg())
    mod.reload_audio_config_snapshot()

    assert mod._SAMPLE_RATE == 8000
    assert mod._BITS_PER_SAMPLE == 8
    assert mod._CHANNELS == 2
    assert mod._FRAME_MS == 20
    assert mod._RMS_THRESHOLD == 7.5
    assert mod._SILENCE_CUT_S == 2.5
    assert mod._MIN_CHUNK_S == 3.0
    assert mod._FORCE_CUT_S == 40.0
    # 1 分钟 * 8000Hz * 1B * 2ch
    assert mod._MAX_PENDING_BYTES == 960000

    mod.reload_audio_config_snapshot()
    assert mod._SAMPLE_RATE == 8000
    assert mod._MAX_PENDING_BYTES == 960000


# ============================================================
# 4. 摄入注册表 reset
# ============================================================


class _FakeIngestSession:
    """记录 flush/close 调用顺序的会话替身。"""

    instances: List["_FakeIngestSession"] = []

    def __init__(self, device_id: str, **kwargs: Any) -> None:
        self.device_id = device_id
        self.kwargs = kwargs
        self.calls: List[str] = []
        self.emitted: List[Any] = []
        _FakeIngestSession.instances.append(self)

    def sweep(self, now_ms: Any = None) -> List[Any]:
        return []

    def flush(self) -> List[Any]:
        self.calls.append("flush")
        return list(self.emitted)

    def close(self) -> None:
        self.calls.append("close")


def test_registry_reset_flushes_old_sessions_and_rebuilds(monkeypatch):
    import services.audio_ingest_registry as regmod

    _FakeIngestSession.instances = []
    monkeypatch.setattr(regmod, "DeviceIngestSession", _FakeIngestSession)
    monkeypatch.setattr(
        regmod,
        "get_audio_config",
        lambda: {
            "stream": {
                "stitch_enabled": True,
                "holdback_s": 42.0,
                "min_flush_speech_ratio": 0.33,
                "sample_rate": 8000,
                "bytes_per_sample": 1,
                "frame_ms": 20,
                "rms_threshold": 9.0,
                "stitch": {
                    "tolerance_ms": 777,
                    "max_chunk_s": 33.0,
                    "min_chunk_s": 3.0,
                    "silence_cut_s": 0.9,
                },
            }
        },
    )

    old = regmod.AudioIngestRegistry(start_sweeper=True)
    regmod._instance = old
    try:
        old.get_or_create("dev-a")
        old.get_or_create("dev-b")
        session_a, session_b = _FakeIngestSession.instances
        session_a.emitted = ["chunk-a"]
        session_b.emitted = ["chunk-b"]
        assert old._sweeper_thread is not None
        assert old._sweeper_thread.is_alive()

        dispatches: List[Any] = []

        def _sink(device_id: str, chunks: List[Any]) -> None:
            dispatches.append((device_id, chunks))

        new = regmod.reset_audio_ingest_registry(sink=_sink)
        try:
            assert new is not old
            assert regmod.get_audio_ingest_registry() is new
            assert regmod.peek_audio_ingest_registry() is new

            # 新配置生效
            assert new._holdback_s == 42.0
            assert new._min_flush_speech_ratio == 0.33
            assert new._stitch["tolerance_ms"] == 777
            assert new._stitch["max_chunk_s"] == 33.0

            # sink 重挂 + sweeper 重启
            assert new._sweep_sink is _sink
            assert new._sweeper_started is True
            assert new._sweeper_thread is not None
            assert new._sweeper_thread.is_alive()

            # 旧 sweeper 已停
            assert old._sweeper_stop.is_set()
            assert old._sweeper_thread is None or not old._sweeper_thread.is_alive()

            # 旧会话先 flush 后 close，且已从注册表摘除
            assert old._sessions == {}
            assert [s.calls for s in _FakeIngestSession.instances[:2]] == [
                ["flush", "close"],
                ["flush", "close"],
            ]
            # flush 产出的尾段交给新 sink 派发，不丢在途音频
            assert dispatches == [
                ("dev-a", ["chunk-a"]),
                ("dev-b", ["chunk-b"]),
            ]

            # 新注册表新建会话时使用完整的新配置
            new.get_or_create("dev-c")
            created = _FakeIngestSession.instances[2]
            assert created.kwargs["sample_rate"] == 8000
            assert created.kwargs["bytes_per_sample"] == 1
            assert created.kwargs["frame_ms"] == 20
            assert created.kwargs["rms_threshold"] == 9.0
        finally:
            new.stop_sweeper()
            regmod._instance = None
    finally:
        old.stop_sweeper()


def test_registry_reset_without_sink_leaves_sink_unset(monkeypatch):
    import services.audio_ingest_registry as regmod

    monkeypatch.setattr(
        regmod,
        "get_audio_config",
        lambda: {"stream": {"stitch_enabled": True}},
    )
    old = regmod.AudioIngestRegistry(start_sweeper=False)
    regmod._instance = old

    def _sink(device_id: str, chunks: List[Any]) -> None:
        return None

    old.set_sweep_sink(_sink)
    try:
        new = regmod.reset_audio_ingest_registry()
        try:
            assert new._sweep_sink is None
            assert regmod.get_audio_ingest_registry() is new
        finally:
            new.stop_sweeper()
            regmod._instance = None
    finally:
        old.stop_sweeper()


# ============================================================
# 5. 分析队列 reset
# ============================================================


def test_queue_reset_stops_old_worker_and_uses_fresh_maxsize(monkeypatch):
    import services.audio_analysis_queue as qmod

    monkeypatch.setattr(
        qmod, "get_audio_config", lambda: {"stream": {"queue_maxsize": 2}}
    )

    old = qmod.AudioAnalysisQueue(maxsize=1)
    qmod._queue_instance = old
    try:
        assert old._worker.is_alive()

        new = qmod.reset_analysis_queue()

        assert new is not old
        assert qmod.get_analysis_queue() is new
        assert new._queue.maxsize == 2
        assert not old._worker.is_alive()
        assert old._stop_event.is_set()
        assert new._worker.is_alive()
    finally:
        old.stop(timeout=5.0)


def test_queue_stop_is_idempotent_and_joins_worker():
    import services.audio_analysis_queue as qmod

    q = qmod.AudioAnalysisQueue(maxsize=1)
    q.stop(timeout=3.0)
    assert not q._worker.is_alive()
    q.stop(timeout=3.0)
    assert not q._worker.is_alive()


# ============================================================
# 6. 压缩器 reset
# ============================================================


def test_reset_compressor_clears_singleton(monkeypatch):
    import services.audio_compressor as cmod

    fake = cmod.AudioCompressor(data_dir="/tmp/n07-not-used", keep_days=1)
    monkeypatch.setattr(cmod, "_compressor_instance", fake)

    cmod.reset_compressor()
    assert cmod._compressor_instance is None

    # 幂等
    cmod.reset_compressor()
    assert cmod._compressor_instance is None


# ============================================================
# 7. 子系统未创建时安全
# ============================================================


def test_reload_and_reset_are_safe_before_subsystem_creation(monkeypatch):
    import services.audio_analysis_pipeline as pipeline_mod
    import services.audio_analysis_queue as queue_mod
    import services.audio_compressor as comp_mod
    import services.audio_ingest_registry as reg_mod

    monkeypatch.setattr(
        pipeline_mod,
        "get_audio_config",
        lambda: {"voiceprint": {}, "stream": {}},
    )
    monkeypatch.setattr(
        reg_mod, "get_audio_config", lambda: {"stream": {}}
    )
    monkeypatch.setattr(
        queue_mod, "get_audio_config", lambda: {"stream": {}}
    )
    monkeypatch.setattr(reg_mod, "_instance", None)
    monkeypatch.setattr(queue_mod, "_queue_instance", None)
    monkeypatch.setattr(comp_mod, "_compressor_instance", None)

    pipeline_mod.reload_audio_config_snapshot()

    registry = reg_mod.reset_audio_ingest_registry()
    queue = queue_mod.reset_analysis_queue()
    comp_mod.reset_compressor()

    assert reg_mod.get_audio_ingest_registry() is registry
    assert queue_mod.get_analysis_queue() is queue
    assert comp_mod._compressor_instance is None

    registry.stop_sweeper()
    queue.stop(timeout=5.0)


def test_no_orphan_queue_thread_after_reset(monkeypatch):
    """reset 后旧 worker 不再是存活线程（线程名在枚举中不重复出现）。"""
    import services.audio_analysis_queue as qmod

    monkeypatch.setattr(
        qmod, "get_audio_config", lambda: {"stream": {"queue_maxsize": 4}}
    )
    old = qmod.AudioAnalysisQueue(maxsize=1)
    qmod._queue_instance = old
    old_thread = old._worker
    try:
        qmod.reset_analysis_queue()
        assert not old_thread.is_alive()
        alive_named = [
            t for t in threading.enumerate() if t.name == "audio-analysis-worker"
        ]
        assert old_thread not in alive_named
    finally:
        old.stop(timeout=5.0)
