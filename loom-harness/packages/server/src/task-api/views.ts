/**
 * T28 任务/运行域 API —— 视图投影与详情 join（docs/02 §T28「list/detail join ledger+trace」）。
 *
 * 三个纯函数：
 *   toRunView      —— RunRecord（引擎登记表）→ 响应行（snake_case，含 run_id/attempt/trigger/status）；
 *   detailOf       —— 单 run 详情：ledger join（D15 expected/actual）+ trace spans（T21）
 *                     + attempt 链（沿 parent_run 上溯，含自身）；
 *   pauseStateOf   —— PauseSwitches 快照 → GET /pause 响应（只读，D31）。
 *
 * 判别联合消费铁律：LedgerRow 先 `t` 收窄、TraceRecord 先 `kind` 收窄再取字段。
 * 重启语义（T12 注释冻结：引擎登记表重启即空，持久真相只在账本）：
 *   引擎无记录时回退用账本 expected 行的 RunRow payload 重建视图，如实暴露缺口。
 */

import {
  readTraceFile,
  spansOnly,
  localDateKey,
  type TraceRecord,
} from "@axeuh/loom-core";
import {
  RUN_ID_SHAPE_RE,
  RUN_TRIGGERS,
  type RunRecord,
  type RunRow,
} from "@axeuh/loom-core/run-engine";
import type { LedgerRow } from "@axeuh/loom-adapters";
import type { SubTaskRecord } from "@axeuh/loom-core/kernel";
import type {
  LedgerJoin,
  PauseStateView,
  RunDetailView,
  RunView,
  RunViewStatus,
  TaskDetailView,
  TaskSurfaceSource,
  TaskView,
} from "./types.js";
import type { PauseSwitches } from "@axeuh/loom-core/pause";

/** RunRecord → 列表/详情公共视图（status = 引擎状态机当下值）。 */
export function toRunView(rec: RunRecord): RunView {
  return {
    run_id: rec.row.run_id,
    workflow: rec.row.workflow,
    attempt: rec.row.attempt,
    trigger: rec.row.trigger,
    parent_run: rec.row.parent_run,
    session_id: rec.row.session_id,
    status: rec.state,
    dispatched_at: rec.dispatchedAt,
    terminal_at: rec.terminalAt,
    crashed: rec.crashed,
    cancel_requested: rec.cancelRequested,
    error: rec.error,
  };
}

/** 账本 expected 行 payload 宽松重建 RunRow（形状不合 = null，不猜）。 */
function rowFromLedgerPayload(payload: unknown): RunRow | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  // W9 切片 3 契约纯度：后台 sub 的账本行（additive kind:"sub" 判别）不是 run——
  // /runs/:id 的账本回退面对 sub id 返回 null（→404）；sub 详情走 /tasks/:id 专属面。
  if (p["kind"] === "sub") return null;
  const runId = p["run_id"];
  const workflow = p["workflow"];
  const attempt = p["attempt"];
  const trigger = p["trigger"];
  const sessionId = p["session_id"];
  const parentRun = p["parent_run"];
  if (typeof runId !== "string" || !RUN_ID_SHAPE_RE.test(runId)) return null;
  if (typeof workflow !== "string" || workflow.length === 0) return null;
  if (typeof attempt !== "number" || !Number.isInteger(attempt)) return null;
  const triggerKnown = RUN_TRIGGERS.find((t): boolean => t === trigger);
  if (triggerKnown === undefined) return null;
  if (typeof sessionId !== "string" || !RUN_ID_SHAPE_RE.test(sessionId)) return null;
  if (parentRun !== null && typeof parentRun !== "string") return null;
  return {
    run_id: runId,
    workflow,
    attempt,
    trigger: triggerKnown,
    parent_run: parentRun,
    session_id: sessionId,
  };
}

/** 内部：某 run 的账本观察（对外 LedgerJoin + expected payload 原料）。 */
interface LedgerObservation extends LedgerJoin {
  /** expected 行 payload（RunRow 形状原料；无 expected 行 = null）。 */
  readonly expectedPayload: unknown;
}

/** 从账本行里取某 run 的 expected/actual（先 `t` 收窄再取字段）。 */
function observeLedger(rows: readonly LedgerRow[], runId: string): LedgerObservation {
  let expectedAt: number | null = null;
  let expectedPayload: unknown = null;
  let actual: LedgerJoin["actual"] = null;
  for (const row of rows) {
    if (row.runId !== runId) continue;
    if (row.t === "expected") {
      expectedAt = row.at;
      expectedPayload = row.payload;
    } else {
      actual = { at: row.at, status: row.status };
    }
  }
  return { expected_at: expectedAt, actual, expectedPayload };
}

/** 内部：详情行的来源（引擎记录优先，回退账本 payload）。 */
function baseViewOf(
  rec: RunRecord | undefined,
  obs: LedgerObservation,
  fallbackStatus: RunViewStatus,
): RunView | null {
  if (rec !== undefined) return toRunView(rec);
  const row = rowFromLedgerPayload(obs.expectedPayload);
  if (row === null) return null;
  return {
    run_id: row.run_id,
    workflow: row.workflow,
    attempt: row.attempt,
    trigger: row.trigger,
    parent_run: row.parent_run,
    session_id: row.session_id,
    status: fallbackStatus,
    dispatched_at: obs.expected_at ?? 0,
    terminal_at: obs.actual?.at ?? null,
    crashed: false,
    cancel_requested: null,
    error: obs.actual === null ? "ledger gap: expected without actual" : null,
  };
}

/** 详情 join 的依赖（路由注入，测试可造）。 */
export interface DetailSources {
  readonly rows: () => readonly LedgerRow[];
  /** trace 读取（缺省不接 = 空数组）。 */
  readonly traceStateRoot?: string;
}

/**
 * 单 run 详情：ledger + trace join + attempt 链。
 * 未知 run（引擎与账本都查不到）= null → 路由层 404。
 */
export function detailOf(runId: string, engineGet: (id: string) => RunRecord | undefined, src: DetailSources): RunDetailView | null {
  const rows = src.rows();
  const rec = engineGet(runId);
  const obs = observeLedger(rows, runId);
  // 状态回退词：actual 行存在用其 status（重启后引擎无痕仍可知终态）；缺口如实报。
  const ledgerStatus = obs.actual?.status ?? (obs.expected_at !== null ? "running" : "unknown");
  const base = baseViewOf(rec, obs, ledgerStatus);
  if (base === null) return null;

  const trace = traceSpansOf(base.dispatched_at, runId, src.traceStateRoot);
  return {
    ...base,
    terminal: rec?.terminal ?? null,
    ledger: { expected_at: obs.expected_at, actual: obs.actual },
    trace,
    chain: attemptChainOf(runId, rec, rows, engineGet),
  };
}

/** 当日 trace 的 span 列表（dispatched_at 定日分片；文件不存在 = 空数组）。
 *  W23-C：导出给 ledger-sub-views 复用（同一 trace 读取口径，禁第二实现）。 */
export function traceSpansOf(at: number, runId: string, stateRoot: string | undefined): readonly TraceRecord[] {
  if (stateRoot === undefined) return [];
  const dateKey = at > 0 ? localDateKey(at) : localDateKey(Date.now());
  const recs = readTraceFile(stateRoot, dateKey);
  return spansOnly(recs).filter((s) => s.runId === runId);
}

/**
 * attempt 链：沿 parent_run 逐级上溯（含自身，旧→新）。
 * 环与深度都由 visited/上限双保险截断（账本数据不可全信）。
 */
function attemptChainOf(
  runId: string,
  rec: RunRecord | undefined,
  rows: readonly LedgerRow[],
  engineGet: (id: string) => RunRecord | undefined,
): readonly RunView[] {
  const chain: RunView[] = [];
  const seen = new Set<string>();
  let cursor: string | null = runId;
  let depth = 0;
  while (cursor !== null && depth < 64) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const child = cursor === runId ? rec : engineGet(cursor);
    const obs = observeLedger(rows, cursor);
    const view = baseViewOf(child, obs, obs.actual?.status ?? "running");
    if (view === null) break;
    chain.unshift(view);
    cursor = view.parent_run;
    depth += 1;
  }
  return chain;
}

/** PauseSwitches → GET /pause 只读视图（Map → 普通对象，snake_case）。 */
export function pauseStateOf(sw: PauseSwitches): PauseStateView {
  const perWorkflow: Record<string, boolean> = {};
  for (const [workflow, paused] of sw.perWorkflow) perWorkflow[workflow] = paused;
  return { global: sw.global, per_workflow: perWorkflow };
}

/** 后台任务记录 → /tasks 视图行（toRunView 镜像 + 任务三键；run_id=task_id 同值）。
 *  W23-C：内核在飞册行恒标 in_memory:true（账本-only 历史行由 ledger-sub-views 渲染、键缺席）。 */
export function toTaskView(rec: SubTaskRecord): TaskView {
  return {
    in_memory: true,
    task_id: rec.taskId,
    agent_type: rec.agentType,
    parent_session: rec.parentSessionId,
    title: rec.title ?? null,
    run_id: rec.row.run_id,
    workflow: rec.row.workflow,
    session_id: rec.row.session_id,
    status: rec.state,
    dispatched_at: rec.dispatchedAt,
    terminal_at: rec.terminalAt,
    crashed: rec.crashed,
    cancel_requested: rec.cancelRequested,
    error: rec.error,
  };
}

/**
 * /tasks/:id 详情 = detailOf 同构 join（ledger+trace；get 源=后台册记录，其
 * RunRecord 兼容性由 SubTaskRecord extends 保证）+ 任务身份-overlay。
 * 未知/重启后无痕 = null → 路由 404（后台册是内存面；durable 历史走账本对账面，
 * 不经 /tasks——S08 在途并集口径只吃在册条目）。
 */
export function taskDetailOf(
  taskId: string,
  tasks: TaskSurfaceSource,
  src: DetailSources,
): TaskDetailView | null {
  const rec = tasks.get(taskId);
  if (rec === undefined) return null;
  const detail = detailOf(taskId, (id) => tasks.get(id), src);
  if (detail === null) return null;
  return {
    // W23-C 来源标：内核在飞册命中 = in_memory:true（账本-only 面由 ledger-sub-views 渲染，键缺席）。
    in_memory: true,
    task_id: rec.taskId,
    agent_type: rec.agentType,
    parent_session: rec.parentSessionId,
    title: rec.title ?? null,
    run_id: detail.run_id,
    workflow: detail.workflow,
    session_id: detail.session_id,
    status: detail.status,
    dispatched_at: detail.dispatched_at,
    terminal_at: detail.terminal_at,
    crashed: detail.crashed,
    cancel_requested: detail.cancel_requested,
    error: detail.error,
    task: rec.task,
    depth: rec.depth,
    terminal: detail.terminal,
    ledger: detail.ledger,
    trace: detail.trace,
  };
}
