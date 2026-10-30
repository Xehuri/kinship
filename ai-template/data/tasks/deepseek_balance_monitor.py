"""
name: DeepSeek余额告警器
enabled: false
note: 默认关。每 30 分钟查一次 DeepSeek 余额，低于阈值发 App 通知；余额每累计消耗一定金额写入一条 perception 数据。阈值、密钥路径与状态路径可用环境变量覆盖，API key 默认读同目录 deepseek_key.txt（gitignored）。
"""

import os
import json
import time
import requests
from datetime import datetime

DATA_DIR = os.environ.get("AXEUH_AI_DATA_DIR", "ai/data")
KEY_FILE = os.environ.get(
    "DEEPSEEK_KEY_FILE",
    os.path.join(DATA_DIR, "tasks", "deepseek_key.txt"),
)
AUTH_FILE = "backend/config/auth.json"
STATE_FILE = os.environ.get(
    "DEEPSEEK_BALANCE_STATE",
    os.path.join(DATA_DIR, "tasks", ".balance_state.json"),
)
CHECK_INTERVAL = int(os.environ.get("DEEPSEEK_CHECK_INTERVAL", 30 * 60))
HEARTBEAT_INTERVAL = 60  # 分段睡眠时的心跳间隔，必须小于 ScriptRunner 300 秒超时阈值


def _env_float(name, default):
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return float(default)


ALERT_THRESHOLD = _env_float("DEEPSEEK_ALERT_THRESHOLD", 5.0)
RECORD_STEP = _env_float("DEEPSEEK_RECORD_STEP", 5.0)
ALERT_STEP = _env_float("DEEPSEEK_ALERT_STEP", 2.0)          # 低位时每再降该金额补一次告警
ALERT_REPEAT_HOURS = _env_float("DEEPSEEK_ALERT_REPEAT_HOURS", 12)  # 且至少间隔该小时数
NOTIFY_ENABLED = os.environ.get("DEEPSEEK_NOTIFY_ENABLED", "1").lower() not in ("0", "false", "no")


def _load_key():
    with open(KEY_FILE, encoding="utf-8") as f:
        return f.read().strip()


def _load_token():
    with open(AUTH_FILE, encoding="utf-8") as f:
        auth = json.load(f)
    tokens = auth.get("tokens", {})
    if not tokens:
        return "", "default"
    best = max(tokens.items(), key=lambda kv: kv[1].get("expires_at", ""))
    return best[0], best[1].get("user_id", "default")


def _load_state():
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def _save_state(state):
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False)


def _call_backend(port, token, path, payload):
    url = f"https://127.0.0.1:{port}{path}"
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    resp = requests.post(url, json=payload, headers=headers, timeout=10, verify=False)
    resp.raise_for_status()
    return resp.json()


def _check_balance():
    key = _load_key()
    resp = requests.get(
        "https://api.deepseek.com/user/balance",
        headers={"Authorization": f"Bearer {key}", "Accept": "application/json"},
        timeout=15,
    )
    resp.raise_for_status()
    info = resp.json()["balance_infos"][0]
    return float(info["total_balance"]), info["currency"]


def run(context):
    port = context.backend_info()["backend_port"]
    token, user_id = _load_token()
    state = _load_state()
    last_balance = state.get("last_balance")
    alerted = state.get("alerted", False)
    last_alert_balance = state.get("last_alert_balance")
    last_alert_ts = state.get("last_alert_ts")

    while True:
        try:
            balance, currency = _check_balance()

            if last_balance is None:
                _call_backend(port, token, "/api/screen/stt/perception-event", {
                    "type": "balance",
                    "payload": {"balance": balance, "currency": currency},
                    "ts": datetime.now().strftime("%H:%M:%S"),
                })
                last_balance = balance
                context.log(f"首次记录余额 {balance} {currency}")
            elif balance > last_balance:
                last_balance = balance
                context.log(f"余额回升至 {balance} {currency}，重置基准")
            elif last_balance - balance >= RECORD_STEP:
                _call_backend(port, token, "/api/screen/stt/perception-event", {
                    "type": "balance",
                    "payload": {"balance": balance, "currency": currency},
                    "ts": datetime.now().strftime("%H:%M:%S"),
                })
                last_balance = balance
                context.log(f"累计消耗 {RECORD_STEP} 元，记录余额 {balance} {currency}")

            should_alert = False
            if balance < ALERT_THRESHOLD:
                if not alerted:
                    should_alert = True
                elif last_alert_balance is not None and balance <= last_alert_balance - ALERT_STEP:
                    should_alert = True
                    context.log(
                        f"余额较上次告警({last_alert_balance} {currency})再降 "
                        f"{ALERT_STEP} 元以上，补发告警"
                    )
                elif last_alert_ts is not None and time.time() - last_alert_ts >= ALERT_REPEAT_HOURS * 3600:
                    should_alert = True
                    context.log(f"余额低位已持续 {ALERT_REPEAT_HOURS} 小时以上，补发告警")

            if NOTIFY_ENABLED and should_alert:
                _call_backend(port, token, "/api/notification/send", {
                    "title": "DeepSeek余额告警",
                    "content": f"余额仅 {balance} {currency}，请尽快充值！",
                    "user_id": user_id,
                })
                alerted = True
                last_alert_balance = balance
                last_alert_ts = time.time()
                context.log(f"余额 {balance} {currency}，已发告警通知")
            elif balance >= ALERT_THRESHOLD and alerted:
                alerted = False
                last_alert_balance = None
                last_alert_ts = None

            state["last_balance"] = last_balance
            state["alerted"] = alerted
            state["last_alert_balance"] = last_alert_balance
            state["last_alert_ts"] = last_alert_ts
            _save_state(state)
        except Exception as e:
            context.log(f"检查失败: {e}", level="warning")

        # 分段睡眠 + 心跳：ScriptRunner 要求每 300 秒至少一次心跳，
        # 一次性睡满检查周期会被判定超时杀掉重启，故拆成 60 秒小段。
        for _ in range(max(1, CHECK_INTERVAL // HEARTBEAT_INTERVAL)):
            context.heartbeat()
            time.sleep(HEARTBEAT_INTERVAL)
        context.heartbeat()
