# -*- coding: utf-8 -*-
"""B1 外层唤醒链路 local_hit 契约测试（monkeypatch，不依赖真模型/真 WS/真内核）。

契约核对结论（对照 K4b kernel/axeuh_kernel/stream/session.py + stream/kws.py）:
  - wakeup.hit 帧字段 {keyword, confidence} 与 trigger_local_hit(keyword,
    confidence) 一一对应，驱动**同一**状态机入口 detect -> verify -> record;
  - confidence 收进 [0,1]（kernel-design §4.7 分数约定）；内核 KWS 不暴露后验，
    确定命中恒 1.0（内核 kws.py 同约定）；
  - B1 起服务端**零本地 KWS**：detect 态只消费「待处理命中」（内核桥 / 端侧
    命中都经 trigger_local_hit 注入），start_state 两条路径都不加载任何本地模型;
  - keyword 与命中过滤同语义：必须命中运行时目标词表。
"""
import time

import pytest

from services import wake_word_service as wws


def _make_params(**over) -> wws.WakeParams:
    """手工构造 WakeParams（绕过 audio_config，测试零配置依赖）。

    B1：model_dir/chunk/keywords_score 等本地 KWS 字段已移除（KWS 在内核）。
    """
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
        weak_split={"enabled": False},
    )
    base.update(over)
    return wws.WakeParams(**base)


def _pcm(ms: int, sr: int = 16000) -> bytes:
    """生成 ms 毫秒静音 s16le PCM。"""
    return b"\x00\x00" * int(sr * ms / 1000)


def _wait_state(st, want: str, timeout: float = 2.0) -> bool:
    """轮询等待状态机进入目标态（worker 线程异步消费）。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if st._state == want:
            return True
        time.sleep(0.02)
    return st._state == want


@pytest.fixture
def target_keywords(monkeypatch):
    """固定运行时目标词表（隔离其他测试对模块级列表的改动）。"""
    monkeypatch.setattr(wws, "_target_keywords", ["小贺同学"])
    return ["小贺同学"]


@pytest.fixture
def state_factory(monkeypatch):
    """构造不依赖真模型的 local_hit 状态机；测试结束自动 close 所有状态。"""
    created = []

    def _make(local_hit: bool = True, **param_over):
        detector = wws.WakeWordDetector()
        # 进门验证打桩：绝不触碰真实声纹模型
        monkeypatch.setattr(
            wws.WakeWordState,
            "_voiceprint_gate",
            lambda self, audio: (True, "测试员", True, 0.9),
        )
        st = detector.create_state(
            "dev-test", "sess-k4c", 0, _make_params(**param_over),
            local_hit=local_hit,
        )
        created.append(st)
        return detector, st

    yield _make
    for st in created:
        st.close()


# ============================================================
# 1) wakeup.hit 字段驱动同一状态机入口（K4b 契约对齐）
# ============================================================

def test_wakeup_hit_frame_fields_drive_same_entry(
    state_factory, target_keywords,
):
    """K4b wakeup.hit {keyword, confidence} -> trigger_local_hit 同一入口。"""
    # 内核 /v1/stream 出站帧形状（session.py L155）
    wakeup_hit = {"type": "wakeup.hit", "keyword": "小贺同学", "confidence": 1.0}

    detector, st = state_factory(local_hit=True)
    ok = st.trigger_local_hit(
        wakeup_hit["keyword"], confidence=wakeup_hit["confidence"]
    )
    assert ok is True
    # B1：外层零本地 KWS——detector 不再持有任何模型/解码流
    assert not hasattr(detector, "ensure_spotter"), "WakeWordDetector 不应再有本地模型加载入口"

    st.feed(_pcm(100))
    assert _wait_state(st, "verify"), f"应进入 verify 态，实际 {st._state}"
    assert st._current_keyword == "小贺同学"
    assert st._hit_confidence == 1.0


def test_local_hit_without_confidence_defaults_none(
    state_factory, target_keywords,
):
    """confidence 可省略（App 现行 audio_start 不带该字段）。"""
    _, st = state_factory(local_hit=True)
    assert st.trigger_local_hit("小贺同学") is True
    assert st._pending_local_hit == ("小贺同学", None)


# ============================================================
# 2) confidence 收进 [0,1]（§4.7 分数约定）
# ============================================================

@pytest.mark.parametrize("raw,expected", [
    (1.5, 1.0),
    (-0.3, 0.0),
    (0.97, 0.97),
    ("abc", None),
    (None, None),
])
def test_confidence_clamped_to_unit_interval(
    state_factory, target_keywords, raw, expected,
):
    """超界收进 [0,1]，非数值降 None（仅观测字段，不影响触发）。"""
    _, st = state_factory(local_hit=True)
    assert st.trigger_local_hit("小贺同学", confidence=raw) is True
    assert st._pending_local_hit == ("小贺同学", expected)


# ============================================================
# 3) keyword 目标词表过滤（与内核命中路径同语义）
# ============================================================

def test_non_target_keyword_rejected(state_factory, target_keywords):
    """不在运行时目标词表的 keyword 拒绝登记（端侧旧词表不触发）。"""
    _, st = state_factory(local_hit=True)
    assert st.trigger_local_hit("紧急集合", confidence=1.0) is False
    assert st._pending_local_hit is None, "被拒登记不得占用 pending 槽位"

    # 无 pending 可消费：喂帧后状态机保持 detect
    st.feed(_pcm(100))
    time.sleep(0.3)
    assert st._state == "detect", "被拒登记不得驱动状态机"


def test_empty_keyword_falls_back_to_primary(state_factory, target_keywords):
    """keyword 缺省/空白 -> 主唤醒词（词表首项，恒在表内）。"""
    _, st = state_factory(local_hit=True)
    assert st.trigger_local_hit(None) is True
    assert st._pending_local_hit == ("小贺同学", None)
    # pending 未消费 -> 空白 keyword 的第二次登记被去重拒绝
    assert st.trigger_local_hit("   ") is False


# ============================================================
# 4) 重复登记去重 / 会话关闭拒绝
# ============================================================

def test_duplicate_pending_hit_deduped(state_factory, target_keywords):
    """已有未消费 pending 时重复登记返回 False（端侧抖动连击防护）。"""
    _, st = state_factory(local_hit=True)
    assert st.trigger_local_hit("小贺同学", confidence=1.0) is True
    assert st.trigger_local_hit("小贺同学", confidence=1.0) is False


def test_trigger_after_close_rejected(state_factory, target_keywords):
    """会话已关闭 -> False。"""
    _, st = state_factory(local_hit=True)
    st.close()
    assert st.trigger_local_hit("小贺同学") is False


# ============================================================
# 5) B1：服务端零本地 KWS（两条路径都不加载本地模型）
# ============================================================

def test_server_mode_never_decodes_local_kws(
    state_factory, target_keywords,
):
    """非 local_hit 且无 pending：帧停留 detect，B1 起服务端绝无任何本地 KWS 解码。"""
    detector, st = state_factory(local_hit=False)
    st.feed(_pcm(200))
    time.sleep(0.3)
    assert st._state == "detect"
    assert not hasattr(st, "_stream"), "WakeWordState 不应再持有本地解码流"
    assert not hasattr(detector, "spotter"), "WakeWordDetector 不应再持有本地 spotter"


def test_start_state_no_local_model_both_paths(monkeypatch, target_keywords):
    """start_state 两条路径（local_hit / 内核命中）都不加载本地模型，且触发预热。

    B1：ensure_spotter 已删除；start_state 只新建状态机 + 调度一次内核评分预热。
    """
    warm_calls = {"n": 0}
    fresh = []

    def _fake_warmup():
        warm_calls["n"] += 1

    def _fake_detector():
        d = wws.WakeWordDetector()
        fresh.append(d)
        return d

    monkeypatch.setattr(wws, "is_enabled", lambda: True)
    monkeypatch.setattr(wws, "_resolve_params", lambda: _make_params())
    monkeypatch.setattr(wws, "get_detector", _fake_detector)
    # 预热不得真发内核请求：打桩为计数（绝不 spawn 真内核）
    monkeypatch.setattr(wws, "_schedule_score_warmup", _fake_warmup)

    assert not hasattr(wws.WakeWordDetector, "ensure_spotter"), \
        "ensure_spotter 应已随 B1 删除"

    try:
        st_local = wws.start_state(
            "dev", "s-local", 0, None, False, local_hit=True,
        )
        assert st_local is not None, "local_hit 会话必须能启动（无本地模型要求）"
        assert warm_calls["n"] == 1, "start_state 应调度一次内核评分预热"
        st_local.close()

        st_server = wws.start_state(
            "dev", "s-server", 0, None, False, local_hit=False,
        )
        assert st_server is not None, "内核命中路径同样无需本地模型即可启动"
        assert warm_calls["n"] == 2, "两条路径都要预热内核评分（压低进门延迟）"
        st_server.close()
    finally:
        for d in fresh:
            for sid in list(d._states):
                d.remove_state(sid)


def test_local_hit_state_machine_full_flow(state_factory, target_keywords):
    """detect -> verify -> record 全迁移：进门验证通过后进入录制态。"""
    events = []

    detector, st = state_factory(local_hit=True)
    # 挂事件回调（wake_start 应在进门验证通过时触发）
    st._on_event = lambda ev, payload: events.append((ev, payload))

    assert st.trigger_local_hit("小贺同学", confidence=0.97) is True
    # 喂入超过验证窗口（sliding 1500ms）的音频 -> 立即/随后触发进门验证
    st.feed(_pcm(1600))
    assert _wait_state(st, "record"), f"应进入 record 态，实际 {st._state}"
    assert st._current_keyword == "小贺同学"
    assert st._hit_confidence == 0.97
    assert st._speaker_name == "测试员"
    assert any(ev == "wake_start" for ev, _ in events), "进门验证通过须发 wake_start"
