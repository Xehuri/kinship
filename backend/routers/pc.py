# -*- coding: utf-8 -*-
"""
PC 感知数据接收路由

接收 Windows Agent 采集的 PC 感知数据（聚焦窗口、无人状态、屏幕锁屏等），
写入 perception.jsonl，与手机感知数据统一存储。

认证方式：使用后端 AuthMiddleware，Agent 需先登录获取 Bearer token。
"""

import logging
from typing import List, Optional, Any
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Request
from pydantic import BaseModel

from services.perception_store import append_perception

logger = logging.getLogger(__name__)
CST = timezone(timedelta(hours=8))

router = APIRouter(prefix="/api/pc", tags=["PC感知"])


# ============ Pydantic 模型 ============


class PcEventPayload(BaseModel):
    """单条 PC 感知事件的数据体"""
    process: Optional[str] = None
    title: Optional[str] = None
    pid: Optional[int] = None
    state: Optional[str] = None
    idle_seconds: Optional[int] = None


class PcEvent(BaseModel):
    """单条 PC 感知事件"""
    type: str
    t: Optional[str] = None
    t_iso: Optional[str] = None
    payload: PcEventPayload = PcEventPayload()


class PcSyncRequest(BaseModel):
    """PC 感知数据同步请求"""
    agent_id: str
    agent_name: Optional[str] = None
    events: List[PcEvent]


# ============ 事件处理 ============


_PAYLOAD_FIELDS: dict[str, list[str]] = {
    "pc_window": ["process", "title", "pid"],
    "pc_idle": ["state", "idle_seconds"],
    "pc_screen": ["state"],
}


def _make_payload(event: PcEvent) -> dict[str, Any]:
    """根据事件类型提取有效 payload 字段"""
    fields = _PAYLOAD_FIELDS.get(event.type, [])
    raw = event.payload.model_dump() if hasattr(event.payload, 'model_dump') else event.payload.dict()
    return {k: raw[k] for k in fields if k in raw and raw[k] is not None}


def _now_str() -> str:
    return datetime.now(CST).strftime("%H:%M:%S")


def _now_iso() -> str:
    return datetime.now(CST).isoformat()


def _event_date(t_iso: Optional[str]) -> Optional[str]:
    """从原始 t_iso 提取事件日期（YYYY-MM-DD），供 perception 按事件日期分桶。

    单一规则，无推断阶梯（t_iso 是设备记录的事件时间，日期部分即事件日期）：
      - None -> None（保持旧的今天分桶语义）
      - 可解析 ISO（含 tz-aware，datetime.fromisoformat 后取 date 部分）-> "YYYY-MM-DD"
      - 不可解析 -> None + 一条 warning，fail-soft 落今天桶
    """
    if t_iso is None:
        return None
    try:
        return datetime.fromisoformat(t_iso).date().isoformat()
    except ValueError:
        logger.warning("PC 事件 t_iso 无法解析，本次按今天分桶: %r", t_iso)
        return None


# ============ API 端点 ============


@router.post("/sync")
async def sync_pc_data(data: PcSyncRequest, request: Request):
    """接收 PC 感知数据并写入 perception.jsonl

    认证由 AuthMiddleware 处理（需 Bearer token）。
    将每条事件写入 perception.jsonl 文件。
    """
    if not data.events:
        return {"success": True, "count": 0}

    success_count = 0
    for event in data.events:
        try:
            entry = {
                "type": event.type,
                "t": event.t or _now_str(),
                "t_iso": event.t_iso or _now_iso(),
                "payload": _make_payload(event),
                "_source": "pc_sensor",
                "_agent_id": data.agent_id,
                "_agent_name": data.agent_name,
            }
            # date_str 必须由原始 event.t_iso 推导，绝不能用 entry["t_iso"]
            # （后者缺失时已兜底为 now，会把迟到事件错标成今天）。
            if append_perception(entry, auto_type=False,
                                 date_str=_event_date(event.t_iso)):
                success_count += 1
        except Exception as e:
            logger.warning("写入 PC 感知事件失败: %s", e)

    logger.info("PC 感知数据已接收: agent=%s(%s), 成功=%d/%d",
                data.agent_id, data.agent_name or "", success_count, len(data.events))

    return {"success": True, "count": success_count, "total": len(data.events)}
