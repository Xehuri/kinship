/**
 * AgentSession —— harness-pi 的 kernel：LLM–tool 循环、hook 派发、run/continue/abort。
 *
 * 调用方可依赖：
 *   - LLM I/O 走 pi-ai `stream()`。
 *   - 连续 `isConcurrencySafe` 的 tool 并行；unsafe 调用是屏障。
 *   - 自然结束（`reason === "done"`）后 `onContinuationCheck` 可在同一次
 *     `run()` 里再开一轮 turn loop，受 `maxContinuations` 封顶。
 *     `onSessionEnd` 每次 `run()` / `continue()` 恰好一次。
 *   - `tool.execute` throw → `isError` tool result，循环继续。
 *   - hook throw / timeout 默认 fail-open；`failClosed` 的 decision 视为 deny。
 *   - 单个 AbortController：caller `signal` 与 `ctx.abort` 共用。
 *
 * allow: SIZE_OK —— 本文件是 AgentSession 单一状态机（run/turn/llm/tool 四相 + 持久化 + live 总线），
 * 基线即 1650+ 纯 LOC；fleet 并行工单以本文件行锚协作，切片会撞面。拆分须待锚点收敛后另立主题。
 */

import {
  stream,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type Api,
  type ToolCall,
  type ToolResultMessage,
  type Usage,
  type StopReason,
} from "@earendil-works/pi-ai";

import { markDeepSeekReasoningContent } from "./reasoning-replay.js";

type AccumulatedUsageKey = "input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens";
type AssertNoExtraUsageKeys<T extends never> = T;
type _AccumulatedUsageCoversAllUsageKeys = AssertNoExtraUsageKeys<
  Exclude<keyof Usage, "cost" | AccumulatedUsageKey>
>;

/**
 * Phase 3：streaming consumer 看到的事件类型。每个事件对应一个 EVENT-category hook。
 *
 * 跟 hook event 的区别：
 *   - hook 是 plugin 写的代码（可以决断、改 context）
 *   - SessionEvent 是只读流，给外部 consumer（HTTP/WS handler / 测试）订阅
 *
 * **故意不包括的事件**（设计决定，不要"补全"）：
 *   - onPreToolUse / onUserPromptSubmit：decision-category，能改 control flow；
 *     stream 是只读视图，让 caller 决断会模糊"控制平面"边界。
 *   - transformSystemPromptBeforeLlm / transformMessagesBeforeLlm：pipe-category，
 *     是 plugin-to-plugin 的转换链，对外部 consumer 不可观察也无意义。
 *   - wrapTurn / wrapToolExec：around-category，洋葱嵌套；嵌套语义跟"flat event 流"
 *     不兼容，强行 yield 会让 consumer 看到错乱的 begin/end 序列。
 *
 * 这个 union 显式列出，让消费者用 discriminated switch 处理。新加 arm 时记得
 * 同步更新 phase3-capabilities.test.ts 的 exhaustive-switch 测试。
 *
 * **注意**：`tool-end.result.newMessages` 包含 tool 想注入的 user/system 消息，但 kernel
 * 可能在 push 进 session.messages 之前过滤掉 assistant/toolResult role 的注入。Stream
 * consumer 看到的是 raw result，不是 kernel 实际接受的 messages。
 */
export type SessionEvent =
  | { type: "session-start"; sessionId: string; source: "run" | "continue"; initialPrompt?: string }
  | { type: "turn-start"; turnIdx: number }
  | { type: "llm-end"; msg: AssistantMessage; durationMs: number }
  | { type: "tool-end"; call: ToolCall; result: ToolExecResult; durationMs: number }
  | { type: "turn-end"; turnIdx: number; toolResultsCount: number; stopReason: AssistantMessage["stopReason"] }
  | { type: "continuation-check"; turns: number; continuations: number }
  | { type: "session-end"; summary: RunSummary }
  | { type: "error"; phase: "llm" | "tool" | "hook"; message: string; hookName?: string };

/**
 * Event Bus —— **live track**（设计依据 docs/09 §3.1）。
 *
 * 与 `SessionEvent`（coarse "recorded" 生命周期事件，经 `runStreaming()` 暴露）分两条轨：
 * 这里是回合**进行中**的细粒度 token/thinking/toolcall delta，经 `session.on(type, cb)` 订阅。
 * 它们**可丢**（UI 丢几帧无所谓），不进 transcript；listener 抛错被内核隔离，绝不影响 loop
 * （借鉴 kimi LoopEventDispatcher 的 durable/live 双轨 + live listener 容错）。
 *
 * 这个 union 显式列出，让消费者用 discriminated switch 处理。新加 arm 时记得
 * 同步更新 event-bus.test.ts 的 LiveEvent exhaustive-switch 测试。
 */
export type LiveEvent =
  | { type: "message_start" }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  // `message_update`：**回合进行中**的「中间态、逐块快照」。在每个内容块边界（text / thinking /
  // toolcall 各自 `*_end`）各发一次，携带 pi-ai 截至此刻**已拼好的 `partial`**。比逐 token delta
  // **低频**（每块一次，非每 token，避免 O(n²) 流量）。
  //
  // **契约（务必看清）**：
  //   - 它是**中间快照**，不是终态。`message.content` 只含「已收尾的块」，回合还没结束。
  //   - **终态、权威**的整条消息以 `message_end`（源自 `stream().result()`）为准。
  //   - 需要终态的消费者**必须**用 `message_end`；把 `message_update.message` 当终态（例如在 mid-abort
  //     时拿最后一帧 update 当成最终结果）是**错的**——它可能缺少尚未收尾的块。
  //   - 偏好「渲染整条快照」的 UI **主动**订阅 `message_update`；偏好「自己累积 delta」的 UI **忽略**它、
  //     只订阅 `*_delta`。两类消费者互不依赖。
  | { type: "message_update"; message: AssistantMessage }
  // `message_start` 与 `message_end` **严格成对**：成功路径在 try 后 emit 一次（带 message），
  // catch 路径 emit 一次（不带 message）且必 rethrow —— 两路恰好各一次，不重复、不悬空。
  // （注意：不是 try/finally；若把成功路径那次挪进 finally 会与 catch 那次造成 double-emit。）
  // W42a 补充：**一次 turn 内**若内核按 llmErrorRetries 重发同一 LLM call，则**逐 attempt 各成对**
  // （重试=新的 LLM call）；消费者按对判流，不按 turn 计数。
  //
  // **关于 `message`**：绝大多数情况下 `message` 都**存在**——provider 把运行时 LLM 错误 / abort
  // 表达成一个 `error` 流事件，`stream().result()` 会 **resolve** 出一条 `stopReason` 为
  // `"error"`/`"aborted"` 的 AssistantMessage（不 reject），走成功路径、`message_end` **带** message。
  // 只有 `stream()` **同步抛**（如 provider 未注册）才走 catch、`message` 缺省。
  // **下游判失败应看 `message.stopReason`，不要用「message 是否存在」来判。**
  | { type: "message_end"; message?: AssistantMessage };

type LiveEventType = LiveEvent["type"];
type LiveHandler<T extends LiveEventType> = (e: Extract<LiveEvent, { type: T }>) => void;
import { HookContextImpl, getKernelInternals } from "./context.js";
import {
  HookDispatcher,
  verifyHookDependencies,
  assertCriticalDecisionHooks,
  type HookFailureSink,
  type HookDependencyWarning,
} from "./dispatcher.js";
import type {
  Hook,
  LogLevel,
  SessionConfigView,
  ToolExecResult,
  ContextOverflowInput,
  ActiveBoundary,
} from "./hook.js";

/**
 * autoCompaction 写入 `ctx.state` 的 live 境界 well-known key。
 * 内核每个 turn 结束后读取此 key、更新 `_activeBoundary`。
 * Plugin 从 `@axeuh/loom-core` import 使用。
 */
export const ACTIVE_BOUNDARY_KEY = "harness-pi.activeBoundary" as const;
import { ToolExecutor, findToolByName } from "./tool-executor.js";
import {
  createAttachmentMessage,
  filterIncompleteToolCalls,
} from "./types.js";
import type { HarnessTool } from "./types.js";
import type { SessionEntry, SessionStore, StoredEntry } from "./session-store.js";
import {
  COMPACTION_CHECKPOINT_VERSION,
  isCompactionCheckpointPayload,
  legacyCheckpointCoveredCount,
  resolveCheckpointTailIncluded,
} from "./compaction-checkpoint.js";
import type {
  CompactionCheckpointMeta,
  CompactionCheckpointPayload,
} from "./compaction-checkpoint.js";
import type {
  CompactionCommit,
  CompactionContextSnapshot,
  CompactionWorkerOptions,
  WorkerOutcome,
} from "./compaction/worker.js";
import { CompactionCoordinator } from "./compaction/coordinator.js";
import type { CompactionReason, CompactionState } from "./compaction/compaction-state.js";
import {
  CompactionFailedError,
  CompactionRecoveryRequiredError,
  type SessionCompactionOptions,
} from "./compaction/session-compaction.js";
import {
  assertValidWatermarkLevels,
  buildContextWatermarkMessage,
  contextWatermarkLevel,
  highestWatermarkLevelAtOrBelow,
} from "./compaction/context-watermark.js";
import { hybridTokenCounter } from "./plugins/token-estimate.js";
import { defaultIsContextOverflow } from "./context-overflow.js";
import { resolveLlmOptions } from "./llm-model.js";
import type { LlmOptions } from "./llm-model.js";
import { canonicalJson, snapshotWireRequest } from "./wire-capture.js";
import type { WireRequestSnapshot } from "./wire-capture.js";
import type {
  ContextBaseline,
  SessionContextPreview,
  SessionContextWatcher,
} from "./assembly/session-context.js";
import { randomUUID } from "node:crypto";

/** systemPrompt 热重载的触发原因（session 首轮 / 压缩提交后）。 */
export type SystemPromptRefreshReason = "session-start" | "compaction";

/**
 * systemPrompt 热重载结果：prompt 与可选上下文基线。
 * prompt null = 不改 systemPrompt（但 contextBaseline 仍会 rebase 会话水位）；
 * contextBaseline 缺省 = 不 rebase。两者可独立出现，供 server resync 在"渲染字节没变"
 * 时仍把新 baseline 交给 watcher。
 */
export interface SystemPromptRefreshResult {
  readonly prompt: string | null;
  readonly contextBaseline?: ContextBaseline | undefined;
}

type SystemPromptProvider = (
  reason: SystemPromptRefreshReason,
) => Promise<string | SystemPromptRefreshResult | null> | string | SystemPromptRefreshResult | null;

export interface AgentSessionOptions {
  model: Model<Api>;
  tools: HarnessTool[];
  systemPrompt?: string;
  /**
   * systemPrompt 热重载 provider：session-start（首轮前一次）与 compaction（压缩提交后）时调用。
   * 返回 string = 新 prompt；null = 不变；抛错 = 保留旧 prompt（绝不失败 run/compaction）。
   * 返回对象时 prompt 可同时携带 contextBaseline（prompt 为 null 也照样 rebase 会话水位）。
   * 缺省 = 完全旧行为（prompt 构造期固定）。
   */
  refreshSystemPrompt?: SystemPromptProvider;
  /**
   * 每会话上下文侦听器：session-start 与（contextCheckEachTurn 时）每次 LLM 调用前
   * 检查注入源变更，并把变更作为 durable user 消息 push 进转录。
   * 缺省 = 完全旧行为（无检查、无注入）。
   */
  contextWatcher?: SessionContextWatcher;
  /**
   * 是否每 turn 检查一次上下文变更。缺省 = contextWatcher !== undefined（子/副会话）；
   * 主会话显式 false（只吃准入 preview + 刷新/压缩 rebase，保 W17-F 帧/转录 parity）。
   */
  contextCheckEachTurn?: boolean;
  hooks?: Hook<Message | CompactionCheckpointPayload>[];
  /** 防失控硬上限；默认 200。 */
  maxTurns?: number;
  /** onSessionEnd 续跑次数硬上限；默认 5。超出返回 reason="max_continuations"。 */
  maxContinuations?: number;
  /** 续跑时可注入历史 messages（lifecycle-restart controller 用）。 */
  initialMessages?: Message[];
  /**
   * 可选会话存储。给定后，内核在每个 turn 结束 + run 结束把新 messages（及一条 terminal entry）
   * append 进 store；配合 `AgentSession.resume(store, sessionId)` 可从落盘历史重建并续跑。
   * 协议在内核，落盘实现（JSONL / Postgres）在 adapter。
   */
  store?: SessionStore;
  /**
   * W57 P2c-2：会话级压缩接线（state sidecar + summarizer + 绝对 fallback 阈值）。
   * 给定后内核在每次 LLM 调用前检查压缩状态/请求体积，必要时先跑一次后台 worker 并用
   * commit 后的 boundary 投影；缺省 = 完全旧行为（不创建 worker、不读写 sidecar）。
   * 与既有 autoCompaction hook 是独立路径：本项不消费 `maxContextTokens`/`triggerRatio`。
   */
  compaction?: SessionCompactionOptions;
  /** 覆盖自动生成的 session id。`AgentSession.resume` 用它把新 session 绑回同一 lineage。 */
  sessionId?: string;
  /**
   * 持久化失败的处理模式。默认 false = best-effort（store I/O 失败只记日志 + 计入 RunSummary.persistenceErrors，
   * 不改终态，下次 flush 从 HWM 重试）。true = strict：若 run 结束时持久化未真正完成（最终 flush 或 terminal
   * append 失败），把 RunSummary.reason 改写为 "error" 并填 error，让依赖 durable resume/复现的调用方不会
   * 把「done 但落盘不全」当成功。注意 strict 判定在 onSessionEnd 之后（terminal 持久化发生在 session 结束后），
   * 故 onSessionEnd 仍观察到 loop 的自然 reason；strict 只改写**返回的** RunSummary。
   */
  strictPersistence?: boolean;
  /**
   * 内核内部用：resume 时声明前 N 条 initialMessages 已在 store 里、不要重复 append。
   * 普通调用者不要设。
   */
  resumedMessageCount?: number;
  /**
   * 透传给 pi-ai stream()/complete() 的 provider options（typed，见 {@link LlmOptions}）。
   * 公共字段（apiKey / temperature / headers / …）类型化，`{apikey}` 这类 typo 编译期失败；
   * provider 专属键走 `providerExtras` 逃生口。`signal` 是 kernel 保留字段，已从类型 Omit 掉
   * （即使经 `providerExtras` 偷传也会被当前 session 的 AbortSignal 覆盖）。
   */
  llmOptions?: LlmOptions;
  /** Hook 失败上报通道（metrics plugin 通常 hook 进来）。 */
  hookFailureSink?: HookFailureSink;
  /**
   * 把一次「LLM 以 `stopReason==="error"` 结束」判定为 context-overflow 的谓词（docs/09 §3.6）。
   * 返回 true → 内核 fire `onContextOverflow`（`stopReason:"error"`）。默认 `defaultIsContextOverflow`
   * （匹配 OpenAI/Anthropic/DashScope 常见 prompt-too-long 文案）。`stopReason==="length"` 是无歧义
   * 越界，不经此谓词。内核不内置 compaction 策略，连「什么算 overflow」都让你可换。
   */
  isContextOverflow?: (errorMessage: string) => boolean;
  /**
   * W42a 瞬时 provider 错误的**带退避重试**上限：一次 LLM call 解析出 error 终态（或异常 aborted 终态）
   * 且非 context-overflow 时，放弃前对**同一请求**重发至多本值次。缺省 2；0=禁用（error-stop 一发即
   * 诚实终态化）。重试发生在同一 turn 内、**不消耗回合数**（maxTurns 不因重试前进）；真用户 abort 在途
   * 即刻停止重发。overflow 分类（docs/09 §3.6 通道）与同步抛（建流期）不重试——重发同样超长/同样配错。
   */
  llmErrorRetries?: number;
  /**
   * W42a 重试退避基数 ms（第 n 次重发前等 `base × 2^n`，缺省 1000 → 1s/2s）。测试注小值提速用；
   * 等待窗口 abort-aware（abort 即刻中断，不多等一毫秒）。
   */
  llmErrorRetryBackoffMs?: number;
  /**
   * systemMessage emit 通道：所有 HookResult.systemMessage 走这里。
   * 默认 console.log；永不进 LLM context。
   */
  consoleSink?: (
    msg: string,
    ctx: { sessionId: string; turnIdx: number },
  ) => void;
  /**
   * `ctx.log.<level>(msg, fields?)` 的后端 sink。默认走 console.{log,warn,error,debug}
   * 带 `[harness-pi <sessionId> turn=N]` 前缀。生产环境通常注入 pino / winston / 业务 logger。
   *
   * sink 永远在 hot path 上同步调用；如果要 ship 远端，先 buffer 再 batch flush。
   */
  logSink?: (
    level: LogLevel,
    msg: string,
    fields: Record<string, unknown>,
  ) => void;
  /**
   * W23-A 发线面持久回调：每次 LLM call **解析完成后**恰好一次（A1 槽已设、A2 载荷此刻
   * 已落位；fake 通道 onPayload 永不触发 → providerPayload 如实 null）。
   * fire-and-forget：回调抛错被内核吞断（fail-soft，绝不反噬回合——同 onRemindersDrained
   * 观测面纪律）；错误不路由、不记账，只以本注释申明口径存在。
   */
  onWireSnapshot?: (
    snapshot: WireRequestSnapshot,
    providerPayload: string | null,
  ) => void;
}

/**
 * 一次 run/continue 的**结构化终态**（设计依据 docs/09 §3.2 的 TerminalResult）。
 *
 * `reason` 是判别字段（done / max_turns / aborted / error / max_continuations）。
 * domain-free：内核只给 done/aborted/error 这种通用终态，业务层（如 bidding 的
 * filled/uncertain/failed）从 `reason` + 自己的 tool 回调映射，**不进内核**。
 *
 * `usage` 总是由内核填充。声明式编排层（controllers）靠 `usage` 做 budget、靠
 * `reason`/`lastMessage` 判 work-item 终态。
 */
export interface RunSummary {
  turns: number;
  /** 同 session 内 onSessionEnd 触发续跑的次数。 */
  continuations: number;
  /**
   * 终态判别字段。注意 `"aborted"` 涵盖三类来源（caller abort / watchdog / onUserPromptSubmit
   * policy-deny），需配合 `abortReason` 细分 —— 编排层判重试不应只看 reason（如 lifecycle-restart
   * 默认只重试 `abortReason` 以 `watchdog:` 开头的，policy-deny 不会被误重试）。
   */
  reason:
    | "done"
    | "max_turns"
    | "aborted"
    | "error"
    | "max_continuations";
  /**
   * **session 累计** token usage（含 cost）：累加该 session `messages` 里**至今所有** assistant
   * 的 usage —— 含本次 run 之前的 run/continue（messages 是持久累积的）。内核总是填充（无 LLM 调用为零值）。
   * 注意：lifecycle-restart 这类「换 session + 搬历史」的 controller 会让 usage 在重启间**重叠累加**，
   * 那是 controller 层语义（见 controllers/lifecycle-restart.ts 注释），内核契约本身自洽。
   */
  usage: Usage;
  /**
   * 该 session `messages` 里最后一条 assistant 消息（无任何 assistant 则缺省）。
   * **注意 `error` 终态**：LLM 同步抛时失败的 assistant **不入 messages**，`lastMessage` 指向
   * 上一个成功 turn（甚至上一次 run），失败详情在 `error`。而 provider 把错误表达成流事件时，
   * `result()` resolve 出 `stopReason="error"` 的 assistant，它**会**入 messages、成为 `lastMessage`。
   * 判失败请看 `reason`/`error`/`lastMessage.stopReason`，别假设 `lastMessage` 就是本次的产物。
   */
  lastMessage?: AssistantMessage;
  /** `lastMessage` 的 stopReason（便于消费者不必自己翻 lastMessage）。 */
  stopReason?: StopReason;
  error?: Error;
  abortReason?: string;
  /** 持久化（SessionStore）失败记录。两种模式下都会**如实暴露**（非空才出现）；strict 模式还会把 reason 改 error。 */
  persistenceErrors?: string[];
}

const DEFAULT_MAX_TURNS = 200;
const DEFAULT_MAX_CONTINUATIONS = 5;
/** W42a：error/aborted-无信号 终态放弃前的默认重试次数（0=禁用）。 */
const DEFAULT_LLM_ERROR_RETRIES = 2;
/** W42a：重试退避基数 ms（第 n 次重发前等 base×2^n → 缺省 1s/2s）。 */
const DEFAULT_LLM_ERROR_RETRY_BACKOFF_MS = 1000;

/** Single turn 的退出状态。 */
type TurnOutcome = "done" | "continue" | "abort" | "error";

/**
 * W51 live 压缩境界**只读快照**（GET /sessions/:id/compaction 的 core 侧唯一数据源）。
 *
 * 与 `_activeBoundary` 同生命周期语义：null = 内核尚未持有 active boundary（本 session
 * 还没触发 view-only 压缩；重启后由首轮 autoCompaction 重新派生）。非 null = 现势境界的
 * 一次性快照（消费者拿去拼压缩分隔线，绝不回写内核）。
 *
 * 字段口径（W51 硬接口合同，hm 后端逐键消费）：
 *   - coveredCount：`_activeBoundary.coveredCount`——`_messages` 前缀被折进 summary 的条数
 *     （真相坐标基准，见 hook.ts ActiveBoundary 头注）。
 *   - summaryText：boundary summary message 的**全文**（string content 原样；content 块数组
 *     则拼接全部 text 块，image/thinking/toolCall 不贡献文本）。
 *   - anchor*：**未覆盖尾巴第一条** = `_messages[coveredCount]`（越界/不该发生的情况 →
 *     anchors 双 null，境界如实可见）。pi-ai Message 三变体均不声明稳定 id
 *     （types.d.ts:184-212，W51 勘察结论），常态 anchorMessageId=null；仅当消息对象上
 *     真实携带非空 string `id` 扩展字段时透传（见 {@link stableMessageId}）。
 *   - totalMessages：`session.messages.length`（全量真相，投影前基数；tailCount 由消费侧
 *     totalMessages − coveredCount 现算，快照本身不存派生值）。
 */
export interface CompactionView {
  readonly coveredCount: number;
  readonly summaryText: string;
  readonly anchorMessageId: string | null;
  readonly anchorTimestampMs: number | null;
  readonly totalMessages: number;
  /** 该 boundary 由 resume checkpoint 恢复（而非本 turn live 压缩产生）时出现。 */
  readonly restored?: boolean;
  /** checkpoint 坐标系下历史累计覆盖条数（跨 resume 累计）；仅恢复边界携带。 */
  readonly historicalCoveredCount?: number;
}

/**
 * `_replayStoreHistory` 从最后一条 `compaction_boundary` 重放出的可恢复坐标。
 * 只在内核内部消费：resume/hydrate 用它 seed `_activeBoundary`，autoCompaction 再从
 * `ctx.state` 采纳同一坐标。
 */
interface ReplayedBoundary {
  summary: Message;
  historicalCoveredCount: number;
  checkpointId: string;
  anchorTimestampMs: number | null;
}

/** 提取一条 message 的全文文本（见 {@link CompactionView} summaryText 口径）。 */
function messageFullText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  let text = "";
  for (const block of message.content) {
    if (block.type === "text") text += block.text;
  }
  return text;
}

/**
 * 稳定 id 探针：pi-ai `Message`（User/Assistant/ToolResult 三变体）**没有** id 字段，
 * AssistantMessage 的 `responseId` 是 provider 响应 id（非逐条消息凭证，与转录条目 id
 * 不同谱），故常态返回 null。若未来上游/装配层给消息对象附加非空 string `id`，
 * 经 `in` 探测量透传——W51 合同「the id if the message object carries a stable id」。
 */
function stableMessageId(message: Message | undefined): string | null {
  if (message === undefined) return null;
  if ("id" in message) {
    const rawId: unknown = message.id;
    if (typeof rawId === "string" && rawId.length > 0) return rawId;
  }
  return null;
}

function checkpointSourceForReason(
  reason: CompactionCommit["reason"] | "auto",
): CompactionCheckpointMeta["source"] {
  switch (reason) {
    case "manual":
    case "tool":
      return "manual";
    case "auto":
    case "watermark":
    case "fallback":
      return "auto";
    default: {
      const unreachable: never = reason;
      throw new Error(`unsupported compaction reason: ${String(unreachable)}`);
    }
  }
}

/** steer() 返回的取消句柄：cancel 摘除仍 park 的条目返回 true；已被 drain 则 false。 */
export interface SteerHandle {
  cancel(): boolean;
}

/** steer() 选项。 */
export interface SteerOptions {
  /** 消息 push 进 `_messages` 后同步回调；回调抛错不影响 turn。 */
  onDrained?: () => void;
}

interface SteerInboxEntry {
  message: Message;
  onDrained?: () => void;
}

export class AgentSession {
  readonly id: string;
  readonly model: Model<Api>;
  readonly tools: ReadonlyArray<HarnessTool>;
  private _systemPrompt: string;
  readonly maxTurns: number;
  readonly maxContinuations: number;
  private readonly _llmOptions: LlmOptions;
  private readonly _refreshSystemPromptProvider: SystemPromptProvider | undefined;
  /** 会话拥有的上下文侦听器；undefined = 旧行为（零检查、零注入）。 */
  private readonly _contextWatcher: SessionContextWatcher | undefined;
  /** 每 turn 检查开关；缺省跟随 watcher 存在性（主会话显式 false）。 */
  private readonly _contextCheckEachTurn: boolean;
  /** run/continue 序号；与 turnIdx 组成上下文检查去重键。 */
  private _runSeq = 0;
  /** 本 run 最近一次已检查的 `${runSeq}:${turnIdx}`；null = 尚未检查。 */
  private _contextCheckedKey: string | null = null;
  /** session-start 刷新是否已成功（失败留待后续 run 重试；成功后永不再刷）。 */
  private _sessionStartRefreshSucceeded = false;
  /** 串行刷新队列：并发 session-start/compaction 刷新绝不重叠。 */
  private _refreshChain: Promise<void> = Promise.resolve();

  private _messages: Message[];
  private _hooks: Hook<Message | CompactionCheckpointPayload>[];
  private _dispatcher: HookDispatcher;
  private readonly _hookFailureSink: HookFailureSink | undefined;
  private _ctx: HookContextImpl;
  /** 单 AbortController 唯一的 abort 真相源。Reason 通过 signal.reason 传播。 */
  private _abortCtrl: AbortController;
  private _pendingAttachments: Message[] = [];
  /** Steering inbox（park 队列）。steer() enqueue，loop 在 turn 开始的安全点 drain。 */
  private _steerInbox: SteerInboxEntry[] = [];
  private _lastTurnError: Error | null = null;
  private _running = false;
  private _consoleSink: (
    msg: string,
    ctx: { sessionId: string; turnIdx: number },
  ) => void;
  /** Event Bus live listeners（按事件类型分组）。 */
  private readonly _liveListeners = new Map<
    LiveEventType,
    Set<(e: LiveEvent) => void>
  >();
  /** 可选会话存储 + 已 append 进 store 的 messages 数（避免重复落盘）。 */
  private readonly _store: SessionStore | undefined;
  private _persistedCount: number;
  /**
   * W16-F5 封棺水位：上一条 terminal 封记时的 `_persistedCount` 快照；-1=本实例未封过。
   * 同一水位重复 `_persistTerminal`（abort 竞态双 flush / 零增量空轮）= 幂等跳过，恰一封。
   */
  private _lastSealCount = -1;
  /**
   * Live 境界（autoCompaction 写入 ctx.state、由内核持有）。
   * null = 未设定境界（照常把全量 _messages 发给 LLM）。
   * 非 null = 投影成 `[boundary.summary, ..._messages.slice(coveredCount), ...pending]`。
   * summary 复用同一对象 → prefix bytes 稳定（提升 prompt-cache 命中率）。
   */
  private _activeBoundary: ActiveBoundary | null = null;
  /** W57 P2c-2：会话级压缩协调器；null = 未注入 compaction（旧行为）。 */
  private readonly _compactionCoordinator: CompactionCoordinator | null;
  /** 自动 fallback 的绝对 token 阈值（来自 SessionCompactionOptions，非硬编码）。 */
  private readonly _compactionFallbackTokens: number;
  /** P3 水位档位（绝对 token 数，严格递增；来自 SessionCompactionOptions，非硬编码）。 */
  private readonly _compactionWatermarkLevels: readonly number[];
  /**
   * 已提醒到的最高水位档位（绝对 token 数；0 = 尚未提醒）。构造/重放时从持久
   * `<system-reminder>` notice 的 marker 恢复，压缩成功后重置。
   */
  private _lastWatermarkLevel = 0;
  /** 压缩成功后跳过下一次水位判定的 one-turn grace；防止刚压缩完立刻重复提醒。 */
  private _watermarkGracePending = false;
  /** strict 持久化模式：run 结束落盘不全则把返回的 RunSummary.reason 改 error（见选项注释）。 */
  private readonly _strictPersistence: boolean;
  /** 本 session 累积的持久化失败记录；两种模式下都如实挂上 RunSummary.persistenceErrors。 */
  private _persistenceErrors: string[] = [];
  /** error-stopReason → 是否 context-overflow 的判定（可经选项覆盖，默认内置启发式）。 */
  private readonly _isContextOverflow: (errorMessage: string) => boolean;
  /** W42a：瞬时 provider 错误放弃前的最大重发次数（0=禁用；缺省 2）。 */
  private readonly _llmErrorRetries: number;
  /** W42a：重试退避基数 ms（第 n 次重发前等 base×2ⁿ；缺省 1000 → 1s/2s）。 */
  private readonly _llmErrorRetryBackoffMs: number;
  /**
   * W17-A 发线面捕获（A1 装配口快照 + A2 provider 载荷）。**纯内存、每会话单槽覆盖、
   * 重启即清**——与 W13 #contextViews 同一内存纪律（registry.ts:72：内存、重启清空、
   * 不落新文件）。单槽 ~55-120KB 量级，不存全量载荷历史。只读 getter 暴露给 server
   * v2 面（GET /sessions/:id/context/full 的 `wire` 块唯一 core 侧数据源）。
   */
  private _lastWireRequest: WireRequestSnapshot | null = null;
  /**
   * A2：provider 发线口最近一次载荷的 canonical JSON 文本。
   * **诚实缺席**：unit 测试的 fake model 通道不经 pi-ai 真实 provider → onPayload
   * 永不触发 → 恒 null。这就是 server v2 面如实回 `providerPayloadAbsentReason` 的契约。
   */
  private _lastProviderPayload: string | null = null;
  /** A2 载荷捕获时刻（epoch ms；与 `_lastProviderPayload` 同生命周期，null=未捕获）。 */
  private _providerPayloadCapturedAt: number | null = null;
  /** W23-A 发线面持久回调（可选）；每次 LLM call 解析完成后恰好一次，抛错 fail-soft 吞断。 */
  private readonly _onWireSnapshot:
    | ((snapshot: WireRequestSnapshot, providerPayload: string | null) => void)
    | undefined;

  constructor(opts: AgentSessionOptions) {
    this.id = opts.sessionId ?? randomUUID();
    this._store = opts.store;
    this._strictPersistence = opts.strictPersistence ?? false;
    // resume 时前 N 条 initialMessages 已在 store，不重复 append；普通构造从 0 起。
    // 夹到 initialMessages 长度，防止误传过大值导致首批新消息漏落盘。
    this._persistedCount = Math.min(
      opts.resumedMessageCount ?? 0,
      opts.initialMessages?.length ?? 0,
    );
    this.model = opts.model;
    this.tools = opts.tools;
    this._systemPrompt = opts.systemPrompt ?? "";
    this._refreshSystemPromptProvider = opts.refreshSystemPrompt;
    this._contextWatcher = opts.contextWatcher;
    this._contextCheckEachTurn = opts.contextCheckEachTurn ?? opts.contextWatcher !== undefined;
    this.maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
    this.maxContinuations = opts.maxContinuations ?? DEFAULT_MAX_CONTINUATIONS;
    this._llmOptions = { ...(opts.llmOptions ?? {}) };
    this._onWireSnapshot = opts.onWireSnapshot;
    // W42a 重试参数构造期 fail-loud（配错就拒绝构造，与 assertCriticalDecisionHooks 同纪律；
    // 0 合法=禁用，负数/小数拒）。
    this._llmErrorRetries = opts.llmErrorRetries ?? DEFAULT_LLM_ERROR_RETRIES;
    if (!Number.isInteger(this._llmErrorRetries) || this._llmErrorRetries < 0) {
      throw new Error(
        `AgentSession: llmErrorRetries must be an integer >= 0 (got ${String(opts.llmErrorRetries)})`,
      );
    }
    this._llmErrorRetryBackoffMs = opts.llmErrorRetryBackoffMs ?? DEFAULT_LLM_ERROR_RETRY_BACKOFF_MS;
    if (!Number.isInteger(this._llmErrorRetryBackoffMs) || this._llmErrorRetryBackoffMs < 0) {
      throw new Error(
        `AgentSession: llmErrorRetryBackoffMs must be an integer >= 0 (got ${String(opts.llmErrorRetryBackoffMs)})`,
      );
    }

    this._messages = opts.initialMessages ? [...opts.initialMessages] : [];
    this._hooks = [...(opts.hooks ?? [])];
    // fail-closed 分类硬校验（§3.7）：critical decision hook 必须显式声明 failClosed，否则拒绝构造。
    // 放在 dispatcher 之前——配错就 fail-loud，不让一个静默 fail-open 的安全 hook 跑起来。
    assertCriticalDecisionHooks(this._hooks);
    this._hookFailureSink = opts.hookFailureSink;
    this._isContextOverflow = opts.isContextOverflow ?? defaultIsContextOverflow;
    this._dispatcher = new HookDispatcher(this._hooks, this._hookFailureSink);
    this._consoleSink =
      opts.consoleSink ??
      ((msg, c) => {
        // eslint-disable-next-line no-console
        console.log(`[harness-pi ${c.sessionId} turn=${c.turnIdx}] ${msg}`);
      });

    // 构造期校验 hook 软依赖，warning 走 consoleSink；不阻塞构造，让 caller 决定怎么响应
    this._emitDependencyWarnings(verifyHookDependencies(this._hooks));

    this._abortCtrl = new AbortController();
    // tools 是构造期固定（`use()` 只允许在 idle 加 hooks，不改 tools / model / maxTurns）。
    // Object.freeze 是**浅冻**：configView 顶层 + model + toolNames 数组 + tools 数组及其每个元素都冻结，
    // plugin 不能替换字段/增删元素;但 tool.parameters 是 TypeBox schema 对象的**引用**(未深冻)——估算只读
    // 不写,与 model 的扁平冻结粒度一致,不构成新风险面。
    // systemPrompt 用 getter：顶层仍冻结，但值跟随 live systemPrompt 热重载。
    const session = this;
    const configView: SessionConfigView = Object.freeze({
      sessionId: this.id,
      model: Object.freeze({
        id: this.model.id,
        provider: this.model.provider,
        // X2(#57):暴露有效窗口给 autoCompaction 算绝对阈值。值取自 pi-ai Model 同名字段(调用方权威)。
        contextWindow: this.model.contextWindow,
        maxTokens: this.model.maxTokens,
      }),
      toolNames: Object.freeze(this.tools.map((t) => t.name)),
      // 只暴露 pi-ai Tool 三字段（与每请求随发的 piTools 同形），冻结每个元素防 plugin 改 schema。
      tools: Object.freeze(
        this.tools.map((t) =>
          Object.freeze({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          }),
        ),
      ),
      get systemPrompt(): string {
        return session._systemPrompt;
      },
      maxTurns: this.maxTurns,
      maxContinuations: this.maxContinuations,
    });
    const ctxDeps: import("./context.js").HookContextDeps = {
      sessionId: this.id,
      initialSignal: this._abortCtrl.signal,
      messages: this._messages,
      config: configView,
      onAppendMessage: (msg) => this._messages.push(msg),
      onAbort: (reason) => this._abortCtrl.abort(new Error(reason)),
      // O5：把 controller 在 tool 内调的 fireSubagentStart/End 派发到本 session 的 hook。
      // 闭包读 this._ctx 在调用时已构造完毕（fire* 只在 run 中、tool 内触发，无循环依赖）。
      // 观测事件：fireEvent 返回 MergedHookResult 一律忽略（无控制流）。
      onSubagentStart: async (input) => {
        await this._dispatcher.fireEvent("onSubagentStart", input, this._ctx);
      },
      onSubagentEnd: async (input) => {
        await this._dispatcher.fireEvent("onSubagentEnd", input, this._ctx);
      },
    };
    if (opts.logSink) ctxDeps.logSink = opts.logSink;
    this._ctx = new HookContextImpl(ctxDeps);

    const compaction = opts.compaction;
    if (compaction === undefined) {
      this._compactionCoordinator = null;
      this._compactionFallbackTokens = 0;
      this._compactionWatermarkLevels = [];
    } else {
      if (!Number.isFinite(compaction.fallbackTokens) || compaction.fallbackTokens <= 0) {
        throw new RangeError(
          `AgentSession: compaction.fallbackTokens must be a finite number > 0 (got ${String(compaction.fallbackTokens)})`,
        );
      }
      assertValidWatermarkLevels(compaction.watermarkLevels, compaction.fallbackTokens);
      this._compactionFallbackTokens = compaction.fallbackTokens;
      this._compactionWatermarkLevels = [...(compaction.watermarkLevels ?? [])];
      const workerOptions: Omit<CompactionWorkerOptions, "onEvent"> = {
        keepRecent: compaction.keepRecent,
        summaryChunkTokens: compaction.summaryChunkTokens,
        ...(compaction.keepRecentTokens !== undefined
          ? { keepRecentTokens: compaction.keepRecentTokens }
          : {}),
        ...(compaction.resummarizeEvery !== undefined
          ? { resummarizeEvery: compaction.resummarizeEvery }
          : {}),
        ...(compaction.requestTimeoutMs !== undefined
          ? { requestTimeoutMs: compaction.requestTimeoutMs }
          : {}),
        ...(compaction.retryCount !== undefined ? { retryCount: compaction.retryCount } : {}),
        ...(compaction.summaryMode !== undefined
          ? { summaryMode: compaction.summaryMode }
          : {}),
        ...(compaction.singleCallBudgetTokens !== undefined
          ? { singleCallBudgetTokens: compaction.singleCallBudgetTokens }
          : {}),
        ...(compaction.summaryMaxSplitDepth !== undefined
          ? { summaryMaxSplitDepth: compaction.summaryMaxSplitDepth }
          : {}),
      };
      this._compactionCoordinator = new CompactionCoordinator({
        session: this,
        stateStore: compaction.stateStore,
        summarize: compaction.summarize,
        wrapSummary: compaction.wrapSummary,
        workerOptions,
        ...(compaction.projectSummaryInput !== undefined
          ? { projectSummaryInput: compaction.projectSummaryInput }
          : {}),
        ...(compaction.additionalSummaryPerspectives !== undefined
          ? { additionalSummaryPerspectives: compaction.additionalSummaryPerspectives }
          : {}),
        ...(compaction.onEvent !== undefined ? { onEvent: compaction.onEvent } : {}),
      });
    }
    this._lastWatermarkLevel = this._maxPersistedWatermarkLevel();
  }

  /** 当前 live systemPrompt（热重载后立即反映；无 provider 时与构造期值逐字节一致）。 */
  get systemPrompt(): string {
    return this._systemPrompt;
  }

  get messages(): ReadonlyArray<Message> {
    return this._messages;
  }

  /**
   * W51 只读 getter：live 压缩境界快照（形状与口径见 {@link CompactionView}）。
   * null = `_activeBoundary` 未设；纯读、零副作用，绝不改投影/持久化面。
   */
  get compactionView(): CompactionView | null {
    const boundary = this._activeBoundary;
    if (boundary === null) return null;
    const totalMessages = this._messages.length;
    // anchor = 未覆盖尾巴第一条；越界（不该发生，如 coveredCount>=total）→ undefined → anchors 双 null。
    const anchor = this._messages[boundary.coveredCount];
    return {
      coveredCount: boundary.coveredCount,
      summaryText: messageFullText(boundary.summary),
      anchorMessageId: stableMessageId(anchor),
      anchorTimestampMs: anchor === undefined ? null : anchor.timestamp,
      totalMessages,
      ...(boundary.restored === true ? { restored: true } : {}),
      ...(boundary.historicalCoveredCount !== undefined
        ? { historicalCoveredCount: boundary.historicalCoveredCount }
        : {}),
    };
  }

  /**
   * 后台压缩 worker 的 attempt 起点快照：`raw` 是 `_messages` 的**副本**（worker 只读，
   * 任何就地修改都不得反噬真相），`prevCovered` 取当前 live boundary 的覆盖条数。
   */
  getCompactionSnapshot(): CompactionContextSnapshot {
    return {
      raw: [...this._messages],
      prevCovered: this._activeBoundary?.coveredCount ?? 0,
      ctx: this._ctx,
    };
  }

  /**
   * 串行刷新 systemPrompt（promise chain）：并发触发按到达序执行，绝不重叠。
   * 返回 provider 是否成功（无 provider = no-op 成功）。
   */
  private _refreshPrompt(reason: SystemPromptRefreshReason): Promise<boolean> {
    const provider = this._refreshSystemPromptProvider;
    if (provider === undefined) return Promise.resolve(true);
    const run = this._refreshChain.then(() => this._maybeRefreshPrompt(reason, provider));
    this._refreshChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async _maybeRefreshPrompt(
    reason: SystemPromptRefreshReason,
    provider: SystemPromptProvider,
  ): Promise<boolean> {
    try {
      const next = await provider(reason);
      const prompt =
        typeof next === "string" ? next : next === null ? null : next.prompt;
      const contextBaseline =
        typeof next === "string" || next === null
          ? undefined
          : next.contextBaseline;
      // Baseline rebase 独立于 prompt：server resync 在渲染字节无变化时仍可能带来新水位，
      // 漏掉它会让下一次 admission/per-turn 检查把已交付内容重发一遍。
      if (contextBaseline !== undefined) {
        try {
          this._contextWatcher?.reseed(contextBaseline);
        } catch (err) {
          this._ctx.log.warn("[system-prompt] context baseline reseed failed", {
            reason,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (prompt !== null) {
        const beforeLength = this._systemPrompt.length;
        this._systemPrompt = prompt;
        this._ctx.log.info("[system-prompt] refreshed", {
          reason,
          beforeLength,
          afterLength: prompt.length,
        });
      }
      return true;
    } catch (err) {
      this._ctx.log.warn("[system-prompt] refresh failed", {
        reason,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * 提交一次后台压缩：先把 boundary + checkpoint append 进 store，**成功之后**才更新 live
   * 境界（`_activeBoundary` + `ctx.state`），失败时 live 面保持原样。只改投影、不改
   * `_messages`（真相数组 append-only），故 `messages.length` 不变、`compactionView` 生效。
   *
   * 无 store 时直接抛错：没有持久化就无法通过 resume 对账，拒绝静默降级成内存边界。
   */
  async commitCompaction(commit: CompactionCommit): Promise<void> {
    const store = this._store;
    if (store === undefined) {
      throw new Error(
        "AgentSession.commitCompaction(): session has no store; compaction boundary cannot be persisted",
      );
    }
    const checkpoint: CompactionCheckpointMeta = {
      version: COMPACTION_CHECKPOINT_VERSION,
      coveredCount: commit.coveredCount,
      anchorTimestampMs: commit.anchorTimestampMs,
      summaryId: commit.checkpointId,
      createdAt: Date.now(),
      source: checkpointSourceForReason(commit.reason),
      tailIncluded: commit.tailIncluded ?? false,
    };
    await store.appendEntry(this.id, {
      kind: "compaction_boundary",
      summary: commit.summary,
      checkpoint,
    });
    const active: ActiveBoundary = {
      summary: commit.summary,
      coveredCount: commit.coveredCount,
      checkpointId: commit.checkpointId,
      anchorTimestampMs: commit.anchorTimestampMs,
      persisted: true,
    };
    this._activeBoundary = active;
    this._ctx.state.set(ACTIVE_BOUNDARY_KEY, active);
    this._lastWatermarkLevel = 0;
    this._watermarkGracePending = true;
    // 压缩后的同一次 LLM call（_prepareCompactionForLlm 之后）即用新 prompt；
    // provider 失败只记 warn，绝不失败压缩提交。
    if (this._refreshSystemPromptProvider !== undefined) {
      await this._refreshPrompt("compaction");
    }
  }

  /** 当前压缩 sidecar 快照；未注入 compaction 或 sidecar 缺失/损坏 = null。 */
  get compactionState(): CompactionState | null {
    return this._compactionCoordinator?.state ?? null;
  }

  /**
   * 手动触发一次压缩并等待 outcome（tool/HTTP 手动入口的 core 面）。
   * 只启动一个 worker；已有在飞 attempt 时按 worker 契约抛 `CompactionBusyError`。
   * `floor` 是覆盖下限（raw 坐标），缺省 = 当前 boundary 的 coveredCount。
   */
  async compactNow(
    reason: CompactionReason = "manual",
    floor?: number,
  ): Promise<WorkerOutcome> {
    return this.startCompaction(reason, floor).done;
  }

  /** 启动一次后台压缩并立即返回；调用方可用 done 等待终态。 */
  startCompaction(
    reason: CompactionReason = "manual",
    floor?: number,
  ): { attemptId: string; done: Promise<WorkerOutcome> } {
    const coordinator = this._compactionCoordinator;
    if (coordinator === null) {
      throw new Error("AgentSession.startCompaction(): compaction is not configured");
    }
    return coordinator.start(reason, floor);
  }

  /** 中止在飞压缩 attempt；未注入 compaction 或空闲时无副作用。 */
  abortCompaction(reason?: string): void {
    this._compactionCoordinator?.abort(reason);
  }

  /**
   * boot 恢复：把崩溃残留的 compacting sidecar 迁到 retry_pending，返回是否发生迁移。
   * 不启动 attempt；下一个 LLM 前置闸门会按 retry_pending 自动重试。
   */
  recoverStaleCompaction(): boolean {
    return this._compactionCoordinator?.recoverStaleCompacting() !== null;
  }

  /**
   * W17-A 只读 getter：最近一次 A1 装配口快照；null=尚未发起过任何 LLM call。
   * 内存面、重启即清（W13 纪律）。server v2 `wire.request` 块逐字消费本对象。
   */
  get lastWireRequest(): WireRequestSnapshot | null {
    return this._lastWireRequest;
  }

  /**
   * W17-A 只读 getter：最近一次 A2 provider 载荷的 canonical JSON 文本；null=未捕获。
   * fake model 通道不经 pi-ai provider → 恒 null（诚实缺席，见字段注释）。
   * 每 attempt last-write-wins：一次 LLM call 内 provider 重试多次 → 只留末次实发载荷。
   */
  get lastProviderPayload(): string | null {
    return this._lastProviderPayload;
  }

  /** A2 载荷捕获时刻（epoch ms）；与 lastProviderPayload 同步 null / 非 null。 */
  get providerPayloadCapturedAt(): number | null {
    return this._providerPayloadCapturedAt;
  }

  /**
   * 注册 hook。注意：不要在 `run()` / `continue()` 进行中调用，会 throw。
   */
  use(hook: Hook): this {
    if (this._running) {
      throw new Error(
        "AgentSession.use(): cannot register hook while run() is in progress",
      );
    }
    // 与构造期同样的 fail-closed 硬校验：use() 也是注册期，critical decision hook 配错即拒绝。
    assertCriticalDecisionHooks([hook]);
    this._hooks.push(hook);
    this._dispatcher = new HookDispatcher(this._hooks, this._hookFailureSink);
    // 重新校验软依赖（新 hook 可能补齐 missing-required，也可能引入 conflict）
    this._emitDependencyWarnings(verifyHookDependencies(this._hooks));
    return this;
  }

  /**
   * 把 hook 依赖校验 warning 发给 consoleSink。turnIdx 用 -1 表示"构造期"。
   *
   * 抑制规则（避免 spam 用户）：
   *   - 抑制 `hook` 是 `internal: true` 的 hook 触发的 warning（plugin author 自己的事，不该跟用户报）
   *   - 抑制 `related` 是 `internal: true` hook 的 warning（同上）
   */
  private _emitDependencyWarnings(warnings: HookDependencyWarning[]): void {
    const internalNames = new Set(
      this._hooks.filter((h) => h.internal === true).map((h) => h.name),
    );
    for (const w of warnings) {
      if (internalNames.has(w.hook) || internalNames.has(w.related)) continue;
      this._consoleSink(`[hook-deps:${w.kind}] ${w.message}`, {
        sessionId: this.id,
        turnIdx: -1,
      });
    }
  }

  abort(reason = "abort() called"): void {
    if (this._abortCtrl.signal.aborted) return;
    this._abortCtrl.abort(new Error(reason));
  }

  /**
   * 订阅 Event Bus 的 **live** 事件（回合进行中的 token/thinking/toolcall delta）。
   * 返回 unsubscribe 函数。可在 run 进行中或之前注册（与 `use()` 不同，不受 `_running` 限制——
   * 它是只读观察，不改控制平面）。listener 抛错被隔离，不影响 loop。
   */
  on<T extends LiveEventType>(type: T, handler: LiveHandler<T>): () => void {
    let set = this._liveListeners.get(type);
    if (!set) {
      set = new Set();
      this._liveListeners.set(type, set);
    }
    const erased = handler as (e: LiveEvent) => void;
    set.add(erased);
    return () => {
      this._liveListeners.get(type)?.delete(erased);
    };
  }

  /** 发一条 live 事件给订阅者。listener 抛错被吞掉（live 容错），绝不冒泡进 loop。 */
  private _emitLive(e: LiveEvent): void {
    const set = this._liveListeners.get(e.type);
    if (!set || set.size === 0) return;
    // 快照：listener 在回调里 on()/unsubscribe 不影响本次遍历——新 listener 从下个事件起生效。
    for (const h of [...set]) {
      try {
        h(e);
      } catch (err) {
        this._consoleSink(
          `[event-bus] live listener for "${e.type}" threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { sessionId: this.id, turnIdx: this._ctx.turnIdx },
        );
      }
    }
  }

  snapshot(): { sessionId: string; messages: Message[] } {
    return { sessionId: this.id, messages: [...this._messages] };
  }

  getCacheSafeParams(): {
    systemPrompt: string;
    forkContextMessages: Message[];
    model: Model<Api>;
    llmOptions: LlmOptions;
  } {
    const projectedMessages: Message[] = this._activeBoundary !== null
      ? [
          this._activeBoundary.summary,
          ...this._messages.slice(this._activeBoundary.coveredCount),
        ]
      : [...this._messages];
    return {
      systemPrompt: this.systemPrompt,
      forkContextMessages: filterIncompleteToolCalls(projectedMessages),
      model: this.model,
      llmOptions: { ...this._llmOptions },
    };
  }

  /**
   * Steering（park/drain，docs/09 §3.5）：把一条消息 **park** 进 steering inbox。loop 会在下一个
   * turn 开始的安全点 drain 它、注入对话——**不 suspend、不打断进行中的 turn**（对齐 iii.dev / codex
   * 的「park 不 suspend」）。run 进行中或之外调用都安全（单线程下 push 是原子的）。
   *
   * 只接受 `role:"user"` 消息（用 `createUserMessage` 构造）——assistant/toolResult 会破坏对话不变量，
   * 直接抛错（fail-loud）。pi-ai 无独立 system role，"系统提示"类 steering 用 user 消息表达或走
   * consoleSink，不在此注入。
   *
   * drain 时机是 loop 控制流的一部分（只有 loop 能保证 turn 原子性 / cache 前缀不破），故此机制进内核；
   * 「何时该 park、谁能回复」是 policy，留给插件 / app。
   */
  steer(message: Message, opts?: SteerOptions): SteerHandle {
    if (message.role !== "user") {
      throw new Error(
        `AgentSession.steer: only user-role messages can be steered, got "${message.role}" ` +
          `(assistant/toolResult would break conversation invariants)`,
      );
    }
    const entry: SteerInboxEntry = {
      message,
      ...(opts?.onDrained !== undefined ? { onDrained: opts.onDrained } : {}),
    };
    this._steerInbox.push(entry);
    return {
      cancel: (): boolean => {
        const idx = this._steerInbox.indexOf(entry);
        if (idx < 0) return false;
        this._steerInbox.splice(idx, 1);
        return true;
      },
    };
  }

  /** 追加 user prompt 跑到结束。 */
  async run(
    prompt: string,
    opts?: {
      signal?: AbortSignal;
      contextNotices?: readonly string[];
      /**
       * 准入点的上下文变更预览：undefined = 未检查（session 自行 check）；
       * null = 已检查且无变更（本 run 不再重复检查）；对象 = 精确消费该预览。
       */
      contextPreview?: SessionContextPreview | null;
      /** 用户 prompt 的 accept 时刻；缺省为 push 时的 Date.now()（contextNotices 不受影响）。 */
      promptTimestamp?: number;
    },
  ): Promise<RunSummary> {
    return this._runInternal({
      source: "run",
      prompt,
      ...(opts?.signal ? { signal: opts.signal } : {}),
      ...(opts?.contextNotices !== undefined ? { contextNotices: opts.contextNotices } : {}),
      ...(opts?.contextPreview !== undefined ? { contextPreview: opts.contextPreview } : {}),
      ...(opts?.promptTimestamp !== undefined ? { promptTimestamp: opts.promptTimestamp } : {}),
    });
  }

  /** 不追加新消息从当前 messages 继续。 */
  async continue(opts?: { signal?: AbortSignal }): Promise<RunSummary> {
    return this._runInternal({
      source: "continue",
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
  }

  /**
   * Phase 3 新增：streaming API。返回 `AsyncIterable<SessionEvent>`，consumer 可以边
   * 跑边 push（典型场景：后端 HTTP/WebSocket 流式回前端）。
   *
   * 实现上挂一个 internal forwarder hook 把事件 push 到 async queue；外部 iterator 把
   * queue 转 async iterator。yield 完最后的 `session-end` 事件后 iterator close。
   *
   * **不能并发**：跟 `run()` / `continue()` 互斥，同一 session 同一时刻只能一个跑。
   */
  runStreaming(
    prompt: string,
    opts?: { signal?: AbortSignal },
  ): AsyncIterable<SessionEvent> & { finalSummary: Promise<RunSummary> } {
    return this._runStreamingInternal({
      source: "run",
      prompt,
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
  }

  /** Streaming 版本的 continue()。 */
  continueStreaming(
    opts?: { signal?: AbortSignal },
  ): AsyncIterable<SessionEvent> & { finalSummary: Promise<RunSummary> } {
    return this._runStreamingInternal({
      source: "continue",
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
  }

  private _runStreamingInternal(args: {
    source: "run" | "continue";
    prompt?: string;
    signal?: AbortSignal;
  }): AsyncIterable<SessionEvent> & { finalSummary: Promise<RunSummary> } {
    // 内部 push-to-queue forwarder hook（不上报 metric / log；纯 plumbing）
    const queue: SessionEvent[] = [];
    let resolveNext: ((v: IteratorResult<SessionEvent>) => void) | null = null;
    let done = false;
    const sessionIdCapture = this.id;

    const push = (ev: SessionEvent): void => {
      if (done) return;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: ev, done: false });
      } else {
        queue.push(ev);
      }
    };
    const close = (): void => {
      if (done) return;
      done = true;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: undefined, done: true });
      }
    };

    const forwarder: Hook = {
      name: "harness-pi.streaming-forwarder",
      internal: true,
      onSessionStart(input) {
        push({
          type: "session-start",
          sessionId: sessionIdCapture,
          source: input.source,
          ...(input.initialPrompt !== undefined
            ? { initialPrompt: input.initialPrompt }
            : {}),
        });
      },
      onTurnStart(input) {
        push({ type: "turn-start", turnIdx: input.turnIdx });
      },
      onLlmEnd(input) {
        push({
          type: "llm-end",
          msg: input.msg,
          durationMs: input.durationMs,
        });
      },
      onPostToolUse(input) {
        push({
          type: "tool-end",
          call: input.call,
          result: input.result,
          durationMs: input.durationMs,
        });
      },
      onTurnEnd(input) {
        push({
          type: "turn-end",
          turnIdx: input.turnIdx,
          toolResultsCount: input.toolResults.length,
          stopReason: input.assistantMessage.stopReason,
        });
      },
      onContinuationCheck(input) {
        push({
          type: "continuation-check",
          turns: input.turns,
          continuations: input.continuations,
        });
      },
      onError(input) {
        push({
          type: "error",
          phase: input.phase,
          message: input.err.message,
          ...(input.hookName !== undefined
            ? { hookName: input.hookName }
            : {}),
        });
      },
    };

    // 提取 cleanup 给 resolve/reject 路径共用，避免重复
    const cleanupForwarder = (): void => {
      const idx = this._hooks.indexOf(forwarder);
      if (idx >= 0) this._hooks.splice(idx, 1);
      this._dispatcher = new HookDispatcher(
        this._hooks,
        this._hookFailureSink,
      );
    };

    // M3 兜底：如果当前已在跑（_running=true），this.use() 会 throw。把这个错转成
    // 已关闭的 iterator，让 caller 可以正常 for-await 而不是 catch sync exception。
    try {
      this.use(forwarder);
    } catch (err) {
      const errEv: SessionEvent = {
        type: "error",
        phase: "hook",
        message:
          err instanceof Error
            ? err.message
            : "runStreaming called while session is already running",
      };
      let emitted = false;
      const closedIter: AsyncIterableIterator<SessionEvent> = {
        async next(): Promise<IteratorResult<SessionEvent>> {
          if (!emitted) {
            emitted = true;
            return { value: errEv, done: false };
          }
          return { value: undefined, done: true };
        },
        async return(): Promise<IteratorResult<SessionEvent>> {
          emitted = true;
          return { value: undefined, done: true };
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
      const rejected = Promise.reject<RunSummary>(
        err instanceof Error
          ? err
          : new Error("runStreaming concurrent invocation"),
      );
      // 避免 unhandled-rejection 警告——caller 不 await finalSummary 也 OK
      rejected.catch(() => {});
      return Object.assign(closedIter, { finalSummary: rejected });
    }

    // 异步跑 session，结束后 push session-end + close
    const summaryPromise = this._runInternal(args).then(
      (summary) => {
        push({ type: "session-end", summary });
        close();
        cleanupForwarder();
        return summary;
      },
      (err) => {
        push({
          type: "error",
          phase: "hook",
          message: err instanceof Error ? err.message : String(err),
        });
        close();
        cleanupForwarder();
        throw err;
      },
    );

    const iter: AsyncIterableIterator<SessionEvent> = {
      next: (): Promise<IteratorResult<SessionEvent>> => {
        if (queue.length > 0) {
          return Promise.resolve({
            value: queue.shift()!,
            done: false,
          });
        }
        if (done) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          resolveNext = resolve;
        });
      },
      // M2：consumer 可以提前 break，触发 session.abort() 取消正在跑的 session。
      // 满足标准 AsyncIterator close protocol：`for await ... break` / iter.return() 都会调这里。
      return: (): Promise<IteratorResult<SessionEvent>> => {
        if (!done) {
          // 让 session 走正常 abort 流程（onSessionEnd 还会 fire，summaryPromise 会 resolve aborted）
          if (!this._abortCtrl.signal.aborted) {
            this._abortCtrl.abort(
              new Error("runStreaming: consumer broke iteration"),
            );
          }
        }
        return Promise.resolve({ value: undefined, done: true });
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };

    return Object.assign(iter, { finalSummary: summaryPromise });
  }

  /* ────────────── 主流程 ────────────── */

  private async _runInternal(args: {
    source: "run" | "continue";
    prompt?: string;
    signal?: AbortSignal;
    contextNotices?: readonly string[];
    contextPreview?: SessionContextPreview | null;
    promptTimestamp?: number;
  }): Promise<RunSummary> {
    if (this._running) {
      throw new Error("AgentSession: run() / continue() already in progress");
    }
    this._running = true;
    try {
      return await this._runInternalUnchecked(args);
    } finally {
      this._running = false;
    }
  }

  private async _runInternalUnchecked(args: {
    source: "run" | "continue";
    prompt?: string;
    signal?: AbortSignal;
    contextNotices?: readonly string[];
    contextPreview?: SessionContextPreview | null;
    promptTimestamp?: number;
  }): Promise<RunSummary> {
    // 每次 run/continue 重建 AbortController；上次的 abort 状态不污染本次
    this._abortCtrl = new AbortController();
    getKernelInternals(this._ctx).setSignal(this._abortCtrl.signal);
    this._runSeq += 1;
    this._contextCheckedKey = null;
    this._pendingAttachments = [];
    this._lastTurnError = null;
    // persistenceErrors 是 per-run 信号（对齐 error/abortReason）：每次 run/continue 清零，
    // 否则上一次的失败会污染本次干净 run 的 RunSummary.persistenceErrors。
    this._persistenceErrors = [];
    // 注意：_steerInbox **故意不在此清空**——park 的 steer 是「等下次跑起来时插队」的用户意图，
    // 应跨 run/continue 边界存活、在首个 turn 的安全点 drain；这与 transient 的 _pendingAttachments
    // （上次 run 的残渣、每次清零）语义相反。别"顺手"加 `this._steerInbox = []` 求对称。

    // 把 caller signal forward 进 internal controller
    const cleanupCallerForward = forwardSignal(args.signal, this._abortCtrl);

    try {
      // session-start 热重载：在 onSessionStart / 首个 turn 之前完成；仅成功才置位，
      // provider 读盘失败留待后续 run 重试（失败绝不失败本次 run）。
      if (
        this._refreshSystemPromptProvider !== undefined &&
        !this._sessionStartRefreshSucceeded
      ) {
        if (await this._refreshPrompt("session-start")) {
          this._sessionStartRefreshSucceeded = true;
        }
      }

      // onSessionStart
      const ssInput: { source: "run" | "continue"; initialPrompt?: string } = {
        source: args.source,
      };
      if (args.prompt !== undefined) ssInput.initialPrompt = args.prompt;
      const ssOut = await this._dispatcher.fireEvent(
        "onSessionStart",
        ssInput,
        this._ctx,
      );
      this._flushSystemMessages(ssOut.systemMessages);
      if (ssOut.initialUserMessage) {
        this._messages.push({
          role: "user",
          content: ssOut.initialUserMessage,
          timestamp: Date.now(),
        });
      }
      for (const c of ssOut.additionalContexts) {
        this._pushAttachment(c, "onSessionStart");
      }

      // run 模式：准入检查（watcher 所有权）先于本轮用户消息与 legacy contextNotices。
      // continue 不重放，与 W16 contextNotices 同口径；preview 三态见 run() 选项注释。
      if (args.source === "run") {
        this._emitContextNotices(0, args.contextPreview);
      }

      // run 模式：push user prompt + UserPromptSubmit
      if (args.source === "run" && args.prompt !== undefined) {
        // W16 上下文变更 prelude（用户口径"注入到会话最前面"=新轮次增量之首——先于本轮
        // 用户消息 push，非会话历史头部；对齐 dsh next-step prepend 语义）。不改写已加载
        // 上下文：systemPrompt 前缀字节冻结不动（W15-B 哨兵），notice 只是普通 user-role
        // 消息、随 HWM 落盘成转录（持久 prelude，区别于 W12 transient reminder 尾通道）。
        // 续跑路径（continue/auto-continuation）source!=="run" 天然不重放 ⇒ 首请求消费一次。
        // undefined/空数组 ⇒ 逐字节旧行为（既有测试钉死）。
        for (const notice of args.contextNotices ?? []) {
          this._messages.push({
            role: "user",
            content: notice,
            timestamp: Date.now(),
          });
        }
        const userMsg: Message = {
          role: "user",
          content: args.prompt,
          timestamp: args.promptTimestamp ?? Date.now(),
        };
        this._messages.push(userMsg);

        const upsOut = await this._dispatcher.fireDecision(
          "onUserPromptSubmit",
          { userMessage: userMsg },
          this._ctx,
        );
        // continue=false OR decision="deny" both halt the prompt
        if (
          upsOut?.continue === false ||
          upsOut?.decision === "deny"
        ) {
          // 终止 run：flush systemMessage 让 operator 看到原因。
          // 不 push additionalContext —— 这条 run 不会再有 LLM call 消费它，
          // 而 _pendingAttachments 会在下次 _runInternalUnchecked 被清空（line ~213），
          // push 进去是 dead write。
          if (upsOut.systemMessage) {
            this._flushSystemMessages([upsOut.systemMessage]);
          }
          const summary: RunSummary = {
            turns: 0,
            continuations: 0,
            reason: "aborted",
            usage: this._accumulatedUsage(),
          };
          const last = this._lastAssistant();
          if (last) {
            summary.lastMessage = last;
            summary.stopReason = last.stopReason;
          }
          const reasonText =
            upsOut.stopReason ??
            upsOut.reason ??
            "onUserPromptSubmit halted";
          summary.abortReason = reasonText;
          await this._fireSessionEnd(0, 0, summary.reason);
          const persistedOk = await this._persistTerminal(summary);
          this._finalizePersistence(summary, persistedOk);
          return summary;
        }
        if (upsOut?.systemMessage) {
          this._flushSystemMessages([upsOut.systemMessage]);
        }
        if (upsOut?.additionalContext) {
          this._pushAttachment(upsOut.additionalContext, "onUserPromptSubmit");
        }
      }

      // turn loop（首轮 + 任意 continuations）
      let turnIdx = 0;
      let continuations = 0;
      let reason: RunSummary["reason"] = "done";

      while (true) {
        const r = await this._runTurnsUntilStop(turnIdx);
        turnIdx = r.turnIdx;
        reason = r.reason;

        if (reason !== "done") break;

        // 到上限就不再问续跑
        if (continuations >= this.maxContinuations) {
          reason = "max_continuations";
          break;
        }

        // 询问 hook 是否要续跑（独立事件 onContinuationCheck，不是 onSessionEnd）
        const ccOut = await this._dispatcher.fireEvent(
          "onContinuationCheck",
          { turns: turnIdx, continuations },
          this._ctx,
        );
        this._flushSystemMessages(ccOut.systemMessages);

        const wantsContinue =
          ccOut.continue === true && !this._abortCtrl.signal.aborted;

        if (!wantsContinue) break;

        continuations++;
        for (const c of ccOut.additionalContexts) {
          this._pushAttachment(c, "onContinuationCheck");
        }
        // 继续下一轮 turn loop
      }

      // 退出 loop：恰好 fire 一次 onSessionEnd（无论 done / aborted / error / max_turns / max_continuations）
      await this._fireSessionEnd(turnIdx, continuations, reason);
      const summary = this._buildSummary(turnIdx, continuations, reason);
      const persistedOk = await this._persistTerminal(summary);
      this._finalizePersistence(summary, persistedOk);
      return summary;
    } finally {
      cleanupCallerForward();
    }
  }

  /**
   * 把上下文变更转成 durable user 消息（随 turn-end flush 落盘）。
   * turn 去重键在 IO 之前置位：同一 (runSeq, turnIdx) 至多检查一次（run-start 的 turn 0
   * 与首个 _phaseLlmCall 共享序号）。preview 三态：undefined=check；null=不检查；
   * 对象=精确 consume。任何失败只 warn，绝不失败 run。
   */
  private _emitContextNotices(
    turnIdx: number,
    preview: SessionContextPreview | null | undefined,
  ): void {
    const watcher = this._contextWatcher;
    if (watcher === undefined) return;
    const key = `${String(this._runSeq)}:${String(turnIdx)}`;
    if (this._contextCheckedKey === key) return;
    this._contextCheckedKey = key;
    if (preview === null) return;
    try {
      const notices: string[] = [];
      if (preview === undefined) {
        const outcome = watcher.check();
        if (outcome !== null) notices.push(...outcome.notices);
      } else {
        const consumed = watcher.consume(preview);
        notices.push(...consumed.stalePreviewNotices);
        if (consumed.outcome !== null) notices.push(...consumed.outcome.notices);
      }
      for (const notice of notices) {
        this._messages.push({ role: "user", content: notice, timestamp: Date.now() });
      }
    } catch (err) {
      this._ctx.log.warn("[session-context] check failed", {
        turnIdx,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async _fireSessionEnd(
    turns: number,
    continuations: number,
    reason: RunSummary["reason"],
  ): Promise<void> {
    const seOut = await this._dispatcher.fireEvent(
      "onSessionEnd",
      { turns, reason, continuations },
      this._ctx,
    );
    this._flushSystemMessages(seOut.systemMessages);
  }

  /**
   * 累加该 session `messages` 里所有 assistant 的 usage（含 cost）。无 LLM 调用则全零。
   *
   * ⚠️ **维护契约**：这是**逐字段手写**累加。pi-ai 的 `Usage` 若新增字段（如 reasoningTokens），
   * TS 不会在这里报错，会**静默漏算** —— 加字段时务必同步这里。
   * `?? 0` / `if (mu.cost)`：pi-ai 的 Usage 字段类型上均必填，这些是**防御 OpenAI-compatible
   * provider（如 DashScope）/ 代理返回畸形 / 缺字段 usage** 的兜底，不是类型层需要。
   */
  private _accumulatedUsage(): Usage {
    const u: Usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    for (const m of this._messages) {
      if (m.role !== "assistant") continue;
      const mu = (m as AssistantMessage).usage;
      if (!mu) continue;
      u.input += mu.input ?? 0;
      u.output += mu.output ?? 0;
      u.cacheRead += mu.cacheRead ?? 0;
      u.cacheWrite += mu.cacheWrite ?? 0;
      u.totalTokens += mu.totalTokens ?? 0;
      if (mu.cost) {
        u.cost.input += mu.cost.input ?? 0;
        u.cost.output += mu.cost.output ?? 0;
        u.cost.cacheRead += mu.cost.cacheRead ?? 0;
        u.cost.cacheWrite += mu.cost.cacheWrite ?? 0;
        u.cost.total += mu.cost.total ?? 0;
      }
    }
    return u;
  }

  /** 最后一条 assistant 消息（用于 RunSummary.lastMessage）。 */
  private _lastAssistant(): AssistantMessage | undefined {
    for (let i = this._messages.length - 1; i >= 0; i--) {
      const m = this._messages[i];
      if (m && m.role === "assistant") return m as AssistantMessage;
    }
    return undefined;
  }

  private _buildSummary(
    turns: number,
    continuations: number,
    reason: RunSummary["reason"],
  ): RunSummary {
    const last = this._lastAssistant();
    const summary: RunSummary = {
      turns,
      continuations,
      reason,
      usage: this._accumulatedUsage(),
    };
    if (last) {
      summary.lastMessage = last;
      summary.stopReason = last.stopReason;
    }
    if (this._lastTurnError) summary.error = this._lastTurnError;
    if (this._abortCtrl.signal.aborted) {
      const r = this._abortCtrl.signal.reason;
      summary.abortReason = r instanceof Error ? r.message : String(r ?? "aborted");
    }
    return summary;
  }

  /**
   * 记录一次 store I/O 失败：写日志 + 计入 `_persistenceErrors`（两种模式都记，最终都挂上 RunSummary）。
   * best-effort 下失败不劫持控制流（下次 flush 从未成功处重试）；strict 下由 `_finalizePersistence`
   * 据「最终是否真正落盘完成」改写终态，故此处只如实记录、不改控制流。
   */
  private _reportStoreError(op: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    this._persistenceErrors.push(`${op}: ${msg}`);
    const note = this._strictPersistence
      ? "strict persistence"
      : "best-effort persistence, will retry next flush";
    this._consoleSink(`[session-store] ${op} failed (${note}): ${msg}`, {
      sessionId: this.id,
      turnIdx: this._ctx.turnIdx,
    });
  }

  /**
   * 把自上次以来的新 messages append 进 store（顺序、append-only）。无 store 即 no-op。
   *
   * `_persistedCount` 是 **high-water-mark，逐条推进**：append 成功一条才前进一条 —— 中途
   * `appendEntry` 抛错时计数器停在已成功处，下次 flush 从失败那条重试，**绝不重复 append**
   * （store 是 append-only、不去重，重复 append 会让 resume 读出重复消息）。
   * best-effort：append 失败被 catch，不抛给控制流（持久化失败不该杀掉 run）。
   * 依赖 `_messages` **append-only、索引稳定**（内核只 push，从不 splice/reorder）—— HWM 才成立。
   *
   * 返回是否全部 flush 成功（无 store 视为成功）；调用方据此判断持久化是否真正完成。
   */
  private async _flushToStore(): Promise<boolean> {
    if (!this._store) return true;
    try {
      for (; this._persistedCount < this._messages.length; this._persistedCount++) {
        const pending = this._messages[this._persistedCount]!;
        // W16-F5 脏对防御：abort/error 微轮的**零内容块** assistant（_phaseLlmCall 无条件 push）
        // 不落盘——它无正文、无 toolCall、resume 读回即孤儿尾巴噪声（现网 loom-main seq16 即此形）。
        // HWM 照常前进（append-only 索引稳定），绝不回退或重 index 前序已落条目。
        if (isEmptyArtifactAssistant(pending)) continue;
        await this._store.appendEntry(this.id, {
          kind: "message",
          message: pending,
        });
      }
      return true;
    } catch (err) {
      this._reportStoreError("appendEntry(message)", err);
      return false;
    }
  }

  /**
   * run 结束：flush 剩余 messages + append 一条 terminal entry（终态元数据）。无 store 即 no-op。
   * 返回「最终 flush + terminal append 是否都成功」这个真实完成信号，供 `_finalizePersistence` 裁决。
   */
  private async _persistTerminal(summary: RunSummary): Promise<boolean> {
    if (!this._store) return true;
    const flushed = await this._flushToStore();
    // W16-F5 封一幂等（一轮一封印）：转录水位较上次封印零前进的空轮（abort 竞态双 flush 防御面、
    // 零增量微轮的"usage 同款脏 terminal"观感源）不再重封——check→置位同步无 await，单线程原子；
    // 正常轮必带新条目（prompt/toolResult/正文）水位前进，照常封印，逐 run/continue 语义不动。
    if (this._persistedCount === this._lastSealCount) {
      return flushed;
    }
    let terminalAppendedOk = true;
    try {
      this._lastSealCount = this._persistedCount;
      await this._store.appendEntry(this.id, { kind: "terminal", result: summary });
    } catch (err) {
      this._reportStoreError("appendEntry(terminal)", err);
      terminalAppendedOk = false;
    }
    return flushed && terminalAppendedOk;
  }

  /**
   * run 返回前对持久化结果做最终裁决：把累积的 persistenceErrors 如实挂上 summary；strict 模式下若持久化
   * 未真正完成（persistedOk=false）则把 reason 改 "error" 并补 error。persistedOk 用「最终 flush+terminal
   * 是否成功」这个真实完成信号，而非「是否出现过 error」——故 best-effort 下的瞬时错误若已重试成功，strict
   * 不会误判。
   *
   * **只提级 `done`**：strict 仅把「本应成功(done)却落盘不全」这一危险情形提级为 error；已是非 done 终态
   * （aborted/error/max_turns/max_continuations）**不被覆盖**——它们本就非干净成功、调用方不会误信，且
   * persistenceErrors 已如实暴露失败。这避免 strict 用 "error" 盖掉合法的 aborted/max_turns 信号，
   * 也保留某 turn 自然抛错时的原始 `summary.error`（不被 "strict persistence failed" 顶替）。
   */
  private _finalizePersistence(summary: RunSummary, persistedOk: boolean): void {
    if (this._persistenceErrors.length > 0) {
      summary.persistenceErrors = [...this._persistenceErrors];
    }
    if (this._strictPersistence && !persistedOk && summary.reason === "done") {
      summary.reason = "error";
      summary.error = new Error(
        `strict persistence failed: ${this._persistenceErrors.join("; ") || "store append did not complete"}`,
      );
    }
  }

  /**
   * 从 store 的落盘历史重建一个绑回同一 lineage 的 AgentSession，可直接 `continue()` 续跑。
   * 重放规则/信任边界/引用不可变见 `_replayStoreHistory`（与 `hydrateFromStore` 同源）。
   * 重建出的 messages 经 `initialMessages` + `resumedMessageCount` 标记为「已持久化」，续跑只 append 新消息。
   */
  static async resume(
    store: SessionStore,
    sessionId: string,
    opts: Omit<
      AgentSessionOptions,
      "store" | "sessionId" | "initialMessages" | "resumedMessageCount"
    >,
  ): Promise<AgentSession> {
    const replayed = await AgentSession._replayStoreHistory(store, sessionId);
    const session = new AgentSession({
      ...opts,
      store,
      sessionId,
      initialMessages: replayed.messages,
      resumedMessageCount: replayed.messages.length,
    });
    session._seedReplayedBoundary(replayed.boundary);
    return session;
  }

  /**
   * W17-G 重启对话连续性（registry 惰性 resume 面）：把一个**空内存构造**的本实例
   * 绑到 store 落盘历史——与 `resume` 同源共用 `_replayStoreHistory` 重放体，算法零分叉。
   *
   * 语义 = resume 的同步等价物，但**原地灌入**（不新建实例）：`_messages` 就地把重放行
   * push 进原数组（HookContextImpl 在构造期持 `messages` **引用**，见构造器 ctxDeps；
   * 重新赋值会留下 ctx 指向空数组的脑裂），并把 `_persistedCount`（HWM）抬到重放长度
   * ⇒ 续跑只 append 新消息、绝不重复落盘前缀（resume.test.ts:325 同款钉）。id/事件总线/
   * hooks 全部不动 ⇒ 上层（server SessionRegistry）的 loop/hub 引用保持逐字节旧形状。
   *
   * 返回是否真有历史可载：store 不持有该 sid（getLeafId=null）或未绑 store ⇒ false，
   * 新会话零变化（逐字节旧行为）。前置不变量（程序员契约，违反=fail-loud throw，
   * 绝不静默双载）：消息为空且无 run 在途——双载会重放重复历史并污染 HWM。
   */
  async hydrateFromStore(): Promise<boolean> {
    const store = this._store;
    if (store === undefined) return false;
    if (this._messages.length > 0 || this._running) {
      throw new Error(
        "AgentSession.hydrateFromStore(): only allowed on an idle, not-yet-populated session",
      );
    }
    if ((await store.getLeafId(this.id)) === null) return false;
    const replayed = await AgentSession._replayStoreHistory(store, this.id);
    this._messages.push(...replayed.messages);
    this._persistedCount = replayed.messages.length;
    this._seedReplayedBoundary(replayed.boundary);
    this._lastWatermarkLevel = this._maxPersistedWatermarkLevel();
    return true;
  }

  /**
   * 把重放进来的持久化压缩边界写进 live 面（`_activeBoundary` + `ctx.state`）。
   * `coveredCount` 固定为 1：重放后的 `_messages` 是 `[summary, ...retained uncovered tail]`，
   * summary 本身占一条坐标。历史累计条数另存 `historicalCoveredCount`（checkpoint 坐标系）。
   */
  private _seedReplayedBoundary(boundary: ReplayedBoundary | null): void {
    if (boundary === null) return;
    const active: ActiveBoundary = {
      summary: boundary.summary,
      coveredCount: 1,
      restored: true,
      rehydratedCount: this._messages.length,
      historicalCoveredCount: boundary.historicalCoveredCount,
      checkpointId: boundary.checkpointId,
      anchorTimestampMs: boundary.anchorTimestampMs,
    };
    this._activeBoundary = active;
    this._ctx.state.set(ACTIVE_BOUNDARY_KEY, active);
  }

  /**
   * resume 重放体（`resume` 与 `hydrateFromStore` 唯一共用实现；改动两处语义必须同步）。
   * 按 root→leaf 沿 lineage 重建 messages；遇 `compaction_boundary` 丢弃被 summary 替换的
   * 前缀，重放后的 live 面 = `[summary, ...retained uncovered tail]`（SessionStore 故意不
   * 裁剪、把裁剪留给重放体，见 session-store.ts）；`terminal` 忽略（仅元数据）。
   * 尾部保留策略见 `resolveCheckpointTailIncluded` 与循环内注释。
   * 尾部 assistant 的悬挂 toolCall → 合成 isError toolResult **并即时 append 回 store**
   * （配对不变量修复）。
   * **信任边界**：不可信落盘数据进内核的唯一入口——信任 store 返回的 `Message` schema
   * 合法（校验是 adapter 职责），只修配对。
   * **引用不可变**：直接复用 store 返回的引用；依赖 hooks/pipes 不原地 mutate message
   * （与 SessionStore 的不可变契约一致，见 session-store.ts:SessionEntry）。
   */
  private static async _replayStoreHistory(
    store: SessionStore,
    sessionId: string,
  ): Promise<{ messages: Message[]; boundary: ReplayedBoundary | null }> {
    const path = await store.getPathToLeaf(sessionId);
    const boundaryIndices: number[] = [];
    for (let i = 0; i < path.length; i++) {
      if (path[i]?.entry.kind === "compaction_boundary") boundaryIndices.push(i);
    }
    const lastBoundaryIndex = boundaryIndices[boundaryIndices.length - 1] ?? -1;
    // 下一边界是否带显式 tailIncluded：transition lookahead 用。下一边界若是 worker
    // checkpoint（显式 true/false），它的 coveredCount 可能是对着「含上一条 legacy
    // tail」的 live 数组算的，丢弃上一条 tail 会让它的坐标整体左移。
    const nextBoundaryHasExplicitTail = new Map<number, boolean>();
    for (let i = 0; i < boundaryIndices.length; i++) {
      const boundaryIndex = boundaryIndices[i]!;
      const nextIndex = boundaryIndices[i + 1];
      const nextEntry = nextIndex === undefined ? undefined : path[nextIndex]?.entry;
      nextBoundaryHasExplicitTail.set(
        boundaryIndex,
        nextEntry?.kind === "compaction_boundary" &&
          nextEntry.checkpoint?.tailIncluded !== undefined,
      );
    }
    const msgs: Message[] = [];
    let messageCount = 0;
    let previousBoundaryMessageCount: number | null = null;
    let boundaryMessageCount: number | null = null;
    let boundaryEntry: StoredEntry | null = null;
    for (let pathIndex = 0; pathIndex < path.length; pathIndex++) {
      const stored = path[pathIndex]!;
      const entry = stored.entry;
      if (entry.kind === "message") {
        messageCount++;
        msgs.push(entry.message);
      } else if (entry.kind === "compaction_boundary") {
        previousBoundaryMessageCount = boundaryMessageCount;
        boundaryMessageCount = messageCount;
        const checkpoint = entry.checkpoint;
        const tailIncluded = resolveCheckpointTailIncluded(
          checkpoint,
          messageFullText(entry.summary),
        );
        let keepFrom: number;
        if (checkpoint === undefined || tailIncluded === true) {
          // checkpointless legacy / summary 已内嵌 tail：整段前缀由 summary 替换。
          keepFrom = msgs.length;
        } else if (tailIncluded === false) {
          // worker summary 只覆盖前缀：保留 checkpoint 未覆盖的 recent tail。
          keepFrom = Math.max(0, Math.min(checkpoint.coveredCount, msgs.length));
        } else if (
          pathIndex !== lastBoundaryIndex &&
          nextBoundaryHasExplicitTail.get(pathIndex) !== true
        ) {
          // 非最后边界且下一边界无显式 tail 标记：丢弃，避免跨边界坐标漂移（历史救援另案）。
          keepFrom = msgs.length;
        } else {
          // 最后边界，或下一边界带显式 tailIncluded 的 transition 边界：保留 legacy
          // checkpoint 未覆盖的 tail。优先按 anchorTimestampMs 对齐 coveredCount 与重放
          // 坐标（两者都以 raw 坐标记录，但早期尾段可能已被丢弃）。
          const covered = Math.max(
            0,
            Math.min(checkpoint.coveredCount, msgs.length),
          );
          keepFrom = covered;
          const anchor = checkpoint.anchorTimestampMs;
          if (anchor !== null && msgs[covered]?.timestamp !== anchor) {
            for (let i = 1; i < msgs.length; i++) {
              if (msgs[i]?.timestamp === anchor) {
                keepFrom = i;
                break;
              }
            }
          }
        }
        const tail = msgs.slice(keepFrom);
        msgs.length = 0;
        msgs.push(entry.summary, ...tail);
        boundaryEntry = stored;
      }
      // terminal: 忽略
    }
    let trailingAssistantIndex = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.role === "assistant") {
        trailingAssistantIndex = i;
        break;
      }
    }
    const trailingAssistant = msgs[trailingAssistantIndex];
    if (trailingAssistant?.role === "assistant") {
      const resolved = new Set<string>();
      for (let i = trailingAssistantIndex + 1; i < msgs.length; i++) {
        const message = msgs[i];
        if (message?.role === "toolResult") resolved.add(message.toolCallId);
      }
      for (const block of trailingAssistant.content) {
        if (block.type !== "toolCall" || resolved.has(block.id)) continue;
        const toolResult: ToolResultMessage = {
          role: "toolResult",
          toolCallId: block.id,
          toolName: block.name,
          content: [
            {
              type: "text",
              text: "interrupted before completion (synthesized on resume)",
            },
          ],
          isError: true,
          timestamp: Date.now(),
        };
        await store.appendEntry(sessionId, {
          kind: "message",
          message: toolResult,
        });
        msgs.push(toolResult);
        resolved.add(block.id);
      }
    }
    let boundary: ReplayedBoundary | null = null;
    if (boundaryEntry !== null && boundaryEntry.entry.kind === "compaction_boundary") {
      const entry = boundaryEntry.entry;
      const summary = msgs[0];
      if (summary === undefined) {
        throw new Error("_replayStoreHistory: compaction boundary produced no summary");
      }
      boundary = {
        summary,
        historicalCoveredCount:
          entry.checkpoint?.coveredCount ??
          legacyCheckpointCoveredCount(
            previousBoundaryMessageCount,
            boundaryMessageCount ?? 0,
          ),
        checkpointId: entry.checkpoint?.summaryId ?? boundaryEntry.id,
        anchorTimestampMs:
          entry.checkpoint?.anchorTimestampMs ?? msgs[1]?.timestamp ?? null,
      };
    }
    return { messages: msgs, boundary };
  }

  /**
   * 跑 turn 直到某种结束（done / abort / error / max_turns）。
   * 不处理 onSessionEnd —— 调用方决定要不要续跑。
   */
  private async _runTurnsUntilStop(
    startTurnIdx: number,
  ): Promise<{ turnIdx: number; reason: RunSummary["reason"] }> {
    let turnIdx = startTurnIdx;

    while (turnIdx < this.maxTurns) {
      if (this._abortCtrl.signal.aborted) {
        return { turnIdx, reason: "aborted" };
      }

      getKernelInternals(this._ctx).setTurnIdx(turnIdx);
      const outcome = await this._runOneTurn(turnIdx);
      turnIdx++;

      // 每个 turn 结束把新 messages append 进 store（durable resume；no-op if no store）。
      await this._flushToStore();

      // After-flush 观测点（C1，docs/09 §4.2）：仅有 store 时 fire。**collect-return**：hook 不持有
      // 任何写能力，只**返回** boundary；内核在这里 in-band、awaited、串行地把它写进 store——在进入
      // 下一轮 loop / 下一次 _flushToStore / terminal **之前**完成。这保证：boundary 永远落在「它之后
      // 的消息 flush」之前，且绝无两个 appendEntry 并发同 session（满足 SessionStore 串行契约）。
      //
      // 超时的 hook 其返回被 dispatcher 的 race 丢弃 → fireAfterFlush 拿不到它的 boundary → 这里不写
      // → 该 turn 无 boundary（干净跳过，**绝不产生 detached store 写**）。这是上一版「detached 写能力」
      // 设计导致 data-loss/乱序的根因修复。
      //
      // boundary 是 store 侧额外 entry，**不动** _persistedCount / _messages（HWM 不变量保持）。
      // append 抛错按 best-effort 处理（记 failureSink、不杀 run），与 _flushToStore 一致。
      if (this._store) {
        const boundaries = await this._dispatcher.fireAfterFlush(
          {
            // 刚跑完并 flush 的那个 turn 的序号（_ctx.turnIdx 仍是 :setTurnIdx 设的值，
            // 而局部 turnIdx 已 ++ 指向下一轮）—— 与 onContextOverflow 取 _ctx.turnIdx 一致。
            turnIdx: this._ctx.turnIdx,
            persistedCount: this._persistedCount,
          },
          this._ctx,
        );
        // 多个 hook 都返回 boundary 时按顺序逐条 append（正常只 1 个）。
        // 裸 Message 是 legacy 写法；payload 形态额外把信息性 checkpoint 元数据原样落库。
        for (const boundary of boundaries) {
          try {
            const entry: SessionEntry = isCompactionCheckpointPayload(boundary)
              ? {
                  kind: "compaction_boundary",
                  summary: boundary.summary,
                  checkpoint: boundary.checkpoint,
                }
              : { kind: "compaction_boundary", summary: boundary };
            await this._store.appendEntry(this.id, entry);
          } catch (err) {
            this._reportStoreError("appendEntry(compaction_boundary)", err);
          }
        }
      }

      // 从 ctx.state 读取 live boundary、更新 _activeBoundary。
      // 不论有无 store 都执行（目的是稳定 live 投影，与持久化无关）。
      // autoCompaction 在 transformMessagesBeforeLlm 内 ctx.state.set(ACTIVE_BOUNDARY_KEY, ...) 后，
      // 下一 turn 的 _phaseLlmCall 即可用同一 summary 对象投影。
      const newBoundary = this._ctx.state.get(ACTIVE_BOUNDARY_KEY);
      if (newBoundary !== undefined) {
        const boundaryChanged =
          newBoundary !== this._activeBoundary ||
          newBoundary.checkpointId !== this._activeBoundary?.checkpointId;
        this._activeBoundary = newBoundary;
        // legacy 路径（hook 直接写 ctx.state）：turn 末尾刷新；worker commit 路径已在
        // commitCompaction 内刷过且 `_activeBoundary` 是同一对象，此处不会双刷。
        if (
          boundaryChanged &&
          newBoundary.restored !== true &&
          this._refreshSystemPromptProvider !== undefined
        ) {
          await this._refreshPrompt("compaction");
        }
      }

      if (outcome === "done") return { turnIdx, reason: "done" };
      if (outcome === "abort") return { turnIdx, reason: "aborted" };
      if (outcome === "error") return { turnIdx, reason: "error" };
    }
    return { turnIdx, reason: "max_turns" };
  }

  /**
   * Drain steering inbox（docs/09 §3.5）：原子取走队列、按入队顺序 push 进 _messages，并对每条
   * fire 一次 onSteer。在 turn 开始的安全点调用，保证插队消息进入下一次 buildMessages、且不破坏
   * 进行中 turn 的原子性。
   *
   * 原子性：`drained = inbox; inbox = []` 是同步 swap，读取与清空之间无 await，所以 fire onSteer 期间
   * steer() 的新 push 落进新数组、下个 turn 再 drain，既不丢也不重。
   */
  private async _drainSteerInbox(turnIdx: number): Promise<void> {
    if (this._steerInbox.length === 0) return;
    const drained = this._steerInbox;
    this._steerInbox = [];
    for (const entry of drained) {
      const message = entry.message;
      this._messages.push(message);
      const out = await this._dispatcher.fireEvent(
        "onSteer",
        { message, turnIdx },
        this._ctx,
      );
      this._flushSystemMessages(out.systemMessages);
      for (const c of out.additionalContexts) {
        this._pushAttachment(c, "onSteer");
      }
      if (entry.onDrained !== undefined) {
        try {
          entry.onDrained();
        } catch (err) {
          // 回调是通知面，抛错绝不杀 turn；与 hook 失败同口上报。
          this._hookFailureSink?.({
            hookName: "steer",
            method: "onDrained",
            errorMessage: err instanceof Error ? err.message : String(err),
            internal: false,
          });
        }
      }
    }
  }

  /**
   * 单 turn 的完整逻辑。3 个 phase 串起来，外层包 wrapTurn around chain。
   * 每个 phase 做一件事，方便 reviewer 改某一阶段不动其他 phase 的缩进。
   *
   *   drainSteer → onTurnStart event → wrapTurn[ _phaseLlmCall → _phaseToolBatch → _phaseTurnEnd ]
   */
  private async _runOneTurn(turnIdx: number): Promise<TurnOutcome> {
    // 安全点：turn 开始前 drain steering inbox，把 park 的消息注入下一次 buildMessages。
    await this._drainSteerInbox(turnIdx);

    const tsOut = await this._dispatcher.fireEvent(
      "onTurnStart",
      { turnIdx },
      this._ctx,
    );
    this._flushSystemMessages(tsOut.systemMessages);
    for (const c of tsOut.additionalContexts) {
      this._pushAttachment(c, "onTurnStart");
    }

    const turnOut: { assistant: AssistantMessage | null } = { assistant: null };

    try {
      const inner = async (): Promise<void> => {
        const assistant = await this._phaseLlmCall();
        turnOut.assistant = assistant;
        if (this._abortCtrl.signal.aborted) return;

        const toolResults = await this._phaseToolBatch(assistant);
        await this._phaseTurnEnd(turnIdx, assistant, toolResults);
      };

      const wrapped = this._dispatcher.buildWrapTurn(this._ctx, inner);
      await wrapped();
    } catch (err) {
      this._lastTurnError =
        err instanceof Error ? err : new Error(String(err));
      return "error";
    }

    if (this._abortCtrl.signal.aborted) return "abort";
    const finalAssistant = turnOut.assistant;
    if (!finalAssistant) return "error";
    if (finalAssistant.stopReason !== "toolUse") return "done";
    return "continue";
  }

  /**
   * 每次 LLM 调用前的压缩闸门（W57 P2c-2）。顺序即状态机优先级：
   *   1. 有在飞 attempt → 等它；失败则让本 turn 失败，成功则用新 boundary 继续。
   *   2. retry_pending → 用原 reason 再试一次（失败仍保持 retry_pending）。
   *   3. compacting 但无在飞 worker（崩溃残留）→ 明确报错，绝不发正常 LLM 请求；
   *      boot 恢复可先调 `CompactionCoordinator.recoverStaleCompacting()`。
   *   4. idle → 估算投影后的整次请求；`>= fallbackTokens` 时启动 reason="fallback"。
   *
   * 成功路径不改这里的状态：worker commit 已原子更新 `_activeBoundary`/ctx.state，
   * 紧随其后的 `_phaseLlmCall` 自然按新投影组装 baseMessages。
   *
   * P3：idle 分支先按投影体积发一次水位提醒（若跨过新档位），再判 fallback——因此
   * 600k notice 会进入本次请求，即使同一轮紧接着触发 750k 兜底压缩。
   */
  private async _prepareCompactionForLlm(): Promise<void> {
    const coordinator = this._compactionCoordinator;
    if (coordinator === null) return;

    if (coordinator.isRunning) {
      const outcome = await coordinator.wait();
      if (!outcome.ok) throw new CompactionFailedError(outcome);
      return;
    }

    const state = coordinator.state;
    const status = state?.status ?? "idle";
    switch (status) {
      case "retry_pending": {
        await this._startCompactionAndWait(coordinator, state?.reason ?? "fallback");
        return;
      }
      case "compacting": {
        throw new CompactionRecoveryRequiredError(this.id, state?.attemptId ?? null);
      }
      case "idle": {
        const estimated = this._estimateProjectedRequestTokens();
        this._maybeEmitContextWatermark(estimated);
        if (state?.fallbackSuppressed === true) return;
        if (estimated < this._compactionFallbackTokens) return;
        await this._startCompactionAndWait(coordinator, "fallback");
        return;
      }
      default: {
        const unreachable: never = status;
        throw new Error(`unsupported compaction state: ${String(unreachable)}`);
      }
    }
  }

  private async _startCompactionAndWait(
    coordinator: CompactionCoordinator,
    reason: CompactionReason,
  ): Promise<void> {
    const outcome = await coordinator.start(reason).done;
    if (!outcome.ok) throw new CompactionFailedError(outcome);
  }

  /** 扫描 `_messages` 里持久化的水位 notice，恢复已提醒到的最高档位（重放/水合路径）。 */
  private _maxPersistedWatermarkLevel(): number {
    let highest = 0;
    for (const message of this._messages) {
      const level = contextWatermarkLevel(message);
      if (level !== null && level > highest) highest = level;
    }
    return highest;
  }

  /**
   * 若投影请求体积跨过新的配置档位，向 `_messages` append 一条持久水位 notice。
   * - 每档至多一次；跳级只发跨过的最高档（例如 290k → 610k 只发 600k）。
   * - 压缩成功后的下一次 LLM 调用由 one-turn grace 吞掉（避免刚压完立刻重复提醒）。
   * - notice 是普通 user-role message，随 turn-end flush 落盘；本次 `_phaseLlmCall`
   *   在 `_prepare` 之后才组装 baseMessages，故一定进入当前请求。
   */
  private _maybeEmitContextWatermark(estimatedTokens: number): void {
    if (this._watermarkGracePending) {
      this._watermarkGracePending = false;
      return;
    }
    const levels = this._compactionWatermarkLevels;
    if (levels.length === 0) return;
    const level = highestWatermarkLevelAtOrBelow(levels, estimatedTokens);
    if (level <= this._lastWatermarkLevel) return;
    const highestConfigured = levels[levels.length - 1];
    this._messages.push(
      buildContextWatermarkMessage({
        level,
        estimatedTokens,
        hardCap: this._compactionFallbackTokens,
        ...(highestConfigured === level ? { isHighest: true } : {}),
      }),
    );
    this._lastWatermarkLevel = level;
  }

  /** 估算「下一次 LLM 请求」的体积：live boundary 投影（或全量 `_messages`）+ tools/systemPrompt。 */
  private _estimateProjectedRequestTokens(): number {
    const boundary = this._activeBoundary;
    const messages =
      boundary === null
        ? [...this._messages, ...this._pendingAttachments]
        : [
            boundary.summary,
            ...this._messages.slice(boundary.coveredCount),
            ...this._pendingAttachments,
          ];
    const tools = this.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
    return hybridTokenCounter.estimate({
      messages,
      tools,
      systemPrompt: this.systemPrompt,
      usageFloorIndex: boundary === null ? 0 : 1,
    });
  }

  /**
   * Phase 1 / 3：LLM call。
   *   - pipe systemPrompt + messages
   *   - flush pendingAttachments（已纳入 transformed view）
   *   - 调 pi-ai complete()，失败 fire onError 后 re-throw
   *   - onLlmEnd event
   *   - assistant push 进 session.messages
   */
  private async _phaseLlmCall(): Promise<AssistantMessage> {
    await this._prepareCompactionForLlm();
    // 每 turn 检查点：压缩闸门之后（commit 的 reseed 已生效、边界投影已定），
    // 装配 baseMessages 之前——新 notice 落在未覆盖尾巴并进入本次请求。
    if (this._contextCheckEachTurn && this._contextWatcher !== undefined) {
      this._emitContextNotices(this._ctx.turnIdx, undefined);
    }
    const sysPrompt = await this._dispatcher.firePipeSystemPrompt(
      this.systemPrompt,
      this._ctx,
    );
    // live boundary 投影：_activeBoundary 已设则投 [summary, _messages[K..], pending]，
    // 未设则照旧 [_messages, pending]。复用同一 summary 对象 →
    // turn 间 prefix bytes 稳定、最大化 provider 的 prompt-cache 命中率。
    const baseMessages: Message[] = this._activeBoundary !== null
      ? [
          this._activeBoundary.summary,
          ...this._messages.slice(this._activeBoundary.coveredCount),
          ...this._pendingAttachments,
        ]
      : [
          ...this._messages,
          ...this._pendingAttachments,
        ];
    const transformed = await this._dispatcher.firePipeMessages(
      baseMessages,
      this._ctx,
    );
    // 发线前兜底：压缩边界/重放可能留下 orphan toolResult（provider 400）。
    // 复用 fork 面同一过滤器，只改本次请求、不改 _messages 真相。
    const wireMessages = filterIncompleteToolCalls(transformed);
    // W17-B transient 尾标：清空前记录本轮随发附件条数（附件恒为 baseMessages 连续尾段，
    // 见 wire-capture.ts transientCount 字段申明与其中的 compaction 诚实口径）。
    const transientCount = this._pendingAttachments.length;
    this._pendingAttachments = [];

    const baseTools = this.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
    const piTools = await this._dispatcher.firePipeTools(baseTools, this._ctx);
    const context: Context = {
      messages: markDeepSeekReasoningContent(stripHarnessOnlyFields(wireMessages), this.model),
      tools: piTools,
      ...(sysPrompt ? { systemPrompt: sysPrompt } : {}),
    };
    const wireOptions = resolveLlmOptions(this._llmOptions);
    // W17-A A1 装配口快照：捕获点在**一切变换之后**（pipe sysPrompt / pipe messages /
    // pipe tools / strip harness-only / resolveLlmOptions 摊平）、stream() 发出之前；
    // _pendingAttachments 已于上方清空，但附件内容此刻就在 context.messages 里（transient
    // 只进发线不进转录，W12）。捕获时刻**同步**序列化成文本——pi-ai provider 可能事后
    // mutate 对象，留引用不可靠。纯只读：不改 context / wireOptions 一字节（W15-B 零扰动）。
    this._lastWireRequest = snapshotWireRequest({
      turnIdx: this._ctx.turnIdx,
      model: this.model,
      context,
      options: wireOptions,
      transientCount,
    });

    // ── W42a 瞬时 provider 错误重试循环 ──
    // pi-ai 把 provider 运行时错误表达成 error 流事件：result() **resolve**（不 reject）出
    // stopReason="error"、或 provider 侧中断的异常 "aborted"（本地无 abort 信号）终态。此类错误多为
    // 瞬时（socket terminated / 5xx / 限流），放弃前对**同一已装配请求**（context/options 逐字节复用）
    // 重发至多 llmErrorRetries 次，退避 base×2ⁿ（缺省 1s/2s）。不重试的三类都是语义边界，别"统一"：
    //   - stream() 同步抛（建流期=connection/config 类，走下方 catch，旧路径逐字节不变）；
    //   - overflow 分类（length / overflow 文案）——超长 prompt 重发照样超长，重试=徒劳；onContextOverflow
    //     通道语义（docs/09 §3.6、fire 不改控制流）整体不动；
    //   - 真用户 abort（本地信号在飞的 aborted）——用户意志走既有 abort 通道。
    // 重试发生在同一 turn 内：不经过 _runOneTurn 返回、不 flush、turnIdx 不前进（不消耗回合数）。
    // 每次 attempt 各自成对 message_start/end（live 配对契约逐 call 成立）；onLlmEnd/push 只属终态。
    let attempt = 0;
    let assistant: AssistantMessage;
    let llmDurationMs = 0;
    for (;;) {
      const t0 = Date.now();
      this._emitLive({ type: "message_start" });
      try {
        // stream() 而非 complete()：complete() 内部就是 stream().result()，两者结果完全等价，
        // 但 stream 让我们在回合进行中把 delta 作为 live 事件发出（Event Bus）。
        const s = stream(this.model, context, {
          ...wireOptions,
          signal: this._abortCtrl.signal,
          // W17-A A2 provider 发线口捕获。pi-ai 硬契约：onPayload 收到**非 undefined 返回
          // 会替换出向载荷**（providers/openai-completions.js:78 `if (nextParams !== undefined)
          // params = nextParams`）——故本闭包只允许裸赋值语句体、返回 undefined（只捕获不
          // 替换）。一次 call 内 provider 多次调用 = last-write-wins（只留末次实发载荷，
          // 单槽覆盖同 A1）。fake model 通道不读 options → 本闭包永不触发 → 如实缺席。
          onPayload: (payload) => {
            this._lastProviderPayload = canonicalJson(payload);
            this._providerPayloadCapturedAt = Date.now();
          },
        });
        for await (const ev of s) {
          // pi-ai 的 delta 事件字段名（contentIndex/delta）与 LiveEvent 一致，直接转发。
          if (
            ev.type === "text_delta" ||
            ev.type === "thinking_delta" ||
            ev.type === "toolcall_delta"
          ) {
            this._emitLive({ type: ev.type, contentIndex: ev.contentIndex, delta: ev.delta });
          } else if (
            ev.type === "text_end" ||
            ev.type === "thinking_end" ||
            ev.type === "toolcall_end"
          ) {
            // 内容块收尾：发一次「已拼好的整条消息」快照（pi-ai 的 partial）。低频、给快照式前端。
            this._emitLive({ type: "message_update", message: ev.partial });
          }
        }
        assistant = await s.result();
      } catch (err) {
        // message_start 必须配对：抛错 / abort 时也发 message_end（不带 message）。
        this._emitLive({ type: "message_end" });
        await this._dispatcher.fireError(
          {
            phase: "llm",
            err: err instanceof Error ? err : new Error(String(err)),
          },
          this._ctx,
        );
        throw err;
      }
      llmDurationMs = Date.now() - t0;
      this._emitLive({ type: "message_end", message: assistant });

      // W23-A 发线面持久回调：调用已 resolve（A1 槽已设、A2 载荷此刻已落位；fake 通道为
      // 如实 null）。fire-and-forget——回调抛错吞断留观测纪律：绝不路由、绝不反噬回合。
      // 同步抛的 call（上方 catch 路径）不在此列：「解析完成」是其前提。重试=新的 LLM call，
      // 本回调逐 attempt 各触发一次（单槽 last-write-wins 落终态 attempt 的字节）。
      if (this._onWireSnapshot !== undefined) {
        try {
          this._onWireSnapshot(this._lastWireRequest!, this._lastProviderPayload);
        } catch {
          /* fail-soft：持久面缺席好过回合被观测回调炸死 */
        }
      }

      if (this._detectOverflow(assistant) !== null) break; // overflow 通道：单次发送、不重试（见上）
      if (!this._isTransientLlmFailure(assistant)) break; // 正常终态/真用户 abort
      if (attempt >= this._llmErrorRetries || this._abortCtrl.signal.aborted) break; // 耗尽/中断在途 → 走诚实终态化
      const interrupted = await this._sleepRetryBackoff(attempt);
      if (interrupted) break; // 退避窗口内 abort：不再重发，走既有 abort 通道
      attempt++;
      this._consoleSink(
        `[llm-retry] 重发 attempt ${attempt + 1}/${this._llmErrorRetries + 1}：` +
          `stopReason="${assistant.stopReason}" err=${assistant.errorMessage ?? "(no errorMessage)"}`,
        { sessionId: this.id, turnIdx: this._ctx.turnIdx },
      );
    }

    const lleOut = await this._dispatcher.fireEvent(
      "onLlmEnd",
      { msg: assistant, durationMs: llmDurationMs },
      this._ctx,
    );
    this._flushSystemMessages(lleOut.systemMessages);
    this._messages.push(assistant);

    // Context overflow 观测点（docs/09 §3.6）。pi-ai 把「越界」表达成两种 resolve 出的终态：
    //   - stopReason==="length"：输出/窗口被模型截断（无歧义，必是 overflow）。
    //   - stopReason==="error" + errorMessage 命中 overflow 文案（provider 把 context-overflow 当
    //     API error 报回，pi-ai 转成 error 流事件 → result() resolve 出 stopReason==="error"）。
    // 内核只「发事件」，不再当普通 done 静默吞掉；压缩/重启策略全在插件（ctx.abort("compaction:...")
    // → compactRestartFresh 重启 fresh，或 transformMessagesBeforeLlm 改写消息）。注意 fire 不改控制流：
    // 没策略 abort 时这条 length / overflow-error assistant 仍以 reason:"done" 收尾（契约不变）。
    // 但**非 overflow** 的 error-stopReason（坏 apiKey 401 / 限流 / 其它 provider 错误）与
    // **无本地 abort 信号的异常 aborted**（W42a，provider 侧断流属 error 类）会被下面的 else-if
    // 提级为 reason:"error"（#53），不再静默成 done。connection/config 类 sync-throw
    //（provider 未注册）走上面的 catch，不是 overflow，不在此分类。
    // overflow 判定在 push 之后重算（旧路径同款时序：事件 messageCount 必须含已入转录的 assistant；
    // 循环内那次只是重试门控，其结果对象不带入本节）。
    const overflowFinal = this._detectOverflow(assistant);
    if (overflowFinal !== null) {
      const coOut = await this._dispatcher.fireEvent(
        "onContextOverflow",
        overflowFinal,
        this._ctx,
      );
      this._flushSystemMessages(coOut.systemMessages);
    } else if (this._isTransientLlmFailure(assistant)) {
      // #53 + W42a：重试在位时本节只在**耗尽/禁用/abort 中断**后到达——放弃即如实：
      // fire onError（可观测，插件可记录/决策；observe-only 不改控制流）后 throw，经 _runOneTurn
      // 既有 catch 提级 reason="error" + summary.error=provider errorMessage。中间失败 attempt 的
      // 残骸不入转录（push 只属终态），两种 LLM 失败模式（error/aborted-无信号）与同步抛自此统一。
      const err = new Error(
        assistant.errorMessage ?? `LLM call ended with stopReason="${assistant.stopReason}"`,
      );
      await this._dispatcher.fireError({ phase: "llm", err }, this._ctx);
      throw err;
    }

    return assistant;
  }

  /**
   * W42a：一条 resolve 出的 assistant 是否属"瞬时 LLM 失败"类（重试候选 + 耗尽后诚实终态化对象）——
   * stopReason "error"；或 "aborted" **且本地无 abort 信号**（provider 侧断流；真用户 abort 的
   * aborted 属用户意志，走 abort 通道不属本类）。overflow 分类在调用点先行短路，不入本判。
   */
  private _isTransientLlmFailure(m: AssistantMessage): boolean {
    if (m.stopReason === "error") return true;
    return m.stopReason === "aborted" && !this._abortCtrl.signal.aborted;
  }

  /**
   * W42a 重试退避等待：`base × 2^attempt` ms（缺省 1000 → 1s/2s）。abort-aware：等待窗口
   * 与 abort 竞速，abort 即刻中断并返回 true（调用方据此放弃重发），睡满返回 false。
   */
  private _sleepRetryBackoff(attempt: number): Promise<boolean> {
    const signal = this._abortCtrl.signal;
    const delay = this._llmErrorRetryBackoffMs * 2 ** attempt;
    return new Promise<boolean>((resolve) => {
      const finish = (interrupted: boolean): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(interrupted);
      };
      const onAbort = (): void => finish(true);
      const timer = setTimeout(() => finish(false), delay);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * 把一条 resolve 出的 assistant 判定为 context-overflow（docs/09 §3.6），返回 fire 用的事件输入或
   * null。"length" 无歧义；"error" 经 `_isContextOverflow`（默认启发式，可选项覆盖）匹配 errorMessage。
   */
  private _detectOverflow(
    assistant: AssistantMessage,
  ): ContextOverflowInput | null {
    const base = {
      turnIdx: this._ctx.turnIdx,
      messageCount: this._messages.length,
    };
    if (assistant.stopReason === "length") {
      return { ...base, stopReason: "length" };
    }
    if (assistant.stopReason === "error") {
      const errorMessage = assistant.errorMessage ?? "";
      if (this._isContextOverflow(errorMessage)) {
        return { ...base, stopReason: "error", errorMessage };
      }
    }
    return null;
  }

  /**
   * Phase 2 / 3：tool batch。
   *   - 提取 toolCalls
   *   - ToolExecutor 按 isConcurrencySafe 分批跑
   *   - 每个 result push 一条 toolResult message
   *   - newMessages 注入时拦截 toolResult/assistant role（防 tool 破坏对话不变量）
   */
  private async _phaseToolBatch(
    assistant: AssistantMessage,
  ): Promise<ToolExecResult[]> {
    const toolCalls = assistant.content.filter(
      (b): b is ToolCall => b.type === "toolCall",
    );
    if (toolCalls.length === 0) return [];

    const executor = new ToolExecutor({
      tools: this.tools,
      dispatcher: this._dispatcher,
      ctx: this._ctx,
      abortCtrl: this._abortCtrl,
      pushAttachment: (c, e) => this._pushAttachment(c, e),
      flushSystemMessages: (m) => this._flushSystemMessages(m),
    });
    const results = await executor.executeBatch(toolCalls);

    const toolResultsForTurn: ToolExecResult[] = [];
    for (const call of toolCalls) {
      const result = results.get(call.id);
      if (!result) continue;
      const trMsg: ToolResultMessage = {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: result.content,
        isError: result.isError ?? false,
        timestamp: Date.now(),
      };
      if (result.details !== undefined) {
        (trMsg as ToolResultMessage & { details?: unknown }).details =
          result.details;
      }
      this._messages.push(trMsg);
      if (result.newMessages) {
        for (const m of result.newMessages) {
          // 防御：tool 不能伪造 toolResult / assistant role 来破坏 conversation 完整性
          // user / system role 是可接受的注入（attachment 模式）
          if (m.role === "toolResult" || m.role === "assistant") {
            await this._dispatcher.fireError(
              {
                phase: "tool",
                err: new Error(
                  `tool "${call.name}" attempted to inject ${m.role} message via newMessages — rejected (only user/system allowed)`,
                ),
                call,
              },
              this._ctx,
            );
            continue;
          }
          this._messages.push(m);
        }
      }
      toolResultsForTurn.push(result);
    }
    return toolResultsForTurn;
  }

  /**
   * Phase 3 / 3：onTurnEnd event。
   *   - flush systemMessages
   *   - push additionalContext attachments（下一 turn 的 LLM 看到）
   *   - 处理 continue=false（plugin 在 turn 边界主动中止 session）
   */
  private async _phaseTurnEnd(
    turnIdx: number,
    assistant: AssistantMessage,
    toolResults: ToolExecResult[],
  ): Promise<void> {
    const teOut = await this._dispatcher.fireEvent(
      "onTurnEnd",
      {
        turnIdx,
        assistantMessage: assistant,
        toolResults,
      },
      this._ctx,
    );
    this._flushSystemMessages(teOut.systemMessages);
    for (const c of teOut.additionalContexts) {
      this._pushAttachment(c, "onTurnEnd");
    }
    if (teOut.continue === false) {
      this._abortCtrl.abort(
        new Error(teOut.stopReason ?? "onTurnEnd continue=false"),
      );
    }
  }


  /* ────────────── Helpers ────────────── */

  private _pushAttachment(content: string, hookEvent: string): void {
    this._pendingAttachments.push(
      createAttachmentMessage({
        type: "hook_additional_context",
        content,
        hookEvent,
      }),
    );
  }

  private _flushSystemMessages(msgs: ReadonlyArray<string>): void {
    if (msgs.length === 0) return;
    for (const m of msgs) {
      this._consoleSink(m, {
        sessionId: this.id,
        turnIdx: this._ctx.turnIdx,
      });
    }
  }
}

/* ────────────── 模块级 helpers ────────────── */

// findToolByName 移到 tool-executor.ts，从这里 re-export 保持向后兼容
export { findToolByName } from "./tool-executor.js";

/**
 * W16-F5 零内容块 assistant 产物判定：abort/error 收尾的 resolved assistant（_phaseLlmCall
 * 无条件 push）无正文、无 toolCall，进转录纯读回噪声。仅认 assistant role——user/toolResult、
 * 任何带块的 assistant（含 thinking-only / toolCall-only）绝不入列。
 */
function isEmptyArtifactAssistant(m: Message): boolean {
  return m.role === "assistant" && m.content.length === 0;
}

/**
 * 把 kernel-only 字段去掉再发给 pi-ai。
 * `details` 是本地 trace metadata，不能进入模型上下文。
 * 优化：先 scan，只有真有字段要剥离时才走 map。
 */
function stripHarnessOnlyFields(messages: ReadonlyArray<Message>): Message[] {
  let hasHarnessOnlyFields = false;
  for (const m of messages) {
    if (
      (m as { _meta?: unknown })._meta !== undefined ||
      (m as { details?: unknown }).details !== undefined
    ) {
      hasHarnessOnlyFields = true;
      break;
    }
  }
  if (!hasHarnessOnlyFields) return messages.slice();

  return messages.map((m) => {
    if (
      (m as { _meta?: unknown })._meta === undefined &&
      (m as { details?: unknown }).details === undefined
    ) {
      return m;
    }
    const copy = { ...m } as Message & { _meta?: unknown; details?: unknown };
    delete copy._meta;
    delete copy.details;
    return copy;
  });
}

/**
 * 把 external AbortSignal 桥接到 internal AbortController。
 * 返回 cleanup 函数（卸载 listener，避免 long-lived signal 持有 controller 引用）。
 */
function forwardSignal(
  external: AbortSignal | undefined,
  internal: AbortController,
): () => void {
  if (!external) return () => {};
  if (external.aborted) {
    internal.abort(external.reason);
    return () => {};
  }
  const handler = (): void => internal.abort(external.reason);
  external.addEventListener("abort", handler, { once: true });
  return () => external.removeEventListener("abort", handler);
}
