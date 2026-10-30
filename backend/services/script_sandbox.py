"""
安全沙箱 - AST 审查 + 子进程隔离 (生产版)

从 demo/sandbox.py 改造的生产版本：
- 移除 CLI 入口和包装脚本
- 使用 logging 替代 print
- 配置从 config.get_config() 读取
- stdout 原始文本返回，不解析 JSON
- 单例模式 (ScriptSandbox)
"""

import ast
import os
import sys
import re
import subprocess
import time
import logging
import ctypes
# Linux 迁移(2026-10-07)：ctypes.wintypes 仅 Windows 存在；非 win32 平台下
# Job Object 相关结构体不参与运行（_create_job_object 已有 try/except 降级），
# 仅为让模块可导入而提供本地别名回退。
if sys.platform == "win32":
    from ctypes import wintypes
else:
    class _WintypesFallback:
        LARGE_INTEGER = ctypes.c_longlong
        DWORD = ctypes.c_uint32
        HANDLE = ctypes.c_void_p
        BOOL = ctypes.c_int
    wintypes = _WintypesFallback()  # type: ignore[assignment]
from typing import Optional, List, Set, Dict, Any, Tuple

from config.config import get_config

logger = logging.getLogger(__name__)

# =========================================================================
# 白名单配置
# =========================================================================

# 允许导入的标准库模块
ALLOWED_IMPORTS: Set[str] = {
    "math", "json", "re", "datetime", "time", "random",
    "typing", "collections", "pathlib", "os",
    "socket", "http", "urllib", "requests",
    # H5：小米云健康拉取任务（ai/data/tasks/xiaomi_cloud_health.py）复用
    # 后端单一真源协议实现；仅放行该叶子模块，services 其余部分仍禁止
    "services.health.sources.cloud_pull",
    # P2-V8：云拉取去 round-trip——任务脚本直写 HealthStore，仅放行
    # 公共 store 访问器所在叶子模块（get_health_store；写入路径零复制）
    "services.health_storage",
}

# os.path 下允许使用的方法（只读操作）
ALLOWED_OS_PATH_METHODS: Set[str] = {
    "exists", "getsize", "getmtime", "basename", "dirname",
    "join", "splitext", "isfile", "isdir", "normpath", "abspath",
    "realpath", "relpath", "commonpath", "commonprefix",
    "split", "splitdrive", "splitroot",
}

# 禁止使用的内置函数
BLOCKED_BUILTINS: Set[str] = {
    "eval", "exec", "compile", "__import__", "input",
}

# 禁止的属性访问前缀（_ 开头表示私有属性）
BLOCKED_ATTR_PREFIXES: Tuple[str, ...] = ("_",)

# 完全禁止导入的模块
BLOCKED_MODULES: Set[str] = {
    "subprocess", "shutil", "ctypes",
    "tempfile", "asyncio",
    "threading", "multiprocessing",
    "aiohttp", "flask", "fastapi",
    "builtins", "importlib",
}

# 跨平台兼容：Windows 下 CREATE_NO_WINDOW 避免弹出控制台窗口
_POPEN_CREATE_NO_WINDOW: int = getattr(subprocess, "CREATE_NO_WINDOW", 0)

# Windows Job Object 句柄（全局延迟初始化）
# Linux 迁移(2026-10-07)：ctypes.WinDLL 仅 Windows 有；类型注解改字符串形式，
# _get_kernel32 在非 win32 直接抛错（调用方 _create_job_object 均包 try/except 降级）
kernel32: Optional["ctypes.WinDLL"] = None


def _get_kernel32() -> "ctypes.WinDLL":
    """获取 kernel32 句柄（延迟初始化，仅 Windows）"""
    global kernel32
    if sys.platform != "win32":
        raise OSError("kernel32 仅 Windows 可用（Linux 下 Job Object 跳过）")
    if kernel32 is None:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    return kernel32


# =========================================================================
# AST 安全审查
# =========================================================================

class SecurityChecker(ast.NodeVisitor):
    """AST 安全检查器 - 遍历 AST 节点检测危险代码模式"""

    def __init__(self):
        self.errors: List[str] = []
        self.used_imports: Set[str] = set()
        # 记录导入别名映射：asname -> (模块全名, 是否是受限模块)
        self._import_aliases: Dict[str, str] = {}

    # ------------------------------------------------------------------
    # import / from ... import
    # ------------------------------------------------------------------

    def visit_Import(self, node: ast.Import) -> None:
        """检查 import xxx 语句"""
        for alias in node.names:
            name = alias.name
            asname = alias.asname or name
            self._import_aliases[asname] = name

            if name in BLOCKED_MODULES:
                self.errors.append(
                    f"blocked: import {name} (行 {node.lineno}) - 禁止的模块"
                )
                continue

            # os.path 不能直接 import（必须用 from os.path import xxx）
            if name in ("os.path", "posixpath", "ntpath"):
                self.errors.append(
                    f"blocked: import {name} (行 {node.lineno}) - "
                    f"请使用 from os.path import <method>"
                )
                continue

            if name not in ALLOWED_IMPORTS:
                self.errors.append(
                    f"blocked: import {name} (行 {node.lineno}) - 不在白名单中"
                )
                continue

            self.used_imports.add(name)

        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        """检查 from xxx import yyy 语句"""
        module = node.module or ""

        # --- from os.path import exists, getsize, ... ---
        if module == "os.path":
            for alias in node.names:
                name = alias.name
                asname = alias.asname or name
                self._import_aliases[asname] = f"os.path.{name}"
                if name not in ALLOWED_OS_PATH_METHODS:
                    self.errors.append(
                        f"blocked: from os.path import {name} (行 {node.lineno}) "
                        f"- 不允许的 os.path 方法"
                    )
                else:
                    self.used_imports.add(f"os.path.{name}")
            return

        # --- from os import xxx ---
        if module == "os":
            for alias in node.names:
                name = alias.name
                asname = alias.asname or name
                self._import_aliases[asname] = f"os.{name}"
                self.used_imports.add(f"os.{name}")
            return

        # --- from builtins import xxx ---
        if module in ("builtins", "__builtins__"):
            for alias in node.names:
                self.errors.append(
                    f"blocked: from {module} import {alias.name} (行 {node.lineno}) "
                    f"- 禁止导入 builtins"
                )
            return

        # --- from <blocked_module> import xxx ---
        if module in BLOCKED_MODULES:
            for alias in node.names:
                self.errors.append(
                    f"blocked: from {module} import {alias.name} (行 {node.lineno}) "
                    f"- 禁止的模块"
                )
            return

        # --- from <allowed_module> import xxx ---
        if module not in ALLOWED_IMPORTS:
            self.errors.append(
                f"blocked: from {module} import ... (行 {node.lineno}) - 不在白名单中"
            )
            return

        # 在白名单中，记录别名
        for alias in node.names:
            asname = alias.asname or alias.name
            self._import_aliases[asname] = f"{module}.{alias.name}"

        self.used_imports.add(module)
        self.generic_visit(node)

    # ------------------------------------------------------------------
    # 函数调用检测
    # ------------------------------------------------------------------

    def visit_Call(self, node: ast.Call) -> None:
        """检查函数调用 - 检测危险 builtins 和绕过手法"""
        func = node.func
        lineno = node.lineno

        # --- 形如 xxx() 的直接调用 ---
        if isinstance(func, ast.Name):
            fname = func.id

            # 禁止的内置函数
            if fname in BLOCKED_BUILTINS:
                self.errors.append(
                    f"blocked: {fname}() (行 {lineno}) - 禁止的内置函数"
                )
                self.generic_visit(node)
                return

            # 反射函数
            if fname in ("globals", "locals"):
                self.errors.append(
                    f"blocked: {fname}() (行 {lineno}) - 禁止的反射函数"
                )
                self.generic_visit(node)
                return

            # getattr 绕过
            if fname == "getattr":
                self.errors.append(
                    f"blocked: getattr() (行 {lineno}) - 可用于绕过导入限制"
                )
                self.generic_visit(node)
                return

            # type() 单参数 - 类遍历
            if fname == "type" and len(node.args) == 1:
                self.errors.append(
                    f"blocked: type() 单参数 (行 {lineno}) - 可用于类遍历"
                )
                self.generic_visit(node)
                return

        # --- 形如 xxx.yyy() 的方法调用 ---
        if isinstance(func, ast.Attribute):
            method_name = func.attr

            # builtins.getattr / builtins.eval / builtins.exec / etc.
            if isinstance(func.value, ast.Name) and func.value.id in ("builtins", "__builtins__"):
                if method_name in BLOCKED_BUILTINS or method_name == "getattr":
                    self.errors.append(
                        f"blocked: builtins.{method_name}() (行 {lineno}) - 通过 builtins 绕过"
                    )
                    self.generic_visit(node)
                    return

            # str.format() / str.format_map() - 类遍历绕过
            if method_name in ("format", "format_map"):
                self.errors.append(
                    f"blocked: str.{method_name}() (行 {lineno}) - 可用于类遍历绕过"
                )
                self.generic_visit(node)
                return

            # __import__() 直接调用（如 xxx.__import__）
            if method_name == "__import__":
                self.errors.append(
                    f"blocked: {method_name}() (行 {lineno}) - 禁止调用 __import__"
                )
                self.generic_visit(node)
                return

        self.generic_visit(node)

    # ------------------------------------------------------------------
    # 属性访问检测
    # ------------------------------------------------------------------

    def visit_Attribute(self, node: ast.Attribute) -> None:
        """检查属性访问 - 检测 _ 前缀、__ 前缀和 os.path 越权"""
        attr = node.attr
        lineno = node.lineno

        # --- 检测 _ 和 __ 前缀属性访问 ---
        if attr.startswith("_") and attr != "__builtins__":
            # 特别处理：在 except 块中访问 __traceback__ 是 CVE 模式
            if attr == "__traceback__":
                self.errors.append(
                    f"blocked: __traceback__ 访问 (行 {lineno}) - "
                    f"CVE-2026-39888 帧遍历绕过"
                )
                self.generic_visit(node)
                return

            # 其他的 _ 前缀属性
            self.errors.append(
                f"blocked: 属性 '{attr}' 以 _ 开头 (行 {lineno}) - "
                f"禁止访问私有属性"
            )
            self.generic_visit(node)
            return

        # --- 检测 os.path.xxx 方法是否在白名单中 ---
        if isinstance(node.value, ast.Attribute):
            inner = node.value
            if isinstance(inner.value, ast.Name) and inner.value.id == "os" and inner.attr == "path":
                if attr not in ALLOWED_OS_PATH_METHODS:
                    self.errors.append(
                        f"blocked: os.path.{attr} (行 {lineno}) - 不允许的 os.path 方法"
                    )
                self.generic_visit(node)
                return

        # --- 检测通过别名导入的 path.xxx 调用 ---
        if isinstance(node.value, ast.Name):
            alias_name = node.value.id
            if alias_name in self._import_aliases:
                real_name = self._import_aliases[alias_name]
                if real_name == "os.path" or real_name.startswith("os.path."):
                    if attr not in ALLOWED_OS_PATH_METHODS:
                        self.errors.append(
                            f"blocked: {alias_name}.{attr} (行 {lineno}) - "
                            f"不允许的 os.path 方法"
                        )

        self.generic_visit(node)

    # ------------------------------------------------------------------
    # 字符串拼接绕过检测
    # ------------------------------------------------------------------

    def visit_BinOp(self, node: ast.BinOp) -> None:
        """检查二元操作 - 检测字符串拼接绕过 (如 "e"+"v"+"a"+"l")"""
        if isinstance(node.op, ast.Add):
            parts = self._extract_strings(node)
            if len(parts) >= 2:
                combined = "".join(parts)
                # 检查拼接结果是否是危险名称
                dangerous_names = BLOCKED_BUILTINS | {
                    "getattr", "globals", "locals", "type",
                    "__import__", "__builtins__", "__class__",
                    "__bases__", "__subclasses__", "__globals__",
                }
                if combined in dangerous_names:
                    display = "+".join(repr(s) for s in parts)
                    self.errors.append(
                        f"blocked: 字符串拼接绕过 '{display}' (行 {node.lineno}) "
                        f"- 可能用于绕过安全限制"
                    )

        self.generic_visit(node)

    @staticmethod
    def _extract_strings(node: ast.AST) -> List[str]:
        """递归提取 BinOp Add 操作中的字符串常量"""
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return [node.value]
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            left = SecurityChecker._extract_strings(node.left)
            right = SecurityChecker._extract_strings(node.right)
            return left + right
        return []

    # ------------------------------------------------------------------
    # 编码绕过检测
    # ------------------------------------------------------------------

    def visit_Constant(self, node: ast.Constant) -> None:
        """检查常量 - 检测 hex/unicode 编码绕过"""
        if not isinstance(node.value, str):
            self.generic_visit(node)
            return

        s: str = node.value
        lineno = node.lineno

        # 定义危险名称集合
        dangerous_names = BLOCKED_BUILTINS | {
            "getattr", "globals", "locals", "__import__",
            "__builtins__", "__class__", "builtins",
        }

        # 检测 hex 编码绕过
        if "\\x" in s:
            decoded = self._decode_escapes(s)
            if decoded in dangerous_names:
                self.errors.append(
                    f"blocked: 十六进制编码字符串 (行 {lineno}) - '{s}' -> '{decoded}'"
                )
                self.generic_visit(node)
                return

        # 检测 unicode 编码绕过
        if "\\u" in s or "\\U" in s:
            decoded = self._decode_escapes(s)
            if decoded in dangerous_names:
                self.errors.append(
                    f"blocked: Unicode 编码字符串 (行 {lineno}) - 可能的绕过尝试"
                )
                self.generic_visit(node)
                return

        # 检测八进制编码绕过
        if re.search(r"\\[0-7]{3}", s):
            decoded = self._decode_escapes(s)
            if decoded in dangerous_names:
                self.errors.append(
                    f"blocked: 八进制编码字符串 (行 {lineno}) - 可能的绕过尝试"
                )
                self.generic_visit(node)
                return

        self.generic_visit(node)

    # ------------------------------------------------------------------
    # except __traceback__ 帧遍历 (CVE-2026-39888)
    # ------------------------------------------------------------------

    def visit_Try(self, node: ast.Try) -> None:
        """检查 try/except - 检测 __traceback__ 帧遍历"""
        for handler in node.handlers:
            if handler.name is not None:
                # 全局 __traceback__ 检查已在 visit_Attribute 中完成
                pass
        self.generic_visit(node)

    # ------------------------------------------------------------------

    @staticmethod
    def _decode_escapes(s: str) -> str:
        """解码字符串中的转义序列"""
        try:
            return s.encode("utf-8").decode("unicode_escape")
        except (UnicodeDecodeError, UnicodeEncodeError):
            return s


def check_security(source_code: str) -> Dict[str, Any]:
    """对源码进行 AST 安全审查

    Args:
        source_code: 要审查的 Python 源码字符串

    Returns:
        审查结果字典:
            passed(bool): 是否通过审查
            errors(list): 错误列表
            used_imports(list): 使用的导入列表
            lines_checked(int): 检查的行数
    """
    try:
        tree = ast.parse(source_code)
    except SyntaxError as e:
        return {
            "passed": False,
            "errors": [f"syntax error: {e}"],
            "used_imports": [],
            "lines_checked": len(source_code.splitlines()),
        }

    checker = SecurityChecker()

    # 使用 ast.walk + 手动调用 visit 确保所有节点都被访问
    # SecurityChecker 继承 NodeVisitor 自动遍历，但显式调用更可靠
    checker.visit(tree)

    return {
        "passed": len(checker.errors) == 0,
        "errors": checker.errors,
        "used_imports": sorted(checker.used_imports),
        "lines_checked": len(source_code.splitlines()),
    }


# =========================================================================
# Windows Job Object - 子进程内存限制
# =========================================================================

# Job Object 限制常量
JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x00000100
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000

# JobObjectExtendedLimitInformation 信息类
JobObjectExtendedLimitInformation = 9


class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", wintypes.LARGE_INTEGER),
        ("PerJobUserTimeLimit", wintypes.LARGE_INTEGER),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class IO_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_ulonglong),
        ("WriteOperationCount", ctypes.c_ulonglong),
        ("OtherOperationCount", ctypes.c_ulonglong),
        ("ReadTransferCount", ctypes.c_ulonglong),
        ("WriteTransferCount", ctypes.c_ulonglong),
        ("OtherTransferCount", ctypes.c_ulonglong),
    ]


class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
        ("IoInfo", IO_COUNTERS),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


def _create_job_object(memory_limit_mb: int = 256):
    """创建 Windows Job Object 并设置进程内存限制

    Args:
        memory_limit_mb: 内存限制（MB）

    Returns:
        job_handle: Job Object 句柄，失败返回 None
    """
    try:
        k32 = _get_kernel32()
        job_handle = k32.CreateJobObjectW(None, None)
        if not job_handle:
            return None

        memory_bytes = memory_limit_mb * 1024 * 1024

        info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        info.BasicLimitInformation.LimitFlags = (
            JOB_OBJECT_LIMIT_PROCESS_MEMORY
            | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        )
        info.ProcessMemoryLimit = ctypes.c_size_t(memory_bytes)
        info.JobMemoryLimit = ctypes.c_size_t(memory_bytes)

        result = k32.SetInformationJobObject(
            job_handle,
            JobObjectExtendedLimitInformation,
            ctypes.byref(info),
            ctypes.sizeof(info),
        )
        if not result:
            k32.CloseHandle(job_handle)
            return None

        return job_handle
    except Exception:
        return None


def _assign_process_to_job(job_handle, process_pid: int) -> bool:
    """将进程（通过 PID）分配到 Job Object

    Args:
        job_handle: Job Object 句柄
        process_pid: 子进程 PID

    Returns:
        是否成功
    """
    try:
        k32 = _get_kernel32()
        # PROCESS_SET_QUOTA | PROCESS_TERMINATE
        access_rights = 0x0100 | 0x0001
        proc_handle = k32.OpenProcess(access_rights, False, process_pid)
        if not proc_handle:
            return False
        try:
            result = k32.AssignProcessToJobObject(job_handle, proc_handle)
            return bool(result)
        finally:
            k32.CloseHandle(proc_handle)
    except Exception:
        return False


# =========================================================================
# 子进程执行
# =========================================================================

def execute_script(
    script_path: str,
    timeout: int = 30,
    env_vars: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """在沙箱子进程中执行脚本（生产版）

    与 demo 版本的区别：
    - 不创建包装脚本，直接运行目标脚本
    - 不接收 Context 实例（由上层调用者处理通信）
    - stdout 作为原始文本返回（不解析 JSON）
    - 更简洁的返回结构

    执行流程：
    1. 读取脚本源码
    2. AST 安全审查
    3. 创建 Windows Job Object（内存限制）
    4. 以子进程方式直接运行脚本
    5. 收集 stdout/stderr
    6. 处理超时

    Args:
        script_path: 要执行的脚本路径
        timeout: 超时秒数（默认 30）
        env_vars: 额外的环境变量（可选）

    Returns:
        执行结果字典:
            success(bool): 是否成功完成（exit_code == 0 且未超时）
            exit_code(int): 进程退出码（-1 超时，-2 安全审查未通过）
            stdout(str): 标准输出原始文本
            stderr(str): 标准错误输出
            timed_out(bool): 是否超时终止
            duration(float): 执行耗时（秒）
    """
    start_time = time.time()
    result: Dict[str, Any] = {
        "success": False,
        "exit_code": -1,
        "stdout": "",
        "stderr": "",
        "timed_out": False,
        "duration": 0.0,
    }

    # --- 1. 读取源码并进行 AST 安全审查 ---
    try:
        with open(script_path, "r", encoding="utf-8") as f:
            source = f.read()
    except FileNotFoundError:
        msg = f"脚本文件未找到: {script_path}"
        logger.error(msg)
        result["stderr"] = msg
        return result
    except PermissionError:
        msg = f"权限错误: 无法读取 {script_path}"
        logger.error(msg)
        result["stderr"] = msg
        return result
    except OSError:
        msg = f"IO错误: 无法读取 {script_path}"
        logger.error(msg)
        result["stderr"] = msg
        return result

    security = check_security(source)
    if not security["passed"]:
        error_lines = "\n".join(security["errors"])
        logger.warning(f"安全审查未通过: {script_path}\n{error_lines}")
        result["stderr"] = "安全审查未通过:\n" + error_lines
        result["exit_code"] = -2
        return result

    # --- 2. 创建 Job Object（设置内存限制）---
    # 从配置读取内存限制，默认 256MB
    cfg = get_config()
    memory_limit = getattr(cfg, 'sandbox_memory_limit_mb', None) or 256
    # 也尝试从 sandbox.memory_limit_mb 读取
    try:
        memory_limit = int(cfg._data.get('sandbox', {}).get('memory_limit_mb', memory_limit))
    except (AttributeError, ValueError, TypeError):
        pass

    job_handle = _create_job_object(memory_limit)
    if job_handle is None:
        logger.warning("无法创建 Job Object，内存限制不生效")

    # --- 3. 准备环境变量 ---
    env = os.environ.copy()
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8:replace"
    if env_vars:
        env.update(env_vars)

    # 添加脚本目录到 PYTHONPATH（允许脚本导入同级模块）；
    # 同时添加 backend/ 目录 —— 任务脚本可 import 白名单内的
    # services.health.sources.cloud_pull（子进程 sys.path 不含 cwd，必须显式注入）
    script_dir = os.path.dirname(os.path.abspath(script_path))
    backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    python_path = env.get("PYTHONPATH", "")
    path_parts = [script_dir, backend_dir]
    if python_path:
        path_parts.append(python_path)
    env["PYTHONPATH"] = os.pathsep.join(path_parts)

    # --- 4. 启动子进程（直接运行脚本，无包装器）---
    process = None
    try:
        process = subprocess.Popen(
            [sys.executable, "-u", script_path],
            shell=False,
            creationflags=_POPEN_CREATE_NO_WINDOW,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            encoding="utf-8",
            errors="replace",
            env=env,
        )

        # 分配 Job Object
        if job_handle and process.pid:
            _assign_process_to_job(job_handle, process.pid)

        # --- 5. 收集输出（带超时）---
        stdout_text = ""
        stderr_text = ""
        try:
            stdout_text, stderr_text = process.communicate(timeout=timeout)
            duration = time.time() - start_time
            result["exit_code"] = process.returncode
            result["success"] = process.returncode == 0
            result["stdout"] = stdout_text or ""
            result["stderr"] = stderr_text or ""
            result["timed_out"] = False
            result["duration"] = duration

        except subprocess.TimeoutExpired:
            # 超时 - 杀死进程并获取已产生的输出
            logger.warning(f"脚本执行超时 ({timeout}s): {script_path}")
            process.kill()
            try:
                leftover_stdout, leftover_stderr = process.communicate(timeout=10)
                stdout_text += (leftover_stdout or "")
                stderr_text += (leftover_stderr or "")
            except subprocess.TimeoutExpired:
                logger.error(f"超时后 communicate 仍超时: {script_path}")
                # 如果还超时就放弃，用已有的部分输出

            duration = time.time() - start_time
            result["exit_code"] = process.returncode if process.returncode is not None else -1
            result["stdout"] = stdout_text or ""
            result["stderr"] = stderr_text or ""
            result["timed_out"] = True
            result["duration"] = duration

    except Exception as e:
        logger.error(f"执行脚本异常: {script_path}: {type(e).__name__}: {e}")
        result["stderr"] = (result.get("stderr") or "") + f"执行异常: {type(e).__name__}: {e}"
    finally:
        # 关闭 Job Object 句柄
        if job_handle:
            try:
                _get_kernel32().CloseHandle(job_handle)
            except Exception:
                pass

    return result


# =========================================================================
# 单例封装
# =========================================================================

class ScriptSandbox:
    """脚本沙箱（面向对象封装）

    提供 check() 和 execute() 两个核心方法的单例类。
    所有耗时操作同步执行，调用方负责异步包装（如 run_in_executor）。
    """

    def __init__(self, memory_limit_mb: int = 256):
        """
        Args:
            memory_limit_mb: Job Object 内存限制（MB）
        """
        self._memory_limit_mb = memory_limit_mb
        logger.info(
            f"ScriptSandbox 初始化完成 (memory_limit={memory_limit_mb}MB)"
        )

    def check(self, source_code: str) -> Dict[str, Any]:
        """对源码进行 AST 安全审查

        Args:
            source_code: Python 源码字符串

        Returns:
            同 check_security()
        """
        return check_security(source_code)

    def execute(
        self,
        script_path: str,
        timeout: int = 30,
        env_vars: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        """在沙箱子进程中执行脚本

        Args:
            script_path: 脚本绝对路径
            timeout: 超时秒数
            env_vars: 额外环境变量

        Returns:
            同 execute_script()
        """
        return execute_script(script_path, timeout, env_vars)


# 全局单例
_instance: Optional[ScriptSandbox] = None


def get_script_sandbox() -> ScriptSandbox:
    """获取全局 ScriptSandbox 单例（懒加载）"""
    global _instance
    if _instance is None:
        _instance = ScriptSandbox()
    return _instance


def init_script_sandbox(memory_limit_mb: int = 256) -> ScriptSandbox:
    """初始化（或重置）全局 ScriptSandbox 单例

    Args:
        memory_limit_mb: 内存限制（MB）

    Returns:
        ScriptSandbox 实例
    """
    global _instance
    _instance = ScriptSandbox(memory_limit_mb=memory_limit_mb)
    return _instance
