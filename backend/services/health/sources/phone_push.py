# -*- coding: utf-8 -*-
"""
push 方向归一（P1-V7 合一后的唯一实现）：/sync 载荷 -> HealthBatch（架构文档第 6 节）。

P1-V7 前本分组逻辑与 health_storage.save_health_data 是"逐行等价双胞胎"，
靠 parity 测试防漂移；现合一本模块为唯一实现：save_health_data 与
/api/health/sync phone/cloud 两支全部调用下述 plain 函数。
PhonePushSource 类与 registry.get_source/capabilities 死抽象随合一删除
（生产零调用）；分组/睡眠归一原语（_ts_to_date/_pick_date/_build_sleep 等）
自 health_storage 迁入本模块（单一实现处，消双向依赖）。

语义（characterization 逐字段锁死，改前后分片 JSON 逐字节一致）：
  - 分组口径 : 样本/电量按东八区 t 归日；daily/sleep 归主日（_pick_date；
    explicit_date 仅云端历史补拉使用，phone 支路由层恒传 None 保持现状）
  - 步数     : 样本 steps 为区间增量，批次不注入 total_steps（store 写入时求和）
  - 睡眠     : Android 数字编码 2/3/4/5 -> deep/light/rem/awake，HH:mm 锚主日
               （no-reattribution：不重归属到起床日，与 /sync 现行一致）
  - 电量     : battery_levels 独立拆为 batch.battery（{t, level}）
  - 设备     : phone -> device_id = device_name or "phone"（载荷 device_id 键
               忽略——保持 save_health_data 生产口径）；cloud -> device_id >
               cloud:{cloud_user_id} > "cloud"；kind 随 source。
  - fetched_at: push 批次恒不携带（store 合并语义保留已存值），与合一前一致。
  - 设备注册：单点收敛在路由层（routers/health.py /sync 首见建档），本模块
    不再注册（合一前 normalize 与路由双注册，重复实现）。
"""
from typing import Any, Dict, List, Optional
from datetime import datetime, timezone, timedelta

from ..models import (
    DailySummary,
    DeviceRef,
    HealthBatch,
    HealthSample,
    SleepData,
    SleepSegment,
)

# 东八区
_CST = timezone(timedelta(hours=8))

# Android 数字 stage 编码 -> canonical 枚举（架构文档第 9 节：源 A 2/3/4/5）
_STAGE_CODE_TO_ENUM = {2: "deep", 3: "light", 4: "rem", 5: "awake"}
_STAGE_ENUMS = {"deep", "light", "rem", "awake", "unknown"}


def _today_str() -> str:
    """今天的日期字符串（东八区）；非法时间戳回退用。"""
    return datetime.now(_CST).strftime("%Y-%m-%d")


def _ts_to_date(ts_val: Any) -> str:
    """从时间戳获取日期字符串（东八区）；非法值回退今天。"""
    try:
        return datetime.fromtimestamp(
            ts_val if isinstance(ts_val, (int, float)) else int(ts_val), _CST
        ).strftime("%Y-%m-%d")
    except (ValueError, OSError, TypeError):
        return _today_str()


def _pick_date(*dicts: Optional[Dict[str, Any]]) -> str:
    """按 t/timestamp 归属日期；缺省回退今天（与 H2 前口径一致）。"""
    for dd in dicts:
        if dd:
            ts = dd.get("t") or dd.get("timestamp")
            if ts:
                return _ts_to_date(ts)
    return _today_str()


def _stage_to_enum(raw: Any) -> str:
    """Android 数字编码 / 枚举字符串 -> canonical 枚举；无法识别归为 unknown。"""
    if isinstance(raw, bool):
        return "unknown"
    if isinstance(raw, int):
        return _STAGE_CODE_TO_ENUM.get(raw, "unknown")
    if isinstance(raw, str):
        s = raw.strip().lower()
        if s in _STAGE_ENUMS:
            return s
        if s.isdigit():
            return _STAGE_CODE_TO_ENUM.get(int(s), "unknown")
    return "unknown"


def _hm_to_epoch(hm: Any, date_str: str) -> Optional[int]:
    """将 "HH:mm" 锚定到指定日期（东八区）转 epoch 秒；无法解析返回 None。"""
    if not isinstance(hm, str):
        return None
    try:
        dt = datetime.strptime(f"{date_str} {hm.strip()}", "%Y-%m-%d %H:%M")
    except ValueError:
        return None
    return int(dt.replace(tzinfo=_CST).timestamp())


def _build_sleep(sleep_payload: Dict[str, Any], anchor_date: str) -> Optional[SleepData]:
    """请求 sleep_data dict -> canonical SleepData。

    stages 适配：Android {"t":"HH:mm","stage":2/3/4/5} -> SleepSegment
    {start_ts(epoch，锚定批次日期), stage(枚举), duration_min}；
    duration_min 由下一段 start_ts 推算（末段为 0），不要求 Android 提供逐段时长。
    """
    if not sleep_payload:
        return None
    parsed: List[Any] = []
    for st in sleep_payload.get("stages") or []:
        if not isinstance(st, dict):
            continue
        ts = _hm_to_epoch(st.get("t"), anchor_date)
        if ts is None:
            continue
        parsed.append((ts, _stage_to_enum(st.get("stage"))))

    segments: List[SleepSegment] = []
    for i, (ts, stage) in enumerate(parsed):
        if i + 1 < len(parsed):
            duration = max(0, (parsed[i + 1][0] - ts)) // 60
        else:
            duration = 0
        segments.append(
            SleepSegment(
                start_ts=int(ts), stage=str(stage), duration_min=int(duration)
            )
        )

    return SleepData(
        duration_min=sleep_payload.get("duration_min"),
        deep_min=sleep_payload.get("deep_min"),
        light_min=sleep_payload.get("light_min"),
        rem_min=sleep_payload.get("rem_min"),
        awake_min=sleep_payload.get("awake_min"),
        wakeup_time=sleep_payload.get("wakeup_time"),
        segments=segments,
    )


def normalize(raw: Dict[str, Any]) -> HealthBatch:
    """单日载荷 -> HealthBatch（push 方向归一唯一实现）。

    raw 键：date（必填）、samples、battery_levels、daily_summary、sleep_data、
    user_id、device_name、device_id、source（缺省 phone）、cloud_user_id。
    分组（多日拆分）由 batches_from_request 完成。
    """
    source = raw.get("source") or "phone"
    # H6：user_id 必须由调用方（路由层已解析的认证身份，经
    # batches_from_request 传入）显式提供；缺失即报错，绝不自造
    # "default"（多用户物理隔离，架构 §5.5）
    user_id = raw.get("user_id")
    if not user_id:
        raise ValueError(
            "phone_push.normalize 缺少 user_id：必须由路由层已解析的"
            "认证用户传入，禁止 default 降级"
        )
    date_str = raw["date"]
    device_name = raw.get("device_name")

    # 样本：t/hr/steps/stress/spo2（t_iso 由 store 导出再生，这里丢弃）
    samples = [
        HealthSample(
            t=s["t"],
            hr=s.get("hr"),
            steps=s.get("steps"),
            stress=s.get("stress"),
            spo2=s.get("spo2"),
        )
        for s in raw.get("samples") or []
        if s.get("t") is not None
    ]
    # 电量：独立点位（同 t 后写覆盖由 store 合并语义保证）
    battery = []
    for b in raw.get("battery_levels") or []:
        if b.get("t") is None:
            continue
        entry: Dict[str, int] = {"t": b["t"]}
        if b.get("level") is not None:
            entry["level"] = b["level"]
        battery.append(entry)

    daily_raw = raw.get("daily_summary")
    daily = DailySummary.from_dict(daily_raw) if daily_raw else None
    # 睡眠 stage 映射（2/3/4/5 -> 枚举）+ HH:mm 锚主日
    sleep = _build_sleep(raw.get("sleep_data"), date_str) if raw.get("sleep_data") else None

    # 设备块（source 分派 kind/id 规则；注册收敛在路由层，见模块 docstring）
    if source == "cloud":
        kind = "cloud"
        device_id = raw.get("device_id") or (
            f"cloud:{raw['cloud_user_id']}" if raw.get("cloud_user_id") else "cloud"
        )
    else:
        kind = "phone"
        # 保持 save_health_data 生产口径：device_id 键忽略，仅 device_name 兜底 "phone"
        device_id = device_name or "phone"
    device = DeviceRef(
        device_id=device_id,
        label=device_name,
        kind=kind,
        owner_user_id=user_id,
        source_id=source,
    )

    batch = HealthBatch(
        source_id=source,
        user_id=user_id,
        device=device,
        date=date_str,
        samples=samples,
        daily_summary=daily,
        sleep=sleep,
        battery=battery,
    )
    return batch


def batches_from_request(
    payload: Dict[str, Any],
    user_id: str,
    explicit_date: Optional[str] = None,
) -> List[HealthBatch]:
    """完整 /sync 载荷 -> 按日分组的 HealthBatch 列表（唯一实现）。

    分组口径（characterization 锁死）：
      - samples / battery_levels 按 t（东八区）归日
      - daily_summary / sleep_data 只归主日（_pick_date；explicit_date 时
        强制归指定日期 —— 云端历史补拉的 sleep-only 日也要有落点）
      - 主日不在样本组且无 daily/sleep 时兜底建空组
    """
    groups: Dict[str, Dict[str, List[Any]]] = {}

    def _group(ts_val: Any) -> Dict[str, List[Any]]:
        return groups.setdefault(_ts_to_date(ts_val), {"samples": [], "battery": []})

    for s in payload.get("samples") or []:
        if s.get("t") is not None:
            _group(s["t"])["samples"].append(s)
    for b in payload.get("battery_levels") or []:
        if b.get("t") is not None:
            _group(b["t"])["battery"].append(b)

    daily = payload.get("daily_summary")
    sleep = payload.get("sleep_data")
    main_date = explicit_date or _pick_date(daily, sleep)
    if not groups:
        groups[main_date] = {"samples": [], "battery": []}
    elif explicit_date and main_date not in groups:
        # 云补拉：历史睡眠/日总可能没有任何当日样本，显式日期必建组
        groups[main_date] = {"samples": [], "battery": []}

    device_name = payload.get("device_name")
    batches: List[HealthBatch] = []
    for date_str, group in groups.items():
        batch = normalize({
            "date": date_str,
            "samples": group["samples"],
            "battery_levels": group["battery"],
            # daily/sleep 只挂主日
            "daily_summary": daily if date_str == main_date else None,
            "sleep_data": sleep if date_str == main_date else None,
            "user_id": user_id,
            "device_name": device_name,
            "device_id": payload.get("device_id"),
            "source": payload.get("source") or "phone",
            "cloud_user_id": payload.get("cloud_user_id"),
        })
        batches.append(batch)
    return batches
