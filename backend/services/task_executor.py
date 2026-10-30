"""
任务执行器
负责执行定时任务，包括发送到当前会话/主智能体、重试机制、熔断器
"""
import asyncio
import logging
import time
from typing import Optional, Callable, Dict
from datetime import datetime

from .task_models import Task, TaskExecution, TaskExecutionState
from .task_config import (
    TASK_MAX_RETRIES,
    TASK_RETRY_DELAY_BASE,
    CIRCUIT_BREAKER_THRESHOLD,
    CIRCUIT_BREAKER_COOLDOWN,
    TASK_EXECUTION_TIMEOUT
)
from .stt_session_manager import get_session_manager
# 双通道工厂（别名保留原符号名，调用点零改动）
from .ai_client_factory import acquire_ai_client as acquire_opencode_client
from .task_storage import get_task_storage

logger = logging.getLogger(__name__)


class CircuitBreakerOpen(Exception):
    """熔断器打开异常"""
    pass


class TaskExecutor:
    """
    任务执行器
    
    功能：
    - 发送任务提示词到当前会话/主智能体
    - 失败重试（指数退避）
    - 熔断器保护
    - 通知 SupervisorService 监控会话
    """
    
    def __init__(self):
        """
        初始化执行器
        """
        # 熔断器状态（BE-COR-M1：按 task_id 维度隔离）
        # 单任务反复失败只影响该任务，不再影响其它任务的执行。
        self._task_failures: Dict[str, int] = {}       # task_id -> 连续失败次数
        self._circuit_open_until: Dict[str, float] = {}  # task_id -> 熔断恢复时间戳

        logger.info("TaskExecutor 初始化完成")

    async def execute(self, task: Task) -> bool:
        """
        执行任务

        Args:
            task: 要执行的任务

        Returns:
            是否执行成功

        Raises:
            CircuitBreakerOpen: 该任务熔断器打开时
        """
        task_id = task.task_id

        # 检查该任务的熔断器（仅影响本任务）
        if self._is_circuit_open(task_id):
            raise CircuitBreakerOpen(
                f"任务 {task_id} 熔断器打开，暂时不可用"
                f"（{self._get_circuit_cooldown(task_id)}秒后恢复）"
            )

        # 执行重试循环
        for attempt in range(TASK_MAX_RETRIES + 1):
            try:
                success = await self._execute_once(task)

                if success:
                    # 执行成功，重置该任务的失败计数
                    self._reset_failures(task_id)
                    return True

                # 执行失败但未抛出异常
                self._record_failure(task_id)

                # 检查是否需要打开该任务的熔断器
                if self._is_circuit_open(task_id):
                    return False

                # 如果不是最后一次尝试，等待后重试
                if attempt < TASK_MAX_RETRIES:
                    delay = self._calculate_retry_delay(attempt)
                    logger.warning(
                        f"任务 {task_id} 第 {attempt + 1} 次执行失败，"
                        f"{delay}秒后重试..."
                    )
                    await asyncio.sleep(delay)

            except CircuitBreakerOpen:
                raise

            except Exception as e:
                logger.error(f"任务 {task_id} 执行异常: {e}")
                self._record_failure(task_id)

                # 检查是否需要打开该任务的熔断器
                if self._is_circuit_open(task_id):
                    return False

                # 如果不是最后一次尝试，等待后重试
                if attempt < TASK_MAX_RETRIES:
                    delay = self._calculate_retry_delay(attempt)
                    logger.warning(
                        f"任务 {task_id} 第 {attempt + 1} 次执行异常，"
                        f"{delay}秒后重试..."
                    )
                    await asyncio.sleep(delay)

        # 所有重试都失败了
        logger.error(f"任务 {task_id} 在 {TASK_MAX_RETRIES + 1} 次尝试后仍失败")
        return False
    
    async def execute_task_now(self, task: Task) -> bool:
        """
        立即执行任务（用于手动触发）
        
        Args:
            task: 要执行的任务
            
        Returns:
            是否执行成功
        """
        return await self._execute_once(task)
    
    async def _execute_once(self, task: Task) -> bool:
        """
        单次执行任务 - 根据配置发送到不同目标
        
        Args:
            task: 要执行的任务
            
        Returns:
            是否执行成功
        """
        try:
            # 1. 根据target_type获取目标会话
            session_id, is_new_session = await self._get_target_session_by_config(task)
            
            if not session_id:
                logger.error(f"无法为任务 {task.task_id} 获取目标会话")
                return False
            
            logger.info(f"任务 {task.task_id} 使用会话: {session_id} (target_type={task.target_type})")
            
            # 2. 发送任务消息
            success = await self._send_message_with_config(session_id, task)
            
            # 3. 如果是新建会话模式且发送成功，可选：关闭临时会话（根据需求决定是否保留）
            if is_new_session and success and task.target_type == "new_session":
                # 这里可以选择是否关闭临时会话
                # await self._close_temporary_session(session_id)
                pass
            
            if success:
                logger.info(f"任务 {task.task_id} 消息发送成功")
                # scheduler已记录执行记录和run_count，这里只更新最后执行时间
                try:
                    storage = get_task_storage()
                    storage.update_task(
                        task.task_id,
                        last_run=time.time()
                    )
                except Exception as e:
                    logger.error(f"更新任务 {task.task_id} 执行状态失败: {e}")
                return True
            else:
                logger.error(f"任务 {task.task_id} 消息发送失败")
                try:
                    storage = get_task_storage()
                    storage.update_task(
                        task.task_id,
                        last_run=time.time()
                    )
                except Exception as e:
                    logger.error(f"更新任务 {task.task_id} 状态异常: {e}")
                return False
            
        except asyncio.TimeoutError:
            logger.error(f"任务 {task.task_id} 执行超时")
            return False
        
        except Exception as e:
            logger.error(f"任务 {task.task_id} 执行失败: {e}")
            return False
    
    async def _get_target_session_by_config(self, task: Task) -> tuple[Optional[str], bool]:
        """
        根据任务配置获取目标会话ID
        
        Args:
            task: 任务对象
            
        Returns:
            (session_id, is_new_session) - 会话ID和是否为新创建的会话
        """
        session_manager = get_session_manager()
        gw = await acquire_opencode_client()
        is_new_session = False
        
        try:
            if task.target_type == "specific" and task.target_session:
                # 发送到指定会话
                session_id = task.target_session
                # 验证会话是否有效
                try:
                    result = await gw.get_session_status(session_id)
                    if not result.get('ok'):
                        logger.warning(f"指定会话 {session_id} 已失效")
                        return None, False
                except Exception as e:
                    logger.warning(f"验证指定会话失败: {e}")
                    return None, False
                logger.debug(f"使用指定会话: {session_id}")
                return session_id, False
                
            elif task.target_type == "current":
                # 发送到当前会话
                current_session = session_manager.get_current_session()
                if current_session:
                    logger.debug(f"使用当前会话: {current_session.session_id}")
                    return current_session.session_id, False
                else:
                    logger.error("没有当前会话可用")
                    return None, False
                    
            elif task.target_type == "new_session":
                # 新建会话
                try:
                    result = await gw.create_session(
                        title=f"定时任务会话 - {task.task_name}"
                    )
                    if not result.get('ok'):
                        error_detail = result.get('error', {}).get('detail', 'unknown error')
                        logger.error(f"创建新会话失败: {error_detail}")
                        return None, False
                    session_id = result['data']['session_id']
                    is_new_session = True
                    logger.info(f"创建新会话用于任务执行: {session_id}")
                    return session_id, True
                except Exception as e:
                    logger.error(f"创建新会话异常: {e}")
                    return None, False
                    
            else:  # main_task 或其他默认值
                # 发送到main-task会话（默认行为）
                main_task_session = session_manager.get_agent_session("main-task")
                if main_task_session:
                    # 验证会话是否仍然有效
                    try:
                        result = await gw.get_session_status(main_task_session)
                        if result.get('ok'):
                            logger.debug(f"使用main-task会话: {main_task_session}")
                            return main_task_session, False
                        else:
                            logger.warning(f"main-task会话已失效")
                    except Exception as e:
                        logger.warning(f"验证main-task会话失败: {e}")
                
                # 如果main-task会话不可用，回退到当前会话
                current_session = session_manager.get_current_session()
                if current_session:
                    logger.warning(f"main-task会话不可用，使用当前会话: {current_session.session_id}")
                    return current_session.session_id, False
                
                logger.error("没有可用的会话")
                return None, False
                
        except Exception as e:
            logger.error(f"获取目标会话失败: {e}")
            return None, False
    
    async def _get_target_session(self) -> Optional[str]:
        """
        获取目标会话ID（当前会话或主智能体会话）- 兼容旧版本
        
        优先使用主智能体会话，如果不存在或无效，则使用当前会话
        
        Returns:
            会话ID，失败返回 None
        """
        try:
            session_manager = get_session_manager()
            gw = await acquire_opencode_client()
            
            # 优先获取主智能体会话
            main_task_session = session_manager.get_agent_session("main-task")
            if main_task_session:
                # 验证会话是否仍然有效
                try:
                    result = await gw.get_session_status(main_task_session)
                    if result.get('ok'):
                        logger.debug(f"使用主智能体会话: {main_task_session}")
                        return main_task_session
                    else:
                        logger.warning(f"主智能体会话 {main_task_session} 已失效，尝试使用当前会话")
                except Exception as e:
                    logger.warning(f"验证主智能体会话失败: {e}")
            
            # 如果没有主智能体会话或已失效，使用当前会话
            current_session = session_manager.get_current_session()
            if current_session:
                logger.debug(f"使用当前会话: {current_session.session_id}")
                return current_session.session_id
            
            logger.error("没有可用的会话（主智能体或当前会话）")
            return None
            
        except Exception as e:
            logger.error(f"获取目标会话失败: {e}")
            return None
    
    async def _send_message_with_config(self, session_id: str, task: Task) -> bool:
        """
        发送任务消息（支持自定义前缀配置）
        
        Args:
            session_id: 会话ID
            task: 任务对象
            
        Returns:
            是否发送成功
        """
        try:
            # 构建消息内容
            message = self._build_message(task)
            
            # 经 OpenCode 客户端信封层发送消息
            gw = await acquire_opencode_client()
            
            # 发送消息（支持按任务覆盖模型配置）
            result = await gw.send_message(
                session_id=session_id,
                message=message,
                agent="main-task",
                model_id=task.model_id,
                provider_id=task.provider_id
            )
            
            if result.get('ok'):
                # 【2026-09-09 取消 web_message 感知记录】任务触发不再写入 perception.jsonl
                # if True:
                #     try:
                #         asyncio.create_task(self._record_task_trigger(task))
                #     except Exception as rec_err:
                #         logger.debug(f"记录任务触发到感知数据异常: {rec_err}")
                return True
            else:
                error_detail = result.get('error', {}).get('detail', 'unknown error')
                logger.error(f"发送消息失败: {error_detail}")
                return False
            
        except asyncio.TimeoutError:
            logger.error(f"发送消息超时（{TASK_EXECUTION_TIMEOUT}秒）")
            return False
        
        except Exception as e:
            logger.error(f"发送消息失败: {e}")
            return False
    
    # 【2026-09-09 取消 web_message 感知记录】方法停用，保留定义以防历史追溯。
    # async def _record_task_trigger(self, task: Task) -> None:
    #     """记录任务触发标题到感知数据
    #
    #     直接调用 append_perception（同一进程内），只记录任务名称，不包含完整提示词。
    #     """
    #     try:
    #         from .perception_store import append_perception
    #         from datetime import datetime, timezone, timedelta
    #         now = datetime.now(timezone(timedelta(hours=8)))
    #         entry = {
    #             "type": "web_message",
    #             "t": now.strftime("%H:%M:%S"),
    #             "content": f"[任务触发] {task.task_name}",
    #             "source": "task_trigger",
    #             "user_qq": str(task.user_id),
    #         }
    #         append_perception(entry, auto_type=False)
    #         logger.debug(f"[TaskTrigger] 已记录到感知数据: {task.task_name}")
    #     except Exception as e:
    #         logger.debug(f"[TaskTrigger] 记录异常（不影响任务执行）: {e}")

    def _build_message(self, task: Task) -> str:
        """
        构建发送给 AI 的消息

        正文首行统一场景前缀 【定时任务】{任务名}（见 ai/AGENTS.md 场景前缀契约）。

        Args:
            task: 任务对象

        Returns:
            消息内容
        """
        message = f"""【定时任务】{task.task_name}
任务ID: {task.task_id}
执行时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
执行次数: {task.run_count}

--- 任务提示词 ---
{task.prompt}
--- 提示词结束 ---

请按照上述提示词执行任务。
"""
        return message
    
    def _calculate_retry_delay(self, attempt: int) -> int:
        """
        计算重试延迟（指数退避）
        
        Args:
            attempt: 当前尝试次数（从0开始）
            
        Returns:
            延迟秒数
        """
        # 指数退避：60s, 120s, 240s
        delay = TASK_RETRY_DELAY_BASE * (2 ** attempt)
        return min(delay, 600)  # 最多600秒（10分钟）
    
    def _record_failure(self, task_id: str) -> None:
        """记录某任务的一次失败，达到阈值则打开该任务的熔断器。"""
        count = self._task_failures.get(task_id, 0) + 1
        self._task_failures[task_id] = count
        if count >= CIRCUIT_BREAKER_THRESHOLD:
            self._open_circuit(task_id)

    def _reset_failures(self, task_id: str) -> None:
        """重置某任务的失败计数并关闭其熔断器。"""
        self._task_failures.pop(task_id, None)
        self._circuit_open_until.pop(task_id, None)

    def _is_circuit_open(self, task_id: str) -> bool:
        """
        检查指定任务的熔断器是否打开

        Args:
            task_id: 任务ID

        Returns:
            是否打开
        """
        until = self._circuit_open_until.get(task_id)
        if not until:
            return False

        # 检查冷却时间是否已过
        now = datetime.now().timestamp()
        if now >= until:
            # 自动关闭该任务的熔断器
            self._reset_failures(task_id)
            logger.info(f"任务 {task_id} 熔断器自动关闭")
            return False

        return True

    def _open_circuit(self, task_id: str) -> None:
        """打开指定任务的熔断器"""
        self._circuit_open_until[task_id] = (
            datetime.now().timestamp() + CIRCUIT_BREAKER_COOLDOWN
        )
        logger.warning(
            f"任务 {task_id} 熔断器已打开，将在 {CIRCUIT_BREAKER_COOLDOWN} 秒（"
            f"{CIRCUIT_BREAKER_COOLDOWN // 60}分钟）后自动关闭"
        )

    def _get_circuit_cooldown(self, task_id: str) -> int:
        """
        获取指定任务熔断器的剩余冷却时间

        Args:
            task_id: 任务ID

        Returns:
            剩余秒数
        """
        until = self._circuit_open_until.get(task_id)
        if not until:
            return 0

        remaining = int(until - datetime.now().timestamp())
        return max(0, remaining)

    def get_status(self) -> dict:
        """
        获取执行器状态

        Returns:
            状态字典（circuit_breaker 为跨任务聚合视图，另含 open_tasks 明细）
        """
        open_tasks: Dict[str, int] = {}
        for task_id in list(self._circuit_open_until.keys()):
            if self._is_circuit_open(task_id):
                open_tasks[task_id] = self._get_circuit_cooldown(task_id)

        return {
            "circuit_breaker": {
                "open": bool(open_tasks),
                "consecutive_failures": max(self._task_failures.values(), default=0),
                "cooldown_seconds": max(open_tasks.values(), default=0),
                "open_tasks": open_tasks,
            },
            "max_retries": TASK_MAX_RETRIES,
            "retry_delay_base": TASK_RETRY_DELAY_BASE,
            "circuit_breaker_threshold": CIRCUIT_BREAKER_THRESHOLD,
            "circuit_breaker_cooldown": CIRCUIT_BREAKER_COOLDOWN
        }


# 全局单例
_task_executor_instance: Optional[TaskExecutor] = None


def get_task_executor() -> TaskExecutor:
    """获取 TaskExecutor 单例"""
    global _task_executor_instance
    if _task_executor_instance is None:
        _task_executor_instance = TaskExecutor()
    return _task_executor_instance


def init_task_executor() -> TaskExecutor:
    """
    初始化 TaskExecutor
    
    Returns:
        TaskExecutor 实例
    """
    global _task_executor_instance
    _task_executor_instance = TaskExecutor()
    return _task_executor_instance