"""memory_write CLI 回归测试（tmp_path 造树，不碰真实记忆目录）。"""

import hashlib
import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import memory_write

MODULE = Path(__file__).resolve().parents[1] / 'memory_write.py'
MONTH = datetime.now().strftime('%Y-%m')
LOG_LINE_RE = re.compile(r'^- \d{4}-\d{2}-\d{2} \d{2}:\d{2} \[01数据检查\] line-\d+$')
SCRATCH_LINE_RE = re.compile(r'^- \[\d{2}:\d{2}\]\[来源:批次-12\]\[类型:想法\] .+$')


def _tree(tmp_path: Path) -> Path:
    root = tmp_path / 'memory'
    for rel in ('self/执行日志', 'self/scratch', 'profile', 'topics'):
        (root / rel).mkdir(parents=True, exist_ok=True)
    return root


def _main(root: Path, command: str, *args: str) -> int:
    return memory_write.main([command, '--root', str(root), *args])


def _marker_lines(path: Path) -> list[str]:
    return [line for line in path.read_text(encoding='utf-8').splitlines()
            if line.strip().startswith('<!-- mem:')]


def _body_lines(path: Path) -> list[str]:
    return [line for line in path.read_text(encoding='utf-8').splitlines()
            if not line.strip().startswith('<!-- mem:')]


def _active_count(path: Path) -> int:
    return sum('status=active' in line for line in _marker_lines(path))


def test_append_log_concurrent_20_processes(tmp_path):
    root = _tree(tmp_path)
    commands = [
        [sys.executable, str(MODULE), 'append-log', '--root', str(root),
         '--text', f'line-{index}', '--task', '01数据检查']
        for index in range(20)
    ]
    processes = [
        subprocess.Popen(cmd, cwd=str(tmp_path), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        for cmd in commands
    ]
    for process in processes:
        stdout, stderr = process.communicate(timeout=60)
        assert process.returncode == 0, stderr.decode('utf-8', errors='replace')

    files = list((root / 'self/执行日志').glob('*.md'))
    assert len(files) == 1
    assert files[0].name == f'{MONTH}.md'
    raw = files[0].read_bytes()
    assert b'\r\n' not in raw
    lines = raw.decode('utf-8').splitlines()
    assert len(lines) == 20
    assert all(LOG_LINE_RE.match(line) for line in lines)
    assert sorted(lines) == sorted(set(lines))


def test_append_scratch_format(tmp_path):
    root = _tree(tmp_path)
    assert _main(root, 'append-scratch', '--date', '2026-01-01', '--source', '批次-12',
                 '--type', '想法', '--text', '第一条') == 0
    assert _main(root, 'append-scratch', '--date', '2026-01-01', '--source', '批次-12',
                 '--type', '想法', '--text', '第二条') == 0

    target = root / 'self/scratch/2026-01-01.md'
    lines = target.read_text(encoding='utf-8').splitlines()
    assert len(lines) == 2
    assert all(SCRATCH_LINE_RE.match(line) for line in lines)
    assert lines[0].endswith('第一条')
    assert lines[1].endswith('第二条')


@pytest.mark.parametrize('bad_source', ['外部', 'batch-01', ''])
def test_append_scratch_rejects_bad_source(tmp_path, bad_source):
    root = _tree(tmp_path)
    assert _main(root, 'append-scratch', '--date', '2026-01-01', '--source', bad_source,
                 '--type', '想法', '--text', 'x') == 2
    assert not (root / 'self/scratch/2026-01-01.md').exists()


def test_upsert_new_noop_and_supersede(tmp_path, capsys):
    root = _tree(tmp_path)
    target = root / 'self/必读.md'
    header = '---\ntags: [记忆]\n---\n# 必读\n\n'
    target.write_text(header, encoding='utf-8')

    assert _main(root, 'upsert', '--file', str(target), '--key', '定位',
                 '--text', '第一版', '--source', '复盘', '--importance', '3') == 0
    first = target.read_text(encoding='utf-8')
    assert first.startswith(header)
    assert _active_count(target) == 1
    text_hash = hashlib.sha256('第一版'.encode('utf-8')).hexdigest()[:8]
    expected_id = hashlib.sha1(('定位' + text_hash).encode('utf-8')).hexdigest()[:12]
    marker = _marker_lines(target)[0]
    for field in ('id=', 'key=定位', 'status=active', 'valid_from=',
                  'source=复盘', 'importance=3', f'hash={text_hash}'):
        assert field in marker
    assert f'id={expected_id}' in marker

    before = target.read_bytes()
    capsys.readouterr()
    assert _main(root, 'upsert', '--file', str(target), '--key', '定位',
                 '--text', '第一版', '--source', '复盘', '--importance', '3') == 0
    assert 'NOOP' in capsys.readouterr().out
    assert target.read_bytes() == before

    assert _main(root, 'upsert', '--file', str(target), '--key', '定位',
                 '--text', '第二版', '--source', '复盘', '--importance', '4') == 0
    second = target.read_text(encoding='utf-8')
    assert '第一版' in second
    assert '第二版' in second
    assert _active_count(target) == 1
    superseded = [line for line in _marker_lines(target) if 'status=superseded' in line]
    assert len(superseded) == 1
    assert 'superseded_by=' in superseded[0]
    assert 'invalid_at=' in superseded[0]
    assert f'superseded_by={expected_id}' not in superseded[0]


def test_mark_changes_only_marker_line(tmp_path):
    root = _tree(tmp_path)
    target = root / 'self/必读.md'
    target.write_text('# 必读\n\n', encoding='utf-8')
    _main(root, 'upsert', '--file', str(target), '--key', 'k1', '--text', 'A', '--source', '复盘')
    _main(root, 'upsert', '--file', str(target), '--key', 'k1', '--text', 'B', '--source', '复盘')
    body_before = _body_lines(target)

    assert _main(root, 'mark', '--file', str(target), '--key', 'k1',
                 '--status', 'invalid', '--invalid-at', '2026-01-02') == 0
    assert _active_count(target) == 0
    assert all('status=invalid' in line for line in _marker_lines(target))
    assert all('invalid_at=2026-01-02' in line for line in _marker_lines(target))
    assert _body_lines(target) == body_before


def test_check_detects_duplicate_active_and_missing_field(tmp_path, capsys):
    root = _tree(tmp_path)
    dup = root / 'self/认知.md'
    dup.write_text(
        '<!-- mem: id=a1; key=k; status=active; valid_from=2026-01-01; '
        'source=x; importance=3; hash=aaaaaaaa -->\nA\n'
        '<!-- mem: id=a2; key=k; status=active; valid_from=2026-01-01; '
        'source=x; importance=3; hash=bbbbbbbb -->\nB\n',
        encoding='utf-8',
    )
    assert _main(root, 'check', '--budgets') == 1
    output = capsys.readouterr().out
    assert 'active' in output and 'k' in output

    dup.unlink()
    missing = root / 'self/认知.md'
    missing.write_text(
        '<!-- mem: id=a1; key=k; status=active; valid_from=2026-01-01; '
        'source=x; importance=3 -->\nA\n',
        encoding='utf-8',
    )
    before = missing.read_bytes()
    assert _main(root, 'check', '--budgets') == 1
    assert '缺字段' in capsys.readouterr().out
    assert missing.read_bytes() == before


def test_check_detects_budget_overflow(tmp_path, capsys):
    root = _tree(tmp_path)
    (root / 'self/必读.md').write_bytes(b'x' * (3 * 1024 + 1))
    assert _main(root, 'check', '--budgets') == 1
    assert '超预算' in capsys.readouterr().out

    (root / 'self/必读.md').write_bytes(b'x' * 100)
    (root / 'topics/INDEX.md').write_text('\n'.join('line' for _ in range(80)), encoding='utf-8')
    assert _main(root, 'check', '--budgets') == 0
    (root / 'topics/INDEX.md').write_text('\n'.join('line' for _ in range(81)), encoding='utf-8')
    assert _main(root, 'check', '--budgets') == 1


def test_path_traversal_exits_2(tmp_path, capsys):
    root = _tree(tmp_path)
    outside = tmp_path / 'outside.md'
    assert _main(root, 'append-log', '--file', str(outside), '--text', 'x', '--task', 't') == 2
    assert not outside.exists()

    assert _main(root, 'upsert', '--file', str(outside), '--key', 'k', '--text', 'x',
                 '--source', '复盘') == 2
    assert not outside.exists()

    link = root / 'self/link.md'
    link.symlink_to(outside)
    assert _main(root, 'append-log', '--file', str(link), '--text', 'x', '--task', 't') == 2
    assert not outside.exists()
    assert '路径越界' in capsys.readouterr().err


def test_snapshot_manifest_and_source_unchanged(tmp_path):
    root = _tree(tmp_path)
    keep = root / 'self/必读.md'
    keep.write_text('# 必读\n', encoding='utf-8')
    (root / 'archive').mkdir(exist_ok=True)
    (root / 'archive/old.md').write_text('old\n', encoding='utf-8')
    source_before = keep.read_bytes()

    assert _main(root, 'snapshot', '--reason', '测试快照') == 0
    manifests = list((root / '.backups').glob('*/MANIFEST.json'))
    assert len(manifests) == 1
    manifest = json.loads(manifests[0].read_text(encoding='utf-8'))
    paths = [item['path'] for item in manifest['files']]
    assert 'self/必读.md' in paths
    assert 'archive/old.md' not in paths
    assert manifest['reason'] == '测试快照'
    record = next(item for item in manifest['files'] if item['path'] == 'self/必读.md')
    assert record['bytes'] == len(source_before)
    assert record['sha256'] == hashlib.sha256(source_before).hexdigest()
    assert keep.read_bytes() == source_before

    assert _main(root, 'snapshot', '--reason', '第二次') == 0
    assert len(list((root / '.backups').glob('*/MANIFEST.json'))) == 2


def test_newline_style_preserved(tmp_path):
    root = _tree(tmp_path)
    lf = root / 'self/lf.md'
    lf.write_bytes(b'# t\n\n- old\n')
    assert _main(root, 'upsert', '--file', str(lf), '--key', 'k', '--text', 'A',
                 '--source', '复盘') == 0
    lf_raw = lf.read_bytes()
    assert b'\r\n' not in lf_raw
    assert lf_raw.startswith(b'# t\n\n- old\n')

    crlf = root / 'self/crlf.md'
    crlf.write_bytes(b'# t\r\n\r\n- old\r\n')
    assert _main(root, 'upsert', '--file', str(crlf), '--key', 'k', '--text', 'A',
                 '--source', '复盘') == 0
    crlf_raw = crlf.read_bytes()
    assert crlf_raw.startswith(b'# t\r\n\r\n- old\r\n')
    assert b'\n' not in crlf_raw.replace(b'\r\n', b'')

    assert _main(root, 'append-log', '--file', str(crlf), '--text', '日志',
                 '--task', '01数据检查') == 0
    appended = crlf.read_bytes()
    assert b'\n' not in appended.replace(b'\r\n', b'')


def test_global_root_and_root_relative_file(tmp_path, monkeypatch):
    root = _tree(tmp_path)
    elsewhere = tmp_path / 'elsewhere'
    elsewhere.mkdir()
    monkeypatch.chdir(elsewhere)

    assert memory_write.main(['--root', str(root), 'append-log', '--text', 'g',
                              '--task', '01数据检查']) == 0
    assert (root / 'self/执行日志' / f'{MONTH}.md').exists()

    assert memory_write.main(['--root', str(root), 'upsert', '--file', 'self/必读.md',
                              '--key', 'k', '--text', 'v', '--source', '复盘']) == 0
    assert (root / 'self/必读.md').exists()
    assert memory_write.main(['--root', str(root), 'check']) == 0


def test_snapshot_rejects_backups_symlink_escape(tmp_path):
    root = _tree(tmp_path)
    outside = tmp_path / 'outside-backups'
    outside.mkdir()
    (root / '.backups').symlink_to(outside, target_is_directory=True)

    assert _main(root, 'snapshot', '--reason', '越界') == 2
    assert list(outside.iterdir()) == []
