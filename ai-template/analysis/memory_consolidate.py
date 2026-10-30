#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AI 记忆目录离线巩固工具：daily 清理草稿纸、weekly 只读体检。

# allow: SIZE_OK — 任务限定只新增单文件 CLI；daily/weekly 共用路径防护、报告与快照层。


设计约束：
- 默认 dry-run，只有显式 --apply 才允许写；weekly 即使 --apply 也不改内容。
- daily 只删除 self/scratch/{YYYY-MM-DD}.md 中「文件日期早于 today-7」且行尾带
  `→已收割(` / `→丢弃(` 的行；文件头、README、未标记行原样保留，空文件保留。
- daily --apply 前先快照到 .backups/{ts}/MANIFEST.json（复用 memory_write 逻辑）。
- 所有读写路径 realpath 必须位于 --root 内，越界退出 2。
- 按字节删行，不改变 CRLF/LF 风格；不重建 projection、不合并 prose、不碰 archive。
- 仅标准库，不联网。

用法：
    python analysis/memory_consolidate.py --mode daily
    python analysis/memory_consolidate.py --mode daily --apply
    python analysis/memory_consolidate.py --mode weekly --json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tempfile
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Iterator, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parent))
import memory_write  # noqa: E402  (同目录模块，复用快照/遍历/原子写)

AI_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ROOT = AI_ROOT / 'memory'
SCRATCH_REL = 'self/scratch'
TASKS_REL = 'self/任务.md'
RETENTION_DAYS = 7
STALE_DAYS = 30
LARGE_LINES = 300
LARGE_BYTES = 20 * 1024
HARVEST_MARKERS = ('→已收割(', '→丢弃(')
SCRATCH_NAME_RE = re.compile(r'^(\d{4}-\d{2}-\d{2})(?:-[A-Za-z0-9]+)?\.md$')
DONE_TASK_RE = re.compile(r'^\s*-\s*\[[xX]\]\s+')
EXCLUDED_DIR_NAMES = frozenset({'archive', '_template', '.backups', '.git', '__pycache__'})
NOISE_PREFIXES = ('#', '<!--', '```', '---', '***', '___', '>')


class ConsolidateError(Exception):
    """带退出码的显式错误：2=参数/路径安全。"""

    def __init__(self, message: str, code: int = 2) -> None:
        super().__init__(message)
        self.code = code


def _real(path: Path) -> Path:
    return Path(os.path.realpath(os.path.abspath(str(path))))


def _inside(target: Path, root: Path) -> bool:
    try:
        return target != root and os.path.commonpath([str(target), str(root)]) == str(root)
    except ValueError:
        return False


def _guard(path: Path, root: Path, what: str) -> Path:
    real = _real(path)
    if not _inside(real, root):
        raise ConsolidateError(f'路径越界（{what} 必须位于 {root} 内）：{real}', 2)
    return real


def _resolve_root(root_arg: str | None) -> Path:
    root = _real(Path(root_arg) if root_arg else DEFAULT_ROOT)
    if not root.is_dir():
        raise ConsolidateError(f'root 不存在或不是目录：{root}', 2)
    return root


def _rel(root: Path, path: Path) -> str:
    return path.relative_to(root).as_posix()


def _decode(raw: bytes) -> str:
    return raw.decode('utf-8', errors='surrogateescape')


def _preview(text: str, limit: int = 160) -> str:
    text = text.encode('utf-8', errors='replace').decode('utf-8')
    text = ' '.join(text.split())
    return text if len(text) <= limit else text[:limit] + '...'


def _write_bytes(target: Path, data: bytes) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix='.memconsolidate-', suffix='.tmp', dir=str(target.parent))
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, 'wb') as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        mode = stat.S_IMODE(target.stat().st_mode) if target.exists() else 0o644
        os.chmod(tmp, mode)
        os.replace(tmp, target)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    dir_fd = os.open(str(target.parent), os.O_RDONLY)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)


def _scratch_date(name: str) -> date | None:
    match = SCRATCH_NAME_RE.match(name)
    if not match:
        return None
    try:
        return date.fromisoformat(match.group(1))
    except ValueError:
        return None


def _is_marked(line: bytes) -> bool:
    """标记必须落在行尾附近，避免正文里引用格式字符串时误删。"""
    text = line.decode('utf-8', errors='replace').rstrip('\r\n')
    return any(
        0 <= (start := text.rfind(marker)) and len(text) - start <= 64
        for marker in HARVEST_MARKERS
    )


def plan_daily(root: Path, today: date | None = None) -> dict[str, Any]:
    """只读扫描，返回 daily 计划/报告。"""
    today = today or date.today()
    cutoff = today - timedelta(days=RETENTION_DAYS)
    scratch = root / SCRATCH_REL
    report: dict[str, Any] = {
        'mode': 'daily',
        'dry_run': True,
        'root': str(root),
        'today': today.isoformat(),
        'cutoff': cutoff.isoformat(),
        'files_scanned': 0,
        'files_changed': [],
        'candidate_lines': 0,
        'deleted_lines': 0,
        'candidates': [],
        'skipped': {
            'young_marked_lines': 0,
            'unmarked_lines': 0,
            'undated_files': [],
        },
        'snapshot': None,
        'warnings': [],
    }
    if not scratch.exists():
        report['warnings'].append(f'{SCRATCH_REL} 不存在')
        return report
    _guard(scratch, root, 'scratch 目录')
    if not scratch.is_dir():
        raise ConsolidateError(f'{scratch} 不是目录', 2)

    for path in sorted(scratch.glob('*.md')):
        _guard(path, root, 'scratch 文件')
        if not path.is_file():
            continue
        report['files_scanned'] += 1
        rel = _rel(root, path)
        file_date = _scratch_date(path.name)
        if file_date is None:
            report['skipped']['undated_files'].append(rel)
            continue
        raw = path.read_bytes()
        lines = raw.splitlines(keepends=True)
        marked = [index for index, line in enumerate(lines, start=1) if _is_marked(line)]
        if file_date >= cutoff:
            report['skipped']['young_marked_lines'] += len(marked)
            report['skipped']['unmarked_lines'] += sum(
                1 for line in lines if line.strip() and not _is_marked(line)
            )
            continue
        marked_set = set(marked)
        report['skipped']['unmarked_lines'] += sum(
            1 for index, line in enumerate(lines, start=1)
            if line.strip() and index not in marked_set
        )
        for index, line in enumerate(lines, start=1):
            if index in marked_set:
                report['candidates'].append({
                    'path': rel,
                    'line': index,
                    'text': _preview(_decode(line).rstrip('\r\n')),
                })
    report['candidate_lines'] = len(report['candidates'])
    return report


def _take_snapshot(root: Path, reason: str) -> str:
    dest = memory_write._snapshot_dir(root)
    files: list[dict[str, Any]] = []
    for path in memory_write._iter_memory_files(root):
        rel = path.relative_to(root).as_posix()
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
        copied = target.read_bytes()
        files.append({
            'path': rel,
            'bytes': len(copied),
            'sha256': hashlib.sha256(copied).hexdigest(),
        })
    manifest = {
        'created_at': datetime.now().isoformat(timespec='seconds'),
        'reason': reason,
        'root': str(root),
        'file_count': len(files),
        'total_bytes': sum(int(item['bytes']) for item in files),
        'files': files,
    }
    _write_bytes(dest / 'MANIFEST.json', (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode())
    return dest.relative_to(root).as_posix()


def run_daily(root: Path, apply: bool = False, today: date | None = None) -> dict[str, Any]:
    report = plan_daily(root, today)
    report['dry_run'] = not apply
    if not apply or not report['candidates']:
        return report

    by_file: dict[str, set[int]] = {}
    for candidate in report['candidates']:
        by_file.setdefault(candidate['path'], set()).add(int(candidate['line']))
    report['snapshot'] = _take_snapshot(
        root, f'memory_consolidate daily before delete ({report["today"]})'
    )
    deleted = 0
    for rel in sorted(by_file):
        path = _guard(root / rel, root, '待写文件')
        raw = path.read_bytes()
        lines = raw.splitlines(keepends=True)
        drop = by_file[rel]
        kept = [line for index, line in enumerate(lines, start=1) if index not in drop]
        if len(kept) == len(lines):
            continue
        _write_bytes(path, b''.join(kept))
        deleted += len(lines) - len(kept)
        report['files_changed'].append(rel)
    report['deleted_lines'] = deleted
    return report


def _iter_active_md(root: Path) -> Iterator[tuple[str, Path]]:
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = sorted(name for name in dirnames if name not in EXCLUDED_DIR_NAMES)
        for name in sorted(filenames):
            if not name.endswith('.md'):
                continue
            path = _guard(Path(dirpath) / name, root, '活跃文件')
            if path.is_file():
                yield _rel(root, path), path


def _is_noise(line: str) -> bool:
    stripped = line.strip()
    return not stripped or stripped.startswith(NOISE_PREFIXES)


def _normalize(parts: Sequence[str]) -> str:
    return re.sub(r'\s+', ' ', ' '.join(parts)).strip()


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode('utf-8')).hexdigest()[:12]


def _body_lines(text: str) -> list[tuple[int, str]]:
    lines = text.replace('\r\n', '\n').replace('\r', '\n').split('\n')
    if lines and lines[0].strip() == '---':
        for index in range(1, len(lines)):
            if lines[index].strip() == '---':
                return [(number, line) for number, line in enumerate(lines[index + 1:], start=index + 2)]
    return list(enumerate(lines, start=1))


def _paragraphs(lines: Sequence[tuple[int, str]]) -> Iterator[tuple[int, list[str]]]:
    block: list[str] = []
    start = 0
    for number, line in lines:
        if _is_noise(line):
            if block:
                yield start, block
                block = []
        else:
            if not block:
                start = number
            block.append(line.strip())
    if block:
        yield start, block


def plan_weekly(root: Path, today: date | None = None) -> dict[str, Any]:
    """只读体检：重复段落/行、陈旧、超线、已完成任务候选。"""
    today = today or date.today()
    stale_cutoff = today - timedelta(days=STALE_DAYS)
    report: dict[str, Any] = {
        'mode': 'weekly',
        'dry_run': True,
        'root': str(root),
        'today': today.isoformat(),
        'files_scanned': 0,
        'duplicate_paragraphs': [],
        'duplicate_lines': [],
        'stale_files': [],
        'oversized_files': [],
        'completed_tasks': [],
        'write_actions': [],
        'warnings': [],
    }
    groups: dict[str, dict[str, Any]] = {}

    for rel, path in _iter_active_md(root):
        report['files_scanned'] += 1
        raw = path.read_bytes()
        lines = _body_lines(_decode(raw))
        for start, block in _paragraphs(lines):
            normalized = _normalize(block)
            if len(normalized) < 10:
                continue
            digest = _hash(normalized)
            group = groups.setdefault(digest, {
                'hash': digest,
                'preview': _preview(normalized, 120),
                'occurrences': [],
            })
            group['occurrences'].append({'path': rel, 'line': start})

        seen: dict[str, list[int]] = {}
        for number, line in lines:
            if _is_noise(line):
                continue
            normalized = _normalize([line])
            if len(normalized) < 6:
                continue
            seen.setdefault(_hash(normalized), []).append(number)
        for digest, numbers in seen.items():
            if len(numbers) < 2:
                continue
            report['duplicate_lines'].append({
                'hash': digest,
                'path': rel,
                'lines': numbers,
                'count': len(numbers),
            })

        mtime = datetime.fromtimestamp(path.stat().st_mtime).date()
        if mtime < stale_cutoff:
            report['stale_files'].append({
                'path': rel,
                'mtime': mtime.isoformat(),
                'age_days': (today - mtime).days,
            })

        line_count = len(raw.decode('utf-8', errors='replace').splitlines())
        size = len(raw)
        if size > LARGE_BYTES or line_count > LARGE_LINES:
            report['oversized_files'].append({
                'path': rel,
                'bytes': size,
                'lines': line_count,
                'suggestion': '拆分' if line_count > LARGE_LINES else '压缩',
            })

    for group in groups.values():
        rels = {occurrence['path'] for occurrence in group['occurrences']}
        if len(rels) >= 2:
            group['file_count'] = len(rels)
            report['duplicate_paragraphs'].append(group)
    report['duplicate_paragraphs'].sort(key=lambda item: item['hash'])
    report['duplicate_lines'].sort(key=lambda item: (item['path'], item['lines'][0]))

    tasks = root / TASKS_REL
    if tasks.is_file():
        _guard(tasks, root, '任务文件')
        text = _decode(tasks.read_bytes()).replace('\r\n', '\n').replace('\r', '\n')
        for number, line in enumerate(text.split('\n'), start=1):
            if DONE_TASK_RE.match(line):
                report['completed_tasks'].append({
                    'path': TASKS_REL,
                    'line': number,
                    'text': _preview(line.strip()),
                })
    else:
        report['warnings'].append(f'{TASKS_REL} 不存在')
    return report


def run_weekly(root: Path, apply: bool = False, today: date | None = None) -> dict[str, Any]:
    """weekly 无自动写动作；--apply 也只产出报告。"""
    report = plan_weekly(root, today)
    report['dry_run'] = not apply
    report['write_actions'] = []
    return report


def _print_daily(report: dict[str, Any]) -> None:
    state = 'DRY-RUN' if report['dry_run'] else 'APPLY'
    print(f"MODE daily {state} root={report['root']} today={report['today']} cutoff={report['cutoff']}")
    print(
        f"SCAN files={report['files_scanned']} candidates={report['candidate_lines']} "
        f"deleted={report['deleted_lines']}"
    )
    skipped = report['skipped']
    print(
        f"SKIP young_marked={skipped['young_marked_lines']} unmarked={skipped['unmarked_lines']} "
        f"undated={len(skipped['undated_files'])}"
    )
    for candidate in report['candidates']:
        print(f"CANDIDATE {candidate['path']}:{candidate['line']} {candidate['text']}")
    for warning in report['warnings']:
        print(f"WARN {warning}")
    if report['snapshot']:
        print(f"SNAPSHOT {report['snapshot']}")


def _print_weekly(report: dict[str, Any]) -> None:
    print(f"MODE weekly (report-only) root={report['root']} today={report['today']}")
    print(
        f"SCAN files={report['files_scanned']} duplicate_paragraphs={len(report['duplicate_paragraphs'])} "
        f"duplicate_lines={len(report['duplicate_lines'])} stale={len(report['stale_files'])} "
        f"oversized={len(report['oversized_files'])} completed_tasks={len(report['completed_tasks'])}"
    )
    for group in report['duplicate_paragraphs']:
        places = ', '.join(f"{item['path']}:{item['line']}" for item in group['occurrences'])
        print(f"DUP-PARA {group['hash']} files={group['file_count']} {places} :: {group['preview']}")
    for item in report['duplicate_lines']:
        print(f"DUP-LINE {item['path']} lines={item['lines']} x{item['count']} hash={item['hash']}")
    for item in report['stale_files']:
        print(f"STALE {item['path']} mtime={item['mtime']} age_days={item['age_days']}")
    for item in report['oversized_files']:
        print(
            f"OVERSIZE {item['path']} bytes={item['bytes']} lines={item['lines']} "
            f"suggestion={item['suggestion']}"
        )
    for item in report['completed_tasks']:
        print(f"DONE-TASK {item['path']}:{item['line']} {item['text']}")
    for warning in report['warnings']:
        print(f"WARN {warning}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog='memory_consolidate.py',
        description='AI 记忆目录离线巩固：daily 清理过期草稿标记行；weekly 只读体检。默认 dry-run。',
    )
    parser.add_argument('--mode', required=True, choices=('daily', 'weekly'))
    write = parser.add_mutually_exclusive_group()
    write.add_argument('--dry-run', dest='apply', action='store_false', help='只报告，不写文件（默认）')
    write.add_argument('--apply', dest='apply', action='store_true', help='daily 执行删除（先快照）；weekly 仍只报告')
    parser.set_defaults(apply=False)
    parser.add_argument('--root', default=None, help='记忆根目录（默认 {AI目录}/memory）')
    parser.add_argument('--json', action='store_true', help='输出机器可读 JSON')
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        root = _resolve_root(args.root)
        if args.mode == 'daily':
            report = run_daily(root, apply=bool(args.apply))
        else:
            report = run_weekly(root, apply=bool(args.apply))
        if args.json:
            print(json.dumps(report, ensure_ascii=False, indent=2))
        elif args.mode == 'daily':
            _print_daily(report)
        else:
            _print_weekly(report)
        return 0
    except (ConsolidateError, memory_write.MemoryWriteError) as exc:
        print(f'ERROR {exc}', file=sys.stderr)
        return exc.code
    except OSError as exc:
        print(f'ERROR 文件系统操作失败：{exc}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
