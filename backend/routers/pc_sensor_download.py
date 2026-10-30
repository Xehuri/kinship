"""
PC 采集端下载路由 — 为设置页提供 Windows PC 采集器 (.exe) 的下载入口

安全措施：
- 走主后端 HTTPS 通道，必须认证（不在 PUBLIC_PATHS 中）
- 浏览器的 <a download> 无法携带 Authorization 头，因此本路径加入
  middleware.auth_middleware.QUERY_CREDENTIAL_PATH_PREFIXES，接受一次性 ?ticket=
  （POST /auth/ws-ticket 获取，30 秒过期，用后即焚）；同时也兼容 Authorization 头调用
- 文件不存在时返回 404 + 明确提示（该文件被 .gitignore 忽略，需自行构建）

路径来源：config.config.PC_SENSOR_EXE_PATH
（环境变量 PC_SENSOR_EXE_PATH > 配置 pc_sensor.exe_path > 默认 desktop/pc-sensor/dist/Kinship-PCSensor.exe）
"""

import asyncio
import hashlib
import logging
import os

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from config.config import get_config

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/pc-sensor", tags=["PC采集端下载"])

# 下载时返回的文件名（展示用；磁盘上的产物仍按技术标识命名）
DOWNLOAD_FILENAME = "Kinship-PCSensor.exe"

# 文件不存在时的统一提示
_NOT_BUILT_HINT = "PC 采集端未构建: 请在服务器上运行 desktop/pc-sensor/build.bat 生成采集端产物"


def get_exe_path() -> str:
    """PC 采集端 exe 路径（统一配置，支持 pc_sensor.exe_path 覆盖）"""
    return get_config().PC_SENSOR_EXE_PATH


def _format_size(size: int) -> str:
    """字节数转人类可读字符串（如 33.9 MB）"""
    if size <= 0:
        return ""
    value = float(size)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return f"{int(value)} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} GB"


def _sha256(path: str) -> str:
    """流式计算文件 SHA-256（分块读取，避免一次性载入约 34MB）"""
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


@router.get("/info")
async def pc_sensor_info():
    """
    查询 PC 采集端文件信息（供设置页展示文件大小）

    不计算 SHA-256（需全量读盘），仅在下载响应头中提供。
    """
    path = get_exe_path()
    if not os.path.isfile(path):
        logger.info(f"PC 采集端未构建: {path}")
        return {
            "exists": False,
            "filename": DOWNLOAD_FILENAME,
            "size": 0,
            "size_text": "",
            "mtime": 0,
            "sha256": None,
            "hint": _NOT_BUILT_HINT,
        }

    size = os.path.getsize(path)
    return {
        "exists": True,
        "filename": DOWNLOAD_FILENAME,
        "size": size,
        "size_text": _format_size(size),
        "mtime": int(os.path.getmtime(path)),
        "sha256": None,
    }


@router.get("/download")
async def download_pc_sensor():
    """
    下载 PC 采集端 exe

    认证方式：一次性票据 ?ticket=（浏览器 <a download>）或 Authorization: Bearer 头（脚本/curl）。
    """
    path = get_exe_path()
    if not os.path.isfile(path):
        logger.warning(f"PC 采集端下载失败, 文件不存在: {path}")
        raise HTTPException(status_code=404, detail=_NOT_BUILT_HINT)

    size = os.path.getsize(path)
    # 大文件哈希放入线程池，避免阻塞事件循环
    content_sha256 = await asyncio.to_thread(_sha256, path)

    logger.info(f"PC 采集端下载: {path} ({size} bytes)")

    return FileResponse(
        path=path,
        filename=DOWNLOAD_FILENAME,
        media_type="application/vnd.microsoft.portable-executable",
        headers={
            "X-File-Size": str(size),
            "X-File-SHA256": content_sha256,
            "Cache-Control": "no-store",
        },
    )
