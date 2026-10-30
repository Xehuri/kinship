# -*- coding: utf-8 -*-
"""托盘图标：优先加载 Kinship 吉祥物 PNG，缺失时回退并告警。

Pillow 随 Windows 采集端运行时一起分发，后端 venv 不一定安装；
因此依赖 Pillow 的用例在缺失时跳过，结构断言始终执行。
"""

import logging
import os
import shutil
import struct

import pytest

import pc_sensor_app

ASSETS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets")


def _png_size(path: str) -> tuple[int, int]:
    with open(path, "rb") as f:
        header = f.read(24)
    assert header[:8] == b"\x89PNG\r\n\x1a\n", path
    return struct.unpack(">II", header[16:24])


def _ico_sizes(path: str) -> list[int]:
    with open(path, "rb") as f:
        header = f.read(6)
        assert struct.unpack("<HH", header[:4]) == (0, 1), path
        count = struct.unpack("<H", header[4:6])[0]
        entries = f.read(count * 16)
    sizes = []
    for index in range(count):
        width = entries[index * 16] or 256
        height = entries[index * 16 + 1] or 256
        assert width == height, path
        sizes.append(width)
    return sizes


def test_load_tray_image_exists():
    assert callable(pc_sensor_app.load_tray_image)


def test_mascot_assets_exist():
    assert _png_size(os.path.join(ASSETS_DIR, "tray-icon-32.png")) == (32, 32)
    assert _png_size(os.path.join(ASSETS_DIR, "tray-icon-64.png")) == (64, 64)
    assert _ico_sizes(os.path.join(ASSETS_DIR, "kinship-pc-sensor.ico")) == [
        16, 24, 32, 48, 64, 128, 256,
    ]


def test_load_tray_image_uses_64px_mascot():
    Image = pytest.importorskip("PIL.Image")

    image = pc_sensor_app.load_tray_image()

    assert image.size == (64, 64)
    assert image.mode == "RGBA"
    with Image.open(os.path.join(ASSETS_DIR, "tray-icon-64.png")) as expected:
        assert image.tobytes() == expected.convert("RGBA").tobytes()


def test_load_tray_image_falls_back_to_32px(monkeypatch, tmp_path):
    pytest.importorskip("PIL.Image")
    assets = tmp_path / "assets"
    assets.mkdir()
    shutil.copyfile(os.path.join(ASSETS_DIR, "tray-icon-32.png"), assets / "tray-icon-32.png")
    monkeypatch.setattr(pc_sensor_app, "RESOURCE_DIR", str(tmp_path))

    image = pc_sensor_app.load_tray_image(size=64)

    assert image.size == (32, 32)
    assert image.mode == "RGBA"


def test_load_tray_image_falls_back_to_solid_square(monkeypatch, tmp_path, caplog):
    pytest.importorskip("PIL.Image")
    monkeypatch.setattr(pc_sensor_app, "RESOURCE_DIR", str(tmp_path))

    with caplog.at_level(logging.WARNING, logger="pc_sensor_app"):
        image = pc_sensor_app.load_tray_image(size=64)

    assert image.size == (64, 64)
    assert image.mode == "RGBA"
    colors = image.getcolors(maxcolors=2)
    assert colors is not None and len(colors) == 1
    assert colors[0][1][3] == 255
    assert any(record.levelno >= logging.WARNING for record in caplog.records)
