#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""只读记忆索引构建库（M1）。

索引范围：
- ai/memory/**（排除 archive/、_template/、.backups/、__pycache__/、.git/）
- ai/data/daily/{date}/**（默认今天及前两天，动态计算；可用 --dates 显式指定）
- ai/data/users/{用户标识}/health/{date}/cloud.json（健康真源分片；
  用户标识默认 example-user，可用环境变量 MEMORY_HEALTH_USER 覆盖）

产物（由 CLI 写到 --out）：
- entities.jsonl：文件实体、批次小节实体、人物别名/条目实体、健康分片实体
- links.jsonl：wikilink、frontmatter links、source_files 三条来源的链接
- manifest.json：源文件清单 + 计数 + source_hash + 产物哈希
- status.json：链接解析/破损、JSONL 坏行、健康来源、重复 basename 等状态

硬约束：
- 只读源文件；所有写入只发生在 --out 目录内。
- 不读音频内容，不 hash 音频/二进制，只记 size/mtime。
- source_hash 排除 mtime、generated_at、绝对路径等易变字段，两次构建必须一致。
- 纯标准库，Python 3.10+。
"""

# allow: SIZE_OK — 单一职责的只读索引流水线（扫描 -> 实体 -> 链接 -> 状态 -> 落盘），
# 拆文件会让共享数据结构与确定性哈希口径分散，反而不利于审计。

from __future__ import annotations

import hashlib
import json
import os
import posixpath
import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import date as date_cls
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence

SCHEMA_VERSION = 1
DEFAULT_DATES = tuple(
    (date_cls.today() - timedelta(days=offset)).isoformat() for offset in (2, 1, 0)
)
HEALTH_USER = os.environ.get('MEMORY_HEALTH_USER', 'example-user')
OUTPUT_NAMES = ('entities.jsonl', 'links.jsonl', 'status.json', 'manifest.json')

EXCLUDED_DIR_NAMES = frozenset({'archive', '_template', '.backups', '__pycache__', '.git'})
BACKUP_RE = re.compile(r'\.bak(?:-|$)')
BACKUP_SPLIT_RE = re.compile(r'\.bak(?:-.*)?$')
TEXT_EXTENSIONS = frozenset({
    '.md', '.markdown', '.txt', '.json', '.jsonl', '.yaml', '.yml', '.csv',
    '.tsv', '.py', '.js', '.ts', '.html', '.css', '.xml', '.toml', '.ini',
    '.cfg', '.log',
})
AUDIO_EXTENSIONS = frozenset({
    '.flac', '.wav', '.mp3', '.m4a', '.ogg', '.opus', '.aac', '.wma', '.amr',
})
IMAGE_EXTENSIONS = frozenset({'.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic'})

FRONTMATTER_RE = re.compile(r'^---\r?\n(.*?)\r?\n---(?:\r?\n|$)', re.S)
DATE_RE = re.compile(r'\d{4}-\d{2}-\d{2}')
SECTION_RE = re.compile(r'^##\s+(\d{1,2}:\d{2})\s*[~～]\s*(\d{1,2}:\d{2})(.*)$')
WIKILINK_RE = re.compile(r'\[\[([^\[\]]+)\]\]')
H1_RE = re.compile(r'^#\s+(.+?)\s*$')
HEADING_RE = re.compile(r'^#{1,6}\s+(.+?)\s*$')
NICKNAME_RE = re.compile(r'(?<![\u4e00-\u9fff])昵称\s*[：:]?\s*([^，,；;。\n]+)')
QUOTED_ALIAS_RES = (
    (re.compile(r'(?<![\u4e00-\u9fff])QQ名\s*[“"]([^”"]+)[”"]'), 'qq'),
    (re.compile(r'(?<![\u4e00-\u9fff])微信联系人\s*[“"]([^”"]+)[”"]'), 'wechat'),
    (re.compile(r'(?<![\u4e00-\u9fff])花名\s*[“"]([^”"]+)[”"]'), 'nickname'),
    (re.compile(r'(?<![\u4e00-\u9fff])(?:别名|又名)\s*[：:]?\s*([^，,；;。\n]+)'), 'alias'),
)
PERSON_ENTRY_RE = re.compile(r'^\s*-\s+(.+?)\s*\|\s*(.*)$')
AGGREGATE_PEOPLE_FILES = frozenset({'同学朋友', '待确认人物'})


class MemoryIndexError(Exception):
    """可预期的索引构建错误。"""


@dataclass(frozen=True)
class BuildResult:
    source_hash: str
    manifest: dict[str, Any]
    status: dict[str, Any]
    entities: tuple[dict[str, Any], ...]
    links: tuple[dict[str, Any], ...]
    summary: dict[str, Any]
    written: tuple[str, ...] = ()


@dataclass
class _ScanState:
    repo: Path
    dates: tuple[str, ...]
    files: list[dict[str, Any]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def _utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')


def _mtime_iso(path: Path) -> str:
    return datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).replace(
        microsecond=0).isoformat().replace('+00:00', 'Z')


def _posix(path: Path, repo: Path) -> str:
    return path.resolve().relative_to(repo.resolve()).as_posix()


def _read_text(path: Path) -> str:
    return path.read_text(encoding='utf-8', errors='replace')


def _hash_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def _unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
        return value[1:-1]
    return value


def split_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    """与 memory_audit.py 同口径的最小 YAML frontmatter 解析器。"""
    text = text.lstrip('\ufeff')
    match = FRONTMATTER_RE.match(text)
    if not match:
        return {}, text
    data: dict[str, Any] = {}
    current_key: str | None = None
    for raw_line in match.group(1).splitlines():
        line = raw_line.rstrip()
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        item = re.match(r'^\s*-\s+(.*)$', line)
        if item and current_key:
            bucket = data.get(current_key)
            if not isinstance(bucket, list):
                bucket = []
                data[current_key] = bucket
            bucket.append(_unquote(item.group(1).strip()))
            continue
        key_value = re.match(r'^([A-Za-z0-9_-]+):\s*(.*)$', line)
        if not key_value:
            continue
        current_key = key_value.group(1)
        value = key_value.group(2).strip()
        if value.startswith('[') and value.endswith(']'):
            body = value[1:-1]
            data[current_key] = [_unquote(part.strip()) for part in body.split(',') if part.strip()]
        elif value:
            data[current_key] = _unquote(value)
        else:
            data[current_key] = []
    return data, text[match.end():]


def _tags(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value if str(item).strip()]
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    return []


def _as_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    return []


def _parse_date(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    candidate = value.strip()[:10]
    try:
        return date_cls.fromisoformat(candidate).isoformat()
    except ValueError:
        return None


def _date_from_path(rel: str) -> str | None:
    match = re.search(r'/(?:daily|health)/(\d{4}-\d{2}-\d{2})/', '/' + rel)
    return match.group(1) if match else None


def _date_from_filename(name: str) -> str | None:
    match = DATE_RE.search(name)
    return match.group(0) if match else None


def _classify(path: Path) -> tuple[str, bool]:
    suffix = Path(BACKUP_SPLIT_RE.sub('', path.name)).suffix.lower()
    if suffix in AUDIO_EXTENSIONS:
        return 'audio', False
    if suffix in IMAGE_EXTENSIONS:
        return 'image', False
    if suffix in TEXT_EXTENSIONS:
        if suffix in ('.md', '.markdown'):
            return 'markdown', True
        if suffix == '.json':
            return 'json', True
        if suffix == '.jsonl':
            return 'jsonl', True
        if suffix in ('.yaml', '.yml'):
            return 'yaml', True
        return 'text', True
    return 'binary', False


def _iter_files(root: Path, excluded: frozenset[str], warnings: list[str]) -> Iterable[Path]:
    if not root.is_dir():
        return
    root_real = root.resolve()
    for current, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = sorted(name for name in dirnames if name not in excluded)
        for name in sorted(filenames):
            path = Path(current) / name
            if path.is_symlink():
                try:
                    path.resolve().relative_to(root_real)
                except (OSError, ValueError):
                    warnings.append(f'skipped symlink outside root: {path}')
                    continue
            yield path


def _health_shard_path(repo: Path, day: str) -> Path:
    return repo / 'ai' / 'data' / 'users' / HEALTH_USER / 'health' / day / 'cloud.json'


def _health_daily_path(repo: Path, day: str) -> Path:
    return repo / 'ai' / 'data' / 'daily' / day / 'health.json'


def scan_sources(repo: Path, dates: Sequence[str]) -> _ScanState:
    state = _ScanState(repo=repo, dates=tuple(dates))
    memory_root = repo / 'ai' / 'memory'
    if not memory_root.is_dir():
        raise MemoryIndexError(f'缺少目录：{memory_root}')
    for path in _iter_files(memory_root, EXCLUDED_DIR_NAMES, state.warnings):
        state.files.append(_manifest_entry(path, repo, 'memory'))
    for day in dates:
        daily_root = repo / 'ai' / 'data' / 'daily' / day
        if not daily_root.is_dir():
            state.warnings.append(f'missing daily directory: {daily_root.relative_to(repo).as_posix()}')
            continue
        for path in _iter_files(daily_root, frozenset(), state.warnings):
            state.files.append(_manifest_entry(path, repo, 'daily'))
    for day in dates:
        shard = _health_shard_path(repo, day)
        if shard.is_file():
            entry = _manifest_entry(shard, repo, 'health')
            entry['is_health_shard'] = True
            state.files.append(entry)
    state.files.sort(key=lambda item: item['path'])
    return state


def _manifest_entry(path: Path, repo: Path, group: str) -> dict[str, Any]:
    rel = _posix(path, repo)
    stat = path.stat()
    kind, is_text = _classify(path)
    backup = bool(BACKUP_RE.search(path.name))
    entry: dict[str, Any] = {
        'path': rel,
        'group': group,
        'kind': kind,
        'canonical': not backup,
        'backup': backup,
        'date': _date_from_path(rel) or _date_from_filename(path.name),
        'bytes': stat.st_size,
        'lines': None,
        'sha256': None,
        'mtime': _mtime_iso(path),
        'extension': path.suffix.lower(),
        'is_health_shard': False,
        'is_health_json': path.name == 'health.json' and '/daily/' in f'/{rel}',
    }
    if is_text:
        raw = path.read_bytes()
        text = raw.decode('utf-8', errors='replace')
        entry['sha256'] = _hash_bytes(raw)
        entry['lines'] = len(text.splitlines())
    return entry


def _source_payload(files: Sequence[dict[str, Any]], dates: Sequence[str],
                    health: dict[str, Any]) -> dict[str, Any]:
    rows = [
        {
            'path': item['path'],
            'group': item['group'],
            'kind': item['kind'],
            'canonical': item['canonical'],
            'date': item['date'],
            'bytes': item['bytes'],
            'lines': item['lines'],
            'sha256': item['sha256'],
            'is_health_shard': item['is_health_shard'],
            'is_health_json': item['is_health_json'],
        }
        for item in files
    ]
    return {
        'schema_version': SCHEMA_VERSION,
        'dates': list(dates),
        'files': rows,
        'health': health,
    }


def compute_source_hash(files: Sequence[dict[str, Any]], dates: Sequence[str],
                        health: dict[str, Any]) -> str:
    payload = _source_payload(files, dates, health)
    blob = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(',', ':'))
    return _hash_bytes(blob.encode('utf-8'))


def build_health_status(repo: Path, files: Sequence[dict[str, Any]],
                        dates: Sequence[str], warnings: list[str]) -> dict[str, Any]:
    paths = {item['path']: item for item in files}
    result: dict[str, Any] = {'user': HEALTH_USER, 'dates': {}}
    for day in dates:
        shard_rel = f'ai/data/users/{HEALTH_USER}/health/{day}/cloud.json'
        daily_rel = f'ai/data/daily/{day}/health.json'
        shard_entry = paths.get(shard_rel)
        daily_entry = paths.get(daily_rel)
        if shard_entry:
            source = 'backend_shard'
            source_path = shard_rel
        elif daily_entry:
            source = 'legacy_health_json'
            source_path = daily_rel
        else:
            source = 'missing'
            source_path = None
        info: dict[str, Any] = {
            'source': source,
            'source_path': source_path,
            'shard_present': shard_entry is not None,
            'shard_path': shard_rel if shard_entry else None,
            'daily_health_json_present': daily_entry is not None,
            'daily_health_json_path': daily_rel if daily_entry else None,
        }
        if shard_entry:
            info['bytes'] = shard_entry['bytes']
            info['sha256'] = shard_entry['sha256']
            try:
                payload = json.loads(_read_text(repo / shard_rel))
            except (OSError, json.JSONDecodeError) as exc:
                warnings.append(f'health shard parse failed: {shard_rel}: {exc}')
            else:
                if isinstance(payload, dict):
                    info['fetched_at'] = payload.get('fetched_at')
                    samples = payload.get('samples')
                    info['samples'] = len(samples) if isinstance(samples, list) else None
                    info['payload_date'] = payload.get('date')
        result['dates'][day] = info
    return result


def _entity_id(kind: str, path: str, anchor: str) -> str:
    blob = f'{kind}\x1f{path}\x1f{anchor}'.encode('utf-8')
    return hashlib.sha256(blob).hexdigest()[:16]


def _first_heading(lines: Sequence[str], title: str) -> tuple[str, int]:
    for index, line in enumerate(lines, start=1):
        match = HEADING_RE.match(line)
        if match:
            return match.group(1).strip(), index
    return title, 1


def _title_for(text: str, frontmatter: dict[str, Any], stem: str) -> str:
    name = frontmatter.get('name')
    if isinstance(name, str) and name.strip():
        return name.strip()
    for line in text.splitlines():
        match = H1_RE.match(line)
        if match:
            return match.group(1).strip()
    return stem


def _entity_base(kind: str, path: str, anchor: str, *, title: str, date: str | None,
                 date_source: str, tags: list[str], status: str, text: str,
                 lines: int | None, frontmatter: dict[str, Any],
                 anchors: list[dict[str, Any]], window: dict[str, str] | None,
                 source_refs: list[str]) -> dict[str, Any]:
    raw = text.encode('utf-8')
    return {
        'entity_id': _entity_id(kind, path, anchor),
        'kind': kind,
        'path': path,
        'anchor': anchor,
        'date': date,
        'date_source': date_source,
        'title': title,
        'tags': tags,
        'status': status,
        'bytes': len(raw),
        'lines': lines,
        'sha256': _hash_bytes(raw),
        'frontmatter': frontmatter,
        'anchors': anchors,
        'window': window,
        'source_refs': source_refs,
    }


def _file_date(path: str, frontmatter: dict[str, Any]) -> tuple[str | None, str]:
    path_date = _date_from_path(path)
    if path_date:
        return path_date, 'path'
    fm_date = _parse_date(frontmatter.get('date')) or _parse_date(frontmatter.get('updated'))
    if fm_date:
        return fm_date, 'frontmatter'
    name_date = _date_from_filename(posixpath.basename(path))
    if name_date:
        return name_date, 'filename'
    return None, 'none'


def _source_refs(frontmatter: dict[str, Any]) -> list[str]:
    refs: list[str] = []
    for key in ('source_files', 'sources', 'source'):
        refs.extend(_as_list(frontmatter.get(key)))
    deduped: list[str] = []
    for item in refs:
        if item not in deduped:
            deduped.append(item)
    return deduped


def _section_entities(path: str, lines: Sequence[str],
                      file_entity: dict[str, Any]) -> list[dict[str, Any]]:
    found: list[tuple[int, str, str, str]] = []
    for line_no, line in enumerate(lines, start=1):
        match = SECTION_RE.match(line)
        if not match:
            continue
        start = _norm_hhmm(match.group(1))
        end = _norm_hhmm(match.group(2))
        heading = line[3:].strip()
        found.append((line_no, start, end, heading))
    counts = Counter(f'{start}~{end}' for _, start, end, _ in found)
    seen: Counter[str] = Counter()
    entities: list[dict[str, Any]] = []
    for position, (line_no, start, end, heading) in enumerate(found):
        next_line = found[position + 1][0] if position + 1 < len(found) else len(lines) + 1
        section_lines = lines[line_no - 1:next_line - 1]
        section_text = '\n'.join(section_lines)
        key = f'{start}~{end}'
        seen[key] += 1
        anchor = f'#section={key}'
        if counts[key] > 1:
            anchor += f'@{seen[key]}'
        entities.append(_entity_base(
            'batch_section', path, anchor,
            title=heading,
            date=file_entity['date'],
            date_source=file_entity['date_source'],
            tags=list(file_entity['tags']),
            status=file_entity['status'],
            text=section_text,
            lines=len(section_lines),
            frontmatter=file_entity['frontmatter'],
            anchors=[{'heading': heading, 'line': line_no}],
            window={'start': start, 'end': end},
            source_refs=[],
        ))
    return entities


def _norm_hhmm(value: str) -> str:
    hour, minute = value.split(':', 1)
    return f'{int(hour):02d}:{int(minute):02d}'


def _clean_alias(value: str) -> str:
    value = value.strip().strip('`*"_[]')
    value = re.sub(r'\s+', ' ', value)
    return value.strip()


def _alias_values(raw: str) -> list[str]:
    parts = re.split(r'[/、]', raw)
    return [_clean_alias(part) for part in parts if _clean_alias(part)]


GENERIC_PERSON_MARKERS = (
    '昵称', '对象', '女性', '男性', '亲属', '家人', '队友', '群',
    '朋友', '项目', '对接人', '辈', '现场', '通话', '独白', '语音', '放鸽子',
)


def _valid_person_entry(stem: str, raw_label: str, label: str) -> bool:
    if not label or len(label) > 40 or '：' in label or ':' in label:
        return False
    if stem == '同学朋友':
        return True
    bold = raw_label.startswith('**') and raw_label.endswith('**')
    quoted = raw_label[:1] in ('"', '“', '「')
    if bold or quoted:
        return True
    if len(label) > 12 or re.search(r'\s', label) or re.search(r'[0-9０-９]', label):
        return False
    return not any(marker in label for marker in GENERIC_PERSON_MARKERS)


def _person_candidates(path: str, frontmatter: dict[str, Any],
                       lines: Sequence[str]) -> list[tuple[str, int]]:
    stem = Path(path).stem
    aggregate = stem in AGGREGATE_PEOPLE_FILES
    candidates: list[tuple[str, int]] = []
    name = frontmatter.get('name')
    if isinstance(name, str) and name.strip() and not aggregate:
        candidates.append((_clean_alias(name), _frontmatter_key_line(lines, 'name')))
    aliases = _as_list(frontmatter.get('aliases')) + _as_list(frontmatter.get('alias'))
    alias_line = _frontmatter_key_line(lines, 'aliases') or _frontmatter_key_line(lines, 'alias')
    for alias in aliases:
        candidates.append((_clean_alias(alias), alias_line))
    for line_no, line in enumerate(lines, start=1):
        nickname = NICKNAME_RE.search(line)
        if nickname:
            for alias in _alias_values(nickname.group(1)):
                candidates.append((alias, line_no))
        for regex, _kind in QUOTED_ALIAS_RES:
            for match in regex.finditer(line):
                for alias in _alias_values(match.group(1)):
                    candidates.append((alias, line_no))
        entry = PERSON_ENTRY_RE.match(line)
        if entry:
            raw_label = entry.group(1).strip()
            label = _clean_alias(raw_label.replace('**', ''))
            if _valid_person_entry(stem, raw_label, label):
                candidates.append((label, line_no))
    deduped: list[tuple[str, int]] = []
    seen: set[str] = set()
    for alias, line_no in candidates:
        if not alias or alias in seen or alias in AGGREGATE_PEOPLE_FILES:
            continue
        seen.add(alias)
        deduped.append((alias, line_no))
    return deduped


def _person_entities(path: str, lines: Sequence[str],
                     frontmatter: dict[str, Any], file_entity: dict[str, Any]) -> list[dict[str, Any]]:
    entities: list[dict[str, Any]] = []
    for alias, line_no in _person_candidates(path, frontmatter, lines):
        line_text = lines[line_no - 1] if 0 < line_no <= len(lines) else alias
        entities.append(_entity_base(
            'person', path, f'#person={alias}',
            title=alias,
            date=file_entity['date'],
            date_source=file_entity['date_source'],
            tags=list(file_entity['tags']),
            status=file_entity['status'],
            text=line_text,
            lines=1,
            frontmatter=frontmatter,
            anchors=[{'heading': alias, 'line': line_no}],
            window=None,
            source_refs=[path],
        ))
    return entities


def _frontmatter_key_line(lines: Sequence[str], key: str) -> int:
    for index, line in enumerate(lines, start=1):
        if re.match(rf'^{re.escape(key)}\s*:', line):
            return index
        if index > 1 and line.strip() == '---':
            break
    return 1


def build_entities(repo: Path, files: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    entities: list[dict[str, Any]] = []
    for item in files:
        if item['is_health_shard']:
            entities.append(_entity_base(
                'health_shard', item['path'], '#health',
                title=posixpath.basename(item['path']),
                date=item['date'],
                date_source='path',
                tags=[],
                status='active',
                text=_read_text(repo / item['path']),
                lines=item['lines'],
                frontmatter={},
                anchors=[{'heading': posixpath.basename(item['path']), 'line': 1}],
                window=None,
                source_refs=[],
            ))
            continue
        if item['kind'] != 'markdown' or not item['canonical']:
            continue
        text = _read_text(repo / item['path'])
        lines = text.splitlines()
        frontmatter, _body = split_frontmatter(text)
        day, date_source = _file_date(item['path'], frontmatter)
        title = _title_for(text, frontmatter, Path(item['path']).stem)
        heading, heading_line = _first_heading(lines, title)
        kind = 'daily_file' if item['group'] == 'daily' else 'memory_file'
        status_value = frontmatter.get('status')
        entity_status = status_value.strip() if isinstance(status_value, str) else ''
        entity = _entity_base(
            kind, item['path'], '#file',
            title=title,
            date=day,
            date_source=date_source,
            tags=_tags(frontmatter.get('tags')),
            status=entity_status or 'active',
            text=text,
            lines=len(lines),
            frontmatter=frontmatter,
            anchors=[{'heading': heading, 'line': heading_line}],
            window=None,
            source_refs=_source_refs(frontmatter),
        )
        entities.append(entity)
        if item['group'] == 'daily':
            entities.extend(_section_entities(item['path'], lines, entity))
        if item['path'].startswith('ai/memory/profile/semantic/people/'):
            entities.extend(_person_entities(item['path'], lines, frontmatter, entity))
    entities.sort(key=lambda item: (item['kind'], item['path'], item['anchor']))
    return entities


def _repo_relative(repo: Path, rel: str) -> str | None:
    candidate = (repo / rel).resolve()
    try:
        return candidate.relative_to(repo.resolve()).as_posix()
    except ValueError:
        return None


def _target_variants(target: str) -> list[str]:
    variants = [target]
    if target.lower().endswith('.md'):
        variants.append(target[:-3])
    else:
        variants.append(target + '.md')
    result: list[str] = []
    for variant in variants:
        if variant and variant not in result:
            result.append(variant)
    return result


def _memory_basename_map(files: Sequence[dict[str, Any]]) -> dict[str, list[str]]:
    mapping: dict[str, list[str]] = {}
    for item in files:
        if item['group'] != 'memory' or not item['canonical']:
            continue
        name = posixpath.basename(item['path'])
        mapping.setdefault(name, []).append(item['path'])
    for paths in mapping.values():
        paths.sort()
    return mapping


def _basename_map(repo: Path, root: Path, warnings: list[str]) -> dict[str, list[str]]:
    mapping: dict[str, list[str]] = {}
    if not root.is_dir():
        return mapping
    for current, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = sorted(dirnames)
        for name in sorted(filenames):
            if not name.endswith('.md'):
                continue
            path = Path(current) / name
            rel = _repo_relative(repo, str(path.relative_to(repo)))
            if rel is None:
                warnings.append(f'skipped link target outside repo: {path}')
                continue
            mapping.setdefault(name, []).append(rel)
    for paths in mapping.values():
        paths.sort()
    return mapping


def _daily_basename_map(repo: Path, warnings: list[str]) -> dict[str, list[str]]:
    return _basename_map(repo, repo / 'ai' / 'data' / 'daily', warnings)


def _other_data_basename_map(repo: Path, warnings: list[str]) -> dict[str, list[str]]:
    daily_root = (repo / 'ai' / 'data' / 'daily').resolve()
    mapping: dict[str, list[str]] = {}
    root = repo / 'ai' / 'data'
    if not root.is_dir():
        return mapping
    for current, dirnames, filenames in os.walk(root, followlinks=False):
        current_path = Path(current).resolve()
        if current_path == daily_root:
            dirnames[:] = []
            continue
        dirnames[:] = sorted(name for name in dirnames
                             if (current_path / name).resolve() != daily_root)
        for name in sorted(filenames):
            if not name.endswith('.md'):
                continue
            path = Path(current) / name
            rel = _repo_relative(repo, str(path.relative_to(repo)))
            if rel is None:
                continue
            mapping.setdefault(name, []).append(rel)
    for paths in mapping.values():
        paths.sort()
    return mapping


def _resolve_target(repo: Path, source_rel: str, raw_target: str,
                    memory_basenames: dict[str, list[str]],
                    daily_basenames: dict[str, list[str]],
                    other_data_basenames: dict[str, list[str]]) -> tuple[str, str | None]:
    target = raw_target.strip().replace('\\', '/')
    if '#' in target:
        target = target.split('#', 1)[0]
    target = target.strip()
    if not target:
        return 'broken', None
    source_dir = posixpath.dirname(source_rel)
    roots = ((source_dir, 'exact'), ('ai/memory', 'exact'), ('ai/data', 'exact'))
    for variant in _target_variants(target):
        for base, label in roots:
            rel = posixpath.normpath(posixpath.join(base, variant))
            if rel.startswith('../') or rel == '..':
                continue
            resolved = _repo_relative(repo, rel)
            if resolved is None:
                continue
            path = repo / resolved
            if path.is_file() or path.is_dir():
                return label, resolved
        if variant.startswith('memory/'):
            rel = 'ai/' + variant
            resolved = _repo_relative(repo, rel)
            if resolved and (repo / resolved).is_file():
                return 'exact', resolved
        for rel in (posixpath.normpath(variant), posixpath.normpath('ai/' + variant)):
            if rel.startswith('../') or rel == '..':
                continue
            resolved = _repo_relative(repo, rel)
            if resolved is None:
                continue
            path = repo / resolved
            if path.is_file() or path.is_dir():
                return 'repo', resolved
    for variant in _target_variants(target):
        name = posixpath.basename(variant)
        if name in memory_basenames:
            return 'basename', memory_basenames[name][0]
    for variant in _target_variants(target):
        name = posixpath.basename(variant)
        if name in daily_basenames:
            return 'daily', daily_basenames[name][0]
    for variant in _target_variants(target):
        name = posixpath.basename(variant)
        if name in other_data_basenames:
            return 'repo', other_data_basenames[name][0]
    return 'broken', None


def _fragment_line(repo: Path, resolved: str | None, raw_target: str) -> int | None:
    if not resolved or '#' not in raw_target:
        return None
    fragment = raw_target.split('#', 1)[1].strip()
    if not fragment:
        return None
    path = repo / resolved
    if not path.is_file() or path.suffix.lower() not in ('.md', '.markdown'):
        return None
    try:
        lines = _read_text(path).splitlines()
    except OSError:
        return None
    for index, line in enumerate(lines, start=1):
        if line.startswith('#') and fragment in line:
            return index
    for index, line in enumerate(lines, start=1):
        if fragment in line:
            return index
    return None


def _frontmatter_value_line(lines: Sequence[str], key: str, value: str) -> int:
    key_line = _frontmatter_key_line(lines, key)
    probe = value.strip()
    if probe.startswith('[[') and probe.endswith(']]'):
        probe = probe[2:-2].split('|', 1)[0]
    for index, line in enumerate(lines, start=1):
        if key_line <= index and probe and probe in line:
            return index
    return key_line


def _wikilink_parts(inner: str) -> tuple[str, str | None]:
    if '|' in inner:
        target, alias = inner.split('|', 1)
        return target.strip(), alias.strip() or None
    return inner.strip(), None


def _link_record(source_rel: str, source_line: int, source_kind: str,
                 target_raw: str, alias: str | None, repo: Path,
                 memory_basenames: dict[str, list[str]],
                 daily_basenames: dict[str, list[str]],
                 other_data_basenames: dict[str, list[str]],
                 entries_by_path: dict[str, dict[str, Any]]) -> dict[str, Any]:
    resolution, resolved = _resolve_target(
        repo, source_rel, target_raw, memory_basenames,
        daily_basenames, other_data_basenames)
    resolved_line = _fragment_line(repo, resolved, target_raw)
    link_date = None
    if resolved:
        link_date = _date_from_path(resolved)
        if link_date is None and resolved in entries_by_path:
            link_date = entries_by_path[resolved].get('date')
    return {
        'link_id': _entity_id('link', source_rel, f'{source_line}:{source_kind}:{target_raw}'),
        'source_path': source_rel,
        'source_line': source_line,
        'source_kind': source_kind,
        'target_raw': target_raw,
        'alias': alias,
        'resolution': resolution,
        'resolved_path': resolved,
        'resolved_line': resolved_line,
        'date': link_date,
    }


def _frontmatter_line_count(text: str) -> int:
    normalized = text.lstrip('\ufeff')
    match = FRONTMATTER_RE.match(normalized)
    if not match:
        return 0
    return len(normalized[:match.end()].splitlines())


def build_links(repo: Path, files: Sequence[dict[str, Any]],
                warnings: list[str]) -> list[dict[str, Any]]:
    entries_by_path = {item['path']: item for item in files}
    memory_basenames = _memory_basename_map(files)
    daily_basenames = _daily_basename_map(repo, warnings)
    other_data_basenames = _other_data_basename_map(repo, warnings)
    links: list[dict[str, Any]] = []
    for item in files:
        if not item['canonical'] or item['kind'] != 'markdown':
            continue
        path = repo / item['path']
        text = _read_text(path)
        lines = text.splitlines()
        frontmatter_end = _frontmatter_line_count(text)
        for line_no, line in enumerate(lines, start=1):
            if line_no <= frontmatter_end:
                continue
            for match in WIKILINK_RE.finditer(line):
                target, alias = _wikilink_parts(match.group(1))
                links.append(_link_record(
                    item['path'], line_no, 'wikilink', target, alias,
                    repo, memory_basenames, daily_basenames, other_data_basenames,
                    entries_by_path))
        frontmatter, _body = split_frontmatter(text)
        for value in _as_list(frontmatter.get('links')):
            line_no = _frontmatter_value_line(lines, 'links', value)
            for match in WIKILINK_RE.finditer(value):
                target, alias = _wikilink_parts(match.group(1))
                links.append(_link_record(
                    item['path'], line_no, 'frontmatter_links', target, alias,
                    repo, memory_basenames, daily_basenames, other_data_basenames,
                    entries_by_path))
        for value in _as_list(frontmatter.get('source_files')):
            line_no = _frontmatter_value_line(lines, 'source_files', value)
            links.append(_link_record(
                item['path'], line_no, 'source_files', value, None,
                repo, memory_basenames, daily_basenames, other_data_basenames,
                entries_by_path))
    links.sort(key=lambda row: (row['source_path'], row['source_line'],
                                row['source_kind'], row['target_raw'], row['alias'] or ''))
    return links


def analyze_jsonl(repo: Path, files: Sequence[dict[str, Any]]) -> dict[str, Any]:
    details: dict[str, Any] = {}
    total_blank = 0
    total_bad = 0
    for item in files:
        if item['kind'] != 'jsonl':
            continue
        text = _read_text(repo / item['path'])
        lines = text.splitlines()
        blank = sum(1 for line in lines if not line.strip())
        bad = 0
        first_bad: dict[str, Any] | None = None
        for index, line in enumerate(lines, start=1):
            if not line.strip():
                continue
            try:
                json.loads(line)
            except json.JSONDecodeError as exc:
                bad += 1
                if first_bad is None:
                    first_bad = {'line': index, 'error': str(exc)}
        details[item['path']] = {
            'lines': len(lines),
            'blank_lines': blank,
            'bad_lines': bad,
            'first_bad': first_bad,
        }
        total_blank += blank
        total_bad += bad
    return {
        'files': len(details),
        'lines': sum(row['lines'] for row in details.values()),
        'blank_lines': total_blank,
        'bad_lines': total_bad,
        'details': details,
    }


def _duplicate_basenames(files: Sequence[dict[str, Any]]) -> dict[str, Any]:
    groups: dict[str, list[str]] = {}
    for item in files:
        if not item['canonical'] or item['kind'] != 'markdown':
            continue
        groups.setdefault(posixpath.basename(item['path']), []).append(item['path'])
    duplicates = [
        {'basename': name, 'count': len(paths), 'paths': sorted(paths)}
        for name, paths in sorted(groups.items()) if len(paths) > 1
    ]
    return {'count': len(duplicates), 'items': duplicates}


def build_status(source_hash: str, generated_at: str, dates: Sequence[str],
                 files: Sequence[dict[str, Any]], entities: Sequence[dict[str, Any]],
                 links: Sequence[dict[str, Any]], jsonl: dict[str, Any],
                 health: dict[str, Any], duplicates: dict[str, Any],
                 warnings: Sequence[str]) -> dict[str, Any]:
    by_kind = Counter(item['kind'] for item in files)
    by_group = Counter(item['group'] for item in files)
    entity_counts = Counter(item['kind'] for item in entities)
    resolutions = Counter(item['resolution'] for item in links)
    broken = [item for item in links if item['resolution'] == 'broken']
    return {
        'schema_version': SCHEMA_VERSION,
        'generated_at': generated_at,
        'source_hash': source_hash,
        'dates': list(dates),
        'manifest': {
            'files': len(files),
            'canonical_files': sum(1 for item in files if item['canonical']),
            'backup_files': sum(1 for item in files if item['backup']),
            'total_bytes': sum(item['bytes'] for item in files),
            'text_hashed': sum(1 for item in files if item['sha256'] is not None),
            'metadata_only': sum(1 for item in files if item['sha256'] is None),
            'by_kind': dict(sorted(by_kind.items())),
            'by_group': dict(sorted(by_group.items())),
        },
        'entities': {
            'records': len(entities),
            'by_kind': dict(sorted(entity_counts.items())),
        },
        'links': {
            'records': len(links),
            'by_resolution': dict(sorted(resolutions.items())),
            'broken': len(broken),
            'broken_items': [
                {
                    'source_path': item['source_path'],
                    'source_line': item['source_line'],
                    'target_raw': item['target_raw'],
                    'source_kind': item['source_kind'],
                }
                for item in broken
            ],
        },
        'jsonl': {
            'files': jsonl['files'],
            'lines': jsonl['lines'],
            'blank_lines': jsonl['blank_lines'],
            'bad_lines': jsonl['bad_lines'],
            'details': jsonl['details'],
        },
        'health': health,
        'duplicate_basenames': duplicates,
        'excluded_dir_names': sorted(EXCLUDED_DIR_NAMES),
        'warnings': list(warnings),
    }


def build_manifest(files: Sequence[dict[str, Any]], dates: Sequence[str],
                   source_hash: str, generated_at: str, health: dict[str, Any],
                   outputs: dict[str, Any]) -> dict[str, Any]:
    by_kind = Counter(item['kind'] for item in files)
    by_group = Counter(item['group'] for item in files)
    return {
        'schema_version': SCHEMA_VERSION,
        'generated_at': generated_at,
        'dates': list(dates),
        'source_hash': source_hash,
        'exclusions': {
            'memory_dir_names': sorted(EXCLUDED_DIR_NAMES),
            'backup_suffix': '.bak-*',
            'hashed_extensions': sorted(TEXT_EXTENSIONS),
        },
        'health': health,
        'counts': {
            'files': len(files),
            'canonical_files': sum(1 for item in files if item['canonical']),
            'backup_files': sum(1 for item in files if item['backup']),
            'total_bytes': sum(item['bytes'] for item in files),
            'text_hashed': sum(1 for item in files if item['sha256'] is not None),
            'metadata_only': sum(1 for item in files if item['sha256'] is None),
            'by_kind': dict(sorted(by_kind.items())),
            'by_group': dict(sorted(by_group.items())),
        },
        'files': list(files),
        'outputs': outputs,
    }


def _serialize_jsonl(records: Sequence[dict[str, Any]]) -> bytes:
    lines = [json.dumps(item, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
             for item in records]
    text = '\n'.join(lines) + ('\n' if lines else '')
    return text.encode('utf-8')


def _serialize_json(payload: dict[str, Any]) -> bytes:
    text = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + '\n'
    return text.encode('utf-8')


def _write_artifacts(out_dir: Path, artifacts: dict[str, bytes]) -> tuple[str, ...]:
    out = out_dir.resolve()
    if out.exists() and not out.is_dir():
        raise MemoryIndexError(f'--out 不是目录：{out}')
    out.mkdir(parents=True, exist_ok=True)
    written: list[str] = []
    for name in OUTPUT_NAMES:
        if name not in artifacts:
            continue
        target = (out / name).resolve()
        if target.parent != out:
            raise MemoryIndexError(f'拒绝写出 --out 之外：{target}')
        temporary = out / (name + '.tmp')
        with temporary.open('wb') as handle:
            handle.write(artifacts[name])
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
        written.append(name)
    return tuple(written)


def build_index(repo_root: str | Path, dates: Sequence[str] = DEFAULT_DATES,
                out_dir: str | Path | None = None,
                dry_run: bool = False) -> BuildResult:
    repo = Path(repo_root).resolve()
    normalized_dates = tuple(dates)
    if not normalized_dates:
        raise MemoryIndexError('至少需要一个日期')
    for day in normalized_dates:
        if _parse_date(day) != day:
            raise MemoryIndexError(f'日期格式必须是 YYYY-MM-DD：{day}')
    scan = scan_sources(repo, normalized_dates)
    health = build_health_status(repo, scan.files, normalized_dates, scan.warnings)
    source_hash = compute_source_hash(scan.files, normalized_dates, health)
    entities = build_entities(repo, scan.files)
    links = build_links(repo, scan.files, scan.warnings)
    jsonl = analyze_jsonl(repo, scan.files)
    duplicates = _duplicate_basenames(scan.files)
    generated_at = _utc_now()
    status = build_status(source_hash, generated_at, normalized_dates, scan.files,
                          entities, links, jsonl, health, duplicates, scan.warnings)
    manifest = build_manifest(scan.files, normalized_dates, source_hash,
                              generated_at, health, {})
    summary = {
        'schema_version': SCHEMA_VERSION,
        'source_hash': source_hash,
        'dates': list(normalized_dates),
        'manifest_files': status['manifest']['files'],
        'manifest_bytes': status['manifest']['total_bytes'],
        'canonical_files': status['manifest']['canonical_files'],
        'entities': status['entities']['records'],
        'links': status['links']['records'],
        'broken_links': status['links']['broken'],
        'jsonl_blank_lines': status['jsonl']['blank_lines'],
        'jsonl_bad_lines': status['jsonl']['bad_lines'],
        'duplicate_basenames': duplicates['count'],
        'dry_run': dry_run,
        'out_dir': None if dry_run or out_dir is None else str(Path(out_dir).resolve()),
    }
    if dry_run:
        return BuildResult(source_hash, manifest, status, tuple(entities),
                           tuple(links), summary)
    if out_dir is None:
        raise MemoryIndexError('非 dry-run 必须提供 --out')
    artifacts = {
        'entities.jsonl': _serialize_jsonl(entities),
        'links.jsonl': _serialize_jsonl(links),
        'status.json': _serialize_json(status),
    }
    output_hashes = {
        name: {
            'sha256': _hash_bytes(data),
            'bytes': len(data),
            'records': len(entities) if name == 'entities.jsonl'
            else len(links) if name == 'links.jsonl' else 1,
        }
        for name, data in artifacts.items()
    }
    manifest['outputs'] = output_hashes
    artifacts['manifest.json'] = _serialize_json(manifest)
    written = _write_artifacts(Path(out_dir), artifacts)
    summary['outputs'] = output_hashes
    return BuildResult(source_hash, manifest, status, tuple(entities),
                       tuple(links), summary, written)
