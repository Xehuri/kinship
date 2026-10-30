# -*- coding: utf-8 -*-
"""B1 唤醒链全量切内核：fake 内核 httpx 缝断言（不 spawn 真内核、零本地模型）。

覆盖四个算法点的内核化接线与降级矩阵：
  1. 进门/退出打分 -> kernel_client 垫片（POST /v1/voiceprint/score，
     collect 不传 = False，唤醒音频不进 cohort）；内核 down -> 进门
     fail-closed（scores 空 -> 拒绝开录）、退出判停跳过（None，计数不动）。
  2. 录停 ASR -> kernel_job_client.run_audio_analysis_jobs（kinds 恰
     ["analyze.asr"]，options.weak_split 逐键透传配置）；通道 None ->
     放弃本次指令，绝不回退本地 SenseVoice。
  3. 尾静音判停 -> POST /v1/inspect/vad_curve（engine=pyannote，
     10s 窗 buffer、bucket 网格）；失败 -> 本次判定跳过。
  4. KWS：start_state 两条路径都不加载本地模型；detect 无命中不迁移
     （= 降级不唤醒）；local_hit 直通仍可驱动进门 -> 录制。
  5. 微型预热：_score_warmup_once -> score 端点一次静音微型请求
     （collect 不置真，失败容忍，节流）。
"""
import base64
import json
import os
import time

import httpx
import numpy as np
import pytest

from services import kernel_client as kc
from services import wake_word_service as wws


def _make_params(**over) -> wws.WakeParams:
    """手工构造 WakeParams（绕过 audio_config，测试零配置依赖）。"""
    base = dict(
        sample_rate=16000,
        pre_roll_ms=800,
        feed_queue_maxsize=50,
        keywords_score=1.8,
        keywords_threshold=0.25,
        entry_threshold_ready=0.7,
        entry_threshold_cold=0.45,
        exit_threshold=0.75,
        exit_threshold_cold=0.45,
        exit_hold_ms=3750,
        vad_silence_ms=3000,
        min_record_ms=2500,
        max_record_ms=1800000,
        sliding_window_ms=1500,
        sliding_hop_ms=750,
        vad_threshold=0.5,
        vad_window_s=10.0,
        vad_step_s=0.5,
        vad_bucket_ms=100,
        weak_split={"enabled": True, "window_ms": 1500,
                    "low_energy_win_ms": 1500, "min_seg_ms": 2500,
                    "max_seg_ms": 12000},
    )
    base.update(over)
    return wws.WakeParams(**base)


def _stub(handler):
    """构造打桩内核客户端（已连接，不 spawn）——同 K2/rewire 惯例。"""
    return kc.KernelClient(
        base_url="http://kernel.test", token="t",
        transport=httpx.MockTransport(handler),
    )


def _down_client():
    def _raise(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    return _stub(_raise)


@pytest.fixture(autouse=True)
def reset_warn_state():
    """限频告警状态隔离（避免跨用例互相抑制断言）。"""
    with wws._kernel_warn_lock:
        wws._kernel_warn_ts.clear()
    kc._reset_down_state()
    yield


def _score_envelope(scores, as_norm=True):
    """内核 /v1/voiceprint/score 成功信封（六键 facts）。"""
    return httpx.Response(200, json={
        "schema_version": "1",
        "facts": {"scores": dict(scores), "raw": {}, "imp_mean": None,
                  "imp_std": None, "n_cohort": 12 if as_norm else 0,
                  "as_norm_on": bool(as_norm)},
        "provenance": {},
    })


def _bare_state(**param_over):
    """绕过线程/队列的 WakeWordState 壳（只测打分/判停数学）。"""
    st = object.__new__(wws.WakeWordState)
    st._p = _make_params(**param_over)
    st._sr = 16000
    st._session_id = "s-kernel-test"
    st._test_mode = False
    return st


# ============================================================
# 1) 进门打分走内核 score 端点；阈值域切换语义保真
# ============================================================

def test_entry_gate_calls_kernel_score_endpoint(monkeypatch):
    """进门验证 -> POST /v1/voiceprint/score；collect 不置真（不进 cohort）。"""
    seen = {}

    def _handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["payload"] = json.loads(request.content.decode("utf-8"))
        return _score_envelope({"用户": 0.82}, as_norm=True)

    monkeypatch.setattr(kc, "get_kernel_client", lambda: _stub(_handler))
    st = _bare_state()
    audio = np.zeros(24000, dtype=np.float32)
    ok, name, as_norm, score = st._voiceprint_gate(audio)
    assert ok is True and name == "用户" and as_norm is True
    assert score == pytest.approx(0.82)
    assert seen["path"] == "/v1/voiceprint/score"
    # 唤醒音频 collect=False：payload 不含 collect 键（保持现状纪律）
    assert "collect" not in seen["payload"]
    assert "sliding" not in seen["payload"]
    assert seen["payload"]["audio_b64"], "音频必须 base64 随请求上送"


def test_entry_gate_cold_domain_uses_cold_threshold(monkeypatch):
    """as_norm_on=False -> 走冷阈值域（entry_threshold_cold=0.45）：0.5 通过。"""
    monkeypatch.setattr(
        kc, "get_kernel_client",
        lambda: _stub(lambda req: _score_envelope({"用户": 0.50}, as_norm=False)),
    )
    st = _bare_state()
    ok, _name, as_norm, _score = st._voiceprint_gate(
        np.zeros(24000, dtype=np.float32)
    )
    assert as_norm is False
    assert ok is True, "raw 域 0.50 >= entry_threshold_cold 0.45 应通过"


def test_entry_gate_below_ready_threshold_rejected(monkeypatch):
    """AS-Norm 域 0.50 < entry_threshold_ready 0.7 -> 进门失败（阈值数学不变）。"""
    monkeypatch.setattr(
        kc, "get_kernel_client",
        lambda: _stub(lambda req: _score_envelope({"用户": 0.50}, as_norm=True)),
    )
    st = _bare_state()
    ok, _name, _as_norm, _score = st._voiceprint_gate(
        np.zeros(24000, dtype=np.float32)
    )
    assert ok is False


def test_entry_gate_kernel_down_fail_closed(monkeypatch):
    """内核不可达 -> scores 空 -> 进门失败（无法验证就不开录）。"""
    monkeypatch.setattr(kc, "get_kernel_client", _down_client)
    st = _bare_state()
    ok, name, as_norm, score = st._voiceprint_gate(
        np.zeros(24000, dtype=np.float32)
    )
    assert ok is False and name == "" and as_norm is None and score == 0.0


def test_entry_gate_empty_registry_fail_closed(monkeypatch):
    """内核在线但注册为空（scores={}）-> 同样恒失败（对齐旧语义）。"""
    monkeypatch.setattr(
        kc, "get_kernel_client",
        lambda: _stub(lambda req: _score_envelope({})),
    )
    st = _bare_state()
    ok, _name, _as_norm, _score = st._voiceprint_gate(
        np.zeros(24000, dtype=np.float32)
    )
    assert ok is False


# ============================================================
# 2) 退出滑窗打分走内核；低分/高分/域切换/不可达四态
# ============================================================

def _record_shell(**param_over):
    st = _bare_state(**param_over)
    # 1.5s @16k int16 = 48000 字节，恰满 sliding_window_ms 窗
    st._vp_buf = bytearray(b"\x01\x00" * 24000)
    st._vp_buf_limit = max(
        2, int(16000 * st._p.sliding_window_ms / 1000.0) * 2
    )
    st._vp_scores = []
    return st


def test_exit_window_low_score(monkeypatch):
    """窗分 0.30 < exit_threshold 0.75（AS-Norm 域）-> True（低分窗）。"""
    monkeypatch.setattr(
        kc, "get_kernel_client",
        lambda: _stub(lambda req: _score_envelope({"用户": 0.30})),
    )
    st = _record_shell()
    assert st._record_voiceprint_low() is True
    assert st._vp_scores == []   # 非测试模式不记观测序列


def test_exit_window_high_score(monkeypatch):
    """窗分 0.80 >= exit_threshold -> False（高分窗，计数应清零）。"""
    monkeypatch.setattr(
        kc, "get_kernel_client",
        lambda: _stub(lambda req: _score_envelope({"用户": 0.80})),
    )
    st = _record_shell()
    assert st._record_voiceprint_low() is False


def test_exit_window_kernel_down_returns_none(monkeypatch):
    """内核不可达 -> None（本次判停跳过，_low_windows 计数不动，绝不回退本地）。"""
    monkeypatch.setattr(kc, "get_kernel_client", _down_client)
    st = _record_shell()
    assert st._record_voiceprint_low() is None


def test_exit_window_cold_domain(monkeypatch):
    """as_norm_on=False -> 与 exit_threshold_cold 比对（0.40 < 0.45 -> 低分）。"""
    monkeypatch.setattr(
        kc, "get_kernel_client",
        lambda: _stub(lambda req: _score_envelope({"用户": 0.40}, as_norm=False)),
    )
    st = _record_shell()
    assert st._record_voiceprint_low() is True


# ============================================================
# 3) 录停 ASR -> analyze.asr job（weak_split 逐键透传）
# ============================================================

def test_asr_transcribe_submits_kernel_job(monkeypatch):
    """_kernel_asr_transcribe -> run_audio_analysis_jobs(单 kind asr + weak_split)。"""
    import services.kernel_job_client as kjc

    calls = []

    def _fake(audio_path, *, kinds=None, options_by_kind=None, **kw):
        calls.append({"kinds": kinds, "options": options_by_kind,
                      "path": audio_path})
        return {"analyze.asr": {"text": "开灯", "segments": [
            {"start_ms": 0, "end_ms": 800, "text": "开"},
            {"start_ms": 800, "end_ms": 1600, "text": "灯"},
            {"start_ms": 1600, "end_ms": 2400, "text": "  "},
        ]}}

    monkeypatch.setattr(kjc, "run_audio_analysis_jobs", _fake)
    st = _bare_state()
    text = st._kernel_asr_transcribe(b"\x00\x00" * 16000)
    assert text == "开灯", "逐段 strip 后拼接（空白段剔除，与旧聚合路径一致）"
    assert calls[0]["kinds"] == ["analyze.asr"]
    # 生产配置节逐键透传（enabled 显式传，含 low_energy_win_ms 宽容键）
    assert calls[0]["options"] == {"analyze.asr": {"weak_split": {
        "enabled": True, "window_ms": 1500, "low_energy_win_ms": 1500,
        "min_seg_ms": 2500, "max_seg_ms": 12000,
    }}}
    assert not os.path.exists(calls[0]["path"]), "临时 WAV 用后即删"


def test_asr_transcribe_channel_down_returns_none(monkeypatch):
    """通道不可用（run_audio_analysis_jobs -> None）-> None（放弃指令信号）。"""
    import services.kernel_job_client as kjc

    monkeypatch.setattr(kjc, "run_audio_analysis_jobs", lambda *a, **k: None)
    st = _bare_state()
    assert st._kernel_asr_transcribe(b"\x00\x00" * 16000) is None


def test_asr_disabled_weak_split_forwards_enabled_false(monkeypatch):
    """配置 enabled=False 时显式透传 {enabled: False}（内核缺省同值，双保险）。"""
    import services.kernel_job_client as kjc

    calls = []

    def _fake(audio_path, *, kinds=None, options_by_kind=None, **kw):
        calls.append(options_by_kind)
        return {"analyze.asr": {"segments": []}}

    monkeypatch.setattr(kjc, "run_audio_analysis_jobs", _fake)
    st = _bare_state(weak_split={"enabled": False})
    assert st._kernel_asr_transcribe(b"\x00\x00" * 16000) == ""
    assert calls[0] == {"analyze.asr": {"weak_split": {"enabled": False}}}


# ============================================================
# 4) 尾静音判停 -> POST /v1/inspect/vad_curve
# ============================================================

def _vad_shell():
    st = _bare_state()
    st._vad_buf = bytearray(b"\x00\x00" * 16000)   # 1s 缓冲（不足 10s 前补零）
    return st


def _vad_curve_facts(points, duration_ms, step_ms=100):
    return httpx.Response(200, json={
        "schema_version": "1",
        "facts": {"points": points, "step_ms": step_ms,
                  "frames_total": len(points), "decimated": False,
                  "duration_ms": duration_ms, "engine": "pyannote",
                  "reason": "ok"},
        "provenance": {},
    })


def test_vad_trailing_silence_via_kernel(monkeypatch):
    """曲线尾部 30 桶低于阈值 -> 尾静音 3.0s；喂 10s 窗（前补零）、frame=bucket。"""
    seen = {}

    def _handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["payload"] = json.loads(request.content.decode("utf-8"))
        wav = base64.b64decode(seen["payload"]["audio_b64"])
        seen["wav_len"] = len(wav)
        seen["riff"] = wav[:4]
        return _vad_curve_facts([0.9] * 70 + [0.0] * 30, 10000)

    monkeypatch.setattr(kc, "get_kernel_client", lambda: _stub(_handler))
    st = _vad_shell()
    silence = st._vad_trailing_silence()
    assert seen["path"] == "/v1/inspect/vad_curve"
    assert seen["payload"]["engine"] == "pyannote"
    assert seen["payload"]["frame_ms"] == 100   # = vad_bucket_ms
    assert seen["riff"] == b"RIFF"
    # 10s 窗 = 前补零至 320000 字节 PCM + 44 字节 RIFF 头
    assert seen["wav_len"] == 10 * 16000 * 2 + 44
    assert silence == pytest.approx(3.0)


def test_vad_trailing_silence_all_silent(monkeypatch):
    """全静音曲线 -> 尾静音 = 整窗时长。"""
    monkeypatch.setattr(
        kc, "get_kernel_client",
        lambda: _stub(lambda req: _vad_curve_facts([0.0] * 100, 10000)),
    )
    st = _vad_shell()
    assert st._vad_trailing_silence() == pytest.approx(10.0)


def test_vad_trailing_silence_all_speech_returns_zero(monkeypatch):
    """全语音曲线 -> 尾静音 0（不触发停止）。"""
    monkeypatch.setattr(
        kc, "get_kernel_client",
        lambda: _stub(lambda req: _vad_curve_facts([1.0] * 100, 10000)),
    )
    st = _vad_shell()
    assert st._vad_trailing_silence() == pytest.approx(0.0)


def test_vad_trailing_silence_kernel_down_returns_none(monkeypatch):
    """内核不可达 -> None（本次判定跳过，与原「推理异常忽略」同语义）。"""
    monkeypatch.setattr(kc, "get_kernel_client", _down_client)
    st = _vad_shell()
    assert st._vad_trailing_silence() is None


def test_vad_empty_buffer_skips_kernel(monkeypatch):
    """空缓冲不发内核请求（旧行为保持）。"""
    def _handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("空缓冲不得调用内核")

    monkeypatch.setattr(kc, "get_kernel_client", lambda: _stub(_handler))
    st = _vad_shell()
    st._vad_buf = bytearray()
    assert st._vad_trailing_silence() is None


# ============================================================
# 5) KWS 降级不唤醒：start_state 无本地模型；detect 无命中不迁移
# ============================================================

@pytest.fixture
def wake_enabled(monkeypatch):
    """开唤醒 + 固定词表 + 打桩预热（绝不打真内核）。"""
    monkeypatch.setattr(wws, "is_enabled", lambda: True)
    monkeypatch.setattr(wws, "_resolve_params", lambda: _make_params())
    monkeypatch.setattr(wws, "_target_keywords", ["小贺同学"])
    monkeypatch.setattr(wws, "_schedule_score_warmup", lambda: None)


def test_start_state_no_local_kws_model(wake_enabled):
    """start_state 不加载任何本地 KWS 模型即可建立唤醒态；无命中永停留 detect。"""
    assert not hasattr(wws.WakeWordDetector, "ensure_spotter")
    assert not hasattr(wws.WakeWordState, "_reset_kws_stream")
    st = wws.start_state("dev", "s-k1", 0, None, False, local_hit=False)
    assert st is not None
    try:
        # 无命中来源时持续投喂也只停留 detect（= 降级不唤醒）
        st.feed(b"\x00\x00" * 16000)
        deadline = time.time() + 1.0
        while time.time() < deadline:
            if st._state != "detect":
                break
            time.sleep(0.05)
        assert st._state == "detect"
    finally:
        st.close()


def test_kernel_down_still_starts_state(wake_enabled, monkeypatch):
    """内核整体不可达时 start_state 仍成功（上行/pre-roll 不受影响），
    唤醒检测自然失效（无命中注入方）——降级不唤醒的行为基座。"""
    monkeypatch.setattr(kc, "get_kernel_client", _down_client)
    st = wws.start_state("dev", "s-k2", 0, None, False, local_hit=False)
    assert st is not None
    st.close()


def test_local_hit_passthrough_still_drives_state(wake_enabled, monkeypatch):
    """local_hit 直通回归：登记命中 + 喂满验证窗 -> 进门验证（打桩）通过进 record。"""
    monkeypatch.setattr(
        wws.WakeWordState, "_voiceprint_gate",
        lambda self, audio: (True, "测试员", True, 0.9),
    )
    st = wws.start_state("dev", "s-k3", 0, None, False, local_hit=True)
    assert st is not None
    try:
        assert st.trigger_local_hit("小贺同学", confidence=0.95) is True
        st.feed(b"\x00\x00" * int(16000 * 1.6))  # 1.6s >= sliding 1.5s
        deadline = time.time() + 2.0
        while time.time() < deadline and st._state != "record":
            time.sleep(0.05)
        assert st._state == "record", f"应进入 record 态，实际 {st._state}"
    finally:
        st.close()


# ============================================================
# 6) 微型预热：静音 0.1s + score 端点 + 失败容忍 + 节流
# ============================================================

def test_score_warmup_micro_request(monkeypatch):
    """_score_warmup_once 向 score 端点发一次微型静音请求（collect 不置真）。"""
    seen = {}

    def _handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["payload"] = json.loads(request.content.decode("utf-8"))
        return httpx.Response(200, json={
            "schema_version": "1", "facts": {"scores": {}}, "provenance": {},
        })

    monkeypatch.setattr(kc, "get_kernel_client", lambda: _stub(_handler))
    with wws._warm_lock:
        wws._warm_last_ts = 0.0
    wws._score_warmup_once()
    assert seen["path"] == "/v1/voiceprint/score"
    assert "collect" not in seen["payload"]
    wav = base64.b64decode(seen["payload"]["audio_b64"])
    # 0.1s @16k int16 + 44 头 = 3244 字节（微型样本）
    assert len(wav) == int(0.1 * 16000) * 2 + 44
    assert wav[:4] == b"RIFF"


def test_score_warmup_swallows_kernel_down(monkeypatch):
    """预热失败只告警，绝不抛出、绝不阻断 start_state。"""
    monkeypatch.setattr(kc, "get_kernel_client", _down_client)
    with wws._warm_lock:
        wws._warm_last_ts = 0.0
    wws._score_warmup_once()   # 不抛即通过


def test_score_warmup_throttled(monkeypatch):
    """预热节流：窗口内重复调用不再触内核。"""
    calls = {"n": 0}

    def _handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, json={
            "schema_version": "1", "facts": {"scores": {}}, "provenance": {},
        })

    monkeypatch.setattr(kc, "get_kernel_client", lambda: _stub(_handler))
    with wws._warm_lock:
        wws._warm_last_ts = 0.0
    wws._score_warmup_once()
    wws._score_warmup_once()
    assert calls["n"] == 1


# ============================================================
# 7) 限频告警工具本身
# ============================================================

def test_warn_kernel_down_rate_limited(monkeypatch):
    """同一 tag 60s 内只输出一条 ERROR。"""
    errors = []

    class _Rec:
        def error(self, msg, *a, **k):
            errors.append(msg)

    monkeypatch.setattr(wws, "logger", _Rec())
    with wws._kernel_warn_lock:
        wws._kernel_warn_ts.clear()
    wws._warn_kernel_down("t1", "first")
    wws._warn_kernel_down("t1", "second")
    wws._warn_kernel_down("t2", "other-tag")
    assert len(errors) == 2, "同 tag 抑制、异 tag 各放行一条"
