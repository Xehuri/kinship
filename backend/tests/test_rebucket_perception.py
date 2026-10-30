# -*- coding: utf-8 -*-
"""
rebucket_perception_misplaced.py 一次性清理工具测试（T2）。

锁定契约（仅 voice 行，按 audio 前缀 daily/{YYYY-MM-DD}/ 判错位）：
  1. dry-run 零写入（字节与 mtime 逐文件不变），只报告移动数/坏行数
  2. --apply 精确移动 fixture 中的 3 条错位的 voice 行（2 条→10-11 既有文件、
     1 条→不存在的 10-10，需建目录+建文件）
  3. 备份先于任何重写：backup 目录下逐字节等于原文件（cp -a 语义）
  4. 坏行 / notify 行 / 正确 voice 行逐字节原位保留（顺序不变）
  5. 非 voice 行前缀错位只报告不移动；voice 行 audio 缺失/不可解析只报告不移动
  6. 守恒：移动前后全树行数相等；移入块按 t 升序稳定追加在既有行之后
  7. 幂等：第二次 --apply 与 --apply 后的 dry-run 均报告 0 移动

脚本导入方式与 test_fact_extractor_voice.py 一致：importlib.util.spec_from_
file_location 直接按路径加载 repo 根 scripts/ 下模块（不走包名）。
"""
import importlib.util
import json
import os
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_SCRIPT_PATH = _REPO_ROOT / "scripts" / "rebucket_perception_misplaced.py"

_spec = importlib.util.spec_from_file_location("_rebucket_mod", _SCRIPT_PATH)
rb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rb)

PERCEPTION = "perception.jsonl"


def _row(**kw) -> bytes:
    """构造一行 jsonl（UTF-8 字节，带换行）。"""
    return (json.dumps(kw, ensure_ascii=False) + "\n").encode("utf-8")


# fixture 行（模块级常量，测试内外共享期望字节）
VOICE_OK = _row(type="voice", t="08:00:00", audio="daily/2026-10-12/audio/ok.wav")
MIS_A = _row(type="voice", t="23:50:10", audio="daily/2026-10-11/audio/a.wav")
NOTIFY = _row(type="notify", t="08:01:00", key="k1")
MIS_B = _row(type="voice", t="23:46:10", audio="daily/2026-10-11/audio/b.wav")
MIS_C = _row(type="voice", t="00:05:00", audio="daily/2026-10-10/audio/c.wav")
NOTIFY_BAD_PREFIX = _row(type="notify", t="08:02:00", audio="daily/2026-10-11/audio/n.wav")
VOICE_UNRESOLVED = _row(type="voice", t="08:03:00", audio="garbage.wav")
MALFORMED = b'{"type": "voice", "audio": daily/2026-10-11/audio/bad.wav\n'
EXIST_11 = _row(type="voice", t="10:00:00", audio="daily/2026-10-11/audio/k.wav")

SRC_LINES = [VOICE_OK, MIS_A, NOTIFY, MIS_B, MIS_C,
             NOTIFY_BAD_PREFIX, VOICE_UNRESOLVED, MALFORMED]


@pytest.fixture()
def data_base(tmp_path: Path) -> Path:
    """构造假 daily 树：10-12（含 3 条错位）+ 10-11（1 条既有）；10-10 目录缺失。

    返回 daily 根（与工具 --data-base / config.DATA_DIR/daily 语义一致），
    备份目录落位其父目录（= DATA_DIR 语义）。
    """
    base = tmp_path / "daily"
    d12 = base / "2026-10-12"
    d11 = base / "2026-10-11"
    d12.mkdir(parents=True)
    d11.mkdir(parents=True)
    (d12 / PERCEPTION).write_bytes(b"".join(SRC_LINES))
    (d11 / PERCEPTION).write_bytes(EXIST_11)
    return base


def _snapshot(base: Path):
    """全树 perception.jsonl 的 {相对路径: (mtime_ns, bytes)}。"""
    out = {}
    for p in sorted(base.rglob(PERCEPTION)):
        out[str(p.relative_to(base))] = (p.stat().st_mtime_ns, p.read_bytes())
    return out


# ── 1. dry-run 零写入 ────────────────────────────────────────

def test_dry_run_touches_nothing(data_base):
    before = _snapshot(data_base)
    rc = rb.run(str(data_base), apply=False)
    assert rc == 0
    assert _snapshot(data_base) == before  # mtime+字节逐文件一致
    # 未建备份目录（dry-run 不写任何东西）
    assert not list(data_base.parent.glob("rebucket-backup-*"))


def test_scan_reports_counts(data_base):
    rep = rb.scan(str(data_base))
    d12 = rep["days"]["2026-10-12"]
    assert d12["malformed"] == 1
    assert d12["voice_unresolved"] == 1
    assert d12["nonvoice_mismatch"] == 1
    assert [m["target"] for m in d12["misplaced"]] == ["2026-10-11", "2026-10-11", "2026-10-10"]
    assert rep["total_moved"] == 3


# ── 2/6. apply 精确移动 + 移入块按 t 升序 ───────────────────

def test_apply_moves_exactly_three(data_base):
    rc = rb.run(str(data_base), apply=True)
    assert rc == 0
    src = (data_base / "2026-10-12" / PERCEPTION).read_bytes()
    assert MIS_A not in src and MIS_B not in src and MIS_C not in src
    tgt = (data_base / "2026-10-11" / PERCEPTION).read_bytes()
    assert tgt == EXIST_11 + MIS_B + MIS_A  # 既有在前；移入按 t 升序（23:46 < 23:50）
    new = data_base / "2026-10-10" / PERCEPTION
    assert new.exists() and new.read_bytes() == MIS_C  # 缺失目标：建目录+建文件


# ── 3. 备份逐字节等于原文件 ──────────────────────────────────

def test_backup_byte_identical(data_base):
    rb.run(str(data_base), apply=True)
    backups = list(data_base.parent.glob("rebucket-backup-*"))
    assert len(backups) == 1
    broot = backups[0]
    assert (broot / "daily" / "2026-10-12" / PERCEPTION).read_bytes() == b"".join(SRC_LINES)
    assert (broot / "daily" / "2026-10-11" / PERCEPTION).read_bytes() == EXIST_11
    # 10-10 原本不存在 → 不应出现在备份里
    assert not (broot / "daily" / "2026-10-10").exists()


# ── 4/5. 原位行逐字节保留、不移动 ───────────────────────────

def test_kept_lines_in_place_byte_identical(data_base):
    rb.run(str(data_base), apply=True)
    src = (data_base / "2026-10-12" / PERCEPTION).read_bytes()
    assert src == VOICE_OK + NOTIFY + NOTIFY_BAD_PREFIX + VOICE_UNRESOLVED + MALFORMED
    # 顺序保持、坏行与 notify 行未被改写


# ── 6. 守恒 ─────────────────────────────────────────────────

def test_conservation_total_lines(data_base):
    p12 = data_base / "2026-10-12" / PERCEPTION
    p11 = data_base / "2026-10-11" / PERCEPTION
    before = len(p12.read_bytes().splitlines()) + len(p11.read_bytes().splitlines())
    rb.run(str(data_base), apply=True)
    after = (len(p12.read_bytes().splitlines())
             + len(p11.read_bytes().splitlines())
             + len((data_base / "2026-10-10" / PERCEPTION).read_bytes().splitlines()))
    assert after == before == 9


# ── 7. 幂等 ─────────────────────────────────────────────────

def test_rerun_apply_moves_zero(data_base):
    assert rb.run(str(data_base), apply=True) == 0
    mid = _snapshot(data_base)
    assert rb.run(str(data_base), apply=True) == 0  # 第二次 apply：0 移动
    after = _snapshot(data_base)
    assert after == mid  # 数据文件不变
    assert len(list(data_base.parent.glob("rebucket-backup-*"))) == 1  # 0 移动不建第二个备份
    rep = rb.scan(str(data_base))
    assert rep["total_moved"] == 0
    assert rb.run(str(data_base), apply=False) == 0  # 之后 dry-run 也报 0
    assert rep["total_malformed"] == 1  # 坏行原位仍在、仍被计数


def test_no_moves_no_backup_dir(data_base):
    # 先清掉错位行 → apply 报 0 移动且不建备份目录
    p12 = data_base / "2026-10-12" / PERCEPTION
    p12.write_bytes(VOICE_OK + NOTIFY + MALFORMED)
    assert rb.run(str(data_base), apply=True) == 0
    assert not list(data_base.parent.glob("rebucket-backup-*"))


# ── 8. 重复守卫（音频 basename 冲突跳过、原位保留） ──────────

DUP_K = _row(type="voice", t="09:00:00", audio="daily/2026-10-11/audio/k.wav")  # 与 EXIST_11 同名
DUP_Z1 = _row(type="voice", t="01:00:00", audio="daily/2026-10-11/audio/z.wav")  # 计划内同名对
DUP_Z2 = _row(type="voice", t="02:00:00", audio="daily/2026-10-11/audio/z.wav")
MIS_11_OUT = _row(type="voice", t="03:00:00", audio="daily/2026-10-09/audio/q.wav")  # 10-11 内将移出的行
SRC_Q = _row(type="voice", t="04:00:00", audio="daily/2026-10-11/audio/q.wav")       # 与上行同名但非重复


def _tree(tmp_path: Path, d12: bytes, d11: bytes) -> Path:
    base = tmp_path / "daily"
    (base / "2026-10-12").mkdir(parents=True)
    (base / "2026-10-11").mkdir(parents=True)
    (base / "2026-10-12" / PERCEPTION).write_bytes(d12)
    (base / "2026-10-11" / PERCEPTION).write_bytes(d11)
    return base


def test_dupe_guard_skips_existing_in_target(tmp_path):
    base = _tree(tmp_path, b"".join([VOICE_OK, MIS_A, DUP_K]), EXIST_11)
    rep = rb.scan(str(base))
    assert rep["total_moved"] == 1
    assert [m["idx"] for m in rep["days"]["2026-10-12"]["misplaced"]] == [1]
    assert rep["days"]["2026-10-12"]["dupe_skipped"] == 1
    assert rep["total_dupe_skipped"] == 1
    rc = rb.run(str(base), apply=True)
    assert rc == 0
    assert (base / "2026-10-12" / PERCEPTION).read_bytes() == VOICE_OK + DUP_K
    assert (base / "2026-10-11" / PERCEPTION).read_bytes() == EXIST_11 + MIS_A


def test_dupe_guard_intra_plan_first_wins(tmp_path):
    base = _tree(tmp_path, DUP_Z1 + DUP_Z2, EXIST_11)
    rep = rb.scan(str(base))
    assert rep["total_moved"] == 1 and rep["total_dupe_skipped"] == 1
    rb.run(str(base), apply=True)
    assert (base / "2026-10-12" / PERCEPTION).read_bytes() == DUP_Z2
    assert (base / "2026-10-11" / PERCEPTION).read_bytes() == EXIST_11 + DUP_Z1


def test_dupe_guard_ignores_rows_leaving_target(tmp_path):
    # MIS_11_OUT 即将从 10-11 移出 → SRC_Q 不算重复（防误判）
    base = _tree(tmp_path, SRC_Q, EXIST_11 + MIS_11_OUT)
    rep = rb.scan(str(base))
    assert rep["total_moved"] == 2
    assert rep["total_dupe_skipped"] == 0
    rc = rb.run(str(base), apply=True)
    assert rc == 0
    assert (base / "2026-10-11" / PERCEPTION).read_bytes() == EXIST_11 + SRC_Q
    assert (base / "2026-10-09" / PERCEPTION).read_bytes() == MIS_11_OUT
