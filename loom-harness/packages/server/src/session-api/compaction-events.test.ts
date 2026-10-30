import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendCompactionEvent,
  compactionEventKey,
  readCompactionEvents,
  type CompactionEvent,
} from "./compaction-events.js";

const SESSION_ID = "ses_c1_events";

let stateRoot = "";
let eventSeq = 0;

function event(summaryText: string, overrides: Partial<CompactionEvent> = {}): CompactionEvent {
  eventSeq += 1;
  return {
    id: `evt-${String(eventSeq)}`,
    kind: "auto",
    coveredCount: eventSeq,
    summaryText,
    anchorMessageId: null,
    anchorTimestampMs: null,
    recordedAt: 1_000 + eventSeq,
    ...overrides,
  };
}

function logFile(): string {
  return join(stateRoot, "session", "compaction", `${SESSION_ID}.events.jsonl`);
}

function logLines(): string[] {
  return readFileSync(logFile(), "utf8").trim().split("\n");
}

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "loom-c1-events-"));
  eventSeq = 0;
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

describe("C1 compaction event log", () => {
  it("missing file reads as empty log and reports no skipped lines", () => {
    expect(readCompactionEvents(stateRoot, SESSION_ID)).toEqual({ events: [], skipped: 0 });
  });

  it("appends distinct summaries as two JSONL lines", () => {
    expect(appendCompactionEvent(stateRoot, SESSION_ID, event("first"))).toBe(true);
    expect(appendCompactionEvent(stateRoot, SESSION_ID, event("second"))).toBe(true);

    expect(logLines()).toHaveLength(2);
    expect(readCompactionEvents(stateRoot, SESSION_ID).events.map((row) => row.summaryText)).toEqual([
      "first",
      "second",
    ]);
  });

  it("dedupes by summary hash: duplicate returns false and does not grow the file", () => {
    expect(appendCompactionEvent(stateRoot, SESSION_ID, event("same summary"))).toBe(true);
    const before = readFileSync(logFile(), "utf8");

    expect(appendCompactionEvent(stateRoot, SESSION_ID, event("same summary", { id: "other-id" }))).toBe(false);

    expect(readFileSync(logFile(), "utf8")).toBe(before);
    expect(readCompactionEvents(stateRoot, SESSION_ID).events).toHaveLength(1);
  });

  it("skips and counts corrupt lines while keeping valid rows", () => {
    const valid = event("valid");
    mkdirSync(dirname(logFile()), { recursive: true });
    writeFileSync(logFile(), `${JSON.stringify(valid)}\nnot-json\n{"id":"broken"}\n`, "utf8");

    const log = readCompactionEvents(stateRoot, SESSION_ID);
    expect(log.events).toEqual([valid]);
    expect(log.skipped).toBe(2);
  });

  it("appends safely after a crash-truncated line without swallowing the new event", () => {
    const stale = event("stale");
    mkdirSync(dirname(logFile()), { recursive: true });
    writeFileSync(logFile(), JSON.stringify(stale).slice(0, 20), "utf8");

    const fresh = event("fresh");
    expect(appendCompactionEvent(stateRoot, SESSION_ID, fresh)).toBe(true);

    const log = readCompactionEvents(stateRoot, SESSION_ID);
    expect(log.events).toEqual([fresh]);
    expect(log.skipped).toBe(1);
  });

  it("uses sha256 of the summary text as a stable key", () => {
    expect(compactionEventKey("abc")).toMatch(/^[0-9a-f]{64}$/);
    expect(compactionEventKey("abc")).toBe(compactionEventKey("abc"));
    expect(compactionEventKey("abc")).not.toBe(compactionEventKey("abd"));
  });
});
