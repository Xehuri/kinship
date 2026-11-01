"""memory_audit 只读体检工具的回归测试（全部在 tmp_path 造树，不碰真实记忆目录）。"""

import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import memory_audit as audit

MAIN = Path(__file__).resolve().parents[1] / 'memory_audit.py'
FIXED_SOURCE_TS = datetime(2026, 1, 1, 0, 0, 0).timestamp()
DATE = '2026-10-25'

MAIN_MEMORY = (
    'AGENTS.md, memory/self/必读.md, memory/self/persona-lite.md, '
    'memory/profile/state.md, memory/profile/core-lite.md, memory/topics/INDEX.md, '
    'memory/self/chat-mode.md'
)
SUB_MEMORY = (
    'agents/AGENTS-lite.md, memory/self/必读.md, memory/profile/state.md, '
    'memory/profile/core-lite.md, memory/topics/INDEX.md, memory/profile/规律-摘要.md'
)


def _write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8')
    return path


def _frontmatter(tags: str, extra: str = '') -> str:
    return f'---\ntags: [{tags}]\n{extra}---\n# doc\n'


def _memory_card(tags: str = '记忆', updated: str | None = None,
                 date: str | None = None, extra: str = '') -> str:
    lines = [f'tags: [{tags}]']
    if updated:
        lines.append(f'updated: {updated}')
    if date:
        lines.append(f'date: {date}')
    if extra:
        lines.append(extra)
    return '---\n' + '\n'.join(lines) + '\n---\n# card\n'


def _agent(name: str, memory: str) -> str:
    return f'---\nname: {name}\nmemory: [{memory}]\n---\n# {name}\n'


def _make_tree(tmp_path: Path) -> Path:
    ai = tmp_path / 'root'

    _write(ai / 'AGENTS.md', '# ai agents\n')
    _write(ai / 'agents' / 'main.md', _agent('main', MAIN_MEMORY))
    _write(ai / 'agents' / 'data-checker.md', _agent('data-checker', SUB_MEMORY))
    _write(ai / 'agents' / 'reviewer.md', _agent('reviewer', SUB_MEMORY))
    _write(ai / 'agents' / 'AGENTS-lite.md', '# AGENTS-lite\n')

    memory = ai / 'memory'
    _write(memory / 'self' / '必读.md', _memory_card('记忆, L0, self', date='2026-01-02'))
    _write(memory / 'self' / '身份.md', _memory_card('记忆, self, 身份', date='2026-01-01'))
    _write(memory / 'self' / 'chat-mode.md', _memory_card('记忆, self, chat', date='2026-01-02'))
    _write(memory / 'self' / 'persona-lite.md', _memory_card(
        '记忆, self, projection', updated=DATE, extra='source_files: [self/身份.md]'))
    _write(memory / 'profile' / 'state.md', _memory_card('记忆, 状态快照', date='2026-01-02'))
    _write(memory / 'profile' / 'core.md', _memory_card('记忆, 用户画像', date='2026-01-03'))
    _write(memory / 'profile' / 'core-lite.md', _memory_card(
        '记忆, 用户画像, projection', updated=DATE,
        extra='source_files: [profile/core.md, profile/semantic/]'))
    _write(memory / 'profile' / 'semantic' / '常去地点.md',
           _memory_card('记忆, 语义记忆, 地点', date=DATE))
    _write(memory / 'profile' / '规律-摘要.md', '# 规律摘要\n')
    _write(memory / 'topics' / 'INDEX.md', '# 话题索引\n')
    _write(memory / 'archive' / 'README.md', '# archive\n')

    daily = ai / 'data' / 'daily' / DATE
    _write(daily / f'当日摘要-{DATE}.md', '<!-- summary-v2 -->\n# 摘要\n- 一条\n')
    _write(daily / f'批次索引-{DATE}.md', '<!-- batch-index-v2 -->\n# 索引\n- 一行\n')
    _write(daily / f'理解-{DATE}-批次-08.md', '# 理解\n## 08:00~10:00\n')

    for source in (
        memory / 'self' / '身份.md',
        memory / 'profile' / 'core.md',
        memory / 'profile' / 'semantic' / '常去地点.md',
    ):
        os.utime(source, (FIXED_SOURCE_TS, FIXED_SOURCE_TS))
    return ai


@pytest.fixture()
def tree(tmp_path: Path) -> Path:
    return _make_tree(tmp_path)


def _ids(report, severity: str) -> set[str]:
    return {item['id'] for item in report[severity]}


def test_estimate_tokens_uses_cjk_formula():
    assert audit.estimate_tokens('abcd') == 1
    assert audit.estimate_tokens('你好abcd') == 2


def test_check_passes_on_clean_tree(tree: Path, capsys):
    report = audit.build_report(tree)
    assert report['errors'] == []
    assert report['warnings'] == []
    assert audit.main(['--root', str(tree), 'check']) == 0
    assert 'SUMMARY errors=0 warnings=0' in capsys.readouterr().out


def test_main_extra_memory_item_is_error(tree: Path, capsys):
    main_path = tree / 'agents' / 'main.md'
    _write(main_path, _agent('main', MAIN_MEMORY + ', memory/self/身份.md'))

    report = audit.build_report(tree)
    assert 'agent.main.memory.count' in _ids(report, 'errors')
    assert audit.main(['--root', str(tree), 'check']) == 1
    output = capsys.readouterr().out
    assert 'ERROR [agent.main.memory.count]' in output


def test_missing_memory_tag_is_error(tree: Path):
    _write(
        tree / 'memory' / 'profile' / 'semantic' / '新卡.md',
        _memory_card('人物, 新卡', updated=DATE),
    )

    report = audit.build_report(tree)
    assert 'memory.tag.missing' in _ids(report, 'errors')
    tagged = [item for item in report['errors'] if item['path'].endswith('新卡.md')]
    assert len(tagged) == 1


def test_stale_projection_is_error(tree: Path):
    persona = tree / 'memory' / 'self' / 'persona-lite.md'
    _write(persona, _memory_card(
        '记忆, self, projection', updated='2000-01-01',
        extra='source_files: [self/身份.md]'))

    report = audit.build_report(tree)
    stale = [item for item in report['errors'] if item['id'] == 'projection.stale']
    assert len(stale) == 1
    assert stale[0]['path'].endswith('self/persona-lite.md')


def test_oversized_summary_and_index_are_errors(tree: Path):
    daily = tree / 'data' / 'daily' / DATE
    _write(daily / f'当日摘要-{DATE}.md', '<!-- summary-v2 -->\n' + 'x' * 30_000)
    _write(daily / f'批次索引-{DATE}.md', '<!-- batch-index-v2 -->\n' + 'x' * 5_000)

    report = audit.build_report(tree)
    ids = _ids(report, 'errors')
    assert 'daily.summary.oversize' in ids
    assert 'daily.index.oversize' in ids


def test_legacy_summary_only_warns(tree: Path):
    daily = tree / 'data' / 'daily' / DATE
    _write(daily / f'当日摘要-{DATE}.md', '# legacy\n' + 'x' * 30_000)
    (daily / f'批次索引-{DATE}.md').unlink()

    report = audit.build_report(tree)
    assert report['errors'] == []
    warning_ids = _ids(report, 'warnings')
    assert 'daily.summary.legacy' in warning_ids
    assert 'daily.index.pending_v2' in warning_ids
    assert audit.main(['--root', str(tree), 'check']) == 0


def test_finalized_legacy_summary_is_error(tree: Path):
    daily = tree / 'data' / 'daily' / DATE
    _write(daily / f'当日摘要-{DATE}.md', '# legacy\n' + 'x' * 30_000)
    (daily / f'批次索引-{DATE}.md').unlink()
    _write(daily / f'复盘-{DATE}.md', '# 复盘\n')

    report = audit.build_report(tree)
    assert 'daily.summary.legacy' in _ids(report, 'errors')
    assert 'daily.index.pending_v2' in _ids(report, 'errors')


def test_scan_and_report_json_are_parseable(tree: Path):
    scan = subprocess.run(
        [sys.executable, str(MAIN), '--root', str(tree), 'scan'],
        capture_output=True, text=True, check=False,
    )
    assert scan.returncode == 0, scan.stderr
    assert 'PATH\tCATEGORY\tBYTES\tLINES\tTOKENS\tTAGS\tUPDATED\tSTATUS' in scan.stdout
    assert 'memory/self/必读.md' in scan.stdout

    report = subprocess.run(
        [sys.executable, str(MAIN), '--root', str(tree), 'report', '--json'],
        capture_output=True, text=True, check=False,
    )
    assert report.returncode == 0, report.stderr
    payload = json.loads(report.stdout)
    assert {'generated_at', 'files', 'totals', 'checks', 'errors', 'warnings'} <= set(payload)
    assert payload['totals']['files'] == len(payload['files'])
    assert payload['files'] == sorted(payload['files'], key=lambda item: item['path'])
