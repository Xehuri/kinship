/**
 * FlowStore 协议 + 类型化错误（D1-D9 Wave 1）。
 *
 * 协议只描述语义，不规定落盘：MemoryFlowStore 是内核自带实现，L5 JSON store 复用同一契约。
 * 所有写路径都以「受理 / 拒绝」二态返回：拒绝必须抛类型化错误（fail-loud），
 * 不允许静默吞掉版本冲突或对 closed 行的写入。
 */

import type { FlowLimits } from "./limits.js";
import type {
  FlowCommitInput,
  FlowCommitOptions,
  FlowCommitResult,
  FlowDefaultOptions,
  FlowSubject,
  FlowUnsetInput,
  FlowUnsetRecord,
} from "./types.js";

/** 输入形状/语义非法（字段缺失、枚举越界、路径穿越、非法时区等）。 */
export class FlowValidationError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`[flow:validation] ${field}: ${message}`);
    this.name = "FlowValidationError";
    this.field = field;
  }
}

/** 乐观并发冲突：expected_version 与当前 version 不符，本次写入未生效。 */
export class FlowConflictError extends Error {
  readonly subject_id: string;
  readonly expected: number;
  readonly actual: number;
  constructor(subjectId: string, expected: number, actual: number) {
    super(
      `[flow:conflict] subject ${subjectId} expected version ${expected}, actual ${actual}`,
    );
    this.name = "FlowConflictError";
    this.subject_id = subjectId;
    this.expected = expected;
    this.actual = actual;
  }
}

/** 主体已关闭，拒绝任何后续提交。 */
export class FlowClosedError extends Error {
  readonly subject_id: string;
  readonly closed_at: number | null;
  constructor(subjectId: string, closedAt: number | null) {
    super(`[flow:closed] subject ${subjectId} is closed`);
    this.name = "FlowClosedError";
    this.subject_id = subjectId;
    this.closed_at = closedAt;
  }
}

/** 台账容量/体积超限。 */
export class FlowLimitError extends Error {
  readonly limit: keyof FlowLimits;
  readonly max: number;
  readonly actual: number;
  constructor(limit: keyof FlowLimits, max: number, actual: number) {
    super(`[flow:limit] ${limit} max=${max}, actual=${actual}`);
    this.name = "FlowLimitError";
    this.limit = limit;
    this.max = max;
    this.actual = actual;
  }
}

/** subject_id 不存在（或不属于该 session）。 */
export class FlowNotFoundError extends Error {
  readonly subject_id: string;
  constructor(subjectId: string) {
    super(`[flow:not-found] subject ${subjectId}`);
    this.name = "FlowNotFoundError";
    this.subject_id = subjectId;
  }
}

export interface FlowStore {
  /** 某 session 的全部主体（创建顺序，含 closed）。 */
  list(sessionId: string): Promise<readonly FlowSubject[]>;
  /** 按全局唯一 subject_id 取行。 */
  get(subjectId: string): Promise<FlowSubject | null>;
  /** 按 session + 名称精确查找（重名保护用）。 */
  findByName(sessionId: string, subjectName: string): Promise<FlowSubject | null>;
  /**
   * 惰性确保默认主体「主线」：
   * - session 为空 → 创建并返回（version 1，last_commit null）；
   * - 已有「主线」→ 原样返回；
   * - 已有其他主体但无「主线」→ 返回 null（默认主体只在零主体时创建）。
   */
  ensureDefault(sessionId: string, options?: FlowDefaultOptions): Promise<FlowSubject | null>;
  /**
   * 提交（创建或 CAS 更新）。
   *
   * 解析顺序：
   * 1. subject_id → 更新（必须带 expected_version；closed 拒绝）；
   * 2. subject_name → 同名已存在则原样返回 created:false，否则创建；
   * 3. 两者都缺 → session 零主体时创建「主线」，否则找「主线」做幂等命中，
   *    再否则拒绝（要求显式 subject_id / subject_name）。
   */
  commit(
    sessionId: string,
    input: FlowCommitInput,
    options: FlowCommitOptions,
  ): Promise<FlowCommitResult>;
  /** 追加一条「本回合未提交」观测记录（append-only；不改任何主体）。 */
  appendUnset(sessionId: string, input: FlowUnsetInput): Promise<FlowUnsetRecord>;
  /** 已知 session id（含仅有 unset 记录的 session），按首次出现顺序。 */
  listSessionIds(): Promise<readonly string[]>;
  /**
   * 最早待决策主体：state ∈ {active, waiting_user, waiting_event} 且
   * next_decision_at 非 null；按 next_decision_at 升序（同值按 subject_id），
   * **overdue 视为 now**：过期行照常返回，调用方应立即处理而不是等下一次唤醒。
   * 没有候选返回 null。
   */
  earliestPending(sessionId: string, now?: number): Promise<FlowSubject | null>;
}
