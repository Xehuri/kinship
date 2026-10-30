/**
 * T13 对账 / 两级重试 / 死信验收（docs/02 §T13；TDD：三种 catchup 策略表驱动先行）。
 *
 * 覆盖（冻结验收 + 计划补充形状）：
 *   1. 三种 catchup 策略（latest/all/none）表驱动，各含空差集 no-op；
 *   2. 两级重试分明——auto-resume=同 run 同会话（level 1）/ catchup=新会话（level 2）；
 *   3. 重试计数从账本 attempt 读、max 从 Limits 现读；耗尽 → 死信收口 + 投主 + 通知；
 *   4. 死信回执形状与 T12 DeadLetterPayload 严格对齐；
 *   5. 无内存态——重启=新建 Reconciler 纯文件重放，计划可复现、账本驱动。
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, type Limits } from "../convergence/index.js";
import type { RunRow, RunTrigger } from "../run-engine/index.js";
import {
  MapCatchupPolicy,
  MemoryAutoResume,
  MemoryCatchupDispatch,
  MemoryMainDeliver,
  MemoryRecoveryLedger,
} from "./memory-recovery.js";
import { Reconciler, type ReconcilerOptions } from "./reconciler.js";
import { orderGapsByRecency, retryLevelOf, selectCandidates } from "./strategy.js";
import {
  maxAttemptsOf,
  type CatchupStrategy,
  type DeadLetterReceipt,
  type GapRun,
  type RecoveryAction,
} from "./types.js";

/* ────────────── helpers ────────────── */

function nth<T>(items: ReadonlyArray<T>, i: number): T {
  const v = items[i];
  if (v === undefined) throw new Error(`no element at index ${i}`);
  return v;
}

let _seq = 0;
function runRow(over: Partial<RunRow> = {}): RunRow {
  _seq += 1;
  const hex = _seq.toString(16).padStart(16, "0");
  return {
    run_id: `run_${hex}`,
    workflow: "nightly-audit",
    attempt: 1,
    trigger: "manual",
    parent_run: null,
    session_id: `ses_${hex}`,
    ...over,
  };
}

interface Harness {
  ledger: MemoryRecoveryLedger;
  policy: MapCatchupPolicy;
  autoResume: MemoryAutoResume;
  dispatch: MemoryCatchupDispatch;
  mainDeliver: MemoryMainDeliver;
  reconciler: Reconciler;
}

function makeHarness(
  policy: ReadonlyMap<string, CatchupStrategy>,
  over: Partial<ReconcilerOptions> = {},
  limits: Limits = DEFAULT_LIMITS,
): Harness {
  const ledger = new MemoryRecoveryLedger();
  const autoResume = new MemoryAutoResume();
  const dispatch = new MemoryCatchupDispatch();
  const mainDeliver = new MemoryMainDeliver();
  const reconciler = new Reconciler({
    ledger,
    policy: new MapCatchupPolicy(policy),
    limits,
    autoResume,
    dispatch,
    mainDeliver,
    ...over,
  });
  return { ledger, policy: new MapCatchupPolicy(policy), autoResume, dispatch, mainDeliver, reconciler };
}

/** 种一批缺口：expected 无 actual（模拟崩溃形状）。 */
function seedGaps(ledger: MemoryRecoveryLedger, rows: ReadonlyArray<[RunRow, number]>): void {
  for (const [row, at] of rows) ledger.seed(row, at);
}

/** 种一条已收口 run：expected + actual。 */
function seedClosed(
  ledger: MemoryRecoveryLedger,
  row: RunRow,
  at: number,
  status: "done" | "failed" | "partial" | "dead-letter",
): void {
  ledger.expected(row.run_id, at, row);
  ledger.actual(row.run_id, at + 1, status, null);
}

function actionsOfKind<K extends RecoveryAction["kind"]>(
  plan: { actions: readonly RecoveryAction[] },
  kind: K,
): Array<Extract<RecoveryAction, { kind: K }>> {
  return plan.actions.filter((a): a is Extract<RecoveryAction, { kind: K }> => a.kind === kind);
}

/* ────────────── 1. 三种策略表驱动（各含空差集 no-op） ────────────── */

describe("catchup 策略（表驱动：latest/all/none）", () => {
  it.each([
    {
      name: "all：3 个缺口全部补跑（各新会话 attempt+1）",
      strategy: "all" as CatchupStrategy,
      gaps: [
        [runRow({ workflow: "billing" }), 100],
        [runRow({ workflow: "billing" }), 200],
        [runRow({ workflow: "billing" }), 300],
      ] as Array<[RunRow, number]>,
      wantCatchup: 3,
      wantSkip: 0,
    },
    {
      name: "all：空差集 → 零动作 no-op",
      strategy: "all" as CatchupStrategy,
      gaps: [] as Array<[RunRow, number]>,
      wantCatchup: 0,
      wantSkip: 0,
    },
    {
      name: "latest：多缺口只补最近一班，其余 skip(superseded)",
      strategy: "latest" as CatchupStrategy,
      gaps: [
        [runRow({ workflow: "audit" }), 100],
        [runRow({ workflow: "audit" }), 200],
        [runRow({ workflow: "audit" }), 300],
      ] as Array<[RunRow, number]>,
      wantCatchup: 1,
      wantSkip: 2,
    },
    {
      name: "latest：空差集 → 零动作 no-op",
      strategy: "latest" as CatchupStrategy,
      gaps: [] as Array<[RunRow, number]>,
      wantCatchup: 0,
      wantSkip: 0,
    },
    {
      name: "none：缺口全部作废 skip(strategy-none)，零补跑",
      strategy: "none" as CatchupStrategy,
      gaps: [
        [runRow({ workflow: "reminder" }), 100],
        [runRow({ workflow: "reminder" }), 200],
      ] as Array<[RunRow, number]>,
      wantCatchup: 0,
      wantSkip: 2,
    },
    {
      name: "none：空差集 → 零动作 no-op",
      strategy: "none" as CatchupStrategy,
      gaps: [] as Array<[RunRow, number]>,
      wantCatchup: 0,
      wantSkip: 0,
    },
  ])("$name", ({ strategy, gaps, wantCatchup, wantSkip }) => {
    const h = makeHarness(new Map([[gaps[0]?.[0].workflow ?? "w", strategy]]));
    seedGaps(h.ledger, gaps);

    const plan = h.reconciler.replay();
    expect(actionsOfKind(plan, "catchup")).toHaveLength(wantCatchup);
    expect(actionsOfKind(plan, "skip")).toHaveLength(wantSkip);
    expect(plan.gapRunIds).toHaveLength(gaps.length);
  });

  it("latest：候选 = 最近一班（expected 时刻最大者）；被取代者记 superseded", () => {
    const newest = runRow({ workflow: "audit" });
    const oldest = runRow({ workflow: "audit" });
    const middle = runRow({ workflow: "audit" });
    const h = makeHarness(new Map([["audit", "latest"]]));
    seedGaps(h.ledger, [
      [oldest, 100],
      [newest, 300],
      [middle, 200],
    ]);

    const plan = h.reconciler.replay();
    const catchup = nth(actionsOfKind(plan, "catchup"), 0);
    expect(catchup.run.run_id).toBe(newest.run_id);
    const skipped = actionsOfKind(plan, "skip");
    expect(skipped.map((s) => s.run.run_id).sort()).toEqual(
      [oldest.run_id, middle.run_id].sort(),
    );
    for (const s of skipped) expect(s.reason).toBe("strategy-latest-superseded");
  });

  it("逐工作流策略独立：audit=all 全补 / reminder=none 作废（同一账本）", () => {
    const h = makeHarness(
      new Map<string, CatchupStrategy>([
        ["audit", "all"],
        ["reminder", "none"],
      ]),
    );
    seedGaps(h.ledger, [
      [runRow({ workflow: "audit" }), 100],
      [runRow({ workflow: "audit" }), 200],
      [runRow({ workflow: "reminder" }), 150],
    ]);

    const plan = h.reconciler.replay();
    expect(actionsOfKind(plan, "catchup")).toHaveLength(2);
    expect(actionsOfKind(plan, "skip")).toHaveLength(1);
    expect(nth(actionsOfKind(plan, "skip"), 0).reason).toBe("strategy-none");
  });

  it("已收口 run 不算缺口（expected+actual）；scanned = 账本总行数", () => {
    const h = makeHarness(new Map([["audit", "all"]]));
    seedClosed(h.ledger, runRow({ workflow: "audit" }), 100, "done");
    seedGaps(h.ledger, [[runRow({ workflow: "audit" }), 200]]);

    const plan = h.reconciler.replay();
    expect(plan.scanned).toBe(3); // 2 expected + 1 actual
    expect(plan.gapRunIds).toHaveLength(1);
    expect(actionsOfKind(plan, "catchup")).toHaveLength(1);
  });
});

/* ────────────── 2. 两级重试分明（D19） ────────────── */

describe("两级重试（auto-resume=同 run 同会话 / catchup=新会话）", () => {
  it("trigger=auto-resume → level 1：动作 auto-resume，apply 走 resume 端口、不派发新 run", async () => {
    const row = runRow({ workflow: "audit", trigger: "auto-resume" });
    const h = makeHarness(new Map([["audit", "all"]]));
    seedGaps(h.ledger, [[row, 100]]);

    const plan = h.reconciler.replay();
    const action = nth(actionsOfKind(plan, "auto-resume"), 0);
    expect(action.level).toBe(1);
    expect(action.run.run_id).toBe(row.run_id);

    const result = await h.reconciler.apply(plan);
    expect(result.resumed).toBe(1);
    expect(result.dispatched).toBe(0);
    expect(h.autoResume.resumed.map((r) => r.run_id)).toEqual([row.run_id]);
    expect(h.dispatch.requests).toHaveLength(0);
  });

  it("trigger=cron/manual/script → level 2：动作 catchup，request 带 attempt+1 + parent_run，apply 走新会话端口", async () => {
    const triggers: RunTrigger[] = ["cron", "manual", "script"];
    for (const trigger of triggers) {
      const row = runRow({ workflow: "billing", trigger, attempt: 2 });
      const h = makeHarness(new Map([["billing", "all"]]));
      seedGaps(h.ledger, [[row, 100]]);

      const plan = h.reconciler.replay();
      const action = nth(actionsOfKind(plan, "catchup"), 0);
      expect(action.level).toBe(2);
      expect(action.request).toEqual({
        workflow: "billing",
        trigger: "catchup",
        attempt: 3,
        parent_run: row.run_id,
      });

      const result = await h.reconciler.apply(plan);
      expect(result.dispatched).toBe(1);
      expect(result.resumed).toBe(0);
      expect(h.dispatch.requests).toEqual([action.request]);
      expect(h.autoResume.resumed).toHaveLength(0);
    }
  });

  it("retryLevelOf：仅 auto-resume 是 level 1，其余一律 level 2", () => {
    expect(retryLevelOf(runRow({ trigger: "auto-resume" }))).toBe(1);
    for (const t of ["cron", "script", "manual", "catchup", "rerun"] as RunTrigger[]) {
      expect(retryLevelOf(runRow({ trigger: t }))).toBe(2);
    }
  });
});

/* ────────────── 3. max 从 Limits 现读 + 死信 ────────────── */

describe("重试耗尽 → 死信（max 从 Limits 现读）", () => {
  it("maxAttemptsOf = 1 + Limits.autoContinuations；热载改值即刻生效", () => {
    expect(maxAttemptsOf({ ...DEFAULT_LIMITS, autoContinuations: 2 })).toBe(3);
    expect(maxAttemptsOf({ ...DEFAULT_LIMITS, autoContinuations: 0 })).toBe(1);
    expect(maxAttemptsOf({ ...DEFAULT_LIMITS, autoContinuations: 5 })).toBe(6);
  });

  it("attempt >= max → dead-letter 动作；attempt < max → 仍 catchup（边界）", () => {
    const limits: Limits = { ...DEFAULT_LIMITS, autoContinuations: 2 }; // max=3
    const atMax = runRow({ workflow: "audit", attempt: 3 });
    const belowMax = runRow({ workflow: "audit", attempt: 2 });
    const h = makeHarness(new Map([["audit", "all"]]), {}, limits);
    seedGaps(h.ledger, [
      [belowMax, 100],
      [atMax, 200],
    ]);

    const plan = h.reconciler.replay();
    expect(actionsOfKind(plan, "catchup").map((a) => a.run.run_id)).toEqual([belowMax.run_id]);
    expect(actionsOfKind(plan, "dead-letter").map((a) => a.run.run_id)).toEqual([atMax.run_id]);
  });

  it("apply 死信：账本收口 actual(dead-letter) + 回执投主 + 通知钩子", async () => {
    const limits: Limits = { ...DEFAULT_LIMITS, autoContinuations: 1 }; // max=2
    const row = runRow({ workflow: "billing", trigger: "cron", attempt: 2, parent_run: null });
    const notified: DeadLetterReceipt[] = [];
    const h = makeHarness(
      new Map([["billing", "all"]]),
      { notify: (r) => void notified.push(r) },
      limits,
    );
    seedGaps(h.ledger, [[row, 500]]);

    const plan = h.reconciler.replay();
    const result = await h.reconciler.apply(plan);
    expect(result.deadLettered).toBe(1);

    // 账本收口（持久真相）
    const actual = h.ledger.rows().find((r) => r.t === "actual");
    expect(actual?.t).toBe("actual");
    if (actual?.t !== "actual") throw new Error("unreachable");
    expect(actual.status).toBe("dead-letter");
    expect(h.ledger.gaps()).toEqual([]);

    // 投主 + 通知
    expect(h.mainDeliver.delivered).toHaveLength(1);
    expect(notified).toHaveLength(1);
    expect(nth(h.mainDeliver.delivered, 0)).toEqual(nth(notified, 0));
  });

  it("死信回执形状与 T12 DeadLetterPayload 逐字段对齐", async () => {
    const limits: Limits = { ...DEFAULT_LIMITS, autoContinuations: 0 }; // max=1
    const parent = runRow();
    const row = runRow({
      workflow: "billing",
      trigger: "manual",
      attempt: 1,
      parent_run: parent.run_id,
    });
    const h = makeHarness(new Map([["billing", "all"]]), {}, limits);
    seedGaps(h.ledger, [[row, 777]]);

    await h.reconciler.apply(h.reconciler.replay());
    const receipt = nth(h.mainDeliver.delivered, 0);

    // 与 T12 DeadLetterPayload 同字段集（T12 的失败终态死信由引擎 emit）
    expect(receipt.kind).toBe("dead-letter");
    expect(receipt.run_id).toBe(row.run_id);
    expect(receipt.workflow).toBe("billing");
    expect(receipt.attempt).toBe(1);
    expect(receipt.trigger).toBe("manual");
    expect(receipt.parent_run).toBe(parent.run_id);
    expect(receipt.session_id).toBe(row.session_id);
    expect(receipt.at).toBe(777);
    expect(receipt.digest).toContain("重试已耗尽");
    expect(receipt.blockers.length).toBeGreaterThan(0);
    expect(Object.keys(receipt).sort()).toEqual(
      [
        "at",
        "attempt",
        "blockers",
        "digest",
        "kind",
        "parent_run",
        "run_id",
        "session_id",
        "trigger",
        "workflow",
      ].sort(),
    );
  });

  it("投主失败不回滚已收口的账本终态（旁路纪律）", async () => {
    const limits: Limits = { ...DEFAULT_LIMITS, autoContinuations: 0 };
    const row = runRow({ workflow: "billing", attempt: 1 });
    const h = makeHarness(
      new Map([["billing", "all"]]),
      {
        mainDeliver: {
          deliver() {
            throw new Error("inbox down");
          },
        },
      },
      limits,
    );
    seedGaps(h.ledger, [[row, 100]]);

    const result = await h.reconciler.apply(h.reconciler.replay());
    expect(result.deadLettered).toBe(1);
    expect(h.ledger.gaps()).toEqual([]); // 收口已持久
    const actual = h.ledger.rows().find((r) => r.t === "actual");
    expect(actual?.t === "actual" && actual.status).toBe("dead-letter");
  });
});

/* ────────────── 4. 无内存态 / 重启语义 ────────────── */

describe("无内存态（重启=纯文件重放）", () => {
  it("同一账本两次 replay 计划一致；新建 Reconciler 结果仍一致（重启语义）", () => {
    const h = makeHarness(new Map([["audit", "all"]]));
    seedGaps(h.ledger, [
      [runRow({ workflow: "audit" }), 100],
      [runRow({ workflow: "audit" }), 200],
    ]);

    const p1 = h.reconciler.replay();
    const p2 = h.reconciler.replay();
    expect(p2.actions).toEqual(p1.actions);
    expect(p2.gapRunIds).toEqual(p1.gapRunIds);

    // 重启：全新对账器实例，唯一输入仍是账本
    const restarted = new Reconciler({
      ledger: h.ledger,
      policy: new MapCatchupPolicy(new Map([["audit", "all"]])),
      limits: DEFAULT_LIMITS,
      autoResume: new MemoryAutoResume(),
      dispatch: new MemoryCatchupDispatch(),
      mainDeliver: new MemoryMainDeliver(),
    });
    expect(restarted.replay().actions).toEqual(p1.actions);
  });

  it("重试计数持久在账本 attempt（非内存）：apply 后重放仍见同一 attempt", async () => {
    const row = runRow({ workflow: "audit", attempt: 2 });
    const h = makeHarness(new Map([["audit", "all"]]));
    seedGaps(h.ledger, [[row, 100]]);

    await h.reconciler.apply(h.reconciler.replay());
    // 补跑请求的 attempt 来自账本行，非内存计数器
    expect(nth(h.dispatch.requests, 0).attempt).toBe(3);
    const expectedRow = h.ledger.rows().find((r) => r.t === "expected");
    expect(expectedRow?.t === "expected" && (expectedRow.payload as RunRow).attempt).toBe(2);
  });

  it("死信收口后重放不再见缺口（账本驱动，非内存）", async () => {
    const limits: Limits = { ...DEFAULT_LIMITS, autoContinuations: 0 };
    const row = runRow({ workflow: "billing", attempt: 1 });
    const h = makeHarness(new Map([["billing", "all"]]), {}, limits);
    seedGaps(h.ledger, [[row, 100]]);

    await h.reconciler.apply(h.reconciler.replay());
    const plan = h.reconciler.replay();
    expect(plan.gapRunIds).toEqual([]);
    expect(plan.actions).toEqual([]);
  });
});

/* ────────────── 5. 策略纯函数边界 ────────────── */

describe("strategy 纯函数", () => {
  it("orderGapsByRecency：at 降序，同 at 按 run_id 升序（确定 tie-break）", () => {
    const a = runRow();
    const b = runRow();
    const gaps: GapRun[] = [
      { run: a, at: 100 },
      { run: b, at: 100 },
    ];
    const ordered = orderGapsByRecency(gaps);
    expect(ordered[0]?.run.run_id).toBe(a.run_id < b.run_id ? a.run_id : b.run_id);
    expect(ordered[1]?.run.run_id).toBe(a.run_id < b.run_id ? b.run_id : a.run_id);
  });

  it("selectCandidates：空差集恒双空（任意策略）", () => {
    for (const s of ["latest", "all", "none"] as CatchupStrategy[]) {
      const sel = selectCandidates([], s);
      expect(sel.candidates).toEqual([]);
      expect(sel.skipped).toEqual([]);
    }
  });
});
