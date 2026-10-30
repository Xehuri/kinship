# -*- coding: utf-8 -*-
"""小米健康云引导 API：认证、脱敏、绝不启动拉取线程、完成态判定。"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from middleware.onboarding_gate import OnboardingGateMiddleware
from routers import onboarding_xiaomi as router_module
from services import config_authz
from services.onboarding_xiaomi import xiaomi_finish_error

BASE = "/api/system/onboarding/xiaomi"

STATUS = {
    "enabled": True,
    "configured": True,
    "phase": "ok",
    "userid": "test...user",
    "userid_configured": True,
    "region": "cn",
    "last_error": "",
}


def _client(monkeypatch, *, service=None, read=None, write=None, gate=False):
    async def allow_read(request):
        return None

    async def allow_write(request, password):
        return None

    monkeypatch.setattr(
        router_module.config_authz, "require_config_read", read or allow_read
    )
    monkeypatch.setattr(
        router_module.config_authz, "require_config_write", write or allow_write
    )
    if service is not None:
        monkeypatch.setattr(
            router_module, "get_health_cloud_service", lambda: service
        )

    app = FastAPI()
    if gate:
        app.state.onboarding_state_completed = False
        app.add_middleware(OnboardingGateMiddleware)

        @app.get("/api/health/cloud/status")
        async def blocked_cloud():
            return {"ok": True}

    app.include_router(router_module.router)
    return TestClient(app)


def _thread_recorder():
    created = []

    class _Thread:
        def __init__(self, target=None, name=None, daemon=None):
            created.append(name or "")

        def start(self):
            raise AssertionError("引导流程不得启动拉取线程")

    return created, _Thread


def _mock_service() -> MagicMock:
    service = MagicMock()
    service.status.return_value = dict(STATUS)
    service.request_qr.return_value = {
        "lp": "https://example.invalid/lp",
        "qr_base64": "iVBORw0KGgo=",
        "expires_in": 300,
        "login_url": "https://example.invalid/login",
    }
    service.poll_qr_once.return_value = {"state": "waiting"}
    return service


@pytest.fixture()
def cloud_service(tmp_path, monkeypatch):
    from services import health_cloud_service as hcs

    service = hcs.HealthCloudService()
    service.state_path = lambda: str(tmp_path / "health_cloud_state.json")
    cfg = SimpleNamespace(
        HEALTH_CLOUD_STATE_PATH=str(tmp_path / "health_cloud_state.json"),
        HEALTH_CLOUD_USERID="test-cloud-user",
        HEALTH_CLOUD_PASSTOKEN="secret-pass-token",
        HEALTH_CLOUD_REGION="cn",
        HEALTH_CLOUD_ENABLED=True,
        HEALTH_CLOUD_POLL_INTERVAL_MIN=30,
        HEALTH_CLOUD_INITIAL_LOOKBACK_DAYS=3,
        HEALTH_CLOUD_OVERLAP_DAYS=7,
    )
    monkeypatch.setattr(hcs, "get_config", lambda: cfg)
    monkeypatch.setattr(service, "_latest_cloud_shard", lambda: "")
    return service


class TestInspectEndpoint:
    def test_requires_read_auth(self, monkeypatch):
        async def deny_read(request):
            raise config_authz.ConfigAuthError(
                401, "auth_required", "未授权访问，请先登录"
            )

        service = _mock_service()
        client = _client(monkeypatch, service=service, read=deny_read)

        response = client.get(BASE)

        assert response.status_code == 401
        assert response.json()["code"] == "auth_required"
        service.status.assert_not_called()

    def test_masks_userid_and_never_returns_passtoken(
        self, monkeypatch, cloud_service
    ):
        client = _client(monkeypatch, service=cloud_service)

        response = client.get(BASE)

        assert response.status_code == 200
        payload = response.json()
        assert payload["enabled"] is True
        assert payload["configured"] is True
        assert payload["userid_masked"] == "test...user"
        assert payload["userid_configured"] is True
        assert payload["needs_login"] is False
        assert "test-cloud-user" not in response.text
        assert "secret-pass-token" not in response.text
        assert "passToken" not in response.text

    def test_needs_login_when_credentials_expired(
        self, monkeypatch, cloud_service
    ):
        cloud_service._update_state(last_error="凭据失效: 401")
        client = _client(monkeypatch, service=cloud_service)

        payload = client.get(BASE).json()

        assert payload["phase"] == "auth_expired"
        assert payload["needs_login"] is True

    def test_needs_login_when_enabled_but_unconfigured(
        self, monkeypatch, cloud_service
    ):
        from services import health_cloud_service as hcs

        unconfigured = SimpleNamespace(
            HEALTH_CLOUD_STATE_PATH=cloud_service.state_path(),
            HEALTH_CLOUD_USERID="",
            HEALTH_CLOUD_PASSTOKEN="",
            HEALTH_CLOUD_REGION="cn",
            HEALTH_CLOUD_ENABLED=True,
            HEALTH_CLOUD_POLL_INTERVAL_MIN=30,
            HEALTH_CLOUD_INITIAL_LOOKBACK_DAYS=3,
            HEALTH_CLOUD_OVERLAP_DAYS=7,
        )
        monkeypatch.setattr(hcs, "get_config", lambda: unconfigured)
        cloud_service._save_state({"enabled": True})
        client = _client(monkeypatch, service=cloud_service)

        payload = client.get(BASE).json()

        assert payload["configured"] is False
        assert payload["needs_login"] is True


class TestConfigEndpoint:
    def test_writes_state_without_starting_pull(self, monkeypatch):
        service = _mock_service()
        client = _client(monkeypatch, service=service)

        response = client.post(
            BASE + "/config",
            json={"enabled": True, "current_password": "correct-password"},
        )

        assert response.status_code == 200
        service.set_enabled.assert_called_once_with(True, start_pull=False)
        service.start.assert_not_called()
        service.pull_once.assert_not_called()
        assert response.json()["starts_after_finish"] is True
        assert "passToken" not in response.text

    def test_real_service_leaves_pull_thread_idle(self, monkeypatch, cloud_service):
        from services import health_cloud_service as hcs

        created, thread_cls = _thread_recorder()
        monkeypatch.setattr(hcs, "threading", SimpleNamespace(Thread=thread_cls))
        client = _client(monkeypatch, service=cloud_service)

        response = client.post(BASE + "/config", json={"enabled": True})

        assert response.status_code == 200
        assert cloud_service.is_enabled() is True
        assert cloud_service._thread is None
        assert created == []

    def test_disable_without_start_also_skips_pull(self, monkeypatch):
        service = _mock_service()
        client = _client(monkeypatch, service=service)

        response = client.post(BASE + "/config", json={"enabled": False})

        assert response.status_code == 200
        service.set_enabled.assert_called_once_with(False, start_pull=False)
        service.start.assert_not_called()

    def test_passes_current_password_to_write_auth(self, monkeypatch):
        passwords = []

        async def capture_write(request, password):
            passwords.append(password)
            return None

        service = _mock_service()
        client = _client(monkeypatch, service=service, write=capture_write)

        client.post(
            BASE + "/config",
            json={"enabled": True, "current_password": "pw"},
        )

        assert passwords == ["pw"]

    def test_denied_write_does_not_touch_service(self, monkeypatch):
        async def deny_write(request, password):
            raise config_authz.ConfigAuthError(
                403, "password_required", "修改配置需要验证密码"
            )

        service = _mock_service()
        client = _client(monkeypatch, service=service, write=deny_write)

        response = client.post(BASE + "/config", json={"enabled": True})

        assert response.status_code == 403
        assert response.json()["code"] == "password_required"
        service.set_enabled.assert_not_called()


class TestQrEndpoints:
    def test_qr_returns_payload_without_pull(self, monkeypatch):
        service = _mock_service()
        client = _client(monkeypatch, service=service)

        response = client.post(BASE + "/qr", json={})

        assert response.status_code == 200
        assert response.json() == {
            "lp": "https://example.invalid/lp",
            "qr_base64": "iVBORw0KGgo=",
            "expires_in": 300,
            "login_url": "https://example.invalid/login",
        }
        service.request_qr.assert_called_once()
        service.set_enabled.assert_not_called()
        service.poll_qr_once.assert_not_called()

    def test_qr_failure_maps_to_502_and_redacts_query_secret(self, monkeypatch):
        service = _mock_service()
        service.request_qr.side_effect = RuntimeError(
            "network down https://x.invalid/lp?passToken=leaked-secret"
        )
        client = _client(monkeypatch, service=service)

        response = client.post(BASE + "/qr", json={})

        assert response.status_code == 502
        assert response.json()["code"] == "xiaomi_qr_failed"
        assert "leaked-secret" not in response.text

    def test_qr_failure_redacts_configured_userid(self, monkeypatch):
        monkeypatch.setattr(
            router_module,
            "get_config",
            lambda: SimpleNamespace(HEALTH_CLOUD_USERID="test-cloud-user"),
        )
        service = _mock_service()
        service.request_qr.side_effect = RuntimeError(
            "login failed for test-cloud-user"
        )
        client = _client(monkeypatch, service=service)

        response = client.post(BASE + "/qr", json={})

        assert response.status_code == 502
        assert "test-cloud-user" not in response.text
        assert "test...user" in response.text

    def test_poll_waiting_forwards_start_pull_false(self, monkeypatch):
        service = _mock_service()
        client = _client(monkeypatch, service=service)

        response = client.post(
            BASE + "/qr/poll",
            json={"lp": "https://example.invalid/lp"},
        )

        assert response.status_code == 200
        assert response.json() == {"state": "waiting"}
        service.poll_qr_once.assert_called_once_with(
            "https://example.invalid/lp", start_pull=False
        )
        service.set_enabled.assert_not_called()

    def test_poll_success_returns_masked_userid_and_configured(
        self, monkeypatch
    ):
        service = _mock_service()
        service.poll_qr_once.return_value = {
            "state": "success",
            "user_id": "test...user",
        }
        client = _client(monkeypatch, service=service)

        response = client.post(
            BASE + "/qr/poll",
            json={"lp": "https://example.invalid/lp"},
        )

        assert response.status_code == 200
        assert response.json() == {
            "state": "success",
            "userid_masked": "test...user",
            "configured": True,
        }
        assert "passToken" not in response.text

    def test_poll_failure_maps_to_502_and_redacts_query_secret(
        self, monkeypatch
    ):
        service = _mock_service()
        service.poll_qr_once.side_effect = RuntimeError(
            "boom https://x.invalid/poll?passToken=leaked-secret"
        )
        client = _client(monkeypatch, service=service)

        response = client.post(
            BASE + "/qr/poll",
            json={"lp": "https://example.invalid/lp"},
        )

        assert response.status_code == 502
        assert response.json()["code"] == "xiaomi_qr_poll_failed"
        assert "leaked-secret" not in response.text

    def test_poll_denied_write_does_not_poll(self, monkeypatch):
        async def deny_write(request, password):
            raise config_authz.ConfigAuthError(403, "password_invalid", "密码错误")

        service = _mock_service()
        client = _client(monkeypatch, service=service, write=deny_write)

        response = client.post(
            BASE + "/qr/poll",
            json={"lp": "https://example.invalid/lp"},
        )

        assert response.status_code == 403
        service.poll_qr_once.assert_not_called()


class TestBootstrapGate:
    def test_gate_allows_xiaomi_and_blocks_health_cloud(self, monkeypatch):
        service = _mock_service()
        client = _client(monkeypatch, service=service, gate=True)

        allowed = client.get(BASE)
        blocked = client.get("/api/health/cloud/status")

        assert allowed.status_code == 200
        assert blocked.status_code == 503
        assert blocked.json() == {
            "code": "onboarding_required",
            "message": "Complete onboarding first",
        }


class TestFinishHelper:
    def test_disabled_is_not_blocking(self):
        assert xiaomi_finish_error(enabled=False, configured=False) is None

    def test_disabled_with_credentials_is_not_blocking(self):
        assert xiaomi_finish_error(enabled=False, configured=True) is None

    def test_enabled_and_configured_is_not_blocking(self):
        assert xiaomi_finish_error(enabled=True, configured=True) is None

    def test_enabled_without_credentials_blocks_finish(self):
        assert xiaomi_finish_error(enabled=True, configured=False) == {
            "code": "xiaomi_not_configured",
            "message": (
                "小米健康云已启用，但尚未完成扫码登录，"
                "请在「小米健康云」步骤扫码或关闭启用。"
            ),
        }
