# -*- coding: utf-8 -*-
"""
健康数据 canonical 数据模型（H1 暗接入骨架）。

依据 health-data-source-architecture.md 第 6 节定义 dataclass 契约：
  - HealthSample   : 单个采样点（steps 为区间增量）
  - SleepSegment   : 睡眠阶段段（stage 属于 deep|light|rem|awake|unknown）
  - SleepSession   : 单次睡眠会话（主觉/小睡；保留原始 items 与阶段段）
  - SleepData      : 当日睡眠汇总 + 阶段段列表 + 多会话列表
  - DailySummary   : 日汇总（total_steps 在写入/导出时按增量求和）
  - DeviceRef      : 设备引用（分片内嵌，聚合视图可回溯源）
  - HealthBatch    : 一条数据源在一个用户某日的完整批次

序列化规则：可选字段为 None 时省略键（不写 null）。
分片 JSON 键名遵循方案第 5.2 节：source / sleep_data / battery_levels。
"""
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

# 睡眠阶段枚举（方案第 6 节）
_SLEEP_STAGES = {"deep", "light", "rem", "awake", "unknown"}

# DailySummary 参与序列化的字段（第 6 节 + 既有上报契约的其余可选指标）
_DAILY_FIELDS = (
    "total_steps",
    # 既有上报契约的 daily_summary.steps（末值口径）：H2 门面需原样保留进分片，
    # 派生视图才不会丢键（读取端 total_steps 另按增量求和补齐）
    "steps",
    "hr_resting",
    "hr_avg",
    "hr_max",
    "hr_min",
    "stress_avg",
    "spo2_avg",
    "calories",
    "training_load",
)


@dataclass
class HealthSample:
    """单个采样点。steps 为区间增量（canonical 语义）。"""

    t: int
    hr: Optional[int] = None
    steps: Optional[int] = None
    stress: Optional[int] = None
    spo2: Optional[int] = None
    resting_hr: Optional[int] = None
    calories: Optional[int] = None

    def to_dict(self) -> Dict[str, Any]:
        """序列化：None 字段省略键。"""
        out: Dict[str, Any] = {"t": self.t}
        for name in ("hr", "steps", "stress", "spo2", "resting_hr", "calories"):
            value = getattr(self, name)
            if value is not None:
                out[name] = value
        return out

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "HealthSample":
        return cls(
            t=data["t"],
            hr=data.get("hr"),
            steps=data.get("steps"),
            stress=data.get("stress"),
            spo2=data.get("spo2"),
            resting_hr=data.get("resting_hr"),
            calories=data.get("calories"),
        )


@dataclass
class SleepSegment:
    """睡眠阶段段：绝对起始时间 + 枚举阶段 + 时长（分钟）。"""

    start_ts: int
    stage: str
    duration_min: int

    def __post_init__(self) -> None:
        if self.stage not in _SLEEP_STAGES:
            raise ValueError(
                f"非法睡眠阶段: {self.stage!r}，允许值: {sorted(_SLEEP_STAGES)}"
            )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "start_ts": self.start_ts,
            "stage": self.stage,
            "duration_min": self.duration_min,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "SleepSegment":
        return cls(
            start_ts=data["start_ts"],
            stage=data["stage"],
            duration_min=data["duration_min"],
        )


@dataclass
class SleepSession:
    """单次睡眠会话（主觉或小睡）。

    items 保留云端原始 {start_time, end_time, state} 三元组；stages 为对应
    的 canonical 阶段段。标量口径与 SleepData 顶层字段一致。
    """

    bedtime: Optional[int] = None
    wakeup: Optional[int] = None
    duration: Optional[int] = None
    deep: Optional[int] = None
    light: Optional[int] = None
    rem: Optional[int] = None
    awake: Optional[int] = None
    awake_count: Optional[int] = None
    items: List[Dict[str, int]] = field(default_factory=list)
    stages: List[SleepSegment] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        """序列化：None 标量省略；items/stages 为空时省略对应键。"""
        out: Dict[str, Any] = {}
        for name in (
            "bedtime",
            "wakeup",
            "duration",
            "deep",
            "light",
            "rem",
            "awake",
            "awake_count",
        ):
            value = getattr(self, name)
            if value is not None:
                out[name] = value
        if self.items:
            out["items"] = [dict(item) for item in self.items]
        if self.stages:
            out["stages"] = [seg.to_dict() for seg in self.stages]
        return out

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "SleepSession":
        return cls(
            bedtime=data.get("bedtime"),
            wakeup=data.get("wakeup"),
            duration=data.get("duration"),
            deep=data.get("deep"),
            light=data.get("light"),
            rem=data.get("rem"),
            awake=data.get("awake"),
            awake_count=data.get("awake_count"),
            items=[
                dict(item) for item in data.get("items") or []
                if isinstance(item, dict)
            ],
            stages=[
                SleepSegment.from_dict(seg) for seg in data.get("stages") or []
            ],
        )


def sleep_session_key(session: Dict[str, Any]) -> Optional[tuple]:
    """会话去重键：优先起止时刻，退化到 (wakeup,duration) 与阶段合计。

    无可用于识别的字段时返回 None（调用方保留该会话、不做去重）。
    """
    bedtime = session.get("bedtime")
    wakeup = session.get("wakeup")
    if bedtime is not None and wakeup is not None:
        return (bedtime, wakeup)
    duration = session.get("duration")
    if wakeup is not None and duration is not None:
        return (wakeup, duration)
    stage_totals = (
        session.get("deep"),
        session.get("light"),
        session.get("rem"),
        session.get("awake"),
    )
    if duration is not None and all(value is not None for value in stage_totals):
        return (duration, *stage_totals)
    return None


@dataclass
class SleepData:
    """当日睡眠汇总；segments 序列化为第 5.2 节的 stages 键。

    cloud 口径：duration_min = deep_min + light_min + rem_min（不含 awake），
    duration_min + awake_min = 卧床时长。顶层字段镜像最长主觉，sleep_sessions
    保留当日全部会话（含小睡）。
    """

    duration_min: Optional[int] = None
    deep_min: Optional[int] = None
    light_min: Optional[int] = None
    rem_min: Optional[int] = None
    awake_min: Optional[int] = None
    wakeup_time: Optional[int] = None
    segments: List[SleepSegment] = field(default_factory=list)
    awake_count: Optional[int] = None
    bedtime: Optional[int] = None
    sleep_sessions: List[SleepSession] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        """序列化：None 标量省略；segments/sleep_sessions 为空时省略键。"""
        out: Dict[str, Any] = {}
        for name in (
            "duration_min",
            "deep_min",
            "light_min",
            "rem_min",
            "awake_min",
            "wakeup_time",
            "awake_count",
            "bedtime",
        ):
            value = getattr(self, name)
            if value is not None:
                out[name] = value
        if self.segments:
            out["stages"] = [seg.to_dict() for seg in self.segments]
        if self.sleep_sessions:
            out["sleep_sessions"] = [
                session.to_dict() for session in self.sleep_sessions
            ]
        return out

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "SleepData":
        return cls(
            duration_min=data.get("duration_min"),
            deep_min=data.get("deep_min"),
            light_min=data.get("light_min"),
            rem_min=data.get("rem_min"),
            awake_min=data.get("awake_min"),
            wakeup_time=data.get("wakeup_time"),
            segments=[
                SleepSegment.from_dict(seg) for seg in data.get("stages") or []
            ],
            awake_count=data.get("awake_count"),
            bedtime=data.get("bedtime"),
            sleep_sessions=[
                SleepSession.from_dict(session)
                for session in data.get("sleep_sessions") or []
            ],
        )


@dataclass
class DailySummary:
    """日汇总。total_steps 在写入/导出时按样本增量求和（绝不取末值、绝不差分）。"""

    total_steps: Optional[int] = None
    steps: Optional[int] = None
    hr_resting: Optional[int] = None
    hr_avg: Optional[int] = None
    hr_max: Optional[int] = None
    hr_min: Optional[int] = None
    stress_avg: Optional[int] = None
    spo2_avg: Optional[int] = None
    calories: Optional[int] = None
    training_load: Optional[int] = None

    def to_dict(self) -> Dict[str, Any]:
        """序列化：None 字段省略键。"""
        out: Dict[str, Any] = {}
        for name in _DAILY_FIELDS:
            value = getattr(self, name)
            if value is not None:
                out[name] = value
        return out

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "DailySummary":
        return cls(**{name: data[name] for name in _DAILY_FIELDS if name in data})


@dataclass
class DeviceRef:
    """设备引用：分片内嵌 device 块（方案第 5.2/7 节）。"""

    device_id: str
    label: Optional[str] = None
    kind: str = "phone"
    owner_user_id: Optional[str] = None
    source_id: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """序列化：device_id/kind 必写；其余 None 省略。"""
        out: Dict[str, Any] = {"device_id": self.device_id, "kind": self.kind}
        if self.label is not None:
            out["label"] = self.label
        if self.owner_user_id is not None:
            out["owner_user_id"] = self.owner_user_id
        if self.source_id is not None:
            out["source_id"] = self.source_id
        return out

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "DeviceRef":
        return cls(
            device_id=data.get("device_id", ""),
            label=data.get("label"),
            kind=data.get("kind", "phone"),
            owner_user_id=data.get("owner_user_id"),
            source_id=data.get("source_id"),
        )


@dataclass
class HealthBatch:
    """一条数据源（phone/cloud）在某用户某日的完整批次。"""

    source_id: str
    user_id: str
    device: DeviceRef
    date: str
    samples: List[HealthSample] = field(default_factory=list)
    daily_summary: Optional[DailySummary] = None
    sleep: Optional[SleepData] = None
    battery: List[Dict[str, int]] = field(default_factory=list)
    fetched_at: Optional[int] = None

    def to_dict(self) -> Dict[str, Any]:
        """序列化为分片 JSON 结构（第 5.2 节键名）。"""
        out: Dict[str, Any] = {
            "source": self.source_id,
            "user_id": self.user_id,
            "date": self.date,
            "device": self.device.to_dict(),
            "samples": [s.to_dict() for s in self.samples],
        }
        # 可选空列表省略键（保留分片中已有的电量记录，不因缺省而清空）
        if self.battery:
            out["battery_levels"] = [
                {k: v for k, v in b.items() if v is not None} for b in self.battery
            ]
        if self.daily_summary is not None:
            out["daily_summary"] = self.daily_summary.to_dict()
        if self.sleep is not None:
            out["sleep_data"] = self.sleep.to_dict()
        if self.fetched_at is not None:
            out["fetched_at"] = self.fetched_at
        return out

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "HealthBatch":
        daily = data.get("daily_summary")
        sleep = data.get("sleep_data")
        return cls(
            source_id=data["source"],
            user_id=data["user_id"],
            date=data["date"],
            device=DeviceRef.from_dict(data.get("device") or {}),
            samples=[HealthSample.from_dict(s) for s in data.get("samples") or []],
            daily_summary=DailySummary.from_dict(daily) if daily is not None else None,
            sleep=SleepData.from_dict(sleep) if sleep is not None else None,
            battery=list(data.get("battery_levels") or []),
            fetched_at=data.get("fetched_at"),
        )
