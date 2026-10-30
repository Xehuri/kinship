# -*- coding: utf-8 -*-
"""Launcher retirement (task 25): importable rollback path, no bootstrap/OpenCode, hot_server entry."""
from __future__ import annotations

import ast
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import launcher  # noqa: E402
import config.config as config_module  # noqa: E402


class _Cfg:
    CONDAPYTHON_PATH = sys.executable
    BACKEND_HOST = "0.0.0.0"
    BACKEND_PORT = 8768
    BACKEND_HTTP_PORT = 28769
    BACKEND_HTTPS_PORT = 28768
    SSL_ENABLED = False
    SSL_CERT = ""
    SSL_KEY = ""


def _build_manager(monkeypatch, tmp_path) -> launcher.ServiceManager:
    monkeypatch.setattr(
        launcher,
        "parse_args",
        lambda: SimpleNamespace(config=None, data_dir=None),
    )
    monkeypatch.setattr(launcher, "_backend_dir", lambda: tmp_path / "backend")
    monkeypatch.setattr(config_module, "get_config", lambda: _Cfg())
    monkeypatch.setattr(config_module, "set_config_path", lambda path: None)
    return launcher.ServiceManager()


def _main_guard(node: ast.AST) -> bool:
    if not isinstance(node, ast.If) or not isinstance(node.test, ast.Compare):
        return False
    test = node.test
    return (
        isinstance(test.left, ast.Name)
        and test.left.id == "__name__"
        and len(test.ops) == 1
        and isinstance(test.ops[0], ast.Eq)
        and len(test.comparators) == 1
        and isinstance(test.comparators[0], ast.Constant)
        and test.comparators[0].value == "__main__"
    )


def test_launcher_module_still_imports_for_rollback():
    """launcher.py 保留仅为回滚；OpenCode 与 bootstrap 管理必须已移除。"""
    assert Path(launcher.__file__).resolve() == (ROOT / "launcher.py").resolve()
    assert hasattr(launcher, "ServiceManager")
    assert not hasattr(launcher, "onboarding_bootstrap_required")
    assert not hasattr(launcher, "build_opencode_env")
    assert not hasattr(launcher, "find_opencode_cmd")


def test_bootstrap_flag_no_longer_exists(monkeypatch):
    monkeypatch.setattr(sys, "argv", ["launcher.py", "--bootstrap"])
    with pytest.raises(SystemExit) as exc:
        launcher.parse_args()
    assert exc.value.code == 2


def test_config_and_data_dir_flags_still_accepted(monkeypatch):
    monkeypatch.setattr(
        sys, "argv", ["launcher.py", "--config", "/tmp/c.yaml", "--data-dir", "/tmp/d"]
    )
    args = launcher.parse_args()
    assert args.config == "/tmp/c.yaml"
    assert args.data_dir == "/tmp/d"


def test_run_supervises_backend_only(monkeypatch, tmp_path):
    manager = _build_manager(monkeypatch, tmp_path)
    manager.start_backend = MagicMock()
    manager.wait_health = MagicMock()
    manager.stop_backend = MagicMock()
    manager.running = False

    manager.run()

    manager.start_backend.assert_called_once_with()
    manager.wait_health.assert_called_once_with()
    manager.stop_backend.assert_called_once_with()
    assert not hasattr(manager, "start_opencode")


def test_health_url_uses_http_port_when_ssl_disabled(monkeypatch, tmp_path):
    manager = _build_manager(monkeypatch, tmp_path)

    assert manager.health_url() == "http://127.0.0.1:28769/health"


def test_health_url_uses_https_port_when_ssl_ready(monkeypatch, tmp_path):
    cert = tmp_path / "cert.pem"
    key = tmp_path / "key.pem"
    cert.write_text("cert", encoding="utf-8")
    key.write_text("key", encoding="utf-8")

    cfg = _Cfg()
    cfg.SSL_ENABLED = True
    cfg.SSL_CERT = str(cert)
    cfg.SSL_KEY = str(key)

    manager = _build_manager(monkeypatch, tmp_path)
    monkeypatch.setattr(config_module, "get_config", lambda: cfg)
    assert manager.health_url() == "https://127.0.0.1:28768/health"


def test_hot_server_is_importable_entry_point():
    import core.hot_server as hot_server

    assert callable(hot_server.main)
    assert callable(hot_server.run_hot_server)

    tree = ast.parse(Path(hot_server.__file__).read_text(encoding="utf-8"))
    guard = next(node for node in ast.walk(tree) if _main_guard(node))
    assert any(
        isinstance(stmt, ast.Expr)
        and isinstance(stmt.value, ast.Call)
        and getattr(stmt.value.func, "id", None) == "main"
        for stmt in guard.body
    )


def test_hot_server_imports_via_module_entry_from_backend_cwd():
    proc = subprocess.run(
        [sys.executable, "-c", "import core.hot_server"],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 0, proc.stderr


def test_repo_unit_runs_hot_server_with_orchestrator_env():
    unit = (ROOT / "deploy" / "axeuh-health.service").read_text(encoding="utf-8")
    lines = unit.splitlines()
    assert "ExecStart=/opt/kinship/.venv-health/bin/python -m core.hot_server" in lines
    working = [line for line in lines if line.startswith("WorkingDirectory=")]
    assert len(working) == 1 and working[0].endswith("/backend")
    assert "Environment=AXEUH_KERNEL_PYTHON=/opt/kinship/.venv-kernel/bin/python" in lines
    assert "Environment=AXEUH_LOOM_MODE=child" in lines
    assert "Environment=AXEUH_ORCHESTRATOR=on" in lines
    assert "launcher.py" not in unit
