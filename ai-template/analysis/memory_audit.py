#!/usr/bin/env python3
"""记忆目录与 agent 注入清单的只读体检工具。

用法：
    python {AI目录}/analysis/memory_audit.py scan
    python {AI目录}/analysis/memory_audit.py report --json
    python {AI目录}/analysis/memory_audit.py check

check 退出码：0=通过（允许 warning），1=存在 error。

不写任何文件，不联网，不调用 Loom。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any, Iterable, Sequence

AI_ROOT = Path(__file__).resolve().parents[1]

ERROR = 'error'
WARNING = 'warning'

# 主会话：6 件必需 + chat-mode 可选，上限 7；批次/复盘角色：5 件 core + 规律-摘要可选，上限 6。
MAIN_REQUIRED = (
    'AGENTS.md',
    'memory/self/必读.md',
    'memory/self/persona-lite.md',
    'memory/profile/state.md',
    'memory/profile/core-lite.md',
    'memory/topics/INDEX.md',
)
MAIN_OPTIONAL = ('memory/self/chat-mode.md',)
MAIN_MAX_ITEMS = len(MAIN_REQUIRED) + len(MAIN_OPTIONAL)
MAIN_FORBIDDEN = (
    'memory/self/纠错.md',
    'memory/self/认知.md',
    'memory/self/任务.md',
    'memory/self/关系.md',
    'memory/profile/core.md',
    'memory/self/SELF-INDEX.md',
)
SUBAGENT_NAMES = ('data-checker', 'reviewer')
SUBAGENT_REQUIRED = (
    'agents/AGENTS-lite.md',
    'memory/self/必读.md',
    'memory/profile/state.md',
    'memory/profile/core-lite.md',
    'memory/topics/INDEX.md',
)
SUBAGENT_OPTIONAL = ('memory/profile/规律-摘要.md',)
SUBAGENT_ALIASES = {'agents/AGENTS-lite.md': ('AGENTS.md',)}
SUBAGENT_MAX_ITEMS = len(SUBAGENT_REQUIRED) + len(SUBAGENT_OPTIONAL)

DEFAULT_PROJECTION_STATUS = Path(__file__).resolve().parents[2] / '.memory-projection' / 'projection-status.json'
PROJECTION_FRESH_HOURS = 24

LARGE_BYTES = 20 * 1024
LARGE_LINES = 300
SUMMARY_MAX_BYTES = 24_000
INDEX_MAX_BYTES = 4_000

# A 方案（主会话常驻 6 件）于 2026-10-20 收口；此前的卡片缺「记忆」tag 记 warning，
# 此后新增/更新的卡片缺 tag 记 error，避免老账把 check 永久卡红。
TAG_ENFORCE_SINCE = date(2026, 10, 20)
TAG_REQUIRED = '记忆'

CJK_RE = re.compile(r'[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]')
FRONTMATTER_RE = re.compile(r'^---\r?\n(.*?)\r?\n---(?:\r?\n|$)', re.S)
WRITER_HINT_RE = re.compile(r'writer|写入方|写入者|谁写', re.IGNORECASE)


@dataclass(frozen=True)
class Check:
    severity: str
    check_id: str
    message: str
    path: str = ''

    def as_dict(self) -> dict[str, str]:
        return {
            'id': self.check_id,
            'severity': self.severity,
            'message': self.message,
            'path': self.path,
        }


def _read(path: Path) -> str:
    return path.read_text(encoding='utf-8', errors='replace')


def _unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
        return value[1:-1]
    return value


def split_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    """解析最小 YAML frontmatter（标量、行内列表、块列表），不依赖 PyYAML。"""
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


def estimate_tokens(text: str) -> int:
    """与既有口径一致：CJK 字符 * 0.62 + 非 CJK 字符 / 4。"""
    cjk = len(CJK_RE.findall(text))
    return int(round(cjk * 0.62 + (len(text) - cjk) / 4))


def _parse_date(value: Any) -> date | None:
    if not isinstance(value, str) or not value.strip():
        return None
    candidate = value.strip()
    try:
        return date.fromisoformat(candidate[:10])
    except ValueError:
        pass
    for fmt in ('%Y/%m/%d', '%Y-%m-%d %H:%M:%S'):
        try:
            return datetime.strptime(candidate, fmt).date()
        except ValueError:
            continue
    return None


def _mtime(path: Path) -> datetime:
    return datetime.fromtimestamp(path.stat().st_mtime)


def _newest_mtime(path: Path) -> datetime:
    """文件取自身 mtime；目录递归取目录内文件的最新 mtime（空目录回退目录 mtime）。"""
    if path.is_file():
        return _mtime(path)
    newest: datetime | None = None
    if path.is_dir():
        for child in path.rglob('*'):
            if child.is_file():
                child_mtime = _mtime(child)
                newest = child_mtime if newest is None else max(newest, child_mtime)
    return newest if newest is not None else _mtime(path)


def _display_path(root: Path, path: Path) -> str:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return path.as_posix()


def _memory_category(rel: Path) -> str:
    parts = rel.parts
    if parts[0] == 'self':
        return 'memory/self' if len(parts) == 2 else f'memory/self/{parts[1]}'
    if parts[0] == 'profile':
        if len(parts) == 2:
            return 'memory/profile'
        if parts[1] == 'semantic':
            return 'memory/profile/semantic' if len(parts) == 3 else f'memory/profile/semantic/{parts[2]}'
        return f'memory/profile/{parts[1]}'
    if parts[0] in ('fact', 'topics'):
        return f'memory/{parts[0]}'
    return 'memory/root'


def _file_record(root: Path, path: Path, category: str) -> dict[str, Any]:
    content = _read(path)
    frontmatter = split_frontmatter(content)[0]
    tags = frontmatter.get('tags')
    if isinstance(tags, list):
        tag_list = [str(tag) for tag in tags]
    elif isinstance(tags, str) and tags:
        tag_list = [tags]
    else:
        tag_list = []
    updated = frontmatter.get('updated') or frontmatter.get('date')
    if not isinstance(updated, str) or not updated.strip():
        updated = _mtime(path).date().isoformat()
    return {
        'path': _display_path(root, path),
        'category': category,
        'bytes': path.stat().st_size,
        'lines': len(content.splitlines()),
        'estimated_tokens': estimate_tokens(content),
        'tags': tag_list,
        'updated': updated.strip(),
        'status': 'ok',
    }


def _iter_memory_files(memory_dir: Path) -> Iterable[tuple[Path, Path]]:
    if not memory_dir.is_dir():
        return []
    files = []
    for path in memory_dir.rglob('*.md'):
        rel = path.relative_to(memory_dir)
        if rel.parts[0] in ('archive', '_template'):
            continue
        files.append((rel, path))
    files.sort(key=lambda pair: pair[0].as_posix())
    return files


def _needs_tag_check(rel: Path) -> bool:
    if rel.parts[0] == 'self':
        if rel.as_posix() == 'self/执行日志.md':
            return False
        if len(rel.parts) >= 2 and rel.parts[1] in ('scratch', '执行日志'):
            return False
        return True
    return rel.parts[0] == 'profile' and len(rel.parts) >= 2 and rel.parts[1] == 'semantic'


def _normalize_memory_item(value: str) -> str:
    item = value.strip().strip('`"\'').replace('\\', '/')
    while item.startswith('./'):
        item = item[2:]
    ai_prefix = AI_ROOT.name + '/'
    if item.startswith(ai_prefix):
        item = item[len(ai_prefix):]
    return item


def _memory_items(frontmatter: dict[str, Any]) -> list[str]:
    raw = frontmatter.get('memory')
    if isinstance(raw, list):
        return [_normalize_memory_item(str(item)) for item in raw]
    if isinstance(raw, str):
        return [_normalize_memory_item(part) for part in re.split(r'[,\s]+', raw) if part.strip()]
    return []


def _agent_memory_checks(root: Path, checks: list[Check]) -> None:
    agents_dir = root / 'agents'

    def load(name: str) -> list[str] | None:
        path = agents_dir / f'{name}.md'
        display = _display_path(root, path)
        if not path.is_file():
            checks.append(Check(ERROR, f'agent.{name}.missing', 'agent 文件不存在', display))
            return None
        frontmatter, _ = split_frontmatter(_read(path))
        items = _memory_items(frontmatter)
        if not items:
            checks.append(Check(ERROR, f'agent.{name}.memory.empty', 'frontmatter memory: 为空或缺失', display))
        return items

    main_items = load('main')
    if main_items is not None:
        display = _display_path(root, agents_dir / 'main.md')
        if len(main_items) > MAIN_MAX_ITEMS:
            checks.append(Check(
                ERROR, 'agent.main.memory.count',
                f'主会话注入 {len(main_items)} 件，超过上限 {MAIN_MAX_ITEMS}'
                f'（必需 {len(MAIN_REQUIRED)} + 可选 {len(MAIN_OPTIONAL)}）',
                display,
            ))
        missing = [item for item in MAIN_REQUIRED if item not in main_items]
        if missing:
            checks.append(Check(
                ERROR, 'agent.main.memory.missing',
                '主会话注入缺少必需件：' + ', '.join(missing),
                display,
            ))
        forbidden = [item for item in main_items if item in MAIN_FORBIDDEN]
        if forbidden:
            checks.append(Check(
                ERROR, 'agent.main.memory.forbidden',
                '主会话注入含禁止件：' + ', '.join(forbidden),
                display,
            ))
        allowed = set(MAIN_REQUIRED) | set(MAIN_OPTIONAL)
        extra = [item for item in main_items if item not in allowed and item not in MAIN_FORBIDDEN]
        if extra:
            checks.append(Check(
                ERROR, 'agent.main.memory.extra',
                '主会话注入含未允许件：' + ', '.join(extra),
                display,
            ))
        for item in main_items:
            if not (root / item).is_file():
                checks.append(Check(
                    ERROR, 'agent.main.memory.file_missing',
                    f'注入清单指向的文件不存在：{item}',
                    display,
                ))

    for name in SUBAGENT_NAMES:
        items = load(name)
        if items is None:
            continue
        display = _display_path(root, agents_dir / f'{name}.md')
        if len(items) > SUBAGENT_MAX_ITEMS:
            checks.append(Check(
                ERROR, f'agent.{name}.memory.count',
                f'{name} 注入 {len(items)} 件，超过上限 {SUBAGENT_MAX_ITEMS}'
                f'（核心 {len(SUBAGENT_REQUIRED)} + 可选 {len(SUBAGENT_OPTIONAL)}）',
                display,
            ))
        missing = [
            item for item in SUBAGENT_REQUIRED
            if item not in items
            and not any(alias in items for alias in SUBAGENT_ALIASES.get(item, ()))
        ]
        allowed = set(SUBAGENT_REQUIRED) | set(SUBAGENT_OPTIONAL)
        allowed.update(alias for aliases in SUBAGENT_ALIASES.values() for alias in aliases)
        extra = [item for item in items if item not in allowed]
        if missing or extra:
            parts = []
            if missing:
                parts.append('缺少 ' + ', '.join(missing))
            if extra:
                parts.append('多余 ' + ', '.join(extra))
            checks.append(Check(
                ERROR, f'agent.{name}.memory.mismatch',
                f'{name} 注入清单不符：' + '；'.join(parts),
                display,
            ))
        for item in items:
            if not (root / item).is_file():
                checks.append(Check(
                    ERROR, f'agent.{name}.memory.file_missing',
                    f'注入清单指向的文件不存在：{item}',
                    display,
                ))


def _memory_file_checks(root: Path, memory_dir: Path,
                        records: list[dict[str, Any]], checks: list[Check]) -> None:
    for rel, path in _iter_memory_files(memory_dir):
        text = _read(path)
        frontmatter, _ = split_frontmatter(text)
        display = _display_path(root, path)
        record = _file_record(root, path, _memory_category(rel))
        records.append(record)

        if record['bytes'] > LARGE_BYTES or record['lines'] > LARGE_LINES:
            checks.append(Check(
                WARNING, 'memory.size.large',
                f"{record['bytes']} bytes / {record['lines']} lines，超过 20KB/300 行",
                display,
            ))

        if _needs_tag_check(rel):
            if not frontmatter:
                checks.append(Check(
                    WARNING, 'memory.frontmatter.missing',
                    '无 frontmatter，跳过「记忆」tag 检查',
                    display,
                ))
            elif TAG_REQUIRED not in record['tags']:
                touched = _parse_date(frontmatter.get('updated')) or _parse_date(frontmatter.get('date'))
                if touched is not None and touched < TAG_ENFORCE_SINCE:
                    checks.append(Check(
                        WARNING, 'memory.tag.legacy_missing',
                        f'旧卡片缺「{TAG_REQUIRED}」tag（{touched.isoformat()} 早于 {TAG_ENFORCE_SINCE.isoformat()}）',
                        display,
                    ))
                else:
                    checks.append(Check(
                        ERROR, 'memory.tag.missing',
                        f'frontmatter 缺「{TAG_REQUIRED}」tag',
                        display,
                    ))


def _default_projection_status(root: Path) -> Path | None:
    env = os.environ.get('MEMORY_PROJECTION_STATUS')
    if env:
        return Path(env)
    return DEFAULT_PROJECTION_STATUS if root.resolve() == AI_ROOT else None


def _fresh_projection(path: Path | None) -> dict[str, Any] | None:
    if path is None or not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
        built_at = datetime.fromisoformat(str(data['built_at']).replace('Z', '+00:00'))
    except (OSError, KeyError, TypeError, ValueError):
        return None
    if built_at.tzinfo is None:
        built_at = built_at.astimezone()
    age_hours = (datetime.now().astimezone() - built_at).total_seconds() / 3600
    if age_hours > PROJECTION_FRESH_HOURS:
        return None
    changed = int(data.get('changed_lines') or 0)
    candidates = data.get('candidate_paths') or {}
    if not isinstance(candidates, dict):
        return None
    if changed > 0 and any(not (path.parent / str(name)).is_file() for name in candidates.values()):
        return None
    return data


def _projection_checks(root: Path, memory_dir: Path, checks: list[Check],
                       projection_status: Path | None = None) -> None:
    status_path = projection_status or _default_projection_status(root)
    candidate = _fresh_projection(status_path)
    for rel_name in ('self/persona-lite.md', 'profile/core-lite.md'):
        path = memory_dir / rel_name
        display = _display_path(root, path)
        if not path.is_file():
            checks.append(Check(ERROR, 'projection.missing', '投影文件不存在', display))
            continue
        frontmatter, _ = split_frontmatter(_read(path))
        updated = _parse_date(frontmatter.get('updated'))
        if updated is None:
            checks.append(Check(ERROR, 'projection.missing_updated', '缺少合法 updated（YYYY-MM-DD）', display))
            continue
        source_files = frontmatter.get('source_files')
        if not isinstance(source_files, list) or not source_files:
            checks.append(Check(WARNING, 'projection.no_sources', '缺少 source_files，无法判断新鲜度', display))
            continue
        for source in source_files:
            source_path = memory_dir / str(source)
            if not source_path.exists():
                checks.append(Check(
                    ERROR, 'projection.source_missing',
                    f'source_files 指向的路径不存在：{source}',
                    display,
                ))
                continue
            source_date = _newest_mtime(source_path).date()
            if updated < source_date:
                if candidate is not None:
                    checks.append(Check(
                        WARNING, 'projection.candidate_ready',
                        f'updated {updated.isoformat()} 早于 {source} 最新 mtime '
                        f'{source_date.isoformat()}；候选已生成（built_at '
                        f"{candidate.get('built_at')}，changed_lines {candidate.get('changed_lines')}）",
                        display,
                    ))
                else:
                    checks.append(Check(
                        ERROR, 'projection.stale',
                        f'updated {updated.isoformat()} 早于 {source} 最新 mtime {source_date.isoformat()}',
                        display,
                    ))


def _structural_memory_checks(root: Path, memory_dir: Path, checks: list[Check]) -> None:
    legacy_log = memory_dir / 'self' / '执行日志.md'
    if legacy_log.exists():
        checks.append(Check(
            WARNING, 'memory.legacy.exec_log',
            '旧路径 self/执行日志.md 仍存在（新路径 self/执行日志/{YYYY-MM}.md）',
            _display_path(root, legacy_log),
        ))

    events_dir = memory_dir / 'profile' / 'events'
    if not events_dir.is_dir():
        checks.append(Check(WARNING, 'memory.events.missing', 'profile/events/ 不存在', _display_path(root, events_dir)))
    elif not (events_dir / 'README.md').is_file():
        writer_note = False
        for candidate in events_dir.rglob('*.md'):
            if WRITER_HINT_RE.search(_read(candidate)):
                writer_note = True
                break
        if not writer_note:
            checks.append(Check(
                WARNING, 'memory.events.no_writer',
                'profile/events/ 无 README.md 或 writer 说明（无明确写入方）',
                _display_path(root, events_dir),
            ))

    archive_dir = memory_dir / 'archive'
    if not archive_dir.is_dir():
        checks.append(Check(WARNING, 'memory.archive.missing', 'archive/ 不存在', _display_path(root, archive_dir)))
    elif not (archive_dir / 'README.md').is_file():
        checks.append(Check(
            WARNING, 'memory.archive.no_readme',
            'archive/ 缺 README.md（归档边界与只读约定无说明）',
            _display_path(root, archive_dir),
        ))


def _latest_daily_dir(root: Path) -> Path | None:
    daily_root = root / 'data' / 'daily'
    if not daily_root.is_dir():
        return None
    dates = sorted(
        child.name for child in daily_root.iterdir()
        if child.is_dir() and re.fullmatch(r'\d{4}-\d{2}-\d{2}', child.name)
    )
    return daily_root / dates[-1] if dates else None


def _daily_checks(root: Path, records: list[dict[str, Any]], checks: list[Check]) -> None:
    day_dir = _latest_daily_dir(root)
    if day_dir is None:
        checks.append(Check(WARNING, 'daily.no_dates', 'data/daily/ 下没有日期目录', 'data/daily'))
        return
    date_str = day_dir.name
    summary = day_dir / f'当日摘要-{date_str}.md'
    index = day_dir / f'批次索引-{date_str}.md'
    batch_files = sorted(day_dir.glob(f'理解-{date_str}-批次-*.md'))
    finalized = (day_dir / f'复盘-{date_str}.md').is_file()
    summary_v2 = False

    if not summary.is_file():
        checks.append(Check(ERROR, 'daily.summary.missing', f'缺少 当日摘要-{date_str}.md', _display_path(root, summary)))
    else:
        text = _read(summary)
        summary_v2 = text.lstrip().startswith('<!-- summary-v2 -->')
        records.append(_file_record(root, summary, 'daily/summary'))
        size = summary.stat().st_size
        if not summary_v2:
            # 当日未复盘（尚未定稿）时给 v2 迁移窗口；已复盘仍非 v2 则是真漂移。
            severity = ERROR if finalized else WARNING
            checks.append(Check(
                severity, 'daily.summary.legacy',
                '摘要非 v2 格式（无 <!-- summary-v2 -->），需下次 --update-summary 重建'
                + ('（当日已复盘，不再给迁移窗口）' if finalized else ''),
                _display_path(root, summary),
            ))
            if size > SUMMARY_MAX_BYTES:
                checks.append(Check(
                    severity, 'daily.summary.oversize_legacy',
                    f'{size} bytes > {SUMMARY_MAX_BYTES}，旧格式摘要超限'
                    + ('（当日已复盘）' if finalized else '（重建后受 error 约束）'),
                    _display_path(root, summary),
                ))
        elif size > SUMMARY_MAX_BYTES:
            checks.append(Check(
                ERROR, 'daily.summary.oversize',
                f'{size} bytes > {SUMMARY_MAX_BYTES}',
                _display_path(root, summary),
            ))

    if index.is_file():
        records.append(_file_record(root, index, 'daily/index'))
        size = index.stat().st_size
        if size > INDEX_MAX_BYTES:
            checks.append(Check(
                ERROR, 'daily.index.oversize',
                f'{size} bytes > {INDEX_MAX_BYTES}',
                _display_path(root, index),
            ))
    elif summary_v2:
        if batch_files:
            checks.append(Check(
                ERROR, 'daily.index.missing',
                f'已有 {len(batch_files)} 个批次文件但缺少 批次索引-{date_str}.md',
                _display_path(root, index),
            ))
        else:
            checks.append(Check(
                WARNING, 'daily.index.pending',
                '当日尚无批次文件，批次索引允许暂缺',
                _display_path(root, index),
            ))
    else:
        severity = ERROR if finalized else WARNING
        checks.append(Check(
            severity, 'daily.index.pending_v2',
            '摘要尚未进入 v2 流程，批次索引待生成（下次 --update-summary）'
            + ('（当日已复盘）' if finalized else ''),
            _display_path(root, index),
        ))


def _attach_file_status(records: list[dict[str, Any]], checks: Sequence[Check]) -> None:
    by_path = {record['path']: record for record in records}
    for check in checks:
        record = by_path.get(check.path)
        if record is None:
            continue
        if check.severity == ERROR:
            record['status'] = 'error'
        elif record['status'] != 'error':
            record['status'] = 'warning'


def build_report(root: Path | str = AI_ROOT,
                 projection_status: Path | str | None = None) -> dict[str, Any]:
    root = Path(root).resolve()
    memory_dir = root / 'memory'
    records: list[dict[str, Any]] = []
    checks: list[Check] = []

    _agent_memory_checks(root, checks)
    _memory_file_checks(root, memory_dir, records, checks)
    _projection_checks(root, memory_dir, checks, Path(projection_status) if projection_status else None)
    _structural_memory_checks(root, memory_dir, checks)
    _daily_checks(root, records, checks)

    checks.sort(key=lambda check: (0 if check.severity == ERROR else 1, check.check_id, check.path, check.message))
    _attach_file_status(records, checks)
    records.sort(key=lambda record: record['path'])

    errors = [check for check in checks if check.severity == ERROR]
    warnings = [check for check in checks if check.severity == WARNING]
    totals = {
        'files': len(records),
        'bytes': sum(record['bytes'] for record in records),
        'lines': sum(record['lines'] for record in records),
        'estimated_tokens': sum(record['estimated_tokens'] for record in records),
        'errors': len(errors),
        'warnings': len(warnings),
    }
    return {
        'generated_at': datetime.now().astimezone().isoformat(timespec='seconds'),
        'root': str(root),
        'files': records,
        'totals': totals,
        'checks': [check.as_dict() for check in checks],
        'errors': [check.as_dict() for check in errors],
        'warnings': [check.as_dict() for check in warnings],
    }


def _print_scan(report: dict[str, Any]) -> None:
    print('PATH\tCATEGORY\tBYTES\tLINES\tTOKENS\tTAGS\tUPDATED\tSTATUS')
    for record in report['files']:
        tags = ','.join(record['tags']) if record['tags'] else '-'
        print(
            f"{record['path']}\t{record['category']}\t{record['bytes']}\t{record['lines']}\t"
            f"{record['estimated_tokens']}\t{tags}\t{record['updated']}\t{record['status']}"
        )
    totals = report['totals']
    print(
        f"TOTAL\tfiles={totals['files']}\tbytes={totals['bytes']}\tlines={totals['lines']}\t"
        f"tokens={totals['estimated_tokens']}\terrors={totals['errors']}\twarnings={totals['warnings']}"
    )


def _print_checks(report: dict[str, Any]) -> None:
    for check in report['checks']:
        label = 'ERROR' if check['severity'] == ERROR else 'WARN'
        location = f" {check['path']}" if check['path'] else ''
        print(f"{label} [{check['id']}]{location}: {check['message']}")
    totals = report['totals']
    print(f"SUMMARY errors={totals['errors']} warnings={totals['warnings']}")


def main(argv: Sequence[str] | None = None) -> int:
    root_option = argparse.ArgumentParser(add_help=False)
    root_option.add_argument('--root', default=argparse.SUPPRESS, help='AI 根目录（默认按本文件位置推导）')
    root_option.add_argument('--projection-status', default=argparse.SUPPRESS,
                             help='projection-status.json 路径')

    parser = argparse.ArgumentParser(description='记忆目录只读体检工具（scan/report/check）')
    parser.add_argument('--root', default=str(AI_ROOT), help='AI 根目录（默认按本文件位置推导）')
    parser.add_argument('--projection-status', default=None, help='projection-status.json 路径')
    subparsers = parser.add_subparsers(dest='command', required=True)
    subparsers.add_parser('scan', parents=[root_option], help='人类可读文件清单')
    report_parser = subparsers.add_parser('report', parents=[root_option], help='输出报告')
    report_parser.add_argument('--json', action='store_true', help='输出机器可读 JSON')
    subparsers.add_parser('check', parents=[root_option], help='只跑规则，0=通过 1=有 error')
    args = parser.parse_args(argv)

    report = build_report(Path(args.root), args.projection_status)

    if args.command == 'scan':
        _print_scan(report)
        return 0
    if args.command == 'report':
        if args.json:
            print(json.dumps(report, ensure_ascii=False, indent=2))
        else:
            _print_scan(report)
            _print_checks(report)
        return 0
    _print_checks(report)
    return 1 if report['errors'] else 0


if __name__ == '__main__':
    sys.exit(main())
