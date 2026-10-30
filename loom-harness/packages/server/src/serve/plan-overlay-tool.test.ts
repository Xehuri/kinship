/**
 * plan 覆盖层工具（T07）验收：read/base/diff/revise/done/note/close 七个动作、
 * CAS 冲突折叠、done 的单次 overlay 更新 + 单行账本、verify/force 门、
 * closed 不可变，以及所有失败都以 isError 回灌而非抛出。
 *
 * 全部根落在 mkdtemp；母版用 T04 JsonMasterPlanStore 播种，工具直接包
 * T06 JsonPlanOverlayStore + PlanLedger，不读 ai/data、不碰生产。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { HookContext, ToolExecResult } from "@axeuh/loom-core";

import { JsonMasterPlanStore } from "../plan/json-master-plan-store.js";
import { JsonPlanOverlayStore } from "../plan/json-plan-overlay-store.js";
import type { MasterEntry, MasterPlanDocument } from "../plan/master-plan.js";
import { PlanLedger } from "../plan/plan-ledger.js";
import type { PlanCoverage } from "../plan/plan-store.js";
import {
  createPlanOverlayTool,
  type PlanBaseResult,
  type PlanCloseResult,
  type PlanCoverageVerifier,
  type PlanDiffResult,
  type PlanDoneResult,
  type PlanReadResult,
} from "./plan-overlay-tool.js";

const NOW = Date.UTC(2026, 9, 28, 4, 0, 0);
const DAY = "2026-10-28";
const YESTERDAY = "2026-10-27";
const SIGNAL = new AbortController().signal;
const CTX = { sessionId: "ses_plan_overlay_tool" } as unknown as HookContext;

const COVERAGE: PlanCoverage = {
  profile: "merged_7",
  checkpoints: ["cov-06"],
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

function payloadOf<T>(out: ToolExecResult): T {
  if (out.isError === true) {
    throw new Error(`plan tool failed: ${textOf(out)}`);
  }
  const details = out.details as { readonly __plan?: unknown } | undefined;
  const payload = details?.__plan;
  if (payload === undefined) throw new Error("plan tool returned no __plan payload");
  return payload as T;
}

function errorName(out: ToolExecResult): string {
  expect(out.isError).toBe(true);
  const details = out.details as { readonly __plan?: unknown } | undefined;
  const payload = details?.__plan;
  if (!isRecord(payload)) {
    throw new Error(`plan tool returned no error payload: ${textOf(out)}`);
  }
  const name = payload["error"];
  if (typeof name !== "string") {
    throw new Error(`plan tool error payload has no error name: ${textOf(out)}`);
  }
  return name;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function opKeys(ops: readonly unknown[]): readonly string[] {
  return ops.map((op) => {
    if (!isRecord(op)) return "unknown";
    if (typeof op["id"] === "string") return `${String(op["op"])}:${op["id"]}`;
    const item = op["item"];
    if (isRecord(item) && typeof item["id"] === "string") {
      return `${String(op["op"])}:${item["id"]}`;
    }
    return String(op["op"]);
  });
}

function masterEntry(overrides: Partial<MasterEntry> = {}): MasterEntry {
  return {
    id: "morning-review",
    kind: "fixed",
    title: "晨间复盘",
    enabled: true,
    action: "review.daily",
    instruction: "先看昨日复盘",
    schedule: { kind: "daily", at: "06:10" },
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function masterDoc(entries: readonly MasterEntry[] = [masterEntry()]): MasterPlanDocument {
  return {
    schema: 1,
    kind: "master-plan",
    timezone: "Asia/Shanghai",
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    entries,
  };
}

interface Harness {
  readonly stateRoot: string;
  readonly planRoot: string;
  readonly masterStore: JsonMasterPlanStore;
  readonly overlayStore: JsonPlanOverlayStore;
  readonly ledger: PlanLedger;
  readonly tool: ReturnType<typeof createPlanOverlayTool>;
}

async function setup(
  options: {
    readonly verifier?: PlanCoverageVerifier;
    readonly master?: MasterPlanDocument;
  } = {},
): Promise<Harness> {
  const stateRoot = mkdtempSync(join(tmpdir(), "plan-overlay-tool-"));
  roots.push(stateRoot);
  const planRoot = join(stateRoot, "data");
  const masterStore = new JsonMasterPlanStore({ planRoot, now: () => NOW });
  await masterStore.write(options.master ?? masterDoc(), null);
  const overlayStore = new JsonPlanOverlayStore({
    planRoot,
    master: masterStore,
    now: () => NOW,
  });
  const ledger = new PlanLedger({ planRoot, now: () => NOW });
  const tool = createPlanOverlayTool({
    overlayStore,
    master: masterStore,
    ledger,
    now: () => NOW,
    ...(options.verifier === undefined ? {} : { verifier: options.verifier }),
  });
  return { stateRoot, planRoot, masterStore, overlayStore, ledger, tool };
}

function masterHash(harness: Harness): string {
  return sha256(harness.masterStore.paths().json);
}

async function createOverlay(
  harness: Harness,
  date: string,
  ops: readonly unknown[],
): Promise<PlanDiffResult> {
  const out = await harness.tool.execute(
    { action: "diff", date, base_version: 1, ops, reason: "初始 diff", coverage: COVERAGE },
    CTX,
    SIGNAL,
  );
  return payloadOf<PlanDiffResult>(out);
}

describe("read / base", () => {
  it("read 无覆盖层时返回母版、null 覆盖层与空账本", async () => {
    const harness = await setup();
    const out = await harness.tool.execute({ action: "read", date: DAY }, CTX, SIGNAL);
    const read = payloadOf<PlanReadResult>(out);

    expect(read.date).toBe(DAY);
    expect(read.master.version).toBe(1);
    expect(read.master.entries.map((entry) => entry.id)).toEqual(["morning-review"]);
    expect(read.overlay).toBeNull();
    expect(read.effective).toBeNull();
    expect(read.leftovers).toEqual([]);
    expect(read.ledger_tail).toEqual([]);

    const text = textOf(out);
    expect(text.startsWith(`plan read ${DAY}`)).toBe(true);
    expect(text).toContain("entries ");
    expect(text.split("morning-review").length - 1).toBe(1);
    expect(text).not.toContain('"master":');
    expect(text.length).toBeLessThan(
      JSON.stringify(payloadOf<PlanReadResult>(out)).length * 0.7,
    );
  });

  it("base 物化母版条目，遗留只保留昨日未完成且不在今日计划的条目", async () => {
    const harness = await setup({
      master: masterDoc([
        masterEntry(),
        masterEntry({
          id: "daily-review",
          title: "每日复盘",
          action: "review.daily",
          schedule: { kind: "daily", at: "00:40" },
        }),
      ]),
    });
    await createOverlay(harness, YESTERDAY, [
      {
        op: "add",
        item: {
          id: "leftover-1",
          kind: "care",
          intent: "昨日未完成",
          status: "planned",
          done_when: "08:00 前已处理",
        },
      },
      {
        op: "add",
        item: {
          id: "skipped-1",
          kind: "care",
          intent: "昨日跳过",
          status: "planned",
          done_when: "08:00 前已处理",
        },
      },
      {
        op: "add",
        item: {
          id: "plan-build",
          kind: "note",
          intent: "计划生成",
          status: "planned",
          action: "plan.build",
        },
      },
      {
        op: "add",
        item: {
          id: "plan-review",
          kind: "review",
          intent: "计划复核",
          status: "planned",
          action: "plan.review",
        },
      },
    ]);
    const yesterdayDone = payloadOf<PlanDoneResult>(
      await harness.tool.execute(
        { action: "done", date: YESTERDAY, id: "morning-review", status: "done", evidence: "已完成" },
        CTX,
        SIGNAL,
      ),
    );
    expect(yesterdayDone.status).toBe("done");
    const yesterdaySkipped = payloadOf<PlanDoneResult>(
      await harness.tool.execute(
        { action: "done", date: YESTERDAY, id: "skipped-1", status: "skipped" },
        CTX,
        SIGNAL,
      ),
    );
    expect(yesterdaySkipped.status).toBe("skipped");

    const out = await harness.tool.execute({ action: "base", date: DAY }, CTX, SIGNAL);
    const base = payloadOf<PlanBaseResult>(out);
    expect(base.date).toBe(DAY);
    expect(base.master_version).toBe(1);
    expect(base.base_version).toBe(1);
    expect(base.items.map((entry) => entry.id)).toEqual(["morning-review", "daily-review"]);
    expect(base.leftovers.map((entry) => entry.id)).toEqual(["leftover-1"]);
    expect(base.leftovers[0]?.source_date).toBe(YESTERDAY);

    const text = textOf(out);
    expect(text.startsWith(`plan base ${DAY}`)).toBe(true);
    expect(text).toContain("items 2:");

    const read = payloadOf<PlanReadResult>(
      await harness.tool.execute({ action: "read", date: DAY }, CTX, SIGNAL),
    );
    expect(read.overlay).toBeNull();
    expect(read.leftovers.map((entry) => entry.id)).toEqual(["leftover-1"]);
  });

  it("include_instruction 默认隐藏 instruction 正文，true 时渲染", async () => {
    const harness = await setup();

    const without = await harness.tool.execute({ action: "read", date: DAY }, CTX, SIGNAL);
    expect(textOf(without)).not.toContain("instruction:");

    const withBodies = await harness.tool.execute(
      { action: "read", date: DAY, include_instruction: true },
      CTX,
      SIGNAL,
    );
    expect(textOf(withBodies)).toContain("instruction: 先看昨日复盘");
  });

  it("include_instruction 类型非法时 isError 且报字段名", async () => {
    const harness = await setup();

    const out = await harness.tool.execute(
      { action: "read", date: DAY, include_instruction: 42 },
      CTX,
      SIGNAL,
    );

    expect(out.isError).toBe(true);
    expect(errorName(out)).toBe("PlanOverlayValidationError");
    expect(textOf(out)).toContain("include_instruction");
  });
});

describe("read/base 条目过滤", () => {
  function filterMaster(): MasterPlanDocument {
    return masterDoc([
      masterEntry(),
      masterEntry({
        id: "coverage-06",
        kind: "anchor",
        title: "06 点覆盖",
        action: "coverage.run",
        schedule: { kind: "daily", at: "06:00" },
      }),
    ]);
  }

  async function filterHarness(): Promise<Harness> {
    const harness = await setup({ master: filterMaster() });
    await createOverlay(harness, DAY, [
      {
        op: "add",
        item: {
          id: "walk",
          kind: "care",
          intent: "散步",
          status: "planned",
          done_when: "08:00 前已处理",
        },
      },
    ]);
    await harness.tool.execute(
      { action: "done", date: DAY, id: "morning-review", status: "done" },
      CTX,
      SIGNAL,
    );
    return harness;
  }

  it("read status 只收窄文本，details.__plan.effective.entries 保持完整", async () => {
    const harness = await filterHarness();
    const out = await harness.tool.execute(
      { action: "read", date: DAY, status: "planned" },
      CTX,
      SIGNAL,
    );
    const read = payloadOf<PlanReadResult>(out);
    const text = textOf(out);

    expect(text).toContain("filter=status=planned");
    expect(text).toContain("entries 2/3");
    expect(text).toContain("coverage-06");
    expect(text).toContain("walk");
    expect(text).not.toContain("fixed morning-review");
    expect(read.effective?.entries).toHaveLength(3);
  });

  it("read 接受 status 数组与 kind 数组", async () => {
    const harness = await filterHarness();

    const statuses = await harness.tool.execute(
      { action: "read", date: DAY, status: ["planned", "blocked"] },
      CTX,
      SIGNAL,
    );
    const statusText = textOf(statuses);
    expect(statusText).toContain("filter=status=planned|blocked");
    expect(statusText).toContain("entries 2/3");
    expect(statusText).not.toContain("fixed morning-review");

    const kinds = await harness.tool.execute(
      { action: "read", date: DAY, kind: ["care"] },
      CTX,
      SIGNAL,
    );
    const kindText = textOf(kinds);
    expect(kindText).toContain("filter=kind=care");
    expect(kindText).toContain("entries 1/3");
    expect(kindText).toContain("walk");
    expect(kindText).not.toContain("coverage-06");
  });

  it("read kind=anchor 匹配母版锚点条目", async () => {
    const harness = await filterHarness();
    const out = await harness.tool.execute(
      { action: "read", date: DAY, kind: "anchor" },
      CTX,
      SIGNAL,
    );
    const text = textOf(out);

    expect(text).toContain("filter=kind=anchor");
    expect(text).toContain("anchor coverage-06");
    expect(text).not.toContain("walk");
    expect(payloadOf<PlanReadResult>(out).effective?.entries).toHaveLength(3);
  });

  it("base status/kind 只收窄文本，details.__plan.items 保持完整", async () => {
    const harness = await setup({ master: filterMaster() });

    const byKind = await harness.tool.execute(
      { action: "base", date: DAY, kind: ["anchor"] },
      CTX,
      SIGNAL,
    );
    const kindBase = payloadOf<PlanBaseResult>(byKind);
    const kindText = textOf(byKind);
    expect(kindBase.items).toHaveLength(2);
    expect(kindText).toContain("filter=kind=anchor");
    expect(kindText).toContain("items=1/2");
    expect(kindText).toContain("anchor coverage-06");
    expect(kindText).not.toContain("fixed morning-review");

    const byStatus = await harness.tool.execute(
      { action: "base", date: DAY, status: "planned" },
      CTX,
      SIGNAL,
    );
    const statusText = textOf(byStatus);
    expect(statusText).toContain("filter=status=planned");
    expect(statusText).toContain("items=2/2");
    expect(payloadOf<PlanBaseResult>(byStatus).items).toHaveLength(2);
  });

  it("过滤器非法值或空数组返回 PlanOverlayValidationError", async () => {
    const harness = await setup();
    const cases: readonly {
      readonly args: Record<string, unknown>;
      readonly field: string;
    }[] = [
      { args: { action: "read", date: DAY, status: [] }, field: "status" },
      { args: { action: "read", date: DAY, status: "finished" }, field: "status" },
      { args: { action: "base", date: DAY, status: 42 }, field: "status" },
      { args: { action: "read", date: DAY, kind: [] }, field: "kind" },
      { args: { action: "read", date: DAY, kind: "fixed" }, field: "kind" },
      { args: { action: "base", date: DAY, kind: 42 }, field: "kind" },
    ];

    for (const item of cases) {
      const out = await harness.tool.execute(item.args, CTX, SIGNAL);
      expect(out.isError, JSON.stringify(item.args)).toBe(true);
      expect(errorName(out), JSON.stringify(item.args)).toBe("PlanOverlayValidationError");
      expect(textOf(out), JSON.stringify(item.args)).toContain(item.field);
    }
  });

  it("非 read/base 动作忽略 status/kind 过滤器参数", async () => {
    const harness = await setup();
    await createOverlay(harness, DAY, []);

    const out = await harness.tool.execute(
      { action: "note", date: DAY, text: "只记笔记", status: "finished", kind: "bogus" },
      CTX,
      SIGNAL,
    );
    expect(payloadOf<PlanDiffResult>(out).overlay.notes).toEqual(["只记笔记"]);
  });
});

describe("diff CAS", () => {
  it("base_version 与母版不一致时 isError，不写覆盖层与账本", async () => {
    const harness = await setup();
    const before = masterHash(harness);
    const paths = harness.overlayStore.paths(DAY);

    const out = await harness.tool.execute(
      { action: "diff", date: DAY, base_version: 2, ops: [], reason: "基线过期" },
      CTX,
      SIGNAL,
    );

    expect(errorName(out)).toBe("OverlayBaseStaleError");
    expect(existsSync(paths.overlay)).toBe(false);
    expect(existsSync(paths.markdown)).toBe(false);
    expect(await harness.ledger.read(DAY)).toEqual([]);
    expect(masterHash(harness)).toBe(before);
  });

  it("diff 成功创建 committed 覆盖层、写一行 diff 账本，母版字节不变", async () => {
    const harness = await setup();
    const before = masterHash(harness);
    const paths = harness.overlayStore.paths(DAY);

    const result = await createOverlay(harness, DAY, [
      { op: "update", id: "morning-review", patch: { at: "06:30" } },
    ]);

    expect(result.overlay.status).toBe("committed");
    expect(result.overlay.version).toBe(2);
    expect(result.overlay.base_version).toBe(1);
    expect(result.overlay.coverage).toEqual(COVERAGE);
    expect(result.effective.entries.find((entry) => entry.id === "morning-review")?.at).toBe(
      "06:30",
    );
    expect(result.ledger.source).toBe("plan");
    expect(result.ledger.event).toBe("diff");
    expect(result.ledger.version).toBe(2);
    expect((await harness.ledger.read(DAY)).map((row) => row.event)).toEqual(["diff"]);
    expect(masterHash(harness)).toBe(before);
    expect((await harness.masterStore.read()).version).toBe(1);

    const persisted = JSON.parse(readFileSync(paths.overlay, "utf8")) as {
      readonly version: number;
      readonly status: string;
    };
    expect(persisted.version).toBe(2);
    expect(persisted.status).toBe("committed");

    const read = payloadOf<PlanReadResult>(
      await harness.tool.execute({ action: "read", date: DAY }, CTX, SIGNAL),
    );
    expect(read.overlay?.version).toBe(2);
    expect(read.ledger_tail.map((row) => row.event)).toEqual(["diff"]);
  });

  it("expected_version 冲突 isError，覆盖层、账本与母版均不变", async () => {
    const harness = await setup();
    await createOverlay(harness, DAY, [
      { op: "update", id: "morning-review", patch: { at: "06:30" } },
    ]);
    const versionBefore = (await harness.overlayStore.read(DAY)).version;
    const before = masterHash(harness);

    const out = await harness.tool.execute(
      {
        action: "diff",
        date: DAY,
        base_version: 1,
        expected_version: 99,
        ops: [{ op: "update", id: "morning-review", patch: { at: "07:00" } }],
        reason: "版本冲突",
      },
      CTX,
      SIGNAL,
    );

    expect(errorName(out)).toBe("PlanOverlayConflictError");
    expect((await harness.overlayStore.read(DAY)).version).toBe(versionBefore);
    expect((await harness.ledger.read(DAY)).length).toBe(1);
    expect(masterHash(harness)).toBe(before);
  });

  it("已有覆盖层时 diff 按 expected_version 修订并再次提交", async () => {
    const harness = await setup();
    const first = await createOverlay(harness, DAY, [
      { op: "update", id: "morning-review", patch: { at: "06:30" } },
    ]);

    const out = await harness.tool.execute(
      {
        action: "diff",
        date: DAY,
        base_version: 1,
        expected_version: first.overlay.version,
        ops: [{ op: "update", id: "morning-review", patch: { at: "07:00" } }],
        reason: "第二次 diff",
      },
      CTX,
      SIGNAL,
    );
    const second = payloadOf<PlanDiffResult>(out);

    expect(second.overlay.version).toBe(4);
    expect(second.overlay.status).toBe("committed");
    expect(second.effective.entries.find((entry) => entry.id === "morning-review")?.at).toBe(
      "07:00",
    );
    expect((await harness.ledger.read(DAY)).map((row) => row.event)).toEqual(["diff", "diff"]);

    const text = textOf(out);
    expect(text.startsWith(`plan diff ${DAY}`)).toBe(true);
    expect(text).toContain("coverage ");
    expect(text).toContain("entries ");
  });

  it("已有覆盖层时 diff 只传 user_intent 保留既有 ops", async () => {
    const harness = await setup();
    const first = await createOverlay(harness, DAY, [
      { op: "update", id: "morning-review", patch: { at: "06:30" } },
      {
        op: "add",
        item: {
          id: "walk",
          kind: "care",
          intent: "散步",
          status: "planned",
          done_when: "08:00 前已处理",
        },
      },
    ]);
    const before = opKeys(first.overlay.ops);

    const out = await harness.tool.execute(
      {
        action: "diff",
        date: DAY,
        base_version: 1,
        expected_version: first.overlay.version,
        reason: "只更新意图",
        user_intent: "第二版意图",
      },
      CTX,
      SIGNAL,
    );
    const second = payloadOf<PlanDiffResult>(out);

    expect(second.overlay.user_intent).toBe("第二版意图");
    expect(second.overlay.ops).toHaveLength(first.overlay.ops.length);
    expect(opKeys(second.overlay.ops)).toEqual(before);
    expect(second.effective.entries.find((entry) => entry.id === "morning-review")?.at).toBe(
      "06:30",
    );
    expect(second.effective.entries.find((entry) => entry.id === "walk")?.status).toBe(
      "planned",
    );
  });

  it("diff 创建路径缺 ops 时仍 isError 且不写覆盖层", async () => {
    const harness = await setup();
    const paths = harness.overlayStore.paths(DAY);

    const out = await harness.tool.execute(
      {
        action: "diff",
        date: DAY,
        base_version: 1,
        reason: "缺 ops 创建",
        user_intent: "只有意图",
      },
      CTX,
      SIGNAL,
    );

    expect(out.isError).toBe(true);
    expect(errorName(out)).toBe("PlanOverlayValidationError");
    expect(textOf(out)).toContain("ops");
    expect(existsSync(paths.overlay)).toBe(false);
    expect(await harness.ledger.read(DAY)).toEqual([]);
  });

  it("已有覆盖层时 diff 无任何变更字段 isError，不做空版本推进", async () => {
    const harness = await setup();
    const first = await createOverlay(harness, DAY, []);
    const overlayBefore = readFileSync(harness.overlayStore.paths(DAY).overlay, "utf8");

    const out = await harness.tool.execute(
      {
        action: "diff",
        date: DAY,
        base_version: 1,
        expected_version: first.overlay.version,
        reason: "空修订",
      },
      CTX,
      SIGNAL,
    );

    expect(out.isError).toBe(true);
    expect(errorName(out)).toBe("PlanOverlayValidationError");
    expect(textOf(out)).toContain("至少提供 ops/user_intent/notes/coverage 之一");
    expect(readFileSync(harness.overlayStore.paths(DAY).overlay, "utf8")).toBe(overlayBefore);
    expect((await harness.ledger.read(DAY)).length).toBe(1);
  });
});

describe("user_intent", () => {
  it("diff 创建时持久化 user_intent，read 文本与 details.__plan 都可见", async () => {
    const harness = await setup();
    const created = payloadOf<PlanDiffResult>(
      await harness.tool.execute(
        {
          action: "diff",
          date: DAY,
          base_version: 1,
          ops: [],
          reason: "带意图创建",
          coverage: COVERAGE,
          user_intent: "今天专注复习",
        },
        CTX,
        SIGNAL,
      ),
    );
    expect(created.overlay.user_intent).toBe("今天专注复习");

    const out = await harness.tool.execute({ action: "read", date: DAY }, CTX, SIGNAL);
    const read = payloadOf<PlanReadResult>(out);
    expect(read.overlay?.user_intent).toBe("今天专注复习");
    expect(read.effective?.user_intent).toBe("今天专注复习");
    expect(textOf(out)).toContain("user_intent: 今天专注复习");
  });

  it("diff 修订与 revise 动作替换 user_intent，done/note 保留", async () => {
    const harness = await setup();
    const first = payloadOf<PlanDiffResult>(
      await harness.tool.execute(
        {
          action: "diff",
          date: DAY,
          base_version: 1,
          ops: [],
          reason: "首次",
          coverage: COVERAGE,
          user_intent: "第一版意图",
        },
        CTX,
        SIGNAL,
      ),
    );
    expect(first.overlay.user_intent).toBe("第一版意图");

    const second = payloadOf<PlanDiffResult>(
      await harness.tool.execute(
        {
          action: "diff",
          date: DAY,
          base_version: 1,
          expected_version: first.overlay.version,
          ops: [],
          reason: "diff 修订",
          user_intent: "第二版意图",
        },
        CTX,
        SIGNAL,
      ),
    );
    expect(second.overlay.user_intent).toBe("第二版意图");

    const third = payloadOf<PlanDiffResult>(
      await harness.tool.execute(
        {
          action: "revise",
          date: DAY,
          expected_version: second.overlay.version,
          ops: [],
          reason: "revise 修订",
          user_intent: "第三版意图",
        },
        CTX,
        SIGNAL,
      ),
    );
    expect(third.overlay.user_intent).toBe("第三版意图");

    const done = payloadOf<PlanDoneResult>(
      await harness.tool.execute(
        { action: "done", date: DAY, id: "morning-review", status: "blocked" },
        CTX,
        SIGNAL,
      ),
    );
    expect(done.overlay.user_intent).toBe("第三版意图");

    const noted = payloadOf<PlanDiffResult>(
      await harness.tool.execute(
        { action: "note", date: DAY, text: "收尾" },
        CTX,
        SIGNAL,
      ),
    );
    expect(noted.overlay.user_intent).toBe("第三版意图");
  });

  it("非法 user_intent 返回 PlanOverlayValidationError，不写覆盖层", async () => {
    const harness = await setup();
    const paths = harness.overlayStore.paths(DAY);

    for (const value of ["", 42]) {
      const out = await harness.tool.execute(
        {
          action: "diff",
          date: DAY,
          base_version: 1,
          ops: [],
          reason: "非法意图",
          user_intent: value,
        },
        CTX,
        SIGNAL,
      );
      expect(out.isError, String(value)).toBe(true);
      expect(errorName(out), String(value)).toBe("PlanOverlayValidationError");
      expect(textOf(out), String(value)).toContain("user_intent");
      expect(existsSync(paths.overlay)).toBe(false);
    }
  });

  it("已有覆盖层时修订传入非法 user_intent 不落盘", async () => {
    const harness = await setup();
    const first = await createOverlay(harness, DAY, []);
    const overlayPath = harness.overlayStore.paths(DAY).overlay;
    const before = readFileSync(overlayPath, "utf8");

    const out = await harness.tool.execute(
      {
        action: "revise",
        date: DAY,
        expected_version: first.overlay.version,
        ops: [],
        reason: "非法意图",
        user_intent: "",
      },
      CTX,
      SIGNAL,
    );

    expect(errorName(out)).toBe("PlanOverlayValidationError");
    expect(textOf(out)).toContain("user_intent");
    expect(readFileSync(overlayPath, "utf8")).toBe(before);
  });
});

describe("revise", () => {
  it("revise 做版本 CAS 修订，不重新核对 base_version", async () => {
    const harness = await setup();
    await createOverlay(harness, DAY, [
      { op: "update", id: "morning-review", patch: { at: "06:30" } },
    ]);
    // 母版推进到 v2，覆盖层仍停在 base_version=1。
    await harness.masterStore.write(masterDoc(), 1);
    expect((await harness.masterStore.read()).version).toBe(2);
    const before = masterHash(harness);

    const revised = payloadOf<PlanDiffResult>(
      await harness.tool.execute(
        {
          action: "revise",
          date: DAY,
          expected_version: 2,
          ops: [{ op: "update", id: "morning-review", patch: { at: "07:10" } }],
          reason: "母版漂移后的修订",
        },
        CTX,
        SIGNAL,
      ),
    );

    expect(revised.overlay.version).toBe(3);
    expect(revised.overlay.base_version).toBe(1);
    expect(revised.overlay.status).toBe("committed");
    expect(revised.effective.warnings).toContain("base_stale:1!=2");
    expect(revised.effective.entries.find((entry) => entry.id === "morning-review")?.at).toBe(
      "07:10",
    );
    expect(revised.ledger.event).toBe("revise");
    expect(masterHash(harness)).toBe(before);
  });

  it("revise 版本冲突 isError 且不落盘", async () => {
    const harness = await setup();
    await createOverlay(harness, DAY, [
      { op: "update", id: "morning-review", patch: { at: "06:30" } },
    ]);
    const beforeOverlay = readFileSync(harness.overlayStore.paths(DAY).overlay, "utf8");

    const out = await harness.tool.execute(
      {
        action: "revise",
        date: DAY,
        expected_version: 99,
        ops: [{ op: "update", id: "morning-review", patch: { at: "08:00" } }],
        reason: "版本冲突",
      },
      CTX,
      SIGNAL,
    );

    expect(errorName(out)).toBe("PlanOverlayConflictError");
    expect(readFileSync(harness.overlayStore.paths(DAY).overlay, "utf8")).toBe(beforeOverlay);
    expect((await harness.ledger.read(DAY)).length).toBe(1);
  });

  it("revise 只传 user_intent 时替换意图并保留既有 ops", async () => {
    const harness = await setup();
    const first = await createOverlay(harness, DAY, [
      { op: "update", id: "morning-review", patch: { at: "06:30" } },
      {
        op: "add",
        item: {
          id: "walk",
          kind: "care",
          intent: "散步",
          status: "planned",
          done_when: "08:00 前已处理",
        },
      },
    ]);
    const before = opKeys(first.overlay.ops);

    const out = await harness.tool.execute(
      {
        action: "revise",
        date: DAY,
        expected_version: first.overlay.version,
        reason: "只改意图",
        user_intent: "下午去图书馆",
      },
      CTX,
      SIGNAL,
    );
    const revised = payloadOf<PlanDiffResult>(out);

    expect(revised.overlay.user_intent).toBe("下午去图书馆");
    expect(revised.overlay.ops).toHaveLength(first.overlay.ops.length);
    expect(opKeys(revised.overlay.ops)).toEqual(before);
    expect(revised.effective.entries.find((entry) => entry.id === "morning-review")?.at).toBe(
      "06:30",
    );
    expect(revised.effective.entries.find((entry) => entry.id === "walk")?.status).toBe(
      "planned",
    );
    expect(revised.ledger.event).toBe("revise");
  });

  it("revise 既无 ops 也无 user_intent 时 isError，版本不推进", async () => {
    const harness = await setup();
    const first = await createOverlay(harness, DAY, []);
    const overlayPath = harness.overlayStore.paths(DAY).overlay;
    const before = readFileSync(overlayPath, "utf8");

    const out = await harness.tool.execute(
      {
        action: "revise",
        date: DAY,
        expected_version: first.overlay.version,
        reason: "空修订",
      },
      CTX,
      SIGNAL,
    );

    expect(out.isError).toBe(true);
    expect(errorName(out)).toBe("PlanOverlayValidationError");
    expect(textOf(out)).toContain("至少需要一个修改字段");
    expect(readFileSync(overlayPath, "utf8")).toBe(before);
    expect((await harness.overlayStore.read(DAY)).version).toBe(first.overlay.version);
    expect((await harness.ledger.read(DAY)).length).toBe(1);
  });
});

describe("done", () => {
  it("done/blocked/skipped/carried 各写一次覆盖层更新与一行账本，母版不变", async () => {
    const harness = await setup();
    await createOverlay(harness, DAY, [
      { op: "update", id: "morning-review", patch: { at: "06:30" } },
    ]);
    const before = masterHash(harness);
    const statuses = ["done", "blocked", "skipped", "carried"] as const;
    let expectedVersion = 2;

    for (const status of statuses) {
      const args: Record<string, unknown> = {
        action: "done",
        date: DAY,
        id: "morning-review",
        status,
      };
      if (status === "done") args["evidence"] = "打卡截图";
      const out = await harness.tool.execute(args, CTX, SIGNAL);
      const result = payloadOf<PlanDoneResult>(out);

      expect(result.status).toBe(status);
      expect(result.overlay.version).toBe(expectedVersion + 1);
      expectedVersion = result.overlay.version;
      expect(result.effective.entries.find((entry) => entry.id === "morning-review")?.status).toBe(
        status,
      );
      expect(result.ledger.event).toBe("done");
      expect(result.ledger.source).toBe("plan");
      expect(result.ledger.entry_id).toBe("morning-review");
      expect(result.ledger.status).toBe(status);
      expect(
        result.overlay.ops.filter(
          (op) => op.op === "update" && op.id === "morning-review",
        ),
      ).toHaveLength(1);

      if (status === "done") {
        const text = textOf(out);
        expect(text.startsWith(`plan done ${DAY} id=morning-review`)).toBe(true);
        expect(text).toContain("entry: [");
        expect(text).toContain("entries ");
      }
    }

    const rows = await harness.ledger.read(DAY);
    expect(rows.map((row) => row.event)).toEqual(["diff", "done", "done", "done", "done"]);
    expect(rows.slice(1).map((row) => row.status)).toEqual([...statuses]);
    expect(masterHash(harness)).toBe(before);
  });

  it("done verify=coverage 无校验器时 isError 且不写", async () => {
    const harness = await setup();
    await createOverlay(harness, DAY, [
      { op: "update", id: "morning-review", patch: { at: "06:30" } },
    ]);
    const overlayPath = harness.overlayStore.paths(DAY).overlay;
    const beforeOverlay = readFileSync(overlayPath, "utf8");
    const beforeMaster = masterHash(harness);

    const out = await harness.tool.execute(
      { action: "done", date: DAY, id: "morning-review", status: "done", verify: "coverage" },
      CTX,
      SIGNAL,
    );

    expect(errorName(out)).toBe("PlanCoverageVerifierUnavailableError");
    expect(readFileSync(overlayPath, "utf8")).toBe(beforeOverlay);
    expect((await harness.overlayStore.read(DAY)).version).toBe(2);
    expect((await harness.ledger.read(DAY)).length).toBe(1);
    expect(masterHash(harness)).toBe(beforeMaster);
  });

  it("verify=coverage 经注入校验器：通过写 done，否决 isError 且不写", async () => {
    const harness = await setup({
      verifier: { verify: (input) => ({ ok: input.status === "done" }) },
    });
    await createOverlay(harness, DAY, [
      { op: "update", id: "morning-review", patch: { at: "06:30" } },
    ]);

    const passed = payloadOf<PlanDoneResult>(
      await harness.tool.execute(
        {
          action: "done",
          date: DAY,
          id: "morning-review",
          status: "done",
          verify: "coverage",
          evidence: "打卡截图",
        },
        CTX,
        SIGNAL,
      ),
    );
    expect(passed.status).toBe("done");
    expect(passed.ledger.event).toBe("done");
    expect((await harness.ledger.read(DAY)).length).toBe(2);

    const failed = await harness.tool.execute(
      { action: "done", date: DAY, id: "morning-review", status: "blocked", verify: "coverage" },
      CTX,
      SIGNAL,
    );
    expect(errorName(failed)).toBe("PlanDoneVerificationError");
    expect((await harness.overlayStore.read(DAY)).version).toBe(passed.overlay.version);
    expect((await harness.ledger.read(DAY)).length).toBe(2);
  });

  it("force:true 缺 evidence 时 isError 不写；带 evidence 写 override 行并跳过校验器", async () => {
    const harness = await setup();
    await createOverlay(harness, DAY, [
      { op: "update", id: "morning-review", patch: { at: "06:30" } },
    ]);

    const missing = await harness.tool.execute(
      {
        action: "done",
        date: DAY,
        id: "morning-review",
        status: "done",
        verify: "coverage",
        force: true,
      },
      CTX,
      SIGNAL,
    );
    expect(errorName(missing)).toBe("PlanOverlayValidationError");
    expect((await harness.overlayStore.read(DAY)).version).toBe(2);
    expect((await harness.ledger.read(DAY)).length).toBe(1);

    const forced = payloadOf<PlanDoneResult>(
      await harness.tool.execute(
        {
          action: "done",
          date: DAY,
          id: "morning-review",
          status: "done",
          verify: "coverage",
          force: true,
          evidence: "人工核对截图",
        },
        CTX,
        SIGNAL,
      ),
    );
    expect(forced.status).toBe("done");
    expect(forced.overlay.version).toBe(3);
    expect(forced.ledger.event).toBe("override");
    expect(forced.ledger.reason).toBe("人工核对截图");
    expect(forced.ledger.status).toBe("done");
    expect((await harness.ledger.read(DAY)).map((row) => row.event)).toEqual([
      "diff",
      "override",
    ]);
  });

  it("done status=planned 仍按 done 状态校验拒绝", async () => {
    const harness = await setup();
    await createOverlay(harness, DAY, []);

    const out = await harness.tool.execute(
      { action: "done", date: DAY, id: "morning-review", status: "planned" },
      CTX,
      SIGNAL,
    );

    expect(errorName(out)).toBe("PlanOverlayValidationError");
    expect(textOf(out)).toContain("status");
    expect((await harness.overlayStore.read(DAY)).version).toBe(2);
  });
});

describe("note / close", () => {
  it("note 追加笔记并只写一行 note 账本", async () => {
    const harness = await setup();
    await createOverlay(harness, DAY, []);
    const beforeMaster = masterHash(harness);

    const out = await harness.tool.execute(
      { action: "note", date: DAY, text: "午后补一条" },
      CTX,
      SIGNAL,
    );
    const noted = payloadOf<PlanDiffResult>(out);

    expect(noted.overlay.notes).toEqual(["午后补一条"]);
    expect(noted.overlay.version).toBe(3);
    expect(noted.ledger.event).toBe("note");
    expect(noted.ledger.reason).toBe("午后补一条");
    expect((await harness.ledger.read(DAY)).length).toBe(2);
    expect(masterHash(harness)).toBe(beforeMaster);

    const text = textOf(out);
    expect(text.startsWith(`plan note ${DAY}`)).toBe(true);
    expect(text).toContain("latest note: 午后补一条");
    expect(text).toContain("entries ");
  });

  it("close 把未完成条目转 carried，之后所有写入 isError 且 closed 覆盖层不可变", async () => {
    const harness = await setup();
    await createOverlay(harness, DAY, [
      { op: "update", id: "morning-review", patch: { at: "06:30" } },
      {
        op: "add",
        item: {
          id: "walk",
          kind: "care",
          intent: "散步",
          status: "planned",
          done_when: "08:00 前已处理",
        },
      },
    ]);
    await harness.tool.execute(
      { action: "done", date: DAY, id: "morning-review", status: "done" },
      CTX,
      SIGNAL,
    );
    const beforeMaster = masterHash(harness);

    const out = await harness.tool.execute(
      { action: "close", date: DAY, expected_version: 3, summary: "当日收口" },
      CTX,
      SIGNAL,
    );
    const closed = payloadOf<PlanCloseResult>(out);

    expect(closed.overlay.status).toBe("closed");
    expect(closed.overlay.version).toBe(5);
    expect(closed.carried.map((entry) => entry.id)).toEqual(["walk"]);
    expect(closed.carried[0]?.status).toBe("carried");
    expect(
      closed.effective.entries.find((entry) => entry.id === "walk")?.status,
    ).toBe("carried");
    expect(
      closed.effective.entries.find((entry) => entry.id === "morning-review")?.status,
    ).toBe("done");
    expect(closed.ledger.event).toBe("close");
    expect(closed.ledger.version).toBe(5);
    expect(masterHash(harness)).toBe(beforeMaster);

    const text = textOf(out);
    expect(text.startsWith(`plan close ${DAY}`)).toBe(true);
    expect(text).toContain("summary: 当日收口");
    expect(text).toContain("carried 1:");

    const attempts: readonly Record<string, unknown>[] = [
      { action: "diff", date: DAY, base_version: 1, ops: [], reason: "closed 后 diff" },
      {
        action: "revise",
        date: DAY,
        expected_version: 5,
        ops: [{ op: "update", id: "morning-review", patch: { at: "08:00" } }],
        reason: "closed 后 revise",
      },
      { action: "done", date: DAY, id: "morning-review", status: "done" },
      { action: "note", date: DAY, text: "closed 后 note" },
      { action: "close", date: DAY, expected_version: 5, summary: "再次收口" },
    ];
    for (const args of attempts) {
      const out = await harness.tool.execute(args, CTX, SIGNAL);
      expect(errorName(out)).toBe("PlanOverlayClosedError");
    }

    expect((await harness.overlayStore.read(DAY)).version).toBe(5);
    expect((await harness.ledger.read(DAY)).map((row) => row.event)).toEqual([
      "diff",
      "done",
      "close",
    ]);
  });
});

describe("care done_when 校验", () => {
  it("diff 新增 care 缺 done_when 或不可核验时 isError，不写覆盖层", async () => {
    const harness = await setup();
    const paths = harness.overlayStore.paths(DAY);
    const items: readonly Record<string, unknown>[] = [
      { id: "care-1", kind: "care", intent: "吃药", status: "planned" },
      { id: "care-2", kind: "care", intent: "吃药", status: "planned", done_when: "记得吃药" },
    ];

    for (const item of items) {
      const out = await harness.tool.execute(
        {
          action: "diff",
          date: DAY,
          base_version: 1,
          ops: [{ op: "add", item }],
          reason: "care 校验",
        },
        CTX,
        SIGNAL,
      );
      expect(errorName(out), String(item["id"])).toBe("PlanOverlayValidationError");
      expect(textOf(out), String(item["id"])).toContain("done_when");
      expect(textOf(out), String(item["id"])).toContain("kind=note");
      expect(existsSync(paths.overlay), String(item["id"])).toBe(false);
    }
    expect(await harness.ledger.read(DAY)).toEqual([]);
  });

  it("diff 新增 care 带 done_when 或 window 成功", async () => {
    const harness = await setup();
    const withDoneWhen = payloadOf<PlanDiffResult>(
      await harness.tool.execute(
        {
          action: "diff",
          date: DAY,
          base_version: 1,
          ops: [
            {
              op: "add",
              item: {
                id: "care-1",
                kind: "care",
                intent: "吃药",
                status: "planned",
                done_when: "08:00 前已处理",
              },
            },
          ],
          reason: "带 done_when",
          coverage: COVERAGE,
        },
        CTX,
        SIGNAL,
      ),
    );
    expect(
      withDoneWhen.effective.entries.find((entry) => entry.id === "care-1")?.done_when,
    ).toBe("08:00 前已处理");

    const withWindow = payloadOf<PlanDiffResult>(
      await harness.tool.execute(
        {
          action: "diff",
          date: DAY,
          base_version: 1,
          expected_version: withDoneWhen.overlay.version,
          ops: [
            {
              op: "add",
              item: {
                id: "care-2",
                kind: "care",
                intent: "晨练",
                status: "planned",
                done_when: "晨练结束",
                window: "08:00~09:00",
              },
            },
          ],
          reason: "带 window",
        },
        CTX,
        SIGNAL,
      ),
    );
    expect(
      withWindow.effective.entries.find((entry) => entry.id === "care-2")?.window,
    ).toBe("08:00~09:00");
  });
});

describe("失败一律 isError，不抛出", () => {
  it("无覆盖层时 revise/done/note/close 均返回 PlanOverlayNotFoundError", async () => {
    const harness = await setup();
    const attempts: readonly Record<string, unknown>[] = [
      { action: "revise", date: DAY, expected_version: 1, ops: [], reason: "无覆盖层" },
      { action: "done", date: DAY, id: "morning-review", status: "done" },
      { action: "note", date: DAY, text: "无覆盖层" },
      { action: "close", date: DAY, expected_version: 1, summary: "无覆盖层" },
    ];
    for (const args of attempts) {
      const out = await harness.tool.execute(args, CTX, SIGNAL);
      expect(errorName(out)).toBe("PlanOverlayNotFoundError");
    }
  });

  it("参数/状态/CAS 错误全部折叠为 isError 结果", async () => {
    const harness = await setup();
    await createOverlay(harness, DAY, [
      { op: "update", id: "morning-review", patch: { at: "06:30" } },
    ]);
    const overlayBefore = readFileSync(harness.overlayStore.paths(DAY).overlay, "utf8");

    const cases: readonly {
      readonly label: string;
      readonly args: Record<string, unknown>;
      readonly error: string;
    }[] = [
      {
        label: "未知 action",
        args: { action: "rename", date: DAY },
        error: "PlanOverlayValidationError",
      },
      {
        label: "read 缺 date",
        args: { action: "read" },
        error: "PlanOverlayValidationError",
      },
      {
        label: "base 日历越界日期",
        args: { action: "base", date: "2026-02-30" },
        error: "PlanOverlayValidationError",
      },
      {
        label: "diff 缺 base_version",
        args: { action: "diff", date: DAY, ops: [], reason: "x" },
        error: "PlanOverlayValidationError",
      },
      {
        label: "diff 未知 op",
        args: { action: "diff", date: DAY, base_version: 1, ops: [{ op: "rename" }], reason: "x" },
        error: "PlanOverlayValidationError",
      },
      {
        label: "diff 缺 reason",
        args: { action: "diff", date: DAY, base_version: 1, ops: [] },
        error: "PlanOverlayValidationError",
      },
      {
        label: "revise 版本冲突",
        args: {
          action: "revise",
          date: DAY,
          expected_version: 99,
          ops: [{ op: "update", id: "morning-review", patch: { at: "08:00" } }],
          reason: "x",
        },
        error: "PlanOverlayConflictError",
      },
      {
        label: "done 未知 id",
        args: { action: "done", date: DAY, id: "nope", status: "done" },
        error: "PlanOverlayValidationError",
      },
      {
        label: "done 非法 status",
        args: { action: "done", date: DAY, id: "morning-review", status: "finished" },
        error: "PlanOverlayValidationError",
      },
      {
        label: "done 非法 id",
        args: { action: "done", date: DAY, id: "bad id!", status: "done" },
        error: "PlanOverlayValidationError",
      },
      {
        label: "note 缺 text",
        args: { action: "note", date: DAY },
        error: "PlanOverlayValidationError",
      },
      {
        label: "close 缺 expected_version",
        args: { action: "close", date: DAY, summary: "x" },
        error: "PlanOverlayValidationError",
      },
      {
        label: "close 缺 summary",
        args: { action: "close", date: DAY, expected_version: 2 },
        error: "PlanOverlayValidationError",
      },
    ];

    for (const item of cases) {
      const out = await harness.tool.execute(item.args, CTX, SIGNAL);
      expect(out.isError, item.label).toBe(true);
      expect(errorName(out), item.label).toBe(item.error);
    }

    expect(readFileSync(harness.overlayStore.paths(DAY).overlay, "utf8")).toBe(overlayBefore);
    expect((await harness.ledger.read(DAY)).length).toBe(1);
  });

  it("args 非对象也折叠为 isError", async () => {
    const harness = await setup();
    const out = await harness.tool.execute(
      [] as unknown as Record<string, unknown>,
      CTX,
      SIGNAL,
    );
    expect(errorName(out)).toBe("PlanOverlayValidationError");
  });
});
