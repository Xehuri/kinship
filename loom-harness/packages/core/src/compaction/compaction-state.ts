/**
 * W57 压缩状态机（P1 核心原语）。
 *
 * 只负责状态形状、纯迁移与边界校验；持久化在 compaction-state-store.ts，重试策略在
 * compaction-retry.ts。本文件不读盘、不发事件，也不决定何时触发压缩。
 *
 * 迁移图（PLAN §State machine）：
 *   idle -> compacting -> idle（成功提交 boundary / 用户 abort）
 *   compacting -> retry_pending（重试耗尽或终态错误）
 *   retry_pending -> compacting（新消息 / 手动重试）
 * 不变量：同一会话最多一个 compacting；失败/中断不改 base 指针（boundary 由 worker 负责）。
 */

export const COMPACTION_STATE_VERSION = 1 as const;

export type CompactionStatus = "idle" | "compacting" | "retry_pending";

export type CompactionReason = "manual" | "tool" | "watermark" | "fallback";

/** sidecar 持久契约（PLAN §Sidecar），字段顺序即写入顺序。 */
export interface CompactionState {
  readonly version: typeof COMPACTION_STATE_VERSION;
  readonly status: CompactionStatus;
  readonly attemptId: string | null;
  readonly reason: CompactionReason | null;
  readonly attemptsUsed: number;
  readonly lastError: string | null;
  readonly baseCoveredCount: number;
  readonly baseCheckpointId: string | null;
  readonly bootRetryAttempted: boolean;
  readonly fallbackSuppressed: boolean;
  readonly updatedAt: number;
}

export interface BeginCompactionInput {
  readonly attemptId: string;
  readonly reason: CompactionReason;
  /** 缺省沿用上一份 state 的 base（新的压缩快照由调用方显式覆盖）。 */
  readonly baseCoveredCount?: number;
  readonly baseCheckpointId?: string | null;
  readonly now?: number;
}

export interface CompactionSuccessInput {
  /** 成功提交后的新 base；缺省沿用旧值。 */
  readonly baseCoveredCount?: number;
  readonly baseCheckpointId?: string | null;
  readonly now?: number;
}

export interface CompactionFailureInput {
  readonly lastError: string;
  readonly attemptsUsed: number;
  readonly now?: number;
}

export interface CompactionAbortInput {
  readonly now?: number;
}

const STATUS_VALUES: readonly CompactionStatus[] = ["idle", "compacting", "retry_pending"];
const REASON_VALUES: readonly CompactionReason[] = ["manual", "tool", "watermark", "fallback"];

function checkedTimestamp(now: number): number {
  if (!Number.isFinite(now) || now < 0) {
    throw new RangeError(`invalid compaction timestamp: ${String(now)}`);
  }
  return now;
}

function assertCompacting(state: CompactionState, action: string): void {
  if (state.status !== "compacting") {
    throw new Error(`${action}: expected status "compacting", got "${state.status}"`);
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.some((candidate) => candidate === value);
}

/** 初始态：无 in-flight attempt、无 base、无 suppression。 */
export function idleState(now: number = Date.now()): CompactionState {
  return {
    version: COMPACTION_STATE_VERSION,
    status: "idle",
    attemptId: null,
    reason: null,
    attemptsUsed: 0,
    lastError: null,
    baseCoveredCount: 0,
    baseCheckpointId: null,
    bootRetryAttempted: false,
    fallbackSuppressed: false,
    updatedAt: checkedTimestamp(now),
  };
}

/**
 * idle/retry_pending -> compacting。compacting 中再次 begin 视为双 worker，
 * 直接抛错而不是静默覆盖 attemptId。
 */
export function beginCompaction(
  state: CompactionState,
  input: BeginCompactionInput,
): CompactionState {
  if (state.status === "compacting") {
    throw new Error(`beginCompaction: session already compacting (attempt ${state.attemptId ?? "?"})`);
  }
  if (input.attemptId.length === 0) {
    throw new Error("beginCompaction: attemptId must be non-empty");
  }
  const baseCoveredCount = input.baseCoveredCount ?? state.baseCoveredCount;
  if (!isNonNegativeInteger(baseCoveredCount)) {
    throw new RangeError(`beginCompaction: invalid baseCoveredCount ${String(baseCoveredCount)}`);
  }
  return {
    ...state,
    status: "compacting",
    attemptId: input.attemptId,
    reason: input.reason,
    attemptsUsed: 0,
    lastError: null,
    baseCoveredCount,
    baseCheckpointId: input.baseCheckpointId !== undefined
      ? input.baseCheckpointId
      : state.baseCheckpointId,
    updatedAt: checkedTimestamp(input.now ?? Date.now()),
  };
}

/**
 * compacting -> idle。成功即提交完成：清空 attempt 级字段与 fallback suppression，
 * 可携带新 boundary base 供重启对账。
 */
export function markCompactionSuccess(
  state: CompactionState,
  input: CompactionSuccessInput = {},
): CompactionState {
  assertCompacting(state, "markCompactionSuccess");
  const baseCoveredCount = input.baseCoveredCount ?? state.baseCoveredCount;
  if (!isNonNegativeInteger(baseCoveredCount)) {
    throw new RangeError(`markCompactionSuccess: invalid baseCoveredCount ${String(baseCoveredCount)}`);
  }
  return {
    version: COMPACTION_STATE_VERSION,
    status: "idle",
    attemptId: null,
    reason: null,
    attemptsUsed: 0,
    lastError: null,
    baseCoveredCount,
    baseCheckpointId: input.baseCheckpointId !== undefined
      ? input.baseCheckpointId
      : state.baseCheckpointId,
    bootRetryAttempted: false,
    fallbackSuppressed: false,
    updatedAt: checkedTimestamp(input.now ?? Date.now()),
  };
}

/**
 * compacting -> retry_pending。保留 attemptId/reason/base 与 suppression，
 * 新消息或手动重试时由 beginCompaction 复用这些字段并重置预算。
 */
export function markCompactionFailure(
  state: CompactionState,
  input: CompactionFailureInput,
): CompactionState {
  assertCompacting(state, "markCompactionFailure");
  if (!isNonNegativeInteger(input.attemptsUsed)) {
    throw new RangeError(`markCompactionFailure: invalid attemptsUsed ${String(input.attemptsUsed)}`);
  }
  return {
    ...state,
    status: "retry_pending",
    attemptsUsed: input.attemptsUsed,
    lastError: input.lastError,
    updatedAt: checkedTimestamp(input.now ?? Date.now()),
  };
}

/**
 * compacting -> idle（真用户 abort）。不写 boundary、不改 base。
 * abort 的是 fallback 压缩时置 suppression，直到下一条消息被处理（clearFallbackSuppression）。
 */
export function markCompactionAborted(
  state: CompactionState,
  input: CompactionAbortInput = {},
): CompactionState {
  assertCompacting(state, "markCompactionAborted");
  return {
    ...state,
    status: "idle",
    attemptId: null,
    reason: null,
    attemptsUsed: 0,
    lastError: null,
    fallbackSuppressed: state.reason === "fallback" ? true : state.fallbackSuppressed,
    updatedAt: checkedTimestamp(input.now ?? Date.now()),
  };
}

/** 记录本进程已消费唯一一次 boot 重试（状态本身不变）。 */
export function markBootRetryConsumed(
  state: CompactionState,
  now: number = Date.now(),
): CompactionState {
  return { ...state, bootRetryAttempted: true, updatedAt: checkedTimestamp(now) };
}

/** 持久化「暂缓 750k fallback」；由 abort 路径或上层策略调用。 */
export function suppressFallback(
  state: CompactionState,
  now: number = Date.now(),
): CompactionState {
  return { ...state, fallbackSuppressed: true, updatedAt: checkedTimestamp(now) };
}

/** 下一条消息被处理后解除 suppression（唯一解除点，避免 fallback 连环触发）。 */
export function clearFallbackSuppression(
  state: CompactionState,
  now: number = Date.now(),
): CompactionState {
  return { ...state, fallbackSuppressed: false, updatedAt: checkedTimestamp(now) };
}

/**
 * sidecar 边界校验（parse-don't-validate）。unknown 出此函数即可信；
 * 版本、枚举、有限非负计数、可空字符串与布尔全部逐字段检查。
 */
export function isCompactionState(value: unknown): value is CompactionState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record["version"] === COMPACTION_STATE_VERSION &&
    isOneOf(record["status"], STATUS_VALUES) &&
    (record["attemptId"] === null ||
      (typeof record["attemptId"] === "string" && record["attemptId"].length > 0)) &&
    (record["reason"] === null || isOneOf(record["reason"], REASON_VALUES)) &&
    isNonNegativeInteger(record["attemptsUsed"]) &&
    isNullableString(record["lastError"]) &&
    isNonNegativeInteger(record["baseCoveredCount"]) &&
    isNullableString(record["baseCheckpointId"]) &&
    typeof record["bootRetryAttempted"] === "boolean" &&
    typeof record["fallbackSuppressed"] === "boolean" &&
    typeof record["updatedAt"] === "number" &&
    Number.isFinite(record["updatedAt"]) &&
    record["updatedAt"] >= 0
  );
}
