"""
Axeuh Home System - 数据模型定义
"""
from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any, Literal
from datetime import datetime
from enum import Enum


class ComponentType(str, Enum):
    TERMINAL = "terminal"
    BASH = "bash"
    STOCK = "stock"
    TEXT = "text"
    CUSTOM = "custom"


class ComponentStatus(str, Enum):
    RUNNING = "running"
    IDLE = "idle"
    COMPLETED = "completed"
    ERROR = "error"
    STOPPED = "stopped"


# ============ 基础组件模型 ============

class ComponentBase(BaseModel):
    """组件基础属性"""
    title: Optional[str] = None
    x: Optional[int] = None
    y: Optional[int] = None
    width: Optional[int] = None
    height: Optional[int] = None
    scale: Optional[float] = Field(default=1.0, ge=0.5, le=2.0)


class ComponentCreate(ComponentBase):
    """创建组件请求"""
    pass


class ComponentUpdate(BaseModel):
    """更新组件请求"""
    title: Optional[str] = None
    x: Optional[int] = None
    y: Optional[int] = None
    width: Optional[int] = None
    height: Optional[int] = None
    scale: Optional[float] = Field(default=None, ge=0.5, le=2.0)


class Component(ComponentBase):
    """组件完整模型"""
    id: str
    type: ComponentType
    user_id: Optional[str] = None  # 组件所属用户，None 表示全局可见
    status: ComponentStatus = ComponentStatus.IDLE
    created_at: datetime = Field(default_factory=datetime.now)
    updated_at: datetime = Field(default_factory=datetime.now)

    class Config:
        use_enum_values = True


# ============ 终端组件 ============

class TerminalCreate(ComponentBase):
    """创建终端请求"""
    title: str
    x: int
    y: int
    width: Optional[int] = 600
    height: Optional[int] = 400
    scale: Optional[float] = 1.0
    session_id: Optional[str] = None
    agent_type: Optional[str] = None
    model_id: Optional[str] = None


class Terminal(Component):
    """终端组件"""
    type: Literal[ComponentType.TERMINAL] = ComponentType.TERMINAL
    session_id: Optional[str] = None
    agent_type: Optional[str] = None
    model_id: Optional[str] = None
    content: str = ""
    lines: int = 0
    last_activity: Optional[datetime] = None


class TerminalMessage(BaseModel):
    """终端消息"""
    content: str
    type: Literal["text", "command"] = "text"


# ============ 临时终端 (Bash) ============

class BashCreate(BaseModel):
    """执行 Bash 命令请求"""
    command: str
    title: Optional[str] = None
    x: Optional[int] = None
    y: Optional[int] = None
    width: Optional[int] = None
    height: Optional[int] = None
    timeout: Optional[int] = 120000  # 默认 2 分钟
    auto_close: Optional[bool] = True  # 默认自动关闭
    auto_close_delay: Optional[int] = 3000  # 默认 3 秒后关闭


class BashComponent(Component):
    """Bash 组件"""
    type: Literal[ComponentType.BASH] = ComponentType.BASH
    command: str
    exit_code: Optional[int] = None
    output: str = ""
    duration: Optional[int] = None  # 执行时长 (ms)
    auto_close: bool = True
    auto_close_delay: int = 3000


# ============ 股票追踪 ============

class StockMode(str, Enum):
    MINUTE = "minute"
    DAY = "day"
    WEEK = "week"
    MONTH = "month"


class StockCreate(ComponentBase):
    """创建股票追踪请求"""
    stock_code: str
    title: Optional[str] = None
    mode: Optional[StockMode] = StockMode.MINUTE
    x: Optional[int] = None
    y: Optional[int] = None
    width: Optional[int] = 350
    height: Optional[int] = 250
    scale: Optional[float] = 1.0
    alert_high: Optional[float] = None
    alert_low: Optional[float] = None
    refresh_interval: Optional[int] = 5000


class StockUpdate(BaseModel):
    """更新股票追踪请求"""
    mode: Optional[StockMode] = None
    alert_high: Optional[float] = None
    alert_low: Optional[float] = None


class StockComponent(Component):
    """股票追踪组件"""
    type: Literal[ComponentType.STOCK] = ComponentType.STOCK
    stock_code: str
    stock_name: Optional[str] = None
    mode: StockMode = StockMode.MINUTE
    current_price: Optional[float] = None
    change: Optional[float] = None
    high: Optional[float] = None
    low: Optional[float] = None
    alert_high: Optional[float] = None
    alert_low: Optional[float] = None
    refresh_interval: int = 5000
    last_update: Optional[datetime] = None


# ============ 文本组件 ============

class TextCreate(ComponentBase):
    """创建文本组件请求"""
    title: Optional[str] = "备忘录"
    content: Optional[str] = ""
    x: Optional[int] = None
    y: Optional[int] = None
    width: Optional[int] = 300
    height: Optional[int] = 200
    scale: Optional[float] = 1.0


class TextUpdate(BaseModel):
    """更新文本组件请求"""
    content: Optional[str] = None
    title: Optional[str] = None


class TextComponent(Component):
    """文本组件"""
    type: Literal[ComponentType.TEXT] = ComponentType.TEXT
    content: str = ""
    editable: bool = True


# ============ 自定义组件 ============

class ContentType(str, Enum):
    HTML = "html"
    TEXT = "text"
    MARKDOWN = "markdown"


class CustomAction(BaseModel):
    """自定义组件交互按钮"""
    label: str
    action: str  # refresh, open, custom
    endpoint: Optional[str] = None
    url: Optional[str] = None


class CustomCreate(ComponentBase):
    """创建自定义组件请求"""
    title: Optional[str] = None
    content: Optional[str] = ""
    content_type: Optional[ContentType] = ContentType.HTML
    x: Optional[int] = None
    y: Optional[int] = None
    width: Optional[int] = None
    height: Optional[int] = None
    scale: Optional[float] = 1.0
    style: Optional[Dict[str, Any]] = None
    actions: Optional[List[CustomAction]] = None


class CustomUpdate(BaseModel):
    """更新自定义组件请求"""
    content: Optional[str] = None
    style: Optional[Dict[str, Any]] = None
    actions: Optional[List[CustomAction]] = None


class CustomComponent(Component):
    """自定义组件"""
    type: Literal[ComponentType.CUSTOM] = ComponentType.CUSTOM
    content: str = ""
    content_type: ContentType = ContentType.HTML
    style: Optional[Dict[str, Any]] = None
    actions: Optional[List[CustomAction]] = None


# ============ 响应模型 ============

class ComponentListResponse(BaseModel):
    """组件列表响应"""
    components: List[Dict[str, Any]]


class DeleteResponse(BaseModel):
    """删除响应"""
    success: bool
    component_id: str
    type: str
    cleanup_actions: List[str] = []


class SuccessResponse(BaseModel):
    """通用成功响应"""
    success: bool
    message: Optional[str] = None


# ============ WebSocket 消息 ============

class WSMessage(BaseModel):
    """WebSocket 消息"""
    type: str
    data: Optional[Dict[str, Any]] = None
    component_id: Optional[str] = None
    timestamp: datetime = Field(default_factory=datetime.now)


# ============ 定时任务模型 ============

class ScheduleType(str, Enum):
    """定时类型"""
    DELAY = "delay"
    SCHEDULED = "scheduled"


class TaskTargetType(str, Enum):
    """任务发送目标类型"""
    MAIN_TASK = "main_task"      # 发送到main-task会话
    CURRENT = "current"          # 发送到当前活跃会话
    NEW_SESSION = "new_session"  # 每次执行新建会话
    SPECIFIC = "specific"        # 发送到指定会话


class TaskBase(BaseModel):
    """任务基础模型"""
    task_name: str = Field(..., max_length=200, description="任务名称")
    prompt: str = Field(..., max_length=10000, description="任务提示词")
    schedule_type: ScheduleType = Field(..., description="调度类型: delay/scheduled")
    schedule_config: Dict[str, Any] = Field(..., description="调度配置")
    enabled: bool = Field(default=True, description="是否启用")
    repeat: bool = Field(default=False, description="是否重复执行")
    # 新增字段
    target_type: TaskTargetType = Field(default=TaskTargetType.MAIN_TASK, description="发送目标类型")
    target_session: Optional[str] = Field(default=None, description="目标会话ID，当target_type为specific时使用")


class TaskCreate(TaskBase):
    """创建任务请求"""
    pass


class TaskUpdate(BaseModel):
    """更新任务请求"""
    task_name: Optional[str] = Field(default=None, max_length=200)
    prompt: Optional[str] = Field(default=None, max_length=10000)
    schedule_config: Optional[Dict[str, Any]] = None
    enabled: Optional[bool] = None
    repeat: Optional[bool] = None
    target_type: Optional[TaskTargetType] = None
    target_session: Optional[str] = None


class TaskResponse(BaseModel):
    """任务响应模型"""
    task_id: str
    user_id: int
    task_name: str
    prompt: str
    schedule_type: str
    schedule_config: Dict[str, Any]
    enabled: bool
    repeat: bool
    created_at: float
    last_run: Optional[float] = None
    next_run: Optional[float] = None
    run_count: int = 0
    # 新增字段
    target_type: str = "main_task"
    target_session: Optional[str] = None

    class Config:
        use_enum_values = True


class TaskListResponse(BaseModel):
    """任务列表响应"""
    tasks: List[TaskResponse]
    total: int


class TaskExecutionResponse(BaseModel):
    """任务执行记录响应"""
    execution_id: str
    task_id: str
    status: str  # pending/success/failed
    session_id: Optional[str] = None
    started_at: Optional[float] = None
    completed_at: Optional[float] = None
    retry_count: int = 0
    error_message: Optional[str] = None


class TaskExecutionListResponse(BaseModel):
    """任务执行历史响应"""
    executions: List[TaskExecutionResponse]
    total: int


class TaskTriggerResponse(BaseModel):
    """手动触发任务响应"""
    success: bool
    task_id: str
    execution_id: Optional[str] = None
    message: str


class TaskStats(BaseModel):
    """任务统计"""
    total_tasks: int
    enabled_tasks: int
    total_executions: int
    success_count: int
    failed_count: int
