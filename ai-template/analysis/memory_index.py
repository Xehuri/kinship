#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""只读记忆索引 CLI（M1）。

用法：
    python {AI目录}/analysis/memory_index.py --dry-run
    python {AI目录}/analysis/memory_index.py --out {AI目录}/data/cache/memory-index/run1
    python {AI目录}/analysis/memory_index.py --dates 2099-01-01,2099-01-02 \
        --out {AI目录}/data/cache/memory-index/run2

--dates 缺省为今天及前两天（按运行当天动态计算）；需要可复现的固定窗口时
显式传入 --dates。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

import memory_index_lib as lib


def _dates(value: str) -> tuple[str, ...]:
    return tuple(part.strip() for part in value.split(',') if part.strip())


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description='构建只读记忆索引（entities/links/manifest/status）')
    parser.add_argument('--repo-root', default=str(REPO_ROOT), help='仓库根目录')
    parser.add_argument('--dates', type=_dates, default=lib.DEFAULT_DATES,
                        help='逗号分隔的日期；缺省为今天及前两天，动态计算')
    parser.add_argument('--out', help='输出目录（非 dry-run 必填）')
    parser.add_argument('--dry-run', action='store_true', help='只扫描并输出计数，不写任何文件')
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.dry_run and not args.out:
        parser.error('--out is required unless --dry-run is set')
    try:
        result = lib.build_index(args.repo_root, args.dates, args.out, args.dry_run)
    except lib.MemoryIndexError as exc:
        print(f'error: {exc}', file=sys.stderr)
        return 2
    summary = dict(result.summary)
    if result.written:
        summary['written'] = list(result.written)
    print(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
