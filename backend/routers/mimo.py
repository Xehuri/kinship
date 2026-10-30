"""MiMo 音频拉取专用端点

只暴露 ai/data/cache/mimo_audio/ 临时目录下的文件，供 MiMo API 通过公网 URL 拉取。
安全设计:
- 专用请求路径 /api/mimo/audio/{filename}，与通用文件接口隔离
- 只读 cache/mimo_audio/ 临时目录，realpath + commonpath 严格防目录穿越
- 短 TTL 签名 URL（HMAC-SHA256 + exp），签名/过期不符一律拒绝，
  不再依赖"随机文件名保密"
"""

import os
import logging

from fastapi import APIRouter, HTTPException
from starlette.responses import Response

from config.config import get_config
from mimo_signing import verify_signed_params

logger = logging.getLogger(__name__)

router = APIRouter(tags=["mimo"])

# 临时音频目录（相对 ai/data/）：脚本复制待分析音频到这里，分析后清理
MIMO_TMP_REL = os.path.join("cache", "mimo_audio")

_MEDIA_TYPES = {
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
}


def _resolve_audio_path(filename: str) -> str:
    """把文件名解析为临时目录内的绝对路径。

    使用 realpath + os.path.commonpath 严格校验：目标必须位于
    cache/mimo_audio/ 内，防止 `..` 或前缀同名目录绕过。
    """
    tmp_dir = os.path.join(get_config().DATA_DIR, MIMO_TMP_REL)
    tmp_root = os.path.realpath(tmp_dir)
    abs_path = os.path.realpath(os.path.join(tmp_dir, filename))
    try:
        common = os.path.commonpath([tmp_root, abs_path])
    except ValueError:
        # 不同盘符等情况视为越界
        common = None
    if common != tmp_root:
        raise HTTPException(status_code=403, detail="路径越界")
    return abs_path


@router.get("/mimo/audio/{filename}")
async def get_mimo_audio(filename: str, exp: str | None = None, sig: str | None = None):
    """返回 cache/mimo_audio/ 下的音频文件（短 TTL 签名 URL，免 token）

    exp/sig 由 mimo_signing.build_signed_path 生成：
      - 签名缺失或错误 -> 403
      - 签名有效但已过期 -> 410
    文件名仅允许 [A-Za-z0-9._-] 字符，防路径穿越。
    """
    if not filename or not all(c.isalnum() or c in "._-" for c in filename):
        raise HTTPException(status_code=400, detail="非法文件名")

    reason = verify_signed_params(filename, exp, sig)
    if reason == "expired":
        raise HTTPException(status_code=410, detail="链接已过期")
    if reason:
        raise HTTPException(status_code=403, detail="签名无效")

    abs_path = _resolve_audio_path(filename)

    if not os.path.isfile(abs_path):
        raise HTTPException(status_code=404, detail="文件不存在")

    ext = os.path.splitext(abs_path)[1].lower()
    media_type = _MEDIA_TYPES.get(ext, "application/octet-stream")

    try:
        with open(abs_path, "rb") as f:
            content = f.read()
        return Response(content=content, media_type=media_type)
    except OSError as e:
        logger.error(f"读取 MiMo 临时音频失败 {abs_path}: {e}")
        raise HTTPException(status_code=500, detail="读取文件失败")
