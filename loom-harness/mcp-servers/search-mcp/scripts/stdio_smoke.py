#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""真实 MCP stdio 协议冒烟脚本（验收门 S6 + S3 的执行器）。

用 mcp 客户端 SDK 以 stdio 传输拉起本仓库根目录的 search_mcp.py 子进程，
按真实 MCP 协议依次验证：
  1) initialize 握手成功
  2) tools/list 工具名集合恰为 {web_search, provider_status, reset_cooldown}，
     且 web_search 的 inputSchema.properties.provider 存在（enum 含 tavily/exa，
     或描述中明确可选值；两者皆无时降级为警告但打印）
  3) web_search 默认路由（不带 provider 参数）：非 isError，文本首行为
     "web_search provider=... fallback=... results=..."；打印首条结果行（截断 80 字符）
  4) web_search 显式路由 provider="exa"（S3）：首行 provider=exa
  5) provider_status：纯文本，首行含 default= / fallback=，且含 tavily/exa 状态行
  6) reset_cooldown：纯文本，首行 "reset_cooldown reset=..."，其后每家有状态行

任何一步 FAIL 即打印诊断并 exit(1)；每步用 asyncio.wait_for 包 90s 超时护栏。

三个工具在 MCP 边界均声明 structured_output=False 并返回 str，CallToolResult
只有 TextContent；本脚本直接读取文本块断言，不再解析 JSON。
"""

import asyncio
import re
import sys
import time
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

# 脚本顶部常量：BASE = search-mcp 仓库根目录，stdio server 入口文件挂在其下
BASE = Path(__file__).resolve().parent.parent
SERVER_ENTRY = BASE / "search_mcp.py"

# 每步超时护栏（秒）
STEP_TIMEOUT_S = 90.0
# 工具名集合的精确期望
EXPECTED_TOOLS = {"web_search", "provider_status", "reset_cooldown"}
# provider 显式路由的可选值
PROVIDER_CHOICES = {"tavily", "exa"}

# 纯文本契约首行（多行模式，允许文本中间出现）
WEB_SEARCH_HEADER = re.compile(r"^web_search provider=(\S+) fallback=(yes|no) results=(\d+)$", re.MULTILINE)
PROVIDER_STATUS_HEADER = re.compile(r"^provider_status default=(\S+) fallback=(on|off)$", re.MULTILINE)
RESET_COOLDOWN_HEADER = re.compile(r"^reset_cooldown reset=(\S+)$", re.MULTILINE)


def log_pass(msg):
    print("[PASS] %s" % msg, flush=True)


def log_warn(msg):
    print("[WARN] %s" % msg, flush=True)


def log_fail(msg):
    print("[FAIL] %s" % msg, flush=True)
    sys.exit(1)


def clip(text, limit=80):
    """摘要打印用：超长字符串截断到 limit 字符。"""
    s = str(text)
    return s if len(s) <= limit else s[:limit] + "..."


def text_blob(res):
    """拼接 CallToolResult 中所有 TextContent（JSON 兜底解析与错误上下文共用）。"""
    parts = []
    for block in (res.content or []):
        t = getattr(block, "text", None)
        if t is not None:
            parts.append(t)
    return "".join(parts)


def text_payload(res, what):
    """读取工具返回的纯文本负载；没有文本内容时抛 AssertionError 转 FAIL。"""
    blob = text_blob(res)
    if not blob:
        raise AssertionError(
            "%s：返回无文本内容，原始 content=%r" % (what, res.content)
        )
    return blob


def assert_not_error(res, what):
    """断言工具返回非 isError，并把文本内容带进错误上下文方便排障。"""
    assert not getattr(res, "isError", False), (
        "%s 返回 isError，文本内容：%s" % (what, clip(text_blob(res), 300))
    )


# ---------------------------------------------------------------------------
# 各验证步骤：成功返回摘要字符串；断言失败抛 AssertionError
# ---------------------------------------------------------------------------

async def step_initialize(session):
    """步骤 1：initialize 握手。"""
    res = await session.initialize()
    assert getattr(res, "protocolVersion", None), "initialize 响应缺少 protocolVersion"
    info = getattr(res, "serverInfo", None)
    return "server=%s version=%s protocol=%s" % (
        getattr(info, "name", "?"),
        getattr(info, "version", "?"),
        res.protocolVersion,
    )


async def step_tools_list(session):
    """步骤 2：tools/list 工具集合与 web_search 的 provider 路由参数（S3 前置）。"""
    res = await session.list_tools()
    names = {t.name for t in (res.tools or [])}
    assert names == EXPECTED_TOOLS, "工具名集合不匹配：期望=%s 实际=%s" % (
        sorted(EXPECTED_TOOLS),
        sorted(names),
    )
    web_search = next(t for t in res.tools if t.name == "web_search")
    schema = web_search.inputSchema or {}
    props = schema.get("properties") or {}
    assert "provider" in props, (
        "web_search inputSchema.properties 缺少 provider（显式路由参数，S3 依赖）"
    )
    provider_schema = props.get("provider") or {}
    enum = provider_schema.get("enum")
    detail = "工具集合 %s 完全匹配" % sorted(names)
    if enum is not None:
        missing = PROVIDER_CHOICES - set(enum)
        assert not missing, "provider enum 缺少可选值：%s（enum=%r）" % (
            sorted(missing),
            enum,
        )
        detail += "，provider enum=%r" % (list(enum),)
    else:
        # 无 enum 时降级：只要描述里把 tavily/exa 作为可选值写清楚也算通过（打印即可）
        tokens = set(
            re.findall(r"[a-z]+", (provider_schema.get("description") or "").lower())
        )
        if PROVIDER_CHOICES <= tokens:
            detail += "，provider 无 enum 但描述已写明 tavily/exa 可选值"
        else:
            log_warn(
                "provider 无 enum，且描述未明确列出 tavily/exa 可选值，"
                "description=%r（按约定降级为警告，不判 FAIL）"
                % provider_schema.get("description")
            )
            detail += "（provider 可选值检查降级为警告，见上方 WARN）"
    return detail


async def step_search_default_route(session):
    """步骤 3：web_search 不带 provider，走默认路由，验证纯文本首行与结果行。"""
    res = await session.call_tool(
        "web_search", {"query": "OpenAI 最新动态", "max_results": 2}
    )
    assert_not_error(res, "web_search 默认路由")
    text = text_payload(res, "web_search 默认路由")
    assert "{" not in text, "返回文本疑似 JSON：%s" % clip(text, 300)
    lines = text.splitlines()
    assert lines and lines[0].startswith("web_search provider="), (
        "首行不符合纯文本契约：%r" % (lines[0] if lines else "")
    )
    header = WEB_SEARCH_HEADER.search(text)
    assert header is not None, "web_search 首行缺少 provider=/fallback=/results=：%r" % (
        lines[0] if lines else ""
    )
    provider_used, fallback, count = header.groups()
    summary = "provider=%s fallback=%s 结果条数=%s" % (provider_used, fallback, count)
    if int(count) > 0 and len(lines) > 1:
        summary += " | 首条=%s" % clip(lines[1])
    else:
        log_warn("results=0：协议层合规，但真实 key/网络下应有内容，请核查")
    return summary


async def step_search_explicit_exa(session):
    """步骤 4：显式 provider="exa"，验证 S3 路由不被默认策略吞掉。"""
    res = await session.call_tool(
        "web_search", {"query": "test", "max_results": 1, "provider": "exa"}
    )
    assert_not_error(res, "web_search 显式 exa 路由")
    text = text_payload(res, "web_search 显式 exa 路由")
    assert "{" not in text, "返回文本疑似 JSON：%s" % clip(text, 300)
    header = WEB_SEARCH_HEADER.search(text)
    assert header is not None, "web_search 首行缺少 provider=/fallback=/results=：%r" % (
        clip(text.splitlines()[0] if text.splitlines() else "", 300),
    )
    used, fallback, _ = header.groups()
    assert used == "exa", (
        "S3 显式路由失效：请求 provider=exa，实际首行 provider=%s（fallback=%s）"
        % (used, fallback)
    )
    return "provider=%s fallback=%s" % (used, fallback)


async def step_provider_status(session):
    """步骤 5：provider_status 纯文本首行 + tavily/exa 状态行齐全。"""
    res = await session.call_tool("provider_status", {})
    assert_not_error(res, "provider_status")
    text = text_payload(res, "provider_status")
    assert "{" not in text, "返回文本疑似 JSON：%s" % clip(text, 300)
    lines = text.splitlines()
    assert lines and lines[0].startswith("provider_status default="), (
        "首行不符合纯文本契约：%r" % (lines[0] if lines else "")
    )
    assert " fallback=" in lines[0], "provider_status 首行缺少 fallback=：%r" % lines[0]
    header = PROVIDER_STATUS_HEADER.search(text)
    assert header is not None, "provider_status 首行格式不符：%r" % lines[0]
    for name in ("tavily", "exa"):
        assert any(line.startswith("- %s state=" % name) for line in lines), (
            "provider_status 缺少 %s 状态行" % name
        )
    tavily_line = next(line for line in lines if line.startswith("- tavily state="))
    return "首行=%s | %s" % (clip(lines[0]), clip(tavily_line))


async def step_reset_cooldown(session):
    """步骤 6：reset_cooldown 纯文本首行与提供商标记行。"""
    res = await session.call_tool("reset_cooldown", {})
    assert_not_error(res, "reset_cooldown")
    text = text_payload(res, "reset_cooldown")
    assert "{" not in text, "返回文本疑似 JSON：%s" % clip(text, 300)
    lines = text.splitlines()
    assert lines and lines[0].startswith("reset_cooldown reset="), (
        "首行不符合纯文本契约：%r" % (lines[0] if lines else "")
    )
    header = RESET_COOLDOWN_HEADER.search(text)
    assert header is not None, "reset_cooldown 首行格式不符：%r" % lines[0]
    assert any(line.startswith("- ") and " state=" in line for line in lines[1:]), (
        "reset_cooldown 缺少提供商状态行"
    )
    return "首行=%s 提供商行数=%d" % (clip(lines[0]), len(lines) - 1)


STEPS = (
    ("步骤1 initialize 握手", step_initialize),
    ("步骤2 tools/list 工具集合与 provider 参数", step_tools_list),
    ("步骤3 web_search 默认路由（不带 provider）", step_search_default_route),
    ("步骤4 web_search 显式 provider=exa（S3）", step_search_explicit_exa),
    ("步骤5 provider_status 双 provider 状态", step_provider_status),
    ("步骤6 reset_cooldown 纯文本契约", step_reset_cooldown),
)


async def main():
    if not SERVER_ENTRY.exists():
        log_fail(
            "找不到 stdio server 入口文件：%s（search_mcp.py 由集成波次创建，就位后再跑本脚本）"
            % SERVER_ENTRY
        )
    server_params = StdioServerParameters(
        command=sys.executable,
        args=[str(SERVER_ENTRY)],
        cwd=str(BASE),
    )
    async with stdio_client(server_params) as (read_stream, write_stream):
        async with ClientSession(read_stream, write_stream) as session:
            for label, step in STEPS:
                started = time.perf_counter()
                try:
                    summary = await asyncio.wait_for(
                        step(session), timeout=STEP_TIMEOUT_S
                    )
                except TimeoutError:  # 3.11+ 起即 asyncio.TimeoutError
                    log_fail(
                        "%s：超过 %d 秒超时护栏（耗时 %.1fs）"
                        % (label, int(STEP_TIMEOUT_S), time.perf_counter() - started)
                    )
                except SystemExit:
                    raise
                except AssertionError as exc:
                    log_fail(
                        "%s：%s（耗时 %.2fs）" % (label, exc, time.perf_counter() - started)
                    )
                except Exception as exc:
                    log_fail(
                        "%s：抛出 %s：%s（耗时 %.2fs）"
                        % (label, type(exc).__name__, exc, time.perf_counter() - started)
                    )
                log_pass(
                    "%s（耗时 %.2fs）：%s"
                    % (label, time.perf_counter() - started, summary)
                )
    log_pass("全部步骤通过：S6（stdio 协议）+ S3（provider 路由）验证达标")


if __name__ == "__main__":
    asyncio.run(main())
