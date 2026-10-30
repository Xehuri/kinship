# -*- coding: utf-8 -*-
"""
perception.jsonl 错位 voice 行一次性归位工具（T2，幂等，默认 dry-run）。

范围（只动 voice 行）：daily/{d}/perception.jsonl 中 type=="voice" 且
audio 前缀 re.match(r'^daily/(\\d{4}-\\d{2}-\\d{2})/') 解析出的日期 != d 的行，
移入前缀所指日期文件。其余行一律原位保留：
  - JSON 解析失败的坏行：绝不改写，只计数报告；
  - 非 voice 行即使 audio 前缀错位：只报计数，不移动；
  - voice 行 audio 缺失/不可解析：只报告，不移动；
  - 重复守卫：错桶行音频 basename 已在目标日"将保留行"中、或本计划内
    已有同名先行者 → 跳过移动并计数（防历史重复分析行搬入目标日双重计数）。

读取顺序容忍结论（已调查写死，勿再重复调查）：perception_reader.read_day 与
ai/analysis/fact_extractor.load_perception 均不排序、保持文件行序；预览/移动端
按行序展示，legacy 脚本自行重排。故移入块稳定排序：既有目标行保持在前，
移入行按其 t 字段升序追加（t 缺失/非字符串排最后），最大程度维持展示时序。

--apply 流程：
  1. 先把所有涉及的源文件与已存在的目标文件 cp -a 语义备份到
     DATA_DIR/rebucket-backup-YYYYmmdd-HHMM/（相对路径保留 daily/ 层级）；
  2. 源文件重写 = 快照去掉移出行（保留行逐字节原样、顺序不变，原位删行不排序）；
  3. 移入行追加进目标文件（目录/文件缺失则创建）；
  4. 守恒断言：全树行数前后相等且移出数==移入数，违反则大声中止（退出码 2）；
  5. 打印汇总表。
0 移动时不建备份目录、不碰任何文件 → 幂等（二次运行报 0）。

用法：
    python scripts/rebucket_perception_misplaced.py                # dry-run
    python scripts/rebucket_perception_misplaced.py --apply        # 实际移动
    python scripts/rebucket_perception_misplaced.py --data-base X  # 覆盖数据根（测试用）

退出码：0 正常；1 参数/目录错误；2 守恒校验失败。
"""

import argparse
import json
import os
import re
import shutil
import sys
from datetime import datetime

# 与 backfill_audio.py 相同的 bootstrap 约定：backend 进 sys.path，
# DATA_DIR 经 config 解析（延迟 import，测试注入 --data-base 时完全不碰 config）
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.normpath(os.path.join(_SCRIPT_DIR, ".."))
_BACKEND_DIR = os.path.join(_PROJECT_ROOT, "backend")
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

PERCEPTION = "perception.jsonl"
_DATE_DIR_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_AUDIO_PREFIX_RE = re.compile(r"^daily/(\d{4}-\d{2}-\d{2})/")


def _default_data_base() -> str:
    """生产数据根：与 perception_store._DATA_BASE 同源（config.DATA_DIR/daily）。"""
    from config.config import get_config
    return os.path.join(get_config().DATA_DIR, "daily")


def _read_lines(path: str) -> "list[bytes]":
    """按物理行读入字节（含各自行尾；仅末行可能无 \\n）。"""
    with open(path, "rb") as f:
        return list(f)


def _classify(raw: bytes, day: str) -> "tuple[str, str]":
    """单行分类，返回 (类别, 错位目标日或空串)。

    类别: malformed | keep | nonvoice_mismatch | voice_unresolved | misplaced
    """
    try:
        row = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return ("malformed", "")
    if not isinstance(row, dict):
        return ("keep", "")
    audio = row.get("audio")
    m = _AUDIO_PREFIX_RE.match(audio) if isinstance(audio, str) else None
    if row.get("type") != "voice":
        # 非 voice 行：前缀与所在日不符只计数，绝不移动
        if m is not None and m[1] != day:
            return ("nonvoice_mismatch", "")
        return ("keep", "")
    if m is None:
        return ("voice_unresolved", "")  # audio 缺失/不可解析：报告不移动
    if m[1] == day:
        return ("keep", "")
    return ("misplaced", m[1])


def _sort_key(entry: dict) -> "tuple[int, str, int]":
    """移入块排序键：t 升序；t 缺失/非字符串排最后；seq 保证稳定确定性。"""
    t = entry["t"]
    return (0, t, entry["seq"]) if isinstance(t, str) else (1, "", entry["seq"])


def scan(data_base: str) -> dict:
    """扫描全树，产出移动计划与计数（纯读，不写任何东西）。

    重复守卫：错桶行若其音频 basename 已存在于目标日"将保留的行"中，
    或同日计划内已有同 basename 先行者，则跳过移动、原位保留并计数
    （避免把历史重复分析行搬进目标日造成双重计数）。
    """
    try:
        names = sorted(n for n in os.listdir(data_base)
                       if _DATE_DIR_RE.match(n) and os.path.isdir(os.path.join(data_base, n)))
    except OSError as e:
        print(f"错误: 无法列出 {data_base}: {e}", file=sys.stderr)
        raise
    days: dict = {}
    moves_in: dict = {}
    seq = 0
    dupe_skipped: dict = {}  # (day, target) -> 跳过计数
    # 第一遍：读入全部行；收集各日"将保留的 voice 行"音频 basename
    # （本文件内即将移出的行不计入，避免与将被搬走的行误判重复）
    keep_bns: dict = {}
    for day in names:
        path = os.path.join(data_base, day, PERCEPTION)
        info = {"path": path, "lines": [], "malformed": 0, "voice_unresolved": 0,
                "nonvoice_mismatch": 0, "misplaced": [], "dupe_skipped": 0}
        if os.path.isfile(path):
            info["lines"] = _read_lines(path)
        s: set = set()
        for raw in info["lines"]:
            try:
                row = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                continue
            if not isinstance(row, dict) or row.get("type") != "voice":
                continue
            audio = row.get("audio")
            if not isinstance(audio, str):
                continue
            m = _AUDIO_PREFIX_RE.match(audio)
            if m is not None and m[1] != day:
                continue  # 该行将被移出本文件，不计入保留集合
            s.add(os.path.basename(audio))
        keep_bns[day] = s
        days[day] = info
    # 第二遍：分类错桶行并施加重复守卫
    planned_bns: dict = {}  # target -> 本计划已收 basename 集合（计划内自我去重）
    for day, info in days.items():
        for idx, raw in enumerate(info["lines"]):
            kind, target = _classify(raw, day)
            if kind == "keep":
                continue
            if kind == "misplaced":
                row = json.loads(raw.decode("utf-8"))
                bn = os.path.basename(row.get("audio", ""))
                planned = planned_bns.setdefault(target, set())
                if bn in keep_bns.get(target, set()) or bn in planned:
                    info["dupe_skipped"] += 1
                    dupe_skipped[(day, target)] = dupe_skipped.get((day, target), 0) + 1
                    continue
                planned.add(bn)
                moves_in.setdefault(target, []).append(
                    {"idx": idx, "target": target, "t": row.get("t"), "raw": raw, "seq": seq})
                info["misplaced"].append({"idx": idx, "target": target})
                seq += 1
            else:
                info[kind] += 1
    total_dupe = sum(info["dupe_skipped"] for info in days.values())
    return {"days": days, "moves_in": moves_in, "total_moved": seq,
            "total_dupe_skipped": total_dupe, "dupe_detail": dupe_skipped,
            "total_malformed": sum(d["malformed"] for d in days.values())}


def _print_report(rep: dict, data_base: str) -> None:
    """按日打印：错位移出数与去向 / 坏行 / 非voice错位 / voice不可解析 / 重复跳过。"""
    print(f"数据根: {data_base}")
    print(f"{'日期':<12} {'移出行':>6} {'→目标':<24} {'坏行':>4} {'非voice错位':>10} "
          f"{'voice不可解析':>12} {'重复跳过':>6}")
    for day, d in rep["days"].items():
        cnt: dict = {}
        for m in d["misplaced"]:
            cnt[m["target"]] = cnt.get(m["target"], 0) + 1
        tg = ",".join(f"{k}x{v}" for k, v in sorted(cnt.items())) or "-"
        print(f"{day:<12} {len(d['misplaced']):>6} {tg:<24} {d['malformed']:>4} "
              f"{d['nonvoice_mismatch']:>10} {d['voice_unresolved']:>12} {d['dupe_skipped']:>6}")
    line = (f"合计待移动 voice 行: {rep['total_moved']}；坏行(原位保留): {rep['total_malformed']}")
    if rep["total_dupe_skipped"]:
        detail = ",".join(f"{d}->{t}x{c}" for (d, t), c in sorted(rep["dupe_detail"].items()))
        line += f"；重复跳过(原位保留): {rep['total_dupe_skipped']} ({detail})"
    print(line)


def _norm_nl(raw: bytes) -> bytes:
    """移入行规范化：确保以 \\n 结尾（源末行可能无换行）。"""
    return raw if raw.endswith(b"\n") else raw + b"\n"


def _backup(data_base: str, rep: dict) -> str:
    """备份涉及的源文件（有移出行）与已存在的目标文件（cp -a 单文件语义 copy2）。"""
    root = os.path.dirname(os.path.abspath(data_base))
    broot = os.path.join(root, "rebucket-backup-" + datetime.now().strftime("%Y%m%d-%H%M"))
    n = 0
    while os.path.exists(broot):
        n += 1
        broot = os.path.join(root, f"rebucket-backup-{datetime.now():%Y%m%d-%H%M}-{n}")
    paths = [d["path"] for d in rep["days"].values() if d["misplaced"]]
    paths += [os.path.join(data_base, t, PERCEPTION) for t in rep["moves_in"]]
    copied = 0
    for path in dict.fromkeys(paths):  # 去重且保序（同文件既出又入只备份一次）
        if not os.path.isfile(path):
            continue  # 目标不存在则无需备份（移动时才创建）
        dst = os.path.join(broot, "daily", os.path.relpath(path, data_base))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(path, dst)
        copied += 1
    print(f"备份完成: {broot} ({copied} 个文件)")
    return broot


def _write_atomic(path: str, data: bytes) -> None:
    tmp = path + ".rebucket.tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


def _apply_moves(data_base: str, rep: dict) -> int:
    """执行移动 + 守恒校验。返回退出码（0 正常，2 守恒失败）。"""
    before_total = sum(len(d["lines"]) for d in rep["days"].values())
    _backup(data_base, rep)
    # 1) 重写源文件：保留行逐字节原样、顺序不变
    for day, d in rep["days"].items():
        drop = {m["idx"] for m in d["misplaced"]}
        if drop:
            _write_atomic(d["path"], b"".join(l for i, l in enumerate(d["lines"]) if i not in drop))
    # 2) 追加移入行：既有在前，移入块按 t 升序（目标目录/文件缺失则创建）
    appended = 0
    for target, ents in rep["moves_in"].items():
        tpath = os.path.join(data_base, target, PERCEPTION)
        os.makedirs(os.path.dirname(tpath), exist_ok=True)
        blob = b"".join(_norm_nl(e["raw"]) for e in sorted(ents, key=_sort_key))
        if os.path.isfile(tpath):
            with open(tpath, "rb") as f:
                existing = f.read()
            if existing and not existing.endswith(b"\n"):
                existing += b"\n"  # 目标末行无换行时补分隔，保证追加行独立成行
            _write_atomic(tpath, existing + blob)
        else:
            _write_atomic(tpath, blob)
        appended += len(ents)
    # 3) 守恒断言：全树行数前后相等，且移出数==移入数
    after_total = sum(len(_read_lines(os.path.join(data_base, n, PERCEPTION)))
                      for n in os.listdir(data_base)
                      if _DATE_DIR_RE.match(n) and os.path.isfile(os.path.join(data_base, n, PERCEPTION)))
    if appended != rep["total_moved"] or after_total != before_total:
        print(f"FATAL 守恒破坏: 移出{rep['total_moved']} vs 移入{appended}；"
              f"全树行数 {before_total} vs {after_total}。备份目录含原始文件，请人工核对。",
              file=sys.stderr)
        return 2
    print(f"守恒校验通过: 全树 {before_total} 行不变（移出 {rep['total_moved']} = 移入 {appended}）")
    return 0


def run(data_base: str, apply: bool) -> int:
    """主流程：扫描 → 报告 → （可选）执行。0 移动时不写任何东西。"""
    if not os.path.isdir(data_base):
        print(f"错误: 数据根不存在: {data_base}", file=sys.stderr)
        return 1
    rep = scan(data_base)
    _print_report(rep, data_base)
    if rep["total_moved"] == 0:
        print("无错位的 voice 行需要移动。")
        return 0
    if not apply:
        print("dry-run 模式：未做任何写入。加 --apply 执行移动。")
        return 0
    return _apply_moves(data_base, rep)


def main(argv: "list[str] | None" = None) -> int:
    parser = argparse.ArgumentParser(description="perception.jsonl 错位 voice 行归位（默认 dry-run）")
    parser.add_argument("--apply", action="store_true", help="实际执行移动（先备份，后守恒校验）")
    parser.add_argument("--data-base", default=None,
                        help="daily 数据根覆盖（缺省=config.DATA_DIR/daily；测试/演练用）")
    args = parser.parse_args(argv)
    return run(args.data_base or _default_data_base(), args.apply)


if __name__ == "__main__":
    sys.exit(main())
