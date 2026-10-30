# -*- coding: utf-8 -*-
"""OpenCode loopback HTTP Basic 认证单测（K5）。

覆盖三面（全部 fail-open：未配置 server_password 的老部署零改动照常工作）：
  1. config property：config 键 > 环境变量 > 空；空 = 不启用认证
  2. opencode_client：配置后每个请求点带 Authorization: Basic（含原本无自定义头的
     list/status 等端点）；未配置不带头 + 单次 WARNING
  3. client 信封全链路（monkeypatch aiohttp http 层捕获真实请求头）

launcher 的 OpenCode 环境注入已随任务 25（launcher 退役）删除，不再覆盖。
"""
import asyncio
import base64
import logging
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

import aiohttp

from config.config import get_config
import services.opencode_client as oc
from services.opencode_client import OpenCodeClient, _basic_auth_value


def _basic(user: str, password: str) -> str:
    """构造期望的 Basic 头值。"""
    return "Basic " + base64.b64encode(f"{user}:{password}".encode("utf-8")).decode("ascii")


@pytest.fixture
def opencode_password(monkeypatch):
    """设置/恢复 opencode.server_password（config 单例跨测试共享，必须恢复）。

    同时清掉环境变量干扰，保证 config 键分支可独立断言。
    """
    cfg = get_config()
    node = cfg._data.setdefault("opencode", {})
    had_pw, old_pw = "server_password" in node, node.get("server_password")
    had_user, old_user = "server_username" in node, node.get("server_username")
    monkeypatch.delenv("OPENCODE_SERVER_PASSWORD", raising=False)
    monkeypatch.delenv("OPENCODE_SERVER_USERNAME", raising=False)

    def _set(password, username=None):
        node["server_password"] = password
        if username is not None:
            node["server_username"] = username

    yield _set
    if had_pw:
        node["server_password"] = old_pw
    else:
        node.pop("server_password", None)
    if had_user:
        node["server_username"] = old_user
    else:
        node.pop("server_username", None)


@pytest.fixture
def auth_warned_reset():
    """重置/恢复 fail-open 告警的一次性标志。"""
    old = oc._auth_warned
    oc._auth_warned = False
    yield
    oc._auth_warned = old


class _FakeResp:
    """替身 aiohttp 响应（支持 async with + json/text）。"""

    status = 200

    def __init__(self, headers=None):
        self.headers = dict(headers or {})

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def json(self):
        return []

    async def text(self):
        return "[]"


# ── 1. config property ──────────────────────────────────────────


class TestConfigServerAuth:
    def test_default_is_empty_fail_open(self, opencode_password, monkeypatch):
        opencode_password("")
        cfg = get_config()
        assert cfg.OPENCODE_SERVER_PASSWORD == ""
        assert cfg.OPENCODE_SERVER_USERNAME == "opencode"

    def test_config_key_wins_over_env(self, opencode_password, monkeypatch):
        opencode_password("cfgpw")
        monkeypatch.setenv("OPENCODE_SERVER_PASSWORD", "envpw")
        assert get_config().OPENCODE_SERVER_PASSWORD == "cfgpw"

    def test_env_fallback_when_config_empty(self, opencode_password, monkeypatch):
        opencode_password("")
        monkeypatch.setenv("OPENCODE_SERVER_PASSWORD", "envpw")
        monkeypatch.setenv("OPENCODE_SERVER_USERNAME", "envuser")
        cfg = get_config()
        assert cfg.OPENCODE_SERVER_PASSWORD == "envpw"
        assert cfg.OPENCODE_SERVER_USERNAME == "envuser"


# ── 2. client 头构造（fail-open） ───────────────────────────────


class TestClientAuthHeaders:
    def test_no_password_returns_none(self, opencode_password, auth_warned_reset):
        opencode_password("")
        assert _basic_auth_value() is None

    def test_headers_carry_basic_when_configured(
        self, opencode_password, auth_warned_reset
    ):
        opencode_password("s3cret", username="opencode")
        headers = OpenCodeClient(base_url="http://127.0.0.1:5096")._get_headers("ses_1")
        assert headers["Authorization"] == _basic("opencode", "s3cret")
        # 原有头不受影响（向后兼容）
        assert headers["x-opencode-directory"]
        assert headers["Content-Type"] == "application/json"

    def test_custom_username_in_basic(self, opencode_password, auth_warned_reset):
        opencode_password("pw", username="alice")
        assert _basic_auth_value() == _basic("alice", "pw")

    def test_headers_without_password_have_no_authorization(
        self, opencode_password, auth_warned_reset
    ):
        opencode_password("")
        headers = OpenCodeClient(base_url="http://127.0.0.1:5096")._get_headers()
        assert "Authorization" not in headers

    def test_missing_password_warns_exactly_once(
        self, opencode_password, auth_warned_reset, caplog
    ):
        opencode_password("")
        with caplog.at_level(logging.WARNING, logger="services.opencode_client"):
            _basic_auth_value()
            _basic_auth_value()
        hits = [r for r in caplog.records if "server_password" in r.getMessage()]
        assert len(hits) == 1, f"fail-open 告警应恰好一次, 实际 {len(hits)}"


# ── 3. client 信封全链路（monkeypatch aiohttp http 层） ─────────
# V6 平迁：原经 gateway 的用例改直调 client 信封方法（gateway 已退役）。


class TestClientRequestCarriesAuth:
    """client 信封层 → aiohttp：断言真实出站请求头带/不带认证。"""

    captured: dict = {}
    client = None

    @pytest.fixture(autouse=True)
    def _wire(self, opencode_password, auth_warned_reset, monkeypatch):
        cfg = get_config()
        cfg._data.setdefault("features", {})["opencode_mock_enabled"] = False

        client = OpenCodeClient(base_url="http://127.0.0.1:5096")
        captured: dict = {"headers": {}, "url": ""}

        def fake_get(session, url, **kwargs):
            captured["url"] = url
            captured["headers"] = dict(kwargs.get("headers") or {})
            return _FakeResp()

        def fake_post(session, url, **kwargs):
            captured["url"] = url
            captured["headers"] = dict(kwargs.get("headers") or {})
            return _FakeResp()

        monkeypatch.setattr(aiohttp.ClientSession, "get", fake_get)
        monkeypatch.setattr(aiohttp.ClientSession, "post", fake_post)
        self.captured = captured
        self.client = client
        yield

    def test_health_check_sends_basic_header(self, opencode_password):
        """原本次无自定义头的 list_sessions 路径也必须带认证（monkeypatch http 层）。"""
        opencode_password("topsecret")
        r = asyncio.run(self.client.health_check())
        assert r["ok"] is True
        assert r["data"]["status"] == "online"
        assert self.captured["headers"].get("Authorization") == _basic(
            "opencode", "topsecret"
        )

    def test_send_message_sends_basic_header(self, opencode_password):
        """经 _get_headers 的主链路（发消息）同样带认证。"""
        opencode_password("topsecret", username="opencode")
        r = asyncio.run(
            self.client.send_message(session_id="ses_x", message="hello")
        )
        assert r["ok"] is True
        assert self.captured["headers"].get("Authorization") == _basic(
            "opencode", "topsecret"
        )

    def test_fail_open_no_header_when_unconfigured(
        self, opencode_password, caplog
    ):
        """未配置密码：请求形状与改造前完全一致（无 Authorization），不阻断。"""
        opencode_password("")
        with caplog.at_level(logging.WARNING, logger="services.opencode_client"):
            r = asyncio.run(self.client.health_check())
        assert r["ok"] is True
        assert "Authorization" not in (self.captured["headers"] or {})
        assert any("server_password" in rec.getMessage() for rec in caplog.records)
