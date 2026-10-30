// T18 上下文装配器（层状注入 / 稳定字节前缀 / fail-soft 降级）。
// 下游消费：T19 压缩（Segment 边界+prefixHash）、T27、T37；审计降级行走 T21 trace。

export {
  assemble,
  resolveMemorySources,
  renderMemorySegment,
  renderAssemblyPrefix,
  rebaseAssemblyPrefix,
  memorySourceContract,
  memorySourceContractRelaxed,
  MISSING_PLACEHOLDER,
  UNREADABLE_PLACEHOLDER,
  DEFAULT_CONVERGENCE_NOTE,
} from "./assembler.js";

export {
  MAIN_SESSION_GLOBS,
  SIDE_SESSION_BASE_GLOBS,
  expandMemoryGlob,
  expandMemoryGlobs,
  dedupeSort,
  type ExpandedGlobs,
  type GlobRejection,
} from "./memory-declaration.js";

export {
  CONTEXT_NOTICE_BUDGET_BYTES,
  SKILLS_CATALOG_REL_PATH,
  detectContextChanges,
  isContextFileStale,
  seedContextWatermark,
  type ContextChangeAction,
  type ContextChangeOutcome,
  type ContextFileObservation,
  type ContextFileSeed,
  type ContextWatermark,
  type ContextWatermarkEntry,
} from "./context-change.js";

export {
  ContextBaselineTemplate,
  SessionContextWatcher,
  type ContextBaseline,
  type SessionContextDynamicSource,
  type SessionContextPreview,
  type SessionContextSource,
  type SessionContextWatcherOptions,
} from "./session-context.js";

export {
  createFsAssemblyReader,
  type FsReaderOptions,
  type ShardSourceLike,
} from "./fs-reader.js";

export type {
  Assembly,
  AssemblyDegrade,
  AssemblyPlan,
  AssemblyReader,
  DegradeReason,
  HistoryIncrement,
  MemorySource,
  Segment,
  SegmentName,
  TurnInput,
  WorkflowTemplate,
} from "./types.js";
