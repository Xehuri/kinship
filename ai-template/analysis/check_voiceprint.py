"""
声纹数据质量检查脚本

统计当天 perception.jsonl 中 voice 事件的 sim 值分布，
输出高置信匹配率、sim中位数等关键指标。
供复盘子智能体和主智能体在复盘前使用。

用法: python analysis/check_voiceprint.py {date}
输出: JSON格式的质量报告
"""
import argparse
import json
import sys
from collections import Counter
from pathlib import Path

# perception.jsonl 解析复用后端唯一 reader：按脚本相对路径把 backend/ 追加到
# sys.path。数据根取本脚本口径 {AI目录}/data，不随后端配置漂移。
_BACKEND_DIR = str(Path(__file__).resolve().parent.parent.parent / "backend")
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)
from services import perception_reader  # noqa: E402

_DATA_ROOT = str(Path(__file__).resolve().parent.parent / "data")


def check_voiceprint(date: str) -> dict:
    """检查指定日期的声纹数据质量"""
    if not perception_reader.has_perception(date, data_root=_DATA_ROOT):
        missing = perception_reader.perception_path(date, data_root=_DATA_ROOT)
        return {"error": f"perception.jsonl 不存在: {missing}"}

    segments = []
    sims = []

    for rec in perception_reader.read_day(date, types=("voice",),
                                          data_root=_DATA_ROOT):
        try:
            # 新格式: 遍历 segs 数组（每个 VAD 段一个对象）
            # 判断依据应为 segs 字段而非顶层 vp 字段（voice 记录顶层无 vp，vp 在 segs[].vp）
            if "segs" in rec:
                for seg in rec.get("segs", []):
                    vp = seg.get("vp", {}) or {}
                    sim = vp.get("sim")
                    speaker = vp.get("spk", "")
                    text = (seg.get("text") or rec.get("text", ""))[:50]
                    if sim is not None:
                        sims.append(sim)
                        segments.append({
                            "t": rec.get("t", ""),
                            "sim": sim,
                            "speaker": speaker,
                            "text": text,
                        })
            else:
                # 旧格式兼容
                for seg in rec.get("segments", []):
                    sim = seg.get("voiceprint_sim", None)
                    speaker = seg.get("voiceprint_speaker", "")
                    if sim is not None:
                        sims.append(sim)
                        segments.append({
                            "t": rec.get("t", ""),
                            "sim": sim,
                            "speaker": speaker,
                            "text": seg.get("text", "")[:50],
                        })
        except (KeyError, TypeError):
            continue

    total = len(sims)
    if total == 0:
        return {
            "date": date,
            "total_segments": 0,
            "warning": "当天无 voice 数据",
            "pass": True,
        }

    high = [s for s in sims if s >= 0.5]
    mid = [s for s in sims if 0.0 <= s < 0.5]
    low = [s for s in sims if s < 0.0]

    high_rate = len(high) / total * 100
    mid_rate = len(mid) / total * 100
    low_rate = len(low) / total * 100
    avg_sim = sum(sims) / total
    sorted_sims = sorted(sims)
    median_sim = sorted_sims[total // 2]

    # 声纹名称统计
    speaker_counter = Counter(s.get("speaker", "") for s in segments)

    # 质量判定
    issues = []
    if high_rate < 5:
        issues.append(f"高置信匹配率仅 {high_rate:.1f}%（阈值5%）- 声纹几乎无法确认用户身份")
    if median_sim < 0.1:
        issues.append(f"sim中位数 {median_sim:.3f} - 一半以上语音段完全不匹配")
    if avg_sim < 0.15:
        issues.append(f"sim均值 {avg_sim:.3f} - 整体匹配度极低")
    if "" in speaker_counter and speaker_counter[""] / total > 0.5:
        issues.append(f"空speaker占比 {speaker_counter['']/total*100:.1f}% - 多数语音未匹配到任何声纹")
    # 检测名称截断问题：存在两个 speaker 名互为后缀（短名是长名结尾）
    nonempty_names = sorted((n for n in speaker_counter if n), key=len)
    for i, short_name in enumerate(nonempty_names):
        for long_name in nonempty_names[i + 1:]:
            if long_name != short_name and long_name.endswith(short_name):
                issues.append(
                    f"声纹名称不一致：'{long_name}'{speaker_counter[long_name]}次 vs "
                    f"'{short_name}'{speaker_counter[short_name]}次 - 可能存在截断bug"
                )

    pass_check = len(issues) == 0

    return {
        "date": date,
        "total_segments": total,
        "sim_stats": {
            "high_count": len(high),
            "high_pct": round(high_rate, 1),
            "mid_count": len(mid),
            "mid_pct": round(mid_rate, 1),
            "low_count": len(low),
            "low_pct": round(low_rate, 1),
            "avg": round(avg_sim, 3),
            "median": round(median_sim, 3),
            "min": round(min(sims), 3),
            "max": round(max(sims), 3),
        },
        "speaker_distribution": dict(speaker_counter.most_common(5)),
        "issues": issues,
        "pass": pass_check,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='声纹数据质量检查')
    parser.add_argument('date', help='日期, 格式: YYYY-MM-DD')
    args = parser.parse_args()

    result = check_voiceprint(args.date)
    print(json.dumps(result, ensure_ascii=False, indent=2))
