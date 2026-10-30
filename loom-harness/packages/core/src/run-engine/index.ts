// T12 副会话运行引擎（docs/02 §T12；D5/D15/D19/D23/D26/D31）。
// 下游消费入口：T13 对账（gaps 形状）、T14 回执（actual payload）、
// T15 cron / T17 暂停（dispatch + AdmissionControl）、T25 取消/重派（cancel/parentRun）、
// T27/T28 API（get/listRuns）、T34/T35/T38（崩溃与零残留不变量）。

export {
  RUN_STATES,
  RUN_TRIGGERS,
  RUN_ID_SHAPE_RE,
  RunEngineError,
  admitAll,
  defaultRunId,
  defaultSessionId,
  parseAgentRef,
  parseDispatchInput,
  type RunState,
  type RunTerminalState,
  type RunTrigger,
  type RunRow,
  type RunRecord,
  type TerminalSnapshot,
  type LedgerPort,
  type LedgerTerminalStatus,
  type RunLaunchContext,
  type RunLaunchResult,
  type RunSessionPort,
  type AdmissionControl,
  type AdmissionDecision,
  type ArtifactSink,
  type ArtifactSnapshot,
  type DeadLetterSink,
  type DeadLetterPayload,
  type DispatchInput,
  type DispatchResult,
  type RunEngineLog,
} from "./types.js";

export { RunEngine, type RunEngineOptions } from "./engine.js";
export { MemoryLedger, type MemoryLedgerEntry } from "./memory-ledger.js";
export {
  createSideSessionPort,
  type SideBindingResolution,
  type SideRunBinding,
  type SideSessionPortOptions,
} from "./side-session-port.js";
