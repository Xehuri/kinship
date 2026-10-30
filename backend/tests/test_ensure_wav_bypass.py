# -*- coding: utf-8 -*-
"""T1 止血: _ensure_wav 旁路改造测试。

B 类高危背景: 原实现将非 WAV 用 ffmpeg 转码后 os.replace 就地覆盖原文件,
原文件字节被毁(未来 .flac 上传时原件内容永久丢失)。

改造契约:
  1. 有效 WAV -> 返回原路径, sha256 不变;
  2. 非 WAV -> 转码到旁路 {stem}.analysis.wav 并返回旁路路径,
     原文件 sha256 前后不变(不覆盖);
  3. 无法转换(无 ffmpeg / 转码失败) -> 返回 None, 原文件不动;
  4. analyze_audio_file: 分析走旁路 WAV, perception.jsonl 仍指原件。
"""

import hashlib
import math
import struct
import subprocess
import wave

import pytest


def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _make_wav(path: str, seconds: float = 0.5) -> str:
    """16kHz/单声道/16bit 正弦 WAV。"""
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
    """用 soundfile 生成真实 FLAC(16kHz/单声道/PCM_16)。"""
    import numpy as np
    import soundfile as sf

    sample_rate = 16000
    num = int(sample_rate * seconds)
    t = np.arange(num) / sample_rate
    data = (0.3 * np.sin(2 * np.pi * 440.0 * t)).astype(np.float32)
    sf.write(path, data, sample_rate, format="FLAC", subtype="PCM_16")
    return path


# ============================================================
# 1-3. _ensure_wav 旁路契约
# ============================================================

def test_valid_wav_returns_same_path_unchanged(tmp_path):
    """已是有效 WAV: 返回原路径, 字节不变, 不产生旁路文件。"""
    from services.audio_analysis_pipeline import _ensure_wav

    wav = _make_wav(str(tmp_path / "seg.wav"))
    digest_before = _sha256(wav)

    out = _ensure_wav(wav)

    assert out == wav, "有效 WAV 应原样返回原路径"
    assert _sha256(wav) == digest_before, "有效 WAV 字节不得变化"
    assert not (tmp_path / "seg.analysis.wav").exists(), "无需生成旁路文件"


def test_non_wav_bypass_not_overwrite(tmp_path):
    """非 WAV: 转码到 {stem}.analysis.wav 旁路, 原文件 sha256 前后不变。"""
    from services.audio_analysis_pipeline import _ensure_wav

    flac = _make_flac(str(tmp_path / "seg.flac"))
    digest_before = _sha256(flac)

    out = _ensure_wav(flac)

    assert out is not None, "有 ffmpeg 时非 WAV 应转码成功"
    assert out != flac, "必须返回旁路路径, 不得返回原路径"
    assert out.endswith(".analysis.wav"), f"旁路文件名应为 {{stem}}.analysis.wav, 得到 {out}"
    assert _sha256(flac) == digest_before, "原文件字节严禁被覆盖(B 类高危回归)"
    # 旁路必须是可被 wave 模块读取的有效 WAV
    with wave.open(out, "rb") as wf:
        assert wf.getframerate() == 16000
        assert wf.getnchannels() == 1


def test_non_wav_no_ffmpeg_returns_none(tmp_path, monkeypatch):
    """无 ffmpeg 可用: 返回 None, 原文件不动, 不留半成品。"""
    from services.audio_analysis_pipeline import _ensure_wav

    flac = _make_flac(str(tmp_path / "seg.flac"))
    digest_before = _sha256(flac)

    def _boom(*args, **kwargs):
        raise FileNotFoundError("ffmpeg not found")

    monkeypatch.setattr(subprocess, "run", _boom)

    out = _ensure_wav(flac)

    assert out is None, "无法转换时必须返回 None"
    assert _sha256(flac) == digest_before, "失败路径也不得改动原文件"
    assert not (tmp_path / "seg.analysis.wav").exists(), "失败时不得留半成品旁路"


# ============================================================
# 4. analyze_audio_file: 分析走旁路, jsonl 指原件
#    (B5t 迁移: B2 删除降级全家桶后, 算法唯一路径是内核作业——以作业缝
#     收到的路径断言"分析走旁路", 不再经本地 mgr.analyze)
# ============================================================

def _patch_kernel_seams(monkeypatch, text: str, seen_paths: list):
    """主链作业缝: 记录内核收到的(旁路)路径并返回带文本的最小 facts。"""
    import services.kernel_job_client as kjc
    import services.audio_analysis_pipeline as pipeline_mod

    def _spy_jobs(path):
        seen_paths.append(path)
        return {
            "analyze.vad": {"duration_ms": 500, "segments": []},
            "analyze.asr": {"duration_ms": 500, "text": text, "segments": []},
            "analyze.scene": {"duration_ms": 500, "scene_primary": None,
                              "scene_tags": [], "scene_groups": {}},
            "analyze.diarize": {"duration_ms": 500, "segments": []},
        }

    monkeypatch.setattr(kjc, "run_audio_analysis_jobs", _spy_jobs)
    monkeypatch.setattr(
        kjc, "run_residual_analysis_jobs",
        lambda path, **kw: {k: None for k in ("analyze.aed", "analyze.breath")},
    )
    monkeypatch.setattr(pipeline_mod, "_unknown_speaker_enabled", lambda: False)
    monkeypatch.setattr(pipeline_mod, "_schedule_retry", lambda *a, **k: None)


def test_analyze_uses_bypass_jsonl_points_original(tmp_path, monkeypatch):
    """flac 输入: 内核收到旁路 WAV, perception.jsonl 的 audio 字段指原件 flac。"""
    from services import perception_store
    from services.audio_analysis_pipeline import analyze_audio_file

    flac = _make_flac(str(tmp_path / "voice.flac"))
    digest_before = _sha256(flac)

    # 作业缝: 记录内核实际收到的分析路径
    analyzed_paths = []
    _patch_kernel_seams(monkeypatch, "旁路测试", analyzed_paths)

    # (B5t) 陌生人聚合已改管线内置纯内存聚合 _summarize_unk_entry，
    # 不再 import unknown_speaker_pipeline——旧 no-op 补丁随接线删除。
    import services.kernel_client as kc_mod

    monkeypatch.setattr(kc_mod, "vp_speaker_count", lambda: 0)
    monkeypatch.setattr(kc_mod, "vp_cohort_stats", lambda: {})

    # DATA_DIR 与测试音频同盘(Windows 跨盘 relpath 会抛错)
    import config.config as cfg_mod

    class _FakeCfg:
        DATA_DIR = str(tmp_path)

    monkeypatch.setattr(cfg_mod, "get_config", lambda: _FakeCfg())

    # 记录 append_perception
    entries = []
    monkeypatch.setattr(
        perception_store, "append_perception",
        lambda entry, user_id="default", auto_type=True, date_str=None: entries.append(entry) or True,
    )

    analyze_audio_file(flac, None, device_name="dev-bypass")

    # 分析路径必须是旁路 WAV
    assert analyzed_paths, "内核作业必须收到分析路径"
    got = analyzed_paths[0]
    assert got.endswith(".analysis.wav"), f"分析必须走旁路, 得到 {got}"
    # 原件不变
    assert _sha256(flac) == digest_before, "分析后原件字节不得变化(B 类高危回归)"
    # jsonl 指原件(相对路径), 不是旁路
    assert entries, "upload 必须写 perception 条目"
    audio_rel = entries[0].get("audio", "")
    assert audio_rel.endswith("voice.flac"), (
        f"perception.audio 必须指原件 flac, 得到 {audio_rel}"
    )
    assert ".analysis" not in audio_rel, "jsonl 不得暴露旁路文件名"


def test_analyze_purges_bypass_after_done(tmp_path, monkeypatch):
    """瞬态旁路: flac 分析结束后 {stem}.analysis.wav 必须被清理, 原件保留。

    契约: .analysis.wav 是分析用的临时转码衍生品, 不得在数据目录持久保存。
    (B5t: 分析路径断言从 mgr.analyze 改到内核作业缝记录的路径)
    """
    import os

    from services import perception_store
    from services.audio_analysis_pipeline import analyze_audio_file

    flac = _make_flac(str(tmp_path / "voice.flac"))

    analyzed_paths = []
    _patch_kernel_seams(monkeypatch, "清理测试", analyzed_paths)

    # (B5t) 陌生人聚合已改管线内置纯内存聚合 _summarize_unk_entry，
    # 不再 import unknown_speaker_pipeline——旧 no-op 补丁随接线删除。
    import services.kernel_client as kc_mod

    monkeypatch.setattr(kc_mod, "vp_speaker_count", lambda: 0)
    monkeypatch.setattr(kc_mod, "vp_cohort_stats", lambda: {})

    import config.config as cfg_mod

    class _FakeCfg:
        DATA_DIR = str(tmp_path)

    monkeypatch.setattr(cfg_mod, "get_config", lambda: _FakeCfg())
    monkeypatch.setattr(
        perception_store, "append_perception",
        lambda entry, user_id="default", auto_type=True, date_str=None: True,
    )

    analyze_audio_file(flac, None, device_name="dev-purge")

    # 分析期间旁路存在(作业缝收到的是旁路路径, 此刻尚未进 finally)
    assert analyzed_paths and analyzed_paths[0].endswith(".analysis.wav")
    # 分析结束: 旁路被清理, 原件保留
    assert not (tmp_path / "voice.analysis.wav").exists(), \
        "分析结束旁路 .analysis.wav 必须被清理, 不落数据目录"
    assert os.path.isfile(flac), "原件 flac 必须保留(绝不因清理旁路误删原件)"


def test_valid_wav_analyze_does_not_delete_original(tmp_path, monkeypatch):
    """WAV 上传档: _ensure_wav 原样返回路径(旁路==原件), 清理不得删原件。"""
    import os

    from services import perception_store
    from services.audio_analysis_pipeline import analyze_audio_file

    wav = _make_wav(str(tmp_path / "seg.wav"))

    analyzed_paths = []
    _patch_kernel_seams(monkeypatch, "原样", analyzed_paths)

    # (B5t) 陌生人聚合已改管线内置纯内存聚合 _summarize_unk_entry，
    # 不再 import unknown_speaker_pipeline——旧 no-op 补丁随接线删除。
    import services.kernel_client as kc_mod

    monkeypatch.setattr(kc_mod, "vp_speaker_count", lambda: 0)
    monkeypatch.setattr(kc_mod, "vp_cohort_stats", lambda: {})

    import config.config as cfg_mod

    class _FakeCfg:
        DATA_DIR = str(tmp_path)

    monkeypatch.setattr(cfg_mod, "get_config", lambda: _FakeCfg())
    monkeypatch.setattr(
        perception_store, "append_perception",
        lambda entry, user_id="default", auto_type=True, date_str=None: True,
    )

    analyze_audio_file(wav, None, device_name="dev-wav")

    # WAV 原件路径不以 .analysis.wav 结尾, 清理逻辑必须跳过 -> 原件还在
    assert os.path.isfile(wav), "WAV 原件绝不被误删"
    # 作业缝收到的分析路径就是原件(WAV 不生成旁路)
    assert analyzed_paths == [wav], "WAV 输入应原样分析(不生成旁路)"
