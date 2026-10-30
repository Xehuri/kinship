#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
mimo_audio_sweep.py — mimo_audio 缓存自动清理（写入方负责，防膨胀）

背景：`data/cache/mimo_audio/` 是 audio_mimo_analyzer / listen_audio 的
临时音频中转区（复制音频 → 后端签名端点暴露给 MiMo → 分析完删）；异常中断会留孤儿。
本模块负责自动清理，防止长期累积。

清理策略（三层）：
    1. .md 结果文件永不删除（analysis 链引用 117+ 个 .md）
    2. 保护期内文件不删（默认 2 小时，正在被 MiMo 拉取的在途文件）
    3. 保留 N 天（默认 7）+ 总量上限（默认 300MB）双约束：
       先删超期音频，仍超总量则按 mtime 从旧到新删到上限内

用法：
    python mimo_audio_sweep.py                 # 默认参数清理
    python mimo_audio_sweep.py --dry-run       # 只统计不删
    python mimo_audio_sweep.py --retention-days 3 --max-total-mb 100
    程序化：from mimo_audio_sweep import sweep; sweep()
"""
import argparse
import json
import os
import sys
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
AI_ROOT = os.path.normpath(os.path.join(SCRIPT_DIR, ".."))

# 结果文件后缀：永不删除（analysis 链会引用这些 .md）
RESULT_EXTS = {".md"}

DEFAULT_RETENTION_DAYS = 7
DEFAULT_MAX_TOTAL_MB = 300
DEFAULT_PROTECT_HOURS = 2


def _default_cache_dir():
    # 与 analyze 侧一致：{AI目录}/data/cache/mimo_audio（本文件在 analysis/ 下）
    return os.path.normpath(os.path.join(AI_ROOT, "data", "cache", "mimo_audio"))


def sweep(cache_dir=None, retention_days=DEFAULT_RETENTION_DAYS,
          max_total_mb=DEFAULT_MAX_TOTAL_MB, protect_hours=DEFAULT_PROTECT_HOURS,
          dry_run=False, verbose=False):
    """清理 mimo_audio 缓存，返回统计 dict（不抛异常，失败返回 error 字段）。"""
    cache_dir = cache_dir or _default_cache_dir()
    stats = {
        "dir": cache_dir,
        "scanned": 0,
        "audio_files": 0,
        "deleted": 0,
        "freed_bytes": 0,
        "kept_md": 0,
        "kept_protected": 0,
        "kept_within_retention": 0,
        "total_audio_bytes": 0,
        "dry_run": dry_run,
        "error": None,
    }
    if not os.path.isdir(cache_dir):
        stats["error"] = "cache_dir_not_found"
        return stats

    now = time.time()
    retention_sec = max(0, retention_days) * 86400
    protect_sec = max(0, protect_hours) * 3600
    max_total_bytes = max(0, max_total_mb) * 1024 * 1024

    try:
        entries = []
        for name in os.listdir(cache_dir):
            path = os.path.join(cache_dir, name)
            if not os.path.isfile(path):
                continue
            stats["scanned"] += 1
            ext = os.path.splitext(name)[1].lower()
            if ext in RESULT_EXTS:
                stats["kept_md"] += 1
                continue
            # 非 .md 一律视为可清理的中间产物（含未知后缀/concat 清单/无后缀），
            # 结果文件只有 .md，这条边界必须守住
            try:
                mtime = os.path.getmtime(path)
                size = os.path.getsize(path)
            except OSError:
                continue
            stats["audio_files"] += 1
            stats["total_audio_bytes"] += size
            entries.append((mtime, size, path))

        # 第 1 刀：删超保护期且超保留期的；同时记录幸存清单
        survivors = []          # (mtime, size, path, protected: bool)
        for mtime, size, path in entries:
            age = now - mtime
            protected = age <= protect_sec
            if not protected and retention_sec and age > retention_sec:
                if dry_run:
                    stats["deleted"] += 1
                    stats["freed_bytes"] += size
                    if verbose:
                        print("del(过期): %s (%.1f MB, %.1f 天)"
                              % (os.path.basename(path), size / 1048576, age / 86400))
                    continue
                try:
                    os.remove(path)
                    stats["deleted"] += 1
                    stats["freed_bytes"] += size
                    if verbose:
                        print("del(过期): %s (%.1f MB, %.1f 天)"
                              % (os.path.basename(path), size / 1048576, age / 86400))
                    continue
                except OSError:
                    pass  # 删除失败留待下次
            if protected:
                stats["kept_protected"] += 1
            else:
                stats["kept_within_retention"] += 1
            survivors.append((mtime, size, path, protected))

        # 第 2 刀：幸存音频仍超总量上限 → 按 mtime 从旧到新删（保护期不删）
        total = sum(s for _, s, _, _ in survivors)
        deletable = sorted((e for e in survivors if not e[3]), key=lambda e: e[0])
        for mtime, size, path, _protected in deletable:
            if total <= max_total_bytes:
                break
            if dry_run:
                stats["deleted"] += 1
                stats["freed_bytes"] += size
                stats["kept_within_retention"] -= 1
                total -= size
                if verbose:
                    print("del(超量): %s (%.1f MB)"
                          % (os.path.basename(path), size / 1048576))
                continue
            try:
                os.remove(path)
                stats["deleted"] += 1
                stats["freed_bytes"] += size
                stats["kept_within_retention"] -= 1
                total -= size
                if verbose:
                    print("del(超量): %s (%.1f MB)"
                          % (os.path.basename(path), size / 1048576))
            except OSError:
                pass  # 失败不再计数，留待下次

        stats["total_audio_bytes"] = total
    except Exception as exc:  # 清理是尽力而为，绝不影响分析主流程
        stats["error"] = "%s: %s" % (type(exc).__name__, exc)

    return stats


def _fmt(stats):
    return ("mimo_audio 清理: 扫描 %d / 音频 %d，删除 %d (%.1fMB)，"
            "保留 md %d / 保护期 %d / 期内 %d，音频余 %.1fMB%s"
            % (stats["scanned"], stats["audio_files"], stats["deleted"],
               stats["freed_bytes"] / 1048576, stats["kept_md"],
               stats["kept_protected"], stats["kept_within_retention"],
               stats["total_audio_bytes"] / 1048576,
               " [dry-run]" if stats["dry_run"] else ""))


def main():
    ap = argparse.ArgumentParser(description="mimo_audio 缓存自动清理")
    ap.add_argument("--retention-days", type=int, default=DEFAULT_RETENTION_DAYS)
    ap.add_argument("--max-total-mb", type=int, default=DEFAULT_MAX_TOTAL_MB)
    ap.add_argument("--protect-hours", type=float, default=DEFAULT_PROTECT_HOURS)
    ap.add_argument("--dry-run", action="store_true", help="只统计不删除")
    ap.add_argument("--json", action="store_true", help="输出 JSON 统计")
    ap.add_argument("-v", "--verbose", action="store_true", help="逐文件打印删除")
    args = ap.parse_args()

    stats = sweep(retention_days=args.retention_days,
                  max_total_mb=args.max_total_mb,
                  protect_hours=args.protect_hours,
                  dry_run=args.dry_run, verbose=args.verbose)
    if args.json:
        print(json.dumps(stats, ensure_ascii=False, indent=2))
    else:
        print(_fmt(stats))
        if stats["error"]:
            print("error: %s" % stats["error"], file=sys.stderr)
    return 1 if stats["error"] else 0


if __name__ == "__main__":
    sys.exit(main())
