# -*- coding: utf-8 -*-
"""
健康数据多源存储包（H1 暗接入骨架）。

依据 health-data-source-architecture.md 第 5/6 节：
  - models  : canonical dataclass 契约（HealthBatch / HealthSample / SleepData 等）
  - paths   : 显式 data_root 的路径解析与参数校验
  - store   : 分片存储 + 原子写 + 同 t 合并 + 派生兼容视图导出

本包为独立暗接入骨架：不 import、不修改 services.health_storage，
不接线任何路由/配置；构造与测试一律显式传 data_root。
"""

from .models import (
    DailySummary,
    DeviceRef,
    HealthBatch,
    HealthSample,
    SleepData,
    SleepSegment,
)
from .paths import legacy_path, shard_path
from .store import HealthStore

__all__ = [
    "DailySummary",
    "DeviceRef",
    "HealthBatch",
    "HealthSample",
    "SleepData",
    "SleepSegment",
    "HealthStore",
    "legacy_path",
    "shard_path",
]
