/**
 * T4 inbox batch runtime：标记解析、单轮认领、FYI 自动回执、action 重投/死信、
 * defer 跳过、重复 finish 不重复重投。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { InboxConfig } from "../config/section-checks.js";
import { InboxBatchRuntime, parseInboxPromptMarkers } from "./batch.js";
import { InboxJournalStore } from "./journal-store.js";
import type { LetterInput } from "./types.js";

const SESSION = "ses_inbox_batch";
const T0 = Date.UTC(2026, 10, 2, 12, 0, 0);

let root = "";
let clock = T0;
let seq = 0;
let store: InboxJournalStore;
let delivered: string[];
let timers: Array<{ run: () => void; delayMs: number }>;

function input(overrides: Partial<LetterInput> = {}): LetterInput {
  return {
    source: "svc",
    kind: "action",
    class: "notify",
    trust: "user",
    principal: "batch-test",
    body: "batch body",
    ...overrides,
  };
}

function add(overrides: Partial<LetterInput> = {}): string {
  const result = store.append(input(overrides), { now: clock });
  if (result.outcome !== "received") throw new Error(`expected received, got ${result.outcome}`);
  return result.record.id;
}

function deliver(id: string, attempts = 1, batchId?: string): void {
  store.appendEvent({
    schema: 1,
    event: "letter.delivered",
    at: clock,
    id,
    delivered_at: clock,
    attempts,
    ...(batchId === undefined ? {} : { batch_id: batchId }),
  });
}

function runtime(config: InboxConfig = {}): InboxBatchRuntime {
  return new InboxBatchRuntime({
    store,
    config: {
      ...config,
      redelivery: { maxAttempts: 1, backoffMs: 5_000, ...config.redelivery },
      ackGraceTurns: config.ackGraceTurns ?? 2,
    },
    sessionID: SESSION,
    deliverWake: (line) => {
      delivered.push(line);
    },
    now: () => clock,
    schedule: (run, delayMs) => {
      timers.push({ run, delayMs });
      return () => {};
    },
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "loom-inbox-batch-"));
  clock = T0;
  seq = 0;
  delivered = [];
  timers = [];
  store = new InboxJournalStore({
    stateRoot: root,
    sessionId: SESSION,
    now: () => clock,
    idFactory: () => `l${String(++seq)}`,
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("parseInboxPromptMarkers", () => {
  it("digest 信封：batch 标记 + included_ids，不把 [letter=id] 当单信标记", () => {
    const markers = parseInboxPromptMarkers(
      [
        "[loom-inbox:batch=inbox:batch:1] [class=digest count=2]",
        "收件箱摘要",
        "[letter=l1] [source=svc trust=user principal=p kind=action class=digest]",
        "body",
        "included_ids: l1, l2",
        "still_pending: 0",
      ].join("\n"),
    );
    expect(markers.batchId).toBe("inbox:batch:1");
    expect(markers.letterIds).toEqual([]);
    expect(markers.includedIds).toEqual(["l1", "l2"]);
  });

  it("单信提醒：解析 loom-inbox:letter 标记", () => {
    const markers = parseInboxPromptMarkers("[loom-inbox:letter=l9] 请处理");
    expect(markers.batchId).toBeUndefined();
    expect(markers.letterIds).toEqual(["l9"]);
  });

  it("included_ids 为 (none) 时为空", () => {
    const markers = parseInboxPromptMarkers("[loom-inbox:batch=b1]\nincluded_ids: (none)");
    expect(markers.includedIds).toEqual([]);
  });
});

describe("claim", () => {
  it("同一 batch 在 finish 前只认领一次；included_ids 可解析未 markDelivered 的信", () => {
    const l1 = add();
    const l2 = add({ class: "digest" });
    const rt = runtime();
    const text = `[loom-inbox:batch=b1]\nincluded_ids: ${l1}, ${l2}`;
    const first = rt.onPrompt(SESSION, text);
    const second = rt.onPrompt(SESSION, text);
    expect(first?.letterIds).toEqual([l1, l2]);
    expect(second).toBe(first);
    rt.onRunFinished(SESSION, first);
    const third = rt.onPrompt(SESSION, text);
    expect(third).not.toBe(first);
  });

  it("batch_id 可从 journal 的 delivered 事件恢复", () => {
    const l1 = add({ class: "digest" });
    deliver(l1, 1, "b1");
    expect(store.get(l1)?.batch_id).toBe("b1");
    const rt = runtime();
    const token = rt.onPrompt(SESSION, "[loom-inbox:batch=b1]");
    expect(token?.letterIds).toEqual([l1]);
  });

  it("非 inbox 会话不认领", () => {
    add();
    const rt = runtime();
    expect(rt.onPrompt("ses_side", "[loom-inbox:letter=l1]")).toBeUndefined();
  });
});

describe("run finish", () => {
  it("FYI(autoAckKinds) 自动 ack no_action，不重投", () => {
    const id = add({ kind: "fyi" });
    deliver(id);
    const rt = runtime({ autoAckKinds: ["fyi"] });
    const token = rt.onPrompt(SESSION, `[loom-inbox:letter=${id}]`);
    rt.onRunFinished(SESSION, token);
    expect(store.get(id)?.state).toBe("acked");
    expect(store.get(id)?.ack_outcome).toBe("no_action");
    expect(store.get(id)?.evidence_ref).toBeUndefined();
    expect(timers).toEqual([]);
    expect(delivered).toEqual([]);
  });

  it("action 未 ack：attempts+1 重投，按 backoff 排提醒；到上限后死信", () => {
    const id = add({ kind: "action" });
    deliver(id);
    const rt = runtime();
    const token = rt.onPrompt(SESSION, `[loom-inbox:letter=${id}]`);
    rt.onRunFinished(SESSION, token);

    expect(store.get(id)?.state).toBe("pending");
    expect(store.get(id)?.attempts).toBe(2);
    expect(timers).toHaveLength(1);
    expect(timers[0]?.delayMs).toBe(5_000);
    expect(delivered).toEqual([]);

    timers[0]!.run();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain(`[loom-inbox:letter=${id}]`);

    const reminder = rt.onPrompt(SESSION, delivered[0]!);
    expect(reminder?.letterIds).toEqual([id]);
    rt.onRunFinished(SESSION, reminder);
    expect(store.get(id)?.state).toBe("dead_letter");
    expect(timers).toHaveLength(1);
  });

  it("maxAttempts=0 首轮未 ack 直接死信", () => {
    const id = add();
    deliver(id);
    const rt = runtime({ redelivery: { maxAttempts: 0, backoffMs: 0 } });
    const token = rt.onPrompt(SESSION, `[loom-inbox:letter=${id}]`);
    rt.onRunFinished(SESSION, token);
    expect(store.get(id)?.state).toBe("dead_letter");
    expect(delivered).toEqual([]);
  });

  it("ackGraceTurns=0 禁止重投（直接死信）", () => {
    const id = add();
    deliver(id);
    const rt = runtime({ ackGraceTurns: 0 });
    rt.onRunFinished(SESSION, rt.onPrompt(SESSION, `[loom-inbox:letter=${id}]`));
    expect(store.get(id)?.state).toBe("dead_letter");
  });

  it("重复 finish 同一 token 不重复重投", () => {
    const id = add();
    deliver(id);
    const rt = runtime();
    const token = rt.onPrompt(SESSION, `[loom-inbox:letter=${id}]`);
    const size = store.size;
    rt.onRunFinished(SESSION, token);
    rt.onRunFinished(SESSION, token);
    expect(store.size).toBe(size + 1);
    expect(timers).toHaveLength(1);
  });

  it("defer 到未来：run finish 跳过，不重投也不死信", () => {
    const id = add();
    deliver(id);
    store.appendEvent({
      schema: 1,
      event: "letter.deferred",
      at: clock,
      id,
      deferred_until: clock + 60 * 60 * 1000,
    });
    const rt = runtime();
    rt.onRunFinished(SESSION, rt.onPrompt(SESSION, `[loom-inbox:letter=${id}]`));
    expect(store.get(id)?.state).toBe("deferred");
    expect(store.get(id)?.attempts).toBe(1);
    expect(timers).toEqual([]);
  });

  it("崩溃后 pending 信无 delivered 事件：仍可重投一次（attempts 0→1）", () => {
    const id = add();
    const rt = runtime();
    rt.onRunFinished(SESSION, rt.onPrompt(SESSION, `[loom-inbox:letter=${id}]`));
    expect(store.get(id)?.attempts).toBe(1);
    expect(store.get(id)?.state).toBe("pending");
    expect(timers).toHaveLength(1);
  });
});

describe("replay", () => {
  it("batch_id 与 defer_count 在重开账本后保持", () => {
    const id = add({ class: "digest" });
    deliver(id, 1, "b1");
    store.appendEvent({
      schema: 1,
      event: "letter.deferred",
      at: clock,
      id,
      deferred_until: clock + 60_000,
    });
    const reopened = new InboxJournalStore({
      stateRoot: root,
      sessionId: SESSION,
      now: () => clock,
    });
    const record = reopened.get(id);
    expect(record?.batch_id).toBe("b1");
    expect(record?.defer_count).toBe(1);
  });
});
