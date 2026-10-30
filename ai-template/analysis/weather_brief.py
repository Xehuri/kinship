#!/usr/bin/env python3
"""天气简报（每日 07:00 定时任务用）。

取{天气地点}当日天气，输出 2~3 句口语 + 落盘留证。
数据源：open-meteo（免 key）。失败直接报错码，不编造。
位置通过环境变量配置：WEATHER_PLACE（地点名）、WEATHER_LAT / WEATHER_LON（坐标）。

用法:
    weather_brief.py                # 打印简报
    weather_brief.py --date 2026-10-20
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from datetime import date as _date

PLACE = os.environ.get("WEATHER_PLACE", "{天气地点}")
LAT = float(os.environ["WEATHER_LAT"]) if os.environ.get("WEATHER_LAT") else None
LON = float(os.environ["WEATHER_LON"]) if os.environ.get("WEATHER_LON") else None
TZ = "Asia/Shanghai"

CODES = {
    0: "晴", 1: "晴间多云", 2: "多云", 3: "阴",
    45: "有雾", 48: "雾凇",
    51: "小毛雨", 53: "毛雨", 55: "密毛雨",
    56: "冻毛雨", 57: "强冻毛雨",
    61: "小雨", 63: "中雨", 65: "大雨",
    66: "冻雨", 67: "强冻雨",
    71: "小雪", 73: "中雪", 75: "大雪", 77: "米雪",
    80: "阵雨", 81: "强阵雨", 82: "暴雨",
    85: "阵雪", 86: "强阵雪",
    95: "雷阵雨", 96: "雷阵雨伴冰雹", 99: "强雷暴伴冰雹",
}

URL = (
    "https://api.open-meteo.com/v1/forecast"
    "?daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,"
    "weather_code,wind_speed_10m_max,sunrise,sunset"
    "&hourly=temperature_2m,apparent_temperature,precipitation_probability,wind_speed_10m"
    f"&timezone={TZ}&forecast_days=1"
)


def fetch() -> dict:
    url = URL + f"&latitude={LAT}&longitude={LON}"
    req = urllib.request.Request(url, headers={"User-Agent": "weather-brief/1.0"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode("utf-8"))


def brief(d: dict) -> str:
    daily = d["daily"]
    tmax = daily["temperature_2m_max"][0]
    tmin = daily["temperature_2m_min"][0]
    code = int(daily["weather_code"][0])
    rain = daily["precipitation_probability_max"][0]
    wind = daily["wind_speed_10m_max"][0]
    desc = CODES.get(code, f"天气码{code}")

    parts = [f"今天{PLACE}{desc}，{tmin:.0f}~{tmax:.0f}℃。"]
    if rain is not None and rain >= 30:
        parts.append(f"降水概率 {rain:.0f}%。")
    else:
        parts.append("基本不下雨。")
    if wind is not None and wind >= 30:
        parts.append(f"风偏大，最大 {wind:.0f} km/h，出门注意。")
    elif wind is not None and wind >= 20:
        parts.append(f"有点风，最大 {wind:.0f} km/h。")

    # 当天最高温 / 最低温出现时段，方便抓"早晚冷"
    hourly = d.get("hourly", {})
    ts, temps = hourly.get("time", []), hourly.get("temperature_2m", [])
    if ts:
        days = [t for t in ts if t.startswith(daily["time"][0])]
        if days:
            idx = [ts.index(t) for t in days]
            imax = max(idx, key=lambda i: temps[i])
            imin = min(idx, key=lambda i: temps[i])
            parts.append(f"最热在 {ts[imax][11:16]}，最冷在 {ts[imin][11:16]}。")
            # 体感：湿度+风会让"11~20℃"体感明显更冷（体感温度低于气温）
            feels = hourly.get("apparent_temperature", [])
            wnd = hourly.get("wind_speed_10m", [])
            if feels:
                fmin = min(idx, key=lambda i: (feels[i] if i < len(feels) and feels[i] is not None else 99))
                if fmin < len(feels) and feels[fmin] is not None:
                    w = wnd[fmin] if fmin < len(wnd) and wnd[fmin] is not None else None
                    ws = f"，风 {w:.0f} km/h" if w else ""
                    parts.append(f"最冷时体感约 {feels[fmin]:.0f}℃{ws}。")

    # 雨窗：按小时概率/降水量找连续降雨段，方便回答"啥时候下、啥时候停"
    hourly = d.get("hourly", {})
    ts, probs = hourly.get("time", []), hourly.get("precipitation_probability", [])
    mm = hourly.get("precipitation", [])
    if ts and probs:
        wet = [
            (t[11:16], p, (mm[i] if i < len(mm) else 0))
            for i, (t, p) in enumerate(zip(ts, probs))
            if (p is not None and p >= 50) or (i < len(mm) and mm[i] and mm[i] >= 0.5)
        ]
        if wet:
            runs, cur = [], [wet[0]]
            for item in wet[1:]:
                if int(item[0][:2]) - int(cur[-1][0][:2]) == 1:
                    cur.append(item)
                else:
                    runs.append(cur)
                    cur = [item]
            runs.append(cur)
            seg = "、".join((r[0][0] if len(r) == 1 else f"{r[0][0]}~{r[-1][0]}") for r in runs)
            parts.append(f"雨主要在 {seg}。")
        else:
            parts.append("全天基本没有成段的雨。")
    return "".join(parts)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=str(_date.today()))
    ap.add_argument("--out-dir", default=None, help="留证目录，默认不写")
    args = ap.parse_args()

    if LAT is None or LON is None:
        print(
            "[天气配置缺失] 请设置环境变量 WEATHER_LAT / WEATHER_LON（可选 WEATHER_PLACE）",
            file=sys.stderr,
        )
        return 2

    try:
        d = fetch()
    except Exception as e:  # noqa: BLE001
        print(f"[天气获取失败] {type(e).__name__}: {e}", file=sys.stderr)
        return 2

    text = brief(d)
    if args.out_dir:
        from pathlib import Path

        p = Path(args.out_dir)
        p.mkdir(parents=True, exist_ok=True)
        f = p / f"天气-{args.date}.md"
        f.write_text(
            f"# 天气（{PLACE}）{args.date}\n\n"
            f"> 来源 open-meteo，lat {LAT} lon {LON}，拉取时间 {_date.today()}（脚本运行时刻）\n\n"
            f"{text}\n\n```json\n{json.dumps(d['daily'], ensure_ascii=False, indent=2)}\n```\n",
            encoding="utf-8",
        )
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
