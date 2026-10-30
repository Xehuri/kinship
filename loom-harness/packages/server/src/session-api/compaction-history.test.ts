import { describe, expect, it } from "vitest";
import {
  COMPACTION_CHECKPOINT_VERSION,
  MemorySessionStore,
  type Message,
} from "@axeuh/loom-core";

import type { CompactionEvent } from "./compaction-events.js";
import { boundaryEventsFromStore, mergeCompactionEvents } from "./compaction-history.js";

function message(content: string, timestamp: number): Message {
  return { role: "user", content, timestamp };
}

async function appendMessages(
  store: MemorySessionStore,
  sessionID: string,
  count: number,
  firstTimestamp: number,
): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await store.appendEntry(sessionID, {
      kind: "message",
      message: message(`m${String(firstTimestamp + i)}`, firstTimestamp + i),
    });
  }
}

function autoEvent(summaryText: string, overrides: Partial<CompactionEvent> = {}): CompactionEvent {
  return {
    id: `auto-${summaryText}`,
    kind: "auto",
    coveredCount: 1,
    summaryText,
    anchorMessageId: null,
    anchorTimestampMs: null,
    recordedAt: 1,
    ...overrides,
  };
}

describe("C2 boundary extraction", () => {
  it("emits one boundary event with message count, next-message anchor and summary timestamp", async () => {
    const store = new MemorySessionStore();
    const sid = "ses_c2_one";
    await store.appendEntry(sid, { kind: "message", message: message("u1", 1_001) });
    await store.appendEntry(sid, { kind: "message", message: message("u2", 1_002) });
    const boundary = await store.appendEntry(sid, {
      kind: "compaction_boundary",
      summary: message("SUMMARY-ONE", 900),
    });
    const anchor = await store.appendEntry(sid, { kind: "message", message: message("tail1", 1_003) });
    await store.appendEntry(sid, { kind: "message", message: message("tail2", 1_004) });

    expect(await boundaryEventsFromStore(store, sid)).toEqual([
      {
        id: boundary.id,
        kind: "boundary",
        coveredCount: 2,
        summaryText: "SUMMARY-ONE",
        anchorMessageId: anchor.id,
        anchorTimestampMs: 1_003,
        recordedAt: 900,
      },
    ]);
  });

  it("emits two boundaries with legacy covered counts and ascending anchors", async () => {
    const store = new MemorySessionStore();
    const sid = "ses_c2_two";
    await store.appendEntry(sid, { kind: "message", message: message("a1", 2_001) });
    await store.appendEntry(sid, { kind: "message", message: message("a2", 2_002) });
    const first = await store.appendEntry(sid, {
      kind: "compaction_boundary",
      summary: message("SUMMARY-A", 1_900),
    });
    const firstAnchor = await store.appendEntry(sid, { kind: "message", message: message("a3", 2_003) });
    await store.appendEntry(sid, { kind: "message", message: message("a4", 2_004) });
    const second = await store.appendEntry(sid, {
      kind: "compaction_boundary",
      summary: message("SUMMARY-B", 1_950),
    });
    const secondAnchor = await store.appendEntry(sid, { kind: "message", message: message("a5", 2_005) });

    const events = await boundaryEventsFromStore(store, sid);
    expect(events.map((event) => event.id)).toEqual([first.id, second.id]);
    expect(events.map((event) => event.coveredCount)).toEqual([2, 3]);
    expect(events.map((event) => event.anchorMessageId)).toEqual([firstAnchor.id, secondAnchor.id]);
    expect(events.map((event) => event.anchorTimestampMs)).toEqual([2_003, 2_005]);
    expect(events.map((event) => event.recordedAt)).toEqual([1_900, 1_950]);

    const reversed = mergeCompactionEvents([events[1]!, events[0]!], [], []);
    expect(reversed.map((event) => event.id)).toEqual([first.id, second.id]);
  });

  it("derives legacy covered counts from boundary coordinates", async () => {
    const store = new MemorySessionStore();
    const sid = "ses_c2_legacy_coords";
    await appendMessages(store, sid, 1_355, 10_000);
    await store.appendEntry(sid, {
      kind: "compaction_boundary",
      summary: message("SUMMARY-COORD-1", 9_000),
    });
    await appendMessages(store, sid, 2_121, 20_000);
    await store.appendEntry(sid, {
      kind: "compaction_boundary",
      summary: message("SUMMARY-COORD-2", 9_500),
    });

    const events = await boundaryEventsFromStore(store, sid);
    expect(events.map((event) => event.coveredCount)).toEqual([1_355, 2_122]);
  });

  it("prefers checkpoint coveredCount, anchor timestamp and createdAt", async () => {
    const store = new MemorySessionStore();
    const sid = "ses_c2_checkpoint_meta";
    await appendMessages(store, sid, 2, 3_000);
    const boundary = await store.appendEntry(sid, {
      kind: "compaction_boundary",
      summary: message("SUMMARY-META", 3_900),
      checkpoint: {
        version: COMPACTION_CHECKPOINT_VERSION,
        coveredCount: 77,
        anchorTimestampMs: 3_555,
        summaryId: "summary-meta",
        createdAt: 3_950,
        source: "manual",
      },
    });
    const anchor = await store.appendEntry(sid, {
      kind: "message",
      message: message("tail", 3_400),
    });

    expect(await boundaryEventsFromStore(store, sid)).toEqual([
      {
        id: boundary.id,
        kind: "boundary",
        coveredCount: 77,
        summaryText: "SUMMARY-META",
        anchorMessageId: anchor.id,
        anchorTimestampMs: 3_555,
        recordedAt: 3_950,
      },
    ]);
  });

  it("applies the legacy formula across three boundaries", async () => {
    const store = new MemorySessionStore();
    const sid = "ses_c2_three_coords";
    await appendMessages(store, sid, 2, 5_000);
    await store.appendEntry(sid, {
      kind: "compaction_boundary",
      summary: message("SUMMARY-3A", 4_900),
    });
    await appendMessages(store, sid, 2, 6_000);
    await store.appendEntry(sid, {
      kind: "compaction_boundary",
      summary: message("SUMMARY-3B", 5_900),
    });
    await appendMessages(store, sid, 3, 7_000);
    await store.appendEntry(sid, {
      kind: "compaction_boundary",
      summary: message("SUMMARY-3C", 6_900),
    });

    const events = await boundaryEventsFromStore(store, sid);
    expect(events.map((event) => event.coveredCount)).toEqual([2, 3, 4]);
  });

  it("skips a boundary whose summary content is not a string", async () => {
    const store = new MemorySessionStore();
    const sid = "ses_c2_blocks";
    await store.appendEntry(sid, { kind: "message", message: message("u1", 3_001) });
    await store.appendEntry(sid, {
      kind: "compaction_boundary",
      summary: { role: "user", content: [{ type: "text", text: "BLOCKS" }], timestamp: 3_100 },
    });
    await store.appendEntry(sid, { kind: "message", message: message("u2", 3_002) });

    expect(await boundaryEventsFromStore(store, sid)).toEqual([]);
  });
});

describe("C2 merge", () => {
  it("dedupes boundary + auto + live with the same summary, keeping the boundary canonical", () => {
    const boundary = autoEvent("same", { id: "boundary-id", kind: "boundary", recordedAt: 100 });
    const autoLog = autoEvent("same", { id: "auto-id", recordedAt: 200 });
    const live = autoEvent("same", { id: "live-id", recordedAt: 300 });

    const merged = mergeCompactionEvents([boundary], [autoLog], live);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual(boundary);
  });

  it("keeps null anchors and orders by anchor timestamp falling back to recordedAt", () => {
    const anchored = autoEvent("anchored", { anchorTimestampMs: 200, recordedAt: 50 });
    const nullEarly = autoEvent("null-early", { anchorTimestampMs: null, recordedAt: 100 });
    const nullLate = autoEvent("null-late", { anchorTimestampMs: null, recordedAt: 300 });

    const merged = mergeCompactionEvents([], [anchored, nullLate], [nullEarly]);

    expect(merged.map((event) => event.summaryText)).toEqual(["null-early", "anchored", "null-late"]);
  });
});
