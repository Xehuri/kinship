/**
 * 信封渲染验收：task.trigger 的正文完整性 + ack 指令；其他 kind 的 preview 行为不变。
 */

import { describe, expect, it } from "vitest";

import {
  countsFromSnapshot,
  renderDigestEnvelope,
  renderLetterEnvelope,
  type InboxEnvelopeCounts,
} from "./envelope.js";
import type { InboxSnapshot, LetterRecord } from "./types.js";

const TASK_BODY = "TASK-INSTRUCTION-".repeat(60);

function counts(includedIds: readonly string[] = ["l1"]): InboxEnvelopeCounts {
  const snapshot: InboxSnapshot = {
    as_of: 2000,
    pending: includedIds.length,
    by_class: { digest: 0, notify: includedIds.length, interrupt: 0 },
    by_source: { "backend.tasks": includedIds.length },
    oldest_age_ms: 1000,
    dead_letter: 0,
    unknown: 0,
    digest_due_at: null,
  };
  return countsFromSnapshot(snapshot, includedIds);
}

function record(overrides: Partial<LetterRecord> = {}): LetterRecord {
  return {
    source: "backend.tasks",
    kind: "task.trigger",
    class: "notify",
    trust: "trusted_service",
    principal: "backend",
    title: "任务触发",
    body: TASK_BODY,
    correlation_id: "run-1",
    id: "l1",
    created_at: 1000,
    state: "delivered",
    attempts: 1,
    defer_count: 0,
    ...overrides,
  };
}

describe("renderLetterEnvelope task.trigger", () => {
  it("preview 模式仍给完整正文，并在正文后附 ack 指令", () => {
    const text = renderLetterEnvelope(record(), "preview", counts());
    expect(text).toContain(TASK_BODY);
    expect(text).not.toContain("…（已截断）");
    expect(text).toContain(
      "任务信件：完成后必须调用 inbox_ack（id 见上方 marker），outcome=acted，并带 evidence_ref。",
    );
    expect(text).toContain("[loom-inbox:letter=l1]");
  });

  it("非 task.trigger 的 notify 仍按 preview 截断且不带 ack 指令", () => {
    const text = renderLetterEnvelope(
      record({ kind: "backend.notice", body: "B".repeat(900) }),
      "preview",
      counts(),
    );
    expect(text).toContain("…（已截断）");
    expect(text).not.toContain("B".repeat(900));
    expect(text).not.toContain("任务信件：完成后必须调用 inbox_ack");
  });

  it("interrupt 的完整正文行为不变", () => {
    const body = "C".repeat(900);
    const text = renderLetterEnvelope(record({ kind: "alert", class: "interrupt", body }), "full", counts());
    expect(text).toContain(body);
    expect(text).not.toContain("任务信件：完成后必须调用 inbox_ack");
  });
});

describe("renderDigestEnvelope task.trigger", () => {
  it("摘要中的 task.trigger 不被截断，其他条目仍是 preview", () => {
    const task = record({ id: "l1" });
    const note = record({ id: "l2", kind: "backend.notice", body: "D".repeat(900) });
    const text = renderDigestEnvelope([task, note], "b1", counts(["l1", "l2"]));
    expect(text).toContain(TASK_BODY);
    expect(text).toContain("…（已截断）");
  });
});
