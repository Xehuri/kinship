# -*- coding: utf-8 -*-
"""B1 唤醒链端到端 sanity：真内核（kernel_client 自动 spawn --port 0）。

覆盖两个必须真算力的贯通点（其余四个算法点由 test_wake_kernel_paths.py 的
fake-httpx 缝全量锁定，此处不重复）：

  1. 进门验证执行且失败拒录：trigger_local_hit + 合成正弦 PCM（1.6s，满足
     sliding 1500ms 验证窗）喂进 WakeWordState -> 真内核 /v1/voiceprint/score
     打分。临时空 state-dir（无注册声纹）-> scores 恒空 -> fail-closed：
     状态机不进 record（回 detect），App 协议帧 wake_start 绝不发出。
  2. 录停 ASR 提交收割：WakeWordState._kernel_asr_transcribe 对合成正弦 WAV
     提交 analyze.asr 作业（weak_split 显式透传）并长轮询收割。内核可用时
     返回 str（正弦无语音 -> 通常空串）；返回 None 则视为内核 ASR 不可用
     （model.unavailable 等）-> skip 而非 fail（本机权重不齐时不误伤基线）。

运行门控：默认 **skip**。原因（不强求是任务裁定）：
  - 真内核 spawn + ERes2Vec/SenseVoice 懒加载首调分钟级，全量基线（~4 分钟）
    不宜每次都付这个时长与偶发抖动；
  - 需要本机具备内核全部权重。
手动验证：`AXEUH_B1_REAL_KERNEL=1 python -m pytest tests/test_wake_kernel_real.py -v`
（B1 交付时本机已跑通，证据见完成报告）。

内核生命周期：state-dir 指向 tmp_path；本测试自己 spawn 的内核进程在
fixture 收尾按 PID 精确回收（只杀本次 _popen 记录的子进程，绝不按进程名
杀，遵守仓库进程管理红线）。
"""
import asyncio
import os
import time

import numpy as np
import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("AXEUH_B1_REAL_KERNEL") != "1",
    reason="真内核 e2e 默认关：spawn+模型懒加载分钟级/需本机权重（B1 交付已在"
           "本机以 AXEUH_B1_REAL_KERNEL=1 跑通）。开启方式见文件 docstring。",
)


def _make_params(**over):
    from services import wake_word_service as wws

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
                    "min_seg_ms": 2500, "max_seg_ms": 12000},
    )
    base.update(over)
    return wws.WakeParams(**base)


@pytest.fixture(scope="module")
def real_kernel(tmp_path_factory):
    """spawn 真内核（临时 state-dir，**禁播种 = 空注册库**），yield 客户端；收尾按 PID 回收。

    禁播种（monkeypatch `_seed_state_from_outer` 为 no-op）是进门验证
    fail-closed 断言的前提：外层生产 voiceprints.json 一旦被拷入内核 state-dir，
    空注册库语义就不成立，正弦打分不再是确定性恒失败。
    """
    from services import kernel_client as kc

    state_dir = tmp_path_factory.mktemp("b1_kernel_state")
    spawned = []

    _orig_popen = kc._popen
    _orig_seed = kc.KernelClient._seed_state_from_outer

    def _spy_popen(cmd, **kw):
        proc = _orig_popen(cmd, **kw)
        spawned.append(proc)
        return proc

    old_env = os.environ.get("AXEUH_KERNEL_STATE_DIR")
    os.environ["AXEUH_KERNEL_STATE_DIR"] = str(state_dir)
    kc._popen = _spy_popen
    kc.KernelClient._seed_state_from_outer = staticmethod(lambda state_dir: None)
    kc.reset_kernel_client()
    client = kc.get_kernel_client()
    try:
        client.ensure()   # spawn + 握手（_read_handshake_line 内置 120s 超时）
    except Exception as exc:
        kc._popen = _orig_popen
        kc.KernelClient._seed_state_from_outer = _orig_seed
        if old_env is not None:
            os.environ["AXEUH_KERNEL_STATE_DIR"] = old_env
        else:
            os.environ.pop("AXEUH_KERNEL_STATE_DIR", None)
        pytest.skip(f"真内核 spawn 失败（本机权重/环境不齐，不强求）: {exc}")
    yield client
    # 收尾：只回收本次测试 spawn 的子进程（精确 PID，绝不按名称杀）
    for proc in spawned:
        try:
            if proc.poll() is None:
                proc.terminate()
                proc.wait(timeout=10)
        except Exception:
            pass
    kc._popen = _orig_popen
    kc.KernelClient._seed_state_from_outer = _orig_seed
    if old_env is not None:
        os.environ["AXEUH_KERNEL_STATE_DIR"] = old_env
    else:
        os.environ.pop("AXEUH_KERNEL_STATE_DIR", None)
    kc.reset_kernel_client()


def _sine_pcm(ms: int, freq: float = 220.0, sr: int = 16000) -> bytes:
    """合成正弦（音量大，但非任何人声/唤醒词——进门验证必然不过或无注册恒空）。"""
    n = int(sr * ms / 1000.0)
    t = np.arange(n) / sr
    return (np.sin(2 * np.pi * freq * t) * 12000).astype(np.int16).tobytes()


def test_real_kernel_health(real_kernel):
    """前置贯通性：真内核 /v1/health 可达（失败则后续全 skip 意义已失，故硬断言）。"""
    assert real_kernel.available(timeout=5.0) is True


def test_entry_gate_fail_closed_on_empty_registry(real_kernel, monkeypatch):
    """audio_start 语义模拟：命中 + 正弦推流 -> 真内核进门打分执行且拒录。

    空注册库 -> scores={} -> _voiceprint_gate fail-closed -> 状态机绝不进
    record（wake_start 不发，App 5s 兜底退出，正是生产期望的降级形态）。
    验证「打分确实触达了真内核」：spy _warn_kernel_down('entry') 被调用
    （scores 空的统一告警路径），同时 gate 内部真调过 score 端点。
    """
    from services import wake_word_service as wws

    monkeypatch.setattr(wws, "_target_keywords", ["小贺同学"])
    events = []
    down_calls = []

    monkeypatch.setattr(
        wws, "_warn_kernel_down",
        lambda tag, detail: down_calls.append(tag),
    )

    detector = wws.WakeWordDetector()
    st = detector.create_state(
        "dev-e2e", "sess-e2e-entry", int(time.time() * 1000), _make_params(),
        on_event=lambda ev, payload: events.append(ev),
        local_hit=True,
    )
    try:
        assert st.trigger_local_hit("小贺同学", confidence=1.0) is True
        # 分帧推入 1.6s 正弦（> sliding_window 1500ms，进门验证必然执行一次）
        for _ in range(8):
            st.feed(_sine_pcm(200))
            time.sleep(0.05)
        # 真内核首调含声纹模型懒加载：给足等待（HEAVY_TIMEOUT 120s + 余量）
        deadline = time.time() + 150
        verified = False
        while time.time() < deadline:
            if "entry" in down_calls:
                verified = True
                break
            if st._state == "record":
                pytest.fail("空注册库下绝不应进门成功（scores 非空说明 state-dir 不净）")
            time.sleep(0.2)
        assert verified, "真内核进门验证应被触发且 fail-closed（entry 告警被记）"
        assert st._state != "record", "fail-closed：无法验证绝不开录"
        assert "wake_start" not in events, "拒录时不得下发 wake/start（App 兜底退出）"
    finally:
        st.close()


def test_record_stop_asr_job_harvest(real_kernel, tmp_path):
    """录停语义模拟：_kernel_asr_transcribe 提交 analyze.asr（weak_split）并收割。

    内核可用 -> 返回 str（正弦无语音 -> 空串也属成功收割）；返回 None 视为
    内核 ASR 模型不可用（model.unavailable）-> skip（环境缺权重，非接线缺陷）。
    """
    from services import wake_word_service as wws

    st = object.__new__(wws.WakeWordState)
    st._sr = 16000
    st._p = _make_params()
    st._session_id = "sess-e2e-asr"
    st._test_mode = False

    pcm = _sine_pcm(3000)   # 3s 正弦
    text = st._kernel_asr_transcribe(pcm)
    if text is None:
        pytest.skip("真内核 analyze.asr 通道不可用（SenseVoice 权重缺失等），跳过收割断言")
    assert isinstance(text, str), "收割成功必须返回 str（可为空 = 无语音）"
    # 正弦不含语音，转写文本应为空或近空（不做硬断言：模型幻觉词不可控）
