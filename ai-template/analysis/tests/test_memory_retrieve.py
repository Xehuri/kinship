"""memory_retrieve 只读检索工具回归测试（tmp_path 造最小记忆树，不碰生产）。"""

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import memory_retrieve as retrieve

MODULE = Path(__file__).resolve().parents[1] / 'memory_retrieve.py'
FIXED_MTIME = 1_700_000_000  # 固定 mtime，隔离 recency


def _write(root: Path, rel: str, text: str, mtime: float = FIXED_MTIME) -> Path:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8')
    os.utime(path, (mtime, mtime))
    return path


def _run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(MODULE), *args],
        capture_output=True,
        text=True,
        timeout=60,
    )


def test_cjk_bigram_hits_person_and_ranks_first(tmp_path):
    root = tmp_path / 'memory'
    _write(root, 'people/人物甲.md',
           '# 人物甲\n\n与人物甲的通话记录：人物甲说周末回家。\n')
    _write(root, 'topics/天气.md', '# 天气\n\n今天晴天，适合散步。\n')

    assert retrieve.tokenize('人物 通话') == ['人物', '通话']
    result = retrieve.retrieve(root, '人物 通话', budget=6000, max_items=12, context=0)

    paths = [item['path'] for item in result['items']]
    assert paths[0] == 'people/人物甲.md'
    assert paths == ['people/人物甲.md']
    assert '人物' in result['items'][0]['text']


def test_heading_hit_is_weighted(tmp_path):
    root = tmp_path / 'memory'
    body = '睡眠是每天都会发生的事，' * 6 + '\n'
    _write(root, 'topics/a.md', f'# 睡眠锚点\n\n{body}')
    _write(root, 'topics/b.md', f'# 无关标题\n\n{body}')

    result = retrieve.retrieve(root, '睡眠', budget=6000, max_items=12, context=0)
    first, second = result['items'][0], result['items'][1]
    assert first['path'] == 'topics/a.md'
    assert second['path'] == 'topics/b.md'
    assert first['score'] > second['score']


def test_budget_truncates_by_utf8_bytes(tmp_path):
    root = tmp_path / 'memory'
    body = '睡眠' * 75 + '\n'  # 单行约 450 字节
    for index in range(5):
        _write(root, f'topics/note-{index}.md', f'# 睡眠记录 {index}\n\n{body}')

    result = retrieve.retrieve(root, '睡眠', budget=600, max_items=12, context=0)
    assert 0 < len(result['items']) < 5
    assert result['total_bytes'] <= 600
    assert sum(len(item['text'].encode('utf-8')) for item in result['items']) == result['total_bytes']


def test_context_lines_have_correct_numbers(tmp_path):
    root = tmp_path / 'memory'
    _write(root, 'topics/context.md',
           '# A\n第一段。\n睡眠很好。\n# B\n第二段。\n')

    result = retrieve.retrieve(root, '睡眠', budget=6000, max_items=12, context=1)
    item = result['items'][0]
    assert item['line'] == 2  # 正文首行，而非标题行
    assert '    1 | # A' in item['text']
    assert '    2 | 第一段。' in item['text']
    assert '    3 | 睡眠很好。' in item['text']
    assert '    4 | # B' in item['text']
    assert '    5 | 第二段。' not in item['text']


def test_empty_query_and_missing_root_exit_2(tmp_path):
    root = tmp_path / 'memory'
    _write(root, 'topics/a.md', '# A\n\n睡眠。\n')

    empty = _run('--query', '   ', '--root', str(root))
    stopwords = _run('--query', '的 了 是', '--root', str(root))
    missing = _run('--query', '睡眠', '--root', str(tmp_path / 'nope'))

    assert empty.returncode == 2
    assert stopwords.returncode == 2
    assert missing.returncode == 2


def test_run_is_read_only(tmp_path):
    root = tmp_path / 'memory'
    files = [
        _write(root, 'topics/a.md', '# A\n\n睡眠记录。\n'),
        _write(root, 'self/必读.md', '# 必读\n\n睡眠与记忆。\n'),
    ]

    def snapshot() -> dict[str, tuple[str, int]]:
        return {
            str(path): (hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_mtime_ns)
            for path in files
        }

    before = snapshot()
    proc = _run('--query', '睡眠', '--root', str(root), '--json')
    after = snapshot()

    assert proc.returncode == 0
    assert json.loads(proc.stdout)['items']
    assert before == after


def test_excludes_archive_template_backups_and_pycache(tmp_path):
    root = tmp_path / 'memory'
    for rel in (
        'archive/old.md',
        '_template/card.md',
        '.backups/snap.md',
        '__pycache__/junk.md',
    ):
        _write(root, rel, '# 睡眠\n\n睡眠归档记录。\n')
    _write(root, 'topics/keep.md', '# 睡眠\n\n睡眠现行记录。\n')

    result = retrieve.retrieve(root, '睡眠', budget=6000, max_items=12, context=0)
    assert {item['path'] for item in result['items']} == {'topics/keep.md'}


def test_symlink_escaping_root_is_skipped(tmp_path):
    root = tmp_path / 'memory'
    outside = tmp_path / 'outside.md'
    outside.write_text('# 睡眠\n\n睡眠越界记录。\n', encoding='utf-8')
    _write(root, 'topics/keep.md', '# 睡眠\n\n睡眠现行记录。\n')
    link = root / 'leak.md'
    try:
        link.symlink_to(outside)
    except OSError as exc:  # 极端文件系统不支持符号链接
        pytest.skip(f'无法创建符号链接：{exc}')

    result = retrieve.retrieve(root, '睡眠', budget=6000, max_items=12, context=0)
    assert {item['path'] for item in result['items']} == {'topics/keep.md'}
