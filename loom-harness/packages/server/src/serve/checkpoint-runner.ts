/**
 * 检查点编排（Todo 27）：一次检查点 = plan 读取 -> 批次执行 -> 一次 plan revise -> 一条 flow 动作。
 *
 * 本文件是纯编排层，不引入新的调度器、不自己起 timer、不猜文件路径：
 *   - `planTool` 是 plan store 的读写面（`PlanStore` 的 read/revise），校验全部归 store；
 *   - `flowTool` 是已绑定 session 的持续记录动作面（wait/resume/close），校验全部归
 *     FlowContinuationStore / flow 工具；
 *   - `executeBatch` 由生产侧注入（后续接真实 data-check 批次），测试用假实现。
 *
 * 状态机（一个检查点只走一遍）：
 *
 *   plan read ──缺失──> plan-missing（不写 plan、不写 flow）
 *      │
 *      └─> 条目定位 ──缺失──> item-missing（不执行批次、不写 plan/flow）
 *             │
 *             └─> executeBatch ──抛错──> failed(batch)（不写 plan/flow）
 *                    │
 *                    └─> plan revise（恰好一次）
 *                           │
 *                           └─> flow wait | resume | close
 *
 * flow 决策：
 *   - batch.followUp 存在 -> wait（保持后续跟进）；
 *   - done / skipped / blocked -> close；
 *   - partial 且无 followUp -> resume（继续处理，不虚构下一检查时间）。
 *
 * 纪律：
 *   - 计划收口（plan close）永远不在这里做，05:00 / 主会话才是收口者；
 *   - plan revise 失败不重试；flow 失败不再 revise，结果里保留已完成的 plan 版本；
 *   - 所有工具/store 错误折叠成结构化结果返回，不向调用方抛异常。
 */

import {
  FlowContinuationConflictError,
  FlowContinuationNotFoundError,
  type FlowContinuation,
  type FlowContinuationCloseInput,
  type FlowContinuationResumeInput,
  type FlowContinuationState,
  type FlowContinuationWaitInput,
  type FlowTimeInput,
} from "@axeuh/loom-core";

import {
  PlanNotFoundError,
  type PlanDocument,
  type PlanItem,
  type PlanItemStatus,
  type PlanReviseOp,
  type PlanStore,
} from "../plan/plan-store.js";
import type {
  CoverageVerifyResult,
  CoverageVerifier,
} from "./coverage-verify.js";

/* ───────────────────────── 注入缝 ───────────────────────── */

/** plan 读写面；`JsonPlanStore` / plan 工具背后的 store 都满足。日期/版本校验归 store。 */
export type CheckpointPlanTool = Pick<PlanStore, "read" | "revise">;

/**
 * 已绑定 session 的持续记录动作面。生产侧用 `FlowContinuationStore` 或 flow 工具
 * 做一层薄绑定（session 不进检查点参数），本层不再重复 id/source/reason 校验。
 */
export interface CheckpointFlowTool {
  wait(input: FlowContinuationWaitInput): Promise<FlowContinuation>;
  resume(input: FlowContinuationResumeInput): Promise<FlowContinuation>;
  close(input: FlowContinuationCloseInput): Promise<FlowContinuation>;
}

export const CHECKPOINT_BATCH_STATUSES = [
  "done",
  "partial",
  "skipped",
  "blocked",
] as const;
export type CheckpointBatchStatus = (typeof CHECKPOINT_BATCH_STATUSES)[number];

/** 需要下一次继续看时的等待条件；`next_at` 交给 flow store 解析。 */
export interface CheckpointFollowUp {
  readonly waitingOn: string;
  readonly nextAt: FlowTimeInput;
  readonly closeCondition?: string;
  readonly reason?: string;
}

/** 批次执行结果；生产批次用 `blocked` 表达 API/数据阻塞，而不是抛错。 */
export interface CheckpointBatchOutcome {
  readonly status: CheckpointBatchStatus;
  /** 写进 plan 笔记与 flow reason 的短说明。 */
  readonly note?: string;
  /** 存在即表示检查点没有结束，需要 `flow wait`。 */
  readonly followUp?: CheckpointFollowUp;
}

export interface CheckpointBatchContext {
  readonly date: string;
  readonly checkpointId: string;
  readonly targetDate: string;
  readonly item: PlanItem;
  readonly planVersion: number;
  readonly at: number;
}

export type CheckpointBatchExecutor = (
  context: CheckpointBatchContext,
) => Promise<CheckpointBatchOutcome>;

/* ───────────────────────── 生产覆盖批次执行器（T09） ───────────────────────── */

/**
 * 覆盖校验的批次映射：pass -> done；gap -> partial + followUp；
 * no_data / error -> blocked。执行器只翻译结果，不自行重试、不派发下一跳，
 * 是否继续看仍由主会话在检查点之外决定。
 */
export interface CoverageBatchExecutorOptions {
  readonly verifier: CoverageVerifier;
  /**
   * 可选：用 plan 真源刷新条目 `target_date`（检查点 context 可能是旧快照）。
   * 读取失败退回 context 的 targetDate；覆盖校验不依赖 plan 可读。
   */
  readonly planTool?: CheckpointPlanTool;
}

const COVERAGE_GAP_WAITING_ON = "coverage gap";
const COVERAGE_GAP_NEXT_AT = "30m";
const COVERAGE_GAP_CLOSE_CONDITION = "check_coverage exit 0";

function coverageBatchOutcome(
  result: CoverageVerifyResult,
): CheckpointBatchOutcome {
  const summary = result.summary.trim() === "" ? result.status : result.summary.trim();
  const note = `coverage ${result.status}: ${summary}`;
  switch (result.status) {
    case "pass":
      return { status: "done", note };
    case "gap":
      return {
        status: "partial",
        note,
        followUp: {
          waitingOn: COVERAGE_GAP_WAITING_ON,
          nextAt: COVERAGE_GAP_NEXT_AT,
          closeCondition: COVERAGE_GAP_CLOSE_CONDITION,
        },
      };
    case "no_data":
    case "error":
      return { status: "blocked", note };
  }
}

async function resolveCoverageDate(
  options: CoverageBatchExecutorOptions,
  context: CheckpointBatchContext,
): Promise<string> {
  const fallback = context.item.target_date ?? context.targetDate;
  if (options.planTool === undefined) return fallback;
  try {
    const plan = await options.planTool.read(context.date);
    const fresh =
      plan.items.find((item) => item.checkpoint_id === context.checkpointId) ??
      plan.items.find((item) => item.id === context.item.id);
    return fresh?.target_date ?? fallback;
  } catch {
    // plan 只是目标日期的增强来源；读取失败不影响确定性校验。
    return fallback;
  }
}

export function createCoverageBatchExecutor(
  options: CoverageBatchExecutorOptions,
): CheckpointBatchExecutor {
  return async (context) => {
    const date = await resolveCoverageDate(options, context);
    return coverageBatchOutcome(await options.verifier.check(date));
  };
}

export interface RunCheckpointOptions {
  readonly planTool: CheckpointPlanTool;
  readonly flowTool: CheckpointFlowTool;
  readonly date: string;
  readonly checkpointId: string;
  readonly targetDate: string;
  readonly executeBatch: CheckpointBatchExecutor;
  /** 时钟注入（测试固定 at）；缺省 Date.now。 */
  readonly now?: () => number;
}

/* ───────────────────────── 结果投影 ───────────────────────── */

export type CheckpointFlowAction = "wait" | "resume" | "close";

export type CheckpointRunStatus =
  | "done"
  | "skipped"
  | "blocked"
  | "waiting"
  | "resumed"
  | "plan-missing"
  | "item-missing"
  | "failed";

export type CheckpointRunPhase = "plan-read" | "batch" | "plan-revise" | "flow";

export interface CheckpointRunSteps {
  readonly planRead: boolean;
  readonly batchExecuted: boolean;
  readonly planRevised: boolean;
  readonly flowActioned: boolean;
}

export interface CheckpointPlanState {
  readonly versionBefore: number;
  readonly versionAfter: number;
  readonly itemStatus: PlanItemStatus;
  readonly note: string;
}

export interface CheckpointFlowState {
  readonly action: CheckpointFlowAction;
  readonly id: string;
  readonly state: FlowContinuationState;
  /** false = close 时没有既有记录（无事可关，不是错误）。 */
  readonly existed: boolean;
}

export interface CheckpointRunError {
  readonly phase: CheckpointRunPhase;
  readonly name: string;
  readonly message: string;
}

export interface CheckpointRunResult {
  readonly ok: boolean;
  readonly status: CheckpointRunStatus;
  readonly date: string;
  readonly checkpointId: string;
  readonly targetDate: string;
  readonly itemId: string | null;
  readonly at: number;
  readonly steps: CheckpointRunSteps;
  readonly plan: CheckpointPlanState | null;
  readonly flow: CheckpointFlowState | null;
  readonly batch: CheckpointBatchOutcome | null;
  readonly error: CheckpointRunError | null;
  /** 一行可见摘要（日志/测试/后续 UI 可直接展示）。 */
  readonly message: string;
}

/* ───────────────────────── 纯辅助 ───────────────────────── */

const ITEM_STATUS_BY_BATCH: Record<CheckpointBatchStatus, PlanItemStatus> = {
  done: "done",
  partial: "planned",
  skipped: "skipped",
  blocked: "blocked",
};

function isCheckpointBatchStatus(value: unknown): value is CheckpointBatchStatus {
  return (
    typeof value === "string" &&
    (CHECKPOINT_BATCH_STATUSES as readonly string[]).includes(value)
  );
}

function resolveNow(now: (() => number) | undefined): number {
  const value = now === undefined ? Date.now() : now();
  return Number.isFinite(value) ? value : Date.now();
}

function errorInfo(error: unknown): { readonly name: string; readonly message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: "Error", message: String(error) };
}

/** 计划笔记与 flow reason 共用同一句短说明，避免两处口径漂移。 */
function checkpointNote(
  checkpointId: string,
  outcome: CheckpointBatchOutcome,
): string {
  const base = `checkpoint ${checkpointId} ${outcome.status}`;
  const detail = outcome.note?.trim();
  return detail === undefined || detail === "" ? base : `${base}: ${detail}`;
}

/**
 * 条目定位：先认 checkpoint_id，再退到条目 id（两者都来自同一份 plan 真源）。
 * 一个检查点只操作一个条目；重复命中时取计划顺序里的第一条。
 */
function findCheckpointItem(
  plan: PlanDocument,
  checkpointId: string,
): PlanItem | null {
  const byCheckpoint = plan.items.find(
    (item) => item.checkpoint_id === checkpointId,
  );
  if (byCheckpoint !== undefined) return byCheckpoint;
  return plan.items.find((item) => item.id === checkpointId) ?? null;
}

function decideFlowAction(outcome: CheckpointBatchOutcome): CheckpointFlowAction {
  if (outcome.followUp !== undefined) return "wait";
  if (
    outcome.status === "done" ||
    outcome.status === "skipped" ||
    outcome.status === "blocked"
  ) {
    return "close";
  }
  return "resume";
}

interface FlowApplied {
  readonly state: FlowContinuationState;
  readonly existed: boolean;
}

async function applyFlowAction(
  flowTool: CheckpointFlowTool,
  action: CheckpointFlowAction,
  checkpointId: string,
  id: string,
  sourceId: string,
  date: string,
  outcome: CheckpointBatchOutcome,
): Promise<FlowApplied> {
  const reason = checkpointNote(checkpointId, outcome);
  switch (action) {
    case "wait": {
      const followUp = outcome.followUp;
      if (followUp === undefined) {
        throw new Error(`checkpoint ${id}: wait 缺少 followUp`);
      }
      const record = await flowTool.wait({
        id,
        source: { plan_date: date, checkpoint_id: sourceId },
        waiting_on: followUp.waitingOn,
        next_at: followUp.nextAt,
        ...(followUp.closeCondition === undefined
          ? {}
          : { close_condition: followUp.closeCondition }),
        reason: followUp.reason ?? reason,
      });
      return { state: record.state, existed: true };
    }
    case "resume": {
      const record = await flowTool.resume({ id, reason });
      return { state: record.state, existed: true };
    }
    case "close": {
      try {
        const record = await flowTool.close({ id, reason });
        return { state: record.state, existed: true };
      } catch (error) {
        // 没有持续记录 / 已经关闭 = 目标态已满足；不把幂等重跑当失败。
        if (error instanceof FlowContinuationNotFoundError) {
          return { state: "closed", existed: false };
        }
        if (error instanceof FlowContinuationConflictError) {
          return { state: "closed", existed: true };
        }
        throw error;
      }
    }
  }
}

/* ───────────────────────── 编排主体 ───────────────────────── */

export async function runCheckpoint(
  options: RunCheckpointOptions,
): Promise<CheckpointRunResult> {
  const { planTool, flowTool, date, checkpointId, targetDate, executeBatch } = options;
  const at = resolveNow(options.now);
  const steps: {
    planRead: boolean;
    batchExecuted: boolean;
    planRevised: boolean;
    flowActioned: boolean;
  } = {
    planRead: false,
    batchExecuted: false,
    planRevised: false,
    flowActioned: false,
  };

  const result = (overrides: {
    readonly ok: boolean;
    readonly status: CheckpointRunStatus;
    readonly itemId?: string | null;
    readonly plan?: CheckpointPlanState | null;
    readonly flow?: CheckpointFlowState | null;
    readonly batch?: CheckpointBatchOutcome | null;
    readonly error?: CheckpointRunError | null;
    readonly message: string;
  }): CheckpointRunResult => ({
    ok: overrides.ok,
    status: overrides.status,
    date,
    checkpointId,
    targetDate,
    itemId: overrides.itemId ?? null,
    at,
    steps: { ...steps },
    plan: overrides.plan ?? null,
    flow: overrides.flow ?? null,
    batch: overrides.batch ?? null,
    error: overrides.error ?? null,
    message: overrides.message,
  });

  /* 1. plan read */
  let plan: PlanDocument;
  try {
    plan = await planTool.read(date);
    steps.planRead = true;
  } catch (error) {
    const info = errorInfo(error);
    if (error instanceof PlanNotFoundError) {
      return result({
        ok: false,
        status: "plan-missing",
        error: { phase: "plan-read", ...info },
        message:
          `checkpoint ${checkpointId} plan-missing: plan ${date} 不存在，` +
          "未执行批次、未写 plan、未写 flow",
      });
    }
    return result({
      ok: false,
      status: "failed",
      error: { phase: "plan-read", ...info },
      message: `checkpoint ${checkpointId} failed at plan-read: ${info.name}: ${info.message}`,
    });
  }

  /* 2. 条目定位（没有锚点就不执行批次，避免无 plan 归属的副作用） */
  const item = findCheckpointItem(plan, checkpointId);
  if (item === null) {
    return result({
      ok: false,
      status: "item-missing",
      message:
        `checkpoint ${checkpointId} item-missing: plan ${date} 没有对应条目，` +
        "未执行批次、未写 plan/flow",
    });
  }

  /* 3. executeBatch */
  let batch: CheckpointBatchOutcome;
  try {
    batch = await executeBatch({
      date,
      checkpointId,
      targetDate,
      item,
      planVersion: plan.version,
      at,
    });
    steps.batchExecuted = true;
  } catch (error) {
    const info = errorInfo(error);
    return result({
      ok: false,
      status: "failed",
      itemId: item.id,
      error: { phase: "batch", ...info },
      message: `checkpoint ${checkpointId} failed at batch: ${info.name}: ${info.message}`,
    });
  }

  if (!isCheckpointBatchStatus(batch.status)) {
    return result({
      ok: false,
      status: "failed",
      itemId: item.id,
      batch,
      error: {
        phase: "batch",
        name: "CheckpointBatchError",
        message: `非法批次状态: ${String(batch.status)}`,
      },
      message: `checkpoint ${checkpointId} failed at batch: 非法批次状态 ${String(batch.status)}`,
    });
  }

  /* 4. plan revise：每个检查点恰好一次，失败不重试 */
  const versionBefore = plan.version;
  const itemStatus = ITEM_STATUS_BY_BATCH[batch.status];
  const note = checkpointNote(checkpointId, batch);
  const ops: readonly PlanReviseOp[] = [
    { op: "upsert_item", item: { ...item, status: itemStatus } },
    { op: "append_note", note },
  ];
  let revised: PlanDocument;
  try {
    revised = await planTool.revise(
      date,
      versionBefore,
      ops,
      `checkpoint ${checkpointId} ${batch.status}`,
    );
    steps.planRevised = true;
  } catch (error) {
    const info = errorInfo(error);
    return result({
      ok: false,
      status: "failed",
      itemId: item.id,
      batch,
      error: { phase: "plan-revise", ...info },
      message:
        `checkpoint ${checkpointId} failed at plan-revise after plan v${versionBefore}: ` +
        `${info.name}: ${info.message}（未写 flow）`,
    });
  }

  const planState: CheckpointPlanState = {
    versionBefore,
    versionAfter: revised.version,
    itemStatus,
    note,
  };

  /* 5. flow wait / resume / close：最多一条，失败不再 revise */
  const action = decideFlowAction(batch);
  const flowId = item.checkpoint_id ?? item.id;
  const sourceId = item.checkpoint_id ?? checkpointId;
  let applied: FlowApplied;
  try {
    applied = await applyFlowAction(
      flowTool,
      action,
      checkpointId,
      flowId,
      sourceId,
      date,
      batch,
    );
    steps.flowActioned = true;
  } catch (error) {
    const info = errorInfo(error);
    return result({
      ok: false,
      status: "failed",
      itemId: item.id,
      plan: planState,
      batch,
      error: { phase: "flow", ...info },
      message:
        `checkpoint ${checkpointId} failed at flow ${action} after plan v${versionBefore} -> ` +
        `v${revised.version}: ${info.name}: ${info.message}`,
    });
  }

  const flowState: CheckpointFlowState = {
    action,
    id: flowId,
    state: applied.state,
    existed: applied.existed,
  };

  const status: CheckpointRunStatus =
    batch.status === "partial"
      ? action === "wait"
        ? "waiting"
        : "resumed"
      : batch.status;

  return result({
    ok: true,
    status,
    itemId: item.id,
    plan: planState,
    flow: flowState,
    batch,
    message:
      `checkpoint ${checkpointId} ${batch.status}: plan v${versionBefore} -> v${revised.version}，` +
      `flow ${action} ${flowId}（${applied.state}${applied.existed ? "" : "，无既有记录"}）`,
  });
}
