"""build_blocks legacy 单体理解解析回归测试。"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import build_blocks as builder


def _write(root: Path, rel: str, text: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8')


def _legacy_fixture(tmp_path: Path) -> Path:
    root = tmp_path / 'ai'
    _write(root, 'data/daily/2026-06-13/理解-2026-06-13.md',
           '# 2026-06-13 理解记录\n\n'
           '## 00:00~00:05\n\n第一段。\n\n'
           '## 00:10~00:30 — 第二段\n\n第二段正文。\n\n'
           '## 无时间标题\n\n不应成为 block。\n')
    return root


def test_legacy_file_builds_time_blocks(tmp_path):
    root = _legacy_fixture(tmp_path)
    days, rows = builder.build_legacy(root, '2026-06-13')

    assert days == {'2026-06-13'}
    assert [row['block_id'] for row in rows] == [
        'L-20260613-00-01', 'L-20260613-00-02']
    assert [row['source_type'] for row in rows] == ['legacy', 'legacy']
    assert rows[0]['file'] == 'data/daily/2026-06-13/理解-2026-06-13.md'
    assert rows[0]['line_start'] == 3
    assert rows[0]['line_end'] == 6
    assert rows[1]['heading'] == '00:10~00:30 — 第二段'
    assert rows[1]['text_sha256'] == builder.text_sha256(rows[1]['text'])


def test_all_source_falls_back_to_legacy_for_early_date(tmp_path):
    root = _legacy_fixture(tmp_path)
    out = tmp_path / 'out'
    code = builder.main([
        '--root', str(root),
        '--index-dir', str(out),
        '--date', '2026-06-13',
        '--source', 'all',
        '--dry-run',
        '--json',
    ])

    assert code == 0
    # dry-run must not create the index file
    assert not (out / 'blocks.jsonl').exists()


def test_legacy_is_skipped_when_batch_exists(tmp_path):
    root = _legacy_fixture(tmp_path)
    _write(root, 'data/daily/2026-08-14/理解-2026-08-14.md',
           '# 2026-08-14 理解记录\n\n## 00:00~00:10\n\n旧单体。\n')
    _write(root, 'data/daily/2026-08-14/理解-2026-08-14-批次-08.md',
           '# 批次\n\n## 08:00~08:10\n\n批次段。\n')
    days, rows = builder.build_legacy(root, '2026-08-14')
    assert days == {'2026-08-14'}
    assert rows == []
