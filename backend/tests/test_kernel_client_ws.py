# -*- coding: utf-8 -*-
"""T6 Step A: kernel_client WS 流辅助契约测试（aiohttp 打桩，不连真内核）。

锁定（方法签名与降级语义，改动即破坏 Step B 桥接）：
  - ``KernelClient.stream_ws_url()``: http->ws / https->wss 换 scheme +
    ``/v1/stream?token=...``（token 走 query，与内核端点自校验契约一致）
  - ``KernelClient.ws_connect_stream(*, timeout=0.5) ->
    Optional[KernelStreamWs]``: 惰性 ensure -> 本机回环建连（**不带 Origin**
    头，内核 check_origin 非空一律拒）-> 握手探测
  - 握手探测三分支：健康路径无首帧 -> ``("timeout", None)`` 视为就绪；
    鉴权失败 error 帧 -> ``None``（降级信号）并关闭句柄；传输错误 -> ``None``
  - ``KernelStreamWs.receive()`` 归一化 ``(kind, payload)`` 五态；
    ``close()`` 同时释放底层 WS 与 ClientSession（防会话泄漏）
  - 全程 fail-open 不抛（与 HTTP 面 KernelUnavailable 503 降级同哲学）
"""
import asyncio
from types import SimpleNamespace
from typing import Any, Dict

import aiohttp
import pytest

from services import kernel_client as kc


class _RawWs:
    """aiohttp ClientWebSocketResponse 桩：按队列出帧，空队列抛超时。"""

    def __init__(self, frames=()):
        self._frames = list(frames)
        self.closed = False

    async def receive(self, timeout=None):
        if not self._frames:
            raise asyncio.TimeoutError()
        return self._frames.pop(0)

    async def close(self, code=1000, message=b""):
        self.closed = True

    def exception(self):
        return None


class _FakeSession:
    """ClientSession 桩（KernelStreamWs.close 释放路径用）。"""

    def __init__(self):
        self.closed = False

    async def close(self):
        self.closed = True


def _text_frame(payload: Dict[str, Any]):
    import json

    return SimpleNamespace(
        type=aiohttp.WSMsgType.TEXT,
        data=json.dumps(payload, ensure_ascii=False),
    )


@pytest.fixture
def ws_capture(monkeypatch):
    """打桩 aiohttp.ClientSession.ws_connect：记录调用参数、注入出站帧。"""
    cap: Dict[str, Any] = {"calls": [], "frames": [], "error": None, "raw": None}

    async def _fake_ws_connect(self, url, **kwargs):
        cap["calls"].append({"url": url, "kwargs": dict(kwargs)})
        if cap["error"] is not None:
            raise cap["error"]
        raw = _RawWs(cap["frames"])
        cap["raw"] = raw
        return raw

    monkeypatch.setattr(aiohttp.ClientSession, "ws_connect", _fake_ws_connect)
    return cap


def _client(token: str = "tk1") -> kc.KernelClient:
    return kc.KernelClient(base_url="http://127.0.0.1:9", token=token)


# ============================================================
# 1) stream_ws_url: scheme 换算 + query token
# ============================================================

def test_stream_ws_url_http_maps_to_ws():
    assert _client().stream_ws_url() == (
        "ws://127.0.0.1:9/v1/stream?token=tk1"
    )


def test_stream_ws_url_https_maps_to_wss_and_quotes_token():
    c = kc.KernelClient(base_url="https://x.test/", token="a b/c")
    assert c.stream_ws_url() == "wss://x.test/v1/stream?token=a%20b%2Fc"


# ============================================================
# 2) ws_connect_stream: 健康路径（无首帧 -> timeout -> 就绪）
# ============================================================

def test_ws_connect_healthy_probe_returns_conn_without_origin(ws_capture):
    """健康路径：握手窗口静默 -> 就绪；URL 正确且不带 Origin 头。"""
    c = _client()
    conn = asyncio.run(c.ws_connect_stream(timeout=0.01))
    assert conn is not None, "健康路径必须返回可用句柄"
    assert not conn.closed

    call = ws_capture["calls"][0]
    assert call["url"] == "ws://127.0.0.1:9/v1/stream?token=tk1"
    headers = call["kwargs"].get("headers")
    # 显式空 headers 且绝不传 origin 参数（内核 check_origin 非空拒）
    assert headers is not None and dict(headers) == {}
    assert "origin" not in {str(k).lower() for k in (headers or {})}
    assert call["kwargs"].get("origin") is None

    # close 释放底层 WS + ClientSession
    asyncio.run(conn.close())
    assert ws_capture["raw"].closed is True


# ============================================================
# 3) ws_connect_stream: 握手 error 帧 -> None（降级信号）
# ============================================================

def test_ws_connect_handshake_error_frame_returns_none(ws_capture):
    """鉴权失败帧（accept 后立即回 error 再 close1008）-> None 且句柄已关。"""
    ws_capture["frames"] = [
        _text_frame({"error": {
            "code": "auth.failed",
            "message": "invalid stream token or origin",
            "retryable": False,
        }})
    ]
    c = _client()
    conn = asyncio.run(c.ws_connect_stream(timeout=0.5))
    assert conn is None, "握手 error 帧必须返回可用性 False（降级信号）"
    assert ws_capture["raw"].closed is True, "被拒连接必须关闭防泄漏"


def test_ws_connect_closed_kind_returns_none(ws_capture):
    """握手即半关（closed kind）-> None。"""
    ws_capture["frames"] = [
        SimpleNamespace(type=aiohttp.WSMsgType.CLOSED, data=1006)
    ]
    assert asyncio.run(_client().ws_connect_stream(timeout=0.5)) is None
    assert ws_capture["raw"].closed is True


# ============================================================
# 4) ws_connect_stream: 传输失败 / 缺凭证 -> None（fail-open）
# ============================================================

def test_ws_connect_transport_error_returns_none(ws_capture):
    """建连异常（连接拒绝等）-> None，不抛（降级）。"""
    ws_capture["error"] = OSError("connection refused")
    conn = asyncio.run(_client().ws_connect_stream(timeout=0.01))
    assert conn is None


def test_ws_connect_missing_token_skips_connect(ws_capture):
    """缺 token -> 直接 None，不触达网络。"""
    c = kc.KernelClient(base_url="http://127.0.0.1:9", token="")
    assert asyncio.run(c.ws_connect_stream(timeout=0.01)) is None
    assert ws_capture["calls"] == []


def test_ws_connect_ensures_when_not_connected(ws_capture):
    """未连接客户端先惰性 ensure（阻塞部分由调用方 to_thread），再建连。"""
    c = kc.KernelClient(token="tk2")  # 无 base_url -> 视为未连接
    calls = {"ensure": 0}

    def _fake_ensure():
        calls["ensure"] += 1
        c.base_url = "http://127.0.0.1:9"
        c._connected = True

    c.ensure = _fake_ensure
    conn = asyncio.run(c.ws_connect_stream(timeout=0.01))
    assert calls["ensure"] == 1
    assert conn is not None
    asyncio.run(conn.close())


# ============================================================
# 5) KernelStreamWs.receive 归一化五态 + close 双释放
# ============================================================

def test_receive_normalized_kinds_and_close_releases_both():
    raw = _RawWs([
        SimpleNamespace(type=aiohttp.WSMsgType.TEXT, data='{"a":1}'),
        SimpleNamespace(type=aiohttp.WSMsgType.BINARY, data=b"\x01\x02"),
        SimpleNamespace(type=aiohttp.WSMsgType.CLOSED, data=1000),
    ])
    sess = _FakeSession()
    ws = kc.KernelStreamWs(sess, raw)

    async def main():
        assert await ws.receive() == ("text", '{"a":1}')
        assert await ws.receive() == ("binary", b"\x01\x02")
        assert await ws.receive() == ("closed", None)
        # 空帧队列 -> 超时折叠（不抛）
        assert await ws.receive(timeout=0.01) == ("timeout", None)
        await ws.close()

    asyncio.run(main())
    assert raw.closed is True
    assert sess.closed is True, "close() 必须同时释放 ClientSession"


def test_receive_error_kind_from_transport_failure():
    class _BoomWs(_RawWs):
        async def receive(self, timeout=None):
            raise OSError("reset by peer")

    ws = kc.KernelStreamWs(_FakeSession(), _BoomWs())
    kind, data = asyncio.run(ws.receive())
    assert kind == "error"
    assert "reset by peer" in data


def test_scrub_token_never_logs_plaintext():
    """日志脱敏：token 明文被替换（禁把内核 token 写进日志）。"""
    c = _client(token="secret-token")
    assert "secret-token" not in c._scrub_token("fail secret-token boom")
    assert "***" in c._scrub_token("fail secret-token boom")
