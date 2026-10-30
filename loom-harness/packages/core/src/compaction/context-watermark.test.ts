import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { createFakeModel, createTestContext, type FakeModel } from "../testing.js";
import { createUserMessage } from "../types.js";
import { AgentSession } from "../session.js";
import { MemorySessionStore } from "../session-store.js";
import { alignCoverBoundary, chooseTailStart } from "../plugins/auto-compaction.js";
import {
  assertValidWatermarkLevels,
  buildContextWatermarkMessage,
  contextWatermarkLevel,
  highestWatermarkLevelAtOrBelow,
  isContextWatermarkMessage,
} from "./context-watermark.js";
import { CompactionStateStore } from "./compaction-state-store.js";
import type { SessionCompactionOptions } from "./session-compaction.js";
import { summarizeCompactionPrefix } from "./summarize-prefix.js";

function textOf(message: Message): string {
  return typeof message.content === "string"
    ? message.content
    : message.content.map((block) => ("text" in block ? block.text : "")).join("");
}

function assistantUsage(input: number): Message {
  return {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    api: "openai-completions",
    provider: "fake",
    model: "fake",
    usage: {
      input,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
    error: false,
  } as unknown as Message;
}

describe("context watermark message", () => {
  it("builds the soft notice with marker and hard-cap reading", () => {
    const message = buildContextWatermarkMessage({
      level: 300_000,
      estimatedTokens: 320_000,
      hardCap: 750_000,
      now: 1,
    });
    const text = textOf(message);

    expect(isContextWatermarkMessage(message)).toBe(true);
    expect(contextWatermarkLevel(message)).toBe(300_000);
    expect(text).toContain("[context-watermark:300000]");
    expect(text).toContain("320k / 750k");
    expect(text).toContain("如果当前没有未完成事项");
    expect(text).not.toContain("收敛");
    expect(text).not.toContain("记忆");
    expect(text).not.toContain("自动压缩兜底");
  });

  it("adds the fallback sentence only at the highest configured level", () => {
    const message = buildContextWatermarkMessage({
      level: 600_000,
      estimatedTokens: 610_000,
      hardCap: 750_000,
      isHighest: true,
      now: 1,
    });
    expect(textOf(message)).toContain("达到 750k 时系统会自动压缩兜底");
  });

  it("selects the highest crossed level", () => {
    const levels = [300_000, 500_000, 600_000];
    expect(highestWatermarkLevelAtOrBelow(levels, 299_999)).toBe(0);
    expect(highestWatermarkLevelAtOrBelow(levels, 500_000)).toBe(500_000);
    expect(highestWatermarkLevelAtOrBelow(levels, 610_000)).toBe(600_000);
  });
});

describe("watermark boundary and summary exclusion", () => {
  const notice = buildContextWatermarkMessage({
    level: 300_000,
    estimatedTokens: 320_000,
    hardCap: 750_000,
    now: 1,
  });

  it("alignCoverBoundary never selects a watermark as the tail start", () => {
    const messages = [createUserMessage("u0"), notice, createUserMessage("u1")];
    expect(alignCoverBoundary(messages, 1, 0)).toBe(0);
  });

  it("chooseTailStart skips a watermark user boundary", () => {
    const messages = [
      createUserMessage("u0"),
      notice,
      createUserMessage("u1"),
      createUserMessage("u2"),
    ];
    expect(chooseTailStart(messages, { keepRecent: 3, floor: 0, hasPrevious: false })).toBe(0);
  });

  it("summarizeCompactionPrefix filters watermark notices from the model input", async () => {
    const { ctx } = createTestContext();
    const seen: Message[][] = [];
    await summarizeCompactionPrefix({
      prefix: [notice, createUserMessage("real")],
      summaryChunkTokens: 1000,
      ctx,
      summarize: (messages) => {
        seen.push(messages);
        return "summary";
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(1);
    expect(textOf(seen[0]![0]!)).toBe("real");
  });
});

describe("session watermark emission", () => {
  let root: string;
  let stateStore: CompactionStateStore;
  let fake: FakeModel;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "loom-watermark-"));
    stateStore = new CompactionStateStore({ stateRoot: root });
    fake = createFakeModel();
  });

  afterEach(() => {
    fake.teardown();
    rmSync(root, { recursive: true, force: true });
  });

  function options(
    levels: readonly number[],
    fallbackTokens = 1_000_000,
  ): SessionCompactionOptions {
    return {
      stateStore,
      summarize: () => "unused",
      wrapSummary: (text, count) => `[${count}]${text}`,
      fallbackTokens,
      keepRecent: 1,
      watermarkLevels: levels,
      summaryChunkTokens: 1000,
      retryCount: 0,
    };
  }

  it("emits one notice per level and restores the level from replay", async () => {
    const session = new AgentSession({
      sessionId: "ses_watermark",
      model: fake,
      tools: [],
      initialMessages: [createUserMessage("old")],
      compaction: options([1]),
    });

    await session.run("next");
    const first = session.messages.filter(isContextWatermarkMessage);
    expect(first).toHaveLength(1);
    expect(contextWatermarkLevel(first[0]!)).toBe(1);

    await session.run("again");
    expect(session.messages.filter(isContextWatermarkMessage)).toHaveLength(1);

    const replayed = new AgentSession({
      sessionId: "ses_watermark",
      model: fake,
      tools: [],
      initialMessages: [...session.messages],
      compaction: options([1]),
    });
    await replayed.run("third");
    expect(replayed.messages.filter(isContextWatermarkMessage)).toHaveLength(1);
  });

  it("resets after compaction and gives the next turn one grace period", async () => {
    const store = new MemorySessionStore();
    const session = new AgentSession({
      sessionId: "ses_watermark",
      model: fake,
      tools: [],
      store,
      initialMessages: [createUserMessage("u0"), createUserMessage("u1")],
      compaction: options([1]),
    });

    await session.run("first");
    expect(session.messages.filter(isContextWatermarkMessage)).toHaveLength(1);

    await session.commitCompaction({
      attemptId: "attempt",
      reason: "manual",
      coveredCount: 1,
      summary: createUserMessage("summary"),
      summaryText: "summary",
      checkpointId: "checkpoint",
      anchorTimestampMs: null,
    });

    await session.run("second");
    expect(session.messages.filter(isContextWatermarkMessage)).toHaveLength(1);

    await session.run("third");
    expect(session.messages.filter(isContextWatermarkMessage)).toHaveLength(2);
  });

  it("stays silent below the first configured level", async () => {
    const session = new AgentSession({
      sessionId: "ses_watermark_below",
      model: fake,
      tools: [],
      initialMessages: [assistantUsage(299_000)],
      compaction: options([300_000, 500_000, 600_000], 750_000),
    });

    await session.run("next");

    expect(session.messages.filter(isContextWatermarkMessage)).toHaveLength(0);
    expect(fake.getCalls()[0]!.messages.some(isContextWatermarkMessage)).toBe(false);
  });

  it("crosses 300k once, persists the marker and includes it in the current request", async () => {
    const store = new MemorySessionStore();
    const session = new AgentSession({
      sessionId: "ses_watermark_300",
      model: fake,
      tools: [],
      store,
      initialMessages: [assistantUsage(300_000)],
      compaction: options([300_000, 500_000, 600_000], 750_000),
    });

    await session.run("next");

    const notices = session.messages.filter(isContextWatermarkMessage);
    expect(notices).toHaveLength(1);
    expect(textOf(notices[0]!)).toContain("[context-watermark:300000]");
    expect(fake.getCalls()[0]!.messages.filter(isContextWatermarkMessage)).toHaveLength(1);
    const entries = await store.getPathToLeaf("ses_watermark_300");
    expect(
      entries.filter(
        (entry) => entry.entry.kind === "message" && isContextWatermarkMessage(entry.entry.message),
      ),
    ).toHaveLength(1);

    await session.run("again");
    expect(session.messages.filter(isContextWatermarkMessage)).toHaveLength(1);
  });

  for (const scenario of [
    { input: 500_000, level: 500_000, fallback: false },
    { input: 600_000, level: 600_000, fallback: true },
  ] as const) {
    it(`crosses ${scenario.level}k and ${scenario.fallback ? "includes" : "omits"} the fallback sentence`, async () => {
      const session = new AgentSession({
        sessionId: `ses_watermark_${scenario.level}`,
        model: fake,
        tools: [],
        initialMessages: [assistantUsage(scenario.input)],
        compaction: options([300_000, 500_000, 600_000], 750_000),
      });

      await session.run("next");

      const notices = session.messages.filter(isContextWatermarkMessage);
      expect(notices).toHaveLength(1);
      expect(contextWatermarkLevel(notices[0]!)).toBe(scenario.level);
      const text = textOf(notices[0]!);
      if (scenario.fallback) {
        expect(text).toContain("达到 750k 时系统会自动压缩兜底。");
      } else {
        expect(text).not.toContain("自动压缩兜底");
      }
    });
  }

  it("a single 610k evaluation emits only the highest level", async () => {
    const session = new AgentSession({
      sessionId: "ses_watermark_direct_jump",
      model: fake,
      tools: [],
      initialMessages: [assistantUsage(610_000)],
      compaction: options([300_000, 500_000, 600_000], 750_000),
    });

    await session.run("next");

    expect(
      session.messages.filter(isContextWatermarkMessage).map(contextWatermarkLevel),
    ).toEqual([600_000]);
  });

  it("a jump from 300k to 610k emits only the highest crossed level", async () => {
    const persisted = buildContextWatermarkMessage({
      level: 300_000,
      estimatedTokens: 300_000,
      hardCap: 750_000,
    });
    const session = new AgentSession({
      sessionId: "ses_watermark_jump",
      model: fake,
      tools: [],
      initialMessages: [assistantUsage(610_000), persisted],
      compaction: options([300_000, 500_000, 600_000], 750_000),
    });

    await session.run("next");

    const levels = session.messages
      .filter(isContextWatermarkMessage)
      .map(contextWatermarkLevel);
    expect(levels).toEqual([300_000, 600_000]);
  });

  it("hydrateFromStore restores the last level from a persisted notice", async () => {
    const store = new MemorySessionStore();
    const persisted = buildContextWatermarkMessage({
      level: 300_000,
      estimatedTokens: 300_000,
      hardCap: 750_000,
    });
    await store.appendEntry("ses_watermark_hydrate", {
      kind: "message",
      message: assistantUsage(400_000),
    });
    await store.appendEntry("ses_watermark_hydrate", { kind: "message", message: persisted });
    const session = new AgentSession({
      sessionId: "ses_watermark_hydrate",
      model: fake,
      tools: [],
      store,
      compaction: options([300_000, 500_000, 600_000], 750_000),
    });

    expect(await session.hydrateFromStore()).toBe(true);
    await session.run("next");

    expect(session.messages.filter(isContextWatermarkMessage)).toHaveLength(1);
  });

  it("rejects invalid watermarkLevels at construction", () => {
    const invalid: ReadonlyArray<readonly number[]> = [
      [0],
      [1.5],
      [300_000, 300_000],
      [300_000, 750_000],
      [Number.NaN],
    ];
    for (const levels of invalid) {
      expect(
        () =>
          new AgentSession({
            sessionId: "ses_watermark_bad",
            model: fake,
            tools: [],
            compaction: options(levels, 750_000),
          }),
      ).toThrow(RangeError);
    }
  });
});

describe("assertValidWatermarkLevels", () => {
  it("accepts undefined and strictly increasing positive integers below the hard cap", () => {
    expect(() => assertValidWatermarkLevels(undefined, 750_000)).not.toThrow();
    expect(() =>
      assertValidWatermarkLevels([300_000, 500_000, 600_000], 750_000),
    ).not.toThrow();
  });

  it("rejects non-positive, non-integer, descending and over-cap levels", () => {
    const invalid: ReadonlyArray<readonly number[]> = [
      [0],
      [-1],
      [1.5],
      [300_000, 300_000],
      [500_000, 300_000],
      [750_000],
      [300_000, 800_000],
      [Number.POSITIVE_INFINITY],
    ];
    for (const levels of invalid) {
      expect(() => assertValidWatermarkLevels(levels, 750_000)).toThrow(RangeError);
    }
  });
});
