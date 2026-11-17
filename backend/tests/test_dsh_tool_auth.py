# -*- coding: utf-8 -*-
"""dsh 工具回调凭据推送：base_url 推导、token 缺失短路、成败/脱敏、合并调度。

全部离线：bridge 传输一律 monkeypatch（``DshClient.push_tool_auth`` 或
``services.dsh_tool_auth.push_tool_auth`` 记录器），不发真实 HTTP；监听参数经
``core.hot_server.get_config`` 的桩注入（https/http 推导走真实监听判定）。
本 venv 无 pytest-asyncio，async 统一 asyncio.run 驱动（与 test_dsh_paths 同款）。
"""
from __future__ import annotations

import asyncio
import logging
from types import SimpleNamespace
from typing import Any, Callable, Dict, List

import pytest

import auth
import core.hot_server as hot_server
import main as main_module
import services.dsh_health as dsh_health
import services.dsh_tool_auth as dsh_tool_auth
from config.store import ConfigChange
from services.config_reconciler import apply_ai_surface
from services.dsh_client import DshClient

_PAYLOAD_FIELDS = {"schema", "base_url", "token", "source", "generated_at"}
_SERVICE_TOKEN = "svc-token-0123456789abcdef"


def _reset_health() -> None:
    dsh_health._STATE.update(
        {"status": "unknown", "version": None, "session_id": None, "checked_at": None}
    )
    dsh_health._last_status = None
    dsh_health._last_log_at = 0.0


@pytest.fixture(autouse=True)
def _clean_state():
    dsh_tool_auth._reset_state()
    _reset_health()
    yield
    dsh_tool_auth._reset_state()
    _reset_health()


def _patch_listener(
    monkeypatch,
    *,
    port: Any = 8768,
    ssl_enabled: bool = False,
    cert: str = "",
    key: str = "",
) -> SimpleNamespace:
    """替换 hot_server 的配置源，驱动真实的监听参数（端口/TLS 回退）判定。"""
    stub = SimpleNamespace(
        BACKEND_HOST="0.0.0.0",
        BACKEND_PORT=port,
        SSL_ENABLED=ssl_enabled,
        SSL_CERT=cert,
        SSL_KEY=key,
    )
    monkeypatch.setattr(hot_server, "get_config", lambda: stub)
    return stub


def _patch_token(monkeypatch, token: Any) -> None:
    """注入 service token 来源（production 走 auth.ensure_service_token）。"""
    monkeypatch.setattr(auth, "ensure_service_token", lambda: token)


def _recorder(store: List[str]) -> Callable[[str], None]:
    def _record(reason: str) -> None:
        store.append(reason)

    return _record


def _ai_change(old: str | None, new: str | None) -> ConfigChange:
    return ConfigChange(
        old={"ai_backend": old} if old else {},
        new={"ai_backend": new} if new else {},
        changed_paths=("ai_backend",),
    )


def _tls_files(tmp_path) -> tuple[str, str]:
    cert = tmp_path / "cert.pem"
    key = tmp_path / "key.pem"
    cert.write_text("dummy-cert", encoding="utf-8")
    key.write_text("dummy-key", encoding="utf-8")
    return str(cert), str(key)


# ---------------------------------------------------------------------------
# 载荷构造：base_url 推导
# ---------------------------------------------------------------------------


def test_build_payload_http_and_shape(monkeypatch) -> None:
    _patch_listener(monkeypatch)
    _patch_token(monkeypatch, _SERVICE_TOKEN)

    payload = dsh_tool_auth.build_tool_auth_payload()

    assert set(payload) == _PAYLOAD_FIELDS
    assert payload["schema"] == dsh_tool_auth.PAYLOAD_SCHEMA == 1
    assert payload["base_url"] == "http://127.0.0.1:8768"
    assert payload["token"] == _SERVICE_TOKEN
    assert payload["source"] == "kinship-backend"
    assert isinstance(payload["generated_at"], int)
    assert payload["generated_at"] > 0


def test_base_url_uses_https_when_tls_ready(monkeypatch, tmp_path) -> None:
    cert, key = _tls_files(tmp_path)
    _patch_listener(monkeypatch, port=9443, ssl_enabled=True, cert=cert, key=key)
    _patch_token(monkeypatch, _SERVICE_TOKEN)

    payload = dsh_tool_auth.build_tool_auth_payload()

    assert payload["base_url"] == "https://127.0.0.1:9443"


def test_base_url_falls_back_to_http_when_tls_files_missing(
    monkeypatch, tmp_path
) -> None:
    """ssl.enabled=true 但私钥文件不存在：与 hot_server 一致的 HTTP 回退。"""
    cert, _ = _tls_files(tmp_path)
    missing_key = str(tmp_path / "missing-key.pem")
    _patch_listener(monkeypatch, ssl_enabled=True, cert=cert, key=missing_key)
    _patch_token(monkeypatch, _SERVICE_TOKEN)

    payload = dsh_tool_auth.build_tool_auth_payload()

    assert payload["base_url"] == "http://127.0.0.1:8768"


def test_base_url_http_when_ssl_disabled_even_if_files_exist(
    monkeypatch, tmp_path
) -> None:
    cert, key = _tls_files(tmp_path)
    _patch_listener(monkeypatch, ssl_enabled=False, cert=cert, key=key)
    _patch_token(monkeypatch, _SERVICE_TOKEN)

    payload = dsh_tool_auth.build_tool_auth_payload()

    assert payload["base_url"] == "http://127.0.0.1:8768"


@pytest.mark.parametrize("bad_port", [0, 70000, "not-a-number", True])
def test_base_url_port_falls_back_to_default(monkeypatch, bad_port) -> None:
    """非法监听端口按 hot_server 同款回退 8768，不拼出坏 URL。"""
    _patch_listener(monkeypatch, port=bad_port)
    _patch_token(monkeypatch, _SERVICE_TOKEN)

    payload = dsh_tool_auth.build_tool_auth_payload()

    assert payload["base_url"] == "http://127.0.0.1:8768"


@pytest.mark.parametrize("missing", [None, ""])
def test_build_payload_token_missing_is_none(monkeypatch, missing) -> None:
    """无用户/空串一律归 None：不伪造、不空串发送。"""
    _patch_listener(monkeypatch)
    _patch_token(monkeypatch, missing)

    payload = dsh_tool_auth.build_tool_auth_payload()

    assert payload["token"] is None


# ---------------------------------------------------------------------------
# 推送本体
# ---------------------------------------------------------------------------


def test_missing_service_token_skips_http(monkeypatch) -> None:
    _patch_listener(monkeypatch)
    _patch_token(monkeypatch, None)
    sent: List[Dict[str, Any]] = []

    async def _never(self, payload):
        sent.append(dict(payload))
        raise AssertionError("无 service token 时不应发请求")

    monkeypatch.setattr(DshClient, "push_tool_auth", _never)

    result = asyncio.run(dsh_tool_auth.push_tool_auth("boot"))

    assert sent == []
    assert set(result) == {"ok", "status", "reason", "error", "at"}
    assert result["ok"] is False
    assert result["status"] is None
    assert result["reason"] == "boot"
    assert result["error"] == dsh_tool_auth.SERVICE_TOKEN_MISSING == "service_token_missing"
    assert isinstance(result["at"], int)
    assert dsh_tool_auth.last_push() == result


def test_push_success_records_payload_and_last_push(monkeypatch, caplog) -> None:
    _patch_listener(monkeypatch, port=9443)
    _patch_token(monkeypatch, _SERVICE_TOKEN)
    captured: Dict[str, Any] = {}

    async def _fake(self, payload):
        captured["payload"] = dict(payload)
        return 200, {"ok": True, "stored_at": 1794759000123}, {}

    monkeypatch.setattr(DshClient, "push_tool_auth", _fake)

    with caplog.at_level(logging.INFO, logger="services.dsh_tool_auth"):
        result = asyncio.run(dsh_tool_auth.push_tool_auth("ai_surface"))

    assert result["ok"] is True
    assert result["status"] == 200
    assert result["reason"] == "ai_surface"
    assert result["error"] is None
    assert isinstance(result["at"], int)
    assert set(captured["payload"]) == _PAYLOAD_FIELDS
    assert captured["payload"]["base_url"] == "http://127.0.0.1:9443"
    assert captured["payload"]["token"] == _SERVICE_TOKEN
    assert dsh_tool_auth.last_push() == result
    # 诊断面与日志都不带 token
    assert _SERVICE_TOKEN not in str(dsh_tool_auth.last_push())
    assert _SERVICE_TOKEN not in caplog.text


def test_push_non_200_is_failure(monkeypatch) -> None:
    _patch_listener(monkeypatch)
    _patch_token(monkeypatch, _SERVICE_TOKEN)

    async def _denied(self, payload):
        return 401, {"error": "unauthorized"}, {}

    monkeypatch.setattr(DshClient, "push_tool_auth", _denied)

    result = asyncio.run(dsh_tool_auth.push_tool_auth("health"))

    assert result["ok"] is False
    assert result["status"] == 401
    assert result["reason"] == "health"
    assert "401" in result["error"]
    assert _SERVICE_TOKEN not in result["error"]
    assert dsh_tool_auth.last_push()["ok"] is False


def test_push_transport_exception_is_swallowed_and_redacted(
    monkeypatch, caplog
) -> None:
    """传输异常不外抛；Authorization 形态与裸 token 字面量都被抹掉。"""
    _patch_listener(monkeypatch)
    _patch_token(monkeypatch, _SERVICE_TOKEN)

    async def _boom(self, payload):
        raise RuntimeError(
            "connect failed Authorization: Bearer "
            f"{_SERVICE_TOKEN} body_extras token={_SERVICE_TOKEN}"
        )

    monkeypatch.setattr(DshClient, "push_tool_auth", _boom)

    with caplog.at_level(logging.WARNING, logger="services.dsh_tool_auth"):
        result = asyncio.run(dsh_tool_auth.push_tool_auth("boot"))

    assert result["ok"] is False
    assert result["status"] is None
    assert result["error"]
    assert "***" in result["error"]
    assert _SERVICE_TOKEN not in result["error"]
    assert _SERVICE_TOKEN not in caplog.text
    assert dsh_tool_auth.last_push()["ok"] is False
    assert _SERVICE_TOKEN not in str(dsh_tool_auth.last_push())


def test_push_swallows_build_exception(monkeypatch) -> None:
    """token 来源自身抛错也只收成 ok=False，不外抛。"""
    _patch_listener(monkeypatch)

    def _broken_token() -> str:
        raise RuntimeError("auth 配置损坏")

    monkeypatch.setattr(auth, "ensure_service_token", _broken_token)

    result = asyncio.run(dsh_tool_auth.push_tool_auth("boot"))

    assert result["ok"] is False
    assert result["status"] is None
    assert "auth 配置损坏" in result["error"]
    assert dsh_tool_auth.last_push() == result


# ---------------------------------------------------------------------------
# 调度合并
# ---------------------------------------------------------------------------


def test_schedule_push_coalesces_rapid_calls(monkeypatch) -> None:
    calls: List[str] = []

    async def _recording(reason: str):
        calls.append(reason)
        return {"ok": True}

    monkeypatch.setattr(dsh_tool_auth, "push_tool_auth", _recording)

    async def _scenario():
        dsh_tool_auth.schedule_push("boot")
        dsh_tool_auth.schedule_push("health")  # 在途任务期间的调用被合并
        dsh_tool_auth.schedule_push("ai_surface")
        await asyncio.sleep(0.05)

    asyncio.run(_scenario())

    assert calls == ["boot"]


def test_schedule_push_throttles_next_call_after_completion(monkeypatch) -> None:
    calls: List[str] = []

    async def _recording(reason: str):
        calls.append(reason)
        return {"ok": True}

    monkeypatch.setattr(dsh_tool_auth, "push_tool_auth", _recording)

    async def _scenario():
        dsh_tool_auth.schedule_push("boot")
        await asyncio.sleep(0.05)  # 首个任务已完成
        assert dsh_tool_auth._task is not None and dsh_tool_auth._task.done()
        dsh_tool_auth.schedule_push("setup")  # 距上次 < 1s，仍被合并
        await asyncio.sleep(0.05)

    asyncio.run(_scenario())

    assert calls == ["boot"]


def test_schedule_push_without_running_loop_is_noop(monkeypatch) -> None:
    calls: List[str] = []

    async def _recording(reason: str):
        calls.append(reason)
        return {"ok": True}

    monkeypatch.setattr(dsh_tool_auth, "push_tool_auth", _recording)

    dsh_tool_auth.schedule_push("boot")  # 同步上下文：无运行中事件循环

    assert calls == []
    assert dsh_tool_auth._task is None


# ---------------------------------------------------------------------------
# 生命周期钩子
# ---------------------------------------------------------------------------


def test_health_transition_to_online_schedules_one_push(monkeypatch) -> None:
    calls: List[str] = []
    monkeypatch.setattr(dsh_tool_auth, "schedule_push", _recorder(calls))

    dsh_health._record("offline", None, None, "connect refused")
    assert calls == []

    dsh_health._record("online", "0.2.1", "dsh-sess-1", None)
    assert calls == ["health"]

    dsh_health._record("online", "0.2.1", "dsh-sess-1", None)  # 重复 online 不推
    assert calls == ["health"]


def test_apply_ai_surface_pushes_tool_auth_only_for_dsh(monkeypatch) -> None:
    import services.config_reconciler as reconciler

    synced: List[str] = []
    pushed: List[str] = []

    async def _fake_sync(backend: str):
        synced.append(backend)
        return {"backend": backend, "loom": None}

    monkeypatch.setattr(reconciler, "sync_ai_surface", _fake_sync)
    monkeypatch.setattr(dsh_tool_auth, "schedule_push", _recorder(pushed))
    # dsh_paths 的同点推送不属本用例断言范围，替换为空操作避免真实调度
    monkeypatch.setattr(
        "services.dsh_paths.schedule_push", lambda reason: None
    )

    asyncio.run(apply_ai_surface(_ai_change("loom", "dsh")))
    assert synced == ["dsh"]
    assert pushed == ["ai_surface"]

    asyncio.run(apply_ai_surface(_ai_change("dsh", "loom")))
    assert synced == ["dsh", "loom"]
    assert pushed == ["ai_surface"]  # 非 dsh 后端不推


def test_setup_success_schedules_tool_auth(monkeypatch) -> None:
    import routers.auth_api as auth_api

    calls: List[str] = []
    monkeypatch.setattr(dsh_tool_auth, "schedule_push", _recorder(calls))
    monkeypatch.setattr(auth_api, "is_setup_required", lambda: True)
    monkeypatch.setattr(
        auth_api, "create_first_user", lambda username, password: (True, "设置成功", "tok-1")
    )
    monkeypatch.setattr(
        auth_api, "get_config", lambda: SimpleNamespace(setup_require_token=False)
    )

    body = auth_api.LoginRequest(username="NewAdmin", password="secret123")
    response = asyncio.run(auth_api.setup(body, SimpleNamespace(headers={})))

    assert calls == ["setup"]
    assert response.success is True
    assert response.token == "tok-1"


def test_setup_failure_does_not_schedule(monkeypatch) -> None:
    import routers.auth_api as auth_api

    calls: List[str] = []
    monkeypatch.setattr(dsh_tool_auth, "schedule_push", _recorder(calls))
    monkeypatch.setattr(auth_api, "is_setup_required", lambda: True)
    monkeypatch.setattr(
        auth_api, "create_first_user", lambda username, password: (False, "用户名已存在", None)
    )
    monkeypatch.setattr(
        auth_api, "get_config", lambda: SimpleNamespace(setup_require_token=False)
    )

    body = auth_api.LoginRequest(username="Other", password="secret123")
    response = asyncio.run(auth_api.setup(body, SimpleNamespace(headers={})))

    assert calls == []
    assert response.status_code == 400


class _FakeScheduler:
    def __init__(self) -> None:
        self.paused = None

    def set_paused(self, value: bool) -> None:
        self.paused = value

    async def start(self) -> None:
        pass


class _FakeRunner:
    async def start(self) -> None:
        pass


class _FakeRegistry:
    def set_sweep_sink(self, sink) -> None:
        pass

    def start_sweeper(self) -> None:
        pass


class _FakeStore:
    appliers: tuple[str, ...] = ()

    def start_watcher(self, loop) -> None:
        pass


def test_service_plane_boot_schedules_tool_auth(monkeypatch) -> None:
    scheduler = _FakeScheduler()
    runner = _FakeRunner()
    registry = _FakeRegistry()
    store = _FakeStore()

    monkeypatch.setattr(main_module, "get_config", lambda: SimpleNamespace())
    monkeypatch.setattr(
        main_module,
        "init_task_executor",
        lambda: SimpleNamespace(execute=lambda *a, **kw: None),
    )
    monkeypatch.setattr(
        main_module,
        "init_task_scheduler",
        lambda execute_callback=None: scheduler,
    )
    monkeypatch.setattr(main_module, "init_script_runner", lambda: runner)
    monkeypatch.setattr(main_module, "get_config_store", lambda: store)
    monkeypatch.setattr(
        main_module, "register_default_appliers", lambda *a, **kw: ["ai"]
    )
    monkeypatch.setattr(main_module, "_register_builtin_tasks", lambda *a, **kw: None)

    import services.audio_ingest_registry as registry_module

    monkeypatch.setattr(
        registry_module, "get_audio_ingest_registry", lambda: registry
    )

    pushed: List[str] = []
    monkeypatch.setattr(dsh_tool_auth, "schedule_push", _recorder(pushed))
    # 同点位的 dsh_paths 推送已有独立用例，这里替换为空操作避免真实调度
    monkeypatch.setattr("services.dsh_paths.schedule_push", lambda reason: None)

    app = SimpleNamespace(state=SimpleNamespace(config_store=store))

    async def _scenario():
        return await main_module._start_service_plane(app, mode="validation")

    report = asyncio.run(_scenario())

    assert report["subsystems"]["config_appliers"] == "ok"
    assert pushed == ["boot"]
