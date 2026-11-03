/**
 * T4 inbox pull tools：主会话守卫、list 无正文、read 截断/标记、ack 证据与幂等、
 * defer 上限、未知 id 整批拒绝。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HarnessTool, HookContext, ToolExecResult } from "@axeuh/loom-core";

import type { InboxConfig } from "../config/section-checks.js";
import { InboxJournalStore } from "./journal-store.js";
import { INBOX_TOOL_LIMITS, createInboxTools } from "./tools.js";
import type { LetterInput } from "./types.js";

const SESSION = "ses_inbox_main";
const T0 = Date.UTC(2026, 10, 2, 12, 0, 0);

let root = "";
let clock = T0;
let seq = 0;
let store: InboxJournalStore;

const CONFIG: InboxConfig = {
  mode: "live",
  sources: { svc: { maxTrust: "user", maxClass: "interrupt" } },
  autoAckKinds: ["fyi"],
};

function input(overrides: Partial<LetterInput> = {}): LetterInput {
  return {
    source: "svc",
    kind: "action",
    class: "notify",
    trust: "user",
    principal: "tools-test",
    body: "letter body",
    ...overrides,
  };
}

function add(overrides: Partial<LetterInput> = {}): string {
  const result = store.append(input(overrides), { now: clock });
  if (result.outcome !== "received") throw new Error(`expected received, got ${result.outcome}`);
  return result.record.id;
}

function makeStore(): InboxJournalStore {
  return new InboxJournalStore({
    stateRoot: root,
    sessionId: SESSION,
    now: () => clock,
    idFactory: () => `l${String(++seq)}`,
    validation: { maxBodyBytes: 128 * 1024 },
  });
}

function makeTools(config: InboxConfig = CONFIG): Map<string, HarnessTool> {
  return new Map(
    createInboxTools({
      store,
      config,
      sessionID: SESSION,
      now: () => clock,
    }).map((tool) => [tool.name, tool]),
  );
}

function ctx(sessionId = SESSION): HookContext {
  return { sessionId } as unknown as HookContext;
}

async function call(
  tools: Map<string, HarnessTool>,
  name: string,
  args: Record<string, unknown>,
  sessionId = SESSION,
): Promise<{ text: string; json: Record<string, unknown> }> {
  const tool = tools.get(name);
  if (tool === undefined) throw new Error(`missing tool ${name}`);
  const result: ToolExecResult = await tool.execute(args, ctx(sessionId), new AbortController().signal);
  const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
  return { text, json: JSON.parse(text) as Record<string, unknown> };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "loom-inbox-tools-"));
  clock = T0;
  seq = 0;
  store = makeStore();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("inbox tool guard", () => {
  it("非配置主会话调用四件工具全部拒绝，错误不含正文", async () => {
    const id = add({ body: "TOP-SECRET-BODY" });
    const tools = makeTools();
    const cases: Array<[string, Record<string, unknown>]> = [
      ["inbox_list", {}],
      ["inbox_read", { ids: [id] }],
      ["inbox_ack", { ids: [id], outcome: "acted", evidence_ref: "e" }],
      ["inbox_defer", { ids: [id], until: T0 + 60_000 }],
    ];
    for (const [name, args] of cases) {
      await expect(call(tools, name, args, "ses_child_1")).rejects.toThrow(
        /only available to the configured inbox main session/,
      );
    }
    await expect(call(tools, "inbox_read", { ids: [id] }, "ses_child_1")).rejects.not.toThrow(
      /TOP-SECRET-BODY/,
    );
  });
});

describe("inbox_list", () => {
  it("按线程聚合未读，只返回线程元数据，绝不返回正文或信件 id", async () => {
    add({
      thread_id: "g1",
      thread_name: "群一",
      thread_kind: "group",
      principal: "123",
      body: "SECRET-GROUP-1",
    });
    clock += 1000;
    add({
      thread_id: "g1",
      thread_name: "群一",
      thread_kind: "group",
      principal: "123",
      body: "SECRET-GROUP-2",
    });
    clock += 1000;
    add({
      thread_id: "u9",
      thread_name: "小明",
      thread_kind: "contact",
      principal: "u9",
      body: "SECRET-DM",
    });
    const tools = makeTools();
    const { json, text } = await call(tools, "inbox_list", {});
    expect(text).not.toContain("SECRET-GROUP-1");
    expect(text).not.toContain("SECRET-GROUP-2");
    expect(text).not.toContain("SECRET-DM");
    expect(json["as_of"]).toBe(clock);
    expect(json["total_unread"]).toBe(3);
    expect(json["truncated"]).toBe(false);
    const threads = json["threads"] as Array<Record<string, unknown>>;
    expect(threads).toEqual([
      {
        source: "svc",
        thread_id: "u9",
        thread_name: "小明",
        thread_kind: "contact",
        unread: 1,
        latest_at: T0 + 2000,
        oldest_unread_at: T0 + 2000,
      },
      {
        source: "svc",
        thread_id: "g1",
        thread_name: "群一",
        thread_kind: "group",
        unread: 2,
        latest_at: T0 + 1000,
        oldest_unread_at: T0,
      },
    ]);
    for (const thread of threads) {
      expect("body" in thread).toBe(false);
      expect("id" in thread).toBe(false);
      expect("title" in thread).toBe(false);
    }
  });

  it("只有 read/acked/observed 的线程不出现在邮箱概览", async () => {
    const readId = add({ thread_id: "read", thread_name: "已读", thread_kind: "group" });
    const tools = makeTools();
    await call(tools, "inbox_read", { ids: [readId] });
    const ackId = add({
      kind: "fyi",
      thread_id: "acked",
      thread_name: "已确认",
      thread_kind: "group",
    });
    await call(tools, "inbox_ack", { ids: [ackId], outcome: "no_action" });
    store.recordObserved(
      input({ thread_id: "obs", thread_name: "旁路", thread_kind: "group" }),
      { now: clock },
    );
    const { json } = await call(tools, "inbox_list", {});
    expect(json["total_unread"]).toBe(0);
    expect(json["threads"]).toEqual([]);
    expect(json["truncated"]).toBe(false);
  });

  it("线程按 latest_at 倒序，limit 截断线程但 total_unread 为截断前总和", async () => {
    add({ thread_id: "a", thread_name: "A", thread_kind: "group" });
    clock += 1000;
    add({ thread_id: "b", thread_name: "B", thread_kind: "group" });
    clock += 1000;
    add({ thread_id: "b", thread_name: "B", thread_kind: "group" });
    clock += 1000;
    add({ thread_id: "c", thread_name: "C", thread_kind: "group" });
    const tools = makeTools();
    const { json } = await call(tools, "inbox_list", { limit: 2 });
    expect(json["total_unread"]).toBe(4);
    expect(json["truncated"]).toBe(true);
    const threads = json["threads"] as Array<Record<string, unknown>>;
    expect(threads.map((thread) => thread["thread_id"])).toEqual(["c", "b"]);
  });

  it("无 thread 元数据时按 source+principal 回退归组，名称/类别取最新有值者", async () => {
    add({ principal: "alice" });
    clock += 1000;
    add({ principal: "alice" });
    clock += 1000;
    add({ principal: "bob" });
    clock += 1000;
    add({ source: "other", principal: "alice" });
    clock += 1000;
    add({
      principal: "carol",
      thread_id: "c1",
      thread_name: "Carol",
      thread_kind: "group",
    });
    clock += 1000;
    add({ principal: "carol", thread_id: "c1" });
    const tools = makeTools();
    const { json } = await call(tools, "inbox_list", {});
    const threads = json["threads"] as Array<Record<string, unknown>>;
    expect(threads).toHaveLength(4);
    expect(threads.find((thread) => thread["thread_id"] === "svc:alice")).toMatchObject({
      thread_name: "alice",
      thread_kind: "contact",
      unread: 2,
    });
    expect(threads.some((thread) => thread["thread_id"] === "svc:bob")).toBe(true);
    expect(threads.some((thread) => thread["thread_id"] === "other:alice")).toBe(true);
    expect(threads.find((thread) => thread["thread_id"] === "c1")).toMatchObject({
      thread_name: "Carol",
      thread_kind: "group",
      unread: 2,
    });
  });

  it("source 与 thread_kind 过滤同时影响 visible threads 与 total_unread", async () => {
    add({ source: "svc", thread_id: "g1", thread_name: "群", thread_kind: "group" });
    clock += 1000;
    add({ source: "other", thread_id: "dm1", thread_name: "私聊", thread_kind: "dm" });
    clock += 1000;
    add({ source: "other", thread_id: "g2", thread_name: "群二", thread_kind: "group" });
    const tools = makeTools();
    const bySource = await call(tools, "inbox_list", { source: "other" });
    expect(bySource.json["total_unread"]).toBe(2);
    expect(
      (bySource.json["threads"] as Array<Record<string, unknown>>).map(
        (thread) => thread["thread_id"],
      ),
    ).toEqual(["g2", "dm1"]);
    const byKind = await call(tools, "inbox_list", { thread_kind: "group" });
    expect(byKind.json["total_unread"]).toBe(2);
    expect(
      (byKind.json["threads"] as Array<Record<string, unknown>>).map(
        (thread) => thread["thread_id"],
      ),
    ).toEqual(["g2", "g1"]);
  });
});

describe("inbox_read", () => {
  it("按 id 返回正文并标记 read（不改 ack），回填线程字段", async () => {
    const id = add({ body: "hello body", thread_id: "g1", thread_name: "群一", thread_kind: "group" });
    const tools = makeTools();
    const before = store.size;
    const { json } = await call(tools, "inbox_read", { ids: [id] });
    const letters = json["letters"] as Array<Record<string, unknown>>;
    expect(letters[0]).toMatchObject({
      id,
      body: "hello body",
      truncated: false,
      state: "read",
      thread_id: "g1",
      thread_name: "群一",
      thread_kind: "group",
    });
    expect(store.get(id)?.state).toBe("read");
    expect(store.get(id)?.acked_at).toBeUndefined();
    expect(store.size).toBe(before + 1);
  });

  it("重复 read 不重复写 read 事件", async () => {
    const id = add();
    const tools = makeTools();
    await call(tools, "inbox_read", { ids: [id] });
    const size = store.size;
    await call(tools, "inbox_read", { ids: [id] });
    expect(store.size).toBe(size);
  });

  it("超过 64KB 的正文截断且 truncated=true", async () => {
    const body = "x".repeat(70 * 1024);
    const id = add({ body });
    const tools = makeTools();
    const { json } = await call(tools, "inbox_read", { ids: [id] });
    const letters = json["letters"] as Array<Record<string, unknown>>;
    expect(letters[0]?.["truncated"]).toBe(true);
    expect(Buffer.byteLength(String(letters[0]?.["body"]), "utf8")).toBeLessThanOrEqual(
      INBOX_TOOL_LIMITS.readMaxBodyBytes,
    );
  });

  it("未知 id 整批拒绝且已知信不被标记 read", async () => {
    const id = add();
    const tools = makeTools();
    await expect(call(tools, "inbox_read", { ids: [id, "missing"] })).rejects.toThrow(
      /unknown letter id\(s\): missing/,
    );
    expect(store.get(id)?.state).toBe("pending");
  });

  it("按线程批量读取：旧到新返回、标记 read、未读线程消失", async () => {
    const first = add({
      body: "first",
      thread_id: "g1",
      thread_name: "群一",
      thread_kind: "group",
    });
    clock += 1000;
    const second = add({
      body: "second",
      thread_id: "g1",
      thread_name: "群一",
      thread_kind: "group",
    });
    const tools = makeTools();
    const { json } = await call(tools, "inbox_read", { source: "svc", thread_id: "g1" });
    const letters = json["letters"] as Array<Record<string, unknown>>;
    expect(letters.map((letter) => letter["id"])).toEqual([first, second]);
    expect(letters[0]).toMatchObject({
      body: "first",
      thread_id: "g1",
      thread_name: "群一",
      thread_kind: "group",
      state: "read",
    });
    expect(json["truncated"]).toBe(false);
    expect(json["remaining"]).toBe(0);
    expect(store.get(first)?.state).toBe("read");
    expect(store.get(second)?.state).toBe("read");
    const mailbox = await call(tools, "inbox_list", {});
    expect(mailbox.json["total_unread"]).toBe(0);
    expect(mailbox.json["threads"]).toEqual([]);
  });

  it("线程读取默认跳过 read 与终态；include_read=true 只额外纳入 read", async () => {
    const old = add({ thread_id: "g1", thread_name: "群一", thread_kind: "group" });
    const tools = makeTools();
    await call(tools, "inbox_read", { ids: [old] });
    const acked = add({ kind: "fyi", thread_id: "g1", thread_name: "群一", thread_kind: "group" });
    await call(tools, "inbox_ack", { ids: [acked], outcome: "no_action" });
    clock += 1000;
    const fresh = add({ thread_id: "g1", thread_name: "群一", thread_kind: "group" });

    const unreadOnly = await call(tools, "inbox_read", { source: "svc", thread_id: "g1" });
    expect(
      (unreadOnly.json["letters"] as Array<Record<string, unknown>>).map((letter) => letter["id"]),
    ).toEqual([fresh]);

    const withRead = await call(tools, "inbox_read", {
      source: "svc",
      thread_id: "g1",
      include_read: true,
    });
    expect(
      (withRead.json["letters"] as Array<Record<string, unknown>>).map((letter) => letter["id"]),
    ).toEqual([old, fresh]);
  });

  it("线程读取 limit 取最旧优先，truncated/remaining 反映未返回数量", async () => {
    const ids = [add({ thread_id: "g1" })];
    clock += 1000;
    ids.push(add({ thread_id: "g1" }));
    clock += 1000;
    ids.push(add({ thread_id: "g1" }));
    const tools = makeTools();
    const { json } = await call(tools, "inbox_read", {
      source: "svc",
      thread_id: "g1",
      limit: 2,
    });
    const letters = json["letters"] as Array<Record<string, unknown>>;
    expect(letters.map((letter) => letter["id"])).toEqual([ids[0], ids[1]]);
    expect(json["truncated"]).toBe(true);
    expect(json["remaining"]).toBe(1);
    expect(store.get(ids[0]!)?.state).toBe("read");
    expect(store.get(ids[1]!)?.state).toBe("read");
    expect(store.get(ids[2]!)?.state).toBe("pending");
    const mailbox = await call(tools, "inbox_list", {});
    expect(mailbox.json["total_unread"]).toBe(1);
  });

  it("mark_read=false 不写 read 事件", async () => {
    const id = add({ thread_id: "g1" });
    const tools = makeTools();
    const before = store.size;
    const { json } = await call(tools, "inbox_read", {
      source: "svc",
      thread_id: "g1",
      mark_read: false,
    });
    const letters = json["letters"] as Array<Record<string, unknown>>;
    expect(letters[0]).toMatchObject({ id, state: "pending" });
    expect(store.size).toBe(before);
    expect(store.get(id)?.state).toBe("pending");
  });

  it("ids 与线程参数互斥，线程读取必须同时给 source+thread_id", async () => {
    const tools = makeTools();
    await expect(
      call(tools, "inbox_read", { ids: ["l1"], source: "svc", thread_id: "g1" }),
    ).rejects.toThrow(/cannot be combined/);
    await expect(call(tools, "inbox_read", { ids: ["l1"], source: "svc" })).rejects.toThrow(
      /cannot be combined/,
    );
    await expect(call(tools, "inbox_read", { thread_id: "g1" })).rejects.toThrow(
      /both source and thread_id/,
    );
    await expect(call(tools, "inbox_read", { source: "svc" })).rejects.toThrow(
      /both source and thread_id/,
    );
    await expect(call(tools, "inbox_read", {})).rejects.toThrow(/provide ids/);
  });
});

describe("inbox_ack", () => {
  it("action 信缺 evidence_ref 整批拒绝；补齐后落 letter.acked", async () => {
    const id = add({ kind: "action", body: "SECRET-ACK-BODY" });
    const tools = makeTools();
    await expect(
      call(tools, "inbox_ack", { ids: [id], outcome: "acted" }),
    ).rejects.toThrow(/require a non-empty evidence_ref/);
    expect(store.get(id)?.state).toBe("pending");

    const { json } = await call(tools, "inbox_ack", {
      ids: [id],
      outcome: "acted",
      evidence_ref: "run:42",
      note: "done",
    });
    expect(json["acked"]).toBe(1);
    const record = store.get(id);
    expect(record?.state).toBe("acked");
    expect(record?.ack_outcome).toBe("acted");
    expect(record?.evidence_ref).toBe("run:42");
    expect(record?.ack_note).toBe("done");
  });

  it("FYI(autoAckKinds) 不要求 evidence_ref", async () => {
    const id = add({ kind: "fyi" });
    const tools = makeTools();
    await call(tools, "inbox_ack", { ids: [id], outcome: "no_action" });
    expect(store.get(id)?.state).toBe("acked");
  });

  it("已 acked 幂等：返回 already_acked 且不新增事件", async () => {
    const id = add({ kind: "fyi" });
    const tools = makeTools();
    await call(tools, "inbox_ack", { ids: [id], outcome: "no_action" });
    const size = store.size;
    const { json } = await call(tools, "inbox_ack", { ids: [id], outcome: "no_action" });
    expect(json["acked"]).toBe(0);
    expect((json["results"] as Array<Record<string, unknown>>)[0]).toMatchObject({
      id,
      status: "already_acked",
    });
    expect(store.size).toBe(size);
  });

  it("未知 id 整批拒绝，已知信不产生部分 ack", async () => {
    const id = add({ kind: "fyi" });
    const tools = makeTools();
    await expect(
      call(tools, "inbox_ack", { ids: [id, "missing"], outcome: "no_action" }),
    ).rejects.toThrow(/unknown letter id\(s\): missing/);
    expect(store.get(id)?.state).toBe("pending");
  });
});

describe("inbox_defer", () => {
  it("ISO/epoch 解析、defer_count 递增、replay 后保持计数", async () => {
    const id = add();
    const tools = makeTools();
    const until = new Date(T0 + 60 * 60 * 1000).toISOString();
    const first = await call(tools, "inbox_defer", { ids: [id], until });
    expect((first.json["deferred"] as Array<Record<string, unknown>>)[0]).toMatchObject({
      id,
      state: "deferred",
      deferred_until: Date.parse(until),
      defer_count: 1,
    });
    expect(store.get(id)?.defer_count).toBe(1);

    await call(tools, "inbox_defer", { ids: [id], until: T0 + 2 * 60 * 60 * 1000 });
    await call(tools, "inbox_defer", { ids: [id], until: T0 + 3 * 60 * 60 * 1000 });
    await expect(
      call(tools, "inbox_defer", { ids: [id], until: T0 + 4 * 60 * 60 * 1000 }),
    ).rejects.toThrow(/3-defer limit/);

    seq = 100;
    const reopened = makeStore();
    expect(reopened.get(id)?.defer_count).toBe(3);
  });

  it("超过 24h 或过去时刻拒绝", async () => {
    const id = add();
    const tools = makeTools();
    await expect(
      call(tools, "inbox_defer", { ids: [id], until: T0 + 25 * 60 * 60 * 1000 }),
    ).rejects.toThrow(/24h/);
    await expect(
      call(tools, "inbox_defer", { ids: [id], until: T0 - 1 }),
    ).rejects.toThrow(/future/);
  });

  it("未知 id 整批拒绝且已知信状态不变", async () => {
    const id = add();
    const tools = makeTools();
    await expect(
      call(tools, "inbox_defer", { ids: [id, "missing"], until: T0 + 60_000 }),
    ).rejects.toThrow(/unknown letter id\(s\): missing/);
    expect(store.get(id)?.state).toBe("pending");
    expect(store.get(id)?.defer_count).toBe(0);
  });
});
