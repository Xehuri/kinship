import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../session.js";
import { MemorySessionStore, type SessionStore } from "../session-store.js";
import { createFakeModel, type FakeModel } from "../testing.js";
import { createUserMessage } from "../types.js";
import type { CompactionCheckpointMeta } from "../compaction-checkpoint.js";
import { CompactionStateStore } from "./compaction-state-store.js";
import type { SessionCompactionOptions } from "./session-compaction.js";

const SID = "ses_dual_perspective_session";
const OPS_BODY = "ops body: deploy window closed at 09:41 and the queue is drained";
const CHAT_BODY = "chat body: user asked about the cat photos from yesterday";
const COMBINED = `## OPS STATE\n\n${OPS_BODY}\n\n## CHAT STATE\n\n${CHAT_BODY}`;

let root: string;
let stateStore: CompactionStateStore;
let fake: FakeModel;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "loom-dual-perspective-session-"));
  stateStore = new CompactionStateStore({ stateRoot: root });
  fake = createFakeModel();
});

afterEach(() => {
  fake.teardown();
  rmSync(root, { recursive: true, force: true });
});

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function sessionCompaction(calls: string[]): SessionCompactionOptions {
  return {
    stateStore,
    summarize: () => {
      calls.push("ops");
      return OPS_BODY;
    },
    additionalSummaryPerspectives: [
      {
        key: "chat",
        title: "CHAT STATE",
        summarize: () => {
          calls.push("chat");
          return CHAT_BODY;
        },
      },
    ],
    wrapSummary: (text, coveredCount) => `[compacted ${String(coveredCount)}]\n${text}`,
    fallbackTokens: 1_000_000,
    keepRecent: 1,
    summaryChunkTokens: 1_000,
    retryCount: 0,
  };
}

async function seedStore(store: SessionStore, texts: readonly string[]): Promise<void> {
  for (const text of texts) {
    await store.appendEntry(SID, {
      kind: "message",
      message: createUserMessage(text),
    });
  }
}

async function readCheckpoints(
  store: SessionStore,
): Promise<Array<CompactionCheckpointMeta | undefined>> {
  const path = await store.getPathToLeaf(SID);
  return path.flatMap((node) =>
    node.entry.kind === "compaction_boundary" ? [node.entry.checkpoint] : [],
  );
}

describe("AgentSession dual-perspective compaction", () => {
  it("commits one combined ops+chat summary and replays it unchanged with the uncovered tail", async () => {
    const store = new MemorySessionStore();
    await seedStore(store, ["m0", "m1", "m2", "m3"]);

    const calls: string[] = [];
    const session = await AgentSession.resume(store, SID, {
      model: fake,
      tools: [],
      compaction: sessionCompaction(calls),
    });
    const totalMessages = session.messages.length;

    expect(totalMessages).toBe(4);
    expect(session.compactionView).toBeNull();

    const outcome = await session.compactNow("manual");

    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.kind !== "compacted") {
      throw new Error(`expected compacted outcome, got ${JSON.stringify(outcome)}`);
    }
    expect(calls).toEqual(["ops", "chat"]);
    expect(outcome.summaryText).toBe(COMBINED);
    expect(outcome.coveredCount).toBeGreaterThan(0);

    const view = session.compactionView;
    expect(view).not.toBeNull();
    if (view === null) throw new Error("expected a compaction view after commit");

    const coveredCount = view.coveredCount;
    const tailCount = view.totalMessages - coveredCount;
    const summaryHash = createHash("sha256").update(view.summaryText).digest("hex");

    expect(session.messages).toHaveLength(totalMessages);
    expect(coveredCount).toBe(3);
    expect(tailCount).toBe(1);
    expect(view.totalMessages).toBe(totalMessages);
    expect(view.summaryText).toBe(`[compacted ${String(coveredCount)}]\n${COMBINED}`);
    expect(countOccurrences(view.summaryText, "## OPS STATE")).toBe(1);
    expect(countOccurrences(view.summaryText, "## CHAT STATE")).toBe(1);
    expect(view.summaryText.indexOf("## OPS STATE")).toBeLessThan(
      view.summaryText.indexOf("## CHAT STATE"),
    );
    expect(view.summaryText.indexOf(OPS_BODY)).toBeLessThan(
      view.summaryText.indexOf(CHAT_BODY),
    );

    const resumed = await AgentSession.resume(store, SID, {
      model: fake,
      tools: [],
      compaction: sessionCompaction(calls),
    });
    const resumedView = resumed.compactionView;
    expect(resumedView).not.toBeNull();
    if (resumedView === null) throw new Error("expected a replayed compaction view");

    const resumedTailCount = resumedView.totalMessages - resumedView.coveredCount;

    expect(resumedView.summaryText).toBe(view.summaryText);
    expect(createHash("sha256").update(resumedView.summaryText).digest("hex")).toBe(summaryHash);
    expect(resumedView.historicalCoveredCount).toBe(coveredCount);
    expect(resumedView.coveredCount).toBe(1);
    expect(resumedTailCount).toBe(tailCount);
    expect(resumed.messages).toHaveLength(1 + tailCount);
    expect(resumed.messages[1]?.content).toBe("m3");
    const checkpoints = await readCheckpoints(store);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]?.coveredCount).toBe(coveredCount);
    expect(checkpoints[0]?.tailIncluded).toBe(false);
    expect(session.compactionState?.status).toBe("idle");
    expect(resumed.compactionState?.status).toBe("idle");
  });
});
