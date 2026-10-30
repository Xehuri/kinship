"""
name: trigger_task测试
enabled: false
note: 演示 trigger_task 用法，实际发送代码已注释。取消注释即可测试。
prompt: |
  这是一个 trigger_task 功能演示脚本。
  展示了如何从自定义脚本触发 AI 任务。
"""

import time
from datetime import datetime


def run(context):
    """演示 trigger_task 功能（发送代码已注释）"""
    context.log("trigger_task 演示脚本启动")

    # 获取后端信息
    info = context.backend_info()
    context.log(f"会话ID: {info['opencode_session_id']}")

    # 触发任务的代码已注释，取消注释即可向 AI 会话发送消息：
    # now = datetime.now().strftime("%H:%M:%S")
    # context.trigger_task(
    #     "trigger_task测试",
    #     f"【trigger_task测试】来自脚本的测试任务，触发时间: {now}"
    # )
    # context.log(f"trigger_task调用完成 ({now})")

    context.log(f"演示完成 (时间: {datetime.now().strftime('%H:%M:%S')})，如需测试请取消注释")
    context.heartbeat()
    context.log("脚本退出")
