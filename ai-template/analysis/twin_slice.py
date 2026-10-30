#!/usr/bin/env python3
"""从当日 `事实-全天.md` 切出指定窗口，供本地孪生轨使用（只读源文件，只写 {AI目录}/data/twin/）。

用法：
    python3 analysis/twin_slice.py 2026-01-01 10:00 12:00
输出：
    data/twin/YYYY-MM-DD/facts-HH.md  （窗口起点的小时；持久目录，重启不丢）
并在 stdout 打印切片文件、行号范围、字节数。
"""
import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SLOT = re.compile(r"^## (\d{2}):(\d{2})~")


def to_sec(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 3600 + int(m) * 60


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="从当日事实文件切出指定时间窗，供本地孪生轨使用。",
        epilog="示例: python analysis/twin_slice.py 2026-01-01 10:00 12:00",
    )
    parser.add_argument("date", help="日期 YYYY-MM-DD")
    parser.add_argument("start", help="窗口起点 HH:MM")
    parser.add_argument("end", help="窗口终点 HH:MM")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    date, start, end = args.date, args.start, args.end
    src = ROOT / "data" / "daily" / date / "事实-全天.md"
    if not src.exists():
        print(f"未找到 {src}")
        return 1
    lines = src.read_text(encoding="utf-8").splitlines()
    lo = to_sec(start)
    hi = to_sec(end)
    begin = last = None
    for i, ln in enumerate(lines):
        m = SLOT.match(ln)
        if not m:
            continue
        slot = int(m.group(1)) * 3600 + int(m.group(2)) * 60
        if lo <= slot < hi:
            if begin is None:
                begin = i
            last = i
    if begin is None:
        print(f"{date} 事实文件里没有 {start}~{end} 的时段")
        return 1
    # 末尾取到下一段头之前（含本段全部行）
    stop = None
    for j in range(last + 1, len(lines)):
        if SLOT.match(lines[j]):
            stop = j
            break
    if stop is None:
        stop = len(lines)
    outdir = ROOT / "data" / "twin" / date
    outdir.mkdir(parents=True, exist_ok=True)
    out = outdir / f"facts-{start[:2]}.md"
    body = [f"# 孪生输入 {date} {start}~{end}（事实-全天.md L{begin+1}~L{stop}）"]
    body += lines[begin:stop]
    out.write_text("\n".join(body) + "\n", encoding="utf-8")
    print(f"切片={out} 行={begin+1}~{stop} 字节={out.stat().st_size}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
