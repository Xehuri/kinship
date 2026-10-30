"""
OTA 更新路由 — 为 Axeuh 助手提供 APK 下载服务

安全措施：
- 走主后端 HTTPS 通道
- Token 认证（通过查询参数或 Authorization 头传递登录 token）
- 一次性下载票据（60 秒，用后即焚），避免长期 token 进入 URL
- 文件校验（Content-MD5 / 文件大小验证）
"""

import os
import hashlib
import logging
import time
from typing import Optional
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse
from auth import verify_token as verify_auth_token
import auth
from services import clients_catalog

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/ota", tags=["ota"])

from config.config import get_config

OTA_TICKET_TTL_SECONDS = 60


def get_ota_dir() -> str:
    """OTA 目录每次现读：环境变量优先，否则取当前配置 ota.apk_dir。"""
    env_dir = os.environ.get("OTA_FILE_DIR")
    if env_dir:
        return env_dir
    return get_config().OTA_APK_DIR


def get_apk_path() -> Optional[str]:
    """获取最新的 APK 文件路径"""
    ota_dir = get_ota_dir()
    if not os.path.isdir(ota_dir):
        logger.warning(f"OTA 目录不存在: {ota_dir}")
        return None

    apk_files = [f for f in os.listdir(ota_dir) if f.endswith(".apk")]
    if not apk_files:
        logger.warning(f"OTA 目录中没有 APK 文件: {ota_dir}")
        return None

    # 取最新修改的 APK
    latest = max(apk_files, key=lambda f: os.path.getmtime(os.path.join(ota_dir, f)))
    return os.path.join(ota_dir, latest)


def verify_token(token: Optional[str]) -> Optional[str]:
    """验证登录 token — 支持查询参数或 Authorization 头传入"""
    if not token:
        return None
    ok, uid = verify_auth_token(token)
    return uid if ok else None


def _request_user(
    request: Request, token: Optional[str], ticket: Optional[str]
) -> Optional[str]:
    """中间件已认证（Bearer 或一次性 ticket）时直接取身份，否则路由内自行校验。"""
    user_id = getattr(request.state, "user_id", None)
    if user_id:
        return user_id
    if ticket:
        ok, ticket_user = auth.consume_ws_ticket(
            ticket, required_scope=auth.TICKET_SCOPE_DOWNLOAD
        )
        if ok:
            return ticket_user
    return verify_token(token)


def _content_md5(path: str) -> str:
    md5_hash = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            md5_hash.update(chunk)
    return md5_hash.hexdigest()


@router.post("/ticket")
async def issue_download_ticket(request: Request):
    """签发一次性 APK 下载票据（Bearer 认证，60 秒内有效）。"""
    auth_header = request.headers.get("Authorization", "")
    header_token = auth_header[7:] if auth_header.startswith("Bearer ") else None
    user_id = getattr(request.state, "user_id", None) or verify_token(header_token)
    if not user_id:
        raise HTTPException(status_code=401, detail="未授权：请先登录")

    apk_path = get_apk_path()
    if not apk_path or not os.path.isfile(apk_path):
        raise HTTPException(status_code=404, detail="更新文件不存在")

    artifact = clients_catalog.inspect_apk_file(apk_path)
    filename = artifact.download_name if artifact else os.path.basename(apk_path)
    size = artifact.size if artifact else os.path.getsize(apk_path)
    sha256 = artifact.sha256 if artifact else clients_catalog.file_sha256(apk_path)
    source_filename = os.path.basename(apk_path)

    ticket, ttl = auth.create_ws_ticket(
        user_id,
        ttl_seconds=OTA_TICKET_TTL_SECONDS,
        scope=auth.TICKET_SCOPE_DOWNLOAD,
    )
    logger.info("OTA 票据签发: user=%s file=%s", user_id, filename)
    return {
        "ticket": ticket,
        "url": f"/api/ota/download?ticket={ticket}",
        "expires_at": int(time.time()) + ttl,
        "expires_in": ttl,
        "filename": filename,
        "source_filename": source_filename,
        "sha256": sha256,
        "size": size,
    }


@router.get("/download")
async def download_apk(
    request: Request,
    token: Optional[str] = Query(None, description="登录 Bearer Token（可从 Authorization 头传入）"),
    ticket: Optional[str] = Query(None, description="一次性下载票据"),
):
    """
    下载最新 APK

    认证方式（三选一）：
    1. 一次性票据: ?ticket=xxx（POST /api/ota/ticket 获取）
    2. 查询参数: ?token=xxx（兼容 App 旧实现）
    3. Authorization: Bearer xxx 头
    """
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        token = token or auth_header[7:]

    user_id = _request_user(request, token, ticket)
    if not user_id:
        raise HTTPException(status_code=401, detail="未授权：请先登录")
    logger.info(f"OTA 下载: user={user_id}")

    apk_path = get_apk_path()
    if not apk_path or not os.path.isfile(apk_path):
        raise HTTPException(status_code=404, detail="更新文件不存在")

    content_md5 = _content_md5(apk_path)
    file_size = os.path.getsize(apk_path)
    artifact = clients_catalog.inspect_apk_file(apk_path)
    file_name = artifact.download_name if artifact else os.path.basename(apk_path)

    logger.info(
        f"OTA 下载: {apk_path} ({file_size} bytes), "
        f"client: {request.client.host if request.client else 'unknown'}"
    )

    return FileResponse(
        path=apk_path,
        filename=file_name,
        media_type="application/vnd.android.package-archive",
        headers={
            "Content-MD5": content_md5,
            "X-File-Size": str(file_size),
            "X-Package-Name": "com.xehuri.kinship",
            "X-Source-Filename": os.path.basename(apk_path),
        }
    )


@router.get("/info")
async def ota_info():
    """OTA 服务器信息"""
    apk_path = get_apk_path()
    if apk_path:
        file_size = os.path.getsize(apk_path)
        file_mtime = os.path.getmtime(apk_path)
        artifact = clients_catalog.inspect_apk_file(apk_path)
        return {
            "status": "active",
            "apkFile": os.path.basename(apk_path),
            "filename": artifact.download_name if artifact else os.path.basename(apk_path),
            "version": artifact.version if artifact else None,
            "fileSize": file_size,
            "lastModified": file_mtime,
        }
    else:
        return {"status": "no_apk"}
