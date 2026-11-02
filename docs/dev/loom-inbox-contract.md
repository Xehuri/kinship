# Loom 统一收件箱（letters）契约冻结

> 本文档在不动生产行为的前提下，冻结 Loom 异步收件箱（letters）的契约。
> 所有字段/语义均对照现有代码落点，引用格式 `文件:行`。
> 生产代码落点：`loom-harness/packages/server/src/session-api/registry.ts`（send ~586、deliverWake ~423）、
> `loom-harness/packages/core/src/main-loop/boundary.ts`（deliver ~79、remind ~91）。

## 0. 动机与范围

在改动 `send` / `deliverWake` / `boundary` 行为之前，先冻结契约并用表征测试（characterization test）
证明当前行为。本文档只描述**目标契约**；实现该契约后，既有 `send`/`deliverWake` 的语义被复用而非替换：

- `interrupt`（抢占式）→ 走 `registry.send()`（`registry.ts:586`），`interruptOnSend === true` 时 abort 当前轮。
- `notify`（通知）→ 走 `registry.deliverWake()`（`registry.ts:423`），**永不 abort**。
- `digest`（摘要）→ 入账 ledger + 一次计划摘要唤醒，pull-only。

## 1. Letter schema（信体）

| 字段 | 类型 | 说明 | 来源 |
|------|------|------|------|
| `id` | string | 服务端分配，提交后回填（类比 `WakeQueueEntry.id` `wake-queue.ts:41`） | 服务端 |
| `source` | string | 已注册来源键（`inbox.sources.<key>`，`[a-z0-9_.-]{1,64}`），如 `qq` / `backend.tasks`；未注册来源拒绝 | 路由/网关 |
| `kind` | string | 单行 kind 标签（来源定义，如 `system_note` / `reminder_digest` / `inbox_letter`），≤64 字符 | 来源 |
| `class` | enum | `interrupt` / `notify` / `digest` | 路由决策 |
| `trust` | enum | `external` / `trusted_service` / `user` | 来源信誉 |
| `principal` | string | 发起方标识（QQ 号 / 服务名 / 用户）；必填、无控制字符 | 网关 |
| `created_at` | number(ms) | 入箱时刻 | 服务端 |
| `not_before` | number(ms) | 最早可投递时刻（quietHours 生效前不推） | 调度 |
| `expires_at` | number(ms) | 过期即丢弃/死信（参考 `wake-queue.ts:284` isExpired 口径） | 分类器 |
| `title` | string | 单行标题（bounded，默认 ≤ 200 码点） | 来源 |
| `body` | string | 正文（非空；UTF-8 字节 ≤ `inbox.limits.maxBodyBytes`，消费层缺省 16384；越界 413） | 来源 |
| `ref` | JSON? | 关联资源（run id / session id / url / 结构化对象）；JSON 序列化 ≤2KB | 来源 |
| `correlation_id` | string? | 同类关联（追问链/同源多次投递） | 来源 |
| `dedupe_key` | string? | 幂等去重键（同源同键 → 200 duplicate，参考 `wake-queue.ts:439` delivered 抑制） | 来源 |
| `coalesce_key` | string? | 合并键（同键多次 notify 折叠为一条 still_pending） | 来源 |
| `reply_to` | string? | 本信回复目标（若有） | 来源 |
| `causation_depth` | number | 因果链深度（0=直接来源，>0=转发/派生） | 路由 |

> 注：`source` 与 `trust` 是两个正交维度——`source` 回答"从哪来"，`trust` 回答"可信度"；
> `QQ @` 是 `external` 且 `trust=external`，内部服务回调是 `trusted_service`。

## 2. Class 语义表

| class | 投递通道 | 是否可能 abort 当前轮 | 落盘形态 | 可见性 |
|-------|----------|----------------------|----------|--------|
| `interrupt` | `registry.send()`（`registry.ts:586`） | 是：仅当 `interruptOnSend === true`，`busy` 时 unshift 队首 + `loop.abort("send:interrupt")`（`registry.ts:589-595`），返回 `interrupted:true` | durable user 消息（进 `loop.messages`、`session.messages`、HWM） | 实时推 |
| `notify` | `registry.deliverWake()`（`registry.ts:423`） | **否**：直接 `push` 入 send 队列，`running===null` 时 `#drainQueue` 立即起轮（`registry.ts:443`），busy 时等当前轮收尾后 `#drainQueue`，绝不 abort | durable user 消息（同 interrupt 落盘面） | 实时推 + 待发可见 |
| `digest` | ledger 入账 + 一次计划摘要唤醒（`wake-queue.ts` 计划来源） | 否 | 仅 ledger（pull 实体），不入实时推送 | pull-only |

落盘形态对照：`TurnBoundary.deliver()`（`boundary.ts:79`）入 `_inbox`，在 `onTurnStart` 边界
经 `ctx.appendMessage` 持久注入（进 `session.messages`，随 HWM 落盘，resume 可见）——这是
"回执/信件是对话事实"的实现位，与 `remind()` 的 transient 通道（`boundary.ts:91`，绝不进转录）严格区分。

## 3. Push envelope（推送信封）规则

外部内容投递必须满足：

1. **单一 user-role 消息**：一个信封 = 一条 user 消息；绝不为外部内容生成 `system` role
   （`TurnBoundary.deliver` 拒收非 user role，`boundary.ts:81-86` fail-loud）。
2. **bounded preview + counts + included_ids + still_pending**：信封携带摘要预览、包含条数、
   已含 letter id 列表、尚未投递条数（对应 `WakeQueueSnapshot` `wake-queue.ts:95` 的 entries/delivered 形态）。
3. **外部内容 fence + label**：`external` 内容必须围栏并标注来源（如 `[external:QQ:12345]`），
   明确区分"模型自述"与"外部转述"。
4. **transient 提醒不进信封正文**：`remind()` 注入走 `additionalContext`（`boundary.ts:126-129`），
   只进下一次 LLM call 的 messages view 尾部、不落 `session.messages`/转录（`boundary.ts:15-19`）。

## 4. Pull tools（拉取工具）

| 工具 | 作用 | 关键纪律 |
|------|------|----------|
| `inbox_list` | 列待处理信件（按 `class`/`not_before` 过滤） | 不含已 ack；返回 `still_pending` 计数 |
| `inbox_read` | 读取单封/批量信件全文 | 不消费（ack 由独立动作触发） |
| `inbox_ack` | 确认处理（见 §5 规则） | per-letter；`delivered != acked` |
| `inbox_defer` | 延后到 `not_before` | 不改 `expires_at` 以上限 |

### 5. ack 规则

1. **FYI 自动 ack**：`class=notify` 且 `kind=system_note`/纯告知（无 action 期望）的信件，模型读后即自动 ack。
2. **action 需 evidence_ref**：要求模型执行动作的信件，ack 必须附带 `evidence_ref`（落盘/工具调用证据），
   否则 ack 视为无效（防止"已读乱回"）。
3. **delivered != acked**：投递（进会话/落盘）与 ack（模型确认处理）是两件事；`deliver` 是 durable，
   `ack` 是独立动作（类比 `delivered`/`entries` 在 `wake-queue.ts:41-66` 的双集合）。
4. **per-letter ack**：逐封 ack，不支持批量模糊 ack。
5. **redelivery / dead-letter**：`expires_at` 前未 ack 且 `trust=external` 高优 → 重投一次；
   重投仍失败 → 死信（参考 `wake-queue.ts:915-936` 唯一一次重试 + `onDeadLetter` 口径）。

## 6. HTTP 响应表（POST /inbox/letters）

| 状态码 | 含义 | 触发条件 |
|--------|------|----------|
| 202 | accepted | 入箱成功，将异步投递/入账 |
| 200 | duplicate | `dedupe_key` 命中已投递（`wake-queue.ts:439` suppressed/duplicate 口径） |
| 400 | validation | 字段非法/缺失/`class` 未知 |
| 401 | auth | 缺/错 Bearer（与既有 `session-api` 路由 401 同门，见 `session-api.test.ts:407`） |
| 403 | source/trust | 来源或信任级别不被该 inbox 实例允许 |
| 413 | body too large | `body` 超 `inbox.limits.maxBodyBytes` |
| 429 | rate limited | 超过 `inbox.sources.<key>.ratePerMinute` 或 `inbox.limits.maxLettersPerMinute` |
| 503 | inbox disabled | `.loom/config.yaml` `inbox.mode === off` 或实例未装配 |

当前代码尚无 `/inbox/letters` 路由（grep 全仓无命中），本表为目标契约；路由层可复用
`registerSessionRoutes`（`routes.ts:148`）与 `respondSend`（`routes.ts:96`）的 202/409 框架。

## 7. 配置键（`.loom/config.yaml` 的 `inbox` 段）

所有键均为**可选**；整段缺省 = 不物化，消费层缺省 `mode=off`（旧行为：无外部信箱）。
未知键静默容忍；非法值 fail-fast 并在错误中点名精确键。缺省值集中在
`loom-harness/packages/server/src/inbox/defaults.ts`，schema 不伪造用户未写的值。

| 键 | 类型 | 说明 |
|----|------|------|
| `mode` | `off / shadow / live` | off=不装配；shadow=只落账观测（`route=observed`）；live=入库并允许路由投递 |
| `sessionId` | string | 收件箱账本文件名（`<stateRoot>/inbox/<sessionId>.jsonl`）；缺省由消费层选主会话 |
| `sources` | map | source 注册键 → 来源配置；未注册来源一律抑制 |
| `sources.<key>.maxTrust` | `external / trusted_service / user` | 该来源可声明的最高 trust；只向下钳制 |
| `sources.<key>.maxClass` | `digest / notify / interrupt` | 该来源可请求的最高 class；只向下钳制；`maxTrust=external` 时不得为 `interrupt` |
| `sources.<key>.ratePerMinute` | 正整数 | 每分钟最多尝试次数；超限降一档 |
| `sources.<key>.burst` | 正整数 | 1 秒内最多尝试次数；超限降一档 |
| `sources.<key>.cooldownMs` | ≥0 整数 | 两次投递最小间隔；未到期降一档 |
| `sources.<key>.requireDedupeKey` | boolean | 强制 `dedupe_key`，缺失则抑制 |
| `sources.<key>.tokenEnv` | string | 鉴权 token 的环境变量名（只存名字，不存值） |
| `limits.maxBodyBytes` | 正整数 | `body` UTF-8 字节上限（消费层缺省 16384） |
| `limits.maxPending` | ≥0 整数 | 未终结信件积压上限（超过抑制新信件；缺省 1000） |
| `limits.maxLettersPerMinute` | 正整数 | 全局速率上限（缺省 120） |
| `digest.cadenceMs` | 正整数 | 摘要唤醒节拍（缺省 15min） |
| `digest.maxAgeMs` | 正整数 | 摘要信件最长等待（缺省 6h） |
| `digest.maxBatch` | 正整数 | 单次摘要最多条数（缺省 20） |
| `digest.leaseMs` | 正整数 | 摘要租约（缺省 60s） |
| `classes.weights.interrupt / notify / digest` | >0 数字 | 仅 policy 内部排序，必须单调不增；不进入 decision/prompt/日志/HTTP |
| `accumulate.notifyBurst` | 正整数 | 窗口内 notify 达到该次数 → digest（缺省 3） |
| `accumulate.windowMs` | 正整数 | notify burst 统计窗口（缺省 5min） |
| `quietHours.enabled` | boolean | 是否启用静默时段 |
| `quietHours.start` / `end` | `HH:MM` | 本地静默区间（start > end 视为跨夜） |
| `quietHours.timezone` | string | 合法 IANA 时区名；`enabled=true` 时必填 |
| `quietHours.downgradeExternalInterruptTo` | `notify / digest` | 静默期 external interrupt 的降级目标（缺省 notify） |
| `redelivery.maxAttempts` | ≥0 整数 | 重投次数上限（缺省 1） |
| `redelivery.backoffMs` | ≥0 整数 | 重投退避（缺省 30s） |
| `ackGraceTurns` | ≥0 整数 | 未 ack 存活的轮数上限（缺省 2） |
| `autoAckKinds` | string[] | 自动 ack 的 `kind` 集合（无重复） |
| `dedupeTtlMs` | ≥0 整数 | 去重键保留时长（缺省 48h） |
| `coalesceWindowMs` | ≥0 整数 | 合并窗口（缺省 30min） |
| `echo.maxCausationDepth` | ≥0 整数 | 因果链深度上限（缺省 32） |
| `echo.blockedSources` | string[] | 禁止回显的来源键列表（无重复、匹配 source 键正则） |
| `planMirror` | boolean | 是否在每轮 plan 注入信箱待处理计数（缺省 true） |
| `metricsIntervalMs` | 正整数 | 信箱指标采样间隔（缺省 60s） |

> `source` 与 `trust` 仍是两个正交维度：`source` 回答"从哪来"（注册键），
> `trust` 回答"可信度"（external/trusted_service/user）。调用方只能请求 `class`；
> 数值 score/weight 一律由 policy 内部计算，不进入请求/响应/日志。

## 8. 明确非目标（non-goals）

1. **用户聊天不进收件箱**：`POST /sessions/:sessionID/messages`（`routes.ts:220`）是聊天主通道，
   与 `/inbox/letters` 是两个端点；用户直接输入走 `registry.send`，绝不经 inbox 路由。
2. **plan anchors 不进收件箱**：计划锚点（`anchor_targets.yaml`、Plan mode、`plan-scheduler.ts`）是
   独立的计划/唤醒来源（`wake-queue.ts` `source:"plan"`），按 `WAKE_QUEUE_SOURCES`（`wake-queue.ts:21`）
   三来源（plan/flow/special）路由，**不**经 inbox 分类器。
3. **不新增第二调度器/队列/数据库**：复用既有 `WakeQueue`（`wake-queue.ts:523`）、`SessionRegistry`
   的 send/deliverWake、`TurnBoundary`，**不**另起 scheduler/queue/DB（对照 Flow 退役后"无第二队列"纪律）。

## 9. 与既有行为的对齐锚点

- `interrupt` 复用 `send()` 的 `interrupted:true` 返回面（`types.ts:478`、`respondSend` `routes.ts:103`）。
- `notify` 复用 `deliverWake()` 的 durable queue + idle 直起轮（`registry.ts:440-443`）。
- `digest` 复用 `WakeQueue` 计划来源与 `reconcileSource`（`plan-scheduler.ts:6` 仅对 plan 来源对账）。
- 信封"仅 user-role"复用 `TurnBoundary.deliver` 的 role 守卫（`boundary.ts:81-86`）。
- 外部内容围栏复用既有 `delivery.notify` 帧属性通道（`registry.ts:408` `reminderNotifyProps` 同款）。

## 10. T2/T3 落地范围（2026-11-02）

T2 交付收件箱核心：配置 schema（`inbox` 段 + `checkInbox`）、信件类型与边界校验、
事件账本（`<stateRoot>/inbox/<sessionId>.jsonl`）、纯 policy、shadow 观测与测试。

T3（同日）已落地：`POST /inbox/letters`、`GET /inbox/status`、interrupt/notify/digest
投递路由（复用 `registry.send` / `registry.deliverWake`）、digest 经既有 WakeQueue 的
单条目排班、boot 装配与 `LoomClient.send_letter`。

**仍未包含**：模型 pull 工具（`inbox_list/read/ack/defer`）与 batch-ack 生命周期——
这些属于 T4；账本是 ledger，不新增 scheduler/queue/DB。
