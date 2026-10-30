"""memory_index_query 只读查询评估器回归测试（tmp_path 造树，不碰真实 ai/）。"""

import hashlib
import json
import os
import sys
from pathlib import Path

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import memory_index_query as mq

FIXED_MTIME = 1_700_000_000


def _write(root: Path, rel: str, text: str) -> Path:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8')
    os.utime(path, (FIXED_MTIME, FIXED_MTIME))
    return path


def _file_entity(path: str, *, kind: str = 'memory_file', title: str = '',
                 date: str | None = None, tags: list[str] | None = None,
                 anchor: str = '#file') -> dict:
    return {
        'path': path, 'kind': kind, 'anchor': anchor, 'title': title,
        'tags': list(tags or []), 'date': date, 'date_source': 'path',
        'frontmatter': {}, 'anchors': [{'heading': title, 'line': 1}],
        'window': None,
    }


def _section_entity(path: str, line: int, *, title: str = '',
                    date: str | None = None) -> dict:
    return {
        'path': path, 'kind': 'batch_section', 'anchor': f'#section={title or line}',
        'title': title, 'tags': [], 'date': date, 'date_source': 'path',
        'frontmatter': {}, 'anchors': [{'heading': title, 'line': line}],
        'window': None,
    }


def _make_index(tmp_path: Path, entities: list[dict], *,
                source_hash: str = 'test-source-hash',
                links: list[dict] | None = None) -> Path:
    index = tmp_path / 'index'
    index.mkdir()
    (index / 'entities.jsonl').write_text(
        ''.join(json.dumps(item, ensure_ascii=False, sort_keys=True) + '\n'
                for item in entities), encoding='utf-8')
    (index / 'links.jsonl').write_text(
        ''.join(json.dumps(item, ensure_ascii=False, sort_keys=True) + '\n'
                for item in (links or [])), encoding='utf-8')
    manifest = {
        'schema_version': 1, 'source_hash': source_hash,
        'generated_at': '2026-10-23T00:00:00Z',
        'counts': {'files': len(entities), 'canonical_files': len(entities)},
        'files': [{'path': item['path']} for item in entities],
    }
    (index / 'manifest.json').write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return index


def _make_queries(tmp_path: Path, queries: list[dict]) -> Path:
    path = tmp_path / 'queries.yaml'
    path.write_text(yaml.safe_dump(queries, allow_unicode=True, sort_keys=False),
                    encoding='utf-8')
    return path


def _query(query_id: str, query: str, match_kind: str,
           expected: list[str], aliases: list[str] | None = None) -> dict:
    return {
        'id': query_id, 'query': query, 'match_kind': match_kind,
        'expected_paths': expected, 'aliases': list(aliases or []),
        'min_hits': 1, 'notes': '',
    }


def _snapshot(root: Path) -> dict[str, tuple[int, int, str]]:
    result: dict[str, tuple[int, int, str]] = {}
    for current, _dirnames, filenames in os.walk(root):
        for name in filenames:
            path = Path(current) / name
            stat = path.stat()
            result[path.relative_to(root).as_posix()] = (
                stat.st_size, stat.st_mtime_ns,
                hashlib.sha256(path.read_bytes()).hexdigest())
    return result


def _evaluate(tmp_path: Path, files: dict[str, str], entities: list[dict],
              queries: list[dict], **kwargs):
    repo = tmp_path / 'repo'
    for rel, text in files.items():
        _write(repo, rel, text)
    index = _make_index(tmp_path, entities)
    query_path = _make_queries(tmp_path, queries)
    return mq.evaluate_files(index, query_path, repo_root=repo, **kwargs)


def test_literal_matches_query_only_and_ranks_expected(tmp_path):
    ev = _evaluate(
        tmp_path,
        {
            'ai/memory/profile/target.md': '# target\n\n示例人物 示例人物\n',
            'ai/memory/profile/alias.md': '# alias\n\nExampleAlias\n',
            'ai/memory/profile/other.md': '# other\n\n无关内容\n',
        },
        [
            _file_entity('ai/memory/profile/target.md', title='target'),
            _file_entity('ai/memory/profile/alias.md', title='alias'),
            _file_entity('ai/memory/profile/other.md', title='other'),
        ],
        [_query('q1', '示例人物', 'literal', ['ai/memory/profile/target.md'],
                aliases=['ExampleAlias'])],
    )
    result = ev.results[0]
    assert result.status == 'PASS'
    assert result.ranked[0].path == 'ai/memory/profile/target.md'
    assert result.ranked[0].evidence['phrase_hits'] == 2
    assert result.ranked[0].evidence['matched_terms'] == ['示例人物']
    assert all(item.path != 'ai/memory/profile/alias.md' for item in result.ranked)


def test_token_uses_aliases_and_cooccurrence(tmp_path):
    ev = _evaluate(
        tmp_path,
        {
            'ai/memory/profile/a.md': '# a\n\ncar train\n',
            'ai/memory/profile/b.md': '# b\n\ncar\n',
            'ai/memory/profile/c.md': '# c\n\nticket\n',
        },
        [
            _file_entity('ai/memory/profile/a.md', title='a'),
            _file_entity('ai/memory/profile/b.md', title='b'),
            _file_entity('ai/memory/profile/c.md', title='c'),
        ],
        [_query('q1', 'ticket', 'token', ['ai/memory/profile/a.md'],
                aliases=['car', 'train'])],
    )
    result = ev.results[0]
    assert result.status == 'PASS'
    assert [item.path for item in result.ranked[:2]] == [
        'ai/memory/profile/a.md', 'ai/memory/profile/b.md']
    assert result.ranked[0].evidence['matched_terms'] == ['car', 'train']
    assert result.ranked[0].evidence['alias_hits'] == 2
    assert all(item.path != 'ai/memory/profile/c.md' for item in result.ranked)


def test_alias_uses_synonyms_only(tmp_path):
    ev = _evaluate(
        tmp_path,
        {
            'ai/memory/profile/bug.md': '# bug\n\nbug\n',
            'ai/memory/profile/issue.md': '# issue\n\nissue\n',
        },
        [
            _file_entity('ai/memory/profile/bug.md', title='bug'),
            _file_entity('ai/memory/profile/issue.md', title='issue'),
        ],
        [_query('q1', 'issue', 'alias', ['ai/memory/profile/bug.md'],
                aliases=['bug'])],
    )
    result = ev.results[0]
    assert result.status == 'PASS'
    assert result.ranked[0].path == 'ai/memory/profile/bug.md'
    assert result.ranked[0].evidence['matched_terms'] == ['bug']
    assert all(item.path != 'ai/memory/profile/issue.md' for item in result.ranked)


def test_mixed_phrase_outranks_alias(tmp_path):
    ev = _evaluate(
        tmp_path,
        {
            'ai/memory/profile/phrase.md': '# phrase\n\nalphabeta\n',
            'ai/memory/profile/alias.md': '# alias\n\ngamma1234\n',
        },
        [
            _file_entity('ai/memory/profile/phrase.md', title='phrase'),
            _file_entity('ai/memory/profile/alias.md', title='alias'),
        ],
        [_query('q1', 'alpha beta', 'mixed', ['ai/memory/profile/phrase.md'],
                aliases=['gamma'])],
    )
    result = ev.results[0]
    assert result.status == 'PASS'
    assert result.ranked[0].path == 'ai/memory/profile/phrase.md'
    assert result.ranked[0].evidence['phrase_hits'] == 1
    alias_item = next(item for item in result.ranked
                      if item.path == 'ai/memory/profile/alias.md')
    assert alias_item.evidence['alias_hits'] == 1
    assert result.ranked[0].score > alias_item.score


def test_top5_and_expected_path_hit(tmp_path):
    files = {f'ai/memory/profile/n{i}.md': '# n\n\n' + 'needle' * i + '\n'
             for i in range(1, 8)}
    entities = [_file_entity(f'ai/memory/profile/n{i}.md', title='n')
                for i in range(1, 8)]
    ev = _evaluate(
        tmp_path, files, entities,
        [
            _query('q_high', 'needle', 'literal', ['ai/memory/profile/n7.md']),
            _query('q_low', 'needle', 'literal', ['ai/memory/profile/n1.md']),
        ],
        top_k=5, required_passes=1,
    )
    high, low = ev.results
    assert len(high.ranked) == 5
    assert high.status == 'PASS'
    assert high.best_expected_rank == 1
    assert high.ranked[0].path == 'ai/memory/profile/n7.md'
    assert low.status == 'FAIL'
    assert low.best_expected_rank == 7
    assert low.expected[0]['in_top_k'] is False
    assert all(item.path != 'ai/memory/profile/n1.md' for item in low.ranked)


def test_batch_sections_aggregate_per_path(tmp_path):
    full = ('# 事实\n\n'
            '## 06:00~06:05 | 手机\n车票\n\n'
            '## 06:05~06:10 | 手机\n12306\n')
    half = '# 事实\n\n## 06:00~06:05 | 手机\n车票\n'
    entities = [
        _file_entity('ai/data/daily/2026-10-21/事实-全天.md',
                     kind='daily_file', title='事实 全天', date='2026-10-21'),
        _section_entity('ai/data/daily/2026-10-21/事实-全天.md', 3,
                        title='06:00~06:05', date='2026-10-21'),
        _section_entity('ai/data/daily/2026-10-21/事实-全天.md', 6,
                        title='06:05~06:10', date='2026-10-21'),
        _file_entity('ai/data/daily/2026-10-21/事实-半天.md',
                     kind='daily_file', title='事实 半天', date='2026-10-21'),
        _section_entity('ai/data/daily/2026-10-21/事实-半天.md', 3,
                        title='06:00~06:05', date='2026-10-21'),
    ]
    ev = _evaluate(
        tmp_path,
        {'ai/data/daily/2026-10-21/事实-全天.md': full,
         'ai/data/daily/2026-10-21/事实-半天.md': half},
        entities,
        [_query('q1', '机票', 'token',
                ['ai/data/daily/2026-10-21/事实-全天.md'],
                aliases=['车票', '12306'])],
    )
    result = ev.results[0]
    assert result.status == 'PASS'
    assert result.ranked[0].path == 'ai/data/daily/2026-10-21/事实-全天.md'
    assert result.ranked[1].path == 'ai/data/daily/2026-10-21/事实-半天.md'
    evidence = result.ranked[0].evidence
    assert evidence['matched_terms'] == ['12306', '车票']
    assert evidence['hit_entities'] == 2
    assert result.ranked[1].evidence['hit_entities'] == 1


def test_recency_only_breaks_ties(tmp_path):
    ev = _evaluate(
        tmp_path,
        {
            'ai/memory/profile/a-old.md': '# note\n\nneedle\n',
            'ai/memory/profile/b-new.md': '# note\n\nneedle\n',
        },
        [
            _file_entity('ai/memory/profile/a-old.md', title='note',
                         date='2026-10-20'),
            _file_entity('ai/memory/profile/b-new.md', title='note',
                         date='2026-10-22'),
        ],
        [_query('q1', 'needle', 'literal', ['ai/memory/profile/b-new.md'])],
    )
    result = ev.results[0]
    assert [item.path for item in result.ranked[:2]] == [
        'ai/memory/profile/b-new.md', 'ai/memory/profile/a-old.md']
    assert result.ranked[0].score == result.ranked[1].score
    assert result.ranked[0].evidence['best_date'] == '2026-10-22'


def test_path_title_tag_hits_are_evidence(tmp_path):
    ev = _evaluate(
        tmp_path,
        {
            'ai/memory/profile/needle.md': '# path\n\nnothing\n',
            'ai/memory/profile/title.md': '# title\n\nnothing\n',
            'ai/memory/profile/tags.md': '# tags\n\nnothing\n',
            'ai/memory/profile/body.md': '# body\n\nneedle\n',
        },
        [
            _file_entity('ai/memory/profile/needle.md', title='path'),
            _file_entity('ai/memory/profile/title.md', title='needle'),
            _file_entity('ai/memory/profile/tags.md', title='tags',
                         tags=['needle']),
            _file_entity('ai/memory/profile/body.md', title='body'),
        ],
        [_query('q1', 'needle', 'literal', ['ai/memory/profile/body.md'])],
    )
    result = ev.results[0]
    ranks = {item.path: item for item in result.ranked}
    assert ranks['ai/memory/profile/needle.md'].evidence['field_hits'] == ['path']
    assert ranks['ai/memory/profile/needle.md'].evidence['field_terms'] == ['needle']
    assert ranks['ai/memory/profile/title.md'].evidence['field_hits'] == ['title']
    assert ranks['ai/memory/profile/title.md'].evidence['field_terms'] == ['needle']
    assert ranks['ai/memory/profile/tags.md'].evidence['field_hits'] == ['tags']
    assert ranks['ai/memory/profile/tags.md'].evidence['field_terms'] == ['needle']
    assert ranks['ai/memory/profile/body.md'].evidence['field_hits'] == []
    assert ranks['ai/memory/profile/body.md'].evidence['phrase_hits'] == 1
    assert result.status == 'PASS'


def test_missing_and_broken_index_raise(tmp_path):
    with pytest.raises(mq.MemoryQueryError):
        mq.load_index(tmp_path / 'missing')
    partial = tmp_path / 'partial'
    partial.mkdir()
    (partial / 'manifest.json').write_text('{"files": []}', encoding='utf-8')
    with pytest.raises(mq.MemoryQueryError):
        mq.load_index(partial)

    repo = tmp_path / 'repo'
    _write(repo, 'ai/memory/profile/a.md', '# a\n\nneedle\n')
    index = _make_index(tmp_path, [_file_entity('ai/memory/profile/a.md',
                                                title='a')])
    (index / 'entities.jsonl').write_text('{not-json}\n', encoding='utf-8')
    with pytest.raises(mq.MemoryQueryError):
        mq.load_index(index)

    broken_manifest = tmp_path / 'broken-manifest'
    broken_manifest.mkdir()
    (broken_manifest / 'entities.jsonl').write_text('', encoding='utf-8')
    (broken_manifest / 'links.jsonl').write_text('', encoding='utf-8')
    (broken_manifest / 'manifest.json').write_text(
        '{"files": []}\n', encoding='utf-8')
    with pytest.raises(mq.MemoryQueryError):
        mq.load_index(broken_manifest)


def test_invalid_query_spec_raises(tmp_path):
    bad_kind = tmp_path / 'bad-kind.yaml'
    bad_kind.write_text(yaml.safe_dump([{
        'id': 'q1', 'query': 'x', 'match_kind': 'fuzzy',
        'expected_paths': ['ai/memory/profile/a.md']}], allow_unicode=True),
        encoding='utf-8')
    with pytest.raises(mq.MemoryQueryError):
        mq.load_queries(bad_kind)

    no_aliases = tmp_path / 'no-aliases.yaml'
    no_aliases.write_text(yaml.safe_dump([{
        'id': 'q1', 'query': 'x', 'match_kind': 'token',
        'expected_paths': ['ai/memory/profile/a.md'], 'aliases': []}],
        allow_unicode=True), encoding='utf-8')
    with pytest.raises(mq.MemoryQueryError):
        mq.load_queries(no_aliases)


def test_deterministic_output_and_no_source_writes(tmp_path):
    repo = tmp_path / 'repo'
    for rel in ('ai/memory/profile/a.md', 'ai/memory/profile/b.md'):
        _write(repo, rel, '# note\n\nneedle 示例人物\n')
    entities = [
        _file_entity('ai/memory/profile/a.md', title='note', date='2026-10-21'),
        _file_entity('ai/memory/profile/b.md', title='note', date='2026-10-22'),
    ]
    index = _make_index(tmp_path, entities)
    query_path = _make_queries(tmp_path, [
        _query('q1', 'needle', 'literal', ['ai/memory/profile/a.md']),
        _query('q2', '示例人物', 'literal', ['ai/memory/profile/b.md']),
    ])
    before = _snapshot(repo)
    first = mq.evaluate_files(index, query_path, repo_root=repo)
    second = mq.evaluate_files(index, query_path, repo_root=repo)
    assert mq.build_report(first) == mq.build_report(second)
    assert mq.render_markdown(first) == mq.render_markdown(second)
    out1 = tmp_path / 'out1'
    out2 = tmp_path / 'out2'
    mq.write_report(first, out1)
    mq.write_report(second, out2)
    for name in (mq.REPORT_JSON, mq.REPORT_MD):
        assert (out1 / name).read_bytes() == (out2 / name).read_bytes()
    assert _snapshot(repo) == before
    assert sorted(path.name for path in out1.iterdir()) == [
        mq.REPORT_JSON, mq.REPORT_MD]


def test_report_json_and_markdown_shape(tmp_path):
    ev = _evaluate(
        tmp_path,
        {'ai/memory/profile/a.md': '# a\n\nneedle needle\n'},
        [_file_entity('ai/memory/profile/a.md', title='a',
                      date='2026-10-21')],
        [_query('q1', 'needle', 'literal', ['ai/memory/profile/a.md'])],
    )
    json_path, md_path = mq.write_report(ev, tmp_path / 'out')
    payload = json.loads(json_path.read_text(encoding='utf-8'))
    assert payload['tool'] == 'memory_index_query'
    assert payload['schema_version'] == 1
    assert set(payload) >= {
        'index', 'queries_file', 'top_k', 'summary', 'queries', 'warnings'}
    assert payload['top_k'] == 5
    assert payload['summary']['total'] == 1
    assert payload['summary']['passed'] == 1
    assert payload['summary']['threshold_met'] is True
    assert len(payload['queries_file']['sha256']) == 64
    query = payload['queries'][0]
    assert set(query) >= {
        'id', 'query', 'match_kind', 'aliases', 'expected_paths', 'min_hits',
        'notes', 'status', 'matched_expected_paths', 'best_expected_rank',
        'expected', 'top'}
    assert query['status'] == 'PASS'
    assert query['top'][0]['path'] == 'ai/memory/profile/a.md'
    assert query['top'][0]['expected'] is True
    assert set(query['top'][0]['evidence']) >= {
        'matched_terms', 'phrase_terms', 'alias_terms', 'phrase_hits',
        'alias_hits', 'coverage', 'field_hits', 'field_terms', 'hit_entities',
        'best_anchor', 'best_line', 'best_title', 'best_date',
        'score_evidence', 'score_field', 'role_prior'}
    assert query['expected'][0]['rank'] == 1
    markdown = md_path.read_text(encoding='utf-8')
    for token in ('# Memory index query report', '## Summary',
                  '## Query details', '| Rank | Path | Score | Evidence |',
                  'q1'):
        assert token in markdown


def test_cli_writes_reports(tmp_path, capsys):
    repo = tmp_path / 'repo'
    _write(repo, 'ai/memory/profile/a.md', '# a\n\nneedle\n')
    index = _make_index(tmp_path, [
        _file_entity('ai/memory/profile/a.md', title='a')])
    query_path = _make_queries(tmp_path, [
        _query('q1', 'needle', 'literal', ['ai/memory/profile/a.md'])])
    out = tmp_path / 'out'
    code = mq.main([
        '--index', str(index), '--queries', str(query_path),
        '--out', str(out), '--repo-root', str(repo), '--min-pass', '1'])
    assert code == 0
    assert (out / mq.REPORT_JSON).is_file()
    assert (out / mq.REPORT_MD).is_file()
    payload = json.loads(capsys.readouterr().out)
    assert payload['summary']['passed'] == 1
    assert payload['summary']['threshold_met'] is True
