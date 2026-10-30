# -*- coding: utf-8 -*-
"""MOSS 只读校验：外部 vLLM 可达性、模型匹配与错误信封。"""

from __future__ import annotations

import asyncio
import json
import logging
import socket
from contextlib import asynccontextmanager
from typing import Any

import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer

from config.config import Config
from services import moss_client


MODEL = "moss-audio-4b"


def _run(coro):
    return asyncio.run(coro)


def _cfg(**moss: Any) -> Config:
    return Config({"moss": moss})


@asynccontextmanager
async def _serve(handler):
    app = web.Application()
    app.router.add_get("/v1/models", handler)
    server = TestServer(app)
    await server.start_server()
    try:
        yield str(server.make_url("")).rstrip("/")
    finally:
        await server.close()


def _closed_port() -> int:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


class TestValidate:
    def test_200_model_found_sends_no_credentials(self):
        seen_headers: list[dict[str, str]] = []

        async def handler(request):
            seen_headers.append({key.lower(): value for key, value in request.headers.items()})
            return web.json_response(
                {
                    "object": "list",
                    "data": [
                        {"id": MODEL, "object": "model", "api_key": "RESPONSE-SECRET"}
                    ],
                }
            )

        async def scenario():
            async with _serve(handler) as base:
                result = await moss_client.validate(base, MODEL, timeout=1.0)
                assert result["reachable"] is True
                assert result["model_found"] is True
                assert result["models"] == [MODEL]
                assert result["matched_model"] == MODEL
                assert result["latency_ms"] >= 0
                assert result["loopback"] is True
                assert result["warnings"] == []
                assert result["error"] is None
                assert "authorization" not in seen_headers[0]
                assert "cookie" not in seen_headers[0]
                assert "RESPONSE-SECRET" not in json.dumps(result)

        asyncio.run(scenario())

    def test_defaults_come_from_config(self, monkeypatch):
        seen: list[tuple[str, str]] = []

        async def fake_fetch(base_url, timeout):
            seen.append((base_url, timeout))
            return 200, {"data": [{"id": MODEL}]}

        monkeypatch.setattr(moss_client, "_fetch_models", fake_fetch)
        config = _cfg(
            base_url="http://127.0.0.1:9100", model="moss-audio-4b"
        )

        result = _run(moss_client.validate(config=config))

        assert result["base_url"] == "http://127.0.0.1:9100"
        assert result["model"] == MODEL
        assert result["model_found"] is True
        assert seen[0][0] == "http://127.0.0.1:9100"

    def test_v1_suffixes_are_normalized(self, monkeypatch):
        seen: list[str] = []

        async def fake_fetch(base_url, timeout):
            seen.append(base_url)
            return 200, {"data": [{"id": MODEL}]}

        monkeypatch.setattr(moss_client, "_fetch_models", fake_fetch)

        for raw in (
            "http://127.0.0.1:8100/v1",
            "http://127.0.0.1:8100/v1/",
            "http://127.0.0.1:8100/v1/models",
        ):
            result = _run(moss_client.validate(raw, MODEL))
            assert result["base_url"] == "http://127.0.0.1:8100"
            assert result["model_found"] is True

        assert seen == ["http://127.0.0.1:8100"] * 3

    def test_wrong_model_lists_available_models(self):
        async def handler(request):
            return web.json_response(
                {"object": "list", "data": [{"id": "other-model"}]}
            )

        async def scenario():
            async with _serve(handler) as base:
                result = await moss_client.validate(base, MODEL, timeout=1.0)
                assert result["reachable"] is True
                assert result["model_found"] is False
                assert result["models"] == ["other-model"]
                assert result["error"]["code"] == "model_not_found"
                assert "other-model" in result["error"]["message"]

        asyncio.run(scenario())

    def test_accepts_canonical_moss_alias(self):
        async def handler(request):
            return web.json_response(
                {"object": "list", "data": [{"id": "MOSS-Audio-4B-Instruct"}]}
            )

        async def scenario():
            async with _serve(handler) as base:
                result = await moss_client.validate(base, MODEL, timeout=1.0)
                assert result["reachable"] is True
                assert result["model_found"] is True
                assert result["matched_model"] == "MOSS-Audio-4B-Instruct"

        asyncio.run(scenario())

    def test_timeout_is_reported_as_unreachable_with_actionable_message(self):
        async def handler(request):
            await asyncio.sleep(0.2)
            return web.json_response({"data": [{"id": MODEL}]})

        async def scenario():
            async with _serve(handler) as base:
                result = await moss_client.validate(base, MODEL, timeout=0.05)
                assert result["reachable"] is False
                assert result["model_found"] is False
                assert result["error"]["code"] == "moss_timeout"
                assert "vLLM" in result["error"]["message"]
                assert "冷启动" in result["error"]["message"]

        asyncio.run(scenario())

    def test_connection_refused_is_reported_as_unreachable(self):
        async def scenario():
            result = await moss_client.validate(
                f"http://127.0.0.1:{_closed_port()}", MODEL, timeout=0.5
            )
            assert result["reachable"] is False
            assert result["model_found"] is False
            assert result["error"]["code"] == "moss_unreachable"
            assert "vLLM" in result["error"]["message"]

        asyncio.run(scenario())

    def test_non_loopback_returns_warning_but_still_validates(self, monkeypatch):
        async def fake_fetch(base_url, timeout):
            return 200, {"data": [{"id": MODEL}]}

        monkeypatch.setattr(moss_client, "_fetch_models", fake_fetch)

        result = _run(
            moss_client.validate("http://192.0.2.10:8100", MODEL, timeout=1.0)
        )

        assert result["reachable"] is True
        assert result["model_found"] is True
        assert result["loopback"] is False
        assert any("TLS" in warning and "API Key" in warning for warning in result["warnings"])

    @pytest.mark.parametrize(
        "base_url",
        ["http://127.0.0.1:8100", "http://localhost:8100", "http://[::1]:8100"],
    )
    def test_loopback_hosts_are_recognised(self, base_url, monkeypatch):
        async def fake_fetch(url, timeout):
            return 200, {"data": [{"id": MODEL}]}

        monkeypatch.setattr(moss_client, "_fetch_models", fake_fetch)
        result = _run(moss_client.validate(base_url, MODEL))
        assert result["loopback"] is True
        assert result["warnings"] == []

    def test_url_credentials_are_rejected_and_not_echoed(self):
        result = _run(
            moss_client.validate(
                "http://user:super-secret@127.0.0.1:8100", MODEL
            )
        )
        assert result["reachable"] is False
        assert result["error"]["code"] == "invalid_base_url"
        serialized = json.dumps(result, ensure_ascii=False)
        assert "super-secret" not in serialized
        assert "user:" not in serialized

    def test_invalid_scheme_and_empty_url_are_rejected(self):
        for raw in ("ftp://127.0.0.1:8100", "", "http://127.0.0.1:99999"):
            result = _run(moss_client.validate(raw, MODEL))
            assert result["reachable"] is False
            assert result["error"]["code"] == "invalid_base_url"

    def test_http_error_body_is_not_returned_or_logged(self, caplog):
        async def handler(request):
            return web.Response(
                status=500, text='{"error": "SECRET-LOG-TOKEN"}'
            )

        async def scenario():
            async with _serve(handler) as base:
                with caplog.at_level(logging.INFO):
                    result = await moss_client.validate(base, MODEL, timeout=1.0)
                assert result["reachable"] is True
                assert result["model_found"] is False
                assert result["error"]["code"] == "moss_http_error"
                assert "SECRET-LOG-TOKEN" not in json.dumps(result)
                assert "SECRET-LOG-TOKEN" not in caplog.text

        asyncio.run(scenario())
