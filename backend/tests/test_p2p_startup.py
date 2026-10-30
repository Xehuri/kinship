# -*- coding: utf-8 -*-
"""P2P 启动链路：fail-open 与 import 纯度。"""
import os
import subprocess
import sys

from fastapi.testclient import TestClient

from main import app


_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def test_lifespan_p2p_start_failure_is_non_fatal(monkeypatch):
    import services.p2p.manager as manager_module

    class BrokenManager:
        async def start(self):
            raise RuntimeError("p2p boom")

    async def broken_stop():
        raise RuntimeError("p2p stop boom")

    monkeypatch.setattr(manager_module, "get_p2p_manager", lambda: BrokenManager())
    monkeypatch.setattr(manager_module, "stop_p2p_manager", broken_stop)

    with TestClient(app) as test_client:
        assert test_client.get("/health").status_code == 200


def test_router_import_creates_no_manager_singleton():
    script = (
        "import routers.p2p\n"
        "import services.p2p.manager as manager_module\n"
        "assert manager_module._instance is None, 'import side effect'\n"
        "print('P2P_IMPORT_OK')\n"
    )
    proc = subprocess.run(
        [sys.executable, "-c", script],
        cwd=_BACKEND_DIR,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 0, proc.stderr[-2000:]
    assert "P2P_IMPORT_OK" in proc.stdout
