# -*- coding: utf-8 -*-
"""T02: 配置写入授权与 staging 认证状态隔离。

覆盖：
- 引导模式（系统中无用户）：无论配置是否降级、setup_require_token 开关如何，
  配置写入一律要求 X-Setup-Token
- 已配置系统（存在用户）：user token + 密码 的放行/拒绝矩阵；
  配置降级也不能退回 setup token 路径
- 启动辅助 ensure_bootstrap_token 的文件生成条件、0600 权限、完整令牌仅在
  启动日志出现一次（来源=文件/新生成）
- verify_setup_token 的 HTTP 校验路径不记录令牌
- 密码不得出现在日志；引导令牌仅在启动日志出现一次
- backend.log 在 POSIX 上收紧到 0600
- AEUH_AUTH_STATE_DIR 对 auth 状态文件路径的隔离
- backend/config/.setup_token 被 .gitignore 忽略

真实生成用例只读写 tmp_path 下的临时令牌文件；其余 auth 校验函数均被替换。
"""
import asyncio
import logging
import os
import re
import shutil
import stat
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

import auth
import config.config as config_module
import services.config_authz as config_authz
from services.config_authz import (
    ConfigAuthError,
    ensure_bootstrap_token,
    require_config_read,
    require_config_write,
)


BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_DIR.parent


def _request(*, user_id=None, token_kind=None, headers=None):
    """构造最小 Request 替身（仅暴露 state.user_id/state.token_kind 与 headers.get）。"""
    state = SimpleNamespace()
    if user_id is not None:
        state.user_id = user_id
    if token_kind is not None:
        state.token_kind = token_kind
    return SimpleNamespace(state=state, headers=headers or {})


def _fake_config(*, unconfigured=False, setup_require_token=False):
    """构造配置替身：新授权逻辑只认用户存在性，不应读取这些降级标记。"""
    return SimpleNamespace(
        UNCONFIGURED=unconfigured,
        setup_require_token=setup_require_token,
    )


def _configured(
    monkeypatch, *, password_result=(True, "alice"), setup_valid=True, config=None
):
    """存在用户的常规模式（setup token 默认仍"有效"，以证明它不被接受）。"""
    monkeypatch.setattr(config_authz.auth, "is_setup_required", lambda: False)
    monkeypatch.setattr(
        config_authz.auth, "verify_password", lambda user, pw: password_result
    )
    monkeypatch.setattr(
        config_authz.auth, "verify_setup_token", lambda token: setup_valid
    )
    monkeypatch.setattr(
        config_module, "get_config", lambda: config or _fake_config()
    )


def _bootstrap(monkeypatch, *, setup_valid=False, config=None):
    """无用户引导模式：auth.is_setup_required() 为 True。"""
    monkeypatch.setattr(config_authz.auth, "is_setup_required", lambda: True)
    monkeypatch.setattr(
        config_authz.auth, "verify_setup_token", lambda token: setup_valid
    )

    def _password_path_must_not_run(user, pw):
        raise AssertionError("引导模式不得进入密码校验路径")

    monkeypatch.setattr(
        config_authz.auth, "verify_password", _password_path_must_not_run
    )
    monkeypatch.setattr(
        config_module, "get_config", lambda: config or _fake_config()
    )


def _expect_error(coro, *, status_code, code):
    with pytest.raises(ConfigAuthError) as excinfo:
        asyncio.run(coro)
    err = excinfo.value
    assert err.status_code == status_code
    assert err.code == code
    return err


# ---------------------------------------------------------------- 已配置系统


def test_configured_user_with_correct_password_succeeds(monkeypatch):
    _configured(monkeypatch, password_result=(True, "alice"))
    req = _request(user_id="alice", token_kind="user")

    result = asyncio.run(require_config_write(req, "correct-password"))

    assert result.user_id == "alice"
    assert result.method == "password"
    assert result.token_kind == "user"


def test_configured_missing_password_is_rejected(monkeypatch):
    _configured(monkeypatch)
    req = _request(user_id="alice", token_kind="user")

    _expect_error(
        require_config_write(req, None),
        status_code=403,
        code="password_required",
    )


def test_configured_wrong_password_is_rejected(monkeypatch):
    _configured(monkeypatch, password_result=(False, None))
    req = _request(user_id="alice", token_kind="user")

    _expect_error(
        require_config_write(req, "wrong-password"),
        status_code=403,
        code="password_invalid",
    )


def test_service_token_is_forbidden(monkeypatch):
    _configured(monkeypatch)
    req = _request(user_id="alice", token_kind="service")

    _expect_error(
        require_config_write(req, "correct-password"),
        status_code=403,
        code="token_kind_forbidden",
    )


def test_device_token_is_forbidden(monkeypatch):
    _configured(monkeypatch)
    req = _request(user_id="alice", token_kind="device")

    _expect_error(
        require_config_write(req, "correct-password"),
        status_code=403,
        code="token_kind_forbidden",
    )


def test_configured_degraded_config_ignores_setup_token(monkeypatch):
    """存在用户时配置降级（UNCONFIGURED=True）也不得退回 setup token 路径。"""
    _configured(
        monkeypatch,
        config=_fake_config(unconfigured=True, setup_require_token=True),
    )
    req = _request(
        user_id="alice",
        token_kind="user",
        headers={"X-Setup-Token": "good"},
    )

    _expect_error(
        require_config_write(req, None),
        status_code=403,
        code="password_required",
    )


def test_configured_degraded_config_allows_password(monkeypatch):
    """存在用户时配置降级（UNCONFIGURED=True）仍走密码路径并放行。"""
    _configured(
        monkeypatch,
        password_result=(True, "alice"),
        config=_fake_config(unconfigured=True),
    )
    req = _request(user_id="alice", token_kind="user")

    result = asyncio.run(require_config_write(req, "correct-password"))

    assert result.user_id == "alice"
    assert result.method == "password"


# ---------------------------------------------------------------- 引导模式


def test_bootstrap_missing_setup_token_is_rejected(monkeypatch):
    _bootstrap(monkeypatch)
    req = _request(user_id="alice", token_kind="user")

    _expect_error(
        require_config_write(req),
        status_code=403,
        code="setup_token_required",
    )


def test_bootstrap_invalid_setup_token_is_rejected(monkeypatch):
    _bootstrap(monkeypatch, setup_valid=False)
    req = _request(user_id="alice", token_kind="user", headers={"X-Setup-Token": "bad"})

    _expect_error(
        require_config_write(req),
        status_code=403,
        code="setup_token_invalid",
    )


def test_bootstrap_valid_setup_token_succeeds(monkeypatch):
    _bootstrap(monkeypatch, setup_valid=True)
    req = _request(headers={"X-Setup-Token": "good"})

    result = asyncio.run(require_config_write(req))

    assert result.user_id == "__setup__"
    assert result.method == "setup_token"
    assert result.token_kind == "setup"


def test_bootstrap_requires_setup_token_regardless_of_config_flags(monkeypatch):
    """无用户即引导模式：配置不降级、setup_require_token=False 也必须带令牌。"""
    _bootstrap(
        monkeypatch,
        config=_fake_config(unconfigured=False, setup_require_token=False),
    )
    req = _request()

    _expect_error(
        require_config_write(req),
        status_code=403,
        code="setup_token_required",
    )


def test_bootstrap_valid_setup_token_works_when_setup_require_token_disabled(monkeypatch):
    """setup_require_token=False 只影响 /auth/setup，不解除配置写入的令牌要求。"""
    _bootstrap(
        monkeypatch,
        setup_valid=True,
        config=_fake_config(unconfigured=False, setup_require_token=False),
    )
    req = _request(headers={"X-Setup-Token": "good"})

    result = asyncio.run(require_config_write(req))

    assert result.method == "setup_token"
    assert result.token_kind == "setup"


def test_bootstrap_mode_helper_is_monkeypatchable(monkeypatch):
    """授权判定保留模块级函数作为测试接缝。"""
    monkeypatch.setattr(config_authz, "_is_bootstrap_mode", lambda: True)
    monkeypatch.setattr(config_authz.auth, "verify_setup_token", lambda token: True)

    result = asyncio.run(
        require_config_write(_request(headers={"X-Setup-Token": "good"}))
    )

    assert result.method == "setup_token"


# ---------------------------------------------------------------- 配置读取


def test_read_configured_user_token_succeeds_without_password(monkeypatch):
    _configured(monkeypatch)
    req = _request(user_id="alice", token_kind="user")

    result = asyncio.run(require_config_read(req))

    assert result.user_id == "alice"
    assert result.token_kind == "user"


def test_read_missing_identity_is_rejected(monkeypatch):
    _configured(monkeypatch)

    _expect_error(
        require_config_read(_request()),
        status_code=401,
        code="auth_required",
    )


def test_read_service_and_device_tokens_are_forbidden(monkeypatch):
    _configured(monkeypatch)

    for kind in ("service", "device"):
        _expect_error(
            require_config_read(_request(user_id="alice", token_kind=kind)),
            status_code=403,
            code="token_kind_forbidden",
        )


def test_read_bootstrap_allows_without_setup_token_or_password(monkeypatch):
    _bootstrap(monkeypatch)

    result = asyncio.run(require_config_read(_request()))

    assert result.user_id == config_authz.SETUP_USER_ID
    assert result.token_kind == "setup"


# ---------------------------------------------------------------- 启动辅助


def _bootstrap_setup_token_env(monkeypatch, token_file: Path):
    """把真实引导令牌生成隔离到 tmp_path，并让系统处于无用户状态。"""
    monkeypatch.setattr(config_authz.auth, "SETUP_TOKEN_FILE", str(token_file))
    monkeypatch.setattr(config_authz.auth, "is_setup_required", lambda: True)
    monkeypatch.setattr(
        config_authz.auth, "get_auth_config", lambda: auth.AuthConfig()
    )


def _setup_token_records(caplog):
    return [
        record
        for record in caplog.records
        if "初始化令牌" in record.getMessage()
    ]


def test_ensure_bootstrap_token_creates_real_file_when_setup_required(
    monkeypatch, caplog, tmp_path
):
    caplog.set_level(logging.INFO)
    token_file = tmp_path / ".setup_token"
    _bootstrap_setup_token_env(monkeypatch, token_file)

    description = ensure_bootstrap_token()

    raw = token_file.read_text(encoding="utf-8").strip()
    assert description == str(token_file)
    assert raw not in description
    assert re.fullmatch(r"[0-9a-f]{64}", raw)
    assert stat.S_IMODE(token_file.stat().st_mode) == 0o600

    records = _setup_token_records(caplog)
    assert len(records) == 1
    message = records[0].getMessage()
    assert raw in message
    assert "来源=新生成" in message


def test_ensure_bootstrap_token_reports_existing_file_source(
    monkeypatch, caplog, tmp_path
):
    caplog.set_level(logging.INFO)
    token_file = tmp_path / ".setup_token"
    existing = "0123456789abcdef" * 4
    token_file.write_text(existing, encoding="utf-8")
    _bootstrap_setup_token_env(monkeypatch, token_file)

    description = ensure_bootstrap_token()

    assert description == str(token_file)
    assert token_file.read_text(encoding="utf-8").strip() == existing
    records = _setup_token_records(caplog)
    assert len(records) == 1
    message = records[0].getMessage()
    assert existing in message
    assert "来源=文件" in message


def test_verify_setup_token_never_logs_the_token(monkeypatch, caplog, tmp_path):
    caplog.set_level(logging.DEBUG)
    token_file = tmp_path / ".setup_token"
    _bootstrap_setup_token_env(monkeypatch, token_file)
    token = config_authz.auth.get_or_create_setup_token()
    caplog.clear()

    assert config_authz.auth.verify_setup_token(token) is True
    assert config_authz.auth.verify_setup_token("wrong-token") is False

    assert token not in caplog.text


def test_ensure_bootstrap_token_skips_when_users_exist(monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)
    calls = []

    monkeypatch.setattr(config_authz.auth, "is_setup_required", lambda: False)

    def _get_or_create():
        calls.append(1)
        return "must-not-be-used"

    monkeypatch.setattr(
        config_authz.auth, "get_or_create_setup_token", _get_or_create
    )

    description = ensure_bootstrap_token()

    assert description == ""
    assert calls == []
    assert "must-not-be-used" not in caplog.text
    assert _setup_token_records(caplog) == []


# ---------------------------------------------------------------- 日志保密


@pytest.mark.skipif(os.name != "posix", reason="POSIX 权限位")
def test_setup_logging_tightens_backend_log_to_0600(tmp_path):
    from core.log_setup import setup_logging

    log_path = tmp_path / "backend.log"
    log_path.write_text("", encoding="utf-8")
    os.chmod(log_path, 0o644)

    logger = setup_logging("test.backend.log.permissions", log_dir=str(tmp_path))
    try:
        assert stat.S_IMODE(log_path.stat().st_mode) == 0o600
    finally:
        for handler in list(logger.handlers):
            logger.removeHandler(handler)
            handler.close()


def test_secrets_never_appear_in_logs(monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)
    password = "s3cr3t-do-not-log"
    setup_secret = "setup-secret-token"

    _configured(monkeypatch, password_result=(False, None))
    _expect_error(
        require_config_write(_request(user_id="alice", token_kind="user"), password),
        status_code=403,
        code="password_invalid",
    )

    _bootstrap(monkeypatch, setup_valid=False)
    _expect_error(
        require_config_write(
            _request(headers={"X-Setup-Token": setup_secret})
        ),
        status_code=403,
        code="setup_token_invalid",
    )

    assert password not in caplog.text
    assert setup_secret not in caplog.text


# ---------------------------------------------------------------- 部署隔离


def _auth_paths(env, cwd):
    code = (
        "import auth;"
        "print(auth.AUTH_CONFIG_FILE);"
        "print(auth.SETUP_TOKEN_FILE)"
    )
    proc = subprocess.run(
        [sys.executable, "-c", code],
        cwd=str(cwd),
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    auth_file, setup_file = proc.stdout.strip().splitlines()
    return Path(auth_file), Path(setup_file)


def test_auth_state_dir_env_isolates_paths(tmp_path):
    env = dict(os.environ)
    env["PYTHONPATH"] = str(BACKEND_DIR)
    env["AXEUH_AUTH_STATE_DIR"] = str(tmp_path / "state")
    env["PYTHONDONTWRITEBYTECODE"] = "1"

    auth_file, setup_file = _auth_paths(env, BACKEND_DIR)

    assert auth_file == tmp_path / "state" / "auth.json"
    assert setup_file == tmp_path / "state" / ".setup_token"


def test_auth_state_paths_default_to_backend_config():
    env = dict(os.environ)
    env["PYTHONPATH"] = str(BACKEND_DIR)
    env.pop("AXEUH_AUTH_STATE_DIR", None)
    env["PYTHONDONTWRITEBYTECODE"] = "1"

    auth_file, setup_file = _auth_paths(env, BACKEND_DIR)

    assert auth_file == BACKEND_DIR / "config" / "auth.json"
    assert setup_file == BACKEND_DIR / "config" / ".setup_token"


def test_setup_token_file_is_gitignored():
    if shutil.which("git") is None:
        pytest.skip("git unavailable")

    proc = subprocess.run(
        ["git", "check-ignore", "backend/config/.setup_token"],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        timeout=60,
    )

    assert proc.returncode == 0, proc.stderr
