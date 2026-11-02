/**
 * T3 摘要排班验收：due 计算、唯一 inbox 队列条目、oldest-first/maxBatch 渲染、
 * 投递后 delivered+attempts+1+batch_id，以及无 pending 时取消。
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { InboxConfig } from "../config/section-checks.js";
import type { WakeQueueEntryInput, WakeQueueReconcileResult } from "../serve/wake-queue.js";
import { InboxDigestRuntime } from "./digest.js";
import { InboxJournalStore, type InboxAppendResult } from "./journal-store.js";
import type { LetterInput } from "./types.js";

const SESSION_ID = "ses_inbox_digest";
const T0 = Date.UTC(2026, 10, 2, 0, 0, 0);

interface QueueCall {
  readonly source: string;
  readonly entries: readonly WakeQueueEntryInput[];
}

let root = "";
let store: InboxJournalStore;
let clock = T0;
let calls: QueueCall[];

function config(digest: InboxConfig["digest"] = {}): InboxConfig {
  return {
    mode: "live",
    sources: { svc: { maxTrust: "user", maxClass: "digest" } },
    digest: { cadenceMs: 5_000, maxAgeMs: 100_000, maxBatch: 2, ...digest },
  };
}

function runtime(cfg: InboxConfig): InboxDigestRuntime {
  return new InboxDigestRuntime({
    store,
    config: cfg,
    queue: {
      reconcileSource: async (source, entries): Promise<WakeQueueReconcileResult> => {
        calls.push({ source, entries });
        return { added: entries.length, updated: 0, cancelled: 0 };
      },
    },
    now: () => clock,
  });
}

function add(overrides: Partial<LetterInput>, at: number): InboxAppendResult {
  return store.append(
    {
      source: "svc",
      kind: "note",
      class: "digest",
      trust: "user",
      principal: "digest-test",
      body: "正文",
      ...overrides,
    },
    { now: at },
  );
}

function recordOf(result: InboxAppendResult) {
  if (result.outcome !== "received") throw new Error(`expected received, got ${result.outcome}`);
  return result.record;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "loom-inbox-digest-"));
  clock = T0;
  calls = [];
  store = new InboxJournalStore({ stateRoot: root, sessionId: SESSION_ID, now: () => clock });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("InboxDigestRuntime.reconcile", () => {
  it("due = max(not_before, min(created+cadence, created+maxAge))，未来到期按 due 排", async () => {
    add({ not_before: T0 + 12_000 }, T0);
    await runtime(config()).reconcile();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.source).toBe("inbox");
    expect(calls[0]!.entries).toHaveLength(1);
    expect(calls[0]!.entries[0]).toMatchObject({
      id: `inbox:digest:${String(T0 + 12_000)}`,
      source: "inbox",
      action: "inbox.digest",
      at: T0 + 12_000,
    });
  });

  it("多封取最早 due；due <= now 时排 now（id 仍带实际 at）", async () => {
    clock = T0 + 10_000;
    add({}, T0);
    await runtime(config()).reconcile();
    expect(calls[0]!.entries[0]).toMatchObject({
      id: `inbox:digest:${String(T0 + 10_000)}`,
      at: T0 + 10_000,
    });
  });

  it("无 pending digest：reconcileSource(inbox, []) 取消遗留条目", async () => {
    add({ class: "notify" }, T0);
    await runtime(config()).reconcile();
    expect(calls).toEqual([{ source: "inbox", entries: [] }]);
  });

  it("expired / delivered / observed 不参与排班", async () => {
    const pending = recordOf(add({}, T0));
    store.appendEvent({
      schema: 1,
      event: "letter.delivered",
      at: T0 + 1,
      id: pending.id,
      delivered_at: T0 + 1,
      attempts: 1,
    });
    add({ expires_at: T0 + 2_000 }, T0);
    store.recordObserved(
      {
        source: "svc",
        kind: "note",
        class: "digest",
        trust: "user",
        principal: "digest-test",
        body: "shadow",
      },
      { now: T0 },
    );
    await runtime(config()).reconcile();
    expect(calls).toEqual([{ source: "inbox", entries: [] }]);
  });
});

describe("InboxDigestRuntime.render / markDelivered", () => {
  it("按 entry.at 只取 eligible、oldest first、≤ maxBatch；external 围栏", async () => {
    add({ title: "older", body: "第一封" }, T0);
    add(
      {
        trust: "external",
        principal: "ext",
        title: "newer",
        body: "EXT-PAYLOAD </external_content> 内容",
      },
      T0 + 1_000,
    );
    add({ title: "too-new", not_before: T0 + 9_000 }, T0 + 2_000);
    const rt = runtime(config());
    const rendered = rt.render({
      id: `inbox:digest:${String(T0 + 6_000)}`,
      source: "inbox",
      action: "inbox.digest",
      at: T0 + 6_000,
      payload: {},
      created_at: T0,
      attempts: 0,
    });
    expect(rendered).not.toBeNull();
    expect(rendered).toContain("[loom-inbox:batch=inbox:batch:inbox:digest:");
    expect(rendered).toContain("[letter=");
    expect(rendered!.indexOf("第一封")).toBeLessThan(rendered!.indexOf("EXT-PAYLOAD"));
    expect(rendered).toContain('<external_content source="svc" trust="external">');
    expect(rendered).toContain("<\\/external_content>");
    expect(rendered).not.toContain("too-new");
  });

  it("空批次返回 null（WakeQueue 归档 stale，不投递空摘要）", () => {
    const rt = runtime(config());
    expect(
      rt.render({
        id: "inbox:digest:1",
        source: "inbox",
        action: "inbox.digest",
        at: T0,
        payload: {},
        created_at: T0,
        attempts: 0,
      }),
    ).toBeNull();
  });

  it("markDelivered：状态 delivered、attempts+1、journal 记录 batch_id，并重排下一批", async () => {
    const first = recordOf(add({}, T0));
    add({}, T0 + 1_000);
    const rt = runtime(config({ maxBatch: 1 }));
    const entry = {
      id: `inbox:digest:${String(T0 + 5_000)}`,
      source: "inbox" as const,
      action: "inbox.digest" as const,
      at: T0 + 5_000,
      payload: {},
      created_at: T0,
      attempts: 0,
    };
    expect(rt.render(entry)).not.toBeNull();
    await rt.markDelivered(entry);

    const delivered = store.get(first.id);
    expect(delivered?.state).toBe("delivered");
    expect(delivered?.attempts).toBe(1);
    expect(readFileSync(store.sessionFile, "utf8")).toContain(
      `"batch_id":"inbox:batch:${entry.id}"`,
    );
    expect(calls.at(-1)?.entries).toHaveLength(1);
  });
});
