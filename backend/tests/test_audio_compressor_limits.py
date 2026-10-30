# -*- coding: utf-8 -*-
"""T2: AudioCompressor 的 ffmpeg 线程上限与 nice 优先级。

契约:
  1. config audio_compressor.ffmpeg_threads: int，缺省 0，夹取 0..64；
  2. config audio_compressor.nice: int，缺省 0，夹取 -20..19；
  3. 纯函数 _build_ffmpeg_archive_cmd 在 threads=0 / nice=0 时逐项等于旧命令；
     threads>0 在输出路径前加 -threads N；POSIX 且 nice!=0 前缀 nice -n N；
     Windows 跳过 nice；
  4. 构造器 ffmpeg_threads / nice 真的接到 ffmpeg 子进程命令上。
"""

import math
import os
import struct
import wave
from datetime import datetime, timedelta, timezone

import pytest

from config.config import Config

_FFMPEG = "/usr/bin/ffmpeg"
_CONCAT = "/data/_concat_2020-01-01.txt"
_ARCHIVE = "/data/audio_archive.m4a"

# 旧实现（audio_compressor.py 改造前）的完整 argv，逐项锁定：
# 归档编码参数（aac/48k/单声道/16k/+faststart）不得被本改动顺手改掉。
_OLD_CMD = [
    _FFMPEG, "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", _CONCAT,
    "-c:a", "aac",
    "-b:a", "48k",
    "-ac", "1",
    "-ar", "16000",
    "-movflags", "+faststart",
    _ARCHIVE,
]


def _config(**audio_compressor) -> Config:
    """构造 Config（补齐 opencode 必填项，避免 _validate_opencode 抛错）。"""
    return Config({
        "opencode": {
            "default_model": "m",
            "default_provider": "p",
            "default_agent": "a",
        },
        "audio_compressor": audio_compressor,
    })


# ============================================================
# 1. 配置默认值 / 解析 / 夹取
# ============================================================

def test_limits_default_to_zero():
    cfg = _config()
    assert cfg.AUDIO_COMPRESSOR_FFMPEG_THREADS == 0
    assert cfg.AUDIO_COMPRESSOR_NICE == 0


def test_ffmpeg_threads_parses_and_clamps():
    assert _config(ffmpeg_threads=8).AUDIO_COMPRESSOR_FFMPEG_THREADS == 8
    assert _config(ffmpeg_threads="12").AUDIO_COMPRESSOR_FFMPEG_THREADS == 12
    assert _config(ffmpeg_threads=99).AUDIO_COMPRESSOR_FFMPEG_THREADS == 64
    assert _config(ffmpeg_threads=-3).AUDIO_COMPRESSOR_FFMPEG_THREADS == 0
    assert _config(ffmpeg_threads="lots").AUDIO_COMPRESSOR_FFMPEG_THREADS == 0


def test_nice_parses_and_clamps():
    assert _config(nice=10).AUDIO_COMPRESSOR_NICE == 10
    assert _config(nice="-5").AUDIO_COMPRESSOR_NICE == -5
    assert _config(nice=30).AUDIO_COMPRESSOR_NICE == 19
    assert _config(nice=-30).AUDIO_COMPRESSOR_NICE == -20
    assert _config(nice="high").AUDIO_COMPRESSOR_NICE == 0


# ============================================================
# 2. 纯命令构建器
# ============================================================

def test_old_argv_unchanged_when_both_zero():
    from services.audio_compressor import _build_ffmpeg_archive_cmd

    cmd = _build_ffmpeg_archive_cmd(
        _FFMPEG, _CONCAT, _ARCHIVE, threads=0, nice=0
    )
    assert cmd == _OLD_CMD


def test_threads_appended_before_output_path():
    from services.audio_compressor import _build_ffmpeg_archive_cmd

    cmd = _build_ffmpeg_archive_cmd(
        _FFMPEG, _CONCAT, _ARCHIVE, threads=4, nice=0
    )
    assert cmd == _OLD_CMD[:-1] + ["-threads", "4", _ARCHIVE]


@pytest.mark.skipif(os.name == "nt", reason="nice 仅 POSIX 生效")
def test_nice_prefix_on_posix(monkeypatch):
    from services.audio_compressor import _build_ffmpeg_archive_cmd

    monkeypatch.setattr("sys.platform", "linux")
    cmd = _build_ffmpeg_archive_cmd(
        _FFMPEG, _CONCAT, _ARCHIVE, threads=0, nice=10
    )
    assert cmd == ["nice", "-n", "10"] + _OLD_CMD


def test_windows_skips_nice(monkeypatch):
    from services.audio_compressor import _build_ffmpeg_archive_cmd

    monkeypatch.setattr("sys.platform", "win32")
    cmd = _build_ffmpeg_archive_cmd(
        _FFMPEG, _CONCAT, _ARCHIVE, threads=2, nice=10
    )
    assert cmd == _OLD_CMD[:-1] + ["-threads", "2", _ARCHIVE]
    assert "nice" not in cmd


# ============================================================
# 3. 构造器接线：参数真的进入 ffmpeg 子进程 argv
# ============================================================

def _make_wav(path: str, seconds: float = 0.5) -> str:
    sample_rate = 16000
    num = int(sample_rate * seconds)
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        frames = bytearray()
        for i in range(num):
            t = i / sample_rate
            frames += struct.pack(
                "<h", int(32767 * 0.3 * math.sin(2 * math.pi * 440.0 * t))
            )
        wf.writeframes(bytes(frames))
    return path


class _FakeResult:
    returncode = 0
    stdout = ""
    stderr = ""


def test_constructor_wiring_reaches_ffmpeg_argv(tmp_path, monkeypatch):
    import services.audio_compressor as ac

    old_date = (
        datetime.now(timezone(timedelta(hours=8))).date() - timedelta(days=30)
    ).isoformat()
    audio_dir = tmp_path / "daily" / old_date / "audio"
    audio_dir.mkdir(parents=True)
    _make_wav(str(audio_dir / "120000_dev_1.wav"))

    calls = []

    def fake_run(cmd, **_kwargs):
        calls.append(list(cmd))
        if str(cmd[-1]).endswith(".m4a"):
            with open(cmd[-1], "wb") as f:
                f.write(b"\x00" * 1024)
        return _FakeResult()

    monkeypatch.setattr(ac.subprocess, "run", fake_run)

    comp = ac.AudioCompressor(
        data_dir=str(tmp_path), keep_days=2, ffmpeg_threads=4, nice=10
    )
    assert comp.ffmpeg_threads == 4
    assert comp.nice == 10

    ok = comp._compress_bucket_date_sync("daily", old_date)
    assert ok is True

    ffmpeg_calls = [c for c in calls if "concat" in c]
    assert len(ffmpeg_calls) == 1, f"应只有一次 ffmpeg 调用, 得到 {calls}"
    cmd = ffmpeg_calls[0]
    assert cmd[cmd.index("-threads") + 1] == "4"
    if os.name != "nt":
        assert cmd[:3] == ["nice", "-n", "10"], "POSIX 且 nice!=0 必须前缀 nice"


def test_constructor_defaults_keep_old_argv(tmp_path, monkeypatch):
    import services.audio_compressor as ac

    old_date = (
        datetime.now(timezone(timedelta(hours=8))).date() - timedelta(days=30)
    ).isoformat()
    audio_dir = tmp_path / "daily" / old_date / "audio"
    audio_dir.mkdir(parents=True)
    _make_wav(str(audio_dir / "120000_dev_1.wav"))

    calls = []

    def fake_run(cmd, **_kwargs):
        calls.append(list(cmd))
        if str(cmd[-1]).endswith(".m4a"):
            with open(cmd[-1], "wb") as f:
                f.write(b"\x00" * 1024)
        return _FakeResult()

    monkeypatch.setattr(ac.subprocess, "run", fake_run)

    comp = ac.AudioCompressor(data_dir=str(tmp_path), keep_days=2)
    assert comp.ffmpeg_threads == 0
    assert comp.nice == 0

    ok = comp._compress_bucket_date_sync("daily", old_date)
    assert ok is True

    cmd = [c for c in calls if "concat" in c][0]
    assert "-threads" not in cmd
    assert cmd[0] != "nice"
