# -*- coding: utf-8 -*-
"""
认证 API 端点测试（首次初始化 / 凭据修改）

通过 FastAPI TestClient 覆盖路由层行为：
  - GET  /auth/setup-status        无用户返回 needs_setup=True，已有用户返回 False
  - POST /auth/setup               首次初始化成功返回 Token；已初始化返回 409
  - POST /auth/change-credentials  成功 200（改密返回新 Token 且旧 Token 失效）；原密码错误 400；未授权 401

隔离方式：conftest.py 在导入期已把 auth 的配置读写替换为内存 mock，
这里为每个用例再注入独立的内存配置，避免相互污染。
"""
import pytest

import auth
import routers.auth_api as auth_api
from config.config import Config


@pytest.fixture(autouse=True)
def _isolate_auth_global(monkeypatch, tmp_path):
    """隔离 auth._auth_config 全局指针与引导令牌文件，避免污染真实配置。"""
    monkeypatch.setattr(auth, "_auth_config", None)
    monkeypatch.setattr(auth, "SETUP_TOKEN_FILE", str(tmp_path / ".setup_token"))
    yield


def _install(monkeypatch, config):
    """把 auth 的读取/保存替换为给定的内存配置，返回保存记录列表。"""
    saved = []
    monkeypatch.setattr(auth, "get_auth_config", lambda: config)
    monkeypatch.setattr(auth, "save_auth_config", lambda c: saved.append(c))
    return saved


def _configure_switch(monkeypatch, require_token: bool):
    """覆盖路由层读取的配置，控制 auth.setup_require_token 开关。"""
    monkeypatch.setattr(
        auth_api,
        "get_config",
        lambda: Config({
            # Config 对 opencode 必填项做 fail-fast 校验，测试态补一组最小合法值
            "opencode": {
                "default_agent": "main-task",
                "default_model": "test-model",
                "default_provider": "test-provider",
            },
            "auth": {"setup_require_token": require_token},
        }),
    )


def _empty_config():
    """空配置（首次初始化前状态）。"""
    return auth.AuthConfig(users={}, tokens={})


def _user_config(username="Axeuh", password="oldpass123"):
    """构造含单个用户、无 Token 的内存配置。"""
    return auth.AuthConfig(
        users={
            username: auth.UserInfo(
                password_hash=auth.hash_password(password),
                display_name=username,
            )
        },
        tokens={},
    )


def _user_config_with_token(username="Axeuh", password="oldpass123", token="tok_user"):
    """构造含单个用户 + 一个长期有效 Token 的内存配置（供受保护端点测试）。"""
    return auth.AuthConfig(
        users={
            username: auth.UserInfo(
                password_hash=auth.hash_password(password),
                display_name=username,
            )
        },
        tokens={
            token: auth.TokenInfo(
                user_id=username, expires_at="2099-01-01T00:00:00", kind="user"
            )
        },
    )


class TestSetupStatus:
    """GET /auth/setup-status 首次初始化状态查询"""

    def test_needs_setup_when_no_user(self, client, monkeypatch):
        """无用户时返回 needs_setup=True，并附带 require_token 开关"""
        _install(monkeypatch, _empty_config())
        _configure_switch(monkeypatch, False)

        resp = client.get("/auth/setup-status")

        assert resp.status_code == 200
        assert resp.json() == {"needs_setup": True, "require_token": False}

    def test_no_setup_when_user_exists(self, client, monkeypatch):
        """已有用户时返回 needs_setup=False"""
        _install(monkeypatch, _user_config())
        _configure_switch(monkeypatch, False)

        resp = client.get("/auth/setup-status")

        assert resp.status_code == 200
        assert resp.json() == {"needs_setup": False, "require_token": False}

    def test_setup_status_reports_token_switch(self, client, monkeypatch):
        """开关开启时 setup-status 的 require_token 为 True，且不泄露引导令牌"""
        _install(monkeypatch, _empty_config())
        _configure_switch(monkeypatch, True)
        setup_token = auth.get_or_create_setup_token()

        resp = client.get("/auth/setup-status")

        assert resp.status_code == 200
        assert resp.json() == {"needs_setup": True, "require_token": True}
        assert setup_token
        assert setup_token not in resp.text


class TestSetup:
    """POST /auth/setup 首次初始化"""

    def test_setup_success_without_token_by_default(self, client, monkeypatch):
        """默认（开关关闭）不携带 X-Setup-Token 也能完成首次设置"""
        config = _empty_config()
        _install(monkeypatch, config)
        _configure_switch(monkeypatch, False)

        resp = client.post(
            "/auth/setup",
            json={"username": "NewAdmin", "password": "secret123"},
        )

        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is True
        assert data["token"]
        assert data["user_id"] == "NewAdmin"
        assert data["display_name"] == "NewAdmin"
        assert "NewAdmin" in config.users

    def test_setup_success_with_token_when_required(self, client, monkeypatch):
        """开关开启 + 正确引导令牌 -> 设置成功，返回 Token 并创建用户"""
        config = _empty_config()
        _install(monkeypatch, config)
        _configure_switch(monkeypatch, True)
        setup_token = auth.get_or_create_setup_token()

        resp = client.post(
            "/auth/setup",
            headers={"X-Setup-Token": setup_token},
            json={"username": "NewAdmin", "password": "secret123"},
        )

        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is True
        assert data["token"]
        assert data["token"] != setup_token
        assert setup_token not in resp.text
        assert data["user_id"] == "NewAdmin"
        assert data["display_name"] == "NewAdmin"
        assert "NewAdmin" in config.users

    def test_setup_without_token_forbidden_when_required(self, client, monkeypatch):
        """开关开启：无引导令牌 -> 403，且不创建用户"""
        config = _empty_config()
        _install(monkeypatch, config)
        _configure_switch(monkeypatch, True)

        resp = client.post(
            "/auth/setup",
            json={"username": "NewAdmin", "password": "secret123"},
        )

        assert resp.status_code == 403
        assert resp.json()["success"] is False
        assert config.users == {}

    def test_setup_wrong_token_forbidden_when_required(self, client, monkeypatch):
        """开关开启：错误引导令牌 -> 403，响应不回显真实引导令牌"""
        config = _empty_config()
        _install(monkeypatch, config)
        _configure_switch(monkeypatch, True)
        setup_token = auth.get_or_create_setup_token()

        resp = client.post(
            "/auth/setup",
            headers={"X-Setup-Token": "wrong-token"},
            json={"username": "NewAdmin", "password": "secret123"},
        )

        assert resp.status_code == 403
        assert setup_token not in resp.text
        assert config.users == {}

    def test_setup_conflict_when_initialized(self, client, monkeypatch):
        """已有用户时重复初始化返回 409"""
        config = _user_config()
        _install(monkeypatch, config)
        _configure_switch(monkeypatch, False)

        resp = client.post(
            "/auth/setup",
            json={"username": "Other", "password": "secret123"},
        )

        assert resp.status_code == 409
        data = resp.json()
        assert data["success"] is False
        assert data["message"] == "系统已初始化，无法重复设置"
        assert "Other" not in config.users

    def test_setup_short_password_rejected(self, client, monkeypatch):
        """密码不足 6 位返回 400，且不创建用户"""
        config = _empty_config()
        _install(monkeypatch, config)
        _configure_switch(monkeypatch, False)

        resp = client.post(
            "/auth/setup",
            json={"username": "NewAdmin", "password": "123"},
        )

        assert resp.status_code == 400
        assert resp.json()["success"] is False
        assert config.users == {}


class TestChangeCredentials:
    """POST /auth/change-credentials 凭据修改"""

    def test_change_password_success(self, client, monkeypatch):
        """改密码成功返回 200 与新 Token；旧 Token 失效，新 Token 生效"""
        config = _user_config_with_token()
        _install(monkeypatch, config)

        resp = client.post(
            "/auth/change-credentials",
            headers={"Authorization": "Bearer tok_user"},
            json={"old_password": "oldpass123", "new_password": "newpass456"},
        )

        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is True
        assert data["user_id"] == "Axeuh"
        assert auth.verify_password("Axeuh", "newpass456") == (True, "Axeuh")
        # 改密返回可用的新 Token
        assert data["token"]
        # 旧 Token 已吊销，不再有效
        assert auth.verify_token("tok_user") == (False, None)
        # 新 Token 绑定同一用户且有效
        assert auth.verify_token(data["token"]) == (True, "Axeuh")

    def test_change_username_success(self, client, monkeypatch):
        """改名成功返回 200 与最终用户名，且不轮换 Token"""
        config = _user_config_with_token()
        _install(monkeypatch, config)

        resp = client.post(
            "/auth/change-credentials",
            headers={"Authorization": "Bearer tok_user"},
            json={"old_password": "oldpass123", "new_username": "Renamed"},
        )

        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is True
        assert data["user_id"] == "Renamed"
        assert "Renamed" in config.users
        # 仅改名：不返回新 Token，既有 Token 仍有效且归属同步为新用户名
        assert data.get("token") is None
        assert auth.verify_token("tok_user") == (True, "Renamed")

    def test_wrong_old_password_rejected(self, client, monkeypatch):
        """原密码错误返回 400"""
        config = _user_config_with_token()
        _install(monkeypatch, config)

        resp = client.post(
            "/auth/change-credentials",
            headers={"Authorization": "Bearer tok_user"},
            json={"old_password": "wrong_password", "new_password": "newpass456"},
        )

        assert resp.status_code == 400
        data = resp.json()
        assert data["success"] is False
        assert data["message"] == "原密码错误"

    def test_requires_auth(self, client, monkeypatch):
        """无有效 Token 时被中间件拦截返回 401"""
        _install(monkeypatch, _user_config_with_token())

        resp = client.post(
            "/auth/change-credentials",
            json={"old_password": "oldpass123", "new_password": "newpass456"},
        )

        assert resp.status_code == 401
