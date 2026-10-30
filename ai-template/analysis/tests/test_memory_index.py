"""memory_index 只读索引的回归测试（全部在 tmp_path 造树，不碰真实 ai/）。"""

import hashlib
import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import memory_index_lib as lib

DATES = ('2026-10-20', '2026-10-21', '2026-10-22')


def _write(repo: Path, rel: str, text: str) -> Path:
    path = repo / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8')
    return path


def _write_bytes(repo: Path, rel: str, data: bytes) -> Path:
    path = repo / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def _fixture(tmp_path: Path) -> Path:
    repo = tmp_path / 'repo'
    _write(repo, 'ai/memory/README.md', '# 记忆系统\n\n根索引。\n')
    _write(repo, 'ai/memory/self/README.md', '# self 索引\n')
    _write(repo, 'ai/memory/fact/2026-09.md',
           '---\ntags: [记忆, fact索引]\ndate: 2026-09-01\n---\n# 2026-09 索引\n')
    _write(repo, 'ai/memory/self/执行日志/2026-09.md', '# 执行日志 2026-09\n')
    _write(repo, 'ai/memory/profile/core.md', '# 用户画像\n')
    _write(repo, 'ai/memory/profile/core-lite.md',
           '---\ntags: [记忆, 投影]\nupdated: 2026-10-22\n'
           'source_files: [profile/core.md, profile/semantic/]\n---\n# core-lite\n')
    _write(repo, 'ai/memory/self/认知.md',
           '---\ntags: [记忆, 认知]\ndate: 2026-10-21\n---\n'
           '# 认知\n\n见 [[README.md]]、[[理解-2026-10-20-批次-06]]、'
           '[[深度回顾-2026-09-02~2026-09-15]]、[[no-such-note]]。\n')
    _write(repo, 'ai/memory/self/认知.md.bak-20260101', '# 备份\n')
    _write(repo, 'ai/memory/profile/semantic/people/示例人物.md',
           '---\nname: 示例人物\ndescription: 测试人物\ntype: profile/people\n'
           'date: 2026-09-09\ntags: [记忆, 人物]\n---\n'
           '# 示例人物\n\n- 全名 **示例人物**，昵称 示例昵称/Example；'
           'QQ名"示例QQ昵称"，微信联系人"示例微信名"。\n')
    _write(repo, 'ai/memory/profile/semantic/people/同学朋友.md',
           '---\nname: 同学朋友\ndescription: 测试聚合\ntype: profile/people\n'
           'date: 2026-09-09\ntags: [记忆, 人物]\n---\n'
           '# 同学朋友\n\n## 学校同学\n\n- 示例同学甲 | 培训同伴\n- 示例同学乙/示例同学丙 | 游戏朋友\n')
    _write(repo, 'ai/memory/archive/old.md', '# 旧档\n')
    _write(repo, 'ai/memory/_template/t.md', '# 模板\n')
    _write(repo, 'ai/memory/__pycache__/x.pyc', 'ignored')

    _write(repo, 'ai/data/daily/2026-10-19/复盘-2026-10-19.md', '# 复盘 10-19\n')
    _write(repo, 'ai/data/reports/深度回顾-2026-09-02~2026-09-15.md', '# 深度回顾\n')
    _write(repo, 'ai/data/daily/2026-10-20/理解-2026-10-20-批次-06.md',
           '---\ntags: [理解, 数据检查, 2026-10-20]\ntype: data/daily\n'
           'date: 2026-10-20\nwindow: 06:00~06:35\n---\n'
           '# 2026-10-20 06:00~06:35 理解记录\n\n'
           '## 06:00~06:35\n正文 06。\n\n'
           '## 06:35~06:55\n正文 06b。见 [[复盘-2026-10-19]]。\n')
    _write(repo, 'ai/data/daily/2026-10-20/当日摘要-2026-10-20.md', '# 当日摘要\n')
    _write(repo, 'ai/data/daily/2026-10-20/复盘-2026-10-20.md',
           '---\ndate: 2026-10-20\ntags: [复盘]\nlinks:\n'
           '  - [[当日摘要-2026-10-20|当日摘要]]\n'
           '  - [[理解-2026-10-20-批次-06|理解]]\n---\n# 复盘 10-20\n')
    _write(repo, 'ai/data/daily/2026-10-20/perception.jsonl',
           '{"a": 1}\n\nnot-json\n{"b": 2}\n')
    _write_bytes(repo, 'ai/data/daily/2026-10-20/audio/clip.flac', b'fLaC\x00fake')

    _write(repo, 'ai/data/daily/2026-10-21/理解-2026-10-21-批次-补14.md',
           '# 补14\n\n## 14:00~14:40\n补 14 正文。\n')
    _write(repo, 'ai/data/daily/2026-10-21/理解-2026-10-21-批次-补16.md',
           '# 补16\n\n## 16:00~16:40\n补 16 正文。\n')
    _write(repo, 'ai/data/daily/2026-10-21/health.json', '{"legacy": true}\n')

    _write(repo, 'ai/data/daily/2026-10-22/事实-全天.md',
           '# 事实\n\n## 06:00~06:05 | 手机\nA\n\n## 06:00~06:05 | 手机\nB\n')

    _write(repo, 'ai/data/users/example-user/health/2026-10-20/cloud.json',
           json.dumps({'source': 'cloud', 'date': '2026-10-20',
                       'fetched_at': 1792707992, 'samples': [1, 2, 3]}) + '\n')
    return repo


def _snapshot(root: Path) -> dict[str, tuple[int, int, str]]:
    result: dict[str, tuple[int, int, str]] = {}
    for current, _dirnames, filenames in os.walk(root):
        for name in filenames:
            path = Path(current) / name
            stat = path.stat()
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            result[path.relative_to(root).as_posix()] = (
                stat.st_size, stat.st_mtime_ns, digest)
    return result


def test_build_is_zero_write_and_deterministic(tmp_path):
    repo = _fixture(tmp_path)
    before = _snapshot(repo)
    first = lib.build_index(repo, DATES, tmp_path / 'run1')
    second = lib.build_index(repo, DATES, tmp_path / 'run2')

    assert _snapshot(repo) == before
    assert first.source_hash == second.source_hash
    assert first.manifest['source_hash'] == second.manifest['source_hash']
    assert (tmp_path / 'run1/entities.jsonl').read_bytes() == \
        (tmp_path / 'run2/entities.jsonl').read_bytes()
    assert (tmp_path / 'run1/links.jsonl').read_bytes() == \
        (tmp_path / 'run2/links.jsonl').read_bytes()
    assert sorted(path.name for path in (tmp_path / 'run1').iterdir()) == [
        'entities.jsonl', 'links.jsonl', 'manifest.json', 'status.json']
    manifest = first.manifest
    for name in ('entities.jsonl', 'links.jsonl', 'status.json'):
        data = (tmp_path / 'run1' / name).read_bytes()
        assert manifest['outputs'][name]['sha256'] == hashlib.sha256(data).hexdigest()
        assert manifest['outputs'][name]['bytes'] == len(data)


def test_broken_link_reporting_and_frontmatter_links(tmp_path):
    repo = _fixture(tmp_path)
    result = lib.build_index(repo, DATES, tmp_path / 'out')

    broken = [link for link in result.links if link['resolution'] == 'broken']
    assert [(link['source_path'], link['target_raw']) for link in broken] == [
        ('ai/memory/self/认知.md', 'no-such-note')]
    assert result.status['links']['broken'] == 1
    assert result.status['links']['broken_items'][0]['target_raw'] == 'no-such-note'

    exact = [link for link in result.links
             if link['source_path'] == 'ai/memory/self/认知.md'
             and link['target_raw'] == 'README.md']
    assert exact and exact[0]['resolution'] == 'exact'
    assert exact[0]['resolved_path'] == 'ai/memory/self/README.md'

    daily = [link for link in result.links
             if link['source_path'] == 'ai/memory/self/认知.md'
             and link['target_raw'] == '理解-2026-10-20-批次-06']
    assert daily and daily[0]['resolution'] == 'daily'
    assert daily[0]['date'] == '2026-10-20'

    report = [link for link in result.links
              if link['target_raw'] == '深度回顾-2026-09-02~2026-09-15']
    assert report and report[0]['resolution'] == 'repo'
    assert report[0]['resolved_path'] == \
        'ai/data/reports/深度回顾-2026-09-02~2026-09-15.md'

    frontmatter_links = [link for link in result.links
                         if link['source_kind'] == 'frontmatter_links']
    assert {link['alias'] for link in frontmatter_links} == {'当日摘要', '理解'}
    assert all(link['resolution'] == 'exact' for link in frontmatter_links)

    source_links = [link for link in result.links
                    if link['source_kind'] == 'source_files']
    assert len(source_links) == 2
    assert all(link['resolution'] == 'exact' for link in source_links)


def test_duplicate_basenames_use_path_based_ids(tmp_path):
    repo = _fixture(tmp_path)
    result = lib.build_index(repo, DATES, tmp_path / 'out')

    readmes = [entity for entity in result.entities
               if entity['kind'] == 'memory_file'
               and entity['path'].endswith('README.md')]
    assert len(readmes) == 2
    assert readmes[0]['entity_id'] != readmes[1]['entity_id']
    assert {entity['path'] for entity in readmes} == {
        'ai/memory/README.md', 'ai/memory/self/README.md'}

    duplicate_names = {item['basename']
                       for item in result.status['duplicate_basenames']['items']}
    assert {'README.md', '2026-09.md'} <= duplicate_names


def test_missing_health_json_uses_backend_shard(tmp_path):
    repo = _fixture(tmp_path)
    result = lib.build_index(repo, DATES, tmp_path / 'out')
    health = result.status['health']['dates']

    assert health['2026-10-20']['source'] == 'backend_shard'
    assert health['2026-10-20']['shard_present'] is True
    assert health['2026-10-20']['daily_health_json_present'] is False
    assert health['2026-10-21']['source'] == 'legacy_health_json'
    assert health['2026-10-22']['source'] == 'missing'

    manifest = {item['path']: item for item in result.manifest['files']}
    shard_path = 'ai/data/users/example-user/health/2026-10-20/cloud.json'
    assert manifest[shard_path]['is_health_shard'] is True
    assert 'ai/data/daily/2026-10-20/health.json' not in manifest
    assert manifest['ai/data/daily/2026-10-21/health.json']['is_health_json'] is True
    shards = [entity for entity in result.entities if entity['kind'] == 'health_shard']
    assert [entity['path'] for entity in shards] == [shard_path]


def test_bu_files_are_not_dropped(tmp_path):
    repo = _fixture(tmp_path)
    result = lib.build_index(repo, DATES, tmp_path / 'out')
    daily_paths = {entity['path'] for entity in result.entities
                   if entity['kind'] == 'daily_file'}
    assert any('批次-补14' in path for path in daily_paths)
    assert any('批次-补16' in path for path in daily_paths)
    section_paths = {entity['path'] for entity in result.entities
                     if entity['kind'] == 'batch_section'}
    assert any('批次-补14' in path for path in section_paths)
    assert any('批次-补16' in path for path in section_paths)


def test_jsonl_bad_and_blank_lines_are_counted(tmp_path):
    repo = _fixture(tmp_path)
    result = lib.build_index(repo, DATES, tmp_path / 'out')
    jsonl = result.status['jsonl']

    assert jsonl['files'] == 1
    assert jsonl['lines'] == 4
    assert jsonl['blank_lines'] == 1
    assert jsonl['bad_lines'] == 1
    detail = jsonl['details']['ai/data/daily/2026-10-20/perception.jsonl']
    assert detail['first_bad']['line'] == 3


def test_backup_and_audio_are_metadata_only(tmp_path):
    repo = _fixture(tmp_path)
    result = lib.build_index(repo, DATES, tmp_path / 'out')
    manifest = {item['path']: item for item in result.manifest['files']}

    backup = manifest['ai/memory/self/认知.md.bak-20260101']
    assert backup['canonical'] is False
    assert backup['backup'] is True
    assert not any('.bak-' in entity['path'] for entity in result.entities)

    audio = manifest['ai/data/daily/2026-10-20/audio/clip.flac']
    assert audio['kind'] == 'audio'
    assert audio['sha256'] is None
    assert result.status['manifest']['metadata_only'] >= 1


def test_duplicate_section_headings_get_distinct_ids(tmp_path):
    repo = _fixture(tmp_path)
    result = lib.build_index(repo, DATES, tmp_path / 'out')
    sections = [entity for entity in result.entities
                if entity['kind'] == 'batch_section'
                and entity['path'].endswith('事实-全天.md')]
    assert [entity['anchor'] for entity in sections] == [
        '#section=06:00~06:05@1', '#section=06:00~06:05@2']
    assert sections[0]['entity_id'] != sections[1]['entity_id']
    assert sections[0]['window'] == {'start': '06:00', 'end': '06:05'}


def test_dry_run_writes_nothing(tmp_path):
    repo = _fixture(tmp_path)
    before = _snapshot(repo)
    out = tmp_path / 'out'
    result = lib.build_index(repo, DATES, out, dry_run=True)

    assert not out.exists()
    assert result.written == ()
    assert result.summary['dry_run'] is True
    assert result.summary['manifest_files'] > 0
    assert result.manifest['counts']['files'] == result.summary['manifest_files']
    assert _snapshot(repo) == before
