/**
 * T35 E2E —— 死信路径 + 跨重启重试阶梯（真 Ledger 文件 + 真 RunEngine + 真 Reconciler）。
 * （docs/02 §T35；决策 docs/01 D15/D19/D26/D31）
 *
 * 冻结验收补充：
 *   1. 重试耗尽缺口 → 死信：磁盘落 actual(dead-letter)，payload 与 T12 主通道
 *      DeadLetterPayload 字段集逐一同构（形状落主通道）；投主 + 通知双轨各一份；
 *   2. 跨重启阶梯：每轮 = 全新进程实例（新 Ledger + 新引擎 + 新 Reconciler），
 *      catchup 经 SpawningCatchupPort 真派发补跑（补跑再崩 = 缺口滚存），
 *      latest 策略逐轮取最近一班，attempt 到 max → 死信收口 → 再重启缺口清零（对已收口者）。
 */

import { describe, expect, it } from "vitest";

import {
  CRASH_BEHAVIOR,
  ScriptedSessionPort,
  SpawningCatchupPort,
  actionsOfKind,
  actualRows,
  dispatchInput,
  expectedRows,
  launch,
  makeHarness,
  nth,
  restart,
  type Harness,
} from "./harness.js";
import type { CatchupRequest } from "@axeuh/loom-core/recovery";
import type { RunRow } from "@axeuh/loom-core/run-engine";
import { DEFAULT_LIMITS, type Limits } from "@axeuh/loom-core";

/** 崩溃一班：真引擎派发 + 执行端口抛炸 → 账本只留 expected（缺口形状）。 */
async function crashRun(h: Harness, runId: string, workflow: string, attempt: number): Promise<void> {
  const port = new ScriptedSessionPort();
  port.script(runId, CRASH_BEHAVIOR);
  const engine = h.newEngine(h.openLedger(), port);
  await launch(engine, dispatchInput(runId, workflow, "cron", { attempt }));
}

describe("T35 E2E / 死信路径落主通道形状", () => {
  it("max=1 时 attempt=1 耗尽：磁盘 actual(dead-letter) payload 与 T12 主通道死信同构 + 双轨回执", async () => {
    const h = makeHarness();
    try {
      const runId = h.nextRunId();
      await crashRun(h, runId, "billing", 1);
      const limits: Limits = { ...DEFAULT_LIMITS, autoContinuations: 0 }; // max = 1

      const r = restart(h, new Map([["billing", "all"]]), { limits });
      const plan = r.reconciler.replay();
      expect(actionsOfKind(plan, "dead-letter").map((a) => a.run.run_id)).toEqual([runId]);

      const applied = await r.reconciler.apply(plan);
      expect(applied).toEqual({ resumed: 0, dispatched: 0, deadLettered: 1, skipped: 0 });

      // 磁盘真相：缺口收口为 actual(dead-letter)，payload = 死信回执。
      const raw = h.readFileRows();
      expect(expectedRows(raw)).toHaveLength(1); // 崩溃事实行原样保留，不篡改
      const actual = nth(actualRows(raw), 0);
      expect(actual.status).toBe("dead-letter");
      expect(actual.runId).toBe(runId);

      // 形状对齐断言：磁盘回执字段集 == T12 主通道 DeadLetterPayload 字段清单
      // （编译期双向同形由 T13 `_deadLetterShapeAligned` 门禁保证；此处落运行时证据）。
      const onDisk = actual.payload as Record<string, unknown>;
      expect(Object.keys(onDisk).sort()).toEqual(
        ["at", "attempt", "blockers", "digest", "kind", "parent_run", "run_id", "session_id", "trigger", "workflow"].sort(),
      );
      expect(onDisk).toMatchObject({
        kind: "dead-letter",
        run_id: runId,
        workflow: "billing",
        attempt: 1,
        trigger: "cron",
        parent_run: null,
        session_id: `ses_${runId.slice(4)}`,
      });
      expect(typeof onDisk["digest"]).toBe("string");
      expect(Array.isArray(onDisk["blockers"])).toBe(true);

      // 双轨：投主 + 通知收到同一份回执（D23③）。
      expect(r.mainDeliver.delivered).toHaveLength(1);
      expect(r.notified).toHaveLength(1);
      expect(nth(r.mainDeliver.delivered, 0)).toEqual(nth(r.notified, 0));

      // 再重启：账本驱动收敛 —— 已收口 run 不再见缺口、零动作。
      const r2 = restart(h, new Map([["billing", "all"]]), { limits });
      const plan2 = r2.reconciler.replay();
      expect(plan2.gapRunIds).toEqual([]);
      expect(plan2.actions).toEqual([]);
    } finally {
      h.cleanup();
    }
  });
});

describe("T35 E2E / 跨重启完整重试阶梯（latest：catchup 真派发 → 死信收口）", () => {
  it("每轮全新进程实例：att1→补跑att2→补跑att3=max→死信；磁盘全程唯一真相", async () => {
    const h = makeHarness();
    try {
      const limits: Limits = { ...DEFAULT_LIMITS, autoContinuations: 2 }; // max = 3
      const run1 = h.nextRunId();
      await crashRun(h, run1, "billing", 1);

      /**
       * 一轮「重启 + 对账 + 应用」。catchup 接真派发链路：新 Ledger + 新引擎补跑，
       * 补跑同样崩（缺口滚存下一轮）—— 与 server 装配同款（端口补 prompt 转 dispatch）。
       * 返回本轮观察件供逐轮断言。
       */
      async function bootRound(expectedGap: string, wantAttemptPlusOne: boolean) {
        const spawned: RunRow[] = [];
        const dispatch = new SpawningCatchupPort(async (request: CatchupRequest) => {
          const runId = h.nextRunId();
          const port = new ScriptedSessionPort();
          port.script(runId, CRASH_BEHAVIOR);
          const engine = h.newEngine(h.openLedger(), port);
          const record = await launch(
            engine,
            dispatchInput(runId, request.workflow, "catchup", {
              attempt: request.attempt,
              parentRun: request.parent_run,
            }),
          );
          expect(record.row).toMatchObject({
            run_id: runId,
            workflow: request.workflow,
            attempt: request.attempt,
            trigger: "catchup",
            parent_run: request.parent_run,
          });
          spawned.push(record.row);
        });

        const r = restart(h, new Map([["billing", "latest"]]), { limits, dispatch });
        const plan = r.reconciler.replay();
        if (wantAttemptPlusOne) {
          const catchup = actionsOfKind(plan, "catchup");
          expect(catchup).toHaveLength(1);
          expect(nth(catchup, 0).run.run_id).toBe(expectedGap);
          expect(nth(catchup, 0).request.attempt).toBeGreaterThan(1);
        } else {
          expect(actionsOfKind(plan, "dead-letter").map((a) => a.run.run_id)).toEqual([expectedGap]);
        }
        const applied = await r.reconciler.apply(plan);
        expect(spawned.length).toBe(applied.dispatched);
        return { r, plan, applied, spawned };
      }

      // 轮 1：唯一缺口 run1(att1) → latest 候选=run1 → catchup 真派 run2(att2)，再崩。
      const round1 = await bootRound(run1, true);
      expect(round1.applied.dispatched).toBe(1);
      expect(nth(round1.spawned, 0).attempt).toBe(2);
      const run2 = nth(round1.spawned, 0).run_id;

      // 轮 2：磁盘缺口 [run1, run2]，latest 只认最近一班 run2；run1 记 superseded（no-op）。
      const r2 = restart(h, new Map([["billing", "latest"]]), { limits });
      const plan2 = r2.reconciler.replay();
      expect(plan2.gapRunIds).toEqual([run1, run2]); // 出现序稳定（文件真相）
      expect(nth(actionsOfKind(plan2, "catchup"), 0).run.run_id).toBe(run2);
      expect(nth(actionsOfKind(plan2, "skip"), 0).reason).toBe("strategy-latest-superseded");
      const round2 = await bootRound(run2, true);
      expect(nth(round2.spawned, 0).attempt).toBe(3);
      const run3 = nth(round2.spawned, 0).run_id;

      // 轮 3：候选=run3，att3 = max → 死信收口：磁盘落 actual(dead-letter) 且投主+通知。
      const round3 = await bootRound(run3, false);
      expect(round3.applied.deadLettered).toBe(1);
      const raw3 = h.readFileRows();
      const dlRow = nth(actualRows(raw3), 0);
      expect(dlRow.status).toBe("dead-letter");
      expect(dlRow.runId).toBe(run3);
      expect(round3.r.mainDeliver.delivered).toHaveLength(1);
      expect(round3.r.notified).toHaveLength(1);

      // 终局重启（latest 不变）：run3 已收口不再出现；剩余缺口 [run1, run2] 中
      // 最近一班 run2 仍是 catchup 候选、run1 记 superseded —— 对账真相只在文件。
      const r4 = restart(h, new Map([["billing", "latest"]]), { limits });
      const plan4 = r4.reconciler.replay();
      expect(plan4.gapRunIds).toEqual([run1, run2]);
      expect(actionsOfKind(plan4, "dead-letter")).toHaveLength(0);
      expect(actionsOfKind(plan4, "catchup").map((a) => a.run.run_id)).toEqual([run2]);
      expect(actionsOfKind(plan4, "skip").map((s) => s.run.run_id)).toEqual([run1]);
    } finally {
      h.cleanup();
    }
  });
});
