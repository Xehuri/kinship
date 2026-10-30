/**
 * Regression: resume replay must retain the uncovered recent tail of the **last** persisted
 * compaction boundary when the checkpoint declares `tailIncluded: false` (worker summary covers
 * only the prefix). Legacy checkpoints without the flag keep their tail only at the last
 * boundary (older boundaries are dropped to avoid coordinate drift).
 *
 * Production shape B5325: coveredCount=222 over `[S4989, ...304]` (305 slots) leaves an 83
 * message tail that the old unconditional `msgs.length = 0` replay deleted.
 */

import { describe, expect, it } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { AgentSession } from "../session.js";
import { MemorySessionStore } from "../session-store.js";
import { createFakeModel } from "../testing.js";
import { createUserMessage } from "../types.js";
import {
  COMPACTION_CHECKPOINT_VERSION,
  COMPACTION_TAIL_SEPARATOR,
  type CompactionCheckpointMeta,
} from "../compaction-checkpoint.js";

const user = (text: string, timestamp: number): Message =>
  ({ role: "user", content: text, timestamp }) as Message;

function textOf(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
}

function texts(messages: ReadonlyArray<Message>): string[] {
  return messages.map(textOf);
}

function checkpoint(
  coveredCount: number,
  anchorTimestampMs: number | null,
  tailIncluded?: boolean,
): CompactionCheckpointMeta {
  return {
    version: COMPACTION_CHECKPOINT_VERSION,
    coveredCount,
    anchorTimestampMs,
    summaryId: `ckpt-${coveredCount}-${String(tailIncluded)}`,
    createdAt: 1_700_000_000_000,
    source: "auto",
    ...(tailIncluded === undefined ? {} : { tailIncluded }),
  };
}

async function appendBoundary(
  store: MemorySessionStore,
  sessionId: string,
  summary: string,
  meta?: CompactionCheckpointMeta,
): Promise<void> {
  await store.appendEntry(sessionId, {
    kind: "compaction_boundary",
    summary: createUserMessage(summary),
    ...(meta === undefined ? {} : { checkpoint: meta }),
  });
}

async function resume(store: MemorySessionStore, sessionId: string) {
  const fake = createFakeModel();
  const session = await AgentSession.resume(store, sessionId, {
    model: fake,
    tools: [],
  });
  return { session, fake };
}

describe("resume replay retains the uncovered tail according to checkpoint metadata", () => {
  it("keeps the uncovered tail for an explicit tailIncluded:false checkpoint", async () => {
    const store = new MemorySessionStore();
    const sid = "tail-explicit-false";
    for (let i = 0; i < 5; i++) {
      await store.appendEntry(sid, {
        kind: "message",
        message: user(`m${i}`, 1000 + i),
      });
    }
    await appendBoundary(store, sid, "S", checkpoint(3, 1003, false));

    const { session, fake } = await resume(store, sid);
    try {
      expect(texts(session.messages)).toEqual(["S", "m3", "m4"]);
      expect(session.messages[1]?.timestamp).toBe(1003);
      expect(session.compactionView?.totalMessages).toBe(3);
      expect(session.compactionView?.coveredCount).toBe(1);
      expect(session.compactionView?.historicalCoveredCount).toBe(3);
    } finally {
      fake.teardown();
    }
  });

  it("replays a combined ops+chat summary byte-identically with the uncovered tail", async () => {
    const store = new MemorySessionStore();
    const sid = "tail-combined-perspectives";
    for (let i = 0; i < 5; i++) {
      await store.appendEntry(sid, {
        kind: "message",
        message: user(`m${i}`, 1000 + i),
      });
    }
    const combined =
      "## OPS STATE\n\nops summary for the covered prefix\n\n## CHAT STATE\n\nchat summary for the covered prefix";
    await appendBoundary(store, sid, combined, checkpoint(3, 1003, false));

    const { session, fake } = await resume(store, sid);
    try {
      expect(session.messages).toHaveLength(3);
      expect(
        session.messages.filter((message) => textOf(message) === combined),
      ).toHaveLength(1);
      const summary = session.messages[0];
      expect(summary !== undefined && textOf(summary)).toBe(combined);
      expect(texts(session.messages.slice(1))).toEqual(["m3", "m4"]);
      expect(session.compactionView?.summaryText).toBe(combined);
      expect(session.compactionView?.coveredCount).toBe(1);
      expect(session.compactionView?.historicalCoveredCount).toBe(3);
      expect(session.compactionView?.totalMessages).toBe(3);
    } finally {
      fake.teardown();
    }
  });

  it("drops the tail for an explicit tailIncluded:true checkpoint", async () => {
    const store = new MemorySessionStore();
    const sid = "tail-explicit-true";
    for (let i = 0; i < 5; i++) {
      await store.appendEntry(sid, {
        kind: "message",
        message: user(`m${i}`, 1000 + i),
      });
    }
    await appendBoundary(store, sid, "S", checkpoint(3, 1003, true));

    const { session, fake } = await resume(store, sid);
    try {
      expect(texts(session.messages)).toEqual(["S"]);
      expect(session.compactionView?.totalMessages).toBe(1);
    } finally {
      fake.teardown();
    }
  });

  it("drops the tail of a legacy checkpoint that is not the last boundary", async () => {
    const store = new MemorySessionStore();
    const sid = "tail-legacy-not-last";
    for (let i = 0; i < 5; i++) {
      await store.appendEntry(sid, {
        kind: "message",
        message: user(`m${i}`, 1000 + i),
      });
    }
    await appendBoundary(store, sid, "S1", checkpoint(2, 1002));
    await store.appendEntry(sid, { kind: "message", message: user("m5", 1005) });
    // Next boundary is legacy too (no explicit tailIncluded): no transition lookahead.
    await appendBoundary(store, sid, "S2", checkpoint(2, null));

    const { session, fake } = await resume(store, sid);
    try {
      // If B1 had retained its 3-message tail, B2's replay array would contain it and
      // coveredCount=2 would leak m3/m4/m5 into the final live array.
      expect(texts(session.messages)).toEqual(["S2"]);
      expect(session.compactionView?.totalMessages).toBe(1);
    } finally {
      fake.teardown();
    }
  });

  it("keeps the tail of a legacy checkpoint before an explicit worker boundary", async () => {
    const store = new MemorySessionStore();
    const sid = "tail-legacy-before-explicit";
    for (let i = 0; i < 4; i++) {
      await store.appendEntry(sid, {
        kind: "message",
        message: user(`m${i}`, 1000 + i),
      });
    }
    // Legacy boundary without an explicit marker: its uncovered tail is m2..m3.
    await appendBoundary(store, sid, "S1", checkpoint(2, 1002));
    await store.appendEntry(sid, { kind: "message", message: user("m4", 1004) });
    await store.appendEntry(sid, { kind: "message", message: user("m5", 1005) });
    // Worker boundary computed against the live array [S1, m2, m3, m4, m5]:
    // coveredCount=4 covers S1..m4, leaving m5 uncovered.
    await appendBoundary(store, sid, "S2", checkpoint(4, 1005, false));
    await store.appendEntry(sid, { kind: "message", message: user("m6", 1006) });

    const { session, fake } = await resume(store, sid);
    try {
      // Dropping B1's legacy tail would collapse B2's coordinates and lose m5.
      expect(texts(session.messages)).toEqual(["S2", "m5", "m6"]);
      expect(session.messages[1]?.timestamp).toBe(1005);
      expect(session.compactionView?.totalMessages).toBe(3);
      expect(session.compactionView?.coveredCount).toBe(1);
      expect(session.compactionView?.historicalCoveredCount).toBe(4);
    } finally {
      fake.teardown();
    }
  });

  it("keeps the tail of a legacy checkpoint at the last boundary", async () => {
    const store = new MemorySessionStore();
    const sid = "tail-legacy-last";
    for (let i = 0; i < 5; i++) {
      await store.appendEntry(sid, {
        kind: "message",
        message: user(`m${i}`, 1000 + i),
      });
    }
    await appendBoundary(store, sid, "S", checkpoint(2, 1002));

    const { session, fake } = await resume(store, sid);
    try {
      expect(texts(session.messages)).toEqual(["S", "m2", "m3", "m4"]);
      expect(session.compactionView?.totalMessages).toBe(4);
    } finally {
      fake.teardown();
    }
  });

  it("drops the tail when a legacy summary embeds COMPACTION_TAIL_SEPARATOR", async () => {
    const store = new MemorySessionStore();
    const sid = "tail-legacy-separator";
    for (let i = 0; i < 5; i++) {
      await store.appendEntry(sid, {
        kind: "message",
        message: user(`m${i}`, 1000 + i),
      });
    }
    const embedded = `S${COMPACTION_TAIL_SEPARATOR}EMBEDDED-TAIL`;
    await appendBoundary(store, sid, embedded, checkpoint(2, 1002));

    const { session, fake } = await resume(store, sid);
    try {
      expect(texts(session.messages)).toEqual([embedded]);
      expect(session.compactionView?.totalMessages).toBe(1);
    } finally {
      fake.teardown();
    }
  });

  it("drops the tail of a checkpointless boundary", async () => {
    const store = new MemorySessionStore();
    const sid = "tail-checkpointless";
    for (let i = 0; i < 5; i++) {
      await store.appendEntry(sid, {
        kind: "message",
        message: user(`m${i}`, 1000 + i),
      });
    }
    await appendBoundary(store, sid, "S");

    const { session, fake } = await resume(store, sid);
    try {
      expect(texts(session.messages)).toEqual(["S"]);
      expect(session.compactionView?.totalMessages).toBe(1);
    } finally {
      fake.teardown();
    }
  });

  it("composes two explicit-false checkpoints without coordinate shift", async () => {
    const store = new MemorySessionStore();
    const sid = "tail-two-false";
    for (let i = 0; i < 10; i++) {
      await store.appendEntry(sid, {
        kind: "message",
        message: user(`m${i}`, 1000 + i),
      });
    }
    await appendBoundary(store, sid, "S1", checkpoint(3, 1003, false));
    await store.appendEntry(sid, { kind: "message", message: user("m10", 1010) });
    await store.appendEntry(sid, { kind: "message", message: user("m11", 1011) });
    await appendBoundary(store, sid, "S2", checkpoint(5, 1008, false));

    const { session, fake } = await resume(store, sid);
    try {
      expect(texts(session.messages)).toEqual([
        "S2",
        "m7",
        "m8",
        "m9",
        "m10",
        "m11",
      ]);
      expect(session.compactionView?.totalMessages).toBe(6);
    } finally {
      fake.teardown();
    }
  });

  it("retains the production 305-slot / covered 222 / 83-message tail shape (B5325)", async () => {
    const store = new MemorySessionStore();
    const sid = "tail-production-shape";
    for (let i = 0; i < 5; i++) {
      await store.appendEntry(sid, {
        kind: "message",
        message: user(`pre-${i}`, 1000 + i),
      });
    }
    // Older checkpointless boundary: its prefix is fully dropped.
    await appendBoundary(store, sid, "S0");
    for (let i = 0; i < 1153; i++) {
      await store.appendEntry(sid, {
        kind: "message",
        message: user(`mid-${i}`, 10_000 + i),
      });
    }
    // Older legacy checkpoint (non-last): its uncovered tail is intentionally NOT rescued.
    await appendBoundary(store, sid, "S1", checkpoint(1073, 11_072));
    for (let i = 0; i < 304; i++) {
      await store.appendEntry(sid, {
        kind: "message",
        message: user(`tail-${i}`, 20_000 + i),
      });
    }
    // B2 replay array is [S1, ...304] (305 slots). msgs[222] is tail-221.
    await appendBoundary(store, sid, "S2", checkpoint(222, 20_221));
    for (let i = 0; i < 3; i++) {
      await store.appendEntry(sid, {
        kind: "message",
        message: user(`post-${i}`, 30_000 + i),
      });
    }

    const { session, fake } = await resume(store, sid);
    try {
      expect(session.messages).toHaveLength(87);
      expect(session.messages[0] !== undefined && textOf(session.messages[0])).toBe("S2");
      expect(session.messages[1]?.timestamp).toBe(20_221);
      expect(session.messages[83]?.timestamp).toBe(20_303);
      expect(session.messages[84]?.timestamp).toBe(30_000);
      expect(session.compactionView?.totalMessages).toBe(87);
      expect(session.compactionView?.coveredCount).toBe(1);
      expect(session.compactionView?.historicalCoveredCount).toBe(222);
      const allTexts = texts(session.messages);
      expect(allTexts.some((text) => text.startsWith("mid-"))).toBe(false);
      expect(allTexts).not.toContain("tail-0");
      expect(allTexts).not.toContain("S1");
    } finally {
      fake.teardown();
    }
  });

  it("continuing after hydrate does not re-persist the retained tail", async () => {
    const store = new MemorySessionStore();
    const sid = "tail-hydrate-no-duplicate";
    for (let i = 0; i < 5; i++) {
      await store.appendEntry(sid, {
        kind: "message",
        message: user(`m${i}`, 1000 + i),
      });
    }
    await appendBoundary(store, sid, "S", checkpoint(3, 1003, false));

    const fake = createFakeModel([
      { content: [{ type: "text", text: "answer" }], stopReason: "stop" },
    ]);
    const session = new AgentSession({ sessionId: sid, model: fake, tools: [], store });
    try {
      expect(await session.hydrateFromStore()).toBe(true);
      expect(texts(session.messages)).toEqual(["S", "m3", "m4"]);

      const before = (await store.getPathToLeaf(sid)).filter(
        (node) => node.entry.kind === "message",
      ).length;
      await session.run("next");
      const path = await store.getPathToLeaf(sid);
      const storedTexts = path.flatMap((node) =>
        node.entry.kind === "message" ? [textOf(node.entry.message)] : [],
      );

      expect(storedTexts).toHaveLength(before + 2);
      expect(storedTexts.filter((text) => text === "m3")).toHaveLength(1);
      expect(storedTexts.filter((text) => text === "m4")).toHaveLength(1);
      expect(storedTexts.filter((text) => text === "next")).toHaveLength(1);
    } finally {
      fake.teardown();
    }
  });
});
