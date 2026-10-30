# Loom 使用文档

> 版本：v1（2026-10-08；2026-10-18 增补 W53 按 agent 分配模型；2026-10-19 增补 W54/W55/W56 压缩历史、忙时可见性与抢占、瞬时重试与读图护栏；2026-10-21 增补 converge 自动唤醒（wake）与 server.autoWakeEnabled；2026-10-21 增补单次/auto 压缩、投影摘要与 tail 重放；2026-10-28 增补单主会话、sessionList 列表开关与 GET /sessions/main）。Loom（织机）是 axeuh 自研 agent harness，替换 opencode serve；
> "小贺同学"是织工（persona），Loom 是躯体（infra）。
> 决策真源：docs/01（D1–D34）；实现真源：packages/ 源码；本文是使用者视角的汇编。
> 文中标注 **[未来]** 的条目属命名蓝图，v1 未实现，勿依赖。

---

## 1. 架构一图流

```
                      axeuh-health-monitor 后端 (8768/8769)
                              │ ai_backend 开关
                ┌─────────────┴─────────────┐
                ▼(兜底)                      ▼(转正)
     opencode serve :5096            loom serve :5100  ← systemd axeuh-loom
     （原样保留，随时切回）            │
                                     ├─ 主会话（聊天，长生命周期，收束终止）
                                     ├─ 副会话引擎（定时/手动任务，每次 fresh）
                                     ├─ 子智能体（task 工具派发，上限受控）
                                     ├─ 上下文装配器（AGENTS.md+memory 注入，缓存友好）
                                     └─ L0 账本（state/*.jsonl：trace/ledger/session/inbox/dead-letter）
```

核心不变量：
- **收束才停**：回合只由"收束工具成功调用+字段齐"终止，纯文本结束不停止；超限自动收束为"需用户确认"，绝不静默假完成（D25/D30/D31）。
- **账本先于执行**：任务 expected 行在任何执行动作前持久化；崩溃重启后全量对账补差（D13/D19）。
- **前缀字节恒定**：稳定记忆是"经线"（prompt cache 命中），每轮增量是"纬线"（D6）。
- **opencode.db 已弃用**：一切状态在 `state/` jsonl，append-only，内存不是真源（D2）。

## 2. 快速开始

```bash
cd /opt/kinship/loom-harness

# 1) 配置（首次）：复制模板并改 workspace/port，见 §3
cp config/loom.example.yaml config/loom.yaml

# 2) 环境变量：LOOM_CONFIG 路径 / LOOM_TOKEN 服务令牌 / LOOM_KEY_* 模型密钥
#    生产由 systemd EnvironmentFile 注入；手测时可临时 export

# 3) 起服务（监听口 ≥5097，生产=5100）
node packages/server/dist/cli.js serve            # 或 --port 5100 --config config/loom.yaml

# 4) 冒烟（开发回归资产，自动起停+断言）
bash scripts/smoke-serve.sh        # 假模型全链
bash scripts/smoke-real-model.sh   # 真模型对话（需真实 LOOM_KEY_*）

# 离线 CI（假模型，无网络）
bash scripts/ci.sh                 # typecheck+build+test
```

CLI 实际命令面：`loom serve [--port N] [--hostname H] [--config PATH]`。
`loom runs / trace / doctor` **[未来]**：v1 未实现，等价能力走 HTTP API（§5）与直读 state 文件（§7）。

## 3. 配置

### 3.1 loom.yaml（部署级，gitignore，密钥零入库）

主要段，完整口径看 `config/loom.example.yaml` 内注释：

| 段 | 关键字段 | 说明 |
|---|---|---|
| `server` | port(≥5097) / hostname / interruptOnSend / autoWakeEnabled / sessionList / mainSessionId | 生产=5100 / 127.0.0.1；5096/8768/8769/18888 是现网禁碰口（D32）；interruptOnSend=true 时忙时发送抢占在途 turn，缺省/false 保留旧排队语义（§5.1）；autoWakeEnabled 缺省启用，显式 false 关闭主会话自动唤醒，改动需重启（§4.1）；sessionList 缺省关闭，仅显式 true 开放 `GET /sessions`；mainSessionId 指定主会话，缺省走标记/调度/首个会话解析（§3.4）；两者改动均需重启 |
| `workspace` | 路径 | **一切记忆与任务定义的家**。开发=fixture-workspace/，生产=axeuh-health-monitor/ai/ |
| `models[]` | id/provider/contextWindow/maxOutput/vision/timeout/reasoningEffort | 模型目录；timeout 毫秒。可多条并存：`models[0]` 供主会话/副会话/压缩，子智能体按 frontmatter `model:` 选用其他条目（W53） |
| `pricing` | input/output/cacheRead/cacheWrite | USD/百万 token，cost-tracker 记账用 |
| `providers[]` | provider / baseUrl / apiKey? | provider 级端点；`apiKey` 可选内联，声明时优先于 `credentials`。`/config` 只回 `apiKeyConfigured` 布尔，密钥值永不外泄 |
| `credentials` | 逻辑名: `${ENV_VAR}` | **只允许 env 引用**。写内联密钥→拒绝启动；env 无值→fail-fast；无内联 `apiKey` 时作为回退 |
| `exits` | kind: ai-mcp 等 | D33 stub，v1 原样透传不实现 |
| `pty` | enabled / maxSessionsPerLoomSession / maxSessionsTotal | 交互式终端（§7.2）；整段缺省=启用，两个上限缺省 16/64 |

- `models[].reasoningEffort`（可选）：`none|minimal|low|medium|high|xhigh|max`。缺席 = 不发送 thinking 参数、走上游默认；设置后按 reasoning 模型发送 `reasoning_effort` 档位（DeepSeek 官方支持 none/low/high/max，minimal→low、medium/xhigh→high）。

配置加载优先级：`--config 参数 > LOOM_CONFIG 环境变量 > 仓库默认`。

### 3.2 环境变量

| 变量 | 用途 |
|---|---|
| `LOOM_TOKEN` | 所有 HTTP 端点的 Bearer 令牌（无未鉴权路径） |
| `LOOM_KEY_<供应商>` | 模型密钥（如 LOOM_KEY_EFLOWCODE），只进进程环境 |
| `LOOM_CONFIG` / `LOOM_STATE` | 配置路径 / state 根覆盖 |
| 假模型 | `LOOM_FAKE_MODEL=1`（离线冒烟/CI），真实链路=正常 env |

### 3.3 热加载四件套（D10）

工作区配置面（`ai/config/{injection,triggers,workflows,models}`）**改文件即生效，不重启**：
加载即校验（坏配置**拒绝+旧配置继续服务**，绝不崩）→ 原子交换 → `config.applied` 审计事件（含前后 sha256，查 `GET /config/audit`）→ 回滚=git 还原文件。

### 3.4 单主会话与列表开关（2026-10-28）

Loom 按单主会话运行。`GET /sessions/main` 恒可用，不受 `sessionList` 影响，返回一个 `{sessionID,status,createdAt,title?,archived}` 对象，不返回列表或计数；主会话未注册时就地登记（自愈），无法解析主会话返回 503 `main_session_unavailable`。

主会话解析优先级（boot 一次，确定性）：

1. `server.mainSessionId`（非空，仅字母数字/下划线）
2. 运行时标记 `{stateRoot}/session/main-session.json`（`{sessionID,source,updatedAt}`；运行时数据，不提交 git）
3. `scheduling.sessionId`
4. 主 store 中第一个已持久化会话
5. 新生成

解析结果在每次 boot 解析后原子覆盖标记，跨重启保持同一主会话；显式 id 非法、标记损坏或首个会话 id 非法，只 WARN 并继续下一来源。`server.sessionList` 缺省关闭：`GET /sessions` 与 `GET /sessions?archived=1` 一律 404 `session_list_disabled`，仅显式 `sessionList: true` 恢复旧列表行为。列表开关不影响 `POST /sessions`、`GET /sessions/main` 与全部逐会话端点（messages、history、status、pending、compact、archive 等）。

## 4. 上下文注入（经线）

装配分层：段0 system（含收束工具说明）→ 段1 稳定记忆 → 段2 任务提示词 → 段3 每轮增量。**你只维护段1 的文件**：

- `AGENTS.md`（workspace 根）：主智能体全局契约，每轮注入。
- `memory/**/*.md`：任何 Markdown 自动按路径字典序扫描注入；加文件即上线、删即下线，无需注册。
- 缓存保护：memory 文件若含"日期+时分"级易变内容（`2026-09-13 08:00`）会被判 invalid 降级为占位（防打穿 prompt cache）——**日期写日粒度**（`2026-09-13`）没问题。
- fail-soft：任何记忆文件缺失/损坏→该段占位降级+审计记录，装配不崩。
- 压缩（D14/D18/D21）：生产走 worker 路径（声明 `compaction.fallbackTokens`）：旧 compactable `toolResult` 先投影为占位符，`summaryMode: auto` 在预算内单次摘要、超预算递归拆分（depth ≤ 2），成功后写 `coveredCount`/`tailIncluded` boundary；已覆盖前缀不重复压缩。legacy hook（未声明 `fallbackTokens`）仍保留 micro→full 两级语义。详见 §5.4.1。

### 4.1 自动唤醒（converge wake）

主会话的 `converge` 工具支持可选字段 `wake`，用于设置一次性自动唤醒。副会话（side）携带 `wake` 会被拒收；子智能体不提供 `converge` 工具，因此只有主会话能设置。

- 时间格式：倒计时（`30s` / `10m` / `1h30m` / `2天`）、带时区 ISO（`2026-10-22T08:00:00+08:00`）、本地日期时间（`2026-10-22 08:00`）、`HH:MM`（取下一次该钟点）、`none`（清除）。
- 语义：省略 `wake` = 保持已有计划不变；`none` = 显式清除；最长 30 天；格式非法、时间已过或超出 30 天，会整体拒收本次 converge 调用。
- 持久化：一次性唤醒落盘到 `state/session/wake/{sessionID}.json`，重启后自动恢复。启动时已过期但未超过 24 小时的唤醒立即触发，超过 24 小时的丢弃。
- 触发：到点向该会话投递 durable user 消息（`【自动唤醒】...`）。会话空闲则立即起一轮；忙则排入待发队列，当前轮收尾后起新轮。
- 清除：由模型负责清除（再次调用 converge 并传 `wake: "none"`）。普通用户消息不会自动清除待触发的唤醒。
- 关闭：配置 `server.autoWakeEnabled: false` 并重启服务。键缺席等于启用；关闭后 `wake` 从工具 schema 消失，带 `wake` 的调用被拒收。
- `converge` 的 `digest` 与 `body` 不再是必填项：`digest` 由系统从本回合助手正文自动派生，`body` 可省略。

## 5. HTTP API（真实路由面）

全部端点需 `Authorization: Bearer $LOOM_TOKEN`（或 `X-Loom-Token` 头）。Base=`http://127.0.0.1:5100`。

**会话域（主会话/聊天）**
| 方法 路径 | 作用 |
|---|---|
| `POST /sessions` | 建会话 |
| `POST /sessions/:sessionID/messages` | 发消息。`server.interruptOnSend: true`（生产）时忙时新消息插队首并 abort 在途 turn，202 返回 `interrupted:true`；`false`/键缺席时，忙时走 W54/W55 非打断路径，FIFO 入队并 steer，202 返回 `queued:true`，队列上限 10、满则 409（详见 §5.1） |
| `POST /sessions/:sessionID/compact` | 手动压缩。先 `loop.hydrate()` 回放 durable 转录（修复重启后空快照 no-op），再启动 worker；202 返回 `{status:"compacting",accepted:true,attemptId}`；会话忙或已有压缩在跑 409（`session_busy`/`compaction_busy`），worker 不可用 501（`compaction_unavailable`）。详见 §5.4.1 |
| `POST /sessions/:sessionID/voice` | 语音口径："先 abort 再发送" |
| `POST /sessions/:sessionID/abort` | 中断当前轮（可 resume，尾巴自愈） |
| `GET /sessions/:sessionID/history` | 分页历史，游标头 `x-next-cursor` |
| `GET /sessions/:sessionID/pending` | 待发队列读模型 `{sessionID,pending:[{text,at,state}]}`；state=`queued`/`running`/`drained`；未知会话 404，空队列 200 |
| `GET /sessions/:sessionID/status` | 会话状态 |
| `GET /sessions/main` | 主会话单对象 `{sessionID,status,createdAt,title?,archived}`；不返回列表或计数；未解析 503 `main_session_unavailable`，未注册就地自愈；不受列表开关影响（§3.4） |
| `GET /sessions` | 会话列表；缺省关闭，返回 404 `session_list_disabled`，仅 `server.sessionList: true` 时可用；`?archived=1` 同受此门，开启后只列归档 |
| `GET /sessions/:sessionID/compactions` | 压缩历史：durable boundary + append-only 事件日志 + 当前 live/cache 按摘要去重合并，旧到新返回 `{sessionID,events[]}`；无压缩史=`events:[]`（详见 §5.4） |
| `GET /sessions/:sessionID/compaction` | 旧 live 单快照（已弃用：仅当前/最后一次 active 摘要，只作旧前端回退；多卡历史以 `/compactions` 为准） |

**事件流（SSE）**：`GET /events`（订阅全量事件流）
- 帧只有 `data:` 行（**无 `event:` 行**，前端 onmessage 兼容）；信封 `{payload:{type,properties}}`；`session.idle` 必带 sessionID；id 一律无连字符；`Last-Event-ID` 头重连自动从当日 trace 补发后切 live。
- 会话域自有帧包括 `session.status`/`session.idle`/`session.error` 与待发队列快照 `session.queue`；后者 properties=`{pending:[{text,at,state}],sessionID}`，见 §5.1。

### 5.1 忙时消息、抢占与队列（W54/W55/W56）

`POST /sessions/:sessionID/messages` 在会话忙时的行为由 `server.interruptOnSend` 决定。两条路径都保留：true（生产）会打断在途 turn 并抢占；false/键缺席才走 W54/W55 的排队与 steer。

**A. `interruptOnSend: true`（当前生产）**
- 新消息 `unshift` 到队首，立即 `abort("send:interrupt")` 在途 turn，HTTP 202 返回 `interrupted:true`（不带 `queued`）。
- 被 abort 的 turn 收尾后，队首这条新消息成为下一轮 prompt；原队列项保持原序，作为 followers 合并进该轮，不丢弃、不重排。
- 该分支不检查 10 条容量闸，也不把新消息 steer 进即将 abort 的轮（避免与 abort 竞态；新消息的定位就是下一轮 prompt）。

**B. `interruptOnSend: false` 或键缺席（W54/W55 旧语义）**
- 新消息按 FIFO 入队，上限 10；满时 409 `session_busy`，响应带 `queueCapacity` 与 `queueLength`；受理成功返回 202 `queued:true`。
- 消息受理后立即 steer 进在途轮 inbox，在下一个 turn 边界（下一次 LLM 请求前）注入，随本轮 flush 按真实对话顺序落盘（前序 toolResult 在前），每条只消费一次。**只有这条路径保留旧的排队不打断语义。**
- 受理时刻不写 store、不发 user echo；sidecar 只存 `{text,at}`。收尾 settle 用 store 中 `(content,timestamp)` 证据决定摘队或留给下一轮。
- run 以成功/abort 收尾时，队列中未消费项合并进下一 run 的首次 LLM 请求（队首作 prompt，其余 steer），只新增 1 个 run；run 以 error 收尾时不合并，退回逐条出队，避免失败重试反复重挂整队列。
- 重启恢复先 hydrate，再按 `(content,timestamp)` 对账：历史中已存在的项只从 sidecar 剔除，缺失项重新入队；全部命中时只清账，不起合成 run。

**共同点与可见性**
- 两条路径下，abort 都只停当前 turn，不清队列；未落盘项只在内存 + sidecar，重启可恢复。
- 队列每次变化都发 SSE `session.queue`，properties 含 `pending:[{text,at,state}]`，state=`queued`/`running`/`drained`；空队列也发，前端据此清空。
- Web 会话页把待发消息渲染在转录之外的独立 pending 区：首次 `GET /pending` 拉取，之后由 `session.queue` 驱动；消息离开 pending 区即表示已过 turn 边界落盘，前端补拉 history。
- 队列容量 10 只约束 B 路径；A 路径的抢占发送不受该闸限制。

### 5.2 瞬时 LLM 重试语义（W42a/W42c）

- `attempt` 是 `_phaseLlmCall()` 内的局部变量（`let attempt = 0`），只属于一次 LLM call，不是会话生命周期计数器。每次新的 LLM call、每次新的用户发送都从 0 开始；一次成功发送后的下一次发送也从 0 开始。
- `llm.errorRetries` 缺省 2（core 构造参数名 `llmErrorRetries`；当前生产显式写 `llm.errorRetries: 2`）：初发 1 次 + 最多重发 2 次 = 单次 LLM call 最多 3 次发送。设为 0 即禁用重试。
- 日志 `[llm-retry] 重发 attempt 2/3` 表示这是最多 3 次发送中的第 2 次（首次重发），不是"已经重试 2 次"。
- 重试发生在同一个 turn 内：不经过 `_runOneTurn` 返回、不 flush、不推进 `turnIdx`，不消耗回合数。
- 退避为 `base × 2^attempt`，base 缺省 1000ms，即 1s、2s；等待窗口对 abort 敏感，abort 后不再重发。
- 只重试瞬时 provider 失败：resolve 出的 `stopReason:"error"`，或 `stopReason:"aborted"` 且本地 abort 信号未触发（provider 侧断流）。
- 不重试 context overflow（`length` 或 overflow 文案）、真实用户 abort、`stream()` 同步抛出的连接/配置类错误。中间失败 attempt 的残骸不入转录，只有终态 attempt 落账。

### 5.3 read 工具图片护栏

`read` 在图片 base64 进入模型上下文之前做硬拦截，按文件头识别 png/jpeg/gif/webp：

| 检查 | 上限 | 说明 |
|---|---|---|
| 文件字节 | 10 MiB（10,485,760 字节） | 超限直接工具错误；base64 后约 13.3MB |
| 单边像素 | 4096 | 宽或高任一超限即拒绝 |
| 总像素 | 16,000,000 | 宽×高；单边检查之后再做总像素检查 |

- 尺寸无法解析（头部损坏、格式不支持）同样拒绝，不把疑似坏图送给视觉模型。
- 实测：`1027x15000` 与 `1236x9665` 均被拒（单边超 4096）；`1200x1277` 通过（约 153 万像素）。
- 错误文案会提示切段或降采样后重读。护栏只作用于图片读取，文本读取路径不变；阈值来自工具常量 `DEFAULT_MAX_IMAGE_DIMENSION=4096`、`DEFAULT_MAX_IMAGE_PIXELS=16_000_000`（16000000）、`DEFAULT_MAX_IMAGE_BYTES=10*1024*1024`，可由工具构造参数覆盖。

### 5.4 压缩历史与当前生产配置

压缩历史是拉取面，不通过 SSE 推送完整列表。Web 会话页打开或刷新时读取 `GET /sessions/:sessionID/compactions`，每条事件渲染为一张独立分隔卡（旧到新）。

- 数据面合并三类来源：store 中的 durable `compaction_boundary`、`state/session/compaction/{sid}.events.jsonl` 的 append-only 观察日志、当前 live/最后一次 cache 快照。
- 按摘要全文 sha256 去重，再按 `(anchorTimestampMs ?? recordedAt), recordedAt` 升序排列；未知会话 404，已知但从未压缩返回 `events: []`。
- 旧的单快照接口只保留给前端对旧服务的兼容回退，不再作为压缩历史的文档主口径；多卡 UI 一律以 `/compactions` 为准。

当前生产配置快照（2026-10-21，实例 `.loom/config.yaml`；这是部署声明值，不是框架硬编码缺省）：

| 键 | 值 | 说明 |
|---|---|---|
| `compaction.enabled` | true | 主会话压缩开启 |
| `compaction.fallbackTokens` | 750000 | worker 路径开关；LLM 调用前估算 ≥ 该值触发 fallback 压缩（声明后才启用 worker） |
| `compaction.watermark.levels` | [300000, 500000, 600000] | 投影请求体积跨档时注入一次性 `system-reminder`（每档至多一次） |
| `compaction.requestTimeoutMs` | 300000 | 每次摘要调用超时 300s |
| `compaction.retryCount` | 10 | 单 attempt 共享的瞬时重试预算 |
| `compaction.keepRecent` | 8 | recent tail 条数下限 |
| `compaction.keepRecentTokens` | 15000 | recent tail token 预算（与条数下限取更长 tail） |
| `compaction.resummarizeEvery` | 16 | 覆盖前缀每增长 16 条才重算摘要 |
| `compaction.summaryMode` | auto | 预算内单次；超预算递归拆分，叶子回退分块 |
| `compaction.summaryReasoningEffort` | low | 仅覆盖摘要调用思考强度 |
| `compaction.summaryChunkTokens` | 100000 | 仅 chunked/递归叶子的分块上限 |
| `compaction.singleCallBudgetTokens` | 缺席 → 813136 | 由模型窗口推导：`floor(1,000,000×0.85) − min(maxOutput=32,768, 32,768) − 4,096` |
| `compaction.boundary` | true | 落 durable `compaction_boundary`（`coveredCount`/`tailIncluded`） |
| `compaction.stream` | flushIntervalMs 50 / flushMaxBytes 4096 | 压缩 SSE 节流 |
| `compaction.microcompact` | enabled true；triggerTokens 150000；targetTokens 60000；keepRecent 5 | 先微压缩；`compactableTools` 同时驱动摘要输入投影 |
| `compaction.maxContextTokens` | 缺席 | 仅 legacy hook 路径读取（worker 不看该键） |
| `compaction.summaryTimeoutMs` | 缺席 | 仅 legacy hook 路径使用，缺省 60000 |

`maxContextTokens` 与 `summaryTimeoutMs` 缺席是有意为之：生产 worker 用 `fallbackTokens` + `requestTimeoutMs`，这两个键只服务 legacy autoCompaction 路径（未声明 `fallbackTokens` 时）。单次预算未显式声明，由 `models[0]` 的 `contextWindow=1,000,000` 与 `maxOutput=32,768` 推导为 `floor(1,000,000×0.85) − min(maxOutput, 32,768) − 4,096 = 813,136`。上表是部署声明值，不是框架硬编码缺省。

#### 5.4.1 压缩实现（2026-10-21）

**两条路径。** 生产实例声明 `compaction.fallbackTokens`，摘要 worker 由 `buildSessionCompactionOptions` 接管；`buildCompactionHooks` 按配置仍挂 `microcompact` 与 `boundary` 钩子，但不再挂 `autoCompaction`。未声明 `fallbackTokens` 的部署仍走 legacy `autoCompaction` hook：`maxContextTokens`/`triggerRatio`/`summaryTimeoutMs` 只在那边生效，摘要用 9 段模板 + `completeText` 非流式调用。

- **手动压缩**：`POST /sessions/:sessionID/compact` 先 `loop.hydrate()` 再 `startCompaction("manual")`。重启后 durable 转录已回放，不再对空 `_messages` no-op；受理即 202，压缩事件由 per-session publisher 发 SSE。
- **快照与投影**：worker 取 raw 快照，按 `keepRecent`/`keepRecentTokens` 保留 recent tail；旧的、`compactableTools` 白名单内 toolResult 投影为 `[microcompact: <tool> output cleared, ~N chars]`（完整工具输出仍在 durable 存储，可按需重取）。投影只改摘要入参，不改进 commit 的 raw 坐标。
- **单次/递归 auto**：`summaryMode: auto` 下，投影后前缀估算 ≤ 单次预算则恰好一次 `streamText` 摘要调用；超预算则按消息边界递归左右拆分，`summaryMaxSplitDepth` 缺省 2，到达深度的超预算叶子回退到 `summaryChunkTokens` 分块 map-reduce。`single` 强制单次，`chunked` 保持旧分块。
- **模板与思考强度**：worker 的 ops 视角用 compact-6 handoff 模板（Primary Request and Intent / Confirmed Decisions and Constraints / Files, Paths, and Resources / Errors and Fixes / Current Work / Next Step，约 1500 词，不罗列全部用户消息），chat 视角用六段聊天延续模板；legacy hook 仍用 9 段模板。`summaryReasoningEffort` 只覆盖摘要调用，不影响主会话。
- **双视角摘要（2026-10-22）**：worker 路径默认对同一投影前缀跑两趟独立摘要，按 ops、chat 顺序流式输出并带 `perspective` 标签，拼成一条 `summaryText`：`[auto-compacted summary of N earlier messages]\n## OPS STATE\n\n<ops>\n\n## CHAT STATE\n\n<chat>`。两段同轮注入，只有一个 `coveredCount` 与 boundary（`tailIncluded:false`），重放不变，持久化与 API/UI 仍只见一个 `summaryText`；chat 六段为 Relationship and Tone / User Preferences and Standing Instructions / Emotional Threads / Open Personal Loops / People, Places, and Projects in Play / Voice Anchors（模板标签为英文，实际输出随对话主语言本地化），用对话主语言而非任务报告口吻。`compaction.summaryPerspectives` 缺席即 `["ops","chat"]`，`["ops"]` 立即回退单 ops 摘要（与旧单输出字节同形），该键须声明 `fallbackTokens`、非空、不重复且含 `ops`；legacy 路径（无 `fallbackTokens`）仍单份 9 段摘要、无 chat 视角。代价：worker 摘要工作量约翻倍。
- **瞬时重试**：每次摘要调用受 `requestTimeoutMs` 约束，整次 attempt 共享 `retryCount`。超时、网络、限流与 `Stream ended without finish_reason` 等截断流按 transient 重试；同一 attempt 内复用同一 messages 引用。
- **boundary 与重放**：成功 commit 写 `tailIncluded: false` 的 durable `compaction_boundary`，`coveredCount` 是 raw 坐标；重放 = summary + 未被覆盖的 tail。legacy boundary 的 summary 内嵌 tail（`tailIncluded: true`）；最后一条 legacy boundary，或下一条是显式 worker boundary 的 transition boundary，保留自己的 tail（transition lookahead）。`coveredCount` 单调推进；历史视图按摘要 sha256 去重。
- **失败语义**：摘要或 commit 任一失败即 all-or-nothing：不写 boundary、状态落 `retry_pending`、旧 summary 原样保留；下一轮 LLM 前可自动重试。
- **已知残留**：更早的 B4989 风格非最后 legacy boundary，若下一条没有显式 marker，其 tail 不会被救援；`noop` outcome 没有 SSE 终态帧。

**任务域（副会话/工作流）**
| 方法 路径 | 作用 |
|---|---|
| `POST /runs` | 手动派发任务 |
| `GET /runs` / `GET /runs/:runID` | 运行列表/详情（queued/admitted/running/done/failed/partial） |
| `POST /runs/:runID/cancel` | 取消（actor 落账；副会话不得控制副会话） |
| `POST /runs/:runID/rerun` | 重跑（新会话、attempt+1、parent_run 溯源） |
| `GET /pause` | 全局/按工作流暂停开关查询 |

**运维域**：`GET /health`（uptime/version）、`GET /config`（脱敏：credentials 只回 `${VAR}` 名）、`GET /config/audit`（热载审计）、`GET /catalog/models`。

curl 示例：
```bash
H="Authorization: Bearer $LOOM_TOKEN"
curl -s -H "$H" http://127.0.0.1:5100/health
curl -s -X POST -H "$H" -H "content-type: application/json" \
  -d '{"content":"你好"}' http://127.0.0.1:5100/sessions/ses_xxx/messages
curl -N -H "$H" http://127.0.0.1:5100/events   # SSE 收流
```

## 6. 任务（workflow）定义

一个任务=一个 yaml（生产在 `ai/config/triggers/`，形状迁移自 `data/tasks/*.yaml`）：

```yaml
name: 今日复盘
schedule:                # 三型：daily "HH:MM" / weekly {days: mon, at} / monthly {1: "18:30"}
  daily: "00:30"
enabled: true            # 单任务热开关
catchup: latest          # 漏触发策略: latest(只补最近)/all(全补)/none(丢弃)
prompt: |-
  1. 运行: python analysis/check_coverage.py {昨天日期}
  2. 子智能体: task(subagent_type="reviewer", prompt="读 agents/02-daily-review.md 执行, date={昨天}")
  3. 子智能体自查后 git add/commit；主智能体验收输出
```

生命周期（全自动）：到点→**expected 先落账**→fresh 副会话执行→收束终态(done/partial/failed)→回执验证(声明产物存在+哈希核验)→投递主会话。
兜底：自动续跑=同会话 resume；追赶/手动重跑=新会话；重试超限→**死信进主会话**，绝不静默。
写 prompt 心法：副会话每次都没有记忆——背景靠 §4 注入，路径写工作区相对路径，验收标准写死在 prompt 里。

## 7. 子智能体

- 定义=workspace `agents/*.md`（frontmatter 声明可用类型；内置 general/explore）。活例 fixture-workspace/agents/01-data-check.md：身份声明+职责边界+验收标准。
- 主会话内 `task(subagent_type=..., prompt=...)` 派发；派发闸与轮数上限由实例配置 `subagent.maxFanout`/`maxDepth`/`maxInflightTotal`/`maxTurns` 决定（缺省 8/2/16/50）；`subagent.*` 改配置 + 重启生效，无热重载通道；父取消自动传播子。
- `subagent.maxTurns`（整数 ≥1，缺省 50）：task 派发的子会话（同步与后台）轮数硬顶；到顶以 `reason=max_turns` 终止。生产实例将声明 150，这是部署值，不是框架缺省。
- 作用边界：`maxTurns` 只管 task 子会话；不约束主会话、副会话（`POST /runs` 起的 side/scheduled 会话），也不约束收束闸 `convergence.turnHardCap`。
- 观测面：启动日志 `loom subagent limits {fanout, depth, inflight, turns, source, turnsSource}`；`source` 判前三键来源，`turnsSource` 单独判 `maxTurns` 来源。
- 结果以工具结果形态回灌主会话；输出含 `<task_metadata>...session_id: ...</task_metadata>` 块（前端反解父子关系用）。
- **按 agent 分配模型（W53）**：定义文件 frontmatter 写 `model: <models[].id>`，该类型子会话即用对应模型句柄与凭据；不写 `model:` = 继承主模型。主会话/副会话/压缩恒用 `models[0]`。
  - 未知 id：装配期只 `warn`（`loom agent model unresolved`，服务照常起），派发该 agent 时返回响亮 tool error（列出可用 id），**绝不静默回落主模型**。
  - 新增/改 `model:`、改 `models[]` 或凭据需重启 loom；仅改 agent 正文无需重启（spawn 时重读）。

### 7.1 模板与 A/B 对照

agent 定义（`workspace/agents/local_compare.md`）：

```markdown
---
name: local_compare
kind: sub
model: qwen3.8-27b
description: 本地模型对照子智能体（测试用，不参与生产分析批次）
---

<正文 = 该子智能体的 system prompt>
```

配置侧（`loom.yaml` 片段；`models[].id` 必须与 frontmatter 的 `model:` 完全一致）：

```yaml
providers:
  - provider: local-vllm
    baseUrl: http://127.0.0.1:8000/v1
models:
  - id: qwen3.8-27b
    provider: local-vllm
    contextWindow: 262144
    maxOutput: 32768
    timeout: 300000
credentials:
  local-vllm: ${LOOM_KEY_LOCAL}   # 无鉴权端点也要占位值（loom 按 provider 取凭据）
```

A/B 操作：

1. 用同一 prompt 分别派 `local_compare` 与 `general`（或另一个未声明 `model:` 的 agent）。
2. 从 task 结果 `<task_metadata>` 取子会话 sid，`GET /sessions/<sid>/context/full` 读 `wire.model.id`，确认实际使用的模型。
3. `GET /sessions/<sid>/history` 取两侧完整输出并对比。

新增模型不会改变现有链路：只有声明了 `model:` 的子会话切换模型，主会话/副会话/压缩仍走 `models[0]`。

### 7.2 交互式终端（PTY）

- 工具五件套：`pty_spawn` / `pty_write` / `pty_read` / `pty_list` / `pty_kill`（node-pty 后端，后台交互式会话，不阻塞回合）。
- 退出回调：`pty_spawn` 默认 `notifyOnExit: true`。进程退出（自然退出或 timeout 自动杀）时生成 `<pty_exited>` 通知并投回**发起会话**：会话空闲则经 `SessionRegistry.deliverWake` 立即起唤醒轮（通知行 = 该轮 durable user 消息）；会话忙则通知行入 durable send 队列，当前轮收尾后自动起新轮（不依赖 transient 边界提醒，避免收束前滞留丢失）。设 `false` 则不唤醒，只能靠 `pty_read` 轮询。
- 配置（`.loom/config.yaml`，整段可缺省）：`pty.enabled`（缺省 true）、`pty.maxSessionsPerLoomSession`（缺省 16）、`pty.maxSessionsTotal`（缺省 64）。输出缓冲 1,000,000 字符，超限丢最旧；超过上限的 spawn 响亮拒绝。
- 安全口径：spawn 前经 D7 缝 `authorizeTool`（`pty_spawn` 显式 allow，deny/net/cwd/审计与 bash 同源）；cwd 必须在 workspace 内（进入 shell 后可交互 cd，逃逸面与 bash 相同）；环境变量经 `scrubPtyEnv`（`safeShellEnv` + `LOOM_`/`AXEUH_`/`OPENCODE_`/`MI_`/`MOP_` 前缀剥离），服务令牌与模型密钥不会进入终端。
- 归属：PTY 按发起会话隔离（读写杀只能操作本会话的 id）。子智能体持有的 PTY 退出通知投其子会话——子会话不在主 `SessionRegistry` 中，因此不会唤醒主会话；需要主会话续跑的 PTY 应由主会话发起。
- 输出现经工具结果面呈现（无独立终端 UI）；`pty_read` 支持行号分页与安全正则过滤（拒绝高危回溯模式）。

## 8. 观测与审计（一切可回放）

`state/` 目录（append-only jsonl，唯一真源）：

| 路径 | 内容 |
|---|---|
| `state/trace/{date}.jsonl` | span 骨架 queued→admitted→assembly→turn[i]→tool[j]→summary→delivered；token in/out、缓存命中、供应商、nudge、重试原因 |
| `state/ledger/{date}.jsonl` | 任务账本 expected/actual（对账器输入） |
| `state/session/{id}.jsonl` | 会话转录，N-turn 分片+目录索引（增量读，永不全量回放，D20） |
| `state/session/queue/{sid}.json` | 忙时待发队列 sidecar（`{text,at}`，重启按 `(content,timestamp)` 对账恢复） |
| `state/session/compaction/{sid}.events.jsonl` | 压缩摘要 append-only 观察日志（与 durable boundary 合并成 `/compactions` 历史） |
| `state/config/{date}.jsonl` | 配置 applied 审计（前后 hash） |
| `state/inbox/` `state/dead-letter/` | 待投递 / 死信 |

分析脚本改读这些文件（替代 opencode.db 的 D2 方案）：聚合统计在脚本侧算，loom 不开聚合端点。

## 9. 双通道运维（转正+兜底）

- **切换**：后端 `config.yaml` `ai_backend: loom` → 重启 axeuh-health；opencode(5096) 全程不停。
- **回退**：`ai_backend: opencode` → 重启即回老链路（秒级）；loom 的 state/ 数据保留不清（再切回无缝）。
- 两套会话数据互相独立，切来切去不会串台；观察期指标见 docs/04 §8（trace span 完整率、账本零缺口、死信数、缓存命中率）。
- loom 进程监督：systemd `axeuh-loom.service`（Restart=always）；日志 `journalctl -u axeuh-loom`；改任何配置前 `cp -a` 备份（项目红线）。

## 10. 故障排查

| 症状 | 定位 | 处置 |
|---|---|---|
| 启动即退，报"未配置服务令牌" | LOOM_TOKEN 未注入 | env/EnvironmentFile 检查 |
| 启动即退，报 `${VAR}` 无法解析 | credentials 引用 env 无值 | 补 LOOM_KEY_*，fail-fast 是设计 |
| 启动即退，报内联密钥 | loom.yaml 写了密钥字面量 | 改成 `${ENV}` 引用 |
| 改了配置没生效 | 校验被拒 | `GET /config/audit` 看拒绝原因（旧配置在服务，无崩） |
| 回合不结束 | 收束字段不齐在催办 | 看 trace nudge 计数；5 次后自动升级，60 轮硬顶兜底 |
| UI 卡 120s 无 idle | 前端链路漏 session.idle | 查 `/events` 帧；loom 侧 idle 必带 id（契约测试已锁） |
| 任务没跑 | 到点被暂停/enabled:false | `GET /pause`；catchup 策略决定补跑行为 |
| 端口占用 | 非 loom 进程抢 5100 | `ss -tlnp`，只按 PID 处置，禁按名杀（项目红线） |

---

*配套文档：决策=docs/01 · 实现计划=docs/02 · 影子验证=docs/03 · 切换清单=docs/04 · HTTP 选型=docs/05。*
