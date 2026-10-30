"""config —— 聚合搜索 MCP server 的配置加载（harness 副本：启动宽容版）。

路径优先级：显式参数 > 环境变量 SEARCH_MCP_CONFIG > 模块同目录 config.json。
环境变量覆盖：SEARCH_MCP_TAVILY_KEY / SEARCH_MCP_EXA_KEY / SEARCH_MCP_DEFAULT_PROVIDER。

与原版（search-mcp 仓库）的唯一行为差异：配置问题不再 SystemExit，改为
"启动宽容、调用时硬约束"——harness 对 spawn 失败的 MCP server 静默降级、
工具整体消失，体验差；因此文件缺失 / JSON 非法 / 未配 key / default_provider
非法都只向 stderr 输出中文警告并回落默认配置，服务照常启动，由路由层在
web_search 调用时返回带配置指引的 error dict（SearchUnavailable 既有行为）。
警告绝不打到 stdout（stdio server 的 stdout 是协议通道）；绝不打印 key 明文。
"""

import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

_VALID_PROVIDERS = ("tavily", "exa")

# 未配置指引的统一文案（缺文件 / 坏 JSON / 零 key 警告共用后半句）
_KEY_HINT = "配置 API key 后方可实际搜索（参考 config.example.json 或环境变量 SEARCH_MCP_TAVILY_KEY / SEARCH_MCP_EXA_KEY）"


@dataclass
class Config:
    """加载并校验后的运行配置。"""

    default_provider: str
    fallback_enabled: bool
    request_deadline_s: float
    tavily_key: Optional[str]
    exa_key: Optional[str]
    config_path: Path
    exa_monthly_budget_usd: float = 10.0


def _warn(message: str) -> None:
    """中文警告统一走 stderr（stdout 留给 MCP 协议），不中断启动。"""
    print(f"search-mcp: {message}", file=sys.stderr)


def _resolve_path(path: Optional[str]) -> Path:
    """按优先级解析配置文件路径（显式参数 > env > 模块同目录）。"""
    if path:
        return Path(path)
    env_path = os.environ.get("SEARCH_MCP_CONFIG")
    if env_path:
        return Path(env_path)
    return Path(__file__).resolve().parent / "config.json"


def _read_json(cfg_file: Path) -> tuple[dict[str, Any], bool]:
    """宽容读配置：任何问题都返回 ({}, False) 并打 stderr 警告，绝不抛异常。

    返回值第二项表示"文件存在且可解析"；False 时 load_config 跳过零 key
    警告（缺文件 / 坏 JSON 的警告已含同等指引，避免重复刷屏）。
    """
    if not cfg_file.is_file():
        _warn(f"未找到配置文件 {cfg_file}，使用默认配置；{_KEY_HINT}")
        return {}, False
    try:
        data = json.loads(cfg_file.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        _warn(f"配置文件不是合法 JSON：{cfg_file}（{exc.msg}），按空配置继续；{_KEY_HINT}")
        return {}, False
    except OSError as exc:
        _warn(f"配置文件无法读取：{cfg_file}（{exc}），按空配置继续；{_KEY_HINT}")
        return {}, False
    if not isinstance(data, dict):
        _warn(f"配置文件顶层必须是 JSON 对象：{cfg_file}，按空配置继续；{_KEY_HINT}")
        return {}, False
    return data, True


def _provider_key(data: dict[str, Any], name: str) -> Optional[str]:
    """取 providers.<name>.api_key；空串/缺失/非对象一律归一为 None。"""
    section = data.get("providers")
    if not isinstance(section, dict):
        return None
    entry = section.get(name)
    if not isinstance(entry, dict):
        return None
    key = entry.get("api_key")
    if isinstance(key, str) and key.strip():
        return key
    return None


def load_config(path: Optional[str] = None) -> Config:
    """加载配置：读文件（宽容）→ 环境变量覆盖 → 回落默认值 → 返回 Config。

    本函数在任何输入下都返回可用 Config，绝不 SystemExit / raise；
    "未配 key 不得搜索"的硬约束由 SearchRouter 在调用时以 SearchUnavailable
    中文指引落实（providers 空 dict 时既有行为）。
    """
    cfg_file = _resolve_path(path)
    data, parsed = _read_json(cfg_file)

    default_provider = data.get("default_provider") or "tavily"
    tavily_key = _provider_key(data, "tavily")
    exa_key = _provider_key(data, "exa")

    # 环境变量覆盖文件值（key 只覆盖值本身，绝不明文输出）
    env_provider = os.environ.get("SEARCH_MCP_DEFAULT_PROVIDER")
    if env_provider:
        default_provider = env_provider
    env_tavily = os.environ.get("SEARCH_MCP_TAVILY_KEY")
    if env_tavily:
        tavily_key = env_tavily
    env_exa = os.environ.get("SEARCH_MCP_EXA_KEY")
    if env_exa:
        exa_key = env_exa

    # default_provider 非法 → 警告并回落默认 tavily（启动宽容原则）
    if default_provider not in _VALID_PROVIDERS:
        _warn(
            f"default_provider 非法：'{default_provider}'，只允许 'tavily' 或 'exa'，"
            "已回落为 'tavily'"
        )
        default_provider = "tavily"

    # 文件正常但两个 key 全空 → 仅警告，服务照常（调用期返回配置指引错误）
    if parsed and not tavily_key and not exa_key:
        _warn(f"两个提供商均未配置 api_key，使用默认配置启动；{_KEY_HINT}")

    providers = data.get("providers") if isinstance(data.get("providers"), dict) else {}
    exa_section = providers.get("exa") if isinstance(providers.get("exa"), dict) else {}
    budget = exa_section.get("monthly_budget_usd")
    if not isinstance(budget, (int, float)):
        budget = 10.0

    fallback = data.get("fallback_enabled")
    deadline = data.get("request_deadline_s")
    try:
        deadline_f = float(deadline) if deadline is not None else 55.0
    except (TypeError, ValueError):
        _warn(f"request_deadline_s 必须是数字：{deadline!r}，已回落默认 55.0")
        deadline_f = 55.0

    return Config(
        default_provider=str(default_provider),
        fallback_enabled=True if fallback is None else bool(fallback),
        request_deadline_s=deadline_f,
        tavily_key=tavily_key,
        exa_key=exa_key,
        config_path=cfg_file,
        exa_monthly_budget_usd=float(budget),
    )
