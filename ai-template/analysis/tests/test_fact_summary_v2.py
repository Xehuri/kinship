"""fact_extractor 当日摘要 v2 / 批次索引 v2 回归测试（全部用临时构造数据）。"""

import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import fact_extractor as fe

DATE = '2026-01-01'

_REQUIRED_API = (
    'update_daily_summary',
    'update_batch_index',
    'SUMMARY_MAX_CHARS',
    'SUMMARY_MAX_BYTES',
    'BATCH_INDEX_MAX_CHARS',
    'BATCH_INDEX_MAX_BYTES',
)
if not all(hasattr(fe, name) for name in _REQUIRED_API):
    pytest.skip(
        'fact_extractor 尚未提供 summary-v2 接口，模板升级后启用',
        allow_module_level=True,
    )


def _write_batch(daily_dir, hh, body, date=DATE):
    path = Path(daily_dir) / f'理解-{date}-批次-{hh:02d}.md'
    path.write_text(body, encoding='utf-8')
    return path


def _section(title, judgement, observations):
    lines = [f'## {title}', '', '【综合判断】', judgement, '', '【关键观察】']
    lines.extend(f'- {obs}' for obs in observations)
    return '\n'.join(lines) + '\n'


def _batch_index_rows(index):
    return [
        line for line in index.splitlines()
        if line.startswith('| ') and '---' not in line and not line.startswith('| HH')
    ]


def test_summary_without_subblocks_keeps_judgement_and_observations(tmp_path):
    body = '# 理解记录\n\n' + _section(
        '08:00~09:00', '用户在看视频。置信度: 高', ['观察一', '观察二'])
    _write_batch(tmp_path, 8, body)

    summary = fe.update_daily_summary(DATE, daily_dir=str(tmp_path))

    assert summary.startswith('<!-- summary-v2 -->')
    assert '## 批08' in summary
    assert '### 08:00~09:00' in summary
    assert '- 综合判断: 用户在看视频。置信度: 高；关键观察: 观察一' in summary
    assert '观察二' not in summary


def test_summary_with_subblocks_keeps_each_block(tmp_path):
    body = (
        '# 理解记录\n\n'
        '## 08:00~10:00\n\n'
        '【综合判断】\n全窗判断\n\n'
        '【关键观察】\n- 全窗观察\n\n'
        '#### 段1 睡眠尾段\n\n【综合判断】\n判断一\n\n【关键观察】\n- 观察A\n\n'
        '#### 段2 起床\n\n【综合判断】\n判断二\n\n【关键观察】\n- 观察B\n'
    )
    _write_batch(tmp_path, 10, body)

    summary = fe.update_daily_summary(DATE, daily_dir=str(tmp_path))

    assert '- 综合判断: 全窗判断；关键观察: 全窗观察' in summary
    assert '- [段1] 综合判断: 判断一；关键观察: 观察A' in summary
    assert '- [段2] 综合判断: 判断二；关键观察: 观察B' in summary


def test_extract_section_block_respects_char_budgets():
    long_judgement = '判' * 500
    long_obs = '观' * 500
    body = (
        '【综合判断】\n' + long_judgement + '\n\n'
        '【关键观察】\n- ' + long_obs + '\n- ' + long_obs + '\n- ' + long_obs + '\n'
    )

    judgement, observations = fe._extract_section_block(body)

    assert len(judgement) <= 200
    assert judgement.endswith('…')
    assert len(observations) == 3
    assert all(len(obs) <= 200 for obs in observations)
    assert observations[0].endswith('…')
    assert sum(map(len, observations)) + len(judgement) <= 1200


def test_truncate_doc_respects_utf8_byte_cap():
    marker = '<!-- truncated -->'
    text = '汉' * 1000

    out = fe._truncate_doc(text, 24000, marker, max_bytes=101)

    assert len(out.encode('utf-8')) <= 101
    assert len(out) <= 24000
    assert out.endswith(marker)


def test_summary_global_cap_truncates_with_marker(tmp_path):
    for hh in range(24):
        parts = ['# 理解记录', '']
        for start in (0, 30):
            title = f'{hh:02d}:{start:02d}~{hh:02d}:{start + 29:02d}'
            parts.append(_section(title, '判' * 500, ['观' * 500] * 3))
        _write_batch(tmp_path, hh, '\n'.join(parts))

    summary = fe.update_daily_summary(DATE, daily_dir=str(tmp_path))

    assert len(summary) <= fe.SUMMARY_MAX_CHARS
    assert len(summary.encode('utf-8')) <= fe.SUMMARY_MAX_BYTES
    for hh in range(24):
        assert f'## 批{hh:02d}' in summary


def test_batch_index_uses_real_section_line_numbers(tmp_path):
    body = '\n'.join([
        '# 理解记录',            # 1
        '',                      # 2
        '> 说明',                # 3
        '',                      # 4
        '## 08:00~09:00',        # 5
        '',                      # 6
        '【综合判断】',          # 7
        '判断甲',                # 8
        '',                      # 9
        '【关键观察】',          # 10
        '- 观察甲',              # 11
        '- 观察乙',              # 12
        '- 观察丙',              # 13
        '',                      # 14
        '## 08:30~09:00',        # 15
        '',                      # 16
        '【综合判断】',          # 17
        '判断乙',                # 18
        '',                      # 19
        '【关键观察】',          # 20
        '- 观察丁',              # 21
    ]) + '\n'
    fname = f'理解-{DATE}-批次-08.md'
    _write_batch(tmp_path, 8, body)

    index = fe.update_batch_index(DATE, daily_dir=str(tmp_path))

    assert index.startswith(f'# {DATE} 批次索引')
    assert '<!-- batch-index-v2 -->' in index
    assert f'| 08 | 08:00~09:00 | 判断甲 | 观察甲 | {fname}:5 |' in index
    assert '| 08 | 08:30~09:00' not in index
    assert '观察丙' not in index
    assert len(index) <= fe.BATCH_INDEX_MAX_CHARS
    assert len(index.encode('utf-8')) <= fe.BATCH_INDEX_MAX_BYTES


def test_empty_directory_returns_headers_without_writing(tmp_path):
    summary = fe.update_daily_summary(DATE, daily_dir=str(tmp_path))
    index = fe.update_batch_index(DATE, daily_dir=str(tmp_path))

    assert '（暂无批次文件）' in summary
    assert '（暂无批次文件）' in index
    assert list(tmp_path.iterdir()) == []


def test_batch_index_global_cap_truncates_with_marker(tmp_path):
    for hh in range(24):
        parts = ['# 理解记录', '']
        for start in (0, 30):
            title = f'{hh:02d}:{start:02d}~{hh:02d}:{start + 29:02d}'
            parts.append(_section(title, '判' * 300, ['观' * 300, '察' * 300]))
        _write_batch(tmp_path, hh, '\n'.join(parts))

    index = fe.update_batch_index(DATE, daily_dir=str(tmp_path))

    assert len(index) <= fe.BATCH_INDEX_MAX_CHARS
    assert len(index.encode('utf-8')) <= fe.BATCH_INDEX_MAX_BYTES
    rows = _batch_index_rows(index)
    assert len(rows) == 24
    assert all(re.search(r'\.md:\d+ \|$', row) for row in rows)
