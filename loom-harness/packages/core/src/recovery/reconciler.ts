/**
 * Reconciler —— T13 对账器（docs/02 §T13；决策 docs/01 D15/D19/D26）。
 *
 * 核心不变量：**无内存态**。`replay()` 每次都从 `ledger.rows()` 全量重放 L0 账本，
 * 求 expected−actual 差集（缺口），按逐工作流 catchup 策略产出恢复动作。进程重启后
 * 对账器是全新实例，唯一输入仍是账本文件 —— 这就是「重启语义=纯文件重放」。
 *
 * 恢复动作三类（`RecoveryAction`）：
 *   auto-resume（level 1）—— 缺口 run 的 trigger === "auto-resume"：同 run 同会话 resume；
 *   catchup    （level 2）—— 其余 trigger：新会话补跑（attempt+1、parent_run=缺口 run）；
 *   dead-letter          —— attempt ≥ maxAttempts（max = 1 + Limits.autoContinuations 现读）
 *                           时重试耗尽：账本收口 dead-letter + 回执投主 + 通知钩子。
 *   skip                 —— none 策略或 latest 被更新一班取代（no-op，不伪造终态）。
 *
 * 持久化真相：重试计数 = 账本里该 run 的 `attempt`（RunRow 冻结字段），**不是内存计数器**；
 * 每轮 replay 现读，故天然幂等、可跨重启。`replay()` 纯只读，`apply()` 才落副作用。
 */

import type { Limits } from "../convergence/index.js";
import type { RunRow } from "../run-engine/index.js";
import type { RecoveryLedgerPort } from "./types.js";
import { parseRunRow } from "./types.js";
import {
  retryLevelOf,
  selectCandidates,
} from "./strategy.js";
import {
  RecoveryError,
  maxAttemptsOf,
  type AutoResumePort,
  type CatchupDispatchPort,
  type CatchupPolicyPort,
  type CatchupRequest,
  type DeadLetterReceipt,
  type GapRun,
  type MainDeliverPort,
  type ReconciliationPlan,
  type RecoveryAction,
  type RecoveryApplyResult,
  type RecoveryLog,
  type RecoveryNotifyHook,
} from "./types.js";

export interface ReconcilerOptions {
  /** 恢复账本端口（真 Ledger 满足；测试用 MemoryRecoveryLedger）。 */
  readonly ledger: RecoveryLedgerPort;
  /** 逐工作流 catchup 策略（config 热载读取闭包）。 */
  readonly policy: CatchupPolicyPort;
  /** 收束阈值对象（热载：每次 replay 现读 autoContinuations 决定 maxAttempts）。 */
  readonly limits: Limits;
  /** 自动续跑端口（level 1）；缺省 = 无实现（遇 auto-resume 缺口响亮抛错）。 */
  readonly autoResume?: AutoResumePort;
  /** 追赶派发端口（level 2）；缺省 = 无实现（遇 catchup 缺口响亮抛错）。 */
  readonly dispatch?: CatchupDispatchPort;
  /** 死信投主端口；缺省 = 无实现（遇死信响亮抛错）。 */
  readonly mainDeliver?: MainDeliverPort;
  /** 死信通知钩子（可选，D23③）；失败只记 warn，不回滚已收口账本。 */
  readonly notify?: RecoveryNotifyHook;
  /** 结构化日志，缺省静默。 */
  readonly log?: RecoveryLog;
}

export class Reconciler {
  private readonly _opts: ReconcilerOptions;
  private readonly _log: RecoveryLog;

  constructor(opts: ReconcilerOptions) {
    this._opts = opts;
    this._log = opts.log ?? (() => {});
  }

  /**
   * 全量重放账本 → 对账计划（**纯只读，无副作用**）。
   * 每次调用都重新读账本，故「重启」= 新建 Reconciler 再 replay，语义一致。
   */
  replay(): ReconciliationPlan {
    const rows = this._readRows();
    const maxAttempts = maxAttemptsOf(this._opts.limits);

    // 1. 全量重放求缺口：有 expected 无 actual。
    const closed = new Set<string>();
    const gaps: GapRun[] = [];
    for (const row of rows) {
      if (row.t === "actual") {
        closed.add(row.runId);
        continue;
      }
      gaps.push({ run: parseRunRow(row.runId, row.payload), at: row.at });
    }
    const openGaps = gaps.filter((g) => !closed.has(g.run.run_id));

    // 2. 按 workflow 分组，保持账本首现序（确定性）。
    const byWorkflow = new Map<string, GapRun[]>();
    for (const gap of openGaps) {
      const wf = gap.run.workflow;
      const bucket = byWorkflow.get(wf);
      if (bucket === undefined) {
        byWorkflow.set(wf, [gap]);
      } else {
        bucket.push(gap);
      }
    }

    // 3. 逐工作流按策略折候选 → 生成动作。
    const actions: RecoveryAction[] = [];
    for (const [workflow, wfGaps] of byWorkflow) {
      const strategy = this._opts.policy.strategyFor(workflow);
      const { candidates, skipped } = selectCandidates(wfGaps, strategy);
      for (const s of skipped) {
        actions.push({
          kind: "skip",
          run: s.gap.run,
          reason: s.reason,
          at: s.gap.at,
        });
      }
      for (const gap of candidates) {
        actions.push(this._planCandidate(gap, maxAttempts));
      }
    }

    const plan: ReconciliationPlan = {
      scanned: rows.length,
      gapRunIds: openGaps.map((g) => g.run.run_id),
      actions,
    };
    this._log("debug", "recovery:replay", {
      scanned: plan.scanned,
      gaps: plan.gapRunIds.length,
      actions: plan.actions.length,
      maxAttempts,
    });
    return plan;
  }

  /**
   * 执行对账计划（落副作用）。逐个动作串行：auto-resume / catchup / 死信收口 / skip。
   * 死信路径 = 先账本收口（actual dead-letter）再投主+通知 —— 收口是持久真相，
   * 投递失败不回滚（对齐 T12 旁路副作用纪律）。
   */
  async apply(plan: ReconciliationPlan): Promise<RecoveryApplyResult> {
    let resumed = 0;
    let dispatched = 0;
    let deadLettered = 0;
    let skipped = 0;

    for (const action of plan.actions) {
      switch (action.kind) {
        case "auto-resume": {
          const port = this._requirePort("autoResume", action.run.run_id);
          await port.resume(action.run);
          resumed += 1;
          this._log("info", "recovery:auto-resume", {
            run_id: action.run.run_id,
            workflow: action.run.workflow,
            attempt: action.run.attempt,
          });
          break;
        }
        case "catchup": {
          const port = this._requirePort("dispatch", action.run.run_id);
          await port.dispatchCatchup(action.request);
          dispatched += 1;
          this._log("info", "recovery:catchup", {
            parent_run: action.run.run_id,
            workflow: action.request.workflow,
            attempt: action.request.attempt,
          });
          break;
        }
        case "dead-letter": {
          await this._deadLetter(action.run, action.receipt);
          deadLettered += 1;
          break;
        }
        case "skip": {
          skipped += 1;
          this._log("info", "recovery:skip", {
            run_id: action.run.run_id,
            workflow: action.run.workflow,
            reason: action.reason,
          });
          break;
        }
        default: {
          const unreachable: never = action;
          throw new RecoveryError(
            "run-row",
            `unhandled RecoveryAction: ${JSON.stringify(unreachable)}`,
          );
        }
      }
    }

    return { resumed, dispatched, deadLettered, skipped };
  }

  /* ────────────── 内部 ────────────── */

  private _readRows() {
    try {
      return this._opts.ledger.rows();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new RecoveryError("ledger-read", `ledger.rows() failed: ${msg}`);
    }
  }

  /** 候选缺口 → 动作：重试耗尽判死信，否则按 trigger 定级别（1 续跑 / 2 新会话）。 */
  private _planCandidate(gap: GapRun, maxAttempts: number): RecoveryAction {
    const run = gap.run;
    if (run.attempt >= maxAttempts) {
      return { kind: "dead-letter", run, receipt: this._receiptOf(run, gap.at) };
    }
    if (retryLevelOf(run) === 1) {
      return { kind: "auto-resume", level: 1, run };
    }
    const request: CatchupRequest = {
      workflow: run.workflow,
      trigger: "catchup",
      attempt: run.attempt + 1,
      parent_run: run.run_id,
    };
    return { kind: "catchup", level: 2, run, request };
  }

  /** 死信回执（形状与 T12 DeadLetterPayload 严格对齐；digest/blockers 如实合成）。 */
  private _receiptOf(run: RunRow, at: number): DeadLetterReceipt {
    return {
      kind: "dead-letter",
      run_id: run.run_id,
      workflow: run.workflow,
      attempt: run.attempt,
      trigger: run.trigger,
      parent_run: run.parent_run,
      session_id: run.session_id,
      digest: `failed：run ${run.run_id}（workflow=${run.workflow}, attempt=${run.attempt}）执行器崩溃，重试已耗尽`,
      blockers: Object.freeze([`retry-exhausted:attempt=${run.attempt}`, `trigger:${run.trigger}`]),
      at,
    };
  }

  /** 死信收口：账本 actual(dead-letter) → 投主 → 通知。投递/通知失败不回滚收口。 */
  private async _deadLetter(run: RunRow, receipt: DeadLetterReceipt): Promise<void> {
    try {
      this._opts.ledger.actual(run.run_id, receipt.at, "dead-letter", receipt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new RecoveryError("port", `dead-letter actual write failed for ${run.run_id}: ${msg}`);
    }
    this._log("warn", "recovery:dead-letter", {
      run_id: run.run_id,
      workflow: run.workflow,
      attempt: run.attempt,
    });

    const deliver = this._requirePort("mainDeliver", run.run_id);
    try {
      await deliver.deliver(receipt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._log("error", "recovery:dead-letter-deliver-failed", { run_id: run.run_id, error: msg });
    }

    const notify = this._opts.notify;
    if (notify !== undefined) {
      try {
        await notify(receipt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this._log("warn", "recovery:dead-letter-notify-failed", { run_id: run.run_id, error: msg });
      }
    }
  }

  private _requirePort<K extends "autoResume" | "dispatch" | "mainDeliver">(
    key: K,
    runId: string,
  ): NonNullable<ReconcilerOptions[K]> {
    const port = this._opts[key];
    if (port === undefined) {
      throw new RecoveryError(
        "port",
        `recovery action for run ${runId} needs port "${key}" but none was injected`,
      );
    }
    return port;
  }
}
