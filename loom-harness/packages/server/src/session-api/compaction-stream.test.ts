import { describe, expect, it } from "vitest";
import type { CompactionWorkerEvent } from "@axeuh/loom-core";

import { CompactionStreamPublisher } from "./compaction-stream.js";

interface Frame {
  readonly type: string;
  readonly props: Readonly<Record<string, unknown>>;
}

function makePublisher(sessionID = "ses_p5") {
  const frames: Frame[] = [];
  const publisher = new CompactionStreamPublisher({
    hub: {
      publish(type, _sessionID, props = {}) {
        frames.push({ type, props });
      },
    },
    sessionID,
    flushIntervalMs: 1,
    flushMaxBytes: 10_000,
  });
  return { publisher, frames };
}

function delta(
  overrides: Partial<Extract<CompactionWorkerEvent, { type: "delta" }>> = {},
): Extract<CompactionWorkerEvent, { type: "delta" }> {
  return {
    type: "delta",
    attemptId: "a-b",
    chunk: 0,
    retry: 0,
    part: "content",
    delta: "hello",
    ...overrides,
  };
}

describe("CompactionStreamPublisher", () => {
  it("emits started, virtual part deltas, scrub, and compacted", () => {
    const { publisher, frames } = makePublisher();
    publisher.handle({ type: "started", attemptId: "a-b", reason: "manual" });
    publisher.handle(delta({ part: "reasoning", delta: "thinking" }));
    publisher.handle(delta({ delta: "token=supersecret-value" }));
    publisher.flushAll();
    publisher.handle({
      type: "succeeded",
      attemptId: "a-b",
      coveredCount: 4,
      checkpointId: "chk",
      attemptsUsed: 1,
    });

    const types = frames.map((f) => f.type);
    expect(types).toContain("session.compaction.started");
    expect(types).toContain("session.compaction.chunk");
    expect(types).toContain("message.part.updated");
    expect(types).toContain("message.part.delta");
    expect(types).toContain("session.compacted");

    const register = frames.find((f) => f.type === "message.part.updated");
    expect(register?.props["part"]).toMatchObject({
      id: "cmp_a_b_c0_r0_reasoning",
      type: "reasoning",
    });
    const deltas = frames.filter((f) => f.type === "message.part.delta");
    expect(deltas.map((f) => f.props["delta"]).join("")).toContain("thinking");
    expect(deltas.map((f) => f.props["delta"]).join("")).not.toContain("supersecret-value");
    expect(deltas.map((f) => f.props["partID"])).toContain("cmp_a_b_c0_r0_content");
    expect(frames.find((f) => f.type === "session.compacted")?.props).toMatchObject({
      attemptId: "a-b",
      coveredCount: 4,
      source: "manual",
    });
  });

  it("flushes and emits retry/failed without a compacted frame", () => {
    const { publisher, frames } = makePublisher();
    publisher.handle({ type: "started", attemptId: "a-b", reason: "fallback" });
    publisher.handle(delta({ delta: "partial" }));
    publisher.handle({
      type: "retrying",
      attemptId: "a-b",
      retry: 1,
      delayMs: 2000,
      errorClass: "transient",
      error: new Error("timeout"),
    });
    publisher.handle({
      type: "failed",
      attemptId: "a-b",
      errorClass: "transient",
      attemptsUsed: 11,
      error: new Error("exhausted"),
    });

    expect(frames.some((f) => f.type === "session.compaction.retry")).toBe(true);
    expect(frames.some((f) => f.type === "session.compaction_failed")).toBe(true);
    expect(frames.some((f) => f.type === "session.compacted")).toBe(false);
  });

  it("keeps chunk zero separate for ops and chat perspectives", () => {
    const { publisher, frames } = makePublisher();
    publisher.handle({ type: "started", attemptId: "a-b", reason: "manual" });
    publisher.handle(delta({ perspective: "ops", delta: "ops text" }));
    publisher.handle(delta({ perspective: "chat", delta: "chat text" }));
    publisher.flushAll();

    const chunks = frames.filter((f) => f.type === "session.compaction.chunk");
    expect(chunks.map((f) => f.props["perspective"])).toEqual(["ops", "chat"]);

    const deltas = frames.filter((f) => f.type === "message.part.delta");
    expect(deltas.find((f) => f.props["partID"] === "cmp_a_b_pops_c0_r0_content")?.props["delta"]).toBe(
      "ops text",
    );
    expect(deltas.find((f) => f.props["partID"] === "cmp_a_b_pchat_c0_r0_content")?.props["delta"]).toBe(
      "chat text",
    );
  });

  it("flushes the ops tail before starting the chat perspective", () => {
    const { publisher, frames } = makePublisher();
    publisher.handle({ type: "started", attemptId: "a-b", reason: "manual" });
    publisher.handle(delta({ perspective: "ops", delta: "o".repeat(200) }));
    publisher.handle(delta({ perspective: "chat", delta: "chat text" }));
    publisher.flushAll();

    const opsFlush = frames.findIndex(
      (f) => f.type === "message.part.delta" && f.props["partID"] === "cmp_a_b_pops_c0_r0_content",
    );
    const chatChunk = frames.findIndex(
      (f) => f.type === "session.compaction.chunk" && f.props["perspective"] === "chat",
    );
    const chatFlush = frames.findIndex(
      (f) => f.type === "message.part.delta" && f.props["partID"] === "cmp_a_b_pchat_c0_r0_content",
    );
    expect(opsFlush).toBeGreaterThanOrEqual(0);
    expect(chatChunk).toBeGreaterThan(opsFlush);
    expect(chatFlush).toBeGreaterThan(chatChunk);

    const opsText = frames
      .filter((f) => f.type === "message.part.delta" && f.props["partID"] === "cmp_a_b_pops_c0_r0_content")
      .map((f) => f.props["delta"])
      .join("");
    expect(opsText).toBe("o".repeat(200));
  });

  it("adds perspective to chunk, retry, and failed frames when defined", () => {
    const { publisher, frames } = makePublisher();
    publisher.handle({ type: "started", attemptId: "a-b", reason: "manual" });
    publisher.handle(delta({ perspective: "ops", delta: "o" }));
    publisher.handle({
      type: "retrying",
      attemptId: "a-b",
      retry: 1,
      delayMs: 10,
      errorClass: "transient",
      error: new Error("timeout"),
      perspective: "chat",
    });
    publisher.handle({
      type: "failed",
      attemptId: "a-b",
      errorClass: "transient",
      attemptsUsed: 2,
      error: new Error("exhausted"),
      perspective: "chat",
    });

    expect(frames.find((f) => f.type === "session.compaction.chunk")?.props["perspective"]).toBe("ops");
    expect(frames.find((f) => f.type === "session.compaction.retry")?.props["perspective"]).toBe("chat");
    expect(frames.find((f) => f.type === "session.compaction_failed")?.props["perspective"]).toBe("chat");
  });

  it("keeps legacy frames and part ids unchanged when perspective is absent", () => {
    const { publisher, frames } = makePublisher();
    publisher.handle({ type: "started", attemptId: "a-b", reason: "manual" });
    publisher.handle(delta({ delta: "hello" }));
    publisher.flushAll();
    publisher.handle({
      type: "retrying",
      attemptId: "a-b",
      retry: 1,
      delayMs: 10,
      errorClass: "transient",
      error: new Error("timeout"),
    });
    publisher.handle({
      type: "failed",
      attemptId: "a-b",
      errorClass: "transient",
      attemptsUsed: 2,
      error: new Error("exhausted"),
    });

    const chunk = frames.find((f) => f.type === "session.compaction.chunk");
    expect(chunk?.props).toEqual({ attemptId: "a-b", chunk: 0, retry: 0, part: "content" });
    expect(frames.find((f) => f.type === "message.part.delta")?.props["partID"]).toBe(
      "cmp_a_b_c0_r0_content",
    );
    expect(frames.find((f) => f.type === "session.compaction.retry")?.props).toEqual({
      attemptId: "a-b",
      retry: 1,
      delayMs: 10,
      errorClass: "transient",
      error: "timeout",
    });
    expect(frames.find((f) => f.type === "session.compaction_failed")?.props).toEqual({
      attemptId: "a-b",
      error: { code: "compaction_failed", message: "exhausted" },
      errorClass: "transient",
      attemptsUsed: 2,
    });
  });
});
