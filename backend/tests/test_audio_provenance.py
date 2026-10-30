# -*- coding: utf-8 -*-
"""音频来源溯源 (origin) 透传与写入门控测试。

覆盖链路：
  1. analyze_audio_file 默认 origin="upload"（不传）时仍写 perception.jsonl，行为不变；
  2. analyze_audio_file origin="stream" 时不写 perception.jsonl；
  3. save_audio origin="stream" 时音频落在 daily/ 之外的 stream/ 目录；
  4. save_audio 默认（upload）仍落 daily/{date}/audio，向后兼容；
  5. AudioAnalysisQueue.submit 把 origin 透传给消费者 analyze_audio_file。

所有测试均 mock 重型模型（multimodal / pyannote / funasr / 声纹服务），
绝不加载真实模型，也不触碰真实数据目录。
"""

import os
import struct
import math
import wave
import threading
from datetime import datetime, timezone, timedelta

import pytest

from services import perception_store


# ============================================================
# 测试辅助
# ============================================================

# 记录 pipeline 门控时实际调用 append_perception 的次数
def _make_wav(path: str, seconds: float = 0.5) -> str:
    """生成一个可被 wave 模块识别的真实 WAV 文件（16kHz/单声道/16bit）。"""
    sample_rate = 16000
    num_samples = int(sample_rate * seconds)
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        frames = bytearray()
        for i in range(num_samples):
            t = i / sample_rate
            frames += struct.pack("<h", int(32767 * 0.3 * math.sin(2 * math.pi * 440.0 * t)))
        wf.writeframes(bytes(frames))
    return path


def _minimal_facts(text: str = "测试语音") -> dict:
    """内核主链四 kind 的最小 facts(无 segments -> 跳过段级声纹分支)。

    B2 起 analyze_audio_file 的算法唯一路径是内核: 作业缝返回该 facts 即
    "内核可用"，写条目的 ASR 文本来自 analyze.asr。残留两件/track 另设缝。
    """
    return {
        "analyze.vad": {"duration_ms": 1000, "segments": []},
        "analyze.asr": {
            "duration_ms": 1000,
            "text": text,
            "segments": [],
        },
        "analyze.scene": {"duration_ms": 1000, "scene_primary": None,
                          "scene_tags": [], "scene_groups": {}},
        "analyze.diarize": {"duration_ms": 1000, "segments": []},
    }


@pytest.fixture
def isolate_models(monkeypatch, tmp_path):
    """隔离所有重型依赖：内核作业/残留两件/track 缝、声纹服务、陌生人聚合。

    B5t 迁移(B2): 原"伪多模态 fake mgr 回退全路径"失效——降级全家桶已删，
    算法唯一路径是内核。本 fixture 把作业缝固定为"内核可用+无语音 facts"。

    Returns:
        记录 append_perception 调用的列表（供断言是否写增量数据）。
    """
    # 1. 内核作业缝（B2）: 恒回最小 facts(内核可用语义) + 残留两件全 None
    #    + track 关闭 + requeue 拦截，绝不 spawn 真内核/发真实请求。
    import services.kernel_job_client as kjc_mod

    monkeypatch.setattr(
        kjc_mod, "run_audio_analysis_jobs",
        lambda audio_path: _minimal_facts(),
    )
    monkeypatch.setattr(
        kjc_mod, "run_residual_analysis_jobs",
        lambda audio_path, **kw: {k: None for k in ("analyze.aed", "analyze.breath")},
    )
    # 2. 关闭陌生人 track 喂送(避免发真实 HTTP)
    import services.audio_analysis_pipeline as pipeline_mod

    monkeypatch.setattr(pipeline_mod, "_unknown_speaker_enabled", lambda: False)
    # 3. requeue 拦截(防误建队列单例; 本 fixture 语义下主链恒成功, 不应触发)
    monkeypatch.setattr(
        pipeline_mod, "_schedule_retry",
        lambda *a, **k: None,
    )

    # 4. (B5t) 陌生人聚合已改管线内置纯内存聚合 _summarize_unk_entry，
    #    不再 import unknown_speaker_pipeline——旧 no-op 补丁随接线删除。

    # 5. 声纹内核探针桩: 计数 0 -> 跳过段级评分分支（V10 镜像内存读改内核 HTTP 面）
    import services.kernel_client as kc_mod

    monkeypatch.setattr(kc_mod, "vp_speaker_count", lambda: 0)
    monkeypatch.setattr(kc_mod, "vp_cohort_stats", lambda: {})

    # 6. 让 pipeline 的 os.path.relpath 基准与测试音频同盘（Windows 跨盘 relpath 会抛错）
    import config.config as cfg_mod

    class _FakeCfg:
        DATA_DIR = str(tmp_path)

    monkeypatch.setattr(cfg_mod, "get_config", lambda: _FakeCfg())

    # 7. append_perception 记录器（不写真实 perception.jsonl）。
    #    列表本体记录 entry（兼容既有用量断言），.kwargs 记录每次调用的
    #    关键字参数（供 date_str 分桶断言）。
    class _Recorder(list):
        pass

    calls = _Recorder()
    calls.kwargs = []

    def _record(entry, user_id="default", auto_type=True, date_str=None):
        calls.append(entry)
        calls.kwargs.append({"user_id": user_id, "auto_type": auto_type,
                             "date_str": date_str})
        return True

    monkeypatch.setattr(perception_store, "append_perception", _record)
    return calls


@pytest.fixture
def isolated_store(monkeypatch, tmp_path):
    """把感知存储的根目录重定向到临时目录，避免污染真实 ai/data。"""
    data_root = tmp_path / "data"
    monkeypatch.setattr(perception_store, "_DATA_BASE", str(data_root / "daily"))
    monkeypatch.setattr(perception_store, "_STREAM_AUDIO_BASE", str(data_root / "stream"))
    return data_root


# ============================================================
# 1 / 2. analyze_audio_file 的 origin 门控
# ============================================================

def test_upload_default_still_appends_perception(tmp_path, isolate_models):
    """默认（不传 origin）等价于 upload：仍写 perception.jsonl，行为不变。"""
    from services.audio_analysis_pipeline import analyze_audio_file

    wav = _make_wav(str(tmp_path / "upload.wav"))
    analyze_audio_file(wav, None, device_name="dev-upload")

    assert len(isolate_models) == 1, "默认 origin 必须写入 perception 条目"
    assert isolate_models[0].get("type") == "voice"


def test_upload_explicit_origin_appends_perception(tmp_path, isolate_models):
    """显式 origin="upload" 同样写 perception.jsonl。"""
    from services.audio_analysis_pipeline import analyze_audio_file

    wav = _make_wav(str(tmp_path / "upload2.wav"))
    analyze_audio_file(wav, None, device_name="dev-upload", origin="upload")

    assert len(isolate_models) == 1


def test_stream_origin_skips_perception(tmp_path, isolate_models):
    """origin="stream" 时不写 perception.jsonl（流式音频不污染增量数据）。"""
    from services.audio_analysis_pipeline import analyze_audio_file

    wav = _make_wav(str(tmp_path / "stream.wav"))
    analyze_audio_file(wav, None, device_name="dev-stream", origin="stream")

    assert isolate_models == [], "流式音频不得写入 perception 条目"


# ============================================================
# 1b. date_str 事件日期分桶（离线补传不漂进当日桶）
# ============================================================

_CST = timezone(timedelta(hours=8))


def test_append_perception_gets_event_date_str(tmp_path, isolate_models):
    """start_epoch_ms 指定事件时间时，date_str 必须等于该事件的 CST 日期，
    而非分析执行日（手机离线补传旧录音落对应日期桶）。"""
    from services.audio_analysis_pipeline import analyze_audio_file

    # 事件时刻显式构造（2026-10-11 14:30 CST），不写死魔法 epoch
    event_dt = datetime(2026, 10, 11, 14, 30, 0, tzinfo=_CST)
    start_ms = int(event_dt.timestamp() * 1000)

    wav = _make_wav(str(tmp_path / "replay.wav"))
    analyze_audio_file(wav, start_ms, device_name="dev-replay")

    assert len(isolate_models) == 1
    assert isolate_models.kwargs[0]["date_str"] == "2026-10-11"


def test_append_perception_date_str_falls_back_to_today(tmp_path, isolate_models):
    """start_epoch_ms=None 时退回当前东八区日期（保持既有"今日桶"语义）。
    断言口径与管线一致：datetime.now(_CST)，不写死字面量。"""
    from services.audio_analysis_pipeline import analyze_audio_file

    wav = _make_wav(str(tmp_path / "live.wav"))
    analyze_audio_file(wav, None, device_name="dev-live")

    assert len(isolate_models) == 1
    assert isolate_models.kwargs[0]["date_str"] == datetime.now(_CST).strftime("%Y-%m-%d")


# ============================================================
# 3 / 4. save_audio 的目标目录
# ============================================================

def test_save_audio_stream_writes_outside_daily(isolated_store):
    """origin="stream" 时音频写在 daily/ 之外的 stream/ 目录。"""
    start_ms = 1_757_836_800_000  # 2025-09-14 00:00:00 +08:00
    rel = perception_store.save_audio(
        b"RIFF-fake-wav-bytes",
        device_id="dev-stream",
        start_ms=start_ms,
        end_ms=start_ms + 1000,
        origin="stream",
    )

    assert rel is not None
    assert not rel.startswith("daily/"), "流式音频不得落在 daily 目录"
    assert rel.startswith("stream/")
    assert os.path.exists(os.path.join(str(isolated_store), rel.replace("/", os.sep)))


def test_save_audio_upload_keeps_daily_layout(isolated_store):
    """默认（upload）时音频仍落 daily/{date}/audio，保持向后兼容。"""
    start_ms = 1_757_836_800_000
    rel = perception_store.save_audio(
        b"RIFF-fake-wav-bytes",
        device_id="dev-upload",
        start_ms=start_ms,
        end_ms=start_ms + 1000,
    )

    assert rel is not None
    assert rel.startswith("daily/")
    assert "/audio/" in rel


def test_save_audio_explicit_target_dir(isolated_store):
    """显式 target_dir 优先于 origin 默认目录。"""
    start_ms = 1_757_836_800_000
    rel = perception_store.save_audio(
        b"RIFF-fake-wav-bytes",
        device_id="dev",
        start_ms=start_ms,
        origin="stream",
        target_dir=str(isolated_store / "custom"),
    )

    assert rel is not None
    assert rel.startswith("custom/"), f"应写入显式目标目录，实际: {rel}"


# ============================================================
# 5. 队列 origin 透传
# ============================================================

def test_queue_submit_passes_origin_to_consumer(monkeypatch):
    """submit(origin="stream") 必须透传给消费者 analyze_audio_file。"""
    import services.audio_analysis_pipeline as pipeline_mod
    from services.audio_analysis_queue import AudioAnalysisQueue

    recorded = {}
    done = threading.Event()

    def _fake_analyze(abs_path, start_epoch_ms, device_name="", ts_val=None, origin="upload"):
        recorded["origin"] = origin
        recorded["path"] = abs_path
        done.set()

    monkeypatch.setattr(pipeline_mod, "analyze_audio_file", _fake_analyze)

    q = AudioAnalysisQueue(maxsize=4)
    assert q.submit("C:/tmp/fake.wav", 123, "dev-stream", origin="stream") is True
    assert done.wait(5.0), "worker 未消费队列条目"
    assert recorded["origin"] == "stream"


def test_queue_submit_default_origin_is_upload(monkeypatch):
    """不传 origin 时默认透传 "upload"，既有调用点行为不变。"""
    import services.audio_analysis_pipeline as pipeline_mod
    from services.audio_analysis_queue import AudioAnalysisQueue

    recorded = {}
    done = threading.Event()

    def _fake_analyze(abs_path, start_epoch_ms, device_name="", ts_val=None, origin="upload"):
        recorded["origin"] = origin
        done.set()

    monkeypatch.setattr(pipeline_mod, "analyze_audio_file", _fake_analyze)

    q = AudioAnalysisQueue(maxsize=4)
    assert q.submit("C:/tmp/fake2.wav", 456, "dev-upload") is True
    assert done.wait(5.0), "worker 未消费队列条目"
    assert recorded["origin"] == "upload"
