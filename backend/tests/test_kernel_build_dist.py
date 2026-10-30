# -*- coding: utf-8 -*-
"""kernel/build_dist.py 的运行期依赖清单生成（离线，不触发真实构建）。"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

BUILD_DIST_PATH = (
    Path(__file__).resolve().parents[2] / "kernel" / "build_dist.py"
)
_SPEC = importlib.util.spec_from_file_location(
    "kernel_build_dist_under_test", BUILD_DIST_PATH
)
assert _SPEC is not None and _SPEC.loader is not None
build_dist = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(build_dist)


PYPROJECT = """[project]
name = "axeuh-kernel"
version = "1.0.0"
dependencies = [
    "fastapi",
    "uvicorn>=0.30",
    "numpy",
    "torch>=2.1",
    "torchaudio",
    "funasr==1.3.22",
    "modelscope[framework]>=1.20",
]

[build-system]
requires = ["setuptools>=61"]
"""


def test_project_dependencies_excludes_torch_packages(tmp_path) -> None:
    pyproject = tmp_path / "pyproject.toml"
    pyproject.write_text(PYPROJECT, encoding="utf-8")

    dependencies = build_dist.project_dependencies(pyproject)

    assert dependencies == [
        "fastapi",
        "uvicorn>=0.30",
        "numpy",
        "funasr==1.3.22",
        "modelscope[framework]>=1.20",
    ]


def test_fallback_parser_reads_multiline_dependencies() -> None:
    text = (
        "[project]\n"
        'name = "x"\n'
        "dependencies = [\n"
        '    "fastapi",  # web\n'
        "    'torch',\n"
        "]\n"
        "[build-system]\n"
        'requires = ["setuptools>=61"]\n'
    )

    assert build_dist._dependencies_fallback(text) == ["fastapi", "torch"]


def test_write_requirements_creates_one_line_per_dependency(tmp_path) -> None:
    pyproject = tmp_path / "pyproject.toml"
    pyproject.write_text(PYPROJECT, encoding="utf-8")
    dist = tmp_path / "dist"
    dist.mkdir()

    dependencies = build_dist.write_requirements(dist, pyproject)

    text = (dist / "requirements.txt").read_text(encoding="utf-8")
    assert text.endswith("\n")
    assert text.splitlines() == dependencies
    assert "-e" not in text
    assert not any(line.lower().startswith("torch") for line in text.splitlines())


def test_main_writes_requirements_into_dist(tmp_path, monkeypatch) -> None:
    source = tmp_path / "src" / "axeuh_kernel"
    source.mkdir(parents=True)
    (source / "__init__.py").write_text("API_VERSION = '1.0.0'\n", encoding="utf-8")
    meta = tmp_path / "kernel-meta"
    meta.mkdir()
    (meta / "pyproject.toml").write_text(PYPROJECT, encoding="utf-8")
    out = tmp_path / "dist" / "axeuh-kernel"

    monkeypatch.setattr(build_dist, "KERNEL_DIR", meta)
    monkeypatch.setattr(build_dist, "SRC_PKG", source)
    monkeypatch.setattr(build_dist, "DEFAULT_OUT", out)
    monkeypatch.setattr(build_dist, "_smoke", lambda _out: None)

    assert build_dist.main(["--protection", "pyc"]) == 0

    requirements = (out / "requirements.txt").read_text(encoding="utf-8")
    assert requirements.splitlines() == [
        "fastapi",
        "uvicorn>=0.30",
        "numpy",
        "funasr==1.3.22",
        "modelscope[framework]>=1.20",
    ]
    info = json.loads((out / "BUILD_INFO.json").read_text(encoding="utf-8"))
    assert info["requirements"] == "requirements.txt"
    assert info["requirements_packages"] == 5
