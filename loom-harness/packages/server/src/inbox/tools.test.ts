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
  it("只返回元数据、计数、included_ids 与 still_pending，绝不返回正文", async () => {
    const first = add({ kind: "action", body: "SECRET-ACTION", title: "action title" });
    const second = add({ kind: "fyi", class: "digest", body: "SECRET-FYI" });
    const tools = makeTools();
    const { json, text } = await call(tools, "inbox_list", { state: "pending" });
    expect(text).not.toContain("SECRET-ACTION");
    expect(text).not.toContain("SECRET-FYI");
    expect(json["as_of"]).toBe(clock);
    expect(json["pending"]).toBe(2);
    expect(json["by_class"]).toEqual({ digest: 1, notify: 1, interrupt: 0 });
    expect(json["by_source"]).toEqual({ svc: 2 });
    expect(json["included_ids"]).toEqual([first, second]);
    expect(json["still_pending"]).toBe(0);
    const letters = json["letters"] as Array<Record<string, unknown>>;
    expect(letters).toHaveLength(2);
    expect(letters[0]).toMatchObject({
      id: first,
      source: "svc",
      kind: "action",
      class: "notify",
      trust: "user",
      state: "pending",
      created_at: clock,
      attempts: 0,
      title: "action title",
    });
    expect("body" in letters[0]!).toBe(false);
  });

  it("limit 截断 rows，但 matched 保留过滤后总数、still_pending 扣减已含项", async () => {
    const first = add();
    add();
    const tools = makeTools();
    const { json } = await call(tools, "inbox_list", { limit: 1 });
    expect(json["matched"]).toBe(2);
    expect(json["included_ids"]).toEqual([first]);
    expect(json["still_pending"]).toBe(1);
  });

  it("shadow 模式默认 all：observed 行可见但 pending 计数仍为 0", async () => {
    const observed = store.recordObserved(input({ kind: "fyi" }), { now: clock });
    const tools = makeTools({ ...CONFIG, mode: "shadow" });
    const { json } = await call(tools, "inbox_list", {});
    expect(json["included_ids"]).toEqual([observed.id]);
    expect(json["pending"]).toBe(0);
    expect((json["letters"] as Array<Record<string, unknown>>)[0]?.["state"]).toBe("observed");
  });

  it("state=acked 只看已 ack；state=all 含终态", async () => {
    const first = add({ kind: "fyi" });
    add();
    const tools = makeTools();
    await call(tools, "inbox_ack", { ids: [first], outcome: "no_action" });
    const acked = await call(tools, "inbox_list", { state: "acked" });
    expect(acked.json["included_ids"]).toEqual([first]);
    const all = await call(tools, "inbox_list", { state: "all" });
    expect((all.json["letters"] as unknown[]).length).toBe(2);
  });
});

describe("inbox_read", () => {
  it("返回正文并标记 read（不改 ack）", async () => {
    const id = add({ body: "hello body" });
    const tools = makeTools();
    const before = store.size;
    const { json } = await call(tools, "inbox_read", { ids: [id] });
    const letters = json["letters"] as Array<Record<string, unknown>>;
    expect(letters[0]).toMatchObject({ id, body: "hello body", truncated: false, state: "read" });
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
