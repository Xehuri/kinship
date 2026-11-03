"""
name: 夜间主动联系
enabled: false
note: 默认关，可选任务骨架。用户曾要求主动联系；21:00 与 22:30 各主动发一条（当天有效，状态去重）。
      SLOTS 可按需调整。
prompt: |
  【主动联系】用户曾要求 AI 主动开口。
"""

import json
import os
import time
from datetime import datetime

AI_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TASK_DIR = os.path.join(AI_ROOT, "data", "tasks")
STATE = os.path.join(TASK_DIR, ".night_checkin_state.json")
SLOTS = ["21:00", "22:30"]  # 按需修改时间槽
WINDOW = 3  # 分钟容差


def _load():
    try:
        return json.load(open(STATE, encoding="utf-8"))
    except Exception:
        return {}


def _save(d):
    tmp = STATE + ".tmp"
    json.dump(d, open(tmp, "w", encoding="utf-8"), ensure_ascii=False)
    os.replace(tmp, STATE)


def run(context):
    context.log("夜间主动联系启动（%s）" % ",".join(SLOTS))
    while True:
        try:
            context.heartbeat()
            now = datetime.now()
            date = now.strftime("%Y-%m-%d")
            hm = now.strftime("%H:%M")
            st = _load()
            if st.get("date") != date:
                st = {"date": date, "done": []}
            for slot in SLOTS:
                if slot in st["done"]:
                    continue
                sh, sm = [int(x) for x in slot.split(":")]
                delta = (now.hour * 60 + now.minute) - (sh * 60 + sm)
                if 0 <= delta <= WINDOW:
                    msg = (
                        "【主动联系】现在 %s。用户曾要求主动联系。"
                        "通过 ai-mcp_send_notification 发一条给用户：一到两句话，问用户这会儿在做什么、"
                        "或者提一句今天的事。"
                        "**不汇报进度、不列清单、不问用户吃没吃**。"
                    ) % hm
                    context.trigger_task("夜间主动联系", msg)
                    st["done"].append(slot)
                    _save(st)
                    context.log(f"已触发 {slot}")
        except Exception as e:  # noqa: BLE001
            try:
                context.log(f"夜间主动联系异常：{e!r}")
            except Exception:
                pass
        time.sleep(40)
