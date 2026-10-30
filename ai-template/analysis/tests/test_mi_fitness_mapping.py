"""mi_fitness_fetch 睡眠阶段映射与汇总表清醒列回归测试。"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import mi_fitness_fetch as mf


def test_sleep_stage_name():
    assert mf.sleep_stage_name(2) == "深睡"
    assert mf.sleep_stage_name(3) == "浅睡"
    assert mf.sleep_stage_name(4) == "REM"
    assert mf.sleep_stage_name(5) == "清醒"
    assert mf.sleep_stage_name(1) == "未知"
    assert mf.sleep_stage_name(None) == "未知"


def test_sleep_summary_has_awake_columns():
    record = {
        "time": 1788274800,  # 2026-09-01 23:00 (UTC+8)
        "value": {
            "bedtime": 1788274800,
            "duration": 480,
            "sleep_deep_duration": 100,
            "sleep_light_duration": 300,
            "sleep_rem_duration": 80,
            "sleep_awake_duration": 0,
            "awake_count": 0,
            "items": [{"state": 2}, {"state": 3}],
        },
    }
    out = mf.format_summary("sleep", [record])
    assert "清醒(分)" in out
    assert "清醒次" in out
    data_row = next(
        line for line in out.splitlines() if line.strip().startswith("2026-09-01")
    )
    cells = data_row.split()
    assert cells[-3:] == ["0", "0", "2"]
