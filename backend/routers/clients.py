# -*- coding: utf-8 -*-
"""客户端下载 API（T10）：引导目录与桌面端安装包下载。"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Query, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from starlette.concurrency import run_in_threadpool

import auth
from services import clients_catalog, config_authz

logger = logging.getLogger(__name__)

router = APIRouter(tags=["clients"])


def _unauthorized() -> JSONResponse:
    return JSONResponse(
        status_code=401, content={"detail": "未授权：请先登录"}
    )


async def _read_auth_error(request: Request) -> Optional[JSONResponse]:
    try:
        await config_authz.require_config_read(request)
    except config_authz.ConfigAuthError as exc:
        return config_authz.config_auth_error_response(exc)
    return None


def _download_user(request: Request, ticket: str) -> Optional[str]:
    user_id = getattr(request.state, "user_id", None)
    if user_id:
        return user_id
    if ticket:
        ok, ticket_user = auth.consume_ws_ticket(
            ticket, required_scope=auth.TICKET_SCOPE_DOWNLOAD
        )
        if ok:
            return ticket_user
    return None


@router.get("/api/system/onboarding/clients", response_model=None)
async def onboarding_clients(request: Request):
    auth_error = await _read_auth_error(request)
    if auth_error is not None:
        return auth_error
    return await run_in_threadpool(clients_catalog.catalog)


@router.get("/api/clients/desktop/download")
async def download_desktop(
    request: Request,
    ticket: str = Query("", description="一次性下载票据"),
):
    """下载桌面端安装包；本地产物优先，其次配置发行 URL，最后 404。"""
    user_id = _download_user(request, ticket)
    if not user_id:
        return _unauthorized()

    artifact = clients_catalog.inspect_local_desktop()
    if artifact is not None:
        path = Path(artifact.path)
        release_dir = Path(clients_catalog.desktop_release_dir())
        if not path.resolve().is_relative_to(release_dir.resolve()):
            logger.warning("拒绝越界的桌面端下载路径: %s", path)
            return JSONResponse(
                status_code=404, content={"detail": "桌面端安装包不存在"}
            )

        logger.info("桌面端下载: %s (%s bytes)", path.name, artifact.size)
        return FileResponse(
            path=str(path),
            filename=artifact.download_name,
            media_type="application/vnd.microsoft.portable-executable",
            headers={
                "X-File-Size": str(artifact.size),
                "X-File-SHA256": artifact.sha256,
                "Cache-Control": "no-store",
            },
        )

    configured_url = clients_catalog.get_config().CLIENTS_DESKTOP_URL.strip()
    if configured_url:
        return RedirectResponse(url=configured_url, status_code=302)
    return JSONResponse(status_code=404, content={"detail": "桌面端安装包不存在"})
