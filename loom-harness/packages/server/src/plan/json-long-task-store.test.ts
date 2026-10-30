/**
 * JsonLongTaskStore 验收：JSON 真源 + MD 派生、CAS、暂停/恢复/归档生命周期、
 * due 过滤、id/路径校验与原子落盘。全部使用 mkdtemp，不碰真实 ai/data。
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { JsonLongTaskStore } from "./json-long-task-store.js";
import {
  LongTaskArchivedError,
  LongTaskConflictError,
  LongTaskExistsError,
  LongTaskNotFoundError,
  LongTaskValidationError,
  renderLongTaskMarkdown,
  type LongTaskCadence,
  type LongTaskCreateInput,
  type LongTaskUpdatePatch,
} from "./long-task-store.js";

const NOW = Date.UTC(2026, 9, 27, 4, 0, 0);
const TODAY = "2026-10-27";
const ID = "lt_weekly_review";
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(prefix = "long-task-store-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function openStore(planRoot: string, clock = { now: NOW }): JsonLongTaskStore {
  return new JsonLongTaskStore({ planRoot, now: () => clock.now });
}

function tasksDirOf(root: string): string {
  return join(root, "plan", "long-tasks");
}

function jsonFileOf(root: string, id: string): string {
  return join(tasksDirOf(root), `${id}.json`);
}

function mdFileOf(root: string, id: string): string {
  return join(tasksDirOf(root), `${id}.md`);
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

function input(overrides: Partial<LongTaskCreateInput> = {}): LongTaskCreateInput {
  return {
    title: "每周复盘",
    intent: "每周把这一周收一下，定下周三件事",
    cadence: "weekly",
    next_check: TODAY,
    notes: ["先问他要不要复盘，不催"],
    ...overrides,
  };
}

describe("创建与读取", () => {
  it("创建后 JSON 与 MD 同时落盘，read 返回 JSON + 渲染 MD", async () => {
    const root = tempRoot();
    const store = openStore(root);
    const stamp = new Date(NOW).toISOString();

    const task = await store.create(input({ id: ID }));

    expect(task).toEqual({
      schema: 1,
      id: ID,
      title: "每周复盘",
      intent: "每周把这一周收一下，定下周三件事",
      cadence: "weekly",
      next_check: TODAY,
      last_done: null,
      status: "active",
      review_policy: "after_done",
      notes: ["先问他要不要复盘，不催"],
      created_at: stamp,
      updated_at: stamp,
      version: 1,
    });
    expect(readJson(jsonFileOf(root, ID))).toEqual(task);
    expect(readFileSync(mdFileOf(root, ID), "utf8")).toBe(renderLongTaskMarkdown(task));

    const read = await store.read(ID);
    expect(read.task).toEqual(task);
    expect(read.markdown).toBe(renderLongTaskMarkdown(task));
    expect(read.markdown).toContain(`# 每周复盘`);
    expect(read.markdown).toContain("## 意图");
  });

  it("缺省 id 由 title 派生，重名自动加后缀", async () => {
    const root = tempRoot();
    const store = openStore(root);

    const first = await store.create(input({ title: "每周复盘" }));
    const second = await store.create(input({ title: "每周复盘" }));
    const ascii = await store.create(input({ title: "Weekly Review!" }));

    expect(first.id).toBe("lt_task");
    expect(second.id).toBe("lt_task_2");
    expect(ascii.id).toBe("lt_weekly_review");
    expect(existsSync(jsonFileOf(root, first.id))).toBe(true);
  });

  it("重复 id 拒绝覆盖，重开 store 仍能看到旧记录", async () => {
    const root = tempRoot();
    const store = openStore(root);
    const created = await store.create(input({ id: ID }));

    await expect(store.create(input({ id: ID }))).rejects.toBeInstanceOf(
      LongTaskExistsError,
    );

    const reopened = openStore(root);
    expect((await reopened.read(ID)).task).toEqual(created);
    await expect(reopened.create(input({ id: ID }))).rejects.toBeInstanceOf(
      LongTaskExistsError,
    );
  });
});

describe("更新与 CAS", () => {
  it("update 推进 next_check，version 自增，created_at 不变", async () => {
    const clock = { now: NOW };
    const root = tempRoot();
    const store = openStore(root, clock);
    const created = await store.create(input({ id: ID }));

    clock.now = NOW + 60_000;
    const updated = await store.update(ID, 1, {
      next_check: "2026-11-03",
      title: "每周复盘（改）",
      last_done: TODAY,
    });

    expect(updated.version).toBe(2);
    expect(updated.next_check).toBe("2026-11-03");
    expect(updated.title).toBe("每周复盘（改）");
    expect(updated.last_done).toBe(TODAY);
    expect(updated.created_at).toBe(created.created_at);
    expect(updated.updated_at).toBe(new Date(NOW + 60_000).toISOString());
    expect(readJson(jsonFileOf(root, ID))).toEqual(updated);
    expect(readFileSync(mdFileOf(root, ID), "utf8")).toBe(
      renderLongTaskMarkdown(updated),
    );
  });

  it("stale version 抛冲突且不落盘", async () => {
    const root = tempRoot();
    const store = openStore(root);
    await store.create(input({ id: ID }));
    await store.update(ID, 1, { next_check: "2026-11-03" });

    await expect(store.update(ID, 1, { next_check: "2026-12-01" })).rejects.toMatchObject(
      { id: ID, expected: 1, actual: 2 },
    );
    await expect(store.update(ID, 1, { next_check: "2026-12-01" })).rejects.toBeInstanceOf(
      LongTaskConflictError,
    );

    const current = (await store.read(ID)).task;
    expect(current.version).toBe(2);
    expect(current.next_check).toBe("2026-11-03");
  });

  it("update 拒绝 status/id/版本等只读字段与空 patch", async () => {
    const root = tempRoot();
    const store = openStore(root);
    await store.create(input({ id: ID }));

    await expect(store.update(ID, 1, {} as LongTaskUpdatePatch)).rejects.toBeInstanceOf(
      LongTaskValidationError,
    );
    const withStatus = { status: "paused" } as unknown as LongTaskUpdatePatch;
    await expect(store.update(ID, 1, withStatus)).rejects.toBeInstanceOf(
      LongTaskValidationError,
    );
  });
});

describe("暂停/恢复/归档生命周期", () => {
  it("pause 保留 next_check，resume 恢复 active；until 改写 next_check", async () => {
    const root = tempRoot();
    const store = openStore(root);
    await store.create(input({ id: ID }));

    const paused = await store.pause(ID, 1);
    expect(paused.status).toBe("paused");
    expect(paused.next_check).toBe(TODAY);
    expect(paused.version).toBe(2);
    expect(await store.list({ due: "today", date: TODAY })).toEqual([]);

    const resumed = await store.resume(ID, 2);
    expect(resumed.status).toBe("active");
    expect(resumed.next_check).toBe(TODAY);
    expect((await store.list({ due: "today", date: TODAY })).map((row) => row.id)).toEqual([
      ID,
    ]);

    const pausedUntil = await store.pause(ID, 3, "2026-11-01");
    expect(pausedUntil.status).toBe("paused");
    expect(pausedUntil.next_check).toBe("2026-11-01");

    const resumedLater = await store.resume(ID, 4);
    expect(resumedLater.status).toBe("active");
    expect(resumedLater.next_check).toBe("2026-11-01");
  });

  it("archive 保留文件、仍可 read，后续变更被拒绝", async () => {
    const root = tempRoot();
    const store = openStore(root);
    await store.create(input({ id: ID }));

    const archived = await store.archive(ID, 1);
    expect(archived.status).toBe("archived");
    expect(archived.version).toBe(2);
    expect(existsSync(jsonFileOf(root, ID))).toBe(true);
    expect(existsSync(mdFileOf(root, ID))).toBe(true);

    const read = await store.read(ID);
    expect(read.task).toEqual(archived);
    expect(read.markdown).toContain("状态：archived");

    await expect(store.archive(ID, 2)).rejects.toBeInstanceOf(LongTaskArchivedError);
    await expect(store.update(ID, 2, { title: "改名" })).rejects.toBeInstanceOf(
      LongTaskArchivedError,
    );
    await expect(store.pause(ID, 2)).rejects.toBeInstanceOf(LongTaskArchivedError);
    await expect(store.resume(ID, 2)).rejects.toBeInstanceOf(LongTaskArchivedError);
  });
});

describe("list 过滤", () => {
  it("today 只含 active 且 next_check <= today；paused/archived 被排除", async () => {
    const root = tempRoot();
    const store = openStore(root);
    await store.create(input({ id: "lt_due_equal", next_check: "2026-10-26" }));
    await store.create(input({ id: "lt_due_today", next_check: TODAY }));
    await store.create(input({ id: "lt_due_future", next_check: "2026-10-29" }));
    const paused = await store.create(input({ id: "lt_paused_today", next_check: TODAY }));
    await store.pause("lt_paused_today", paused.version);
    const archived = await store.create(
      input({ id: "lt_archived_today", next_check: TODAY }),
    );
    await store.archive("lt_archived_today", archived.version);

    const today = await store.list({ due: "today", date: TODAY });
    expect(today.map((row) => row.id)).toEqual(["lt_due_equal", "lt_due_today"]);

    const active = await store.list({ due: "active" });
    expect(active.map((row) => row.id)).toEqual([
      "lt_due_equal",
      "lt_due_today",
      "lt_due_future",
    ]);

    const all = await store.list({ due: "all" });
    expect(all.map((row) => row.id)).toEqual([
      "lt_due_equal",
      "lt_archived_today",
      "lt_due_today",
      "lt_paused_today",
      "lt_due_future",
    ]);
    expect(await store.list()).toEqual(all);
    expect((await store.list({ due: "today", date: "2026-10-28" })).map((row) => row.id)).toEqual(
      ["lt_due_equal", "lt_due_today"],
    );
  });
});

describe("校验与路径安全", () => {
  it("constructor 拒绝空根/相对根，绝不猜测默认路径", () => {
    expect(() => new JsonLongTaskStore({ planRoot: "" })).toThrow(LongTaskValidationError);
    expect(() => new JsonLongTaskStore({ planRoot: "   " })).toThrow(
      LongTaskValidationError,
    );
    expect(() => new JsonLongTaskStore({ planRoot: "relative/plan" })).toThrow(
      /必须是绝对路径/,
    );
  });

  it("非法 id 与路径穿越一律拒绝，且不创建任何目录", async () => {
    const root = tempRoot();
    const store = openStore(root);

    await expect(store.create(input({ id: "lt_AB" }))).rejects.toBeInstanceOf(
      LongTaskValidationError,
    );
    await expect(store.create(input({ id: "lt_ab" }))).rejects.toBeInstanceOf(
      LongTaskValidationError,
    );
    await expect(store.create(input({ id: "../../escape" }))).rejects.toBeInstanceOf(
      LongTaskValidationError,
    );
    await expect(store.read("../../etc/passwd")).rejects.toBeInstanceOf(
      LongTaskValidationError,
    );

    expect(readdirSync(root)).toEqual([]);
  });

  it("拒绝指向 planRoot 之外的 plan/long-tasks 符号链接", async () => {
    const root = tempRoot();
    const outside = tempRoot("long-task-outside-");
    const store = openStore(root);
    mkdirSync(join(root, "plan"), { recursive: true });
    symlinkSync(outside, join(root, "plan", "long-tasks"), "dir");

    await expect(store.create(input({ id: ID }))).rejects.toBeInstanceOf(
      LongTaskValidationError,
    );
    expect(readdirSync(outside)).toEqual([]);
  });

  it("缺失文件抛 not-found，空根 list 为空且不建目录", async () => {
    const root = tempRoot();
    const store = openStore(root);

    await expect(store.read("lt_missing_1")).rejects.toBeInstanceOf(
      LongTaskNotFoundError,
    );
    expect(await store.list()).toEqual([]);
    expect(existsSync(join(root, "plan"))).toBe(false);
  });

  it("损坏 JSON、schema 不符、非法文件名 fail-loud", async () => {
    const root = tempRoot();
    const store = openStore(root);
    mkdirSync(tasksDirOf(root), { recursive: true });

    writeFileSync(jsonFileOf(root, "lt_broken_1"), "{not json");
    await expect(store.read("lt_broken_1")).rejects.toBeInstanceOf(
      LongTaskValidationError,
    );

    writeFileSync(
      jsonFileOf(root, "lt_broken_1"),
      JSON.stringify({ schema: 2, id: "lt_broken_1" }),
    );
    await expect(store.read("lt_broken_1")).rejects.toBeInstanceOf(
      LongTaskValidationError,
    );

    writeFileSync(join(tasksDirOf(root), "index.json"), "{}");
    await expect(store.list()).rejects.toBeInstanceOf(LongTaskValidationError);
  });

  it("日期与枚举非法时拒绝创建", async () => {
    const root = tempRoot();
    const store = openStore(root);

    await expect(
      store.create(input({ next_check: "2026-02-30" })),
    ).rejects.toBeInstanceOf(LongTaskValidationError);
    await expect(
      store.create(input({ next_check: "2026/10/27" })),
    ).rejects.toBeInstanceOf(LongTaskValidationError);
    await expect(
      store.create(input({ cadence: "yearly" as LongTaskCadence })),
    ).rejects.toBeInstanceOf(LongTaskValidationError);
    await expect(store.create(input({ title: "   " }))).rejects.toBeInstanceOf(
      LongTaskValidationError,
    );
  });
});
