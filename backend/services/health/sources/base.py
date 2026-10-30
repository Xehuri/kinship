# -*- coding: utf-8 -*-
"""
健康数据源抽象基类（H5，架构文档第 6 节；P1-V7 裁定保留）。

P1-V7 裁定：push 方向归一已平函数化（phone_push.normalize /
batches_from_request 为唯一实现，save_health_data 与 /sync 两支共用），
PhonePushSource 类随双胞胎合一删除。本 ABC 现仅承载 pull 方向
（CloudPullSource 唯一继承者），删除它将波及 V8 冻结的 cloud_pull.py，
故保留接口、不做无收益清算。

  - source_id   : 分片归属标识（phone / cloud）
  - direction   : push（路由收请求）| pull（任务主动拉取）
  - normalize() : 原始载荷 -> canonical HealthBatch（语义在适配器内归一）
  - fetch()     : 仅 pull 源实现（按 since 水位拉取）
"""
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional

from ..models import HealthBatch


class HealthSource(ABC):
    """数据源适配器基类。"""

    #: 分片归属标识（paths.VALID_SOURCES 成员）
    source_id: str = ""
    #: 方向：push（客户端推）| pull（服务端拉）
    direction: str = "push"

    @abstractmethod
    def normalize(self, raw: Dict[str, Any]) -> HealthBatch:
        """把该源的原始载荷归一为 canonical HealthBatch。

        各源 raw 形状不同（phone = /sync 载荷按日分组；cloud = §3.6 云记录），
        语义归一（步数口径 / 睡眠 stage 码表 / 电量拆分）全部发生在适配器内。
        """

    def fetch(self, since: Optional[int] = None) -> List[HealthBatch]:
        """按 since 水位拉取数据（仅 pull 源实现）。

        push 源没有拉取语义，显式抛 NotImplementedError（registry 测试锁定）。
        """
        raise NotImplementedError(
            f"{self.source_id} 是 push 源，不支持 fetch 拉取"
        )
