"""
name: 生产测试脚本
enabled: false
note: 完整功能演示，展示 Context API 全部能力（后端信息、目录读写、网络请求）
prompt: |
  这是一个自定义脚本的完整功能演示。
  展示了 frontmatter、数据读取、条件判断、心跳、后端信息获取等能力。
"""

import time
import os
from datetime import datetime
from os.path import exists, getsize, isdir


def run(context):
    """生产测试 - 展示脚本的完整能力"""
    # 获取后端运行信息
    info = context.backend_info()
    context.log(
        f"后端信息: 端口={info['backend_port']}, "
        f"OpenCode端口={info['opencode_port']}, "
        f"主智能体={info['opencode_session_id']}"
    )
    context.log("脚本启动成功")

    while True:
        today = datetime.now().strftime("%Y-%m-%d")
        data_dir = f"ai/data/{today}"

        # 1. 目录读写
        if isdir(data_dir):
            files = os.listdir(data_dir)
            context.log(f"{today} 数据目录: {len(files)} 个文件")
        else:
            context.log(f"{today} 暂无数据目录")

        # 2. 读取文件
        if exists("ai/data/perception.jsonl"):
            size = getsize("ai/data/perception.jsonl")
            context.log(f"perception.jsonl: {size} bytes")
        else:
            context.log("暂无感知数据")

        # 3. 向 OpenCode 发送消息（取消注释即可启用）
        # 示例 1: 条件触发
        # if os.path.getsize("ai/data/perception.jsonl") > 1024:
        #     context.trigger_task("数据检查", "请分析最新的感知数据")

        # 示例 2: 定期触发
        # context.trigger_task("定时检查", "请检查系统状态并回复")

        # 示例 3: 带异常告警
        # if error_condition:
        #     context.alert("发现数据异常")
        #     context.trigger_task("异常分析", "请分析以下异常数据...")

        # 4. 保活信号（每300秒至少一次）
        context.heartbeat()

        # 5. 控制频率
        time.sleep(300)
