"""
健康数据 API 路由

端点:
- POST /api/health/sync - App 上传健康数据（可选 source/device_id/date，H5 源选择）
- GET /api/health/query?date=YYYY-MM-DD - 查询某天数据
"""

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from typing import Literal, Optional, List, Dict, Any, Union
import logging
import json

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/health", tags=["health"])


def _require_user_id(request: Optional[Request]) -> str:
    """取中间件注入的认证 user_id；缺失即 401 拒绝（H6，架构 §5.5 / 风险 7）。

    /api/health/* 不在 PUBLIC_PATHS（auth_middleware.py 精确匹配白名单），
    AuthMiddleware 鉴权通过后必于 auth_middleware.py L117 注入
    request.state.user_id —— 正常 HTTP 请求恒有值。缺失只可能是绕过中间件
    的异常调用（直接函数调用 / 注入失效），此时显式 401 拒绝，
    绝不静默降级写入 users/default/（多用户物理隔离，A5 验收锁定）。
    """
    user_id = (
        getattr(request.state, "user_id", None) if request is not None else None
    )
    if not user_id:
        raise HTTPException(
            status_code=401,
            detail="缺少用户身份（user_id 未注入），拒绝访问健康数据",
        )
    return user_id


# ============ 运行时源选择（H5，架构文档 §8） ============

def _selection_path() -> str:
    """运行时源选择文件：config.HEALTH_SOURCE_SELECTION_PATH
    （默认 backend/data/health_source_selection.json，V14 收编原文件位上溯硬编码）。

    结构 {user_id: {primary, mode}}；测试 monkeypatch 本函数重定向到 tmp_path。
    """
    from config.config import get_config
    return get_config().HEALTH_SOURCE_SELECTION_PATH


def _load_selection() -> Dict[str, Any]:
    """读取运行时源选择；缺失/损坏按空处理（回落 config 默认）。"""
    try:
        with open(_selection_path(), encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def _effective_selection(user_id: str) -> tuple:
    """当前用户的生效选择 (primary, mode)：运行时文件 > config 默认。

    供活端点 /sync 的 exclusive 模式判定使用；运行时选择文件仅可经
    本函数读取（历史 PUT 写入端点已随旁路清理删除）。
    """
    from config.config import get_config
    cfg = get_config()
    entry = _load_selection().get(user_id)
    if not isinstance(entry, dict):
        entry = {}
    primary = entry.get("primary") or cfg.HEALTH_DEFAULT_SOURCE
    mode = entry.get("mode") or cfg.HEALTH_SOURCE_MODE
    return primary, mode


# ============ 数据模型 ============

class SamplePoint(BaseModel):
    """单个采样点"""
    t: int = Field(..., description="Unix 时间戳(秒)")
    hr: Optional[int] = Field(None, ge=0, le=250)
    steps: Optional[int] = Field(None, ge=0)
    stress: Optional[int] = Field(None, ge=0, le=255)
    spo2: Optional[int] = Field(None, ge=0, le=100)


class BatteryPoint(BaseModel):
    t: int
    level: int = Field(..., ge=0, le=100)


class DailySummary(BaseModel):
    steps: Optional[int] = None
    total_steps: Optional[int] = Field(None, description="日总步数（云源日总增量求和口径）")
    hr_resting: Optional[int] = None
    hr_avg: Optional[int] = None
    hr_max: Optional[int] = None
    hr_min: Optional[int] = None
    stress_avg: Optional[int] = None
    spo2_avg: Optional[int] = None
    calories: Optional[int] = None
    training_load: Optional[int] = None


class StagePoint(BaseModel):
    t: str = Field(..., description="时间 HH:MM")
    stage: Union[int, str] = Field(..., description="阶段: deep/light/rem/awake，或数字兼容旧数据")

class SleepData(BaseModel):
    duration_min: Optional[int] = Field(None, description="总睡眠分钟")
    deep_min: Optional[int] = Field(None, description="深睡分钟")
    light_min: Optional[int] = Field(None, description="浅睡分钟")
    rem_min: Optional[int] = Field(None, description="REM 分钟")
    awake_min: Optional[int] = Field(None, description="清醒分钟")
    wakeup_time: Optional[int] = Field(None, description="起床时间戳")
    stages: Optional[List[StagePoint]] = Field(None, description="阶段时间线")


class HealthSyncRequest(BaseModel):
    """健康数据同步请求（source/device_id/date 为 H5 新增可选字段，Android 不受影响）"""
    samples: List[SamplePoint] = []
    daily_summary: Optional[DailySummary] = None
    battery_levels: List[BatteryPoint] = []
    sleep_data: Optional[SleepData] = None
    client_time: Optional[str] = None
    device_name: Optional[str] = None
    source: Literal["phone", "cloud"] = Field(
        "phone", description="数据源（H5）：phone=手机直传，cloud=云任务回传"
    )
    device_id: Optional[str] = Field(
        None, description="设备标识（H5）；云源为 cloud:{userId}"
    )
    date: Optional[str] = Field(
        None, pattern=r"^\d{4}-\d{2}-\d{2}$",
        description="显式归属日期（H5 云补拉历史日用；缺省按样本/主日推导）",
    )


# ============ API 端点 ============


@router.post("/sync")
async def health_sync(req: HealthSyncRequest, fastapi_request: Request):
    """
    App 端定时上传健康数据。

    每 1 小时调用一次，上传期间累计的全部传感器数据。
    """
    from services.health_storage import save_health_data

    user_id = _require_user_id(fastapi_request)

    # 源选择（H5）：exclusive 模式下非主源写入直接 409 拒绝
    primary, mode = _effective_selection(user_id)
    if mode == "exclusive" and req.source != primary:
        raise HTTPException(
            status_code=409,
            detail=(
                f"exclusive 模式仅允许主数据源 {primary} 写入，"
                f"本次 source={req.source} 被拒绝；"
                f"如需多源并写，请将 config.yaml health.source_mode 改为 merge"
            ),
        )

    # 设备注册表自动建档（H6，架构 §7）：首见 device_name/device_id 时以
    # 认证用户为 owner 幂等 upsert 到 backend/data/health_devices.json；
    # 失败不阻断写入（注册表是元数据不是真源）。P1-V7：注册单点收敛在
    # 本路由层（合一前归一层还会重复注册一次，随双胞胎合一删除）。
    try:
        from services.health import devices as devices_mod
        devices_mod.register(
            device_name=req.device_name,
            device_id=req.device_id,
            owner=user_id,
            kind="cloud" if req.source == "cloud" else "phone",
            source_id=req.source,
        )
    except Exception:
        logger.warning("[HealthSync] 设备注册表登记失败（不阻断写入）", exc_info=True)

    samples = [s.model_dump(exclude_none=True) for s in req.samples]
    battery = [b.model_dump() for b in req.battery_levels]
    daily = req.daily_summary.model_dump(exclude_none=True) if req.daily_summary else None
    sleep = req.sleep_data.model_dump(exclude_none=True) if req.sleep_data else None

    # 构建日志摘要
    log_parts = [f"[HealthSync] user={user_id} source={req.source} samples={len(samples)}"]

    if samples:
        hr_vals = [s["hr"] for s in samples if "hr" in s and s["hr"] is not None]
        steps_vals = [s["steps"] for s in samples if "steps" in s and s["steps"] is not None]
        ts_min = min(s["t"] for s in samples) if samples else 0
        ts_max = max(s["t"] for s in samples) if samples else 0
        from datetime import datetime, timezone, timedelta
        cst = timezone(timedelta(hours=8))
        log_parts.append(f"period={datetime.fromtimestamp(ts_min, cst).strftime('%H:%M')}~{datetime.fromtimestamp(ts_max, cst).strftime('%H:%M')}")
        if hr_vals:
            log_parts.append(f"hr={min(hr_vals)}-{max(hr_vals)} ({len(hr_vals)}pts)")
        if steps_vals:
            log_parts.append(f"steps={steps_vals[-1]}")
    else:
        log_parts.append("(no samples)")

    if battery:
        levels = [b["level"] for b in battery]
        log_parts.append(f"battery={min(levels)}%-{max(levels)}% ({len(levels)}pts)")

    if daily:
        log_parts.append(f"daily: {json.dumps(daily, ensure_ascii=False)}")

    if sleep:
        log_parts.append(f"sleep: dur={sleep.get('duration_min','?')}min deep={sleep.get('deep_min','?')} light={sleep.get('light_min','?')} rem={sleep.get('rem_min','?')}")

    logger.info(" | ".join(log_parts))

    # P1-V7 合一：phone/cloud 两支走同一条 normalize→store 路径
    # （save_health_data 委派 phone_push.batches_from_request 唯一实现）。
    # phone 支不传 device_id/explicit_date —— 保持 H2 前 Android 契约口径
    # （device_id 兜底 device_name or "phone"，主日按样本/日总推导）；
    # cloud 支带 device_id 与显式 date（云补拉历史日锚点）。
    # P2-V8：云生产链路已改任务脚本直写 store（不再 POST 本端点）；
    # source=cloud 处理无生产消费者、仅剩端点兼容保留（裁定见 vunit-V8.md）。
    result = save_health_data(
        samples=samples,
        daily_summary=daily,
        battery_levels=battery,
        sleep_data=sleep,
        user_id=user_id,
        device_name=req.device_name,
        source=req.source,
        device_id=req.device_id if req.source == "cloud" else None,
        explicit_date=req.date if req.source == "cloud" else None,
    )
    return result


@router.get("/query")
async def health_query(date: Optional[str] = None, request: Request = None):
    """查询某天的健康数据（按认证用户读其源分片，H6/A5 物理隔离）"""
    from services.health_storage import query_health_data
    user_id = _require_user_id(request)
    return query_health_data(date=date, user_id=user_id)

