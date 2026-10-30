"""
name: 数据检查调度器
enabled: true
note: 数据检查调度器，7窗（00/06/08/12/16/20/22 点，v4 2026-10-27）。
  cov-00 是今日计划里的检查点，但数据归属昨天：覆盖前一天22:00~00:00（跨日）；
  06点覆盖00:00~06:00（夜间一扛）；08/12/16/20/22 各覆盖其后时段。
  7窗全发通知，不静默。
prompt: |-
  数据检查调度器，每 2 小时自动触发数据检查流水线。
"""
import json
import time
from datetime import datetime, timedelta
from pathlib import Path

# 持久化状态文件路径（wrapper exec 环境下 __file__ 不可用，使用 cwd 相对路径）
STATE_FILE = "ai/data/tasks/.data_check_state.json"


def _load_state():
    """从磁盘加载上次触发记录"""
    try:
        return json.loads(Path(STATE_FILE).read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def _save_state(state):
    """将触发记录持久化到磁盘"""
    try:
        Path(STATE_FILE).write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
    except (OSError, IOError):
        pass


# 时间窗口定义: {触发小时: (开始时间, 结束时间)}
# 2026-10-27 调整v4：7窗（00/06/08/12/16/20/22），移除 10/14/18。
#   cov-00 是今日计划里的检查点，但 target_date 指昨天（覆盖前一天 22:00~00:00，跨日）。
#   凌晨 00:00~06:00 由 06 点批次一扛。
#   0: 22~00(2h，跨日) | 6: 00~06(6h) | 8: 06~08(2h) | 12: 08~12
#   16: 12~16 | 20: 16~20 | 22: 20~22
#   状态兼容：旧 state 文件里残留的 10/14/18 键不再被读取，保留无害，无需手工清理。
#   通知：7窗全发，不静默。
WINDOWS = {
    0:  ("22:00", "00:00"),
    6:  ("00:00", "06:00"),
    8:  ("06:00", "08:00"),
    12: ("08:00", "12:00"),
    16: ("12:00", "16:00"),
    20: ("16:00", "20:00"),
    22: ("20:00", "22:00"),
}


def _build_prompt(trigger_hour, target_date):
    """构建发给AI的简化提示词"""
    start, end = WINDOWS[trigger_hour]
    time_label = f"{trigger_hour:02d}点"
    window = f"{start}~{end}"
    name = f"数据检查_{time_label}"
    date_hint = f"日期: {target_date}（前一天，不是今天）" if trigger_hour == 0 else f"日期: {target_date}"

    # 简化prompt：子智能体参数由主智能体从 AGENTS.md 流程中获取
    return (
        f"【数据检查 - {name}】 按子智能体调度流程执行, {date_hint}, 覆盖时段: {window}。"
        "若事实文件含 `└ MOSS:` 行，按规则-01 作为辅助数据源消费，不得替代 sim/设备/指针日期做身份硬归因。"
    )


def run(context):
    """自循环调度：每 30 秒检查当前时间，在对应整点触发数据检查"""
    # {小时: 上次触发日期}，用于同一天不重复触发（持久化到磁盘防重启丢失）
    restored = _load_state()
    if restored:
        context.log(f"从磁盘恢复调度状态: {restored}")

    context.log("数据检查调度器已启动，覆盖时段: " + ", ".join(f"{h:02d}:00" for h in sorted(WINDOWS)))

    while True:
        now = datetime.now()
        today = now.strftime("%Y-%m-%d")
        hour = now.hour

        # 每轮判定前重读磁盘 state：FileWatcher 高频重启会产生瞬时双实例，
        # 各实例内存 state 互不可见会双触发。读盘后任何实例都能看到其他实例的
        # 写入，竞态窗口收敛到 trigger→save 的毫秒级。
        last_triggered = _load_state()

        if hour in WINDOWS and last_triggered.get(str(hour)) != today:
            start, end = WINDOWS[hour]

            # 00 点算前一天的日期（跨日窗口）
            if hour == 0:
                target_date = (now - timedelta(days=1)).strftime("%Y-%m-%d")
            else:
                target_date = today

            prompt = _build_prompt(hour, target_date)
            task_name = f"数据检查_{hour:02d}点"
            context.trigger_task(task_name, prompt)
            context.log(f"已触发 {task_name} (日期={target_date}, 窗口={start}~{end})")
            last_triggered[str(hour)] = today
            _save_state(last_triggered)

        context.heartbeat()
        time.sleep(240)
