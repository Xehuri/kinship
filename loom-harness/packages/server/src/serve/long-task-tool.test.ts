/**
 * long_task 工具验收：七个动作的正常/拒绝路径、due 过滤、归档排除、
 * 重复/非法 id、陈旧版本、read 的 Markdown 投影、缺 id 与坏参数。
 * 全部使用 mkdtemp 根，不碰真实 ai/data。文本是纯文本；结构化断言一律读 details。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { HarnessTool, HookContext, ToolExecResult } from "@axeuh/loom-core";

import { JsonLongTaskStore } from "../plan/json-long-task-store.js";
import type { LongTask, LongTaskCreateInput } from "../plan/long-task-store.js";
import { LONG_TASK_TOOL_NAME, createLongTaskTool } from "./long-task-tool.js";

const NOW = Date.UTC(2026, 9, 27, 4, 0, 0);
const TODAY = "2026-10-27";
const TOMORROW = "2026-10-28";
const YESTERDAY = "2026-10-26";

const roots: string[] = [];
const signal = new AbortController().signal;

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

interface Fixture {
  readonly root: string;
  readonly store: JsonLongTaskStore;
  readonly tool: HarnessTool;
}

function makeCtx(): HookContext {
  const store = new Map<string, unknown>();
  return {
    sessionId: "ses_long_task_tool",
    turnIdx: 0,
    state: {
      get: (key: unknown) => store.get(String(key)),
      set: (key: unknown, value: unknown) => {
        store.set(String(key), value);
      },
      has: (key: unknown) => store.has(String(key)),
      delete: (key: unknown) => store.delete(String(key)),
    },
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as HookContext;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "long-task-tool-"));
  roots.push(root);
  const store = new JsonLongTaskStore({ planRoot: root, now: () => NOW });
  return { root, store, tool: createLongTaskTool({ store }) };
}

interface Outcome {
  readonly result: ToolExecResult;
  readonly text: string;
  /** 从 details 重建的结构化视图（文本已不再承载 JSON）。 */
  readonly json: unknown;
  readonly isError: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonFromDetails(result: ToolExecResult, args: unknown): unknown {
  const details = result.details as Record<string, unknown> | undefined;
  if (details === undefined) return null;
  const tasks = details["__long_tasks"];
  const call: Record<string, unknown> = isRecord(args) ? args : {};
  if (tasks !== undefined) {
    const list = tasks as readonly LongTask[];
    return {
      ok: true,
      action: "list",
      due: call["due"] ?? "all",
      date: call["date"] ?? null,
      count: list.length,
      tasks: list,
    };
  }
  const record = details["__long_task"];
  if (record === undefined) return null;
  if (isRecord(record) && typeof record["ok"] === "boolean") return record;
  if (isRecord(record) && record["markdown"] !== undefined) {
    return { ok: true, action: "read", task: record["task"], markdown: record["markdown"] };
  }
  return { ok: true, action: call["action"], task: record };
}

async function call(tool: HarnessTool, args: unknown): Promise<Outcome> {
  const result = await tool.execute(args as Record<string, unknown>, makeCtx(), signal);
  const block = result.content[0];
  const text = block !== undefined && block.type === "text" ? block.text : "";
  return {
    result,
    text,
    json: jsonFromDetails(result, args),
    isError: result.isError === true,
  };
}

interface TaskPayload {
  readonly ok: true;
  readonly action: string;
  readonly task: LongTask;
}

interface ListPayload {
  readonly ok: true;
  readonly action: "list";
  readonly due: string;
  readonly date: string | null;
  readonly count: number;
  readonly tasks: readonly LongTask[];
}

interface ReadPayload extends TaskPayload {
  readonly markdown: string;
}

interface ErrorPayload {
  readonly ok: false;
  readonly action: string;
  readonly error: string;
  readonly message: string;
}

function asTask(json: unknown): TaskPayload {
  return json as TaskPayload;
}

function asList(json: unknown): ListPayload {
  return json as ListPayload;
}

function asRead(json: unknown): ReadPayload {
  return json as ReadPayload;
}

function errorOf(out: Outcome): ErrorPayload {
  return detailsOf(out.result)["__long_task"] as ErrorPayload;
}

function detailsOf(result: ToolExecResult): Record<string, unknown> {
  return result.details as Record<string, unknown>;
}

function weeklyTask(overrides: Partial<LongTaskCreateInput> = {}): LongTaskCreateInput {
  return {
    id: "lt_weekly_review",
    title: "每周复盘",
    intent: "每周把这一周收一下，定下周三件事",
    cadence: "weekly",
    next_check: TODAY,
    ...overrides,
  };
}

async function createTask(
  tool: HarnessTool,
  overrides: Partial<LongTaskCreateInput> = {},
): Promise<void> {
  const out = await call(tool, { action: "create", task: weeklyTask(overrides) });
  expect(out.isError).toBe(false);
}

describe("工厂契约", () => {
  it("name=long_task、非只读、串行执行，参数只暴露动作字段（无文件路径）", () => {
    const { tool } = fixture();
    expect(tool.name).toBe(LONG_TASK_TOOL_NAME);
    expect(tool.name).toBe("long_task");
    expect(tool.isReadOnly).toBe(false);
    expect(tool.isConcurrencySafe?.({})).toBe(false);
    const schema = tool.parameters as unknown as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties).sort()).toEqual([
      "action",
      "date",
      "due",
      "expected_version",
      "id",
      "patch",
      "task",
      "until",
    ]);
    expect(JSON.stringify(tool.parameters)).not.toContain("planRoot");
  });
});

describe("create", () => {
  it("创建成功：文本为紧凑纯文本，details.__long_task=任务本身，版本 1 / active", async () => {
    const { tool, store } = fixture();
    const out = await call(tool, { action: "create", task: weeklyTask() });

    expect(out.isError).toBe(false);
    const payload = asTask(out.json);
    expect(payload.action).toBe("create");
    expect(payload.task).toMatchObject({
      schema: 1,
      id: "lt_weekly_review",
      title: "每周复盘",
      cadence: "weekly",
      next_check: TODAY,
      last_done: null,
      status: "active",
      review_policy: "after_done",
      notes: [],
      version: 1,
    });
    expect(payload.task.created_at).toBe(new Date(NOW).toISOString());
    expect(payload.task.updated_at).toBe(payload.task.created_at);
    expect(detailsOf(out.result)["__long_task"]).toEqual(payload.task);
    expect(out.text).toContain("long_task create ok id=lt_weekly_review");
    expect(out.text).toContain("status=active");
    expect(out.text).toContain("cadence=weekly");
    expect(out.text.startsWith("{")).toBe(false);
    expect(out.text).not.toContain('"task":');
    await expect(store.read("lt_weekly_review")).resolves.toMatchObject({
      task: payload.task,
    });
  });

  it("缺省 id 由 title 派生：ASCII 标题生成合法 lt_ id", async () => {
    const { tool } = fixture();
    const out = await call(tool, {
      action: "create",
      task: {
        title: "Daily Walk",
        intent: "每天走一走",
        cadence: "daily",
        next_check: TODAY,
      },
    });
    expect(out.isError).toBe(false);
    expect(asTask(out.json).task.id).toMatch(/^lt_daily_walk$/);
  });

  it("重复 create 同一 id：isError=true，LongTaskExistsError，既有记录不被覆盖", async () => {
    const { tool, store } = fixture();
    await createTask(tool);

    const out = await call(tool, {
      action: "create",
      task: weeklyTask({ title: "覆盖尝试" }),
    });
    expect(out.isError).toBe(true);
    expect(errorOf(out)).toMatchObject({
      ok: false,
      action: "create",
      error: "LongTaskExistsError",
    });
    expect(out.text).toContain("[long-task:exists]");
    const read = await store.read("lt_weekly_review");
    expect(read.task.title).toBe("每周复盘");
    expect(read.task.version).toBe(1);
  });

  it("非法 id：isError=true，LongTaskValidationError 带 id 字段", async () => {
    const { tool } = fixture();
    const out = await call(tool, {
      action: "create",
      task: weeklyTask({ id: "weekly_review" }),
    });
    expect(out.isError).toBe(true);
    expect(errorOf(out).error).toBe("LongTaskValidationError");
    expect(errorOf(out).message).toContain("id");
  });

  it("缺 task / cadence 越界：isError=true，不抛错", async () => {
    const { tool } = fixture();
    const missing = await call(tool, { action: "create" });
    expect(missing.isError).toBe(true);
    expect(errorOf(missing).message).toContain("task");

    const badCadence = await call(tool, {
      action: "create",
      task: { ...weeklyTask(), cadence: "hourly" },
    });
    expect(badCadence.isError).toBe(true);
    expect(errorOf(badCadence).message).toContain("cadence");
  });
});

describe("update", () => {
  it("更新成功：version+1，next_check/notes 生效，文本为 update 行，details 同源", async () => {
    const { tool } = fixture();
    await createTask(tool);

    const out = await call(tool, {
      action: "update",
      id: "lt_weekly_review",
      expected_version: 1,
      patch: { next_check: TOMORROW, notes: ["先问他要不要复盘", "不催"] },
    });
    expect(out.isError).toBe(false);
    const payload = asTask(out.json);
    expect(payload.action).toBe("update");
    expect(payload.task.version).toBe(2);
    expect(payload.task.next_check).toBe(TOMORROW);
    expect(payload.task.notes).toEqual(["先问他要不要复盘", "不催"]);
    expect(detailsOf(out.result)["__long_task"]).toEqual(payload.task);
    expect(out.text).toContain("long_task update ok");
    expect(out.text).toContain("v2");
  });

  it("陈旧版本：isError=true，LongTaskConflictError，磁盘记录未被改动", async () => {
    const { tool, store } = fixture();
    await createTask(tool);
    await call(tool, {
      action: "update",
      id: "lt_weekly_review",
      expected_version: 1,
      patch: { next_check: TOMORROW },
    });

    const stale = await call(tool, {
      action: "update",
      id: "lt_weekly_review",
      expected_version: 1,
      patch: { title: "过期写入" },
    });
    expect(stale.isError).toBe(true);
    expect(errorOf(stale)).toMatchObject({
      action: "update",
      error: "LongTaskConflictError",
    });
    expect(stale.text).toContain("[long-task:conflict]");
    const read = await store.read("lt_weekly_review");
    expect(read.task.version).toBe(2);
    expect(read.task.title).toBe("每周复盘");
    expect(read.task.next_check).toBe(TOMORROW);
  });

  it("patch 含 status / 空 patch / 缺 expected_version：全部 isError", async () => {
    const { tool } = fixture();
    await createTask(tool);

    const withStatus = await call(tool, {
      action: "update",
      id: "lt_weekly_review",
      expected_version: 1,
      patch: { status: "paused" },
    });
    expect(withStatus.isError).toBe(true);
    expect(errorOf(withStatus).message).toContain("不允许修改");

    const empty = await call(tool, {
      action: "update",
      id: "lt_weekly_review",
      expected_version: 1,
      patch: {},
    });
    expect(empty.isError).toBe(true);
    expect(errorOf(empty).message).toContain("至少需要一个字段");

    const missingVersion = await call(tool, {
      action: "update",
      id: "lt_weekly_review",
      patch: { title: "x" },
    });
    expect(missingVersion.isError).toBe(true);
    expect(errorOf(missingVersion).message).toContain("expectedVersion");
  });
});

describe("pause / resume / archive", () => {
  it("pause 带 until：status=paused，next_check 指向 until", async () => {
    const { tool } = fixture();
    await createTask(tool);

    const out = await call(tool, {
      action: "pause",
      id: "lt_weekly_review",
      expected_version: 1,
      until: TOMORROW,
    });
    expect(out.isError).toBe(false);
    const payload = asTask(out.json);
    expect(payload.action).toBe("pause");
    expect(payload.task.status).toBe("paused");
    expect(payload.task.next_check).toBe(TOMORROW);
    expect(payload.task.version).toBe(2);
  });

  it("pause 不带 until：保留原 next_check；resume 回到 active 且日期不变", async () => {
    const { tool } = fixture();
    await createTask(tool);

    const paused = await call(tool, {
      action: "pause",
      id: "lt_weekly_review",
      expected_version: 1,
    });
    expect(asTask(paused.json).task).toMatchObject({ status: "paused", next_check: TODAY });

    const resumed = await call(tool, {
      action: "resume",
      id: "lt_weekly_review",
      expected_version: 2,
    });
    expect(resumed.isError).toBe(false);
    expect(asTask(resumed.json).task).toMatchObject({
      status: "active",
      next_check: TODAY,
      version: 3,
    });
  });

  it("archive：status=archived，之后 update/pause/resume 全部 isError: Archived", async () => {
    const { tool } = fixture();
    await createTask(tool);

    const archived = await call(tool, {
      action: "archive",
      id: "lt_weekly_review",
      expected_version: 1,
    });
    expect(archived.isError).toBe(false);
    expect(asTask(archived.json).task).toMatchObject({ status: "archived", version: 2 });

    for (const action of ["update", "pause", "resume", "archive"] as const) {
      const out = await call(tool, {
        action,
        id: "lt_weekly_review",
        expected_version: 2,
        ...(action === "update" ? { patch: { title: "x" } } : {}),
      });
      expect(out.isError).toBe(true);
      expect(errorOf(out).error).toBe("LongTaskArchivedError");
    }
  });

  it("pause 的 until 非法日期：isError，而不是写入坏值", async () => {
    const { tool } = fixture();
    await createTask(tool);
    const out = await call(tool, {
      action: "pause",
      id: "lt_weekly_review",
      expected_version: 1,
      until: "2026-02-30",
    });
    expect(out.isError).toBe(true);
    expect(errorOf(out).error).toBe("LongTaskValidationError");
    expect(errorOf(out).message).toContain("日期不存在");
  });
});

describe("list", () => {
  async function seed(tool: HarnessTool): Promise<void> {
    await createTask(tool, { id: "lt_today", title: "今天", cadence: "daily", next_check: TODAY });
    await createTask(tool, { id: "lt_overdue", title: "逾期", cadence: "daily", next_check: YESTERDAY });
    await createTask(tool, { id: "lt_future", title: "未来", cadence: "weekly", next_check: TOMORROW });
    await createTask(tool, { id: "lt_paused", title: "暂停", cadence: "weekly", next_check: TODAY });
    await createTask(tool, { id: "lt_archived", title: "归档", cadence: "monthly", next_check: TODAY });
    const paused = await call(tool, { action: "pause", id: "lt_paused", expected_version: 1 });
    expect(paused.isError).toBe(false);
    const archived = await call(tool, { action: "archive", id: "lt_archived", expected_version: 1 });
    expect(archived.isError).toBe(false);
  }

  it("due=today：只含 active 且 next_check<=今天，按日期升序", async () => {
    const { tool } = fixture();
    await seed(tool);

    const out = await call(tool, { action: "list", due: "today" });
    expect(out.isError).toBe(false);
    const payload = asList(out.json);
    expect(payload.due).toBe("today");
    expect(payload.date).toBeNull();
    expect(payload.tasks.map((t) => t.id)).toEqual(["lt_overdue", "lt_today"]);
    expect(payload.count).toBe(2);
    expect(detailsOf(out.result)["__long_tasks"]).toEqual(payload.tasks);
    expect(out.text).toContain("long_task list due=today");
    expect(out.text).toContain("count=2");
    expect(out.text).toContain("lt_overdue");
    expect(out.text).toContain("lt_today");
    expect(out.text).not.toContain('"tasks":');
  });

  it("date 省略：文本头写 date=store-today", async () => {
    const { tool } = fixture();
    await seed(tool);

    const out = await call(tool, { action: "list", due: "today" });
    expect(out.text.startsWith("long_task list due=today date=store-today")).toBe(true);
  });

  it("空列表：头带 (no tasks)，无条目行", async () => {
    const { tool } = fixture();
    const out = await call(tool, { action: "list", due: "today" });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("count=0");
    expect(out.text).toContain("(no tasks)");
    expect(out.text.split("\n")).toHaveLength(1);
  });

  it("due=active：排除 paused 与 archived，保留未来任务", async () => {
    const { tool } = fixture();
    await seed(tool);
    const payload = asList((await call(tool, { action: "list", due: "active" })).json);
    expect(payload.tasks.map((t) => t.id)).toEqual(["lt_overdue", "lt_today", "lt_future"]);
  });

  it("due=all（缺省）：含 paused 与 archived", async () => {
    const { tool } = fixture();
    await seed(tool);

    const explicit = asList((await call(tool, { action: "list", due: "all" })).json);
    expect(explicit.tasks.map((t) => t.id)).toEqual([
      "lt_overdue",
      "lt_archived",
      "lt_paused",
      "lt_today",
      "lt_future",
    ]);
    expect(explicit.tasks.find((t) => t.id === "lt_archived")?.status).toBe("archived");

    const byDefault = asList((await call(tool, { action: "list" })).json);
    expect(byDefault.due).toBe("all");
    expect(byDefault.count).toBe(5);
  });

  it("显式 date 改变 due=today 的参考日：明天再看时未来任务进入视图", async () => {
    const { tool } = fixture();
    await seed(tool);

    const out = await call(tool, { action: "list", due: "today", date: TOMORROW });
    const payload = asList(out.json);
    expect(payload.date).toBe(TOMORROW);
    expect(payload.tasks.map((t) => t.id)).toEqual(["lt_overdue", "lt_today", "lt_future"]);
  });

  it("坏 due / 坏 date：isError=true", async () => {
    const { tool } = fixture();
    const badDue = await call(tool, { action: "list", due: "week" });
    expect(badDue.isError).toBe(true);
    expect(errorOf(badDue).message).toContain("due");

    const badDate = await call(tool, { action: "list", date: "2026-02-30" });
    expect(badDate.isError).toBe(true);
    expect(errorOf(badDate).message).toContain("日期不存在");
  });
});

describe("read", () => {
  it("content 为渲染 Markdown 正文，details 同源", async () => {
    const { tool } = fixture();
    await createTask(tool, { notes: ["先问他要不要复盘"] });

    const out = await call(tool, { action: "read", id: "lt_weekly_review" });
    expect(out.isError).toBe(false);
    const payload = asRead(out.json);
    expect(payload.action).toBe("read");
    expect(payload.task.id).toBe("lt_weekly_review");
    expect(payload.markdown).toContain("# 每周复盘");
    expect(payload.markdown).toContain("任务 ID：`lt_weekly_review`");
    expect(payload.markdown).toContain("## 意图");
    expect(payload.markdown).toContain("- 先问他要不要复盘");
    expect(detailsOf(out.result)["__long_task"]).toEqual({
      task: payload.task,
      markdown: payload.markdown,
    });
    expect(out.text.startsWith("# 每周复盘")).toBe(true);
    expect(out.text).toContain("lt_weekly_review");
    expect(out.text).not.toContain('"markdown":');
  });

  it("任务不存在：isError=true，LongTaskNotFoundError", async () => {
    const { tool } = fixture();
    const out = await call(tool, { action: "read", id: "lt_missing" });
    expect(out.isError).toBe(true);
    expect(errorOf(out)).toMatchObject({
      action: "read",
      error: "LongTaskNotFoundError",
    });
    expect(out.text).toContain("[long-task:not-found]");
  });

  it("id 非法或缺失：isError=true，LongTaskValidationError", async () => {
    const { tool } = fixture();
    const bad = await call(tool, { action: "read", id: "not-an-id" });
    expect(bad.isError).toBe(true);
    expect(errorOf(bad).error).toBe("LongTaskValidationError");

    const missing = await call(tool, { action: "read" });
    expect(missing.isError).toBe(true);
    expect(errorOf(missing).error).toBe("LongTaskValidationError");
  });
});

describe("坏参数兜底", () => {
  it("未知 action：isError=true，错误信封 action=unknown", async () => {
    const { tool } = fixture();
    const out = await call(tool, { action: "drop" });
    expect(out.isError).toBe(true);
    expect(errorOf(out)).toMatchObject({ ok: false, action: "unknown", error: "LongTaskValidationError" });
    expect(out.text).toContain("create|update|pause|resume|archive|list|read");
  });

  it("args 非对象：isError=true，不抛错", async () => {
    const { tool } = fixture();
    const out = await call(tool, null);
    expect(out.isError).toBe(true);
    expect(errorOf(out).error).toBe("LongTaskValidationError");
    expect(errorOf(out).message).toContain("args");
  });

  it("expected_version 非正整数：isError=true", async () => {
    const { tool } = fixture();
    await createTask(tool);
    const out = await call(tool, {
      action: "resume",
      id: "lt_weekly_review",
      expected_version: 0,
    });
    expect(out.isError).toBe(true);
    expect(errorOf(out).message).toContain("expectedVersion");
  });
});
