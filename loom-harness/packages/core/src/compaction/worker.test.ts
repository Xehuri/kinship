/**
 * W57 背景压缩 worker 单测：状态迁移、共享重试预算、超时、abort、commit 失败与 noop。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestContext } from "../testing.js";
import { createUserMessage } from "../types.js";
import {
  beginCompaction,
  idleState,
  type CompactionReason,
  type CompactionState,
} from "./compaction-state.js";
import { CompactionStateStore } from "./compaction-state-store.js";
import { projectToolResultsForSummary } from "./summary-projection.js";
import {
  CompactionBusyError,
  CompactionWorker,
  type CompactionCommit,
  type CompactionWorkerDeps,
  type CompactionWorkerEvent,
  type CompactionWorkerOptions,
  type WorkerOutcome,
} from "./worker.js";

const SID = "ses_worker";

let root: string;
let store: CompactionStateStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "loom-compaction-worker-"));
  store = new CompactionStateStore({ stateRoot: root });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function user(text: string): Message {
  return createUserMessage(text);
}

function textOf(message: Message): string {
  return typeof message.content === "string"
    ? message.content
    : message.content.map((block) => ("text" in block ? block.text : "")).join("");
}

function assistant(text: string): Message {
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
    timestamp: 0,
  };
}

function toolResult(toolName: string, text: string, callId = `${toolName}-call`): Message {
  return {
    role: "toolResult",
    toolCallId: callId,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 0,
  };
}

/**
 * 2026-10-21 生产实测形状：长度 2984，index 0 为上一份摘要，1..2981 为历史消息，
 * 2982 为本 turn 用户提示，2983 为 assistant 工具调用。index 2976 的长消息让
 * keepRecentTokens=15000 的 tail 预算恰好把边界顶回 2976（生产 coveredCount）。
 */
function productionShape(): Message[] {
  const raw: Message[] = [user("PREV-SUMMARY")];
  for (let i = 1; i <= 2981; i++) {
    raw.push(user(i === 2976 ? "x".repeat(60_000) : `m${String(i)}`));
  }
  raw.push(user("CURRENT TURN PROMPT"));
  raw.push(assistant("tool call"));
  return raw;
}

function readState(): CompactionState {
  const result = store.read(SID);
  if (result.kind !== "ok") throw new Error(`expected ok sidecar, got ${result.kind}`);
  return result.state;
}

function makeWorker(
  raw: Message[],
  overrides: Partial<CompactionWorkerDeps> = {},
  options: Partial<CompactionWorkerOptions> = {},
  prevCovered = 0,
): CompactionWorker {
  const { ctx } = createTestContext();
  return new CompactionWorker(
    {
      sessionId: SID,
      stateStore: store,
      summarize: () => "summary-text",
      commit: async () => {},
      context: () => ({ raw, prevCovered, ctx }),
      wrapSummary: (text, count) => `[compacted ${String(count)}]\n${text}`,
      ...overrides,
    },
    {
      keepRecent: 2,
      summaryChunkTokens: 1_000,
      sleep: async () => {},
      random: () => 0.5,
      ...options,
    },
  );
}

function expectCompacted(outcome: WorkerOutcome): Extract<WorkerOutcome, { kind: "compacted" }> {
  expect(outcome.ok).toBe(true);
  if (!outcome.ok || outcome.kind !== "compacted") {
    throw new Error(`expected compacted outcome, got ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

describe("CompactionWorker success path", () => {
  it("summarizes the prefix, commits once with anchor, and moves compacting -> idle", async () => {
    const raw = [user("one"), user("two"), user("three"), user("four")];
    const commits: CompactionCommit[] = [];
    const events: CompactionWorkerEvent[] = [];
    let stateDuringCommit: string | null = null;
    const wrapped: Array<[string, number]> = [];

    const worker = makeWorker(
      raw,
      {
        commit: async (commit) => {
          commits.push(commit);
          stateDuringCommit = readState().status;
        },
        wrapSummary: (text, count) => {
          wrapped.push([text, count]);
          return `[compacted ${String(count)}]\n${text}`;
        },
      },
      { onEvent: (event) => events.push(event) },
    );

    const { attemptId, done } = worker.start({ reason: "manual" });
    const outcome = expectCompacted(await done);

    expect(commits).toHaveLength(1);
    const commit = commits[0]!;
    expect(commit.attemptId).toBe(attemptId);
    expect(commit.reason).toBe("manual");
    expect(commit.coveredCount).toBe(2);
    expect(commit.summaryText).toBe("summary-text");
    expect(textOf(commit.summary)).toBe("[compacted 2]\nsummary-text");
    expect(commit.anchorTimestampMs).toBe(raw[2]!.timestamp);
    expect(commit.checkpointId.length).toBeGreaterThan(0);
    expect(stateDuringCommit).toBe("compacting");
    expect(wrapped).toEqual([["summary-text", 2]]);
    expect(outcome.anchorTimestampMs).toBe(raw[2]!.timestamp);
    expect(events.map((event) => event.type)).toEqual(["started", "succeeded"]);

    const state = readState();
    expect(state.status).toBe("idle");
    expect(state.attemptId).toBeNull();
    expect(state.baseCoveredCount).toBe(2);
    expect(state.baseCheckpointId).toBe(commit.checkpointId);
    expect(worker.isRunning).toBe(false);
    expect(await worker.wait()).toEqual(outcome);
  });

  it("returns noop without commit when the whole history is the recent tail", async () => {
    let commits = 0;
    const worker = makeWorker([user("a"), user("b")], {
      commit: async () => {
        commits += 1;
      },
    });

    const outcome = await worker.start({ reason: "tool" }).done;

    expect(outcome.ok).toBe(true);
    expect(outcome.kind).toBe("noop");
    expect(commits).toBe(0);
    const state = readState();
    expect(state.status).toBe("idle");
    expect(state.baseCoveredCount).toBe(0);
  });
});

describe("CompactionWorker production 2984/2982 shape", () => {
  const productionOptions = {
    keepRecent: 8,
    keepRecentTokens: 15_000,
    summaryChunkTokens: 100_000,
    resummarizeEvery: 16,
  };

  it("no-ops when a near-end floor equals the last user index", async () => {
    const raw = productionShape();
    const commits: CompactionCommit[] = [];
    const worker = makeWorker(
      raw,
      {
        commit: async (commit) => {
          commits.push(commit);
        },
      },
      productionOptions,
      1,
    );

    const outcome = await worker.start({ reason: "tool", floor: 2982 }).done;

    expect(raw).toHaveLength(2984);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.kind !== "noop") {
      throw new Error(`expected noop outcome, got ${JSON.stringify(outcome)}`);
    }
    expect(outcome.kind).toBe("noop");
    expect(outcome.coveredCount).toBe(2982);
    expect(commits).toHaveLength(0);
    expect(readState().baseCoveredCount).toBe(1);
  });

  it("compacts from prevCovered without a floor in the 2984/2982 shape", async () => {
    const raw = productionShape();
    const calls: Message[][] = [];
    const commits: CompactionCommit[] = [];
    const worker = makeWorker(
      raw,
      {
        summarize: (messages) => {
          calls.push(messages);
          return "summary-text";
        },
        commit: async (commit) => {
          commits.push(commit);
        },
      },
      productionOptions,
      1,
    );

    const outcome = expectCompacted(await worker.start({ reason: "tool" }).done);

    expect(outcome.coveredCount).toBe(2976);
    expect(commits).toHaveLength(1);
    expect(commits[0]!.coveredCount).toBe(2976);
    const summarized = calls
      .flat()
      .map((message) => textOf(message))
      .join("\n");
    expect(summarized).not.toContain("CURRENT TURN PROMPT");
    expect(
      raw.slice(2976).some((message) => textOf(message).includes("CURRENT TURN PROMPT")),
    ).toBe(true);
  });
});

describe("CompactionWorker retry policy", () => {
  it("retries a transient failure with the same request bytes and one commit", async () => {
    const raw = [user("one"), user("two"), user("three"), user("four")];
    const calls: Message[][] = [];
    const delays: number[] = [];
    let attempts = 0;
    let commits = 0;
    const events: CompactionWorkerEvent[] = [];

    const worker = makeWorker(
      raw,
      {
        summarize: (messages) => {
          calls.push(messages);
          attempts += 1;
          if (attempts === 1) throw { kind: "transient", message: "upstream reset" };
          return "recovered-summary";
        },
        commit: async () => {
          commits += 1;
        },
      },
      {
        sleep: async (ms) => {
          delays.push(ms);
        },
        onEvent: (event) => events.push(event),
      },
    );

    const outcome = expectCompacted(await worker.start({ reason: "manual" }).done);

    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe(calls[0]);
    expect(delays).toEqual([2_000]);
    expect(commits).toBe(1);
    expect(outcome.attemptsUsed).toBe(1);
    expect(events.filter((event) => event.type === "retrying")).toEqual([
      expect.objectContaining({ type: "retrying", retry: 1, delayMs: 2_000 }),
    ]);
    expect(readState().status).toBe("idle");
  });

  it("exhausts the shared budget after 10 retries and leaves retry_pending", async () => {
    const raw = [user("one"), user("two"), user("three"), user("four")];
    let calls = 0;
    let commits = 0;
    const delays: number[] = [];

    const worker = makeWorker(
      raw,
      {
        summarize: () => {
          calls += 1;
          throw { kind: "transient", message: "still down" };
        },
        commit: async () => {
          commits += 1;
        },
      },
      {
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );

    const outcome = await worker.start({ reason: "watermark" }).done;

    expect(calls).toBe(11);
    expect(delays).toHaveLength(10);
    expect(commits).toBe(0);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.kind).toBe("failed");
    expect(outcome.attemptsUsed).toBe(10);
    const state = readState();
    expect(state.status).toBe("retry_pending");
    expect(state.attemptsUsed).toBe(10);
    expect(state.lastError).toBe("still down");
  });

  it.each([
    ["overflow", { stopReason: "length" }, "retry_pending", "failed"],
    ["sync", { kind: "sync" }, "retry_pending", "failed"],
    ["abort", { kind: "abort" }, "idle", "aborted"],
  ] as const)(
    "does not retry %s failures",
    async (_label, thrown, expectedStatus, expectedKind) => {
      const raw = [user("one"), user("two"), user("three"), user("four")];
      let calls = 0;
      let commits = 0;

      const worker = makeWorker(raw, {
        summarize: () => {
          calls += 1;
          throw thrown;
        },
        commit: async () => {
          commits += 1;
        },
      });

      const outcome = await worker.start({ reason: "manual" }).done;

      expect(calls).toBe(1);
      expect(commits).toBe(0);
      expect(outcome.kind).toBe(expectedKind);
      expect(readState().status).toBe(expectedStatus);
    },
  );

  it("times out a hung request, consumes the retry budget, and fails without hanging", async () => {
    const raw = [user("one"), user("two"), user("three"), user("four")];
    let calls = 0;

    const worker = makeWorker(
      raw,
      {
        summarize: () => {
          calls += 1;
          return new Promise<string>(() => {});
        },
      },
      { requestTimeoutMs: 10, retryCount: 1 },
    );

    const outcome = await worker.start({ reason: "fallback" }).done;

    expect(calls).toBe(2);
    expect(outcome.ok).toBe(false);
    if (outcome.ok || outcome.kind !== "failed") throw new Error("expected failure");
    expect(outcome.kind).toBe("failed");
    expect(outcome.attemptsUsed).toBe(1);
    expect(outcome.error.name).toBe("CompactionRequestTimeoutError");
    expect(readState().status).toBe("retry_pending");
  });

  it("shares one budget across chunks so later chunks see the remaining retries", async () => {
    const raw = [user("a".repeat(400)), user("b".repeat(400)), user("c".repeat(400))];
    const delays: number[] = [];
    let calls = 0;
    let commits = 0;

    const worker = makeWorker(
      raw,
      {
        summarize: () => {
          calls += 1;
          if (calls === 1 || calls === 2 || calls === 4) {
            throw { kind: "transient", message: `chunk-fail-${String(calls)}` };
          }
          return calls === 6 ? "merged-summary" : `partial-${String(calls)}`;
        },
        commit: async () => {
          commits += 1;
        },
      },
      {
        keepRecent: 1,
        summaryChunkTokens: 150,
        retryCount: 3,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );

    const outcome = expectCompacted(await worker.start({ reason: "manual" }).done);

    expect(calls).toBe(6);
    expect(delays).toEqual([2_000, 4_000, 8_000]);
    expect(commits).toBe(1);
    expect(outcome.summaryText).toBe("merged-summary");
    expect(outcome.attemptsUsed).toBe(3);
  });
});

describe("CompactionWorker abort", () => {
  it("aborts a hung request to idle without commit", async () => {
    const raw = [user("one"), user("two"), user("three"), user("four")];
    let entered!: () => void;
    const requestEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let commits = 0;

    const worker = makeWorker(
      raw,
      {
        summarize: () => {
          entered();
          return new Promise<string>(() => {});
        },
        commit: async () => {
          commits += 1;
        },
      },
      { requestTimeoutMs: 1_000 },
    );

    const { done } = worker.start({ reason: "manual" });
    await requestEntered;
    worker.abort("user cancelled");
    const outcome = await done;

    expect(outcome.ok).toBe(false);
    if (outcome.ok || outcome.kind !== "aborted") throw new Error("expected abort");
    expect(outcome.kind).toBe("aborted");
    expect(outcome.abortReason).toBe("user cancelled");
    expect(commits).toBe(0);
    expect(readState().status).toBe("idle");
  });

  it("aborts during retry sleep to idle without commit", async () => {
    const raw = [user("one"), user("two"), user("three"), user("four")];
    let sleepEntered!: () => void;
    const sleeping = new Promise<void>((resolve) => {
      sleepEntered = resolve;
    });
    let sleeps = 0;

    const worker = makeWorker(
      raw,
      {
        summarize: () => {
          throw { kind: "transient", message: "down" };
        },
      },
      {
        sleep: () => {
          sleeps += 1;
          sleepEntered();
          return new Promise<void>(() => {});
        },
      },
    );

    const { done } = worker.start({ reason: "manual" });
    await sleeping;
    worker.abort();
    const outcome = await done;

    expect(outcome.ok).toBe(false);
    if (outcome.ok || outcome.kind !== "aborted") throw new Error("expected abort");
    expect(outcome.kind).toBe("aborted");
    expect(sleeps).toBe(1);
    expect(readState().status).toBe("idle");
  });
});

describe("CompactionWorker failure paths", () => {
  it("treats a commit throw as a failed attempt without writing success", async () => {
    const raw = [user("one"), user("two"), user("three"), user("four")];
    let commits = 0;

    const worker = makeWorker(raw, {
      commit: async () => {
        commits += 1;
        throw new Error("boundary write failed");
      },
    });

    const outcome = await worker.start({ reason: "manual" }).done;

    expect(commits).toBe(1);
    expect(outcome.ok).toBe(false);
    if (outcome.ok || outcome.kind !== "failed") throw new Error("expected failure");
    expect(outcome.kind).toBe("failed");
    expect(outcome.error.message).toBe("boundary write failed");
    const state = readState();
    expect(state.status).toBe("retry_pending");
    expect(state.lastError).toBe("boundary write failed");
    expect(state.baseCheckpointId).toBeNull();
  });

  it("rejects a second start while an attempt is in flight", async () => {
    const raw = [user("one"), user("two"), user("three"), user("four")];
    let entered!: () => void;
    const requestEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });

    const worker = makeWorker(
      raw,
      {
        summarize: () => {
          entered();
          return new Promise<string>(() => {});
        },
      },
      { requestTimeoutMs: 1_000 },
    );

    const first = worker.start({ reason: "manual" });
    await requestEntered;
    expect(() => worker.start({ reason: "tool" })).toThrow(CompactionBusyError);
    expect(worker.isRunning).toBe(true);

    worker.abort();
    await first.done;
    expect(worker.isRunning).toBe(false);
  });

  it("refuses to start when the sidecar still says compacting", () => {
    store.write(
      SID,
      beginCompaction(idleState(1), { attemptId: "cmp_stale", reason: "manual", now: 2 }),
    );
    const worker = makeWorker([user("one")]);

    expect(() => worker.start({ reason: "manual" })).toThrow(CompactionBusyError);
  });
});

describe("CompactionWorker summary mode threading", () => {
  it("single mode calls summarize once and commits the raw prefix boundary", async () => {
    const raw = [user("one"), user("two"), user("three"), user("four")];
    const calls: Message[][] = [];
    const commits: CompactionCommit[] = [];

    const worker = makeWorker(
      raw,
      {
        summarize: (messages) => {
          calls.push(messages);
          return "single-summary";
        },
        commit: async (commit) => {
          commits.push(commit);
        },
      },
      { summaryMode: "single", singleCallBudgetTokens: 10_000 },
    );

    const outcome = expectCompacted(await worker.start({ reason: "manual" }).done);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.map(textOf)).toEqual(["one", "two"]);
    expect(commits).toHaveLength(1);
    expect(commits[0]!.coveredCount).toBe(2);
    expect(commits[0]!.anchorTimestampMs).toBe(raw[2]!.timestamp);
    expect(outcome.coveredCount).toBe(2);
    expect(outcome.anchorTimestampMs).toBe(raw[2]!.timestamp);
    expect(raw.map(textOf)).toEqual(["one", "two", "three", "four"]);
  });

  it("auto mode over budget splits recursively: two halves plus merge, one commit", async () => {
    const raw = Array.from({ length: 6 }, (_, i) => user(`${String(i)}:` + "x".repeat(400)));
    const calls: Message[][] = [];
    const commits: CompactionCommit[] = [];

    const worker = makeWorker(
      raw,
      {
        summarize: (messages) => {
          calls.push(messages);
          return `partial-${String(calls.length)}`;
        },
        commit: async (commit) => {
          commits.push(commit);
        },
      },
      { summaryMode: "auto", singleCallBudgetTokens: 250 },
    );

    const outcome = expectCompacted(await worker.start({ reason: "manual" }).done);

    expect(calls).toHaveLength(3);
    expect(calls[0]).toHaveLength(2);
    expect(calls[1]).toHaveLength(2);
    expect(calls[2]!.map(textOf).join("\n")).toContain("2 段分段摘要");
    expect(commits).toHaveLength(1);
    expect(commits[0]!.coveredCount).toBe(4);
    expect(commits[0]!.anchorTimestampMs).toBe(raw[4]!.timestamp);
    expect(outcome.coveredCount).toBe(4);
  });

  it("projectSummaryInput only changes summarize input; commit coordinates stay raw", async () => {
    const raw = [
      user("question"),
      toolResult("read", "OLD_TOOL_OUTPUT"),
      user("next"),
      user("tail"),
    ];
    const calls: Message[][] = [];
    const commits: CompactionCommit[] = [];

    const worker = makeWorker(
      raw,
      {
        summarize: (messages) => {
          calls.push(messages);
          return "projected-summary";
        },
        commit: async (commit) => {
          commits.push(commit);
        },
        projectSummaryInput: (messages) =>
          projectToolResultsForSummary(messages, {
            compactableTools: new Set(["read"]),
            keepRecent: 0,
          }),
      },
      { summaryMode: "single", singleCallBudgetTokens: 10_000 },
    );

    const outcome = expectCompacted(await worker.start({ reason: "manual" }).done);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.map(textOf)).toEqual([
      "question",
      "[microcompact: read output cleared, ~15 chars]",
    ]);
    expect(commits).toHaveLength(1);
    expect(commits[0]!.coveredCount).toBe(2);
    expect(commits[0]!.anchorTimestampMs).toBe(raw[2]!.timestamp);
    expect(outcome.anchorTimestampMs).toBe(raw[2]!.timestamp);
    expect(textOf(raw[1]!)).toBe("OLD_TOOL_OUTPUT");
  });

  it("defaults to chunked behavior when no mode or budget is given", async () => {
    const raw = Array.from({ length: 6 }, (_, i) => user(`${String(i)}:` + "x".repeat(400)));
    const calls: Message[][] = [];

    const worker = makeWorker(
      raw,
      {
        summarize: (messages) => {
          calls.push(messages);
          return `partial-${String(calls.length)}`;
        },
      },
      { summaryChunkTokens: 150 },
    );

    const outcome = expectCompacted(await worker.start({ reason: "manual" }).done);

    expect(calls).toHaveLength(5);
    expect(calls.slice(0, 4).every((messages) => messages.length === 1)).toBe(true);
    expect(calls[4]!.map(textOf).join("\n")).toContain("4 段分段摘要");
    expect(outcome.coveredCount).toBe(4);
  });

  it("retries a truncated stream once and then leaves the state idle", async () => {
    const raw = [user("one"), user("two"), user("three"), user("four")];
    const calls: Message[][] = [];
    let attempts = 0;

    const worker = makeWorker(raw, {
      summarize: (messages) => {
        calls.push(messages);
        attempts += 1;
        if (attempts === 1) throw new Error("Stream ended without finish_reason");
        return "recovered-summary";
      },
    });

    const outcome = expectCompacted(await worker.start({ reason: "manual" }).done);

    expect(calls).toHaveLength(2);
    expect(outcome.attemptsUsed).toBe(1);
    expect(readState().status).toBe("idle");
  });

  it("rejects summaryMode single without a budget at construction", () => {
    const raw = [user("one"), user("two"), user("three")];
    expect(() => makeWorker(raw, {}, { summaryMode: "single" })).toThrow(
      /singleCallBudgetTokens/,
    );
  });
});
