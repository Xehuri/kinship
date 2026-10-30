# -*- coding: utf-8 -*-
"""上传音频「无缝流」测试（时间连续的分段当作一条流分析）。

需求：上传的 WAV 只是"流的一段"，只有从时间角度看连续（
``B.start_ms <= A.end_ms + 容差``）的分段都追加到同一条流上，**不在文件边界切分**；
切分只发生在流的静音端点或硬上限处；尾部残片靠空闲超时（holdback）强制冲出。
合并发生在**音频层面**——合并后的 PCM 作为单个输入交给既有分析链路（内部
VAD + ASR）。

C5（D1 落地）：帧能量静音切分的**计算已上移内核**（``/v1/stream``
mode:"segment"），外层只留时间轴/去重/水位/冲刷编排。本文件的切分侧一律
注入 ``segment_ref.RefSegmentChannel``（本地仿真，逐位复刻 pre-outer-stripping
的外层 AudioStreamSegmenter 并按内核 t0 绝对轴推帧），锁定的是**外层编排语义**；
内核算法等价性 golden 对拍见 tests/test_ingest_kernel_segment_real.py（真内核）。

覆盖用例：
  1. 时间连续的两个文件 -> 只产出一个分析段，且该段是两段音频在音频层面的拼接；
     派发链路只触发一次分析，落盘 WAV 长度约等于两段之和；
  2. 时间不连续（超容差）-> 先冲刷当前流，各自独立分析，绝不合并；
     容差内的间隙 -> 视为连续（静音补齐），仍合并；
  3. 连续 3 个文件 -> 链式累积为一条流，最终产出单段完整音频；
  4. 静音端点出现在文件中间 -> 在该端点切分（而非文件边界）；
  5. 空闲超时（holdback）无新文件 -> 强制冲刷尾段（通道 stop 语义）；
  6. 中间有静音 / 超出硬上限时正确切分（不会因"连续"无限累积）；
  7. 去重（device, session, seq, start_ms）与水位裁剪；过晚分段丢弃；
  8. 多设备隔离；纯静音不产出；WAV 编解码基本行为；
  9. （C5 新增）通道建立失败/中途断连 -> 降级逐段产出，镜像守恒不丢音频，
     降级冷却，切分参数映射透传到内核通道。

测试全程使用仿真通道（纯标准库算法复刻），不加载任何重型模型、不触碰真实
数据目录、不触内核；合成音频用不同频率的正弦波区分来源，mock ASR 用过零率
识别频率，从而验证「合并后一句话的文本是完整的」。
"""

import math
import threading
import types
from array import array
from pathlib import Path

from services.audio_ingest_session import (
    DeviceIngestSession,
    decode_wav_pcm,
)
from services.audio_codec import pcm_to_wav
from services.audio_ingest_registry import AudioIngestRegistry
from segment_ref import BrokenChannel, RefSegmentChannel, make_channel_factory


# ============================================================
# 测试辅助
# ============================================================

SAMPLE_RATE = 16000
T0 = 1_757_836_800_000  # 2025-09-14 00:00:00 +08:00

# 三个来源音（频率 -> mock ASR 字符）
FREQ_A = 440.0   # 'a'
FREQ_B = 880.0   # 'b'
FREQ_C = 1320.0  # 'c'


def _pcm_tone(seconds: float, freq: float = FREQ_A, amp: float = 0.3) -> bytes:
    """生成有声 PCM（16kHz/单声道/16bit 小端），RMS 远高于静音阈值。"""
    n = int(SAMPLE_RATE * seconds)
    buf = array("h")
    for i in range(n):
        buf.append(int(32767 * amp * math.sin(2 * math.pi * freq * i / SAMPLE_RATE)))
    return buf.tobytes()


def _pcm_silence(seconds: float) -> bytes:
    """生成静音 PCM（全零）。"""
    return b"\x00" * (int(SAMPLE_RATE * seconds) * 2)


def _samples(pcm: bytes) -> int:
    return len(pcm) // 2


def _ms(pcm: bytes) -> int:
    return _samples(pcm) * 1000 // SAMPLE_RATE


def _mk(device_id: str = "dev-1", **kw) -> DeviceIngestSession:
    """构造测试用会话：默认缩短"最短块"，便于在几秒合成音频上验证切分。

    静音端点阈值 1.5s、硬上限 120s、容差 1000ms 与生产默认一致。
    切分侧注入仿真内核通道（RefSegmentChannel）：逐位复刻原外层算法 +
    内核 t0 绝对轴语义，不触真实内核。
    """
    opts = dict(
        min_chunk_s=1.0, silence_cut_s=1.5, max_chunk_s=120.0, tolerance_ms=1000,
        channel_factory=make_channel_factory(),
    )
    opts.update(kw)
    return DeviceIngestSession(device_id, **opts)


def _fake_asr(pcm: bytes, win_s: float = 0.5) -> str:
    """mock ASR：按 0.5s 窗口统计过零率识别音源，输出 'a'/'b'/'c'/'_' 串。

    过零率 ≈ 频率(Hz)：440 -> 'a'，880 -> 'b'，1320 -> 'c'，静音 -> '_'。
    用它验证「合并后一段音频里同时包含前后两半的文本」。
    """
    n = int(SAMPLE_RATE * win_s)
    samples = array("h")
    samples.frombytes(pcm[: len(pcm) // 2 * 2])
    out = []
    for i in range(0, len(samples) - n + 1, n):
        w = samples[i:i + n]
        zc = 0
        prev = w[0]
        for v in w[1:]:
            if (prev < 0) != (v < 0):
                zc += 1
            prev = v
        if zc < 10:
            out.append("_")
        elif zc < 660:
            out.append("a")
        elif zc < 1100:
            out.append("b")
        else:
            out.append("c")
    return "".join(out)


def _texts_of(chunks) -> list:
    """对产出块逐块跑 mock ASR，返回文本列表。"""
    return [_fake_asr(c.pcm) for c in chunks]


# ============================================================
# 1. 时间连续的两个文件 -> 一条流、一个分析段、一次分析
# ============================================================

def test_continuous_files_merge_into_one_stream_and_single_analysis(monkeypatch, tmp_path):
    """A/B 时间连续 -> 音频层面合并为一段；只触发一次分析，WAV 长度约等于两段之和。"""
    import config.config as cfg_mod
    import routers.perception as perc
    from services import perception_store

    calls = []

    def _recorder(abs_path, ts_val, device_name="", start_epoch_ms=None, origin="upload"):
        calls.append({
            "path": abs_path, "ts": ts_val, "device_name": device_name,
            "start_epoch_ms": start_epoch_ms, "origin": origin,
        })

    monkeypatch.setattr(perc, "_trigger_audio_analysis", _recorder)

    # 隔离落盘目录，避免污染真实 ai/data
    data_root = tmp_path / "data"
    monkeypatch.setattr(perception_store, "_DATA_BASE", str(data_root / "daily"))
    monkeypatch.setattr(perception_store, "_STREAM_AUDIO_BASE", str(data_root / "stream"))
    monkeypatch.setattr(
        cfg_mod, "get_config", lambda: types.SimpleNamespace(DATA_DIR=str(data_root))
    )

    sess = _mk()
    # A 结尾是语音（没有静音 padding），B 首尾相接（严格连续），B 末尾带静音端点收尾
    a = _pcm_tone(2.0, FREQ_A)
    b = _pcm_tone(2.0, FREQ_B) + _pcm_silence(2.0)

    r1 = sess.ingest(session_id="s1", seq=1, start_ms=T0, pcm=a,
                     device_name="Pixel", now_ms=T0)
    assert r1.emitted == [], "文件末尾没有静音端点，不应在文件边界切分"
    assert sess.has_pending_tail()

    r2 = sess.ingest(session_id="s1", seq=2, start_ms=T0 + 2000, pcm=b,
                     device_name="Pixel", now_ms=T0 + 2000)
    assert len(r2.emitted) == 1, "流内的静音端点应切出唯一一个分析段"

    chunk = r2.emitted[0]
    assert chunk.start_ms == T0
    assert chunk.trigger == "cut"
    assert chunk.device_id == "dev-1"
    assert chunk.device_name == "Pixel"

    merged = a + b
    # 合并发生在音频层面：产出段是「两段拼接后的音频」的前缀（未在文件边界丢弃/重复音频）
    assert chunk.pcm == merged[: len(chunk.pcm)], "必须是两段音频在音频层面的拼接"
    assert _samples(chunk.pcm) > _samples(a), "B 的音频必须被并入同一条流"
    # 长度约等于两段之和（差值只是被切在静音里的尾巴，不超过 1 帧对齐误差+尾部静音）
    assert abs(_samples(chunk.pcm) - _samples(merged)) <= SAMPLE_RATE

    text = _fake_asr(chunk.pcm)
    assert "a" in text and "b" in text, "一句话不得在文件边界被切断"
    assert text.index("a") < text.index("b")

    # 派发：合并块只触发一次分析，落盘 WAV 长度约等于两段之和
    perc._dispatch_stitched_chunks("dev-1", r2.emitted)
    assert len(calls) == 1, "合并块只应触发一次分析"
    assert calls[0]["start_epoch_ms"] == T0
    assert calls[0]["origin"] == "upload"
    assert calls[0]["device_name"] == "Pixel"

    wav = Path(calls[0]["path"]).read_bytes()
    pcm, rate, channels, width = decode_wav_pcm(wav)
    assert (rate, channels, width) == (16000, 1, 2)
    assert abs(_samples(pcm) - _samples(merged)) <= SAMPLE_RATE, "传入分析的音频长度 ≈ 两段之和"


def test_merge_with_client_pre_roll_overlap_keeps_stream_continuous():
    """App 的 500ms 前滚重叠不能让连续性判定失败（重叠部分按水位裁掉，不是断点）。"""
    sess = _mk()
    a = _pcm_tone(2.0, FREQ_A)
    b = _pcm_tone(2.0, FREQ_B)   # 起点 = A 结束 - 500ms（App 设计的前滚重叠）

    sess.ingest(session_id="s", seq=1, start_ms=T0, pcm=a, now_ms=T0)
    r2 = sess.ingest(session_id="s", seq=2, start_ms=T0 + 1500, pcm=b, now_ms=T0 + 1500)
    out = r2.emitted + sess.flush()

    assert len(out) == 1, "前滚重叠必须被识别为连续，不能切成两段"
    assert _samples(out[0].pcm) == _samples(a) + _samples(b) - int(SAMPLE_RATE * 0.5)
    text = _fake_asr(out[0].pcm)
    assert text.index("a") < text.index("b")


# ============================================================
# 2. 时间不连续 vs 容差内间隙
# ============================================================

def test_discontinuity_beyond_tolerance_flushes_separately():
    """B 与 A 的间隙超过容差 -> 先冲刷 A 那条流，B 另起一条流，绝不合并。"""
    sess = _mk(tolerance_ms=1000)
    a = _pcm_tone(2.0, FREQ_A)
    b = _pcm_tone(2.0, FREQ_B)

    sess.ingest(session_id="s", seq=1, start_ms=T0, pcm=a, now_ms=T0)
    # 起点比 A 的绝对结束晚 5000ms（例如中间丢了一个文件）
    r2 = sess.ingest(session_id="s", seq=2, start_ms=T0 + 7000, pcm=b, now_ms=T0 + 7000)

    assert len(r2.emitted) == 1
    assert r2.emitted[0].trigger == "discontinuity"
    assert r2.emitted[0].pcm == a, "不连续时当前流必须整体冲出且不含下一段音频"
    assert "b" not in _fake_asr(r2.emitted[0].pcm)

    out = sess.flush()
    assert len(out) == 1
    assert out[0].pcm == b, "新流独立分析，不与上一段合并"
    texts = _texts_of(r2.emitted + out)
    assert not any(("a" in t and "b" in t) for t in texts), "不得出现跨不连续间隙的拼接"


def test_gap_within_tolerance_treated_as_continuous():
    """间隙不超过容差 -> 视为同一条流（用静音补齐时间轴），仍合并为一段。"""
    sess = _mk(tolerance_ms=1000)
    a = _pcm_tone(2.0, FREQ_A)
    b = _pcm_tone(2.0, FREQ_B)

    sess.ingest(session_id="s", seq=1, start_ms=T0, pcm=a, now_ms=T0)
    # 900ms 间隙（小于 1000ms 容差）
    r2 = sess.ingest(session_id="s", seq=2, start_ms=T0 + 2900, pcm=b, now_ms=T0 + 2900)

    out = r2.emitted + sess.flush()
    assert len(out) == 1, "容差内的间隙应视为连续，不切割"
    text = _fake_asr(out[0].pcm)
    assert "a" in text and "b" in text
    assert text.index("a") < text.index("b")


def test_continuity_decisions_are_logged_with_both_timestamps(caplog):
    """连续与不连续都必须记录两侧时间戳与判定结果，便于线上核对。"""
    import logging
    sess = _mk(tolerance_ms=1000)
    with caplog.at_level(logging.INFO, logger="services.audio_ingest_session"):
        sess.ingest(session_id="s", seq=1, start_ms=T0, pcm=_pcm_tone(1.0, FREQ_A), now_ms=T0)
        # 连续
        sess.ingest(session_id="s", seq=2, start_ms=T0 + 1000, pcm=_pcm_tone(1.0, FREQ_B),
                    now_ms=T0 + 1000)
        # 不连续
        sess.ingest(session_id="s", seq=3, start_ms=T0 + 100_000, pcm=_pcm_tone(1.0, FREQ_C),
                    now_ms=T0 + 100_000)

    text = caplog.text
    assert "判定=连续" in text
    assert "判定=不连续" in text
    assert str(T0) in text and str(T0 + 1000) in text and str(T0 + 100_000) in text
    assert "容差" in text


# ============================================================
# 3. 连续 3 个文件 -> 链式累积为一条流
# ============================================================

def test_three_continuous_files_chain_into_one_stream():
    """A/B/C 三个文件时间连续 -> 链式累积为同一条流，最终一段完整音频。"""
    sess = _mk()
    a = _pcm_tone(2.0, FREQ_A)
    b = _pcm_tone(2.0, FREQ_B)
    c = _pcm_tone(2.0, FREQ_C)

    assert sess.ingest(session_id="s", seq=1, start_ms=T0, pcm=a, now_ms=T0).emitted == []
    assert sess.ingest(session_id="s", seq=2, start_ms=T0 + 2000, pcm=b,
                       now_ms=T0 + 2000).emitted == []
    assert sess.ingest(session_id="s", seq=3, start_ms=T0 + 4000, pcm=c,
                       now_ms=T0 + 4000).emitted == []
    assert sess.pending_samples == _samples(a) + _samples(b) + _samples(c)

    out = sess.flush()
    assert len(out) == 1, "三个连续文件必须累积成一条流、一个分析段"
    chunk = out[0]
    assert chunk.start_ms == T0
    assert chunk.pcm == a + b + c
    text = _fake_asr(chunk.pcm)
    assert "a" in text and "b" in text and "c" in text
    assert text.index("a") < text.index("b") < text.index("c")


# ============================================================
# 4. 静音端点出现在文件中间 -> 在该端点切分（而非文件边界）
# ============================================================

def test_silence_endpoint_inside_file_splits_there_not_at_file_boundary():
    """单个文件内部含 2s 静音 -> 在该静音端点切分，而不是等文件结束。"""
    sess = _mk(min_chunk_s=1.0, silence_cut_s=1.5)
    a = _pcm_tone(2.0, FREQ_A) + _pcm_silence(2.0) + _pcm_tone(2.0, FREQ_A)

    r1 = sess.ingest(session_id="s", seq=1, start_ms=T0, pcm=a, now_ms=T0)
    assert len(r1.emitted) == 1, "文件内部的静音端点应立即切出一个分析段"
    chunk = r1.emitted[0]
    assert chunk.trigger == "cut"
    assert chunk.start_ms == T0
    # 切点在文件内部（约 3.5s 处），而不是文件边界（6s）
    assert _ms(chunk.pcm) < _ms(a), "切点必须在文件内部，而不是等文件结束"
    assert 3000 <= _ms(chunk.pcm) <= 4500, f"应在 2s 语音后的静音端点切分，实际 {_ms(chunk.pcm)}ms"
    # 切完后剩余部分继续留在流里（跨文件继续拼接）
    assert sess.has_pending_tail()

    rest = sess.flush()
    assert len(rest) == 1
    assert _samples(chunk.pcm) + _samples(rest[0].pcm) == _samples(a), "样本数守恒，不丢音频"


# ============================================================
# 5. 空闲超时（holdback）强制冲刷尾段
# ============================================================

def test_holdback_flushes_idle_tail():
    """连续流在 holdback 内无新文件 -> 强制冲刷尾段并幂等。"""
    sess = _mk(holdback_s=90.0)
    tone = _pcm_tone(2.0, FREQ_A)

    assert sess.ingest(session_id="s", seq=1, start_ms=T0, pcm=tone, now_ms=T0).emitted == []
    assert sess.has_pending_tail()

    assert sess.sweep(now_ms=T0 + 89_000) == []
    out = sess.sweep(now_ms=T0 + 91_000)
    assert len(out) == 1
    assert out[0].trigger == "holdback"
    assert out[0].pcm == tone
    assert out[0].start_ms == T0

    assert sess.sweep(now_ms=T0 + 200_000) == []
    assert not sess.has_pending_tail()


def test_flush_emits_tail_immediately():
    """显式 flush 立即冲刷尾段（会话结束/需要收尾时）。"""
    sess = _mk()
    tone = _pcm_tone(2.0, FREQ_A)
    sess.ingest(session_id="s", seq=1, start_ms=T0, pcm=tone, now_ms=T0)
    out = sess.flush()
    assert len(out) == 1 and out[0].trigger == "flush"
    assert out[0].pcm == tone
    assert sess.flush() == []


# ============================================================
# 6. 不会因"连续"无限累积：静音端点/硬上限都会切分
# ============================================================

def test_hard_cap_cuts_long_continuous_stream():
    """连续流累积到硬上限 -> 强制切分，不会无限累积。"""
    sess = _mk(max_chunk_s=4.0, min_chunk_s=1.0, silence_cut_s=999.0)
    tone = _pcm_tone(2.0, FREQ_A)

    emitted = []
    for i in range(5):  # 5 * 2s = 10s 连续音频
        r = sess.ingest(session_id="s", seq=i, start_ms=T0 + i * 2000, pcm=tone, now_ms=T0)
        emitted.extend(r.emitted)

    assert len(emitted) == 2, "10s 连续音频在 4s 硬上限下应切出 2 段"
    for c in emitted:
        assert _ms(c.pcm) <= 4000 + 2 * 30, f"单段不得超过硬上限，实际 {_ms(c.pcm)}ms"
    assert sess.has_pending_tail(), "剩余音频继续留流中"

    rest = sess.flush()
    assert len(rest) == 1
    assert sum(_samples(c.pcm) for c in emitted + rest) == 5 * _samples(tone)


def test_continuous_stream_with_mid_silence_cuts_early_not_at_cap():
    """连续流中间出现静音 -> 在静音端点提前切分，远早于硬上限。"""
    sess = _mk(max_chunk_s=120.0, min_chunk_s=1.0, silence_cut_s=1.5)
    # 一段 4s 语音 + 2s 静音 + 4s 语音，作为"一条连续的流"分两个文件上传
    first = _pcm_tone(4.0, FREQ_A) + _pcm_silence(2.0)
    second = _pcm_tone(4.0, FREQ_B)

    r1 = sess.ingest(session_id="s", seq=1, start_ms=T0, pcm=first, now_ms=T0)
    assert len(r1.emitted) == 1, "静音端点应切分，而不是等到 120s 硬上限"
    assert _ms(r1.emitted[0].pcm) <= 6000

    r2 = sess.ingest(session_id="s", seq=2, start_ms=T0 + 6000, pcm=second, now_ms=T0 + 6000)
    out = r2.emitted + sess.flush()
    assert len(out) == 1
    # 第二段音频整体落在同一条流上（开头可能带上第一段尾巴的少量静音）
    assert out[0].pcm.endswith(second)
    assert out[0].start_ms == T0 + _ms(r1.emitted[0].pcm)
    # 样本守恒：两段产出之和 == 两个文件之和
    assert _ms(r1.emitted[0].pcm) + _ms(out[0].pcm) == _ms(first) + _ms(second)


# ============================================================
# 7. 去重 / 水位裁剪 / 过晚分段
# ============================================================

def test_duplicate_segment_is_not_processed_twice():
    """同一 (device, session, seq, start_ms) 的重复上传必须命中去重。"""
    sess = _mk()
    tone = _pcm_tone(2.0, FREQ_A)

    r1 = sess.ingest(session_id="s1", seq=1, start_ms=T0, pcm=tone, now_ms=T0)
    assert r1.emitted == []
    pending_after_first = sess.pending_samples

    r2 = sess.ingest(session_id="s1", seq=1, start_ms=T0, pcm=tone, now_ms=T0 + 500)
    assert r2.duplicate is True
    assert r2.emitted == []
    assert sess.pending_samples == pending_after_first, "去重后不得重复累积"


def test_registry_dedup_across_calls():
    """注册表层面同样去重，重复 ingest 不产生任何产出。"""
    reg = AudioIngestRegistry(
        stitch_enabled=True, holdback_s=90.0, start_sweeper=False,
        channel_factory=make_channel_factory(),
    )
    tone = _pcm_tone(2.0, FREQ_A)
    first = reg.ingest("dev", session_id="s", seq=1, start_ms=T0, pcm=tone, now_ms=T0)
    again = reg.ingest("dev", session_id="s", seq=1, start_ms=T0, pcm=tone, now_ms=T0 + 1)

    assert first.duplicate is False
    assert again.duplicate is True
    assert again.emitted == []


def test_late_replay_segment_is_discarded():
    """完全落在已处理区间内的过晚分段应被安全丢弃，避免重复音频。"""
    sess = _mk()
    tone = _pcm_tone(2.0, FREQ_A)

    sess.ingest(session_id="s", seq=1, start_ms=T0, pcm=tone, now_ms=T0)
    late = sess.ingest(session_id="s", seq=0, start_ms=T0 - 2000, pcm=tone, now_ms=T0)
    assert late.skipped is True
    assert late.emitted == []


def test_watermark_advances_to_stream_end():
    """水位推进到已喂入音频的绝对结束时间（去重裁剪与过晚判定的依据）。"""
    sess = _mk()
    tone = _pcm_tone(2.0, FREQ_A)
    sess.ingest(session_id="s", seq=1, start_ms=T0, pcm=tone, now_ms=T0)
    assert sess.watermark_ms == T0 + 2000


# 手机端设计的前滚重叠（AudioSegmentPolicy.OVERLAP_MS=500）：相邻上传段开头
# 会重复上一段结尾的 500ms，后端裁剪时只应裁掉这部分重叠。
OVERLAP_MS = 500


def test_client_start_ms_preferred_over_second_precision_client_time():
    """后端优先采用显式 start_wall_ms（毫秒），仅在缺失时才回退秒级字符串解析。"""
    from routers.perception import _resolve_start
    from datetime import datetime, timezone, timedelta

    true_ms = T0 + 123  # 亚秒部分会被秒级字符串丢弃
    sec_ms = (true_ms // 1000) * 1000

    client_time = datetime.fromtimestamp(
        sec_ms / 1000.0, tz=timezone(timedelta(hours=8))
    ).strftime("%Y-%m-%dT%H:%M:%S+08:00")

    dt_exact, ms_exact = _resolve_start(true_ms, client_time)
    assert dt_exact is not None
    assert ms_exact == true_ms, "显式 start_wall_ms 必须被原样采用"

    dt_fallback, ms_fallback = _resolve_start(None, client_time)
    assert dt_fallback is not None
    assert ms_fallback == sec_ms == T0
    assert ms_fallback < true_ms, "秒级字符串解析会丢失亚秒信息"


def test_exact_start_ms_trims_only_designed_overlap_without_losing_audio():
    """水位裁剪量恰为设计的 500ms 重叠，不丢真实新音频。"""
    seg1_dur_ms = 2000
    seg1 = _pcm_tone(seg1_dur_ms / 1000.0, FREQ_A)
    seg2 = _pcm_tone(3.0, FREQ_B)
    t2_true = T0 + seg1_dur_ms - OVERLAP_MS
    t2_trunc = (t2_true // 1000) * 1000

    kept = {}
    for label, start in (("exact", t2_true), ("truncated", t2_trunc)):
        sess = _mk()
        r1 = sess.ingest(session_id="s", seq=1, start_ms=T0, pcm=seg1, now_ms=T0)
        assert r1.emitted == []
        watermark = sess.watermark_ms
        sess.ingest(session_id="s", seq=2, start_ms=start, pcm=seg2, now_ms=start)
        # 新段被裁剪到水位处，裁剪量 = 水位 - 起点
        kept[label] = max(0, watermark - start)

    assert kept["exact"] == OVERLAP_MS, "只应裁掉设计的 500ms 重叠"
    assert kept["truncated"] == OVERLAP_MS + (t2_true - t2_trunc), "秒级截断会多裁真实音频"


# ============================================================
# 8. 多设备隔离 / 纯静音
# ============================================================

def test_two_devices_are_isolated():
    """不同设备的会话完全独立，一个设备的冲刷不影响另一个。"""
    reg = AudioIngestRegistry(
        stitch_enabled=True, holdback_s=90.0, start_sweeper=False,
        channel_factory=make_channel_factory(),
    )
    tone_a = _pcm_tone(2.0, FREQ_A)
    tone_b = _pcm_tone(2.0, FREQ_B)

    oa = reg.ingest("devA", device_name="A", session_id="sa", seq=1, start_ms=T0,
                    pcm=tone_a, now_ms=T0)
    ob = reg.ingest("devB", device_name="B", session_id="sb", seq=1, start_ms=T0 + 500,
                    pcm=tone_b, now_ms=T0)
    assert oa.emitted == [] and ob.emitted == []
    assert reg.get_or_create("devA") is not reg.get_or_create("devB")

    ra = reg.get_or_create("devA").flush()
    assert len(ra) == 1
    assert ra[0].device_id == "devA"
    assert ra[0].pcm == tone_a
    assert reg.get_or_create("devB").has_pending_tail(), "B 的流不应被 A 的冲刷带走"


def test_concurrent_devices_no_interference():
    """多线程并发摄入不同设备，互不干扰且不抛异常。"""
    reg = AudioIngestRegistry(
        stitch_enabled=True, holdback_s=90.0, start_sweeper=False,
        channel_factory=make_channel_factory(),
    )
    tone = _pcm_tone(0.5, FREQ_A)
    errors = []

    def _worker(dev: str) -> None:
        try:
            for i in range(20):
                reg.ingest(dev, session_id="s", seq=i, start_ms=T0 + i * 500,
                           pcm=tone, now_ms=T0)
        except Exception as e:
            errors.append(e)

    threads = [threading.Thread(target=_worker, args=(f"dev{i}",)) for i in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert errors == []
    for i in range(3):
        sess = reg.get_or_create(f"dev{i}")
        assert sess is not None
        # 每设备累积 20 * 0.5s 音频（未触发切分前仍在会话内）
        assert sess.pending_samples <= 20 * (len(tone) // 2)


def test_pure_silence_file_produces_nothing():
    """纯静音文件不产出条目（避免 ASR 空转噪声写进增量数据）。"""
    sess = _mk()
    r = sess.ingest(session_id="s", seq=1, start_ms=T0, pcm=_pcm_silence(3.0), now_ms=T0)
    assert r.emitted == []
    assert sess.sweep(now_ms=T0 + 200_000) == []


# ============================================================
# 9. 注册表配置透传 / WAV 编解码 / 能量 VAD
# ============================================================

def test_registry_passes_stitch_options_to_session():
    """注册表把 audio.stream.stitch.* 参数透传给会话（容差/硬上限可配）。"""
    reg = AudioIngestRegistry(
        stitch_enabled=True, holdback_s=90.0, start_sweeper=False,
        channel_factory=make_channel_factory(),
        stitch={"tolerance_ms": 3000, "max_chunk_s": 30.0,
                "min_chunk_s": 2.0, "silence_cut_s": 0.8},
    )
    sess = reg.get_or_create("dev")
    assert sess._tolerance_ms == 3000
    assert sess._max_chunk_s == 30.0
    assert sess._min_chunk_s == 2.0
    assert sess._silence_cut_s == 0.8


def test_stitch_options_from_config_reads_nested_block():
    """配置提取函数：从 audio.stream 节读取 stitch 子块，缺省回退内置默认。"""
    from services.audio_ingest_session import stitch_options_from_config
    from services.audio_config import DEFAULT_AUDIO_CONFIG

    got = stitch_options_from_config({
        "stitch": {"tolerance_ms": 500, "max_chunk_s": 180.0,
                   "min_chunk_s": 5.0, "silence_cut_s": 2.0}
    })
    assert got == {"tolerance_ms": 500, "max_chunk_s": 180.0,
                   "min_chunk_s": 5.0, "silence_cut_s": 2.0}

    # 缺省回退：与内置默认配置一致
    assert stitch_options_from_config({}) == dict(
        DEFAULT_AUDIO_CONFIG["stream"]["stitch"]
    )
    # 内置默认值（容差 / 硬上限 / 最短块 / 静音端点）
    assert DEFAULT_AUDIO_CONFIG["stream"]["stitch"] == {
        "tolerance_ms": 1000, "max_chunk_s": 120.0,
        "min_chunk_s": 10.0, "silence_cut_s": 1.5,
    }


def test_build_and_decode_wav_roundtrip():
    """pcm_to_wav / decode_wav_pcm 往返一致，且为 16k/单声道/16bit。"""
    pcm = _pcm_tone(0.5, FREQ_A)
    wav = pcm_to_wav(pcm)
    decoded = decode_wav_pcm(wav)
    assert decoded is not None
    got_pcm, rate, channels, width = decoded
    assert (rate, channels, width) == (16000, 1, 2)
    assert got_pcm == pcm
    assert decode_wav_pcm(b"not-a-wav") is None


# ============================================================
# 10. （C5）切分通道降级：建立失败/中途断连 -> 逐段产出，镜像守恒不丢音频
# ============================================================

def test_channel_open_failure_degrades_to_per_segment_output():
    """通道建立失败 -> 本流降级为逐段独立产出；每段即时产出且样本守恒。"""
    sess = _mk(channel_factory=lambda start_ms, opts: BrokenChannel())
    a = _pcm_tone(2.0, FREQ_A)
    b = _pcm_tone(2.0, FREQ_B)

    r1 = sess.ingest(session_id="s", seq=1, start_ms=T0, pcm=a, now_ms=T0)
    assert len(r1.emitted) == 1, "降级流每段即时产出（无静音切分）"
    assert r1.emitted[0].pcm == a
    assert sess.stream_degraded is True
    assert not sess.has_pending_tail(), "降级产出不留镜像"

    r2 = sess.ingest(session_id="s", seq=2, start_ms=T0 + 2000, pcm=b, now_ms=T0 + 2000)
    assert len(r2.emitted) == 1 and r2.emitted[0].pcm == b


def test_channel_midway_failure_keeps_all_bytes():
    """通道中途断连 -> 已收割段照常、镜像兜底，全程样本数守恒（绝不丢音频）。"""
    sess = _mk(channel_factory=make_channel_factory(raise_on_push_after=1))
    a = _pcm_tone(2.0, FREQ_A)   # 第 1 次 push：正常走通道（无切点，未产出）
    b = _pcm_tone(2.0, FREQ_B)   # 第 2 次 push：断连（本段可能已进内核，按未送达处理）
    c = _pcm_tone(2.0, FREQ_C)   # 降级流：本段起逐段产出

    got = []
    for i, pcm in enumerate((a, b, c)):
        r = sess.ingest(session_id="s", seq=i, start_ms=T0 + i * 2000,
                        pcm=pcm, now_ms=T0 + i * 2000)
        got.extend(r.emitted)
    assert sess.stream_degraded is True
    got.extend(sess.flush())

    total = sum(_samples(x.pcm) for x in got)
    assert total == _samples(a) + _samples(b) + _samples(c), "样本守恒：断连不丢任何音频字节"
    # 产出时间轴不重叠（无重复音频）：按起点排序后逐段首尾相接
    got.sort(key=lambda x: x.start_ms)
    for prev, nxt in zip(got, got[1:]):
        assert nxt.start_ms >= prev.start_ms + _ms(prev.pcm) - 1, "产出段不得重叠"


def test_degrade_cooldown_skips_channel_for_new_streams():
    """降级冷却期内新流直接逐段产出，不再尝试建立通道（不反复付建连成本）。"""
    calls = []

    def _factory(start_ms, opts):
        calls.append(start_ms)
        return BrokenChannel()

    sess = _mk(channel_factory=_factory, degraded_cooldown_s=120.0)
    tone = _pcm_tone(1.0, FREQ_A)

    # 流1：尝试通道（1 次调用）-> 失败降级
    sess.ingest(session_id="s", seq=1, start_ms=T0, pcm=tone, now_ms=T0)
    assert len(calls) == 1
    sess.flush()

    # 流2（冷却期内）：直接降级，不再调工厂
    sess.ingest(session_id="s", seq=2, start_ms=T0 + 500_000, pcm=tone, now_ms=T0 + 500_000)
    assert len(calls) == 1, "冷却期内新流不得再尝试通道"
    sess.flush()


def test_channel_opts_map_stitch_config_to_kernel_segment_params():
    """无缝流/流参数经工厂 opts 映射到内核 segment 参数（C5 配置键映射表锁定）。"""
    seen = {}

    def _factory(start_ms, opts):
        seen.update(opts)
        seen["start_ms"] = start_ms
        return BrokenChannel()

    sess = DeviceIngestSession(
        "dev-map", min_chunk_s=7.5, silence_cut_s=2.5, max_chunk_s=99.0,
        tolerance_ms=1000, rms_threshold=3.75, frame_ms=20,
        channel_factory=_factory,
    )
    sess.ingest(session_id="s", seq=1, start_ms=T0, pcm=_pcm_tone(1.0, FREQ_A), now_ms=T0)

    assert seen["start_ms"] == T0            # t0 = 该流首段绝对起点
    assert seen["silence_cut_s"] == 2.5
    assert seen["min_chunk_s"] == 7.5
    assert seen["max_chunk_s"] == 99.0       # stitch.max_chunk_s -> 内核硬上限
    assert seen["rms_threshold"] == 3.75
    assert seen["frame_ms"] == 20


def test_holdback_flush_uses_channel_stop_and_closes():
    """空闲冲刷 = 通道 session.stop 语义（尾段由内核闭合送出），随后连接释放。"""
    made = []

    def _factory(start_ms, opts):
        ch = RefSegmentChannel(start_ms, opts)
        made.append(ch)
        return ch

    sess = _mk(channel_factory=_factory, holdback_s=90.0)
    tone = _pcm_tone(2.0, FREQ_A)
    sess.ingest(session_id="s", seq=1, start_ms=T0, pcm=tone, now_ms=T0)
    assert len(made) == 1 and made[0].opened

    out = sess.sweep(now_ms=T0 + 91_000)
    assert len(out) == 1 and out[0].trigger == "holdback"
    assert out[0].pcm == tone
    assert made[0].stopped is True, "holdback 冲刷必须走 session.stop"
    assert made[0].closed is True


def test_discontinuity_stops_channel_and_reopens_with_new_t0():
    """不连续冲刷：当前通道 stop 收尾段；新流以新起点重建通道（t0 更新）。"""
    made = []

    def _factory(start_ms, opts):
        ch = RefSegmentChannel(start_ms, opts)
        made.append(ch)
        return ch

    sess = _mk(channel_factory=_factory, tolerance_ms=1000)
    a = _pcm_tone(2.0, FREQ_A)
    b = _pcm_tone(2.0, FREQ_B)

    sess.ingest(session_id="s", seq=1, start_ms=T0, pcm=a, now_ms=T0)
    r2 = sess.ingest(session_id="s", seq=2, start_ms=T0 + 7000, pcm=b, now_ms=T0 + 7000)

    assert len(r2.emitted) == 1 and r2.emitted[0].trigger == "discontinuity"
    assert r2.emitted[0].pcm == a
    assert made[0].stopped is True and made[0].closed is True
    out = sess.flush()
    assert len(out) == 1 and out[0].pcm == b
    assert len(made) == 2, "不连续后新流必须重建通道"
    assert made[1]._t0 == T0 + 7000, "新通道 t0 锚 = 新流首段绝对起点"
