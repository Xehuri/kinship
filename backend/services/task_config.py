"""
定时任务调度器配置
"""

# ============ 调度器配置 ============

# 检查间隔（秒）
# 每2秒检查一次是否有任务到期
TASK_SCHEDULER_CHECK_INTERVAL = 2

# 最大并发执行数
# 同时最多执行5个任务，防止压垮系统
TASK_MAX_CONCURRENT = 5

# 最大重试次数
# 任务失败时最多重试3次
TASK_MAX_RETRIES = 3

# 重试延迟基数（秒）
# 指数退避：60s, 120s, 240s
TASK_RETRY_DELAY_BASE = 60

# 熔断器配置
# 连续失败10次后打开熔断器
CIRCUIT_BREAKER_THRESHOLD = 10
# 熔断器冷却时间（秒）
CIRCUIT_BREAKER_COOLDOWN = 300  # 5分钟

# ============ 执行超时配置 ============

# 任务执行超时（秒）
# 单个任务最多执行5分钟
TASK_EXECUTION_TIMEOUT = 300

# 调度器启动恢复超时（秒）
# 超过此时间仍卡住的执行记录会被标记为失败
RECOVERY_EXECUTION_TIMEOUT = 3600  # 1小时

# ============ 资源限制配置 ============

# 每用户最大任务数
MAX_TASKS_PER_USER = 50

# 提示词最大长度（字符）
MAX_PROMPT_LENGTH = 10000

# 每个任务保留的最大执行历史数
MAX_EXECUTIONS_PER_TASK = 100

# 执行历史保留天数
MAX_EXECUTION_AGE_DAYS = 30

# ============ 存储配置 ============

# 数据目录（相对于backend目录）
TASK_DATA_DIR = "data"

# 任务文件（YAML 格式，AI 可直接编辑）
TASKS_FILE = "tasks.yaml"

# 执行历史文件
EXECUTIONS_FILE = "task_executions.yaml"