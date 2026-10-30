# -*- coding: utf-8 -*-
"""
首次初始化与凭据修改测试

覆盖场景：
  - is_setup_required：无用户为 True，有用户为 False
  - create_first_user：成功创建并返回 Token、重复初始化被拒、
    密码过短被拒、用户名为空被拒
  - change_credentials：改名同步所有 Token 的 user_id（含服务 Token）
    且旧 Token 仍有效；改密吊销普通 Token、保留服务 Token 并返回新 Token；
    原密码错误；用户名冲突
  - load_auth_config：文件缺失时返回空配置且不写盘

注意：conftest.py 在导入期全局替换了 auth.get_auth_config / save_auth_config，
因此这里为每个用例提供独立的内存配置与保存记录器，避免污染全局测试配置。
"""
import stat

import pytest

import auth


@pytest.fixture(autouse=True)
def _isolate_auth_global(monkeypatch, tmp_path):
    """隔离 auth._auth_config 全局指针与引导令牌文件，测试结束后自动还原。"""
    monkeypatch.setattr(auth, "_auth_config", None)
    monkeypatch.setattr(auth, "SETUP_TOKEN_FILE", str(tmp_path / ".setup_token"))
    yield


def _install(monkeypatch, config):
    """把 auth 的读取/保存替换为给定的内存配置，返回保存记录列表。"""
    saved = []
    monkeypatch.setattr(auth, "get_auth_config", lambda: config)
    monkeypatch.setattr(auth, "save_auth_config", lambda c: saved.append(c))
    return saved


def _empty_config():
    """空配置（首次初始化前状态）。"""
    return auth.AuthConfig(users={}, tokens={})


def _user_config(username="Axeuh", password="oldpass123"):
    """构造含单个用户的内存配置。"""
    return auth.AuthConfig(
        users={
            username: auth.UserInfo(
                password_hash=auth.hash_password(password),
                display_name=username,
            )
        },
        tokens={},
    )


def _config_with_tokens(username="Axeuh", password="oldpass123"):
    """构造含一个用户 + 一个用户 Token + 一个服务 Token 的内存配置。"""
    return auth.AuthConfig(
        users={
            username: auth.UserInfo(
                password_hash=auth.hash_password(password),
                display_name=username,
            )
        },
        tokens={
            "user_token": auth.TokenInfo(
                user_id=username, expires_at="2030-01-01T00:00:00", kind="user"
            ),
            "svc_token": auth.TokenInfo(
                user_id=username,
                expires_at=auth.SERVICE_TOKEN_EXPIRY,
                kind=auth.SERVICE_TOKEN_KIND,
            ),
        },
    )


class TestIsSetupRequired:
    """is_setup_required() 判断逻辑"""

    def test_empty_users_requires_setup(self, monkeypatch):
        """无任何用户时需要首次初始化"""
        _install(monkeypatch, _empty_config())
        assert auth.is_setup_required() is True

    def test_existing_users_no_setup(self, monkeypatch):
        """已存在用户时无需初始化"""
        _install(monkeypatch, _user_config())
        assert auth.is_setup_required() is False


class TestCreateFirstUser:
    """create_first_user() 首次初始化"""

    def test_success_creates_user_token_and_service_token(self, monkeypatch):
        """首次设置成功：创建用户、返回登录 Token，并同步创建服务 Token"""
        config = _empty_config()
        saved = _install(monkeypatch, config)

        ok, msg, token = auth.create_first_user("Axeuh", "test-password-123")

        assert ok is True
        assert msg == "设置成功"
        assert token is not None

        # 用户已创建
        assert "Axeuh" in config.users
        assert config.users["Axeuh"].display_name == "Axeuh"

        # 返回的登录 Token 归属该用户
        assert token in config.tokens
        assert config.tokens[token].user_id == "Axeuh"

        # 服务 Token 已同步创建，且恰好一个
        service_tokens = [
            t for t, info in config.tokens.items()
            if info.kind == auth.SERVICE_TOKEN_KIND
        ]
        assert len(service_tokens) == 1
        assert config.tokens[service_tokens[0]].user_id == "Axeuh"

        # 已持久化
        assert len(saved) >= 1

        # 新密码与 Token 立即可用
        assert auth.verify_password("Axeuh", "test-password-123") == (True, "Axeuh")
        assert auth.verify_token(token) == (True, "Axeuh")

    def test_duplicate_setup_rejected(self, monkeypatch):
        """已有用户时重复初始化被拒绝"""
        config = _user_config()
        _install(monkeypatch, config)

        ok, msg, token = auth.create_first_user("Other", "test-password-123")

        assert ok is False
        assert msg == "系统已初始化，无法重复设置"
        assert token is None
        assert "Other" not in config.users

    def test_short_password_rejected(self, monkeypatch):
        """密码不足 6 位被拒绝，且不创建用户"""
        config = _empty_config()
        _install(monkeypatch, config)

        ok, msg, token = auth.create_first_user("Axeuh", "12345")

        assert ok is False
        assert token is None
        assert config.users == {}

    def test_empty_username_rejected(self, monkeypatch):
        """用户名全为空白被拒绝，且不创建用户"""
        config = _empty_config()
        _install(monkeypatch, config)

        ok, msg, token = auth.create_first_user("   ", "test-password-123")

        assert ok is False
        assert token is None
        assert config.users == {}


class TestChangeCredentials:
    """change_credentials() 凭据修改"""

    def test_rename_syncs_all_tokens_and_keeps_them_valid(self, monkeypatch):
        """改名：同步用户 Token 与服务 Token 的 user_id，旧 Token 仍有效"""
        config = _config_with_tokens()
        _install(monkeypatch, config)

        ok, msg, extra = auth.change_credentials(
            "Axeuh", "oldpass123", new_username="NewName"
        )

        assert ok is True
        assert msg == "修改成功"
        assert extra is None

        # 用户键已改名，显示名同步
        assert "NewName" in config.users
        assert "Axeuh" not in config.users
        assert config.users["NewName"].display_name == "NewName"

        # 所有 Token 的 user_id 已同步（含服务 Token）
        assert config.tokens["user_token"].user_id == "NewName"
        assert config.tokens["svc_token"].user_id == "NewName"

        # 旧 Token 无需重发，仍可验证且返回新 user_id
        assert auth.verify_token("user_token") == (True, "NewName")
        assert auth.verify_token("svc_token") == (True, "NewName")

        # 未改密码，原密码在新用户名下仍可用
        assert auth.verify_password("NewName", "oldpass123") == (True, "NewName")

    def test_password_only_change_revokes_user_token_keeps_service(self, monkeypatch):
        """BE-SEC-H3 仅改密码：吊销普通 Token，保留服务 Token，返回新 Token"""
        config = _config_with_tokens()
        _install(monkeypatch, config)

        ok, msg, extra = auth.change_credentials(
            "Axeuh", "oldpass123", new_password="newpass456"
        )

        assert ok is True
        assert msg == "修改成功"
        # 改密返回绑定该用户的新 Token，供当前会话无缝延续
        assert extra is not None
        assert auth.verify_token(extra) == (True, "Axeuh")

        assert "Axeuh" in config.users
        assert config.users["Axeuh"].display_name == "Axeuh"

        # 普通 Token 立即失效；服务 Token 保留且归属不变
        assert "user_token" not in config.tokens
        assert auth.verify_token("user_token") == (False, None)
        assert config.tokens["svc_token"].user_id == "Axeuh"
        assert auth.verify_token("svc_token") == (True, "Axeuh")

        # 新密码生效、旧密码失效
        assert auth.verify_password("Axeuh", "newpass456") == (True, "Axeuh")
        assert auth.verify_password("Axeuh", "oldpass123") == (False, None)

    def test_wrong_old_password_rejected(self, monkeypatch):
        """原密码错误被拒绝，凭据保持不变"""
        config = _config_with_tokens()
        _install(monkeypatch, config)

        ok, msg, extra = auth.change_credentials(
            "Axeuh", "wrong_password", new_password="newpass456"
        )

        assert ok is False
        assert msg == "原密码错误"
        assert extra is None
        # 原密码仍然有效，说明未被修改
        assert auth.verify_password("Axeuh", "oldpass123") == (True, "Axeuh")

    def test_username_collision_rejected(self, monkeypatch):
        """改名为已存在用户名被拒绝"""
        config = _config_with_tokens()
        config.users["Other"] = auth.UserInfo(
            password_hash=auth.hash_password("otherpass"), display_name="Other"
        )
        _install(monkeypatch, config)

        ok, msg, extra = auth.change_credentials(
            "Axeuh", "oldpass123", new_username="Other"
        )

        assert ok is False
        assert msg == "用户名已存在"
        assert extra is None
        assert "Axeuh" in config.users
        assert "Other" in config.users

    def test_short_new_password_rejected(self, monkeypatch):
        """新密码不足 6 位被拒绝"""
        config = _config_with_tokens()
        _install(monkeypatch, config)

        ok, msg, extra = auth.change_credentials(
            "Axeuh", "oldpass123", new_password="123"
        )

        assert ok is False
        assert extra is None
        assert auth.verify_password("Axeuh", "oldpass123") == (True, "Axeuh")

    def test_unknown_user_rejected(self, monkeypatch):
        """用户不存在时被拒绝"""
        config = _config_with_tokens()
        _install(monkeypatch, config)

        ok, msg, extra = auth.change_credentials(
            "Ghost", "oldpass123", new_password="newpass456"
        )

        assert ok is False
        assert msg == "用户不存在"
        assert extra is None


class TestAuthConfigFileIO:
    """load_auth_config 文件行为"""

    def test_missing_file_returns_empty_without_writing(self, monkeypatch, tmp_path):
        """auth.json 缺失时返回空配置，且不创建文件"""
        target = tmp_path / "auth.json"
        monkeypatch.setattr(auth, "AUTH_CONFIG_FILE", str(target))

        config = auth.load_auth_config()

        assert config.users == {}
        assert config.tokens == {}
        assert not target.exists()


class TestSetupTokenFile:
    """引导令牌落盘前必须先建好 0700 状态目录"""

    def test_creates_missing_state_dir_and_persists_token(
        self, monkeypatch, tmp_path
    ):
        target = tmp_path / "auth-state" / ".setup_token"
        monkeypatch.setattr(auth, "SETUP_TOKEN_FILE", str(target))
        _install(monkeypatch, _empty_config())

        token = auth.get_or_create_setup_token()

        assert token
        assert target.read_text(encoding="utf-8") == token
        assert stat.S_IMODE(target.parent.stat().st_mode) == 0o700
        assert stat.S_IMODE(target.stat().st_mode) == 0o600
        assert auth.get_or_create_setup_token() == token

    def test_write_failure_returns_no_token(
        self, monkeypatch, tmp_path, caplog
    ):
        blocker = tmp_path / "blocker"
        blocker.write_text("not a directory", encoding="utf-8")
        monkeypatch.setattr(auth, "SETUP_TOKEN_FILE", str(blocker / ".setup_token"))
        _install(monkeypatch, _empty_config())

        with caplog.at_level("ERROR", logger="auth"):
            token = auth.get_or_create_setup_token()

        assert token == ""
        assert "引导令牌写入失败" in caplog.text
        assert not (blocker / ".setup_token").exists()
