"""
定时任务存储管理器
使用 YAML 文件本地存储，带文件锁和原子写入
AI 可直接编辑 YAML 文件，热加载自动生效
"""
import os
import json
import hashlib
import tempfile
import logging
import asyncio
from datetime import datetime
from typing import Dict, List, Optional, Any
from pathlib import Path

# YAML 序列化（首选），JSON 作为降级
try:
    import yaml
    YAML_AVAILABLE = True
except ImportError:
    YAML_AVAILABLE = False
    logging.warning("PyYAML 未安装，将使用 JSON 作为存储格式")

# 使用 filelock 进行文件级锁定
# 注意：需要先安装 pip install filelock
# 如果未安装，提供降级方案
try:
    from filelock import FileLock
    FILELOCK_AVAILABLE = True
except ImportError:
    FILELOCK_AVAILABLE = False
    logging.warning("filelock 未安装，将使用简单的线程锁作为降级方案")

from .task_models import Task, TaskExecution, TaskExecutionState

logger = logging.getLogger(__name__)


class TaskStorage:
    """
    定时任务存储管理器
    
    特性：
    - JSON 文件持久化
    - 文件锁防止并发冲突
    - 原子写入（临时文件 + 重命名）
    - 内存缓存 + 脏标志
    - 自动清理过期历史
    """
    
    # 资源限制
    MAX_TASKS_PER_USER = 50  # 每用户最大任务数
    MAX_EXECUTIONS_PER_TASK = 100  # 每个任务保留最近100条执行记录
    MAX_EXECUTION_AGE_DAYS = 30  # 执行记录保留30天
    MAX_PROMPT_LENGTH = 10000  # 提示词最大长度
    
    def __init__(self, data_dir: Optional[str] = None):
        """
        初始化存储管理器
        
        Args:
            data_dir: 数据目录路径，默认为 backend/data/
        """
        if data_dir is None:
            # 从统一配置读取
            from config.config import get_config
            _cfg_ts = get_config()
            self.data_dir = Path(_cfg_ts.TASKS_DIR)
            logger.info(f"TaskStorage 使用项目数据目录: {self.data_dir}")
        else:
            self.data_dir = Path(data_dir)
        
        self.data_dir.mkdir(parents=True, exist_ok=True)
        
        # 文件路径（YAML 格式，AI 可直接编辑）
        self.tasks_file = self.data_dir / "tasks.yaml"
        self.executions_file = self.data_dir / "task_executions.yaml"
        
        # 新 tasks/ 目录模式（单个任务 YAML 文件）
        self.tasks_dir = self.data_dir / "tasks"
        self.state_file = self.data_dir / "tasks_state.json"  # 运行时状态
        self._using_tasks_dir = False  # 是否使用 tasks/ 目录模式
        self._tasks_dir_file_mtimes: Dict[str, float] = {}  # tasks/ 文件 mtime 跟踪
        
        # 文件锁路径
        if FILELOCK_AVAILABLE:
            self.tasks_lock = FileLock(str(self.tasks_file) + ".lock")
            self.executions_lock = FileLock(str(self.executions_file) + ".lock")
            self.state_lock = FileLock(str(self.state_file) + ".lock")
        else:
            import threading
            # 可重入锁：同一线程内的嵌套保存不会自锁死
            self._lock = threading.RLock()
            self.tasks_lock = self._lock
            self.executions_lock = self._lock
            self.state_lock = self._lock
        
        # 内存缓存
        self._tasks_cache: Dict[str, Task] = {}
        self._executions_cache: Dict[str, List[TaskExecution]] = {}
        self._tasks_dirty = True
        self._executions_dirty = True

        # 内建回调任务（V13）：代码注册、不进 YAML 定义序列化（防误删），
        # 但进 _tasks_cache 参与调度观察（运行时状态落 tasks_state.json、
        # 执行历史落 task_executions.yaml）。YAML 热重载后由 _inject_builtins
        # 重新注入，真相源在代码不在 YAML。
        self._builtin_tasks: Dict[str, Task] = {}
        self._repair_monitor_task: Optional[asyncio.Task] = None

        # 热加载跟踪（记录文件修改时间，变更时自动重读）
        self._tasks_mtime: Optional[float] = None
        self._executions_mtime: Optional[float] = None
        
        # 用户任务索引
        self._user_tasks: Dict[str, List[str]] = {}
        
        # YAML 合法性兜底监控
        self._yaml_valid = True
        self._yaml_invalid_since: Optional[float] = None  # time.time() 时间戳
        self._last_warning_time: Optional[float] = None   # 上次警告时间

        # 热加载解析失败计数（BE-COR-M6：同一文件连续两次解析失败才判定损坏并备份）
        self._parse_failures: Dict[str, int] = {}
        
        # 加载初始数据
        self._load_from_disk()
        
        logger.info(f"TaskStorage 初始化完成，数据目录: {self.data_dir}")
    
    # ============ 文件操作 ============
    
    def _serialize(self, data: Dict) -> str:
        """序列化为 YAML（或 JSON 降级）"""
        if YAML_AVAILABLE:
            return yaml.dump(data, default_flow_style=False, allow_unicode=True, sort_keys=False, indent=2)
        return json.dumps(data, ensure_ascii=False, indent=2)
    
    def _deserialize(self, content: str) -> Optional[Dict]:
        """从 YAML（或 JSON 降级）反序列化"""
        if YAML_AVAILABLE:
            try:
                return yaml.safe_load(content)
            except yaml.YAMLError:
                pass
            # YAML 失败后尝试 JSON
        try:
            return json.loads(content)
        except json.JSONDecodeError:
            return None
    
    def _atomic_write(self, file_path: Path, data: Dict[str, Any]) -> bool:
        """
        原子写入文件
        
        策略：
        1. 写入临时文件
        2. 原子重命名（保证完整性）
        
        Args:
            file_path: 目标文件路径
            data: 要写入的数据
            
        Returns:
            是否写入成功
        """
        temp_fd = None
        temp_path = None
        
        try:
            temp_fd, temp_path = tempfile.mkstemp(
                dir=str(file_path.parent),
                suffix='.tmp',
                prefix=file_path.stem + '_'
            )
            
            content = self._serialize(data)
            with os.fdopen(temp_fd, 'w', encoding='utf-8') as f:
                f.write(content)
                temp_fd = None
            
            os.replace(temp_path, file_path)
            return True
            
        except Exception as e:
            logger.error(f"原子写入失败 {file_path}: {e}")
            if temp_fd is not None:
                try: os.close(temp_fd)
                except: pass
            if temp_path and os.path.exists(temp_path):
                try: os.unlink(temp_path)
                except: pass
            return False
    
    def _load_file(self, file_path: Path) -> Optional[Dict[str, Any]]:
        """
        安全加载文件（YAML 优先，JSON 降级）
        
        Args:
            file_path: 文件路径
            
        Returns:
            解析后的数据，失败返回 None
        """
        try:
            if not file_path.exists():
                return None
            
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()
            
            result = self._deserialize(content)
            if result is not None:
                self._yaml_valid = True
                self._yaml_invalid_since = None
                self._parse_failures.pop(str(file_path), None)
                return result

            # 解析失败：同一文件连续两次才判定为损坏并备份为 .bak。
            # 这样可以避免"写入中途被读到半截 YAML"被误判并改名（BE-COR-M6）。
            logger.error(f"文件解析失败 {file_path}")
            self._mark_yaml_invalid()
            key = str(file_path)
            fails = self._parse_failures.get(key, 0) + 1
            self._parse_failures[key] = fails
            if fails >= 2:
                backup_path = file_path.with_suffix('.bak')
                try:
                    file_path.rename(backup_path)
                    logger.info(f"已连续 {fails} 次解析失败，备份损坏文件到 {backup_path}")
                except Exception:
                    pass
                self._parse_failures.pop(key, None)
            else:
                logger.warning(f"文件 {file_path} 第 {fails} 次解析失败，暂不备份（等待下次重试）")
            return None
            
        except Exception as e:
            logger.error(f"加载文件失败 {file_path}: {e}")
            self._mark_yaml_invalid()
            return None
    
    def _has_tasks_dir(self) -> bool:
        """检查 tasks/ 目录是否存在且有 yaml 文件"""
        if not self.tasks_dir.exists():
            return False
        return len(list(self.tasks_dir.glob("*.yaml"))) > 0

    def _mark_yaml_invalid(self):
        """标记 YAML 文件为非法状态"""
        import time
        self._yaml_valid = False
        if self._yaml_invalid_since is None:
            self._yaml_invalid_since = time.time()
    
    @property
    def yaml_valid(self) -> bool:
        """YAML 文件当前是否合法"""
        return self._yaml_valid
    
    @property
    def yaml_invalid_duration(self) -> Optional[float]:
        """YAML 文件已非法持续秒数，合法则返回 None"""
        if self._yaml_valid or self._yaml_invalid_since is None:
            return None
        import time
        return time.time() - self._yaml_invalid_since
    
    # ============ 缓存管理 ============
    
    def _check_reload(self) -> None:
        """检查文件是否已变更，是则自动重载缓存。"""
        # 检查 tasks/ 目录或 tasks.yaml
        try:
            if self._using_tasks_dir or self._has_tasks_dir():
                self._check_tasks_dir_reload()
            else:
                # 回退到 tasks.yaml
                current_mtime = self.tasks_file.stat().st_mtime
                if self._tasks_mtime is not None and current_mtime != self._tasks_mtime:
                    logger.info(f"[TaskStorage] 检测到 tasks.yaml 已变更，自动重载...")
                    self._load_tasks_from_disk()
                self._tasks_mtime = current_mtime
        except OSError:
            pass

        # 检查 task_executions.yaml
        try:
            current_mtime = self.executions_file.stat().st_mtime
            if self._executions_mtime is not None and current_mtime != self._executions_mtime:
                logger.info(f"[TaskStorage] 检测到 task_executions.yaml 已变更，自动重载...")
                self._load_executions_from_disk()
            self._executions_mtime = current_mtime
        except OSError:
            pass

    def _check_tasks_dir_reload(self) -> None:
        """检测 tasks/ 目录中的文件变更（文件添加/删除/修改）"""
        try:
            if not self.tasks_dir.exists():
                return
            yaml_files = sorted(self.tasks_dir.glob("*.yaml"))
            current_mtimes = {f.name: f.stat().st_mtime for f in yaml_files}
            if self._tasks_dir_file_mtimes != current_mtimes:
                logger.info("[TaskStorage] 检测到 tasks/ 文件已变更，自动重载...")
                if not self._load_tasks_from_directory():
                    # tasks/ 已空，回退到 tasks.yaml
                    self._using_tasks_dir = False
                    self._load_tasks_from_disk()
            self._tasks_dir_file_mtimes = current_mtimes
        except Exception as e:
            logger.debug(f"检查 tasks/ 变更失败: {e}")

    def _migrate_from_json(self, json_path: Path, yaml_path: Path) -> Optional[Dict]:
        """将旧 JSON 文件迁移到 YAML，返回数据"""
        if not json_path.exists():
            return None
        try:
            with open(json_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            # 写入 YAML
            if YAML_AVAILABLE:
                with open(yaml_path, 'w', encoding='utf-8') as f:
                    yaml.dump(data, f, default_flow_style=False, allow_unicode=True, sort_keys=False, indent=2)
                logger.info(f"已自动迁移 {json_path.name} → {yaml_path.name}")
            return data
        except Exception as e:
            logger.warning(f"迁移 {json_path.name} 失败: {e}")
            return None

    def _load_tasks_from_disk(self) -> None:
        """从磁盘加载任务数据到缓存。"""
        tasks_data = self._load_file(self.tasks_file)
        if tasks_data is None:
            # 自动从旧 JSON 迁移
            json_path = self.tasks_file.with_suffix('.json')
            tasks_data = self._migrate_from_json(json_path, self.tasks_file)
        if tasks_data:
            processed = []
            for t in tasks_data.get('tasks', []):
                # 兼容 ISO 格式时间字符串（人工编辑任务 JSON 时更可读）
                for key in ('created_at', 'last_run', 'next_run'):
                    val = t.get(key)
                    if isinstance(val, str):
                        try:
                            t[key] = datetime.fromisoformat(val).timestamp()
                        except ValueError:
                            pass
                processed.append(Task.from_dict(t))
            self._tasks_cache = {p.task_id: p for p in processed}
            self._inject_builtins()
            self._rebuild_user_index()
            self._tasks_dirty = False
            logger.info(f"[TaskStorage] 已加载 {len(self._tasks_cache)} 个任务")
            # 记录 mtime
            try:
                self._tasks_mtime = self.tasks_file.stat().st_mtime
            except OSError:
                pass

    def _load_tasks_from_directory(self) -> bool:
        """
        从 tasks/*.yaml 加载任务定义，合并运行时状态。
        
        Returns:
            是否成功加载（至少一个任务）
        """
        if not self._has_tasks_dir():
            return False
        
        yaml_files = sorted(self.tasks_dir.glob("*.yaml"))
        if not yaml_files:
            return False
        
        # 加载运行时状态
        state = self._load_state()
        
        tasks = {}
        for yf in yaml_files:
            data = self._load_file(yf)
            if data is None or not isinstance(data, dict):
                logger.warning(f"跳过无效任务文件: {yf.name}")
                continue
            
            # 基于文件名生成稳定的 task_id
            filename_hash = hashlib.md5(yf.stem.encode('utf-8')).hexdigest()[:12]
            task_id = f"task_{filename_hash}"
            data["task_id"] = task_id
            
            # 映射友好字段名到模型字段名
            for yaml_key, model_key in {"name": "task_name"}.items():
                if yaml_key in data and model_key not in data:
                    data[model_key] = data.pop(yaml_key)
            
            # 自动填充默认值
            data.setdefault("user_id", "default")
            data.setdefault("target_type", "main_task")
            data.setdefault("repeat", True)
            
            # 如果存在 schedule 字段，自动推导 schedule_type/schedule_config
            schedule = data.get("schedule")
            if schedule is not None:
                try:
                    from .schedule_parser import ScheduleParser
                    sc = ScheduleParser.parse(schedule)
                    if sc.mode != "invalid":
                        data["schedule_type"] = "delay" if sc.mode == "delay" else "scheduled"
                        sconfig = {"mode": sc.mode}
                        if sc.time:
                            parts = sc.time.split(":")
                            if len(parts) == 2:
                                sconfig["hour"] = int(parts[0])
                                sconfig["minute"] = int(parts[1])
                        data["schedule_config"] = sconfig
                except Exception as e:
                    logger.warning(f"解析任务 {yf.name} 的 schedule 字段失败: {e}")

            # 解析 model 字段：支持字符串简写或结构化字典
            model = data.get("model")
            if model is not None:
                if isinstance(model, str):
                    data["model_id"] = model
                elif isinstance(model, dict):
                    data["model_id"] = model.get("id")
                    data["provider_id"] = model.get("provider")

            # 解析顶层 provider 字段：可与 model 并列书写（model: X + provider: Y）。
            # 若 model 字典内已给出 provider，则以字典写法为准（此处不覆盖）。
            provider = data.get("provider")
            if provider and not data.get("provider_id"):
                data["provider_id"] = provider

            # 合并运行时状态
            if task_id in state:
                task_state = state[task_id]
                for key in ("next_run", "last_run", "run_count"):
                    if key in task_state and task_state[key] is not None:
                        data[key] = task_state[key]
            
            try:
                task = Task.from_dict(data)
                tasks[task.task_id] = task
            except Exception as e:
                logger.error(f"创建任务对象失败 {yf.name}: {e}")
        
        if tasks:
            self._tasks_cache = tasks
            self._inject_builtins()
            self._rebuild_user_index()
            self._tasks_dirty = True
            self._using_tasks_dir = True
            self._tasks_dir_file_mtimes = {f.name: f.stat().st_mtime for f in yaml_files}
            logger.info(f"[TaskStorage] 已从 tasks/ 加载 {len(tasks)} 个任务")
            return True
        
        logger.warning("[TaskStorage] tasks/ 目录无有效任务文件")
        return False

    def _load_state(self) -> dict:
        """从 state_file 加载运行时状态（兼容 YAML/JSON 两种格式）"""
        try:
            if self.state_file.exists():
                with open(self.state_file, 'r', encoding='utf-8') as f:
                    content = f.read()
                data = self._deserialize(content)
                if data is None:
                    logger.warning(f"state_file 解析失败，以空状态继续")
                    return {}
                # 兼容新版 {tasks: {...}} 和旧版直接 {...}
                return data.get("tasks", data) if isinstance(data, dict) else {}
        except Exception as e:
            logger.error(f"加载运行时状态失败: {e}")
        return {}

    def _save_state(self) -> bool:
        """保存运行时状态到 state_file（加锁，避免并发写交叉/banner 覆盖）"""
        with self.state_lock:
            state = {}
            for task_id, task in list(self._tasks_cache.items()):
                state[task_id] = {
                    "next_run": task.next_run,
                    "last_run": task.last_run,
                    "run_count": task.run_count,
                }
            data = {
                "version": 2,
                "updated_at": datetime.now().isoformat(),
                "tasks": state,
            }
            return self._atomic_write(self.state_file, data)

    async def _async_save_state(self) -> None:
        """异步保存运行时状态到 state_file"""
        if self._save_state():
            logger.debug(f"运行时状态已保存到 {self.state_file}")

    def _load_executions_from_disk(self) -> None:
        """从磁盘加载执行历史到缓存。"""
        executions_data = self._load_file(self.executions_file)
        if executions_data:
            executions_list = [
                TaskExecution.from_dict(e)
                for e in executions_data.get('executions', [])
            ]
            self._executions_cache = {}
            for exec in executions_list:
                if exec.task_id not in self._executions_cache:
                    self._executions_cache[exec.task_id] = []
                self._executions_cache[exec.task_id].append(exec)
            self._executions_dirty = False
            logger.info(f"[TaskStorage] 已加载 {len(executions_list)} 条执行记录")
            try:
                self._executions_mtime = self.executions_file.stat().st_mtime
            except OSError:
                pass

    def _load_from_disk(self) -> None:
        """从磁盘加载所有数据到内存缓存（初始化时调用）。"""
        # 优先从 tasks/ 目录加载，失败则回退到 tasks.yaml
        if not self._load_tasks_from_directory():
            self._load_tasks_from_disk()
        self._load_executions_from_disk()
    
    def _save_tasks_to_disk(self) -> bool:
        """将任务缓存保存到磁盘（时间字段输出 ISO 格式，方便人工阅读和修改）"""
        # tasks/ 模式下只保存运行时状态，不写 task YAML 文件
        if self._using_tasks_dir:
            return self._save_state()
        with self.tasks_lock:
            tasks_dict = []
            for t in list(self._tasks_cache.values()):
                # 内建任务定义真相源在代码，不写 tasks.yaml（防误删/防编辑歧义）
                if t.task_id in self._builtin_tasks:
                    continue
                td = t.to_dict()
                # 时间戳转 ISO 格式字符串
                for key in ('created_at', 'last_run', 'next_run'):
                    val = td.get(key)
                    if val is not None:
                        td[key] = datetime.fromtimestamp(val).isoformat()
                tasks_dict.append(td)
            data = {
                "version": 1,
                "updated_at": datetime.now().isoformat(),
                "tasks": tasks_dict
            }
            
            if self._atomic_write(self.tasks_file, data):
                self._tasks_dirty = False
                # V13: tasks.yaml 模式下内建任务无定义文件可带出状态，
                # 显式补写 tasks_state.json 保证执行观测不随存储模式退化。
                if self._builtin_tasks:
                    self._save_state()
                return True
            return False
    
    def _save_executions_to_disk(self) -> bool:
        """将执行历史保存到磁盘"""
        with self.executions_lock:
            all_executions = []
            for exec_list in list(self._executions_cache.values()):
                all_executions.extend(exec_list)
            
            data = {
                "version": 1,
                "updated_at": datetime.now().isoformat(),
                "executions": [e.to_dict() for e in all_executions]
            }
            
            if self._atomic_write(self.executions_file, data):
                self._executions_dirty = False
                return True
            return False
    
    def flush(self) -> bool:
        """同步落盘任务定义/运行时状态与执行历史（重绑前调用）。"""
        tasks_ok = self._save_tasks_to_disk()
        executions_ok = self._save_executions_to_disk()
        return tasks_ok and executions_ok

    def _rebuild_user_index(self) -> None:
        """重建用户任务索引"""
        self._user_tasks = {}
        for task_id, task in self._tasks_cache.items():
            if task.user_id not in self._user_tasks:
                self._user_tasks[task.user_id] = []
            self._user_tasks[task.user_id].append(task_id)
    
    # ============ 任务 CRUD ============
    
    def create_task(self, user_id: str, task_name: str, prompt: str,
                    schedule_type: str, schedule_config: Dict[str, Any],
                    enabled: bool = True, repeat: bool = False,
                    target_type: str = "main_task", target_session: Optional[str] = None) -> Task:
        """
        创建新任务
        
        Args:
            user_id: 用户ID
            task_name: 任务名称
            prompt: 任务提示词
            schedule_type: 调度类型 (delay/scheduled)
            schedule_config: 调度配置
            enabled: 是否启用
            repeat: 是否重复
            target_type: 发送目标类型
            target_session: 目标会话ID
            
        Returns:
            创建的任务对象
            
        Raises:
            ValueError: 超出限制或参数错误
        """
        # 验证用户任务数限制
        user_tasks = self._user_tasks.get(user_id, [])
        if len(user_tasks) >= self.MAX_TASKS_PER_USER:
            raise ValueError(f"用户任务数已达到上限 ({self.MAX_TASKS_PER_USER})")
        
        # 验证提示词长度
        if len(prompt) > self.MAX_PROMPT_LENGTH:
            raise ValueError(f"提示词长度超过限制 ({self.MAX_PROMPT_LENGTH})")
        
        # 创建任务
        task = Task.create(
            user_id=user_id,
            task_name=task_name,
            prompt=prompt,
            schedule_type=schedule_type,
            schedule_config=schedule_config,
            enabled=enabled,
            repeat=repeat,
            target_type=target_type,
            target_session=target_session
        )
        
        # 添加到缓存
        self._tasks_cache[task.task_id] = task
        if user_id not in self._user_tasks:
            self._user_tasks[user_id] = []
        self._user_tasks[user_id].append(task.task_id)
        self._tasks_dirty = True

        # BE-COR-M13: 请求路径内同步落盘，保证 create_task 返回后磁盘即为最新
        self._save_tasks_to_disk()

        logger.info(f"创建任务: {task.task_id} - {task_name} (用户: {user_id})")
        return task
    
    async def _async_save_tasks(self) -> None:
        """异步保存任务到磁盘"""
        if self._save_tasks_to_disk():
            logger.debug(f"任务数据已保存到 {self.tasks_file}")
    
    def _auto_reload(self) -> None:
        """自动检查并重载数据（所有读操作前调用）。"""
        self._check_reload()

    def get_task(self, task_id: str) -> Optional[Task]:
        """
        获取单个任务
        
        Args:
            task_id: 任务ID
            
        Returns:
            任务对象，不存在返回 None
        """
        self._auto_reload()
        return self._tasks_cache.get(task_id)
    
    def get_user_tasks(self, user_id: str) -> List[Task]:
        """
        获取用户的所有任务
        
        Args:
            user_id: 用户ID
            
        Returns:
            任务列表
        """
        self._auto_reload()
        task_ids = self._user_tasks.get(user_id, [])
        return [self._tasks_cache[tid] for tid in task_ids if tid in self._tasks_cache]
    
    def get_enabled_tasks(self) -> List[Task]:
        """
        获取所有启用的任务
        
        Returns:
            启用的任务列表
        """
        self._auto_reload()
        return [t for t in self._tasks_cache.values() if t.enabled]
    
    def get_all_tasks(self) -> List[Task]:
        """
        获取所有任务
        
        Returns:
            所有任务列表
        """
        self._auto_reload()
        return list(self._tasks_cache.values())
    
    def update_task(self, task_id: str, **kwargs) -> Optional[Task]:
        """
        更新任务
        
        Args:
            task_id: 任务ID
            **kwargs: 要更新的字段
            
        Returns:
            更新后的任务，不存在返回 None
        """
        task = self._tasks_cache.get(task_id)
        if not task:
            return None
        
        # 允许更新的字段
        allowed_fields = {
            'task_name', 'prompt', 'schedule_config', 
            'enabled', 'repeat', 'last_run', 'next_run', 'run_count',
            'target_type', 'target_session'
        }
        
        for key, value in kwargs.items():
            if key in allowed_fields and hasattr(task, key):
                setattr(task, key, value)
        
        self._tasks_dirty = True

        # BE-COR-M13: 请求路径内同步落盘（tasks/ 模式下只保存运行时状态）
        if self._using_tasks_dir:
            self._save_state()
        else:
            self._save_tasks_to_disk()

        logger.info(f"更新任务: {task_id}")
        return task
    
    def delete_task(self, task_id: str) -> bool:
        """
        删除任务
        
        Args:
            task_id: 任务ID
            
        Returns:
            是否删除成功
        """
        if task_id in self._builtin_tasks:
            # 内建任务由代码注册（V13），拒绝经存储层删除；停用走配置门控。
            logger.warning(f"拒绝删除内建任务: {task_id}")
            return False
        task = self._tasks_cache.get(task_id)
        if not task:
            return False
        
        user_id = task.user_id
        
        # 从缓存中删除
        del self._tasks_cache[task_id]
        if task_id in self._user_tasks.get(user_id, []):
            self._user_tasks[user_id].remove(task_id)
        
        # 删除相关的执行历史
        if task_id in self._executions_cache:
            del self._executions_cache[task_id]
            self._executions_dirty = True
        
        self._tasks_dirty = True

        # BE-COR-M13: 请求路径内同步落盘
        self._save_tasks_to_disk()
        self._save_executions_to_disk()

        logger.info(f"删除任务: {task_id}")
        return True
    
    # ============ 内建回调任务（V13） ============
    
    def register_builtin(self, task: Task) -> Task:
        """注册内建回调任务（代码注册，供 TaskScheduler.register_builtin 调用）。

        语义与 YAML 任务对齐的唯一差异：定义不进 tasks.yaml/tasks/ 序列化。
        - 进 _tasks_cache -> get_enabled_tasks 可见、update_task 可写运行时状态、
          _save_state 落 tasks_state.json（观测）、record_execution 落执行历史；
        - 若 tasks_state.json 存有该 task_id 的运行时状态则回并，
          重启后 next_run 语义与 YAML 任务一致（错过时刻由 tick 判定补跑）。
        同名（同 task_id）重复注册为幂等替换。
        """
        state = self._load_state()
        st = state.get(task.task_id) or {}
        for key in ("next_run", "last_run", "run_count"):
            val = st.get(key)
            if val is not None:
                setattr(task, key, val)
        self._builtin_tasks[task.task_id] = task
        self._tasks_cache[task.task_id] = task
        self._rebuild_user_index()
        logger.info(
            f"[TaskStorage] 内建任务已注册: {task.task_id} "
            f"schedule={task.schedule!r} next_run={task.next_run}"
        )
        return task

    def get_builtin_tasks(self) -> Dict[str, Task]:
        """返回内建任务注册表副本（重绑到新存储时转移注册）。"""
        return dict(self._builtin_tasks)

    def _inject_builtins(self) -> None:
        """YAML 重载整体替换 _tasks_cache 后重新注入内建任务（真相源在代码）。"""
        if not self._builtin_tasks:
            return
        for task_id, task in self._builtin_tasks.items():
            self._tasks_cache[task_id] = task
    
    async def _async_save_executions(self) -> None:
        """异步保存执行历史到磁盘"""
        if self._save_executions_to_disk():
            logger.debug(f"执行历史已保存到 {self.executions_file}")
    
    # ============ 执行历史 ============
    
    def record_execution(self, task_id: str, status: str,
                         session_id: Optional[str] = None,
                         error_message: Optional[str] = None) -> TaskExecution:
        """
        记录任务执行
        
        Args:
            task_id: 任务ID
            status: 执行状态
            session_id: OpenCode 会话ID
            error_message: 错误信息
            
        Returns:
            执行记录
        """
        execution = TaskExecution.create(task_id)
        execution.status = status
        execution.session_id = session_id
        
        if status in ['success', 'failed']:
            execution.completed_at = datetime.now().timestamp()
        
        if error_message:
            execution.error_message = error_message
        
        # 添加到缓存
        if task_id not in self._executions_cache:
            self._executions_cache[task_id] = []
        
        self._executions_cache[task_id].append(execution)
        self._executions_dirty = True
        
        # 清理旧记录
        self._prune_executions(task_id)

        # BE-COR-M13: 请求路径内同步落盘
        self._save_executions_to_disk()

        return execution
    
    def _prune_executions(self, task_id: str) -> None:
        """
        清理任务的旧执行记录
        
        策略：
        1. 只保留最近 MAX_EXECUTIONS_PER_TASK 条
        2. 删除超过 MAX_EXECUTION_AGE_DAYS 天的记录
        """
        if task_id not in self._executions_cache:
            return
        
        executions = self._executions_cache[task_id]
        
        # 按时间排序（最新的在前）
        executions.sort(key=lambda e: e.started_at or 0, reverse=True)
        
        # 计算时间戳边界
        cutoff_time = datetime.now().timestamp() - (self.MAX_EXECUTION_AGE_DAYS * 24 * 3600)
        
        # 保留条件：在保留数量内 且 未过期
        kept = []
        for i, exec in enumerate(executions):
            if i < self.MAX_EXECUTIONS_PER_TASK:
                if exec.started_at and exec.started_at > cutoff_time:
                    kept.append(exec)
        
        removed_count = len(executions) - len(kept)
        if removed_count > 0:
            logger.debug(f"清理任务 {task_id} 的 {removed_count} 条旧执行记录")
        
        self._executions_cache[task_id] = kept
    
    def get_execution_history(self, task_id: str, limit: int = 100,
                              offset: int = 0) -> List[TaskExecution]:
        """
        获取任务执行历史
        
        Args:
            task_id: 任务ID
            limit: 返回数量限制
            offset: 偏移量
            
        Returns:
            执行记录列表
        """
        executions = self._executions_cache.get(task_id, [])
        
        # 按时间排序（最新的在前）
        sorted_executions = sorted(
            executions,
            key=lambda e: e.started_at or 0,
            reverse=True
        )
        
        return sorted_executions[offset:offset + limit]
    
    def get_executions_by_state(self, state: TaskExecutionState,
                                 started_before: Optional[float] = None) -> List[TaskExecution]:
        """
        获取指定状态的执行记录
        
        Args:
            state: 执行状态
            started_before: 开始时间早于该时间戳
            
        Returns:
            执行记录列表
        """
        result = []
        for exec_list in self._executions_cache.values():
            for exec in exec_list:
                if exec.status == state.value:
                    if started_before is None or (exec.started_at and exec.started_at < started_before):
                        result.append(exec)
        return result
    
    def update_execution(self, execution: TaskExecution) -> bool:
        """
        更新执行记录
        
        Args:
            execution: 执行记录对象
            
        Returns:
            是否更新成功
        """
        if execution.task_id not in self._executions_cache:
            return False
        
        executions = self._executions_cache[execution.task_id]
        for i, exec in enumerate(executions):
            if exec.execution_id == execution.execution_id:
                executions[i] = execution
                self._executions_dirty = True

                # BE-COR-M13: 请求路径内同步落盘
                self._save_executions_to_disk()

                return True
        
        return False
    
    # ============ 统计 ============
    
    def count_tasks(self) -> int:
        """获取任务总数"""
        return len(self._tasks_cache)
    
    def count_enabled_tasks(self) -> int:
        """获取启用的任务数"""
        return sum(1 for t in self._tasks_cache.values() if t.enabled)
    
    # ============ YAML 兜底修复监控 ============
    
    REPAIR_WARN_DELAY = 300  # YAML 非法持续 5 分钟后发警告
    REPAIR_CHECK_INTERVAL = 60  # 每分钟检查一次
    
    async def _repair_monitor_loop(self):
        """后台循环：YAML 非法超过 5 分钟后向主智能体发警告，持续到合法为止"""
        import asyncio
        logger.info("[YAML监控] 兜底修复监控已启动")
        while True:
            try:
                await asyncio.sleep(self.REPAIR_CHECK_INTERVAL)
                
                if self._yaml_valid:
                    self._last_warning_time = None
                    continue
                
                duration = self.yaml_invalid_duration
                if duration is None or duration < self.REPAIR_WARN_DELAY:
                    continue
                
                # 每 5 分钟发一次警告（避免刷屏）
                now = __import__('time').time()
                if self._last_warning_time is not None and (now - self._last_warning_time) < self.REPAIR_WARN_DELAY:
                    continue
                
                self._last_warning_time = now
                logger.warning(f"[YAML监控] YAML 已非法 {duration:.0f}秒，向主智能体发送修复警告")
                
                try:
                    from services.ai_client_factory import acquire_ai_client as acquire_opencode_client  # 双通道工厂，别名保留测试缝
                    from services.stt_session_manager import get_session_manager
                    gw = await acquire_opencode_client()

                    # 解析真实 main-task 会话 ID（修复此前硬编码 "main" 导致的投递丢失）
                    warn_session_id = "main-task"
                    try:
                        sm = get_session_manager()
                        real_sid = sm.get_agent_session("main-task")
                        if real_sid:
                            warn_session_id = real_sid
                    except Exception:
                        pass

                    await gw.send_message(
                        session_id=warn_session_id,
                        message=(
                            "【系统警告】定时任务配置文件（tasks.yaml）解析失败，"
                            f"已持续 {duration:.0f} 秒。\n\n"
                            "请立即修复此文件：\n"
                            "1. 检查 tasks/ 目录下各 YAML 文件格式\n"
                            "2. 修复 YAML 缩进和语法问题\n"
                            "3. 修复后系统会自动加载\n\n"
                            "警告将持续每 5 分钟发送一次，直到文件合法为止。"
                        ),
                        agent="main-task"
                    )
                except Exception as e:
                    logger.error(f"[YAML监控] 发送修复警告失败: {e}")
                    
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"[YAML监控] 循环异常: {e}")
    
    def start_repair_monitor(self) -> Optional[asyncio.Task]:
        """启动 YAML 兜底修复监控（在事件循环中调用），返回任务句柄。"""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            logger.warning("[YAML监控] 无可用事件循环，稍后会在调度器中启动")
            return None
        existing = self._repair_monitor_task
        if existing is not None and not existing.done():
            return existing
        self._repair_monitor_task = loop.create_task(self._repair_monitor_loop())
        logger.info("[YAML监控] 已注册后台任务")
        return self._repair_monitor_task

    def cancel_repair_monitor(self) -> Optional[asyncio.Task]:
        """取消 YAML 监控任务并清空句柄；返回被取消的任务供调用方 await。"""
        task = self._repair_monitor_task
        self._repair_monitor_task = None
        if task is not None and not task.done():
            task.cancel()
        return task
    
    def get_storage_size(self) -> Dict[str, int]:
        """
        获取存储大小
        
        Returns:
            文件大小信息（字节）
        """
        if self._using_tasks_dir:
            tasks_size = sum(f.stat().st_size for f in self.tasks_dir.glob("*.yaml") if f.exists())
            state_size = self.state_file.stat().st_size if self.state_file.exists() else 0
        else:
            tasks_size = self.tasks_file.stat().st_size if self.tasks_file.exists() else 0
            state_size = 0
        executions_size = self.executions_file.stat().st_size if self.executions_file.exists() else 0
        
        return {
            "tasks_file": tasks_size,
            "state_file": state_size,
            "executions_file": executions_size,
            "total": tasks_size + state_size + executions_size
        }


# 全局单例
_task_storage_instance: Optional[TaskStorage] = None


def get_task_storage() -> TaskStorage:
    """获取 TaskStorage 单例"""
    global _task_storage_instance
    if _task_storage_instance is None:
        _task_storage_instance = TaskStorage()
    return _task_storage_instance


def init_task_storage(data_dir: Optional[str] = None) -> TaskStorage:
    """
    初始化 TaskStorage
    
    Args:
        data_dir: 数据目录
        
    Returns:
        TaskStorage 实例
    """
    global _task_storage_instance
    _task_storage_instance = TaskStorage(data_dir)
    return _task_storage_instance