"""
维护管理路由 - Cohort 队列管理（B4：全部经内核 /v1/voiceprint/cohort/*）

数据源迁移说明（2026-09-24，外层 Wave B4）：
  - cohort 的唯一真相源已迁入内核 state-dir（{state}/voiceprint/cohort_{active,audit}.jsonl）；
    外层 ai/data/cache/cohort_*.jsonl 为 9-22 断供后的历史归档（C 波处理），本路由不再读取。
  - 三个端点转发内核 A6 交付的 /v1/voiceprint/cohort/{reload,compact,stats}，
    外层 HTTP 响应 JSON 形状保持向后兼容（键名与文案不变，值映射自内核 facts）。
  - 内核不可达 -> 503 {"error":{"code":"state.unavailable",...}}（对齐 speakers.py 错误面）；
    内核业务错误（4xx/5xx 封闭码）原样透传。

响应字段映射（内核 facts -> 外层形状）：
  - reload:  facts {reloaded, count}                    -> {success, active, message}
  - compact: facts {active_count, audit_count, kept,
                    dropped_rejected, before}           -> {success, active, total_audit,
                                                            message, dropped_rejected, before}
  - stats:   facts {active, buffer}（内核 write-through 采集，buffer 恒 0）
                                                        -> {active, buffer}（原样）
"""

import logging

from fastapi import APIRouter

from services import kernel_client
from services.kernel_client import KernelHttpError, KernelUnavailable
from core.errors import kernel_http_response, kernel_unavailable_response

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/admin")

# 管理操作（compact 涉及全量 audit 重扫 + O(n^2) 多样性贪心，留足余量）
_COMPACT_TIMEOUT = 60.0
_LIGHT_TIMEOUT = 15.0


def _facts(result: object) -> dict:
    """从内核信封 {schema_version, facts, provenance} 取 facts（防御非 dict）。"""
    facts = (result or {}).get("facts") if isinstance(result, dict) else None
    return facts if isinstance(facts, dict) else {}


@router.post("/cohort/reload")
async def cohort_reload():
    """热更新声纹冒名者队列（转内核 POST /v1/voiceprint/cohort/reload）。

    内核每次调用即读盘重建工作集（幂等），本端点语义 = 确认与内核 state-dir
    磁盘一致并回显计数。

    Returns:
        {"success": true, "active": 100, "message": "队列已热更新: 100 条"}
    """
    try:
        result = kernel_client.get_kernel_client().srequest(
            "POST", "/v1/voiceprint/cohort/reload", timeout=_LIGHT_TIMEOUT
        )
    except KernelUnavailable as e:
        logger.error(f"[Admin] cohort 热更新失败（内核不可达）: {e}")
        return kernel_unavailable_response(e)
    except KernelHttpError as e:
        logger.error(f"[Admin] cohort 热更新失败（内核错误）: {e}")
        return kernel_http_response(e)

    facts = _facts(result)
    count = int(facts.get("count") or 0)
    return {
        "success": bool(facts.get("reloaded", True)),
        "active": count,
        "message": f"队列已热更新: {count} 条",
    }


@router.post("/cohort/compact")
async def cohort_compact():
    """手动触发队列压缩（转内核 POST /v1/voiceprint/cohort/compact）。

    内核数学与外层原 compaction 一致：读 audit 全量 -> 过滤 rejected ->
    select_active（reviewed 优先/时间倒序/sim 升序 + 按天配额 + 多样性贪心,
    上限 500）-> 原子重写 active。

    Returns:
        {"success": true, "active": 500, "total_audit": 1523, "message": "压缩完成: 活跃 500 条",
         "dropped_rejected": 12, "before": 500}

    注：total_audit 取内核 facts.audit_count（audit 全量条数）。旧外层实现误取
    内存 buffer 计数（语义偏差），本次一并纠正为真实审计总数。
    """
    try:
        result = kernel_client.get_kernel_client().srequest(
            "POST", "/v1/voiceprint/cohort/compact", timeout=_COMPACT_TIMEOUT
        )
    except KernelUnavailable as e:
        logger.error(f"[Admin] cohort 压缩失败（内核不可达）: {e}")
        return kernel_unavailable_response(e)
    except KernelHttpError as e:
        logger.error(f"[Admin] cohort 压缩失败（内核错误）: {e}")
        return kernel_http_response(e)

    facts = _facts(result)
    active_count = int(facts.get("active_count") or facts.get("kept") or 0)
    audit_count = int(facts.get("audit_count") or 0)
    return {
        "success": True,
        "active": active_count,
        "total_audit": audit_count,
        "message": f"压缩完成: 活跃 {active_count} 条",
        # 内核专属增量信息（旧外层无此数据，供运维观察；消费方按 key 取用不受影响）
        "dropped_rejected": int(facts.get("dropped_rejected") or 0),
        "before": int(facts.get("before") or 0),
    }


@router.get("/cohort/stats")
async def cohort_stats():
    """获取队列统计（转内核 GET /v1/voiceprint/cohort/stats）。

    内核 write-through 采集（每条直接落 audit+active，无外层 FLUSH_BATCH 攒批
    缓冲），故 buffer 恒 0；active = 工作集条数。

    Returns:
        {"active": 500, "buffer": 0}
    """
    try:
        result = kernel_client.get_kernel_client().srequest(
            "GET", "/v1/voiceprint/cohort/stats", timeout=_LIGHT_TIMEOUT
        )
    except KernelUnavailable as e:
        logger.error(f"[Admin] cohort 统计失败（内核不可达）: {e}")
        return kernel_unavailable_response(e)
    except KernelHttpError as e:
        logger.error(f"[Admin] cohort 统计失败（内核错误）: {e}")
        return kernel_http_response(e)

    facts = _facts(result)
    return {
        "active": int(facts.get("active") or 0),
        "buffer": int(facts.get("buffer") or 0),
    }
