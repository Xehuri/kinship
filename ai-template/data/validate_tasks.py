#!/usr/bin/env python3
"""
tasks.json 合法性检查工具

AI 在手动编辑 tasks.json 后，用此脚本检查修改是否有效。

用法:
    python validate_tasks.py                    # 检查 tasks.json
    python validate_tasks.py --executions       # 同时检查 task_executions.json
    python validate_tasks.py --fix              # 自动修复可修复的问题（如 next_run 重算）

退出码: 0=合法, 1=有问题
"""

import json
import sys
import os
from datetime import datetime

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# 合法枚举值
VALID_SCHEDULE_TYPES = {"scheduled", "delay"}
VALID_TARGET_TYPES = {"main_task", "current", "new_session", "specific"}
VALID_TIME_FIELDS = {"created_at", "last_run", "next_run"}
REQUIRED_TASK_FIELDS = {
    "task_id", "user_id", "task_name", "prompt",
    "schedule_type", "schedule_config", "enabled", "repeat"
}


def load_json(path):
    """加载 JSON 文件，返回 (data, errors)"""
    if not os.path.exists(path):
        return None, [f"文件不存在: {path}"]
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f), []
    except json.JSONDecodeError as e:
        return None, [f"JSON 解析错误: {e}"]


def validate_iso_time(val, field_name, task_id):
    """检查时间字段是否是合法 ISO 格式或 None"""
    errors = []
    if val is None:
        return errors
    if isinstance(val, (int, float)):
        errors.append(f"[{task_id}] {field_name} 是数字格式({val})，应改为 ISO 格式字符串")
        return errors
    if not isinstance(val, str):
        errors.append(f"[{task_id}] {field_name} 类型错误: 期望字符串, 得到 {type(val).__name__}")
        return errors
    try:
        datetime.fromisoformat(val)
    except ValueError:
        errors.append(f"[{task_id}] {field_name} 不是合法 ISO 时间: {val}")
    return errors


def validate_task(t, index):
    """验证单个任务，返回错误列表"""
    errors = []
    task_id = t.get("task_id", f"task[{index}]")

    # 1. 必填字段
    for field in REQUIRED_TASK_FIELDS:
        if field not in t:
            errors.append(f"[{task_id}] 缺少必填字段: {field}")

    # 2. 字段类型检查
    if "task_name" in t and not isinstance(t["task_name"], str):
        errors.append(f"[{task_id}] task_name 应为字符串")
    if "prompt" in t and not isinstance(t["prompt"], str):
        errors.append(f"[{task_id}] prompt 应为字符串")
    if "user_id" in t and not isinstance(t["user_id"], str):
        errors.append(f"[{task_id}] user_id 应为字符串")

    # 3. schedule_type
    st = t.get("schedule_type")
    if st is not None and st not in VALID_SCHEDULE_TYPES:
        errors.append(f"[{task_id}] schedule_type 无效: '{st}'，应为 {VALID_SCHEDULE_TYPES}")

    # 4. schedule_config
    sc = t.get("schedule_config")
    if sc is not None:
        if not isinstance(sc, dict):
            errors.append(f"[{task_id}] schedule_config 应为对象")
        elif st == "scheduled":
            mode = sc.get("mode")
            if mode not in (None, "daily", "hourly", "weekly", "once"):
                errors.append(f"[{task_id}] schedule_config.mode 无效: '{mode}'")
            hour = sc.get("hour")
            if hour is not None and not (0 <= hour <= 23):
                errors.append(f"[{task_id}] schedule_config.hour 超出 0~23: {hour}")
            minute = sc.get("minute")
            if minute is not None and not (0 <= minute <= 59):
                errors.append(f"[{task_id}] schedule_config.minute 超出 0~59: {minute}")
        elif st == "delay":
            delay = sc.get("delay_minutes")
            if delay is not None and delay <= 0:
                errors.append(f"[{task_id}] schedule_config.delay_minutes 应大于 0")

    # 5. 布尔字段
    for field in ("enabled", "repeat"):
        val = t.get(field)
        if val is not None and not isinstance(val, bool):
            errors.append(f"[{task_id}] {field} 应为布尔值, 得到 {type(val).__name__}")

    # 6. 时间字段（支持 ISO 格式）
    for field in VALID_TIME_FIELDS:
        if field in t:
            errors.extend(validate_iso_time(t[field], field, task_id))

    # 7. run_count
    rc = t.get("run_count")
    if rc is not None and not isinstance(rc, (int, float)):
        errors.append(f"[{task_id}] run_count 应为数字")

    # 8. target_type
    tt = t.get("target_type")
    if tt is not None and tt not in VALID_TARGET_TYPES:
        errors.append(f"[{task_id}] target_type 无效: '{tt}'")

    # 9. 未知字段
    allowed = REQUIRED_TASK_FIELDS | VALID_TIME_FIELDS | {
        "run_count", "target_type", "target_session"
    }
    for key in t:
        if key not in allowed:
            errors.append(f"[{task_id}] 未知字段: {key}")

    return errors


def validate_tasks_file():
    """验证 tasks.json"""
    path = os.path.join(SCRIPT_DIR, "tasks.json")
    print(f"检查: {path}")
    print("=" * 60)

    data, load_errors = load_json(path)
    if load_errors:
        for e in load_errors:
            print(f"  [错误] {e}")
        return False

    if not isinstance(data, dict):
        print(f"  [错误] 根应为对象, 得到 {type(data).__name__}")
        return False

    all_errors = []
    tasks = data.get("tasks", [])

    if not isinstance(tasks, list):
        print(f"  [错误] tasks 应为数组, 得到 {type(tasks).__name__}")
        return False

    if len(tasks) == 0:
        print("  [警告] tasks 为空数组")

    for i, t in enumerate(tasks):
        if not isinstance(t, dict):
            all_errors.append(f"[task[{i}]] 应为对象, 得到 {type(t).__name__}")
            continue
        all_errors.extend(validate_task(t, i))

    if all_errors:
        print(f"\n发现 {len(all_errors)} 个问题:\n")
        for e in all_errors:
            print(f"  [问题] {e}")
        return False
    else:
        print(f"  校验通过: {len(tasks)} 个任务, 全部合法")
        return True


def validate_executions_file():
    """验证 task_executions.json"""
    path = os.path.join(SCRIPT_DIR, "task_executions.json")
    if not os.path.exists(path):
        print(f"\n跳过: {os.path.basename(path)} 不存在")
        return True

    print(f"\n检查: {path}")
    print("=" * 60)

    data, load_errors = load_json(path)
    if load_errors:
        for e in load_errors:
            print(f"  [错误] {e}")
        return False

    if not isinstance(data, dict):
        print(f"  [错误] 根应为对象, 得到 {type(data).__name__}")
        return False

    executions = data.get("executions", [])
    if not isinstance(executions, list):
        print(f"  [错误] executions 应为数组")
        return False

    errors = []
    for i, e in enumerate(executions):
        if not isinstance(e, dict):
            errors.append(f"[exec[{i}]] 应为对象")
            continue
        eid = e.get("execution_id", f"exec[{i}]")
        for field in ("execution_id", "task_id", "status"):
            if field not in e:
                errors.append(f"[{eid}] 缺少必填字段: {field}")
        for tf in ("started_at", "completed_at"):
            val = e.get(tf)
            if val is not None and isinstance(val, str):
                try:
                    datetime.fromisoformat(val)
                except ValueError:
                    errors.append(f"[{eid}] {tf} 不是合法 ISO 时间")

    if errors:
        print(f"\n发现 {len(errors)} 个问题:\n")
        for e in errors:
            print(f"  [问题] {e}")
        return False

    print(f"  校验通过: {len(executions)} 条记录, 全部合法")
    return True


def main():
    args = set(sys.argv[1:])
    check_executions = "--executions" in args

    tasks_ok = validate_tasks_file()
    execs_ok = True
    if check_executions:
        execs_ok = validate_executions_file()

    print()
    if tasks_ok and execs_ok:
        print("结果: 全部合法")
        sys.exit(0)
    else:
        print("结果: 存在需要修复的问题")
        sys.exit(1)


if __name__ == "__main__":
    main()
