# harness-plugins

Kinship 的 dsh 侧集成。六个独立插件包加一个 preset patch，全部是普通 Cordis
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
  cordis.patch.yml          # host 行: kinship-bridge + kinship-ui + kinship-plan-scheduler
  presets/kinship.patch.yml # agent preset: kinship, order 5
  locale/, icon.svg, docs/  # bundle 在 dsh 插件页的标题、描述、图标与详情文档
  packages/
    kinship-bridge/         # 本机 HTTP API + 单 Session 绑定 + 面板 JSON API
    kinship-ui/             # Web 侧栏 Kinship 面板（浏览器模块 + 无 host 行为）
    kinship-plan/           # daily plan JSON/md/ledger + CAS，v1 不可服务时写当日覆盖层
    kinship-plan-scheduler/ # Loom 计划调度器的 dsh 移植：母版/覆盖层 + 唤醒队列
    kinship-compact/        # compact_context：模型可调用的手动压缩（回合结束后执行）
    kinship-tools/          # 手机通知 / 提醒板 / TTS 原生工具（经 bridge 直连后端）
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
npm run verify     # typecheck + build + tests（364 个用例，30 个文件）
```

`link:dsh` 默认读取
`/mnt/d/tools/node-v24.22.3-linux-x64/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`，
可用 `DSH_PACKAGES_DIR` 覆盖。它只写本 workspace 的 `node_modules`，不碰任何
DSH_HOME。

集成测试会创建临时 `DSH_HOME`，复制七个包和 bundle patch，运行
`dsh --profile kinship-test --dump-config`；测试结束删除临时目录。生产
`dsh-home`、systemd、正在运行的 dsh 都不会被访问。

真实 profile 的安装/更新用 `scripts/sync-profile.sh`（构建产物 → `$DSH_HOME/profiles/<name>/node_modules/`，
不碰 profile 配置）：

```bash
npm run build
DSH_HOME=/path/to/dsh-home bash scripts/sync-profile.sh web
```

> **注意（2026-11-17）**：`sync-profile.sh` 只把构建产物拷进 profile 的 `node_modules/`，不会在
> profile 的 `package.json` 里声明依赖。只要在该 profile 里用 dsh 插件管理器或 `dsh plugin`
> 安装、升级、移除任何插件，pnpm 就会把这些未声明的目录当多余依赖清理（移入
> `node_modules/.ignored/`），随后 dsh 启动或热重载会报
> `skipping profile bundle "kinship-harness-plugins"`，bridge 端口不再监听、后端 dsh 探针 offline。
> 此时**重启 dsh 不会恢复**，必须重装依赖。
>
> 长期部署请改用 `link:` 依赖（一次装好，之后插件操作不会再清理；更新流程 = 本仓库
> `npm run build` + 重启 dsh）：

```bash
cd /path/to/server                # 包含 kinship 检出的目录
export PATH=/path/to/node24/bin:$PATH
REPO=/path/to/server/kinship/harness-plugins
DSH_HOME=/path/to/dsh-home dsh plugin --profile web add \
  "link:$REPO" \
  "link:$REPO/packages/kinship-bridge" \
  "link:$REPO/packages/kinship-ui" \
  "link:$REPO/packages/kinship-plan" \
  "link:$REPO/packages/kinship-plan-scheduler" \
  "link:$REPO/packages/kinship-compact" \
  "link:$REPO/packages/kinship-tools" \
  "link:$REPO/packages/kinship-task-compat"
```

七个插件包会提示 `declares no dsh.bundle … plain dependency`，属正常（bundle 在
`dsh.profile.bundles`，插件包只是普通依赖）。事故细节、判据与恢复步骤见
[docs/ops/dsh-production-rollout.md](../docs/ops/dsh-production-rollout.md) 第 9 节。如果继续使用
`sync-profile.sh`，必须把“装/升级/移除任何插件后重新同步并重启 dsh”写进操作流程。

生产切换的完整步骤（环境变量、bundle 选择、重启、绑定会话、热切 `ai_backend`、回滚）见
[docs/ops/dsh-production-rollout.md](../docs/ops/dsh-production-rollout.md)。

装进真实 profile 后，启动 `dsh web`，左侧栏会出现 **Kinship** 页：桥接地址、
token（显示/复制/轮换）、桥接配置、绑定会话、计划排班卡片和待粘贴的 `config.yaml`
片段都在那里，不需要手改 profile 文件。本 README 后面的表格是面板背后的字段与端点细节。

## kinship-bridge

Host 级插件，own `http.createServer`，默认 `127.0.0.1:18765`。只允许
`127.0.0.1` 或 `::1`，拒绝其他 bind 地址。

### 配置

这些字段属于 dsh profile 的插件配置，可在 dsh Web 侧栏的 **Kinship** 面板里直接改
（保存后写入 profile 并重载本行），也可以直接改 profile 的 `cordis.patch.yml`。

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
否则后端请求会收到 401。最省事的方式是在面板上点「显示令牌」并复制，
同时复制页面底部的 `config.yaml` 片段。

面板还可以轮换 token：写回同一个文件（0600）并立即对运行中的 bridge 生效，
不需要重启。环境变量来源的 token 属于部署方，轮换请求会被拒绝（409
`token_env_managed`）。

### 绑定

- `first`：所有 live root Session 中 `preset === "kinship"` 且 `createdAt` 最早
  的一个。
- `manual`：不自动选；通过 `POST /v1/session/bind` 切换。
- root 定义：`header.parentSession === undefined && header.origin !== "subagent"`。
- 绑定持久化到 `$DSH_HOME/kinship/binding.json`，同目录 temp + fsync + rename。
- 同一时刻最多一个绑定；`POST /v1/session/bind` 原子切换：先写文件，成功后再
  改内存；写失败返回 500 且保留旧绑定。
- 绑定的 Session 消失时状态变成 `bound_session_missing`；默认不自动换绑。
- 冷启动自愈：进程重启后 registry 为空，绑定指向的持久化 Session 不再"存活"，
  bridge 会在启动时预热、并在请求期懒恢复（`sessionController.resolveAgent`，
  与 dsh UI 打开会话同一条路径，含 preset 装配）。所以重启 dsh 后**不需要**先在
  UI 里打开一次 Kinship 会话。恢复失败（会话被删、preset 移除、无
  `sessionController` 的组合）才回落到 `bound_session_missing`；其它失败是
  409 `bound_session_unavailable`。多个并发请求共享同一次恢复尝试（单飞）。

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
| GET | `/v1/kinship/paths` | - | 上次接受的路径文档（含 `stored_at`）；未推送过为 404 |
| POST | `/v1/kinship/paths` | 路径文档（见「Root」） | 200 `{ok, ...文档, stored_at}`；非法为 400 `bad_request` |
| GET | `/v1/kinship/tool-auth` | - | `{ok:true, schema:1, configured, base_url, at}`，永不含 token |
| POST | `/v1/kinship/tool-auth` | `{schema:1, base_url, token, source, generated_at}` | 200 同 GET；schema/host 不合法为 400 `bad_request` |

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

## 工具授权（tool-auth）

手机通知、提醒板和 TTS 以前是独立 MCP 进程（`ai-template/mcp/ai_mcp.py`）自己读写
`config.yaml` + `backend/config/auth.json` 来找到后端。在 dsh 上改由后端推送一次：

`POST /v1/kinship/tool-auth`（Bearer 同 bridge 其它路由）body：

```json
{"schema":1,"base_url":"https://127.0.0.1:8768","token":"<service token>","source":"kinship-backend","generated_at":1794759000000}
```

- 校验：`schema` 必须 1；`base_url` 必须 `http(s)` 且主机名只能是 `127.0.0.1` /
  `localhost`（推的是明文 token，不能发到任意外部主机）；`token`/`source` 非空；
  `generated_at` 为非负整数。任一不合法 → 400 `bad_request`。
- 桥只把 `{baseUrl, token, at}` 放内存，**不落盘**：`$DSH_HOME` 里没有凭据副本，
  重启后等下一次推送（后端启动/上线时各推一次）。
- `GET` 同路径返回 `{ok:true, schema:1, configured, base_url, at}`，**绝不含 token**；
  推过之后桥向兄弟插件发 `kinship/tool-auth` 事件（payload 同样无 token）。
- 客户端：`base_url` 是 `https` 时跳过证书校验（主实例自签证书），`http` 直接请求；
  单次请求 30s 超时；后端非 2xx / 非 JSON / 连接失败都收成 `ok:false` + 简短
  error，error 里不会出现 token（内联回显也会被替换成 `[redacted]`）。

请求路径：`POST /api/notification/send`、`POST /api/reminders`、`GET /api/reminders`、
`POST /api/screen/tts/speak`（`send_audio:true`）。

## 手动压缩

`POST /v1/session/compact` 通过宿主注册的 `/compact` 命令（`kinship` preset 里的
`command-compact`）异步触发一次手动压缩：会话必须 **idle**，否则 409
`compaction_busy`；宿主组合里没有该命令时 500 `compaction_unavailable`。受理后立即
返回 202，压缩本身通过 `compaction/*` 事件在 SSE 里体现。

`GET /v1/session/compaction` 从 durable 日志推导最近一次压缩（`compaction/summary`
的 `shadowedSeqs` 数量与摘要文本、紧随其后的替换 `user/message` 作为锚点），
无压缩时 `status:"none"`。

模型侧的手动压缩是另一个入口：`kinship-compact` 行的 `compact_context` 工具（回合
结束后执行），见下面的 [kinship-compact](#kinship-compact) 一节。

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
- 页面底部的计划排班卡片读写的四个 `/api/kinship/ui/plan*` 路由不属于本包，由
  `kinship-plan-scheduler` 行注册（见下一节）；该行缺席时卡片单独提示"未安装"，
  其余卡片不受影响。

## kinship-plan

简化日计划工具。真源只有 JSON；markdown 是派生视图；ledger 只追加。v1 truth
不可服务时（`plan-{date}.json` 缺失 / 已 closed / 不含目标 id），`plan_note` 与
`plan_done` 改写真源旁边的当日覆盖层 `plan-{date}.overlay.json`。

### Root

解析顺序，绝不静默猜：

1. `config.root`
2. `KINSHIP_PLAN_ROOT`
3. `KINSHIP_AI_ROOT/data`（现有 Kinship plan data root）

三者都没有时插件激活失败。root 必须是绝对路径，并且目标路径会做
realpath 越界检查。

### 文件

```
{root}/daily/{date}/plan-{date}.json          真源（v1，CAS）
{root}/daily/{date}/计划-{date}.md            人读视图
{root}/daily/{date}/plan-ledger.jsonl         审计，只追加
{root}/daily/{date}/plan-{date}.overlay.json  当日覆盖层（仅写回回退路径）
{root}/plan/master.json                       母版，只读（覆盖层的 base）
```

JSON 先写（同目录 temp + fsync + rename），成功后写 md。md 写失败不回滚 JSON，
下一次写入会自愈。未知顶层字段和未知 item 字段读入后保存在 `extra`，每次写入
原样合并回去；现有 `coverage` 等 v1/v2 字段因此不会被丢掉，但本工具不解释、
不修改 coverage。

如果同一天存在 `plan-{date}.overlay.json` 而 truth JSON 不存在，默认拒绝写入
并抛 `plan_overlay_present`；设置 `allowOverlayShadow: true` 才允许在 overlay
旁创建 v1 truth 文件。`plan_read` 此时返回 `warning: "overlay_present"`。

### CAS

CAS 版本口径：`plan_commit` / `plan_close` 必须带 `expected_version`；`plan_note` /
`plan_done` 在当日 v1 账缺失或 closed 时可省略（写当日覆盖层），v1 仍 open 时仍要带它
（否则返回带当前版本的校验错误）：

- `0` = 创建（仅 commit 合法）
- 其他值必须等于磁盘当前 `version`
- 不匹配抛 `plan_conflict`，文件不变（回退路径不吞 conflict）
- `closed` 计划拒绝 commit；note/done 在 closed 时改走当日覆盖层
- `close` 用当前 version 重试是幂等的

同进程内按 date 串行化；跨进程是"读 version 后比较再写"，不是文件锁。覆盖层写入
另一套：母版/覆盖层 store 走 `daily/{date}/.plan.lock` 文件锁 + 原子写，CAS 是覆盖层
自己的 `version`。

### Tools

| 工具 | 作用 |
|---|---|
| `plan_read` | 读一天；缺失返回 `found:false`，不报错 |
| `plan_overlay_read` | 读生效计划（母版 + 当日覆盖层 diff）：`source`、覆盖层 `version`/`status`、条目 id/status；无覆盖层时 `source=master` |
| `plan_commit` | 创建或整表替换 items/notes；保留未知字段；不管理 coverage |
| `plan_note` | 追加一条 note，items 不变；v1 缺失/closed 时写当日覆盖层（此时可省略 `expected_version`） |
| `plan_done` | 改一个 item 的 status（默认 done），可写 evidence/note；done 时写 `done_at`；v1 缺失/closed/无该 id 时写当日覆盖层（此时可省略 `expected_version`） |
| `plan_close` | status=closed；未完成项转 carried；写 `carry_over`；写 ledger |
| `plan` | Loom 兼容别名：`read/commit/revise/diff/note/done/close`；revise/diff 是整表 commit；note/done 与同名工具同一回退路径 |

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

### 覆盖层写回（W59）

- 触发：`plan_note` 在 v1 缺失 / closed 时落当日覆盖层（v1 存在且未关闭时仍必须带
  `expected_version`，缺版本报校验错误而不是悄悄改道）；`plan_done` 在 v1 缺失 /
  closed / 不含目标 id 时落覆盖层。`plan` 别名的 note/done 走同一处理器与同一回退。
- 创建：`base_version` = 母版 `version`，`ops: []`，`status: "draft"`，
  `coverage = {profile: "merged_7", checkpoints: 母版 anchor id 排序列表, debt: []}`；
  首条 note 随创建一起写入（不额外升版本）。并发创建撞车时采纳已存在的覆盖层。
  需要母版且至少一个 `anchor` 条目，否则拒绝（`master plan is required` /
  覆盖层校验）；计划工具从不创建母版。
- done patch：`{status, evidence?, done_at}`，`done_at` 只在 `status=done` 时写
  ISO 时间；同一 id 只保留一个 op（已有 `add` 就地 patch、已有 `update` 合并、被
  `remove` 的 id 拒绝）；`expected_version >= 1` 时作为覆盖层 CAS 期望值（`0` 只表示
  "没有 v1 计划"，不参与 CAS）。note 走 `notes_append` 的 CAS 修订。
- ledger：两种写回各追加一行 `source: "plan"` 的事实行——note 带 `event`/`version`/
  `reason`，done 带 `event`/`entry_id`/`status`/`version`。
- 返回：回退写入的 mutation view 带 `source: "overlay"`，`version` 是覆盖层版本，
  `json_path` 指向 `.overlay.json`。
- 不回退：v1 的 `plan_conflict` 仍是 conflict；`plan_commit` / `plan_close` 只写 v1；
  `plan` 系列从不写母版；`verify=coverage` 在 dsh 未实现（覆盖层里的 coverage 块只是
  排班检查点清单，没有覆盖校验器）。
- 设计与逐条规则见 [packages/kinship-plan/docs/DETAIL.md](packages/kinship-plan/docs/DETAIL.md)。

## kinship-plan-scheduler

Host 级插件，把 Loom 的计划调度器搬到 dsh：读同一份 `{planRoot}/plan/master.json`
与 `{planRoot}/daily/{date}/plan-{date}.overlay.json`，按锚点/看门狗对账出当日
唤醒，写进每会话持久队列，再经 `kinship-bridge` 的 `deliver` 以普通用户消息注入
绑定会话。所以切换运行时不会出现第二份排班真源。**dsh 侧不需要配任何路径**：
Kinship 后端把自己的 `data.ai_root` / `data.dir` 经 bridge 的
`POST /v1/kinship/paths` 推过来（落 `$DSH_HOME/kinship/paths.json`），本插件以推送
的 `plan_root` 为准；时区与对账锚点也从母版派生。引擎移植自
`loom-harness/packages/server/src/plan/plan-scheduler.ts` 与
`serve/wake-queue.ts`；完整设计、对账公式与逐条差异见
[packages/kinship-plan-scheduler/docs/DETAIL.md](packages/kinship-plan-scheduler/docs/DETAIL.md)。

### Root 与状态目录

| 路径 | 解析顺序 |
|---|---|
| `planRoot` | **Kinship 后端推送的 `plan_root`** -> 插件 `planRoot` -> `KINSHIP_PLAN_ROOT` -> `KINSHIP_AI_ROOT/data` |
| `stateDir` | 插件 `stateDir` -> `KINSHIP_PLAN_STATE_DIR` -> `$DSH_HOME/kinship/state`（dsh 私有运行态，不由后端推） |

推送由后端在启动、`data_paths` 配置应用、切到 `ai_backend=dsh`、以及 dsh 健康探针
`offline→online`（覆盖 dsh 重启）时触发；bridge 以 0600 原子写落
`$DSH_HOME/kinship/paths.json` 并发 `kinship/paths` 事件，本插件启动时读该文件、
每次事件重新解析：根变了就原地重启引擎，根没变只刷新面板上的同步时间；被拒或空的
推送不会掐掉正在跑的引擎。相对路径一律拒绝并继续尝试下一候选（不按进程 cwd 猜计划树）。

面板的「计划排班」卡片会标出 `planRoot` 的来源（`kinship 后端推送（时间）` /
`插件配置` / `env` / `默认（等待 kinship 后端推送）`）与 `pathsProblem`。

### 配置

| 字段 | 默认 | 环境变量 | 说明 |
|---|---|---|---|
| `planRoot` | 空 | `KINSHIP_PLAN_ROOT` | 绝对路径覆盖；正常不用配，后端推送优先 |
| `stateDir` | 空 | `KINSHIP_PLAN_STATE_DIR` | 绝对路径；空则 `$DSH_HOME/kinship/state` |
| `mode` | `live` | `KINSHIP_PLAN_MODE` | `live` / `shadow` / `off` |
| `timezone` | `Asia/Shanghai` | `KINSHIP_PLAN_TIMEZONE` | 仅母版不可读时的兜底；母版自带时区优先 |
| `anchors` | 空（从母版派生） | `KINSHIP_PLAN_ANCHORS`（逗号分隔） | 每日对账锚点，严格 `HH:MM`，最多 8 个；空则取母版 `plan.build`/`plan.review` 的时刻，再退 `05:00,07:30` |
| `watchdogMs` | `60000` | `KINSHIP_PLAN_WATCHDOG_MS` | 看门狗间隔，`0` 关闭 |
| `horizonHours` | `48` | `KINSHIP_PLAN_HORIZON_HOURS` | 向前排多久（上限 168） |
| `catchupMaxAgeHours` | `8` | `KINSHIP_PLAN_CATCHUP_MAX_AGE_HOURS` | 迟到但仍在窗口内的条目保持原时刻 |
| `debtAfterHours` | `24` | `KINSHIP_PLAN_DEBT_AFTER_HOURS` | 超过即记为 debt 跳过；必须大于 `catchupMaxAgeHours` |

面板不编辑这一行：改环境变量或 profile patch 后重启 dsh。

### 模式与对账

- `live`（默认）：对账 + 入队 + 到点投递。
- `shadow`：只对账，把"本来会入队"的条目写到 `{stateDir}/plan/shadow/{date}.jsonl`，不碰队列。
- `off`：不建引擎、不排定时器、不写文件；`GET` 面板仍可读，写路由返回 409
  `scheduler_disabled`。

对账触发：启动一次（`boot`）、每日锚点（缺省 05:00 与 07:30）、看门狗（缺省 60s）、
面板「立即对账」（`manual`）。启动时若还没有绑定会话会先 defer，等 `agent/created`
后 1 秒补跑一次。日期窗口是 `now - debtAfterHours` 到 `now + horizonHours`，最多 20 天；
`plan.build` / `plan.review` 每天各最多一条，昨日未完成条目挂在今日 `plan.build` 的
payload 上。

### 面板路由

| 方法 | 路径 | 请求 | 成功响应 |
|---|---|---|---|
| GET | `/api/kinship/ui/plan` | - | `{ok, scheduler, master, queue, next}` |
| POST | `/api/kinship/ui/plan/ops` | `{expectedVersion, ops:[...]}` | 同上（写入后重新对账） |
| POST | `/api/kinship/ui/plan/reconcile` | `{reason:"manual"}`（可省略） | `{ok, queued:{added,updated,cancelled}, snapshot}` |
| POST | `/api/kinship/ui/plan/seed` | `{}` | 同上（写入默认排班） |

`ops` 是母版编辑操作：`upsert_entry` / `replace_entry` / `remove_entry` /
`set_enabled` / `set_status` / `update_entry`（带 patch）。每次写都必须带上次读到的
`expectedVersion`，不匹配返回 409 `master_conflict` 且文件不变。错误码：400
`invalid_request`、404 `master_missing`（还没有母版时调 ops）、413 `body_too_large`
（16 KiB 上限）、409 `scheduler_disabled`、409 `master_exists`（seed 时母版已存在）、
500 `internal`。这四个路由和 bridge 面板同属 dsh Connection 的 owner-only Fetch
通道：未登录 401、非 owner 403、不接受 bridge 的 bearer token。

### 队列与投递

- 队列 `{stateDir}/session/wake-queue/{sessionId}.json`（schema 2，原子写；实例锁
  `{stateDir}/session/wake-queue/.instance.json` 用 `O_EXCL` + pid 存活判定）。
- 投递失败重试一次（`now + 30s`），再失败归档 `failed`；`plan` 条目保留 48h，
  已投递归档保留最近 500 条。
- 唤醒行固定为 `【计划唤醒·<action>】HH:MM · <title>` + 指令 + `条目：<id>` +
  尾行 + `不发用户通知，除非条目要求。`；W59 起尾行恢复 Loom 的
  `完成后执行 plan done（date=…, id=…）`（合并补做条目逐条列 slot id），因为
  `kinship-plan` 的 note/done 在 v1 不可服务时会写当日覆盖层
  （见 [packages/kinship-plan/docs/DETAIL.md](packages/kinship-plan/docs/DETAIL.md)）。`plan.build` / `plan.review` 仍写
  「完成后只写当日计划，不需要 plan done。」。普通唤醒的 `条目：` 行是母版 id，
  可直接作为 `plan done` 的 `id`；合并补做条目的 `条目：` 行是它自己的队列 id，
  要标的是尾行列出的 slot id。模型可用 `plan_overlay_read` 先看生效计划里的 id。
- 只做 `source: "plan"`：flow / special / inbox 三个来源没有生产者，队列与渲染器
  仍然认识它们（`source` 字段与保留期分档保留），但本插件不会产生这类条目。

### 已知差异 / 限制

- 当日存在 v1 `plan-{date}.json` 时仍排母版条目（Loom 会用旧计划整体替换当日视图）；
  旧计划条目按 overlay 的 add 语义追加、无唤醒时刻，撞 id 只记 `legacy_collision:<id>`。
- 唤醒尾行恢复 `plan done`：母版 id 自 W59 起可经当日覆盖层标 done/留 note，但要求
  当日 `plan/master.json` 至少有一个 `anchor` 条目（覆盖层的 coverage 检查点不能为空），
  且 `plan done` 仍需 `expected_version`（没有 v1 计划时传 `0`）。
- 一旦某天有覆盖层，调度器对那天读的是母版 + 覆盖层的合并视图，不再叠加当日 v1
  legacy 条目；覆盖层出现前写入的 v1 条目在排班上会被跳过。
- 尚无覆盖校验器：覆盖层的 `coverage` 块只是 `merged_7` 的检查点清单，dsh 侧不校验
  覆盖债、也不标记检查点已验证。
- 状态根默认 `$DSH_HOME/kinship/state`（Loom 由宿主传 `stateRoot`）。
- 需要 `kinship-bridge` 行和绑定会话，否则对账一律 `deferred_no_session`；
  手动改绑会换成新会话的队列文件，旧队列里未投递的条目不迁移。
- 认领后、投递前进程崩溃会丢那一条唤醒（认领先落盘，与 Loom 同口径）。

## kinship-compact

preset 级的 `compact_context`：模型可调用的手动压缩。Loom 主会话有这个工具，dsh 的
Kinship 会话原先只有自动压缩和人类 `/compact`，04:00 的 `session.compact` 唤醒会让
模型无事可做。

dsh 的 `CompactionEngine.compactNow` 是 idle 会话操作（回合内调用返回 `busy` 的
`ManualCompactionError`），而工具总在回合内执行，所以工具只登记请求立即返回，由插件
自己的轮询在回合结束后压一次：

| 调用时的会话状态 | 返回文本 |
|---|---|
| idle，压出摘要 | `Compaction finished (~N history items).` |
| idle，没有可压区间 | `No compactable history yet.` |
| running（或在调用瞬间开始跑） | `Compaction scheduled: it runs when this turn ends.` |

配置（`presets/kinship.patch.yml` 不设值，用默认）：`pollIntervalMs=500`、
`maxWaitMs=600000`、`maxAttempts=600`。请求按 session id 去重（后一次调用替换前一次）、
`busy` 每次轮询重试、超时 / 超次丢弃并告警、插件卸载清空待办；没有待办时不挂定时器。
详见 [packages/kinship-compact/docs/DETAIL.md](packages/kinship-compact/docs/DETAIL.md)。

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
| `mcp_ai_mcp_tts_speak` | `tts_speak`（`kinship-tools` 原生工具） | `mcp__ai_mcp__tts_speak` |
| `mcp_ai_mcp_send_notification` | `ai-mcp_send_notification`（原生） | `mcp__ai_mcp__send_notification` |
| `mcp_ai_mcp_send_reminder` | `ai-mcp_send_reminder`（原生） | `mcp__ai_mcp__send_reminder` |
| `mcp_ai_mcp_list_reminders` | `ai-mcp_list_reminders`（原生） | `mcp__ai_mcp__list_reminders` |
| `mcp_search_web_search` | `mcp__search__web_search` | `mcp__search-mcp__web_search` |

目标定义可见时注册同 execute 的 alias；MCP 晚连接时 `tools/change` 会补注册。
目标不可见时只记录一次 info 日志，列出期望的 dsh 名字，不静默接受未知工具。
如果实际 MCP server 名导致 dsh 追加 hash 后缀，需要把
`kinship-task-compat.config.mcpAliases` 的 target 改成实际公开名。

## kinship-tools

preset 级的四个原生工具，替代 `ai_mcp` MCP 进程：`inject = ['tools','kinshipBridge']`，
只在 `kinship` preset 作用域注册，全部经 `kinshipBridge` 服务走 bridge 内存凭据访问后端。

| 工具 | 参数 | 行为 |
|---|---|---|
| `ai-mcp_send_notification` | `{title, content, response_format?}` | `POST /api/notification/send`；成功 `通知已发送: <title>` |
| `ai-mcp_send_reminder` | `{text, response_format?}` | 整块覆盖提醒板；`text` 去首尾空白后 ≤ 2000 字符（配置 `maxReminderChars`）；空串=清空；成功 `提醒板已更新（<时刻>）` / `提醒板已清空` |
| `ai-mcp_list_reminders` | `{response_format?}` | 读提醒板全文，围栏代码块原样包裹 + `updated_at` |
| `tts_speak` | `{text, voice?, style?, user_id?, response_format?}` | `POST /api/screen/tts/speak`（`send_audio:true`，`voice` 默认 `mimo_default`）；成功回 `TTS语音已成功发送: "<前 50 字预览>"` |

- 返回文案与错误句（401/403/404/429/500/连接失败/超时）镜像 `ai_mcp.py` 的对应工具；
  `response_format: "json"` 时返回后端原始信封的 JSON 字符串。
- 桥未挂载、或后端还没推 `tool-auth` 时返回清晰的中文错误文本，**不抛异常**；
  工具失败也只体现在 `ok:false` + 文本里。
- 输入校验在工具内做：空白 `title`/`content`/`text` 直接拒绝，提醒板超长在调用后端前
  就返回失败原因。
- 别名：Loom prompt 里的 `mcp_ai_mcp_*` 名字由 `kinship-task-compat` 映射到这四个
  原生名（fallback 保留旧的 `mcp__ai_mcp__*`，MCP server 还在时仍可用）。

## kinship preset

`presets/kinship.patch.yml` 插入：

- `id: kinship` / `name: Kinship` / `order: 5`
- persona 只从 `$KINSHIP_AI_ROOT/agents/main.md` 读 prefix，`complete: false`
- 不挂 `agent-instructions`，不改 AGENTS.md，不建全局 prompt
- 工具：bash/pwsh（按平台）、fs、fs-search、todo、ask-user、
  subagent/subagent_fork/subagent_control、compaction 组（`compaction-basic`、
  `command-compact`、`compact-context`（= `kinship-compact` 的 `compact_context`）、
  `tool-result-pruner`；该组 `isolate` 了 `compaction` 与 `toolResultPruner`，
  所以工具拿到的是本会话自己的压缩服务）、`kinship-plan`、`kinship-task-compat`、
  `kinship-tools`（手机通知/提醒板/TTS 四个原生工具，见
  [kinship-tools](#kinship-tools)）
- 不挂 `kinship-memory`、`kinship-context-watch`、`kinship-qq`

现有 shipped presets（standard=1、ptc=2、minimal=3、cordis=4）不变。

profile 使用方式：profile 的 `dsh.profile.bundles` 加
`kinship-harness-plugins`，并让 bundle 引用的七个包在 profile 的 `node_modules`
可解析（`scripts/sync-profile.sh` 会一次拷全）。`--dump-config` 会显示 host 的
`kinship-bridge`、`kinship-ui`、`kinship-plan-scheduler` 三行和 `preset-kinship` 行
（preset 展开后含 `compaction-basic` / `command-compact` / `compact-context` /
`tool-result-pruner` 等子行）。
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
- v1 `plan` CAS 是进程内串行 + version 比较，不是跨进程文件锁；覆盖层写入是
  `daily/{date}/.plan.lock` 文件锁 + 覆盖层自己的 `version` CAS。
- `plan-ledger.jsonl` 里 `source: "plan"` 的行事件名是 `commit|note|done|close`；
  `source: "scheduler"` 的行是调度器事实行（`deferred_no_session` / `master_error` /
  `master_fallback` / `overlay_error` / `skipped_debt` / `queue_error`，部分带
  `reason` / `entry_id`）。旧 Loom 用 `diff` 表示建账/改写。若共享同一 root，按
  `commit` 兼容或改回 `diff`。
- `plan_close` 会把 `carry_over` 写进 truth JSON；旧 Loom v1 reader 对未知顶层
  键是拒绝的，若两个系统共享同一 root，需要让 Loom 侧忽略该字段或把
  carry_over 只留在 ledger。
- MCP alias 依赖 serverName 和 dsh 的实际公开名；hash 后缀场景需手工改配置。
- 没有实现 `letter_dispatch` 的 send_letter/inbox letter 语义。
- 没有加 `time-context` 行；若需要当前时间/时区运行时上下文，可后续在 preset
  加 `@deepseek-ai/dsh-time-context`。
- 面板绑定限制：只接受 live 的 root `kinship` 会话；绑定切换会关闭已打开的事件流。
- 面板写配置是**完整覆盖**：bundle patch 里由环境变量驱动的字段在保存后会被固定成保存值
  写进 profile，不再跟随环境变量。
- 环境变量来源的 token 不能在面板里轮换（文件来源可以，已单测覆盖）。
- 本 bundle 若作为 profile 的 `dsh.profile.bundles`（组合根）安装，dsh 插件页不会把它
  列成"已安装插件"，bundle/插件行的标题、描述、图标与详情文档只对普通插件安装的
  profile 显示；面板与 bridge 本身不受影响。
- 面板的"未绑定 / 没有 kinship 会话"状态只有单测覆盖，未在浏览器里实测。
- 计划调度器的移植差异与限制集中在 `## kinship-plan-scheduler` 的「已知差异 / 限制」：
  legacy 当日仍排母版、只实现 `plan` 来源、需要 bridge 行与绑定会话、有覆盖层的那天
  改读合并视图、尚无覆盖校验器；唤醒尾行自 W59 起恢复 `plan done`（写回要求母版带
  anchor 条目，且 `plan done` 仍需 `expected_version`）。
- 路径由 Kinship 后端推送这一点同样只影响计划调度：bridge 新增
  `POST/GET /v1/kinship/paths`（落 `$DSH_HOME/kinship/paths.json`），后端在启动/
  data_paths/ai_surface/health 上线四个时机推一次；其它行不依赖它。
- `kinship-tools` 的工具授权同样靠后端推送（`POST /v1/kinship/tool-auth`，内存态不
  落盘），所以后端没起或还没推时这四个工具只回错误文本，不影响会话其它能力。
- 连字符工具名（`ai-mcp_send_notification` 等）已在真实 dsh `0.2.2-rc.3` 的工具
  注册表里验证：`register` 接受、`definitions()` / `schemas()` 原样返回；未跑真实
  模型回合，模型提供方按 OpenAI 兼容的 `[A-Za-z0-9_-]{1,64}` 规则接受（dsh 自己的
  MCP 公开名也是按 `[A-Za-z0-9_-]` 归一化，同一字符集）。
- `ai_mcp` MCP 进程在 dsh 侧已不需要；退场由后端/部署侧决定，`kinship-task-compat`
  的 fallback 名字保留，MCP server 还在时仍能被调用。
