# -*- coding: utf-8 -*-
"""
健康设备注册表（H5 骨架，架构文档 §7）。

注册表文件：backend/data/health_devices.json（运行时数据，不入 git）。
- 首见某 device_id 自动建档（normalize 触发），owner = 认证用户
- kind ∈ phone | band | cloud | pc；云端 id 规则 = cloud:{userId}
- 幂等 upsert：重复注册只刷新 last_seen / 可补 label，first_seen 保留
- 并发由模块级锁保护 + 临时文件原子替换

完整设备面板 / 归属管理留待 H6；本骨架只保证「写分片可回溯源」。
"""
import json
import logging
import os
import tempfile
import threading
from datetime import datetime, timedelta, timezone
from typing import Optional

from .models import DeviceRef

logger = logging.getLogger(__name__)

_CST = timezone(timedelta(hours=8))
_lock = threading.Lock()


def _registry_path() -> str:
    """注册表路径：config.HEALTH_DEVICES_PATH（默认 backend/data/health_devices.json，V14 收编）。

    测试 monkeypatch 本函数重定向到 tmp_path。
    """
    from config.config import get_config
    return get_config().HEALTH_DEVICES_PATH


def register(
    device_name: Optional[str] = None,
    device_id: Optional[str] = None,
    owner: Optional[str] = None,
    kind: str = "phone",
    source_id: Optional[str] = None,
) -> DeviceRef:
    """登记（幂等 upsert）一台设备，返回分片内嵌用的 DeviceRef。

    device_id 缺省时回退 device_name；cloud 类回退 cloud:{owner}。
    label 仅在显式传入时更新（缺省保留已存标签，与 store 语义一致）。
    """
    resolved_id = device_id or device_name
    if not resolved_id:
        resolved_id = f"cloud:{owner}" if kind == "cloud" and owner else kind
    ref = DeviceRef(
        device_id=resolved_id,
        label=device_name,
        kind=kind,
        owner_user_id=owner,
        source_id=source_id,
    )

    path = _registry_path()
    with _lock:
        data = {}
        if os.path.exists(path):
            try:
                with open(path, encoding="utf-8") as f:
                    loaded = json.load(f)
                if isinstance(loaded, dict):
                    data = loaded
            except (json.JSONDecodeError, OSError) as exc:
                logger.warning("[devices] 注册表读取失败，按空处理: %s", exc)
        prev = data.get(resolved_id) if isinstance(data.get(resolved_id), dict) else {}
        now_iso = datetime.now(_CST).isoformat()
        entry = {
            "label": device_name
            if device_name is not None
            else prev.get("label"),
            "kind": kind,
            "owner_user_id": owner,
            "source_id": source_id,
            "first_seen": prev.get("first_seen") or now_iso,
            "last_seen": now_iso,
        }
        data[resolved_id] = entry
        # 临时文件 + 原子替换（同目录保证同盘）
        directory = os.path.dirname(path)
        os.makedirs(directory, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=directory, suffix=".tmp", prefix=".devices_")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            os.replace(tmp, path)
        except BaseException:
            try:
                if os.path.exists(tmp):
                    os.unlink(tmp)
            except OSError:
                pass
            raise
    return ref
