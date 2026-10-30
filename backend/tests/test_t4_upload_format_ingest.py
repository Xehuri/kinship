# -*- coding: utf-8 -*-
"""T4 后端: 上传格式(wav/flac)接收与保存链 TDD。

覆盖:
  1. sniff_audio_fmt: RIFF+WAVE / fLaC / 裸RIFF(非WAVE) / 短数据 —— 不信任 Content-Type;
  2. decode_audio_pcm: flac fixture 解码 PCM ≡ 同源 wav fixture PCM(逐字节);
  3. encode_audio_bytes: flac 编码产出 fLaC 魔数,失败回退 WAV;
  4. save_audio ext: flac 落 .flac 文件名, 非法 ext 回退 .wav;
  5. _wav_duration_ms: flac 走 soundfile(禁 len/32), wav 回归。
"""

import io

import pytest


# ============================================================
# 1. magic sniff
# ============================================================

def test_sniff_wav_riff_wave():
    from services.audio_ingest_session import sniff_audio_fmt

    # 标准 WAV 头: RIFF....WAVE
    data = b"RIFF" + (36).to_bytes(4, "little") + b"WAVEfmt "
    assert sniff_audio_fmt(data) == "wav"


def test_sniff_flac_magic():
    from services.audio_ingest_session import sniff_audio_fmt

    assert sniff_audio_fmt(b"fLaC" + b"\x00" * 40) == "flac"


def test_sniff_bare_riff_is_not_wav():
    """delta: 裸 RIFF 也匹配 WebP/AVI —— RIFF 必须配 8-11 位 WAVE。"""
    from services.audio_ingest_session import sniff_audio_fmt

    # RIFF + WEBP(伪)
    data = b"RIFF" + (36).to_bytes(4, "little") + b"WEBP"
    assert sniff_audio_fmt(data) != "wav"
    assert sniff_audio_fmt(data) == "unknown"


def test_sniff_short_or_empty_unknown():
    from services.audio_ingest_session import sniff_audio_fmt

    assert sniff_audio_fmt(b"") == "unknown"
    assert sniff_audio_fmt(b"RIFF") == "unknown"


# ============================================================
# 2. flac fixture 解码 ≡ wav fixture PCM（计划必含断言）
# ============================================================

def _make_pcm_fixture(tmp_path):
    """同一段 int16 PCM 分别写 wav 与 flac，返回 (wav_bytes, flac_bytes)。

    用 int16 源而非 float32：两条格式的写入路径共享同一次量化，
    FLAC 无损编码保证解码字节与 WAV data 区逐字节一致。
    """
    import numpy as np
    import soundfile as sf

    sr = 16000
    t = np.arange(int(sr * 0.5)) / sr
    # int16 正弦（确定性量化，避开 float32 双路径 ±1 LSB 差异）
    pcm_i16 = (0.3 * 32767 * np.sin(2 * np.pi * 440.0 * t)).astype(np.int16)

    wav_buf = io.BytesIO()
    sf.write(wav_buf, pcm_i16, sr, format="WAV", subtype="PCM_16")
    flac_buf = io.BytesIO()
    sf.write(flac_buf, pcm_i16, sr, format="FLAC", subtype="PCM_16")
    return wav_buf.getvalue(), flac_buf.getvalue()


def test_decode_flac_pcm_equals_wav_pcm(tmp_path):
    """计划必含: flac fixture 解码 PCM ≡ wav fixture PCM（逐字节）。"""
    from services.audio_ingest_session import decode_audio_pcm

    wav_bytes, flac_bytes = _make_pcm_fixture(tmp_path)

    dec_wav = decode_audio_pcm(wav_bytes)
    dec_flac = decode_audio_pcm(flac_bytes)

    assert dec_wav is not None, "wav 应可解码"
    assert dec_flac is not None, "flac 应可解码"

    pcm_wav, rate_w, ch_w, w_w = dec_wav
    pcm_flac, rate_f, ch_f, w_f = dec_flac

    assert (rate_w, ch_w, w_w) == (16000, 1, 2)
    assert (rate_f, ch_f, w_f) == (16000, 1, 2)
    assert pcm_flac == pcm_wav, "flac 与 wav 解码出的 PCM 必须逐字节一致"


def test_decode_alias_backward_compat(tmp_path):
    """decode_wav_pcm 旧名仍可用（既有调用方/测试不炸）。"""
    from services.audio_ingest_session import decode_audio_pcm, decode_wav_pcm

    wav_bytes, _ = _make_pcm_fixture(tmp_path)
    assert decode_wav_pcm is decode_audio_pcm
    assert decode_wav_pcm(wav_bytes) is not None


# ============================================================
# 3. encode_audio_bytes: flac 产出 fLaC, 失败回退 wav
# ============================================================

def test_encode_flac_produces_flac_magic():
    from services.audio_ingest_session import encode_audio_bytes

    pcm = bytes(3200)  # 1600 样本静音 s16le
    out = encode_audio_bytes(pcm, fmt="flac")
    assert out[:4] == b"fLaC", "flac 封装必须产出 fLaC 魔数"


def test_encode_wav_default_and_fallback():
    from services.audio_ingest_session import encode_audio_bytes

    pcm = bytes(3200)
    out = encode_audio_bytes(pcm)  # 默认 wav
    assert out[:4] == b"RIFF"
    out2 = encode_audio_bytes(pcm, fmt="ogg")  # 非法值回退 wav
    assert out2[:4] == b"RIFF"


# ============================================================
# 4. save_audio ext 白名单
# ============================================================

def test_save_audio_flac_extension(isolated_store):
    from services import perception_store

    start_ms = 1_757_836_800_000
    rel = perception_store.save_audio(
        b"fLaC" + b"\x00" * 64,
        device_id="dev-flac",
        start_ms=start_ms,
        end_ms=start_ms + 1000,
        ext="flac",
    )
    assert rel is not None
    assert rel.endswith(".flac")
    import os

    abs_path = os.path.join(str(isolated_store), rel.replace("/", os.sep))
    assert os.path.exists(abs_path)


def test_save_audio_invalid_ext_falls_back_wav(isolated_store):
    from services import perception_store

    start_ms = 1_757_836_800_000
    rel = perception_store.save_audio(
        b"RIFF-fake",
        device_id="dev-x",
        start_ms=start_ms,
        end_ms=start_ms + 1000,
        ext="../evil",
    )
    assert rel is not None
    assert rel.endswith(".wav"), "非法 ext 必须回退 .wav（防路径注入）"


def test_save_audio_default_remains_wav(isolated_store):
    from services import perception_store

    rel = perception_store.save_audio(b"RIFF-fake", device_id="dev-d")
    assert rel.endswith(".wav")


# ============================================================
# 5. _wav_duration_ms 格式感知
# ============================================================

def test_duration_flac_uses_soundfile_not_len_div(tmp_path):
    from routers.perception import _wav_duration_ms

    _, flac_bytes = _make_pcm_fixture(tmp_path)
    dur = _wav_duration_ms(flac_bytes)
    # 0.5s fixture，允许小误差
    assert 450 <= dur <= 550, f"flac 时长应约 500ms, 得到 {dur}ms"
    # len/32 对压缩流会严重低估: flac 字节数远小于 PCM, len/32 << 500
    assert len(flac_bytes) / 32 < 200, "前置: 压缩字节 len/32 必然偏离(证伪旧数学)"


def test_duration_wav_regression(tmp_path):
    from routers.perception import _wav_duration_ms

    wav_bytes, _ = _make_pcm_fixture(tmp_path)
    dur = _wav_duration_ms(wav_bytes)
    assert 450 <= dur <= 550


def test_duration_unknown_returns_zero():
    from routers.perception import _wav_duration_ms

    # 非 wav/flac 且 wave 解析失败: 仍走 wav 回退 len/32（旧行为）
    assert _wav_duration_ms(b"") == 0


@pytest.fixture
def isolated_store(monkeypatch, tmp_path):
    """把感知存储根目录重定向到临时目录（照抄 provenance 测试）。"""
    from services import perception_store

    data_root = tmp_path / "data"
    monkeypatch.setattr(perception_store, "_DATA_BASE", str(data_root / "daily"))
    monkeypatch.setattr(perception_store, "_STREAM_AUDIO_BASE", str(data_root / "stream"))
    return data_root
