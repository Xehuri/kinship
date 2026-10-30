"""check_coverage 七检查点与跨午夜窗口回归测试（样本全部在 tmp_path 生成）。"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import check_coverage as cc

DATE = '2026-10-27'
HOUR = 3600


def _write_batch(base: Path, date: str, hh: int, *slots: str) -> Path:
    date_dir = base / date
    date_dir.mkdir(parents=True, exist_ok=True)
    path = date_dir / f'理解-{date}-批次-{hh:02d}.md'
    body = '# 理解记录\n\n' + '\n\n'.join(f'## {slot} 测试时段' for slot in slots) + '\n'
    path.write_text(body, encoding='utf-8')
    return path


def _seven_checkpoints() -> dict:
    return {
        'cov-00': {'window': '22:00~00:00', 'trigger': '00:00', 'target_date': 'previous_day'},
        'cov-06': {'window': '00:00~06:00', 'trigger': '06:00', 'target_date': 'today'},
        'cov-08': {'window': '06:00~08:00', 'trigger': '08:00', 'target_date': 'today'},
        'cov-12': {'window': '08:00~12:00', 'trigger': '12:00', 'target_date': 'today'},
        'cov-16': {'window': '12:00~16:00', 'trigger': '16:00', 'target_date': 'today'},
        'cov-20': {'window': '16:00~20:00', 'trigger': '20:00', 'target_date': 'today'},
        'cov-22': {'window': '20:00~22:00', 'trigger': '22:00', 'target_date': 'today'},
    }


def test_parse_understood_slots_handles_both_night_boundaries(tmp_path):
    _write_batch(tmp_path, DATE, 6, '00:00~06:00')
    _write_batch(tmp_path, DATE, 22, '22:00~00:00')

    files = cc.find_understanding_files(str(tmp_path / DATE))
    slots = cc.parse_understood_slots(files)

    assert (0, 6 * HOUR, '00:00', '06:00') in slots
    assert (22 * HOUR, 24 * HOUR, '22:00', '00:00') in slots


def test_get_understood_last_time_prefers_cross_midnight_late_slot(tmp_path):
    _write_batch(tmp_path, DATE, 6, '00:00~06:00')
    _write_batch(tmp_path, DATE, 22, '22:00~00:00')

    end_seconds, start_str, end_str = cc.get_understood_last_time(DATE, str(tmp_path))

    assert (end_seconds, start_str, end_str) == (24 * HOUR, '22:00', '00:00')


def test_get_understood_last_time_compensates_00_slot_to_next_day(tmp_path):
    _write_batch(tmp_path, DATE, 6, '00:00~06:00')

    end_seconds, start_str, end_str = cc.get_understood_last_time(DATE, str(tmp_path))

    assert (end_seconds, start_str, end_str) == (30 * HOUR, '00:00', '06:00')


def test_internal_gap_spanning_0600_is_reported(tmp_path):
    _write_batch(tmp_path, DATE, 2, '00:00~04:00')
    _write_batch(tmp_path, DATE, 8, '08:00~10:00')

    passed, gaps = cc.check_internal_gaps(
        DATE, str(tmp_path), raw_first_seconds=0, raw_last_seconds=10 * HOUR
    )

    assert passed is False
    assert gaps == [('04:00', '08:00', 4 * HOUR, '理解时段之间')]


def test_internal_gap_exactly_7200s_is_reported(tmp_path):
    _write_batch(tmp_path, DATE, 2, '02:00~04:00')
    _write_batch(tmp_path, DATE, 6, '06:00~08:00')

    passed, gaps = cc.check_internal_gaps(
        DATE, str(tmp_path), raw_first_seconds=2 * HOUR, raw_last_seconds=8 * HOUR
    )

    assert passed is False
    assert gaps == [('04:00', '06:00', 7200, '理解时段之间')]


def test_internal_gap_below_7200s_is_ignored(tmp_path):
    _write_batch(tmp_path, DATE, 2, '02:00~04:00')
    _write_batch(tmp_path, DATE, 6, '05:59~08:00')

    passed, gaps = cc.check_internal_gaps(
        DATE, str(tmp_path), raw_first_seconds=2 * HOUR, raw_last_seconds=8 * HOUR
    )

    assert passed is True
    assert gaps == []


def test_validate_profile_accepts_seven_checkpoint_contract():
    result = cc.validate_profile({'name': 'merged_7', 'checkpoints': _seven_checkpoints()})

    assert result['ok'] is True
    assert result['errors'] == []
    assert result['checkpoint_ids'] == list(cc.CHECKPOINT_WINDOWS)
    assert result['windows']['cov-00'] == ('22:00', '00:00')
    assert result['windows']['cov-06'] == ('00:00', '06:00')
    assert result['cov00_target_date'] == 'previous_day'


def test_validate_profile_rejects_missing_checkpoint():
    checkpoints = _seven_checkpoints()
    del checkpoints['cov-00']

    result = cc.validate_profile(checkpoints)

    assert result['ok'] is False
    assert any('cov-00' in error for error in result['errors'])


def test_validate_profile_rejects_legacy_ten_window():
    checkpoints = _seven_checkpoints()
    checkpoints['cov-12']['window'] = '10:00~12:00'

    result = cc.validate_profile(checkpoints)

    assert result['ok'] is False
    assert any('cov-12' in error and '08:00~12:00' in error for error in result['errors'])


def test_validate_profile_rejects_cov00_targeting_today():
    checkpoints = _seven_checkpoints()
    checkpoints['cov-00']['target_date'] = 'today'

    result = cc.validate_profile(checkpoints)

    assert result['ok'] is False
    assert any('cov-00' in error and 'previous_day' in error for error in result['errors'])
