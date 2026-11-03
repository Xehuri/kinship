"""
name: 健康数据同步回调
enabled: false
note: 默认关，可选任务骨架。轮询 cloud.json，末样本前移 ≥5 分钟就记一行；
      若补上的是 ≥60 分钟的空档，才触发一次会话通知。
prompt: |
  【健康同步】用户手动同步了健康数据，空档补上了。
"""

import json
import os
import time
from datetime import datetime

AI_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TASK_DIR = os.path.join(AI_ROOT, "data", "tasks")
STATE = os.path.join(TASK_DIR, ".health_sync_state.json")
USER_SEGMENT = "{用户}"  # 部署时替换为实际用户目录名
HEALTH_DIR = os.path.join(AI_ROOT, "data", "users", USER_SEGMENT, "health")
DAILY_DIR = os.path.join(AI_ROOT, "data", "daily")

POLL = 300          # 5 分钟
MIN_ADVANCE = 300   # 末样本至少前移 5 分钟才算"有新数据"
GAP_ALERT = 3600    # 补上空档 ≥60 分钟才触发会话


def _load():
    try:
        return json.load(open(STATE, encoding="utf-8"))
    except Exception:
        return {}


def _save(d):
    tmp = STATE + ".tmp"
    json.dump(d, open(tmp, "w", encoding="utf-8"), ensure_ascii=False)
    os.replace(tmp, STATE)


def _hm(t):
    return datetime.fromtimestamp(t).strftime("%H:%M")


def _read(path):
    try:
        d = json.load(open(path, encoding="utf-8"))
        s = d.get("samples") or []
        return (s[-1]["t"] if s else None), d.get("fetched_at"), len(s)
    except Exception:
        return None, None, 0


def _wait_with_heartbeat(context, seconds):
    """分块等待：每块最多 60 秒，块间补心跳，总节奏不变。"""
    deadline = time.time() + seconds
    while time.time() < deadline:
        context.heartbeat()
        time.sleep(max(0.0, min(60.0, deadline - time.time())))


def run(context):
    context.log("健康同步回调启动（poll %ds，空档≥%dmin 才通知）" % (POLL, GAP_ALERT // 60))
    while True:
        try:
            context.heartbeat()
            today = datetime.now().strftime("%Y-%m-%d")
            path = os.path.join(HEALTH_DIR, today, "cloud.json")
            last_t, fetched, n = _read(path)
            if last_t:
                st = _load()
                key = "last_t"
                prev = st.get(key)
                prev_date = st.get("date")
                if prev is None or prev_date != today:
                    _save({"date": today, key: last_t, "prev": prev})
                elif last_t - prev >= MIN_ADVANCE:
                    gap = last_t - prev
                    line = f"- {_hm(last_t)} 末样本前移 {gap // 60}min（样本 {n}，fetched {_hm(fetched) if fetched else '-'}）\n"
                    day_dir = os.path.join(DAILY_DIR, today)
                    os.makedirs(day_dir, exist_ok=True)
                    with open(os.path.join(day_dir, "健康-同步事件.md"), "a", encoding="utf-8") as f:
                        f.write(line)
                    context.log(line.strip())
                    if gap >= GAP_ALERT:
                        context.trigger_task(
                            "健康同步",
                            f"【健康同步】用户的健康数据补上了：末样本从 {_hm(prev)} 推到 {_hm(last_t)}，"
                            f"空档 {gap // 60} 分钟。**不要主动发通知、不要上提醒板**，只在心里更新：这段不是断供，是未同步。"
                        )
                    st = _load()
                    st.update({"date": today, key: last_t, "prev": prev})
                    _save(st)
        except Exception as e:  # noqa: BLE001
            try:
                context.log(f"健康同步回调异常：{e!r}")
            except Exception:
                pass
        _wait_with_heartbeat(context, POLL)
