# -*- coding: utf-8 -*-
"""
健康数据一次性迁移脚本（H4）。

把 109 天 legacy 单文件 ai/data/daily/{date}/health.json 迁移到
分片 users/{primary_user}/health/{date}/phone.json，并由
HealthStore.export_legacy 重新生成派生兼容视图（单一写者）。

架构依据：health-data-source-architecture.md 第 5.6 节（迁移步骤）、
第 14 节（迁移与回滚：预期差异仅限 device_name / total_steps 补齐）。

三种模式（互斥）：
  --dry-run   副本演练：把 daily/ 复制到临时目录迁移，比对差异，不写真实数据
  --diff      仅比对：对已有分片与 legacy 派生视图做逐日 diff（需先 --apply 或在副本上跑）
  --apply     正式迁移：直接在 data_root 上写分片并重生成派生视图

主用户从 config.yaml 的 health.primary_user 读取，可用 --user 覆盖。

迁移本身复用 HealthStore 的懒引导（_bootstrap_from_legacy_locked）：
对每个 (user_id, date) 调 export_legacy 即可——若分片不存在而 legacy 有样本，
会先一次性把 legacy 拆解种子进 phone 分片，再合并导出派生视图。
"""
import argparse
import json
import os
import shutil
import sys
import tempfile

# 脚本在 backend/scripts/ 下，backend 为工作根，services 包在其中
_BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)

from services.health.store import HealthStore, _legacy_stage_to_enum  # noqa: E402


# ── stage 规范化 ─────────────────────────────────────
# 历史 legacy 数据的 stage 是字符串枚举（'light'），export_legacy 会映射回
# Android 数字编码（3）。两者经 _legacy_stage_to_enum 都归一到同一枚举，
# 语义等价，diff 时按规范化后比较，不计为数据差异。

def normalize_stage(raw):
    """字符串枚举 / 数字编码 -> canonical 枚举（与 store 同口径）。"""
    return _legacy_stage_to_enum(raw)


def _norm_stages(stages):
    """把 legacy 形状 stages [{t, stage}] 规范化为可比较的 [(t, 枚举)]。"""
    out = []
    for st in stages or []:
        if not isinstance(st, dict):
            continue
        out.append((st.get("t"), normalize_stage(st.get("stage"))))
    return out


# ── 日期发现 ─────────────────────────────────────────

def find_legacy_days(data_root):
    """返回 data_root 下存在 daily/{date}/health.json 的日期列表（升序）。"""
    daily = os.path.join(data_root, "daily")
    if not os.path.isdir(daily):
        return []
    dates = []
    for name in sorted(os.listdir(daily)):
        if len(name) == 10 and name[4] == "-" and name[7] == "-":
            if os.path.isfile(os.path.join(daily, name, "health.json")):
                dates.append(name)
    return dates


# ── diff：迁移前后派生视图比对 ───────────────────────

def _flatten(obj, prefix=""):
    """把嵌套 dict 摊平为 {点路径: 值}（list 保留整体）。"""
    flat = {}
    if isinstance(obj, dict):
        for k, v in obj.items():
            key = f"{prefix}.{k}" if prefix else str(k)
            flat.update(_flatten(v, key))
    else:
        flat[prefix] = obj
    return flat


def diff_views(orig_path, new_path):
    """比对两个 legacy health.json，返回 {语义字段名: {orig, new}}。

    只报告**数据内容**差异，忽略：
      - updated_at（每次导出都会刷新的时间戳）
      - sleep stages 的字符串/数字表示（规范化后等价）

    键名口径（对齐架构第 14 节的预期差异）：
      - device_name    键存在性或值变化
      - total_steps    daily_summary.total_steps 变化（派生视图补齐）
      - 其余字段用摊平路径（如 samples / sleep_data.duration_min），
        任何预期外路径出现即为非预期差异
    """
    with open(orig_path, encoding="utf-8") as f:
        orig = json.load(f)
    with open(new_path, encoding="utf-8") as f:
        new = json.load(f)

    diffs = {}
    a = _flatten(orig)
    b = _flatten(new)

    for key in sorted(set(a) | set(b)):
        if key == "updated_at":
            continue
        if key.startswith("sleep_data.stages"):
            continue

        in_a, in_b = key in a, key in b

        # device_name：缺键 vs 显式 null 也算差异（架构第 14 节预期项）
        if key == "device_name":
            if in_a != in_b or a.get(key) != b.get(key):
                diffs["device_name"] = {"orig": a.get(key), "new": b.get(key)}
            continue

        # total_steps：用语义名（架构第 14 节预期项）
        if key == "daily_summary.total_steps":
            if in_a != in_b or a.get(key) != b.get(key):
                diffs["total_steps"] = {"orig": a.get(key), "new": b.get(key)}
            continue

        if in_a != in_b:
            diffs[key] = {"orig": a.get(key), "new": b.get(key)}
        elif in_a and a[key] != b[key]:
            diffs[key] = {"orig": a[key], "new": b[key]}

    # stages 单独规范化比对（字符串/数字等价）
    oa = _norm_stages((orig.get("sleep_data") or {}).get("stages"))
    ob = _norm_stages((new.get("sleep_data") or {}).get("stages"))
    if oa != ob:
        diffs["sleep_data.stages"] = {"orig": oa, "new": ob}

    return diffs


# ── 迁移核心 ─────────────────────────────────────────

def migrate_all(data_root, user_id):
    """在 data_root 上执行迁移：逐日 export_legacy（懒引导种子 + 重生成派生视图）。

    幂等：分片已存在时懒引导跳过，export 只是重算派生视图（数据不变）。
    """
    dates = find_legacy_days(data_root)
    store = HealthStore(data_root=data_root, primary_user=user_id)
    for date in dates:
        store.export_legacy(user_id, date)
    return {"mode": "apply", "dates": dates, "count": len(dates)}


def dry_run(data_root, user_id, keep_copy=False):
    """副本演练：复制 daily/ 到临时目录迁移，比对差异，不触碰真实数据。

    返回 {"mode", "dates", "count", "diffs": {date: {字段: {orig,new}}}}。
    """
    dates = find_legacy_days(data_root)
    if not dates:
        return {"mode": "dry-run", "dates": [], "count": 0, "diffs": {}}

    tmp = tempfile.mkdtemp(prefix="health_migrate_dryrun_")
    try:
        # 只暂存 health.json（daily/ 含 80GB+ 音频，全量 copytree 会拖垮演练；
        # 迁移只读写 health.json，其余文件无需进入临时副本）
        for date in dates:
            src = os.path.join(data_root, "daily", date, "health.json")
            dst_dir = os.path.join(tmp, "daily", date)
            os.makedirs(dst_dir, exist_ok=True)
            shutil.copy2(src, os.path.join(dst_dir, "health.json"))

        store = HealthStore(data_root=tmp, primary_user=user_id)
        for date in dates:
            store.export_legacy(user_id, date)

        diffs = {}
        for date in dates:
            orig_path = os.path.join(data_root, "daily", date, "health.json")
            new_path = os.path.join(tmp, "daily", date, "health.json")
            diffs[date] = diff_views(orig_path, new_path)

        report = {"mode": "dry-run", "dates": dates, "count": len(dates), "diffs": diffs}
        if keep_copy:
            report["tmp_dir"] = tmp  # 供调用方检查/清理（测试用）
            return report
        return report
    finally:
        if not keep_copy:
            shutil.rmtree(tmp, ignore_errors=True)


def diff_existing(data_root, user_id):
    """对已迁移的数据做逐日 diff（分片已存在时直接比对派生视图 vs 持久化前快照不可得，
    故这里比对『当前派生视图』与『分片重新导出的预期』—— 实际用法：配合备份目录比对）。

    简化：直接返回每个日期的分片存在性 + 派生视图可读性检查。
    """
    dates = find_legacy_days(data_root)
    report = {}
    store = HealthStore(data_root=data_root, primary_user=user_id)
    for date in dates:
        shard = os.path.join(data_root, "users", user_id, "health", date, "phone.json")
        view = os.path.join(data_root, "daily", date, "health.json")
        report[date] = {
            "shard_exists": os.path.isfile(shard),
            "view_exists": os.path.isfile(view),
        }
    return {"mode": "diff", "dates": dates, "count": len(dates), "report": report}


# ── CLI ──────────────────────────────────────────────

def _resolve_user(override):
    if override:
        return override
    try:
        from config.config import get_config
        val = get_config().HEALTH_PRIMARY_USER
        if val:
            return val
    except Exception:
        pass
    raise SystemExit(
        "未指定主用户：请传 --user <id>，或在 config.yaml 配置 health.primary_user"
    )


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="迁移 legacy health.json 到 users/{user}/health/{date}/phone.json 分片"
    )
    parser.add_argument("--data-root", required=True, help="数据根目录（含 daily/）")
    parser.add_argument("--user", default=None, help="主用户（默认读 config health.primary_user）")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true", help="副本演练，不写真实数据")
    mode.add_argument("--diff", action="store_true", help="比对分片与派生视图存在性")
    mode.add_argument("--apply", action="store_true", help="正式迁移")
    args = parser.parse_args(argv)

    user = _resolve_user(args.user)

    if args.dry_run:
        result = dry_run(args.data_root, user)
        print(f"[dry-run] 待迁移 {result['count']} 天 -> {result['dates']}")
        any_diff = False
        for date, d in sorted(result["diffs"].items()):
            if d:
                any_diff = True
                print(f"  {date}:")
                for k, v in sorted(d.items()):
                    print(f"    {k}: {v['orig']!r} -> {v['new']!r}")
        if not any_diff:
            print("  无差异（所有派生视图迁移前后一致）")
    elif args.diff:
        result = diff_existing(args.data_root, user)
        print(f"[diff] 检查 {result['count']} 天")
        for date, r in sorted(result["report"].items()):
            status = "OK" if (r["shard_exists"] and r["view_exists"]) else "MISSING"
            print(f"  {date}: shard={'Y' if r['shard_exists'] else 'N'} "
                  f"view={'Y' if r['view_exists'] else 'N'} [{status}]")
    else:
        result = migrate_all(args.data_root, user)
        print(f"[apply] 已迁移 {result['count']} 天 -> {result['dates']}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
