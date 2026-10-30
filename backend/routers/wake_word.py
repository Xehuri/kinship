# -*- coding: utf-8 -*-
"""
唤醒词工具路由

把中文唤醒词编码为 sherpa-onnx KWS 所需的 token 串。

背景：sherpa-onnx KWS **不接受原始中文**，必须使用拼音 token 形式，
例如 `x iǎo h è t óng x ué @小贺同学`。端侧 App 允许用户输入中文唤醒词，
由本接口完成转换，再通过 `KeywordSpotter.createStream(keywords)` 覆盖内置词表。

K4d 接线：sherpa 编码已迁入内核 `POST /v1/kws/encode`（token 化在内核），
外层只保留业务副作用——词表文件写入、运行时目标词刷新、已加载模型失效；
模型目录仍读外层配置 `audio.wake_word.model_dir` 并随请求下发。

接口：
    - POST /api/screen/wake_word/encode   仅编码，返回 token 行（不落盘）
    - POST /api/screen/wake_word/keywords 编码并同步服务端词表 + 运行时目标词
"""

from typing import Any, Dict, List, Tuple
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
import logging
import os

from services import kernel_client
from services.kernel_client import (
    KernelHttpError,
    KernelUnavailable,
)
from core.errors import kernel_unavailable_response

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/screen/wake_word", tags=["wake-word"])

# 唤醒词分隔符（与项目其它多值配置保持一致）
_SEPARATORS = [",", "，", "\n", ";", "；"]


class EncodeRequest(BaseModel):
    """中文唤醒词编码请求。多个词可用逗号 / 换行 / 分号分隔。"""

    text: str = Field(..., description="唤醒词文本，如 小贺同学")


class EncodedKeyword(BaseModel):
    """单个唤醒词的编码结果。"""

    text: str = Field(..., description="原始中文")
    line: str = Field(..., description="可直接写入 keywords.txt 的整行")


class EncodeResponse(BaseModel):
    """编码响应。"""

    ok: bool
    keywords: str = Field("", description="多行合并结果，可直接作为 createStream(keywords) 入参")
    items: List[EncodedKeyword] = Field(default_factory=list)
    message: str = ""


def _split_keywords(raw: str) -> List[str]:
    """按多种分隔符拆分唤醒词，去空白并保序去重。"""
    parts = [raw]
    for sep in _SEPARATORS:
        nxt: List[str] = []
        for p in parts:
            nxt.extend(p.split(sep))
        parts = nxt
    out: List[str] = []
    for p in parts:
        p = p.strip()
        if p and p not in out:
            out.append(p)
    return out


def _kernel_error_message(exc: KernelHttpError) -> str:
    """提取内核业务错误的 message（封闭错误体 {"error":{...}} 原文透传给客户端）。"""
    body = exc.body
    if isinstance(body, dict):
        err = body.get("error")
        if isinstance(err, dict) and err.get("message"):
            return str(err["message"])
    return str(body)


async def _encode_pairs(texts: List[str]) -> Tuple[List[Tuple[str, str]], str]:
    """经内核把中文唤醒词编码为 (原文, 词表行) 列表。

    成功返回 ``(pairs, "")``，业务失败返回 ``([], 错误信息)``；
    内核断连抛 ``KernelUnavailable``（调用方映射 503 state.unavailable）。
    模型目录取自 ``audio.wake_word.model_dir``（外层配置，随请求下发），
    文件存在性与 sherpa 可用性检查都在内核侧（封闭码 model.unavailable）。
    """
    from services.audio_config import get_audio_config, resolve_path

    cfg = get_audio_config().get("wake_word") or {}
    model_dir = cfg.get("model_dir") or ""
    if not model_dir:
        return [], "未配置 audio.wake_word.model_dir"

    model_dir = resolve_path(model_dir)
    # 经模块属性取单例（同 speakers.py 惯例），保证测试可打桩 kc.get_kernel_client
    envelope = await kernel_client.get_kernel_client().arequest(
        "POST",
        "/v1/kws/encode",
        json={"keywords": texts, "model_dir": model_dir},
    )
    facts = (envelope or {}).get("facts") or {}
    kws = list(facts.get("keywords") or [])
    lines = list(facts.get("lines") or [])
    pairs: List[Tuple[str, str]] = [
        (t, l) for t, l in zip(kws, lines) if l
    ]
    if not pairs:
        return [], "编码结果为空，请检查唤醒词文本"
    return pairs, ""


@router.post("/encode", response_model=EncodeResponse)
async def encode_keywords(req: EncodeRequest):
    """
    把中文唤醒词编码为 KWS token（拼音按声母/韵母二级切分）。

    编码经内核 `POST /v1/kws/encode`；模型路径来自 `config.yaml` 的
    `audio.wake_word.model_dir`。内核断连 -> 503 state.unavailable
    （交互编码必须拿到 token 或明确错误，不做降级跳过）。
    """
    texts = _split_keywords(req.text)
    if not texts:
        return EncodeResponse(ok=False, message="未提供唤醒词文本")

    try:
        pairs, err = await _encode_pairs(texts)
    except KernelUnavailable as e:
        return kernel_unavailable_response(e)
    except KernelHttpError as e:
        # 内核业务错误（模型缺失/编码失败）-> 保持既有 200 ok=false 形状
        return EncodeResponse(ok=False, message=_kernel_error_message(e))
    if err:
        return EncodeResponse(ok=False, message=err)

    items = [EncodedKeyword(text=t, line=l) for t, l in pairs]
    lines = [l for _, l in pairs]
    logger.info(f"[WakeWordEncode] {texts} -> {len(lines)} 条 token")
    return EncodeResponse(ok=True, keywords="\n".join(lines), items=items)


class SyncKeywordsRequest(BaseModel):
    """同步唤醒词表请求。多个词可用逗号 / 换行 / 分号分隔。"""

    keywords: str = Field("", description="唤醒词文本，如 小贺同学")


class SyncKeywordsResponse(BaseModel):
    """同步唤醒词表响应。"""

    ok: bool
    keywords: List[str] = Field(
        default_factory=list, description="写入词表的整行（拼音 token @中文）"
    )
    target: str = Field("", description="运行时主唤醒词（中文）")
    message: str = ""


def _sync_payload(ok: bool, lines: List[str], target: str, message: str) -> Dict[str, Any]:
    """构造统一响应体（错误分支经 JSONResponse 返回 4xx/5xx）。"""
    return {"ok": ok, "keywords": lines, "target": target, "message": message}


@router.post("/keywords", response_model=SyncKeywordsResponse)
async def sync_keywords(req: SyncKeywordsRequest):
    """
    同步唤醒词表：编码 -> 覆盖写入 keywords_file -> 更新运行时目标词 -> 失效 KWS 模型。

    词表路径取自 ``audio.wake_word.keywords_file``（空 = ``<AI_ROOT>/data/wake_word/keywords.txt``）。
    写入后已加载的 KWS 模型会被失效，下次音频流连接按新词表惰性重建；本接口不重启
    进程、不做同步重载，因此不阻塞音频主链路。空词表 / 编码失败返回 400。
    """
    texts = _split_keywords(req.keywords)
    if not texts:
        return JSONResponse(
            status_code=400, content=_sync_payload(False, [], "", "唤醒词为空")
        )

    # 编码在内核完成；词表写入/目标词刷新/模型失效是外层业务副作用，保持不变。
    # 写词表必须先有 token 行 -> 内核断连时无法写文件，503 是正确语义（不可降级）。
    try:
        pairs, err = await _encode_pairs(texts)
    except KernelUnavailable as e:
        return kernel_unavailable_response(e)
    except KernelHttpError as e:
        return JSONResponse(
            status_code=400,
            content=_sync_payload(False, [], "", _kernel_error_message(e)),
        )
    if err:
        return JSONResponse(
            status_code=400, content=_sync_payload(False, [], "", err)
        )

    lines = [line for _, line in pairs]
    labels = [text for text, _ in pairs]

    # 词表路径与 KWS 加载共用同一配置键，空值由 audio_config 按 AI_ROOT 派生
    from config.config import get_config
    from services.audio_config import get_audio_config, resolve_path

    cfg = get_audio_config().get("wake_word") or {}
    keywords_file = cfg.get("keywords_file") or os.path.join(
        get_config().AI_ROOT, "data", "wake_word", "keywords.txt"
    )
    path = resolve_path(keywords_file)

    # 覆盖写入（临时文件 + 原子替换），UTF-8，每行一个词
    try:
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        tmp_path = path + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        os.replace(tmp_path, path)
    except OSError as e:
        logger.error(f"[WakeWordEncode] 写入词表失败: {e}", exc_info=True)
        return JSONResponse(
            status_code=500, content=_sync_payload(False, [], "", f"写入词表失败: {e}")
        )

    # 更新运行时目标词（KWS 在内核 /v1/stream，新词表在下一次建连自然生效）
    try:
        from services import wake_word_service

        effective = wake_word_service.set_target_keywords(labels)
    except Exception as e:
        logger.error(f"[WakeWordEncode] 更新运行时唤醒词失败: {e}", exc_info=True)
        return JSONResponse(
            status_code=500,
            content=_sync_payload(False, [], "", f"更新运行时唤醒词失败: {e}"),
        )

    target = effective[0] if effective else (labels[0] if labels else "")
    logger.info(
        f"[WakeWordEncode] 词表已同步 ({len(lines)} 条) target={target} file={path}"
    )
    return SyncKeywordsResponse(
        ok=True,
        keywords=lines,
        target=target,
        message=f"已更新唤醒词表并刷新运行时目标词（{len(lines)} 个）",
    )
