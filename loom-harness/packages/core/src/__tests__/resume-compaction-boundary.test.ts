/**
 * Regression: resuming a session whose history ends behind a persisted compaction boundary must
 * rehydrate that boundary (coveredCount=1 over the replayed messages, historical C=2122) instead
 * of throwing it away and letting autoCompaction re-derive a smaller one (coveredCount=7).
 *
 * On current HEAD `_replayStoreHistory` returns only messages, so `compactionView` is null and the
 * first run calls summarize once. This test is expected to be RED until the replay seeds the
 * boundary; it must not be weakened.
 */

import { describe, it, expect } from "vitest";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { AgentSession } from "../session.js";
import { MemorySessionStore } from "../session-store.js";
import { createFakeModel } from "../testing.js";
import { createUserMessage } from "../types.js";
import { autoCompaction } from "../plugins/auto-compaction.js";

const SAFE_BOUNDARY_TEXT =
  "[auto-compacted summary of 2121 earlier messages]\nSAFE-BOUNDARY";

const zeroUsage: AssistantMessage["usage"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const bigUsage: AssistantMessage["usage"] = {
  input: 500000,
  output: 1000,
  cacheRead: 58000,
  cacheWrite: 0,
  totalTokens: 559000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const assistantText = (text: string, usage: AssistantMessage["usage"] = zeroUsage): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "fake" as never,
  provider: "fake",
  model: "fake-model",
  usage,
  stopReason: "stop",
  timestamp: 0,
});

const assistantToolCalls = (
  calls: ReadonlyArray<{ id: string; name: string }>,
): Message => ({
  role: "assistant",
  content: calls.map(({ id, name }) => ({ type: "toolCall" as const, id, name, arguments: {} })),
  api: "fake" as never,
  provider: "fake",
  model: "fake-model",
  usage: zeroUsage,
  stopReason: "toolUse",
  timestamp: 0,
});

const toolResultMsg = (toolCallId: string, toolName: string, text: string): Message => ({
  role: "toolResult",
  toolCallId,
  toolName,
  content: [{ type: "text", text }],
  isError: false,
  timestamp: 0,
});

/**
 * The 18 messages after SAFE-BOUNDARY. The user at global index 7 and the toolResult at global
 * index 12 make current autoCompaction land on coveredCount=7 (the regression the test pins).
 */
function tailMessages(): Message[] {
  return [
    createUserMessage("tail-u1"),
    assistantToolCalls([{ id: "tail-tc-a", name: "echo" }]),
    toolResultMsg("tail-tc-a", "echo", "tail-r-a"),
    createUserMessage("tail-u2"),
    assistantToolCalls([{ id: "tail-tc-b", name: "echo" }]),
    toolResultMsg("tail-tc-b", "echo", "tail-r-b"),
    createUserMessage("tail-u3"),
    assistantText("tail-a1"),
    assistantToolCalls([
      { id: "tc1", name: "echo" },
      { id: "tc2", name: "echo" },
      { id: "tc3", name: "echo" },
    ]),
    toolResultMsg("tc1", "echo", "r1"),
    toolResultMsg("tc2", "echo", "r2"),
    toolResultMsg("tc3", "echo", "r3"),
    createUserMessage("tail-u4"),
    assistantText("tail-a2"),
    createUserMessage("tail-u5"),
    assistantText("tail-a3"),
    createUserMessage("tail-u6"),
    assistantText("tail-a4", bigUsage),
  ];
}

async function buildFixture(): Promise<{ store: MemorySessionStore; sessionId: string }> {
  const store = new MemorySessionStore();
  const sessionId = "resume-2122";
  for (let i = 0; i < 1355; i++) {
    await store.appendEntry(sessionId, {
      kind: "message",
      message: createUserMessage(`early-${i}`),
    });
  }
  await store.appendEntry(sessionId, {
    kind: "compaction_boundary",
    summary: createUserMessage("S1"),
  });
  for (let i = 0; i < 2121; i++) {
    await store.appendEntry(sessionId, {
      kind: "message",
      message: createUserMessage(`mid-${i}`),
    });
  }
  await store.appendEntry(sessionId, {
    kind: "compaction_boundary",
    summary: createUserMessage(SAFE_BOUNDARY_TEXT),
  });
  for (const message of tailMessages()) {
    await store.appendEntry(sessionId, { kind: "message", message });
  }
  return { store, sessionId };
}

async function createResumedFixture() {
  const { store, sessionId } = await buildFixture();
  let calls = 0;
  const hook = autoCompaction({
    maxContextTokens: 100000,
    triggerRatio: 0.5,
    keepRecent: 8,
    resummarizeEvery: 16,
    summarize: () => {
      calls++;
      return "NEW-SUMMARY";
    },
  });
  const fake = createFakeModel([{ content: [{ type: "text", text: "ok" }] }]);
  const resumed = await AgentSession.resume(store, sessionId, {
    model: fake,
    tools: [],
    hooks: [hook],
  });
  return { store, sessionId, resumed, fake, calls: () => calls };
}

describe("resume rehydration across a persisted compaction boundary", () => {
  it("rehydrates the persisted boundary into compactionView before any run", async () => {
    const { resumed, fake } = await createResumedFixture();

    expect(resumed.compactionView).not.toBeNull();
    const view = resumed.compactionView;
    if (view === null) {
      throw new Error("compactionView is null: the persisted boundary was not rehydrated");
    }
    expect(view.coveredCount).toBe(1);
    expect(view.totalMessages).toBe(19);
    expect((view as any).historicalCoveredCount).toBe(2122);
    expect(view.summaryText).toBe(SAFE_BOUNDARY_TEXT);
    expect(view.summaryText).toContain("SAFE-BOUNDARY");
    expect(view.summaryText).not.toContain("NEW-SUMMARY");
    fake.teardown();
  });

  it("the first run after resume does not resummarize or advance the boundary", async () => {
    const { store, sessionId, resumed, fake, calls } = await createResumedFixture();

    const result = await resumed.run("next");

    expect(result.reason).toBe("done");
    const after = resumed.compactionView;
    expect(after).not.toBeNull();
    if (after === null) {
      throw new Error("compactionView became null after the first run");
    }
    expect(after.coveredCount).toBe(1);
    expect(after.totalMessages).toBe(21);
    expect(calls()).toBe(0);
    const boundaries = (await store.getPathToLeaf(sessionId)).filter(
      (node) => node.entry.kind === "compaction_boundary",
    );
    expect(boundaries).toHaveLength(2);
    fake.teardown();
  });
});
