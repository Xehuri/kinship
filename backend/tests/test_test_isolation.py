# -*- coding: utf-8 -*-
"""测试运行隔离回归：conftest 必须把 lifespan 的所有写路径挡在生产目录之外。

背景：conftest 的 client fixture 会执行真实 lifespan。若只桩掉调度器，
ScriptRunner 与小米云后台服务仍会启动并写生产 backend/data / ai/data
（2026-10-26 门禁在目标 pytest 运行中实测到生产脚本与云端拉取）。
本文件锁定 conftest 的临时运行时根重定向，防止隔离回退。
"""
from __future__ import annotations

import os
from pathlib import Path

from fastapi.testclient import TestClient

import auth
from config import paths
from config.config import get_config
import main as main_module
from services.bootstrap_runtime import BootstrapRuntime

BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_DIR.parent
PRODUCTION_BACKEND_DATA = BACKEND_DIR / "data"
PRODUCTION_AI_DATA = REPO_ROOT / "ai" / "data"
ONBOARDING_STATE = PRODUCTION_BACKEND_DATA / "onboarding_state.json"


def _runtime_root() -> Path:
    return Path(os.path.realpath(os.environ["AXEUH_TEST_RUNTIME_ROOT"]))


def _top_level_files(root: Path) -> set[str]:
    if not root.is_dir():
        return set()
    return {entry.name for entry in os.scandir(root) if entry.is_file()}


def _fingerprint(path: Path) -> tuple[int, int] | None:
    try:
        stat = path.stat()
    except FileNotFoundError:
        return None
    return (stat.st_mtime_ns, stat.st_size)


def _is_under(path: Path, root: Path) -> bool:
    resolved = Path(os.path.realpath(path))
    return resolved == root or root in resolved.parents


def test_runtime_paths_are_redirected_under_temp_root():
    cfg = get_config()
    runtime_root = _runtime_root()
    production_backend_data = Path(os.path.realpath(PRODUCTION_BACKEND_DATA))
    production_ai_data = Path(os.path.realpath(PRODUCTION_AI_DATA))

    runtime_paths = {
        "DATA_DIR": cfg.DATA_DIR,
        "SESSIONS_PATH": cfg.SESSIONS_PATH,
        "TASKS_DIR": cfg.TASKS_DIR,
        "VOICEPRINTS_PATH": cfg.VOICEPRINTS_PATH,
        "AI_ROOT": cfg.AI_ROOT,
        "UPLOAD_DIR": cfg.UPLOAD_DIR,
        "TASK_LOGS_DIR": cfg.TASK_LOGS_DIR,
        "STREAM_DIR": cfg.STREAM_DIR,
        "HEALTH_DEVICES_PATH": cfg.HEALTH_DEVICES_PATH,
        "HEALTH_SOURCE_SELECTION_PATH": cfg.HEALTH_SOURCE_SELECTION_PATH,
        "HEALTH_CLOUD_STATE_PATH": cfg.HEALTH_CLOUD_STATE_PATH,
        "SCRIPTS_DIR": cfg.SCRIPTS_DIR,
        "KERNEL_STATE_DIR": cfg.KERNEL_STATE_DIR,
        "OTA_APK_DIR": cfg.OTA_APK_DIR,
        "AUTH_STATE_DIR": auth.AUTH_STATE_DIR,
        "DATA_ROOT": str(paths.data_root()),
        "MODELS_ROOT": str(paths.models_root()),
    }

    for name, raw_path in runtime_paths.items():
        path = Path(raw_path)
        assert path.is_absolute(), f"{name} 不是绝对路径: {raw_path}"
        assert _is_under(path, runtime_root), f"{name} 未重定向到临时根: {raw_path}"
        assert not _is_under(path, production_backend_data), f"{name} 指向生产 backend/data"
        assert not _is_under(path, production_ai_data), f"{name} 指向生产 ai/data"

    onboarding_state = Path(os.environ["AEUH_ONBOARDING_STATE"])
    assert onboarding_state.is_absolute()
    assert not _is_under(onboarding_state, production_backend_data)
    assert not _is_under(onboarding_state, production_ai_data)

    assert cfg.HEALTH_CLOUD_ENABLED is False
    assert cfg.HEALTH_CLOUD_USERID == ""
    assert cfg.HEALTH_CLOUD_PASSTOKEN == ""
    assert cfg.QQ_GATEWAY.get("enabled") is False
    assert cfg.P2P.get("enabled") is False


def test_lifespan_creates_no_new_production_files():
    before_files = _top_level_files(PRODUCTION_BACKEND_DATA)
    before_onboarding = _fingerprint(ONBOARDING_STATE)

    with TestClient(main_module.app) as client:
        response = client.get("/health")
        assert response.status_code == 200, response.text

    assert _top_level_files(PRODUCTION_BACKEND_DATA) == before_files
    assert _fingerprint(ONBOARDING_STATE) == before_onboarding


# ---------------------------------------------------------------------------
# Per-test onboarding state + main.app runtime isolation
# ---------------------------------------------------------------------------
# 这组用例必须保持定义顺序：后一个用例断言前一个用例的状态没有泄漏。
# pytest 默认按定义顺序执行，本仓库不含随机排序插件。

_SEEN_ONBOARDING_STATE_PATHS: list[str] = []
_INJECTED_RUNTIME = BootstrapRuntime(active=True)
_INJECTED_VALIDATION = object()


def _assert_distinct_onboarding_state_path() -> Path:
    raw = os.environ["AEUH_ONBOARDING_STATE"]
    path = Path(raw)
    assert path.is_absolute()
    assert path.name == "onboarding_state.json"
    assert str(path) not in _SEEN_ONBOARDING_STATE_PATHS
    assert not path.exists()
    _SEEN_ONBOARDING_STATE_PATHS.append(str(path))
    return path


def test_each_test_gets_a_distinct_onboarding_state_path():
    _assert_distinct_onboarding_state_path()


def test_each_test_gets_a_distinct_onboarding_state_path_again():
    _assert_distinct_onboarding_state_path()


def test_bootstrap_env_still_starts_the_service_plane(monkeypatch):
    monkeypatch.setenv("AXEUH_ONBOARDING_BOOTSTRAP", "1")
    monkeypatch.setattr(auth, "is_setup_required", lambda: True)

    with TestClient(main_module.app) as client:
        runtime = main_module.app.state.bootstrap_runtime
        assert runtime.active is False
        assert runtime.committed is True
        assert main_module.app.state.service_plane_started is True
        assert client.get("/health").status_code == 200
        assert client.get("/api/system/onboarding/status").status_code == 200


def test_gate_and_state_file_do_not_leak_into_next_test():
    assert os.environ.get("AXEUH_ONBOARDING_BOOTSTRAP") is None
    state_path = Path(os.environ["AEUH_ONBOARDING_STATE"])
    assert not state_path.exists()

    with TestClient(main_module.app) as client:
        assert main_module.app.state.bootstrap_runtime.active is False
        assert client.get("/health").status_code == 200
        assert client.get("/api/system/onboarding/status").status_code != 503
        assert client.get("/api/screen/session/list").status_code != 503


def test_main_app_state_injection_is_visible_within_the_test():
    main_module.app.state.bootstrap_runtime = _INJECTED_RUNTIME
    main_module.app.state.startup_validation = _INJECTED_VALIDATION
    main_module.app.state.onboarding_state_completed = False
    main_module.app.state.service_plane_started = False
    main_module.app.state.service_plane_stopped = False
    main_module.app.state.service_plane_mode = "validation"
    main_module.app.state.deferred_integrations_started = True

    client = TestClient(main_module.app)
    try:
        assert client.get("/api/screen/session/list").status_code == 503
    finally:
        client.close()


def test_main_app_state_is_restored_after_the_previous_test():
    state = main_module.app.state
    assert getattr(state, "bootstrap_runtime", None) is not _INJECTED_RUNTIME
    assert getattr(state, "startup_validation", None) is not _INJECTED_VALIDATION
    assert getattr(state, "onboarding_state_completed", None) is None
    assert getattr(state, "service_plane_started", None) is not False
    assert getattr(state, "service_plane_mode", None) != "validation"
    assert getattr(state, "deferred_integrations_started", None) is not True

    client = TestClient(main_module.app)
    try:
        assert client.get("/health").status_code == 200
        assert client.get("/api/screen/session/list").status_code != 503
    finally:
        client.close()
