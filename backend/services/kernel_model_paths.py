# -*- coding: utf-8 -*-
"""内核模型目录与缓存环境变量解析（模型下载器与内核 spawn 共用）。

模型根下的目录布局与"伪 HOME"一致::

    <models_root>/.cache/modelscope
    <models_root>/.cache/huggingface/hub
    <models_root>/.cache/axeuh-kernel/models
    <models_root>/.cache/torch

优先级（spawn 与下载子进程相同）：

1. ``AXEUH_KERNEL_MODEL_DIR``：显式 ``kernel.model_dir`` 覆盖一切；未配置时
   保留调用方环境里的非空值；都没有则用默认模型目录。
2. 其余键（含 ``AXEUH_KERNEL_MODEL_DOWNLOAD_DIR``）：调用方环境里的非空值
   优先（运维显式接管），否则用 ``<models_root>/.cache/...`` 默认值。

空白环境值视同未设置；默认目录在调用期按 ``config.paths.models_root()``
解析，不做 import 快照。
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Mapping

from config.paths import models_root, project_root

KERNEL_MODEL_DIR_ENV = "AXEUH_KERNEL_MODEL_DIR"
KERNEL_MODEL_DOWNLOAD_DIR_ENV = "AXEUH_KERNEL_MODEL_DOWNLOAD_DIR"


def default_model_dir() -> Path:
    """默认内核模型目录：``<models_root>/.cache/axeuh-kernel/models``。"""
    return (models_root() / ".cache" / "axeuh-kernel" / "models").resolve()


def cache_env_defaults() -> "dict[str, Path]":
    """模型下载/推理进程应继承的缓存目录默认值。"""
    cache = models_root() / ".cache"
    huggingface = cache / "huggingface"
    return {
        "MODELSCOPE_CACHE": cache / "modelscope",
        "HF_HOME": huggingface,
        "HF_HUB_CACHE": huggingface / "hub",
        "HUGGINGFACE_HUB_CACHE": huggingface / "hub",
        "TRANSFORMERS_CACHE": huggingface / "hub",
        "TORCH_HOME": cache / "torch",
    }


def _absolute_model_dir(raw: str | Path) -> Path:
    path = Path(raw).expanduser()
    if not path.is_absolute():
        path = project_root() / path
    return Path(os.path.abspath(path))


def apply_model_env(
    env: Mapping[str, str], *, model_dir: str | Path | None = None
) -> "dict[str, str]":
    """返回注入模型缓存变量后的新环境字典（不修改入参）。

    ``model_dir`` 是配置层 ``kernel.model_dir`` 的显式覆盖；它只作用于
    ``AXEUH_KERNEL_MODEL_DIR``，下载目录与其它缓存固定落在 ``models_root()``。
    """
    result = dict(env)
    default = default_model_dir()

    configured = str(model_dir).strip() if model_dir is not None else ""
    if configured:
        result[KERNEL_MODEL_DIR_ENV] = str(_absolute_model_dir(configured))
    elif not result.get(KERNEL_MODEL_DIR_ENV, "").strip():
        result[KERNEL_MODEL_DIR_ENV] = str(default)

    if not result.get(KERNEL_MODEL_DOWNLOAD_DIR_ENV, "").strip():
        result[KERNEL_MODEL_DOWNLOAD_DIR_ENV] = str(default)

    for key, path in cache_env_defaults().items():
        if not result.get(key, "").strip():
            result[key] = str(path)
    return result


__all__ = [
    "KERNEL_MODEL_DIR_ENV",
    "KERNEL_MODEL_DOWNLOAD_DIR_ENV",
    "apply_model_env",
    "cache_env_defaults",
    "default_model_dir",
]
