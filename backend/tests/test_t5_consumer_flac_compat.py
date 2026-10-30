# -*- coding: utf-8 -*-
"""T5 消费方双后缀兼容锁。

覆盖计划点名的消费面:
  1. voiceprint_audit 音频统计收 wav+flac;
  2. voiceprint_audit /day 音频端点 MIME 按扩展名(flac -> audio/flac);
  3. mobile 文件类型 type_map 收 .flac,media_type_map 有 audio/flac;
  4. preview timeline 后缀与回推正则容忍 flac;
  5. check_coverage / audio_mimo_analyzer 双后缀筛选(源码静态断言)。
"""

import inspect
import os
import re


def test_vaudit_days_count_includes_flac():
    """days 统计必须数 .flac（源码断言：双后缀筛选存在）。"""
    from routers import voiceprint_audit

    src = inspect.getsource(voiceprint_audit)
    assert '(".wav", ".flac")' in src, "voiceprint_audit 统计须收 wav+flac"


def test_vaudit_audio_endpoint_mime_dynamic():
    """get_day_audio/archive/voice 端点 MIME 不得硬编码——须按扩展名分流。"""
    from routers import voiceprint_audit

    src = inspect.getsource(voiceprint_audit)
    assert 'audio/flac' in src, "音频端点须有 flac MIME 分支"
    # 归档/注册/日音频端点均须动态 media（出现 audio/flac 分流即达标；
    # 无条件 media_type="audio/wav" 的硬编码 FileResponse 已全部消除）
    hardcoded = re.findall(r'FileResponse\([^)]*media_type="audio/wav"', src)
    assert not hardcoded, f"残留硬编码 audio/wav FileResponse: {hardcoded}"
    # 归档直读须容忍 .flac 文件名
    assert '(".wav", ".flac")' in src


def test_mobile_type_map_has_flac():
    from routers import mobile

    src = inspect.getsource(mobile)
    assert '".flac": "flac"' in src, "mobile type_map 须收 .flac"
    assert '".flac": "audio/flac"' in src, "media_type_map 须有 audio/flac"


def test_preview_timeline_tolerates_flac():
    from routers import preview

    src = inspect.getsource(preview)
    # B3 重写后旧式文件名判定改为子串检查（行为等价，双后缀均容忍）
    assert 'endswith((".wav", ".flac")' in src, "timeline 文件筛选须容忍 .flac"
    assert '"_default." in low' in src, "旧式整分文件名判定须容忍 _default.* (wav/flac)"
    assert re.search(r'_default\\\.\(?:wav\|flac\)', src) or \
        "_default\\.(?:wav|flac)" in src, "audio 字段回推正则须容忍 flac"


def test_check_coverage_counts_flac():
    path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "..", "ai", "analysis", "check_coverage.py",
    )
    path = os.path.normpath(path)
    with open(path, encoding="utf-8") as f:
        src = f.read()
    assert "('.wav', '.flac')" in src, "覆盖率统计须双后缀（flac 不算假缺口）"


def test_audio_mimo_analyzer_counts_flac():
    path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "..", "ai", "analysis", "audio_mimo_analyzer.py",
    )
    path = os.path.normpath(path)
    with open(path, encoding="utf-8") as f:
        src = f.read()
    assert src.count('(".wav", ".flac")') >= 2, (
        "audio_mimo_analyzer 列目录与窗口筛选须双后缀"
    )
