# -*- coding: utf-8 -*-
"""内核发行包脚本的离线自检：只跑 --help / --self-check，不触发构建。"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(
    shutil.which("bash") is None, reason="bash not available"
)

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "build-kernel-asset.sh"


def _run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(SCRIPT), *args],
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )


def test_help_lists_usage_and_manifest_argument():
    proc = _run("--help")
    assert proc.returncode == 0
    assert "release-manifest.json" in proc.stdout
    assert "PROTECTION" in proc.stdout


def test_self_check_passes_without_building():
    proc = _run("--self-check")
    assert proc.returncode == 0, proc.stderr
    assert "self-check ok" in proc.stdout
