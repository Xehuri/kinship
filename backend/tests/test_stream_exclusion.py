# -*- coding: utf-8 -*-
"""流式（唤醒）链路「不写增量数据，但保留 ASR 投递」回归测试。

背景（两条独立链路，不可混谈）：
  - 环境音频（分段上传）-> 进增量数据（perception.jsonl / daily 音频），供 AI 分析；
  - 语音唤醒（/ws/audio-stream）-> 不进增量数据，产出是 ASR 结果投递主会话（语音指令）。

本文件锁定的不变量：
  1. 唤醒后处理（WakeWordState._finish_and_send）不写 perception.jsonl，也不落 daily 音频；
  2. 流式会话（AudioStreamSession）音频落 daily 之外的 stream/ 目录，且分析侧按
     origin="stream" 跳过 perception 写入（流式会话结束后 daily 无新增 voice 条目、无音频）；
  3. 唤醒的 ASR 投递路径（_send_to_main -> main-task）仍被调用，正文带【语音唤醒】前缀。

所有测试均以 monkeypatch 隔离 pyannote / funasr / multimodal / 声纹等重型依赖，
绝不加载真实模型，也不触碰真实数据目录。
"""

import sys
import types

import pytest

from services import perception_store

# 关键：在模块导入期先绑定 audio_stream_session 对 save_audio 的引用，
# 之后 fixture 里对 perception_store.save_audio 的 monkeypatch 只影响
# 「调用期再 import」的唤醒链路，不会改变流式会话的真实落盘行为。
from services.audio_stream_session import AudioStreamSession

# C5：流式会话的切分计算在内核 segment 通道；单测注入本地仿真通道
# （纯内存复刻原外层算法），绝不触真实内核/生产 pidfile。
from segment_ref import make_channel_factory


def _mk_session(device_id: str, session_id: str, start_wall_ms: int, **kw):
    """构造 AudioStreamSession 并注入仿真切分通道（测试专用）。"""
    return AudioStreamSession(
        device_id=device_id,
        session_id=session_id,
        start_wall_ms=start_wall_ms,
        channel_factory=make_channel_factory(),
        **kw,
    )


# ============================================================
# 辅助
# ============================================================

def _silence_pcm(seconds: float, sample_rate: int = 16000) -> bytes:
    """生成指定时长的静音 PCM（16kHz/单声道/16bit 小端）。"""
    return b"\x00\x00" * int(sample_rate * seconds)


class _FakeWakeParams:
    """WakeWordState 后处理所需的最小参数对象（B1：无本地 ASR/VAD 设备字段）。"""

    weak_split = {"enabled": False}   # 关闭弱切分，避免引入额外分支


def _make_state():
    """绕过 __init__ 构造 WakeWordState，避免启动状态机线程（B1 起也无本地模型）。"""
    from services import wake_word_service as wws

    st = object.__new__(wws.WakeWordState)
    st._sr = 16000
    st._p = _FakeWakeParams()
    st._test_mode = False              # 非测试模式，验证真实投递路径
    st._session_id = "sess-stream-test"
    st._device_id = "dev-stream-test"
    return st


def _asr_facts(text: str) -> dict:
    """内核 analyze.asr 的最小 facts（B1：唤醒链 ASR 唯一路径是内核作业）。"""
    return {
        "analyze.asr": {
            "duration_ms": 1000,
            "text": text,
            "segments": ([{"start_ms": 0, "end_ms": 1000, "text": text}]
                         if text else []),
        },
    }


def _patch_wake_asr(monkeypatch, text):
    """打桩 wake 链内核 ASR 缝（run_audio_analysis_jobs），绝不触真内核。

    Returns:
        提交记录 list：每次调用 append {"kinds","options_by_kind","path"}。
    """
    import services.kernel_job_client as kjc

    calls: list = []

    def _fake(audio_path, *, kinds=None, options_by_kind=None, **kw):
        calls.append({
            "kinds": kinds,
            "options_by_kind": options_by_kind,
            "path": audio_path,
        })
        return _asr_facts(text)

    monkeypatch.setattr(kjc, "run_audio_analysis_jobs", _fake)
    return calls


def _minimal_facts(text: str = "测试语音") -> dict:
    """内核主链四 kind 的最小 facts(无 segments -> 跳过段级声纹分支)。

    B2 起 analyze_audio_file 的算法唯一路径是内核: 作业缝返回该 facts 即
    "内核可用"，写条目的 ASR 文本来自 analyze.asr。
    """
    return {
        "analyze.vad": {"duration_ms": 1000, "segments": []},
        "analyze.asr": {"duration_ms": 1000, "text": text, "segments": []},
        "analyze.scene": {"duration_ms": 1000, "scene_primary": None,
                          "scene_tags": [], "scene_groups": {}},
        "analyze.diarize": {"duration_ms": 1000, "segments": []},
    }


class _FakeQueue:
    """伪分析队列：只记录 submit 调用，不启动 worker、不触发模型加载。"""

    def __init__(self) -> None:
        self.calls = []

    def submit(self, abs_path, start_epoch_ms, device_name, origin="upload"):
        self.calls.append(
            {
                "abs_path": abs_path,
                "start_epoch_ms": start_epoch_ms,
                "device_name": device_name,
                "origin": origin,
            }
        )
        return True


# ============================================================
# Fixture：隔离重模型 + 重定向数据目录 + 记录落盘/投递
# ============================================================

@pytest.fixture
def isolated_env(monkeypatch, tmp_path):
    """隔离所有重型依赖，并把数据根目录重定向到临时目录。

    Returns:
        dict，含 data_root / append_calls / save_calls / queue。
    """
    data_root = tmp_path / "data"

    # 1. 数据目录重定向（save_audio 内部读这两个模块级变量）
    monkeypatch.setattr(perception_store, "_DATA_BASE", str(data_root / "daily"))
    monkeypatch.setattr(perception_store, "_STREAM_AUDIO_BASE", str(data_root / "stream"))

    # 2. config.get_config 返回临时 DATA_DIR（AudioStreamSession 用它拼绝对路径）
    import config.config as cfg_mod

    class _FakeCfg:
        DATA_DIR = str(data_root)

    monkeypatch.setattr(cfg_mod, "get_config", lambda: _FakeCfg())

    # 3. 落盘/写入记录器（不写真实数据目录）
    append_calls = []

    def _record_append(entry, user_id="default", auto_type=True, date_str=None):
        append_calls.append(entry)
        return True

    save_calls = []

    def _record_save(*args, **kwargs):
        save_calls.append({"args": args, "kwargs": kwargs})
        return None

    monkeypatch.setattr(perception_store, "append_perception", _record_append)
    monkeypatch.setattr(perception_store, "save_audio", _record_save)

    # 4. 关闭陌生人 track 喂送(B2: 管线不再 import 本地四层链/pyannote)
    #    + requeue 拦截(主链若不可用不真建队列单例; 本 fixture 主链恒可用)
    import services.audio_analysis_pipeline as pipeline_mod

    monkeypatch.setattr(pipeline_mod, "_unknown_speaker_enabled", lambda: False)
    monkeypatch.setattr(pipeline_mod, "_schedule_retry", lambda *a, **k: None)

    # 6. (B5t) 陌生人聚合已改管线内置纯内存聚合 _summarize_unk_entry，
    #    不再 import unknown_speaker_pipeline——旧 no-op 补丁随接线删除。

    # 7. 声纹内核探针桩: 计数 0 -> 跳过段级评分分支（V10 镜像内存读改内核 HTTP 面）
    import services.kernel_client as kc_mod

    monkeypatch.setattr(kc_mod, "vp_speaker_count", lambda: 0)
    monkeypatch.setattr(kc_mod, "vp_cohort_stats", lambda: {})

    # 8. 伪分析队列（记录 origin 透传，不启动 worker）
    queue = _FakeQueue()
    import services.audio_analysis_queue as queue_mod

    monkeypatch.setattr(queue_mod, "get_analysis_queue", lambda: queue)

    # 9. 内核作业缝（B2）: 恒回无语音 facts(内核可用语义) + 残留两件全 None,
    #    绝不 spawn 真内核/发真实作业请求（算法唯一路径已是内核，无本地回退）
    import services.kernel_job_client as kjc_mod

    monkeypatch.setattr(
        kjc_mod, "run_audio_analysis_jobs", lambda audio_path: _minimal_facts()
    )
    monkeypatch.setattr(
        kjc_mod, "run_residual_analysis_jobs",
        lambda audio_path, **kw: {k: None for k in ("analyze.aed", "analyze.breath")},
    )

    return {
        "data_root": data_root,
        "append_calls": append_calls,
        "save_calls": save_calls,
        "queue": queue,
    }


# ============================================================
# 1 / 3. 唤醒后处理：不写增量数据，但保留 ASR 投递
# ============================================================

def test_wake_finish_skips_perception_and_daily_audio(monkeypatch, isolated_env):
    """唤醒后处理不得写 perception.jsonl，也不得落盘 daily 音频。"""
    from services import wake_word_service as wws

    state = _make_state()
    _patch_wake_asr(monkeypatch, "打开空调")
    # 投递路径单独 mock：本用例只关心落盘，不关心投递
    monkeypatch.setattr(wws.WakeWordState, "_send_to_main", lambda self, text: None)

    state._finish_and_send(
        pcm=_silence_pcm(1.0),
        start_wall_ms=1_757_836_800_000,
        end_wall_ms=1_757_836_801_000,
        speaker="用户",
        reason="vad_silence",
    )

    assert isolated_env["append_calls"] == [], "唤醒链路不得写 perception 增量条目"
    assert isolated_env["save_calls"] == [], "唤醒链路不得落盘音频"
    # 双保险：daily 目录下既不出现 perception.jsonl，也不出现音频文件
    daily = isolated_env["data_root"] / "daily"
    assert list(daily.rglob("perception.jsonl")) == []
    assert list(daily.rglob("*.wav")) == []


def test_wake_finish_still_delivers_asr_to_main(monkeypatch, isolated_env):
    """唤醒后处理必须仍把（内核）ASR 结果以【语音唤醒】前缀投递到 main-task。

    B1 起 ASR 唯一路径是内核 analyze.asr 作业；本用例同时锁定提交形状：
    kinds 恰为 ["analyze.asr"]、options.weak_split 逐键透传配置。
    """
    from services import wake_word_service as wws

    state = _make_state()
    calls = _patch_wake_asr(monkeypatch, "打开空调")

    delivered = []

    def _record_send(self, text):
        delivered.append(text)

    monkeypatch.setattr(wws.WakeWordState, "_send_to_main", _record_send)

    state._finish_and_send(
        pcm=_silence_pcm(1.0),
        start_wall_ms=1_757_836_800_000,
        end_wall_ms=1_757_836_801_000,
        speaker="用户",
        reason="vad_silence",
    )

    assert len(delivered) == 1, "ASR 投递路径必须被调用且恰好一次"
    assert delivered[0].startswith("【语音唤醒】"), "投递正文须带统一场景前缀"
    assert "打开空调" in delivered[0], "投递正文须包含 ASR 文本"
    # 提交形状：单 kind analyze.asr + weak_split options（配置 enabled=False 显式透传）
    assert len(calls) == 1
    assert calls[0]["kinds"] == ["analyze.asr"]
    assert calls[0]["options_by_kind"] == {
        "analyze.asr": {"weak_split": {"enabled": False}}
    }
    # 临时 WAV 已提交内核（同机直读路径），且用后即删（不残留）
    import os

    assert calls[0]["path"].endswith(".wav")
    assert not os.path.exists(calls[0]["path"]), "后处理临时文件必须清理"


def test_wake_finish_empty_asr_not_delivered(monkeypatch, isolated_env):
    """ASR 空文本仍按既有行为丢弃，不投递、不落盘（回归保护）。"""
    from services import wake_word_service as wws

    state = _make_state()
    _patch_wake_asr(monkeypatch, "")

    delivered = []
    monkeypatch.setattr(
        wws.WakeWordState, "_send_to_main", lambda self, text: delivered.append(text)
    )

    state._finish_and_send(
        pcm=_silence_pcm(1.0),
        start_wall_ms=1_757_836_800_000,
        end_wall_ms=1_757_836_801_000,
        speaker="用户",
        reason="vad_silence",
    )

    assert delivered == []
    assert isolated_env["append_calls"] == []
    assert isolated_env["save_calls"] == []


# ============================================================
# 2. 流式会话：音频落 stream/，不落 daily/，分析 origin 透传
# ============================================================

def test_stream_session_audio_lands_outside_daily(isolated_env):
    """流式会话结束后，daily/ 无新增音频，音频落在 stream/ 且 origin=stream 入队。"""
    from services.audio_stream_session import AudioStreamSession

    start_ms = 1_757_836_800_000  # 2025-09-14 00:00:00 +08:00
    session = _mk_session("dev-stream", "s1", start_ms)
    session.feed(_silence_pcm(1.0))
    session.finish()

    data_root = isolated_env["data_root"]

    # daily 之外才有音频
    assert list((data_root / "daily").rglob("*.wav")) == [], "流式音频不得落在 daily/"
    stream_wavs = list((data_root / "stream").rglob("*.wav"))
    assert len(stream_wavs) == 1, f"流式音频应恰好落 1 个文件，实际 {len(stream_wavs)}"

    # 入队必须显式标注 origin="stream"（分析侧据此跳过 perception 写入）
    assert len(isolated_env["queue"].calls) == 1
    assert isolated_env["queue"].calls[0]["origin"] == "stream"


def test_stream_session_writes_no_perception_entries(isolated_env):
    """流式会话生命周期内不得产生任何 perception 增量条目。"""
    from services.audio_stream_session import AudioStreamSession

    session = _mk_session("dev-stream", "s2", 1_757_836_800_000)
    session.feed(_silence_pcm(1.0))
    session.finish()

    assert isolated_env["append_calls"] == []
    assert list((isolated_env["data_root"] / "daily").rglob("perception.jsonl")) == []


def test_stream_session_pipeline_end_to_end_no_daily_perception(isolated_env):
    """端到端：会话产出的流式音频经分析后，daily/ 仍无 perception.jsonl 与音频。

    复用真实 analyze_audio_file，但重模型全部 mock；验证「流式会话结束」这一
    完整链路（落盘 -> 入队 -> 分析）在 daily 侧零新增。
    """
    from services.audio_stream_session import AudioStreamSession
    from services.audio_analysis_pipeline import analyze_audio_file

    session = _mk_session("dev-stream", "s3", 1_757_836_800_000)
    session.feed(_silence_pcm(1.0))
    session.finish()

    call = isolated_env["queue"].calls[0]
    assert call["origin"] == "stream"

    # 模拟队列 worker 消费：显式以 origin="stream" 走分析链路
    analyze_audio_file(
        call["abs_path"],
        call["start_epoch_ms"],
        device_name=call["device_name"],
        origin=call["origin"],
    )

    assert isolated_env["append_calls"] == [], "流式音频经分析后仍不得写 perception"
    daily = isolated_env["data_root"] / "daily"
    assert list(daily.rglob("perception.jsonl")) == []
    assert list(daily.rglob("*.wav")) == []
