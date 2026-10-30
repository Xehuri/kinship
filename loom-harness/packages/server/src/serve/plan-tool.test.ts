/**
 * plan 工具验收（Todo 10）：
 * 五个动作（read/commit/revise/note/close）全部经 JsonPlanStore 落到 mkdtemp 临时根；
 * commit 新建走 write、已存在走 read->revise；revise/note/close 走 CAS；
 * 类型化错误折叠成 isError 工具结果，不抛异常；成功结果带 details.__plan。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { HookContext, ToolExecResult } from "@axeuh/loom-core";

import { JsonPlanStore } from "../plan/json-plan-store.js";
import type {
  PlanCloseResult,
  PlanCoverage,
  PlanDocument,
  PlanItem,
  PlanItemStatus,
} from "../plan/plan-store.js";
import { createPlanTool } from "./plan-tool.js";

const DATE = "2026-10-28";
const NOW = Date.UTC(2026, 9, 27, 21, 0, 0);
const sig = new AbortController().signal;

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

interface Harness {
  readonly root: string;
  readonly store: JsonPlanStore;
  readonly tool: ReturnType<typeof createPlanTool>;
}

function setup(): Harness {
  const root = mkdtempSync(join(tmpdir(), "plan-tool-"));
  roots.push(root);
  const store = new JsonPlanStore({ planRoot: root, now: () => NOW });
  return { root, store, tool: createPlanTool({ store }) };
}

function makeCtx(sessionId = "ses_main_plan"): HookContext {
  const state = new Map<string, unknown>();
  return {
    sessionId,
    turnIdx: 0,
    signal: sig,
    state: {
      get: (key: unknown) =>
        state.get(typeof key === "string" ? key : (key as { key: string }).key),
      set: (key: unknown, value: unknown) => {
        state.set((key as { key: string }).key, value);
      },
      has: (key: unknown) => state.has((key as { key: string }).key),
      delete: (key: unknown) => state.delete((key as { key: string }).key),
    },
    log: { debug: () => {}, info: () => {}, error: () => {}, warn: () => {} },
  } as unknown as HookContext;
}

const ctx = makeCtx();

function text(result: ToolExecResult): string {
  const block = result.content[0];
  return block !== undefined && block.type === "text" ? block.text : "";
}

function detailsOf<T>(result: ToolExecResult): T {
  const details = result.details as { __plan?: T } | undefined;
  if (details?.__plan === undefined) throw new Error("missing details.__plan");
  return details.__plan;
}

interface ItemExtras {
  readonly target_date?: string;
  readonly window?: string;
  readonly checkpoint_id?: string;
  readonly done_when?: string;
  readonly not_do?: readonly string[];
  readonly source?: string;
  readonly note?: string;
}

function careItem(
  id: string,
  intent: string,
  status: PlanItemStatus = "planned",
  extras: ItemExtras = {},
): PlanItem {
  return {
    id,
    kind: "care",
    intent,
    status,
    ...(extras.target_date === undefined ? {} : { target_date: extras.target_date }),
    ...(extras.window === undefined ? {} : { window: extras.window }),
    ...(extras.checkpoint_id === undefined
      ? {}
      : { checkpoint_id: extras.checkpoint_id }),
    ...(extras.done_when === undefined ? {} : { done_when: extras.done_when }),
    ...(extras.not_do === undefined ? {} : { not_do: extras.not_do }),
    ...(extras.source === undefined ? {} : { source: extras.source }),
    ...(extras.note === undefined ? {} : { note: extras.note }),
  };
}

const COVERAGE: PlanCoverage = {
  profile: "merged_7",
  checkpoints: ["cov-00", "cov-06", "cov-08", "cov-12", "cov-16", "cov-20", "cov-22"],
  debt: [],
};

const MERGED_6_COVERAGE: PlanCoverage = {
  profile: "merged_6",
  checkpoints: ["cov-night", "cov-08", "cov-12", "cov-16", "cov-20", "cov-22"],
  debt: [],
};

function commitArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "commit",
    date: DATE,
    items: [careItem("c1", "材料提交", "planned", { not_do: ["不主动提理发"] })],
    coverage: COVERAGE,
    ...overrides,
  };
}

describe("plan read", () => {
  it("读取已有计划：纯文本与 details.__plan 都是完整文档", async () => {
    const { store, tool } = setup();
    const written = await store.write({
      date: DATE,
      status: "committed",
      items: [careItem("c1", "材料提交")],
      coverage: COVERAGE,
      notes: ["昨晚睡 6 小时"],
    });

    const result = await tool.execute({ action: "read", date: DATE }, ctx, sig);
    expect(result.isError).toBeUndefined();
    const body = text(result);
    expect(body).toContain(`plan ${DATE} status=committed v1 review_at=07:30`);
    expect(body).toContain("- c1 care 材料提交 status=planned");
    expect(body).not.toContain('"items":');
    expect(detailsOf<PlanDocument>(result)).toEqual(written);
  });

  it("计划不存在：isError + not-found，不抛异常", async () => {
    const { tool } = setup();
    const result = await tool.execute({ action: "read", date: DATE }, ctx, sig);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("PlanNotFoundError");
    expect(text(result)).toContain(DATE);
  });
});

describe("plan commit", () => {
  it("新建计划：write 为 committed，返回纯文本与 details.__plan", async () => {
    const { store, tool } = setup();
    const result = await tool.execute(
      commitArgs({ review_at: "08:00", notes: ["昨晚睡 6 小时"] }),
      ctx,
      sig,
    );
    expect(result.isError).toBeUndefined();

    const plan = detailsOf<PlanDocument>(result);
    expect(plan).toMatchObject({
      schema: 1,
      date: DATE,
      status: "committed",
      version: 1,
      review_at: "08:00",
      coverage: COVERAGE,
    });
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({ id: "c1", not_do: ["不主动提理发"] });
    expect(plan.notes).toEqual(["昨晚睡 6 小时"]);
    expect(await store.read(DATE)).toEqual(plan);

    const body = text(result);
    expect(body).toContain("status=committed");
    expect(body).toContain("v1");
    expect(body).toContain("- c1 care 材料提交 status=planned");
    expect(body.startsWith("{")).toBe(false);
    expect(body).not.toContain('"items":');
  });

  it("commit 覆盖缺检查点：isError 且不落盘", async () => {
    const { store, tool } = setup();
    const result = await tool.execute(
      commitArgs({
        coverage: { profile: "merged_7", checkpoints: ["cov-00", "cov-06"], debt: [] },
      }),
      ctx,
      sig,
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("PlanValidationError");
    expect(text(result)).toContain("缺少检查点");
    expect(text(result)).toContain("cov-22");
    await expect(store.read(DATE)).rejects.toMatchObject({ name: "PlanNotFoundError" });
  });

  it("not_do 只是数据字段：完整覆盖的提交不被阻断，条目原样保留", async () => {
    const { store, tool } = setup();
    const items = [
      careItem("c1", "提交材料", "planned", {
        not_do: ["不主动提理发", "不主动催简历"],
      }),
    ];
    const result = await tool.execute(commitArgs({ items }), ctx, sig);

    expect(result.isError).toBeUndefined();
    const plan = detailsOf<PlanDocument>(result);
    expect(plan.items).toEqual(items);
    expect(await store.read(DATE)).toEqual(plan);
  });

  it("已存在计划：read 当前版本后 revise，替换 items/coverage 并追加 notes", async () => {
    const { store, tool } = setup();
    await tool.execute(commitArgs({ notes: ["旧笔记"] }), ctx, sig);

    const nextItems = [
      careItem("cov-06", "06 点覆盖", "done", { checkpoint_id: "cov-06" }),
    ];
    const result = await tool.execute(
      commitArgs({
        items: nextItems,
        coverage: { ...MERGED_6_COVERAGE, debt: ["14:00~16:00"] },
        review_at: "08:00",
        notes: ["新笔记"],
      }),
      ctx,
      sig,
    );

    expect(result.isError).toBeUndefined();
    const plan = detailsOf<PlanDocument>(result);
    expect(plan.version).toBe(2);
    expect(plan.status).toBe("committed");
    expect(plan.review_at).toBe("08:00");
    expect(plan.items).toEqual(nextItems);
    expect(plan.coverage).toEqual({ ...MERGED_6_COVERAGE, debt: ["14:00~16:00"] });
    expect(plan.notes).toEqual(["旧笔记", "新笔记"]);
    expect(await store.read(DATE)).toEqual(plan);
  });
});

describe("plan revise", () => {
  it("ops 形态：按序 upsert_item + append_note", async () => {
    const { store, tool } = setup();
    await tool.execute(commitArgs(), ctx, sig);

    const result = await tool.execute(
      {
        action: "revise",
        date: DATE,
        expected_version: 1,
        reason: "材料已提交",
        ops: [
          { op: "upsert_item", item: careItem("c1", "材料提交", "done") },
          { op: "append_note", note: "09:40 已提交" },
        ],
      },
      ctx,
      sig,
    );

    expect(result.isError).toBeUndefined();
    const body = text(result);
    expect(body).toContain(`plan ${DATE} status=committed v2 review_at=07:30`);
    expect(body).toContain("notes 1:");
    expect(body).toContain("- 09:40 已提交");

    const plan = detailsOf<PlanDocument>(result);
    expect(plan.version).toBe(2);
    expect(plan.items[0]).toMatchObject({ id: "c1", status: "done" });
    expect(plan.notes).toEqual(["09:40 已提交"]);
    expect(await store.read(DATE)).toEqual(plan);
  });

  it("patch 形态：整表覆盖 coverage/review_at 并追加 notes", async () => {
    const { store, tool } = setup();
    await tool.execute(commitArgs(), ctx, sig);

    const result = await tool.execute(
      {
        action: "revise",
        date: DATE,
        expected_version: 1,
        reason: "切换覆盖档",
        patch: {
          review_at: "08:15",
          coverage: { ...MERGED_6_COVERAGE, debt: ["14:00~16:00"] },
          notes_append: ["补一句"],
        },
      },
      ctx,
      sig,
    );

    expect(result.isError).toBeUndefined();
    const body = text(result);
    expect(body).toContain(`plan ${DATE} status=committed v2 review_at=08:15`);
    expect(body).toContain("notes 1:");
    expect(body).toContain("- 补一句");

    const plan = detailsOf<PlanDocument>(result);
    expect(plan.version).toBe(2);
    expect(plan.review_at).toBe("08:15");
    expect(plan.coverage.profile).toBe("merged_6");
    expect(plan.coverage.debt).toEqual(["14:00~16:00"]);
    expect(plan.notes).toEqual(["补一句"]);
    expect(await store.read(DATE)).toEqual(plan);
  });
});

describe("plan note", () => {
  it("带 expected_version：CAS 追加一条笔记", async () => {
    const { store, tool } = setup();
    await tool.execute(commitArgs(), ctx, sig);

    const result = await tool.execute(
      { action: "note", date: DATE, text: "09:40 已提交", expected_version: 1 },
      ctx,
      sig,
    );

    expect(result.isError).toBeUndefined();
    const body = text(result);
    expect(body).toContain(`plan ${DATE} status=committed v2 review_at=07:30`);
    expect(body).toContain("notes 1:");
    expect(body).toContain("- 09:40 已提交");

    const plan = detailsOf<PlanDocument>(result);
    expect(plan.version).toBe(2);
    expect(plan.notes).toEqual(["09:40 已提交"]);
    expect(await store.read(DATE)).toEqual(plan);
  });

  it("省略 expected_version：先读当前版本，已修订过的计划也能追加到最新版", async () => {
    const { store, tool } = setup();
    await tool.execute(commitArgs(), ctx, sig);
    const revised = await tool.execute(
      {
        action: "revise",
        date: DATE,
        expected_version: 1,
        reason: "先改一次",
        patch: { notes_append: ["已有笔记"] },
      },
      ctx,
      sig,
    );
    expect(detailsOf<PlanDocument>(revised).version).toBe(2);

    const result = await tool.execute(
      { action: "note", date: DATE, text: "后补笔记" },
      ctx,
      sig,
    );

    expect(result.isError).toBeUndefined();
    const body = text(result);
    expect(body).toContain(`plan ${DATE} status=committed v3 review_at=07:30`);
    expect(body).toContain("notes 2:");
    expect(body).toContain("- 已有笔记");
    expect(body).toContain("- 后补笔记");

    const plan = detailsOf<PlanDocument>(result);
    expect(plan.version).toBe(3);
    expect(plan.notes).toEqual(["已有笔记", "后补笔记"]);
    expect(await store.read(DATE)).toEqual(plan);
  });
});

describe("plan close", () => {
  it("未完成条目转 carried，结果返回 plan + carried + summary", async () => {
    const { store, tool } = setup();
    const items = [
      careItem("done-1", "已完成", "done"),
      careItem("plan-1", "没做", "planned"),
      careItem("skip-1", "主动跳过", "skipped"),
      careItem("block-1", "被阻塞", "blocked"),
    ];
    await tool.execute(commitArgs({ items }), ctx, sig);

    const result = await tool.execute(
      {
        action: "close",
        date: DATE,
        expected_version: 1,
        summary: "今天只完成一件",
      },
      ctx,
      sig,
    );

    expect(result.isError).toBeUndefined();
    const closed = detailsOf<PlanCloseResult>(result);
    expect(closed.plan.status).toBe("closed");
    expect(closed.plan.version).toBe(2);
    expect(closed.summary).toBe("今天只完成一件");
    expect(closed.carried.map((item) => item.id)).toEqual(["plan-1", "skip-1", "block-1"]);
    expect(closed.carried.every((item) => item.status === "carried")).toBe(true);
    expect(closed.plan.items.map((item) => [item.id, item.status])).toEqual([
      ["done-1", "done"],
      ["plan-1", "carried"],
      ["skip-1", "carried"],
      ["block-1", "carried"],
    ]);

    const body = text(result);
    expect(body).toContain(`plan ${DATE} closed v2 review_at=07:30`);
    expect(body).toContain("summary: 今天只完成一件");
    expect(body).toContain("carried 3: plan-1, skip-1, block-1");
    expect(await store.read(DATE)).toEqual(closed.plan);
  });
});

describe("缺失计划与 CAS 冲突", () => {
  it("read/revise/note/close 对不存在的计划都返回 isError", async () => {
    const { tool } = setup();
    const cases: Array<Record<string, unknown>> = [
      { action: "read", date: DATE },
      {
        action: "revise",
        date: DATE,
        expected_version: 1,
        reason: "改",
        patch: { notes_append: ["x"] },
      },
      { action: "note", date: DATE, text: "x" },
      { action: "close", date: DATE, expected_version: 1, summary: "收口" },
    ];

    for (const args of cases) {
      const result = await tool.execute(args, ctx, sig);
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(text(result)).toContain("PlanNotFoundError");
      expect(text(result)).toContain(DATE);
    }
  });

  it("陈旧 expected_version：isError + conflict，计划文件不变", async () => {
    const { store, tool } = setup();
    await tool.execute(commitArgs(), ctx, sig);
    await tool.execute(
      {
        action: "revise",
        date: DATE,
        expected_version: 1,
        reason: "第一次",
        patch: { notes_append: ["一"] },
      },
      ctx,
      sig,
    );
    const before = await store.read(DATE);

    const result = await tool.execute(
      {
        action: "revise",
        date: DATE,
        expected_version: 1,
        reason: "迟到",
        patch: { notes_append: ["迟到"] },
      },
      ctx,
      sig,
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("PlanConflictError");
    expect(text(result)).toContain("expected version 1");
    expect(await store.read(DATE)).toEqual(before);
  });
});

describe("参数校验", () => {
  it("非法参数全部折叠成 isError，不抛异常、不落盘", async () => {
    const { store, tool } = setup();
    await tool.execute(commitArgs(), ctx, sig);

    const cases: Array<Record<string, unknown>> = [
      { action: "bogus", date: DATE },
      { action: "read" },
      { action: "read", date: "2026-02-30" },
      { action: "commit", date: DATE, coverage: COVERAGE },
      { action: "commit", date: DATE, items: [careItem("c1", "x")] },
      {
        action: "commit",
        date: DATE,
        items: [careItem("c1", "x")],
        coverage: { profile: "merged_10", checkpoints: ["cov-00"], debt: [] },
      },
      {
        action: "commit",
        date: DATE,
        items: [careItem("c1", "x")],
        coverage: {
          profile: "merged_7",
          checkpoints: [...COVERAGE.checkpoints, "cov-99"],
          debt: [],
        },
      },
      {
        action: "commit",
        date: DATE,
        items: [careItem("dup", "一"), careItem("dup", "二")],
        coverage: COVERAGE,
      },
      { action: "revise", date: DATE, expected_version: 1, reason: "x" },
      {
        action: "revise",
        date: DATE,
        expected_version: 1,
        reason: "x",
        patch: { notes_append: ["x"] },
        ops: [],
      },
      {
        action: "revise",
        date: DATE,
        expected_version: 1,
        reason: "x",
        patch: {},
      },
      { action: "note", date: DATE, text: "   " },
      { action: "close", date: DATE, summary: "收口" },
      { action: "close", date: DATE, expected_version: 1, summary: "   " },
    ];

    for (const args of cases) {
      const result = await tool.execute(args, ctx, sig);
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(text(result)).toContain("plan 被拒绝");
    }

    expect((await store.read(DATE)).version).toBe(1);
  });
});
