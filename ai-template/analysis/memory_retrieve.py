#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""记忆目录只读检索工具：query -> 带行号片段 + UTF-8 字节预算。

设计约束：
- 只读：不写任何文件，不联网，无第三方依赖，纯 lexical（无 embedding）。
- 扫描 --root 下所有 .md；跳过 archive/、_template/、.backups/、.git/、__pycache__/。
- 默认不含 self/执行日志/ 与旧路径 self/执行日志.md；--include-cold 显式恢复。
- 指向 root 之外的符号链接文件直接跳过（stderr 计数提示），不退出。
- 查询分词：CJK 连续串切 2-gram（单字保留），ASCII/数字按小写单词；去重去停用词。
- 片段以 Markdown 标题（^#{1,6} ）为边界；正文超过 40 行按空行再切。
- score = 0.55*relevance + 0.30*recency + 0.15*importance（importance 为路径先验 1~5）。
- relevance = (正文命中数 + 2*标题命中数) / sqrt(正文非空白字符数)，仅保留 >0。
- recency = 0.5 ** (文件 mtime 距今天数 / 30)。
- 按 score 降序、path、start_line 排序，取 top --max-items；普通片段超 --budget 立即停止；
  单片段本身大于总预算时按 budget/max-items 配额截断（避免超大文件独占全部预算）。
- --context N 时片段前后各带 N 行，行号前缀计入预算。

用法：
    python {AI目录}/analysis/memory_retrieve.py --query "人物 通话" --budget 6000
    python {AI目录}/analysis/memory_retrieve.py --query "记忆体系 分层" --json
"""

from __future__ import annotations

# allow: SIZE_OK — 任务限定只新增单文件只读 CLI（扫描/分词/切片/打分/预算/输出一体）。

import argparse
import json
import math
import os
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

AI_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ROOT = AI_ROOT / 'memory'
EXCLUDED_DIRS = frozenset({'archive', '_template', '.backups', '.git', '__pycache__'})
COLD_PREFIXES = ('self/执行日志/',)
COLD_FILES = ('self/执行日志.md',)
HEADING_RE = re.compile(r'^#{1,6} +(.+?)\s*$')
CJK_RUN_RE = re.compile(r'[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+')
ASCII_WORD_RE = re.compile(r'[a-z0-9_]+')
MAX_SEGMENT_LINES = 40
STOPWORDS = frozenset((
    '的', '了', '是', '在', '和', '与', '及', '或', '一个', '这个', '那个',
    '我', '你', '他', '她', '它', '们', '有', '没有', '就', '都', '而', '被',
    '把', '给', '让', '对', '从', '到', '为', '以', '于', '之', '其', '这',
    '那', '哪', '什么', '怎么', '为什么', '可以', '需要',
))
IMPORTANCE_HIGH = ('self/纠错', 'self/必读', 'profile/core-lite', 'self/persona-lite')
IMPORTANCE_TOPIC = ('profile/semantic', 'topics')


class RetrieveError(Exception):
    """可预期的用户错误，携带 CLI 退出码。"""

    def __init__(self, message: str, code: int = 2) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class Segment:
    path: str
    start_line: int  # 1-based，片段正文首行
    end_line: int    # 1-based，片段正文末行（含）
    heading: str
    text: str


@dataclass(frozen=True)
class Hit:
    segment: Segment
    score: float


def tokenize(query: str) -> list[str]:
    """CJK 2-gram + ASCII 小写单词，去重并移除停用词。"""
    raw: list[str] = []
    for run in CJK_RUN_RE.findall(query):
        if len(run) == 1:
            raw.append(run)
        else:
            raw.extend(run[index:index + 2] for index in range(len(run) - 1))
    raw.extend(ASCII_WORD_RE.findall(query.lower()))
    terms: list[str] = []
    seen: set[str] = set()
    for term in raw:
        if not term or term in STOPWORDS or term in seen:
            continue
        seen.add(term)
        terms.append(term)
    return terms


def importance_for(rel_path: str) -> int:
    if any(marker in rel_path for marker in IMPORTANCE_HIGH):
        return 5
    if any(marker in rel_path for marker in IMPORTANCE_TOPIC):
        return 4
    if 'fact' in rel_path:
        return 3
    if 'self/执行日志' in rel_path:
        return 1
    return 2


def _inside(path: Path, root_real: Path) -> bool:
    try:
        path.resolve().relative_to(root_real)
        return True
    except (OSError, ValueError):
        return False


def is_cold(rel_path: str) -> bool:
    return rel_path in COLD_FILES or any(rel_path.startswith(prefix) for prefix in COLD_PREFIXES)


def iter_markdown_files(root: Path, include_cold: bool = False) -> tuple[list[Path], int]:
    """返回 (root 内 .md 文件, 被跳过的越界符号链接数)。"""
    root_real = root.resolve()
    files: list[Path] = []
    skipped = 0
    for current, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = sorted(name for name in dirnames if name not in EXCLUDED_DIRS)
        for name in sorted(filenames):
            if not name.endswith('.md'):
                continue
            path = Path(current) / name
            if path.is_symlink() and not _inside(path, root_real):
                skipped += 1
                continue
            if not _inside(path, root_real):
                skipped += 1
                continue
            if not include_cold and is_cold(path.relative_to(root).as_posix()):
                continue
            files.append(path)
    return files, skipped


def _chunks(lines: Sequence[str], body_start: int, body_end: int) -> list[tuple[int, int]]:
    """把一段正文按空行切成不超过 40 行的块（0-based，end 为开区间）。"""
    if body_end <= body_start:
        return []
    if body_end - body_start <= MAX_SEGMENT_LINES:
        return [(body_start, body_end)]
    ranges: list[tuple[int, int]] = []
    index = body_start
    while index < body_end:
        end = index
        while end < body_end and lines[end].strip():
            end += 1
        if end == index:  # 空行本身
            end = index + 1
        if ranges and end - ranges[-1][0] <= MAX_SEGMENT_LINES:
            ranges[-1] = (ranges[-1][0], end)
        elif end - index > MAX_SEGMENT_LINES:
            cursor = index
            while cursor < end:
                ranges.append((cursor, min(cursor + MAX_SEGMENT_LINES, end)))
                cursor += MAX_SEGMENT_LINES
        else:
            ranges.append((index, end))
        index = end
    return ranges


def _append_segment(segments: list[Segment], rel_path: str, lines: Sequence[str],
                    start: int, end: int, heading: str) -> None:
    if start >= end:
        return
    segments.append(Segment(
        path=rel_path,
        start_line=start + 1,
        end_line=end,
        heading=heading,
        text='\n'.join(lines[start:end]),
    ))


def segment_lines(rel_path: str, lines: Sequence[str]) -> list[Segment]:
    headings: list[tuple[int, str]] = []
    for index, line in enumerate(lines):
        match = HEADING_RE.match(line)
        if match:
            headings.append((index, match.group(1).strip()))
    segments: list[Segment] = []
    if not headings:
        for start, end in _chunks(lines, 0, len(lines)):
            _append_segment(segments, rel_path, lines, start, end, '')
        return segments
    if headings[0][0] > 0:
        for start, end in _chunks(lines, 0, headings[0][0]):
            _append_segment(segments, rel_path, lines, start, end, '')
    for position, (line_index, title) in enumerate(headings):
        body_start = line_index + 1
        body_end = headings[position + 1][0] if position + 1 < len(headings) else len(lines)
        for start, end in _chunks(lines, body_start, body_end):
            _append_segment(segments, rel_path, lines, start, end, title)
    return segments


def _relevance(segment: Segment, terms: Sequence[str]) -> float:
    text = segment.text.lower()
    heading = segment.heading.lower()
    hits = sum(text.count(term) for term in terms)
    weighted = hits + 2 * sum(heading.count(term) for term in terms)
    if weighted <= 0:
        return 0.0
    length = len(''.join(text.split())) or 1
    return weighted / math.sqrt(length)


def _snippet(lines: Sequence[str], segment: Segment, context: int) -> str:
    first = max(1, segment.start_line - context)
    last = min(len(lines), segment.end_line + context)
    return '\n'.join(
        f'{number:>5} | {lines[number - 1]}' for number in range(first, last + 1)
    )


def _clip_utf8(text: str, cap: int) -> str:
    """按 UTF-8 字节安全截断，附带省略号。"""
    raw = text.encode('utf-8')
    if len(raw) <= cap:
        return text
    marker = '…'
    room = cap - len(marker.encode('utf-8'))
    if room <= 0:
        return ''
    return raw[:room].decode('utf-8', 'ignore') + marker


def retrieve(root: str | os.PathLike[str], query: str, budget: int = 6000,
             max_items: int = 12, context: int = 1, now: float | None = None,
             include_cold: bool = False) -> dict[str, Any]:
    terms = tokenize(query)
    if not terms:
        raise RetrieveError('查询为空（或只含停用词）', 2)
    root_path = Path(root)
    if not root_path.is_dir():
        raise RetrieveError(f'root 不存在或不是目录：{root_path}', 2)
    files, skipped = iter_markdown_files(root_path, include_cold)
    if skipped:
        print(f'提示：跳过 {skipped} 个指向 root 之外的文件/链接', file=sys.stderr)
    now_ts = time.time() if now is None else now
    hits: list[Hit] = []
    lines_by_rel: dict[str, list[str]] = {}
    for path in files:
        rel_path = path.relative_to(root_path).as_posix()
        try:
            text = path.read_text(encoding='utf-8', errors='replace')
            mtime = path.stat().st_mtime
        except OSError as exc:
            print(f'提示：跳过不可读文件 {rel_path}（{exc}）', file=sys.stderr)
            continue
        lines = text.splitlines()
        lines_by_rel[rel_path] = lines
        age_days = max(0.0, (now_ts - mtime) / 86400.0)
        recency = 0.5 ** (age_days / 30.0)
        importance = importance_for(rel_path)
        for segment in segment_lines(rel_path, lines):
            relevance = _relevance(segment, terms)
            if relevance <= 0:
                continue
            score = 0.55 * relevance + 0.30 * recency + 0.15 * importance
            hits.append(Hit(segment, score))
    hits.sort(key=lambda hit: (-hit.score, hit.segment.path, hit.segment.start_line))
    items: list[dict[str, Any]] = []
    total_bytes = 0
    for hit in hits[:max_items]:
        snippet = _snippet(lines_by_rel[hit.segment.path], hit.segment, context)
        size = len(snippet.encode('utf-8'))
        remaining = budget - total_bytes
        if remaining <= 0:
            break
        if size > budget:
            # 单个片段超过总预算：按单片段配额截断，避免一个超大文件吃掉全部预算。
            cap = max(1, budget // max(1, max_items))
            snippet = _clip_utf8(snippet, min(cap, remaining))
            size = len(snippet.encode('utf-8'))
        elif size > remaining:
            break
        if not snippet:
            break
        total_bytes += size
        items.append({
            'path': hit.segment.path,
            'line': hit.segment.start_line,
            'heading': hit.segment.heading,
            'score': round(hit.score, 6),
            'text': snippet,
        })
    return {
        'query': query,
        'terms': terms,
        'budget': budget,
        'items': items,
        'total_bytes': total_bytes,
    }


def render_human(result: dict[str, Any]) -> str:
    blocks: list[str] = []
    for item in result['items']:
        blocks.append(
            f"{item['path']}:{item['line']} [{item['score']:.4f}] {item['heading']}".rstrip()
        )
        blocks.append(item['text'])
    return '\n\n'.join(blocks) + ('\n' if blocks else '')


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description='记忆目录只读 lexcial 检索（带行号片段与字节预算）')
    parser.add_argument('--query', required=True, help='查询词，例如 "人物 通话"')
    parser.add_argument('--root', default=str(DEFAULT_ROOT), help='记忆根目录')
    parser.add_argument('--budget', type=int, default=6000, help='输出片段 UTF-8 字节上限')
    parser.add_argument('--max-items', type=int, default=12, help='最多返回片段数')
    parser.add_argument('--context', type=int, default=1, help='片段前后附带行数')
    parser.add_argument('--include-cold', action='store_true', help='包含执行日志等冷数据')
    parser.add_argument('--json', action='store_true', help='输出 JSON')
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.budget < 0 or args.max_items < 1 or args.context < 0:
        print('参数非法：budget/context 需 >=0，max-items 需 >=1', file=sys.stderr)
        return 2
    try:
        result = retrieve(args.root, args.query, args.budget, args.max_items, args.context,
                          include_cold=args.include_cold)
    except RetrieveError as exc:
        print(str(exc), file=sys.stderr)
        return exc.code
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        sys.stdout.write(render_human(result))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
