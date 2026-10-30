# -*- coding: utf-8 -*-
"""小米健康云步骤的完成态判定。

纯函数：只接收开关与配置态，不发网络探测，也不读写运行时状态文件。
引导 ``finish`` 校验可直接复用，避免把网络抖动带入完成判定。
"""
from __future__ import annotations

from typing import Optional

XIAOMI_NOT_CONFIGURED_MESSAGE = (
    "小米健康云已启用，但尚未完成扫码登录，"
    "请在「小米健康云」步骤扫码或关闭启用。"
)


def xiaomi_finish_error(
    *, enabled: bool, configured: bool
) -> Optional[dict[str, str]]:
    """返回阻断完成引导的错误；未启用或已配置凭据时返回 None。"""
    if enabled and not configured:
        return {
            "code": "xiaomi_not_configured",
            "message": XIAOMI_NOT_CONFIGURED_MESSAGE,
        }
    return None
