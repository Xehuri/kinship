"""
脚本上下文 - JSON stdout 管道通信

Context 对象提供脚本与调度器之间的通信接口。
所有输出通过 stdout JSON 行传输，调度器读取并分发。
"""

import sys
import json
import time
import os
import re
from typing import Optional, List, Dict, Any


class ContextError(Exception):
    """Context 操作异常"""
    pass


MAX_LINE_LENGTH = 64 * 1024  # 64KB


class Context:
    """
    脚本执行上下文 - 为脚本提供沙箱化 API。

    在 DEMO 模式下，所有操作仅写入 JSON stdout，不发起实际 API 调用。
    """

    def __init__(self, script_name: str = "", demo_mode: bool = True,
                 default_prompt: str = ""):
        self.script_name = script_name
        self.demo_mode = demo_mode
        self.default_prompt = default_prompt
        self._allowed_read_paths: List[str] = self._detect_allowed_paths()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def log(self, message: str, level: str = "info") -> None:
        """输出结构化日志到 stdout 作为 JSON 行。

        Args:
            message: 日志消息内容。
            level: 日志级别，可选 'debug', 'info', 'warning', 'error'。
        """
        self._write_json({
            "type": "log",
            "level": level,
            "message": message,
            "timestamp": time.time(),
        })

    def trigger_task(self, target: str, prompt: Optional[str] = None,
                     model: Optional[str] = None,
                     provider: Optional[str] = None) -> None:
        """向调度器发送信号，触发一个 OpenCode 任务。

        在 demo 模式下，仅输出 JSON 行，不进行实际 API 调用。

        Args:
            target: 任务名称/目标标识。
            prompt: 发送给 OpenCode 的提示词。为 None 时使用 default_prompt。
            model: 覆盖本次触发使用的模型 ID；为 None 时用脚本 frontmatter 的 model，
                再回落到后端全局默认（config.yaml `opencode.default_model`）。
            provider: 覆盖本次触发使用的提供商 ID；为 None 时用脚本 frontmatter 的
                provider，再回落到后端全局默认（config.yaml `opencode.default_provider`）。
        """
        if prompt is None:
            prompt = self.default_prompt
        payload = {
            "type": "trigger_task",
            "target": target,
            "prompt": prompt,
            "timestamp": time.time(),
        }
        # 仅在显式指定时携带，避免用 None 覆盖上层 frontmatter 配置
        if model is not None:
            payload["model"] = model
        if provider is not None:
            payload["provider"] = provider
        self._write_json(payload)

    def alert(self, message: str, level: str = "error") -> None:
        """报告错误/警报。

        Args:
            message: 警报消息内容。
            level: 警报级别，推荐 'error' 或 'warning'。
        """
        self._write_json({
            "type": "alert",
            "level": level,
            "message": message,
            "timestamp": time.time(),
        })

    def read_file(self, path: str) -> Optional[str]:
        """读取文件内容，仅在路径位于沙箱允许范围内时。

        路径沙箱规则：
        - 拒绝包含 '..' 的路径（防止目录遍历）。
        - 拒绝以 '/' 或 Windows 盘符（如 C:\\）开头的绝对路径。
        - 仅允许项目根目录下的相对路径。

        Args:
            path: 文件路径（相对路径或已确认在沙箱内的路径）。

        Returns:
            文件内容字符串，如果路径不允许或文件不存在则返回 None。
        """
        if not self._path_allowed(path):
            return None

        # 尝试在项目根目录下解析路径
        resolved = None
        for base in self._allowed_read_paths:
            candidate = os.path.normpath(os.path.join(base, path))
            # 确保解析后的路径仍在允许的基目录下
            if self._is_subpath(candidate, base):
                resolved = candidate
                break

        if resolved is None:
            return None

        try:
            with open(resolved, "r", encoding="utf-8") as f:
                return f.read()
        except (FileNotFoundError, PermissionError, OSError):
            return None

    def getenv(self, key: str, default: Optional[str] = None) -> Optional[str]:
        """读取环境变量。

        Args:
            key: 环境变量名。
            default: 变量不存在时返回的默认值。

        Returns:
            环境变量值，或 default。
        """
        return os.environ.get(key, default)

    def backend_info(self) -> Dict[str, str]:
        """获取后端运行信息（通过管道注入的环境变量）。

        Returns:
            包含以下键的字典：
                backend_port: 后端 HTTPS 端口
                opencode_port: OpenCode 服务端口
                opencode_session_id: 当前 OpenCode 主智能体会话 ID（可能为空）
        """
        return {
            "backend_port": self.getenv("AXEUH_BACKEND_PORT", ""),
            "opencode_port": self.getenv("AXEUH_OPENCODE_PORT", ""),
            "opencode_session_id": self.getenv("AXEUH_OPENCODE_SESSION_ID", ""),
        }

    def heartbeat(self) -> None:
        """发送心跳信号。

        在 serve() 模式下必须每 30 秒调用一次，以告知调度器脚本仍在运行。
        """
        self._write_json({
            "type": "heartbeat",
            "timestamp": time.time(),
        })

    def schedule_next(self, seconds: float) -> None:
        """请求调度器在指定秒数后再次运行此脚本。

        Args:
            seconds: 距离下次运行的间隔秒数。
        """
        self._write_json({
            "type": "next_run",
            "seconds": seconds,
            "timestamp": time.time(),
        })

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _write_json(self, obj: Dict[str, Any]) -> None:
        """向 stdout 写入一行 JSON。

        规则：
        - 使用 sys.stdout.write() + sys.stdout.flush()，不使用 print()。
        - 每行 JSON 不超过 64KB，超出则截断。
        - 正确处理中文字符（ensure_ascii=False）。

        Args:
            obj: 要序列化的字典对象。
        """
        line = json.dumps(obj, ensure_ascii=False)

        # 截断超出限制的负载
        if len(line) > MAX_LINE_LENGTH:
            # 保留 type 和 timestamp 关键字段，截断 message/prompt 等
            truncated = False
            for key in ("message", "prompt"):
                if key in obj and isinstance(obj[key], str):
                    max_val_len = MAX_LINE_LENGTH - len(line) + len(obj[key]) - 200
                    if max_val_len > 0:
                        obj[key] = obj[key][:max_val_len] + "...[truncated]"
                    else:
                        obj[key] = "...[truncated]"
                    truncated = True
            if truncated:
                line = json.dumps(obj, ensure_ascii=False)
            # 如果截断后仍然超限，强制截断 JSON 字符串本身
            if len(line) > MAX_LINE_LENGTH:
                line = line[: MAX_LINE_LENGTH - 1] + "\u2026"

        sys.stdout.write(line + "\n")
        sys.stdout.flush()

    def _detect_allowed_paths(self) -> List[str]:
        """检测允许读取的路径列表。

        返回：
            包含项目根目录（CWD）和可能的父级项目目录的列表。
        """
        paths = []

        # 当前工作目录
        try:
            cwd = os.getcwd()
            paths.append(cwd)
        except OSError:
            pass

        # 向上查找包含 pyproject.toml 或 setup.py 的项目根目录
        for base in list(paths):
            parent = os.path.dirname(base)
            markers = ("pyproject.toml", "setup.py", "setup.cfg", ".git", "AGENTS.md")
            for _ in range(5):  # 最多上溯 5 层
                if any(os.path.isfile(os.path.join(parent, m)) or os.path.isdir(os.path.join(parent, m)) for m in markers):
                    if parent not in paths:
                        paths.append(parent)
                    break
                next_parent = os.path.dirname(parent)
                if next_parent == parent:
                    break
                parent = next_parent

        # 规范化并去重
        normalized = []
        seen = set()
        for p in paths:
            try:
                np = os.path.normpath(p)
                if np not in seen:
                    normalized.append(np)
                    seen.add(np)
            except OSError:
                continue

        return normalized

    def _path_allowed(self, path: str) -> bool:
        """检查路径是否在允许的沙箱范围内。

        Args:
            path: 要检查的文件路径。

        Returns:
            如果路径安全且在沙箱内返回 True，否则返回 False。
        """
        if not path or not isinstance(path, str):
            return False

        # 拒绝目录遍历（检查路径组件中是否有 ..）
        parts = path.replace("\\", "/").split("/")
        if ".." in parts:
            return False

        # 拒绝 Unix 绝对路径
        if path.startswith("/"):
            return False

        # 拒绝 Windows 盘符绝对路径（如 C:\、D:\ 等）
        if re.match(r"^[A-Za-z]:[\\/]", path):
            return False

        return True

    @staticmethod
    def _is_subpath(candidate: str, base: str) -> bool:
        """检查 candidate 路径是否在 base 目录之下。

        Args:
            candidate: 候选路径。
            base: 基准目录路径。

        Returns:
            如果 candidate 是 base 的子路径返回 True。
        """
        try:
            candidate = os.path.normpath(candidate)
            base = os.path.normpath(base)
            # 在 Windows 上不区分大小写
            if sys.platform == "win32":
                return candidate.lower().startswith(base.lower() + os.sep) or candidate.lower() == base.lower()
            return candidate.startswith(base + os.sep) or candidate == base
        except OSError:
            return False


def create_default_context(script_name: str = "", demo_mode: bool = True,
                            default_prompt: str = "") -> Context:
    """工厂函数，使用默认配置创建 Context 实例。

    Args:
        script_name: 脚本名称标识。
        demo_mode: 是否启用演示模式（默认 True）。
        default_prompt: 默认提示词（在 trigger_task 未指定 prompt 时使用）。

    Returns:
        配置好的 Context 实例。
    """
    return Context(script_name=script_name, demo_mode=demo_mode,
                   default_prompt=default_prompt)
