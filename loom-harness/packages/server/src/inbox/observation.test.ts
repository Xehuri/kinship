/**
 * 观测面：只输出结构化元数据，正文/principal 明文/权重绝不落日志。
 */

import { describe, expect, it } from "vitest";

import type { InboxEvent } from "./journal-store.js";
import { observeInboxEvent, observeInboxSnapshot, principalRef } from "./observation.js";
import type { InboxSnapshot } from "./types.js";

describe("inbox observation", () => {
  it("letter.received 观测不含正文/title/ref/principal 明文", () => {
    const event: InboxEvent = {
      schema: 1,
      event: "letter.received",
      at: 1_000,
      id: "l1",
      created_at: 1_000,
      letter: {
        source: "qq",
        kind: "system_note",
        class: "notify",
        trust: "external",
        principal: "123456789",
        title: "secret title",
        body: "secret body",
        ref: "secret-ref",
      },
    };
    const observed = observeInboxEvent(event);
    const json = JSON.stringify(observed);
    expect(json).not.toContain("secret body");
    expect(json).not.toContain("secret title");
    expect(json).not.toContain("secret-ref");
    expect(json).not.toContain("123456789");
    expect(observed.principal_ref).toBe(principalRef("123456789"));
    expect(observed.principal_ref).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(observed).toMatchObject({
      schema: 1,
      kind: "inbox.event",
      event: "letter.received",
      id: "l1",
      source: "qq",
      class: "notify",
      trust: "external",
      state: "pending",
    });
  });

  it("suppressed 事件带 reason，且没有 body/principal", () => {
    const event: InboxEvent = {
      schema: 1,
      event: "letter.suppressed",
      at: 2_000,
      id: "l2",
      source: "qq",
      class: "interrupt",
      trust: "external",
      reason: "quiet_hours",
    };
    const observed = observeInboxEvent(event);
    expect(observed.reason).toBe("quiet_hours");
    expect("principal_ref" in observed).toBe(false);
    expect("body" in observed).toBe(false);
  });

  it("lifecycle 事件只出状态，不出载荷", () => {
    const event: InboxEvent = {
      schema: 1,
      event: "letter.acked",
      at: 3_000,
      id: "l3",
      acked_at: 3_000,
      ack_outcome: "done",
      evidence_ref: "run:1",
    };
    const observed = observeInboxEvent(event);
    expect(observed.state).toBe("acked");
    expect("ack_outcome" in observed).toBe(false);
    expect("evidence_ref" in observed).toBe(false);
  });

  it("snapshot 观测是快照副本，不含权重", () => {
    const snapshot: InboxSnapshot = {
      as_of: 1_000,
      pending: 2,
      by_class: { digest: 0, notify: 1, interrupt: 1 },
      by_source: { qq: 2 },
      oldest_age_ms: 500,
      dead_letter: 1,
      unknown: 0,
      digest_due_at: null,
    };
    const observed = observeInboxSnapshot(snapshot);
    expect(observed).toEqual({
      schema: 1,
      kind: "inbox.snapshot",
      as_of: 1_000,
      pending: 2,
      by_class: { digest: 0, notify: 1, interrupt: 1 },
      by_source: { qq: 2 },
      oldest_age_ms: 500,
      dead_letter: 1,
      unknown: 0,
      digest_due_at: null,
    });
    expect("weight" in observed).toBe(false);
  });
});
