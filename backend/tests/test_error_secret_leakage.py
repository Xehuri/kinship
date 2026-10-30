# -*- coding: utf-8 -*-
"""错误路径与校验日志的密钥泄漏防护测试。"""

import asyncio
import json
import logging
from types import SimpleNamespace

from starlette.exceptions import HTTPException as StarletteHTTPException

from core.errors import (
    http_exception_handler,
    unhandled_exception_handler,
)


def _request(method: str, path: str) -> SimpleNamespace:
    return SimpleNamespace(method=method, url=SimpleNamespace(path=path))


def test_config_validation_error_does_not_leak_credentials(client, caplog):
    caplog.set_level(logging.DEBUG)
    caplog.clear()
    secrets = (
        "password-SECRET",
        "service-token-SECRET",
        "loom-SECRET",
    )
    payload = {
        "current_password": secrets[0],
        "changes": {
            "ai": {
                "loom": {
                    "service_token": secrets[1],
                    "token": secrets[2],
                }
            }
        },
    }

    response = client.put("/api/system/config", json=payload)

    assert response.status_code == 422
    for secret in secrets:
        assert secret not in response.text
        assert secret not in caplog.text


def test_http_exception_handler_redacts_detail_secrets():
    exc = StarletteHTTPException(
        status_code=400,
        detail="upstream failed ?token=QUERY-SECRET sk-live-DETAIL-SECRET",
    )

    response = asyncio.run(http_exception_handler(_request("GET", "/api/x"), exc))
    text = response.body.decode()

    assert "QUERY-SECRET" not in text
    assert "sk-live-DETAIL-SECRET" not in text
    payload = json.loads(text)
    assert payload["error"]["message"].startswith("upstream failed")


def test_unhandled_exception_handler_redacts_traceback(caplog):
    caplog.set_level(logging.ERROR, logger="core.errors")
    try:
        raise RuntimeError(
            "boom sk-live-EXC-SECRET ?token=TRACE-SECRET"
        )
    except RuntimeError as exc:
        response = asyncio.run(
            unhandled_exception_handler(_request("POST", "/api/x"), exc)
        )

    assert response.status_code == 500
    assert "sk-live-EXC-SECRET" not in caplog.text
    assert "TRACE-SECRET" not in caplog.text
    assert "boom" in caplog.text
