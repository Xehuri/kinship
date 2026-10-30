# -*- coding: utf-8 -*-
"""AXEUH_PROJECT_ROOT 路径隔离：默认值与 staging 覆盖行为。"""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from config import paths
from services import client_artifacts


BACKEND_DIR = Path(__file__).resolve().parents[1]
_PROJECT_ROOT_KEYS = (
    "AXEUH_PROJECT_ROOT",
    "AXEUH_AUTH_STATE_DIR",
    "AEUH_AUTH_STATE_DIR",
)


@pytest.fixture(autouse=True)
def _clean_path_env(monkeypatch):
    for key in _PROJECT_ROOT_KEYS:
        monkeypatch.delenv(key, raising=False)


def _default_project_root() -> Path:
    return Path(paths.__file__).resolve().parents[2]


def test_default_layout_matches_backend_location():
    root = _default_project_root()

    assert paths.project_root() == root
    assert paths.backend_dir() == root / "backend"
    assert paths.frontend_mobile_dir() == root / "frontend" / "mobile"
    assert paths.frontend_dist_dir() == root / "frontend" / "mobile" / "dist"
    assert paths.kernel_dir() == root / "kernel"
    assert paths.ai_dir() == root / "ai"


def test_project_root_override_rewrites_every_helper(monkeypatch, tmp_path):
    root = tmp_path / "isolated"
    monkeypatch.setenv("AXEUH_PROJECT_ROOT", str(root))

    assert paths.project_root() == root.resolve()
    assert paths.backend_dir() == root.resolve() / "backend"
    assert paths.frontend_mobile_dir() == root.resolve() / "frontend" / "mobile"
    assert (
        paths.frontend_dist_dir()
        == root.resolve() / "frontend" / "mobile" / "dist"
    )
    assert paths.kernel_dir() == root.resolve() / "kernel"
    assert paths.ai_dir() == root.resolve() / "ai"
    assert not root.exists()


def test_default_auth_state_dir_uses_env_override(monkeypatch, tmp_path):
    assert paths.default_auth_state_dir() == paths.backend_dir() / "config"

    legacy = tmp_path / "legacy-auth"
    preferred = tmp_path / "preferred-auth"
    monkeypatch.setenv("AEUH_AUTH_STATE_DIR", str(legacy))
    assert paths.default_auth_state_dir() == legacy

    monkeypatch.setenv("AXEUH_AUTH_STATE_DIR", str(preferred))
    assert paths.default_auth_state_dir() == preferred


def test_desktop_release_dir_follows_project_root(monkeypatch, tmp_path):
    monkeypatch.setenv("AXEUH_PROJECT_ROOT", str(tmp_path))
    monkeypatch.delenv("KINSHIP_DESKTOP_RELEASE_DIR", raising=False)

    assert client_artifacts.desktop_release_dir() == str(
        tmp_path.resolve() / "desktop" / "release"
    )

def test_config_relative_paths_follow_project_root(monkeypatch, tmp_path):
    from config.config import Config

    monkeypatch.setenv("AXEUH_PROJECT_ROOT", str(tmp_path))
    cfg = Config(data={})

    assert cfg.SCRIPTS_DIR == str(tmp_path.resolve() / "ai" / "data" / "tasks")
    assert cfg.KERNEL_STATE_DIR == str(
        tmp_path.resolve() / "backend" / "data" / "kernel_state"
    )


def test_axueh_project_root_drives_module_paths(tmp_path):
    root = tmp_path / "staging-root"
    output = tmp_path / "paths.json"
    script = """
import json
import os
import auth
import main
import services.kernel_client as kernel_client
from services import client_artifacts, onboarding_service

payload = {
    "preview": str(main._PREVIEW_DIR),
    "vaudit": str(main._VAUDIT_DIR),
    "mobile_dist": str(main.frontend_dist_dir()),
    "onboarding_root": str(onboarding_service.default_project_root()),
    "onboarding_state": str(onboarding_service._state_path()),
    "auth_state": auth.AUTH_STATE_DIR,
    "desktop_release": client_artifacts.desktop_release_dir(),
    "kernel_dir": str(kernel_client._KERNEL_DIR),
}
with open(os.environ["PATHS_OUTPUT"], "w", encoding="utf-8") as handle:
    json.dump(payload, handle)
"""
    env = os.environ.copy()
    env.pop("AEUH_ONBOARDING_STATE", None)
    env.pop("AXEUH_ONBOARDING_STATE", None)
    env["AXEUH_PROJECT_ROOT"] = str(root)
    env["PYTHONPATH"] = str(BACKEND_DIR)
    env["PATHS_OUTPUT"] = str(output)

    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=str(BACKEND_DIR),
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )

    assert result.returncode == 0, result.stderr
    payload = json.loads(output.read_text(encoding="utf-8"))
    expected = root.resolve()
    assert payload == {
        "preview": str(expected / "frontend" / "preview"),
        "vaudit": str(expected / "frontend" / "vaudit"),
        "mobile_dist": str(expected / "frontend" / "mobile" / "dist"),
        "onboarding_root": str(expected),
        "onboarding_state": str(expected / "backend" / "data" / "onboarding_state.json"),
        "auth_state": str(expected / "backend" / "config"),
        "desktop_release": str(expected / "desktop" / "release"),
        "kernel_dir": str(expected / "kernel"),
    }
