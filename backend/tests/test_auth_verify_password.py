# -*- coding: utf-8 -*-
"""POST /auth/verify-password 只读密码校验端点测试。

覆盖：
  - 正确密码返回 200 且不签发/回显 Token
  - 错误密码返回 403 password_invalid
  - 无 Bearer 由中间件返回 401
  - service/device Token 返回 403 token_kind_forbidden
  - 连续 5 次失败后第 6 次返回 429（Retry-After + retry_after）
  - 成功校验重置失败计数
  - check_user_password 只读：不写 auth.json，不迁移旧版 SHA256 哈希
"""
import hashlib
import json

import pytest

import auth
import routers.auth_api as auth_api

USER_TOKEN = "tok_user"
USER_HEADERS = {"Authorization": f"Bearer {USER_TOKEN}"}


@pytest.fixture(autouse=True)
def _isolate_rate_limit():
    """隔离登录失败限流状态，避免用例间相互污染。"""
    auth_api.reset_login_rate_limit()
    yield
    auth_api.reset_login_rate_limit()


@pytest.fixture(autouse=True)
def _isolate_auth_global(monkeypatch):
    """隔离 auth._auth_config 全局指针。"""
    monkeypatch.setattr(auth, "_auth_config", None)
    yield


def _install(monkeypatch, config):
    """把 auth 的读取/保存替换为给定内存配置，返回保存记录列表。"""
    saved = []
    monkeypatch.setattr(auth, "get_auth_config", lambda: config)
    monkeypatch.setattr(auth, "save_auth_config", lambda c: saved.append(c))
    return saved


def _user_config(password="oldpass123", tokens=None):
    return auth.AuthConfig(
        users={
            "Axeuh": auth.UserInfo(
                password_hash=auth.hash_password(password),
                display_name="Axeuh",
            )
        },
        tokens=tokens or {},
    )


def _user_token_config(password="oldpass123"):
    return _user_config(
        password,
        tokens={
            USER_TOKEN: auth.TokenInfo(
                user_id="Axeuh", expires_at="2099-01-01T00:00:00", kind="user"
            )
        },
    )


def _verify(client, password, headers=USER_HEADERS):
    return client.post(
        "/auth/verify-password", headers=headers, json={"password": password}
    )


class TestVerifyPasswordEndpoint:
    """POST /auth/verify-password 路由行为"""

    def test_valid_password_returns_200_without_token(self, client, monkeypatch):
        """正确密码 -> 200 {"valid": true}，不返回 Token、不回显密码"""
        _install(monkeypatch, _user_token_config())

        resp = _verify(client, "oldpass123")

        assert resp.status_code == 200
        data = resp.json()
        assert data == {"valid": True}
        assert "token" not in data
        assert "oldpass123" not in resp.text

    def test_wrong_password_returns_password_invalid(self, client, monkeypatch):
        """错误密码 -> 403 password_invalid，且不回显密码"""
        _install(monkeypatch, _user_token_config())

        resp = _verify(client, "not-the-password")

        assert resp.status_code == 403
        assert resp.json() == {"code": "password_invalid", "message": "密码错误"}
        assert "not-the-password" not in resp.text

    def test_missing_bearer_returns_401(self, client, monkeypatch):
        """无 Bearer -> 现有认证中间件返回 401"""
        _install(monkeypatch, _user_token_config())

        resp = _verify(client, "oldpass123", headers={})

        assert resp.status_code == 401
        assert "detail" in resp.json()
        assert "oldpass123" not in resp.text

    @pytest.mark.parametrize("kind", ["service", "device"])
    def test_non_user_token_is_forbidden(self, client, monkeypatch, kind):
        """service/device Token -> 403 token_kind_forbidden"""
        token_info = auth.TokenInfo(
            user_id="Axeuh",
            expires_at="2099-01-01T00:00:00",
            kind=kind,
            device_id="phone-1" if kind == "device" else "",
        )
        _install(monkeypatch, _user_config(tokens={"tok_other": token_info}))

        resp = _verify(
            client,
            "oldpass123",
            headers={"Authorization": "Bearer tok_other"},
        )

        assert resp.status_code == 403
        assert resp.json() == {
            "code": "token_kind_forbidden",
            "message": "该 Token 类型无权验证密码",
        }


class TestVerifyPasswordRateLimit:
    """与登录复用的 (IP, user_id) 失败限流"""

    def test_sixth_attempt_after_five_failures_is_rate_limited(
        self, client, monkeypatch
    ):
        """连续 5 次失败后第 6 次 429，带 Retry-After 与 retry_after"""
        _install(monkeypatch, _user_token_config())

        for _ in range(auth_api.LOGIN_MAX_FAILURES):
            resp = _verify(client, "wrongpass")
            assert resp.status_code == 403, resp.text
            assert resp.json()["code"] == "password_invalid"

        resp = _verify(client, "wrongpass")

        assert resp.status_code == 429
        data = resp.json()
        assert data["code"] == "rate_limited"
        retry_after = data["retry_after"]
        assert isinstance(retry_after, int)
        assert retry_after > 0
        assert data["message"] == f"尝试次数过多，请 {retry_after} 秒后再试"
        assert resp.headers["Retry-After"] == str(retry_after)

        # 锁定期间即使密码正确也不再校验
        assert _verify(client, "oldpass123").status_code == 429

    def test_success_resets_failure_counter(self, client, monkeypatch):
        """4 次失败 + 成功 + 连续 2 次失败仍为 403（计数已清零）"""
        _install(monkeypatch, _user_token_config())

        for _ in range(auth_api.LOGIN_MAX_FAILURES - 1):
            assert _verify(client, "wrongpass").status_code == 403

        assert _verify(client, "oldpass123").status_code == 200

        # 若未清零，这次是第 5 次失败并触发锁定
        assert _verify(client, "wrongpass").status_code == 403
        # 已清零时这里仍是普通失败；未清零则锁定中返回 429
        assert _verify(client, "wrongpass").status_code == 403


class TestCheckUserPasswordIsReadOnly:
    """check_user_password 只校验，不迁移、不落盘"""

    def test_does_not_write_auth_json_or_migrate_legacy_sha256(
        self, tmp_path, monkeypatch
    ):
        """旧版 SHA256 哈希校验成功也不迁移、不写 auth.json"""
        legacy_hash = hashlib.sha256(b"legacy-pass").hexdigest()
        auth_file = tmp_path / "auth.json"
        auth_file.write_text(
            json.dumps(
                {
                    "users": {
                        "Legacy": {
                            "password_hash": legacy_hash,
                            "display_name": "Legacy",
                        }
                    },
                    "tokens": {},
                }
            ),
            encoding="utf-8",
        )
        before = auth_file.read_bytes()

        saved = []
        monkeypatch.setattr(auth, "AUTH_CONFIG_FILE", str(auth_file))
        monkeypatch.setattr(auth, "get_auth_config", auth.load_auth_config)
        monkeypatch.setattr(auth, "save_auth_config", lambda c: saved.append(c))

        def _forbidden_migration(*_args, **_kwargs):
            raise AssertionError("check_user_password 不应迁移密码哈希")

        monkeypatch.setattr(auth, "_migrate_password_hash", _forbidden_migration)

        assert auth.check_user_password("Legacy", "legacy-pass") is True
        assert auth.check_user_password("Legacy", "wrong") is False
        assert auth.check_user_password("Missing", "legacy-pass") is False
        assert auth.check_user_password("Legacy", "") is False

        assert auth_file.read_bytes() == before
        assert saved == []
        assert (
            auth.load_auth_config().users["Legacy"].password_hash == legacy_hash
        )
