# -*- coding: utf-8 -*-
"""PC-M9：桌面内嵌模式（无托盘 / 数据目录 / 静态资源 / 关闭）。"""

import json
import os
import subprocess
import sys
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import pc_sensor_app
from pc_sensor import idle_tracker, window_tracker

PC_SENSOR_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VALID_TOKEN = "unit-test-desktop-mode-token-0123456789"


def _client(monkeypatch) -> TestClient:
    monkeypatch.setattr(pc_sensor_app, "AGENT_TOKEN", VALID_TOKEN)
    return TestClient(pc_sensor_app.app)


def _auth() -> dict[str, str]:
    return {"Authorization": f"Bearer {VALID_TOKEN}"}


def _subprocess_env(tmp_path) -> dict[str, str]:
    env = os.environ.copy()
    env.pop("DISPLAY", None)
    env.pop("PC_SENSOR_CONFIG_PATH", None)
    env["PC_SENSOR_DATA_DIR"] = str(tmp_path / "data")
    env["PYTHONPATH"] = PC_SENSOR_DIR + os.pathsep + env.get("PYTHONPATH", "")
    return env


# ============ 参数与数据目录 ============


def test_parse_arg_value_supports_space_form():
    argv = ["--silent", "--data-dir", "/tmp/pc-data"]
    assert pc_sensor_app.parse_arg_value(argv, "--data-dir") == "/tmp/pc-data"


def test_parse_arg_value_supports_equals_form():
    argv = ["--data-dir=/tmp/pc-data"]
    assert pc_sensor_app.parse_arg_value(argv, "--data-dir") == "/tmp/pc-data"


def test_parse_arg_value_returns_none_when_missing():
    assert pc_sensor_app.parse_arg_value(["--silent"], "--data-dir") is None
    assert pc_sensor_app.parse_arg_value(["--data-dir"], "--data-dir") is None


def test_data_dir_cli_wins_over_env(tmp_path):
    cli_dir = tmp_path / "cli"
    env_dir = tmp_path / "env"
    resolved = pc_sensor_app.resolve_data_dir(
        ["--data-dir", str(cli_dir)],
        {"PC_SENSOR_DATA_DIR": str(env_dir)},
    )
    assert resolved == os.path.abspath(str(cli_dir))


def test_data_dir_env_wins_over_default(tmp_path):
    env_dir = tmp_path / "env"
    resolved = pc_sensor_app.resolve_data_dir(
        [],
        {"PC_SENSOR_DATA_DIR": str(env_dir)},
    )
    assert resolved == os.path.abspath(str(env_dir))


def test_data_dir_defaults_to_app_dir():
    assert pc_sensor_app.resolve_data_dir([], {}) == pc_sensor_app.APP_DIR


def test_parse_parent_pid_ignores_invalid_values():
    assert pc_sensor_app.parse_parent_pid(["--parent-pid", "1234"]) == 1234
    assert pc_sensor_app.parse_parent_pid(["--parent-pid=0"]) == 0
    assert pc_sensor_app.parse_parent_pid(["--parent-pid", "-5"]) == 0
    assert pc_sensor_app.parse_parent_pid(["--parent-pid", "abc"]) == 0


# ============ 导入平台安全 ============


def test_import_succeeds_without_display(tmp_path):
    env = _subprocess_env(tmp_path)
    result = subprocess.run(
        [sys.executable, "-c", "import sys, pc_sensor_app; print('pystray' in sys.modules)"],
        cwd=PC_SENSOR_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "False"


def test_import_does_not_require_tray_modules(tmp_path):
    env = _subprocess_env(tmp_path)
    code = (
        "import sys;"
        "sys.modules['pystray'] = None;"
        "sys.modules['PIL'] = None;"
        "import pc_sensor_app;"
        "print(pc_sensor_app.VERSION)"
    )
    result = subprocess.run(
        [sys.executable, "-c", code],
        cwd=PC_SENSOR_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == pc_sensor_app.VERSION


@pytest.mark.skipif(sys.platform == "win32", reason="仅验证非 Windows 平台守卫")
def test_platform_trackers_are_safe_on_non_windows():
    assert window_tracker.get_foreground_window() is None
    assert idle_tracker.get_idle_seconds() == 0.0
    assert idle_tracker.is_screen_locked() is False


# ============ HTTP 契约 ============


def test_health_includes_process_identity(monkeypatch):
    client = _client(monkeypatch)
    payload = client.get("/health").json()

    assert payload["status"] == "ok"
    assert payload["agent_id"]
    assert payload["agent_name"]
    assert payload["pid"] == os.getpid()
    assert payload["version"] == pc_sensor_app.VERSION


def test_local_chart_asset_is_served_without_auth(monkeypatch):
    client = _client(monkeypatch)
    resp = client.get("/static/vendor/chart.umd.min.js")

    assert resp.status_code == 200
    assert "javascript" in resp.headers["content-type"]
    assert len(resp.content) > 100_000


def test_local_chart_asset_supports_head(monkeypatch):
    client = _client(monkeypatch)
    resp = client.head("/static/vendor/chart.umd.min.js")

    assert resp.status_code == 200
    assert "javascript" in resp.headers["content-type"]


def test_static_route_rejects_traversal_and_directories(monkeypatch):
    client = _client(monkeypatch)

    assert client.get("/static/%2e%2e/config.json").status_code == 404
    assert client.get("/static/vendor").status_code == 404


def test_pc_config_has_no_external_cdn(monkeypatch):
    client = _client(monkeypatch)
    resp = client.get("/pc-config")

    assert resp.status_code == 200
    assert "cdn.jsdelivr" not in resp.text
    assert "/static/vendor/chart.umd.min.js" in resp.text
    assert "window.__PC_AGENT_TOKEN__" in resp.text
    csp = resp.headers["content-security-policy"]
    assert "default-src 'self'" in csp
    assert "script-src 'self' 'unsafe-inline'" in csp
    assert resp.headers["x-content-type-options"] == "nosniff"
    assert resp.headers["referrer-policy"] == "no-referrer"


def test_shutdown_requires_bearer_token(monkeypatch):
    client = _client(monkeypatch)
    pc_sensor_app.shutdown_event.clear()
    try:
        resp = client.post("/shutdown")
        assert resp.status_code == 401
        assert pc_sensor_app.shutdown_event.is_set() is False
    finally:
        pc_sensor_app.shutdown_event.clear()


def test_shutdown_sets_event_with_bearer_token(monkeypatch):
    client = _client(monkeypatch)
    pc_sensor_app.shutdown_event.clear()
    try:
        resp = client.post("/shutdown", headers=_auth())
        assert resp.status_code == 200
        assert resp.json() == {"success": True}
        assert pc_sensor_app.shutdown_event.wait(1.0) is True
    finally:
        pc_sensor_app.shutdown_event.clear()


def test_auth_token_endpoint_requires_bearer_token(monkeypatch):
    client = _client(monkeypatch)

    assert client.get("/pc-sensor/auth-token").status_code == 401


def test_auth_token_endpoint_returns_uploader_snapshot(monkeypatch):
    snapshot = {"token": "fixture-backend-token", "expires_in": 3600}
    manager = SimpleNamespace(
        uploader=SimpleNamespace(auth_token_snapshot=lambda: snapshot)
    )
    monkeypatch.setattr(pc_sensor_app, "_pc_sensor_manager", manager)
    client = _client(monkeypatch)

    resp = client.get("/pc-sensor/auth-token", headers=_auth())

    assert resp.status_code == 200
    assert resp.json() == snapshot


def test_status_includes_desktop_identity(tmp_path, monkeypatch):
    agent_cfg = tmp_path / "config.json"
    agent_cfg.write_text(
        json.dumps({"agent_token": VALID_TOKEN, "instance_id": "inst-123"}),
        encoding="utf-8",
    )
    collection_cfg = tmp_path / "pc_sensor_config.json"
    collection_cfg.write_text(json.dumps({"enabled": False}), encoding="utf-8")

    client = _client(monkeypatch)
    monkeypatch.setattr(pc_sensor_app, "CONFIG_PATH", str(agent_cfg))
    monkeypatch.setattr(pc_sensor_app, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(pc_sensor_app, "PC_SENSOR_CONFIG_PATH", str(collection_cfg))
    monkeypatch.setattr(pc_sensor_app, "_pc_sensor_manager", None)

    resp = client.get("/pc-sensor/status", headers=_auth())
    assert resp.status_code == 200
    payload = resp.json()

    assert payload["pid"] == os.getpid()
    assert payload["data_dir"] == str(tmp_path)
    assert payload["instance_id"] == "inst-123"
    assert payload["version"] == pc_sensor_app.VERSION
    for key in (
        "running",
        "enabled",
        "logged_in",
        "window",
        "idle",
        "last_events",
        "queue_size",
    ):
        assert key in payload


def test_token_rotation_preserves_instance_id(tmp_path, monkeypatch):
    cfg_path = tmp_path / "config.json"
    monkeypatch.setattr(pc_sensor_app, "CONFIG_PATH", str(cfg_path))

    cfg = {"agent_token": "", "instance_id": "inst-keep"}
    token = pc_sensor_app._ensure_agent_token(cfg)

    saved = json.loads(cfg_path.read_text(encoding="utf-8"))
    assert saved["instance_id"] == "inst-keep"
    assert saved["agent_token"] == token
