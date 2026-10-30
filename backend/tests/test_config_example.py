# -*- coding: utf-8 -*-
"""config.example.yaml 的 PC 采集端路径基线。"""

from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
CONFIG_EXAMPLE = ROOT / "config.example.yaml"


def test_pc_sensor_example_path_uses_kinship_exe():
    data = yaml.safe_load(CONFIG_EXAMPLE.read_text(encoding="utf-8"))
    assert data["pc_sensor"]["exe_path"].endswith(
        "desktop/pc-sensor/dist/Kinship-PCSensor.exe"
    )
