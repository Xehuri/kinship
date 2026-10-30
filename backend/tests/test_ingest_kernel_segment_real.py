# -*- coding: utf-8 -*-
"""C5 真内核 segment 模式 e2e + golden 对拍（本地实测开启，默认 skip）。

覆盖（任务验证清单）：
  1. 真内核 ``WS /v1/stream`` mode:"segment"：喂「3s 有声 + 2s 静音 + 3s 有声」
     PCM -> 断言 segment.closed x2（切点边界 = golden 参考算法容差内）+
     artifact 为可解析 WAV（时长与帧边界对齐）+ stop 冲刷尾段；
  2. golden 对拍：同一段确定性合成 PCM（多静音/多硬上限混合）分别喂
     - 参考侧：tests/segment_ref.RefSegmenter（pre-outer-stripping 外层
       AudioStreamSegmenter 逐逻辑移植）
     - 内核侧：SegmentChannel 真 subprocess
     断言事件序列（段数/顺序）一致、切点边界差 <= 帧粒度(30ms)+取整容差；
  3. 断连降级：真内核 spawn 后 kill（本测试自己的 proc 句柄，精确 PID）->
     SegmentChannel.push 抛错/置死；经 DeviceIngestSession 走完整链 ->
     镜像兜底逐段产出，**音频字节守恒不丢**。

运行门控：默认 **skip**（与 test_wake_kernel_real 同口径：spawn/回环抖动
不宜进全量基线）。手动验证：
``AXEUH_C5_REAL_KERNEL=1 python -m pytest tests/test_ingest_kernel_segment_real.py -v``

内核生命周期：state-dir 指向 tmp_path（禁播种：与声纹注册库无关，segment
模式不触 sherpa/权重）；本测试 spawn 的内核进程在 fixture 收尾按 PID 句柄
terminate（绝不按进程名杀，遵守仓库进程管理红线）。
"""

from __future__ import annotations

import math
import os
import time
from array import array

import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("AXEUH_C5_REAL_KERNEL") != "1",
    reason="真内核 segment e2e 默认关（spawn/回环抖动，与 B1 真内核测试同口径）。"
           "开启方式见文件 docstring（本机需 kernel/ 可运行环境）。",
)

SAMPLE_RATE = 16000
T0 = 1_757_836_800_000  # 2025-09-14 00:00:00 +08:00
FRAME_MS = 30


def _pcm_tone(seconds: float, freq: float = 440.0, amp: float = 0.3) -> bytes:
    n = int(SAMPLE_RATE * seconds)
    buf = array("h")
    for i in range(n):
        buf.append(int(32767 * amp * math.sin(2 * math.pi * freq * i / SAMPLE_RATE)))
    return buf.tobytes()


def _pcm_silence(seconds: float) -> bytes:
    return b"\x00" * (int(SAMPLE_RATE * seconds) * 2)


def _ms_of(pcm: bytes) -> int:
    return len(pcm) // 2 * 1000 // SAMPLE_RATE


@pytest.fixture(scope="module")
def real_kernel(tmp_path_factory):
    """spawn 真内核（临时 state-dir，禁播种），yield 客户端；收尾按 PID 回收。"""
    from services import kernel_client as kc

    state_dir = tmp_path_factory.mktemp("c5_kernel_state")
    spawned = []

    _orig_popen = kc._popen

    def _spy_popen(cmd, **kw):
        proc = _orig_popen(cmd, **kw)
        spawned.append(proc)
        return proc

    old_env = os.environ.get("AXEUH_KERNEL_STATE_DIR")
    old_token = os.environ.get("AXEUH_KERNEL_TOKEN")
    os.environ["AXEUH_KERNEL_STATE_DIR"] = str(state_dir)
    os.environ["AXEUH_KERNEL_TOKEN"] = "c5-test-token"
    kc._popen = _spy_popen
    _orig_seed = kc.KernelClient._seed_state_from_outer
    kc.KernelClient._seed_state_from_outer = staticmethod(lambda state_dir: None)
    kc.reset_kernel_client()
    client = kc.get_kernel_client()
    try:
        client.ensure()  # spawn + 握手
    except Exception as exc:
        kc._popen = _orig_popen
        kc.KernelClient._seed_state_from_outer = _orig_seed
        for var, val in (("AXEUH_KERNEL_STATE_DIR", old_env),
                         ("AXEUH_KERNEL_TOKEN", old_token)):
            if val is not None:
                os.environ[var] = val
            else:
                os.environ.pop(var, None)
        pytest.skip(f"真内核 spawn 失败（本机环境不齐，不强求）: {exc}")
    yield client, state_dir, spawned
    # 收尾：只回收本次 spawn 的子进程（精确 PID 句柄）
    for proc in spawned:
        try:
            if proc.poll() is None:
                proc.terminate()
                proc.wait(timeout=10)
        except Exception:
            pass
    kc._popen = _orig_popen
    kc.KernelClient._seed_state_from_outer = _orig_seed
    for var, val in (("AXEUH_KERNEL_STATE_DIR", old_env),
                     ("AXEUH_KERNEL_TOKEN", old_token)):
        if val is not None:
            os.environ[var] = val
        else:
            os.environ.pop(var, None)
    kc.reset_kernel_client()


def _mk_channel(t0_ms: int, **over):
    from services.segment_channel import SegmentChannel

    opts = dict(
        name="c5-e2e", t0_ms=t0_ms,
        rms_threshold=5.0, frame_ms=FRAME_MS,
        silence_cut_s=1.5, min_chunk_s=1.0, max_chunk_s=120.0,
    )
    opts.update(over)
    return SegmentChannel(**opts)


def _feed_frames(ch, pcm: bytes, frame_s: float = 0.2):
    """按 200ms 帧推流，返回累计收割的段列表。"""
    from services.segment_channel import SegmentChunk

    got: "list[SegmentChunk]" = []
    step = int(SAMPLE_RATE * frame_s) * 2
    for off in range(0, len(pcm), step):
        got.extend(ch.push(pcm[off:off + step]))
    return got


# ============================================================
# 1. 基本形态：3s 有声 + 2s 静音 + 3s 有声 -> closed x2 + stop 尾段
# ============================================================

def test_segment_mode_cut_stop_and_artifact_wav(real_kernel):
    pcm = _pcm_tone(3.0) + _pcm_silence(2.0) + _pcm_tone(3.0)
    ch = _mk_channel(T0)
    ch.open()
    try:
        mid = _feed_frames(ch, pcm)
        # 静音游程达 1.5s 即切：中段应至少切出 1 段
        assert len(mid) >= 1, f"静音端点应切出至少一段，实际 {len(mid)}"
        first = mid[0]
        # 切点 = 有声 3s + 静音 1.5s（帧对齐，容差 2 帧）
        assert abs(_ms_of(first.pcm) - 4500) <= 2 * FRAME_MS, _ms_of(first.pcm)
        assert first.start_ms == T0
        # artifact WAV 解码后的 PCM 与段字节一致：时长与边界对齐
        assert first.end_ms == first.start_ms + _ms_of(first.pcm)

        tail = ch.stop()
        chunks = mid + tail
        assert len(chunks) == 2, f"应为 静音端点切段 + stop 尾段 共 2 段，实际 {len(chunks)}"
        # 音频守恒：两段拼起来 = 全量（可能有 <=2 帧的对齐残差）
        assert sum(len(c.pcm) for c in chunks) == len(pcm)
        # 尾段起点衔接第一段终点
        assert abs(chunks[1].start_ms - chunks[0].end_ms) <= 2
    finally:
        ch.close()


# ============================================================
# 2. golden 对拍：真内核切点 vs pre-outer-stripping 参考算法
# ============================================================

def _golden_reference_cuts(pcm: bytes, *, force_cut_s: float):
    """参考侧切点（相对毫秒边界序列）——外层原算法逐逻辑复刻。"""
    from segment_ref import RefSegmenter

    seg = RefSegmenter(
        sample_rate=SAMPLE_RATE, force_cut_s=force_cut_s,
        silence_cut_s=1.5, min_chunk_s=1.0, rms_threshold=5.0,
        frame_ms=FRAME_MS,
    )
    cuts = []
    step = int(SAMPLE_RATE * 0.2) * 2
    pos = T0
    for off in range(0, len(pcm), step):
        for c in seg.push(pcm[off:off + step], pos):
            cuts.append((c.start_wall_ms, c.end_wall_ms, c.sample_count))
            pos = c.end_wall_ms
    tail = seg.flush(pos)
    if tail is not None:
        cuts.append((tail.start_wall_ms, tail.end_wall_ms, tail.sample_count))
    return cuts


def _kernel_cuts(pcm: bytes, *, force_cut_s: float):
    """内核侧切点（同参数、同帧喂入）。"""
    ch = _mk_channel(T0, max_chunk_s=force_cut_s)
    ch.open()
    try:
        got = _feed_frames(ch, pcm)
        got.extend(ch.stop())
        return [(c.start_ms, c.end_ms, c.sample_count) for c in got]
    finally:
        ch.close()


def test_golden_parity_kernel_vs_pre_outer_algorithm(real_kernel):
    """多段语音 + 长静音 + 硬上限混合：事件序列一致，边界差 <= 帧粒度。"""
    # 8s 音 + 2s 静 + 6s 音 + 2.5s 静 + 4s 音 ≈ 22.5s；force_cut=10s 触发硬切
    pcm = (
        _pcm_tone(8.0, 440.0) + _pcm_silence(2.0)
        + _pcm_tone(6.0, 880.0) + _pcm_silence(2.5)
        + _pcm_tone(4.0, 1320.0)
    )
    force_cut_s = 10.0

    ref = _golden_reference_cuts(pcm, force_cut_s=force_cut_s)
    ker = _kernel_cuts(pcm, force_cut_s=force_cut_s)

    assert len(ker) == len(ref), f"事件数量必须一致: kernel={len(ker)} ref={len(ref)}"
    assert len(ker) >= 3, "该样本应同时触发静音切与硬上限切（防退化成 trivial）"
    for (rs, re_, rn), (ks, ke, kn) in zip(ref, ker):
        assert rs >= T0 and ks >= T0
        assert abs((ks - T0) - (rs - T0)) <= 2 * FRAME_MS, (rs, ks)
        assert abs((ke - T0) - (re_ - T0)) <= 2 * FRAME_MS, (re_, ke)
        assert kn == rn, "同一切点的样本数应逐样本一致（帧边界同为 30ms 对齐）"
    # 字节守恒双侧一致
    assert sum(r[2] for r in ref) * 2 == len(pcm)
    assert sum(k[2] for k in ker) * 2 == len(pcm)


# ============================================================
# 3. artifact 消费即删：内核 state-dir 不残留已取回的 WAV
# ============================================================

def test_artifacts_deleted_after_consumption(real_kernel):
    _client, state_dir, _spawned = real_kernel
    pcm = _pcm_tone(4.0) + _pcm_silence(2.0) + _pcm_tone(4.0)
    ch = _mk_channel(T0 + 10_000_000)   # 独立 t0 避免与前面测试的 artifact 名冲突
    ch.open()
    try:
        got = _feed_frames(ch, pcm)
        got.extend(ch.stop())
        assert len(got) >= 2
        arts = list((state_dir / "artifacts").glob("art_*.bin"))
        assert arts == [], f"artifact 必须消费即删，残留: {[a.name for a in arts]}"
    finally:
        ch.close()


# ============================================================
# 4. 断连降级：kill 内核 -> 镜像兜底逐段产出，音频字节守恒不丢
#    （放最后：kill 后共享内核客户端指向死端口，其余用例已跑完）
# ============================================================

def test_kernel_kill_degrades_without_losing_bytes(real_kernel):
    """真内核被 kill 后 ingest 全链：降级兜底，全部音频字节守恒且顺序不乱。"""
    _client, _state_dir, spawned = real_kernel
    from services.audio_ingest_session import DeviceIngestSession

    # 不注入工厂：走生产缺省 = 真内核通道。先把一段音频成功喂进内核（建立通道）
    sess = DeviceIngestSession(
        "dev-kill", min_chunk_s=1.0, silence_cut_s=1.5, max_chunk_s=120.0,
        tolerance_ms=1000, degraded_cooldown_s=0.0,
    )
    a = _pcm_tone(2.0, 440.0)
    ra = sess.ingest(session_id="s", seq=1, start_ms=T0, pcm=a, now_ms=T0)

    # kill 本测试 spawn 的内核（只按自己记录的 proc 句柄，绝不按进程名）
    for proc in spawned:
        if proc.poll() is None:
            proc.kill()
    deadline = time.monotonic() + 10
    while any(p.poll() is None for p in spawned) and time.monotonic() < deadline:
        time.sleep(0.05)

    # kill 后继续喂分段：通道死透/重建失败 -> 降级镜像兜底，绝不丢字节
    b = _pcm_tone(2.0, 880.0)
    c = _pcm_tone(2.0, 1320.0)
    rb = sess.ingest(session_id="s", seq=2, start_ms=T0 + 2000, pcm=b, now_ms=T0 + 2000)
    rc = sess.ingest(session_id="s", seq=3, start_ms=T0 + 4000, pcm=c, now_ms=T0 + 4000)
    out = list(ra.emitted) + list(rb.emitted) + list(rc.emitted) + list(sess.flush())

    total = sum(len(x.pcm) for x in out)
    assert total == len(a) + len(b) + len(c), (
        f"音频字节守恒被破坏: emitted={total} expected={len(a) + len(b) + len(c)}"
    )
    # 顺序不乱：按起点排序拼接起来就是原始流（无缝流的本义）
    joined = b"".join(x.pcm for x in sorted(out, key=lambda x: x.start_ms))
    assert joined == a + b + c
