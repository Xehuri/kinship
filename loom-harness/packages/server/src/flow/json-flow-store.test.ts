/**
 * JsonFlowStore 验收：真源/派生索引/审计三层、原子写、重启水合、
 * 身份校验与 MemoryFlowStore 语义对齐。
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_FLOW_SUBJECT_NAME,
  FlowClosedError,
  FlowConflictError,
  FlowValidationError,
} from "@axeuh/loom-core";

import {
  FLOW_UNSET_ROTATE_BYTES,
  JsonFlowStore,
  type JsonFlowStoreOptions,
} from "./index.js";

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "flow-store-"));
  roots.push(root);
  return root;
}

function openStore(
  stateRoot: string,
  options: Pick<JsonFlowStoreOptions, "now" | "idFactory"> = {},
): JsonFlowStore {
  return new JsonFlowStore({
    stateRoot,
    now: options.now ?? (() => NOW),
    ...(options.idFactory === undefined ? {} : { idFactory: options.idFactory }),
  });
}

function idSequence(...values: string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index] ?? values[values.length - 1];
    index += 1;
    if (value === undefined) throw new Error("idSequence 需要至少一个 id");
    return value;
  };
}

function flowDirOf(root: string, sessionId: string): string {
  return join(root, "session", sessionId, "flow");
}

function subjectsDirOf(root: string, sessionId: string): string {
  return join(flowDirOf(root, sessionId), "subjects");
}

function subjectFile(root: string, sessionId: string, subjectId: string): string {
  return join(subjectsDirOf(root, sessionId), `${subjectId}.json`);
}

function indexFile(root: string, sessionId: string): string {
  return join(flowDirOf(root, sessionId), "index.json");
}

function unsetFile(root: string, sessionId: string): string {
  return join(flowDirOf(root, sessionId), "unset.jsonl");
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

describe("创建/更新/读取与重启", () => {
  it("完整字段落盘，更新后文件同步，重启可读写", async () => {
    const root = tempRoot();
    const clock = { now: NOW };
    const store = openStore(root, { now: () => clock.now });
    const parent = await store.commit(
      "s1",
      { subject_name: "父", state: "active" },
      { turn_idx: 1 },
    );
    clock.now = NOW + 1_000;
    const dueAt = Date.UTC(2026, 9, 25, 12, 0, 0);
    const created = await store.commit(
      "s1",
      {
        subject_name: "子",
        kind: "task",
        title: "重构音频链路",
        description: "把重采样移到内核",
        focus: "parked",
        notes_append: ["第一条"],
        notes_ref: "notes/child.md",
        state: "waiting_event",
        next_decision_at: "30m",
        soft_deadline: "2026-10-24T12:00:00Z",
        due_at: dueAt,
        timezone: "Asia/Shanghai",
        schedule: "daily 09:00",
        parent_id: parent.subject.subject_id,
      },
      { turn_idx: 2 },
    );
    expect(created.created).toBe(true);
    const file = subjectFile(root, "s1", created.subject.subject_id);
    expect(readJson(file)).toEqual(created.subject);

    clock.now = NOW + 2_000;
    const updated = await store.commit(
      "s1",
      {
        subject_id: created.subject.subject_id,
        state: "active",
        expected_version: 1,
        notes_append: ["第二条"],
        focus: "background",
      },
      { turn_idx: 3 },
    );
    expect(updated.subject.version).toBe(2);
    expect(readJson(file)).toEqual(updated.subject);

    const reopened = openStore(root, { now: () => clock.now });
    expect(await reopened.list("s1")).toEqual([parent.subject, updated.subject]);
    expect(await reopened.get(created.subject.subject_id)).toEqual(updated.subject);
    expect(await reopened.findByName("s1", "子")).toEqual(updated.subject);
    expect(await reopened.findByName("s1", "不存在")).toBeNull();
    expect(await reopened.get("flow_ffffffffffff")).toBeNull();
    expect(readJson(indexFile(root, "s1"))).toMatchObject({
      schema: 1,
      session_id: "s1",
      subject_ids: [parent.subject.subject_id, created.subject.subject_id],
    });
  });

  it("CAS 冲突不落盘，重启后仍停在旧版本", async () => {
    const root = tempRoot();
    const store = openStore(root);
    const created = await store.commit(
      "s1",
      { subject_name: "甲", state: "active" },
      { turn_idx: 1 },
    );
    await expect(
      store.commit(
        "s1",
        { subject_id: created.subject.subject_id, state: "waiting_user", expected_version: 2 },
        { turn_idx: 2 },
      ),
    ).rejects.toBeInstanceOf(FlowConflictError);
    const file = subjectFile(root, "s1", created.subject.subject_id);
    expect(readJson(file)).toMatchObject({ version: 1, state: "active" });

    const reopened = openStore(root);
    expect((await reopened.get(created.subject.subject_id))?.version).toBe(1);
    const accepted = await reopened.commit(
      "s1",
      { subject_id: created.subject.subject_id, state: "waiting_user", expected_version: 1 },
      { turn_idx: 3 },
    );
    expect(accepted.subject.version).toBe(2);
    expect((await openStore(root).get(created.subject.subject_id))?.version).toBe(2);
  });

  it("closed 主体拒绝后续提交并可跨重启保持", async () => {
    const root = tempRoot();
    const store = openStore(root);
    const created = await store.commit(
      "s1",
      { subject_name: "关闭", state: "active" },
      { turn_idx: 1 },
    );
    const closed = await store.commit(
      "s1",
      {
        subject_id: created.subject.subject_id,
        state: "closed",
        expected_version: 1,
        close_reason: "完成",
      },
      { turn_idx: 2 },
    );
    expect(closed.subject).toMatchObject({ state: "closed", closed_at: NOW });

    await expect(
      store.commit(
        "s1",
        { subject_id: created.subject.subject_id, state: "active", expected_version: 2 },
        { turn_idx: 3 },
      ),
    ).rejects.toBeInstanceOf(FlowClosedError);

    const reopened = openStore(root);
    expect((await reopened.get(created.subject.subject_id))?.state).toBe("closed");
    await expect(
      reopened.commit(
        "s1",
        { subject_id: created.subject.subject_id, state: "active", expected_version: 2 },
        { turn_idx: 4 },
      ),
    ).rejects.toBeInstanceOf(FlowClosedError);
  });
});

describe("派生索引", () => {
  it("index 损坏/陈旧/缺失时以主体文件重建（索引非真源）", async () => {
    const root = tempRoot();
    const store = openStore(root, {
      idFactory: idSequence("flow_000000000001", "flow_000000000002"),
    });
    const a = await store.commit("s1", { subject_name: "A", state: "active" }, { turn_idx: 1 });
    const b = await store.commit("s1", { subject_name: "B", state: "active" }, { turn_idx: 2 });

    writeFileSync(indexFile(root, "s1"), "{ not json", "utf8");
    const rebuilt = openStore(root);
    expect((await rebuilt.list("s1")).map((row) => row.subject_id)).toEqual([
      a.subject.subject_id,
      b.subject.subject_id,
    ]);
    expect(readJson(indexFile(root, "s1"))).toMatchObject({
      subject_ids: [a.subject.subject_id, b.subject.subject_id],
    });

    writeFileSync(
      indexFile(root, "s1"),
      JSON.stringify({
        schema: 1,
        session_id: "s1",
        subject_ids: ["flow_ffffffffffff", a.subject.subject_id],
      }),
      "utf8",
    );
    const stale = openStore(root);
    expect((await stale.list("s1")).map((row) => row.subject_id)).toEqual([
      a.subject.subject_id,
      b.subject.subject_id,
    ]);

    rmSync(indexFile(root, "s1"));
    const missing = openStore(root);
    expect(await missing.list("s1")).toHaveLength(2);
    expect(existsSync(indexFile(root, "s1"))).toBe(true);
  });

  it("损坏的主体 JSON 抛 FlowValidationError，不静默丢行", async () => {
    const root = tempRoot();
    const store = openStore(root);
    const created = await store.commit(
      "s1",
      { subject_name: "坏", state: "active" },
      { turn_idx: 1 },
    );
    const file = subjectFile(root, "s1", created.subject.subject_id);

    writeFileSync(file, "{", "utf8");
    expect(() => openStore(root)).toThrow(FlowValidationError);

    writeFileSync(file, JSON.stringify({ ...created.subject, state: "paused" }), "utf8");
    expect(() => openStore(root)).toThrow(FlowValidationError);

    writeFileSync(
      file,
      JSON.stringify({ ...created.subject, subject_id: "flow_zzzzzzzzzzzz" }),
      "utf8",
    );
    expect(() => openStore(root)).toThrow(FlowValidationError);
  });
});

describe("身份与路径安全", () => {
  it("非法 session/subject id 一律拒绝且不落任何路径", async () => {
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
      await expect(store.list(sessionId)).rejects.toBeInstanceOf(FlowValidationError);
      await expect(
        store.commit(sessionId, { subject_name: "A", state: "active" }, { turn_idx: 1 }),
      ).rejects.toBeInstanceOf(FlowValidationError);
      await expect(store.ensureDefault(sessionId)).rejects.toBeInstanceOf(FlowValidationError);
      await expect(store.findByName(sessionId, "A")).rejects.toBeInstanceOf(FlowValidationError);
      await expect(store.earliestPending(sessionId)).rejects.toBeInstanceOf(FlowValidationError);
      await expect(
        store.appendUnset(sessionId, {
          turn_idx: 1,
          reason: "no_commit",
          had_tool_results: false,
        }),
      ).rejects.toBeInstanceOf(FlowValidationError);
    }
    expect(existsSync(join(root, "session"))).toBe(false);

    await expect(
      store.commit(
        "s1",
        { subject_id: "../evil", state: "active", expected_version: 1 },
        { turn_idx: 1 },
      ),
    ).rejects.toBeInstanceOf(FlowValidationError);
    expect(await store.get("../../etc/passwd")).toBeNull();
  });

  it("拒绝指向 stateRoot 之外的符号链接（读与写）", async () => {
    const outside = tempRoot();

    const readRoot = tempRoot();
    mkdirSync(join(readRoot, "session", "s1"), { recursive: true });
    symlinkSync(outside, join(readRoot, "session", "s1", "flow"), "dir");
    expect(() => openStore(readRoot)).toThrow(FlowValidationError);

    const writeRoot = tempRoot();
    const writer = openStore(writeRoot);
    mkdirSync(join(writeRoot, "session", "s1"), { recursive: true });
    symlinkSync(outside, join(writeRoot, "session", "s1", "flow"), "dir");
    await expect(
      writer.commit("s1", { subject_name: "A", state: "active" }, { turn_idx: 1 }),
    ).rejects.toBeInstanceOf(FlowValidationError);

    const fileRoot = tempRoot();
    const source = openStore(fileRoot);
    const created = await source.commit(
      "s1",
      { subject_name: "A", state: "active" },
      { turn_idx: 1 },
    );
    const target = join(outside, `${created.subject.subject_id}.json`);
    writeFileSync(target, JSON.stringify(created.subject), "utf8");
    const link = subjectFile(fileRoot, "s1", created.subject.subject_id);
    unlinkSync(link);
    symlinkSync(target, link);
    expect(() => openStore(fileRoot)).toThrow(FlowValidationError);
  });

  it("session 目录名非法（但含 flow 数据）时拒绝加载", () => {
    const root = tempRoot();
    mkdirSync(join(root, "session", "bad name", "flow"), { recursive: true });
    expect(() => openStore(root)).toThrow(FlowValidationError);
  });
});

describe("原子写", () => {
  it("主体写失败清理 tmp，重试后只剩完整文件", async () => {
    const root = tempRoot();
    const subjectId = "flow_00000000000a";
    const store = openStore(root, { idFactory: () => subjectId });
    const blocker = subjectFile(root, "s1", subjectId);
    mkdirSync(blocker, { recursive: true });
    writeFileSync(join(blocker, "keep"), "x", "utf8");

    await expect(
      store.commit("s1", { subject_name: "原子", state: "active" }, { turn_idx: 1 }),
    ).rejects.toThrow();
    const leftovers = readdirSync(subjectsDirOf(root, "s1")).filter((name) =>
      name.endsWith(".tmp"),
    );
    expect(leftovers).toEqual([]);

    rmSync(blocker, { recursive: true, force: true });
    const retried = await store.commit(
      "s1",
      { subject_name: "原子", state: "active" },
      { turn_idx: 1 },
    );
    expect(retried.created).toBe(false);
    expect(readJson(subjectFile(root, "s1", subjectId))).toMatchObject({ subject_name: "原子" });
    expect(await openStore(root).list("s1")).toHaveLength(1);
  });
});

describe("会话/主体隔离与默认主体", () => {
  it("多 session、多主体互不串线且重启一致", async () => {
    const root = tempRoot();
    const store = openStore(root);
    const a = await store.commit("s1", { subject_name: "A", state: "active" }, { turn_idx: 1 });
    const b = await store.commit(
      "s1",
      { subject_name: "B", state: "waiting_user" },
      { turn_idx: 2 },
    );
    const c = await store.commit("s2", { subject_name: "C", state: "active" }, { turn_idx: 3 });

    expect((await store.list("s1")).map((row) => row.subject_name)).toEqual(["A", "B"]);
    expect((await store.list("s2")).map((row) => row.subject_name)).toEqual(["C"]);
    expect(await store.findByName("s2", "A")).toBeNull();

    const reopened = openStore(root);
    expect((await reopened.list("s1")).map((row) => row.subject_name)).toEqual(["A", "B"]);
    expect((await reopened.list("s2")).map((row) => row.subject_name)).toEqual(["C"]);
    expect(await reopened.get(a.subject.subject_id)).toEqual(a.subject);
    expect(await reopened.get(b.subject.subject_id)).toEqual(b.subject);
    expect(await reopened.get(c.subject.subject_id)).toEqual(c.subject);
  });

  it("ensureDefault 零主体建「主线」，重复幂等，有他行则不建", async () => {
    const root = tempRoot();
    const store = openStore(root);
    const first = await store.ensureDefault("s1");
    if (first === null) throw new Error("expected default subject");
    expect(first).toMatchObject({
      subject_name: DEFAULT_FLOW_SUBJECT_NAME,
      state: "active",
      focus: "foreground",
      version: 1,
      last_commit: null,
      next_decision_at: null,
    });
    expect(existsSync(subjectFile(root, "s1", first.subject_id))).toBe(true);

    const reopened = openStore(root);
    const again = await reopened.ensureDefault("s1");
    expect(again?.subject_id).toBe(first.subject_id);

    const other = await store.commit(
      "s2",
      { subject_name: "其他", state: "active" },
      { turn_idx: 1 },
    );
    expect(await store.ensureDefault("s2")).toBeNull();
    expect((await store.list("s2")).map((row) => row.subject_name)).toEqual(["其他"]);
    expect(await store.get(other.subject.subject_id)).not.toBeNull();
  });
});

describe("unset 审计", () => {
  it("追加行可跨重启恢复，达到 1MB 轮转一次", async () => {
    const root = tempRoot();
    const store = openStore(root);
    const first = await store.appendUnset("s1", {
      turn_idx: 1,
      reason: "no_commit",
      had_tool_results: false,
    });
    expect(readFileSync(unsetFile(root, "s1"), "utf8")).toContain(JSON.stringify(first));

    const reopened = openStore(root);
    expect(await reopened.listSessionIds()).toEqual(["s1"]);
    await reopened.appendUnset("s1", {
      turn_idx: 2,
      reason: "run_end_no_commit",
      had_tool_results: true,
    });
    expect(
      readFileSync(unsetFile(root, "s1"), "utf8").trim().split("\n"),
    ).toHaveLength(2);

    const bulkLine = `${JSON.stringify({
      schema: 1,
      session_id: "s2",
      at: NOW,
      turn_idx: 1,
      reason: "no_commit",
      had_tool_results: false,
    })}\n`;
    const bulk = bulkLine.repeat(
      Math.ceil((FLOW_UNSET_ROTATE_BYTES + 1_024) / Buffer.byteLength(bulkLine, "utf8")),
    );
    mkdirSync(flowDirOf(root, "s2"), { recursive: true });
    writeFileSync(unsetFile(root, "s2"), bulk, "utf8");

    const rotated = openStore(root);
    await rotated.appendUnset("s2", {
      turn_idx: 2,
      reason: "no_commit",
      had_tool_results: false,
    });
    const archive = join(flowDirOf(root, "s2"), "unset.jsonl.1");
    expect(existsSync(archive)).toBe(true);
    expect(statSync(archive).size).toBeGreaterThan(FLOW_UNSET_ROTATE_BYTES);
    expect(readFileSync(unsetFile(root, "s2"), "utf8").trim().split("\n")).toHaveLength(1);
    expect(new Set(await openStore(root).listSessionIds())).toEqual(new Set(["s1", "s2"]));
  });
});

describe("earliestPending", () => {
  it("跳过 closed，按 next_decision_at 取最早；过期照常返回并跨重启保持", async () => {
    const root = tempRoot();
    const clock = { now: NOW };
    const store = openStore(root, { now: () => clock.now });
    const later = await store.commit(
      "s1",
      { subject_name: "晚", state: "active", next_decision_at: "10m" },
      { turn_idx: 1 },
    );
    const sooner = await store.commit(
      "s1",
      { subject_name: "早", state: "waiting_user", next_decision_at: "5m" },
      { turn_idx: 2 },
    );
    await store.commit("s1", { subject_name: "无时间", state: "waiting_event" }, { turn_idx: 3 });
    await store.commit("s2", { subject_name: "关闭", state: "closed" }, { turn_idx: 4 });

    expect((await store.earliestPending("s1"))?.subject_id).toBe(sooner.subject.subject_id);
    expect(await store.earliestPending("s2")).toBeNull();

    clock.now = NOW + 60 * 60_000;
    expect((await store.earliestPending("s1"))?.subject_id).toBe(sooner.subject.subject_id);
    expect((await store.earliestPending("s1"))?.version).toBe(1);
    expect(later.subject.next_decision_at).toBeGreaterThan(sooner.subject.next_decision_at ?? 0);

    const reopened = openStore(root, { now: () => clock.now });
    expect((await reopened.earliestPending("s1"))?.subject_id).toBe(sooner.subject.subject_id);
  });
});
