# -*- coding: utf-8 -*-
"""N12 程序化 uvicorn HotServer 契约。

钉住：
  (a) 手动 bind 助手：SO_REUSEADDR 生效，端口被占时二次 bind 报错，POSIX 下
      SO_REUSEPORT 允许同 host:port 双监听（零间隙重绑的前提）；
  (b) 一次 serve 只跑一次 lifespan：start 后 rebind 到新端口，startup/shutdown
      计数仍为 1/0，旧端口拒绝连接、新端口 200；
  (c) rebind 失败（目标端口被无 reuse 的监听占用）时旧监听继续服务；
  (d) TLS 证书轮换：SNI 回调把新连接切到新 SSLContext，旧连接不被踢；
  (e) POSIX 同 host:port HTTP<->HTTPS 切换不重启进程、不重跑 lifespan；
  (f) 配置缺失/降级时监听参数回退 0.0.0.0:8768 + SSL off，不抛错；
  (g) rebind_from_config 读实时配置并迁移监听。

零生产端口（8768/8769）、零真实 main:app：全部 127.0.0.1:0 或临时空闲端口。
本 venv 无 pytest-asyncio，统一 asyncio.run 同步驱动。
"""

from __future__ import annotations

import asyncio
import hashlib
import http.client
import os
import shutil
import socket
import ssl
import subprocess
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI

import core.hot_server as hot_server
from core.hot_server import (
    HotServer,
    create_listening_socket,
    get_hot_server,
    read_listener_settings,
)

# ── 测试脚手架 ───────────────────────────────────────────────────────────


def _make_app() -> tuple[FastAPI, dict[str, int]]:
    """最小 ASGI app：只提供 /health 和可计数的 lifespan。"""
    counts = {"startup": 0, "shutdown": 0}

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        counts["startup"] += 1
        try:
            yield
        finally:
            counts["shutdown"] += 1

    app = FastAPI(lifespan=lifespan)

    @app.get("/health")
    async def health() -> dict[str, bool]:
        return {"ok": True}

    return app, counts


def _free_port() -> int:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])
    finally:
        sock.close()


def _http_status(port: int, *, scheme: str = "http", timeout: float = 5.0) -> int:
    if scheme == "https":
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        conn: http.client.HTTPConnection = http.client.HTTPSConnection(
            "127.0.0.1", port, timeout=timeout, context=context
        )
    else:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        conn.request("GET", "/health")
        response = conn.getresponse()
        response.read()
        return int(response.status)
    finally:
        conn.close()


def _open_keep_alive(port: int) -> http.client.HTTPConnection:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    conn.request("GET", "/health")
    response = conn.getresponse()
    response.read()
    assert response.status == 200
    return conn


def _reuse_keep_alive(conn: http.client.HTTPConnection) -> tuple[int, bytes]:
    conn.request("GET", "/health")
    response = conn.getresponse()
    body = response.read()
    return int(response.status), body


def _assert_connection_refused(port: int) -> None:
    with pytest.raises(OSError):
        socket.create_connection(("127.0.0.1", port), timeout=1.0).close()


def _der_sha256(der: bytes) -> str:
    return hashlib.sha256(der).hexdigest()


def _cert_file_sha256(path: str) -> str:
    pem = Path(path).read_text(encoding="ascii")
    return _der_sha256(ssl.PEM_cert_to_DER_cert(pem))


def _peer_cert_sha256(port: int, server_hostname: str | None = "localhost") -> str:
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    with socket.create_connection(("127.0.0.1", port), timeout=5.0) as raw:
        with context.wrap_socket(raw, server_hostname=server_hostname) as tls:
            der = tls.getpeercert(binary_form=True)
    assert der, "服务端没有返回证书"
    return _der_sha256(der)


def _open_tls_connection(port: int) -> ssl.SSLSocket:
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    raw = socket.create_connection(("127.0.0.1", port), timeout=5.0)
    try:
        return context.wrap_socket(raw, server_hostname="localhost")
    except Exception:
        raw.close()
        raise


def _tls_http_get(sock: ssl.SSLSocket) -> bytes:
    sock.sendall(b"GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
    received = b""
    while True:
        chunk = sock.recv(4096)
        if not chunk:
            return received
        received += chunk


def _write_self_signed_cert(tmp_path: Path, stem: str, common_name: str) -> tuple[str, str]:
    if shutil.which("openssl") is None:
        pytest.skip("openssl 不可用，跳过 TLS 实链测试")
    cert = tmp_path / f"{stem}.crt"
    key = tmp_path / f"{stem}.key"
    subprocess.run(
        [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            str(key),
            "-out",
            str(cert),
            "-days",
            "1",
            "-subj",
            f"/CN={common_name}",
            "-addext",
            "subjectAltName=DNS:localhost,DNS:"
            + common_name
            + ",IP:127.0.0.1",
        ],
        check=True,
        capture_output=True,
        timeout=60,
    )
    return str(cert), str(key)


class _FakeConfig:
    """只承载监听参数读取面，绝不触碰真实 config.yaml。"""

    def __init__(self, **values: Any):
        self.BACKEND_HOST = values.get("BACKEND_HOST", "127.0.0.1")
        self.BACKEND_PORT = values.get("BACKEND_PORT", 9443)
        self.BACKEND_HTTPS_PORT = values.get("BACKEND_HTTPS_PORT", 9080)
        self.BACKEND_HTTP_PORT = values.get("BACKEND_HTTP_PORT", 9081)
        self.SSL_ENABLED = values.get("SSL_ENABLED", False)
        self.SSL_CERT = values.get("SSL_CERT", "")
        self.SSL_KEY = values.get("SSL_KEY", "")


# ── socket 助手 ──────────────────────────────────────────────────────────


def test_create_listening_socket_sets_reuseaddr_and_ephemeral_port() -> None:
    sock = create_listening_socket("127.0.0.1", 0)
    try:
        host, port = sock.getsockname()[:2]
        assert host == "127.0.0.1"
        assert int(port) > 0
        assert sock.getsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR) != 0
        assert sock.getblocking() is False
    finally:
        sock.close()


def test_create_listening_socket_rejects_busy_port_without_reuse_port() -> None:
    first = create_listening_socket("127.0.0.1", 0)
    try:
        port = int(first.getsockname()[1])
        with pytest.raises(OSError):
            create_listening_socket("127.0.0.1", port)
    finally:
        first.close()


@pytest.mark.skipif(os.name != "posix", reason="SO_REUSEPORT 仅 POSIX 可用")
def test_create_listening_socket_reuse_port_allows_same_endpoint() -> None:
    first = create_listening_socket("127.0.0.1", 0, reuse_port=True)
    second: socket.socket | None = None
    try:
        port = int(first.getsockname()[1])
        second = create_listening_socket("127.0.0.1", port, reuse_port=True)
        assert int(second.getsockname()[1]) == port
    finally:
        if second is not None:
            second.close()
        first.close()


# ── 配置读取与降级 ───────────────────────────────────────────────────────


def test_read_listener_settings_falls_back_when_config_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _boom() -> _FakeConfig:
        raise FileNotFoundError("config.yaml 不存在")

    monkeypatch.setattr(hot_server, "get_config", _boom)
    settings = read_listener_settings()
    assert settings.host == "0.0.0.0"
    assert settings.port == 8768
    assert settings.ssl_enabled is False
    assert settings.degraded is True


def test_read_listener_settings_uses_single_port_when_tls_ready(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cert = tmp_path / "cert.pem"
    key = tmp_path / "key.pem"
    cert.write_text("placeholder", encoding="utf-8")
    key.write_text("placeholder", encoding="utf-8")
    config = _FakeConfig(
        SSL_ENABLED=True, SSL_CERT=str(cert), SSL_KEY=str(key), BACKEND_PORT=9443
    )
    monkeypatch.setattr(hot_server, "get_config", lambda: config)

    settings = read_listener_settings()
    assert settings.host == "127.0.0.1"
    assert settings.port == 9443
    assert settings.ssl_enabled is True
    assert settings.degraded is False


def test_read_listener_settings_keeps_single_port_when_cert_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = _FakeConfig(
        SSL_ENABLED=True, SSL_CERT="", SSL_KEY="", BACKEND_PORT=9080
    )
    monkeypatch.setattr(hot_server, "get_config", lambda: config)

    settings = read_listener_settings()
    assert settings.port == 9080
    assert settings.ssl_enabled is False


def test_read_listener_settings_ignores_legacy_port_attributes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = _FakeConfig(
        BACKEND_PORT=9123, BACKEND_HTTPS_PORT=9443, BACKEND_HTTP_PORT=9080
    )
    monkeypatch.setattr(hot_server, "get_config", lambda: config)

    settings = read_listener_settings()
    assert settings.port == 9123


def test_read_listener_settings_rejects_invalid_port(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = _FakeConfig(SSL_ENABLED=False, BACKEND_PORT="not-a-port")
    monkeypatch.setattr(hot_server, "get_config", lambda: config)

    settings = read_listener_settings()
    assert settings.port == 8768


# ── 启动 / 重绑 ──────────────────────────────────────────────────────────


def test_start_then_rebind_moves_listener_without_rerunning_lifespan() -> None:
    async def scenario() -> None:
        app, counts = _make_app()
        server = HotServer(app, host="127.0.0.1", port=0, ssl_enabled=False)
        await server.start()
        try:
            assert get_hot_server() is server
            first_port = server.port
            assert await asyncio.to_thread(_http_status, first_port) == 200
            assert counts == {"startup": 1, "shutdown": 0}

            second_port = _free_port()
            result = await server.rebind("127.0.0.1", second_port, ssl_enabled=False)
            assert result["ok"] is True, result
            assert server.port == second_port
            await asyncio.to_thread(_assert_connection_refused, first_port)
            assert await asyncio.to_thread(_http_status, second_port) == 200
            assert counts == {"startup": 1, "shutdown": 0}
        finally:
            server.stop()
            await asyncio.wait_for(server.wait_stopped(), timeout=10)
        assert counts == {"startup": 1, "shutdown": 1}

    asyncio.run(asyncio.wait_for(scenario(), timeout=60))


def test_rebind_keeps_existing_keep_alive_connection() -> None:
    async def scenario() -> None:
        app, counts = _make_app()
        server = HotServer(app, host="127.0.0.1", port=0, ssl_enabled=False)
        await server.start()
        conn = await asyncio.to_thread(_open_keep_alive, server.port)
        try:
            first_port = server.port
            second_port = _free_port()
            result = await server.rebind("127.0.0.1", second_port, ssl_enabled=False)
            assert result["ok"] is True, result

            status, body = await asyncio.to_thread(_reuse_keep_alive, conn)
            assert status == 200
            assert body == b'{"ok":true}'
            await asyncio.to_thread(_assert_connection_refused, first_port)
            assert await asyncio.to_thread(_http_status, second_port) == 200
            assert counts == {"startup": 1, "shutdown": 0}
        finally:
            conn.close()
            server.stop()
            await asyncio.wait_for(server.wait_stopped(), timeout=10)
        assert counts == {"startup": 1, "shutdown": 1}

    asyncio.run(asyncio.wait_for(scenario(), timeout=60))


def test_failed_rebind_keeps_previous_listener() -> None:
    blocker = create_listening_socket("127.0.0.1", 0)
    try:
        busy_port = int(blocker.getsockname()[1])

        async def scenario() -> None:
            app, counts = _make_app()
            server = HotServer(app, host="127.0.0.1", port=0, ssl_enabled=False)
            await server.start()
            try:
                first_port = server.port
                result = await server.rebind("127.0.0.1", busy_port, ssl_enabled=False)
                assert result["ok"] is False
                assert result["error"]
                assert server.port == first_port
                assert await asyncio.to_thread(_http_status, first_port) == 200
                assert counts == {"startup": 1, "shutdown": 0}
            finally:
                server.stop()
                await asyncio.wait_for(server.wait_stopped(), timeout=10)

        asyncio.run(asyncio.wait_for(scenario(), timeout=60))
    finally:
        blocker.close()


def test_rebind_from_config_reads_live_listener_settings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    second_port = _free_port()
    config = _FakeConfig(SSL_ENABLED=False, BACKEND_PORT=second_port)
    monkeypatch.setattr(hot_server, "get_config", lambda: config)

    async def scenario() -> None:
        app, counts = _make_app()
        server = HotServer(app, host="127.0.0.1", port=0, ssl_enabled=False)
        await server.start()
        try:
            first_port = server.port
            result = await server.rebind_from_config()
            assert result["ok"] is True, result
            assert server.port == second_port
            await asyncio.to_thread(_assert_connection_refused, first_port)
            assert await asyncio.to_thread(_http_status, second_port) == 200
            assert counts["startup"] == 1
        finally:
            server.stop()
            await asyncio.wait_for(server.wait_stopped(), timeout=10)

    asyncio.run(asyncio.wait_for(scenario(), timeout=60))


# ── TLS ──────────────────────────────────────────────────────────────────


def test_reload_tls_switches_new_handshakes_without_killing_old_connection(
    tmp_path: Path,
) -> None:
    cert_a, key_a = _write_self_signed_cert(tmp_path, "cert-a", "a.example")
    cert_b, key_b = _write_self_signed_cert(tmp_path, "cert-b", "b.example")
    expected_a = _cert_file_sha256(cert_a)
    expected_b = _cert_file_sha256(cert_b)

    async def scenario() -> None:
        app, counts = _make_app()
        server = HotServer(
            app,
            host="127.0.0.1",
            port=0,
            ssl_enabled=True,
            cert=cert_a,
            key=key_a,
        )
        await server.start()
        old_conn = await asyncio.to_thread(_open_tls_connection, server.port)
        try:
            assert await asyncio.to_thread(_peer_cert_sha256, server.port) == expected_a

            result = await server.reload_tls(cert_b, key_b)
            assert result["ok"] is True, result
            assert server.cert == cert_b
            assert server.key == key_b

            assert await asyncio.to_thread(_peer_cert_sha256, server.port) == expected_b
            assert (
                await asyncio.to_thread(_peer_cert_sha256, server.port, None)
                == expected_b
            )

            received = await asyncio.to_thread(_tls_http_get, old_conn)
            assert b"200" in received.split(b"\r\n", 1)[0]
            assert counts == {"startup": 1, "shutdown": 0}
        finally:
            old_conn.close()
            server.stop()
            await asyncio.wait_for(server.wait_stopped(), timeout=10)
        assert counts == {"startup": 1, "shutdown": 1}

    asyncio.run(asyncio.wait_for(scenario(), timeout=60))


def test_reload_tls_failure_keeps_live_certificate(tmp_path: Path) -> None:
    cert_a, key_a = _write_self_signed_cert(tmp_path, "cert-a", "a.example")
    expected_a = _cert_file_sha256(cert_a)
    bad_cert = tmp_path / "bad.crt"
    bad_cert.write_text("not a certificate", encoding="utf-8")

    async def scenario() -> None:
        app, _counts = _make_app()
        server = HotServer(
            app,
            host="127.0.0.1",
            port=0,
            ssl_enabled=True,
            cert=cert_a,
            key=key_a,
        )
        await server.start()
        try:
            result = await server.reload_tls(str(bad_cert), key_a)
            assert result["ok"] is False
            assert result["error"]
            assert await asyncio.to_thread(_peer_cert_sha256, server.port) == expected_a
        finally:
            server.stop()
            await asyncio.wait_for(server.wait_stopped(), timeout=10)

    asyncio.run(asyncio.wait_for(scenario(), timeout=60))


def test_rebind_from_config_reloads_tls_on_same_path_content_change(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cert_a, key_a = _write_self_signed_cert(tmp_path, "cert-a", "a.example")
    cert_b, key_b = _write_self_signed_cert(tmp_path, "cert-b", "b.example")
    expected_a = _cert_file_sha256(cert_a)
    expected_b = _cert_file_sha256(cert_b)

    async def scenario() -> None:
        app, _counts = _make_app()
        server = HotServer(
            app,
            host="127.0.0.1",
            port=0,
            ssl_enabled=True,
            cert=cert_a,
            key=key_a,
        )
        await server.start()
        try:
            assert await asyncio.to_thread(_peer_cert_sha256, server.port) == expected_a
            config = _FakeConfig(
                BACKEND_HOST="127.0.0.1",
                BACKEND_PORT=server.port,
                SSL_ENABLED=True,
                SSL_CERT=cert_a,
                SSL_KEY=key_a,
            )
            monkeypatch.setattr(hot_server, "get_config", lambda: config)

            Path(cert_a).write_bytes(Path(cert_b).read_bytes())
            Path(key_a).write_bytes(Path(key_b).read_bytes())

            reloads: list[tuple[str, str]] = []
            original = server.reload_tls

            async def _spy(cert: str, key: str) -> dict[str, Any]:
                reloads.append((cert, key))
                return await original(cert, key)

            monkeypatch.setattr(server, "reload_tls", _spy)

            result = await server.rebind_from_config()

            assert result["ok"] is True, result
            assert result["changed"] is True
            assert reloads == [(cert_a, key_a)]
            assert await asyncio.to_thread(_peer_cert_sha256, server.port) == expected_b
        finally:
            server.stop()
            await asyncio.wait_for(server.wait_stopped(), timeout=10)

    asyncio.run(asyncio.wait_for(scenario(), timeout=60))


@pytest.mark.skipif(sys.platform == "win32", reason="SO_REUSEPORT 同端口切换仅 POSIX")
def test_same_port_http_https_toggle_single_lifespan(tmp_path: Path) -> None:
    cert, key = _write_self_signed_cert(tmp_path, "cert-toggle", "toggle.example")

    async def scenario() -> None:
        app, counts = _make_app()
        server = HotServer(app, host="127.0.0.1", port=0, ssl_enabled=False)
        await server.start()
        try:
            port = server.port
            assert await asyncio.to_thread(_http_status, port) == 200

            enabled = await server.rebind(
                "127.0.0.1", port, ssl_enabled=True, cert=cert, key=key
            )
            assert enabled["ok"] is True, enabled
            assert server.ssl_enabled is True
            assert await asyncio.to_thread(_http_status, port, scheme="https") == 200

            disabled = await server.rebind("127.0.0.1", port, ssl_enabled=False)
            assert disabled["ok"] is True, disabled
            assert server.ssl_enabled is False
            assert await asyncio.to_thread(_http_status, port) == 200
            assert counts == {"startup": 1, "shutdown": 0}
        finally:
            server.stop()
            await asyncio.wait_for(server.wait_stopped(), timeout=10)
        assert counts == {"startup": 1, "shutdown": 1}

    asyncio.run(asyncio.wait_for(scenario(), timeout=60))
