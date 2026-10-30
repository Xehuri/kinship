"""fact_extractor 睡眠表与睡眠阶段行回归测试（新格式 sessions / 旧格式回落）。"""

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import fact_extractor as fe

CST = timezone(timedelta(hours=8))


def _ts(date_str, hhmm):
    return int(
        datetime.strptime(f'{date_str} {hhmm}', '%Y-%m-%d %H:%M')
        .replace(tzinfo=CST)
        .timestamp()
    )


def _row(markdown, date_str):
    prefix = f'| {date_str} |'
    for line in markdown.splitlines():
        if line.startswith(prefix):
            return [cell.strip() for cell in line.strip('|').split('|')]
    raise AssertionError(f'未找到 {date_str} 行:\n{markdown}')


def test_manifest_new_format_10_20():
    date = '2026-10-20'
    sleep_sessions = [
        {
            'bedtime': _ts(date, '07:02'), 'wakeup': _ts(date, '12:53'),
            'duration': 351, 'deep': 88, 'light': 222, 'rem': 41,
            'awake': 1, 'awake_count': 1,
            'stages': [{'t': '07:02', 'stage': 'deep'}],
        },
        {
            'bedtime': _ts(date, '10:13'), 'wakeup': _ts(date, '11:38'),
            'duration': 85, 'deep': 20, 'light': 60, 'rem': 5,
            'awake': 0, 'awake_count': 0,
            'stages': [{'t': '10:13', 'stage': 'light'}],
        },
        {
            'bedtime': _ts(date, '11:05'), 'wakeup': _ts(date, '11:46'),
            'duration': 41, 'deep': 5, 'light': 30, 'rem': 6,
            'awake': 0, 'awake_count': 0,
            'stages': [{'t': '11:05', 'stage': 'light'}],
        },
    ]
    sleep_data = {
        'duration_min': 351, 'deep_min': 88, 'light_min': 222, 'rem_min': 41,
        'awake_min': 1, 'awake_count': 1,
        'bedtime': _ts(date, '07:02'), 'wakeup_time': _ts(date, '12:53'),
        'stages': [{'t': '07:02', 'stage': 'deep'}, {'t': '12:52', 'stage': 'awake'}],
        'sleep_sessions': sleep_sessions,
    }

    markdown = '\n'.join(fe._manifest_sleep_section({date: {'sleep_data': sleep_data}}))

    assert _row(markdown, date)[1:] == [
        '新', '07:02', '12:53', '351', '1', '1', '88', '222', '41', '85+41',
    ]


def test_manifest_new_format_10_27():
    date = '2026-10-27'
    sleep_data = {
        'duration_min': 360, 'deep_min': 120, 'light_min': 198, 'rem_min': 42,
        'awake_min': 0, 'awake_count': 0,
        'bedtime': _ts(date, '00:32'), 'wakeup_time': _ts(date, '06:32'),
        'stages': [{'t': '00:32', 'stage': 'light'}, {'t': '06:31', 'stage': 'awake'}],
        'sleep_sessions': [
            {
                'bedtime': _ts(date, '00:32'), 'wakeup': _ts(date, '06:32'),
                'duration': 360, 'deep': 120, 'light': 198, 'rem': 42,
                'awake': 0, 'awake_count': 0,
                'stages': [{'t': '00:32', 'stage': 'light'}],
            },
        ],
    }

    markdown = '\n'.join(fe._manifest_sleep_section({date: {'sleep_data': sleep_data}}))

    assert _row(markdown, date)[1:] == [
        '新', '00:32', '06:32', '360', '0', '0', '120', '198', '42', '-',
    ]


def test_manifest_old_format_fallback():
    date = '2026-10-20'
    sleep_data = {
        'duration_min': 41, 'deep_min': 88, 'light_min': 222,
        'rem_min': 41, 'awake_min': 41,
        'wakeup_time': _ts(date, '11:46'),
        'stages': [
            {'t': '07:02', 'stage': 'light', 'duration_min': 310},
            {'t': '04:06', 'stage': 'rem', 'duration_min': 1},
            {'t': '04:07', 'stage': 'awake', 'duration_min': 41},
        ],
    }

    markdown = '\n'.join(fe._manifest_sleep_section({date: {'sleep_data': sleep_data}}))

    assert _row(markdown, date)[1:] == [
        '旧', '07:02', '04:07', '-', '1', '1', '88', '222', '41', '-',
    ]


def test_manifest_zero_awake_not_dash():
    date = '2026-10-27'
    sleep_data = {
        'duration_min': 300, 'deep_min': 100, 'light_min': 170, 'rem_min': 30,
        'awake_min': 0, 'awake_count': 0,
    }

    markdown = '\n'.join(fe._manifest_sleep_section({date: {'sleep_data': sleep_data}}))
    cells = _row(markdown, date)

    assert cells[5] == '0'
    assert cells[6] == '0'


def test_section_sleep_stages_includes_nap():
    date = '2026-10-20'
    sleep_data = {
        'sleep_sessions': [
            {'stages': [{'start_ts': _ts(date, '10:13'), 'stage': 'rem', 'duration_min': 85}]},
        ],
    }

    in_window = fe._section_sleep_stages(sleep_data, '10:00', '12:00')
    out_window = fe._section_sleep_stages(sleep_data, '08:00', '09:00')

    assert any('rem(10:13)' in line for line in in_window)
    assert out_window == []
