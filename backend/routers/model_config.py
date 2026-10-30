from __future__ import annotations

from typing import Any, Dict, List, Optional
import json
import logging
import os

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services import opencode_client
# 双通道工厂：模型目录按 ai_backend 择路上游（opencode /config/providers 或 loom /catalog/models）
from services.ai_client_factory import acquire_ai_client as acquire_opencode_client
from services.web_backend_selector import acquire_web_client, get_web_backend


logger = logging.getLogger(__name__)


# === 模型配置管理 ===
# V5 收敛：读写与缓存全部走 services.opencode_client 单一实现，
# 写路径 = client 读取的 config 驱动真源路径（config.MODEL_CONFIG_PATH）。
# 本模块不再保留任何本地缓存/路径副本（原 CONFIG_PATH/_load_model_cache/
# load_model_config/reset_model_config_cache 四件套与 client 实现同名分裂，
# 曾导致 POST 写入的文件 client 永远读不到——计划 F3 语义漂移）。
# V6 拍扁：默认值直接取 client 模块级常量（原 gateway 构造期快照与其等值）。
OPENCODE_DEFAULT_MODEL = opencode_client.OPENCODE_DEFAULT_MODEL
OPENCODE_DEFAULT_PROVIDER = opencode_client.OPENCODE_DEFAULT_PROVIDER


router = APIRouter(prefix="/api/screen")


class ModelItem(BaseModel):
    id: str
    name: str


class ProviderItem(BaseModel):
    id: str
    name: str
    models: List[ModelItem]


class CurrentModel(BaseModel):
    model: str
    provider: str


class GetModelResponse(BaseModel):
    success: bool
    current: CurrentModel
    providers: List[ProviderItem]


class SetModelRequest(BaseModel):
    model: str
    provider: str


class ModelContextWindowResponse(BaseModel):
    success: bool
    backend: str
    model: Optional[str] = None
    provider: Optional[str] = None
    contextWindow: Optional[int] = None


def _build_providers_map(providers: Any) -> Dict[str, Dict[str, Any]]:
    """gateway provider 清单 -> {provider_id: ProviderItem dict}（GET/POST 共用）。"""
    providers_map: Dict[str, Dict[str, Any]] = {}
    if not isinstance(providers, list):
        return providers_map
    for pv in providers:
        if not isinstance(pv, dict):
            continue
        provider_id: str = pv.get("id") or ""
        provider_name: str = pv.get("name") or provider_id
        model_list = pv.get("models") or []
        if not provider_id:
            continue
        providers_map[provider_id] = {
            "id": provider_id,
            "name": provider_name,
            "models": [
                ModelItem(id=m["id"], name=m.get("name") or m["id"])
                for m in model_list if isinstance(m, dict) and m.get("id")
            ]
        }
    return providers_map


async def _fetch_providers() -> Any:
    client = await acquire_opencode_client()
    models_result = await client.get_available_models()
    if models_result.get("ok"):
        return models_result["data"].get("providers", [])
    return []


@router.get("/model", response_model=GetModelResponse, tags=["model_config"])
async def get_model_config():
    # 获取可用模型信息，按 provider 分组
    providers = await _fetch_providers()
    providers_map = _build_providers_map(providers)

    current_cfg = opencode_client.load_model_config()
    # 注意：load_model_config() 文件不存在时返回 {}，而 {} 也是 dict，会走进前半支并 .get() 出 None。
    # 因此兜底必须放在 or 之后，否则 current.model 为 None，撞上响应模型的必填 str 会抛 ResponseValidationError(500)。
    current_model = (
        current_cfg.get("default_model") if isinstance(current_cfg, dict) else None
    ) or OPENCODE_DEFAULT_MODEL
    current_provider = (
        current_cfg.get("default_provider") if isinstance(current_cfg, dict) else None
    ) or OPENCODE_DEFAULT_PROVIDER

    # 构造返回结构
    current_out = {"model": current_model, "provider": current_provider}
    providers_final = list(providers_map.values())

    return {"success": True, "current": current_out, "providers": providers_final}


@router.get(
    "/model/context-window",
    response_model=ModelContextWindowResponse,
    tags=["model_config"],
)
async def get_model_context_window():
    """当前 Web 通道主模型的上下文窗口；任何失败都返回 200 + 全 null（纯展示增量）。"""
    backend = get_web_backend()
    data: Any = None
    try:
        client = await acquire_web_client()
        resolver = getattr(client, "get_active_model_context_window", None)
        if resolver is not None:
            data = await resolver()
    except Exception as e:
        logger.debug(f"获取 Web 通道模型上下文窗口失败: backend={backend} err={e}")
    if not isinstance(data, dict):
        data = {}
    return {
        "success": True,
        "backend": backend,
        "model": data.get("model"),
        "provider": data.get("provider"),
        "contextWindow": data.get("contextWindow"),
    }


@router.post("/model", response_model=GetModelResponse, tags=["model_config"])
async def set_model_config(req: SetModelRequest):
    # 校验传入的模型与提供商是否存在于当前可用模型中
    providers = await _fetch_providers()
    valid = False
    if isinstance(providers, list):
        for prov in providers:
            for mdl in prov.get("models", []):
                if prov.get("id") == req.provider and mdl.get("id") == req.model:
                    valid = True
                    break

    if not valid:
        raise HTTPException(status_code=400, detail="Invalid model or provider")

    # 保存到 client 读取的单一真源路径
    config_path = opencode_client.model_config_path()
    data = {"default_model": req.model, "default_provider": req.provider}
    try:
        parent = os.path.dirname(config_path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(config_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save model config: {str(e)}")

    # 清除 client 缓存，让后续 load_model_config() 重新读取文件
    # （真失效：修复改前"router 清自己的缓存、client 缓存纹丝不动"的漂移）
    opencode_client.reset_model_config_cache()

    # 返回更新后的当前配置
    current_out = {"model": req.model, "provider": req.provider}

    return {"success": True, "current": current_out, "providers": list(_build_providers_map(providers).values())}
