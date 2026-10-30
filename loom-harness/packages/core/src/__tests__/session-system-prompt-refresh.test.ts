/**
 * 主会话 systemPrompt 热重载（core 半）：AgentSession 的 live prompt + refresh provider。
 *
 * 契约：
 *   - session-start 刷新发生在 onSessionStart **之前**，只成功一次；失败可在下一 run 重试。
 *   - compaction commit 之后刷新，使同一次压缩后的 LLM call 使用新 prompt。
 *   - legacy onAfterFlush / ctx.state 边界路径在 turn 末尾刷新（与 worker commit 路径不双刷）。
 *   - provider 抛错绝不杀 run/compaction；旧 prompt 保留。
 *   - 刷新串行（并发 commitCompaction 不重叠）。
 *   - ctx.config.systemPrompt 是 live getter（对象仍冻结）。
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
  type AgentSessionOptions,
  type SystemPromptRefreshReason,
} from "../session.js";
import { MemorySessionStore } from "../session-store.js";
import { CompactionStateStore, type CompactionState } from "../compaction/index.js";
import type { Hook } from "../hook.js";

const SID = "ses_system_prompt_refresh";

let root: string;
let stateStore: CompactionStateStore;
let fakes: FakeModel[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "loom-prompt-refresh-"));
  stateStore = new CompactionStateStore({ stateRoot: root });
  fakes = [];
});

afterEach(() => {
  for (const fake of fakes) fake.teardown();
  rmSync(root, { recursive: true, force: true });
});

function fakeModel(): FakeModel {
  const fake = createFakeModel([{ content: [{ type: "text", text: "ok" }] }]);
  fakes.push(fake);
  return fake;
}

function compactionOptions(): NonNullable<AgentSessionOptions["compaction"]> {
  return {
    stateStore,
    summarize: () => "summary-text",
    wrapSummary: (text, coveredCount) => `[compacted ${String(coveredCount)}]\n${text}`,
    fallbackTokens: 1,
    keepRecent: 1,
    summaryChunkTokens: 1_000,
    retryCount: 0,
  };
}

function textMessages(count: number): Message[] {
  return Array.from({ length: count }, (_, i) => createUserMessage(`u${String(i)}`));
}

function readState(): CompactionState | null {
  const result = stateStore.read(SID);
  return result.kind === "ok" ? result.state : null;
}

describe("AgentSession systemPrompt refresh", () => {
  it("refreshes on session-start before onSessionStart exactly once", async () => {
    const order: string[] = [];
    const fake = fakeModel();
    const session = new AgentSession({
      sessionId: SID,
      model: fake,
      tools: [],
      systemPrompt: "OLD-PROMPT",
      refreshSystemPrompt: (reason) => {
        order.push(`provider:${reason}`);
        return "NEW-PROMPT";
      },
      hooks: [
        {
          name: "probe",
          onSessionStart(): void {
            order.push("hook:session-start");
          },
        },
      ],
    });

    const first = await session.run("hello");

    expect(first.reason).toBe("done");
    expect(order).toEqual(["provider:session-start", "hook:session-start"]);
    expect(fake.getCalls()[0]?.systemPrompt).toBe("NEW-PROMPT");
    expect(session.systemPrompt).toBe("NEW-PROMPT");

    fake.push({ content: [{ type: "text", text: "ok-2" }] });
    await session.run("again");

    expect(order.filter((entry) => entry === "provider:session-start")).toHaveLength(1);
    expect(fake.getCalls()[1]?.systemPrompt).toBe("NEW-PROMPT");
  });

  it("keeps the old prompt bytes when the provider returns null", async () => {
    const reasons: SystemPromptRefreshReason[] = [];
    const fake = createFakeModel([
      { content: [{ type: "text", text: "one" }] },
      { content: [{ type: "text", text: "two" }] },
    ]);
    fakes.push(fake);
    const session = new AgentSession({
      sessionId: SID,
      model: fake,
      tools: [],
      systemPrompt: "BASE-PROMPT",
      refreshSystemPrompt: (reason) => {
        reasons.push(reason);
        return null;
      },
    });

    await session.run("first");
    await session.run("second");

    expect(reasons).toEqual(["session-start"]);
    expect(session.systemPrompt).toBe("BASE-PROMPT");
    expect(fake.getCalls()[0]?.systemPrompt).toBe("BASE-PROMPT");
    expect(fake.getCalls()[1]?.systemPrompt).toBe("BASE-PROMPT");
  });

  it("refreshes again on compaction commit and the same post-commit call uses the new prompt", async () => {
    const reasons: SystemPromptRefreshReason[] = [];
    const fake = fakeModel();
    const store = new MemorySessionStore();
    const session = new AgentSession({
      sessionId: SID,
      model: fake,
      tools: [],
      store,
      systemPrompt: "BASE-PROMPT",
      initialMessages: textMessages(3),
      refreshSystemPrompt: (reason) => {
        reasons.push(reason);
        return reason === "session-start" ? "AFTER-START" : "AFTER-COMPACT";
      },
      compaction: compactionOptions(),
    });

    const summary = await session.run("u3");

    expect(summary.reason).toBe("done");
    expect(reasons).toEqual(["session-start", "compaction"]);
    expect(fake.getCalls()[0]?.systemPrompt).toBe("AFTER-COMPACT");
    expect(session.systemPrompt).toBe("AFTER-COMPACT");
    expect(session.compactionView?.coveredCount).toBe(3);
    expect(readState()?.status).toBe("idle");
  });

  it("survives a throwing provider, keeps the old prompt and retries session-start on the next run", async () => {
    let calls = 0;
    const fake = createFakeModel([
      { content: [{ type: "text", text: "one" }] },
      { content: [{ type: "text", text: "two" }] },
    ]);
    fakes.push(fake);
    const session = new AgentSession({
      sessionId: SID,
      model: fake,
      tools: [],
      systemPrompt: "OLD-PROMPT",
      refreshSystemPrompt: () => {
        calls += 1;
        if (calls === 1) throw new Error("disk unavailable");
        return "RECOVERED-PROMPT";
      },
    });

    const first = await session.run("first");

    expect(first.reason).toBe("done");
    expect(calls).toBe(1);
    expect(session.systemPrompt).toBe("OLD-PROMPT");
    expect(fake.getCalls()[0]?.systemPrompt).toBe("OLD-PROMPT");

    const second = await session.run("second");

    expect(second.reason).toBe("done");
    expect(calls).toBe(2);
    expect(session.systemPrompt).toBe("RECOVERED-PROMPT");
    expect(fake.getCalls()[1]?.systemPrompt).toBe("RECOVERED-PROMPT");
  });

  it("refreshes on the legacy ctx.state boundary path at turn end", async () => {
    const reasons: SystemPromptRefreshReason[] = [];
    const fake = fakeModel();
    const boundaryHook: Hook = {
      name: "legacy-boundary",
      transformMessagesBeforeLlm(messages, ctx) {
        if (ctx.turnIdx === 0) {
          ctx.state.set(ACTIVE_BOUNDARY_KEY, {
            summary: createUserMessage("[legacy summary]"),
            coveredCount: 1,
          });
        }
        return messages;
      },
    };
    const session = new AgentSession({
      sessionId: SID,
      model: fake,
      tools: [],
      systemPrompt: "BASE-PROMPT",
      refreshSystemPrompt: (reason) => {
        reasons.push(reason);
        return reason === "session-start" ? "AFTER-START" : "AFTER-LEGACY";
      },
      hooks: [boundaryHook],
    });

    const summary = await session.run("hello");

    expect(summary.reason).toBe("done");
    expect(reasons).toEqual(["session-start", "compaction"]);
    expect(session.systemPrompt).toBe("AFTER-LEGACY");
    expect(session.compactionView?.coveredCount).toBe(1);
  });

  it("refreshes after resume and again on a new compaction", async () => {
    const store = new MemorySessionStore();
    const seedFake = createFakeModel([{ content: [{ type: "text", text: "seed" }] }]);
    fakes.push(seedFake);
    const seed = new AgentSession({
      sessionId: SID,
      model: seedFake,
      tools: [],
      store,
    });
    await seed.run("first");
    await seed.commitCompaction({
      attemptId: "attempt-seed",
      reason: "manual",
      coveredCount: 1,
      summary: createUserMessage("[compacted 1]\nseed-summary"),
      summaryText: "seed-summary",
      checkpointId: "checkpoint-seed",
      anchorTimestampMs: null,
    });

    const reasons: SystemPromptRefreshReason[] = [];
    const resumedFake = fakeModel();
    const resumed = await AgentSession.resume(store, SID, {
      model: resumedFake,
      tools: [],
      systemPrompt: "BASE-PROMPT",
      refreshSystemPrompt: (reason) => {
        reasons.push(reason);
        return reason === "session-start" ? "RESUMED-PROMPT" : "COMPACTED-PROMPT";
      },
    });

    await resumed.run("second");

    expect(reasons).toEqual(["session-start"]);
    expect(resumedFake.getCalls()[0]?.systemPrompt).toBe("RESUMED-PROMPT");
    expect(resumed.compactionView?.restored).toBe(true);

    await resumed.commitCompaction({
      attemptId: "attempt-new",
      reason: "manual",
      coveredCount: 1,
      summary: createUserMessage("[compacted 1]\nnew-summary"),
      summaryText: "new-summary",
      checkpointId: "checkpoint-new",
      anchorTimestampMs: null,
    });

    expect(reasons).toEqual(["session-start", "compaction"]);
    expect(resumed.systemPrompt).toBe("COMPACTED-PROMPT");
  });

  it("exposes the refreshed prompt through the frozen config view", async () => {
    const seen: string[] = [];
    let frozen = false;
    const fake = fakeModel();
    const session = new AgentSession({
      sessionId: SID,
      model: fake,
      tools: [],
      systemPrompt: "BASE-PROMPT",
      refreshSystemPrompt: () => "FRESH-PROMPT",
      hooks: [
        {
          name: "config-probe",
          onTurnStart(_input, ctx): void {
            seen.push(ctx.config.systemPrompt);
            frozen = Object.isFrozen(ctx.config);
          },
        },
      ],
    });

    const summary = await session.run("hello");

    expect(summary.reason).toBe("done");
    expect(seen).toEqual(["FRESH-PROMPT"]);
    expect(frozen).toBe(true);
    expect(session.systemPrompt).toBe("FRESH-PROMPT");
  });

  it("serializes concurrent commitCompaction refreshes", async () => {
    const fake = fakeModel();
    const store = new MemorySessionStore();
    let active = 0;
    let maxActive = 0;
    let refreshes = 0;
    const session = new AgentSession({
      sessionId: SID,
      model: fake,
      tools: [],
      store,
      initialMessages: textMessages(1),
      systemPrompt: "BASE-PROMPT",
      refreshSystemPrompt: async (reason) => {
        refreshes += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return reason === "session-start" ? "AFTER-START" : `AFTER-COMPACT-${String(refreshes)}`;
      },
    });

    await session.run("hello");
    expect(refreshes).toBe(1);

    await Promise.all([
      session.commitCompaction({
        attemptId: "attempt-1",
        reason: "manual",
        coveredCount: 1,
        summary: createUserMessage("[compacted 1]\none"),
        summaryText: "one",
        checkpointId: "checkpoint-1",
        anchorTimestampMs: null,
      }),
      session.commitCompaction({
        attemptId: "attempt-2",
        reason: "manual",
        coveredCount: 1,
        summary: createUserMessage("[compacted 1]\ntwo"),
        summaryText: "two",
        checkpointId: "checkpoint-2",
        anchorTimestampMs: null,
      }),
    ]);

    expect(refreshes).toBe(3);
    expect(maxActive).toBe(1);
    expect(session.systemPrompt).not.toBe("BASE-PROMPT");
  });
});
