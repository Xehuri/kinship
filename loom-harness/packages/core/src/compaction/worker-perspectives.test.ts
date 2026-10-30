import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestContext } from "../testing.js";
import { createUserMessage } from "../types.js";
import type { CompactionState } from "./compaction-state.js";
import { CompactionStateStore } from "./compaction-state-store.js";
import {
  CompactionWorker,
  type CompactionCommit,
  type CompactionSummaryPerspective,
  type CompactionWorkerDeps,
  type CompactionWorkerEvent,
  type CompactionWorkerOptions,
  type SummarizeFn,
  type WorkerOutcome,
} from "./worker.js";

const SID = "ses_worker_perspectives";
const CHAT_TITLE = "CHAT CONTINUITY";

let root: string;
let store: CompactionStateStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "loom-compaction-perspectives-"));
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

function chatPerspective(
  summarize: SummarizeFn,
  buildMergePrompt?: (partials: readonly string[]) => string,
): CompactionSummaryPerspective {
  return {
    key: "chat",
    title: CHAT_TITLE,
    summarize,
    ...(buildMergePrompt === undefined ? {} : { buildMergePrompt }),
  };
}

describe("CompactionWorker summary perspectives", () => {
  it("summarizes ops then chat over one covered prefix and commits the combined text once", async () => {
    const raw = [user("one"), user("two"), user("three"), user("four")];
    const calls: string[] = [];
    const commits: CompactionCommit[] = [];
    const events: CompactionWorkerEvent[] = [];
    const wrapped: Array<[string, number]> = [];

    const worker = makeWorker(
      raw,
      {
        summarize: (messages, _ctx, onDelta) => {
          calls.push("ops");
          onDelta?.({ part: "content", delta: "o" });
          expect(messages.map(textOf)).toEqual(["one", "two"]);
          return "ops summary text";
        },
        additionalSummaryPerspectives: [
          chatPerspective((messages, _ctx, onDelta) => {
            calls.push("chat");
            onDelta?.({ part: "content", delta: "c" });
            expect(messages.map(textOf)).toEqual(["one", "two"]);
            return "chat summary text";
          }),
        ],
        commit: async (commit) => {
          commits.push(commit);
        },
        wrapSummary: (text, count) => {
          wrapped.push([text, count]);
          return `[compacted ${String(count)}]\n${text}`;
        },
      },
      {
        summaryMode: "single",
        singleCallBudgetTokens: 10_000,
        onEvent: (event) => events.push(event),
      },
    );

    const outcome = expectCompacted(await worker.start({ reason: "manual" }).done);
    const combined =
      "## OPS STATE\n\nops summary text\n\n## CHAT CONTINUITY\n\nchat summary text";

    expect(calls).toEqual(["ops", "chat"]);
    expect(commits).toHaveLength(1);
    expect(commits[0]!.coveredCount).toBe(2);
    expect(commits[0]!.summaryText).toBe(combined);
    expect(textOf(commits[0]!.summary)).toBe(`[compacted 2]\n${combined}`);
    expect(commits[0]!.tailIncluded).toBe(false);
    expect(wrapped).toEqual([[combined, 2]]);
    expect(outcome.summaryText).toBe(combined);
    expect(outcome.coveredCount).toBe(2);
    expect(outcome.anchorTimestampMs).toBe(raw[2]!.timestamp);
    expect(
      events
        .filter((event) => event.type === "delta")
        .map((event) => (event as Extract<CompactionWorkerEvent, { type: "delta" }>).perspective),
    ).toEqual(["ops", "chat"]);
    expect(readState().status).toBe("idle");
  });

  it("keeps the single-perspective path byte-identical with no perspective event fields", async () => {
    const raw = [user("one"), user("two"), user("three"), user("four")];
    const commits: CompactionCommit[] = [];
    const events: CompactionWorkerEvent[] = [];
    const wrapped: Array<[string, number]> = [];

    const worker = makeWorker(
      raw,
      {
        summarize: (_messages, _ctx, onDelta) => {
          onDelta?.({ part: "content", delta: "legacy" });
          return "summary-text";
        },
        commit: async (commit) => {
          commits.push(commit);
        },
        wrapSummary: (text, count) => {
          wrapped.push([text, count]);
          return `[compacted ${String(count)}]\n${text}`;
        },
      },
      {
        summaryMode: "single",
        singleCallBudgetTokens: 10_000,
        onEvent: (event) => events.push(event),
      },
    );

    const outcome = expectCompacted(await worker.start({ reason: "manual" }).done);

    expect(commits).toHaveLength(1);
    expect(commits[0]!.summaryText).toBe("summary-text");
    expect(textOf(commits[0]!.summary)).toBe("[compacted 2]\nsummary-text");
    expect(wrapped).toEqual([["summary-text", 2]]);
    expect(outcome.summaryText).toBe("summary-text");
    expect(events.map((event) => event.type)).toEqual(["started", "delta", "succeeded"]);
    expect(events.every((event) => !("perspective" in event))).toBe(true);
  });

  it("fails all-or-nothing with the chat perspective on a non-transient chat error", async () => {
    const raw = [user("one"), user("two"), user("three"), user("four")];
    const calls: string[] = [];
    const commits: CompactionCommit[] = [];
    const events: CompactionWorkerEvent[] = [];

    const worker = makeWorker(
      raw,
      {
        summarize: () => {
          calls.push("ops");
          return "ops summary text";
        },
        additionalSummaryPerspectives: [
          chatPerspective(() => {
            calls.push("chat");
            throw { kind: "sync", message: "chat hard failure" };
          }),
        ],
        commit: async (commit) => {
          commits.push(commit);
        },
      },
      {
        summaryMode: "single",
        singleCallBudgetTokens: 10_000,
        onEvent: (event) => events.push(event),
      },
    );

    const outcome = await worker.start({ reason: "manual" }).done;

    expect(calls).toEqual(["ops", "chat"]);
    expect(commits).toHaveLength(0);
    expect(outcome.ok).toBe(false);
    if (outcome.ok || outcome.kind !== "failed") throw new Error("expected failure");
    expect(outcome.kind).toBe("failed");
    expect(outcome.error.message).toBe("chat hard failure");
    expect(outcome.errorClass).toBe("sync");
    expect(
      events.find((event) => event.type === "failed"),
    ).toEqual(expect.objectContaining({ type: "failed", perspective: "chat" }));
    expect(readState().status).toBe("retry_pending");
  });

  it("retries a transient chat failure without recomputing ops and commits once", async () => {
    const raw = [user("one"), user("two"), user("three"), user("four")];
    const calls: string[] = [];
    const commits: CompactionCommit[] = [];
    const events: CompactionWorkerEvent[] = [];
    let chatAttempts = 0;

    const worker = makeWorker(
      raw,
      {
        summarize: () => {
          calls.push("ops");
          return "ops summary text";
        },
        additionalSummaryPerspectives: [
          chatPerspective(() => {
            calls.push("chat");
            chatAttempts += 1;
            if (chatAttempts === 1) throw { kind: "transient", message: "chat reset" };
            return "chat summary text";
          }),
        ],
        commit: async (commit) => {
          commits.push(commit);
        },
      },
      {
        summaryMode: "single",
        singleCallBudgetTokens: 10_000,
        onEvent: (event) => events.push(event),
      },
    );

    const outcome = expectCompacted(await worker.start({ reason: "manual" }).done);
    const combined =
      "## OPS STATE\n\nops summary text\n\n## CHAT CONTINUITY\n\nchat summary text";

    expect(calls).toEqual(["ops", "chat", "chat"]);
    expect(commits).toHaveLength(1);
    expect(commits[0]!.summaryText).toBe(combined);
    expect(outcome.summaryText).toBe(combined);
    expect(outcome.attemptsUsed).toBe(1);
    expect(events.filter((event) => event.type === "retrying")).toEqual([
      expect.objectContaining({
        type: "retrying",
        retry: 1,
        delayMs: 2_000,
        perspective: "chat",
      }),
    ]);
    expect(readState().status).toBe("idle");
  });

  it("aborts during the chat perspective without committing", async () => {
    const raw = [user("one"), user("two"), user("three"), user("four")];
    const calls: string[] = [];
    let chatEntered!: () => void;
    const chatStarted = new Promise<void>((resolve) => {
      chatEntered = resolve;
    });
    let commits = 0;

    const worker = makeWorker(
      raw,
      {
        summarize: () => {
          calls.push("ops");
          return "ops summary text";
        },
        additionalSummaryPerspectives: [
          chatPerspective(() => {
            calls.push("chat");
            chatEntered();
            return new Promise<string>(() => {});
          }),
        ],
        commit: async () => {
          commits += 1;
        },
      },
      {
        summaryMode: "single",
        singleCallBudgetTokens: 10_000,
        requestTimeoutMs: 1_000,
      },
    );

    const { done } = worker.start({ reason: "manual" });
    await chatStarted;
    worker.abort("user cancelled");
    const outcome = await done;

    expect(calls).toEqual(["ops", "chat"]);
    expect(commits).toBe(0);
    expect(outcome.ok).toBe(false);
    if (outcome.ok || outcome.kind !== "aborted") throw new Error("expected abort");
    expect(outcome.kind).toBe("aborted");
    expect(outcome.abortReason).toBe("user cancelled");
    expect(readState().status).toBe("idle");
  });

  it("passes the generic merge prompt for ops and a custom merge prompt for chat", async () => {
    const raw = Array.from({ length: 4 }, (_, i) => user(`${String(i)}:` + "x".repeat(400)));
    const opsCalls: Message[][] = [];
    const chatCalls: Message[][] = [];
    const commits: CompactionCommit[] = [];

    const worker = makeWorker(
      raw,
      {
        summarize: (messages) => {
          opsCalls.push(messages);
          const text = messages.map(textOf).join("\n");
          return text.includes("段分段摘要") ? "ops final summary" : `ops partial ${String(opsCalls.length)}`;
        },
        additionalSummaryPerspectives: [
          chatPerspective(
            (messages) => {
              chatCalls.push(messages);
              const text = messages.map(textOf).join("\n");
              return text.startsWith("CHAT_MERGE")
                ? "chat final summary"
                : `chat partial ${String(chatCalls.length)}`;
            },
            (partials) => `CHAT_MERGE:${partials.join("|")}`,
          ),
        ],
        commit: async (commit) => {
          commits.push(commit);
        },
      },
      {
        keepRecent: 1,
        summaryChunkTokens: 60,
      },
    );

    const outcome = expectCompacted(await worker.start({ reason: "manual" }).done);

    expect(opsCalls).toHaveLength(4);
    expect(chatCalls).toHaveLength(4);
    expect(opsCalls[0]).toHaveLength(1);
    expect(textOf(opsCalls[0]![0]!)).toContain("0:");
    expect(chatCalls[0]).toHaveLength(1);
    expect(textOf(chatCalls[0]![0]!)).toContain("0:");
    const opsMerge = textOf(opsCalls[3]![0]!);
    expect(opsMerge).toContain("以下是同一条会话的 3 段分段摘要");
    expect(opsMerge).toContain("=== 分段 1 ===");
    expect(textOf(chatCalls[3]![0]!)).toBe(
      "CHAT_MERGE:chat partial 1|chat partial 2|chat partial 3",
    );
    expect(commits).toHaveLength(1);
    expect(commits[0]!.summaryText).toBe(
      "## OPS STATE\n\nops final summary\n\n## CHAT CONTINUITY\n\nchat final summary",
    );
    expect(outcome.coveredCount).toBe(3);
  });
});

describe("CompactionWorker additional perspective validation", () => {
  it("rejects an empty perspective array", () => {
    expect(() =>
      makeWorker([user("one"), user("two"), user("three")], {
        additionalSummaryPerspectives: [],
      }),
    ).toThrow(/non-empty array/);
  });

  it("rejects the reserved ops key, duplicate keys, and blank titles", () => {
    expect(() =>
      makeWorker([user("one"), user("two"), user("three")], {
        additionalSummaryPerspectives: [
          { key: "ops", title: "OPS AGAIN", summarize: () => "duplicate ops" },
        ],
      }),
    ).toThrow(/reserved/);

    expect(() =>
      makeWorker([user("one"), user("two"), user("three")], {
        additionalSummaryPerspectives: [
          chatPerspective(() => "chat summary one"),
          chatPerspective(() => "chat summary two"),
        ],
      }),
    ).toThrow(/duplicate key/);

    expect(() =>
      makeWorker([user("one"), user("two"), user("three")], {
        additionalSummaryPerspectives: [
          { key: "chat", title: "  ", summarize: () => "chat summary" },
        ],
      }),
    ).toThrow(/title must be a non-empty string/);
  });
});
