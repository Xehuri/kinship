/**
 * 单写者与版本冲突集成验收（Todo 14 / GAP-4）。
 *
 * 覆盖三件事：
 *   1. 成功写入只走 Loom 工具（plan / long_task）；第二个 Json*Store 实例只拿
 *      读快照并尝试陈旧写入，CAS 必须拒绝，JSON / MD / 审计保持胜出版本。
 *   2. 只读视图只暴露 read，运行时没有任何写方法。
 *   3. 后端 GET /api/plan 与前端 usePlan 的读路径没有写调用（源码面断言）。
 *
 * 所有落盘都在 mkdtemp 临时根，不碰真实 ai/data。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import type { HarnessTool, HookContext, ToolExecResult } from "@axeuh/loom-core";

import { JsonLongTaskStore } from "./json-long-task-store.js";
import { JsonPlanStore, renderPlanMarkdown } from "./json-plan-store.js";
import {
  LongTaskConflictError,
  renderLongTaskMarkdown,
  type LongTask,
} from "./long-task-store.js";
import {
  PlanConflictError,
  type PlanAuditRecord,
  type PlanCoverage,
  type PlanDocument,
  type PlanStore,
} from "./plan-store.js";
import { createLongTaskTool } from "../serve/long-task-tool.js";
import { createPlanTool } from "../serve/plan-tool.js";

const DATE = "2026-10-28";
const NOW = Date.UTC(2026, 9, 27, 21, 0, 0);
const TASK_ID = "lt_weekly_review";

const MERGED_6: PlanCoverage = {
  profile: "merged_6",
  checkpoints: ["cov-night", "cov-08", "cov-12", "cov-16", "cov-20", "cov-22"],
  debt: [],
};

const signal = new AbortController().signal;

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "plan-single-writer-"));
  roots.push(root);
  return root;
}

function makeCtx(): HookContext {
  const state = new Map<string, unknown>();
  return {
    sessionId: "ses_single_writer",
    turnIdx: 0,
    state: {
      get: (key: unknown) => state.get(String(key)),
      set: (key: unknown, value: unknown) => {
        state.set(String(key), value);
      },
      has: (key: unknown) => state.has(String(key)),
      delete: (key: unknown) => state.delete(String(key)),
    },
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as HookContext;
}

const ctx = makeCtx();

function call(tool: HarnessTool, args: Record<string, unknown>): Promise<ToolExecResult> {
  return tool.execute(args, ctx, signal);
}

function textOf(result: ToolExecResult): string {
  const block = result.content[0];
  return block !== undefined && block.type === "text" ? block.text : "";
}

function planOf(result: ToolExecResult): PlanDocument {
  if (result.isError === true) throw new Error(`unexpected plan error: ${textOf(result)}`);
  const details = result.details as { __plan?: unknown } | undefined;
  const plan = details?.__plan;
  if (plan === null || typeof plan !== "object") throw new Error("missing details.__plan");
  return plan as PlanDocument;
}

function taskOf(result: ToolExecResult): LongTask {
  if (result.isError === true) throw new Error(`unexpected long_task error: ${textOf(result)}`);
  const details = result.details as { __long_task?: unknown } | undefined;
  const task = details?.__long_task;
  if (task === null || typeof task !== "object") throw new Error("missing details.__long_task");
  return task as LongTask;
}

function dayDir(root: string): string {
  return join(root, "daily", DATE);
}

function planJsonPath(root: string): string {
  return join(dayDir(root), `plan-${DATE}.json`);
}

function planMarkdownPath(root: string): string {
  return join(dayDir(root), `计划-${DATE}.md`);
}

function planAuditPath(root: string): string {
  return join(dayDir(root), `plan-${DATE}.audit.jsonl`);
}

function readAudit(root: string): PlanAuditRecord[] {
  const content = readFileSync(planAuditPath(root), "utf8").trim();
  if (content === "") return [];
  return content.split("\n").map((line) => JSON.parse(line) as PlanAuditRecord);
}

function taskDir(root: string): string {
  return join(root, "plan", "long-tasks");
}

function taskJsonPath(root: string, id: string): string {
  return join(taskDir(root), `${id}.json`);
}

function taskMarkdownPath(root: string, id: string): string {
  return join(taskDir(root), `${id}.md`);
}

/** 只读视图：唯一暴露的方法是 read，写方法不可达。 */
type ReadOnlyPlanView = Pick<PlanStore, "read">;

function createReadOnlyPlanView(store: PlanStore): ReadOnlyPlanView {
  return { read: (date: string) => store.read(date) };
}

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..", "..");

function repoPath(relative: string): string {
  return join(REPO_ROOT, ...relative.split("/"));
}

function planCommitArgs(): Record<string, unknown> {
  return {
    action: "commit",
    date: DATE,
    items: [{ id: "care_1", kind: "care", intent: "提交材料", status: "planned" }],
    coverage: MERGED_6,
    review_at: "07:30",
  };
}

describe("plan 单写者与版本冲突", () => {
  it("工具 commit 后，第二个 store 陈旧版本 revise 冲突；唯一版本胜出且 JSON/MD/审计一致", async () => {
    const root = tempRoot();
    const clock = { now: NOW };
    const writerStore = new JsonPlanStore({ planRoot: root, now: () => clock.now });
    const writer = createPlanTool({ store: writerStore });
    // 工具显式声明不并发安全，kernel 会把同一 turn 的写调用串行化。
    expect(writer.isConcurrencySafe?.({})).toBe(false);

    const committed = planOf(await call(writer, planCommitArgs()));
    expect(committed.version).toBe(1);
    expect(committed.status).toBe("committed");

    // 第二个实例只用于拿读快照（模拟只读消费者），随后它带着旧版本尝试写。
    const second = new JsonPlanStore({ planRoot: root, now: () => clock.now });
    const snapshot = await second.read(DATE);
    expect(snapshot.version).toBe(1);

    clock.now += 1_000;
    const revised = planOf(
      await call(writer, {
        action: "revise",
        date: DATE,
        expected_version: snapshot.version,
        reason: "winner",
        ops: [{ op: "append_note", note: "winner" }],
      }),
    );
    expect(revised.version).toBe(2);
    expect(revised.notes).toEqual(["winner"]);

    const jsonBefore = readFileSync(planJsonPath(root), "utf8");
    const markdownBefore = readFileSync(planMarkdownPath(root), "utf8");
    const auditBefore = readFileSync(planAuditPath(root), "utf8");

    const staleError = await second
      .revise(DATE, snapshot.version, { notes_append: ["loser"] }, "stale writer")
      .catch((error: unknown) => error);
    expect(staleError).toBeInstanceOf(PlanConflictError);
    expect(staleError).toMatchObject({ date: DATE, expected: 1, actual: 2 });

    // 冲突写入不落盘、不渲染、不追加审计。
    expect(readFileSync(planJsonPath(root), "utf8")).toBe(jsonBefore);
    expect(readFileSync(planMarkdownPath(root), "utf8")).toBe(markdownBefore);
    expect(readFileSync(planAuditPath(root), "utf8")).toBe(auditBefore);

    const final = await writerStore.read(DATE);
    expect(final).toEqual(revised);
    expect(final.version).toBe(2);
    expect(final.notes).toEqual(["winner"]);
    expect(JSON.parse(jsonBefore)).toEqual(final);
    expect(markdownBefore).toBe(renderPlanMarkdown(final));

    const audit = readAudit(root);
    expect(
      audit.map((record) => [
        record.action,
        record.version,
        record.expected_version,
        record.reason,
      ]),
    ).toEqual([
      ["write", 1, null, null],
      ["revise", 2, 1, "winner"],
    ]);

    // 重新读取当前版本后继续修订应当成功：两个连续修订都以磁盘版本为基准。
    clock.now += 1_000;
    const third = planOf(
      await call(writer, {
        action: "revise",
        date: DATE,
        expected_version: final.version,
        reason: "fresh",
        patch: { notes_append: ["fresh"] },
      }),
    );
    expect(third.version).toBe(3);
    expect((await second.read(DATE)).version).toBe(3);
  });

  it("只读视图只暴露 read，返回 0 个写方法", async () => {
    const root = tempRoot();
    const store = new JsonPlanStore({ planRoot: root, now: () => NOW });
    const tool = createPlanTool({ store });
    await call(tool, planCommitArgs());

    const view = createReadOnlyPlanView(store);
    expect(Object.keys(view)).toEqual(["read"]);
    for (const method of ["write", "revise", "close", "appendAudit"] as const) {
      expect((view as unknown as Record<string, unknown>)[method]).toBeUndefined();
    }

    const plan = await view.read(DATE);
    expect(plan.version).toBe(1);
    expect(plan.status).toBe("committed");
  });
});

describe("long_task 单写者与版本冲突", () => {
  it("工具 create/update 后，第二个 store 陈旧 update 冲突且不改文件；归档仍可读", async () => {
    const root = tempRoot();
    const clock = { now: NOW };
    const writerStore = new JsonLongTaskStore({ planRoot: root, now: () => clock.now });
    const writer = createLongTaskTool({ store: writerStore });
    expect(writer.isConcurrencySafe?.({})).toBe(false);

    const created = taskOf(
      await call(writer, {
        action: "create",
        task: {
          id: TASK_ID,
          title: "每周复盘",
          intent: "每周收口一次",
          cadence: "weekly",
          next_check: "2026-11-03",
        },
      }),
    );
    expect(created.version).toBe(1);
    expect(created.status).toBe("active");

    const second = new JsonLongTaskStore({ planRoot: root, now: () => clock.now });
    const snapshot = (await second.read(TASK_ID)).task;
    expect(snapshot.version).toBe(1);

    clock.now += 1_000;
    const updated = taskOf(
      await call(writer, {
        action: "update",
        id: TASK_ID,
        expected_version: snapshot.version,
        patch: { next_check: "2026-11-10", notes: ["winner"] },
      }),
    );
    expect(updated.version).toBe(2);
    expect(updated.next_check).toBe("2026-11-10");

    const jsonBefore = readFileSync(taskJsonPath(root, TASK_ID), "utf8");
    const markdownBefore = readFileSync(taskMarkdownPath(root, TASK_ID), "utf8");

    const staleError = await second
      .update(TASK_ID, snapshot.version, { title: "陈旧覆盖" })
      .catch((error: unknown) => error);
    expect(staleError).toBeInstanceOf(LongTaskConflictError);
    expect(staleError).toMatchObject({ id: TASK_ID, expected: 1, actual: 2 });

    // 没有半写：JSON 与 MD 都与冲突前逐字一致。
    expect(readFileSync(taskJsonPath(root, TASK_ID), "utf8")).toBe(jsonBefore);
    expect(readFileSync(taskMarkdownPath(root, TASK_ID), "utf8")).toBe(markdownBefore);
    expect((await second.read(TASK_ID)).task.title).toBe("每周复盘");

    clock.now += 1_000;
    const archived = taskOf(
      await call(writer, {
        action: "archive",
        id: TASK_ID,
        expected_version: updated.version,
      }),
    );
    expect(archived.status).toBe("archived");
    expect(archived.version).toBe(3);

    // 归档只改 status，文件保留：第二个 store 仍能读到 JSON + 重渲染的 MD。
    const archivedRead = await second.read(TASK_ID);
    expect(archivedRead.task).toEqual(archived);
    expect(existsSync(taskJsonPath(root, TASK_ID))).toBe(true);
    expect(existsSync(taskMarkdownPath(root, TASK_ID))).toBe(true);
    expect(archivedRead.markdown).toBe(renderLongTaskMarkdown(archivedRead.task));
    expect(readFileSync(taskMarkdownPath(root, TASK_ID), "utf8")).toBe(archivedRead.markdown);

    expect((await writerStore.list({ due: "active" })).map((task) => task.id)).not.toContain(
      TASK_ID,
    );
    expect((await writerStore.list({ due: "all" })).map((task) => task.id)).toContain(TASK_ID);
  });
});

describe("读路径只读（源码面断言）", () => {
  it("backend GET /api/plan 只注册只读 GET，且没有任何文件写调用", () => {
    const source = readFileSync(repoPath("backend/routers/plan.py"), "utf8");
    expect(source.match(/@router\.(get|post|put|patch|delete)\b/g) ?? []).toEqual([
      "@router.get",
      "@router.get",
      "@router.get",
    ]);
    expect(source).not.toMatch(/@router\.(post|put|patch|delete)\b/);
    expect(source).not.toMatch(/\.(write_text|write_bytes|mkdir|unlink|rename)\(/);
    expect(source).not.toMatch(/json\.dump\(/);
    expect(source).not.toMatch(/\bopen\([^)]*["'](?:w|a|x)b?["']/);

    const main = readFileSync(repoPath("backend/main.py"), "utf8");
    expect(main).toMatch(/include_router\(plan_router\.router,\s*prefix="\/api"\)/);
  });

  it("frontend usePlan 只读：plan API 仅 GET helper，重排走对话而不是计划写接口", () => {
    const api = readFileSync(repoPath("frontend/mobile/src/api/plan.ts"), "utf8");
    expect(api).toMatch(/import \{[^}]*\bapiGet\b[^}]*\} from '@\/api\/client'/);
    expect(api).not.toMatch(/\b(apiPost|apiPut|apiPatch|apiDelete)\b/);
    expect(api).not.toMatch(/method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/);
    expect(api).not.toMatch(/\bfetch\s*\(/);

    const usePlan = readFileSync(
      repoPath("frontend/mobile/src/composables/usePlan.ts"),
      "utf8",
    );
    expect(usePlan).not.toMatch(/\b(apiPost|apiPut|apiPatch|apiDelete)\b/);
    expect(usePlan).toMatch(/PLAN_REPLAN_TEXT/);
    expect(usePlan).toMatch(/sendMessage as apiSendMessage/);
    expect(usePlan).toMatch(/backend: 'loom'/);
  });
});
