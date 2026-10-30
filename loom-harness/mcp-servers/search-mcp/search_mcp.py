#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""search_mcp —— 聚合网络搜索 MCP server 入口（stdio 传输）。

服务定位：把 search-mcp 的聚合搜索内核（router 额度降级状态机 + cooldown 持久化
+ tavily/exa 双 provider）封装成一个可通过 stdio 运行的 MCP server，
对外暴露三个工具：web_search / provider_status / reset_cooldown。

启动方式（stdio，由 MCP 客户端拉起，不要手工挂起）：
  /opt/venvs/search-mcp/bin/python <本目录>/search_mcp.py

配置说明：读模块同目录 config.json（可用环境变量 SEARCH_MCP_CONFIG 指定路径），
key 与默认提供商可被 SEARCH_MCP_TAVILY_KEY / SEARCH_MCP_EXA_KEY /
SEARCH_MCP_DEFAULT_PROVIDER 覆盖。未配置 key 时服务照常启动（config.py 为
"启动宽容"版，仅向 stderr 打中文警告），web_search 调用返回含配置指引的
纯文本失败说明 —— 复制使用后必须先自行配置 key，见 README"安装后必做"。
冷却与预算状态持久化在 state/cooldown.json（见 cooldown.py）。

工具输出均为紧凑纯文本（不是 JSON）：MCP 客户端把文本块原样交给模型，
不经 FastMCP 的结构化 JSON 包装（工具声明 structured_output=False）。
"""

from typing import Any, Literal

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

from config import Config, load_config
from cooldown import CooldownStore
from providers.base import NormalizedResult, ProviderError, SearchUnavailable
from providers.exa import ExaProvider
from providers.tavily import TavilyProvider
from router import SearchRouter

mcp = FastMCP("search")

# web_search 失败时统一附加的下一步指引（错误不外泄到协议层，指引代替异常）
_ERROR_GUIDE = (
    "可调用 provider_status 查看两家提供商的实时状态与用量；"
    "确认提供商恢复（额度已重置 / 冷却已到期 / key 已修复）后，"
    "调用 reset_cooldown 手动清除冷却记录以恢复路由。"
)

# 文本裁剪上限（字符）：正文摘要 / answer 与 note / meta
_CONTENT_LIMIT = 1200
_ANSWER_LIMIT = 500
_NOTE_LIMIT = 500
_META_LIMIT = 300


def _build_router(cfg: Config, store: CooldownStore) -> SearchRouter:
    """按配置组装路由器：只实例化 key 非空的提供商（工厂函数，测试可注入替身）。"""
    providers: dict[str, Any] = {}
    if cfg.tavily_key:
        providers["tavily"] = TavilyProvider(cfg.tavily_key)
    if cfg.exa_key:
        providers["exa"] = ExaProvider(cfg.exa_key)
    return SearchRouter(cfg, store, providers)


# 模块级构建一次：stdio 单进程长会话，路由器与冷却状态全程共用同一实例。
# config.py 为启动宽容版：load_config() 永不 SystemExit，未配 key 时 providers
# 为空 dict，SearchRouter 照常构造，调用期返回 SearchUnavailable 配置指引。
cfg = load_config()
store = CooldownStore(monthly_budget_usd=cfg.exa_monthly_budget_usd)
router: SearchRouter = _build_router(cfg, store)


# ---------- 纯文本渲染（MCP 边界） ----------


def _plain(value: Any) -> str:
    """任意值压成单行文本：换行与连续空白归一为一个空格。"""
    if value is None:
        return ""
    return " ".join(str(value).split())


def _clip(text: str, limit: int) -> str:
    """按字符上限裁剪（不追加省略号，保持契约稳定）。"""
    return text if len(text) <= limit else text[:limit]


def _labelled(name: str, value: Any, limit: int | None = None, indent: str = "") -> str:
    """渲染 `name: value` 行；值为空时返回空串（调用方据此省略整行）。"""
    text = _plain(value)
    if limit is not None:
        text = _clip(text, limit)
    return f"{indent}{name}: {text}" if text else ""


def _meta_text(value: Any) -> str:
    """把 meta 树压成 `k=v, k=v`：嵌套 dict 继续展平，list 用方括号包裹。"""
    if isinstance(value, dict):
        parts = []
        for key, item in value.items():
            rendered = _meta_text(item)
            if rendered:
                parts.append(f"{key}={rendered}")
        return ", ".join(parts)
    if isinstance(value, (list, tuple)):
        rendered = ", ".join(text for text in (_meta_text(v) for v in value) if text)
        return f"[{rendered}]"
    return _plain(value)


def _quota_text(quota: Any) -> str:
    """渲染 tavily 额度用量为 quota(plan=<plan>, used=<used>)，缺字段则省略。"""
    if not isinstance(quota, dict):
        return ""
    account = quota.get("account") if isinstance(quota.get("account"), dict) else {}
    key_info = quota.get("key") if isinstance(quota.get("key"), dict) else {}
    plan = _plain(account.get("current_plan"))
    used = account.get("plan_usage")
    if used is None:
        used = key_info.get("usage")
    parts = []
    if plan:
        parts.append(f"plan={plan}")
    used_text = _plain(used)
    if used_text:
        parts.append(f"used={used_text}")
    return f"quota({', '.join(parts)})" if parts else ""


def _number_text(value: Any) -> str:
    """数字字段转文本（0 是有效值，不可当空值省略）。"""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return ""
    return _plain(value)


def _render_web_search(result: NormalizedResult) -> str:
    """web_search 成功输出：标题行 + 每条结果三行内 + 尾部可选行。"""
    results = result.results if isinstance(result.results, list) else []
    fallback = "yes" if result.fallback_applied else "no"
    lines = [
        "web_search provider=%s fallback=%s results=%d"
        % (_plain(result.provider_used), fallback, len(results))
    ]
    for index, item in enumerate(results, 1):
        record = item if isinstance(item, dict) else {}
        lines.append(
            "%d. %s — %s" % (index, _plain(record.get("title")), _plain(record.get("url")))
        )
        for line in (
            _labelled("published", record.get("published_date"), indent="   "),
            _labelled("content", record.get("content"), _CONTENT_LIMIT, "   "),
        ):
            if line:
                lines.append(line)
    for line in (
        _labelled("answer", result.answer, _ANSWER_LIMIT),
        _labelled("note", result.note, _NOTE_LIMIT),
        _labelled("meta", _clip(_meta_text(result.meta), _META_LIMIT)),
    ):
        if line:
            lines.append(line)
    return "\n".join(lines)


def _error_text(message: str) -> str:
    """web_search 失败输出：一行错误 + 指引（模型下一步应查状态再重置冷却）。"""
    return "web_search failed: %s\nnote: %s" % (
        _plain(message),
        _clip(_plain(_ERROR_GUIDE), _NOTE_LIMIT),
    )


def _render_status(snapshot: dict[str, Any]) -> str:
    """provider_status 输出：首行默认路由，其后每家提供商一行（保持快照顺序）。"""
    fallback = "on" if snapshot.get("fallback_enabled") else "off"
    lines = [
        "provider_status default=%s fallback=%s"
        % (_plain(snapshot.get("default_provider") or "unknown"), fallback)
    ]
    providers = snapshot.get("providers")
    untils = snapshot.get("cooldown_until")
    providers = providers if isinstance(providers, dict) else {}
    untils = untils if isinstance(untils, dict) else {}
    for name, record in providers.items():
        rec = record if isinstance(record, dict) else {}
        parts = ["state=%s" % (_plain(rec.get("state")) or "unknown")]
        reason = _plain(rec.get("reason"))
        if reason:
            parts.append(f"reason={reason}")
        until = _plain(untils.get(name))
        if until:
            parts.append(f"until={until}")
        quota = _quota_text(rec.get("quota"))
        if quota:
            parts.append(quota)
        cost = _number_text(rec.get("month_cost_usd"))
        if cost:
            parts.append(f"month_cost_usd={cost}")
        budget = _number_text(rec.get("monthly_budget_usd"))
        if budget:
            parts.append(f"monthly_budget_usd={budget}")
        lines.append("- %s %s" % (name, " ".join(parts)))
    return "\n".join(lines)


def _render_reset(payload: dict[str, Any]) -> str:
    """reset_cooldown 输出：首行重置范围，其后每家被清记录一行。"""
    lines = ["reset_cooldown reset=%s" % (_plain(payload.get("reset")) or "all")]
    providers = payload.get("providers")
    providers = providers if isinstance(providers, dict) else {}
    for name, record in providers.items():
        rec = record if isinstance(record, dict) else {}
        parts = ["state=%s" % (_plain(rec.get("state")) or "unknown")]
        reason = _plain(rec.get("reason"))
        if reason:
            parts.append(f"reason={reason}")
        until = _plain(rec.get("until"))
        if until:
            parts.append(f"until={until}")
        lines.append("- %s %s" % (name, " ".join(parts)))
    return "\n".join(lines)


@mcp.tool(
    structured_output=False,
    annotations=ToolAnnotations(
        readOnlyHint=True,
        destructiveHint=False,
        idempotentHint=True,
        openWorldHint=True,
    )
)
def web_search(
    query: str,
    # Literal 枚举让 MCP inputSchema 生成 enum，帮助调用方 AI 精确取值
    provider: Literal["", "tavily", "exa"] = "",
    max_results: int = 5,
    depth: Literal["basic", "advanced"] = "basic",
    topic: Literal["", "general", "news", "finance"] = "",
    time_range: Literal["", "day", "week", "month", "year"] = "",
    include_content: bool = False,
    include_answer: bool = False,
) -> str:
    """聚合网络搜索：双提供商 Tavily / Exa，额度耗尽自动切换。

    provider 留空走默认提供商（默认 tavily，由 config.json 的 default_provider
    决定）；当一家额度耗尽 / 被限流 / 持续故障时自动切换另一家，并在返回的
    fallback=yes 中体现。本工具永不向协议层抛异常。

    用法示例:
      web_search(query="2026 年量子计算进展")
      web_search(query="latest AI news", provider="exa", max_results=10)
      web_search(query="某公司财报", topic="finance", include_answer=True)

    Args:
        query: 搜索关键词（中英文均可，不能为空）
        provider: 显式指定提供商："tavily" / "exa"；空串 = 默认 + 自动后备
        max_results: 最大结果条数（1-20，默认 5；越界会被夹紧到边界值）
        depth: 搜索深度："basic"（默认、快、省额度）或 "advanced"（更全面更贵）
        topic: 主题（可选）："general" / "news" / "finance"；空串 = 不指定
        time_range: 时间范围（可选）："day" / "week" / "month" / "year"；空串 = 不限
        include_content: 是否返回网页正文摘要（默认 false）
        include_answer: 是否附带一句话答案（默认 false，由提供商生成）

    Returns:
        纯文本（非 JSON），成功逐行输出：
          web_search provider=<provider> fallback=<yes|no> results=<n>
          1. <title> — <url>
             published: <published_date>
             content: <正文摘要单行，超 1200 字符截断>
          answer: <一句话答案，超 500 字符截断>
          note: <旁路说明，超 500 字符截断>
          meta: <k=v, k=v，超 300 字符截断>
        published / content / answer / note / meta 无值时不输出对应行。
        失败时只输出 "web_search failed: <原因>" 与 note 指引。搜索失败务必
        先调用 provider_status 查看两家状态与用量，确认恢复后再调用
        reset_cooldown 清除冷却记录。
    """
    try:
        result = router.search(
            query=query,
            provider=provider or None,
            max_results=max_results,
            depth=depth,
            topic=topic or None,
            time_range=time_range or None,
            include_content=include_content,
            include_answer=include_answer,
        )
    except (ValueError, SearchUnavailable, ProviderError) as exc:
        # ProviderError 家族（含 BadRequestError / QuotaExhaustedError 等）与
        # router 对外的 ValueError / SearchUnavailable 全部收口为纯文本错误行，
        # 保住 stdio 会话不被单次失败打断。
        return _error_text(str(exc))
    return _render_web_search(result)


@mcp.tool(structured_output=False)
def provider_status() -> str:
    """查询两家提供商（tavily/exa）的状态与用量。

    返回 router.status() 快照的纯文本视图：每家提供商的 state（ok / cooldown /
    disabled / unconfigured）与 reason、冷却到期时刻、tavily 额度用量
    quota(plan=..., used=...)、exa 本月花费 month_cost_usd 与预算
    monthly_budget_usd，以及当前 default_provider / fallback_enabled 配置。
    诊断 web_search 失败原因时先调本工具；确认提供商恢复后再调用
    reset_cooldown。

    Returns:
        纯文本（非 JSON）：
          provider_status default=<default_provider> fallback=<on|off>
          - <name> state=<state>[ reason=<reason>][ until=<cooldown_until>]
            [ quota(plan=<plan>, used=<used>)][ month_cost_usd=<x>]
            [ monthly_budget_usd=<x>]
        空字段省略；内部异常时输出 "provider_status failed: <原因>"。
    """
    try:
        return _render_status(router.status())
    except Exception as exc:  # 工具边界：任何内部异常都收口为错误行，不外泄到协议层
        return "provider_status failed: %s" % _plain(exc)


@mcp.tool(structured_output=False)
def reset_cooldown(provider: str = "") -> str:
    """手动清除提供商冷却 / 禁用记录（额度恢复或 key 修复后使用）。

    正常情况冷却到期会自愈，无需调用本工具；仅在提供商确认已恢复、
    不想等到月初自动重置（或 disabled 状态永不自动恢复）时手动清除。

    Args:
        provider: "tavily" / "exa" 只清对应一家；空串 = 清全部。

    Returns:
        纯文本（非 JSON）：
          reset_cooldown reset=<provider 或 all>
          - <name> state=<state>[ reason=<reason>][ until=<until>]
        非法 provider 时输出 "reset_cooldown failed: <原因>"。
    """
    try:
        return _render_reset(router.reset(provider or None))
    except ValueError as exc:
        return "reset_cooldown failed: %s" % _plain(exc)


if __name__ == "__main__":
    # stdio 为 FastMCP.run() 默认传输；由 MCP 客户端负责拉起与关闭
    mcp.run()
