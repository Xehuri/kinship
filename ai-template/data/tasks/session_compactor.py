"""
name: 会话压缩器
enabled: true
note: 每天 04:00 向主会话发送一次提醒：整理信息；可以压缩会话，也可以不压缩。不自动调用压缩接口。
prompt: |-
  会话压缩器，每天凌晨 4 点提醒主会话整理信息；可以压缩会话，或者不压缩，按当前需要判断。
"""

import json
import os
import time
from datetime import datetime
from pathlib import Path

DATA_DIR = os.environ.get("AXEUH_AI_DATA_DIR", "ai/data")
# 持久化状态文件路径（wrapper exec 环境下 __file__ 不可用，使用 cwd 相对路径）
STATE_FILE = os.environ.get(
    "AXEUH_SESSION_COMPACTOR_STATE",
    os.path.join(DATA_DIR, "tasks", ".session_compactor_state.json"),
)

REMINDER = "系统提醒：请整理信息；可以压缩会话，或者不压缩，按当前需要判断。"


def _load_state():
    """从磁盘加载上次提醒日期。"""
    try:
        return json.loads(Path(STATE_FILE).read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def _save_state(state):
    """将状态持久化到磁盘（防重启重复提醒）。"""
    try:
        Path(STATE_FILE).write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
    except (OSError, IOError):
        pass


def run(context):
    """每天 04:00 提醒主会话整理信息；由主会话决定是否压缩。"""
    state = _load_state()
    # 兼容旧状态键：旧版记录 last_compacted，新版记录 last_reminded。
    last_reminded = state.get("last_reminded") or state.get("last_compacted", "")
    if state:
        context.log(f"从磁盘恢复压缩器状态: 上次提醒={last_reminded}")

    context.log("会话压缩器已启动，每天 04:00 提醒整理信息（不自动压缩）")

    while True:
        now = datetime.now()
        today = now.strftime("%Y-%m-%d")

        # 每天 04:00 发送一次提醒；由主会话决定压缩或不压缩。
        if now.hour == 4 and today != last_reminded:
            context.trigger_task("会话压缩器", REMINDER)
            context.log("已向主会话发送整理信息/可选压缩提醒")
            last_reminded = today
            _save_state({"last_reminded": last_reminded})

        context.heartbeat()
        time.sleep(300)
