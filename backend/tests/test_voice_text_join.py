# -*- coding: utf-8 -*-
"""voice 条目顶层 text 拼接回归测试（TDD）

修复背景：perception.jsonl 中多段 voice 的顶层 text 只取了 segs[0]，
导致 23 段语音只留下第一段文本，AI 严重丢信息。

本测试覆盖：
  (a) _extract_asr_text：优先顶层 asr_text / text，回退拼接全部有效 segs
      （过滤空串与 <|nospeech|> 占位），不再是首段；
  (b) voice_summary：多段输入时顶层 text 等于全段拼接；单段行为不变；
      仍保留 [:1000] 上限。

不依赖任何模型或真实音频，纯合成 segments 数据。
"""
from services.audio_analysis_pipeline import _extract_asr_text, voice_summary


def _seg(text, start=0.0, end=1.0):
    return {"start": start, "end": end, "text": text}


# ============================================================
# _extract_asr_text：提取全量转写文本
# ============================================================

def test_extract_joins_all_segments_when_no_top_text():
    """无顶层文本时，应拼接全部有效段（这正是原 bug 的位置）。"""
    result = {"segments": [_seg("第一段。"), _seg("第二段。"), _seg("第三段。")]}
    assert _extract_asr_text(result) == "第一段。 第二段。 第三段。"


def test_extract_prefers_top_text_when_present():
    """顶层 text 已是全量转写时优先采用，不再拼接 segs。"""
    result = {"text": "这是完整转写", "segments": [_seg("第一段。"), _seg("第二段。")]}
    assert _extract_asr_text(result) == "这是完整转写"


def test_extract_prefers_asr_text_over_text():
    """asr_text 为历史兼容键，存在时优先级最高。"""
    result = {"asr_text": "来自 asr_text", "text": "来自 text", "segments": [_seg("段。")]}
    assert _extract_asr_text(result) == "来自 asr_text"


def test_extract_filters_empty_and_nospeech_segments():
    """拼接时过滤空串与 <|nospeech|> 占位段。"""
    result = {
        "segments": [
            _seg("有效一。"),
            _seg("   "),
            _seg("<|nospeech|>"),
            _seg("有效二。"),
        ]
    }
    assert _extract_asr_text(result) == "有效一。 有效二。"


def test_extract_single_segment_unchanged():
    """单段输入行为不变：返回该段文本（去空白）。"""
    result = {"segments": [_seg("  只有一段。  ")]}
    assert _extract_asr_text(result) == "只有一段。"


def test_extract_all_nospeech_returns_empty():
    """全部为占位段时返回空串。"""
    result = {"segments": [_seg("<|nospeech|>"), _seg("<|nospeech|>")]}
    assert _extract_asr_text(result) == ""


# ============================================================
# voice_summary：顶层 text 字段
# ============================================================

def test_voice_summary_joins_all_segments_text():
    """多段输入且未传 asr_text 时，顶层 text 等于全段拼接。"""
    segments = [_seg("この美味しい。", 0.0, 1.0), _seg("ありがとう。", 1.0, 2.0)]
    entry = voice_summary(segments, [], "", "audio.wav", "10:00:00", "", 2.0)
    assert entry["text"] == "この美味しい。 ありがとう。"


def test_voice_summary_uses_full_asr_text_from_extractor():
    """修复后的写路径：_extract_asr_text 的全量文本应原样进入顶层 text。"""
    result = {"segments": [_seg("第一段。"), _seg("第二段。")]}
    asr_text = _extract_asr_text(result)
    entry = voice_summary(
        result["segments"], [], "", "audio.wav", "10:00:00", asr_text, 2.0
    )
    assert entry["text"] == "第一段。 第二段。"


def test_voice_summary_single_segment_behavior_unchanged():
    """单段输入行为不变：顶层 text 即该段文本。"""
    entry = voice_summary([_seg("只有一段。")], [], "", "audio.wav", "10:00:00", "", 1.0)
    assert entry["text"] == "只有一段。"


def test_voice_summary_caps_text_at_1000_chars():
    """顶层 text 仍保留 [:1000] 上限。"""
    long_text = "啊" * 2000
    entry = voice_summary([_seg(long_text)], [], "", "audio.wav", "10:00:00", "", 1.0)
    assert len(entry["text"]) == 1000
    assert entry["text"] == long_text[:1000]


def test_voice_summary_nospeech_asr_falls_back_to_join():
    """asr_text 含 <|nospeech|> 时回退拼接有效 segs。"""
    segments = [_seg("真实文本。"), _seg("<|nospeech|>")]
    entry = voice_summary(
        segments, [], "", "audio.wav", "10:00:00", "<|nospeech|>", 2.0
    )
    assert entry["text"] == "真实文本。"
