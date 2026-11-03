"""build_blocks daily review blocks and report-id collision regression tests."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import build_blocks as builder


def _write(root: Path, rel: str, text: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8')


def _daily_review(root: Path, day: str) -> None:
    _write(root, f'data/daily/{day}/复盘-{day}.md',
           '# 复盘\n\n'
           '## 时间线\n\n当天事件。\n\n'
           '## 结论\n\n当天结论。\n')


def test_daily_and_period_reviews_use_distinct_id_schemes(tmp_path):
    root = tmp_path / 'ai'
    _daily_review(root, '2026-11-01')
    _write(root, 'data/reports/每周总结-2026-10-31~11-01.md',
           '# 每周总结\n\n## 概况\n\n本周概况。\n')

    days, rows = builder.build_review(root, None)

    assert days == {'2026-11-01'}
    by_id = {row['block_id']: row for row in rows}
    assert set(by_id) == {
        'R-20261101-D01',
        'R-20261101-D02',
        'R-20261101-01',
    }
    assert by_id['R-20261101-D01']['source_kind'] == 'daily'
    assert by_id['R-20261101-D02']['source_kind'] == 'daily'
    assert by_id['R-20261101-01']['source_kind'] == 'weekly'
    assert by_id['R-20261101-D01']['file'] == 'data/daily/2026-11-01/复盘-2026-11-01.md'
    assert by_id['R-20261101-01']['file'] == 'data/reports/每周总结-2026-10-31~11-01.md'


def test_daily_review_respects_date_filter(tmp_path):
    root = tmp_path / 'ai'
    _daily_review(root, '2026-11-01')
    _daily_review(root, '2026-11-02')

    days, rows = builder.build_review(root, '2026-11-02')

    assert days == {'2026-11-02'}
    assert {row['block_id'] for row in rows} == {
        'R-20261102-D01',
        'R-20261102-D02',
    }
    assert all(row['date'] == '2026-11-02' for row in rows)
