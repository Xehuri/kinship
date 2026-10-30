# -*- coding: utf-8 -*-
"""引导期密钥文件原子写入。

目录固定 0700、文件固定 0600；内容只经同目录临时文件 fsync 后
``os.replace`` 落盘，失败清理临时文件，绝不留半截目标文件，也不记录内容。
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path


def ensure_private_directory(directory: Path | str) -> Path:
    """创建目录（含父级）并收紧到 0700，返回绝对路径。"""
    target = Path(directory)
    target.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(target, 0o700)
    return target.resolve()


def secrets_directory(data_root: Path | str) -> Path:
    """返回 ``<data_root>/secrets`` 并确保其存在且权限为 0700。"""
    return ensure_private_directory(Path(data_root) / "secrets")


def write_secret(
    path: Path | str, payload: str | bytes, *, mode: int = 0o600
) -> Path:
    """原子写入密钥文件，返回目标绝对路径。

    ``payload`` 为文本时按 UTF-8 编码；父目录不存在时按 0700 创建。
    写入过程不记录任何内容；异常时仅清理临时文件，目标文件保持原状。
    """
    target = Path(path)
    directory = ensure_private_directory(target.parent)
    data = payload.encode("utf-8") if isinstance(payload, str) else bytes(payload)

    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{target.name}.", suffix=".tmp", dir=str(directory)
    )
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp_name, mode)
        os.replace(tmp_name, target)
        _fsync_directory(directory)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise
    return target.resolve()


def read_secret(path: Path | str) -> str:
    """读取密钥文本；不存在、不可读或非 UTF-8 时返回空串。"""
    try:
        return Path(path).read_text(encoding="utf-8").strip()
    except (OSError, UnicodeDecodeError):
        return ""


def _fsync_directory(directory: Path) -> None:
    if os.name != "posix":
        return
    try:
        fd = os.open(str(directory), os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)
