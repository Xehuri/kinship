/**
 * T13 Catchup + 两级重试 + 死信 —— 类型契约层
 * （docs/02 §T13；决策 docs/01 D13/D15/D19/D26/D31）。
 *
 * 一句话职责：对账器（Reconciler）**无内存态**全量重放 L0 账本，求 expected−actual
 * 差集（缺口），按逐工作流 catchup 策略 `latest|all|none` 产出恢复动作：
 *   - 自动续跑（重试 level 1）= 同 run 同会话 resume；
 *   - 追赶补跑 / 人工重跑（重试 level 2）= 新会话（新 run、新 session、attempt+1、parent_run）；
 *   - 重试耗尽（attempt ≥ max，max 从 Limits 现读）= 死信：账本收口 + 回执投主 + 通知钩子。
 *
 * 只读复用（**禁改其文件**，只 import）：run-engine/（RunRow / RunTrigger / LedgerPort）、
 * pause/（准入，本模块不直接调）、main-loop/（deliver 投主通道）、convergence/（Limits）。
 * 账本真相唯一来源 = adapters `state/ledger.ts` 的 Ledger；core→adapters 会成包级循环，
 * 故本模块按结构化签名声明同形端口，server 装配时把真 `Ledger` 原样传入即可。
 */

import { RUN_TRIGGERS } from "../run-engine/index.js";
import type {
  DeadLetterPayload,
  LedgerPort,
  LedgerTerminalStatus,
  RunRow,
  RunTrigger,
} from "../run-engine/index.js";
import type { ForceReason, Limits } from "../convergence/index.js";

/** trigger 判别守卫（run-engine barrel 未导出其守卫，此处按同一词表复检）。 */
function isRunTrigger(x: unknown): x is RunTrigger {
  return RUN_TRIGGERS.some((t): boolean => t === x);
}

/* ────────────── 账本只读镜像 ────────────── */

/**
 * 账本行只读镜像：结构**逐字段兼容** adapters `state/ledger.ts` 的 `LedgerRow`
 * （t / runId / at / status? / payload）。真 `Ledger.rows()` 原样满足本接口。
 */
export type RecoveryLedgerRow =
  | {
      readonly t: "expected";
      readonly runId: string;
      readonly at: number;
      readonly payload: unknown;
    }
  | {
      readonly t: "actual";
      readonly runId: string;
      readonly at: number;
      readonly status: LedgerTerminalStatus;
      readonly payload: unknown;
    };

/**
 * 恢复账本端口 = T12 写端口（expected / actual）+ 全量读（对账重启重放用）。
 * 真 `Ledger` 两者皆备；core 测试用 `MemoryRecoveryLedger`。
 * `rows()` 是**重启语义**的唯一真相来源：对账器绝不依赖自身内存。
 */
export interface RecoveryLedgerPort extends LedgerPort {
  /** 全量行（重启全量重放；无内存态真相）。 */
  rows(): readonly RecoveryLedgerRow[];
}

/* ────────────── catchup 策略（D15） ────────────── */

/**
 * 逐工作流追赶策略（D15 冻结词表）：
 *   latest —— 只补最近一班（数据检查型；同 workflow 缺口按 expected 时刻取最新一个）；
 *   all    —— 全部补（计费型；每个缺口各补一次）；
 *   none   —— 作废不补（提醒型；缺口全部 skip，纯 no-op，不伪造终态）。
 */
export const CATCHUP_STRATEGIES = ["latest", "all", "none"] as const;
export type CatchupStrategy = (typeof CATCHUP_STRATEGIES)[number];

/** 策略判别守卫（配置热载值不可信，边界校验用）。 */
export function isCatchupStrategy(x: unknown): x is CatchupStrategy {
  return CATCHUP_STRATEGIES.some((s): boolean => s === x);
}

/** 策略读取端口（逐工作流声明；server 装配读 config，测试注入内存表）。 */
export interface CatchupPolicyPort {
  strategyFor(workflow: string): CatchupStrategy;
}

/* ────────────── 两级重试（D19） ────────────── */

/**
 * 重试级别（计划字面：auto-continue = same run/session；catchup/manual = new session）：
 *   1 = 自动续跑：同 run 同会话 resume（缺口 run 的 trigger === "auto-resume"）；
 *   2 = 新会话补跑：其余 trigger（cron/script/manual/catchup/rerun）。
 * 级别完全由**账本已持久化**的 RunRow.trigger 判定，无内存状态。
 */
export const RETRY_LEVELS = [1, 2] as const;
export type RetryLevel = (typeof RETRY_LEVELS)[number];

/**
 * 追赶 / 重跑请求（Reconciler 产出，端口补 prompt 后转 RunEngine.dispatch）。
 * 账本 RunRow **不存 prompt**（形状冻结），故此处只给派生身份参数；
 * `CatchupDispatchPort` 实现负责从 workflow 配置取 prompt。
 */
export interface CatchupRequest {
  readonly workflow: string;
  readonly trigger: "catchup";
  /** 新 run 的尝试代数 = 缺口 run.attempt + 1（持久化于账本，非内存）。 */
  readonly attempt: number;
  /** 派生源 = 缺口 run_id（D15/D21）。 */
  readonly parent_run: string;
}

/* ────────────── 死信回执 ────────────── */

/**
 * 死信回执 —— 与 T12 `DeadLetterPayload`（failed 终态死信形状）**逐字段对齐**：
 * 同一 snake_case 字段集，确保「重试耗尽死信」与「failed 终态死信」在下游同构可消费。
 * 缺口 run 无 actual（无 digest/blockers），故 digest/blockers 由 Reconciler 如实合成。
 */
export interface DeadLetterReceipt {
  readonly kind: "dead-letter";
  readonly run_id: string;
  readonly workflow: string;
  readonly attempt: number;
  readonly trigger: RunTrigger;
  readonly parent_run: string | null;
  readonly session_id: string;
  readonly digest: string;
  readonly blockers: readonly string[];
  readonly forceReason?: ForceReason;
  readonly at: number;
}

/**
 * 编译期形状对齐断言（双向可赋值 = 严格同形）。
 * 任一字段漂移则本类型解析为 never，编译期即失败。
 * 注意：仅导出类型别名不足以强制 —— never 类型若不落值绑定则静默。
 * 下方 `_deadLetterShapeAligned: ... = true` 是**真实强制点**：漂移使 true 不可
 * 赋给 never，`tsc` 直接报错（这是「严格对齐」的编译期门禁，非文档性声明）。
 */
type AssertDeadLetterShape = DeadLetterPayload extends DeadLetterReceipt
  ? DeadLetterReceipt extends DeadLetterPayload
    ? true
    : never
  : never;
export type RecoveryDeadLetterShapeIsT12Aligned = AssertDeadLetterShape;

/** 编译期门禁实体：类型漂移即编译失败（值本身无运行时用途）。 */
export const _deadLetterShapeAligned: AssertDeadLetterShape = true;

/* ────────────── 恢复端口（全部注入；core 不 import adapters/server） ────────────── */

/** 自动续跑端口（level 1）：同 run 同会话 resume（执行器实现 resume 语义）。 */
export interface AutoResumePort {
  resume(run: RunRow): void | Promise<void>;
}

/** 追赶派发端口（level 2）：补 prompt 后转 RunEngine.dispatch（新会话）。 */
export interface CatchupDispatchPort {
  dispatchCatchup(request: CatchupRequest): void | Promise<void>;
}

/** 死信投主端口：把回执投进主会话 deliver 收件箱（T10 turn 边界消费，D23）。 */
export interface MainDeliverPort {
  deliver(receipt: DeadLetterReceipt): void | Promise<void>;
}

/** 死信通知钩子（D23③ 通知双轨；可选，与投主并行触发）。失败不回滚账本收口。 */
export type RecoveryNotifyHook = (receipt: DeadLetterReceipt) => void | Promise<void>;

/* ────────────── 对账产物 ────────────── */

/** 缺口 run（有 expected 无 actual）及其账本快照。 */
export interface GapRun {
  readonly run: RunRow;
  /** expected 行时刻（latest 策略排序键）。 */
  readonly at: number;
}

/** skip 原因（no-op 亦可审计）。 */
export type SkipReason =
  | "strategy-none" // none 策略：整批作废
  | "strategy-latest-superseded"; // latest 策略：非最新缺口已被最新一班取代

/** 恢复动作（判别联合；消费方 exhaustive switch）。 */
export type RecoveryAction =
  | {
      readonly kind: "auto-resume";
      readonly level: 1;
      readonly run: RunRow;
    }
  | {
      readonly kind: "catchup";
      readonly level: 2;
      readonly run: RunRow;
      readonly request: CatchupRequest;
    }
  | {
      readonly kind: "dead-letter";
      readonly run: RunRow;
      readonly receipt: DeadLetterReceipt;
    }
  | {
      readonly kind: "skip";
      readonly run: RunRow;
      readonly reason: SkipReason;
      readonly at: number;
    };

/**
 * 对账计划（`replay()` 的纯产物，无副作用）。
 *   scanned    —— 账本总分片行数；
 *   gapRunIds  —— 缺口 run_id（按账本 expected 出现序，稳定）；
 *   actions    —— 恢复动作（含 skip/no-op）。
 */
export interface ReconciliationPlan {
  readonly scanned: number;
  readonly gapRunIds: readonly string[];
  readonly actions: readonly RecoveryAction[];
}

/** `apply()` 结果统计。 */
export interface RecoveryApplyResult {
  readonly resumed: number;
  readonly dispatched: number;
  readonly deadLettered: number;
  readonly skipped: number;
}

/* ────────────── 错误 / 日志 ────────────── */

/** 对账类型化错误（fail-loud；message 带 cause 标签便于审计切片）。 */
export class RecoveryError extends Error {
  readonly cause_kind: "ledger-read" | "run-row" | "port";
  constructor(causeKind: RecoveryError["cause_kind"], message: string) {
    super(`[recovery:${causeKind}] ${message}`);
    this.name = "RecoveryError";
    this.cause_kind = causeKind;
  }
}

/** 结构化日志 sink（与 T12 RunEngineLog 同形；缺省静默，server 装配 pino）。 */
export type RecoveryLog = (
  level: "debug" | "info" | "warn" | "error",
  msg: string,
  fields: Record<string, unknown>,
) => void;

/**
 * 边界解析：账本 expected 行 payload（不可信）→ 校验过的 RunRow。
 * 照 T12 `parseDispatchInput` 的惯例：非法即响亮抛 RecoveryError，对账器内部不再重验。
 * 真实账本里 expected 的 payload 即引擎写入的 RunRow（engine.dispatch → ledger.expected）。
 */
export function parseRunRow(runId: string, payload: unknown): RunRow {
  if (payload === null || typeof payload !== "object") {
    throw new RecoveryError(
      "run-row",
      `expected row for ${runId} has non-object payload: ${JSON.stringify(payload)}`,
    );
  }
  const p = payload as Record<string, unknown>;
  const workflow = p["workflow"];
  const attempt = p["attempt"];
  const trigger = p["trigger"];
  const session_id = p["session_id"];
  const parent_run = p["parent_run"];
  if (typeof workflow !== "string" || workflow.trim() === "") {
    throw new RecoveryError("run-row", `expected row for ${runId} missing workflow`);
  }
  if (typeof attempt !== "number" || !Number.isInteger(attempt) || attempt < 1) {
    throw new RecoveryError("run-row", `expected row for ${runId} has invalid attempt`);
  }
  if (!isRunTrigger(trigger)) {
    throw new RecoveryError(
      "run-row",
      `expected row for ${runId} has unknown trigger ${JSON.stringify(trigger)}`,
    );
  }
  if (typeof session_id !== "string" || session_id.trim() === "") {
    throw new RecoveryError("run-row", `expected row for ${runId} missing session_id`);
  }
  if (parent_run !== null && typeof parent_run !== "string") {
    throw new RecoveryError("run-row", `expected row for ${runId} has invalid parent_run`);
  }
  if (p["run_id"] !== undefined && p["run_id"] !== runId) {
    throw new RecoveryError(
      "run-row",
      `expected row payload run_id ${JSON.stringify(p["run_id"])} != ledger runId ${runId}`,
    );
  }
  return {
    run_id: runId,
    workflow,
    attempt,
    trigger,
    parent_run: parent_run === undefined ? null : parent_run,
    session_id,
  };
}

/** 重试上限读取（Limits 热载：每次 replay 现读，不快照）。 */
export function maxAttemptsOf(limits: Limits): number {
  const max = 1 + limits.autoContinuations; // 初次 + 自动续跑预算
  if (!Number.isInteger(max) || max < 1) {
    throw new RecoveryError(
      "port",
      `invalid Limits.autoContinuations for retry budget: ${String(limits.autoContinuations)}`,
    );
  }
  return max;
}
