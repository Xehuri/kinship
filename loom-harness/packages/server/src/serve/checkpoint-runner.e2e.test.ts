/**
 * 检查点端到端验收（Todo 28）：真 plan / flow 工具面 + 真磁盘 store。
 *
 * 与 checkpoint-runner.test.ts 的分工：
 * - 单元测试直接包 store；本文件包的是真实 `createPlanTool` / `FlowTool`，
 *   因此同时覆盖工具参数解析、结果投影、类型化错误回灌；
 * - 根全部落在 mkdtemp，executeBatch 用假实现，不读 ai/data、不碰生产；
 * - 覆盖 close / wait / resume 三种 flow 动作，并钉住“检查点只 revise 一次、绝不自动收口计划”。
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  FlowContinuationConflictError,
  FlowContinuationNotFoundError,
  FlowTool,
  type FlowContinuation,
  type HookContext,
  type ToolExecResult,
} from "@axeuh/loom-core";

import { JsonFlowContinuationStore } from "../flow/json-flow-continuation-store.js";
import { JsonPlanStore } from "../plan/json-plan-store.js";
import {
  PlanNotFoundError,
  type PlanCoverage,
  type PlanDocument,
  type PlanItem,
  type PlanItemStatus,
} from "../plan/plan-store.js";
import { createPlanTool } from "./plan-tool.js";
import {
  runCheckpoint,
  type CheckpointFlowTool,
  type CheckpointPlanTool,
} from "./checkpoint-runner.js";

const DATE = "2026-10-28";
const TARGET_DATE = "2026-10-27";
const SESSION = "ses_checkpoint_e2e";
const NOW = Date.UTC(2026, 9, 28, 8, 0, 0);
const SIGNAL = new AbortController().signal;
const CTX = { sessionId: SESSION } as unknown as HookContext;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(out: ToolExecResult): string {
  return out.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function planOf(out: ToolExecResult, date: string): PlanDocument {
  if (out.isError === true) {
    const details = out.details as { readonly __plan?: unknown } | undefined;
    const payload = details?.__plan;
    const name = isRecord(payload) ? payload["error"] : undefined;
    if (name === "PlanNotFoundError") throw new PlanNotFoundError(date);
    throw new Error(textOf(out));
  }
  const details = out.details as { readonly __plan?: unknown } | undefined;
  const payload = details?.__plan;
  if (!isRecord(payload)) throw new Error("plan tool returned no __plan");
  return payload as unknown as PlanDocument;
}

function flowOf(out: ToolExecResult, id: string): FlowContinuation {
  const details = out.details as
    | {
        readonly __flow?: {
          readonly ok?: boolean;
          readonly error?: string;
          readonly continuation?: FlowContinuation;
        };
      }
    | undefined;
  const payload = details?.__flow;
  if (out.isError === true || payload?.ok !== true) {
    const name = payload?.error;
    if (name === "FlowContinuationNotFoundError") {
      throw new FlowContinuationNotFoundError(id);
    }
    if (name === "FlowContinuationConflictError") {
      throw new FlowContinuationConflictError(id, textOf(out));
    }
    throw new Error(textOf(out));
  }
  const continuation = payload.continuation;
  if (continuation === undefined) {
    throw new Error("flow tool returned no continuation");
  }
  return continuation;
}

interface Harness {
  readonly planRoot: string;
  readonly flowRoot: string;
  readonly planStore: JsonPlanStore;
  readonly flowStore: JsonFlowContinuationStore;
  readonly planTool: ReturnType<typeof createPlanTool>;
  readonly flowTool: ReturnType<typeof FlowTool>;
  readonly plan: CheckpointPlanTool;
  readonly flow: CheckpointFlowTool;
}

function setup(): Harness {
  const planRoot = mkdtempSync(join(tmpdir(), "checkpoint-e2e-plan-"));
  const flowRoot = mkdtempSync(join(tmpdir(), "checkpoint-e2e-flow-"));
  roots.push(planRoot, flowRoot);

  const planStore = new JsonPlanStore({ planRoot, now: () => NOW });
  const flowStore = new JsonFlowContinuationStore({
    stateRoot: flowRoot,
    now: () => NOW,
  });
  const planTool = createPlanTool({ store: planStore });
  const flowTool = FlowTool({ store: flowStore });

  const plan: CheckpointPlanTool = {
    read: async (date) => planOf(await planTool.execute({ action: "read", date }, CTX, SIGNAL), date),
    revise: async (date, expectedVersion, patchOrOps, reason) => {
      const args: Record<string, unknown> = {
        action: "revise",
        date,
        expected_version: expectedVersion,
        reason,
      };
      if (Array.isArray(patchOrOps)) {
        args["ops"] = patchOrOps;
      } else {
        args["patch"] = patchOrOps;
      }
      return planOf(await planTool.execute(args, CTX, SIGNAL), date);
    },
  };

  const flow: CheckpointFlowTool = {
    wait: async (input) => {
      const args: Record<string, unknown> = {
        action: "wait",
        id: input.id,
        waiting_on: input.waiting_on,
        next_at: input.next_at,
      };
      if (input.source !== undefined) args["source"] = input.source;
      if (input.close_condition !== undefined) {
        args["close_condition"] = input.close_condition;
      }
      if (input.reason !== undefined) args["reason"] = input.reason;
      return flowOf(await flowTool.execute(args, CTX, SIGNAL), input.id);
    },
    resume: async (input) => {
      const args: Record<string, unknown> = { action: "resume", id: input.id };
      if (input.reason !== undefined) args["reason"] = input.reason;
      return flowOf(await flowTool.execute(args, CTX, SIGNAL), input.id);
    },
    close: async (input) =>
      flowOf(
        await flowTool.execute(
          { action: "close", id: input.id, reason: input.reason },
          CTX,
          SIGNAL,
        ),
        input.id,
      ),
  };

  return {
    planRoot,
    flowRoot,
    planStore,
    flowStore,
    planTool,
    flowTool,
    plan,
    flow,
  };
}

function careItem(id: string): PlanItem {
  return {
    id,
    kind: "care",
    intent: "材料提交",
    status: "planned",
    window: "09:30~11:00",
    checkpoint_id: id,
    done_when: "材料提交成功",
  };
}

function coverageItem(id: string): PlanItem {
  return {
    id,
    kind: "coverage",
    intent: `${id} coverage`,
    status: "planned",
    target_date: TARGET_DATE,
    window: "22:00~00:00",
    checkpoint_id: id,
    done_when: "check_coverage exit 0",
  };
}

async function seedPlan(h: Harness, items: readonly PlanItem[]): Promise<PlanDocument> {
  return planOf(
    await h.planTool.execute(
      {
        action: "commit",
        date: DATE,
        items,
        coverage: COVERAGE,
        notes: ["initial"],
      },
      CTX,
      SIGNAL,
    ),
    DATE,
  );
}

function itemStatus(after: PlanDocument, id: string): PlanItemStatus | undefined {
  return after.items.find((item) => item.id === id)?.status;
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

function flowItemPath(flowRoot: string, id: string): string {
  return join(flowRoot, "session", SESSION, "flow", "items", `${id}.json`);
}

function readFlowFile(flowRoot: string, id: string): FlowContinuation {
  return JSON.parse(readFileSync(flowItemPath(flowRoot, id), "utf8")) as FlowContinuation;
}

function writeLegacySubject(flowRoot: string): { readonly path: string; readonly body: string } {
  const dir = join(flowRoot, "session", SESSION, "flow", "subjects");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "legacy.json");
  const body = `${JSON.stringify({ schema: 1, subject_id: "legacy", state: "active" })}\n`;
  writeFileSync(path, body, "utf8");
  return { path, body };
}

describe("checkpoint e2e（真 plan / flow 工具 + 真 store）", () => {
  it("done checkpoint: one plan revise, flow close on disk, plan stays committed", async () => {
    const h = setup();
    const legacy = writeLegacySubject(h.flowRoot);
    const before = await seedPlan(h, [careItem("c1")]);
    await h.flow.wait({
      id: "c1",
      source: { plan_date: DATE, checkpoint_id: "c1" },
      waiting_on: "data-check batch",
      next_at: "10m",
    });

    const result = await runCheckpoint({
      planTool: h.plan,
      flowTool: h.flow,
      date: DATE,
      checkpointId: "c1",
      targetDate: DATE,
      executeBatch: async () => ({ status: "done", note: "材料提交成功" }),
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
    expect(result.plan).toMatchObject({
      versionBefore: before.version,
      versionAfter: before.version + 1,
      itemStatus: "done",
    });
    expect(result.flow).toMatchObject({
      action: "close",
      id: "c1",
      state: "closed",
      existed: true,
    });

    const after = await h.planStore.read(DATE);
    expect(after.version).toBe(before.version + 1);
    expect(after.status).toBe("committed");
    expect(itemStatus(after, "c1")).toBe("done");
    expect(after.notes.at(-1)).toBe("checkpoint c1 done: 材料提交成功");

    const path = flowItemPath(h.flowRoot, "c1");
    expect(existsSync(path)).toBe(true);
    expect(readFlowFile(h.flowRoot, "c1")).toMatchObject({
      id: "c1",
      source: { plan_date: DATE, checkpoint_id: "c1" },
      state: "closed",
      waiting_on: null,
      next_at: null,
      reason: "checkpoint c1 done: 材料提交成功",
    });

    // 检查点不自动收口计划：审计里只有 write + 一次 revise，没有 close。
    expect(auditActions(h.planRoot)).toEqual(["write", "revise"]);
    // 旧 subjects 只读：新 store 不扫描、不改写。
    expect(readFileSync(legacy.path, "utf8")).toBe(legacy.body);
  });

  it("partial checkpoint with follow-up: one revise, flow wait at items/{id}.json", async () => {
    const h = setup();
    const before = await seedPlan(h, [coverageItem("cov-08")]);

    const result = await runCheckpoint({
      planTool: h.plan,
      flowTool: h.flow,
      date: DATE,
      checkpointId: "cov-08",
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
    expect(result.flow).toMatchObject({
      action: "wait",
      id: "cov-08",
      state: "waiting",
      existed: true,
    });
    expect(result.plan).toMatchObject({
      versionBefore: before.version,
      versionAfter: before.version + 1,
      itemStatus: "planned",
    });

    const after = await h.planStore.read(DATE);
    expect(after.version).toBe(before.version + 1);
    expect(after.status).toBe("committed");
    expect(itemStatus(after, "cov-08")).toBe("planned");

    const record = readFlowFile(h.flowRoot, "cov-08");
    expect(record).toMatchObject({
      state: "waiting",
      waiting_on: "补设备同步",
      next_at: NOW + 900_000,
      close_condition: "check_coverage exit 0",
    });
    expect(auditActions(h.planRoot)).toEqual(["write", "revise"]);
  });

  it("partial checkpoint without follow-up: one revise, flow resume active", async () => {
    const h = setup();
    const before = await seedPlan(h, [careItem("c2")]);
    await h.flow.wait({
      id: "c2",
      source: { plan_date: DATE, checkpoint_id: "c2" },
      waiting_on: "家人回复",
      next_at: "30m",
    });

    const result = await runCheckpoint({
      planTool: h.plan,
      flowTool: h.flow,
      date: DATE,
      checkpointId: "c2",
      targetDate: DATE,
      executeBatch: async () => ({ status: "partial", note: "回复还没到" }),
      now: () => NOW,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("resumed");
    expect(result.flow).toMatchObject({
      action: "resume",
      id: "c2",
      state: "active",
      existed: true,
    });
    expect(result.plan?.versionAfter).toBe(before.version + 1);

    const after = await h.planStore.read(DATE);
    expect(after.version).toBe(before.version + 1);
    expect(after.status).toBe("committed");
    expect(itemStatus(after, "c2")).toBe("planned");
    expect(readFlowFile(h.flowRoot, "c2")).toMatchObject({
      state: "active",
      waiting_on: null,
      next_at: null,
      reason: "checkpoint c2 partial: 回复还没到",
    });
    expect(auditActions(h.planRoot)).toEqual(["write", "revise"]);
  });
});
