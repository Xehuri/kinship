"""
name: 前台时长监控
enabled: false
note: 回放当日 perception.jsonl（app 切换 + screen 亮灭边沿 + heartbeat 锁屏断言），按设备×应用
      累计「连续前台且亮屏」时长。同一应用不换、中间短时灭屏只暂停计时；换 App 或熄屏超过
      gap_max 即本次会话结束，下一段另起。超阈值且不在黑名单的应用经 trigger_task 向主会话
      发提醒；同一段会话每再满 cooldown 分钟补发一轮。参数与黑名单见本文件顶部 CONFIG，
      状态文件路径可用环境变量覆盖；默认关闭，启用前按需调整阈值。
prompt: |
  【前台时长提醒】有应用连续使用时长超过阈值，详见正文。
"""

import json
import os
import time
from datetime import datetime

DATA_DIR = os.environ.get("AXEUH_AI_DATA_DIR", "ai/data")
STATE_FILE = os.environ.get(
    "AXEUH_FOREGROUND_STATE",
    os.path.join(DATA_DIR, "tasks", ".foreground_watch_state.json"),
)
DAILY_DIR = os.path.join(DATA_DIR, "daily")

# ── 配置：直接改这里，保存后 FileWatcher 热重启脚本即生效 ──
CONFIG = {
    "threshold_minutes": 60,   # 连续使用时长提醒阈值（分钟）
    "cooldown_minutes": 60,    # 同一段连续使用每再满该时长补发一轮提醒
    "poll_seconds": 60,        # 扫描周期（秒，下限 10）
    "gap_max_seconds": 300,    # 证据空洞上限（秒）：同设备相邻事件间隔超过它＝断档
                               # （服务器掉线/设备离线），进行中段在空洞起点截断，不跨洞续表。
                               # heartbeat 每分钟一条，正常间隔 ≤60s；300s 兜底误判极低
    "blacklist": [             # 黑名单：按应用显示名精确匹配（app 事件的 app 字段值），命中不提醒
        "系统桌面",
        "应用包管理组件",
    ],
}

WATCH_TYPES = ("app", "screen", "heartbeat")


def _hms_to_sec(s):
    """'HH:MM:SS' -> 当日秒数；非法返回 None"""
    if not s or not isinstance(s, str):
        return None
    parts = s.split(":")
    if len(parts) != 3:
        return None
    try:
        h, m, sec = int(parts[0]), int(parts[1]), int(parts[2])
    except ValueError:
        return None
    if not (0 <= h < 24 and 0 <= m < 60 and 0 <= sec < 60):
        return None
    return h * 3600 + m * 60 + sec


def load_config():
    """取脚本内 CONFIG（数值键做下限保护；改配置=改本文件，保存即热重载生效）"""
    cfg = {
        "threshold_minutes": CONFIG.get("threshold_minutes", 60),
        "cooldown_minutes": CONFIG.get("cooldown_minutes", 60),
        "poll_seconds": CONFIG.get("poll_seconds", 60),
        "gap_max_seconds": CONFIG.get("gap_max_seconds", 300),
        "blacklist": list(CONFIG.get("blacklist", [])),
    }
    for k in ("threshold_minutes", "cooldown_minutes"):
        if not isinstance(cfg[k], (int, float)) or cfg[k] <= 0:
            cfg[k] = 60
    if not isinstance(cfg["poll_seconds"], (int, float)) or cfg["poll_seconds"] < 10:
        cfg["poll_seconds"] = 10
    # 空洞上限下限保护：至少 120s（> 心跳周期 ×2），防误配成毫秒级导致逐事件截断
    if not isinstance(cfg["gap_max_seconds"], (int, float)) or cfg["gap_max_seconds"] < 120:
        cfg["gap_max_seconds"] = 300
    return cfg


def load_state():
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            st = json.load(f)
        if isinstance(st, dict):
            return st
    except (OSError, ValueError):
        pass
    return {}


def save_state(state):
    try:
        with open(STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False)
    except OSError:
        pass


def collect_events(date_str):
    """读当日 perception.jsonl 中 app/screen/heartbeat 三类事件，按时间排序。

    回放式全量重算故不做字节水位；重发/乱序行经排序后状态机自洽（时长为相邻证据差，
    重复同名 app 事件与重复 locked 态断言均被状态机吸收，不虚增）。
    """
    path = os.path.join(DAILY_DIR, date_str, "perception.jsonl")
    events = []
    if not os.path.exists(path):
        return events
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except ValueError:
                continue
            tp = e.get("type")
            if tp not in WATCH_TYPES:
                continue
            sec = _hms_to_sec(e.get("t"))
            if sec is None:
                continue
            dev = e.get("device_name") or e.get("_agent_id") or ""
            events.append((sec, tp, dev, e))
    events.sort(key=lambda x: x[0])
    return events


def _session_dur(st, end_sec):
    return st["used"] + ((end_sec - st["seg_start"]) if st["seg_start"] is not None else 0)


def _finalize(st, dev, end_sec, out):
    dur = _session_dur(st, end_sec)
    if st["app"] and st["sess_start"] is not None and dur > 0:
        out.append((dev, st["app"], st["sess_start"], dur, end_sec, False))
    st["used"] = 0
    st["seg_start"] = None
    st["sess_start"] = None


def _start_session(st, sec):
    st["used"] = 0
    st["sess_start"] = sec
    st["seg_start"] = sec if st["screen_on"] else None


def scan(events, now_sec, blacklist, gap_max=300):
    """重放事件流，返回 [(device, app, 会话起点, 连续秒数, 结束时刻, 是否进行中)]。

    定义：连续使用＝同一应用保持前台、中间不换 App 的时长。灭屏只暂停计时（锁屏
    看时间、来电），熄屏超过 gap_max（默认 300s）才算本次使用结束、下段另起会话；
    证据空洞超过 gap_max（服务器掉线/设备离线）同样截断会话。
    """
    bset = set(blacklist)
    per = {}
    out = []
    for sec, kind, dev, e in events:
        st = per.get(dev)
        if st is None:
            st = {"screen_on": True, "app": None, "seg_start": None, "sess_start": None,
                  "used": 0, "prev_sec": sec, "last_ts": sec, "lock_sec": None}
            per[dev] = st
        if sec - st["prev_sec"] > gap_max:
            _finalize(st, dev, st["prev_sec"], out)
            if st["app"] and st["screen_on"]:
                _start_session(st, sec)
        st["prev_sec"] = sec
        st["last_ts"] = max(st["last_ts"], sec)
        if kind == "app":
            name = (e.get("app") or "").strip()
            if not name or st["app"] == name:
                continue
            _finalize(st, dev, sec, out)
            st["app"] = name
            _start_session(st, sec)
        elif kind == "heartbeat":
            name = (e.get("app") or "").strip()
            if name and name != st["app"]:
                _finalize(st, dev, sec, out)
                st["app"] = name
                _start_session(st, sec)
            locked = e.get("locked")
            if locked is True:
                st["screen_on"] = False
                if st["seg_start"] is not None:
                    st["used"] += sec - st["seg_start"]
                    st["seg_start"] = None
                st["lock_sec"] = sec
            elif locked is False:
                st["screen_on"] = True
                st["lock_sec"] = None
                if st["app"] is not None and st["seg_start"] is None:
                    st["seg_start"] = sec
        else:
            locked = e.get("locked")
            if locked is True:
                st["screen_on"] = False
                if st["seg_start"] is not None:
                    st["used"] += sec - st["seg_start"]
                    st["seg_start"] = None
                st["lock_sec"] = sec
            elif locked is False:
                was_locked = st["lock_sec"]
                st["screen_on"] = True
                st["lock_sec"] = None
                if was_locked is not None and sec - was_locked > gap_max:
                    _finalize(st, dev, was_locked, out)
                    if st["app"] is not None:
                        _start_session(st, sec)
                elif st["app"] is not None and st["seg_start"] is None:
                    st["seg_start"] = sec

    for dev, st in per.items():
        end_sec = min(now_sec, st["last_ts"])
        dur = _session_dur(st, end_sec)
        if st["app"] and st["sess_start"] is not None and dur > 0:
            out.append((dev, st["app"], st["sess_start"], dur, end_sec, True))
    return [(d, a, s, x, e2, o) for d, a, s, x, e2, o in out
            if a not in bset and x > 0]


def tick(context, cfg, state):
    """一轮扫描：重放当日数据 -> 连续使用超阈值的会话 -> 发提醒（限速 1 次/分）"""
    date_str = datetime.now().strftime("%Y-%m-%d")
    if state.get("date") != date_str:
        state = {"date": date_str, "alerted": {}}
    # 旧版按「当日累计」记账的 key 只有两段，直接清掉，避免污染新口径
    state["alerted"] = {k: v for k, v in state.get("alerted", {}).items() if k.count("|") == 2}
    now_dt = datetime.now()
    now_sec = now_dt.hour * 3600 + now_dt.minute * 60 + now_dt.second

    events = collect_events(date_str)
    if not events:
        context.log("当日暂无感知事件，跳过")
        return state

    sessions = scan(events, now_sec, cfg["blacklist"], cfg.get("gap_max_seconds", 300))
    threshold = cfg["threshold_minutes"] * 60
    cooldown = max(1, int(cfg["cooldown_minutes"])) * 60
    alerted = state.get("alerted", {})

    candidates = []
    for dev, app, start, dur, end_sec, ongoing in sessions:
        # 已结束的会话只补发近期（跨轮次结束时仍能提醒），避免重算历史刷屏
        if not ongoing and end_sec < now_sec - 900:
            continue
        if dur < threshold:
            continue
        key = "%s|%s|%s" % (dev or "未知设备", app, start)
        bucket = int(dur // cooldown)
        if bucket > alerted.get(key, 0):
            candidates.append((dur, dev, app, bucket, key))
    if candidates:
        candidates.sort(key=lambda x: x[0], reverse=True)
        dur, dev, app, bucket, key = candidates[0]
        dev_label = dev if dev else "未知设备"
        mins = int(dur // 60)
        prompt = (
            f"【前台时长提醒】{dev_label} 的「{app}」已连续使用 {mins} 分钟"
            f"（阈值 {cfg['threshold_minutes']} 分钟；同一段使用每再满 {cfg['cooldown_minutes']} 分钟补发一次）。"
            f"请把这条提醒转告主人，别忘时间。无需执行其他任务。"
        )
        context.trigger_task("前台时长提醒", prompt)
        context.log(f"已触发提醒: {dev_label} / {app} / 连续 {mins}min (档位 {bucket})")
        alerted[key] = bucket
    state["alerted"] = alerted
    return state


def run(context):
    cfg = load_config()
    context.log("前台时长监控启动（阈值 %s 分钟，黑名单 %s）" % (
        cfg["threshold_minutes"], cfg["blacklist"]))
    while True:
        try:
            cfg = load_config()
            state = load_state()
            state = tick(context, cfg, state)
            save_state(state)
        except Exception as e:
            context.log("扫描失败: %s" % e, level="warning")
        # 分段睡眠保心跳：ScriptRunner 要求每 300 秒至少一次
        cfg = load_config()
        deadline = time.time() + cfg["poll_seconds"]
        while time.time() < deadline:
            context.heartbeat()
            remain = deadline - time.time()
            time.sleep(min(15, max(1, remain)))
    # 常驻循环不返回
