# -*- coding: utf-8 -*-
"""K2 外层接线测试（RED 先行）：speakers 动作经内核 / 断连降级 / 语音助手WS已删。

约定：
  - POST enroll/identify + GET 清单 -> 内核 /v1/voiceprint/*（httpx MockTransport 桩，
    绝不 spawn 真内核）
  - 内核不可达 -> 交互路由 503 {"error":{"code":"state.unavailable",...}}
  - 感知管线/预览在内核断连时降级：不 503、不崩、vp 字段留空 / sim=null+reason
  - /ws/voice-assistant 路由必须消失（OQ2 裁定删除）
"""
import io
import math
import struct
import wave

import httpx
import pytest

from services import kernel_client as kc


# ============================================================
# 测试辅助
# ============================================================

def _wav_bytes(seconds: float = 0.3, freq: float = 440.0) -> bytes:
    """16kHz/mono/16bit 正弦 WAV。"""
    sr = 16000
    n = int(sr * seconds)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        frames = b"".join(
            struct.pack("<h", int(32767 * 0.3 * math.sin(2 * math.pi * freq * i / sr)))
            for i in range(n)
        )
        wf.writeframes(frames)
    return buf.getvalue()


def _envelope(facts: dict) -> dict:
    return {
        "schema_version": "1",
        "facts": facts,
        "provenance": {
            "model_id": "m", "model_hash": "h", "cohort_hash": "c",
            "preprocessing_version": "p", "computed_at": "2026-01-01T00:00:00Z",
        },
    }


def _stub(handler):
    """构造打桩内核客户端（已连接，不 spawn）。"""
    return kc.KernelClient(
        base_url="http://kernel.test", token="t",
        transport=httpx.MockTransport(handler),
    )


def _down_client():
    def _raise(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    return _stub(_raise)


@pytest.fixture
def patch_kernel(request, monkeypatch):
    """工厂夹具：patch_kernel(handler_or_client) -> 安装内核桩。"""

    def _install(client_or_factory):
        client = (client_or_factory() if callable(client_or_factory)
                  else client_or_factory)
        monkeypatch.setattr(kc, "get_kernel_client", lambda: client)
        kc._reset_down_state()
        return client

    return _install


# ============================================================
# 1) speakers 动作经内核 happy path
# ============================================================

def test_enroll_via_kernel_success(client, auth_headers, patch_kernel):
    def _handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/voiceprint/enroll"
        assert request.headers["Authorization"] == "Bearer t"
        return httpx.Response(200, json=_envelope({
            "enrolled": True,
            "speaker_id": "spk_k2test000001",
            "name": "张三",
            "remark": "宿舍",
            "scene_tag": "",
            "created_at": "2026-09-23T00:00:00Z",
            "embedding_dim": 192,
            "segments_used": 1,
            "duration_ms": 300,
            "speaker_count": 1,
        }))

    patch_kernel(_stub(_handler))
    resp = client.post(
        "/api/screen/speakers/enroll",
        headers=auth_headers,
        files={"file": ("t.wav", _wav_bytes(), "audio/wav")},
        data={"name": "张三", "remark": "宿舍"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "ok"
    assert body["speaker"]["speaker_id"] == "spk_k2test000001"
    assert body["speaker"]["name"] == "张三"


def test_identify_via_kernel_success(client, auth_headers, patch_kernel):
    def _handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/voiceprint/identify"
        return httpx.Response(200, json=_envelope({
            "matched": True,
            "speaker_id": "spk_a",
            "name": "张三",
            "similarity": 0.72,
            "threshold": 0.45,
            "threshold_passed": True,
            "candidates": [
                {"speaker_id": "spk_a", "name": "张三", "similarity": 0.72},
                {"speaker_id": "spk_b", "name": "李四", "similarity": 0.10},
            ],
            "count": 2,
            "as_norm_on": True,
            "n_cohort": 500,
        }))

    patch_kernel(_stub(_handler))
    resp = client.post(
        "/api/screen/speakers/identify",
        headers=auth_headers,
        files={"file": ("t.wav", _wav_bytes(), "audio/wav")},
        data={"threshold": "0.45", "top_k": "3"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "ok"
    # 外层旧契约：matches 只含 >= threshold 的候选（内核 candidates 不做阈值过滤）
    assert body["count"] == 1
    assert body["matches"][0]["name"] == "张三"
    assert body["matches"][0]["similarity"] == 0.72


def test_list_via_kernel_success(client, auth_headers, patch_kernel):
    def _handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/voiceprint/speakers"
        return httpx.Response(200, json=_envelope({
            "count": 1,
            "speakers": [{"speaker_id": "spk_a", "name": "张三",
                          "embedding_dim": 192,
                          "created_at": "2026-09-23T00:00:00Z"}],
        }))

    patch_kernel(_stub(_handler))
    resp = client.get("/api/screen/speakers", headers=auth_headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "ok"
    assert body["count"] == 1
    assert body["speakers"][0]["name"] == "张三"


def test_delete_via_kernel_missing_404(client, auth_headers, patch_kernel):
    def _handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "DELETE"
        return httpx.Response(404, json={
            "error": {"code": "input.not_found",
                      "message": "声纹不存在: spk_nope", "retryable": False}})

    patch_kernel(_stub(_handler))
    resp = client.delete("/api/screen/speakers/spk_nope", headers=auth_headers)
    assert resp.status_code == 404


# ============================================================
# 2) 内核断连：交互路由 503 封闭码
# ============================================================

@pytest.mark.parametrize("method,path,data", [
    ("POST", "/api/screen/speakers/identify", None),
    ("POST", "/api/screen/speakers/enroll", None),
    ("GET", "/api/screen/speakers", None),
])
def test_kernel_down_maps_to_503_state_unavailable(
    client, auth_headers, patch_kernel, method, path, data,
):
    patch_kernel(_down_client())
    kwargs = {"headers": auth_headers}
    if method == "POST":
        kwargs["files"] = {"file": ("t.wav", _wav_bytes(), "audio/wav")}
        kwargs["data"] = {"name": "张三"} if "enroll" in path else {}
    resp = client.request(method, path, **kwargs)
    assert resp.status_code == 503, resp.text
    err = resp.json()["error"]
    assert err["code"] == "state.unavailable"
    assert err["retryable"] is True


# ============================================================
# 3) 预览/感知：内核断连 -> 降级 200，不 503
# ============================================================

def test_preview_sliding_kernel_down_degrades_200(
    client, auth_headers, patch_kernel, tmp_path, monkeypatch,
):
    import routers.preview as preview_mod

    # 造一个隔离的 daily/{date}/audio/{file}.wav
    data_root = tmp_path / "data"
    day = data_root / "daily" / "2026-01-01" / "audio"
    day.mkdir(parents=True)
    wav_path = day / "clip.wav"
    wav_path.write_bytes(_wav_bytes(seconds=2.0))

    monkeypatch.setattr(preview_mod, "_data_dir", lambda: str(data_root))
    patch_kernel(_down_client())

    resp = client.get(
        "/api/preview/sliding",
        params={"date": "2026-01-01", "file": "clip.wav"},
        headers=auth_headers,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ready"] is False
    assert body["reason"] == "state.unavailable"


# ─── B3: preview /file 与 /space 改 fake-kernel 缝（算法经内核, 形状映射） ───

def _preview_wav_file(tmp_path, seconds: float = 2.0):
    """在隔离数据根造 daily/{date}/audio/clip.wav，返回 data_root。"""
    data_root = tmp_path / "data"
    day = data_root / "daily" / "2026-01-01" / "audio"
    day.mkdir(parents=True)
    (day / "clip.wav").write_bytes(_wav_bytes(seconds=seconds))
    return data_root


def _preview_kernel_handler(request: httpx.Request) -> httpx.Response:
    """按内核各端点返回对应形状的假 facts（无需真内核）。"""
    path = request.url.path
    if path == "/v1/health":
        return httpx.Response(200, json={"status": "ok"})
    if path == "/v1/inspect/asr_sliding":
        return httpx.Response(200, json=_envelope({
            "windows": [{"start_ms": 0, "end_ms": 5000, "text": "你好",
                         "emotion": "", "event": None}],
            "truncated": False, "count_total": 1, "duration_ms": 2000,
            "reason": "ok"}))
    if path == "/v1/inspect/vad_curve":
        return httpx.Response(200, json=_envelope({
            "points": [0.1, 0.9, 0.2], "step_ms": 100, "frames_total": 3,
            "decimated": False, "duration_ms": 2000, "engine": "silero",
            "reason": "ok"}))
    if path == "/v1/inspect/diarize_blocks":
        return httpx.Response(200, json=_envelope({
            "blocks": [{"start_ms": 0, "end_ms": 1000, "speaker": "张三",
                        "sim": 0.72}],
            "blocks_truncated": False, "count": 1, "as_norm_on": True,
            "n_cohort": 10, "reason": "ok"}))
    if path == "/v1/voiceprint/score":
        return httpx.Response(200, json=_envelope({
            "scores": {"张三": 0.7}, "raw": {"张三": 0.6}, "imp_mean": 0.1,
            "imp_std": 0.05, "n_cohort": 10, "as_norm_on": True, "reason": "ok"}))
    if path == "/v1/voiceprint/space":
        return httpx.Response(200, json=_envelope({
            "axes": ["PC1", "PC2"], "explained": [0.6, 0.2],
            "cohort": [{"x": 0.0, "y": 0.0}, {"x": 1.0, "y": 1.0}],
            "centroids": [{"x": 0.5, "y": 0.5, "name": "张三"}],
            "probe": {"x": 0.4, "y": 0.6}, "n_points": 3, "reason": "ok"}))
    raise AssertionError("unexpected kernel path: " + path)


def test_preview_file_via_kernel_maps_shapes(
    client, auth_headers, patch_kernel, tmp_path, monkeypatch,
):
    import routers.preview as preview_mod

    data_root = _preview_wav_file(tmp_path)
    monkeypatch.setattr(preview_mod, "_data_dir", lambda: str(data_root))
    patch_kernel(_stub(_preview_kernel_handler))

    resp = client.get(
        "/api/preview/file",
        params={"date": "2026-01-01", "file": "clip.wav"},
        headers=auth_headers,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["engine"] == "pyannote"
    # 滑窗 ASR: 内核 ms -> 前端秒 + emotion/event 保留
    assert body["asr_sliding"][0]["text"] == "你好"
    assert body["asr_sliding"][0]["start"] == 0.0
    assert body["asr_sliding"][0]["end"] == 5.0
    # 三引擎曲线
    assert [c["name"] for c in body["vad_curves"]] == ["Silero", "pyannote", "FunASR"]
    assert body["vad_curves"][0]["points"][0] == {"t": 0.0, "v": 0.1}
    assert body["vad_curve_reason"] is None
    # 切分块: 内核四键 -> 旧前端形状(富字段退化)
    assert body["diar"]["ready"] is True
    b0 = body["diar"]["blocks"][0]
    assert b0["speaker"] == "张三" and b0["sim"] == 0.72
    assert b0["sim_spk"] == "张三" and b0["raw_sim"] is None and b0["raw_spk"] == ""
    # 生产滑窗轨经 score_all_v2（已达标, 保留）
    assert body["diar"]["prod_track"], "生产滑窗轨应有数据"
    # sortformer 产物字段不再出现
    assert "vad_variants" not in body
    assert body["diar"]["engine"] == "pyannote"


def test_preview_file_sortformer_engine_rejected(
    client, auth_headers, patch_kernel, tmp_path, monkeypatch,
):
    """D5: sortformer 入口已移除 -> engine=sortformer 400。"""
    import routers.preview as preview_mod

    data_root = _preview_wav_file(tmp_path)
    monkeypatch.setattr(preview_mod, "_data_dir", lambda: str(data_root))
    resp = client.get(
        "/api/preview/file",
        params={"date": "2026-01-01", "file": "clip.wav", "engine": "sortformer"},
        headers=auth_headers,
    )
    assert resp.status_code == 400, resp.text


def test_preview_file_kernel_down_panels_empty(
    client, auth_headers, patch_kernel, tmp_path, monkeypatch,
):
    import routers.preview as preview_mod

    data_root = _preview_wav_file(tmp_path)
    monkeypatch.setattr(preview_mod, "_data_dir", lambda: str(data_root))
    patch_kernel(_down_client())

    resp = client.get(
        "/api/preview/file",
        params={"date": "2026-01-01", "file": "clip.wav"},
        headers=auth_headers,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["asr_sliding"] == []
    assert body["asr_sliding_reason"] == "state.unavailable"
    assert body["vad_curves"] == []
    assert body["vad_curve_reason"] == "state.unavailable"
    assert body["diar"]["ready"] is False
    assert body["diar"]["reason"] == "state.unavailable"


def test_preview_space_via_kernel_maps(
    client, auth_headers, patch_kernel, tmp_path, monkeypatch,
):
    import routers.preview as preview_mod

    data_root = _preview_wav_file(tmp_path, seconds=4.0)
    monkeypatch.setattr(preview_mod, "_data_dir", lambda: str(data_root))
    patch_kernel(_stub(_preview_kernel_handler))

    resp = client.get(
        "/api/preview/space",
        params={"date": "2026-01-01", "file": "clip.wav"},
        headers=auth_headers,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ready"] is True
    assert body["n_cohort"] == 2
    assert body["anchors"] == ["张三"]
    assert {p["kind"] for p in body["points"]} == {"cohort", "anchor"}
    assert body["explained_var"] == [0.6, 0.2]
    assert body["file_points"], "滑窗探针应有坐标(经内核 space)"
    assert body["file_points"][0]["x"] == 0.4


def test_preview_space_kernel_down(client, auth_headers, patch_kernel):
    patch_kernel(_down_client())
    resp = client.get("/api/preview/space", headers=auth_headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["ready"] is False
    assert resp.json()["reason"] == "state.unavailable"


def test_pipeline_score_kernel_down_writes_voice_entry_without_vp(
    monkeypatch, tmp_path,
):
    """主链可用但段级评分内核断连：不抛、voice 条目照常写入、vp/spk 留空、不触发重投。

    B2 语义: requeue 只覆盖"主链四 kind 不可用"; 主链已成功、仅评分/滑窗垫片
    (kernel_score)不可达时, 打分降级为不标注, 绝不重投(重投会白耗四个重作业)。
    """
    import types

    from services import perception_store

    # 1) 主链作业缝: 返回一个 >=0.5s 的语音段(进入段级声纹分支)
    def _fake_jobs(path):
        return {
            "analyze.vad": {"duration_ms": 1000,
                            "segments": [{"start_ms": 0, "end_ms": 1000}]},
            "analyze.asr": {"duration_ms": 1000, "text": "你好",
                            "segments": [{"start_ms": 0, "end_ms": 1000,
                                          "text": "你好", "emotion": "neutral",
                                          "confidence": 0.8}]},
            "analyze.scene": {"duration_ms": 1000, "scene_primary": None,
                              "scene_tags": [], "scene_groups": {}},
            "analyze.diarize": {"duration_ms": 1000, "segments": []},
        }

    from services import kernel_job_client as kjc_mod

    monkeypatch.setattr(kjc_mod, "run_audio_analysis_jobs", _fake_jobs)
    monkeypatch.setattr(
        kjc_mod, "run_residual_analysis_jobs",
        lambda path, **kw: {k: None for k in ("analyze.aed", "analyze.breath")},
    )
    monkeypatch.setattr(
        kjc_mod, "unknown_track", lambda *a, **k: None,
    )

    # 2) track 门(新链走 kjc.unknown_track 缝=None 已够)。
    #    (B5t) 陌生人聚合已改管线内置纯内存聚合 _summarize_unk_entry，
    #    不再 import unknown_speaker_pipeline——旧 no-op 补丁随接线删除。
    import services.audio_analysis_pipeline as pipeline_mod

    monkeypatch.setattr(pipeline_mod, "_unknown_speaker_enabled", lambda: True)
    # requeue 拦截: 断言评分降级不应触发重投
    retries = []
    monkeypatch.setattr(
        pipeline_mod, "_schedule_retry",
        lambda *a, **k: retries.append(a),
    )

    # 3) 声纹内核探针桩: 有注册(打开段级评分分支), 但评分走内核断连桩
    import services.kernel_client as kc_mod

    monkeypatch.setattr(kc_mod, "vp_speaker_count", lambda: 1)
    monkeypatch.setattr(kc_mod, "vp_cohort_stats", lambda: {"active": 0})

    # 4) 内核断连桩(评分垫片经 get_kernel_client -> ConnectError -> 空 detail)
    patch = kc.KernelClient(
        base_url="http://kernel.test", token="t",
        transport=httpx.MockTransport(
            lambda request: (_ for _ in ()).throw(
                httpx.ConnectError("refused", request=request)
            )
        ),
    )
    monkeypatch.setattr(kc, "get_kernel_client", lambda: patch)
    kc._reset_down_state()

    # 5) 配置/存储隔离
    import config.config as cfg_mod

    monkeypatch.setattr(
        cfg_mod, "get_config",
        lambda: types.SimpleNamespace(
            DATA_DIR=str(tmp_path),
            _data={},  # _unknown_speaker_enabled 读 _data(此处 enabled 门已被覆盖)
        ),
    )
    calls = []
    monkeypatch.setattr(
        perception_store, "append_perception",
        lambda entry, user_id="default", auto_type=True, date_str=None: calls.append(entry) or True,
    )
    monkeypatch.setattr(perception_store, "_DATA_BASE", str(tmp_path / "daily"))
    monkeypatch.setattr(
        perception_store, "_STREAM_AUDIO_BASE", str(tmp_path / "stream")
    )

    # 6) 真实 wav + 真实 analyze_audio_file
    wav = tmp_path / "clip.wav"
    wav.write_bytes(_wav_bytes(seconds=2.0))

    from services.audio_analysis_pipeline import analyze_audio_file

    ret = analyze_audio_file(str(wav), None, device_name="dev-degrade")

    assert ret == "ok"
    assert retries == [], "主链成功、仅评分不可达时不得触发 requeue"
    assert len(calls) == 1, "段级评分断连时 voice 条目必须照常写入"
    entry = calls[0]
    assert entry.get("type") == "voice"
    seg0 = (entry.get("segs") or [{}])[0]
    # 降级语义：vp/spk 字段留空（不标说话人、不给分数）
    assert not seg0.get("voiceprint_speaker"), "断连时不得标注说话人"
    assert seg0.get("voiceprint_sim") in (None, 0), "断连时不得给声纹分"


# ============================================================
# 4) 语音助手 WS 路由已删除（OQ2）
# ============================================================

def test_voice_assistant_ws_route_removed():
    from main import app

    paths = [getattr(r, "path", "") for r in app.routes]
    assert "/ws/voice-assistant" not in paths, \
        "voice_assistant_ws 路由必须删除（OQ2 裁定，零客户端/依赖已删）"


def test_voice_assistant_ws_connect_rejected(client):
    from starlette.websockets import WebSocketDisconnect

    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws/voice-assistant?token=bad"):
            pass
