# -*- coding: utf-8 -*-
"""T6 Step B: /ws/audio-stream <-> 内核 /v1/stream 桥接契约测试。

参照 kernel/tests/test_stream_ws.py 帧断言风格 + fake 内核 WS（mock 注入，
不 spawn 真内核、不依赖真 KWS 模型）。覆盖：

  - 正常路径: audio_start 建内核桥并锁 session.start 帧形状
    （device_id + sample_rate=16000）；内核 wakeup.hit ->
    wake_state.trigger_local_hit(keyword, confidence) 被调（K4c 同一入口）
  - 转发路径: 手机 PCM 二进制转发内核，且本地 wake_state.feed 并行保留
  - 降级路径: 内核不可达（ws_connect_stream -> None）-> 本地 feed 仍工作，
    手机协议帧形状不变（fail-open 不阻断）
  - 内核 error 降级码（model.unavailable 等）-> 关连接回本地，后续帧不再
    转发而本地照跑
  - session.stop 于 audio_stop 与断线 finally 各发一次且连接关闭（防泄漏）
  - 手机出站帧形状不变: connected / pong / audio_stopped / error（协议零变化）

手机 token 与内核 token 严禁混用：本测试分别注入（手机走 ?token= 登录票据，
内核走 _FakeKernelClient，两者无交集）。
"""
import json
import time
from typing import Any, Dict

import pytest

from services import kernel_client as kc
from services import wake_word_service as wws

# 16k s16le 一帧：1600 样本 = 100ms（与 kernel test_stream_ws 同一口径）
FRAME_100MS = b"\x01\x00" * 1600


# ─── 注入替身（不依赖真内核/真模型） ────────────────────────


class _FakeKernelWs:
    """KernelStreamWs 鸭子替身：记录出站帧，可从测试线程注入入站帧。

    receive() 首次在端点事件循环中调用时记录 loop；push 跨线程经
    call_soon_threadsafe 唤醒（TestClient portal 线程与测试线程分离）。
    """

    def __init__(self) -> None:
        self.sent_json = []
        self.sent_bytes = []
        self.closed = False
        self._inbound = []
        self._loop = None
        self._wake = None

    def push(self, kind: str, data) -> None:
        """注入一帧内核出站（测试线程调用，线程安全唤醒读循环）。"""
        def _put() -> None:
            self._inbound.append((kind, data))
            if self._wake is not None:
                self._wake.set()

        if self._loop is not None:
            self._loop.call_soon_threadsafe(_put)
        else:
            _put()  # 读循环尚未启动，先入队

    async def receive(self, timeout=None):
        import asyncio

        if self._loop is None or self._wake is None:
            self._loop = asyncio.get_running_loop()
            self._wake = asyncio.Event()
        wake = self._wake
        while not self._inbound:
            wake.clear()
            try:
                await asyncio.wait_for(wake.wait(), timeout=timeout)
            except (asyncio.TimeoutError, TimeoutError):
                return ("timeout", None)
        return self._inbound.pop(0)

    async def send_json(self, payload) -> None:
        if self.closed:
            raise RuntimeError("connection closed")
        self.sent_json.append(payload)

    async def send_bytes(self, data: bytes) -> None:
        if self.closed:
            raise RuntimeError("connection closed")
        self.sent_bytes.append(bytes(data))

    async def close(self) -> None:
        self.closed = True


class _FakeKernelClient:
    """KernelClient.ws_connect_stream 鸭子替身（None = 内核不可达）。"""

    def __init__(self, conn) -> None:
        self.conn = conn
        self.connect_calls = 0

    async def ws_connect_stream(self, *, timeout: float = 0.5):
        self.connect_calls += 1
        return self.conn


class _FakeWakeState:
    """WakeWordState 鸭子替身：记录 feed / trigger_local_hit / close。"""

    def __init__(self) -> None:
        self.fed = []
        self.hits = []
        self.closed = False

    def feed(self, pcm: bytes) -> None:
        self.fed.append(bytes(pcm))

    def trigger_local_hit(self, keyword=None, confidence=None) -> bool:
        self.hits.append((keyword, confidence))
        return True

    def close(self) -> None:
        self.closed = True


# ─── fixtures ───────────────────────────────────────────────


@pytest.fixture
def wake_spy(monkeypatch):
    """打桩 wake_word_service.start_state -> _FakeWakeState（零模型依赖）。"""
    created = []

    def _start_state(
        device_id, session_id, start_wall_ms,
        on_event=None, test_mode=False, local_hit=False,
    ):
        st = _FakeWakeState()
        created.append(st)
        return st

    monkeypatch.setattr(wws, "start_state", _start_state)
    return created


@pytest.fixture
def kernel_stub(monkeypatch):
    """安装假内核客户端；kernel_stub(conn) -> _FakeKernelClient。"""

    def _install(conn):
        client = _FakeKernelClient(conn)
        monkeypatch.setattr(kc, "get_kernel_client", lambda: client)
        return client

    return _install


def _connect(client, auth_headers):
    """手机侧 WS 连接（手机 token 走 query，与内核 token 无交集）。"""
    token = auth_headers["Authorization"].split(" ", 1)[1]
    return client.websocket_connect("/ws/audio-stream?token=%s" % token)


def _recv(ws) -> Dict[str, Any]:
    return json.loads(ws.receive_text())


def _wait_until(pred, timeout: float = 3.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if pred():
            return True
        time.sleep(0.02)
    return pred()


def _hello_start(ws, device_id: str = "dev1") -> None:
    """hello -> connected -> audio_start（含 ping 屏障，保证桥已建立）。"""
    ws.send_json({"type": "hello", "device_id": device_id,
                  "sample_rate": 16000, "channels": 1})
    msg = _recv(ws)
    assert msg["type"] == "connected"
    ws.send_json({"type": "audio_start", "session_id": "s1",
                  "start_wall_ms": 1758000000000})
    ws.send_json({"type": "ping"})
    # 端点单循环顺序处理：收到 pong 即 audio_start（含桥建连）已全部完成
    assert _recv(ws) == {"type": "pong"}


@pytest.fixture(autouse=True)
def _session_segment_local_ref(monkeypatch):
    """C5：AudioStreamSession 的切分通道一律注入本地仿真（RefSegmentChannel）。

    本文件锁的是 **wake 桥**（_KernelStreamBridge）与手机协议；若放任会话按
    缺省工厂去连 get_kernel_client，会与被 patch 成 fake 的内核客户端串扰
    （桥与会话抢用同一条 fake WS）。仿真通道纯内存、零网络、零内核。
    """
    import services.audio_stream_session as ass
    from segment_ref import make_channel_factory

    monkeypatch.setattr(ass, "_default_channel_factory", make_channel_factory())


# ============================================================
# 1) 正常路径: session.start 锁形状 + wakeup.hit 驱动同一状态机入口
# ============================================================

def test_kernel_hit_triggers_local_hit(
    client, auth_headers, wake_spy, kernel_stub
):
    """wakeup.hit {keyword,confidence} -> trigger_local_hit 被调（K4c 入口）。"""
    conn = _FakeKernelWs()
    kernel_stub(conn)

    with _connect(client, auth_headers) as ws:
        _hello_start(ws, device_id="dev1")
        st = wake_spy[-1]

        # 内核 session.start 帧形状锁定（v1 仅 16000，契约不可改）
        assert conn.sent_json[0] == {
            "type": "session.start",
            "device_id": "dev1",
            "sample_rate": 16000,
        }

        # 注入内核 wakeup.hit -> 同一状态机入口被驱动
        conn.push("text", json.dumps(
            {"type": "wakeup.hit", "keyword": "小贺同学", "confidence": 0.93},
            ensure_ascii=False,
        ))
        assert _wait_until(lambda: st.hits == [("小贺同学", 0.93)]), st.hits

        # 二进制：转发内核 + 本地 feed 并行保留（降级无缝）
        ws.send_bytes(FRAME_100MS)
        ws.send_json({"type": "ping"})
        assert _recv(ws) == {"type": "pong"}
        assert conn.sent_bytes == [FRAME_100MS]
        assert st.fed == [FRAME_100MS]

        # audio_stop -> 出站形状不变 + 内核 session.stop + 连接关闭
        ws.send_json({"type": "audio_stop"})
        assert _recv(ws) == {"type": "audio_stopped"}
        assert {"type": "session.stop"} in conn.sent_json
        assert conn.closed is True


# ============================================================
# 2) 降级路径: 内核不可达 -> 本地 feed 仍工作（fail-open）
# ============================================================

def test_kernel_unavailable_local_feed_still_works(
    client, auth_headers, wake_spy, kernel_stub
):
    """ws_connect_stream -> None：回退本地，本地 feed 照跑、协议帧不变。"""
    stub = kernel_stub(None)  # 内核不可达

    with _connect(client, auth_headers) as ws:
        _hello_start(ws)
        assert stub.connect_calls == 1, "audio_start 必须尝试建内核桥"
        st = wake_spy[-1]

        ws.send_bytes(FRAME_100MS)
        ws.send_json({"type": "ping"})
        assert _recv(ws) == {"type": "pong"}
        # 本地路径完全不受降级影响（现行为）
        assert st.fed == [FRAME_100MS]

        ws.send_json({"type": "audio_stop"})
        assert _recv(ws) == {"type": "audio_stopped"}


# ============================================================
# 3) 断线 finally: session.stop + 关连接 + 释放唤醒态（防泄漏）
# ============================================================

def test_session_stop_and_close_on_disconnect(
    client, auth_headers, wake_spy, kernel_stub
):
    """未 audio_stop 直接断线：finally 发 session.stop 并关内核连接。"""
    conn = _FakeKernelWs()
    kernel_stub(conn)

    with _connect(client, auth_headers) as ws:
        _hello_start(ws)

    # 退出上下文 -> disconnect -> 端点 finally（portal 异步完成，轮询断言）
    assert _wait_until(lambda: {"type": "session.stop"} in conn.sent_json), \
        conn.sent_json
    assert _wait_until(lambda: conn.closed is True)
    assert _wait_until(lambda: wake_spy[-1].closed is True)


# ============================================================
# 4) 内核 error 降级码 -> 关连接回本地，转发停止而本地照跑
# ============================================================

def test_kernel_error_frame_degrades_to_local(
    client, auth_headers, wake_spy, kernel_stub
):
    """model.unavailable -> 关内核连接；后续帧只走本地 feed。"""
    conn = _FakeKernelWs()
    kernel_stub(conn)

    with _connect(client, auth_headers) as ws:
        _hello_start(ws)
        st = wake_spy[-1]

        # 注入内核 error 帧（与 error_envelope 形状一致：顶层只有 error）
        conn.push("text", json.dumps({"error": {
            "code": "model.unavailable",
            "message": "KWS 模型不可用",
            "retryable": True,
        }}, ensure_ascii=False))
        assert _wait_until(lambda: conn.closed is True), "降级码必须关连接"

        # 后续二进制：不再转发内核，本地 feed 仍工作
        ws.send_bytes(FRAME_100MS)
        ws.send_json({"type": "ping"})
        assert _recv(ws) == {"type": "pong"}
        assert conn.sent_bytes == []
        assert st.fed == [FRAME_100MS]


# ============================================================
# 5) 手机出站帧形状不变（协议零变化）
# ============================================================

def test_phone_outbound_frame_shapes_unchanged(
    client, auth_headers, wake_spy, kernel_stub
):
    """connected/pong/audio_stopped/error 全部保持既有形状。"""
    kernel_stub(None)

    with _connect(client, auth_headers) as ws:
        # hello -> connected: 两键形状
        ws.send_json({"type": "hello", "device_id": "d",
                      "sample_rate": 16000, "channels": 1})
        msg = _recv(ws)
        assert set(msg.keys()) == {"type", "session_id"}
        assert msg["type"] == "connected"
        assert isinstance(msg["session_id"], str) and msg["session_id"]

        # 未 start 的二进制 -> error（既有文案）
        ws.send_bytes(b"\x00\x00")
        msg = _recv(ws)
        assert msg["type"] == "error"
        assert "尚未 audio_start" in msg["message"]

        # 坏 JSON -> error
        ws.send_text("{bad")
        msg = _recv(ws)
        assert msg["type"] == "error"
        assert "无效的 JSON" in msg["message"]

        # 未知类型 -> error
        ws.send_json({"type": "nope"})
        msg = _recv(ws)
        assert msg["type"] == "error"
        assert "未知消息类型" in msg["message"]

        # audio_start 缺 start_wall_ms -> error（既有校验不变）
        ws.send_json({"type": "audio_start", "session_id": "sx"})
        msg = _recv(ws)
        assert msg["type"] == "error"
        assert "start_wall_ms" in msg["message"]

        # ping -> pong 精确单键
        ws.send_json({"type": "ping"})
        assert _recv(ws) == {"type": "pong"}

        # audio_start -> audio_stop -> audio_stopped 精确单键
        ws.send_json({"type": "audio_start", "session_id": "s2",
                      "start_wall_ms": 1758000001000})
        ws.send_json({"type": "audio_stop"})
        assert _recv(ws) == {"type": "audio_stopped"}
