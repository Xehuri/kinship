# -*- coding: utf-8 -*-
"""B2 音频分析链内核接线测试: 主链作业 / 残留两件 / 适配层 / requeue / track。

覆盖(TDD 对应 B2 验收点):
  1. run_audio_analysis_jobs 成功路径不变(四 kind + options_by_kind 透传);
  2. run_residual_analysis_jobs: aed/emotion/breath 三 kind 提交与逐 kind
     独立收割, 任一失败仅该 kind 为 None(不回退本地、不触发主链 requeue);
  3. unknown_track: sync POST /v1/unknown/track 薄封装(audio_path 读盘编码
     base64, 失败/不可达返回 None 绝不抛);
  4. 适配层 _adapt_kernel_facts: 内核 facts(_ms) 重塑既有 result 形状,
     残留三件经 run_residual_analysis_jobs 合并(audio_events 秒口径/
     emotion 校准+PANNs Speech 二次校准/breath_events);
  5. requeue: 内核主链不可达 -> analyze_audio_file 返回 "retry" 且
     _schedule_retry 登记(attempt 上限判定在管线侧, 超限 ERROR 不静默);
  6. 滑窗单请求: kernel_score(detail+sliding+collect) 一次调用, windows
     扁平数组重建 voiceprint_windows/五键, vp.max/pct 来自内核统计;
  7. track->spk 映射: facts.blocks 最大重叠直通段级 spk 富对象(键集零变化)。

全部经 monkeypatch 打桩, 绝不 spawn 真内核/加载重模型。
"""
import sys
import types

import pytest

from services import kernel_job_client as kjc


# ============================================================
# 测试辅助
# ============================================================

def _wav_file(tmp_path, seconds: float = 1.0) -> str:
    """生成真实 16k 单声道 WAV(kjc 只取绝对路径, 内容不参与断言)。"""
    import struct
    import wave

    path = tmp_path / "clip.wav"
    n = int(16000 * seconds)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(struct.pack("<%dh" % n, *([0] * n)))
    return str(path)


def _facts_bundle(seg_end_ms: int = 1500) -> dict:
    """四 kind 的 done facts 样本(形状对齐 kernel/jobs/handlers.py 组装)。

    seg_end_ms 可调: 默认 ASR 段 200~1500(1.3s, 短于 1.5s 滑窗不出窗);
    需要覆盖"窗重建"的用例传 >=1700 让语音段吃满至少一个 1500ms 窗。
    """
    return {
        "analyze.vad": {
            "engine": "pyannote",
            "duration_ms": 2000,
            "segment_count": 1,
            "speech_ms": 1800,
            "segments": [{"start_ms": 100, "end_ms": 1900}],
            "segments_truncated": False,
        },
        "analyze.asr": {
            "duration_ms": 2000,
            "text": "明天谁的课",
            "text_truncated": False,
            "segment_count": 1,
            "segments": [
                {
                    "start_ms": 200,
                    "end_ms": seg_end_ms,
                    "text": "明天谁的课",
                    "emotion": "neutral",
                    "confidence": 0.8,
                    # additive: word_ts/words(Commit4 内核补齐后生产存在)
                    "word_ts": [[200.0, 400.0], [400.0, 600.0]],
                    "words": ["明天", "谁"],
                }
            ],
            "segments_truncated": False,
            "emotion_counts": {"neutral": 1},
            "event_counts": {},
        },
        "analyze.scene": {
            "duration_ms": 2000,
            "scene_primary": {
                "class_index": 0,
                "label": "Silence",
                "label_cn": "安静",
                "probability": 0.92,
            },
            "scene_tags": [],
            "scene_groups": {},
            "reason": "ok",
        },
        "analyze.diarize": {
            "duration_ms": 2000,
            "n_speakers": 2,
            "segment_count": 1,
            "segments": [{"start_ms": 100, "end_ms": 1900, "speaker": 0}],
            "segments_truncated": False,
        },
    }


def _residual_bundle() -> dict:
    """残留两件 done facts 样本(形状对齐 handlers analyze_aed/breath)。"""
    return {
        "analyze.aed": {
            "duration_ms": 2000,
            "count": 1,
            "events": [
                {"label": "Clicking", "label_cn": "点击声", "start_ms": 500,
                 "end_ms": 3000, "prob": 0.61},
            ],
            "events_truncated": False,
            "reason": "ok",
        },
        "analyze.breath": {
            "duration_ms": 2000,
            "breaths": [
                {"start_ms": 300, "end_ms": 900, "kind": "sigh"},
            ],
            "count": 1,
            "reason": "ok",
        },
    }


class _FakeJobClient:
    """替身作业客户端: 记录提交参数, get_job 直接返回 done 终态。"""

    instances: list = []

    def __init__(self, base_url, token, timeout=None):
        self.base_url = base_url
        self.token = token
        self.timeout = timeout
        self.submits = []
        self.get_calls = []
        self.facts = dict(_facts_bundle())
        self.facts.update(_residual_bundle())
        self.fail_kind = None  # 置为 kind 名时该作业回 failed
        _FakeJobClient.instances.append(self)

    def submit(self, kind, input=None, options=None, idempotency_key=None):
        self.submits.append({"kind": kind, "input": input, "options": options})
        if self.fail_kind == kind:
            raise kjc.KernelJobError("POST", "/v1/jobs", 503, "模拟提交失败")
        return {"id": "job_%s" % kind, "state": "queued"}

    def get_job(self, job_id, wait=None):
        self.get_calls.append({"job_id": job_id, "wait": wait})
        kind = job_id[len("job_"):]
        if self.fail_kind == kind:
            return {
                "id": job_id, "state": "failed",
                "error": {"code": "model.unavailable", "message": "模型缺失"},
            }
        return {
            "id": job_id,
            "state": "done",
            "result": {"kernel": {"schema_version": "1",
                                  "facts": self.facts[kind],
                                  "provenance": {}},
                       "outer": {}},
        }


class _FakeKernel:
    """替身 kernel_client 单例: ensure 记录调用, base_url/token 就绪。"""

    def __init__(self, *, raise_on_ensure=False):
        self.base_url = "http://127.0.0.1:65535"
        self.token = "test-token"
        self.ensure_called = False
        self.raise_on_ensure = raise_on_ensure

    def ensure(self):
        self.ensure_called = True
        if self.raise_on_ensure:
            from services.kernel_client import KernelUnavailable

            raise KernelUnavailable("连接被拒绝(测试桩)")


@pytest.fixture
def patch_kernel_client(monkeypatch):
    """工厂: patch_kernel_client() -> 安装 kernel_client.get_kernel_client 桩。"""

    def _install(raise_on_ensure=False):
        fake = _FakeKernel(raise_on_ensure=raise_on_ensure)
        import services.kernel_client as kc_mod

        monkeypatch.setattr(kc_mod, "get_kernel_client", lambda: fake)
        return fake

    return _install


@pytest.fixture
def patch_job_client(monkeypatch):
    """工厂: patch_job_client() -> 安装 KernelJobClient 替身并返回其实例记录。"""
    _FakeJobClient.instances = []

    def _install():
        monkeypatch.setattr(kjc, "KernelJobClient", _FakeJobClient)
        # 每次安装清空: run_audio_analysis_jobs 每次调用新建实例,
        # 这里返回工厂 -> 测试经 _FakeJobClient.instances 取最后一个
        return _FakeJobClient

    return _install


# ============================================================
# 1. run_audio_analysis_jobs 成功路径 + options 透传
# ============================================================

def test_run_jobs_submits_four_kinds_with_path_input(
    tmp_path, patch_kernel_client, patch_job_client,
):
    """四 kind 全部以 input.path=绝对路径提交(同机零上传), 且长轮询取齐 facts。"""
    patch_kernel_client()
    cls = patch_job_client()
    wav = _wav_file(tmp_path)

    facts = kjc.run_audio_analysis_jobs(wav, wait=5, deadline_s=30)

    assert facts is not None
    assert set(facts) == {
        "analyze.vad", "analyze.asr", "analyze.scene", "analyze.diarize",
    }
    assert facts["analyze.asr"]["text"] == "明天谁的课"

    client = cls.instances[-1]
    kinds = [s["kind"] for s in client.submits]
    assert kinds == [
        "analyze.vad", "analyze.asr", "analyze.scene", "analyze.diarize",
    ]
    import os

    for s in client.submits:
        assert set(s["input"].keys()) == {"path"}
        assert os.path.isabs(s["input"]["path"])
        assert s["input"]["path"].lower().endswith(".wav")
    # get_job 用长轮询 wait 参数(非 sleep 轮询)
    assert client.get_calls
    assert all(c["wait"] is not None and c["wait"] > 0 for c in client.get_calls)


def test_run_jobs_passes_options_by_kind(
    tmp_path, patch_kernel_client, patch_job_client,
):
    """options_by_kind 按 kind 透传给 submit(B2 残留作业段参数走此通道)。"""
    patch_kernel_client()
    cls = patch_job_client()
    opts = {"analyze.breath": {"vad_timeline": [{"start_ms": 0, "end_ms": 1000}]}}

    kjc.run_audio_analysis_jobs(
        _wav_file(tmp_path), kinds=["analyze.breath"],
        options_by_kind=opts, wait=5,
    )
    client = cls.instances[-1]
    assert client.submits[0]["options"] == opts["analyze.breath"]


def test_run_jobs_ensure_is_invoked(tmp_path, patch_kernel_client, patch_job_client):
    """base_url/token 获取必须经 kernel_client.ensure()(只调用不修改)。"""
    fake = patch_kernel_client()
    patch_job_client()
    kjc.run_audio_analysis_jobs(_wav_file(tmp_path))
    assert fake.ensure_called is True


# ============================================================
# 2. 降级: 任何失败 -> None(不外抛, 调用方按 requeue 处理)
# ============================================================

def test_run_jobs_returns_none_when_kernel_unreachable(
    tmp_path, patch_kernel_client, patch_job_client,
):
    """kernel_client.ensure() 抛 KernelUnavailable -> None(调用方延迟重投)。"""
    patch_kernel_client(raise_on_ensure=True)
    patch_job_client()
    assert kjc.run_audio_analysis_jobs(_wav_file(tmp_path)) is None


def test_run_jobs_returns_none_when_job_failed(
    tmp_path, patch_kernel_client, patch_job_client,
):
    """任一作业进入 failed 终态 -> 整体 None(主链部分采用无意义, 重投)。"""
    patch_kernel_client()
    cls = patch_job_client()

    original_init = cls.__init__

    def _init_and_fail(self, base_url, token, timeout=None):
        original_init(self, base_url, token, timeout)
        self.fail_kind = "analyze.asr"

    cls.__init__ = _init_and_fail
    try:
        assert kjc.run_audio_analysis_jobs(_wav_file(tmp_path)) is None
    finally:
        cls.__init__ = original_init


def test_run_jobs_returns_none_when_submit_raises(
    tmp_path, patch_kernel_client, patch_job_client, monkeypatch,
):
    """提交阶段抛 HTTP 错(503/429/断连) -> None, 绝不外抛阻断分析。"""
    patch_kernel_client()
    cls = patch_job_client()

    def _boom(self, kind, input=None, options=None, idempotency_key=None):
        raise kjc.KernelJobError("POST", "/v1/jobs", 503, "kernel unavailable")

    monkeypatch.setattr(cls, "submit", _boom)
    assert kjc.run_audio_analysis_jobs(_wav_file(tmp_path)) is None


# ============================================================
# 3. run_residual_analysis_jobs: 逐 kind 独立降级
# ============================================================

def test_residual_submits_two_kinds_with_options(
    tmp_path, patch_kernel_client, patch_job_client,
):
    """aed 无 options; breath 带 vad_timeline(有 VAD 时)。2026-10-07 emotion 移除。"""
    patch_kernel_client()
    cls = patch_job_client()

    out = kjc.run_residual_analysis_jobs(
        _wav_file(tmp_path),
        vad_timeline_ms=[{"start_ms": 100, "end_ms": 1900}],
        wait=5, deadline_s=30,
    )
    client = cls.instances[-1]
    kinds = [s["kind"] for s in client.submits]
    assert kinds == ["analyze.aed", "analyze.breath"]
    by_kind = {s["kind"]: s for s in client.submits}
    assert by_kind["analyze.breath"]["options"] == {
        "vad_timeline": [{"start_ms": 100, "end_ms": 1900}]}
    # 两 kind facts 全部取回
    assert out["analyze.aed"]["events"][0]["label"] == "Clicking"
    assert out["analyze.breath"]["breaths"][0]["kind"] == "sigh"


def test_residual_single_failure_degrades_field_only(
    tmp_path, patch_kernel_client, patch_job_client, monkeypatch,
):
    """单 kind 提交失败 -> 仅该字段 None, 其余照常收割(不回退本地、不整体 None)。"""
    patch_kernel_client()
    cls = patch_job_client()

    def _fail_breath(self, kind, input=None, options=None, idempotency_key=None):
        if kind == "analyze.breath":
            raise kjc.KernelJobError("POST", "/v1/jobs", 503, "boom")
        return {"id": "job_%s" % kind, "state": "queued"}

    monkeypatch.setattr(cls, "submit", _fail_breath)

    out = kjc.run_residual_analysis_jobs(
        _wav_file(tmp_path),
        vad_timeline_ms=[{"start_ms": 100, "end_ms": 1900}],
        wait=5,
    )
    assert out["analyze.breath"] is None
    assert out["analyze.aed"]["events"][0]["label"] == "Clicking"


def test_residual_kernel_unreachable_all_fields_none(
    tmp_path, patch_kernel_client, patch_job_client,
):
    """内核整体不可达 -> 两字段全 None(主链已成功, 不触发 requeue)。"""
    patch_kernel_client(raise_on_ensure=True)
    patch_job_client()
    out = kjc.run_residual_analysis_jobs(_wav_file(tmp_path))
    assert out == {"analyze.aed": None, "analyze.breath": None}


# ============================================================
# 4. unknown_track 薄封装
# ============================================================

def test_unknown_track_encodes_audio_file_to_b64(tmp_path, monkeypatch):
    """audio_path 读一次字节 base64 直传, body 含 file_key/start_epoch_ms/device_t。"""
    import base64
    import services.kernel_client as kc_mod

    wav = _wav_file(tmp_path)
    captured = {}

    class _S:
        def srequest(self, method, path, json=None, timeout=None):
            captured["method"] = method
            captured["path"] = path
            captured["json"] = json
            return {"facts": {"file_key": json["file_key"], "blocks": [],
                              "reason": "ok"}}

    monkeypatch.setattr(kc_mod, "get_kernel_client", lambda: _S())
    facts = kjc.unknown_track("key-1", audio_path=wav, start_epoch_ms=123,
                              device_t="dev")
    assert captured["method"] == "POST"
    assert captured["path"] == "/v1/unknown/track"
    body = captured["json"]
    assert body["file_key"] == "key-1"
    assert body["start_epoch_ms"] == 123
    assert body["device_t"] == "dev"
    assert base64.b64decode(body["audio_b64"]) == open(wav, "rb").read()
    assert facts["reason"] == "ok"


def test_unknown_track_failure_returns_none(tmp_path, monkeypatch):
    """track 失败(不可达/HTTP 错误) -> None, 绝不外抛(陌生人不建档)。"""
    import services.kernel_client as kc_mod

    class _Boom:
        def srequest(self, *a, **k):
            from services.kernel_client import KernelUnavailable

            raise KernelUnavailable("拒绝连接(测试桩)")

    monkeypatch.setattr(kc_mod, "get_kernel_client", lambda: _Boom())
    assert kjc.unknown_track("key-1", audio_path=_wav_file(tmp_path)) is None


def test_unknown_track_artifact_xor(tmp_path, monkeypatch):
    """artifact 与 audio_path 都缺 -> 只发 file_key(内核缺输入回 missing_input 空结论)。"""
    import services.kernel_client as kc_mod

    captured = {}

    class _S:
        def srequest(self, method, path, json=None, timeout=None):
            captured["json"] = json
            return {"facts": {"blocks": [], "reason": "missing_input"}}

    monkeypatch.setattr(kc_mod, "get_kernel_client", lambda: _S())
    facts = kjc.unknown_track("key-2", artifact="art_abc")
    assert captured["json"] == {"file_key": "key-2", "artifact": "art_abc"}
    assert facts["reason"] == "missing_input"


# ============================================================
# 5. 适配层 _adapt_kernel_facts(B2: 残留两件经内核 seam)
# ============================================================

@pytest.fixture
def patch_residual(monkeypatch):
    """默认: 残留两件全部失败降级(各测试按需覆盖) -> 字段不写/不校准。"""
    monkeypatch.setattr(
        kjc, "run_residual_analysis_jobs",
        lambda path, **kw: {k: None for k in kjc.RESIDUAL_KINDS},
    )


def test_adapt_maps_ms_to_seconds_and_shapes(patch_residual):
    """facts(_ms) -> result 形状: 段/VAD 秒、scene 三键、时长秒。"""
    from services.audio_analysis_pipeline import _adapt_kernel_facts

    result = _adapt_kernel_facts(_facts_bundle(), "C:/tmp/clip.wav")

    seg0 = result["segments"][0]
    assert seg0["start"] == 0.2
    assert seg0["end"] == 1.5
    assert seg0["text"] == "明天谁的课"
    assert seg0["emotion"] == "neutral"
    assert result["vad_segments"] == [{"start": 0.1, "end": 1.9}]
    assert result["scene"]["scene_primary"]["label_cn"] == "安静"
    assert result["duration"] == 2.0
    assert result["text"] == "明天谁的课"
    assert result["speaker_diarization"]["n_speakers"] == 2
    assert result["speaker_diarization"]["segments"][0]["speaker"] == 0
    assert "speaker_genders" not in result["speaker_diarization"]
    assert "timeline" not in result["speaker_diarization"]
    # 残留全失败: audio_events/breath_events 不写键(旧 mgr 缺失同语义)
    assert "audio_events" not in result
    assert "breath_events" not in result


def test_adapt_passes_segment_and_vad_options_to_residual(monkeypatch, tmp_path):
    """残留作业收到 VAD 掩码毫秒(2026-10-07: 不再回推 emotion 段)。"""
    from services.audio_analysis_pipeline import _adapt_kernel_facts

    captured = {}

    def _spy(path, **kw):
        captured["path"] = path
        captured.update(kw)
        return {k: None for k in kjc.RESIDUAL_KINDS}

    monkeypatch.setattr(kjc, "run_residual_analysis_jobs", _spy)
    _adapt_kernel_facts(_facts_bundle(), "C:/tmp/clip.wav")
    assert captured["path"] == "C:/tmp/clip.wav"
    assert "emotion_segments_ms" not in captured
    assert captured["vad_timeline_ms"] == [{"start_ms": 100, "end_ms": 1900}]


def test_adapt_merges_residual_events(monkeypatch):
    """残留两件合并: aed events 秒口径进 audio_events; breath 进 breath_events。"""
    from services.audio_analysis_pipeline import _adapt_kernel_facts

    monkeypatch.setattr(
        kjc, "run_residual_analysis_jobs",
        lambda path, **kw: _residual_bundle(),
    )
    result = _adapt_kernel_facts(_facts_bundle(), "C:/tmp/clip.wav")

    # aed: {label,label_cn,probability,probability_pct,start,end,count}(旧逐字段)
    ev = result["audio_events"][0]
    assert ev["start"] == 0.5 and ev["end"] == 3.0
    assert ev["label"] == "Clicking" and ev["label_cn"] == "点击声"
    assert ev["probability"] == 0.61 and ev["probability_pct"] == "61%"
    # breath: ms -> 秒 + kind -> type/type_cn
    b = result["breath_events"][0]
    assert b["start"] == 0.3 and b["end"] == 0.9
    assert b["type"] == "sigh" and b["type_cn"] == "叹气"


def test_adapt_panns_secondary_calibration_after_emotion_removed(monkeypatch):
    """2026-10-07 emotion 移除后: 段 emotion 保留 ASR 原标签; PANNs Speech
    二次校准按 aed 重叠接管 confidence(base 改走 ASR 0.8, 公式不变)。"""
    from services.audio_analysis_pipeline import _adapt_kernel_facts

    def _fake(path, **kw):
        b = _residual_bundle()
        b["analyze.aed"]["events"].append(
            {"label": "Speech", "label_cn": "说话声", "start_ms": 300,
             "end_ms": 1400, "prob": 0.42})
        return b

    monkeypatch.setattr(kjc, "run_residual_analysis_jobs", _fake)
    result = _adapt_kernel_facts(_facts_bundle(), "C:/tmp/clip.wav")

    seg = result["segments"][0]
    assert seg["emotion"] == "neutral"  # ASR 原标签保留(不再被 emotion2vec 改写)
    assert "emotion_cn" not in seg or seg["emotion_cn"] == ""
    # PANNs 二次校准: base=ASR 0.8, speech_prob=0.42 >= 0.3 -> *1.1 封顶 0.95
    assert seg["confidence"] == round(0.8 * 1.1, 2)
    assert seg["speech_prob"] == 0.42


def test_adapt_emotion_low_speech_penalty(monkeypatch):
    """speech_prob < 0.3 时罚乘: base*max(p/0.3,0.2)*0.6(emotion 移除后 base=ASR 0.8)。"""
    from services.audio_analysis_pipeline import _adapt_kernel_facts

    def _fake(path, **kw):
        b = _residual_bundle()
        b["analyze.aed"]["events"] = [
            {"label": "Speech", "label_cn": "说话声", "start_ms": 300,
             "end_ms": 1400, "prob": 0.15}]
        return b

    monkeypatch.setattr(kjc, "run_residual_analysis_jobs", _fake)
    result = _adapt_kernel_facts(_facts_bundle(), "C:/tmp/clip.wav")
    seg = result["segments"][0]
    base = 0.8
    cal = base * max(0.15 / 0.3, 0.2) * 0.6
    assert seg["confidence"] == round(cal, 2)
    assert seg["speech_prob"] == 0.15


def test_adapt_residual_missing_fields_partial_degrade(monkeypatch):
    """aed 成功 breath 失败: audio_events 有值, 段 emotion 保留 ASR 原标签。"""
    from services.audio_analysis_pipeline import _adapt_kernel_facts

    def _fake(path, **kw):
        return {"analyze.aed": _residual_bundle()["analyze.aed"],
                "analyze.breath": None}

    monkeypatch.setattr(kjc, "run_residual_analysis_jobs", _fake)
    result = _adapt_kernel_facts(_facts_bundle(), "C:/tmp/clip.wav")
    assert result["audio_events"][0]["label"] == "Clicking"
    seg = result["segments"][0]
    assert seg["emotion"] == "neutral"  # ASR 原标签保留(未校准)
    assert "breath_events" not in result


def test_adapt_missing_facts_key_defaults_empty(patch_residual):
    """单 kind facts 缺失不炸: 对应输出为空形状(容错)。"""
    from services.audio_analysis_pipeline import _adapt_kernel_facts

    result = _adapt_kernel_facts(
        {"analyze.asr": _facts_bundle()["analyze.asr"]},
        "C:/tmp/clip.wav",
    )
    assert result["vad_segments"] == []
    assert result["scene"]["scene_primary"] is None
    assert result["segments"][0]["start"] == 0.2


# ============================================================
# 6. 端到端: 内核 facts 主路径写 voice 条目(B2 无本地回退)
# ============================================================

class _PipelineEnv:
    """analyze_audio_file 端到端所需的全部隔离缝(重模型/网络/配置/落盘)。"""

    def __init__(self, monkeypatch, tmp_path, facts=None, residual=None):
        from services import perception_store
        import services.audio_analysis_pipeline as pipeline_mod

        self.calls = []

        # 1) 主链四 kind 缝
        monkeypatch.setattr(kjc, "run_audio_analysis_jobs",
                            lambda path: facts if facts is not None else _facts_bundle())
        # 2) 残留三件缝
        monkeypatch.setattr(
            kjc, "run_residual_analysis_jobs",
            lambda path, **kw: residual if residual is not None
            else {k: None for k in kjc.RESIDUAL_KINDS},
        )
        # 3) track 缝(生产 config unknown enabled, 端到端默认关闭)
        monkeypatch.setattr(pipeline_mod, "_unknown_speaker_enabled", lambda: False)
        # 4) 声纹内核探针桩: 计数 0 -> 跳段级评分循环(V10: 改内核 HTTP 面)
        import services.kernel_client as kc_mod

        monkeypatch.setattr(kc_mod, "vp_speaker_count", lambda: 0)
        monkeypatch.setattr(kc_mod, "vp_cohort_stats", lambda: {})
        # 5) 配置/存储隔离 + append 记录
        import config.config as cfg_mod

        class _Cfg:
            DATA_DIR = str(tmp_path)

        monkeypatch.setattr(cfg_mod, "get_config", lambda: _Cfg())
        monkeypatch.setattr(
            perception_store, "append_perception",
            lambda entry, user_id="default", auto_type=True, date_str=None: self.calls.append(entry) or True,
        )
        monkeypatch.setattr(perception_store, "_DATA_BASE", str(tmp_path / "daily"))
        monkeypatch.setattr(
            perception_store, "_STREAM_AUDIO_BASE", str(tmp_path / "stream")
        )
        # 6) requeue 缝: 默认拦截(防误建队列单例污染其他用例)。
        #    记录管线传入 _schedule_retry 的原始 attempt(首次失败=0)。
        self.retries = []
        monkeypatch.setattr(
            pipeline_mod, "_schedule_retry",
            lambda path, start, dev, origin, attempt: self.retries.append(
                {"path": path, "start": start, "device": dev,
                 "origin": origin, "attempt": attempt}),
        )


def test_pipeline_uses_kernel_facts_path_end_to_end(monkeypatch, tmp_path):
    """内核 facts 成功: 不走任何本地分析, voice 条目照常写入(env 来自内核 AED)。"""
    env = _PipelineEnv(monkeypatch, tmp_path, residual=_residual_bundle())
    wav = _wav_file(tmp_path, seconds=2.0)
    from services.audio_analysis_pipeline import analyze_audio_file

    ret = analyze_audio_file(wav, None, device_name="dev-kernel")

    assert ret == "ok"
    assert len(env.calls) == 1, "内核 facts 路径必须照常写 voice 条目"
    entry = env.calls[0]
    assert entry["type"] == "voice"
    assert entry["text"] == "明天谁的课"
    seg0 = entry["segs"][0]
    assert seg0["start"] == 0.2 and seg0["end"] == 1.5
    # env 来自内核 aed events(概率数组形状与旧一致)
    assert entry["env"] == [{"label": "点击声", "prob": 0.61, "start": 0.5}]
    assert entry.get("scene") == "安静"
    assert env.retries == []


def test_pipeline_requeues_when_jobs_return_none(monkeypatch, tmp_path):
    """B2 核心语义: run_audio_analysis_jobs 返回 None -> 不写条目、登记重投。"""
    env = _PipelineEnv(monkeypatch, tmp_path, facts=None)
    monkeypatch.setattr(kjc, "run_audio_analysis_jobs", lambda path: None)
    wav = _wav_file(tmp_path, seconds=2.0)
    from services.audio_analysis_pipeline import analyze_audio_file

    ret = analyze_audio_file(wav, 1757836800000, device_name="dev-requeue")

    assert ret == "retry"
    assert env.calls == [], "内核不可达时不得写 perception(半写比不写更糟)"
    assert len(env.retries) == 1
    r = env.retries[0]
    assert r["path"] == wav
    # 管线把"当前已尝试次数"透传给 _schedule_retry(首次失败=0, 内部 +1 登记)
    assert r["attempt"] == 0
    assert r["start"] == 1757836800000
    assert r["origin"] == "upload"


def test_pipeline_requeues_when_adapt_raises(monkeypatch, tmp_path):
    """facts 坏值致适配抛错 -> 同样转重投(重投幂等: append 在末尾不会半写)。"""
    env = _PipelineEnv(monkeypatch, tmp_path, facts={"analyze.asr": 123})
    wav = _wav_file(tmp_path, seconds=2.0)
    from services.audio_analysis_pipeline import analyze_audio_file

    ret = analyze_audio_file(wav, None, device_name="dev-adapt-fail")
    assert ret == "retry"
    assert env.calls == []
    assert len(env.retries) == 1 and env.retries[0]["attempt"] == 0


def test_schedule_retry_backoff_and_limit(monkeypatch, tmp_path):
    """_schedule_retry: attempt+1 透传给队列; 超限(>10)记 ERROR 且不再登记。"""
    import services.audio_analysis_queue as queue_mod
    import services.audio_analysis_pipeline as pipeline_mod

    recorded = []

    class _Q:
        def schedule_retry(self, path, start, dev, origin, attempt):
            recorded.append(attempt)
            return True

    monkeypatch.setattr(queue_mod, "get_analysis_queue", lambda: _Q())
    pipeline_mod._schedule_retry("C:/x.wav", 1, "d", "upload", 0)
    pipeline_mod._schedule_retry("C:/x.wav", 1, "d", "upload", 9)
    assert recorded == [1, 10]
    # 超限: attempt=10 -> nxt=11 > 上限 -> 不登记(丢弃记 ERROR 在函数内)
    pipeline_mod._schedule_retry("C:/x.wav", 1, "d", "upload", 10)
    assert recorded == [1, 10]


def test_queue_retry_heap_dedup_and_promote(monkeypatch):
    """队列重试堆: 同路径去重(最新 attempt 覆盖) + 到期出堆(不重不漏)。"""
    import time
    import services.audio_analysis_queue as qmod

    q = qmod.AudioAnalysisQueue(maxsize=8)
    try:
        # 退避缩到毫秒级便于到期断言
        monkeypatch.setattr(qmod, "_RETRY_BASE_S", 0.001)
        monkeypatch.setattr(qmod, "_RETRY_MAX_S", 0.002)
        q.schedule_retry("C:/dup.wav", 1, "d", "upload", 1)
        q.schedule_retry("C:/dup.wav", 1, "d", "upload", 3)  # 同路径覆盖 attempt
        assert q.retry_pending() == 1
        # 堆内条目携带最新 attempt
        top = min(e[2] for e in q._retries)
        assert top == ("C:/dup.wav", 1, "d", "upload", 3)
        time.sleep(0.01)
        q._promote_due_retries()
        assert q.retry_pending() == 0  # 已出堆(回投主队列)
    finally:
        q._retries.clear()


def test_queue_worker_passes_attempt_to_pipeline(monkeypatch):
    """worker 消费 5 元组重投条目: attempt 透传给 analyze_audio_file。"""
    import threading
    import services.audio_analysis_pipeline as pipeline_mod
    import services.audio_analysis_queue as qmod

    recorded = {}
    done = threading.Event()

    def _fake_analyze(abs_path, start_epoch_ms, device_name="", ts_val=None,
                      origin="upload", attempt=0):
        recorded["attempt"] = attempt
        recorded["origin"] = origin
        done.set()
        return "ok"

    monkeypatch.setattr(pipeline_mod, "analyze_audio_file", _fake_analyze)
    q = qmod.AudioAnalysisQueue(maxsize=4)
    # 直接投一条 5 元组(模拟到期回投的形态)
    q._queue.put(("C:/a.wav", 5, "d", "upload", 2))
    assert done.wait(5.0), "worker 未消费重投条目"
    assert recorded["attempt"] == 2
    assert recorded["origin"] == "upload"


# ============================================================
# 7. 滑窗单请求 + vp 五键(经 kernel_score 垫片 detail 融合)
# ============================================================

def test_pipeline_single_score_request_builds_five_keys(monkeypatch, tmp_path):
    """B2 段级评分一次请求: windows 扁平数组重建 + vp 五键(ws/max/pct)齐活。

    旧路径"整段 1 次 + 每窗 1 次"退化(out-of-band 循环)删除后, vp.max/pct
    必有值 ->     fact_extractor "未校验"守卫不再触发(历史 988 条根治)。
    """
    env = _PipelineEnv(monkeypatch, tmp_path, facts=_facts_bundle(seg_end_ms=1800))
    import services.audio_analysis_pipeline as pipeline_mod
    import services.kernel_client as kc_mod

    monkeypatch.setattr(kc_mod, "vp_speaker_count", lambda: 1)
    monkeypatch.setattr(kc_mod, "vp_cohort_stats", lambda: {"active": 500})

    score_calls = []

    def _fake_score(audio, **kw):
        score_calls.append(kw)
        # 模拟内核 A2 一次返回: 六键 + sliding 四键 + collect 两键
        return {
            "scores": {"小贺": 0.82}, "raw": {"小贺": 0.6},
            "imp_mean": 0.0, "imp_std": 0.1, "n_cohort": 500, "as_norm_on": True,
            # 3 窗扁平数组(1500ms 窗): 0/750/1500 起点
            "windows": [0, 0.85, 750, 0.4, 1500, -0.2],
            "win_max": 0.85, "win_pct": 0.6667, "windows_total": 3,
            "collected": False, "collect_reason": "too_similar",
        }

    monkeypatch.setattr(pipeline_mod, "kernel_score", _fake_score)

    wav = _wav_file(tmp_path, seconds=2.0)
    ret = pipeline_mod.analyze_audio_file(wav, None, device_name="dev-win")
    assert ret == "ok"

    # 一次请求(不是 1+N 次): detail+sliding+collect 全开
    assert len(score_calls) == 1
    call = score_calls[0]
    assert call["detail"] is True
    assert call["sliding"] == {"window_ms": 1500, "hop_ms": 750}
    assert call["collect"] is True
    assert call["collect_meta"]["src_file"].endswith(".wav")

    entry = env.calls[0]
    vp = entry["segs"][0]["vp"]
    # 五键齐全(历史"未校验"根因: ws/max/pct 缺失)
    assert set(vp) == {"spk", "sim", "max", "pct", "ws", "ws_spk"}
    assert vp["spk"] == "小贺" and vp["sim"] == 0.82
    # windows 由扁平数组重建; 窗名沿用段级 top(窗分达阈值才标)
    assert vp["ws"] == [0, 0.85, 750, 0.4, 1500, -0.2]
    assert vp["ws_spk"] == ["小贺", "", ""]
    assert vp["max"] == 0.85
    # pct 语义保留: >0 窗占比(2/3, 与旧 fact_extractor 消费逐位一致)
    assert vp["pct"] == round(2 / 3, 4)
    # stats.max 用内核 win_max
    stats = entry["segs"][0]  # voice_summary 不导出 stats, 仅 vp 可断言
    assert stats["vp"]["max"] == 0.85


def test_pipeline_score_down_writes_entry_without_vp(monkeypatch, tmp_path):
    """段级评分不可达(垫片返回空 detail) -> voice 条目照写、vp 留空、不触发重投。"""
    env = _PipelineEnv(monkeypatch, tmp_path)
    import services.audio_analysis_pipeline as pipeline_mod
    import services.kernel_client as kc_mod

    monkeypatch.setattr(kc_mod, "vp_speaker_count", lambda: 1)
    monkeypatch.setattr(kc_mod, "vp_cohort_stats", lambda: {"active": 0})
    monkeypatch.setattr(
        pipeline_mod, "kernel_score",
        lambda audio, **kw: {"scores": {}, "raw": {}, "imp_mean": None,
                             "imp_std": None, "n_cohort": 0, "as_norm_on": False,
                             "windows": [], "win_max": None, "win_pct": None,
                             "windows_total": 0, "collected": False,
                             "collect_reason": "not_scored"},
    )

    wav = _wav_file(tmp_path, seconds=2.0)
    ret = pipeline_mod.analyze_audio_file(wav, None, device_name="dev-score-down")

    assert ret == "ok"
    assert env.retries == [], "评分降级不重投(requeue 只管主链)"
    assert len(env.calls) == 1
    seg0 = env.calls[0]["segs"][0]
    assert not seg0.get("vp") or not seg0["vp"].get("sim")


# ============================================================
# 8. track -> spk 映射(_apply_track_blocks)
# ============================================================

def test_apply_track_blocks_max_overlap_wins():
    """多块与段重叠时取重叠时长最大块; spk 富对象键集与旧分支逐键一致。"""
    from services.audio_analysis_pipeline import _apply_track_blocks

    segments = [
        {"start": 0.2, "end": 1.5, "text": "第一句"},
        {"start": 3.0, "end": 5.0, "text": "第二句"},
        {"start": 8.0, "end": 9.0, "text": "<|nospeech|>"},
    ]
    facts = {"blocks": [
        # 段1: 块 A 重叠 0.4s, 块 B 重叠 1.0s -> 取 B(unknown 身份)
        {"start_ms": 100, "end_ms": 500, "unk_id": None, "kind": "registered",
         "name": "小贺", "ref_sim": 0.81, "count": None, "is_new": False},
        {"start_ms": 400, "end_ms": 1400, "unk_id": "unk_x", "kind": "unknown",
         "name": None, "ref_sim": 0.66, "count": 3, "is_new": True},
        # 段2 只有 env 块
        {"start_ms": 3100, "end_ms": 4900, "unk_id": None, "kind": "env",
         "name": None, "ref_sim": 0.05, "count": None, "is_new": False},
        # 段3 无重叠块 -> 不映射
    ]}
    n = _apply_track_blocks(segments, facts)
    assert n == 2
    spk1 = segments[0]["voiceprint_track_spk"]
    assert spk1 == {"id": "unk_x", "kind": "unknown", "name": None,
                    "unk_id": "unk_x", "ref_sim": 0.66, "count": 3,
                    "is_new": True}
    spk2 = segments[1]["voiceprint_track_spk"]
    assert spk2["kind"] == "env" and spk2["id"] == "env"
    assert "voiceprint_track_spk" not in segments[2]


def test_voice_summary_spk_passthrough_track(monkeypatch):
    """voice_summary: track 映射的段直通 se.spk(旧 unknown/registered 分支键集零变化)。"""
    from services.audio_analysis_pipeline import voice_summary

    segments = [{
        "start": 0.0, "end": 2.0, "text": "你好",
        "voiceprint_track_spk": {
            "id": "unk_a", "kind": "unknown", "name": None,
            "unk_id": "unk_a", "ref_sim": 0.7, "count": 9, "is_new": False},
    }]
    entry = voice_summary(segments, [], {}, "audio.wav", "10:00:00", "你好", 2.0)
    spk = entry["segs"][0]["spk"]
    assert spk == {"id": "unk_a", "kind": "unknown", "name": None,
                   "unk_id": "unk_a", "ref_sim": 0.7, "count": 9, "is_new": False}


def test_pipeline_track_failure_leaves_spk_fallback(monkeypatch, tmp_path):
    """track 返回 None(不可达) -> 段无 track 映射, spk 走既有阈值分档, 绝不本地建档。"""
    env = _PipelineEnv(monkeypatch, tmp_path)
    import services.audio_analysis_pipeline as pipeline_mod

    monkeypatch.setattr(pipeline_mod, "_unknown_speaker_enabled", lambda: True)
    track_calls = []
    monkeypatch.setattr(
        kjc, "unknown_track",
        lambda key, **kw: track_calls.append(key) or None,
    )

    wav = _wav_file(tmp_path, seconds=2.0)
    ret = pipeline_mod.analyze_audio_file(wav, None, device_name="dev-track")
    assert ret == "ok"
    assert len(track_calls) == 1  # 被尝试
    entry = env.calls[0]
    # 无评分(声纹 0 spk)无 track -> env 分档兜底(旧形状)
    spk = entry["segs"][0]["spk"]
    assert spk["kind"] == "env" and spk["unk_id"] is None
