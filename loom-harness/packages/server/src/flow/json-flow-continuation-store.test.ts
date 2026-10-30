/**
 * JsonFlowContinuationStore 验收（Todo 25）：
 * items/{id}.json 真源、一条目一条记录、冲突/not-found、时间校验、
 * 路径安全、原子写、重启水合，以及旧 flow/subjects 只读不动。
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
import {
  FlowContinuationConflictError,
  FlowContinuationNotFoundError,
  FlowValidationError,
} from "@axeuh/loom-core";

import {
  JsonFlowContinuationStore,
  JsonFlowStore,
} from "./index.js";

const NOW = Date.UTC(2026, 9, 28, 5, 0, 0);
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "flow-continuation-"));
  roots.push(root);
  return root;
}

function openStore(
  root: string,
  now: () => number = () => NOW,
): JsonFlowContinuationStore {
  return new JsonFlowContinuationStore({ stateRoot: root, now });
}

function flowDirOf(root: string, sessionId: string): string {
  return join(root, "session", sessionId, "flow");
}

function itemsDirOf(root: string, sessionId: string): string {
  return join(flowDirOf(root, sessionId), "items");
}

function itemFile(root: string, sessionId: string, id: string): string {
  return join(itemsDirOf(root, sessionId), `${id}.json`);
}

function subjectsDirOf(root: string, sessionId: string): string {
  return join(flowDirOf(root, sessionId), "subjects");
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

function snapshotDir(dir: string): readonly (readonly [string, string])[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .map((name) => [name, readFileSync(join(dir, name), "utf8")] as const);
}

function validWait(id = "c1"): {
  readonly id: string;
  readonly source: { readonly checkpoint_id: string };
  readonly waiting_on: string;
  readonly next_at: string;
} {
  return {
    id,
    source: { checkpoint_id: id },
    waiting_on: `等待 ${id}`,
    next_at: "30m",
  };
}

describe("创建/读取/生命周期与重启", () => {
  it("create -> wait -> resume -> close 逐次落盘，重启可读", async () => {
    const root = tempRoot();
    const clock = { now: NOW };
    const store = openStore(root, () => clock.now);

    const created = await store.create("s1", {
      id: "c1",
      source: { plan_date: "2026-10-28", checkpoint_id: "c1" },
      waiting_on: "材料照片就绪",
      next_at: "30m",
      close_condition: "照片上传",
      reason: "计划创建时登记",
    });
    expect(created).toMatchObject({
      schema: 1,
      id: "c1",
      source: { plan_date: "2026-10-28", checkpoint_id: "c1" },
      state: "waiting",
      waiting_on: "材料照片就绪",
      next_at: NOW + 1_800_000,
      close_condition: "照片上传",
      reason: "计划创建时登记",
      last_update: NOW,
    });
    expect(readJson(itemFile(root, "s1", "c1"))).toEqual(created);
    expect(await store.read("s1", "c1")).toEqual(created);

    clock.now = NOW + 1_000;
    const waited = await store.wait("s1", {
      id: "c1",
      waiting_on: "材料照片已选",
      next_at: "1h",
      reason: "照片已选未提交",
    });
    expect(waited).toMatchObject({
      state: "waiting",
      waiting_on: "材料照片已选",
      next_at: NOW + 1_000 + 3_600_000,
      close_condition: "照片上传",
      reason: "照片已选未提交",
      last_update: NOW + 1_000,
    });
    expect(readJson(itemFile(root, "s1", "c1"))).toEqual(waited);

    clock.now = NOW + 2_000;
    const resumed = await store.resume("s1", {
      id: "c1",
      reason: "检查点到了",
    });
    expect(resumed).toMatchObject({
      state: "active",
      waiting_on: null,
      next_at: null,
      close_condition: "照片上传",
      reason: "检查点到了",
      last_update: NOW + 2_000,
    });
    expect(readJson(itemFile(root, "s1", "c1"))).toEqual(resumed);

    clock.now = NOW + 3_000;
    const closed = await store.close("s1", { id: "c1", reason: "已完成" });
    expect(closed).toMatchObject({
      state: "closed",
      waiting_on: null,
      next_at: null,
      reason: "已完成",
      last_update: NOW + 3_000,
    });
    expect(readJson(itemFile(root, "s1", "c1"))).toEqual(closed);

    const reopened = openStore(root, () => clock.now);
    expect(await reopened.read("s1", "c1")).toEqual(closed);
    expect(await reopened.list("s1")).toEqual([closed]);
  });

  it("不同条目/不同 session 隔离；同一条目换 id 新建冲突", async () => {
    const root = tempRoot();
    const store = openStore(root);
    const first = await store.create("s1", {
      id: "c1",
      source: { checkpoint_id: "c1" },
      waiting_on: "照片就绪",
      next_at: "30m",
    });
    const second = await store.create("s1", {
      id: "c2",
      source: { checkpoint_id: "c2" },
      waiting_on: "家人回复",
      next_at: "1h",
    });
    const otherSession = await store.create("s2", {
      id: "c1",
      source: { checkpoint_id: "c1" },
      waiting_on: "另一个会话",
      next_at: "2h",
    });

    expect((await store.list("s1")).map((row) => row.id)).toEqual([
      "c1",
      "c2",
    ]);
    expect(await store.list("s2")).toEqual([otherSession]);
    expect(first.id).toBe("c1");
    expect(second.id).toBe("c2");

    await expect(
      store.create("s1", {
        id: "c3",
        source: { checkpoint_id: "c1" },
        waiting_on: "重复条目",
        next_at: "2h",
      }),
    ).rejects.toBeInstanceOf(FlowContinuationConflictError);
    await expect(
      store.wait("s1", {
        id: "c3",
        source: { checkpoint_id: "c1" },
        waiting_on: "重复条目",
        next_at: "2h",
      }),
    ).rejects.toBeInstanceOf(FlowContinuationConflictError);
    await expect(
      store.create("s1", {
        id: "c1",
        source: { checkpoint_id: "c9" },
        waiting_on: "重复 id",
        next_at: "2h",
      }),
    ).rejects.toBeInstanceOf(FlowContinuationConflictError);

    expect(readdirSync(itemsDirOf(root, "s1")).sort()).toEqual([
      "c1.json",
      "c2.json",
    ]);
    expect(readdirSync(itemsDirOf(root, "s2"))).toEqual(["c1.json"]);
  });

  it("同 id wait 更新；closed 后 wait/resume/close 均冲突，新 id 可继续同一条目", async () => {
    const store = openStore(tempRoot());
    await store.wait("s1", validWait("c1"));
    const updated = await store.wait("s1", {
      id: "c1",
      waiting_on: "继续等",
      next_at: "2h",
    });
    expect(updated.state).toBe("waiting");
    expect(updated.waiting_on).toBe("继续等");

    await store.close("s1", { id: "c1", reason: "完成" });
    await expect(
      store.wait("s1", validWait("c1")),
    ).rejects.toBeInstanceOf(FlowContinuationConflictError);
    await expect(
      store.resume("s1", { id: "c1" }),
    ).rejects.toBeInstanceOf(FlowContinuationConflictError);
    await expect(
      store.close("s1", { id: "c1", reason: "再关" }),
    ).rejects.toBeInstanceOf(FlowContinuationConflictError);

    const next = await store.create("s1", {
      id: "c2",
      source: { checkpoint_id: "c1" },
      waiting_on: "第二轮",
      next_at: "1h",
    });
    expect(next.id).toBe("c2");
    expect((await store.list("s1")).map((row) => row.state)).toEqual([
      "closed",
      "waiting",
    ]);
  });

  it("read 缺失抛 FlowContinuationNotFoundError", async () => {
    const store = openStore(tempRoot());
    await expect(store.read("s1", "missing")).rejects.toBeInstanceOf(
      FlowContinuationNotFoundError,
    );
  });
});

describe("输入校验", () => {
  it("waiting_on / next_at / source 非法时拒绝且不落盘", async () => {
    const root = tempRoot();
    const store = openStore(root);

    await expect(
      store.create("s1", {
        id: "c1",
        waiting_on: " ",
        next_at: "30m",
      }),
    ).rejects.toBeInstanceOf(FlowValidationError);
    await expect(
      store.create("s1", {
        id: "c1",
        waiting_on: "等",
        next_at: null,
      }),
    ).rejects.toBeInstanceOf(FlowValidationError);
    await expect(
      store.create("s1", {
        id: "c1",
        waiting_on: "等",
        next_at: "not-a-time",
      }),
    ).rejects.toBeInstanceOf(FlowValidationError);
    await expect(
      store.create("s1", {
        id: "c1",
        waiting_on: "等",
        next_at: Number.NaN,
      }),
    ).rejects.toBeInstanceOf(FlowValidationError);
    await expect(
      store.create("s1", {
        id: "c1",
        source: { checkpoint_id: "c1", open_loop_id: "o1" },
        waiting_on: "等",
        next_at: "30m",
      }),
    ).rejects.toBeInstanceOf(FlowValidationError);
    await expect(
      store.create("s1", {
        id: "c1",
        source: { plan_date: "10/28" },
        waiting_on: "等",
        next_at: "30m",
      }),
    ).rejects.toBeInstanceOf(FlowValidationError);

    expect(await store.list("s1")).toEqual([]);
    expect(existsSync(itemsDirOf(root, "s1"))).toBe(false);
  });

  it("close 的空 reason 被拒绝，记录保持 waiting", async () => {
    const store = openStore(tempRoot());
    await store.wait("s1", validWait("c1"));
    await expect(
      store.close("s1", { id: "c1", reason: " " }),
    ).rejects.toBeInstanceOf(FlowValidationError);
    expect((await store.read("s1", "c1")).state).toBe("waiting");
  });
});

describe("路径安全与损坏文件", () => {
  it("非法 session/id 一律拒绝且不创建路径", async () => {
    const root = tempRoot();
    const store = openStore(root);
    const badSessions = [
      "../evil",
      "..",
      ".",
      "/abs",
      "a/b",
      "a\\b",
      "a b",
      "a$",
      "x".repeat(129),
      "",
    ];
    for (const sessionId of badSessions) {
      await expect(store.list(sessionId)).rejects.toBeInstanceOf(
        FlowValidationError,
      );
      await expect(
        store.create(sessionId, validWait("c1")),
      ).rejects.toBeInstanceOf(FlowValidationError);
    }
    expect(existsSync(join(root, "session"))).toBe(false);

    await expect(store.read("s1", "../evil")).rejects.toBeInstanceOf(
      FlowValidationError,
    );
    await expect(
      store.create("s1", validWait("../evil")),
    ).rejects.toBeInstanceOf(FlowValidationError);
    await expect(
      store.create("s1", validWait("a/b")),
    ).rejects.toBeInstanceOf(FlowValidationError);
    await expect(
      store.create("s1", validWait("x".repeat(65))),
    ).rejects.toBeInstanceOf(FlowValidationError);
    expect(existsSync(join(root, "session"))).toBe(false);
  });

  it("拒绝指向 stateRoot 之外的 items 符号链接（读与写）", async () => {
    const outside = tempRoot();

    const readRoot = tempRoot();
    mkdirSync(join(readRoot, "session", "s1", "flow"), { recursive: true });
    symlinkSync(outside, join(readRoot, "session", "s1", "flow", "items"), "dir");
    expect(() => openStore(readRoot)).toThrow(FlowValidationError);

    const writeRoot = tempRoot();
    const writer = openStore(writeRoot);
    mkdirSync(join(writeRoot, "session", "s1", "flow"), { recursive: true });
    symlinkSync(outside, join(writeRoot, "session", "s1", "flow", "items"), "dir");
    await expect(
      writer.create("s1", validWait("c1")),
    ).rejects.toBeInstanceOf(FlowValidationError);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("损坏/身份不一致/状态不一致的记录让水合响亮失败", async () => {
    const root = tempRoot();
    const store = openStore(root);
    const created = await store.wait("s1", validWait("c1"));
    const file = itemFile(root, "s1", "c1");

    writeFileSync(file, "{", "utf8");
    expect(() => openStore(root)).toThrow(FlowValidationError);

    writeFileSync(
      file,
      JSON.stringify({ ...created, id: "other" }),
      "utf8",
    );
    expect(() => openStore(root)).toThrow(FlowValidationError);

    writeFileSync(
      file,
      JSON.stringify({ ...created, state: "active" }),
      "utf8",
    );
    expect(() => openStore(root)).toThrow(FlowValidationError);

    writeFileSync(file, JSON.stringify(created), "utf8");
    writeFileSync(join(itemsDirOf(root, "s1"), "bad name.json"), "{}", "utf8");
    expect(() => openStore(root)).toThrow(FlowValidationError);
  });
});

describe("旧 flow/subjects 只读不动", () => {
  it("持续记录读写不删除/不改写旧主体文件，旧 store 仍可读", async () => {
    const root = tempRoot();
    const legacyStore = new JsonFlowStore({
      stateRoot: root,
      now: () => NOW,
    });
    const legacy = await legacyStore.commit(
      "s1",
      { subject_name: "主线", state: "active" },
      { turn_idx: 1 },
    );
    const subjectsBefore = snapshotDir(subjectsDirOf(root, "s1"));
    const indexBefore = readFileSync(join(flowDirOf(root, "s1"), "index.json"), "utf8");
    expect(subjectsBefore).toHaveLength(1);

    const store = openStore(root);
    await store.create("s1", {
      id: "c1",
      source: { checkpoint_id: "c1" },
      waiting_on: "等消息",
      next_at: "30m",
    });
    await store.wait("s1", {
      id: "c1",
      waiting_on: "继续等",
      next_at: "1h",
    });
    await store.resume("s1", { id: "c1" });
    await store.close("s1", { id: "c1", reason: "完成" });

    expect(snapshotDir(subjectsDirOf(root, "s1"))).toEqual(subjectsBefore);
    expect(readFileSync(join(flowDirOf(root, "s1"), "index.json"), "utf8")).toBe(
      indexBefore,
    );
    expect(existsSync(itemFile(root, "s1", "c1"))).toBe(true);

    const reopenedLegacy = new JsonFlowStore({
      stateRoot: root,
      now: () => NOW,
    });
    const rows = await reopenedLegacy.list("s1");
    expect(rows.map((row) => row.subject_id)).toEqual([
      legacy.subject.subject_id,
    ]);
    expect(rows[0]?.subject_name).toBe("主线");
  });
});
