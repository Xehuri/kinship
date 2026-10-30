// T19 压缩内部例程（D21「压缩定形」：水位判定 / 先 micro 后 full / boundary 幂等 / 指针重读）。
// 编排层复用 plugins/{microcompact,auto-compaction,summary-template} 语义，不改 vendor 插件。
// 下游消费：T37（compaction boundary 测试）、T32（装配读指针回读）；trace 接线经 onTrace 交 server 层。

export type { CompactionLimits } from "./limits.js";
export { DEFAULT_COMPACTION_LIMITS, assertValidCompactionLimits } from "./limits.js";

export type {
  ArchiveSinkLike,
  BoundaryRecord,
  BoundarySinkLike,
  BoundaryWriteOutcome,
  ProjectedHistory,
} from "./boundary.js";
export {
  BOUNDARY_SUMMARY_MARK,
  BoundaryLedger,
  MemoryArchive,
  boundaryCacheBreakpoint,
  buildBoundarySummaryText,
  isBoundaryRow,
  makeBoundaryKey,
  messageRow,
  parseBoundaryRow,
  parseBoundarySummaryText,
  projectThroughBoundaries,
  serializeBoundaryRow,
} from "./boundary.js";

export type {
  CompactionDecision,
  CompactionResult,
  CompactionRoutineOptions,
  CompactionTier,
  CompactionTraceInfo,
  OverflowArchive,
  Summarizer,
} from "./routine.js";
export { CompactionRoutine, jsonlOverflowArchive } from "./routine.js";

// ─────────── W57 压缩状态机 / sidecar / 重试（P1；尚未接入生产）───────────

export type {
  BeginCompactionInput,
  CompactionAbortInput,
  CompactionFailureInput,
  CompactionReason,
  CompactionState,
  CompactionStatus,
  CompactionSuccessInput,
} from "./compaction-state.js";
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
} from "./compaction-state.js";

export type {
  CompactionStateReadResult,
  CompactionStateStoreOptions,
} from "./compaction-state-store.js";
export {
  COMPACTION_STATE_SIDECAR_VERSION,
  CompactionStateStore,
  compactionStateSidecarPath,
  sanitizeSessionIdForFilename,
} from "./compaction-state-store.js";

export type {
  CompactionErrorClass,
  CompactionRetryBudgetOptions,
} from "./compaction-retry.js";
export {
  COMPACTION_MAX_RETRIES,
  COMPACTION_RETRY_BASE_MS,
  COMPACTION_RETRY_FACTOR,
  COMPACTION_RETRY_JITTER_RATIO,
  COMPACTION_RETRY_MAX_DELAY_MS,
  CompactionRetryBudget,
  classifyCompactionError,
  retryDelayMs,
} from "./compaction-retry.js";

// ─────────── W57 前缀摘要（all-or-nothing；autoCompaction 与压缩 worker 共用）───────────

export type {
  SummarizeCompactionPrefixInput,
  SummaryMode,
} from "./summarize-prefix.js";
export {
  buildSummaryMergePrompt,
  chunkMessagesForSummary,
  summarizeCompactionPrefix,
} from "./summarize-prefix.js";

// ─────────── W57 摘要输入投影（microcompact 同款占位符；纯函数）───────────

export type { SummaryProjectionOptions } from "./summary-projection.js";
export { projectToolResultsForSummary } from "./summary-projection.js";

// ─────────── W57 后台压缩 worker（P2；单次 attempt 编排，尚未接入 session/server）───────────

export type {
  CompactionCommit,
  CompactionContextSnapshot,
  CompactionSummaryPerspective,
  CompactionWorkerDeps,
  CompactionWorkerEvent,
  CompactionWorkerOptions,
  StartCompactionInput,
  WorkerOutcome,
} from "./worker.js";
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
} from "./worker.js";

// ─────────── W57 会话级压缩协调器（P2c；AgentSession ↔ worker 薄适配）───────────

export type { CompactionCoordinatorOptions } from "./coordinator.js";
export { CompactionCoordinator } from "./coordinator.js";

// ─────────── W57 P2c-2 会话级压缩接线（AgentSession.compaction）───────────

export type {
  FailedCompactionOutcome,
  SessionCompactionOptions,
} from "./session-compaction.js";
export {
  CompactionFailedError,
  CompactionRecoveryRequiredError,
} from "./session-compaction.js";

// ─────────── W57 P3 上下文水位提醒（持久 system-reminder；不含 HTTP/tool/SSE）───────────

export type { ContextWatermarkMessageInput } from "./context-watermark.js";
export {
  CONTEXT_WATERMARK_MARKER_PREFIX,
  assertValidWatermarkLevels,
  buildContextWatermarkMessage,
  contextWatermarkLevel,
  contextWatermarkMarker,
  highestWatermarkLevelAtOrBelow,
  isContextWatermarkMessage,
} from "./context-watermark.js";
