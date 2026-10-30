# -*- coding: utf-8 -*-
"""48k -> 16k 重采样等价性：soxr 与 numpy-only FFT 参考实现对比。

参考实现不引入 scipy，确保精简运行时依赖（numpy + soxr）下测试可运行。
"""
import io

import numpy as np
import pytest
import soxr

SOURCE_SR = 48000
TARGET_SR = 16000


def _fft_resample(x, in_rate, out_rate):
    x = np.asarray(x, dtype=np.float64)
    n_in = len(x)
    n_out = int(round(n_in * out_rate / in_rate))
    spec = np.fft.rfft(x)
    n_out_bins = n_out // 2 + 1
    if n_out_bins <= len(spec):
        spec = spec[:n_out_bins]
    else:
        spec = np.pad(spec, (0, n_out_bins - len(spec)))
    return (np.fft.irfft(spec, n=n_out) * (n_out / n_in)).astype(np.float32)


def _tone_with_noise(seconds=1.0, sr=SOURCE_SR):
    rng = np.random.default_rng(20261029)
    t = np.arange(int(seconds * sr), dtype=np.float64) / sr
    noise = rng.standard_normal(t.size)
    freqs = np.fft.rfftfreq(t.size, 1.0 / sr)
    noise_spec = np.fft.rfft(noise)
    noise_spec[freqs > 6000] = 0
    noise = np.fft.irfft(noise_spec, n=t.size)
    noise /= np.max(np.abs(noise))
    signal = 0.5 * np.sin(2 * np.pi * 440 * t) + 0.2 * noise
    return (np.hanning(t.size) * signal).astype(np.float32)


def _relative_rms_diff(actual, expected):
    actual = np.asarray(actual, dtype=np.float64)
    expected = np.asarray(expected, dtype=np.float64)
    diff = actual - expected
    return np.sqrt(np.mean(diff ** 2)) / np.sqrt(np.mean(expected ** 2))


def test_48k_to_16k_matches_numpy_reference():
    signal = _tone_with_noise()
    actual = soxr.resample(signal, SOURCE_SR, TARGET_SR)
    expected = _fft_resample(signal, SOURCE_SR, TARGET_SR)

    assert abs(len(actual) - len(expected)) <= 1
    assert _relative_rms_diff(actual, expected) < 0.01


def test_soxr_output_is_float32():
    signal = _tone_with_noise(seconds=0.25)
    actual = soxr.resample(signal, SOURCE_SR, TARGET_SR)

    assert actual.dtype == np.float32
    assert actual.ndim == 1


def test_8k_upsample_to_16k_length():
    signal = _tone_with_noise(seconds=0.5, sr=8000)
    actual = soxr.resample(signal, 8000, TARGET_SR)

    assert actual.dtype == np.float32
    assert abs(len(actual) - len(signal) * 2) <= 1


def test_crop_wav_16k_mono_resamples_48k(tmp_path):
    import soundfile as sf

    from services.phi4_client import crop_wav_16k_mono

    signal = _tone_with_noise(seconds=0.5)
    src = tmp_path / "tone_48k.wav"
    sf.write(str(src), signal, SOURCE_SR, subtype="PCM_16")

    out = crop_wav_16k_mono(str(src), 0.0, 0.25)
    audio, sr = sf.read(io.BytesIO(out), dtype="float32")

    assert sr == TARGET_SR
    assert audio.ndim == 1
    assert abs(len(audio) - 0.25 * TARGET_SR) <= 1
    assert np.max(np.abs(audio)) > 0.1
