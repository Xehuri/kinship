# harness-plugins

Kinship 的 dsh 侧集成。四个独立插件包加一个 preset patch，全部是普通 Cordis
插件，不改 dsh 主循环，不写 `backend/`、`frontend/`、`kinship-data/` 或生产
`dsh-home`。

> Loom 仍是 Kinship 的默认完整工作流。本目录是可选的外部 harness 适配示例，
> dsh 是其中的参考实现，不是唯一路径，也不是开箱即用的功能。若你已经有自己的
> harness，可以按 [`docs/dev/adapter-contract.md`](../docs/dev/adapter-contract.md)
> 接入；接入需要开发和部署能力。

## 结构

```
harness-plugins/
  package.json              # workspace + dsh.bundle.patch
  cordis.patch.yml          # host 行: kinship-bridge + kinship-ui
  presets/kinship.patch.yml # agent preset: kinship, order 5
  locale/, icon.svg, docs/  # bundle 在 dsh 插件页的标题、描述、图标与详情文档
  packages/
    kinship-bridge/         # 本机 HTTP API + 单 Session 绑定 + 面板 JSON API
    kinship-ui/             # Web 侧栏 Kinship 面板（浏览器模块 + 无 host 行为）
    kinship-plan/           # daily plan JSON/md/ledger + CAS
    kinship-task-compat/    # task / todowrite / MCP aliases
  tests/
    unit/
    integration/
```

`@deepseek-ai/*` 是 peer dependency；`@deepseek-ai/schemastery` 是运行时依赖。
目标 dsh 是安装机上的 `0.2.2-rc.3`（任务描述写的是 `0.2.2-rc.1`，peer 范围
`>=0.2.2-rc.1 <0.2.3` 同时覆盖两者）。

## 安装与验证

本机 dsh 安装在 `/mnt/d/tools/node-v24.22.3-linux-x64`，Node 必须用 24：

```bash
export PATH=/mnt/d/tools/node-v24.22.3-linux-x64/bin:$PATH
cd harness-plugins
npm install
npm run link:dsh   # 把安装机的 @deepseek-ai/* 链到本 workspace node_modules
npm run verify     # typecheck + build + 78 tests
```

`link:dsh` 默认读取
`/mnt/d/tools/node-v24.22.3-linux-x64/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`，
可用 `DSH_PACKAGES_DIR` 覆盖。它只写本 workspace 的 `node_modules`，不碰任何
DSH_HOME。

集成测试会创建临时 `DSH_HOME`，复制四个包和 bundle patch，运行
`dsh --profile kinship-test --dump-config`；测试结束删除临时目录。生产
`dsh-home`、systemd、正在运行的 dsh 都不会被访问。

## kinship-bridge

Host 级插件，own `http.createServer`，默认 `127.0.0.1:18765`。只允许
`127.0.0.1` 或 `::1`，拒绝其他 bind 地址。

### 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `host` | `127.0.0.1` | 只允许 loopback |
| `port` | `18765` | `0` 表示临时端口 |
| `tokenEnv` | `KINSHIP_BRIDGE_TOKEN` | bearer token 环境变量 |
| `tokenFile` | 空 | 绝对路径 secret file，优先于 env |
| `policy` | `first` | `first` 或 `manual` |
| `sessionId` | 空 | manual 启动时可选绑定目标 |
| `rebindOnMissing` | `false` | `first` 下绑定的 Session 消失后是否重绑 |
| `bodyLimitBytes` | `65536` | JSON body 上限 |

Token 解析顺序：`tokenFile` -> `tokenEnv` -> `$DSH_HOME/kinship/bridge-token`
（不存在则生成 32 字节 hex，文件 0600）。日志只打印 token 文件路径，不打印
token 或请求体。

后端需要拿到同一个 token：把自动生成的 token 文件路径配置到后端的
`dsh.token_file`，或给 bridge 与后端设置同一个 `KINSHIP_BRIDGE_TOKEN`。
否则后端请求会收到 401。

### 绑定

- `first`：所有 live root Session 中 `preset === "kinship"` 且 `createdAt` 最早
  的一个。
- `manual`：不自动选；通过 `POST /v1/session/bind` 切换。
- root 定义：`header.parentSession === undefined && header.origin !== "subagent"`。
- 绑定持久化到 `$DSH_HOME/kinship/binding.json`，同目录 temp + fsync + rename。
- 同一时刻最多一个绑定；`POST /v1/session/bind` 原子切换：先写文件，成功后再
  改内存；写失败返回 500 且保留旧绑定。
- 绑定的 Session 消失时状态变成 `bound_session_missing`；默认不自动换绑。

### HTTP API

除 `GET /v1/session/events` 的 SSE 外所有响应都是 JSON。全部 `/v1/*` 都要求
`Authorization: Bearer <token>`。

| 方法 | 路径 | 请求 | 成功响应 |
|---|---|---|---|
| GET | `/v1/health` | - | `{ok, version, dsh, session_id, preset, status}` |
| GET | `/v1/session` | - | `{session_id, preset:"kinship", status:"bound", bound_at, policy}` |
| POST | `/v1/session/bind` | `{session_id}` | `{ok, session_id, preset, status, bound_at, policy}` |
| POST | `/v1/session/messages` | `{text, source?}` | 202 `{accepted, session_id, message_id}` |
| POST | `/v1/session/abort` | - | 202 `{ok, session_id, was_running}` |
| GET | `/v1/session/status` | - | `{session_id, status:"idle"|"running", running, last_turn_at}` |
| GET | `/v1/session/messages?limit=&before=` | - | `{session_id, messages, has_more, next_before}` |
| GET | `/v1/session/children` | - | `{session_id, children}` |
| GET | `/v1/session/events` | - | SSE（durable 事件 + live 助手流，见下） |
| GET | `/v1/models` | - | `{providers:[{id,name,models:[{id,name}]}]}`（harness 模型目录，空目录也返回 200） |
| GET | `/v1/session/context` | - | `{session_id, provider, model, contextWindow, usedTokens, projectedTokens}`（未知字段为 null） |
| POST | `/v1/session/compact` | 空 body | 202 `{accepted, session_id, status:"compacting"}`；409 `compaction_busy`；500 `compaction_unavailable` |
| GET | `/v1/session/compaction` | - | `{session_id, status:"none"\|"active", covered_count, summary_text, anchor_message_id, anchor_timestamp_ms}` |
| POST | `/v1/inbox` | `{class, text, thread_id?}` | 202 `{accepted, id, class, target, session_id}` |

`POST /v1/session/messages` 等价于
`agent.send(createUserMessage(...), "next-turn", true)`。
`POST /v1/inbox` 只做队列/投递，不实现 `send_letter` / letter 语义
（`letter_dispatch=false`）。`class=interrupt` 且 agent 正在 running 时投递到
`next-step`，否则 `next-turn`。

错误码：

- 401 `unauthorized`
- 404 `not_found` / `session_not_found`
- 405 `method_not_allowed`
- 409 `no_kinship_session` / `bound_session_missing` / `not_root_session` / `not_kinship_session`
- 413 `body_too_large`
- 422 `invalid_body` / `missing_text` / `missing_class` / `invalid_class` / `invalid_thread_id` 等
- 500 `binding_write_failed` / `children_failed` / `internal`
- 503 `subagents_unavailable`
- 504 `children_timeout`
- 409 `compaction_busy`（会话 running 时请求手动压缩）
- 500 `compaction_unavailable`（宿主组合里没有 `/compact` 命令）

### `GET /v1/session/messages` 形状

Best effort，从 dsh Session event log 投影；不是 dsh 的 durable 真源。按 `seq`
升序返回最近 `limit` 条（默认 50，最大 200）。`before` 是 exclusive seq 上界。

投影同时接受 dsh 0.2.2-rc.3 的真实形状（`assistant/message` 与 `tool/result` 把消息
包在 `data.message` 下）和旧的扁平形状；`tool/result` 的 `tool_call_id` 先读
`message.toolCallId`，再回落 `message.source.callId`。

```json
{
  "session_id": "session-...",
  "messages": [
    {
      "id": "msg-...",
      "role": "user",
      "content": [{"type": "text", "text": "hello"}],
      "text": "hello",
      "created_at": 1790000000000,
      "seq": 12,
      "source": {"kind": "kinship:bridge", "source": "qq"}
    },
    {
      "id": "msg-...",
      "role": "tool",
      "content": [{"type": "text", "text": "ok"}],
      "text": "ok",
      "created_at": 1790000000001,
      "seq": 13,
      "tool_call_id": "call-...",
      "is_error": false
    }
  ],
  "has_more": true,
  "next_before": 12
}
```

只投影 `user/message`、`assistant/message`、`tool/result`；边界事件和 system /
developer 消息不返回。

### `GET /v1/session/events` SSE

连接后先收到 `retry: 3000` 和 `: connected` 注释。之后每个 dsh Session event
一帧：

```
data: {"seq":12,"payload":{"type":"user/message","properties":{...}}}

```

`properties` 就是 `SessionEvent.data`。绑定变化时服务端写
`: binding-changed` 并关闭连接；客户端重连后应重新 `GET /v1/session`。SSE 只发
连接之后的 live 事件；历史用 `/v1/session/messages`。

### 实时助手流（`kinship/assistant-stream`）

同一条 `/v1/session/events` 流里还会出现一类额外事件（契约允许客户端忽略未知类型）：

```
data: {"seq":12.001,"payload":{"type":"kinship/assistant-stream",
  "properties":{"session_id":"session-...","frame":{
    "type":"chunk","attemptId":"...","revision":1,"turn":1,"step":1,
    "chunk":{"type":"text-delta","index":0,"text":"..."}}}}}
```

- 来源是 dsh 进程内的 `agent/assistant-stream` 事件（逐 attempt 的 start/chunk/end），
  **不写入 durable 日志**，只服务实时渲染；历史仍来自 `/v1/session/messages`。
- `frame` 原样携带 dsh 的 `AssistantStreamFrame`；`start` 自带 `turn`/`step`，
  其余帧由插件按 attempt 记住后补上，保证线上形状统一。
- `seq` 是**小数**：`最近 durable seq + n/(n+1000)`，单调递增且严格落在两条 durable
  事件之间。客户端若只用它排序/去重可直接使用；不要把它当分页游标。
- 没有 live 流的宿主可不实现 `subscribeLive`，服务端就只转发 durable 事件。

## 手动压缩

`POST /v1/session/compact` 通过宿主注册的 `/compact` 命令（`kinship` preset 里的
`command-compact`）异步触发一次手动压缩：会话必须 **idle**，否则 409
`compaction_busy`；宿主组合里没有该命令时 500 `compaction_unavailable`。受理后立即
返回 202，压缩本身通过 `compaction/*` 事件在 SSE 里体现。

`GET /v1/session/compaction` 从 durable 日志推导最近一次压缩（`compaction/summary`
的 `shadowedSeqs` 数量与摘要文本、紧随其后的替换 `user/message` 作为锚点），
无压缩时 `status:"none"`。

## kinship-ui（Web 面板）

`kinship-ui` 是 dsh Web 左侧栏里的 **Kinship** 面板：桥接状态、Bearer token、桥接
配置、可绑定会话，以及要写进 Kinship 侧 `config.yaml` 的片段都在这一页。

它只负责 UI：Host 半边是空插件（只为让 Client 模块图有一个独立行），所有数据来自
`kinship-bridge` 挂在 dsh Connection 认证通道上的 `/api/kinship/ui/*`。之所以和
bridge 分成两行，是因为保存配置会重载 bridge 行，而面板必须活过这次重载。

| 方法 | 路径 | 请求 | 成功响应 |
|---|---|---|---|
| GET | `/api/kinship/ui/state` | - | `{ok, bridge, binding, session, token, config, editable, sessions}` |
| POST | `/api/kinship/ui/config` | `{config:{...}}`（可只带改动字段） | `{ok, config, restarted:true}` |
| POST | `/api/kinship/ui/token` | `{action:"reveal"\|"rotate"}` | `{ok, token, token_info}` |
| POST | `/api/kinship/ui/bind` | `{sessionId}` | `{ok, binding}` |

这些路由属于 dsh Connection 的 exact Fetch 通道：浏览器已由 dsh 完成 Host/Origin
校验与登录态校验，非 owner principal 直接 403，未登录 401。它们**不接受** bridge 的
Bearer token，Kinship 后端也不调用它们。

行为：

- 保存配置走 `configEditor.edit()`，写入当前 profile 的插件配置并立刻重载 bridge 行；
  面板本身不消失（独立行），重载后自动刷新状态。
- 写入是**完整配置覆盖**：bundle patch 里由环境变量驱动的字段会被固定为保存时的值。
  这是 dsh 配置档案的正常语义，页面上有说明。
- `token.action="reveal"` 才把 token 值返回给页面；`rotate` 生成新 32 字节 hex 写回
  同一文件（0600）并立即对运行中的 bridge 生效。环境变量来源的 token 不能轮换，会
  返回 409 `token_env_managed`。
- `bind` 等价于 `POST /v1/session/bind`，只接受 live 的 root `kinship` 会话。
- 没有 `configEditor` 的部署（如纯 CLI 组合）页面只读，保存返回 409
  `config_read_only`；没有 Connection 的部署不会注册这些路由，页面显示"桥接未响应"。

## kinship-plan

简化日计划工具。真源只有 JSON；markdown 是派生视图；ledger 只追加。

### Root

解析顺序，绝不静默猜：

1. `config.root`
2. `KINSHIP_PLAN_ROOT`
3. `KINSHIP_AI_ROOT/data`（现有 Kinship plan data root）

三者都没有时插件激活失败。root 必须是绝对路径，并且目标路径会做
realpath 越界检查。

### 文件

```
{root}/daily/{date}/plan-{date}.json      真源
{root}/daily/{date}/计划-{date}.md        人读视图
{root}/daily/{date}/plan-ledger.jsonl     审计，只追加
```

JSON 先写（同目录 temp + fsync + rename），成功后写 md。md 写失败不回滚 JSON，
下一次写入会自愈。未知顶层字段和未知 item 字段读入后保存在 `extra`，每次写入
原样合并回去；现有 `coverage` 等 v1/v2 字段因此不会被丢掉，但本工具不解释、
不修改 coverage。

如果同一天存在 `plan-{date}.overlay.json` 而 truth JSON 不存在，默认拒绝写入
并抛 `plan_overlay_present`；设置 `allowOverlayShadow: true` 才允许在 overlay
旁创建 v1 truth 文件。`plan_read` 此时返回 `warning: "overlay_present"`。

### CAS

每个 mutation 都必须带 `expected_version`：

- `0` = 创建（仅 commit 合法）
- 其他值必须等于磁盘当前 `version`
- 不匹配抛 `plan_conflict`，文件不变
- `closed` 计划拒绝 commit/note/done；`close` 用当前 version 重试是幂等的

同进程内按 date 串行化；跨进程是"读 version 后比较再写"，不是文件锁。

### Tools

| 工具 | 作用 |
|---|---|
| `plan_read` | 读一天；缺失返回 `found:false`，不报错 |
| `plan_commit` | 创建或整表替换 items/notes；保留未知字段；不管理 coverage |
| `plan_note` | 追加一条 note，items 不变 |
| `plan_done` | 改一个 item 的 status（默认 done），可写 evidence/note；done 时写 `done_at` |
| `plan_close` | status=closed；未完成项转 carried；写 `carry_over`；写 ledger |
| `plan` | Loom 兼容别名：`read/commit/revise/diff/note/done/close`；revise/diff 是整表 commit |

`plan_close` 的 `carry_over` 形状：

```json
{
  "to": "2026-11-16",
  "created_at": 1790000000000,
  "items": [
    {"id": "care_a", "kind": "care", "intent": "...", "status": "carried", "...": "..."}
  ]
}
```

`plan-read` 返回的 `plan` 是文件形状（不是内部 `extra` 结构）。

## kinship-task-compat

### `task`

同时接受两种形状：

```
{agent_type | subagent_type, prompt, description?, ...}        # Loom
{category, load_skills, run_in_background, description, prompt, ...} # opencode
```

映射到 `ctx.subagents.startActivation({provider: "spawn", ...})`：

- `agent_type` -> 子 agent prompt 前缀
  `You are the "<agent_type>" subagent.\n\n<prompt>`
- `subagent_type` -> `agent_type` 的别名；现有 main.md/plan 指令里的
  `task(subagent_type="reviewer", ...)` 因此可直接使用
- `description` -> dsh activation label；缺失时用 `agent_type`/`category`/prompt 首行
- `category` -> label 兜底；不改变 prompt
- `load_skills` -> 接受但 dsh subagent 没有该参数，写入结果 `ignored_fields`
- `run_in_background` -> 接受但 dsh subagent 天然异步；写入 `ignored_fields`
- 其他未知字段 -> 写入 `ignored_fields`，不静默丢弃

dsh subagent 总是异步：工具立即返回 activation name，完成通知稍后到达。

### `todowrite`

注册为 `todo_write` 的精确别名（复用同一个 definition/execute），因此两个名字
写的是同一个 durable `todo/write` 事件。preset 子插件可能并发挂载，因此不要求
`@deepseek-ai/dsh-tool-todo` 必须先完成：目标尚未出现时先监听 `tools/change`，
出现后自动注册；同时用重入守卫避免 `ctx.tools.register` 同步发事件导致递归。
插件卸载时会同时退订并注销别名。

### MCP 命名

dsh 的 MCP 公开名是：

```
mcp__<serverName>__<rawName>
```

再按 `[A-Za-z0-9_-]` 归一化；若发生替换或超过 64 字符，追加 12 位 SHA-256
后缀。当前 prompt 里的 Loom 名字和默认 alias 映射：

| Loom prompt 名 | dsh 目标名（默认） | 备用 |
|---|---|---|
| `mcp_ai_mcp_tts_speak` | `mcp__ai_mcp__tts_speak` | `mcp__ai-mcp__tts_speak` |
| `mcp_ai_mcp_send_notification` | `mcp__ai_mcp__send_notification` | `mcp__ai-mcp__send_notification` |
| `mcp_search_web_search` | `mcp__search__web_search` | `mcp__search-mcp__web_search` |

目标定义可见时注册同 execute 的 alias；MCP 晚连接时 `tools/change` 会补注册。
目标不可见时只记录一次 info 日志，列出期望的 dsh 名字，不静默接受未知工具。
如果实际 MCP server 名导致 dsh 追加 hash 后缀，需要把
`kinship-task-compat.config.mcpAliases` 的 target 改成实际公开名。

## kinship preset

`presets/kinship.patch.yml` 插入：

- `id: kinship` / `name: Kinship` / `order: 5`
- persona 只从 `$KINSHIP_AI_ROOT/agents/main.md` 读 prefix，`complete: false`
- 不挂 `agent-instructions`，不改 AGENTS.md，不建全局 prompt
- 工具：bash/pwsh（按平台）、fs、fs-search、todo、ask-user、
  subagent/subagent_fork/subagent_control、compaction 组、`kinship-plan`、
  `kinship-task-compat`
- 不挂 `kinship-memory`、`kinship-context-watch`、`kinship-qq`

现有 shipped presets（standard=1、ptc=2、minimal=3、cordis=4）不变。

profile 使用方式：profile 的 `dsh.profile.bundles` 加
`kinship-harness-plugins`，并让三个包在 profile 的 `node_modules` 可解析。
`--dump-config` 会显示 host 的 `kinship-bridge` 行和 `preset-kinship` 行。
`--dump-config-schema` 对 preset 子行会报 "unrecognized Loader tree carrier"：
这是该 dsh 版本对所有 preset（包括 shipped 的 standard/ptc/minimal/cordis）
的 schema dump 限制，不代表 preset 不能加载。

## 已知差异 / 待办

- 安装机 dsh 是 `0.2.2-rc.3`，不是任务写的 `0.2.2-rc.1`；peer 范围兼容两者。
- `GET /v1/session/messages` 是 best-effort 投影，不承诺 opencode 完整消息结构
  （已按真实嵌套形状投影 text/reasoning/tool 行，扁平旧形状仍兼容）。
- 手动压缩是受理语义：202 只表示已交给 `/compact` 命令，压缩结果与失败原因经
  `compaction/*` 事件和 `command/done` 文本体现，HTTP 不等待摘要完成。
- 模型目录取决于宿主 `llm` 服务；没有配置任何 provider 时 `providers` 为空数组。
- `GET /v1/session` 的 `status` 是绑定状态 `bound`；agent 的
  `idle/running` 在 `GET /v1/session/status`。
- `plan` CAS 是进程内串行 + version 比较，不是跨进程文件锁。
- `plan-ledger.jsonl` 的事件名是 `commit|note|done|close`；旧 Loom 用 `diff`
  表示建账/改写。若共享同一 root，按 `commit` 兼容或改回 `diff`。
- `plan_close` 会把 `carry_over` 写进 truth JSON；旧 Loom v1 reader 对未知顶层
  键是拒绝的，若两个系统共享同一 root，需要让 Loom 侧忽略该字段或把
  carry_over 只留在 ledger。
- MCP alias 依赖 serverName 和 dsh 的实际公开名；hash 后缀场景需手工改配置。
- 没有实现 `letter_dispatch` 的 send_letter/inbox letter 语义。
- 没有加 `time-context` 行；若需要当前时间/时区运行时上下文，可后续在 preset
  加 `@deepseek-ai/dsh-time-context`。
- 没有提交 git；`harness-plugins/` 是新增未跟踪目录。
