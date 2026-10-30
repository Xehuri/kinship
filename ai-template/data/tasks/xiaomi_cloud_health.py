"""
name: 小米云健康拉取
enabled: false
note: 每 health.cloud_poll_interval_min 分钟拉小米云健康数据，canonical 批次直写 HealthStore（source=cloud 分片）；水位与运行状态存 {AI目录}/data/tasks/.xiaomi_cloud_health_state.json；连续失败 3 次推送通知。凭据走 config.yaml 的 health.cloud.*，默认关。
"""

import json
import os
import time
from datetime import datetime

import requests

from config.config import get_config
from services.health.sources.cloud_pull import (
    CloudAuthError,
    CloudPullSource,
    poll_interval_minutes,
)
from services.health_storage import get_health_store

DATA_DIR = os.environ.get("AXEUH_AI_DATA_DIR", "ai/data")
AUTH_FILE = "backend/config/auth.json"
STATE_FILE = os.environ.get(
    "AXEUH_CLOUD_HEALTH_STATE",
    os.path.join(DATA_DIR, "tasks", ".xiaomi_cloud_health_state.json"),
)
HEARTBEAT_INTERVAL = 60  # 分段睡眠时的心跳间隔，必须小于 ScriptRunner 300 秒超时阈值
FAIL_ALERT_THRESHOLD = 3
FAIL_ALERT_EVERY = 24


def _load_token():
    with open(AUTH_FILE, encoding="utf-8") as f:
        auth = json.load(f)
    tokens = auth.get("tokens", {})
    if not tokens:
        return "", ""
    best = max(tokens.items(), key=lambda kv: kv[1].get("expires_at", ""))
    return best[0], best[1].get("user_id", "")


def _resolve_user_id():
    """primary_user 优先；未配置时回落到 auth.json 中最长有效期 token 的用户。"""
    primary = get_config().HEALTH_PRIMARY_USER
    if primary:
        return primary
    _, user_id = _load_token()
    return user_id


def _load_state():
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def _save_state(state):
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False)
    os.replace(tmp, STATE_FILE)


def _notify(context, title, content):
    """失败告警走后端通知接口；通知失败只记日志，不打断拉取循环。"""
    try:
        port = context.backend_info().get("backend_port") or ""
        token, user_id = _load_token()
        if not port or not token:
            context.log("通知链路未就绪，跳过", level="warning")
            return
        requests.post(
            f"https://127.0.0.1:{port}/api/notification/send",
            json={"title": title, "content": content, "user_id": user_id or "default"},
            headers={"Authorization": f"Bearer {token}"},
            timeout=10,
            verify=False,
        )
    except Exception as exc:
        context.log(f"通知发送失败: {exc}", level="warning")


def _error_text(exc):
    if isinstance(exc, CloudAuthError):
        return (
            f"小米云凭据失效（{exc.code}）。请运行 "
            "python backend/scripts/mi_cloud_setup.py --qr 重新扫码"
        )
    return str(exc)


def run(context):
    state = _load_state()
    interval_s = poll_interval_minutes() * 60
    lookback_s = get_config().HEALTH_CLOUD_INITIAL_LOOKBACK_DAYS * 86400
    store = get_health_store()
    src = CloudPullSource()

    while True:
        user_id = _resolve_user_id()
        state["last_attempt"] = int(time.time())
        try:
            if not user_id:
                raise RuntimeError(
                    "无法解析本地用户：请设置 health.primary_user 或先创建 Web 用户"
                )
            since = state.get("watermark") or int(time.time()) - lookback_s
            batches = src.fetch(since=since, user_id=user_id)
            written = 0
            if batches:
                for batch in batches:
                    store.write(batch)
                    written += 1
                state["watermark"] = int(time.time())
            state["last_success"] = int(time.time())
            state["last_batches"] = written
            state["consecutive_failures"] = 0
            state["last_error"] = ""
            _save_state(state)
            with open(STATE_FILE + ".meta", "w", encoding="utf-8") as f:
                json.dump(
                    {
                        "last_run": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                        "batches": written,
                    },
                    f,
                    ensure_ascii=False,
                )
            context.log(
                f"云拉取完成：{written} 个批次（since={since}, user={user_id}）"
                if batches
                else "云拉取无新数据"
            )
        except Exception as exc:
            failures = int(state.get("consecutive_failures", 0)) + 1
            message = _error_text(exc)
            state["consecutive_failures"] = failures
            state["last_error"] = message
            _save_state(state)
            context.log(f"云拉取失败（连续 {failures} 次）: {message}", level="warning")
            if failures == FAIL_ALERT_THRESHOLD or (
                failures > FAIL_ALERT_THRESHOLD and failures % FAIL_ALERT_EVERY == 0
            ):
                _notify(
                    context,
                    "小米云健康拉取失败",
                    f"已连续失败 {failures} 次：{message}",
                )

        for _ in range(max(1, interval_s // HEARTBEAT_INTERVAL)):
            context.heartbeat()
            time.sleep(HEARTBEAT_INTERVAL)
        context.heartbeat()
