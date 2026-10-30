/**
 * T35 E2E —— 账本崩溃追赶（真 Ledger 临时目录 + 真 RunEngine + 真 Reconciler）。
 * （docs/02 §T35；决策 docs/01 D15「崩溃即重放」/ D19 两级重试）
 *
 * 冻结验收：崩溃形状（只写 expected 无 actual）→「重启」（全新 Ledger/Reconciler 实例，
 * 唯一输入 = 磁盘 jsonl）→ 检出 gap → latest/all/none 三种逐工作流策略各走一遍。
 * 断言优先走磁盘字节真相（readFileRows / readFileText），死信与链式追赶见姊妹文件。
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_LIMITS, type Limits } from "@axeuh/loom-core";
import {
  CRASH_BEHAVIOR,
  ScriptedSessionPort,
  actionsOfKind,
  actualRows,
  dispatchInput,
  expectedRows,
  launch,
  makeHarness,
  nth,
  restart,
  terminalResult,
  type Harness,
} from "./harness.js";

/** 崩溃一台引擎并「杀掉进程」：真派发 + 执行端口抛炸 → 账本只剩 expected（缺口形状）。 */
async function crashOne(
  h: Harness,
  runId: string,
  workflow: string,
  trigger: "cron" | "auto-resume" = "cron",
): Promise<void> {
  const port = new ScriptedSessionPort();
  port.script(runId, CRASH_BEHAVIOR);
  const engine = h.newEngine(h.openLedger(), port);
  const record = await launch(engine, dispatchInput(runId, workflow, trigger));
  // 引擎内存视图：崩溃形状 = crashed + failed（进程级），但账本不写 actual。
  expect(record.crashed).toBe(true);
  expect(record.state).toBe("failed");
  expect(engine.gaps()).toEqual([runId]);
  // 引擎实例离开作用域 = 进程被杀；内存登记表随之蒸发（重启语义只认磁盘）。
}

describe("T35 E2E / 崩溃 → 重启 → gap 检出（磁盘真相）", () => {
  it("真账本只落 expected 无 actual；重启后新 Reconciler 从文件检出同一 gap", async () => {
    const h = makeHarness();
    try {
      const runId = h.nextRunId();
      await crashOne(h, runId, "nightly-audit");

      // 磁盘字节真相：1 行 expected、0 行 actual。
      const raw = h.readFileRows();
      expect(expectedRows(raw)).toHaveLength(1);
      expect(actualRows(raw)).toHaveLength(0);
      expect(nth(expectedRows(raw), 0).runId).toBe(runId);

      // 重启 = 全新 Ledger + 全新 Reconciler（无任何内存态输入）。
      const r = restart(h, new Map([["nightly-audit", "all"]]));
      const plan = r.reconciler.replay();
      expect(plan.scanned).toBe(1);
      expect(plan.gapRunIds).toEqual([runId]);
      expect(r.ledger.gaps()).toEqual([runId]);

      // level 2 补跑动作：attempt+1、parent_run=缺口 run（D19）。
      const catchup = nth(actionsOfKind(plan, "catchup"), 0);
      expect(catchup.level).toBe(2);
      expect(catchup.request).toEqual({
        workflow: "nightly-audit",
        trigger: "catchup",
        attempt: 2,
        parent_run: runId,
      });
    } finally {
      h.cleanup();
    }
  });

  it("已收口 run（expected+actual 齐）不是缺口；崩溃 gap 与正常终态同账本共存", async () => {
    const h = makeHarness();
    try {
      const doneId = h.nextRunId();
      const crashId = h.nextRunId();
      const port = new ScriptedSessionPort();
      port.script(doneId, { kind: "terminal", result: terminalResult("done", "正常收工") });
      port.script(crashId, CRASH_BEHAVIOR);
      const engine = h.newEngine(h.openLedger(), port);
      await launch(engine, dispatchInput(doneId, "nightly-audit", "script"));
      await launch(engine, dispatchInput(crashId, "nightly-audit", "cron"));

      const r = restart(h, new Map([["nightly-audit", "all"]]));
      const plan = r.reconciler.replay();
      expect(plan.scanned).toBe(3); // 2 expected + 1 actual
      expect(plan.gapRunIds).toEqual([crashId]);
      expect(actionsOfKind(plan, "catchup").map((a) => a.run.run_id)).toEqual([crashId]);
    } finally {
      h.cleanup();
    }
  });

  it("重启重放可复现：同一磁盘账本两个全新 Reconciler 实例计划一致", async () => {
    const h = makeHarness();
    try {
      const a = h.nextRunId();
      const b = h.nextRunId();
      await crashOne(h, a, "billing");
      await crashOne(h, b, "billing");

      const p1 = restart(h, new Map([["billing", "all"]])).reconciler.replay();
      const p2 = restart(h, new Map([["billing", "all"]])).reconciler.replay();
      expect(p2.actions).toEqual(p1.actions);
      expect(p2.gapRunIds).toEqual([a, b]); // expected 出现序，稳定
    } finally {
      h.cleanup();
    }
  });
});

describe("T35 E2E / catchup 策略 latest/all/none 重启后各走一遍", () => {
  /** 三种策略共用：同工作流 3 个崩溃缺口（时钟严格递增 → at 唯一）。 */
  async function seedThreeCrashes(h: Harness): Promise<string[]> {
    const ids = [h.nextRunId(), h.nextRunId(), h.nextRunId()];
    for (const id of ids) await crashOne(h, id, "wf-multi");
    return ids;
  }

  it("latest：只补最近一班（磁盘 at 最大者），其余 skip(superseded) 不伪造终态", async () => {
    const h = makeHarness();
    try {
      const [old1, old2, newest] = await seedThreeCrashes(h);
      const r = restart(h, new Map([["wf-multi", "latest"]]));
      const plan = r.reconciler.replay();
      expect(plan.gapRunIds).toEqual([old1, old2, newest]);

      const catchup = actionsOfKind(plan, "catchup");
      expect(catchup).toHaveLength(1);
      expect(nth(catchup, 0).run.run_id).toBe(newest);
      const skipped = actionsOfKind(plan, "skip");
      expect(skipped).toHaveLength(2);
      for (const s of skipped) expect(s.reason).toBe("strategy-latest-superseded");

      const applied = await r.reconciler.apply(plan);
      expect(applied.dispatched).toBe(1);
      expect(applied.skipped).toBe(2);

      // 磁盘真相：latest 策略下被取代缺口仍只有 expected（skip = 纯 no-op，无伪造 actual）。
      const raw = h.readFileRows();
      expect(actualRows(raw)).toHaveLength(0);
      expect(new Set(expectedRows(raw).map((e) => e.runId))).toEqual(new Set([old1, old2, newest]));
    } finally {
      h.cleanup();
    }
  });

  it("all：每个缺口各补一次，补跑请求 attempt/parent 逐一对应", async () => {
    const h = makeHarness();
    try {
      const ids = await seedThreeCrashes(h);
      const r = restart(h, new Map([["wf-multi", "all"]]));
      const plan = r.reconciler.replay();
      const catchup = actionsOfKind(plan, "catchup");
      expect(catchup).toHaveLength(3);
      expect(catchup.map((a) => a.request.parent_run)).toEqual(ids);
      for (const a of catchup) expect(a.request.attempt).toBe(2);

      const applied = await r.reconciler.apply(plan);
      expect(applied.dispatched).toBe(3);
      expect(actionsOfKind(plan, "skip")).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  it("none：缺口全部作废（skip strategy-none），apply 后账本文件一字节不变", async () => {
    const h = makeHarness();
    try {
      const ids = await seedThreeCrashes(h);
      const before = h.readFileText();

      const r = restart(h, new Map([["wf-multi", "none"]]));
      const plan = r.reconciler.replay();
      expect(actionsOfKind(plan, "catchup")).toHaveLength(0);
      const skipped = actionsOfKind(plan, "skip");
      expect(skipped).toHaveLength(3);
      for (const s of skipped) expect(s.reason).toBe("strategy-none");

      const applied = await r.reconciler.apply(plan);
      expect(applied).toEqual({ resumed: 0, dispatched: 0, deadLettered: 0, skipped: 3 });
      expect(h.readFileText()).toBe(before); // 提醒型作废 = 真 no-op

      // 未声明策略的工作流保守回落 none（与 server 装配缺省同款语义）。
      const r2 = restart(h, new Map());
      const plan2 = r2.reconciler.replay();
      expect(actionsOfKind(plan2, "skip")).toHaveLength(3);
      expect(plan2.gapRunIds).toEqual(ids);
    } finally {
      h.cleanup();
    }
  });

  it("两级重试分明：auto-resume 缺口走 resume（level 1），cron 缺口走补跑（level 2）", async () => {
    const h = makeHarness();
    try {
      // auto-resume 触发的崩溃 run（D19 level 1 = 同 run 同会话 resume）。
      const resumeId = h.nextRunId();
      const cronId = h.nextRunId();
      await crashOne(h, resumeId, "wf-multi", "auto-resume");
      await crashOne(h, cronId, "wf-multi");

      const r = restart(h, new Map([["wf-multi", "all"]]));
      const plan = r.reconciler.replay();
      const resumed = actionsOfKind(plan, "auto-resume");
      expect(resumed).toHaveLength(1);
      expect(nth(resumed, 0).level).toBe(1);
      expect(nth(resumed, 0).run.run_id).toBe(resumeId);

      const applied = await r.reconciler.apply(plan);
      expect(applied.resumed).toBe(1);
      expect(applied.dispatched).toBe(1);
      expect(r.autoResume.resumed.map((row) => row.run_id)).toEqual([resumeId]);
    } finally {
      h.cleanup();
    }
  });

  it("重试代数读自磁盘 attempt（非内存）：attempt=3 的缺口崩溃后请求 attempt=4", async () => {
    const h = makeHarness();
    try {
      const runId = h.nextRunId();
      const port = new ScriptedSessionPort();
      port.script(runId, CRASH_BEHAVIOR);
      const engine = h.newEngine(h.openLedger(), port);
      await launch(engine, dispatchInput(runId, "billing", "catchup", { attempt: 3 }));

      // max = 1 + autoContinuations(3) = 4 > 3 → 仍是 catchup 候选（未耗尽）。
      const limits: Limits = { ...DEFAULT_LIMITS, autoContinuations: 3 };
      const r = restart(h, new Map([["billing", "all"]]), { limits });
      const plan = r.reconciler.replay();
      expect(nth(actionsOfKind(plan, "catchup"), 0).request.attempt).toBe(4); // 3+1，读自文件行
      await r.reconciler.apply(plan);

      // 磁盘 expected 行未被 apply 改写：payload 仍是崩溃时的 RunRow，且仍无 actual。
      const raw = h.readFileRows();
      expect(actualRows(raw)).toHaveLength(0);
      expect(nth(expectedRows(raw), 0).payload).toMatchObject({
        run_id: runId,
        workflow: "billing",
        attempt: 3,
        trigger: "catchup",
      });
    } finally {
      h.cleanup();
    }
  });
});
