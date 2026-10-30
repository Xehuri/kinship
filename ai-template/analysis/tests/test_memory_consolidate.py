"""memory_consolidate 回归测试（tmp_path 造树，不碰真实记忆目录）。"""

import hashlib
import json
import os
import sys
import time
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import memory_consolidate as consolidate


def _root(tmp_path: Path) -> Path:
    root = tmp_path / 'memory'
    (root / 'self' / 'scratch').mkdir(parents=True)
    return root


def _write(path: Path, text: str, newline: str = '\n') -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(text.replace('\n', newline).encode('utf-8'))
    return path


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _state(root: Path) -> dict[str, tuple[str, int, int]]:
    return {
        path.relative_to(root).as_posix(): (_sha(path), path.stat().st_mtime_ns, path.stat().st_size)
        for path in sorted(root.rglob('*')) if path.is_file()
    }


def _main(root: Path, mode: str, *args: str) -> int:
    return consolidate.main(['--mode', mode, '--root', str(root), *args])


def _json(capsys) -> dict:
    return json.loads(capsys.readouterr().out)


def test_daily_default_is_dry_run_and_candidates_need_age_and_marker(tmp_path, capsys):
    root = _root(tmp_path)
    today = date.today()
    old = (today - timedelta(days=10)).isoformat()
    young = (today - timedelta(days=2)).isoformat()
    _write(
        root / 'self' / 'scratch' / f'{old}.md',
        '# 草稿\n'
        '- 保留未标记\n'
        '- [08:00][来源:主会话][类型:想法] 已处理 →已收割(必读.md)\n'
        '- [08:01][来源:主会话][类型:候选] 丢弃 →丢弃(重复)\n',
    )
    _write(
        root / 'self' / 'scratch' / f'{young}.md',
        '# 草稿\n- [09:00][来源:主会话][类型:想法] 未满七天 →已收割(任务.md)\n',
    )
    _write(root / 'self' / 'scratch' / 'README.md', '# 说明\n→已收割(不是行标记)\n')
    before = _state(root)

    assert _main(root, 'daily', '--json') == 0
    report = _json(capsys)

    assert report['dry_run'] is True
    assert report['deleted_lines'] == 0
    assert report['files_scanned'] == 3
    assert report['candidate_lines'] == 2
    assert {item['path'] for item in report['candidates']} == {f'self/scratch/{old}.md'}
    assert [item['line'] for item in report['candidates']] == [3, 4]
    assert report['skipped']['young_marked_lines'] == 1
    assert report['skipped']['unmarked_lines'] == 3
    assert report['skipped']['undated_files'] == ['self/scratch/README.md']
    assert _state(root) == before
    assert not (root / '.backups').exists()


def test_daily_apply_deletes_candidates_preserves_rest_and_is_idempotent(tmp_path, capsys):
    root = _root(tmp_path)
    old = (date.today() - timedelta(days=10)).isoformat()
    target = _write(
        root / 'self' / 'scratch' / f'{old}.md',
        f'# 草稿 · {old}\n'
        '\n'
        '- 保留一行\n'
        '- [08:00][来源:主会话][类型:想法] 已处理 →已收割(必读.md)\n'
        '- [08:01][来源:主会话][类型:候选] 丢弃 →丢弃(重复)\n'
        '- 尾行未标记\n',
    )
    other = _write(root / 'self' / 'scratch' / 'README.md', '# 说明\n保留\n')
    untouched = _write(root / 'self' / '必读.md', '# 必读\n- 长期条目\n')
    target_sha = _sha(target)
    rel = f'self/scratch/{old}.md'

    assert _main(root, 'daily', '--apply', '--json') == 0
    report = _json(capsys)

    assert report['dry_run'] is False
    assert report['candidate_lines'] == 2
    assert report['deleted_lines'] == 2
    assert report['files_changed'] == [rel]
    text = target.read_text(encoding='utf-8')
    assert text == f'# 草稿 · {old}\n\n- 保留一行\n- 尾行未标记\n'
    assert target_sha != _sha(target)
    assert other.read_text(encoding='utf-8') == '# 说明\n保留\n'
    assert untouched.read_text(encoding='utf-8') == '# 必读\n- 长期条目\n'

    backups = sorted((root / '.backups').iterdir())
    assert len(backups) == 1
    manifest = json.loads((backups[0] / 'MANIFEST.json').read_text(encoding='utf-8'))
    listed = {item['path']: item for item in manifest['files']}
    assert listed[rel]['sha256'] == target_sha
    assert manifest['reason'].startswith('memory_consolidate daily')

    after_first = _state(root)
    capsys.readouterr()
    assert _main(root, 'daily', '--apply', '--json') == 0
    second = _json(capsys)
    assert second['candidate_lines'] == 0
    assert second['deleted_lines'] == 0
    assert second['snapshot'] is None
    assert _state(root) == after_first
    assert len(sorted((root / '.backups').iterdir())) == 1


def test_daily_apply_keeps_emptied_file(tmp_path, capsys):
    root = _root(tmp_path)
    old = (date.today() - timedelta(days=10)).isoformat()
    target = _write(
        root / 'self' / 'scratch' / f'{old}.md',
        '- [08:00][来源:主会话][类型:候选] 唯一行 →丢弃(无价值)\n',
    )

    assert _main(root, 'daily', '--apply', '--json') == 0
    assert _json(capsys)['deleted_lines'] == 1
    assert target.exists()
    assert target.read_bytes() == b''


def test_daily_apply_preserves_crlf_and_lf(tmp_path, capsys):
    root = _root(tmp_path)
    today = date.today()
    old = (today - timedelta(days=10)).isoformat()
    crlf = _write(
        root / 'self' / 'scratch' / f'{old}.md',
        '# 草稿\n- 保留行\n- [08:00][来源:主会话][类型:想法] 处理 →已收割(必读.md)\n- 尾行\n',
        newline='\r\n',
    )
    lf = _write(
        root / 'self' / 'scratch' / f'{(today - timedelta(days=9)).isoformat()}.md',
        '# 草稿\n- 保留行\n- [08:00][来源:主会话][类型:想法] 处理 →丢弃(重复)\n',
    )

    assert _main(root, 'daily', '--apply', '--json') == 0
    assert _json(capsys)['deleted_lines'] == 2

    raw_crlf = crlf.read_bytes()
    assert b'\r\n' in raw_crlf
    assert raw_crlf.replace(b'\r\n', b'').count(b'\n') == 0
    assert '已收割' not in raw_crlf.decode('utf-8')
    assert '保留行' in raw_crlf.decode('utf-8')
    assert b'\r' not in lf.read_bytes()


def test_weekly_reports_duplicates_stale_oversize_and_done_tasks(tmp_path, capsys):
    root = _root(tmp_path)
    shared = '共同重复段落内容，这行足够长用于跨文件检测。'
    _write(
        root / 'self' / 'alpha.md',
        '# Alpha\n\n'
        f'{shared}\n\n'
        '同一文件里重复出现的一行内容。\n\n'
        '同一文件里重复出现的一行内容。\n',
    )
    _write(root / 'self' / 'beta.md', f'# Beta\n\n{shared}\n')
    _write(root / 'self' / 'gamma.md', '\n'.join(f'line {index}' for index in range(1, 306)) + '\n')
    stale = _write(root / 'self' / 'old.md', '# 旧文件\n内容\n')
    stale_ts = time.time() - 40 * 86400
    os.utime(stale, (stale_ts, stale_ts))
    _write(root / 'archive' / 'dup.md', f'# Archive\n\n{shared}\n')
    _write(root / '_template' / 'dup.md', f'# Template\n\n{shared}\n')
    _write(
        root / 'self' / '任务.md',
        '# 任务\n- [x] 已完成任务甲\n- [ ] 未完成任务\n- [X] 已完成任务乙\n',
    )
    before = _state(root)

    assert _main(root, 'weekly', '--apply', '--json') == 0
    report = _json(capsys)

    assert report['dry_run'] is False
    assert report['write_actions'] == []
    assert report['files_scanned'] == 5
    assert _state(root) == before

    paragraphs = {item['hash']: item for item in report['duplicate_paragraphs']}
    assert len(paragraphs) == 1
    group = next(iter(paragraphs.values()))
    assert group['file_count'] == 2
    assert {item['path'] for item in group['occurrences']} == {'self/alpha.md', 'self/beta.md'}
    assert all(not item['path'].startswith(('archive/', '_template/'))
               for item in group['occurrences'])
    assert shared in group['preview']

    alpha_dupes = [item for item in report['duplicate_lines'] if item['path'] == 'self/alpha.md']
    assert len(alpha_dupes) == 1
    assert alpha_dupes[0]['count'] == 2

    assert [item['path'] for item in report['stale_files']] == ['self/old.md']
    assert report['stale_files'][0]['age_days'] >= 30
    assert [item['path'] for item in report['oversized_files']] == ['self/gamma.md']
    assert report['oversized_files'][0]['lines'] == 305
    assert report['oversized_files'][0]['suggestion'] == '拆分'
    assert [(item['line'], '- [x]' in item['text'].lower()) for item in report['completed_tasks']] == [
        (2, True),
        (4, True),
    ]


def test_path_traversal_via_symlink_exits_2(tmp_path, capsys):
    root = tmp_path / 'memory'
    (root / 'self').mkdir(parents=True)
    outside = tmp_path / 'outside'
    outside.mkdir()
    target = _write(
        outside / '2026-01-01.md',
        '- [08:00][来源:主会话][类型:想法] 外部 →已收割(外部.md)\n',
    )
    (root / 'self' / 'scratch').symlink_to(outside, target_is_directory=True)
    target_sha = _sha(target)

    assert _main(root, 'daily', '--apply') == 2
    assert '路径越界' in capsys.readouterr().err
    assert _sha(target) == target_sha
    assert not (root / '.backups').exists()
