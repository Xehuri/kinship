"""
name: 唤醒监控（长时间息屏后首解）
enabled: false
note: 默认关，可选任务骨架。全天盯手机状态——长时间息屏后第一次"真解锁"，就唤醒主会话一次。
      早晨（04:00~09:30）唤醒附带天气；其他时段只做"有事才说"的准备，不主动发消息。
      节流：一次唤醒后静默 3 小时；每天最多 6 次；同一解锁窗口只算一次。
prompt: |
  【唤醒】用户刚刚把手机从长时间息屏里解锁了。
"""

import json
import os
import time
from datetime import datetime

# AI 根目录＝本文件向上三级（ai/data/tasks/x.py → ai/）
AI_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TASK_DIR = os.path.join(AI_ROOT, "data", "tasks")
STATE_FILE = os.path.join(TASK_DIR, ".wake_watch_state.json")
DAILY_DIR = os.path.join(AI_ROOT, "data", "daily")

CONFIG = {
    "poll_seconds": 45,
    "confirm_minutes": 5,
    "confirm_beats": 3,
    "min_apps": 2,
    "idle_night_minutes": 180,
    "idle_day_minutes": 120,
    "morning_from": "04:00",
    "morning_to": "09:30",
    "mute_minutes": 180,
    "max_per_day": 6,
    "quiet_hours": ("23:30", "05:00"),
}


def _now():
    return datetime.now()


def _today():
    return _now().strftime("%Y-%m-%d")


def _minutes(hhmm):
    try:
        h, m = str(hhmm)[:5].split(":")
        return int(h) * 60 + int(m)
    except Exception:
        return None


def _load_state():
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_state(state):
    os.makedirs(TASK_DIR, exist_ok=True)
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False)
    os.replace(tmp, STATE_FILE)


def _beats(date):
    path = os.path.join(DAILY_DIR, date, "perception.jsonl")
    if not os.path.exists(path):
        return []
    out = []
    try:
        with open(path, encoding="utf-8", errors="ignore") as f:
            for line in f:
                if '"heartbeat"' not in line:
                    continue
                try:
                    ev = json.loads(line)
                except Exception:
                    continue
                out.append((str(ev.get("t", ""))[:5], ev.get("locked"), ev.get("app")))
    except Exception:
        return []
    return out


def _candidate(date):
    """返回 (时刻, 息屏分钟数)：最近一次"长时间息屏后真解锁"，没有则 None。"""
    beats = _beats(date)
    if not beats:
        return None
    last_unlocked = None
    best = None
    for i, (t, locked, _app) in enumerate(beats):
        m = _minutes(t)
        if m is None or locked is True:
            continue
        if last_unlocked is not None:
            gap = m - last_unlocked
            threshold = (
                CONFIG["idle_night_minutes"]
                if _minutes(CONFIG["morning_from"]) <= m <= _minutes(CONFIG["morning_to"])
                else CONFIG["idle_day_minutes"]
            )
            if gap >= threshold:
                seg = [
                    (tt, app)
                    for tt, lk, app in beats[i:]
                    if _minutes(tt) is not None
                    and 0 <= _minutes(tt) - m <= CONFIG["confirm_minutes"]
                    and lk is False
                ]
                if len(seg) >= CONFIG["confirm_beats"] and len({a for _t, a in seg}) >= CONFIG["min_apps"]:
                    best = (t, gap)
        last_unlocked = m
    return best


def _in_quiet(hhmm):
    a, b = CONFIG["quiet_hours"]
    m, ma, mb = _minutes(hhmm), _minutes(a), _minutes(b)
    if None in (m, ma, mb):
        return False
    return m >= ma or m < mb


def run(context):
    context.log("唤醒监控启动（长息屏→首解；静默 %dmin／上限 %d次/天）" % (CONFIG["mute_minutes"], CONFIG["max_per_day"]))
    while True:
        try:
            context.heartbeat()
            date = _today()
            now = _now()
            hm = now.strftime("%H:%M")
            state = _load_state()
            if state.get("date") != date:
                state = {"date": date, "count": 0, "last_at": None, "handled": []}

            if _in_quiet(hm) or state.get("count", 0) >= CONFIG["max_per_day"]:
                time.sleep(CONFIG["poll_seconds"])
                continue

            if state.get("last_at"):
                last = datetime.strptime(state["last_at"], "%Y-%m-%d %H:%M:%S")
                if (now - last).total_seconds() < CONFIG["mute_minutes"] * 60:
                    time.sleep(CONFIG["poll_seconds"])
                    continue

            cand = _candidate(date)
            if not cand or cand[0] in state.get("handled", []):
                time.sleep(CONFIG["poll_seconds"])
                continue

            t, gap = cand
            morning = _minutes(CONFIG["morning_from"]) <= _minutes(t) <= _minutes(CONFIG["morning_to"])
            if morning:
                msg = (
                    f"【唤醒】{t} 解锁手机（此前息屏约 {gap // 60}h{gap % 60}m，像刚醒）。"
                    "跑 {Python解释器路径} {AI目录}/analysis/weather_brief.py --out-dir {AI目录}/data/daily/" + date + "，"
                    "把 stdout 原文通过 ai-mcp_send_notification 发给用户，不改写不加清单；脚本失败就回一句没取到。"
                )
            else:
                msg = (
                    f"【唤醒】{t} 解锁手机，此前息屏约 {gap // 60}h{gap % 60}m。"
                    "**不要主动发消息**，只是把状态准备好：用户随后说话就正常接；不说话就什么都不做。"
                )

            state["count"] = state.get("count", 0) + 1
            state["last_at"] = now.strftime("%Y-%m-%d %H:%M:%S")
            state.setdefault("handled", []).append(t)
            _save_state(state)
            context.trigger_task("唤醒监控", msg)
            context.log(f"唤醒：{t}，息屏 {gap}min，早晨={morning}")
        except Exception as e:  # noqa: BLE001
            try:
                context.log("唤醒监控异常：" + repr(e))
            except Exception:
                pass
        time.sleep(CONFIG["poll_seconds"])
