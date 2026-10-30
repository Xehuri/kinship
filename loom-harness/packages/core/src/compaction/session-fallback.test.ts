/**
 * W57 P2c-2：AgentSession 的 LLM 前置压缩闸门。
 *
 * 覆盖 fallback 阈值、commit 后投影、摘要失败后的 retry_pending 重试、手动 compactNow、
 * 未注入 coordinator 的旧行为，以及崩溃残留的 compacting sidecar 拒绝正常 LLM 调用。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeModel, type FakeModel } from "../testing.js";
import { createUserMessage } from "../types.js";
import { AgentSession } from "../session.js";
import { MemorySessionStore, type SessionStore } from "../session-store.js";
import { beginCompaction, idleState, type CompactionState } from "./compaction-state.js";
import { CompactionStateStore } from "./compaction-state-store.js";
import {
  CompactionFailedError,
  CompactionRecoveryRequiredError,
  type SessionCompactionOptions,
} from "./session-compaction.js";

const SID = "ses_session_fallback";

let root: string;
let stateStore: CompactionStateStore;
let fake: FakeModel;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "loom-session-fallback-"));
  stateStore = new CompactionStateStore({ stateRoot: root });
  fake = createFakeModel();
});

afterEach(() => {
  fake.teardown();
  rmSync(root, { recursive: true, force: true });
});

function textOf(message: Message): string {
  return typeof message.content === "string"
    ? message.content
    : message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

interface OptionOverrides {
  readonly summarize?: SessionCompactionOptions["summarize"];
  readonly fallbackTokens?: number;
  readonly keepRecent?: number;
  readonly summaryChunkTokens?: number;
  readonly summaryMode?: SessionCompactionOptions["summaryMode"];
  readonly singleCallBudgetTokens?: number;
  readonly projectSummaryInput?: SessionCompactionOptions["projectSummaryInput"];
}

function sessionCompaction(overrides: OptionOverrides = {}): SessionCompactionOptions {
  return {
    stateStore,
    summarize: overrides.summarize ?? (() => "summary-text"),
    wrapSummary: (text, coveredCount) => `[compacted ${String(coveredCount)}]\n${text}`,
    fallbackTokens: overrides.fallbackTokens ?? 1_000_000,
    keepRecent: overrides.keepRecent ?? 1,
    summaryChunkTokens: overrides.summaryChunkTokens ?? 1_000,
    retryCount: 0,
    ...(overrides.summaryMode !== undefined ? { summaryMode: overrides.summaryMode } : {}),
    ...(overrides.singleCallBudgetTokens !== undefined
      ? { singleCallBudgetTokens: overrides.singleCallBudgetTokens }
      : {}),
    ...(overrides.projectSummaryInput !== undefined
      ? { projectSummaryInput: overrides.projectSummaryInput }
      : {}),
  };
}

interface SessionInput {
  readonly messages?: readonly Message[];
  readonly store?: SessionStore;
  readonly compaction?: SessionCompactionOptions;
}

function makeSession(input: SessionInput = {}): AgentSession {
  return new AgentSession({
    sessionId: SID,
    model: fake,
    tools: [],
    ...(input.messages !== undefined ? { initialMessages: [...input.messages] } : {}),
    ...(input.store !== undefined ? { store: input.store } : {}),
    ...(input.compaction !== undefined ? { compaction: input.compaction } : {}),
  });
}

function readState(): CompactionState | null {
  const result = stateStore.read(SID);
  return result.kind === "ok" ? result.state : null;
}

describe("AgentSession compaction fallback", () => {
  it("does not start below fallbackTokens and sends the original messages", async () => {
    const store = new MemorySessionStore();
    const session = makeSession({
      messages: [createUserMessage("hello")],
      store,
      compaction: sessionCompaction({ fallbackTokens: 1_000_000 }),
    });

    const summary = await session.run("next");

    expect(summary.reason).toBe("done");
    expect(stateStore.read(SID).kind).toBe("missing");
    expect(session.compactionState).toBeNull();
    expect(session.compactionView).toBeNull();
    const calls = fake.getCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.messages.map(textOf)).toEqual(["hello", "next"]);
  });

  it("starts at the fallback threshold and sends summary plus tail after commit", async () => {
    const messages = ["u0", "u1", "u2"].map((text) => createUserMessage(text));
    const store = new MemorySessionStore();
    const session = makeSession({
      messages,
      store,
      compaction: sessionCompaction({ fallbackTokens: 1 }),
    });

    const summary = await session.run("u3");

    expect(summary.reason).toBe("done");
    expect(session.compactionView?.coveredCount).toBe(3);
    expect(session.compactionState).toMatchObject({
      status: "idle",
      baseCoveredCount: 3,
    });
    const calls = fake.getCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.messages.map(textOf)).toEqual([
      "[compacted 3]\nsummary-text",
      "u3",
    ]);
    const entries = await store.getPathToLeaf(SID);
    expect(entries.filter((entry) => entry.entry.kind === "compaction_boundary")).toHaveLength(1);
  });

  it("fails the turn when summarize fails, then retries from retry_pending on the next call", async () => {
    let shouldFail = true;
    const summarize = (): string => {
      if (shouldFail) throw new Error("summarizer down");
      return "recovered-summary";
    };
    const store = new MemorySessionStore();
    const session = makeSession({
      messages: [createUserMessage("u0")],
      store,
      compaction: sessionCompaction({ fallbackTokens: 1, summarize }),
    });

    const first = await session.run("u1");

    expect(first.reason).toBe("error");
    expect(first.error).toBeInstanceOf(CompactionFailedError);
    expect(fake.getCalls()).toHaveLength(0);
    expect(session.compactionView).toBeNull();
    expect(readState()).toMatchObject({
      status: "retry_pending",
      reason: "fallback",
      lastError: "summarizer down",
    });

    shouldFail = false;
    const second = await session.run("u2");

    expect(second.reason).toBe("done");
    expect(readState()?.status).toBe("idle");
    expect(session.compactionView?.coveredCount).toBe(2);
    const calls = fake.getCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.messages.map(textOf)).toEqual([
      "[compacted 2]\nrecovered-summary",
      "u2",
    ]);
  });

  it("manual compactNow compacts the current view", async () => {
    const store = new MemorySessionStore();
    const session = makeSession({
      messages: [createUserMessage("u0"), createUserMessage("u1")],
      store,
      compaction: sessionCompaction({ fallbackTokens: 1_000_000 }),
    });

    const outcome = await session.compactNow("manual");

    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.kind !== "compacted") {
      throw new Error(`expected compacted outcome, got ${JSON.stringify(outcome)}`);
    }
    expect(outcome.reason).toBe("manual");
    expect(session.compactionView?.coveredCount).toBe(1);
    expect(session.compactionState?.status).toBe("idle");
  });

  it("keeps legacy behavior when no compaction option is configured", async () => {
    const session = makeSession({ messages: [createUserMessage("hello")] });

    const summary = await session.run("next");

    expect(summary.reason).toBe("done");
    expect(fake.getCalls()[0]!.messages.map(textOf)).toEqual(["hello", "next"]);
    expect(session.compactionState).toBeNull();
    await expect(session.compactNow()).rejects.toThrow(/not configured/);
  });

  it("forwards summary mode, budget, and projection to the compaction worker", async () => {
    const messages = ["u0", "u1", "u2"].map((text) => createUserMessage(text));
    const summarized: Message[][] = [];
    const store = new MemorySessionStore();
    const session = makeSession({
      messages,
      store,
      compaction: sessionCompaction({
        fallbackTokens: 1,
        summaryChunkTokens: 1,
        summaryMode: "single",
        singleCallBudgetTokens: 10_000,
        projectSummaryInput: (input) =>
          input.map((message) =>
            createUserMessage(textOf(message).replace("u1", "PROJECTED-u1")),
          ),
        summarize: (input) => {
          summarized.push(input);
          return "summary-text";
        },
      }),
    });

    const summary = await session.run("u3");

    expect(summary.reason).toBe("done");
    expect(summarized).toHaveLength(1);
    expect(summarized[0]!.map(textOf)).toEqual(["u0", "PROJECTED-u1", "u2"]);
    expect(session.compactionView?.coveredCount).toBe(3);
    const calls = fake.getCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.messages.map(textOf)).toEqual([
      "[compacted 3]\nsummary-text",
      "u3",
    ]);
  });

  it("refuses a normal LLM call when a stale compacting sidecar has no running worker", async () => {
    stateStore.write(SID, {
      ...idleState(1),
      status: "compacting",
      attemptId: "stale-attempt",
      reason: "fallback",
    });
    const store = new MemorySessionStore();
    const session = makeSession({
      messages: [createUserMessage("u0")],
      store,
      compaction: sessionCompaction({ fallbackTokens: 1 }),
    });

    const summary = await session.run("u1");

    expect(summary.reason).toBe("error");
    expect(summary.error).toBeInstanceOf(CompactionRecoveryRequiredError);
    expect(fake.getCalls()).toHaveLength(0);
    expect(session.compactionState?.status).toBe("compacting");
  });

  it("recovers a stale compacting sidecar to retry_pending for the next gate", () => {
    const session = makeSession({
      messages: [createUserMessage("old"), createUserMessage("old-2")],
      compaction: sessionCompaction({ fallbackTokens: 1 }),
    });
    stateStore.write(
      SID,
      beginCompaction(idleState(1), { attemptId: "stale", reason: "fallback", now: 2 }),
    );

    expect(session.recoverStaleCompaction()).toBe(true);
    expect(session.compactionState?.status).toBe("retry_pending");
    expect(session.compactionState?.attemptId).toBe("stale");
  });

  it("honors persisted fallback suppression", async () => {
    stateStore.write(SID, { ...idleState(1), fallbackSuppressed: true });
    const store = new MemorySessionStore();
    const session = makeSession({
      messages: [createUserMessage("u0")],
      store,
      compaction: sessionCompaction({ fallbackTokens: 1 }),
    });

    const summary = await session.run("u1");

    expect(summary.reason).toBe("done");
    expect(fake.getCalls()).toHaveLength(1);
    expect(session.compactionView).toBeNull();
  });
});
