// T13 追赶 / 两级重试 / 死信（docs/02 §T13；决策 docs/01 D13/D15/D19/D26/D31）。
// 下游消费：T28 Task/run-domain API（对账触发/详情）、T35 账本追赶崩溃测试（重启重放）。

export {
  CATCHUP_STRATEGIES,
  RETRY_LEVELS,
  RecoveryError,
  _deadLetterShapeAligned,
  isCatchupStrategy,
  maxAttemptsOf,
  type CatchupPolicyPort,
  type CatchupRequest,
  type CatchupStrategy,
  type DeadLetterReceipt,
  type GapRun,
  type MainDeliverPort,
  type AutoResumePort,
  type CatchupDispatchPort,
  type ReconciliationPlan,
  type RecoveryAction,
  type RecoveryApplyResult,
  type RecoveryDeadLetterShapeIsT12Aligned,
  type RecoveryLedgerPort,
  type RecoveryLedgerRow,
  type RecoveryLog,
  type RecoveryNotifyHook,
  type RetryLevel,
  type SkipReason,
} from "./types.js";

export { orderGapsByRecency, retryLevelOf, selectCandidates, type CandidateSelection } from "./strategy.js";

export { Reconciler, type ReconcilerOptions } from "./reconciler.js";

export {
  MapCatchupPolicy,
  MemoryAutoResume,
  MemoryCatchupDispatch,
  MemoryMainDeliver,
  MemoryRecoveryLedger,
  deadLetterMessage,
} from "./memory-recovery.js";
