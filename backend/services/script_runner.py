"""
ScriptRunner - 脚本任务管理器

管理 Python 脚本作为子进程运行，监控生命周期，桥接 stdout JSON 消息到后端服务。
生命周期由 FastAPI lifespan 管理。

与 TaskScheduler（管理 YAML 任务）互补，ScriptRunner 管理 Python 脚本任务。

协议：
    脚本通过 stdout 输出 JSON 行与 ScriptRunner 通信：
    - {"type": "heartbeat", "timestamp": ...}
    - {"type": "log", "level": "info", "message": "..."}
    - {"type": "trigger_task", "target": "...", "prompt": "..."}
    - {"type": "alert", "level": "error", "message": "..."}
    - {"type": "next_run", "seconds": 60, "timestamp": ...}
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import subprocess
import sys
import threading
import time
from datetime import date, datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from core.redaction import redact_text

# 跨平台兼容：Windows 下 CREATE_NO_WINDOW 避免弹出控制台窗口
_CREATE_NO_WINDOW: int = getattr(subprocess, "CREATE_NO_WINDOW", 0)

logger = logging.getLogger(__name__)

# 尝试导入脚本沙箱安全检查，不存在则降级
try:
    from .script_sandbox import check_security  # pyright: ignore[reportMissingImports]
except ImportError:
    check_security = None
    logger.warning("script_sandbox 不可用，安全检查将被跳过")

def _audit_log_dir() -> Path:
    """审计日志目录：config.TASK_LOGS_DIR/audit（V14 收编原模块级硬编码）。"""
    from config.config import get_config
    return Path(get_config().TASK_LOGS_DIR) / "audit"


# =========================================================================
# 内置 YAML Frontmatter 解析器（轻量级，无外部依赖）
# =========================================================================


def _parse_frontmatter(source: str) -> Dict[str, Any]:
    """从 Python 源码头部 docstring 中解析 YAML frontmatter。

    格式：
        \"\"\"
        name: 脚本名称
        enabled: true
        note: 备注说明
        prompt: 触发任务时的提示词
        \"\"\"

    Returns:
        解析结果字典，没有 frontmatter 时返回空字典。
    """
    lines = source.splitlines()
    if not lines:
        return {}

    # 跳过开头空行和注释行
    start = 0
    while start < len(lines):
        stripped = lines[start].strip()
        if stripped and not stripped.startswith("#"):
            break
        start += 1

    if start >= len(lines):
        return {}

    first_line = lines[start].strip()

    # 检测 frontmatter 开始标记
    delimiter = None
    if first_line.startswith('"""'):
        delimiter = '"""'
    elif first_line.startswith("'''"):
        delimiter = "'''"
    else:
        return {}

    # 提取 frontmatter 内容行
    content_lines: List[str] = []
    end = start + 1

    # 处理开始标记行可能包含内容的情况
    remaining = first_line[len(delimiter) :]
    if remaining and not remaining.isspace():
        if delimiter in remaining:
            return {}
        content_lines.append(remaining)

    while end < len(lines):
        line = lines[end]
        stripped_line = line.strip()
        if stripped_line.startswith(delimiter):
            break
        content_lines.append(line)
        end += 1

    # 解析键值对
    result: Dict[str, Any] = {}
    current_key: Optional[str] = None
    current_value_lines: List[str] = []

    for line in content_lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            if current_key and not current_value_lines:
                result[current_key] = True
            continue

        is_indented = line.startswith("    ") or line.startswith("\t")

        if not is_indented:
            # 保存上一个 key
            if current_key:
                if current_value_lines:
                    result[current_key] = "\n".join(current_value_lines).strip()
                elif current_key not in result:
                    result[current_key] = True
                current_value_lines = []

            # 解析新 key: value
            match = re.match(r"^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*?)\s*$", stripped)
            if match:
                raw_key = match.group(1)
                if raw_key is None:
                    continue
                key: str = raw_key
                current_key = key
                val = match.group(2).rstrip(",")
                if val:
                    if val in ("|", ">"):
                        current_value_lines = []
                    else:
                        # 类型转换
                        if val.lower() in ("true", "yes", "on"):
                            result[key] = True
                        elif val.lower() in ("false", "no", "off"):
                            result[key] = False
                        elif val.isdigit():
                            result[key] = int(val)
                        elif re.match(r"^\d+\.\d+$", val):
                            result[key] = float(val)
                        elif val.startswith('"') and val.endswith('"'):
                            result[key] = val[1:-1]
                        elif val.startswith("'") and val.endswith("'"):
                            result[key] = val[1:-1]
                        else:
                            result[key] = val
                else:
                    current_value_lines = []
        else:
            if current_key:
                current_value_lines.append(stripped)

    if current_key:
        if current_value_lines:
            result[current_key] = "\n".join(current_value_lines).strip()
        elif current_key not in result:
            result[current_key] = True

    return result


def _get_script_info(source: str) -> Dict[str, Any]:
    """获取脚本信息，含默认值补全。

    Returns:
        {
            "name": str,           # 脚本名称
            "enabled": bool,       # 是否启用
            "note": str,           # 备注说明
            "prompt": str,         # 默认提示词
            "model": str,          # 覆盖默认模型（空则用全局默认）
            "provider": str,       # 覆盖默认提供商（空则用全局默认）
            "has_frontmatter": bool,
        }
    """
    fm = _parse_frontmatter(source)
    has_fm = bool(fm)
    return {
        "name": fm.get("name", ""),
        "enabled": fm.get("enabled", True) if has_fm else False,
        "note": fm.get("note", ""),
        "prompt": fm.get("prompt", ""),
        "model": fm.get("model", ""),
        "provider": fm.get("provider", ""),
        "has_frontmatter": has_fm,
    }


# =========================================================================
# 助手函数
# =========================================================================


def _inject_main_session_id(env: dict) -> None:
    """从 stt_session_manager 缓存获取主智能体会话ID。"""
    try:
        from .stt_session_manager import get_session_manager
        sm = get_session_manager()
        sess = sm.get_agent_session("main-task")
        if sess:
            env["AXEUH_OPENCODE_SESSION_ID"] = sess
    except Exception:
        pass


def _current_scripts_dir() -> Path:
    """当前配置的脚本目录；配置不可读时沿用 ScriptRunner.start 的兜底。"""
    try:
        from config.config import get_config
        return Path(get_config().SCRIPTS_DIR)
    except Exception:
        return Path(__file__).resolve().parent.parent / "scripts"


def _build_task_env() -> dict:
    """构建任务子进程环境变量（启动/重启两路径共用，单一实现）。

    P2-V8：显式注入 backend/ 到 PYTHONPATH——子进程 sys.path 只含包装脚本
    目录与 context 目录，不含 backend/，任务脚本 import services/config
    必须依赖此注入（与 script_sandbox 注入口径一致）。
    """
    env = os.environ.copy()
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8:replace"

    backend_dir = str(Path(__file__).resolve().parent.parent)
    existing = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = (
        backend_dir + os.pathsep + existing if existing else backend_dir
    )

    try:
        from config.config import get_config
        cfg = get_config()
        env["AXEUH_BACKEND_PORT"] = str(getattr(cfg, "BACKEND_HTTPS_PORT", 8768))
        env["AXEUH_OPENCODE_PORT"] = str(getattr(cfg, "OPENCODE_PORT", 5096))
    except Exception:
        env["AXEUH_BACKEND_PORT"] = "8768"
        env["AXEUH_OPENCODE_PORT"] = "5096"
    _inject_main_session_id(env)
    return env


# =========================================================================
# ScriptRunner - 脚本进程管理器
# =========================================================================


class ScriptRunner:
    """脚本任务管理器 - 生命周期由 FastAPI lifespan 管理。

    职责：
    - 启动/停止 Python 脚本子进程
    - 读取 stdout JSON 消息并桥接到后端服务
    - 心跳检测（35s 超时）
    - 自动重启（最多 3 次）
    - 线程安全保障
    """

    def __init__(self, client=None):
        """初始化 ScriptRunner。

        Args:
            client: OpenCodeClient 信封实例，用于桥接 trigger_task 消息。
                    为 None 时桥接协程内经 acquire_opencode_client() 延迟获取
                    （保持启动期零端口探测的 BE-COR-M11 语义）。
        """
        self._client = client
        self._sandbox = None  # 未来可延迟加载更多沙箱功能
        self._processes: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.Lock()
        self._main_loop: Optional[asyncio.AbstractEventLoop] = None
        self._running = False
        self._max_restarts = 3
        self._heartbeat_timeout = 300  # 秒
        self._monitor_interval = 10  # 秒
        self._scripts_dir: Optional[Path] = None

        # 速率限制
        self._rate_limits: Dict[str, List[float]] = {}  # name -> trigger 时间戳列表
        self._rate_limit_max = 1  # 每分钟最多 trigger 1 次（发送到 OpenCode）
        self._rate_limit_window = 60  # 窗口大小（秒）

        # 后台线程
        self._watcher_thread: Optional[threading.Thread] = None
        self._monitor_thread: Optional[threading.Thread] = None

    # ------------------------------------------------------------------
    # 生命周期
    # ------------------------------------------------------------------

    async def start(self, scripts_dir: Optional[str] = None):
        """启动 ScriptRunner，开始文件监控和进程监控。

        Args:
            scripts_dir: 脚本目录路径。None 时从配置读取 scripts.dir。
        """
        self._main_loop = asyncio.get_running_loop()
        self._running = True

        # 确定脚本目录（优先传参，否则读配置，最后兜底）
        if scripts_dir:
            self._scripts_dir = Path(scripts_dir)
        else:
            try:
                from config.config import get_config
                cfg = get_config()
                self._scripts_dir = Path(cfg.SCRIPTS_DIR)
            except Exception:
                self._scripts_dir = Path(__file__).resolve().parent.parent / "scripts"

        self._scripts_dir.mkdir(parents=True, exist_ok=True)
        logger.info("ScriptRunner 脚本目录: %s", self._scripts_dir)

        # 启动 FileWatcher 线程
        self._watcher_thread = threading.Thread(
            target=self._run_watcher,
            daemon=True,
            name="script-runner-watcher",
        )
        self._watcher_thread.start()

        # 启动监控线程
        self._monitor_thread = threading.Thread(
            target=self._monitor_loop,
            daemon=True,
            name="script-runner-monitor",
        )
        self._monitor_thread.start()

        logger.info("ScriptRunner 已启动")

    def is_running(self) -> bool:
        """是否已启动且未停止（启动校验只读探针用）。"""
        return self._running

    async def stop(self):
        """停止 ScriptRunner，关闭所有脚本和监控线程。"""
        logger.info("ScriptRunner 正在停止...")
        self._running = False
        self.stop_all()
        logger.info("ScriptRunner 已停止")

    # ------------------------------------------------------------------
    # 文件监控（在 watcher 线程中运行）
    # ------------------------------------------------------------------

    def _run_watcher(self):
        """FileWatcher 线程入口。"""
        watcher = FileWatcher(self, self._scripts_dir, interval=5)
        # _scan 在 FileWatcher.__init__ 中已执行一次
        while self._running:
            time.sleep(watcher.interval)
            # BE-COR-M10: sleep 期间可能已调用 stop()，必须再次确认 _running，
            # 否则关闭过程中仍会扫描并重新启动脚本。
            if not self._running:
                break
            try:
                watcher._scan()
            except Exception:
                logger.exception("FileWatcher 扫描异常")

    # ------------------------------------------------------------------
    # 脚本管理
    # ------------------------------------------------------------------

    def start_script(self, script_path: str, name: Optional[str] = None) -> bool:
        """启动一个脚本。

        流程：
        1. 读取源码
        2. AST 安全检查
        3. 启动子进程
        4. 注册到进程表
        5. 启动 stdout 读取线程

        Args:
            script_path: 脚本文件路径
            name: 进程名称（默认使用文件名不含扩展名）

        Returns:
            是否成功启动
        """
        script_path = os.path.abspath(script_path)
        if not os.path.isfile(script_path):
            logger.error("脚本不存在: %s", script_path)
            return False

        if not name:
            name = os.path.splitext(os.path.basename(script_path))[0]

        # 如果同名进程已存在，先停止（不存在时不能调用 stop_script，否则误报"不存在"）
        with self._lock:
            already_running = name in self._processes
        if already_running:
            logger.warning("脚本 '%s' 已在运行中，先停止旧进程", name)
            self.stop_script(name)

        # --- 1. 读取源码 ---
        try:
            with open(script_path, "r", encoding="utf-8") as f:
                source = f.read()
        except Exception as e:
            logger.error("读取脚本失败: %s: %s", script_path, e)
            return False

        # 从 frontmatter 提取模型/提供商配置
        script_info = _get_script_info(source)
        script_model = script_info.get("model", "")
        script_provider = script_info.get("provider", "")

        # --- 2. AST 安全检查 ---
        if check_security is not None:
            try:
                security = check_security(source)
                if not security["passed"]:
                    logger.error("安全审查未通过: %s", script_path)
                    for err in security["errors"]:
                        logger.error("  - %s", err)
                    return False
                logger.info(
                    "安全审查通过: %s (%d 行, 导入: %s)",
                    name,
                    security["lines_checked"],
                    ", ".join(security["used_imports"]) or "无",
                )
            except Exception as e:
                logger.warning("安全检查异常（跳过）: %s", e)
        else:
            logger.info("安全检查不可用，跳过: %s", name)

        # --- 2.5 创建包装脚本 ---
        wrapper_path = self._create_wrapper(script_path, name)
        if not wrapper_path:
            logger.error("创建包装脚本失败: %s", name)
            return False

        # --- 3. 启动子进程 ---
        env = _build_task_env()

        try:
            process = subprocess.Popen(
                [sys.executable, "-u", wrapper_path],
                shell=False,
                cwd=str(Path(__file__).parent.parent.parent),  # 项目根目录
                creationflags=_CREATE_NO_WINDOW,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                encoding="utf-8",
                errors="replace",
                env=env,
            )
        except Exception as e:
            logger.error("启动子进程失败: %s", e)
            self._cleanup_wrapper(wrapper_path)
            return False

        # --- 4. 注册进程 ---
        now = time.time()
        with self._lock:
            self._processes[name] = {
                "process": process,
                "wrapper_path": wrapper_path,
                "script_path": script_path,
                "started_at": now,
                "last_heartbeat": now,
                "restart_count": 0,
                "status": "running",
                "crashed": False,
                "log_dir": self._get_log_dir(name),
                "model": script_model,
                "provider": script_provider,
            }

        # --- 5. 启动 stdout 读取线程 ---
        reader_thread = threading.Thread(
            target=self._read_stdout,
            args=(name,),
            daemon=True,
            name=f"reader-{name}",
        )
        reader_thread.start()

        self._audit_log("start", name)
        logger.info("已启动脚本 '%s' (PID: %d)", name, process.pid)
        return True

    def stop_script(self, name: str) -> bool:
        """停止一个脚本。

        优雅停止流程：
        1. process.terminate() 发送 SIGTERM
        2. 等待最多 5 秒
        3. 如果未退出，process.kill() 强制终止

        Args:
            name: 脚本名称

        Returns:
            是否成功停止
        """
        with self._lock:
            if name not in self._processes:
                logger.warning("停止失败: 脚本 '%s' 不存在", name)
                return False
            info = self._processes[name]

        process = info["process"]

        logger.info("正在停止脚本 '%s' (PID: %d)...", name, process.pid)

        # 第一步：优雅终止
        try:
            process.terminate()
        except (OSError, AttributeError) as e:
            logger.warning("终止进程 '%s' 时出错: %s", name, e)

        # 第二步：等待 5 秒
        try:
            process.wait(timeout=5)
            logger.info("脚本 '%s' 已优雅退出", name)
        except subprocess.TimeoutExpired:
            logger.warning("脚本 '%s' 未在 5s 内退出，强制终止", name)
            # 第三步：强制终止
            try:
                process.kill()
                process.wait(timeout=3)
                logger.info("脚本 '%s' 已强制终止", name)
            except Exception as e:
                logger.error("强制终止 '%s' 失败: %s", name, e)

        wrapper_path = info.get("wrapper_path")
        # 从管理表中移除
        with self._lock:
            if name in self._processes:
                self._processes[name]["status"] = "stopped"
                del self._processes[name]

        self._cleanup_wrapper(wrapper_path)

        self._audit_log("stop", name)
        return True

    def stop_all(self):
        """停止所有脚本。"""
        with self._lock:
            names = list(self._processes.keys())

        if not names:
            logger.info("没有正在运行的脚本需要停止")
            return

        logger.info("正在停止所有脚本 (%d 个)...", len(names))
        for name in names:
            self.stop_script(name)
        logger.info("所有脚本已停止")

    # ------------------------------------------------------------------
    # 审计日志
    # ------------------------------------------------------------------

    def _audit_log(self, event: str, name: str, details: Optional[Dict[str, Any]] = None):
        """写入审计日志。

        Args:
            event: 事件类型 (start/stop/crash/trigger_task)
            name: 脚本名称
            details: 额外详情
        """
        try:
            audit_dir = _audit_log_dir()
            audit_dir.mkdir(parents=True, exist_ok=True)
            log_file = audit_dir / f"{date.today().isoformat()}.jsonl"
            entry = {
                "timestamp": datetime.now().isoformat(),
                "event": event,
                "script": name,
            }
            if details:
                entry.update(details)
            with open(log_file, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except Exception as e:
            logger.debug("审计日志写入失败: %s", e)

    # ------------------------------------------------------------------
    # 包装脚本生成
    # ------------------------------------------------------------------

    def _create_wrapper(self, script_path: str, name: str) -> str:
        """创建包装脚本，用于注入 Context 到目标脚本。

        包装脚本负责：
        1. 导入 backend/services/scripts/context.py 的 Context 模块
        2. 创建 Context 实例
        3. 读取并执行目标脚本，将 context 注入到命名空间
        4. 调用 run(context) 函数

        Returns:
            包装脚本的路径 (临时文件)
        """
        from config.config import get_config
        cfg = get_config()

        # 找 context.py 的位置 - 生产脚本引擎位于 backend/services/scripts/context.py
        context_module = None

        # 检查各个可能的位置
        for possible_dir in [Path(__file__).parent / "scripts"]:
            if (possible_dir / "context.py").exists():
                context_module = possible_dir
                break

        if context_module is None:
            logger.error("找不到 context.py 模块")
            return ""

        context_module_json = json.dumps(str(context_module))
        script_path_json = json.dumps(os.path.abspath(script_path))
        name_json = json.dumps(name)

        wrapper_code = (
            "import sys\n"
            "import json\n"
            "import time as _time\n"
            "import builtins as _builtins\n"
            "\n"
            f"_context_dir = {context_module_json}\n"
            "if _context_dir not in sys.path:\n"
            "    sys.path.insert(0, _context_dir)\n"
            "\n"
            "import context as _ctx_mod\n"
            "\n"
            f"_ctx = _ctx_mod.Context(script_name={name_json}, demo_mode=False)\n"
            "\n"
            f"_script_path = {script_path_json}\n"
            'with open(_script_path, "r", encoding="utf-8") as _f:\n'
            "    _source = _f.read()\n"
            "\n"
            '_code = compile(_source, _script_path, "exec")\n'
            '_ns = {"context": _ctx, "__file__": _script_path, "__builtins__": _builtins}\n'
            "try:\n"
            "    exec(_code, _ns)\n"
            "except Exception:\n"
            "    import traceback\n"
            "    traceback.print_exc()\n"
            "    sys.exit(1)\n"
            "\n"
            'if "run" in _ns:\n'
            "    try:\n"
            "        _ns[\"run\"](_ctx)\n"
            '    except Exception:\n'
            "        import traceback\n"
            "        traceback.print_exc()\n"
            "        sys.exit(1)\n"
        )

        # 写入临时文件
        import tempfile
        fd, wrapper_path = tempfile.mkstemp(
            suffix=".py",
            prefix=f"wrapper_{name}_",
            dir=str(self._get_log_dir(name)),
        )
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(wrapper_code)

        return wrapper_path

    # ------------------------------------------------------------------
    # 状态查询
    # ------------------------------------------------------------------

    def get_status(self, name: Optional[str] = None) -> Dict[str, Any]:
        """获取脚本运行状态。

        Args:
            name: 脚本名称，为 None 时返回所有脚本的概要状态

        Returns:
            单个脚本的状态字典或所有脚本的概要。
        """
        with self._lock:
            if name is not None:
                if name not in self._processes:
                    return {"name": name, "status": "not_found", "pid": None}
                return self._build_status(name, self._processes[name])

            # 返回所有脚本的概要状态
            statuses = {}
            for n, info in self._processes.items():
                rcode = info["process"].poll()
                if rcode is None:
                    statuses[n] = "running"
                elif rcode == 0:
                    statuses[n] = "exited"
                else:
                    statuses[n] = "crashed"
            return {"statuses": statuses, "count": len(statuses)}

    def get_all(self) -> List[Dict[str, Any]]:
        """获取所有脚本的详细信息列表。"""
        result: List[Dict[str, Any]] = []
        with self._lock:
            for name, info in self._processes.items():
                result.append(self._build_status(name, info))
        return result

    def _build_status(self, name: str, info: Dict[str, Any]) -> Dict[str, Any]:
        """从进程信息构建状态字典。"""
        process = info["process"]
        returncode = process.poll()
        now = time.time()

        if returncode is None:
            status = "running"
        elif returncode == 0:
            status = "exited"
        else:
            status = "crashed"

        age = now - info.get("started_at", now)
        hb = info.get("last_heartbeat", now)
        return {
            "name": name,
            "status": status,
            "pid": process.pid,
            "returncode": returncode,
            "started_at": info.get("started_at"),
            "running_for": round(age, 1),
            "last_heartbeat": hb,
            "heartbeat_age": round(now - hb, 1),
            "restart_count": info.get("restart_count", 0),
            "crashed": info.get("crashed", False),
            "script_path": info.get("script_path"),
            "log_dir": str(info.get("log_dir", "")),
        }

    # ------------------------------------------------------------------
    # stdout 读取（在 reader 线程中运行）
    # ------------------------------------------------------------------

    def _read_stdout(self, name: str):
        """后台线程：读取脚本 stdout，解析 JSON 行并分发消息。

        Args:
            name: 脚本名称
        """
        with self._lock:
            if name not in self._processes:
                return
            info = self._processes[name]
            process = info["process"]
            log_dir = info["log_dir"]

        # ---- stderr 读取线程 ----
        def _read_stderr():
            try:
                for raw_line in process.stderr:
                    if raw_line:
                        text = raw_line.rstrip("\n\r")
                        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                        log_date = date.today().isoformat()
                        stderr_path = log_dir / f"{log_date}.stderr.log"
                        try:
                            with open(stderr_path, "a", encoding="utf-8") as f:
                                f.write(f"{ts} | [STDERR] {text}\n")
                        except OSError:
                            pass
            except (ValueError, OSError):
                pass

        stderr_thread = threading.Thread(
            target=_read_stderr,
            daemon=True,
            name=f"stderr-{name}",
        )
        stderr_thread.start()

        # ---- stdout 读取 ----
        auto_restart = False
        try:
            for raw_line in process.stdout:
                if not raw_line:
                    continue
                line = raw_line.rstrip("\n\r")
                if not line:
                    continue

                ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                log_date = date.today().isoformat()

                # 尝试解析 JSON
                parsed: Optional[Dict[str, Any]] = None
                try:
                    parsed = json.loads(line)
                except json.JSONDecodeError:
                    pass

                # 写入日志文件
                stdout_path = log_dir / f"{log_date}.log"
                try:
                    with open(stdout_path, "a", encoding="utf-8") as f:
                        f.write(f"{ts} | {line}\n")
                except OSError:
                    pass

                # 处理 JSON 消息
                if parsed and isinstance(parsed, dict):
                    self._handle_message(name, parsed)

        except (ValueError, OSError):
            # 进程退出导致 pipe 关闭，这是正常行为
            pass

        # 进程已结束
        with self._lock:
            if name in self._processes:
                restart_count = self._processes[name].get("restart_count", 0)
                auto_restart = (
                    not self._processes[name].get("crashed", False)
                    and restart_count < self._max_restarts
                )

        logger.info("脚本 %s 输出读取结束", name)

        if auto_restart:
            logger.info("脚本 %s 已退出，准备自动重启", name)

    def _handle_message(self, name: str, msg: Dict[str, Any]):
        """处理来自脚本的 JSON 消息。

        Args:
            name: 脚本名称
            msg: 解析后的 JSON 消息字典
        """
        msg_type = msg.get("type")

        if msg_type == "trigger_task":
            # 速率限制检查
            now = time.time()
            with self._lock:
                timestamps = self._rate_limits.setdefault(name, [])
                # 清理过期记录
                timestamps[:] = [t for t in timestamps if now - t < self._rate_limit_window]
                if len(timestamps) >= self._rate_limit_max:
                    logger.warning(
                        "[脚本:%s] trigger_task 速率限制触发 (每分钟最多 %d 次)",
                        name, self._rate_limit_max
                    )
                    return  # 静默丢弃，不报错
                timestamps.append(now)

            prompt = msg.get("prompt", "")
            target = msg.get("target", "default")
            logger.info(
                "[脚本:%s] 触发任务: target=%s  prompt_chars=%d",
                name,
                target,
                len(prompt),
            )
            self._audit_log("trigger_task", name, {"target": target})
            if self._main_loop:
                try:
                    # 获取真实的 main-task 会话 ID
                    real_session_id = "main-task"
                    try:
                        from .stt_session_manager import get_session_manager
                        sm = get_session_manager()
                        sess = sm.get_agent_session("main-task")
                        if sess:
                            real_session_id = sess
                    except Exception:
                        pass

                    # 模型/提供商优先级：trigger_task 消息内联指定 > 脚本 frontmatter > 全局默认
                    msg_model = msg.get("model") or None
                    msg_provider = msg.get("provider") or None
                    script_model_id = None
                    script_provider_id = None
                    with self._lock:
                        if name in self._processes:
                            script_model_id = self._processes[name].get("model") or None
                            script_provider_id = self._processes[name].get("provider") or None

                    # 正文首行统一场景前缀 【脚本任务】{脚本名}（见 ai/AGENTS.md 场景前缀契约）
                    message = f"【脚本任务】{name}\n{prompt}"

                    async def _bridge_send():
                        client = self._client
                        if client is None:
                            from .ai_client_factory import acquire_ai_client as acquire_opencode_client  # 双通道工厂，别名保留原符号
                            client = await acquire_opencode_client()
                        return await client.send_message(
                            session_id=real_session_id,
                            message=message,
                            agent="main-task",
                            model_id=msg_model or script_model_id,
                            provider_id=msg_provider or script_provider_id,
                        )

                    asyncio.run_coroutine_threadsafe(_bridge_send(), self._main_loop)
                except Exception as e:
                    logger.error(
                        "[脚本:%s] 桥接 trigger_task 失败: %s", name, redact_text(str(e))
                    )
            else:
                logger.info(
                    "[脚本:%s] 主事件循环不可用，触发任务被忽略: prompt_chars=%d",
                    name,
                    len(prompt),
                )

        elif msg_type == "log":
            level = msg.get("level", "info")
            message = redact_text(str(msg.get("message", "")))
            level_method = getattr(logger, level, logger.info)
            level_method("[脚本:%s] %s", name, message)

        elif msg_type == "alert":
            message = redact_text(str(msg.get("message", "")))
            logger.error("[脚本:%s] 异常: %s", name, message)

        elif msg_type == "heartbeat":
            with self._lock:
                if name in self._processes:
                    self._processes[name]["last_heartbeat"] = time.time()

        elif msg_type == "next_run":
            seconds = msg.get("seconds", "?")
            logger.debug("[脚本:%s] 下次执行: %s 秒后", name, seconds)

        else:
            logger.debug("[脚本:%s] 未知消息类型: %s", name, msg_type)

    # ------------------------------------------------------------------
    # 监控循环（在 monitor 线程中运行）
    # ------------------------------------------------------------------

    def _monitor_loop(self):
        """后台监控循环。

        定期检查所有进程的健康状态：
        - 心跳超时（>35s）：尝试重启（最多 3 次）
        - 进程意外退出：尝试重启（最多 3 次）
        - 达到最大重启次数：标记为 crashed 不再重启
        """
        logger.debug("监控线程已启动")
        while self._running:
            try:
                time.sleep(self._monitor_interval)
                # 停止过程中不再检查/重启进程
                if not self._running:
                    break
                self._check_processes()
            except Exception:
                logger.exception("监控循环异常")

    def _check_processes(self):
        """检查所有进程状态并处理异常。"""
        if not self._running:
            return
        now = time.time()
        names_to_check: List[str] = []

        with self._lock:
            names_to_check = list(self._processes.keys())

        for name in names_to_check:
            with self._lock:
                if name not in self._processes:
                    continue
                info = self._processes[name]
                process = info["process"]
                last_hb = info.get("last_heartbeat", 0)
                restart_count = info.get("restart_count", 0)
                crashed = info.get("crashed", False)

            if crashed:
                continue

            # 检查进程是否存活
            returncode = process.poll()
            is_dead = returncode is not None
            heartbeat_expired = (now - last_hb) > self._heartbeat_timeout

            if is_dead:
                self._handle_process_death(name, returncode, restart_count)
                continue

            if heartbeat_expired:
                self._handle_heartbeat_timeout(name, process, restart_count)

    def _handle_process_death(self, name: str, returncode: int, restart_count: int):
        """处理进程退出。

        BE-COR-M9: returncode == 0 视为正常退出（一次性脚本），不再自动重启。
        """
        if returncode == 0:
            self._audit_log("exit", name, {"returncode": 0})
            logger.info("脚本 '%s' 正常退出 (returncode: 0)，不自动重启", name)
            with self._lock:
                if name in self._processes:
                    self._processes[name]["status"] = "exited"
            return

        self._audit_log("crash", name, {"returncode": returncode, "restarts": restart_count})
        logger.warning("脚本 '%s' 已退出 (returncode: %d)", name, returncode)

        if restart_count < self._max_restarts:
            self._restart_script(name)
        else:
            logger.error(
                "脚本 '%s' 已达最大重启次数 (%d)，不再重启",
                name,
                self._max_restarts,
            )
            with self._lock:
                if name in self._processes:
                    self._processes[name]["status"] = "crashed"
                    self._processes[name]["crashed"] = True

    def _handle_heartbeat_timeout(self, name: str, process: "subprocess.Popen[bytes]", restart_count: int):
        """处理心跳超时。"""
        now = time.time()
        with self._lock:
            last_hb = self._processes.get(name, {}).get("last_heartbeat", now) if name in self._processes else now
        logger.warning(
            "脚本 '%s' 心跳超时 (%.0f 秒无心跳)",
            name,
            now - last_hb,
        )

        if restart_count < self._max_restarts:
            # 先终止旧进程
            logger.info("正在终止无响应进程 '%s'...", name)
            try:
                process.terminate()
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    process.kill()
                    process.wait(timeout=3)
                except Exception:
                    pass
            except Exception:
                pass

            self._restart_script(name)
        else:
            logger.error("脚本 '%s' 已达最大重启次数，不再重启", name)
            with self._lock:
                if name in self._processes:
                    self._processes[name]["crashed"] = True

    def _restart_script(self, name: str):
        """重启指定脚本。

        Args:
            name: 脚本名称
        """
        with self._lock:
            if not self._running:
                logger.info("ScriptRunner 已停止，跳过脚本 '%s' 的重启", name)
                return
            if name not in self._processes:
                logger.warning("重启失败: 脚本 '%s' 已不存在", name)
                return
            info = self._processes[name]
            info["restart_count"] = info.get("restart_count", 0) + 1
            script_path = info["script_path"]
            process = info["process"]
            old_wrapper_path = info.get("wrapper_path")

        # 清理旧包装脚本
        self._cleanup_wrapper(old_wrapper_path)

        restart_count = info["restart_count"]
        logger.info(
            "正在重启脚本 '%s' (第 %d/%d 次)",
            name,
            restart_count,
            self._max_restarts,
        )

        # 确保旧进程已终止
        try:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=2)
        except Exception:
            pass

        # 创建新包装脚本
        wrapper_path = self._create_wrapper(script_path, name)
        if not wrapper_path:
            logger.error("重启脚本 '%s' 时创建包装脚本失败", name)
            return

        # 启动新进程
        env = _build_task_env()

        try:
            new_process = subprocess.Popen(
                [sys.executable, "-u", wrapper_path],
                shell=False,
                cwd=str(Path(__file__).parent.parent.parent),  # 项目根目录
                creationflags=_CREATE_NO_WINDOW,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                encoding="utf-8",
                errors="replace",
                env=env,
            )
        except Exception as e:
            logger.error("重启脚本 '%s' 失败: %s", name, e)
            self._cleanup_wrapper(wrapper_path)
            return

        # 更新进程表
        now = time.time()
        with self._lock:
            if name in self._processes:
                self._processes[name].update({
                    "process": new_process,
                    "wrapper_path": wrapper_path,
                    "started_at": now,
                    "last_heartbeat": now,
                    "status": "running",
                    # restart_count 保持累计
                })

        # 启动新输出读取线程
        reader_thread = threading.Thread(
            target=self._read_stdout,
            args=(name,),
            daemon=True,
            name=f"reader-{name}",
        )
        reader_thread.start()

        logger.info("脚本 '%s' 已重启 (新 PID: %d)", name, new_process.pid)

    # ------------------------------------------------------------------
    # 工具方法
    # ------------------------------------------------------------------

    @staticmethod
    def _get_log_dir(name: str) -> Path:
        """脚本日志目录：config.TASK_LOGS_DIR/<name>（V14 收编原相对硬编码）。"""
        from config.config import get_config
        log_dir = Path(get_config().TASK_LOGS_DIR) / name
        log_dir.mkdir(parents=True, exist_ok=True)
        return log_dir

    @staticmethod
    def _cleanup_wrapper(wrapper_path: Optional[str]):
        """删除包装脚本"""
        if wrapper_path and os.path.exists(wrapper_path):
            try:
                os.remove(wrapper_path)
            except OSError:
                pass


# =========================================================================
# FileWatcher - 脚本目录热加载监控器
# =========================================================================


class FileWatcher:
    """scripts/ 目录文件变更监控器。

    每 N 秒扫描一次脚本目录，检测文件变更。
    只处理带 YAML frontmatter 的脚本。
    根据 enabled 状态自动启动/停止脚本。
    """

    def __init__(
        self,
        runner: ScriptRunner,
        scripts_dir: Optional[Path] = None,
        interval: int = 5,
    ):
        """初始化 FileWatcher。

        Args:
            runner: ScriptRunner 实例
            scripts_dir: 监控的脚本目录
            interval: 扫描间隔（秒）
        """
        self.runner = runner
        self.scripts_dir = scripts_dir or Path("backend/scripts")
        self.scripts_dir = self.scripts_dir.resolve()
        self.scripts_dir.mkdir(parents=True, exist_ok=True)
        self.interval = interval
        self._file_mtimes: Dict[str, float] = {}
        self._file_infos: Dict[str, Dict[str, Any]] = {}
        self._logger = logging.getLogger("file_watcher")

        # 初始扫描
        self._scan()
        self._logger.info("FileWatcher 已就绪 (监控: %s, 间隔: %ds)", self.scripts_dir, interval)

    def _scan(self):
        """扫描目录，处理新增/变更/删除。"""
        try:
            current_files: Dict[str, float] = {}
            for f in self.scripts_dir.glob("*.py"):
                try:
                    current_files[f.name] = f.stat().st_mtime
                except OSError:
                    continue

            # 检查新增或变更的文件
            for fname, mtime in current_files.items():
                old_mtime = self._file_mtimes.get(fname)
                if old_mtime != mtime:
                    self._process_file(fname, self.scripts_dir / fname)

            # 检查已删除的文件
            for fname in list(self._file_mtimes.keys()):
                if fname not in current_files:
                    self._handle_deleted(fname)

            self._file_mtimes = current_files

        except Exception as e:
            self._logger.error("扫描异常: %s", e)

    def _process_file(self, fname: str, fpath: Path):
        """处理单个脚本文件。

        Args:
            fname: 文件名
            fpath: 完整路径
        """
        try:
            source = fpath.read_text(encoding="utf-8")
        except Exception as e:
            self._logger.error("读取 %s 失败: %s", fname, e)
            return

        info = _get_script_info(source)
        has_fm = info["has_frontmatter"]

        if not has_fm:
            # 没有 frontmatter -> 不自动管理
            if fname in self._file_infos:
                old_info = self._file_infos[fname]
                if old_info.get("enabled", False):
                    self._logger.info("脚本 %s 已移除 frontmatter，正在停止...", fname)
                    script_name = old_info.get("name") or Path(fname).stem
                    self.runner.stop_script(script_name)
                del self._file_infos[fname]
            return

        script_name = info.get("name") or fpath.stem
        enabled = info.get("enabled", False)
        old_info = self._file_infos.get(fname)

        if enabled:
            # 检查是否已在运行
            st = self.runner.get_status(script_name)
            if st.get("status") == "running":
                self._logger.info("脚本 %s 已更新，重新启动...", script_name)
                self.runner.stop_script(script_name)
                time.sleep(0.5)

            # 启动脚本
            self._logger.info("热加载: 启动脚本 %s", script_name)
            self.runner.start_script(str(fpath), name=script_name)
            self._file_infos[fname] = info
        else:
            # enabled: false -> 停止
            if fname in self._file_infos:
                old_enabled = self._file_infos[fname].get("enabled", False)
                if old_enabled:
                    self._logger.info("热加载: 停止脚本 %s (enabled=false)", script_name)
                    self.runner.stop_script(script_name)
            self._file_infos[fname] = info

    def _handle_deleted(self, fname: str):
        """处理文件被删除。

        Args:
            fname: 被删除的文件名
        """
        info = self._file_infos.pop(fname, None)
        if info and info.get("enabled", False):
            script_name = info.get("name") or Path(fname).stem
            self._logger.info("热加载: 脚本文件 %s 已删除，正在停止...", fname)
            self.runner.stop_script(script_name)
        self._file_mtimes.pop(fname, None)

    def stop(self):
        """停止监控（由 ScriptRunner.stop() 触发清理）。"""
        self._logger.info("FileWatcher 已停止")


# =========================================================================
# 单例模式
# =========================================================================

_script_runner_instance: Optional[ScriptRunner] = None
_script_runner_lock = threading.Lock()


def get_script_runner() -> Optional[ScriptRunner]:
    """获取全局 ScriptRunner 实例。

    Returns:
        ScriptRunner 实例，如果尚未初始化则返回 None。
    """
    global _script_runner_instance
    with _script_runner_lock:
        return _script_runner_instance


def init_script_runner(client=None) -> ScriptRunner:
    """初始化全局 ScriptRunner 实例。

    Args:
        client: OpenCodeClient 信封实例（V6 起取代原 gateway 注入）；
                缺省 None 时桥接协程内延迟获取。

    Returns:
        初始化的 ScriptRunner 实例
    """
    global _script_runner_instance
    with _script_runner_lock:
        if _script_runner_instance is None:
            _script_runner_instance = ScriptRunner(client=client)
        else:
            logger.warning("ScriptRunner 已初始化，重复调用将被忽略")
        return _script_runner_instance


async def reload_scripts_dir(timeout_s: float = 5.0) -> Dict[str, Any]:
    """配置热重载钩子：把 watcher/monitor 安全重绑到当前 SCRIPTS_DIR。

    旧线程 join 超时时不重建单例、不启动新 watcher，避免双 watcher 并存。
    """
    global _script_runner_instance
    with _script_runner_lock:
        old = _script_runner_instance

    target_dir = _current_scripts_dir()
    warnings: List[str] = []

    if old is None:
        runner = init_script_runner()
        with _script_runner_lock:
            _script_runner_instance = runner
        await runner.start(str(target_dir))
        return {
            "ok": True,
            "scripts_dir": str(target_dir),
            "warnings": warnings,
            "started": True,
        }

    await old.stop()

    deadline = time.monotonic() + max(0.0, timeout_s)
    for label, thread in (
        ("watcher", getattr(old, "_watcher_thread", None)),
        ("monitor", getattr(old, "_monitor_thread", None)),
    ):
        if thread is None or not thread.is_alive():
            continue
        remaining = max(0.0, deadline - time.monotonic())
        thread.join(timeout=remaining)
        if thread.is_alive():
            warnings.append(
                f"旧 {label} 线程 join 超时（{timeout_s}s）未退出；"
                "不启动新 watcher 以避免重复"
            )
            return {
                "ok": False,
                "scripts_dir": str(target_dir),
                "warnings": warnings,
                "started": False,
            }

    with _script_runner_lock:
        if _script_runner_instance is not old:
            warnings.append("ScriptRunner 单例已被其他调用替换，跳过重建")
            return {
                "ok": False,
                "scripts_dir": str(target_dir),
                "warnings": warnings,
                "started": False,
            }
        _script_runner_instance = None

    runner = init_script_runner(client=getattr(old, "_client", None))
    with _script_runner_lock:
        _script_runner_instance = runner
    await runner.start(str(target_dir))
    return {
        "ok": True,
        "scripts_dir": str(target_dir),
        "warnings": warnings,
        "started": True,
    }


def _reset_script_runner():
    """重置单例（仅测试用）。"""
    global _script_runner_instance
    with _script_runner_lock:
        _script_runner_instance = None
