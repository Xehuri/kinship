#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AI 记忆目录的唯一写入入口（A 方案）。

设计约束：
- Markdown 仍是真源；长期条目只追加，旧条目不删除，用 superseded/invalid 标记。
- 所有写入走 fcntl.flock（目录锁）+ 同目录临时文件 + fsync + os.replace + 目录 fsync，
  并发追加不会产生交错半行。
- 所有写入路径 realpath 后必须仍在 --root 内；越界退出 2。
- 保留原文件换行风格（CRLF/LF），只做局部插入/标记行替换。

用法：
    python analysis/memory_write.py append-log --text "完成批次" --task 01数据检查
    python analysis/memory_write.py append-scratch --date 2026-01-01 --source 主会话
        --type 想法 --text "..."
    python analysis/memory_write.py upsert --file memory/self/认知.md --key 定位
        --text "..." --source "复盘" --importance 3
    python analysis/memory_write.py mark --file memory/self/认知.md --key 定位
        --status superseded --superseded-by <id>
    python analysis/memory_write.py check --root memory --budgets
    python analysis/memory_write.py snapshot --root memory --reason "复盘前"

依赖：仅标准库。
"""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tempfile
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Iterator, Sequence

AI_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ROOT = AI_ROOT / 'memory'

STATUSES = ('active', 'superseded', 'invalid')
SCRATCH_TYPES = ('想法', '情绪', '立场', '候选', '待核', '疑问')
SCRATCH_SOURCE_RE = re.compile(r'^(主会话|复盘|批次-[0-9A-Za-z_-]+)$')

REQUIRED_FIELDS = ('id', 'key', 'status', 'valid_from', 'source', 'hash')
MARKER_RE = re.compile(r'^<!--\s*mem:\s*(.*?)\s*-->\s*$')
FIELD_RE = re.compile(r'([A-Za-z_][A-Za-z0-9_]*)=([^;]*?)(?=;|$)')

# (相对 root 的路径, 字节上限, 行数上限)
BUDGETS = (
    ('self/必读.md', 3 * 1024, None),
    ('profile/state.md', 3 * 1024, None),
    ('self/persona-lite.md', 6 * 1024, None),
    ('profile/core-lite.md', 6 * 1024, None),
    ('topics/INDEX.md', None, 80),
)
EXCLUDED_DIR_NAMES = frozenset({'.backups', 'archive', '_template', '.git', '__pycache__'})


class MemoryWriteError(Exception):
    """带退出码的显式错误；2=参数/路径安全，1=业务校验。"""

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


def _resolve(root_arg: str | None, file_arg: str | None, default_rel: str) -> tuple[Path, Path]:
    """返回 (root_real, target_real)，并保证 target 在 root 内。"""
    root = _real(Path(root_arg) if root_arg else DEFAULT_ROOT)
    if file_arg:
        raw = Path(file_arg)
        if raw.is_absolute():
            target = _real(raw)
        else:
            from_cwd = _real(Path.cwd() / raw)
            target = from_cwd if _inside(from_cwd, root) else _real(root / raw)
    else:
        target = _real(root / default_rel)
    if not _inside(target, root):
        raise MemoryWriteError(f'路径越界（必须位于 {root} 内）：{target}', 2)
    return root, target


@contextlib.contextmanager
def _dir_lock(directory: Path) -> Iterator[None]:
    """对目录 fd 加 flock：不产生锁文件，同目录写入天然串行化。"""
    directory.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(directory), os.O_RDONLY)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def _detect_newline(raw: bytes) -> str:
    pos = raw.find(b'\n')
    if pos > 0 and raw[pos - 1:pos] == b'\r':
        return '\r\n'
    return '\n'


def _read_text(target: Path) -> tuple[str, str]:
    """返回 (LF 归一化文本, 原换行风格)。"""
    if not target.exists():
        return '', '\n'
    raw = target.read_bytes()
    newline = _detect_newline(raw)
    text = raw.decode('utf-8', errors='surrogateescape')
    text = text.replace('\r\n', '\n').replace('\r', '\n')
    return text, newline


def _atomic_write(target: Path, text_lf: str, newline: str) -> None:
    """临时文件 + fsync + os.replace + 目录 fsync；失败清理临时文件。"""
    target.parent.mkdir(parents=True, exist_ok=True)
    data = text_lf.replace('\n', newline).encode('utf-8', errors='surrogateescape')
    fd, tmp_name = tempfile.mkstemp(prefix='.memwrite-', suffix='.tmp', dir=str(target.parent))
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, 'wb') as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        mode = stat.S_IMODE(target.stat().st_mode) if target.exists() else 0o644
        os.chmod(tmp, mode)
        os.replace(tmp, target)
    except BaseException:
        with contextlib.suppress(FileNotFoundError):
            tmp.unlink()
        raise
    dfd = os.open(str(target.parent), os.O_RDONLY)
    try:
        os.fsync(dfd)
    finally:
        os.close(dfd)


def _append_block(text_lf: str, block_lf: str, separate: bool) -> str:
    if text_lf and not text_lf.endswith('\n'):
        text_lf += '\n'
    if separate and text_lf and not text_lf.endswith('\n\n'):
        text_lf += '\n'
    return text_lf + block_lf


def _one_line(value: str) -> str:
    return ' '.join(value.strip().splitlines()).strip()


def _clean_field(value: str, name: str) -> str:
    value = _one_line(value)
    if not value:
        raise MemoryWriteError(f'{name} 不能为空', 2)
    if ';' in value or '-->' in value:
        raise MemoryWriteError(f'{name} 不能包含分号或 "-->"：{value!r}', 2)
    return value


def _hash_text(text: str) -> str:
    return hashlib.sha256(text.strip().encode('utf-8')).hexdigest()[:8]


def _stable_id(key: str, text_hash: str) -> str:
    return hashlib.sha1((key + text_hash).encode('utf-8')).hexdigest()[:12]


@dataclass
class Entry:
    line_index: int
    fields: list[tuple[str, str]]

    def get(self, name: str) -> str | None:
        for field, value in self.fields:
            if field == name:
                return value.strip()
        return None


def _parse_fields(marker_body: str) -> list[tuple[str, str]]:
    return [(m.group(1), m.group(2).strip()) for m in FIELD_RE.finditer(marker_body)]


def _parse_entries(text_lf: str) -> list[Entry]:
    entries: list[Entry] = []
    for index, line in enumerate(text_lf.split('\n')):
        match = MARKER_RE.match(line.strip())
        if match:
            entries.append(Entry(index, _parse_fields(match.group(1))))
    return entries


def _format_marker(fields: Sequence[tuple[str, str]]) -> str:
    return '<!-- mem: ' + '; '.join(f'{key}={value}' for key, value in fields) + ' -->'


def _replace_marker_line(lines: list[str], entry: Entry, fields: Sequence[tuple[str, str]]) -> None:
    lines[entry.line_index] = _format_marker(fields)


def _updated_fields(
    existing: Sequence[tuple[str, str]], updates: dict[str, str]
) -> list[tuple[str, str]]:
    result: list[tuple[str, str]] = []
    seen: set[str] = set()
    for key, value in existing:
        if key in updates:
            result.append((key, updates[key]))
            seen.add(key)
        else:
            result.append((key, value))
    for key, value in updates.items():
        if key not in seen:
            result.append((key, value))
    return result


def _write_result(target: Path, text_lf: str, newline: str) -> None:
    _atomic_write(target, text_lf, newline)


def cmd_append_log(args: argparse.Namespace) -> int:
    month = datetime.now().strftime('%Y-%m')
    _root, target = _resolve(args.root, args.file, f'self/执行日志/{month}.md')
    now = datetime.now()
    line = f'- {now.strftime("%Y-%m-%d %H:%M")} [{_one_line(args.task)}] {_one_line(args.text)}'
    with _dir_lock(target.parent):
        text, newline = _read_text(target)
        _write_result(target, _append_block(text, line + '\n', separate=False), newline)
    print(f'OK {target}')
    return 0


def cmd_append_scratch(args: argparse.Namespace) -> int:
    if not SCRATCH_SOURCE_RE.match(args.source):
        raise MemoryWriteError(f'非法 --source：{args.source}（主会话/复盘/批次-XX）', 2)
    try:
        scratch_date = date.fromisoformat(args.date)
    except ValueError as exc:
        raise MemoryWriteError(f'非法 --date：{args.date}', 2) from exc
    _root, target = _resolve(args.root, None, f'self/scratch/{scratch_date.isoformat()}.md')
    line = (
        f'- [{datetime.now().strftime("%H:%M")}]'
        f'[来源:{args.source}][类型:{args.type}] {_one_line(args.text)}'
    )
    with _dir_lock(target.parent):
        text, newline = _read_text(target)
        _write_result(target, _append_block(text, line + '\n', separate=False), newline)
    print(f'OK {target}')
    return 0


def cmd_upsert(args: argparse.Namespace) -> int:
    if not 1 <= args.importance <= 5:
        raise MemoryWriteError('--importance 必须在 1..5', 2)
    key = _clean_field(args.key, '--key')
    source = _clean_field(args.source, '--source')
    body = args.text.strip().replace('\r\n', '\n').replace('\r', '\n')
    if not body:
        raise MemoryWriteError('--text 不能为空', 2)
    text_hash = _hash_text(body)
    entry_id = _stable_id(key, text_hash)
    _root, target = _resolve(args.root, args.file, 'self/必读.md')
    today = date.today().isoformat()

    with _dir_lock(target.parent):
        text, newline = _read_text(target)
        lines = text.split('\n')
        entries = _parse_entries(text)
        active_same = [
            entry
            for entry in entries
            if entry.get('key') == key and entry.get('status') == 'active'
        ]

        if any(entry.get('hash') == text_hash for entry in active_same):
            print('NOOP')
            return 0

        for entry in active_same:
            updated = _updated_fields(
                entry.fields,
                {
                    'status': 'superseded',
                    'superseded_by': entry_id,
                    'invalid_at': today,
                },
            )
            _replace_marker_line(lines, entry, updated)

        new_fields = [
            ('id', entry_id),
            ('key', key),
            ('status', args.status),
            ('valid_from', today),
            ('source', source),
            ('importance', str(args.importance)),
            ('hash', text_hash),
        ]
        block = _format_marker(new_fields) + '\n' + body + '\n'
        result = _append_block('\n'.join(lines), block, separate=True)
        _write_result(target, result, newline)
    print(f'OK {entry_id} {target}')
    return 0


def cmd_mark(args: argparse.Namespace) -> int:
    key = _clean_field(args.key, '--key')
    _root, target = _resolve(args.root, args.file, 'self/必读.md')
    if not target.is_file():
        raise MemoryWriteError(f'文件不存在：{target}', 1)
    with _dir_lock(target.parent):
        text, newline = _read_text(target)
        lines = text.split('\n')
        entries = [entry for entry in _parse_entries(text) if entry.get('key') == key]
        if not entries:
            raise MemoryWriteError(f'未找到 key：{key}', 1)
        for entry in entries:
            updates = {'status': args.status}
            if args.superseded_by:
                updates['superseded_by'] = _clean_field(args.superseded_by, '--superseded-by')
            if args.status in ('superseded', 'invalid'):
                updates['invalid_at'] = (
                    args.invalid_at or entry.get('invalid_at') or date.today().isoformat()
                )
            _replace_marker_line(lines, entry, _updated_fields(entry.fields, updates))
        _write_result(target, '\n'.join(lines), newline)
    print(f'OK {key} -> {args.status}')
    return 0


def _iter_memory_files(root: Path) -> Iterator[Path]:
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(name for name in dirnames if name not in EXCLUDED_DIR_NAMES)
        for name in sorted(filenames):
            path = Path(dirpath) / name
            if path.is_file() and not path.is_symlink():
                yield path


def _scan_markers(path: Path, rel: str) -> tuple[list[tuple[int, dict[str, str]]], list[str]]:
    try:
        text = path.read_text(encoding='utf-8', errors='replace')
    except OSError as exc:
        return [], [f'{rel}: 读取失败：{exc}']
    markers: list[tuple[int, dict[str, str]]] = []
    for line_no, line in enumerate(text.splitlines(), start=1):
        match = MARKER_RE.match(line.strip())
        if match:
            markers.append((line_no, {key: value for key, value in _parse_fields(match.group(1))}))
    return markers, []


def _check_budgets(root: Path, violations: list[str]) -> list[str]:
    details: list[str] = []
    for rel, max_bytes, max_lines in BUDGETS:
        path = root / rel
        if not path.is_file():
            continue
        size = path.stat().st_size
        if max_bytes is not None:
            details.append(f'{rel}: {size}/{max_bytes} bytes')
            if size > max_bytes:
                violations.append(f'{rel}: 超预算 {size} bytes > {max_bytes}')
        if max_lines is not None:
            lines = len(path.read_text(encoding='utf-8', errors='replace').splitlines())
            details.append(f'{rel}: {lines}/{max_lines} lines')
            if lines > max_lines:
                violations.append(f'{rel}: 超预算 {lines} lines > {max_lines}')
    return details


def cmd_check(args: argparse.Namespace) -> int:
    root = _real(Path(args.root) if args.root else DEFAULT_ROOT)
    if not root.is_dir():
        raise MemoryWriteError(f'root 不存在或不是目录：{root}', 2)

    violations: list[str] = []
    active: dict[str, list[tuple[str, int]]] = {}
    marker_count = 0
    file_count = 0

    for path in _iter_memory_files(root):
        file_count += 1
        rel = path.relative_to(root).as_posix()
        markers, problems = _scan_markers(path, rel)
        violations.extend(problems)
        marker_count += len(markers)
        for line_no, fields in markers:
            missing = [name for name in REQUIRED_FIELDS if not fields.get(name)]
            if missing:
                violations.append(f'{rel}:{line_no}: 缺字段 {", ".join(missing)}')
            status = fields.get('status')
            if status and status not in STATUSES:
                violations.append(f'{rel}:{line_no}: 非法 status={status!r}')
            key = fields.get('key')
            if key and status == 'active':
                active.setdefault(key, []).append((rel, line_no))

    for key, places in sorted(active.items()):
        if len(places) > 1:
            where = ', '.join(f'{rel}:{line}' for rel, line in places)
            violations.append(f'key {key!r} 存在 {len(places)} 条 active（{where}）')

    details = _check_budgets(root, violations) if args.budgets else []

    if args.budgets:
        for detail in details:
            print(f'BUDGET {detail}')
    if violations:
        for violation in violations:
            print(f'ERROR {violation}')
        print(f'FAIL {len(violations)} 项违规（{file_count} 文件，{marker_count} 条目）')
        return 1
    print(f'OK {file_count} 文件，{marker_count} 条目标记')
    return 0


def _snapshot_dir(root: Path) -> Path:
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    base = root / '.backups'
    target = base / stamp
    counter = 1
    while target.exists():
        target = base / f'{stamp}-{counter}'
        counter += 1
    if not _inside(_real(target), root):
        raise MemoryWriteError(f'快照目录越界：{target}', 2)
    target.mkdir(parents=True)
    return target


def cmd_snapshot(args: argparse.Namespace) -> int:
    root = _real(Path(args.root) if args.root else DEFAULT_ROOT)
    if not root.is_dir():
        raise MemoryWriteError(f'root 不存在或不是目录：{root}', 2)
    dest = _snapshot_dir(root)

    files: list[dict[str, object]] = []
    for path in _iter_memory_files(root):
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
        'reason': args.reason,
        'root': str(root),
        'file_count': len(files),
        'total_bytes': sum(int(item['bytes']) for item in files),
        'files': files,
    }
    payload = json.dumps(manifest, ensure_ascii=False, indent=2) + '\n'
    _atomic_write(dest / 'MANIFEST.json', payload, '\n')
    print(f'OK {dest} ({len(files)} files)')
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog='memory_write.py',
        description='AI 记忆目录的唯一写入入口：加锁、原子写、去重、状态标记、预算体检。',
    )
    parser.add_argument('--root', dest='global_root', default=None, help='记忆根目录（也可放在子命令后）')
    sub = parser.add_subparsers(dest='command', required=True)

    log = sub.add_parser('append-log', help='追加一行执行日志')
    log.add_argument('--text', required=True)
    log.add_argument('--task', required=True)
    log.add_argument('--file', default=None)
    log.add_argument('--root', default=None)
    log.set_defaults(func=cmd_append_log)

    scratch = sub.add_parser('append-scratch', help='追加一行草稿纸')
    scratch.add_argument('--date', required=True)
    scratch.add_argument('--source', required=True)
    scratch.add_argument('--type', required=True, choices=SCRATCH_TYPES)
    scratch.add_argument('--text', required=True)
    scratch.add_argument('--root', default=None)
    scratch.set_defaults(func=cmd_append_scratch)

    upsert = sub.add_parser('upsert', help='按 key 去重追加/取代记忆条目')
    upsert.add_argument('--file', required=True)
    upsert.add_argument('--key', required=True)
    upsert.add_argument('--text', required=True)
    upsert.add_argument('--source', required=True)
    upsert.add_argument('--importance', type=int, default=3)
    upsert.add_argument('--status', default='active', choices=STATUSES)
    upsert.add_argument('--root', default=None)
    upsert.set_defaults(func=cmd_upsert)

    mark = sub.add_parser('mark', help='只改指定 key 的标记行')
    mark.add_argument('--file', required=True)
    mark.add_argument('--key', required=True)
    mark.add_argument('--status', required=True, choices=('superseded', 'invalid'))
    mark.add_argument('--superseded-by', default=None)
    mark.add_argument('--invalid-at', default=None)
    mark.add_argument('--root', default=None)
    mark.set_defaults(func=cmd_mark)

    check = sub.add_parser('check', help='只读校验标记与预算')
    check.add_argument('--root', default=None)
    check.add_argument('--budgets', action='store_true', help='同时校验记忆预算')
    check.set_defaults(func=cmd_check)

    snapshot = sub.add_parser('snapshot', help='快照记忆目录活跃文件')
    snapshot.add_argument('--root', default=None)
    snapshot.add_argument('--reason', required=True)
    snapshot.set_defaults(func=cmd_snapshot)

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if getattr(args, 'root', None) is None:
        args.root = getattr(args, 'global_root', None)
    try:
        return int(args.func(args))
    except MemoryWriteError as exc:
        print(f'ERROR {exc}', file=sys.stderr)
        return exc.code
    except OSError as exc:
        print(f'ERROR 文件系统操作失败：{exc}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
