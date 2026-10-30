/**
 * W23-C /tasks 历史合流 —— 账本 kind:"sub" 行的投影面（重启不丢子任务账）。
 *
 * 定位：GET /tasks 的旧数据源 = kernel.listSubRuns()（纯内存登记册，重启即空）。
 * 后台派发本就写 durable 账本（kernel.ts dispatchSubBackground：expected 携
 * kind:"sub"/agent_type/parent_session 三附加，盖棺写 actual=TerminalSnapshot），
 * boot 已把 `ledger.rows()` 注入 task 路由（ledgerRows）——本模块把两源按
 * **run_id 并集**合流：
 *   - 内核行优先（新鲜状态：in-flight/cancel/error 面只活在这里，toTaskView 直出
 *     带 in_memory:true）；
 *   - 账本-only 行按 actual 盖棺如实渲染；**不可导出字段 = null 诚实**
 *     （crashed/cancel_requested 不在账本词表、task 正文/depth 从未落账本）；
 *   - 缺口（expected 无 actual）与 /runs 账本回退先例逐字同口径：status "running"
 *     + error "ledger gap: expected without actual"（重启后缺口 ≠ 在飞，但账本
 *     无法再细分崩溃/停机——T13 对账面的事，视图不越权编造）。
 *
 * 列表序：内核行（派发插入序）在前，账本-only 按账本行序（时间序）追加。
 * /runs 纯度不受本模块影响（sub 行继续被 views.ts rowFromLedgerPayload 的 kind
 * 判别排除——w9s3 纯度红线钉原样）。
 */

import type { LedgerRow } from "@axeuh/loom-adapters";
import type { SubTaskRecord } from "@axeuh/loom-core/kernel";
import type { LedgerTerminalStatus } from "@axeuh/loom-core/run-engine";
import type { TaskDetailView, TaskView } from "./types.js";
import { toTaskView, traceSpansOf } from "./views.js";

/** 某 task（run_id）的账本观察（expected 首写保留 / actual 后写覆盖）。 */
interface SubLedgerObservation {
  expectedAt: number | null;
  /** expected 行解析产物（payload 非 sub 形状/缺 run_id = 不参与合流，见 parse）。 */
  agentType: string | null;
  parentSession: string | null;
  /** W49.2：expected payload["title"] 宽容读（旧行无键=null，不 fabricate）。 */
  title: string | null;
  workflow: string | null;
  sessionId: string | null;
  actualAt: number | null;
  actualStatus: LedgerTerminalStatus | null;
  /** 只见过 actual 行（无 expected）——理论缺口形态，仍如实渲染历史行。 */
  present: boolean;
}

function asStringOrNull(x: unknown): string | null {
  return typeof x === "string" ? x : null;
}

/** 扫账本一次，收集全部 kind:"sub" run 的观察（run_id → observation，首见序=时间序）。 */
function observeSubLedger(rows: readonly LedgerRow[]): Map<string, SubLedgerObservation> {
  const out = new Map<string, SubLedgerObservation>();
  const blank = (): SubLedgerObservation => ({
    expectedAt: null,
    agentType: null,
    parentSession: null,
    title: null,
    workflow: null,
    sessionId: null,
    actualAt: null,
    actualStatus: null,
    present: false,
  });
  for (const row of rows) {
    if (row.t === "expected") {
      const p = row.payload;
      if (typeof p !== "object" || p === null || Array.isArray(p)) continue;
      const rec = p as Record<string, unknown>;
      if (rec["kind"] !== "sub") continue;
      const runId = asStringOrNull(rec["run_id"]);
      if (runId === null || runId !== row.runId) continue;
      const obs = out.get(runId) ?? blank();
      // expected 首写保留（重放幂等形态下 expected 本就唯一）；actual 后写覆盖=末次盖棺。
      if (obs.expectedAt === null) {
        obs.expectedAt = row.at;
        obs.agentType = asStringOrNull(rec["agent_type"]);
        obs.parentSession = asStringOrNull(rec["parent_session"]);
        obs.title = asStringOrNull(rec["title"]);
        obs.workflow = asStringOrNull(rec["workflow"]);
        obs.sessionId = asStringOrNull(rec["session_id"]);
      }
      obs.present = true;
      out.set(runId, obs);
      continue;
    }
    const known = out.get(row.runId);
    if (known === undefined) continue; // 非 sub run 的 actual（/runs 域）不渗入
    known.actualAt = row.at;
    known.actualStatus = row.status;
    known.present = true;
  }
  return out;
}

/** 单条账本观察 → TaskView（ledger-only 格；in_memory 键恒缺席=历史行来源标）。 */
function taskViewFromLedger(taskId: string, obs: SubLedgerObservation): TaskView {
  const gap = obs.actualStatus === null && obs.expectedAt !== null;
  return {
    task_id: taskId,
    run_id: taskId,
    agent_type: obs.agentType,
    parent_session: obs.parentSession,
    // W49.2：账本行标题=expected 写过的才如实透出；旧行/未给 = null（本函数绝不现造兜底）。
    title: obs.title,
    workflow: obs.workflow,
    session_id: obs.sessionId,
    // 状态真源=盖棺 actual；缺口按 /runs 回退先例词（running+error 说明，不谎报终态）。
    status: obs.actualStatus ?? (obs.expectedAt !== null ? "running" : "unknown"),
    dispatched_at: obs.expectedAt ?? 0,
    terminal_at: obs.actualAt,
    crashed: null, // 崩溃位不入账本（kernel 内存面专属），null=如实不可导出
    cancel_requested: null, // 同上：取消原因只活在内核登记面
    error: gap ? "ledger gap: expected without actual" : null,
  };
}

/**
 * GET /tasks 合流：内核在飞册 ∪ 账本 kind:"sub" 历史（run_id 并集，live 优先）。
 * 纯函数；rows 由路由注入（boot = () => ledger.rows()，现读全分片）。
 */
export function mergeTaskViews(
  kernel: readonly SubTaskRecord[],
  rows: readonly LedgerRow[],
): TaskView[] {
  const out: TaskView[] = kernel.map((rec) => toTaskView(rec));
  const seen = new Set(kernel.map((rec) => rec.row.run_id));
  for (const [runId, obs] of observeSubLedger(rows)) {
    if (seen.has(runId)) continue; // live 优先：内核行携新鲜状态，账本旧影不覆盖
    out.push(taskViewFromLedger(runId, obs));
  }
  return out;
}

/**
 * GET /tasks/:id 的账本-only 回落（内核册 miss 后调用）。未知 id（账本无 sub 痕迹）
 * = null → 路由 404 原纪律。terminal/task/depth 不可导出 = null（模块头口径）；
 * ledger join 与 trace spans 同 /runs 详情口径（views.ts 复用，禁第二实现）。
 */
export function taskDetailFromLedger(
  taskId: string,
  rows: readonly LedgerRow[],
  traceStateRoot: string | undefined,
): TaskDetailView | null {
  const obs = observeSubLedger(rows).get(taskId);
  if (obs === undefined || !obs.present) return null;
  const base = taskViewFromLedger(taskId, obs);
  const actual =
    obs.actualAt !== null && obs.actualStatus !== null
      ? { at: obs.actualAt, status: obs.actualStatus }
      : null;
  return {
    ...base,
    task: null, // 任务正文从未入账本（kernel.ts expected 形状），null 诚实
    depth: null, // 同上
    terminal: null, // 同 /runs 账本回退先例：终局快照只在内存登记面
    ledger: { expected_at: obs.expectedAt, actual },
    trace: traceSpansOf(base.dispatched_at, taskId, traceStateRoot),
  };
}
