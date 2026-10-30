/**
 * Flow 契约（D1-D9 Wave 1）：主体台账的公共类型与运行时判据。
 *
 * 本模块只放**纯类型 + 常量 + 判据**，不碰存储、不读时钟、不做 IO。
 * 时间字段在 FlowCommitInput 里允许模型惯用写法（倒计时/ISO/HH:MM/none），
 * 落库后的 FlowSubject 一律是 epoch 毫秒或 null；转换在 store 边界完成。
 */

/** 台账行 schema 版本（L5 JSON store 按此判别可读性）。 */
export const FLOW_SUBJECT_SCHEMA = 1 as const;

/**
 * 简化持续记录（每个 plan 条目最多一条）的 schema 版本。
 * 与上面的多主体台账并存：旧行继续由 FLOW_SUBJECT_SCHEMA 读取，新行只写本 schema。
 */
export const FLOW_CONTINUATION_SCHEMA = 1 as const;

/** 简化持续记录状态：等待 / 恢复中 / 已关闭。 */
export const FLOW_CONTINUATION_STATES = ["waiting", "active", "closed"] as const;
export type FlowContinuationState = (typeof FLOW_CONTINUATION_STATES)[number];

/**
 * 持续记录的来源：指向 plan 条目（checkpoint_id）或旧 open loop（open_loop_id）。
 * plan_date 用于同日隔离；checkpoint_id / open_loop_id 二选一作为条目身份。
 */
export interface FlowContinuationSource {
  readonly plan_date?: string;
  readonly checkpoint_id?: string;
  readonly open_loop_id?: string;
}

/**
 * 一条简化持续记录。
 *
 * 所有时间均为 epoch 毫秒；waiting_on / next_at 只在 waiting 态非空，
 * active / closed 态一律为 null。last_update 每次写入由 store 覆盖。
 */
export interface FlowContinuation {
  readonly schema: typeof FLOW_CONTINUATION_SCHEMA;
  /** plan 条目 id（同时是 items/{id}.json 的文件名）。 */
  readonly id: string;
  readonly source: FlowContinuationSource;
  readonly state: FlowContinuationState;
  readonly waiting_on: string | null;
  readonly next_at: number | null;
  readonly close_condition: string | null;
  readonly last_update: number;
  readonly reason: string | null;
}

/** 零主体 session 的惰性默认主体名。 */
export const DEFAULT_FLOW_SUBJECT_NAME = "主线";

export const FLOW_STATES = ["active", "waiting_user", "waiting_event", "closed"] as const;
export type FlowState = (typeof FLOW_STATES)[number];

export const FLOW_FOCUSES = ["foreground", "background", "parked"] as const;
export type FlowFocus = (typeof FLOW_FOCUSES)[number];

export const FLOW_SUBJECT_KINDS = ["thread", "task"] as const;
export type FlowSubjectKind = (typeof FLOW_SUBJECT_KINDS)[number];

export const FLOW_UNSET_REASONS = ["no_commit", "run_end_no_commit"] as const;
export type FlowUnsetReason = (typeof FLOW_UNSET_REASONS)[number];

/**
 * 提交时的时间输入：字符串按 converge wake 同族语法解析；number 视为 epoch 毫秒；
 * null 表示显式清空。store 负责按字段套用不同边界（唤醒钳制 / 死线拒绝过去）。
 */
export type FlowTimeInput = string | number | null;

/**
 * schedule 是**不透明调度表达式**（如 "daily 09:00"）：L2 负责语法校验与解释，
 * L5 原样持久化。Wave 1 不在此发明第二套调度语法，避免和 trigger/cron 分叉。
 */
export type FlowSchedule = string;

/** 一次已受理提交的戳记（turn_idx 来自内核回合序号）。 */
export interface FlowCommitStamp {
  readonly turn_idx: number;
  readonly at: number;
}

/**
 * 台账行。所有时间均为 epoch 毫秒；未设置的时间字段为 null。
 * 不可变字段：schema / subject_id / subject_name / session_id / created_at。
 * version 从 1 起，每次**受理**的 commit 递增 1；重复名返回的 created:false 不递增。
 */
export interface FlowSubject {
  readonly schema: typeof FLOW_SUBJECT_SCHEMA;
  /** `flow_` + 12 位小写十六进制；由 store 生成，全局唯一。 */
  readonly subject_id: string;
  readonly subject_name: string;
  readonly session_id: string;
  readonly kind: FlowSubjectKind;
  readonly title: string;
  readonly description: string;
  readonly notes: readonly string[];
  readonly notes_ref: string | null;
  readonly state: FlowState;
  readonly focus: FlowFocus;
  /** 乐观并发版本：创建为 1，每次受理提交 +1。 */
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly next_decision_at: number | null;
  readonly soft_deadline: number | null;
  readonly due_at: number | null;
  readonly timezone: string | null;
  readonly schedule: FlowSchedule | null;
  readonly parent_id: string | null;
  readonly closed_at: number | null;
  readonly close_reason: string | null;
  /** 最近一次受理提交；ensureDefault 直接创建、未经提交时为 null。 */
  readonly last_commit: FlowCommitStamp | null;
}

/**
 * 提交输入：模型/上层给 store 的**唯一写入载荷**。
 *
 * - subject_id：更新路径；必须同时给 expected_version。
 * - subject_name：创建路径；同名已存在时返回既有行（created:false）且不改动。
 * - 两者都缺：仅当 session 尚无任何 subject 时惰性创建默认主体「主线」。
 * - state 必填；其余字段缺省 = 不改动（创建时取默认值）。
 */
export interface FlowCommitInput {
  readonly subject_id?: string;
  readonly subject_name?: string;
  readonly kind?: FlowSubjectKind;
  readonly title?: string;
  readonly description?: string;
  readonly notes_append?: readonly string[];
  readonly notes_ref?: string | null;
  readonly state: FlowState;
  readonly focus?: FlowFocus;
  readonly expected_version?: number;
  readonly next_decision_at?: FlowTimeInput;
  readonly soft_deadline?: FlowTimeInput;
  readonly due_at?: FlowTimeInput;
  readonly timezone?: string | null;
  readonly schedule?: FlowSchedule | null;
  readonly parent_id?: string | null;
  readonly close_reason?: string | null;
}

/** 未提交观测记录（append-only）：用于 gate 侧饥饿/漏提交审计。 */
export interface FlowUnsetRecord {
  readonly schema: typeof FLOW_SUBJECT_SCHEMA;
  readonly session_id: string;
  readonly at: number;
  readonly turn_idx: number;
  readonly reason: FlowUnsetReason;
  readonly had_tool_results: boolean;
}

export interface FlowUnsetInput {
  readonly turn_idx: number;
  readonly reason: FlowUnsetReason;
  readonly had_tool_results: boolean;
  /** 缺省用 store 注入的时钟。 */
  readonly now?: number;
}

export interface FlowCommitOptions {
  /** 内核回合序号，写入 last_commit.turn_idx。 */
  readonly turn_idx: number;
  /** 缺省用 store 注入的时钟。 */
  readonly now?: number;
}

export interface FlowDefaultOptions {
  readonly now?: number;
}

export interface FlowCommitResult {
  readonly subject: FlowSubject;
  /** true = 本次新建；false = 更新或同名幂等命中（未改动）。 */
  readonly created: boolean;
}

const FLOW_STATE_SET: ReadonlySet<string> = new Set(FLOW_STATES);
const FLOW_FOCUS_SET: ReadonlySet<string> = new Set(FLOW_FOCUSES);
const FLOW_KIND_SET: ReadonlySet<string> = new Set(FLOW_SUBJECT_KINDS);
const FLOW_UNSET_REASON_SET: ReadonlySet<string> = new Set(FLOW_UNSET_REASONS);
const FLOW_CONTINUATION_STATE_SET: ReadonlySet<string> = new Set(
  FLOW_CONTINUATION_STATES,
);

export function isFlowState(value: unknown): value is FlowState {
  return typeof value === "string" && FLOW_STATE_SET.has(value);
}

export function isFlowFocus(value: unknown): value is FlowFocus {
  return typeof value === "string" && FLOW_FOCUS_SET.has(value);
}

export function isFlowSubjectKind(value: unknown): value is FlowSubjectKind {
  return typeof value === "string" && FLOW_KIND_SET.has(value);
}

export function isFlowUnsetReason(value: unknown): value is FlowUnsetReason {
  return typeof value === "string" && FLOW_UNSET_REASON_SET.has(value);
}

export function isFlowContinuationState(
  value: unknown,
): value is FlowContinuationState {
  return (
    typeof value === "string" && FLOW_CONTINUATION_STATE_SET.has(value)
  );
}
