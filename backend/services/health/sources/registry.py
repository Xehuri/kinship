# -*- coding: utf-8 -*-
"""
云指标 key 清单（架构 §3.6 全量 9 个）。

P1-V7 清算：原 registry 的 get_source/capabilities/_SOURCE_CLASSES 为生产零调用
死抽象（注册表从未被路由/任务使用），随分组双胞胎合一删除；本模块仅保留
cloud_pull.fetch 实际消费的取数顺序常量。V8 云 round-trip 去除时随
cloud_pull 一并处置。
"""
from typing import List

# fetch 遍历顺序使用的云指标 key（架构 §3.6 全量 9 个）
CLOUD_FETCH_KEYS: List[str] = [
    "steps",
    "calories",
    "heart_rate",
    "resting_heart_rate",
    "sleep",
    "weight",
    "spo2",
    "stress",
    "abnormal_heart_beat",
]
