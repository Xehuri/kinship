# -*- coding: utf-8 -*-
"""V12 刀0：内核切分会话「镜像缓冲/降级/收割/消费」家族的表征锁。

目的：在把 audio_stream_session（WS 直播流，每连接一实例、对象内单线程）与
audio_ingest_session（上传无缝流，每设备一实例、RLock 跨线程共享）的镜像/
降级/收割/消费两套平行实现提取共享基类之前，锁定关键场景的现行为语义
（全部跑绿 = 锁住现状；重构后仍绿 = 行为等价）。

三场景与既有覆盖情况（刀0 取证结论）：

  场景1 通道建连失败/中途断连 -> 降级、镜像整块产出（绝不丢音频、绝不回退本地切分）
    - ingest 侧已覆盖：test_audio_continuity_ingress.py::
        test_channel_open_failure_degrades_to_per_segment_output（建连失败逐段整块）
        test_channel_midway_failure_keeps_all_bytes（中途断连样本守恒）
    - stream 侧无覆盖 -> 本文件补：test_stream_channel_open_failure_* 与
        test_stream_midway_push_failure_*

  场景2 冷却期内新流不再尝试建连（仅 ingest 有冷却语义；stream 每连接对象
    降级即终，不存在冷却）
    - 已覆盖：test_audio_continuity_ingress.py::
        test_degrade_cooldown_skips_channel_for_new_streams

  场景3 镜像缓冲水位推进 + 降级后恢复
    - 水位推进仅在既有用例中间接体现（test_continuous_stream_with_mid_silence_
      cuts_early_not_at_cap 断第二段起点），无内部记账直锁 -> 本文件两侧各补一条
    - 冷却期满新流重试内核并回到切分模式（恢复）无覆盖 -> 本文件补
"""

import io
import math
import types
import wave
from array import array

import pytest

from services.audio_stream_session import AudioStreamSession
from services.audio_ingest_session import DeviceIngestSession
from segment_ref import BrokenChannel, RefSegmentChannel, make_channel_factory

SAMPLE_RATE = 16000
T0 = 1_757_836_800_000  # 2025-09-14 00:00:00 +08:00
FREQ_A = 440.0
FREQ_B = 880.0


def _pcm_tone(seconds: float, freq: float = FREQ_A, amp: float = 0.3) -> bytes:
    """有声 PCM（16kHz/单声道/16bit 小端），RMS 远高于静音阈值。"""
    n = int(SAMPLE_RATE * seconds)
    buf = array("h")
    for i in range(n):
        buf.append(int(32767 * amp * math.sin(2 * math.pi * freq * i / SAMPLE_RATE)))
    return buf.tobytes()


def _pcm_silence(seconds: float) -> bytes:
    return b"\x00" * (int(SAMPLE_RATE * seconds) * 2)


def _samples(pcm: bytes) -> int:
    return len(pcm) // 2


def _decode_wav(wav_bytes: bytes) -> bytes:
    with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
        return wf.readframes(wf.getnframes())


class _FakeQueue:
    """伪分析队列：记录 submit、恒成功（回减背压计数走真实路径）。"""

    def __init__(self) -> None:
        self.calls = []

    def submit(self, abs_path, start_epoch_ms=None, device_name=None, origin="upload"):
        self.calls.append({"abs_path": abs_path, "start_epoch_ms": start_epoch_ms,
                          "device_name": device_name, "origin": origin})
        return True


@pytest.fixture
def stream_env(monkeypatch, tmp_path):
    """隔离 AudioStreamSession 的落盘/入队/配置缝，记录 _persist_and_enqueue 产出。"""
    import services.audio_stream_session as ass
    import services.audio_analysis_queue as queue_mod
    import config.config as cfg_mod

    saved = []

    def _rec_save(wav_bytes, *, start_ms, end_ms, device_id, origin):
        saved.append({"pcm": _decode_wav(wav_bytes), "start_ms": int(start_ms),
                      "end_ms": int(end_ms), "device_id": device_id, "origin": origin})
        return f"stream/test/{start_ms}.wav"

    monkeypatch.setattr(ass, "save_audio", _rec_save)
    queue = _FakeQueue()
    monkeypatch.setattr(queue_mod, "get_analysis_queue", lambda: queue)
    monkeypatch.setattr(cfg_mod, "get_config",
                        lambda: types.SimpleNamespace(DATA_DIR=str(tmp_path)))
    return {"saved": saved, "queue": queue}


def _mk_ingest(**kw) -> DeviceIngestSession:
    """ingest 会话：与 continuity 用例同口径的短切分参数 + 仿真通道。"""
    opts = dict(min_chunk_s=1.0, silence_cut_s=1.5, max_chunk_s=120.0,
                tolerance_ms=1000, channel_factory=make_channel_factory())
    opts.update(kw)
    return DeviceIngestSession("dev-lock", **opts)


# ============================================================
# 场景1（stream 侧补锁）：建连失败 -> 降级、finish 整块产出
# ============================================================

def test_stream_channel_open_failure_degrades_and_finishes_whole_block(stream_env):
    """首帧建连失败 -> 会话降级：feed 期间零产出、不再重试点工厂，finish 整块落盘。"""
    made = []

    def _factory(start_ms, opts):
        ch = BrokenChannel()
        made.append(ch)
        return ch

    sess = AudioStreamSession("dev-lock", "s-lock", T0, channel_factory=_factory)
    a = _pcm_tone(1.0, FREQ_A)
    b = _pcm_tone(1.0, FREQ_B)

    assert sess.feed(a) is None
    assert sess._degraded is True, "建连失败必须降级（绝不回退本地切分）"
    assert len(made) == 1
    assert stream_env["saved"] == [], "降级后 feed 期间不产出，PCM 全部留镜像"

    assert sess.feed(b) is None
    assert len(made) == 1, "降级后不得再尝试建连"
    assert sess._mirror_start_ms == T0, "镜像起点 = 首帧推算墙钟"

    sess.finish()
    saved = stream_env["saved"]
    assert len(saved) == 1, "整条流降级为单块产出"
    assert saved[0]["pcm"] == a + b, "镜像整块 = 全部喂入字节，绝不丢音频"
    assert saved[0]["start_ms"] == T0
    assert saved[0]["end_ms"] == T0 + 2000
    assert saved[0]["origin"] == "stream"
    assert made[0].closed is True, "降级收尾必须关闭通道"


def test_stream_midway_push_failure_degrades_and_keeps_all_bytes(stream_env):
    """通道中途断连 -> 先收割再降级，镜像守恒，finish 整块（a+b 全字节）。"""
    made = []

    def _factory(start_ms, opts):
        ch = RefSegmentChannel(start_ms, opts, raise_on_push_after=1)
        made.append(ch)
        return ch

    sess = AudioStreamSession("dev-lock", "s-mid", T0, channel_factory=_factory)
    a = _pcm_tone(1.0, FREQ_A)
    b = _pcm_tone(1.0, FREQ_B)

    sess.feed(a)   # push 1 正常（1s < min_chunk，无切点）
    sess.feed(b)   # push 2 断连 -> 收割 + 降级
    assert sess._degraded is True
    assert stream_env["saved"] == [], "未切出任何段：a、b 都只在镜像"
    assert made[0].closed is True, "中途断连必须经收割关闭通道"

    sess.finish()
    saved = stream_env["saved"]
    assert len(saved) == 1
    assert saved[0]["pcm"] == a + b
    assert saved[0]["start_ms"] == T0
    total = sum(_samples(c["pcm"]) for c in saved)
    assert total == _samples(a) + _samples(b), "样本守恒：断连不丢任何音频字节"


# ============================================================
# 场景3（直锁水位推进）：内核切出一个段后，镜像起点前移、时间轴无缝衔接
# ============================================================

def test_stream_mirror_watermark_advances_across_kernel_cut(stream_env):
    """内核切出段被消费后 _mirror_start_ms 前移到段尾；后续产出起点与之严格衔接。"""
    def _factory(start_ms, opts):
        return RefSegmentChannel(start_ms, {
            **opts, "min_chunk_s": 1.0, "silence_cut_s": 1.5, "max_chunk_s": 120.0,
        })

    sess = AudioStreamSession("dev-lock", "s-wm", T0, channel_factory=_factory)
    a = _pcm_tone(2.0, FREQ_A) + _pcm_silence(2.0)   # a 内部静音端点切一刀
    b = _pcm_tone(1.0, FREQ_B)

    sess.feed(a)
    saved = stream_env["saved"]
    assert len(saved) == 1, "a 内的静音端点应在 feed 时被收割落盘"
    cut = saved[0]
    assert cut["start_ms"] == T0
    assert sess._mirror_start_ms == cut["end_ms"], \
        "消费后镜像起点必须前移到已产出段的绝对结束时间"
    assert len(sess._mirror) == len(a) - len(cut["pcm"]), "剩余音频继续留在镜像"

    sess.feed(b)
    sess.finish()
    assert len(stream_env["saved"]) == 2, "尾段由通道 stop 闭合产出"
    tail = stream_env["saved"][1]
    assert tail["start_ms"] == cut["end_ms"], "产出时间轴无缝（不重叠、无空洞）"
    assert len(cut["pcm"]) + len(tail["pcm"]) == len(a) + len(b), "样本守恒"


# ============================================================
# 场景3（ingest 侧直锁）：镜像水位推进 + 降级后恢复
# ============================================================

def test_ingest_mirror_start_ms_advances_with_kernel_cut():
    """内核切点消费后 _mirror_start_ms 前移；冲刷产出的第二段起点与之严格衔接。"""
    sess = _mk_ingest()
    a = _pcm_tone(2.0, FREQ_A) + _pcm_silence(2.0)
    b = _pcm_tone(2.0, FREQ_B)

    r1 = sess.ingest(session_id="s", seq=1, start_ms=T0, pcm=a, now_ms=T0)
    assert len(r1.emitted) == 1
    cut = r1.emitted[0]
    assert cut.start_ms == T0
    assert sess._mirror_start_ms == cut.end_ms, "水位前移直锁"

    sess.ingest(session_id="s", seq=2, start_ms=T0 + 4000, pcm=b, now_ms=T0 + 4000)
    rest = sess.flush()
    assert len(rest) == 1
    tail = rest[0]
    assert tail.start_ms == cut.end_ms, "时间轴无缝衔接"
    assert _samples(cut.pcm) + _samples(tail.pcm) == _samples(a) + _samples(b), \
        "样本守恒：切点前后不丢不重"


def test_ingest_recovers_kernel_channel_after_cooldown_expires():
    """降级冷却期满后的新流必须重试内核并回到切分模式（恢复语义；冷却期内行为
    已由 test_degrade_cooldown_skips_channel_for_new_streams 锁定）。"""
    made = []

    def _factory(start_ms, opts):
        ch = BrokenChannel() if not made else RefSegmentChannel(start_ms, opts)
        made.append(ch)
        return ch

    sess = _mk_ingest(channel_factory=_factory, degraded_cooldown_s=120.0)
    r1 = sess.ingest(session_id="s", seq=1, start_ms=T0,
                     pcm=_pcm_tone(1.0, FREQ_A), now_ms=T0)
    assert len(r1.emitted) == 1 and len(made) == 1
    assert sess.stream_degraded is True
    sess.flush()

    # 模拟冷却期满（不 sleep）：新流必须重试内核
    sess._degraded_until = 0.0
    tone_b = _pcm_tone(1.0, FREQ_B)
    r2 = sess.ingest(session_id="s", seq=2, start_ms=T0 + 600_000,
                     pcm=tone_b, now_ms=T0 + 600_000)
    assert len(made) == 2, "冷却期满后新流必须重新建通道"
    assert made[1].opened is True
    assert sess.stream_degraded is False, "新流回到内核切分模式"
    assert r2.emitted == [], "切分模式：无切点不即时产出（区别于降级逐段产出）"
    assert sess.has_pending_tail()

    out = sess.flush()
    assert len(out) == 1 and out[0].pcm == tone_b, "尾段经 session.stop 闭合产出"
