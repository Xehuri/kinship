"""data_check_scheduler 七窗排班回归测试（GAP-2）。"""

import sys
from pathlib import Path

TASKS_DIR = Path(__file__).resolve().parents[2] / "data" / "tasks"
sys.path.insert(0, str(TASKS_DIR))

import data_check_scheduler as scheduler

TARGET_DATE = "2026-10-27"


def test_windows_are_exactly_seven_checkpoints():
    assert scheduler.WINDOWS == {
        0: ("22:00", "00:00"),
        6: ("00:00", "06:00"),
        8: ("06:00", "08:00"),
        12: ("08:00", "12:00"),
        16: ("12:00", "16:00"),
        20: ("16:00", "20:00"),
        22: ("20:00", "22:00"),
    }


def test_removed_afternoon_hours_are_absent():
    for hour in (10, 14, 18):
        assert hour not in scheduler.WINDOWS


def test_midnight_prompt_marks_previous_day():
    prompt = scheduler._build_prompt(0, TARGET_DATE)
    assert "前一天" in prompt
    assert TARGET_DATE in prompt
    assert "22:00~00:00" in prompt


def test_afternoon_prompts_use_four_hour_windows():
    assert "08:00~12:00" in scheduler._build_prompt(12, TARGET_DATE)
    assert "12:00~16:00" in scheduler._build_prompt(16, TARGET_DATE)
    assert "16:00~20:00" in scheduler._build_prompt(20, TARGET_DATE)


def test_remaining_prompts_follow_windows_table():
    assert "00:00~06:00" in scheduler._build_prompt(6, TARGET_DATE)
    assert "06:00~08:00" in scheduler._build_prompt(8, TARGET_DATE)
    assert "20:00~22:00" in scheduler._build_prompt(22, TARGET_DATE)
