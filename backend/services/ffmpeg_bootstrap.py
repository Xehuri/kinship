# -*- coding: utf-8 -*-
"""把 imageio-ffmpeg wheel 自带的 ffmpeg 按需落地到本地 bin 目录。

首次调用从 ``imageio_ffmpeg.get_ffmpeg_exe()`` 复制一次；之后命中已落地文件，
不重复复制。``AXEUH_FFMPEG_BIN_DIR`` 可改写落地目录（安装器/测试/只读部署用）。
缺少 wheel 或复制失败时抛 ``FFmpegMissing``，错误信息以 ``ffmpeg_missing`` 开头。
"""
from __future__ import annotations

import importlib
import logging
import os
import shutil
import sys
import uuid
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

BIN_DIR_ENV = "AXEUH_FFMPEG_BIN_DIR"


class FFmpegMissing(RuntimeError):
    """ffmpeg 既未落地也无法从 imageio-ffmpeg 取得。"""


def _default_bin_dir() -> Path:
    return Path(__file__).resolve().parent.parent / "bin"


def _resolve_bin_dir(bin_dir: str | Path | None) -> Path:
    if bin_dir is not None:
        return Path(bin_dir)
    override = os.environ.get(BIN_DIR_ENV, "").strip()
    return Path(override) if override else _default_bin_dir()


def _binary_name() -> str:
    return "ffmpeg.exe" if sys.platform == "win32" else "ffmpeg"


def _load_imageio_ffmpeg(module: Any | None, bin_dir: Path) -> Any:
    if module is not None:
        return module
    try:
        return importlib.import_module("imageio_ffmpeg")
    except Exception as exc:
        raise FFmpegMissing(
            "ffmpeg_missing: Python 包 imageio-ffmpeg 不可用 "
            f"({exc.__class__.__name__}: {exc}); 请安装 imageio-ffmpeg>=0.6.0 "
            f"或把 ffmpeg 放到 {bin_dir}"
        ) from exc


def _copy_into_place(source: Path, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(f"{dest.name}.tmp-{os.getpid()}-{uuid.uuid4().hex[:8]}")
    try:
        shutil.copy2(source, tmp)
        if sys.platform != "win32":
            os.chmod(tmp, 0o755)
        os.replace(tmp, dest)
    finally:
        tmp.unlink(missing_ok=True)


def ensure_ffmpeg(
    *,
    bin_dir: str | Path | None = None,
    imageio_ffmpeg_module: Any | None = None,
) -> Path:
    """返回可执行的 ffmpeg 路径，必要时从 wheel 复制到 ``bin_dir``。"""
    target_dir = _resolve_bin_dir(bin_dir)
    dest = target_dir / _binary_name()
    if dest.is_file() and os.access(dest, os.X_OK):
        return dest

    module = _load_imageio_ffmpeg(imageio_ffmpeg_module, target_dir)
    try:
        source = Path(module.get_ffmpeg_exe())
    except Exception as exc:
        raise FFmpegMissing(
            f"ffmpeg_missing: imageio-ffmpeg 未提供可用二进制 ({exc})"
        ) from exc
    if not source.is_file():
        raise FFmpegMissing(
            f"ffmpeg_missing: imageio-ffmpeg 指向的路径不存在: {source}"
        )

    try:
        _copy_into_place(source, dest)
    except OSError as exc:
        raise FFmpegMissing(f"ffmpeg_missing: 复制 ffmpeg 到 {dest} 失败 ({exc})") from exc

    try:
        if sys.platform != "win32":
            os.chmod(dest, 0o755)
    except OSError as exc:
        raise FFmpegMissing(
            f"ffmpeg_missing: 落地后的 ffmpeg 无法设为可执行: {dest} ({exc})"
        ) from exc
    if not os.access(dest, os.X_OK):
        raise FFmpegMissing(f"ffmpeg_missing: 落地后的 ffmpeg 不可执行: {dest}")
    logger.info("[ffmpeg_bootstrap] 已从 %s 落地 ffmpeg -> %s", source, dest)
    return dest
