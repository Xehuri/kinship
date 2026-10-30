# -*- coding: utf-8 -*-
"""N12 程序化 uvicorn 宿主：进程内重绑监听地址 + TLS 证书轮换。

设计要点（与 uvicorn 0.54.0 实测行为一致）：
- ``Server.serve(sockets=[sock])`` 只跑一次 lifespan；rebind 只替换
  ``server.servers`` 并关闭旧 asyncio.Server，绝不重复 startup/shutdown；
- ``Server.close()`` 只关监听、不断已有连接，因此旧 SSE/WS 连接不会被重绑踢掉；
- TLS 用 ``ssl_context_factory`` 捕获监听 SSLContext，并挂 ``sni_callback``
  在每次新握手时把 ``sslobj.context`` 指向当前活动 context。证书轮换只换
  引用，不重建监听；失败时旧 context 保持原样；
- 端口绑定不走 ``Config.bind_socket()``（失败会 sys.exit），统一手绑
  SO_REUSEADDR(+SO_REUSEPORT) 后交给 asyncio；绑定失败时保留旧监听。
"""

# allow: SIZE_OK - N12 监听生命周期与 uvicorn.Server 状态同文件维护重绑原子性

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import socket
import ssl
import threading
from dataclasses import dataclass
from typing import Any, Callable

import uvicorn
from uvicorn.config import create_ssl_context as _uvicorn_create_ssl_context

from config.config import get_config
from core.runtime_registry import get_hot_server, set_hot_server

logger = logging.getLogger(__name__)

DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 8768
STARTUP_TIMEOUT_S = 60.0
_LISTEN_BACKLOG = 2048


@dataclass(frozen=True, slots=True)
class ListenerSettings:
    """监听参数快照；degraded=True 表示配置读取失败并回退了默认值。"""

    host: str
    port: int
    ssl_enabled: bool
    cert: str
    key: str
    degraded: bool = False
    reason: str = ""


def _can_reuse_port() -> bool:
    return os.name == "posix" and hasattr(socket, "SO_REUSEPORT")


def _normalize_port(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        port = int(value)
    except (TypeError, ValueError):
        return None
    return port if 1 <= port <= 65535 else None


def _tls_ready(cert: str, key: str) -> bool:
    return bool(cert) and bool(key) and os.path.isfile(cert) and os.path.isfile(key)


def _read_tls_signature(cert: str, key: str) -> tuple[int, int, int, int] | None:
    """证书/私钥文件指纹（mtime_ns + size），用于识别同路径原地轮换。"""
    try:
        cert_stat = os.stat(cert)
        key_stat = os.stat(key)
    except OSError:
        return None
    return (
        cert_stat.st_mtime_ns,
        cert_stat.st_size,
        key_stat.st_mtime_ns,
        key_stat.st_size,
    )


def create_listening_socket(
    host: str, port: int, *, reuse_port: bool = False
) -> socket.socket:
    """手绑监听 socket；失败抛 OSError，由调用方决定是否保留旧监听。"""
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    sock = socket.socket(family, socket.SOCK_STREAM)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        if reuse_port and _can_reuse_port():
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
        sock.setblocking(False)
        sock.bind((host, int(port)))
        sock.listen(_LISTEN_BACKLOG)
        return sock
    except Exception:
        sock.close()
        raise


def read_listener_settings() -> ListenerSettings:
    """读取监听参数；配置缺失/损坏时回退默认值而不是让进程起不来。

    N04 之后 get_config() 返回 live facade，本函数每次调用都能看到新值；
    在此之前（lru_cache）也不影响启动正确性。
    """
    try:
        config = get_config()
    except Exception as exc:
        logger.warning(
            "[HotServer] 读取配置失败，回退默认监听 %s:%s（SSL 关闭）: %s",
            DEFAULT_HOST,
            DEFAULT_PORT,
            exc,
        )
        return ListenerSettings(
            DEFAULT_HOST,
            DEFAULT_PORT,
            False,
            "",
            "",
            degraded=True,
            reason=f"{type(exc).__name__}: {exc}",
        )

    try:
        host = str(getattr(config, "BACKEND_HOST", DEFAULT_HOST) or DEFAULT_HOST)
        ssl_requested = bool(getattr(config, "SSL_ENABLED", False))
        cert = str(getattr(config, "SSL_CERT", "") or "")
        key = str(getattr(config, "SSL_KEY", "") or "")
        ssl_enabled = ssl_requested and _tls_ready(cert, key)
        if ssl_requested and not ssl_enabled:
            logger.warning(
                "[HotServer] SSL 已启用但证书/私钥不可用（cert=%r, key=%r），回退 HTTP",
                cert,
                key,
            )
        raw_port = getattr(config, "BACKEND_PORT", DEFAULT_PORT)
        port = _normalize_port(raw_port)
        if port is None:
            logger.warning(
                "[HotServer] BACKEND_PORT 非法（%r），回退 %s", raw_port, DEFAULT_PORT
            )
            port = DEFAULT_PORT
    except Exception as exc:
        logger.warning(
            "[HotServer] 配置属性读取失败，回退默认监听 %s:%s（SSL 关闭）: %s",
            DEFAULT_HOST,
            DEFAULT_PORT,
            exc,
        )
        return ListenerSettings(
            DEFAULT_HOST,
            DEFAULT_PORT,
            False,
            "",
            "",
            degraded=True,
            reason=f"{type(exc).__name__}: {exc}",
        )

    return ListenerSettings(host, port, ssl_enabled, cert, key)


class HotServer:
    """单进程 uvicorn 宿主：lifespan 只跑一次，监听可原地迁移。"""

    def __init__(
        self,
        app: Any = "main:app",
        *,
        host: str | None = None,
        port: int | None = None,
        ssl_enabled: bool | None = None,
        cert: str | None = None,
        key: str | None = None,
        log_level: str = "info",
        startup_timeout: float = STARTUP_TIMEOUT_S,
    ) -> None:
        self._app = app
        self._explicit_host = host
        self._explicit_port = port
        self._explicit_ssl_enabled = ssl_enabled
        self._explicit_cert = cert
        self._explicit_key = key
        self._log_level = log_level
        self._startup_timeout = startup_timeout

        self.config: uvicorn.Config | None = None
        self.server: uvicorn.Server | None = None
        self.host = DEFAULT_HOST
        self.port = DEFAULT_PORT
        self.ssl_enabled = False
        self.cert = ""
        self.key = ""

        self._sockets: list[socket.socket] = []
        self._serve_task: asyncio.Task[None] | None = None
        self._lifecycle_lock: asyncio.Lock | None = None
        self._ssl_lock = threading.Lock()
        self._ssl_build_lock = threading.Lock()
        self._active_ssl_context: ssl.SSLContext | None = None
        self._listener_ssl_context: ssl.SSLContext | None = None
        self._default_ssl_context_factory: Callable[[], ssl.SSLContext] | None = None
        self._tls_signature: tuple[int, int, int, int] | None = None

    # ── 启动 / 停止 ────────────────────────────────────────────────────

    def _resolve_initial_settings(self) -> ListenerSettings:
        needs_config = (
            self._explicit_host is None
            or self._explicit_port is None
            or self._explicit_ssl_enabled is None
            or (
                self._explicit_ssl_enabled
                and (self._explicit_cert is None or self._explicit_key is None)
            )
        )
        if not needs_config:
            cert = self._explicit_cert or ""
            key = self._explicit_key or ""
            ssl_enabled = bool(self._explicit_ssl_enabled) and _tls_ready(cert, key)
            if self._explicit_ssl_enabled and not ssl_enabled:
                logger.warning(
                    "[HotServer] 显式 SSL 已启用但证书/私钥不可用（cert=%r, key=%r），回退 HTTP",
                    cert,
                    key,
                )
            return ListenerSettings(
                str(self._explicit_host), int(self._explicit_port), ssl_enabled, cert, key
            )

        base = read_listener_settings()
        host = self._explicit_host if self._explicit_host is not None else base.host
        port = (
            int(self._explicit_port)
            if self._explicit_port is not None
            else base.port
        )
        ssl_requested = (
            base.ssl_enabled
            if self._explicit_ssl_enabled is None
            else bool(self._explicit_ssl_enabled)
        )
        cert = self._explicit_cert if self._explicit_cert is not None else base.cert
        key = self._explicit_key if self._explicit_key is not None else base.key
        ssl_enabled = ssl_requested and _tls_ready(cert, key)
        if ssl_requested and not ssl_enabled:
            logger.warning(
                "[HotServer] SSL 已启用但证书/私钥不可用（cert=%r, key=%r），回退 HTTP",
                cert,
                key,
            )
        return ListenerSettings(str(host), port, ssl_enabled, cert, key)

    async def start(self) -> None:
        if self.server is not None:
            raise RuntimeError("HotServer 已经启动")

        settings = self._resolve_initial_settings()
        self.host = settings.host
        self.port = settings.port
        self.ssl_enabled = settings.ssl_enabled
        self.cert = settings.cert
        self.key = settings.key
        self._tls_signature = (
            _read_tls_signature(self.cert, self.key) if self.ssl_enabled else None
        )

        config_kwargs: dict[str, Any] = {
            "host": settings.host,
            "port": settings.port,
            "log_level": self._log_level,
            "timeout_graceful_shutdown": 10,
        }
        if settings.ssl_enabled:
            config_kwargs["ssl_certfile"] = settings.cert
            config_kwargs["ssl_keyfile"] = settings.key
            config_kwargs["ssl_context_factory"] = self._ssl_context_factory

        config = uvicorn.Config(self._app, **config_kwargs)
        config.load()
        self.config = config
        self.server = uvicorn.Server(config)
        self._lifecycle_lock = asyncio.Lock()
        set_hot_server(self)

        try:
            sock = create_listening_socket(
                settings.host, settings.port, reuse_port=_can_reuse_port()
            )
        except Exception as exc:
            logger.error(
                "[HotServer] 绑定 %s:%s 失败: %s", settings.host, settings.port, exc
            )
            await self._abort_start()
            raise

        self._sockets = [sock]
        actual_port = int(sock.getsockname()[1])
        if actual_port != self.port:
            self.port = actual_port
            self.config.port = actual_port

        self._serve_task = asyncio.create_task(
            self.server.serve(sockets=[sock]), name="hot-server-serve"
        )
        try:
            await self._wait_started()
        except BaseException as exc:
            if isinstance(exc, Exception):
                logger.error("[HotServer] 启动失败: %s", exc)
            await self._abort_start()
            raise

        logger.info(
            "[HotServer] 已启动 %s://%s:%s（lifespan 单次）",
            "https" if self.ssl_enabled else "http",
            self.host,
            self.port,
        )

    async def _wait_started(self) -> None:
        server = self.server
        task = self._serve_task
        if server is None or task is None:
            raise RuntimeError("HotServer 尚未初始化 serve 任务")
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self._startup_timeout
        while not server.started:
            if task.done():
                exc = task.exception()
                if exc is not None:
                    raise exc
                raise RuntimeError("HotServer 在 startup 完成前退出")
            if loop.time() >= deadline:
                server.should_exit = True
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
                raise TimeoutError(
                    f"HotServer startup 超过 {self._startup_timeout:.0f}s"
                )
            await asyncio.sleep(0.01)

    async def _abort_start(self) -> None:
        if self.server is not None:
            self.server.should_exit = True
        task = self._serve_task
        if task is not None and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        for sock in self._sockets:
            with contextlib.suppress(OSError):
                sock.close()
        self._sockets = []
        self._serve_task = None
        if get_hot_server() is self:
            set_hot_server(None)

    def stop(self) -> None:
        """请求优雅退出：serve 任务返回后 lifespan.shutdown 只执行一次。"""
        if self.server is not None:
            self.server.should_exit = True

    async def wait_stopped(self) -> None:
        task = self._serve_task
        if task is None:
            return
        with contextlib.suppress(asyncio.CancelledError):
            await task

    # ── 重绑监听 ────────────────────────────────────────────────────────

    async def rebind(
        self,
        host: str,
        port: int,
        *,
        ssl_enabled: bool | None = None,
        cert: str | None = None,
        key: str | None = None,
    ) -> dict[str, Any]:
        server = self.server
        config = self.config
        if server is None or config is None or not server.started:
            return {"ok": False, "error": "HotServer 尚未启动"}
        if server.should_exit:
            return {"ok": False, "error": "HotServer 正在退出"}

        lock = self._lifecycle_lock
        if lock is None:
            return {"ok": False, "error": "HotServer 生命周期锁缺失"}

        async with lock:
            target_host = str(host)
            target_port = int(port)
            target_ssl = self.ssl_enabled if ssl_enabled is None else bool(ssl_enabled)
            target_cert = self.cert if cert is None else str(cert)
            target_key = self.key if key is None else str(key)
            if target_ssl and not _tls_ready(target_cert, target_key):
                return {
                    "ok": False,
                    "error": (
                        "TLS 证书/私钥不可用: "
                        f"cert={target_cert!r} key={target_key!r}"
                    ),
                }

            same_endpoint = target_host == self.host and target_port == self.port
            reuse_port = same_endpoint and _can_reuse_port()
            previous = {
                "host": self.host,
                "port": self.port,
                "ssl_enabled": self.ssl_enabled,
            }

            new_sock: socket.socket | None = None
            try:
                new_sock = create_listening_socket(
                    target_host, target_port, reuse_port=reuse_port
                )
                context = await self._resolve_rebind_context(
                    target_ssl, target_cert, target_key
                )
            except Exception as exc:
                if new_sock is not None:
                    with contextlib.suppress(OSError):
                        new_sock.close()
                logger.error(
                    "[HotServer] 重绑 %s:%s 失败，保留旧监听: %s",
                    target_host,
                    target_port,
                    exc,
                )
                return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

            loop = asyncio.get_running_loop()
            try:
                new_server = await loop.create_server(
                    self._protocol_factory,
                    sock=new_sock,
                    ssl=context if target_ssl else None,
                    backlog=config.backlog,
                )
            except Exception as exc:
                with contextlib.suppress(OSError):
                    new_sock.close()
                logger.error(
                    "[HotServer] 创建 asyncio.Server 失败，保留旧监听: %s", exc
                )
                return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

            if server.should_exit:
                new_server.close()
                with contextlib.suppress(OSError):
                    new_sock.close()
                return {"ok": False, "error": "HotServer 正在退出"}

            old_servers = list(server.servers)
            server.servers = [new_server]
            if (
                target_ssl
                and context is not None
                and context is not self._listener_ssl_context
            ):
                self._install_listener_context(context)
            self._sockets = [new_sock]
            actual_port = int(new_sock.getsockname()[1])

            self.host = target_host
            self.port = actual_port
            self.ssl_enabled = target_ssl
            self.cert = target_cert
            self.key = target_key
            self._tls_signature = (
                _read_tls_signature(target_cert, target_key) if target_ssl else None
            )
            config.host = target_host
            config.port = actual_port
            config.ssl = context if target_ssl else None
            config.ssl_certfile = target_cert or None
            config.ssl_keyfile = target_key or None

            # 旧 asyncio.Server 只关监听不踢已有连接；wait_closed() 会等活跃
            # SSE/WS 排空，重绑路径禁止 await。
            for old_server in old_servers:
                old_server.close()

            logger.info(
                "[HotServer] 监听已迁移 %s:%s -> %s:%s（ssl=%s）",
                previous["host"],
                previous["port"],
                self.host,
                self.port,
                self.ssl_enabled,
            )
            return {
                "ok": True,
                "host": self.host,
                "port": self.port,
                "ssl_enabled": self.ssl_enabled,
                "previous": previous,
            }

    async def _resolve_rebind_context(
        self, target_ssl: bool, cert: str, key: str
    ) -> ssl.SSLContext | None:
        if not target_ssl:
            return None
        unchanged = (
            self.ssl_enabled
            and cert == self.cert
            and key == self.key
            and _read_tls_signature(cert, key) == self._tls_signature
        )
        if unchanged and self._listener_ssl_context is not None:
            return self._listener_ssl_context
        return await asyncio.to_thread(self._build_ssl_context_sync, cert, key)

    # ── TLS 证书轮换 ────────────────────────────────────────────────────

    def _ssl_context_factory(
        self,
        _config: uvicorn.Config,
        default_factory: Callable[[], ssl.SSLContext],
    ) -> ssl.SSLContext:
        self._default_ssl_context_factory = default_factory
        context = default_factory()
        self._install_listener_context(context)
        return context

    def _install_listener_context(self, context: ssl.SSLContext) -> None:
        context.sni_callback = self._handle_sni
        with self._ssl_lock:
            self._listener_ssl_context = context
            self._active_ssl_context = context

    def _handle_sni(
        self,
        sslobj: ssl.SSLObject | ssl.SSLSocket,
        _server_name: str | None,
        _context: ssl.SSLContext,
    ) -> None:
        with self._ssl_lock:
            active = self._active_ssl_context
        if active is not None:
            sslobj.context = active
        return None

    def _build_ssl_context_sync(self, cert: str, key: str) -> ssl.SSLContext:
        """后台线程构建 SSLContext；load_cert_chain 同时校验证书与私钥匹配。"""
        if not _tls_ready(cert, key):
            raise FileNotFoundError(
                f"TLS 证书/私钥不可用: cert={cert!r} key={key!r}"
            )
        with self._ssl_build_lock:
            config = self.config
            if config is None:
                raise RuntimeError("HotServer 尚未启动")
            previous = (config.ssl_certfile, config.ssl_keyfile)
            config.ssl_certfile = cert
            config.ssl_keyfile = key
            try:
                factory = self._default_ssl_context_factory
                if factory is not None:
                    return factory()
                return _uvicorn_create_ssl_context(
                    certfile=cert,
                    keyfile=key,
                    password=config.ssl_keyfile_password,
                    ssl_version=config.ssl_version,
                    cert_reqs=config.ssl_cert_reqs,
                    ca_certs=config.ssl_ca_certs,
                    ciphers=config.ssl_ciphers,
                    alpn_protocols=getattr(
                        config.http_protocol_class, "alpn_protocols", None
                    ),
                )
            finally:
                config.ssl_certfile, config.ssl_keyfile = previous

    async def reload_tls(self, cert: str, key: str) -> dict[str, Any]:
        if self.server is None or self.config is None:
            return {"ok": False, "error": "HotServer 尚未启动"}
        lock = self._lifecycle_lock
        if lock is None:
            return {"ok": False, "error": "HotServer 生命周期锁缺失"}

        async with lock:
            try:
                context = await asyncio.to_thread(
                    self._build_ssl_context_sync, cert, key
                )
            except Exception as exc:
                logger.error(
                    "[HotServer] TLS 证书轮换失败，保留现有证书: %s", exc
                )
                return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

            self._install_listener_context(context)
            self.config.ssl = context if self.ssl_enabled else None
            self.config.ssl_certfile = cert
            self.config.ssl_keyfile = key
            self.cert = cert
            self.key = key
            self._tls_signature = (
                _read_tls_signature(cert, key) if self.ssl_enabled else None
            )
            logger.info(
                "[HotServer] TLS 证书已轮换（活动监听=%s）",
                "https" if self.ssl_enabled else "http",
            )
            return {
                "ok": True,
                "ssl_enabled": self.ssl_enabled,
                "cert": cert,
                "key": key,
            }

    # ── 配置联动 ────────────────────────────────────────────────────────

    async def rebind_from_config(self) -> dict[str, Any]:
        """N11 在 ConfigStore 变更后调用：按实时配置迁移监听/轮换证书。"""
        if self.server is None or not self.server.started:
            return {"ok": False, "error": "HotServer 尚未启动"}

        settings = read_listener_settings()
        endpoint_changed = (settings.host, settings.port) != (self.host, self.port)
        tls_toggled = settings.ssl_enabled != self.ssl_enabled

        if endpoint_changed or tls_toggled:
            result = await self.rebind(
                settings.host,
                settings.port,
                ssl_enabled=settings.ssl_enabled,
                cert=settings.cert or None,
                key=settings.key or None,
            )
            if result.get("ok"):
                result["changed"] = True
            return result

        cert_changed = (settings.cert, settings.key) != (self.cert, self.key)
        signature_changed = (
            settings.ssl_enabled
            and _read_tls_signature(settings.cert, settings.key)
            != self._tls_signature
        )
        if settings.ssl_enabled and (cert_changed or signature_changed):
            result = await self.reload_tls(settings.cert, settings.key)
            result["changed"] = bool(result.get("ok"))
            return result

        return {
            "ok": True,
            "changed": False,
            "host": self.host,
            "port": self.port,
            "ssl_enabled": self.ssl_enabled,
        }

    # ── uvicorn 协议工厂 ────────────────────────────────────────────────

    def _protocol_factory(
        self, _loop: asyncio.AbstractEventLoop | None = None
    ) -> asyncio.Protocol:
        config = self.config
        server = self.server
        if config is None or server is None:
            raise RuntimeError("HotServer 尚未启动")
        return config.http_protocol_class(
            config=config,
            server_state=server.server_state,
            app_state=server.lifespan.state,
            _loop=_loop,
        )


async def run_hot_server() -> None:
    server = HotServer()
    await server.start()
    try:
        await server.wait_stopped()
    finally:
        server.stop()


def main() -> None:
    asyncio.run(run_hot_server())


if __name__ == "__main__":
    main()
