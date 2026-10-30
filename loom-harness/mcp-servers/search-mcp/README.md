# search-mcp —— 聚合网络搜索 MCP server（axeuh-harness 副本）

通过 stdio 运行的 MCP server（FastMCP，`search_mcp.py` 为唯一入口），把聚合搜索
内核暴露给 MCP 客户端（axeuh-harness 等）。双提供商：**Tavily（默认）+ Exa（后备）**，
单入口 `web_search`，额度耗尽自动切换，全程无需调用方干预。

本副本源自 `server/search-mcp/`，唯一行为差异：配置改为**启动宽容**——未配置
API key 时服务照常启动、工具照常可见，调用 `web_search` 才返回含配置指引的
`web_search failed: ...` 纯文本（原版的启动期 SystemExit 会让 harness 静默降级、
工具整体消失）。**使用前必须自行配置 key**，见下文"安装后必做"。

三个工具的输出都是**紧凑纯文本**（不是 JSON）：MCP 客户端把文本块原样交给模型，
FastMCP 不再附结构化 JSON 包装。

## 安装后必做

副本仓库内**不含 config.json**（含真实 key 的配置绝不入库），二选一完成配置：

1. 复制模板并填入自己的 key：

   ```bash
   cp config.example.json config.json
   # 编辑 config.json，把 providers.tavily.api_key / providers.exa.api_key
   # 填成真实 key（用哪家装哪家，另一家留空串即可）
   ```

2. 或用环境变量注入（无需文件）：`SEARCH_MCP_TAVILY_KEY` / `SEARCH_MCP_EXA_KEY`
   注入 key，`SEARCH_MCP_DEFAULT_PROVIDER` 指定默认家。

未配置时：`search_mcp.py` 可正常 import 并以 stdio 启动（stderr 打一行中文警告），
三个工具均可 list；调用 `web_search` 返回 `web_search failed: ...` 首行说明
"未配置 API key（config providers.<name>.api_key 为空）"，其后的 `note` 行指引
先用 `provider_status` 查看状态——配置后无需其他操作即可恢复。

## axeuh-harness 集成

在**生效实例**的 `config.yaml`（`LOOM_INSTANCE` 环境变量指向的实例，不是仓库
根的 `loom.yaml`/`loom.example.yaml`，除非那正是你的生效实例）的 `mcp.servers`
下追加条目，改后**重启 harness 服务**生效（boot 时连接，运行中不热加载）：

```yaml
mcp:
  servers:
    - name: search
      cmd: /opt/venvs/search-mcp/bin/python
      args:
        - /opt/kinship/loom-harness/mcp-servers/search-mcp/search_mcp.py
      cwd: /opt/kinship/loom-harness/mcp-servers/search-mcp
      requestTimeoutMs: 60000
```

字段口径（harness MCP client 以 node:child_process spawn）：

- 可执行文件字段是 **`cmd`（单个字符串）+ `args`（数组）**，不是 `command` 数组；
  `cwd` 可选，建议指向本目录。
- `name` 必须匹配 `^[a-z][a-z0-9_-]{0,31}$`（本条目用 `search`）。
- `requestTimeoutMs` 建议 **60000**：内核单次搜索的 `request_deadline_s=55s`
  加上 429 退避 / 瞬时故障 1s+2s 重试的最坏情况贴着 55s 上限，客户端请求超时必须
  大于它，否则 harness 先于内核放弃、拿不到终态错误文本。下限 1000。
- API key 也可走 `env:` 字段注入（值只进子进程环境，`/config` 只回显键名），
  等价于本目录外的 config.json。

工具映射：每个工具映射为 `mcp_<name>_<tool>`，即
`mcp_search_web_search` / `mcp_search_provider_status` / `mcp_search_reset_cooldown`。
spawn / 握手失败 = 响亮 warn + 该 server 工具面缺席（降级，绝不 crash boot）。

## 自动切换机制

router（`router.py`）按错误语义降级，冷却状态由 `cooldown.py` 持久化：

| 上游信号 | 归类 | 处置 |
| --- | --- | --- |
| Tavily 432/433（含 403 额度语境）、Exa 402 | 额度耗尽 | 该家进入 cooldown，**冷却至下月 1 日 00:00（东八区）+ 9 小时缓冲**（避开提供商按 UTC 月初重置的计数竞态），请求自动切换另一家 |
| 429 | 限流（不等于额度耗尽，绝不冷却） | Tavily 读 Retry-After 在预算内容忍原地重试至多 1 次；Exa 按官方策略不重试，直接切换另一家 |
| 5xx / 超时 / 网络层异常 | 瞬时故障 | 1s、2s 指数退避原地重试至多 2 次（每步先查 55s deadline 剩余预算，不足即停），仍失败则切换，绝不冷却 |
| 401/403（key 失效语境） | key 无效 | 该家置 disabled，**永不自动恢复**，只能 `reset_cooldown` 人工解除 |
| 400/422 | 请求参数 bug | 原样上报（切另一家毫无意义），体现在 `web_search failed:` 首行 |

切换发生时首行为 `fallback=yes`；被跳过/失败的家会汇总进 `note` 行。

**Exa 本地预算记账**：Exa 无公开用量端点，每次成功响应的 `costDollars.total`
由 CooldownStore 按月累计，触顶（默认 **$10/月**，可用
`providers.exa.monthly_budget_usd` 调整）后 Exa 被自动跳过、走 Tavily，账本月初自愈。

两家额度均按每月 1 日重置；查询用量看 `provider_status`。

## 工具

### web_search

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| query | str | （必填） | 搜索关键词，中英文均可，不能为空 |
| provider | str | "" | "tavily" / "exa" 显式指定；空串 = 默认提供商 + 自动后备 |
| max_results | int | 5 | 1-20，越界夹紧到边界值 |
| depth | str | "basic" | "basic" / "advanced"（advanced 更全但更耗额度） |
| topic | str | "" | "general" / "news" / "finance"；空串 = 不指定 |
| time_range | str | "" | "day" / "week" / "month" / "year"；空串 = 不限 |
| include_content | bool | false | 是否返回网页正文摘要 |
| include_answer | bool | false | 是否附带提供商生成的一句话答案 |

成功返回纯文本（每条结果最多三行，空字段整行省略，不输出 score）：

```text
web_search provider=exa fallback=yes results=2
1. 标题一 — https://example.com/1
   published: 2026-10-01
   content: 正文摘要单行（超过 1200 字符截断）
2. 标题二 — https://example.com/2
answer: 一句话答案（超过 500 字符截断）
note: 旁路说明，例如被跳过的提供商（超过 500 字符截断）
meta: skipped_providers=[provider=exa, state=cooldown], count=1
```

`provider` 是实际出手的提供商，`fallback` 为 `yes|no`，`results` 为条数
（无结果时 `results=0`）。失败时只返回两行，**永不向协议层抛异常**（保住
stdio 会话）：

```text
web_search failed: 所有可用提供商均无法完成本次搜索：...
note: 可调用 provider_status 查看两家提供商的实时状态与用量；确认恢复后调用 reset_cooldown 清除冷却记录。
```

搜索失败时应先调用 `provider_status`，确认提供商恢复后再调用 `reset_cooldown`。

### provider_status

无参数。返回纯文本：首行为默认路由，其后每家提供商一行，依次给出 state
（ok / cooldown / disabled / unconfigured）、原因、冷却到期时刻、Tavily 额度
`quota(plan=..., used=...)`、Exa 本月花费与预算；空字段省略。

```text
provider_status default=tavily fallback=on
- tavily state=ok quota(plan=dev, used=12)
- exa state=cooldown reason=quota_exhausted until=2026-11-01T09:00:00+08:00 month_cost_usd=0.0 monthly_budget_usd=10.0
```

内部异常时返回 `provider_status failed: <原因>`。诊断 web_search 失败第一步。

### reset_cooldown

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| provider | str | "" | "tavily" / "exa" 只清一家；空串 = 清全部 |

手动清除冷却/禁用记录。冷却到期本会自愈，仅在提供商确认已恢复（额度重置、
key 修复）而不想等待、或解除 disabled 时调用。

```text
reset_cooldown reset=tavily
- tavily state=ok
```

非法 provider 时返回 `reset_cooldown failed: <原因>`。

## 配置

`config.json`（模块同目录；可用环境变量 `SEARCH_MCP_CONFIG` 指定其他路径），
字段与模板 `config.example.json` 同构：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| default_provider | "tavily" | 默认路由："tavily" / "exa"；非法值警告后回落 "tavily" |
| fallback_enabled | true | 默认家不可用时是否自动切换另一家 |
| request_deadline_s | 55 | 单次 web_search 的总预算（秒），退避/重试都在这笔预算内 |
| providers.tavily.api_key | ""（=不注册该家） | Tavily key |
| providers.exa.api_key | ""（=不注册该家） | Exa key |
| providers.exa.monthly_budget_usd | 10.0 | Exa 本地月度预算上限 |

环境变量覆盖（优先于文件值）：`SEARCH_MCP_TAVILY_KEY`、`SEARCH_MCP_EXA_KEY`、
`SEARCH_MCP_DEFAULT_PROVIDER`、`SEARCH_MCP_CONFIG`。

**启动宽容原则**（与原版差异）：配置文件缺失 / JSON 非法 / 未配任何 key /
default_provider 非法 → 不再 SystemExit，向 stderr 打中文警告后按默认值继续，
调用期由路由层返回配置指引错误文本。损坏的配置不该杀死服务。

## 安全提示

真实 API key 只应存在于本地 `config.json`（已被本目录 `.gitignore` 排除）或
环境变量注入；仓库内只有空 key 模板 `config.example.json`。key 一旦意外入库
立即到提供商后台轮换。

## 本地测试

```bash
cd /opt/kinship/loom-harness/mcp-servers/search-mcp

# 离线全量测试（不联网；无 config.json 也能全绿——启动宽容）
/opt/venvs/search-mcp/bin/python -m pytest tests -q

# 真实 key 联网冒烟（需先按"安装后必做"配置，会产生真实计费请求）
SEARCH_MCP_LIVE=1 /opt/venvs/search-mcp/bin/python -m pytest tests/test_live_smoke.py -v -s

# MCP stdio 协议握手冒烟（拉起本目录 search_mcp.py 子进程走真实协议；
# 脚本按 __file__ 相对定位，复制后自动指向副本）
/opt/venvs/search-mcp/bin/python scripts/stdio_smoke.py
```

## state/ 目录

`state/cooldown.json` 是冷却 / disabled / Exa 预算账本 / Tavily 用量缓存的持久化
位置（原子写，进程重启状态不丢，.gitignore 已排除）。**勿手工删除或编辑**；
需要清状态请用 `reset_cooldown` 工具。文件损坏时会自动重建为空状态并告警，
不构成故障。
