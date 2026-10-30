# -*- coding: utf-8 -*-
"""进程编排器包。

- ``spec``：服务声明模型（``ServiceSpec``）与全局注册表；
- ``runtime``（任务 8）：状态机、重启窗口与子进程生命周期；
- 路由（任务 9）只读注册表暴露状态。

本包导入时不拉起源码内任何被编排服务的依赖，避免启动链耦合。
"""

from .spec import (
    REGISTRY,
    ServiceSpec,
    all_specs,
    clear_registry,
    get,
    register,
    requirements_satisfied,
)

__all__ = [
    "REGISTRY",
    "ServiceSpec",
    "all_specs",
    "clear_registry",
    "get",
    "register",
    "requirements_satisfied",
]
