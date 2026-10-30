# -*- coding: utf-8 -*-
"""
H5 数据源包：push 归一（唯一实现） + pull 适配器。

P1-V7 分组双胞胎合一后：
  - phone_push : /sync 载荷 -> HealthBatch 的 push 方向唯一实现
                 （save_health_data 与 /api/health/sync 两支共用；原
                 PhonePushSource 类与 health_storage 逐行等价分组已合并于此）
  - cloud_pull : 小米云协议（§3.6）登录/RC4 签名/分页/归一（录制 fixture 测试，无网络）
  - registry   : 仅剩 CLOUD_FETCH_KEYS 取数顺序常量（原 get_source/capabilities
                 死注册表已删；V8 云 round-trip 去除时一并处置）
  - base       : HealthSource 抽象（CloudPullSource 仍继承；push 归一已平函数化）
"""
from .base import HealthSource
from .phone_push import batches_from_request, normalize
from .registry import CLOUD_FETCH_KEYS

__all__ = [
    "HealthSource",
    "batches_from_request",
    "normalize",
    "CLOUD_FETCH_KEYS",
]
