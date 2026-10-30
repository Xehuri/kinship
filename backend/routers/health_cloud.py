"""小米健康云路由：状态、开关、扫码登录、立即同步。

全部端点需 Bearer 认证（/api/health/* 不在 PUBLIC_PATHS）。
二维码只经本路由以 base64 返回，不落日志、不暴露文件路径。
"""

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from services.health_cloud_service import get_health_cloud_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/health/cloud", tags=["health-cloud"])


def _require_user_id(request: Optional[Request]) -> str:
    user_id = getattr(request.state, "user_id", None) if request is not None else None
    if not user_id:
        raise HTTPException(status_code=401, detail="缺少用户身份")
    return user_id


class EnableRequest(BaseModel):
    enabled: bool


class SyncRequest(BaseModel):
    days: Optional[int] = Field(default=None, ge=1, le=3650)


class QrPollRequest(BaseModel):
    lp: str


class LatestRequest(BaseModel):
    window_hours: int = Field(default=48, ge=1, le=720)


@router.get("/status")
def cloud_status(request: Request, probe: bool = False):
    _require_user_id(request)
    return get_health_cloud_service().status(probe=probe)


@router.post("/enable")
def cloud_enable(request: Request, body: EnableRequest):
    _require_user_id(request)
    service = get_health_cloud_service()
    service.set_enabled(body.enabled)
    return service.status()


@router.post("/qr")
def cloud_qr(request: Request):
    _require_user_id(request)
    try:
        return get_health_cloud_service().request_qr()
    except Exception as exc:
        logger.warning("小米云二维码申请失败: %s", exc)
        raise HTTPException(status_code=502, detail=f"二维码申请失败: {exc}")


@router.post("/qr/poll")
def cloud_qr_poll(request: Request, body: QrPollRequest):
    _require_user_id(request)
    try:
        # 设置页扫码成功后立即首拉，保持既有行为；引导路由则显式关闭首拉。
        return get_health_cloud_service().poll_qr_once(body.lp, start_pull=True)
    except Exception as exc:
        logger.warning("小米云扫码轮询失败: %s", exc)
        raise HTTPException(status_code=502, detail=f"扫码轮询失败: {exc}")


@router.post("/sync")
def cloud_sync(request: Request, body: SyncRequest):
    _require_user_id(request)
    result = get_health_cloud_service().backfill(body.days) if body.days else (
        get_health_cloud_service().pull_once()
    )
    if not result.get("ok"):
        raise HTTPException(status_code=502, detail=result.get("error") or "同步失败")
    return result


@router.post("/latest")
def cloud_latest(request: Request, body: LatestRequest):
    _require_user_id(request)
    return get_health_cloud_service().latest_cloud_samples(body.window_hours)
