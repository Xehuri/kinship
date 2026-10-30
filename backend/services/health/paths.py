# -*- coding: utf-8 -*-
"""
健康数据路径解析（H1 暗接入骨架）。

所有函数显式接收 data_root；H1 不接线任何配置读取，
构造 HealthStore 与调用本模块时一律由调用方传入数据根目录。

目录布局（health-data-source-architecture.md 第 5.1 节）：
  {data_root}/users/{user_id}/health/{date}/{source}.json   源分片
  {data_root}/daily/{date}/health.json                      派生兼容视图

校验规则：user_id 非空、date 为合法 YYYY-MM-DD、source 属于 {phone, cloud}，
任一不满足抛 ValueError。
"""
import os
import re
from datetime import datetime
from typing import Optional

# 合法数据源（方案第 5.1 节：phone / cloud）
VALID_SOURCES = ("phone", "cloud")

# YYYY-MM-DD 形状（再经 strptime 校验真实日历日期）
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _validate_user_id(user_id: Optional[str]) -> None:
    """user_id 必须非空且不含路径分隔符（防目录穿越）。"""
    if not isinstance(user_id, str) or not user_id.strip():
        raise ValueError(f"user_id 不能为空: {user_id!r}")
    if user_id in (".", "..") or any(sep in user_id for sep in ("/", "\\")):
        raise ValueError(f"user_id 含非法路径字符: {user_id!r}")


def _validate_date(date: Optional[str]) -> None:
    """date 必须为真实日历日期的 YYYY-MM-DD。"""
    if not isinstance(date, str) or not _DATE_RE.match(date):
        raise ValueError(f"date 必须为 YYYY-MM-DD 格式: {date!r}")
    try:
        datetime.strptime(date, "%Y-%m-%d")
    except ValueError:
        raise ValueError(f"date 不是合法日历日期: {date!r}") from None


def _validate_source(source: Optional[str]) -> None:
    """source 必须属于 {phone, cloud}。"""
    if source not in VALID_SOURCES:
        raise ValueError(f"source 必须属于 {VALID_SOURCES}: {source!r}")


def shard_path(data_root: str, user_id: str, date: str, source: str) -> str:
    """源分片路径：{data_root}/users/{user_id}/health/{date}/{source}.json。"""
    _validate_user_id(user_id)
    _validate_date(date)
    _validate_source(source)
    return os.path.join(data_root, "users", user_id, "health", date, f"{source}.json")


def legacy_path(data_root: str, date: str) -> str:
    """派生兼容视图路径：{data_root}/daily/{date}/health.json。"""
    _validate_date(date)
    return os.path.join(data_root, "daily", date, "health.json")
