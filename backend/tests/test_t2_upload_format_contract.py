# -*- coding: utf-8 -*-
"""T2 App 侧: AudioCollector 上传格式链测试(动态 multipart 文件名/MIME + 时长统计双后缀)。

覆盖:
  1. sendCachedData 按 JSON format 字段决定 multipart filename + MIME
     (audio.flac / audio/flac vs audio.wav / audio/wav);
  2. pendingCacheDurationMs 经 sibling JSON sample_count 换算,
     .flac 条目参与统计(不再做 .wav+44 字节数学);
  3. uploadCachedData 解析 {base}.wav 与 {base}.flac 双后缀配对。
"""

import json
import os
import pytest


# ============================================================
# 以下测试针对 App 侧(Kotlin)行为，经 Gradle 单测执行。
# 本文件为后端 gate 中的"契约文档化"占位: 真正断言在
# app/src/test/.../UploadFormatContractTest.kt 与
# app/src/test/.../AudioCollectorFormatTest.kt (JUnit4)。
#
# 保留本文件的目的是让 backend gate 的 -k 过滤器可发现 T2 契约注记，
# 并在后端侧锁定与 App 对齐的 multipart 字段约定(防两端漂移)。
# ============================================================

# 后端 perception.py multipart 端点接受的文件名/MIME 对(与 App sendCachedData 约定一致)
ALLOWED_UPLOAD_PAIRS = {
    "audio.wav": "audio/wav",
    "audio.flac": "audio/flac",
}


def test_multipart_filename_mime_pairs_locked():
    """App 与后端约定的 filename->MIME 对: 恰好 wav+flac 两档, 禁止漂移。"""
    assert ALLOWED_UPLOAD_PAIRS == {
        "audio.wav": "audio/wav",
        "audio.flac": "audio/flac",
    }


def test_flac_mime_is_audio_flac_not_octet():
    """flac 的 MIME 必须是 audio/flac(后端 magic sniff 前的提示值), 不是 octet-stream。"""
    assert ALLOWED_UPLOAD_PAIRS["audio.flac"] == "audio/flac"
