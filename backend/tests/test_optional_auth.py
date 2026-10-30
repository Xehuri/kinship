# -*- coding: utf-8 -*-
"""N11 可选鉴权 + 系统配置路由接线。

覆盖：
  - OPTIONAL_AUTH_PATHS：缺 token / 无效 token 不拦截，有效 Bearer 注入身份；
  - query token 在可选路径上不生效；
  - 其它 /api 路径仍保持精确 401；
  - 主应用挂载 /api/system 配置与引导路由，配置读取需登录且不泄露明文密钥；
  - CORS 来源可随配置端口原地刷新。
"""
from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

import main as main_module
from config.config import get_config
from config.store import get_config_store
from middleware import auth_middleware
from middleware.auth_middleware import OPTIONAL_AUTH_PATHS, AuthMiddleware


def _build_app() -> FastAPI:
    app = FastAPI()
    app.add_middleware(AuthMiddleware)

    @app.api_route("/{full_path:path}", methods=["GET", "POST", "PUT"])
    async def echo(request: Request, full_path: str) -> dict[str, Any]:
        return {
            "path": full_path,
            "user_id": getattr(request.state, "user_id", None),
            "token_kind": getattr(request.state, "token_kind", None),
            "device_id": getattr(request.state, "device_id", None),
        }

    return app


def _verify(token: str) -> tuple[bool, str | None, str, str]:
    if token == "good-token":
        return True, "alice", "user", "device-1"
    return False, None, "", ""


def test_optional_paths_are_exact_set() -> None:
    assert set(OPTIONAL_AUTH_PATHS) == {
        "/api/system/config",
        "/api/system/config/schema",
        "/api/system/config/status",
        "/api/system/config/validate",
        "/api/system/config/restart",
        "/api/system/onboarding/preflight",
        "/api/system/onboarding/status",
        "/api/system/onboarding/state",
        "/api/system/onboarding/action",
        "/api/system/onboarding/clients",
        "/api/system/onboarding/startup",
        "/api/system/onboarding/startup/attempt",
        "/api/system/onboarding/startup/validate",
        "/api/system/onboarding/startup/abort",
    }


def test_valid_bearer_injects_identity_on_optional_path(monkeypatch) -> None:
    monkeypatch.setattr(auth_middleware, "verify_token_full", _verify)

    with TestClient(_build_app()) as client:
        response = client.get(
            "/api/system/config",
            headers={"Authorization": "Bearer good-token"},
        )

    assert response.status_code == 200
    assert response.json() == {
        "path": "api/system/config",
        "user_id": "alice",
        "token_kind": "user",
        "device_id": "device-1",
    }


def test_missing_token_reaches_optional_route_without_identity(monkeypatch) -> None:
    monkeypatch.setattr(auth_middleware, "verify_token_full", _verify)

    with TestClient(_build_app()) as client:
        response = client.get("/api/system/config/status")

    assert response.status_code == 200
    assert response.json()["user_id"] is None


def test_invalid_token_reaches_optional_route_without_identity(monkeypatch) -> None:
    monkeypatch.setattr(auth_middleware, "verify_token_full", _verify)

    with TestClient(_build_app()) as client:
        response = client.get(
            "/api/system/config/schema",
            headers={"Authorization": "Bearer bad-token"},
        )

    assert response.status_code == 200
    assert response.json()["user_id"] is None


def test_query_token_is_ignored_on_optional_path(monkeypatch) -> None:
    monkeypatch.setattr(auth_middleware, "verify_token_full", _verify)

    with TestClient(_build_app()) as client:
        response = client.get("/api/system/config?token=good-token")

    assert response.status_code == 200
    assert response.json()["user_id"] is None


def test_other_api_paths_still_require_auth(monkeypatch) -> None:
    monkeypatch.setattr(auth_middleware, "verify_token_full", _verify)

    with TestClient(_build_app()) as client:
        no_token = client.get("/api/screen/session/list")
        query_token = client.get("/api/screen/session/list?token=good-token")
        valid = client.get(
            "/api/screen/session/list",
            headers={"Authorization": "Bearer good-token"},
        )

    assert no_token.status_code == 401
    assert query_token.status_code == 401
    assert valid.status_code == 200
    assert valid.json()["user_id"] == "alice"


# ---------------------------------------------------------------------------
# 主应用接线
# ---------------------------------------------------------------------------


def test_system_config_read_auth_scope_and_public_companion_routes(
    client, auth_headers
) -> None:
    config_response = client.get("/api/system/config", headers=auth_headers)
    anonymous_config = client.get("/api/system/config")
    schema_response = client.get(
        "/api/system/config/schema", headers=auth_headers
    )
    status_response = client.get(
        "/api/system/config/status", headers=auth_headers
    )
    anonymous_schema = client.get("/api/system/config/schema")
    anonymous_status = client.get("/api/system/config/status")
    onboarding_response = client.get("/api/system/onboarding/status")
    onboarding_authed = client.get(
        "/api/system/onboarding/status", headers=auth_headers
    )

    assert config_response.status_code == 200
    assert anonymous_config.status_code == 401
    assert schema_response.status_code == 200
    assert status_response.status_code == 200
    assert anonymous_schema.status_code == 401
    assert anonymous_status.status_code == 401
    assert onboarding_response.status_code == 401
    assert onboarding_authed.status_code == 200
    assert onboarding_authed.json()["needs_setup"] is False


def test_system_config_never_returns_plaintext_secrets(client, auth_headers) -> None:
    response = client.get("/api/system/config", headers=auth_headers)
    assert response.status_code == 200
    payload = response.json()
    masked = payload["config"]

    sensitive_paths = (
        "loom.token",
        "api.mimo_key",
        "api.dashscope_key",
        "opencode.server_password",
        "health.cloud.passtoken",
        "health.cloud.userid",
    )
    store = get_config_store()
    for path in sensitive_paths:
        raw = store.get(path)
        if not isinstance(raw, str) or len(raw) < 6:
            continue
        assert _leaf(masked, path) == "***"
        assert raw not in response.text


def test_config_put_reaches_route_auth_instead_of_middleware_401(client) -> None:
    response = client.put(
        "/api/system/config",
        json={"revision": "any", "changes": {}},
    )

    assert response.status_code == 401
    assert response.json()["code"] == "auth_required"


def test_health_reports_config_status_without_breaking_shape(client) -> None:
    response = client.get("/health")
    payload = response.json()

    assert response.status_code == 200
    assert payload["status"] in {"healthy", "degraded"}
    assert set(payload["config"]) == {"degraded", "revision", "provider"}


# ---------------------------------------------------------------------------
# CORS
# ---------------------------------------------------------------------------


def _leaf(document: Any, path: str) -> Any:
    node = document
    for part in path.split("."):
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node


def test_cors_origins_helper_reflects_configured_ports() -> None:
    fake = SimpleNamespace(BACKEND_HTTP_PORT=19100, BACKEND_HTTPS_PORT=19101)

    origins = main_module._cors_origins_for(fake)

    assert "http://localhost:19100" in origins
    assert "http://127.0.0.1:19100" in origins
    assert "https://localhost:19101" in origins
    assert "https://127.0.0.1:19101" in origins
    assert "http://localhost:5173" in origins
    assert len(origins) == len(set(origins))


def test_cors_refresh_mutates_live_middleware_origin_list(client, monkeypatch) -> None:
    original = list(main_module._cors_origins)
    fake = SimpleNamespace(
        BACKEND_HTTP_PORT=19110,
        BACKEND_HTTPS_PORT=19111,
        AI_BACKEND="opencode",
    )
    try:
        monkeypatch.setattr(main_module, "get_config", lambda: fake)
        refreshed = main_module._refresh_cors(get_config_store())

        assert refreshed == main_module._cors_origins_for(fake)
        assert main_module._cors_origins is not refreshed
        assert main_module._cors_origins == refreshed

        response = client.get(
            "/health", headers={"Origin": "http://localhost:19110"}
        )
        assert response.status_code == 200
        assert (
            response.headers.get("access-control-allow-origin")
            == "http://localhost:19110"
        )
    finally:
        main_module._cors_origins[:] = original


def test_cors_helper_uses_live_config_ports() -> None:
    from main import _cors_origins

    cfg = get_config()
    assert f"http://localhost:{cfg.BACKEND_HTTP_PORT}" in _cors_origins
    assert f"https://127.0.0.1:{cfg.BACKEND_HTTPS_PORT}" in _cors_origins
