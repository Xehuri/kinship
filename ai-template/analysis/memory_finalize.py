#!/usr/bin/env python3
"""ai/memory 收尾门：确定性硬检查 + 软警告，只写 MEMORY-STATUS.json。

硬检查：断链、文件名日期不一致、PII、投影候选超过 24 小时或源已变。
软检查：文件大小、frontmatter 缺失、legacy 路径、补14/补16 引用。

用法：
    python {AI目录}/analysis/memory_finalize.py --root . --changed-from git \
        --projection-status {AI目录}/data/cache/memory-projection/projection-status.json
    python {AI目录}/analysis/memory_finalize.py --root . ai/memory/self/必读.md

不调用 LLM，不修改任何记忆内容；只有 ai/memory/MEMORY-STATUS.json 会被写入。
"""

from __future__ import annotations

# allow: SIZE_OK — 收尾门是单文件只读 CLI（变更解析/链接/日期/PII/投影/状态写入一体），拆分只会多一个部署件。

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any, Iterable, Sequence
from urllib.parse import unquote

from memory_audit import Check, ERROR, WARNING, split_frontmatter

AI_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = AI_ROOT.parent
STATUS_REL = 'ai/memory/MEMORY-STATUS.json'
MEMORY_REL = 'ai/memory'
DEFAULT_PROJECTION_STATUS = (
    AI_ROOT / 'data' / 'cache' / 'memory-projection' / 'projection-status.json'
)
PROJECTION_FRESH_HOURS = 24
SCHEMA_VERSION = 1
SOFT_BYTES = 20 * 1024
SOFT_LINES = 300
TARGET_TOPS = frozenset({'memory', 'agents'})
SKIP_PARTS = frozenset({'archive', '_template'})

MD_LINK_RE = re.compile(r'\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)')
WIKI_LINK_RE = re.compile(r'\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]')
FULL_DATE_RE = re.compile(r'(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)')
MONTH_RE = re.compile(r'(?<!\d)(\d{4})-(\d{2})(?!\d)')
LINE_DATE_RE = re.compile(r'^\s*(?:[-*+]\s*)?(\d{4})-(\d{2})-(\d{2})(?!\d)')
EXTERNAL_PREFIXES = ('http://', 'https://', 'mailto:', 'tel:', 'obsidian://', 'data:')
PII_PATTERNS = (
    ('身份证号', re.compile(r'(?<!\d)\d{17}[\dXx](?!\d)')),
    ('手机号', re.compile(r'(?<!\d)1[3-9]\d{9}(?!\d)')),
    ('银行卡号', re.compile(r'(?<!\d)\d{16,19}(?!\d)')),
    ('邮箱', re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}')),
)


class FinalizeError(RuntimeError):
    """收尾门无法继续时抛出。"""


@dataclass(frozen=True)
class Projection:
    path: Path
    built_at: datetime
    changed_lines: int
    candidate_paths: dict[str, str]
    warnings: tuple[str, ...]

    @property
    def fresh(self) -> bool:
        return self.age_hours <= PROJECTION_FRESH_HOURS

    def is_fresh(self, now: datetime | None = None) -> bool:
        return self._age(now or datetime.now().astimezone()) <= PROJECTION_FRESH_HOURS

    def _age(self, now: datetime) -> float:
        if now.tzinfo is None:
            now = now.astimezone()
        return (now - self.built_at).total_seconds() / 3600


def _parse_date(value: Any) -> date | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return date.fromisoformat(value.strip()[:10])
    except ValueError:
        return None


def _sha256_path(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _strip_code(text: str) -> str:
    text = re.sub(r'```.*?```', '', text, flags=re.S)
    return re.sub(r'`[^`\n]*`', '', text)


def _link_targets(text: str) -> Iterable[str]:
    clean = _strip_code(text)
    for match in MD_LINK_RE.finditer(clean):
        yield match.group(1).strip()
    for match in WIKI_LINK_RE.finditer(clean):
        yield match.group(1).strip()


def _external(target: str) -> bool:
    low = target.lower()
    return not target or target.startswith('#') or low.startswith(EXTERNAL_PREFIXES)


def _build_link_index(root: Path) -> set[str]:
    names: set[str] = set()
    ai_dir = root / 'ai'
    if not ai_dir.is_dir():
        return names
    for path in ai_dir.rglob('*.md'):
        names.add(path.name)
        names.add(path.stem)
    return names


def _link_exists(root: Path, source: Path, target: str, index: set[str]) -> bool:
    raw = unquote(target.strip().strip('<>')).split('#', 1)[0].strip()
    if not raw:
        return True
    variants = [raw] if Path(raw).suffix else [raw, raw + '.md']
    for base in (source.parent, root / 'ai' / 'memory', root / 'ai', root):
        if any((base / variant).exists() for variant in variants):
            return True
    if '/' not in raw:
        candidate = Path(raw).name
        if not Path(candidate).suffix:
            candidate += '.md'
        if candidate in index:
            return True
    return False


def _is_target(rel: Path) -> bool:
    parts = rel.parts
    return (
        rel.suffix.lower() == '.md'
        and len(parts) >= 3
        and parts[0] == 'ai'
        and parts[1] in TARGET_TOPS
        and not SKIP_PARTS.intersection(parts)
    )


def _date_allowed(value: date, kind: str, expected: date) -> bool:
    if kind == 'day':
        return value == expected
    if (value.year, value.month) == (expected.year, expected.month):
        return True
    months = value.year * 12 + value.month - (expected.year * 12 + expected.month)
    return (months == 1 and value.day <= 3) or (months == -1 and value.day >= 28)


def _date_checks(rel: Path, text: str, frontmatter: dict[str, Any]) -> list[Check]:
    display = rel.as_posix()
    match = FULL_DATE_RE.search(rel.stem)
    kind = 'day'
    expected: date | None = None
    if match:
        expected = date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    else:
        match = MONTH_RE.search(rel.stem)
        kind = 'month'
        if match:
            expected = date(int(match.group(1)), int(match.group(2)), 1)
    if expected is None:
        return []
    checks: list[Check] = []
    for key in ('date', 'updated'):
        actual = _parse_date(frontmatter.get(key))
        if actual is not None and not _date_allowed(actual, kind, expected):
            checks.append(Check(
                ERROR, 'memory.date.mismatch',
                f'文件名日期 {expected.isoformat()} 与 frontmatter {key} {actual.isoformat()} 不一致',
                display,
            ))
    bad: list[tuple[int, date]] = []
    for number, line in enumerate(text.splitlines(), 1):
        line_match = LINE_DATE_RE.match(line)
        if line_match:
            actual = date(int(line_match.group(1)), int(line_match.group(2)), int(line_match.group(3)))
            if not _date_allowed(actual, kind, expected):
                bad.append((number, actual))
    if bad:
        sample = ', '.join(f'L{number}:{actual.isoformat()}' for number, actual in bad[:3])
        checks.append(Check(
            ERROR, 'memory.date.mismatch',
            f'正文行首日期 {len(bad)} 处不在文件名日期 {expected.isoformat()} 范围（{sample}）',
            display,
        ))
    return checks


def _mask(value: str, label: str) -> str:
    if label == '邮箱' and '@' in value:
        local, domain = value.split('@', 1)
        return f'{local[:1]}***@{domain}'
    if len(value) <= 7:
        return '***'
    return f'{value[:3]}{"*" * (len(value) - 7)}{value[-4:]}'


def _pii_check(rel: Path, text: str) -> list[Check]:
    found: list[tuple[str, str, int, int]] = []
    taken: list[tuple[int, int]] = []
    for label, pattern in PII_PATTERNS:
        for match in pattern.finditer(text):
            start, end = match.span()
            if any(not (end <= old_start or start >= old_end) for old_start, old_end in taken):
                continue
            taken.append((start, end))
            found.append((label, match.group(0), start, end))
    if not found:
        return []
    counts: dict[str, int] = {}
    samples: dict[str, str] = {}
    for label, value, _start, _end in found:
        counts[label] = counts.get(label, 0) + 1
        samples.setdefault(label, _mask(value, label))
    detail = '、'.join(f'{label}×{counts[label]}（示例 {samples[label]}）' for label in counts)
    return [Check(ERROR, 'pii.detected', f'命中 PII：{detail}', rel.as_posix())]


def _soft_checks(rel: Path, path: Path, text: str, frontmatter: dict[str, Any]) -> list[Check]:
    display = rel.as_posix()
    checks: list[Check] = []
    size = path.stat().st_size
    lines = len(text.splitlines())
    if size > SOFT_BYTES or lines > SOFT_LINES:
        checks.append(Check(
            WARNING, 'memory.size.large',
            f'{size} bytes / {lines} lines，超过 {SOFT_BYTES // 1024}KB/{SOFT_LINES} 行',
            display,
        ))
    if not frontmatter:
        checks.append(Check(WARNING, 'memory.frontmatter.missing', '无 frontmatter', display))
    if rel.as_posix() == 'ai/memory/self/执行日志.md':
        checks.append(Check(WARNING, 'memory.legacy.path', 'legacy 路径仍被修改', display))
    legacy_refs = sorted({marker for marker in ('补14', '补16') if marker in text})
    if legacy_refs:
        checks.append(Check(
            WARNING, 'memory.legacy.batch_ref',
            '仍引用旧批次号：' + ', '.join(legacy_refs),
            display,
        ))
    return checks


def _projection_path(root: Path, explicit: str | os.PathLike[str] | None) -> Path | None:
    if explicit:
        return Path(explicit)
    env = os.environ.get('MEMORY_PROJECTION_STATUS')
    if env:
        return Path(env)
    if root.resolve() == REPO_ROOT:
        return DEFAULT_PROJECTION_STATUS
    return None


def _load_projection(path: Path | None, explicit: bool) -> tuple[Projection | None, list[Check]]:
    if path is None:
        return None, []
    if not path.is_file():
        if explicit:
            return None, [Check(ERROR, 'projection.status.missing', '投影状态文件不存在', str(path))]
        return None, []
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
        raw = str(data['built_at'])
        built = datetime.fromisoformat(raw.replace('Z', '+00:00'))
        if built.tzinfo is None:
            built = built.astimezone()
        changed = int(data.get('changed_lines') or 0)
        candidates = data.get('candidate_paths') or {}
        warnings = tuple(str(item) for item in (data.get('warnings') or []))
        if not isinstance(candidates, dict):
            raise ValueError('candidate_paths must be an object')
    except (OSError, KeyError, TypeError, ValueError) as exc:
        return None, [Check(ERROR, 'projection.status.invalid', f'投影状态不可解析：{exc}', str(path))]
    return Projection(path, built, changed, {str(k): str(v) for k, v in candidates.items()}, warnings), []


def _projection_checks(root: Path, status: Projection | None,
                       status_checks: list[Check], now: datetime | None = None) -> list[Check]:
    checks = list(status_checks)
    if status is None:
        return checks
    if not status.is_fresh(now):
        checks.append(Check(
            ERROR, 'projection.status.stale',
            f'投影候选超过 {PROJECTION_FRESH_HOURS} 小时未重建',
            str(status.path),
        ))
        return checks
    if status.changed_lines > 0:
        missing = [candidate for candidate in status.candidate_paths.values()
                   if not (status.path.parent / candidate).is_file()]
        if missing:
            checks.append(Check(
                ERROR, 'projection.candidate.missing',
                f'changed_lines={status.changed_lines} 但候选文件缺失：' + ', '.join(missing),
                str(status.path),
            ))
    data = json.loads(status.path.read_text(encoding='utf-8'))
    for source, expected in (data.get('source_hashes') or {}).items():
        path = root / MEMORY_REL / str(source)
        if not path.is_file():
            checks.append(Check(ERROR, 'projection.source.missing', f'投影源不存在：{source}', str(path)))
        elif _sha256_path(path) != str(expected):
            checks.append(Check(
                ERROR, 'projection.sources.changed',
                f'投影源在候选生成后已变：{source}',
                str(path),
            ))
    if status.warnings:
        checks.append(Check(
            WARNING, 'projection.warnings',
            f'投影状态含 {len(status.warnings)} 条警告（{status.warnings[0]}）',
            str(status.path),
        ))
    return checks


def _git_changed(root: Path) -> list[str]:
    command = ['git', '-c', 'core.quotepath=false', 'status', '--porcelain', '--untracked-files=all']
    try:
        result = subprocess.run(command, cwd=root, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise FinalizeError(f'无法读取 git 变更：{exc}') from exc
    if result.returncode != 0:
        raise FinalizeError(f'git status 失败：{result.stderr.strip()}')
    paths: list[str] = []
    for line in result.stdout.splitlines():
        if len(line) < 4:
            continue
        value = line[3:].strip()
        if ' -> ' in value:
            value = value.split(' -> ', 1)[1]
        paths.append(value.strip('"'))
    return paths


def _resolve_files(root: Path, files: Sequence[str], changed_from: str | None) -> list[Path]:
    raw = list(files)
    if changed_from == 'git':
        raw.extend(_git_changed(root))
    if not raw:
        raise FinalizeError('没有变更文件：请用 --changed-from git 或显式传入文件')
    resolved: set[Path] = set()
    for value in raw:
        path = Path(value)
        if not path.is_absolute():
            path = root / path
        rel = path.resolve().relative_to(root.resolve())
        if _is_target(rel):
            resolved.add(rel)
    return sorted(resolved, key=lambda item: item.as_posix())


def _run_id(root: Path, rels: Sequence[Path], projection_path: Path | None) -> str:
    digest = hashlib.sha256(b'memory-finalize-v1\0')
    digest.update(Path(__file__).read_bytes())
    for rel in rels:
        digest.update(rel.as_posix().encode('utf-8') + b'\0')
        path = root / rel
        digest.update(_sha256_path(path).encode() if path.is_file() else b'missing')
    if projection_path is not None and projection_path.is_file():
        digest.update(_sha256_path(projection_path).encode())
    else:
        digest.update(b'no-projection')
    return digest.hexdigest()[:16]


def _existing_status(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def finalize(root: str | os.PathLike[str], files: Sequence[str] = (),
             changed_from: str | None = None, projection_status: str | os.PathLike[str] | None = None,
             now: datetime | None = None) -> dict[str, Any]:
    root_path = Path(root).resolve()
    reference = now or datetime.now().astimezone()
    rels = _resolve_files(root_path, files, changed_from)
    projection_path = _projection_path(root_path, projection_status)
    explicit = projection_status is not None or bool(os.environ.get('MEMORY_PROJECTION_STATUS'))
    projection, status_checks = _load_projection(projection_path, explicit)
    index: set[str] | None = None
    checks: list[Check] = []
    for rel in rels:
        path = root_path / rel
        if not path.is_file():
            checks.append(Check(WARNING, 'memory.file.missing', '变更文件已不存在，跳过', rel.as_posix()))
            continue
        text = path.read_text(encoding='utf-8', errors='replace')
        frontmatter, _ = split_frontmatter(text)
        if index is None:
            index = _build_link_index(root_path)
        for target in _link_targets(text):
            if _external(target):
                continue
            if not _link_exists(root_path, path, target, index):
                checks.append(Check(ERROR, 'link.broken', f'断链：{target}', rel.as_posix()))
        checks.extend(_date_checks(rel, text, frontmatter))
        checks.extend(_pii_check(rel, text))
        checks.extend(_soft_checks(rel, path, text, frontmatter))
    checks.extend(_projection_checks(root_path, projection, status_checks, reference))
    checks.sort(key=lambda check: (0 if check.severity == ERROR else 1, check.check_id,
                                   check.path, check.message))
    errors = sum(1 for check in checks if check.severity == ERROR)
    warnings = sum(1 for check in checks if check.severity == WARNING)
    state = 'failed' if errors else ('warning' if warnings else 'passed')
    run_id = _run_id(root_path, rels, projection_path)
    payload = [check.as_dict() for check in checks]
    counts = {'changed_files': len(rels), 'errors': errors, 'warnings': warnings}
    status_path = root_path / STATUS_REL
    existing = _existing_status(status_path)
    if (existing and existing.get('run_id') == run_id
            and existing.get('checks') == payload and existing.get('counts') == counts
            and existing.get('status') == state):
        return existing
    stamp = reference.astimezone()
    result = {
        'schema_version': SCHEMA_VERSION,
        'last_finalize_at': stamp.isoformat(timespec='seconds'),
        'run_id': run_id,
        'status': state,
        'changed_files': [rel.as_posix() for rel in rels],
        'counts': counts,
        'checks': payload,
        'projection': {
            'status_path': str(projection_path) if projection_path else None,
            'built_at': projection.built_at.isoformat() if projection else None,
            'age_hours': round(projection._age(stamp), 2) if projection else None,
            'changed_lines': projection.changed_lines if projection else None,
            'state': 'fresh' if projection and projection.is_fresh(stamp) else ('stale' if projection else 'missing'),
        },
    }
    status_path.parent.mkdir(parents=True, exist_ok=True)
    status_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return result


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description='ai/memory 收尾门（只写 MEMORY-STATUS.json）')
    parser.add_argument('files', nargs='*', help='显式变更文件（仓库相对路径）')
    parser.add_argument('--root', default=str(REPO_ROOT), help='仓库根目录')
    parser.add_argument('--changed-from', choices=('git',), default=None, help='从 git 读取变更')
    parser.add_argument('--projection-status', default=None, help='projection-status.json 路径')
    parser.add_argument('--json', action='store_true', help='输出 JSON')
    args = parser.parse_args(argv)
    try:
        result = finalize(args.root, args.files, args.changed_from, args.projection_status)
    except (FinalizeError, OSError, ValueError) as exc:
        print(f'ERROR: {exc}', file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        for check in result['checks']:
            label = 'ERROR' if check['severity'] == ERROR else 'WARN'
            print(f"{label} [{check['id']}] {check['path']}: {check['message']}")
        counts = result['counts']
        print(f"SUMMARY changed={counts['changed_files']} errors={counts['errors']} "
              f"warnings={counts['warnings']} status={result['status']}")
    return 1 if result['status'] == 'failed' else 0


if __name__ == '__main__':
    sys.exit(main())
