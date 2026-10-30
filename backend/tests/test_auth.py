# -*- coding: utf-8 -*-
"""
认证模块测试

覆盖场景：
  - 正确/错误密码登录
  - 本地访问不再免认证（Phase 2 已移除）
  - 公开路径（OTA/health/login/docs）无需 token
"""
import pytest
from config.config import get_config

# 从配置读取端口，避免硬编码
_TEST_HOST = f"localhost:{get_config().BACKEND_HTTPS_PORT}"


class TestLogin:
    """登录功能"""

    def test_login_success(self, client):
        """POST /login 正确凭据应返回 token"""
        resp = client.post("/login", json={
            "username": "Axeuh",
            "password": "test-password-123"
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is True
        assert data["token"] is not None
        assert len(data["token"]) > 0
        assert data["user_id"] == "Axeuh"
        assert data["display_name"] is not None

    def test_login_fail_wrong_password(self, client):
        """POST /login 错误密码应返回 success=False"""
        resp = client.post("/login", json={
            "username": "Axeuh",
            "password": "wrong_password_123"
        })
        assert resp.status_code == 200  # 登录端点总是返回 200
        data = resp.json()
        assert data["success"] is False
        assert data["token"] is None

    def test_login_fail_wrong_username(self, client):
        """POST /login 不存在的用户名应返回 success=False"""
        resp = client.post("/login", json={
            "username": "NonExistentUser",
            "password": "any_password"
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is False


class TestLocalAuthBypass:
    """本地访问认证"""

    def test_localhost_no_longer_bypasses_auth(self, client):
        """
        使用 localhost Host 头访问受保护端点应返回 401。
        Phase 2 已移除所有 localhost 认证绕过。
        """
        resp = client.get(
            "/api/screen/session/list",
            headers={"host": "localhost:9787"}
        )
        assert resp.status_code == 401
        data = resp.json()
        assert "detail" in data

    def test_127_dot_0_dot_0_dot_1_requires_auth(self, client):
        """
        使用 127.0.0.1 Host 头访问受保护端点应返回 401。
        """
        resp = client.get(
            "/api/screen/session/list",
            headers={"host": "127.0.0.1:9787"}
        )
        assert resp.status_code == 401

    def test_non_localhost_requires_auth(self, client):
        """
        非 localhost Host 头访问受保护端点应返回 401。
        TestClient 默认 Host 为 "testserver"，触发认证中间件。
        """
        resp = client.get("/api/screen/components")
        assert resp.status_code == 401
        data = resp.json()
        assert "detail" in data


class TestPublicPaths:
    """公开路径无需 Token"""

    def test_health_no_token(self, client):
        """GET /health 无需 token"""
        resp = client.get("/health")
        assert resp.status_code == 200

    def test_login_no_token(self, client):
        """POST /login 无需 token"""
        resp = client.post("/login", json={
            "username": "Axeuh",
            "password": "test-password-123"
        })
        assert resp.status_code == 200

    def test_docs_disabled_returns_404(self, client):
        """BE-SEC-H2: 生产已关闭 /docs，无需 token 但路由不存在 -> 404"""
        resp = client.get("/docs")
        assert resp.status_code == 404

    def test_openapi_json_disabled_returns_404(self, client):
        """BE-SEC-H2: /openapi.json 已关闭 -> 404"""
        resp = client.get("/openapi.json")
        assert resp.status_code == 404

    def test_redoc_disabled_returns_404(self, client):
        """BE-SEC-H2: /redoc 已关闭 -> 404"""
        resp = client.get("/redoc")
        assert resp.status_code == 404
