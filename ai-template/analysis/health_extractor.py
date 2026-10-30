"""
health_extractor.py - 为双周深度回顾提取健康视图摘要
用法: python analysis/health_extractor.py <start_date> <end_date>
示例: python analysis/health_extractor.py 2026-01-01 2026-01-14
"""

import argparse
import json
import sys
import os
from datetime import datetime, timedelta

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)
from health_source import read_health_view

# 数据根：脚本同级的 ../data（即 {AI目录}/data），不依赖当前工作目录
_DATA_DIR = os.path.normpath(os.path.join(_SCRIPT_DIR, "..", "data"))


def load_health(date_str):
    """加载指定日期的健康数据（分片合成视图优先，派生文件回落）"""
    view = read_health_view(date_str)
    if view is not None:
        return view
    # 优先新路径 data/daily/，回退旧路径 data/
    path = os.path.join(_DATA_DIR, "daily", date_str, "health.json")
    if not os.path.exists(path):
        path = os.path.join(_DATA_DIR, date_str, "health.json")
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def extract_sleep(health):
    """提取睡眠摘要"""
    sd = health.get("sleep_data", {})
    if not sd:
        return None
    return {
        "duration_min": sd.get("duration_min", 0),
        "deep_min": sd.get("deep_min", 0),
        "light_min": sd.get("light_min", 0),
        "rem_min": sd.get("rem_min", 0),
        "awake_min": sd.get("awake_min", 0),
        "deep_pct": round(sd.get("deep_min", 0) / max(sd.get("duration_min", 1), 1) * 100, 1),
    }


def extract_hr_summary(samples, health=None):
    """提取HR统计摘要

    health 可选：用于样本级 steps 增量全为 0 时回退 daily_summary.total_steps。
    """
    if not samples:
        return None
    # 过滤00:00~06:00(睡眠)和09:00~22:00(清醒)的HR
    sleep_hrs, awake_hrs = [], []
    min_hr, max_hr = 999, 0
    min_hr_time, max_hr_time = "", ""

    for s in samples:
        # 实际派生 schema 样本键为 hr（兼容旧 heart_rate/bpm）
        hr = s.get("hr") or s.get("heart_rate") or s.get("bpm") or 0
        t_iso = s.get("t_iso", s.get("time", ""))

        if not hr or hr < 30 or hr > 250:
            continue

        if min_hr > hr:
            min_hr = hr
            min_hr_time = t_iso
        if max_hr < hr:
            max_hr = hr
            max_hr_time = t_iso

        try:
            h = int(t_iso[11:13]) if len(t_iso) > 13 else 0
        except (ValueError, IndexError):
            continue

        if 0 <= h < 6:
            sleep_hrs.append(hr)
        elif 9 <= h < 22:
            awake_hrs.append(hr)

    if not sleep_hrs and not awake_hrs:
        return None

    def median(lst):
        s = sorted(lst)
        n = len(s)
        return s[n // 2] if n > 0 else 0

    def spo2_stats(samples):
        vals = [s.get("spo2", s.get("SpO2", 0)) for s in samples
                if s.get("spo2", s.get("SpO2", 0)) and 70 < s.get("spo2", s.get("SpO2", 0)) < 100]
        if not vals:
            return None
        return {"min": min(vals), "mean": round(sum(vals) / len(vals), 1)}

    steps_total = sum(s.get("steps", 0) or 0 for s in samples)
    # 样本级 steps 是区间增量、部分日期不带该键：为 0 时回退日汇总 total_steps
    if not steps_total and health:
        steps_total = (health.get("daily_summary") or {}).get("total_steps") or 0

    result = {
        "hr_count": len(samples),
        "hr_range": f"{min_hr}~{max_hr}",
        "hr_min": min_hr,
        "hr_min_time": min_hr_time[:16] if min_hr_time else "",
        "hr_max": max_hr,
        "hr_max_time": max_hr_time[:16] if max_hr_time else "",
        "steps_total": steps_total,
        "sleep_hr_median": median(sleep_hrs) if sleep_hrs else None,
        "awake_hr_median": median(awake_hrs) if awake_hrs else None,
    }

    spo2 = spo2_stats(samples)
    if spo2:
        result["spo2_range"] = f"{spo2['min']}~{spo2['mean']}"

    return result


def extract_hr_peaks(samples):
    """提取HR峰值事件(清醒基线1.25倍以上的样本)"""
    if not samples:
        return []

    # 计算清醒基线（09:00~22:00中位数）
    awake_hrs = []
    for s in samples:
        hr = s.get("hr") or s.get("heart_rate") or s.get("bpm") or 0
        t_iso = s.get("t_iso", s.get("time", ""))
        if not hr or hr < 30:
            continue
        try:
            h = int(t_iso[11:13])
        except (ValueError, IndexError):
            continue
        if 9 <= h < 22:
            awake_hrs.append(hr)

    if not awake_hrs:
        return []

    baseline = sorted(awake_hrs)[len(awake_hrs) // 2]
    threshold = int(baseline * 1.25)

    peaks = []
    for s in samples:
        hr = s.get("hr") or s.get("heart_rate") or s.get("bpm") or 0
        t_iso = s.get("t_iso", s.get("time", ""))
        if hr and hr >= threshold:
            peaks.append({"time": t_iso[:16], "hr": hr, "baseline": baseline})

    return peaks[:10]  # 最多返回前10个峰值


def extract_sensor_anomalies(health):
    """检测传感器异常"""
    anomalies = []
    samples = health.get("samples", [])
    if not samples:
        return anomalies

    # 检测HR恒定不变（连续>1h方差=0）
    hr_segments = []
    current_hr, start, count = None, "", 0
    for s in samples:
        hr = s.get("hr") or s.get("heart_rate") or s.get("bpm") or 0
        t_iso = s.get("t_iso", s.get("time", ""))
        if not hr:
            continue
        if hr != current_hr:
            if count >= 12:  # 1h以上（每5min一个采样）
                anomalies.append({
                    "type": "HR冻结",
                    "time_range": f"{start[:16]}~{t_iso[:16]}",
                    "value": current_hr,
                    "duration_min": count * 5,
                })
            current_hr = hr
            start = t_iso
            count = 1
        else:
            count += 1

    # 检测全天Hr完全缺失
    day_count = len(samples)
    if day_count == 0:
        anomalies.append({"type": "HR全天缺失", "detail": "samples为空"})
    elif day_count < 5:
        anomalies.append({"type": "HR严重不足", "detail": f"全天仅{day_count}条采样"})

    return anomalies


def date_range(start_str, end_str):
    """生成日期范围"""
    start = datetime.strptime(start_str, "%Y-%m-%d")
    end = datetime.strptime(end_str, "%Y-%m-%d")
    dates = []
    d = start
    while d <= end:
        dates.append(d.strftime("%Y-%m-%d"))
        d += timedelta(days=1)
    return dates


def main():
    parser = argparse.ArgumentParser(
        description='为双周深度回顾提取健康视图摘要')
    parser.add_argument('start_date', help='起始日期, 格式: YYYY-MM-DD')
    parser.add_argument('end_date', help='结束日期, 格式: YYYY-MM-DD')
    args = parser.parse_args()

    start_date, end_date = args.start_date, args.end_date
    dates = date_range(start_date, end_date)

    # 1. 睡眠数据总览
    print("\n## 睡眠数据总览\n")
    print(f"| 日期 | 总时长(min) | 深睡(min) | 深睡% | 浅睡(min) | REM(min) | 清醒(min) |")
    print("|------|-----------|----------|-------|----------|---------|----------|")
    for d in dates:
        h = load_health(d)
        sl = extract_sleep(h) if h else None
        if sl:
            print(f"| {d} | {sl['duration_min']} | {sl['deep_min']} | {sl['deep_pct']}% | {sl['light_min']} | {sl['rem_min']} | {sl['awake_min']} |")
        else:
            print(f"| {d} | - | - | - | - | - | 无数据 |")

    # 2. HR统计总览
    print("\n## HR统计总览\n")
    print(f"| 日期 | 采样数 | HR范围 | 睡眠中位HR | 清醒中位HR | 步数 | SpO2 |")
    print("|------|-------|--------|-----------|-----------|------|------|")
    for d in dates:
        h = load_health(d)
        if not h or not h.get("samples"):
            print(f"| {d} | 0 | - | - | - | - | 无数据 |")
            continue
        s = extract_hr_summary(h.get("samples", []), h)
        if s:
            spo2 = s.get("spo2_range", "-")
            print(f"| {d} | {s['hr_count']} | {s['hr_range']} | {s['sleep_hr_median'] or '-'} | {s['awake_hr_median'] or '-'} | {s['steps_total']} | {spo2} |")
        else:
            print(f"| {d} | 0 | - | - | - | - | - |")

    # 4. HR峰值事件
    print("\n## HR峰值事件（倍数>清醒基线x1.25）\n")
    for d in dates:
        h = load_health(d)
        if not h or not h.get("samples"):
            continue
        peaks = extract_hr_peaks(h.get("samples", []))
        if peaks:
            print(f"**{d}** (基线={peaks[0]['baseline']})：")
            for p in peaks:
                print(f"  - {p['time']} HR={p['hr']}")
            print()

    # 5. 传感器异常
    print("\n## 传感器异常\n")
    for d in dates:
        h = load_health(d)
        if not h:
            print(f"**{d}**: 健康视图不存在")
            continue
        anoms = extract_sensor_anomalies(h)
        if anoms:
            for a in anoms:
                print(f"**{d}** [{a['type']}]: {a.get('time_range', a.get('detail', ''))} (值={a.get('value', '')})")
        elif not h.get("samples"):
            print(f"**{d}**: samples字段为空")


if __name__ == "__main__":
    main()
