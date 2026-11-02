/**
 * 事件账本：append/replay、撕裂尾行、损坏、未知事件、dedupe/coalesce/rate 索引、shadow 观测。
 */

import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StateCorruptionError, StateLayout } from "@axeuh/loom-adapters";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InboxJournalError, InboxJournalStore, type InboxTornTail } from "./journal-store.js";
import type { InboxPolicyDecision, LetterInput } from "./types.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "loom-inbox-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function input(overrides: Partial<LetterInput> = {}): LetterInput {
  return {
    source: "qq",
    kind: "system_note",
    class: "notify",
    trust: "external",
    principal: "123456",
    body: "hello",
    ...overrides,
  };
}

function makeStore(
  opts: {
    readonly now?: () => number;
    readonly idFactory?: () => string;
    readonly onTornTail?: (info: InboxTornTail) => void;
  } = {},
): InboxJournalStore {
  return new InboxJournalStore({
    layout: new StateLayout({ root }),
    sessionId: "main_session",
    ...opts,
  });
}

function acceptedDecision(
  overrides: Partial<InboxPolicyDecision> = {},
): InboxPolicyDecision {
  return {
    class: "notify",
    trust: "external",
    route: "deliver_wake",
    outcome: "accepted",
    reason: "accepted",
    reasons: [],
    ...overrides,
  };
}

describe("InboxJournalStore", () => {
  it("append → get/list/snapshot，replay 可恢复", () => {
    let now = 10_000;
    const store = makeStore({ now: () => now, idFactory: () => "l1" });
    const result = store.append(input({ dedupe_key: "d1", coalesce_key: "c1" }), { now });
    expect(result.outcome).toBe("received");
    if (result.outcome !== "received") throw new Error("expected received");
    expect(result.record.id).toBe("l1");
    expect(result.record.state).toBe("pending");
    expect(result.record.created_at).toBe(10_000);

    expect(store.get("l1")?.body).toBe("hello");
    expect(store.list()).toHaveLength(1);
    expect(store.snapshot({ now })).toEqual({
      as_of: 10_000,
      pending: 1,
      by_class: { digest: 0, notify: 1, interrupt: 0 },
      by_source: { qq: 1 },
      oldest_age_ms: 0,
      dead_letter: 0,
      unknown: 0,
      digest_due_at: null,
    });

    now = 15_000;
    const reopened = makeStore({ now: () => now });
    expect(reopened.get("l1")?.created_at).toBe(10_000);
    expect(reopened.snapshot({ now }).oldest_age_ms).toBe(5_000);
    expect(reopened.snapshot({ now }).pending).toBe(1);
  });

  it("撕裂尾行：回调上报 + 丢弃尾行 + 修复文件后可继续写", () => {
    const store = makeStore({ now: () => 1_000, idFactory: () => "l1" });
    store.append(input(), { now: 1_000 });
    appendFileSync(store.filePath, '{"schema":1,"event":"letter.received"');

    const torn: InboxTornTail[] = [];
    const reopened = makeStore({
      now: () => 2_000,
      onTornTail: (info) => torn.push(info),
    });
    expect(torn).toHaveLength(1);
    expect(torn[0]?.line_number).toBe(2);
    expect(reopened.list()).toHaveLength(1);
    expect(readFileSync(store.filePath, "utf8").endsWith("\n")).toBe(true);

    reopened.append(input({ source: "backend.tasks", principal: "tasks" }), { now: 2_000 });
    expect(reopened.list()).toHaveLength(2);
  });

  it("中段坏行 = StateCorruptionError（响亮失败）", () => {
    const store = makeStore({ now: () => 1_000, idFactory: () => "l1" });
    store.append(input(), { now: 1_000 });
    const line = readFileSync(store.filePath, "utf8").trim();
    writeFileSync(store.filePath, `${line}\nNOT JSON\n${line}\n`);
    expect(() => makeStore()).toThrow(StateCorruptionError);
  });

  it("未知事件类型 → InboxJournalError（尾行也不静默丢弃）", () => {
    const store = makeStore({ now: () => 1_000, idFactory: () => "l1" });
    store.append(input(), { now: 1_000 });
    appendFileSync(
      store.filePath,
      '{"schema":1,"event":"letter.future","at":1,"id":"future"}\n',
    );
    expect(() => makeStore()).toThrow(InboxJournalError);
  });

  it("未知事件类型出现在中段 → InboxJournalError", () => {
    const store = makeStore({ now: () => 1_000, idFactory: () => "l1" });
    store.append(input(), { now: 1_000 });
    const line = readFileSync(store.filePath, "utf8").trim();
    writeFileSync(
      store.filePath,
      '{"schema":1,"event":"letter.future","at":0,"id":"future"}\n' + `${line}\n`,
    );
    expect(() => makeStore()).toThrow(InboxJournalError);
  });

  it("dedupe/coalesce 索引来自 replay", () => {
    const store = makeStore({ now: () => 1_000, idFactory: () => "l1" });
    store.append(input({ dedupe_key: "d1", coalesce_key: "c1" }), { now: 1_000 });
    const index = store.policyIndex();
    expect(index.dedupe.get("d1")).toEqual({ id: "l1", at: 1_000 });
    expect(index.coalesce.get("c1")).toEqual({ id: "l1", at: 1_000 });
    expect(index.pendingCount).toBe(1);

    const reopened = makeStore({ now: () => 2_000 });
    expect(reopened.policyIndex().dedupe.get("d1")?.id).toBe("l1");
  });

  it("coalesced 事件推进窗口时间但保留 target id", () => {
    const store = makeStore({ now: () => 1_000, idFactory: () => "l1" });
    store.append(input({ coalesce_key: "c1" }), { now: 1_000 });
    const decision = acceptedDecision({
      outcome: "coalesced",
      route: "suppressed",
      reason: "coalesced",
      reasons: ["coalesced"],
      coalesce: { key: "c1", window_ms: 5_000, coalesced: true, target_id: "l1", target_at: 1_000 },
    });
    const result = store.append(input({ coalesce_key: "c1" }), { now: 2_000, decision });
    expect(result).toEqual({ outcome: "coalesced", id: expect.any(String), target_id: "l1" });
    expect(store.policyIndex().coalesce.get("c1")).toEqual({ id: "l1", at: 2_000 });
    expect(store.list()).toHaveLength(1);
  });

  it("duplicate/suppressed 事件不建记录，但计入事件数与速率窗口", () => {
    const store = makeStore({
      now: () => 1_000,
      idFactory: (() => {
        let n = 0;
        return () => `l${++n}`;
      })(),
    });
    store.append(input({ dedupe_key: "d1" }), { now: 1_000 });
    const duplicate = store.append(input({ dedupe_key: "d1" }), {
      now: 2_000,
      decision: acceptedDecision({
        outcome: "duplicate",
        route: "suppressed",
        reason: "duplicate",
        reasons: ["duplicate"],
        dedupe: { key: "d1", ttl_ms: 10_000, duplicate: true, existing_id: "l1", existing_at: 1_000 },
      }),
    });
    expect(duplicate.outcome).toBe("duplicate");
    const suppressed = store.append(input(), {
      now: 3_000,
      decision: acceptedDecision({
        outcome: "suppressed",
        route: "suppressed",
        reason: "max_pending",
        reasons: ["max_pending"],
      }),
    });
    expect(suppressed.outcome).toBe("suppressed");
    expect(store.list()).toHaveLength(1);
    expect(store.size).toBe(3);
    expect(store.rateWindow("qq", 3_000, 60_000)).toEqual({ count: 3, last_at: 3_000 });
  });

  it("rateWindow 只统计窗口内且不晚于 now 的采样", () => {
    const store = makeStore({ now: () => 0, idFactory: (() => {
      let n = 0;
      return () => `l${++n}`;
    })() });
    store.append(input(), { now: 1_000 });
    store.append(input(), { now: 2_000 });
    store.append(input(), { now: 61_001 });
    expect(store.rateWindow("qq", 61_001, 60_000)).toEqual({ count: 2, last_at: 61_001 });
    expect(store.rateWindow("qq", 2_000, 0)).toEqual({ count: 1, last_at: 2_000 });
  });

  it("recordObserved：shadow 只落账，不计入 pending/by_class", () => {
    const store = makeStore({ now: () => 1_000, idFactory: () => "obs1" });
    const record = store.recordObserved(input({ class: "interrupt", trust: "user" }), {
      now: 1_000,
    });
    expect(record.state).toBe("observed");
    expect(store.snapshot({ now: 1_000 })).toEqual({
      as_of: 1_000,
      pending: 0,
      by_class: { digest: 0, notify: 0, interrupt: 0 },
      by_source: {},
      oldest_age_ms: 0,
      dead_letter: 0,
      unknown: 0,
      digest_due_at: null,
    });
    expect(store.list({ state: "observed" })).toHaveLength(1);
  });

  it("policy decision 的有效 class/trust 写入记录（只降级，不保留调用方虚高值）", () => {
    const store = makeStore({ now: () => 1_000, idFactory: () => "l1" });
    const result = store.append(input({ class: "interrupt", trust: "user" }), {
      now: 1_000,
      decision: acceptedDecision({ class: "notify", trust: "external" }),
    });
    if (result.outcome !== "received") throw new Error("expected received");
    expect(result.record.class).toBe("notify");
    expect(result.record.trust).toBe("external");
  });

  it("snapshot：knownSources/unknown、digest_due_at、dead_letter", () => {
    const store = makeStore({
      now: () => 1_000,
      idFactory: (() => {
        let n = 0;
        return () => `l${++n}`;
      })(),
    });
    store.append(
      input({ source: "qq", class: "digest", not_before: 5_000 }),
      { now: 1_000 },
    );
    store.append(
      input({ source: "backend.tasks", class: "digest", not_before: 3_000 }),
      { now: 1_000 },
    );
    const snap = store.snapshot({ now: 2_000, knownSources: ["qq"] });
    expect(snap.pending).toBe(2);
    expect(snap.unknown).toBe(1);
    expect(snap.digest_due_at).toBe(3_000);
    expect(store.snapshot({ now: 2_000, knownSources: ["qq", "backend.tasks"] }).unknown).toBe(0);
  });

  it("appendEvent 生命周期事件：dead_letter 进入独立计数且移出 pending", () => {
    const store = makeStore({ now: () => 1_000, idFactory: () => "l1" });
    store.append(input(), 1_000);
    store.appendEvent({
      schema: 1,
      event: "letter.dead_letter",
      at: 2_000,
      id: "l1",
      reason: "delivery_exhausted",
    });
    const snap = store.snapshot(2_000);
    expect(snap.pending).toBe(0);
    expect(snap.dead_letter).toBe(1);
    expect(store.get("l1")?.state).toBe("dead_letter");
  });

  it("append 拒绝调用方自带 id/created_at/score", () => {
    const store = makeStore();
    expect(() =>
      store.append({ ...input(), id: "forged" }),
    ).toThrow(/id/);
    expect(() =>
      store.append({ ...input(), score: 9 }),
    ).toThrow(/score/);
  });

  it("支持 stateRoot 便捷入口与自定义 body 上限", () => {
    const store = new InboxJournalStore({
      stateRoot: root,
      sessionId: "main_session",
      now: () => 1_000,
      idFactory: () => "l1",
      validation: { maxBodyBytes: 4 },
    });
    const result = store.append(input({ body: "abcd" }), 1_000);
    expect(result.outcome).toBe("received");
    expect(() => store.append(input({ body: "abcde" }), 1_000)).toThrow(/UTF-8 字节数/);
  });

  it("replay 不套当前 body 上限（配置收紧后旧账仍可打开）", () => {
    const wide = new InboxJournalStore({
      stateRoot: root,
      sessionId: "main_session",
      now: () => 1_000,
      idFactory: () => "l1",
      validation: { maxBodyBytes: 10 },
    });
    wide.append(input({ body: "0123456789" }), 1_000);
    const narrow = new InboxJournalStore({
      stateRoot: root,
      sessionId: "main_session",
      now: () => 2_000,
      validation: { maxBodyBytes: 1 },
    });
    expect(narrow.get("l1")?.body).toBe("0123456789");
  });
});
