# Kinship AI 运行时适配器契约

> 状态：稳定后端侧边界（2026-11-15）。[`kinship-bridge`](../../harness-plugins/packages/kinship-bridge/src/server.ts) 是 dsh 的参考实现。其他 harness 可以实现同一契约，也可以提供一个等价的适配层。dsh 只是一个实现，不是唯一答案。

## 1. 范围

本契约定义 Kinship 后端与 AI 运行时之间的最小边界。后端不关心运行时内部如何管理会话、模型、工具和上下文，只依赖以下能力：

- 健康检查与会话绑定
- 消息投递、状态查询、中止当前回合
- 历史消息与子会话查询
- 事件订阅（SSE）
- 收件箱投递

运行时负责自己的进程、模型、工具、上下文和持久化。适配层只做传输与会话映射，不复制后端业务逻辑，也不承担音频算法。

## 2. 传输与安全

- 只监听 loopback：`127.0.0.1` 或 `::1`。拒绝绑定其他地址。
- 明文 HTTP 只允许用于 loopback。不要放在反向代理、局域网或公网后面。
- 所有端点都要求 `Authorization: Bearer <token>`，包括 `GET /v1/health`。
- token 从环境变量或受限权限的 secret 文件读取，不写进命令行参数、日志或错误消息。
- token 比较使用常量时间比较。
- JSON 请求体必须有上限。参考实现为 64 KiB，超过返回 `413 body_too_large`。
- 不记录 token、请求体、消息正文和完整会话内容。日志只保留路由、状态码、耗时和脱敏后的错误摘要。

## 3. 会话模型

适配器只服务一个 Kinship 绑定会话。Kinship 后端按单会话架构工作，不存在第二个投递目标。

### 3.1 绑定

绑定策略二选一：

- `first`：自动选择最早创建的、仍然存活的 root 会话，且该会话运行 Kinship preset。
- `manual`：不自动选择，由 `POST /v1/session/bind` 或启动配置指定。

绑定状态持久化在运行时自己的状态目录，使用原子写。绑定对象必须是 root 会话并运行 Kinship preset；子会话和其他 preset 的会话不能绑定。绑定变化时，事件流应结束当前连接，让客户端重新订阅。

### 3.2 错误码

| HTTP | code | 含义 |
| --- | --- | --- |
| 401 | `unauthorized` | 缺少或错误的 Bearer token |
| 404 | `session_not_found` | 请求绑定的会话 id 不存在 |
| 409 | `no_kinship_session` | 当前没有可绑定的 root Kinship 会话 |
| 409 | `bound_session_missing` | 已持久化的绑定指向一个不再存活的会话 |
| 409 | `invalid_session` | 请求绑定的会话不是 root，或没有运行 Kinship preset；参考实现细分为 `not_root_session` 与 `not_kinship_session` |
| 413 | `body_too_large` | 请求体超过上限 |
| 422 | `invalid_body` / `missing_<field>` | 字段缺失或格式错误 |
| 503 | `subagents_unavailable` | 运行时没有挂载子会话能力 |

错误响应包含稳定的机器码和人类可读的说明。机器码用于客户端分支，说明只用于日志和排障。

## 4. 端点

所有成功响应都是 JSON，SSE 除外。

| 端点 | 用途 | 成功响应 |
| --- | --- | --- |
| `GET /v1/health` | 健康检查与绑定状态 | `200 {ok, version, dsh, session_id, preset, status}`；未绑定时 `session_id` 为 `null`，`status` 为 `unbound` |
| `GET /v1/session` | 读取当前绑定 | `200 {session_id, preset, status, bound_at, policy}` |
| `POST /v1/session/bind` | 绑定一个会话，body 为 `{session_id}` | `200`，返回与 `GET /v1/session` 相同的结构 |
| `POST /v1/session/messages` | 投递一条用户消息，body 为 `{text, source?}` | `202 {accepted, message_id, session_id}` |
| `POST /v1/session/abort` | 中止当前回合，空闲时幂等 | `202 {ok, session_id, was_running}` |
| `GET /v1/session/status` | 读取运行状态 | `200 {session_id, status, running, last_turn_at}` |
| `GET /v1/session/messages?limit=&before=` | 分页读取历史消息 | `200 {session_id, messages, has_more, next_before}` |
| `GET /v1/session/children` | 列出子会话 | `200 {session_id, children}` |
| `GET /v1/session/events` | 订阅会话事件 | `200`，`text/event-stream` |
| `POST /v1/inbox` | 投递收件箱消息，body 为 `{class, text, thread_id?}` | `202 {accepted, id, class, target, session_id}` |

除 `GET /v1/health` 和 `POST /v1/session/bind` 外，其余端点都要求已绑定会话；未绑定或绑定失效时返回 409 `no_kinship_session` 或 `bound_session_missing`。

### 4.0 可选扩展端点

契约只要求上表的最小集。参考实现额外提供四个可选端点，供后端按能力探测使用
（不存在时后端走各自降级，不视为违反契约）：

| 端点 | 成功响应 | 用途 |
| --- | --- | --- |
| `GET /v1/models` | `200 {providers:[{id,name,models:[{id,name}]}]}` | 运行时模型目录（空目录也返回 200） |
| `GET /v1/session/context` | `200 {session_id, provider, model, contextWindow, usedTokens, projectedTokens}` | 当前模型路由与上下文占用；未知字段为 `null` |
| `POST /v1/session/compact` | `202 {accepted, session_id, status:"compacting"}` | 手动压缩受理；`409 compaction_busy`（会话非 idle）、`500 compaction_unavailable`（运行时无该能力） |
| `GET /v1/session/compaction` | `200 {session_id, status:"none"\|"active", covered_count, summary_text, anchor_message_id, anchor_timestamp_ms}` | 最近一次压缩边界快照 |

### 4.1 健康检查

`GET /v1/health` 与 `POST /v1/session/bind` 在未绑定时必须可用：前者用于探测，后者用于建立绑定。`version` 是适配器版本，`dsh` 是 harness 版本，`preset` 在未绑定时为 `null`。`status` 取值：`unbound`、`bound`、`bound_session_missing`。`dsh` 字段名沿用参考实现，其他 harness 用它返回自身版本。

### 4.2 消息投递

`POST /v1/session/messages` 在下一个回合边界投递消息，返回 `202` 表示已受理，不表示回合已经完成。`source` 是可选的调用方标签，用于诊断。

`POST /v1/inbox` 的 `class` 必须匹配 `[a-z][a-z0-9_-]{0,31}`。当 `class` 为 `interrupt` 且当前回合正在运行时，消息在下一步投递；其他情况在下一回合投递。`target` 返回值会说明实际选择。

### 4.3 历史消息

`GET /v1/session/messages` 的 `limit` 默认 50，范围 1 到 200。`before` 是事件 `seq` 整数，不是不透明游标。响应中的 `messages` 按时间从旧到新排列，`next_before` 是继续读取更早消息的游标；没有更多消息时为 `null`。

单条消息的稳定字段：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `id` | string | 消息 id |
| `role` | `user` / `assistant` / `tool` | 角色 |
| `content` | array | 原始内容块 |
| `text` | string | 可读文本投影 |
| `created_at` | number | 创建时间，epoch 毫秒 |
| `seq` | number | 事件序号 |
| `source` | any | 可选来源标记 |
| `tool_call_id` | string | 工具调用关联 id，仅工具结果 |
| `is_error` | boolean | 工具结果是否为错误 |

### 4.4 事件流

`GET /v1/session/events` 返回 SSE。每个事件一帧：

```text
data: {"seq":123,"payload":{"type":"assistant/message","properties":{"text":"..."}}}
```

`seq` 在单个会话内单调递增。`payload.type` 是事件类型，`payload.properties` 是该事件的 JSON 数据。客户端必须忽略不认识的事件类型。实现可以发送 `retry:` 和注释行作为保活，客户端应忽略它们。绑定变化时连接结束，客户端重新连接后会收到新绑定会话的事件。

实现**可以**在流里追加额外事件类型（客户端必须忽略未知类型）。参考实现的实时助手流
就是这样一个扩展：`payload.type` 为 `kinship/assistant-stream`，`properties` 为
`{session_id, frame}`，其中 `frame` 是该运行时进程内的逐 attempt 流式帧
（`start` / `chunk` / `end`）。这类帧不属于 durable 日志，`seq` 是实现自定义的
小数（落在两条 durable 事件之间），只用于实时渲染；历史仍以
`GET /v1/session/messages` 为准。没有实时流的运行时可以不发送任何额外类型。

### 4.5 子会话

`GET /v1/session/children` 返回运行时可见的子会话列表。参考实现的每行至少包含 `id`、`parent_id`、`depth`、`kind`，并按运行时的能力附加 `mode`、`name`、`label`、`path`、`activity`、`has_children`、`reason` 或 `created_at`。没有子会话能力时返回 `503 subagents_unavailable`。

## 5. 后端配置

Kinship 公开模板只承诺两条 AI 运行时路径：

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `ai_backend` | `loom` | 运行时选择；`loom` 是默认与完整工作流，`dsh` 是可选适配路径 |
| `dsh.url` | `http://127.0.0.1:18765` | dsh 适配器的 loopback 地址 |
| `dsh.token` | 空 | Bearer token，优先级最高 |
| `dsh.token_file` | 空 | 受限权限的 token 文件，内容为裸 token |
| `dsh.timeout_seconds` | `30` | 请求超时 |

token 读取顺序：`dsh.token` > `dsh.token_file` > 环境变量 `DSH_TOKEN`，兼容别名 `KINSHIP_BRIDGE_TOKEN`。token 只出现在后端进程内，不返回给前端，也不写入日志。

切换 `ai_backend` 或修改 `dsh` 连接参数后，按 [system-config-hot-reload.md](../ops/system-config-hot-reload.md) 确认生效方式；客户端是单例，必要时重启后端。

### 5.1 适配器自己的配置界面（可选）

适配器可以在**它自己的 harness 的 UI** 里提供配置页，用来查看绑定状态、显示或轮换
Bearer token、修改监听端口与绑定策略。这不是契约要求，Kinship 后端也不会调用它；
实现时遵守三条边界：

- 走 harness 自己的已认证通道，不要为 UI 再开一个带 token 的 HTTP 端口。dsh 的
  `kinship-ui` 面板走 dsh Connection 的 owner-only Fetch 通道（`/api/kinship/ui/*`），
  未登录 401、非 owner 403，且不接受 bridge 的 Bearer token。
- 写配置用 harness 的配置编辑器（dsh 是 `ctx.configEditor.edit()`），不要自行改写
  profile patch 文件；写入是完整配置覆盖，环境变量驱动的字段会被固定成保存时的值。
- 环境变量提供的凭据属于部署方，轮换请求应当明确拒绝而不是假装成功（dsh 返回
  409 `token_env_managed`）。

契约仍然只约束第 2 到 5 节的 loopback 会话接口：没有配置界面的适配器同样合规，
本节只是把"界面该放哪、凭据怎么处理"写清楚，避免在 loopback 端口上再暴露一套写接口。

## 6. 会话映射要求

后端对运行时只暴露一组固定能力。适配层需要把单会话语义映射到自己的 API：

- 创建或读取主会话时，返回当前绑定会话，不新建第二个会话。
- 调用方传入的会话 id 只作为兼容标签，实际投递目标始终是绑定会话；响应回传真实 id。
- 模型和 provider 选择由运行时自己的配置或 preset 决定，后端不按消息切换模型。
- 手动压缩接口不在契约内。没有该能力时返回明确错误，不要假装成功。
- 收件箱按 `class` 选择投递边界，参考实现使用 `interrupt` 与普通消息两种边界。

## 7. 非目标

- 不做反向代理。适配器只监听 loopback，Kinship 后端是唯一客户端。
- 不做前端切换按钮。运行时选择在配置层完成，不在 Web UI 暴露。
- 不向 `AGENTS.md` 注入运行时提示词。persona 与工作流由运行时自己的配置或 preset 负责。
- 不要求 memory、context 或 flow 插件。契约只覆盖会话、消息、状态、事件和收件箱；记忆与上下文装配由运行时自行决定。
- 不承诺 Loom 专属能力。手动压缩、flow 收敛和 Loom 专有工具面不在契约内。

## 8. 安全清单

上线前至少确认：

- 监听地址是 `127.0.0.1` 或 `::1`。
- 所有请求都校验 Bearer token，包括健康检查。
- token 来自环境变量或受限权限文件，权限不宽于运行用户可读。
- 请求体有上限，超限返回 `413`。
- 日志不包含 token、请求体、消息正文和完整会话内容。
- 适配器不暴露给反向代理、容器外网卡或局域网。

## 9. 实现状态

dsh 的 `kinship-bridge` 是本契约的参考实现，位于 `harness-plugins/packages/kinship-bridge/`。它当前是可选的适配路径，参考实现已有单元与集成测试；本文不声明所有部署环境的生产可用性。

参考实现同时提供第 4.0 节的可选扩展端点与 `kinship/assistant-stream` 实时流；它们在真实
dsh 0.2.2-rc.3 上已验证（挂载、绑定、消息投递、SSE 翻译、手动压缩受理、模型目录、上下文
窗口）。Kinship 后端对这些能力做能力探测：客户端缺少某个扩展时按"无该能力"降级
（模型目录为空、上下文窗口为 null、压缩返回明确错误），不会假装成功。

参考实现还按第 5.1 节在 dsh Web 侧栏提供了 Kinship 面板
（`harness-plugins/packages/kinship-ui`），经 dsh 自己的 owner-only 通道读写配置与 token；
该面板不属于契约要求。

其他 harness 只要实现本契约，或提供一个等价适配层，就可以接入 Kinship。适配层的语言、进程模型和部署方式不受限制，行为和错误码必须一致。

## 10. 相关文档

- [ai-runtimes.md](ai-runtimes.md)：运行时定位、选择表与能力对比。
- [AI_SYSTEM.md](AI_SYSTEM.md)：Loom 架构与数据流。
- [../ops/CONFIGURATION.md](../ops/CONFIGURATION.md)：后端配置键参考。
- [../ops/system-config-hot-reload.md](../ops/system-config-hot-reload.md)：配置生效方式。
