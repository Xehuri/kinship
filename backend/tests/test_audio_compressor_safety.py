# -*- coding: utf-8 -*-
"""T1 止血: audio_compressor 双后缀归档 + rmtree 防丢测试。

风险背景: 原实现只把 .wav 列入归档清单, 却对整个 audio/ 目录 rmtree,
清单外的 .flac 被静默删除(内容未进 m4a = 数据永久丢失)。

改造契约:
  1. 日期检测与归档清单同时收 .wav + .flac;
  2. 时长解析: WAV 走 RIFF 快解析, 其他格式 soundfile 兜底;
  3. rmtree 前断言: 清单外无残留音频文件, 有残留则只删清单内文件;
  4. 混格式目录压缩成功, index.original_files 计数含 flac(内容不丢)。

V18 追加契约(§5-§7): 扫描桶扩展 daily+stream 两支共用同一实现;
stream 60s 间隔流式 wav 走同一压缩前校验姿势端到端成立;
归档指针改写纯函数 rewrite_archived_pointers 的行为锁定(未接线默认写链)。
"""

import asyncio
import math
import struct
import wave

import pytest


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
            frames += struct.pack("<h", int(32767 * 0.3 * math.sin(2 * math.pi * 440.0 * t)))
        wf.writeframes(bytes(frames))
    return path


def _make_flac(path: str, seconds: float = 0.5) -> str:
    import numpy as np
    import soundfile as sf

    sample_rate = 16000
    num = int(sample_rate * seconds)
    t = np.arange(num) / sample_rate
    data = (0.3 * np.sin(2 * np.pi * 440.0 * t)).astype(np.float32)
    sf.write(path, data, sample_rate, format="FLAC", subtype="PCM_16")
    return path


@pytest.fixture
def old_date_tree(tmp_path):
    """构造一个超过 keep_days 的旧日期目录: daily/2020-01-01/audio/。"""
    from datetime import datetime, timedelta, timezone

    old = (datetime.now(timezone(timedelta(hours=8))).date() - timedelta(days=30)).isoformat()
    audio_dir = tmp_path / "daily" / old / "audio"
    audio_dir.mkdir(parents=True)
    return {"root": str(tmp_path), "date": old, "audio_dir": str(audio_dir)}


# ============================================================
# 1. 日期检测: 纯 flac 目录也要被选中
# ============================================================

def test_dates_include_flac_only_dir(old_date_tree):
    from services.audio_compressor import AudioCompressor

    _make_flac(f"{old_date_tree['audio_dir']}/only.flac")

    comp = AudioCompressor(data_dir=old_date_tree["root"], keep_days=2)
    dates = comp._scan_bucket_dates("daily")

    assert old_date_tree["date"] in dates, "纯 flac 目录必须被日期检测选中"


def test_dates_include_mixed_dir(old_date_tree):
    from services.audio_compressor import AudioCompressor

    _make_wav(f"{old_date_tree['audio_dir']}/a.wav")
    _make_flac(f"{old_date_tree['audio_dir']}/b.flac")

    comp = AudioCompressor(data_dir=old_date_tree["root"], keep_days=2)
    dates = comp._scan_bucket_dates("daily")

    assert old_date_tree["date"] in dates


# ============================================================
# 2. 时长解析: flac 走 soundfile 兜底
# ============================================================

def test_parse_duration_flac_fallback(tmp_path):
    from services.audio_compressor import _parse_duration

    flac = _make_flac(str(tmp_path / "d.flac"), seconds=0.75)
    dur = _parse_duration(flac)

    assert 0.7 <= dur <= 0.8, f"flac 时长应约 0.75s, 得到 {dur}"


def test_parse_duration_wav_fast_path(tmp_path):
    from services.audio_compressor import _parse_duration

    wav = _make_wav(str(tmp_path / "d.wav"), seconds=1.0)
    dur = _parse_duration(wav)

    assert 0.95 <= dur <= 1.05, f"wav 时长应约 1s, 得到 {dur}"


# ============================================================
# 3. rmtree 前断言: 清单外残留音频不得被整目录删除
# ============================================================

def test_purge_keeps_out_of_list_flac(old_date_tree, monkeypatch):
    """清单外 .flac 残留(竞态写入): 只删清单内, 残留必须活下来。"""
    from services.audio_compressor import AudioCompressor

    audio_dir = old_date_tree["audio_dir"]
    keep_wav = _make_wav(f"{audio_dir}/in_list.wav")
    stray_flac = _make_flac(f"{audio_dir}/stray.flac")

    comp = AudioCompressor(data_dir=old_date_tree["root"], keep_days=2)
    comp._safe_purge_audio_dir(audio_dir, {"in_list.wav"})

    assert not __import__("os").path.exists(keep_wav), "清单内文件应被删除"
    assert __import__("os").path.exists(stray_flac), "清单外残留 flac 必须保留(防丢)"


def test_purge_rmtree_when_clean(old_date_tree):
    """清单收全时(无残留): 目录整体删除, 与原行为一致。"""
    import os

    from services.audio_compressor import AudioCompressor

    audio_dir = old_date_tree["audio_dir"]
    wav = _make_wav(f"{audio_dir}/a.wav")
    flac = _make_flac(f"{audio_dir}/b.flac")

    comp = AudioCompressor(data_dir=old_date_tree["root"], keep_days=2)
    comp._safe_purge_audio_dir(audio_dir, {"a.wav", "b.flac"})

    assert not os.path.exists(wav)
    assert not os.path.exists(flac)
    assert not os.path.isdir(audio_dir), "无残留时整目录删除(原行为)"


# ============================================================
# 4. 混格式压缩端到端: 内容不丢(计数含 flac), 原件按 keep_wavs 处理
# ============================================================

def test_compress_mixed_tree_no_loss(old_date_tree):
    """wav+flac 混目录: 压缩成功, original_files=2(flac 进了归档清单)。"""
    import json
    import os

    from services.audio_compressor import AudioCompressor, ARCHIVE_FILENAME

    audio_dir = old_date_tree["audio_dir"]
    _make_wav(f"{audio_dir}/120000_dev_1.wav")
    _make_flac(f"{audio_dir}/120010_dev_2.flac")

    comp = AudioCompressor(
        data_dir=old_date_tree["root"], keep_days=2, keep_wavs=False
    )
    ok = comp._compress_bucket_date_sync("daily", old_date_tree["date"])
    assert ok is True, "混格式(wav+flac)必须压缩成功"

    date_dir = os.path.join(old_date_tree["root"], "daily", old_date_tree["date"])
    archive = os.path.join(date_dir, ARCHIVE_FILENAME)
    index_path = os.path.join(date_dir, "audio_archive_index.json")
    assert os.path.exists(archive), "m4a 归档必须生成"
    assert os.path.exists(index_path), "索引必须生成"

    with open(index_path, encoding="utf-8") as f:
        index = json.load(f)
    assert index["original_files"] == 2, (
        f"归档清单必须含 flac(original_files=2), 得到 {index['original_files']}"
    )
    # keep_wavs=False 且无残留 -> audio 目录已清
    assert not os.path.isdir(audio_dir), "压缩后原件目录应被清理"


# ============================================================
# 5. V18: 扫描桶扩展 daily+stream（同一实现, 互不串桶）
# ============================================================

def _old_date(days=30):
    from datetime import datetime, timedelta, timezone
    return (datetime.now(timezone(timedelta(hours=8))).date() - timedelta(days=days)).isoformat()


def test_scan_buckets_are_isolated_and_share_filter(tmp_path):
    """daily 与 stream 两桶各自被扫到、互不混入；.analysis.wav 两支同口径排除。"""
    import os
    from services.audio_compressor import AudioCompressor

    d_old, s_old = _old_date(), _old_date()
    daily_audio = tmp_path / "daily" / d_old / "audio"
    stream_audio = tmp_path / "stream" / s_old / "audio"
    daily_audio.mkdir(parents=True)
    stream_audio.mkdir(parents=True)
    _make_wav(str(daily_audio / "120000_dev_1.wav"))
    _make_wav(str(daily_audio / "120010_dev_1.analysis.wav"))  # 排除口径
    _make_wav(str(stream_audio / "132000-132100_dev1_1758000000000.wav"))

    comp = AudioCompressor(data_dir=str(tmp_path), keep_days=2)
    assert comp._scan_bucket_dates("daily") == [d_old], "daily 桶只收 daily 支日期"
    assert comp._scan_bucket_dates("stream") == [s_old], "stream 桶只收 stream 支日期"
    assert comp._scan_bucket_dates("nonexistent") == []


def test_compress_all_returns_bucket_items_and_covers_stream(tmp_path):
    """compress_all 双桶驱动: 返回 "bucket/date" 项; stream 支到点即被清扫(不留单向堆积)。"""
    import asyncio
    import os

    from services.audio_compressor import AudioCompressor, ARCHIVE_FILENAME

    s_old = _old_date()
    stream_audio = tmp_path / "stream" / s_old / "audio"
    stream_audio.mkdir(parents=True)
    _make_wav(str(stream_audio / "132000-132010_dev1_1758000000000.wav"), seconds=0.5)
    _make_wav(str(stream_audio / "132010-132020_dev1_1758000600000.wav"), seconds=0.5)

    comp = AudioCompressor(data_dir=str(tmp_path), keep_days=2)
    completed = asyncio.run(comp.compress_all())

    assert completed == [f"stream/{s_old}"], f"返回须为 bucket/date 形态, 得到 {completed}"
    date_dir = str(tmp_path / "stream" / s_old)
    assert os.path.exists(os.path.join(date_dir, ARCHIVE_FILENAME)), "stream 支 m4a 归档必须生成"
    assert os.path.exists(os.path.join(date_dir, "audio_archive_index.json"))
    assert not os.path.isdir(str(stream_audio)), "stream 支原件目录应被清理"
    # 幂等: 已归档日无 audio/ 目录, 不再入选
    assert comp._scan_bucket_dates("stream") == []


# ============================================================
# 6. V18: stream 60s 间隔流式 wav 走同一压缩前校验姿势(端到端)
# ============================================================

def test_stream_60s_chunks_pass_same_validation(tmp_path):
    """两支 60s 16k/单声道/16bit 流式 wav: RIFF 时长解析>0、ffmpeg 合并成功、
    ffprobe 实测时长与预期差 ≤5%(与 _compress_bucket_date_sync 校验姿势同判据)、
    索引 time 前缀取新文件名起始 HHMMSS。"""
    import json
    import os

    from services.audio_compressor import (
        AudioCompressor, ARCHIVE_FILENAME, _get_archive_duration,
    )

    s_old = _old_date()
    stream_audio = tmp_path / "stream" / s_old / "audio"
    stream_audio.mkdir(parents=True)
    # 文件名即生产流式口径 {起HHMMSS}-{止HHMMSS}_{device}_{startms}.wav, 60s 间隔
    _make_wav(str(stream_audio / "132000-132100_dev1_1758000000000.wav"), seconds=60.0)
    _make_wav(str(stream_audio / "132100-132200_dev1_1758006000000.wav"), seconds=60.0)

    comp = AudioCompressor(data_dir=str(tmp_path), keep_days=2)
    assert comp._scan_bucket_dates("stream") == [s_old]

    ok = comp._compress_bucket_date_sync("stream", s_old)
    assert ok is True, "60s 流式 wav 必须通过同一压缩前校验并成功"

    date_dir = str(tmp_path / "stream" / s_old)
    index_path = os.path.join(date_dir, "audio_archive_index.json")
    with open(index_path, encoding="utf-8") as f:
        index = json.load(f)

    assert index["original_files"] == 2
    assert [s["time"] for s in index["segments"]] == ["132000", "132100"], (
        "流式新格式文件名必须截起始 HHMMSS(不塌缩成 '132000-132100')"
    )
    assert abs(index["duration"] - 120.0) <= 0.01, f"RIFF 预期时长应≈120s, 得到 {index['duration']}"

    ffprobe_dur = _get_archive_duration(os.path.join(date_dir, ARCHIVE_FILENAME))
    if ffprobe_dur > 0:  # ffprobe 在场即复核 5% 判据(与实现同阈值)
        diff_ratio = abs(ffprobe_dur - index["duration"]) / index["duration"]
        assert diff_ratio <= 0.05, f"归档实测时长偏差 {diff_ratio:.3f} 须 ≤5%"
    assert not os.path.isdir(stream_audio), "校验通过(未超阈值)原件目录应删除"


# ============================================================
# 7. V18: 归档指针改写纯函数(未接线默认写链, 行为锁定)
# ============================================================

_INDEX = {
    "date": "2020-01-01",
    "segments": [
        {"time": "120000", "filename": "120000-120100_dev_1.wav", "start": 0.0, "end": 60.0},
        {"time": "120100", "filename": "120100-120200_dev_2.flac", "start": 60.0, "end": 118.5},
    ],
}


def test_rewrite_pointers_hit_and_miss():
    from services.audio_compressor import rewrite_archived_pointers

    entries = [
        {"type": "voice", "t": "12:00:00",
         "audio": "daily/2020-01-01/audio/120000-120100_dev_1.wav"},
        {"type": "voice", "t": "12:01:00",
         "audio": "daily/2020-01-01/audio/120100-120200_dev_2.flac"},
        {"type": "voice", "t": "12:02:00",
         "audio": "daily/2020-01-01/audio/not_in_index.wav"},
        {"type": "sensor", "t": "12:03:00", "phone_battery": 50},
    ]
    out = rewrite_archived_pointers(entries, _INDEX, "2020-01-01")

    assert out[0]["audio"] == "daily/2020-01-01/audio_archive.m4a"
    assert out[0]["archive_start"] == 0.0 and out[0]["archive_end"] == 60.0
    assert out[0]["orig_file"] == "120000-120100_dev_1.wav"
    assert out[1]["audio"] == "daily/2020-01-01/audio_archive.m4a"
    assert out[1]["archive_start"] == 60.0 and out[1]["archive_end"] == 118.5
    assert out[2] == entries[2], "未命中清单的条目原样"
    assert out[3] == entries[3], "无指针键的条目原样"


def test_rewrite_pointers_input_not_mutated_and_returns_new_list():
    import copy

    from services.audio_compressor import rewrite_archived_pointers

    entries = [{"type": "voice",
                "audio": "daily/2020-01-01/audio/120000-120100_dev_1.wav"}]
    snapshot = copy.deepcopy(entries)
    out = rewrite_archived_pointers(entries, _INDEX, "2020-01-01")

    assert entries == snapshot, "纯函数: 输入 entries 不得被变异"
    assert out is not entries
    assert out[0] is not entries[0], "被改写条目须以新 dict 返回"


def test_rewrite_pointers_cross_date_and_src_file_key():
    from services.audio_compressor import rewrite_archived_pointers

    # 跨日期引用: 本函数按 index 所属日期负责, 他日指针不动(真实数据确有 T+1 补传引用)
    cross = [{"type": "voice", "audio": "daily/2019-12-31/audio/120000-120100_dev_1.wav"}]
    out = rewrite_archived_pointers(cross, _INDEX, "2020-01-01")
    assert out == cross

    # src_file 裸文件名键同样改写(内核溯源条目形态)
    src = [{"src_file": "120100-120200_dev_2.flac", "src_t": "12:01:00"}]
    out2 = rewrite_archived_pointers(src, _INDEX, "2020-01-01")
    assert out2[0]["src_file"] == "audio_archive.m4a"
    assert out2[0]["archive_start"] == 60.0 and out2[0]["orig_file"] == "120100-120200_dev_2.flac"
    assert "audio" not in out2[0], "无 audio 键不得凭空构造"


def test_rewrite_pointers_empty_index_passthrough():
    from services.audio_compressor import rewrite_archived_pointers

    entries = [{"audio": "daily/2020-01-01/audio/a.wav"}]
    out = rewrite_archived_pointers(entries, {"segments": []}, "2020-01-01")
    assert out == entries
