# -*- coding: utf-8 -*-
"""
服务 Token 机制测试

覆盖场景：
  - 无用户时不创建服务 Token（返回 None，首次初始化不伪造）
  - 有用户时创建恰好一个 far-future 服务 Token，且 user_id 有效
  - 重复调用幂等（同一 Token，数量仍为 1）
  - Token JSON 形状保持兼容，AI 消费端字段（user_id / expires_at）仍在
  - 改密时吊销普通 Token，但保留服务 Token

注意：conftest.py 在导入期全局替换了 auth.get_auth_config / save_auth_config，
因此这里为每个用例提供独立的内存配置与保存记录器，避免污染全局测试配置。
"""
from datetime import datetime

import pytest

import auth


@pytest.fixture(autouse=True)
def _isolate_auth_global(monkeypatch):
    """隔离 auth._auth_config 全局指针，测试结束后由 monkeypatch 自动还原。"""
    monkeypatch.setattr(auth, "_auth_config", None)
    yield


def _install(monkeypatch, config):
    """把 auth 的读取/保存替换为给定的内存配置，返回保存记录列表。"""
    saved = []
    monkeypatch.setattr(auth, "get_auth_config", lambda: config)
    monkeypatch.setattr(auth, "save_auth_config", lambda c: saved.append(c))
    return saved


def _user_config():
    """构造一个含单个用户的真实内存配置。"""
    return auth.AuthConfig(
        users={"Axeuh": auth.UserInfo(password_hash="x", display_name="Axeuh")},
        tokens={},
    )


class TestEnsureServiceToken:
    """ensure_service_token() 核心行为"""

    def test_no_users_returns_none_and_creates_nothing(self, monkeypatch):
        """无用户时不创建任何 Token，返回 None，且不触发保存"""
        config = auth.AuthConfig(users={}, tokens={})
        saved = _install(monkeypatch, config)

        result = auth.ensure_service_token()

        assert result is None
        assert config.tokens == {}
        assert saved == []

    def test_creates_one_service_token_when_users_exist(self, monkeypatch):
        """有用户时创建恰好一个服务 Token，归属有效用户且有效期 far-future"""
        config = _user_config()
        saved = _install(monkeypatch, config)

        token = auth.ensure_service_token()

        assert token is not None
        assert len(config.tokens) == 1
        assert token in config.tokens

        info = config.tokens[token]
        assert info.kind == auth.SERVICE_TOKEN_KIND
        assert info.expires_at == auth.SERVICE_TOKEN_EXPIRY
        assert info.user_id in config.users
        # 有效期必须远在未来
        assert datetime.fromisoformat(info.expires_at) > datetime.now()
        # 已持久化一次
        assert len(saved) == 1
        assert saved[0] is config

    def test_idempotent_on_repeated_calls(self, monkeypatch):
        """重复调用返回同一 Token，数量仍为 1，且只保存一次"""
        config = _user_config()
        saved = _install(monkeypatch, config)

        first = auth.ensure_service_token()
        second = auth.ensure_service_token()

        assert first == second
        assert len(config.tokens) == 1
        assert len(saved) == 1

    def test_existing_service_token_returned_unchanged(self, monkeypatch):
        """已存在服务 Token 时直接返回，不新增也不保存"""
        config = _user_config()
        config.tokens["existing_service"] = auth.TokenInfo(
            user_id="Axeuh",
            expires_at=auth.SERVICE_TOKEN_EXPIRY,
            kind=auth.SERVICE_TOKEN_KIND,
        )
        saved = _install(monkeypatch, config)

        result = auth.ensure_service_token()

        assert result == "existing_service"
        assert len(config.tokens) == 1
        assert saved == []


class TestTokenShapeCompatibility:
    """服务 Token 的 JSON 形状与 AI 消费端字段兼容性"""

    def test_model_dump_keeps_ai_consumer_fields(self, monkeypatch):
        """序列化后仍含 users / tokens 顶层键，token 内含 user_id / expires_at"""
        config = _user_config()
        _install(monkeypatch, config)

        token = auth.ensure_service_token()
        dumped = config.model_dump()

        assert "users" in dumped
        assert "tokens" in dumped
        assert token in dumped["tokens"]

        entry = dumped["tokens"][token]
        # AI 脚本（query_chatlog.py / deepseek_balance_monitor.py）依赖这两个字段
        assert "user_id" in entry
        assert "expires_at" in entry
        assert entry["kind"] == auth.SERVICE_TOKEN_KIND

    def test_legacy_token_defaults_to_user_kind(self):
        """旧 Token 反序列化时 kind 默认为 user，保证既有 Token 仍有效"""
        info = auth.TokenInfo(user_id="Axeuh", expires_at="2030-01-01T00:00:00")
        assert info.kind == "user"


class TestChangePasswordRevokesUserTokenKeepsService:
    """BE-SEC-H3: 改密吊销普通 Token，保留服务 Token"""

    def test_change_password_revokes_user_keeps_service(self, monkeypatch):
        """改密后用户 Token 被吊销，服务 Token 保留"""
        config = _user_config()
        # 使用真实密码哈希，保证旧密码校验通过
        config.users["Axeuh"].password_hash = auth.hash_password("oldpass123")
        config.tokens["user_token"] = auth.TokenInfo(
            user_id="Axeuh", expires_at="2030-01-01T00:00:00", kind="user"
        )
        config.tokens["svc_token"] = auth.TokenInfo(
            user_id="Axeuh",
            expires_at=auth.SERVICE_TOKEN_EXPIRY,
            kind=auth.SERVICE_TOKEN_KIND,
        )
        _install(monkeypatch, config)

        ok, msg = auth.change_password("Axeuh", "oldpass123", "newpass456")

        assert ok is True
        # 普通 Token 吊销
        assert "user_token" not in config.tokens
        assert auth.verify_token("user_token") == (False, None)
        # 服务 Token 保留
        assert "svc_token" in config.tokens
        assert config.tokens["svc_token"].kind == auth.SERVICE_TOKEN_KIND
        assert auth.verify_token("svc_token") == (True, "Axeuh")
