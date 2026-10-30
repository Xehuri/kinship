/**
 * 检查点编排验收（Todo 27）：
 * - 真 JsonPlanStore / JsonFlowContinuationStore，根全部落在 mkdtemp；
 * - executeBatch 用假实现，不触真实 data-check、不读 ai/data、不碰生产 Loom；
 * - 覆盖 done / skipped / missing plan / flow 失败 / batch 失败，另钉一条 partial wait。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type {
  FlowContinuationStore,
  FlowContinuationWaitInput,
} from "@axeuh/loom-core";

import { JsonFlowContinuationStore } from "../flow/json-flow-continuation-store.js";
import { JsonPlanStore } from "../plan/json-plan-store.js";
import type {
  PlanCoverage,
  PlanDocument,
  PlanItem,
  PlanItemStatus,
  PlanWriteInput,
} from "../plan/plan-store.js";
import {
  createCoverageBatchExecutor,
  runCheckpoint,
  type CheckpointBatchContext,
  type CheckpointFlowTool,
  type CheckpointPlanTool,
} from "./checkpoint-runner.js";
import type {
  CoverageVerifyResult,
  CoverageVerifyStatus,
  CoverageVerifier,
} from "./coverage-verify.js";

const DATE = "2026-10-28";
const TARGET_DATE = "2026-10-27";
const SESSION = "ses_checkpoint_runner";
const NOW = Date.UTC(2026, 9, 28, 8, 0, 0);

const COVERAGE: PlanCoverage = {
  profile: "merged_7",
  checkpoints: ["cov-00", "cov-06", "cov-08", "cov-12", "cov-16", "cov-20", "cov-22"],
  debt: [],
};

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

interface PlanSpy {
  readonly tool: CheckpointPlanTool;
  readonly reviseCalls: Array<{
    readonly date: string;
    readonly expectedVersion: number;
    readonly ops: unknown;
    readonly reason: string;
  }>;
}

interface FlowSpy {
  readonly tool: CheckpointFlowTool;
  readonly actions: Array<{ readonly action: string; readonly input: unknown }>;
}

interface Harness {
  readonly planRoot: string;
  readonly planStore: JsonPlanStore;
  readonly flowStore: JsonFlowContinuationStore;
  readonly plan: PlanSpy;
  readonly flow: FlowSpy;
}

function setup(): Harness {
  const planRoot = mkdtempSync(join(tmpdir(), "checkpoint-plan-"));
  const flowRoot = mkdtempSync(join(tmpdir(), "checkpoint-flow-"));
  roots.push(planRoot, flowRoot);

  const planStore = new JsonPlanStore({ planRoot, now: () => NOW });
  const flowStore = new JsonFlowContinuationStore({
    stateRoot: flowRoot,
    now: () => NOW,
  });

  const reviseCalls: PlanSpy["reviseCalls"] = [];
  const planTool: CheckpointPlanTool = {
    read: (date) => planStore.read(date),
    revise: (date, expectedVersion, ops, reason) => {
      reviseCalls.push({ date, expectedVersion, ops, reason });
      return planStore.revise(date, expectedVersion, ops, reason);
    },
  };

  const actions: Array<{ readonly action: string; readonly input: unknown }> = [];
  const boundFlow = (store: FlowContinuationStore): CheckpointFlowTool => ({
    wait: (input: FlowContinuationWaitInput) => {
      actions.push({ action: "wait", input });
      return store.wait(SESSION, input);
    },
    resume: (input) => {
      actions.push({ action: "resume", input });
      return store.resume(SESSION, input);
    },
    close: (input) => {
      actions.push({ action: "close", input });
      return store.close(SESSION, input);
    },
  });

  return {
    planRoot,
    planStore,
    flowStore,
    plan: { tool: planTool, reviseCalls },
    flow: { tool: boundFlow(flowStore), actions },
  };
}

function coverageItem(
  checkpointId: string,
  status: PlanItemStatus = "planned",
): PlanItem {
  return {
    id: checkpointId,
    kind: "coverage",
    intent: `${checkpointId} coverage`,
    status,
    target_date: TARGET_DATE,
    window: "22:00~00:00",
    checkpoint_id: checkpointId,
    done_when: "check_coverage exit 0",
  };
}

function careItem(id: string, checkpointId: string): PlanItem {
  return {
    id,
    kind: "care",
    intent: "材料提交",
    status: "planned",
    window: "09:30~11:00",
    checkpoint_id: checkpointId,
    done_when: "材料提交成功",
  };
}

function writePlan(store: JsonPlanStore, items: readonly PlanItem[]): Promise<PlanDocument> {
  const input: PlanWriteInput = {
    date: DATE,
    status: "committed",
    items,
    coverage: COVERAGE,
    notes: ["initial"],
  };
  return store.write(input);
}

function auditActions(planRoot: string): string[] {
  const path = join(planRoot, "daily", DATE, `plan-${DATE}.audit.jsonl`);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => (JSON.parse(line) as { action: string }).action);
}

describe("runCheckpoint", () => {
  it("done checkpoint: one revise, item done, flow closed", async () => {
    const h = setup();
    const before = await writePlan(h.planStore, [coverageItem("cov-12")]);
    await h.flowStore.wait(SESSION, {
      id: "cov-12",
      source: { plan_date: DATE, checkpoint_id: "cov-12" },
      waiting_on: "data-check batch",
      next_at: "10m",
    });

    const result = await runCheckpoint({
      planTool: h.plan.tool,
      flowTool: h.flow.tool,
      date: DATE,
      checkpointId: "cov-12",
      targetDate: TARGET_DATE,
      executeBatch: async () => ({ status: "done", note: "coverage exit 0" }),
      now: () => NOW,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("done");
    expect(result.steps).toEqual({
      planRead: true,
      batchExecuted: true,
      planRevised: true,
      flowActioned: true,
    });
    expect(result.plan?.versionBefore).toBe(before.version);
    expect(result.plan?.versionAfter).toBe(before.version + 1);
    expect(result.flow).toMatchObject({
      action: "close",
      id: "cov-12",
      state: "closed",
      existed: true,
    });
    expect(h.plan.reviseCalls).toHaveLength(1);

    const after = await h.planStore.read(DATE);
    expect(after.version).toBe(before.version + 1);
    expect(after.status).toBe("committed");
    expect(after.items[0]?.status).toBe("done");
    expect(after.notes.at(-1)).toBe("checkpoint cov-12 done: coverage exit 0");

    const record = await h.flowStore.read(SESSION, "cov-12");
    expect(record.state).toBe("closed");
    expect(record.reason).toBe("checkpoint cov-12 done: coverage exit 0");
    expect(auditActions(h.planRoot)).toEqual(["write", "revise"]);
  });

  it("skipped checkpoint: plan note + skipped item, flow close, no auto plan close", async () => {
    const h = setup();
    const before = await writePlan(h.planStore, [careItem("c1", "c1")]);

    const result = await runCheckpoint({
      planTool: h.plan.tool,
      flowTool: h.flow.tool,
      date: DATE,
      checkpointId: "c1",
      targetDate: DATE,
      executeBatch: async () => ({ status: "skipped", note: "user asleep" }),
      now: () => NOW,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("skipped");
    expect(result.flow).toMatchObject({
      action: "close",
      id: "c1",
      state: "closed",
      existed: false,
    });
    expect(h.plan.reviseCalls).toHaveLength(1);

    const after = await h.planStore.read(DATE);
    expect(after.version).toBe(before.version + 1);
    expect(after.status).toBe("committed");
    expect(after.items[0]?.status).toBe("skipped");
    expect(after.notes).toContain("checkpoint c1 skipped: user asleep");
    // 计划收口只属于 05:00 / 主会话：审计里不得出现 close。
    expect(auditActions(h.planRoot)).toEqual(["write", "revise"]);
  });

  it("missing plan: visible plan-missing result, no plan or flow write", async () => {
    const h = setup();
    let batchCalls = 0;

    const result = await runCheckpoint({
      planTool: h.plan.tool,
      flowTool: h.flow.tool,
      date: DATE,
      checkpointId: "cov-12",
      targetDate: TARGET_DATE,
      executeBatch: async () => {
        batchCalls += 1;
        return { status: "done" };
      },
      now: () => NOW,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("plan-missing");
    expect(result.steps).toEqual({
      planRead: false,
      batchExecuted: false,
      planRevised: false,
      flowActioned: false,
    });
    expect(result.message).toContain("plan-missing");
    expect(result.error).toMatchObject({ phase: "plan-read", name: "PlanNotFoundError" });
    expect(batchCalls).toBe(0);
    expect(h.plan.reviseCalls).toHaveLength(0);
    expect(h.flow.actions).toHaveLength(0);
    expect(await h.flowStore.list(SESSION)).toEqual([]);
    expect(existsSync(join(h.planRoot, "daily", DATE, `plan-${DATE}.json`))).toBe(false);
  });

  it("flow failure after plan revise: reports partial state, never revises twice", async () => {
    const h = setup();
    const before = await writePlan(h.planStore, [coverageItem("cov-16")]);
    const failingFlow: CheckpointFlowTool = {
      wait: h.flow.tool.wait,
      resume: h.flow.tool.resume,
      close: async () => {
        throw new Error("flow store offline");
      },
    };

    const result = await runCheckpoint({
      planTool: h.plan.tool,
      flowTool: failingFlow,
      date: DATE,
      checkpointId: "cov-16",
      targetDate: TARGET_DATE,
      executeBatch: async () => ({ status: "done", note: "coverage exit 0" }),
      now: () => NOW,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ phase: "flow", name: "Error" });
    expect(result.steps).toEqual({
      planRead: true,
      batchExecuted: true,
      planRevised: true,
      flowActioned: false,
    });
    expect(result.plan?.versionBefore).toBe(before.version);
    expect(result.plan?.versionAfter).toBe(before.version + 1);
    expect(h.plan.reviseCalls).toHaveLength(1);

    const after = await h.planStore.read(DATE);
    expect(after.version).toBe(before.version + 1);
    expect(after.items[0]?.status).toBe("done");
    expect(after.notes.at(-1)).toBe("checkpoint cov-16 done: coverage exit 0");
  });

  it("batch failure: no plan revise and no flow write", async () => {
    const h = setup();
    const before = await writePlan(h.planStore, [coverageItem("cov-20")]);

    const result = await runCheckpoint({
      planTool: h.plan.tool,
      flowTool: h.flow.tool,
      date: DATE,
      checkpointId: "cov-20",
      targetDate: TARGET_DATE,
      executeBatch: async () => {
        throw new Error("scheduler unavailable");
      },
      now: () => NOW,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ phase: "batch", name: "Error" });
    expect(result.steps).toEqual({
      planRead: true,
      batchExecuted: false,
      planRevised: false,
      flowActioned: false,
    });
    expect(result.plan).toBeNull();
    expect(h.plan.reviseCalls).toHaveLength(0);
    expect(h.flow.actions).toHaveLength(0);

    const after = await h.planStore.read(DATE);
    expect(after.version).toBe(before.version);
    expect(after.items[0]?.status).toBe("planned");
    expect(after.notes).toEqual(["initial"]);
    expect(auditActions(h.planRoot)).toEqual(["write"]);
  });

  it("partial checkpoint with follow-up: plan revised once, flow waits", async () => {
    const h = setup();
    const before = await writePlan(h.planStore, [coverageItem("cov-22")]);

    const result = await runCheckpoint({
      planTool: h.plan.tool,
      flowTool: h.flow.tool,
      date: DATE,
      checkpointId: "cov-22",
      targetDate: TARGET_DATE,
      executeBatch: async () => ({
        status: "partial",
        note: "half window missing",
        followUp: {
          waitingOn: "补设备同步",
          nextAt: "15m",
          closeCondition: "check_coverage exit 0",
        },
      }),
      now: () => NOW,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("waiting");
    expect(result.plan?.versionAfter).toBe(before.version + 1);
    expect(result.plan?.itemStatus).toBe("planned");
    expect(result.flow).toMatchObject({
      action: "wait",
      id: "cov-22",
      state: "waiting",
      existed: true,
    });
    expect(h.plan.reviseCalls).toHaveLength(1);

    const record = await h.flowStore.read(SESSION, "cov-22");
    expect(record.state).toBe("waiting");
    expect(record.waiting_on).toBe("补设备同步");
    expect(record.close_condition).toBe("check_coverage exit 0");
    expect(record.reason).toBe("checkpoint cov-22 partial: half window missing");
  });
});

/* ───────────────────────── 生产覆盖批次执行器（T09） ───────────────────────── */

interface VerifierSpy {
  readonly verifier: CoverageVerifier;
  readonly calls: string[];
}

function coverageVerifierSpy(
  status: CoverageVerifyStatus,
  summary = `${status} summary`,
): VerifierSpy {
  const calls: string[] = [];
  const result: CoverageVerifyResult = {
    ok: status === "pass",
    status,
    exitCode:
      status === "pass" ? 0 : status === "gap" ? 1 : status === "no_data" ? 2 : null,
    summary,
  };
  return {
    calls,
    verifier: {
      check: (date) => {
        calls.push(date);
        return Promise.resolve(result);
      },
      verify: (input) => {
        calls.push(input.date);
        return Promise.resolve(result);
      },
    },
  };
}

function batchContext(item: PlanItem = coverageItem("cov-12")): CheckpointBatchContext {
  return {
    date: DATE,
    checkpointId: item.checkpoint_id ?? item.id,
    targetDate: TARGET_DATE,
    item,
    planVersion: 1,
    at: NOW,
  };
}

describe("createCoverageBatchExecutor", () => {
  it("pass -> done", async () => {
    const spy = coverageVerifierSpy("pass", "缺口: 0s -> 通过");
    const execute = createCoverageBatchExecutor({ verifier: spy.verifier });

    const outcome = await execute(batchContext());

    expect(outcome).toEqual({
      status: "done",
      note: "coverage pass: 缺口: 0s -> 通过",
    });
    expect(spy.calls).toEqual([TARGET_DATE]);
  });

  it("gap -> partial with follow-up", async () => {
    const spy = coverageVerifierSpy("gap", "未覆盖 22:00~23:40");
    const execute = createCoverageBatchExecutor({ verifier: spy.verifier });

    const outcome = await execute(batchContext());

    expect(outcome).toEqual({
      status: "partial",
      note: "coverage gap: 未覆盖 22:00~23:40",
      followUp: {
        waitingOn: "coverage gap",
        nextAt: "30m",
        closeCondition: "check_coverage exit 0",
      },
    });
  });

  it("no_data -> blocked", async () => {
    const spy = coverageVerifierSpy("no_data", "原始数据不足");
    const execute = createCoverageBatchExecutor({ verifier: spy.verifier });

    const outcome = await execute(batchContext());

    expect(outcome).toEqual({
      status: "blocked",
      note: "coverage no_data: 原始数据不足",
    });
  });

  it("error -> blocked", async () => {
    const spy = coverageVerifierSpy("error", "check_coverage timeout after 30000ms");
    const execute = createCoverageBatchExecutor({ verifier: spy.verifier });

    const outcome = await execute(batchContext());

    expect(outcome).toEqual({
      status: "blocked",
      note: "coverage error: check_coverage timeout after 30000ms",
    });
  });

  it("prefers the item target_date over context targetDate", async () => {
    const spy = coverageVerifierSpy("pass");
    const execute = createCoverageBatchExecutor({ verifier: spy.verifier });
    const item: PlanItem = { ...coverageItem("cov-12"), target_date: "2026-10-26" };

    await execute(batchContext(item));

    expect(spy.calls).toEqual(["2026-10-26"]);
  });

  it("refreshes target_date from the plan when planTool is provided", async () => {
    const h = setup();
    await writePlan(h.planStore, [
      { ...coverageItem("cov-12"), target_date: "2026-10-26" },
    ]);
    const spy = coverageVerifierSpy("pass");
    const execute = createCoverageBatchExecutor({
      verifier: spy.verifier,
      planTool: h.plan.tool,
    });

    const outcome = await execute(batchContext());

    expect(outcome.status).toBe("done");
    expect(spy.calls).toEqual(["2026-10-26"]);
  });

  it("falls back to context targetDate when planTool read fails", async () => {
    const spy = coverageVerifierSpy("pass");
    const planTool: CheckpointPlanTool = {
      read: async () => {
        throw new Error("plan offline");
      },
      revise: async () => {
        throw new Error("unused");
      },
    };
    const execute = createCoverageBatchExecutor({
      verifier: spy.verifier,
      planTool,
    });

    const outcome = await execute(batchContext());

    expect(outcome.status).toBe("done");
    expect(spy.calls).toEqual([TARGET_DATE]);
  });

  it("gap outcome drives runCheckpoint to waiting with a wait flow", async () => {
    const h = setup();
    const before = await writePlan(h.planStore, [coverageItem("cov-12")]);
    const spy = coverageVerifierSpy("gap", "未覆盖 22:00~23:40");

    const result = await runCheckpoint({
      planTool: h.plan.tool,
      flowTool: h.flow.tool,
      date: DATE,
      checkpointId: "cov-12",
      targetDate: TARGET_DATE,
      executeBatch: createCoverageBatchExecutor({ verifier: spy.verifier }),
      now: () => NOW,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("waiting");
    expect(result.plan?.versionAfter).toBe(before.version + 1);
    expect(result.plan?.itemStatus).toBe("planned");
    expect(result.flow).toMatchObject({ action: "wait", state: "waiting" });

    const record = await h.flowStore.read(SESSION, "cov-12");
    expect(record.state).toBe("waiting");
    expect(record.waiting_on).toBe("coverage gap");
    expect(record.reason).toBe(
      "checkpoint cov-12 partial: coverage gap: 未覆盖 22:00~23:40",
    );
  });
});
