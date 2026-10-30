/**
 * Flow 模块 barrel（D1-D9 Wave 1）：类型 / 限额 / 时间边界 / store 契约与内存实现。
 * L2（flow_commit 工具）、L3（gate）、L5（JSON store）共用这一份公共面。
 */

export type {
  FlowCommitInput,
  FlowCommitOptions,
  FlowCommitResult,
  FlowCommitStamp,
  FlowContinuation,
  FlowContinuationSource,
  FlowContinuationState,
  FlowDefaultOptions,
  FlowFocus,
  FlowSchedule,
  FlowState,
  FlowSubject,
  FlowSubjectKind,
  FlowTimeInput,
  FlowUnsetInput,
  FlowUnsetReason,
  FlowUnsetRecord,
} from "./types.js";
export {
  DEFAULT_FLOW_SUBJECT_NAME,
  FLOW_CONTINUATION_SCHEMA,
  FLOW_CONTINUATION_STATES,
  FLOW_FOCUSES,
  FLOW_STATES,
  FLOW_SUBJECT_KINDS,
  FLOW_SUBJECT_SCHEMA,
  FLOW_UNSET_REASONS,
  isFlowContinuationState,
  isFlowFocus,
  isFlowState,
  isFlowSubjectKind,
  isFlowUnsetReason,
} from "./types.js";

export type {
  FlowContinuationCloseInput,
  FlowContinuationCreateInput,
  FlowContinuationResumeInput,
  FlowContinuationStore,
  FlowContinuationWaitInput,
  MemoryFlowContinuationStoreOptions,
} from "./continuation-store.js";
export {
  FlowContinuationConflictError,
  FlowContinuationNotFoundError,
  MemoryFlowContinuationStore,
  hydrateFlowContinuation,
  normalizeContinuationSource,
  requireContinuationId,
} from "./continuation-store.js";

export type { FlowLimits } from "./limits.js";
export { FLOW_LIMITS } from "./limits.js";

export type { FlowTimeResolution } from "./time.js";
export {
  FLOW_DISPLAY_TIME_ZONE,
  clampNextDecisionAt,
  formatFlowTime,
  isValidTimeZone,
  parseFlowTime,
  resolveDeadlineTime,
  resolveNextDecisionAt,
} from "./time.js";

export type { FlowStore } from "./store.js";
export {
  FlowClosedError,
  FlowConflictError,
  FlowLimitError,
  FlowNotFoundError,
  FlowValidationError,
} from "./store.js";

export type { MemoryFlowStoreOptions } from "./memory-store.js";
export { MemoryFlowStore } from "./memory-store.js";

export type { FlowCommitSlot } from "./slot.js";
export { FLOW_COMMIT_SLOT } from "./slot.js";

export type { FlowCommitToolOptions, FlowToolOptions } from "./tool.js";
export {
  FLOW_COMMIT_TOOL_NAME,
  FLOW_TOOL_ACTIONS,
  FLOW_TOOL_NAME,
  FlowCommitTool,
  FlowTool,
  flowCommitParameters,
  flowToolParameters,
} from "./tool.js";
export type { FlowToolAction } from "./tool.js";
export { parseCommitArgs } from "./args.js";

export type { FlowReadToolOptions } from "./read-tools.js";
export {
  FLOW_GET_TOOL_NAME,
  FLOW_LIST_TOOL_NAME,
  FlowGetTool,
  FlowListTool,
  createFlowReadTools,
  flowGetParameters,
  flowListParameters,
} from "./read-tools.js";

export type { FlowGateOptions, FlowRunOutcome } from "./gate.js";
export { FlowGate } from "./gate.js";
