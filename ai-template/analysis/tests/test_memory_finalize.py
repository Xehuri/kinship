"""memory_finalize 收尾门回归测试（tmp_path 造树，不碰真实 ai/memory）。"""

import hashlib
import json
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import memory_finalize as finalize

STAMP = datetime(2026, 10, 23, 12, 0, tzinfo=timezone.utc)


def _write(root: Path, rel: str, text: str) -> Path:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8')
    return path


def _card(*, date: str = '2026-10-22') -> str:
    return f'---\ntags: [记忆]\nupdated: {date}\n---\n# card\n\n正文。\n'


def _tree(tmp_path: Path) -> Path:
    root = tmp_path / 'repo'
    (root / 'ai' / 'memory').mkdir(parents=True)
    return root


def _fresh_status(root: Path, *, built_at: datetime | None = None,
                  changed_lines: int = 0, source_hashes: dict[str, str] | None = None) -> Path:
    status = root / 'projection-status.json'
    status.write_text(json.dumps({
        'built_at': (built_at or datetime.now().astimezone()).isoformat(timespec='seconds'),
        'changed_lines': changed_lines,
        'candidate_paths': {},
        'source_hashes': source_hashes or {},
        'warnings': [],
    }), encoding='utf-8')
    return status


def _ids(result, severity: str) -> set[str]:
    return {check['id'] for check in result['checks'] if check['severity'] == severity}


def test_broken_link_is_hard_error(tmp_path):
    root = _tree(tmp_path)
    _write(root, 'ai/memory/profile/x.md', _card() + '\n[缺失](nope.md)\n')

    result = finalize.finalize(
        root, ['ai/memory/profile/x.md'], projection_status=_fresh_status(root), now=STAMP)

    assert result['status'] == 'failed'
    assert 'link.broken' in _ids(result, 'error')


def test_filename_date_mismatch_is_hard_error(tmp_path):
    root = _tree(tmp_path)
    _write(root, 'ai/memory/self/scratch/2026-10-22.md',
           '# 草稿\n\n- 2026-10-21 10:00 跨日记录\n')

    result = finalize.finalize(
        root, ['ai/memory/self/scratch/2026-10-22.md'],
        projection_status=_fresh_status(root), now=STAMP)

    assert result['status'] == 'failed'
    assert 'memory.date.mismatch' in _ids(result, 'error')


def test_pii_is_hard_error_and_masked(tmp_path):
    root = _tree(tmp_path)
    _write(root, 'ai/memory/profile/people.md', _card() + '\n电话 13812345678\n')

    result = finalize.finalize(
        root, ['ai/memory/profile/people.md'],
        projection_status=_fresh_status(root), now=STAMP)

    assert result['status'] == 'failed'
    assert 'pii.detected' in _ids(result, 'error')
    assert '13812345678' not in json.dumps(result, ensure_ascii=False)


def test_stale_projection_status_is_hard_error(tmp_path):
    root = _tree(tmp_path)
    _write(root, 'ai/memory/profile/x.md', _card())
    old = STAMP - timedelta(hours=48)

    result = finalize.finalize(
        root, ['ai/memory/profile/x.md'],
        projection_status=_fresh_status(root, built_at=old), now=STAMP)

    assert result['status'] == 'failed'
    assert 'projection.status.stale' in _ids(result, 'error')


def test_clean_run_writes_status_and_is_idempotent(tmp_path):
    root = _tree(tmp_path)
    _write(root, 'ai/memory/profile/x.md', _card())
    status = _fresh_status(root)

    first = finalize.finalize(
        root, ['ai/memory/profile/x.md'], projection_status=status, now=STAMP)
    written = root / 'ai/memory/MEMORY-STATUS.json'
    before = written.read_bytes()
    before_mtime = written.stat().st_mtime_ns

    second = finalize.finalize(
        root, ['ai/memory/profile/x.md'], projection_status=status,
        now=STAMP + timedelta(hours=1))

    assert first['status'] == 'passed'
    assert {'last_finalize_at', 'run_id', 'checks', 'counts', 'status'} <= set(first)
    assert first['run_id'] == second['run_id']
    assert second['last_finalize_at'] == first['last_finalize_at']
    assert written.read_bytes() == before
    assert written.stat().st_mtime_ns == before_mtime


def test_finalize_does_not_modify_source_memory_files(tmp_path):
    root = _tree(tmp_path)
    files = [
        _write(root, 'ai/memory/profile/x.md', _card()),
        _write(root, 'ai/memory/self/必读.md', _card()),
    ]

    def snapshot():
        return {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in files}

    before = snapshot()
    finalize.finalize(
        root, ['ai/memory/profile/x.md', 'ai/memory/self/必读.md'],
        projection_status=_fresh_status(root), now=STAMP)

    assert snapshot() == before


def test_changed_from_git_reads_untracked_memory_files(tmp_path):
    root = _tree(tmp_path)
    subprocess.run(['git', 'init'], cwd=root, capture_output=True, text=True, check=True)
    _write(root, 'ai/memory/profile/x.md', _card())

    result = finalize.finalize(
        root, changed_from='git', projection_status=_fresh_status(root), now=STAMP)

    assert result['changed_files'] == ['ai/memory/profile/x.md']
    assert result['status'] == 'passed'


# ---------- 语义检查（必读硬事实 / fact 冲突 / 证据指针） ----------

def _brief(root: Path, body: str) -> Path:
    return _write(root, 'ai/memory/self/必读.md',
                  f'---\ntags: [记忆]\ndate: 2026-11-17\n---\n# 必读\n\n{body}\n')


_GOOD_FACTS = """# Facts

## FACT-2026-11-01-a 甲
- status: active
- entity: 甲
- attribute: 值
- value: 二
- source: x
"""


def test_hardfacts_missing_is_error(tmp_path):
    root = _tree(tmp_path)
    _brief(root, '## 主线\n- 无\n')
    _write(root, 'ai/memory/ledger/facts.md', _GOOD_FACTS)
    result = finalize.finalize(str(root), ['ai/memory/self/必读.md'], now=STAMP)
    assert 'memory.hardfacts.missing' in [c['id'] for c in result['checks']]
    assert result['status'] == 'failed'


def test_hardfacts_thin_is_error(tmp_path):
    root = _tree(tmp_path)
    _brief(root, '## 硬事实（不许压缩）\n\n- 只有一条\n')
    _write(root, 'ai/memory/ledger/facts.md', _GOOD_FACTS)
    result = finalize.finalize(str(root), ['ai/memory/self/必读.md'], now=STAMP)
    assert 'memory.hardfacts.thin' in [c['id'] for c in result['checks']]


def test_hardfacts_ok(tmp_path):
    root = _tree(tmp_path)
    _brief(root, '## 硬事实（不许压缩）\n\n- 甲＝一\n- 乙＝二\n- 丙＝三\n')
    _write(root, 'ai/memory/ledger/facts.md', _GOOD_FACTS)
    result = finalize.finalize(str(root), ['ai/memory/self/必读.md'], now=STAMP)
    assert 'memory.hardfacts.missing' not in [c['id'] for c in result['checks']]
    assert 'memory.hardfacts.thin' not in [c['id'] for c in result['checks']]


def test_fact_conflict_is_error(tmp_path):
    root = _tree(tmp_path)
    _brief(root, '## 硬事实（不许压缩）\n\n- 甲＝一\n- 乙＝二\n- 丙＝三\n')
    _write(root, 'ai/memory/ledger/facts.md', _GOOD_FACTS + """
## FACT-2026-11-02-a 甲二
- status: active
- entity: 甲
- attribute: 值
- value: 三
- source: x
""")
    result = finalize.finalize(str(root), ['ai/memory/self/必读.md'], now=STAMP)
    assert 'memory.fact.conflict' in [c['id'] for c in result['checks']]
    assert result['status'] == 'failed'


def test_superseded_does_not_conflict(tmp_path):
    root = _tree(tmp_path)
    _brief(root, '## 硬事实（不许压缩）\n\n- 甲＝一\n- 乙＝二\n- 丙＝三\n')
    _write(root, 'ai/memory/ledger/facts.md', _GOOD_FACTS + """
## FACT-2026-11-02-a 甲二
- status: superseded
- entity: 甲
- attribute: 值
- value: 三
- source: x
""")
    result = finalize.finalize(str(root), ['ai/memory/self/必读.md'], now=STAMP)
    assert 'memory.fact.conflict' not in [c['id'] for c in result['checks']]


def test_fact_without_source_is_error(tmp_path):
    root = _tree(tmp_path)
    _brief(root, '## 硬事实（不许压缩）\n\n- 甲＝一\n- 乙＝二\n- 丙＝三\n')
    _write(root, 'ai/memory/ledger/facts.md', """# Facts

## FACT-2026-11-03-b 无源
- status: active
- entity: 乙
- attribute: 值
- value: 四
""")
    result = finalize.finalize(str(root), ['ai/memory/self/必读.md'], now=STAMP)
    assert 'memory.fact.no-source' in [c['id'] for c in result['checks']]
