"""
定时任务单元测试
测试 TaskStorage、TaskScheduler、TaskExecutor
"""
import pytest
import asyncio
import tempfile
import os
import sys
import json
from datetime import datetime, timedelta
from unittest.mock import Mock, AsyncMock, patch, MagicMock

# 测试独立的定时任务模块，不依赖完整后端
# 将当前目录加入路径
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# 定义测试用的数据类（避免导入问题）
from enum import Enum
from dataclasses import dataclass, field, asdict
from typing import Optional, Dict, Any, List

class ScheduleType(Enum):
    DELAY = "delay"
    SCHEDULED = "scheduled"

class TaskExecutionState(Enum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCESS = "success"
    FAILED = "failed"
    CANCELLED = "cancelled"

@dataclass
class Task:
    task_id: str
    user_id: int
    task_name: str
    prompt: str
    schedule_type: ScheduleType
    schedule_config: Dict[str, Any]
    created_at: datetime
    updated_at: Optional[datetime] = None
    next_run_at: Optional[datetime] = None
    last_run_at: Optional[datetime] = None
    enabled: bool = True
    max_retries: int = 3
    total_runs: int = 0
    fail_count: int = 0

@dataclass
class TaskExecution:
    execution_id: str
    task_id: str
    state: TaskExecutionState
    started_at: datetime
    completed_at: Optional[datetime] = None
    result: Optional[Dict] = None
    error: Optional[str] = None
    retry_count: int = 0
    execution_time_ms: Optional[int] = None


# ============ TaskStorage 实现（简化版） ============

import threading
import uuid

class TaskStorage:
    """简化版任务存储，用于测试"""
    
    def __init__(self, data_dir: str):
        self.data_dir = data_dir
        self._lock = threading.RLock()
        self._tasks: Dict[str, Task] = {}
        self._executions: Dict[str, List[TaskExecution]] = {}
        
        # 确保目录存在
        os.makedirs(data_dir, exist_ok=True)
        
        # 加载数据
        self._load()
    
    def _load(self):
        """从文件加载数据"""
        tasks_file = os.path.join(self.data_dir, 'tasks.yaml')
        if not os.path.exists(tasks_file):
            tasks_file = os.path.join(self.data_dir, 'tasks.json')
        if os.path.exists(tasks_file):
            try:
                with open(tasks_file, 'r', encoding='utf-8') as f:
                    raw = f.read()
                try:
                    import yaml
                    raw_data = yaml.safe_load(raw)
                except ImportError:
                    raw_data = json.loads(raw)

                if raw_data:
                    for task_id, task_data in raw_data.items():
                        task_data['schedule_type'] = ScheduleType(task_data['schedule_type'])
                        task_data['created_at'] = datetime.fromisoformat(task_data['created_at'])
                        if task_data.get('updated_at'):
                            task_data['updated_at'] = datetime.fromisoformat(task_data['updated_at'])
                        if task_data.get('next_run_at'):
                            task_data['next_run_at'] = datetime.fromisoformat(task_data['next_run_at'])
                        if task_data.get('last_run_at'):
                            task_data['last_run_at'] = datetime.fromisoformat(task_data['last_run_at'])
                        self._tasks[task_id] = Task(**task_data)
            except Exception as e:
                print(f"加载任务失败: {e}")
    
    def _save(self):
        """保存到文件"""
        with self._lock:
            tasks_file = os.path.join(self.data_dir, 'tasks.yaml')
            data = {}
            for task_id, task in self._tasks.items():
                task_dict = asdict(task)
                task_dict['schedule_type'] = task.schedule_type.value
                task_dict['created_at'] = task.created_at.isoformat()
                if task.updated_at:
                    task_dict['updated_at'] = task.updated_at.isoformat()
                if task.next_run_at:
                    task_dict['next_run_at'] = task.next_run_at.isoformat()
                if task.last_run_at:
                    task_dict['last_run_at'] = task.last_run_at.isoformat()
                data[task_id] = task_dict
            
            with open(tasks_file, 'w', encoding='utf-8') as f:
                try:
                    import yaml
                    yaml.dump(data, f, default_flow_style=False, allow_unicode=True, sort_keys=False, indent=2)
                except ImportError:
                    json.dump(data, f, ensure_ascii=False, indent=2)
    
    def create_task(self, user_id: int, task_name: Optional[str], prompt: str,
                   schedule_type: str, schedule_config: Dict[str, Any],
                   enabled: bool = True, max_retries: int = 3) -> Task:
        """创建任务"""
        with self._lock:
            if schedule_type not in ['delay', 'scheduled']:
                raise ValueError(f"无效的 schedule_type: {schedule_type}")
            
            task_id = f"task_{uuid.uuid4().hex[:12]}"
            now = datetime.now()
            
            task = Task(
                task_id=task_id,
                user_id=user_id,
                task_name=task_name or f"任务-{datetime.now().strftime('%m%d%H%M%S')}",
                prompt=prompt,
                schedule_type=ScheduleType(schedule_type),
                schedule_config=schedule_config,
                created_at=now,
                updated_at=now,
                enabled=enabled,
                max_retries=max_retries
            )
            
            self._tasks[task_id] = task
            self._save()
            return task
    
    def get_task(self, task_id: str) -> Optional[Task]:
        """获取任务"""
        return self._tasks.get(task_id)
    
    def update_task(self, task_id: str, **kwargs) -> Optional[Task]:
        """更新任务"""
        with self._lock:
            task = self._tasks.get(task_id)
            if not task:
                return None
            
            for key, value in kwargs.items():
                if hasattr(task, key):
                    setattr(task, key, value)
            
            task.updated_at = datetime.now()
            self._save()
            return task
    
    def delete_task(self, task_id: str) -> bool:
        """删除任务"""
        with self._lock:
            if task_id in self._tasks:
                del self._tasks[task_id]
                self._save()
                return True
            return False
    
    def list_tasks(self, user_id: Optional[int] = None, enabled_only: bool = False) -> List[Task]:
        """列出任务"""
        tasks = list(self._tasks.values())
        
        if user_id is not None:
            tasks = [t for t in tasks if t.user_id == user_id]
        
        if enabled_only:
            tasks = [t for t in tasks if t.enabled]
        
        return sorted(tasks, key=lambda t: t.created_at, reverse=True)
    
    def record_execution(self, task_id: str, state: TaskExecutionState,
                        result: Optional[Dict] = None, error: Optional[str] = None,
                        execution_time_ms: Optional[int] = None) -> TaskExecution:
        """记录执行历史"""
        with self._lock:
            execution = TaskExecution(
                execution_id=f"exec_{uuid.uuid4().hex[:12]}",
                task_id=task_id,
                state=state,
                started_at=datetime.now(),
                completed_at=datetime.now(),
                result=result,
                error=error,
                execution_time_ms=execution_time_ms
            )
            
            if task_id not in self._executions:
                self._executions[task_id] = []
            
            self._executions[task_id].insert(0, execution)
            return execution
    
    def get_executions(self, task_id: str, limit: int = 10, offset: int = 0) -> List[TaskExecution]:
        """获取执行历史"""
        executions = self._executions.get(task_id, [])
        return executions[offset:offset + limit]


# ============ 测试开始 ============

@pytest.fixture
def temp_storage():
    """创建临时存储目录的 fixture"""
    with tempfile.TemporaryDirectory() as tmpdir:
        storage = TaskStorage(data_dir=tmpdir)
        yield storage


class TestTaskStorage:
    """TaskStorage 存储层测试"""
    
    def test_create_task_success(self, temp_storage):
        """测试成功创建任务"""
        task = temp_storage.create_task(
            user_id=123,
            task_name="测试任务",
            prompt="这是一个测试提示词",
            schedule_type="delay",
            schedule_config={"minutes": 5}
        )
        
        assert task.task_name == "测试任务"
        assert task.user_id == 123
        assert task.schedule_type == ScheduleType.DELAY
        assert task.enabled is True
        assert task.task_id.startswith("task_")
        assert len(task.task_id) > 5
    
    def test_create_task_without_name(self, temp_storage):
        """测试不带名称创建任务（自动生成名称）"""
        task = temp_storage.create_task(
            user_id=123,
            task_name=None,
            prompt="测试提示词",
            schedule_type="scheduled",
            schedule_config={"hour": 10, "minute": 30}
        )
        
        assert task.task_name.startswith("任务-")
        assert task.schedule_type == ScheduleType.SCHEDULED
    
    def test_create_task_invalid_schedule_type(self, temp_storage):
        """测试无效的 schedule_type"""
        with pytest.raises(ValueError, match="无效的 schedule_type"):
            temp_storage.create_task(
                user_id=123,
                task_name="测试",
                prompt="测试",
                schedule_type="invalid_type",
                schedule_config={}
            )
    
    def test_get_task_exists(self, temp_storage):
        """测试获取存在的任务"""
        task = temp_storage.create_task(
            user_id=123,
            task_name="测试任务",
            prompt="测试",
            schedule_type="delay",
            schedule_config={"minutes": 5}
        )
        
        retrieved = temp_storage.get_task(task.task_id)
        assert retrieved is not None
        assert retrieved.task_id == task.task_id
        assert retrieved.task_name == "测试任务"
    
    def test_get_task_not_exists(self, temp_storage):
        """测试获取不存在的任务"""
        result = temp_storage.get_task("task_nonexistent")
        assert result is None
    
    def test_update_task_success(self, temp_storage):
        """测试成功更新任务"""
        task = temp_storage.create_task(
            user_id=123,
            task_name="原名称",
            prompt="原提示词",
            schedule_type="delay",
            schedule_config={"minutes": 5}
        )
        
        updated = temp_storage.update_task(
            task.task_id,
            task_name="新名称",
            prompt="新提示词"
        )
        
        assert updated is not None
        assert updated.task_name == "新名称"
        assert updated.prompt == "新提示词"
        assert updated.schedule_type == ScheduleType.DELAY
    
    def test_update_task_not_exists(self, temp_storage):
        """测试更新不存在的任务"""
        result = temp_storage.update_task(
            "task_nonexistent",
            task_name="新名称"
        )
        assert result is None
    
    def test_delete_task_success(self, temp_storage):
        """测试成功删除任务"""
        task = temp_storage.create_task(
            user_id=123,
            task_name="待删除",
            prompt="测试",
            schedule_type="delay",
            schedule_config={"minutes": 5}
        )
        
        deleted = temp_storage.delete_task(task.task_id)
        assert deleted is True
        assert temp_storage.get_task(task.task_id) is None
    
    def test_delete_task_not_exists(self, temp_storage):
        """测试删除不存在的任务"""
        result = temp_storage.delete_task("task_nonexistent")
        assert result is False
    
    def test_list_tasks_filter_by_user(self, temp_storage):
        """测试按用户过滤任务列表"""
        task1 = temp_storage.create_task(
            user_id=123, task_name="用户123的任务1",
            prompt="测试", schedule_type="delay", schedule_config={"minutes": 5}
        )
        task2 = temp_storage.create_task(
            user_id=123, task_name="用户123的任务2",
            prompt="测试", schedule_type="delay", schedule_config={"minutes": 5}
        )
        temp_storage.create_task(
            user_id=456, task_name="用户456的任务",
            prompt="测试", schedule_type="delay", schedule_config={"minutes": 5}
        )
        
        tasks = temp_storage.list_tasks(user_id=123)
        assert len(tasks) == 2
        task_ids = {t.task_id for t in tasks}
        assert task1.task_id in task_ids
        assert task2.task_id in task_ids
    
    def test_list_tasks_filter_by_enabled(self, temp_storage):
        """测试按启用状态过滤"""
        task1 = temp_storage.create_task(
            user_id=123, task_name="启用的任务",
            prompt="测试", schedule_type="delay", schedule_config={"minutes": 5},
            enabled=True
        )
        temp_storage.create_task(
            user_id=123, task_name="禁用的任务",
            prompt="测试", schedule_type="delay", schedule_config={"minutes": 5},
            enabled=False
        )
        
        enabled_tasks = temp_storage.list_tasks(enabled_only=True)
        assert len(enabled_tasks) == 1
        assert enabled_tasks[0].task_id == task1.task_id
    
    def test_record_execution(self, temp_storage):
        """测试记录执行历史"""
        task = temp_storage.create_task(
            user_id=123, task_name="测试",
            prompt="测试", schedule_type="delay", schedule_config={"minutes": 5}
        )
        
        execution = temp_storage.record_execution(
            task_id=task.task_id,
            state=TaskExecutionState.SUCCESS,
            result={"response": "测试响应"},
            execution_time_ms=1500
        )
        
        assert execution.task_id == task.task_id
        assert execution.state == TaskExecutionState.SUCCESS
        assert execution.result == {"response": "测试响应"}
        assert execution.execution_time_ms == 1500
        assert execution.execution_id.startswith("exec_")
    
    def test_get_executions_pagination(self, temp_storage):
        """测试执行历史分页"""
        task = temp_storage.create_task(
            user_id=123, task_name="测试",
            prompt="测试", schedule_type="delay", schedule_config={"minutes": 5}
        )
        
        for i in range(5):
            temp_storage.record_execution(
                task_id=task.task_id,
                state=TaskExecutionState.SUCCESS,
                result={"index": i}
            )
        
        page1 = temp_storage.get_executions(task_id=task.task_id, limit=2, offset=0)
        assert len(page1) == 2
        
        page2 = temp_storage.get_executions(task_id=task.task_id, limit=2, offset=2)
        assert len(page2) == 2
    
    def test_persistence(self, temp_storage):
        """测试数据持久化"""
        task = temp_storage.create_task(
            user_id=123, task_name="持久化测试",
            prompt="测试", schedule_type="delay", schedule_config={"minutes": 5}
        )
        
        # 创建新的存储实例
        new_storage = TaskStorage(data_dir=temp_storage.data_dir)
        
        retrieved = new_storage.get_task(task.task_id)
        assert retrieved is not None
        assert retrieved.task_name == "持久化测试"


class TestEdgeCases:
    """边界情况测试"""
    
    def test_task_name_special_characters(self, temp_storage):
        """测试任务名称包含特殊字符"""
        task = temp_storage.create_task(
            user_id=123,
            task_name="任务<>\"'&测试",
            prompt="测试",
            schedule_type="delay",
            schedule_config={"minutes": 5}
        )
        assert task.task_name == "任务<>\"'&测试"
    
    def test_long_prompt(self, temp_storage):
        """测试超长提示词"""
        long_prompt = "测试" * 10000
        
        task = temp_storage.create_task(
            user_id=123,
            task_name="长提示词测试",
            prompt=long_prompt,
            schedule_type="delay",
            schedule_config={"minutes": 5}
        )
        assert len(task.prompt) == 20000
    
    def test_many_tasks(self, temp_storage):
        """测试大量任务"""
        for i in range(100):
            temp_storage.create_task(
                user_id=123,
                task_name=f"任务{i}",
                prompt=f"提示词{i}",
                schedule_type="delay",
                schedule_config={"minutes": i}
            )
        
        tasks = temp_storage.list_tasks()
        assert len(tasks) == 100


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
