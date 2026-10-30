"""进程级运行时单例注册表。

`python -m core.hot_server` 会把 hot_server 以 ``__main__`` 执行；再由
reconciler ``import core.hot_server`` 时会得到第二个模块对象。若单例存在
hot_server 模块全局里，两份副本会各自持有 ``None``。本模块只按名称导入，
不受 ``-m`` 执行方式影响，保证进程内只有一个 HotServer 实例。
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from core.hot_server import HotServer

_hot_server: Optional["HotServer"] = None


def set_hot_server(server: Optional["HotServer"]) -> None:
    global _hot_server
    _hot_server = server


def get_hot_server() -> Optional["HotServer"]:
    return _hot_server
