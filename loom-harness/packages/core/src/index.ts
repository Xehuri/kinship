// ─────────── Hook protocol ───────────
export type {
  Hook,
  HookContext,
  HookResult,
  MergedHookResult,
  ToolDecision,
  ToolExecResult,
  SessionStartInput,
  SessionEndInput,
  ContinuationCheckInput,
  TurnStartInput,
  TurnEndInput,
  SteerInput,
  LlmEndInput,
  ContextOverflowInput,
  OnAfterFlushInput,
  OnAfterFlushResult,
  OnSubagentStartInput,
  OnSubagentEndInput,
  PreToolUseInput,
  PostToolUseInput,
  UserPromptSubmitInput,
  ErrorInput,
  // ─── Phase 1: state typing / structured log / config view ───
  HookStateRegistry,
  StateSlot,
  TypedStateMap,
  HookLogger,
  LogLevel,
  SessionConfigView,
  // ─── Live boundary（autoCompaction → カーネル連携）───
  ActiveBoundary,
} from "./hook.js";
export { defineSlot } from "./hook.js";

// ─────────── Dispatcher (advanced; plugin authors usually don't need) ───────────
export {
  HookDispatcher,
  HookTimeoutError,
  defaultTimeoutFor,
  mergeResults,
  verifyHookDependencies,
  assertCriticalDecisionHooks,
} from "./dispatcher.js";
export type {
  HookFailureSink,
  HookFailureInfo,
  DecisionOutcome,
  HookDependencyWarning,
} from "./dispatcher.js";

// ─────────── Context-overflow 默认分类器（可经 AgentSessionOptions.isContextOverflow 覆盖） ───────────
export { defaultIsContextOverflow } from "./context-overflow.js";

// ─────────── Tool 形态 + message helpers ───────────
export type { HarnessTool } from "./types.js";
export {
  createUserMessage,
  createAttachmentMessage,
  filterIncompleteToolCalls,
} from "./types.js";

// ─────────── Session persistence (协议在内核，落盘实现在 adapter) ───────────
export { MemorySessionStore } from "./session-store.js";
export type {
  SessionStore,
  SessionEntry,
  StoredEntry,
  ForkLineage,
} from "./session-store.js";

// ─────────── Compaction checkpoint schema（resume 元数据；tailIncluded 参与重放保留策略）───────────
export {
  COMPACTION_CHECKPOINT_VERSION,
  COMPACTION_TAIL_SEPARATOR,
  isCompactionCheckpointPayload,
  legacyCheckpointCoveredCount,
  resolveCheckpointTailIncluded,
} from "./compaction-checkpoint.js";
export type {
  CompactionCheckpointMeta,
  CompactionCheckpointPayload,
} from "./compaction-checkpoint.js";

// ─────────── W57 压缩状态机 / sidecar / 重试原语（P1；尚未接入 autoCompaction/server）───────────
export type {
  BeginCompactionInput,
  CompactionAbortInput,
  CompactionFailureInput,
  CompactionReason,
  CompactionState,
  CompactionStatus,
  CompactionSuccessInput,
} from "./compaction/compaction-state.js";
export {
  COMPACTION_STATE_VERSION,
  beginCompaction,
  clearFallbackSuppression,
  idleState,
  isCompactionState,
  markBootRetryConsumed,
  markCompactionAborted,
  markCompactionFailure,
  markCompactionSuccess,
  suppressFallback,
} from "./compaction/compaction-state.js";
export type {
  CompactionStateReadResult,
  CompactionStateStoreOptions,
} from "./compaction/compaction-state-store.js";
export {
  COMPACTION_STATE_SIDECAR_VERSION,
  CompactionStateStore,
  compactionStateSidecarPath,
  sanitizeSessionIdForFilename,
} from "./compaction/compaction-state-store.js";
export type {
  CompactionErrorClass,
  CompactionRetryBudgetOptions,
} from "./compaction/compaction-retry.js";
export {
  COMPACTION_MAX_RETRIES,
  COMPACTION_RETRY_BASE_MS,
  COMPACTION_RETRY_FACTOR,
  COMPACTION_RETRY_JITTER_RATIO,
  COMPACTION_RETRY_MAX_DELAY_MS,
  CompactionRetryBudget,
  classifyCompactionError,
  retryDelayMs,
} from "./compaction/compaction-retry.js";

// ─────────── W57 前缀摘要（all-or-nothing）───────────
export type {
  SummarizeCompactionPrefixInput,
  SummaryMode,
} from "./compaction/summarize-prefix.js";
export {
  buildSummaryMergePrompt,
  chunkMessagesForSummary,
  summarizeCompactionPrefix,
} from "./compaction/summarize-prefix.js";

// ─────────── W57 摘要输入投影（microcompact 同款占位符；纯函数）───────────

export type { SummaryProjectionOptions } from "./compaction/summary-projection.js";
export { projectToolResultsForSummary } from "./compaction/summary-projection.js";

// ─────────── W57 后台压缩 worker（P2；只依赖注入回调，尚未接入 session/server）───────────
export type {
  CompactionCommit,
  CompactionContextSnapshot,
  CompactionSummaryPerspective,
  CompactionWorkerDeps,
  CompactionWorkerEvent,
  CompactionWorkerOptions,
  StartCompactionInput,
  WorkerOutcome,
} from "./compaction/worker.js";
export {
  COMPACTION_SUMMARY_MAX_CHARS,
  COMPACTION_SUMMARY_MIN_CHARS,
  CompactionAbortedError,
  CompactionBusyError,
  CompactionNotRunningError,
  CompactionRequestTimeoutError,
  CompactionStateWriteError,
  CompactionSummaryValidationError,
  CompactionWorker,
} from "./compaction/worker.js";

// ─────────── W57 会话级压缩协调器（P2c；AgentSession ↔ worker 薄适配）───────────
export type { CompactionCoordinatorOptions } from "./compaction/coordinator.js";
export { CompactionCoordinator } from "./compaction/coordinator.js";

// ─────────── W57 P2c-2 会话级压缩接线（AgentSession.compaction）───────────
export type {
  FailedCompactionOutcome,
  SessionCompactionOptions,
} from "./compaction/session-compaction.js";
export {
  CompactionFailedError,
  CompactionRecoveryRequiredError,
} from "./compaction/session-compaction.js";

// ─────────── W57 P3 上下文水位提醒（持久 system-reminder；不含 HTTP/tool/SSE）───────────

export type { ContextWatermarkMessageInput } from "./compaction/context-watermark.js";
export {
  CONTEXT_WATERMARK_MARKER_PREFIX,
  assertValidWatermarkLevels,
  buildContextWatermarkMessage,
  contextWatermarkLevel,
  contextWatermarkMarker,
  highestWatermarkLevelAtOrBelow,
  isContextWatermarkMessage,
} from "./compaction/context-watermark.js";

// ─────────── Kernel ───────────
export { AgentSession, findToolByName, ACTIVE_BOUNDARY_KEY } from "./session.js";
export type {
  AgentSessionOptions,
  RunSummary,
  SessionEvent,
  LiveEvent,
  CompactionView,
  SteerHandle,
  SteerOptions,
  SystemPromptRefreshReason,
  SystemPromptRefreshResult,
} from "./session.js";

// ─────────── LLM seam（自定义 Model 构造 + typed llmOptions，收口 pi-ai 公共面） ───────────
export { completeText, streamText, makeOpenAICompatibleModel, resolveLlmOptions } from "./llm-model.js";
export type { OpenAICompatibleModelSpec, LlmOptions, StreamTextDelta } from "./llm-model.js";

// ─────────── DeepSeek thinking 回传（T6 消费方/测试引用） ───────────
export { markDeepSeekReasoningContent } from "./reasoning-replay.js";

// ─────────── W17-A 发线面捕获（server v2 `wire` 块的 core 侧数据源与序列化口） ───────────
export { canonicalJson, snapshotWireRequest } from "./wire-capture.js";
export type { WireRequestSnapshot, WireRequestSnapshotInput, WireToolSnapshot } from "./wire-capture.js";

// ─────────── HookContextImpl 实例类型（plugin / controller 偶尔需要） ───────────
export type { HookContextImpl, HookContextDeps } from "./context.js";
// 注意：getKernelInternals / KERNEL_INTERNALS_BAG 故意不导出——它们是 kernel-internal API。
// Plugin 没有 KERNEL_INTERNALS_BAG 引用，也没有 getKernelInternals 函数，无法访问 mutator。

// ─────────── pi-ai re-exports（方便用户少写一个 import）───────────
export type {
  Message,
  AssistantMessage,
  UserMessage,
  ToolResultMessage,
  ToolCall,
  Tool,
  Model,
  Api,
  Usage,
  StopReason,
  Context,
  OpenAICompletionsCompat,
} from "@earendil-works/pi-ai";
export { Type } from "@earendil-works/pi-ai";
export type { Static, TSchema } from "@earendil-works/pi-ai";
export {
  calculateCost,
  getEnvApiKey,
  getModels,
  getProviders,
} from "@earendil-works/pi-ai";

// ─────────── T21 trace/span 审计（schema 供 T29/T39 消费；追加式一行）───────────
export * from "./trace/index.js";

// ─────────── T23 MCP stdio 客户端（fake/ai-mcp 通用；供 T39 shadow 消费）───────────
export * from "./mcp/index.js";

// ─────────── T09 收束工具终止机制（D25/D30/D31；T10/T12 接线消费）───────────
export * from "./convergence/index.js";

// ─────────── D1-D9 Wave 1 Flow 台账契约（L2/L3/L5 消费）───────────
export * from "./flow/index.js";

// ─────────── T06 插件层（vendored plugins barrel；controllers 见 ./plugins/controllers/index.js）───────────
export * from "./plugins/index.js";
