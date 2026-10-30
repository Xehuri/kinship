"""fact_extractor MOSS 子行渲染：只保留静音/ambient 两轴。"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import fact_extractor as fe


def _line(parsed=None, **extra):
    ptr = "daily/2099-01-01/audio/a.wav"
    row = dict(extra)
    if parsed is not None:
        row["parsed"] = parsed
    return fe._moss_subline({ptr: row}, ptr)


def test_human_row_is_audit_only():
    assert _line({"source_type": "human", "scene": "室内", "narrative": "有人在说话"}) == ""


def test_device_and_mixed_rows_are_audit_only():
    assert _line({"source_type": "device_playback", "scene": "室内", "narrative": "外放"}) == ""
    assert _line({"source_type": "mixed", "scene": "室内", "narrative": "混合"}) == ""


def test_ambient_row_is_rendered():
    line = _line({"source_type": "ambient", "scene": "户外风声", "narrative": "风声"})
    assert "src=ambient" in line
    assert "scene=户外风声" in line


def test_is_silence_renders_silence_not_unclear():
    assert _line({"is_silence": True, "source_type": "unclear", "scene": "静音环境"}) == \
        "  └ MOSS: 静音/无语音"


def test_short_circuit_and_missing_rows_unchanged():
    assert _line(_sc=True) == "  └ MOSS: 短路静音"
    assert fe._moss_subline({}, "daily/2099-01-01/audio/a.wav") == ""


def test_error_row_is_audit_only():
    assert _line(_error={"reason": "truncated"}) == ""


def test_section_moss_ambient_renders_unattached_rows():
    ptr = "daily/2026-10-22/audio/a.flac"
    dd = {ptr: {"ts": "2026-10-22T18:28:57+08:00",
               "parsed": {"source_type": "ambient", "scene": "户外", "narrative": "风声"}}}
    lines = fe._section_moss_ambient(dd, {"voice_timeline": []}, "18:25", "18:30")
    assert lines[0] == "- **MOSS 环境/静音**:"
    assert any("src=ambient" in line and "18:28:57" in line for line in lines)


def test_section_moss_ambient_skips_attached_and_human():
    ptr = "daily/2026-10-22/audio/a.flac"
    dd = {ptr: {"ts": "2026-10-22T18:28:57+08:00",
               "parsed": {"source_type": "ambient", "scene": "户外", "narrative": "风声"}}}
    data = {"voice_timeline": [{"type": "speech", "audio_ptr": ptr}]}
    assert fe._section_moss_ambient(dd, data, "18:25", "18:30") == []
    dd[ptr]["parsed"] = {"source_type": "human", "scene": "室内", "narrative": "说话"}
    assert fe._section_moss_ambient(dd, {"voice_timeline": []}, "18:25", "18:30") == []


def test_section_moss_ambient_renders_silence_and_filters_window():
    ptr = "daily/2026-10-22/audio/b.flac"
    dd = {ptr: {"ts": "2026-10-22T19:39:09+08:00",
               "parsed": {"is_silence": True, "source_type": "unclear"}}}
    assert fe._section_moss_ambient(dd, {"voice_timeline": []}, "18:25", "18:30") == []
    lines = fe._section_moss_ambient(dd, {"voice_timeline": []}, "19:35", "19:40")
    assert any("静音/无语音" in line for line in lines)
