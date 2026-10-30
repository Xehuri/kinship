#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""真实网络 key 验证冒烟（验收门 S1/S2 的执行器）。

默认跳过：仅当环境变量 SEARCH_MCP_LIVE=1（或任意非空值）时才执行，
避免无 key / CI 环境误跑真实计费请求。

约定：
- 所有被测模块（config、providers.tavily、providers.exa、NormalizedParams）
  一律在测试函数体内 lazy import——providers/ 下模块此刻尚未生成，
  顶层 import 会直接破坏 pytest 收集；集成波次执行时它们已就位。
- NormalizedParams 的归属模块以 providers/base.py 为首选，其余为兼容候选，
  集成波次若另行安放，请按 _NORMALIZED_PARAMS_SOURCES 顺序维护。

运行方式（本任务不运行，留待集成波次）：
  cd search-mcp && SEARCH_MCP_LIVE=1 /opt/venvs/search-mcp/bin/python -m pytest tests/test_live_smoke.py -v -s
"""

import importlib
import os
import sys
import time

import pytest

pytestmark = pytest.mark.skipif(
    not os.environ.get("SEARCH_MCP_LIVE"),
    reason="需真实 key 的联网冒烟，设 SEARCH_MCP_LIVE=1 才跑",
)

# 保证从 tests/ 目录也能 import 到 search-mcp 根下的 config 等顶层模块
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

# NormalizedParams 候选归属模块（按序探测，命中即止）
_NORMALIZED_PARAMS_SOURCES = (
    "providers.base",
    "providers",
    "normalizer",
    "schemas",
    "search_mcp",
)


def _get(obj, attr):
    """dict 与对象两种形态的统一字段读取。"""
    if isinstance(obj, dict):
        return obj.get(attr)
    return getattr(obj, attr, None)


def _load_config():
    """lazy import 根级 config.py 并调用 load_config()。"""
    import config

    return config.load_config()


def _api_key(cfg, name):
    """从配置提取指定 provider 的 api_key。

    兼容 {name: {api_key: ...}} 与 {name_api_key: ...} 两种常见形态；
    找不到时报错并列出实际顶层键，方便集成波次对照修正。
    """
    block = _get(cfg, name)
    if isinstance(block, str) and block:
        # 容错形态：provider 块直接就是 key 字符串
        return block
    key = _get(block, "api_key") if block is not None else None
    if not key:
        # T2 契约形态：Config 字段为 tavily_key / exa_key
        key = _get(cfg, "%s_key" % name)
    if not key:
        key = _get(cfg, "%s_api_key" % name)
    if not key:
        raise AssertionError(
            "config 中未找到 %s 的 api_key，实际顶层键=%r（key 值本身不打印）"
            % (name, sorted(cfg.keys()) if isinstance(cfg, dict) else type(cfg).__name__)
        )
    return str(key)


def _normalized_params_cls():
    """在候选模块中定位 NormalizedParams 类（pydantic/dataclass 均可，按关键字构造）。"""
    errors = []
    for modname in _NORMALIZED_PARAMS_SOURCES:
        try:
            mod = importlib.import_module(modname)
        except Exception as exc:  # 模块尚不存在/导入有副作用时继续找下一个
            errors.append("%s: %s" % (modname, exc))
            continue
        cls = getattr(mod, "NormalizedParams", None)
        if cls is not None:
            return cls
    raise AssertionError(
        "未找到 NormalizedParams 类，已尝试模块及错误：%s" % errors
    )


def _http_detail(exc):
    """把异常的 HTTP 层细节（httpx.HTTPStatusError 等携带的 response）拼进报错信息。"""
    msg = "%s: %s" % (type(exc).__name__, exc)
    response = getattr(exc, "response", None)
    if response is not None:
        try:
            status = getattr(response, "status_code", "?")
            body = getattr(response, "text", "")
            msg += " | HTTP status=%s 响应体前300字符=%s" % (status, str(body)[:300])
        except Exception:  # 读响应体本身失败时不影响主报错
            pass
    return msg


def test_live_tavily():
    """S1：真实 Tavily key 直连验证——结果非空、归一化字段齐、score 类型诚实。"""
    cfg = _load_config()
    api_key = _api_key(cfg, "tavily")

    from providers.tavily import TavilyProvider

    params_cls = _normalized_params_cls()
    provider = TavilyProvider(api_key, timeout_s=30)
    params = params_cls(query="什么是 MCP 模型上下文协议", max_results=2)

    try:
        resp = provider.search(params, deadline_mono=time.monotonic() + 50)
    except Exception as exc:
        pytest.fail("Tavily 实时搜索调用失败（含 HTTP 层 detail）：%s" % _http_detail(exc))

    results = _get(resp, "results")
    assert results, "Tavily 返回 results 为空，resp=%r" % (resp,)
    for i, r in enumerate(results):
        for field in ("title", "url", "content"):
            assert _get(r, field) is not None, "第%d条结果缺 %s：%r" % (i, field, r)
        score = _get(r, "score")
        assert score is None or isinstance(score, float), (
            "第%d条结果 score 必须为 float 或 None，实际类型=%s 值=%r"
            % (i, type(score).__name__, score)
        )
    print("[live][tavily] 首条 title：%s" % _get(results[0], "title"))


def test_live_exa():
    """S2：真实 Exa key 直连验证——/search 无分数字段，score 必须恒为 None（不许造假）。"""
    cfg = _load_config()
    api_key = _api_key(cfg, "exa")

    from providers.exa import ExaProvider

    params_cls = _normalized_params_cls()
    provider = ExaProvider(api_key, timeout_s=30)
    params = params_cls(query="什么是 MCP 模型上下文协议", max_results=2)

    try:
        resp = provider.search(params, deadline_mono=time.monotonic() + 50)
    except Exception as exc:
        pytest.fail("Exa 实时搜索调用失败（含 HTTP 层 detail）：%s" % _http_detail(exc))

    results = _get(resp, "results")
    assert results, "Exa 返回 results 为空，resp=%r" % (resp,)
    for i, r in enumerate(results):
        assert _get(r, "title") is not None, "第%d条结果缺 title：%r" % (i, r)
        assert _get(r, "url") is not None, "第%d条结果缺 url：%r" % (i, r)
        score = _get(r, "score")
        assert score is None, (
            "Exa /search 响应并无分数字段，归一化层不许造假："
            "第%d条结果 score 应为 None，实际=%r" % (i, score)
        )
    cost_usd = _get(resp, "cost_usd")
    if cost_usd is not None:
        assert cost_usd >= 0, "cost_usd 应为非负数，实际=%r" % (cost_usd,)
    print(
        "[live][exa] 首条 title：%s（cost_usd=%r）"
        % (_get(results[0], "title"), cost_usd)
    )
