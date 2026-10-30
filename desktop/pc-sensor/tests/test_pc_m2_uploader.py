# -*- coding: utf-8 -*-
"""PC-M2：上传失败不丢批，整批放回队首，且队列长度有上限。"""

import json
import ssl
import time
from urllib.error import URLError

import pytest

from pc_sensor.uploader import Uploader


class _FakeSelector:
    """最小端点选择器替身：记录强制重选次数并固定返回一个地址。"""

    def __init__(self, url: str):
        self.url = url
        self.has_candidates = True
        self.force_calls = 0
        self.ssl_context = ssl.create_default_context()

    @property
    def current_url(self) -> str:
        return self.url

    def select(self, force: bool = False) -> str:
        if force:
            self.force_calls += 1
        return self.url


class _FakeResponse:
    def __init__(self, status: int = 200, payload: dict | None = None):
        self.status = status
        self._payload = json.dumps(payload or {}).encode("utf-8")

    def read(self) -> bytes:
        return self._payload

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def _make_uploader(monkeypatch) -> Uploader:
    """构造 Uploader，绕过 __init__ 中的真实登录网络调用。"""
    monkeypatch.setattr(Uploader, "_login", lambda self: True)
    up = Uploader("https://example.invalid", "u", "p", "agent")
    up._token = "tok"
    up._token_expiry = time.monotonic() + 3600
    return up


def test_flush_failure_requeues_batch_at_head(monkeypatch):
    up = _make_uploader(monkeypatch)
    for i in range(3):
        up.enqueue({"i": i})

    up._send_batch = lambda batch: False  # 模拟发送失败
    up.flush()

    with up._lock:
        assert [e["i"] for e in up._buffer] == [0, 1, 2]
    assert up.buffer_size == 3


def test_flush_success_clears_queue(monkeypatch):
    up = _make_uploader(monkeypatch)
    up.enqueue({"i": 1})
    up._send_batch = lambda batch: True
    up.flush()
    assert up.buffer_size == 0


def test_flush_failure_caps_buffer_size(monkeypatch):
    up = _make_uploader(monkeypatch)
    cap = Uploader.MAX_BUFFER
    total = cap + 50
    for i in range(total):
        up.enqueue({"i": i})

    up._send_batch = lambda batch: False
    up.flush()

    assert up.buffer_size == cap
    with up._lock:
        # 丢弃最旧的 50 条，保留最新 cap 条
        assert up._buffer[0]["i"] == 50
        assert up._buffer[-1]["i"] == total - 1


def test_no_token_keeps_batch(monkeypatch):
    """无有效 token 时数据保留在队列等待重试，而非丢弃。"""
    up = _make_uploader(monkeypatch)
    up._token = None
    up._token_expiry = 0
    up.enqueue({"i": 1})
    assert up.flush() is None
    assert up.buffer_size == 1


def test_auth_token_snapshot_without_token(monkeypatch):
    up = _make_uploader(monkeypatch)
    up._token = None
    up._token_expiry = 0

    assert up.auth_token_snapshot() == {"token": "", "expires_in": 0}


def test_auth_token_snapshot_static_token_has_no_expiry(monkeypatch):
    up = _make_uploader(monkeypatch)
    up._token = "static-backend-token"
    up._token_expiry = float("inf")

    assert up.auth_token_snapshot() == {
        "token": "static-backend-token",
        "expires_in": None,
    }


def test_auth_token_snapshot_expiring_token_reports_remaining_seconds(monkeypatch):
    up = _make_uploader(monkeypatch)
    up._token = "login-backend-token"
    up._token_expiry = time.monotonic() + 120

    snapshot = up.auth_token_snapshot()

    assert snapshot["token"] == "login-backend-token"
    assert isinstance(snapshot["expires_in"], int)
    assert 0 < snapshot["expires_in"] <= 120


def test_auth_token_snapshot_expired_token_reports_zero(monkeypatch):
    up = _make_uploader(monkeypatch)
    up._token = "expired-backend-token"
    up._token_expiry = time.monotonic() - 5

    assert up.auth_token_snapshot() == {
        "token": "expired-backend-token",
        "expires_in": 0,
    }


def test_http_4xx_drops_poison_batch(monkeypatch):
    """4xx 视为数据问题，丢弃避免毒丸阻塞（_send_batch 返回 True）。"""
    from email.message import Message
    from urllib.error import HTTPError

    up = _make_uploader(monkeypatch)

    def raise_400(req, timeout=None, context=None):
        raise HTTPError(req.full_url, 400, "Bad Request", Message(), None)

    monkeypatch.setattr("pc_sensor.uploader.urlopen", raise_400)
    assert up._send_batch([{"i": 1}]) is True


def test_http_5xx_retries_batch(monkeypatch):
    from email.message import Message
    from urllib.error import HTTPError

    up = _make_uploader(monkeypatch)

    def raise_500(req, timeout=None, context=None):
        raise HTTPError(req.full_url, 500, "Server Error", Message(), None)

    monkeypatch.setattr("pc_sensor.uploader.urlopen", raise_500)
    assert up._send_batch([{"i": 1}]) is False


def test_uploader_uses_selected_endpoint(monkeypatch):
    selector = _FakeSelector("https://home.example:23443")
    up = Uploader(
        "https://frp.example:8768", "", "", "agent",
        auth_token="tok", transport=selector,
    )
    seen: list[str] = []

    def fake_urlopen(req, timeout=None, context=None):
        seen.append(req.full_url)
        return _FakeResponse(200)

    monkeypatch.setattr("pc_sensor.uploader.urlopen", fake_urlopen)
    assert up._send_batch([{"i": 1}]) is True
    assert seen == ["https://home.example:23443/api/pc/sync"]
    assert up.current_endpoint == "https://home.example:23443"


def test_upload_failure_reselects_and_retries_once(monkeypatch):
    selector = _FakeSelector("https://home.example:23443")
    up = Uploader(
        "https://frp.example:8768", "", "", "agent",
        auth_token="tok", transport=selector,
    )
    calls: list[str] = []

    def fake_urlopen(req, timeout=None, context=None):
        calls.append(req.full_url)
        if len(calls) == 1:
            raise URLError("endpoint down")
        return _FakeResponse(200)

    monkeypatch.setattr("pc_sensor.uploader.urlopen", fake_urlopen)
    assert up._send_batch([{"i": 1}]) is True
    assert len(calls) == 2
    assert selector.force_calls == 1


def test_login_failure_reselects_and_retries_once(monkeypatch):
    selector = _FakeSelector("https://home.example:23443")
    login_calls: list[str] = []

    def fake_urlopen(req, timeout=None, context=None):
        login_calls.append(req.full_url)
        if len(login_calls) == 1:
            raise URLError("login endpoint down")
        return _FakeResponse(200, {"success": True, "token": "fresh-token"})

    monkeypatch.setattr("pc_sensor.uploader.urlopen", fake_urlopen)
    up = Uploader(
        "https://frp.example:8768", "u", "p", "agent",
        transport=selector,
    )

    assert up.has_token is True
    assert up._token == "fresh-token"
    assert selector.force_calls == 1


def test_without_selector_keeps_server_url_behavior(monkeypatch):
    up = Uploader(
        "https://legacy.example:8768/", "", "", "agent",
        auth_token="tok",
    )
    seen: list[str] = []

    def fake_urlopen(req, timeout=None, context=None):
        seen.append(req.full_url)
        return _FakeResponse(200)

    monkeypatch.setattr("pc_sensor.uploader.urlopen", fake_urlopen)
    assert up._send_batch([{"i": 1}]) is True
    assert seen == ["https://legacy.example:8768/api/pc/sync"]
    assert up.current_endpoint == "https://legacy.example:8768"
