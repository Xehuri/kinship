/**
 * P2c 会话级压缩协调器测试：AgentSession.commitCompaction 的持久化/只读视图契约，
 * 以及 coordinator 对 P2b worker 的薄适配（成功、reason 映射、快照副本、commit 失败）。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeModel, type FakeModel } from "../testing.js";
import { createUserMessage } from "../types.js";
import {
  ACTIVE_BOUNDARY_KEY,
  AgentSession,
  MemorySessionStore,
  type SessionEntry,
  type SessionStore,
  type StoredEntry,
} from "../index.js";
import { beginCompaction, idleState, type CompactionState } from "./compaction-state.js";
import { CompactionStateStore } from "./compaction-state-store.js";
import { CompactionCoordinator, type CompactionCoordinatorOptions } from "./coordinator.js";
import type {
  CompactionCommit,
  CompactionWorkerEvent,
  CompactionWorkerOptions,
  WorkerOutcome,
} from "./worker.js";

const SID = "ses_coordinator";

let root: string;
let stateStore: CompactionStateStore;
let fake: FakeModel;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "loom-compaction-coordinator-"));
  stateStore = new CompactionStateStore({ stateRoot: root });
  fake = createFakeModel();
});

afterEach(() => {
  fake.teardown();
  rmSync(root, { recursive: true, force: true });
});

function user(text: string, timestamp: number): Message {
  return { role: "user", content: text, timestamp };
}

function assistant(text: string, timestamp: number): Message {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test-api",
    provider: "test-provider",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  };
}

function textOf(message: Message): string {
  return typeof message.content === "string"
    ? message.content
    : message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

function newSession(messages: Message[], store?: SessionStore): AgentSession {
  return new AgentSession({
    sessionId: SID,
    model: fake,
    tools: [],
    initialMessages: messages,
    ...(store === undefined ? {} : { store }),
  });
}

interface CoordinatorOverrides {
  readonly summarize?: CompactionCoordinatorOptions["summarize"];
  readonly wrapSummary?: CompactionCoordinatorOptions["wrapSummary"];
  readonly workerOptions?: Partial<Omit<CompactionWorkerOptions, "onEvent">>;
  readonly onEvent?: (event: CompactionWorkerEvent) => void;
}

function makeCoordinator(
  session: AgentSession,
  overrides: CoordinatorOverrides = {},
): CompactionCoordinator {
  return new CompactionCoordinator({
    session,
    stateStore,
    summarize: overrides.summarize ?? (() => "summary-text"),
    wrapSummary:
      overrides.wrapSummary ?? ((text, count) => `[compacted ${String(count)}]\n${text}`),
    workerOptions: {
      keepRecent: 2,
      summaryChunkTokens: 1_000,
      sleep: async () => {},
      random: () => 0.5,
      ...overrides.workerOptions,
    },
    ...(overrides.onEvent === undefined ? {} : { onEvent: overrides.onEvent }),
  });
}

function expectCompacted(
  outcome: WorkerOutcome,
): Extract<WorkerOutcome, { kind: "compacted" }> {
  expect(outcome.ok).toBe(true);
  if (!outcome.ok || outcome.kind !== "compacted") {
    throw new Error(`expected compacted outcome, got ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

function expectFailed(
  outcome: WorkerOutcome,
): Extract<WorkerOutcome, { kind: "failed" }> {
  expect(outcome.ok).toBe(false);
  if (outcome.ok || outcome.kind !== "failed") {
    throw new Error(`expected failed outcome, got ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

function boundaryEntries(
  entries: readonly StoredEntry[],
): Array<Extract<SessionEntry, { kind: "compaction_boundary" }>> {
  return entries.flatMap((stored) =>
    stored.entry.kind === "compaction_boundary" ? [stored.entry] : [],
  );
}

/** 可在 commit 阶段注入 append 失败的 store（其余行为同内存实现）。 */
class ToggleBoundaryFailureStore extends MemorySessionStore {
  failBoundaryAppends = false;

  override async appendEntry(sessionId: string, entry: SessionEntry): Promise<StoredEntry> {
    if (this.failBoundaryAppends && entry.kind === "compaction_boundary") {
      throw new Error("boundary append failed");
    }
    return super.appendEntry(sessionId, entry);
  }
}

describe("CompactionCoordinator success path", () => {
  it("persists exactly one boundary, updates the view only, and moves state compacting -> idle", async () => {
    const messages = [
      user("u0", 100),
      assistant("a0", 200),
      user("u1", 300),
      assistant("a1", 400),
    ];
    const sessionStore = new MemorySessionStore();
    const session = newSession(messages, sessionStore);
    const events: CompactionWorkerEvent[] = [];
    let statusAtStart: CompactionState["status"] | null = null;

    const coordinator = makeCoordinator(session, {
      onEvent: (event) => {
        events.push(event);
        if (event.type === "started") statusAtStart = coordinator.state?.status ?? null;
      },
    });

    const { attemptId, done } = coordinator.start("manual");
    const outcome = expectCompacted(await done);

    expect(outcome.attemptId).toBe(attemptId);
    expect(outcome.coveredCount).toBe(2);
    expect(coordinator.isRunning).toBe(false);

    const entries = await sessionStore.getPathToLeaf(session.id);
    const boundaries = boundaryEntries(entries);
    expect(boundaries).toHaveLength(1);
    const boundary = boundaries[0]!;
    expect(boundary.checkpoint).toMatchObject({
      version: 1,
      coveredCount: 2,
      anchorTimestampMs: messages[2]!.timestamp,
      summaryId: outcome.checkpointId,
      source: "manual",
    });
    expect(typeof boundary.checkpoint?.createdAt).toBe("number");
    expect(boundary.checkpoint?.tailIncluded).toBe(false);
    expect(textOf(boundary.summary)).toBe("[compacted 2]\nsummary-text");

    expect(session.compactionView).toEqual({
      coveredCount: 2,
      summaryText: "[compacted 2]\nsummary-text",
      anchorMessageId: null,
      anchorTimestampMs: messages[2]!.timestamp,
      totalMessages: 4,
    });
    expect(session.messages).toHaveLength(messages.length);
    expect(session.messages).toEqual(messages);

    expect(statusAtStart).toBe("compacting");
    expect(coordinator.state?.status).toBe("idle");
    expect(coordinator.state?.baseCoveredCount).toBe(2);
    expect(coordinator.state?.baseCheckpointId).toBe(outcome.checkpointId);
    expect(events.map((event) => event.type)).toEqual(["started", "succeeded"]);
  });

  it.each([
    ["tool", "manual"],
    ["watermark", "auto"],
    ["fallback", "auto"],
  ] as const)("maps reason %s to checkpoint source %s", async (reason, expectedSource) => {
    const messages = [
      user("u0", 100),
      assistant("a0", 200),
      user("u1", 300),
      assistant("a1", 400),
    ];
    const sessionStore = new MemorySessionStore();
    const session = newSession(messages, sessionStore);
    const coordinator = makeCoordinator(session);

    expectCompacted(await coordinator.start(reason).done);

    const boundaries = boundaryEntries(await sessionStore.getPathToLeaf(session.id));
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0]!.checkpoint?.source).toBe(expectedSource);
  });
});

describe("AgentSession compaction snapshot", () => {
  it("copies raw and reads prevCovered from the live boundary", async () => {
    const messages = [
      user("u0", 100),
      assistant("a0", 200),
      user("u1", 300),
      assistant("a1", 400),
    ];
    const session = newSession(messages, new MemorySessionStore());

    const before = session.getCompactionSnapshot();
    expect(before.prevCovered).toBe(0);
    expect(before.raw).toHaveLength(messages.length);
    before.raw.push(createUserMessage("mutated"));
    expect(session.messages).toHaveLength(messages.length);

    const commit: CompactionCommit = {
      attemptId: "attempt-1",
      reason: "manual",
      coveredCount: 2,
      summary: createUserMessage("[compacted 2]\nsummary-text"),
      summaryText: "summary-text",
      checkpointId: "checkpoint-1",
      anchorTimestampMs: messages[2]!.timestamp,
    };
    await session.commitCompaction(commit);

    const after = session.getCompactionSnapshot();
    expect(after.prevCovered).toBe(2);
    expect(after.raw).toHaveLength(messages.length);
    after.raw.pop();
    expect(session.messages).toHaveLength(messages.length);
    expect(after.ctx.state.get(ACTIVE_BOUNDARY_KEY)).toMatchObject({
      summary: commit.summary,
      coveredCount: 2,
      checkpointId: "checkpoint-1",
      anchorTimestampMs: messages[2]!.timestamp,
      persisted: true,
    });
  });

  it("commitCompaction refuses to run without a session store", async () => {
    const session = newSession([user("u0", 100)]);
    const commit: CompactionCommit = {
      attemptId: "attempt-1",
      reason: "manual",
      coveredCount: 1,
      summary: createUserMessage("summary"),
      summaryText: "summary",
      checkpointId: "checkpoint-1",
      anchorTimestampMs: null,
    };
    await expect(session.commitCompaction(commit)).rejects.toThrow(/has no store/);
  });
});

describe("CompactionCoordinator commit failure", () => {
  it("leaves the active boundary unchanged and moves state to retry_pending", async () => {
    const messages = [
      user("u0", 100),
      assistant("a0", 200),
      user("u1", 300),
      assistant("a1", 400),
      user("u2", 500),
      assistant("a2", 600),
    ];
    const sessionStore = new ToggleBoundaryFailureStore();
    const session = newSession(messages, sessionStore);

    const existingSummary = createUserMessage("[compacted 2]\nold-summary");
    await session.commitCompaction({
      attemptId: "attempt-old",
      reason: "manual",
      coveredCount: 2,
      summary: existingSummary,
      summaryText: "old-summary",
      checkpointId: "old-checkpoint",
      anchorTimestampMs: messages[2]!.timestamp,
    });
    expect(session.compactionView?.coveredCount).toBe(2);
    sessionStore.failBoundaryAppends = true;

    const events: CompactionWorkerEvent[] = [];
    const coordinator = makeCoordinator(session, {
      summarize: () => "new-summary",
      workerOptions: { keepRecent: 1 },
      onEvent: (event) => events.push(event),
    });

    const outcome = expectFailed(await coordinator.start("manual").done);

    expect(outcome.error.message).toContain("boundary append failed");
    expect(outcome.errorClass).toBe("terminal");

    const boundaries = boundaryEntries(await sessionStore.getPathToLeaf(session.id));
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0]!.checkpoint?.summaryId).toBe("old-checkpoint");

    expect(session.compactionView?.coveredCount).toBe(2);
    expect(session.compactionView?.summaryText).toBe("[compacted 2]\nold-summary");
    expect(session.getCompactionSnapshot().prevCovered).toBe(2);

    expect(coordinator.state?.status).toBe("retry_pending");
    expect(coordinator.state?.lastError).toContain("boundary append failed");
    expect(coordinator.state?.baseCoveredCount).toBe(2);
    expect(coordinator.state?.baseCheckpointId).toBeNull();
    expect(events.map((event) => event.type)).toEqual(["started", "failed"]);
  });
});

describe("CompactionCoordinator stale recovery", () => {
  it("moves a crash-left compacting sidecar to retry_pending without starting an attempt", () => {
    const session = newSession([user("u0", 100)]);
    const coordinator = makeCoordinator(session);
    stateStore.write(
      SID,
      beginCompaction(idleState(1), {
        attemptId: "stale-attempt",
        reason: "fallback",
        now: 2,
      }),
    );

    const recovered = coordinator.recoverStaleCompacting("stale after crash");

    expect(recovered).toMatchObject({
      status: "retry_pending",
      attemptId: "stale-attempt",
      reason: "fallback",
      lastError: "stale after crash",
    });
    expect(coordinator.state?.status).toBe("retry_pending");
    expect(coordinator.isRunning).toBe(false);
  });
});
