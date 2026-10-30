"""
定时任务数据模型
"""
from dataclasses import dataclass, field, asdict
from datetime import datetime
from enum import Enum
from typing import Dict, List, Optional, Any
import uuid


class ScheduleType(Enum):
    """定时类型"""
    DELAY = "delay"           # 延时任务
    SCHEDULED = "scheduled"   # 定时任务


class TaskExecutionState(Enum):
    """任务执行状态"""
    PENDING = "pending"
    ACQUIRED = "acquired"
    EXECUTING = "executing"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass
class Task:
    """定时任务数据类"""
    task_id: str
    user_id: str
    task_name: str
    prompt: str
    schedule_type: str
    schedule_config: Dict[str, Any]
    enabled: bool = True
    repeat: bool = False
    created_at: float = field(default_factory=lambda: datetime.now().timestamp())
    last_run: Optional[float] = None
    next_run: Optional[float] = None
    run_count: int = 0
    # 新增字段：发送目标配置
    target_type: str = "main_task"  # main_task, current, new_session, specific
    target_session: Optional[str] = None  # 当target_type为specific时使用
    # 模型配置：覆盖全局默认模型
    model_id: Optional[str] = None  # 模型ID（留空则用 config.yaml opencode.default_model）
    provider_id: Optional[str] = None  # 提供商ID（留空则用 config.yaml opencode.default_provider）
    schedule: Optional[Any] = None  # 新统一格式: 字符串简写或结构化字典

    def to_dict(self) -> Dict[str, Any]:
        """转换为字典"""
        return asdict(self)
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Task":
        """从字典创建，兼容旧字段命名迁移和 ISO/浮点时间格式"""
        if data is None:
            raise ValueError("data 不能为空")
        d = dict(data)  # 浅拷贝，避免修改原数据

        # 兼容历史字段名称，将旧字段映射到当前字段
        if "total_runs" in d:
            d["run_count"] = d.pop("total_runs")
        if "last_run_at" in d:
            d["last_run"] = d.pop("last_run_at")
        if "next_run_at" in d:
            d["next_run"] = d.pop("next_run_at")
        # 如果没有创建时间，设置为当前时间戳，保持类型一致
        if "created_at" not in d:
            d["created_at"] = datetime.now().timestamp()

        # 兼容 ISO 格式字符串时间（人工编辑时更可读）
        for key in ('created_at', 'last_run', 'next_run'):
            val = d.get(key)
            if isinstance(val, str):
                try:
                    d[key] = datetime.fromisoformat(val).timestamp()
                except ValueError:
                    pass  # 非 ISO 格式则保持原值

        # 处理新统一 schedule 字段：若存在则填充默认值（已有值则保留）
        schedule_val = d.get("schedule")
        if schedule_val is not None:
            d.setdefault("schedule_type", "")
            d.setdefault("schedule_config", {})
            d.setdefault("repeat", True)

        # 仅保留 Task 数据类定义的字段，防止多余字段导致初始化失败
        allowed_keys = {
            "task_id",
            "user_id",
            "task_name",
            "prompt",
            "schedule_type",
            "schedule_config",
            "enabled",
            "repeat",
            "created_at",
            "last_run",
            "next_run",
            "run_count",
            "target_type",
            "target_session",
            "model_id",
            "provider_id",
            "schedule",
        }
        filtered = {k: v for k, v in d.items() if k in allowed_keys}
        return cls(**filtered)
    
    @classmethod
    def create(cls, user_id: str, task_name: str, prompt: str,
               schedule_type: str = "", schedule_config: Optional[Dict[str, Any]] = None,
               enabled: bool = True, repeat: bool = False,
               target_type: str = "main_task", target_session: Optional[str] = None,
               model_id: Optional[str] = None, provider_id: Optional[str] = None,
               schedule: Optional[Any] = None) -> "Task":
        """创建新任务"""
        config = schedule_config or {}
        return cls(
            task_id=f"task_{uuid.uuid4().hex[:12]}",
            user_id=user_id,
            task_name=task_name,
            prompt=prompt,
            schedule_type=schedule_type,
            schedule_config=config,
            enabled=enabled,
            repeat=repeat,
            target_type=target_type,
            target_session=target_session,
            model_id=model_id,
            provider_id=provider_id,
            schedule=schedule
        )


@dataclass
class TaskExecution:
    """任务执行记录"""
    execution_id: str
    task_id: str
    status: str  # pending/success/failed
    session_id: Optional[str] = None
    started_at: Optional[float] = None
    completed_at: Optional[float] = None
    retry_count: int = 0
    error_message: Optional[str] = None
    
    def to_dict(self) -> Dict[str, Any]:
        """转换为字典（时间字段输出 ISO 格式）"""
        d = asdict(self)
        for key in ('started_at', 'completed_at'):
            val = d.get(key)
            if val is not None:
                d[key] = datetime.fromtimestamp(val).isoformat()
        return d
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "TaskExecution":
        """从字典创建，兼容 ISO 格式字符串"""
        d = dict(data)
        for key in ('started_at', 'completed_at'):
            val = d.get(key)
            if isinstance(val, str):
                try:
                    d[key] = datetime.fromisoformat(val).timestamp()
                except ValueError:
                    pass
        return cls(**d)
    
    @classmethod
    def create(cls, task_id: str) -> "TaskExecution":
        """创建新执行记录"""
        return cls(
            execution_id=f"exec_{uuid.uuid4().hex[:12]}",
            task_id=task_id,
            status="pending",
            started_at=datetime.now().timestamp()
        )
