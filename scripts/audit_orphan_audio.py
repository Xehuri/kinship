# -*- coding: utf-8 -*-
"""
停机窗口孤儿音频审计（只读，B2 审查修正项）。

背景：重启/停机瞬间，"已上传 ACK 但仍在内存 stitch 缓冲"的音频尾块与
"文件已落盘、分析在飞"的条目会静默消失（无 ERROR 日志）。本脚本对比
daily/{d}/audio/ 下的实物文件与全部 perception 行引用的音频，产出三分类：
  analyzed —— 行 audio 全路径 == 文件相对路径（daily/{d}/audio/{fn}）
  probable —— 仅 basename 被某行引用（旧 schema 路径写法不同）
  orphan   —— 路径与 basename 均无引用 → 停机吞掉的候选，报数交用户拍板
绝不写任何文件（报告打印到 stdout）。

用法：
    python scripts/audit_orphan_audio.py                       # 全部日期目录
    python scripts/audit_orphan_audio.py --dates 2026-10-11,2026-10-12
    python scripts/audit_orphan_audio.py --data-base X         # 测试/演练
退出码：0 正常；1 数据根错误。
"""
import argparse
import json
import os
import sys

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.normpath(os.path.join(_SCRIPT_DIR, ".."))
_BACKEND_DIR = os.path.join(_PROJECT_ROOT, "backend")
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

PERCEPTION = "perception.jsonl"
AUDIO_EXT = (".wav", ".flac", ".opus", ".mp3")


def _default_data_base() -> str:
    from config.config import get_config
    return os.path.join(get_config().DATA_DIR, "daily")


def collect_references(data_base: str) -> "tuple[set, set]":
    """全树 perception 行的音频引用：返回 (全路径集合, basename 集合)。"""
    full: set = set()
    base: set = set()
    for day in sorted(os.listdir(data_base)):
        path = os.path.join(data_base, day, PERCEPTION)
        if not os.path.isfile(path):
            continue
        with open(path, "rb") as f:
            for raw in f:
                try:
                    row = json.loads(raw.decode("utf-8"))
                except (UnicodeDecodeError, ValueError):
                    continue
                audio = row.get("audio") if isinstance(row, dict) else None
                if isinstance(audio, str) and audio:
                    full.add(audio)
                    base.add(os.path.basename(audio))
    return full, base


def audit_day(data_base: str, day: str, refs_full: set, refs_base: set) -> dict:
    """单日 audio 目录三分类计数（目录不存在返回 None）。"""
    adir = os.path.join(data_base, day, "audio")
    if not os.path.isdir(adir):
        return None
    stats = {"analyzed": 0, "probable": 0, "orphan": 0, "orphan_samples": []}
    for fn in sorted(os.listdir(adir)):
        if not fn.endswith(AUDIO_EXT):
            continue
        if fn.endswith(".analysis.wav"):
            continue  # 内核分析中间转写件，非原件、从不产行，不算孤儿
        rel = f"daily/{day}/audio/{fn}"
        if rel in refs_full:
            stats["analyzed"] += 1
        elif fn in refs_base:
            stats["probable"] += 1
        else:
            stats["orphan"] += 1
            if len(stats["orphan_samples"]) < 20:
                stats["orphan_samples"].append(rel)
    return stats


def run(data_base: str, dates: "list[str] | None") -> int:
    if not os.path.isdir(data_base):
        print(f"错误: 数据根不存在: {data_base}", file=sys.stderr)
        return 1
    refs_full, refs_base = collect_references(data_base)
    days = dates or sorted(
        n for n in os.listdir(data_base)
        if os.path.isdir(os.path.join(data_base, n, "audio")))
    print(f"数据根: {data_base}（行引用 {len(refs_full)} 个全路径）")
    print(f"{'日期':<12} {'analyzed':>8} {'probable':>8} {'orphan':>6}")
    tot = {"analyzed": 0, "probable": 0, "orphan": 0}
    orphans_any = []
    for day in days:
        s = audit_day(data_base, day, refs_full, refs_base)
        if s is None:
            continue
        for k in tot:
            tot[k] += s[k]
        print(f"{day:<12} {s['analyzed']:>8} {s['probable']:>8} {s['orphan']:>6}")
        orphans_any += [(day, s["orphan_samples"], s["orphan"])]
    print(f"合计: analyzed={tot['analyzed']} probable={tot['probable']} orphan={tot['orphan']}")
    for day, samples, n in orphans_any:
        if n:
            print(f"孤儿明细 {day}（最多列 20）:")
            for rel in samples:
                print(f"  {rel}")
    return 0


def main(argv: "list[str] | None" = None) -> int:
    ap = argparse.ArgumentParser(description="停机窗口孤儿音频审计（只读）")
    ap.add_argument("--dates", default=None, help="逗号分隔日期，缺省全部含 audio 目录的日期")
    ap.add_argument("--data-base", default=None, help="daily 数据根覆盖（缺省=config）")
    args = ap.parse_args(argv)
    dates = args.dates.split(",") if args.dates else None
    return run(args.data_base or _default_data_base(), dates)


if __name__ == "__main__":
    sys.exit(main())
