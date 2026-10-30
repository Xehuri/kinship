import { describe, expect, it } from "vitest";
import {
  COMPACTION_CHECKPOINT_VERSION,
  COMPACTION_TAIL_SEPARATOR,
  isCompactionCheckpointPayload,
  legacyCheckpointCoveredCount,
  resolveCheckpointTailIncluded,
  type CompactionCheckpointPayload,
} from "../compaction-checkpoint.js";
import { createUserMessage } from "../types.js";

function validPayload(): CompactionCheckpointPayload {
  return {
    summary: createUserMessage("SUMMARY"),
    checkpoint: {
      version: COMPACTION_CHECKPOINT_VERSION,
      coveredCount: 42,
      anchorTimestampMs: 1_700_000_000_000,
      summaryId: "summary-1",
      createdAt: 1_700_000_001_000,
      source: "manual",
    },
  };
}

function withCheckpoint(patch: Record<string, unknown>): unknown {
  const payload = validPayload();
  return {
    ...payload,
    checkpoint: { ...payload.checkpoint, ...patch },
  };
}

describe("legacyCheckpointCoveredCount", () => {
  it("uses the boundary message count when there is no previous boundary", () => {
    expect(legacyCheckpointCoveredCount(null, 1355)).toBe(1355);
  });

  it("counts the boundary itself for subsequent boundaries", () => {
    expect(legacyCheckpointCoveredCount(1355, 3476)).toBe(2122);
    expect(legacyCheckpointCoveredCount(3476, 4000)).toBe(525);
  });
});

describe("resolveCheckpointTailIncluded", () => {
  it("returns undefined when there is no checkpoint", () => {
    expect(resolveCheckpointTailIncluded(undefined, "SUMMARY")).toBeUndefined();
  });

  it("returns the explicit boolean flag", () => {
    const base = validPayload().checkpoint;
    expect(resolveCheckpointTailIncluded({ ...base, tailIncluded: true }, "SUMMARY")).toBe(
      true,
    );
    expect(resolveCheckpointTailIncluded({ ...base, tailIncluded: false }, "SUMMARY")).toBe(
      false,
    );
  });

  it("infers true from the legacy separator when the flag is absent", () => {
    const base = validPayload().checkpoint;
    expect(
      resolveCheckpointTailIncluded(
        base,
        `SUMMARY${COMPACTION_TAIL_SEPARATOR}TAIL`,
      ),
    ).toBe(true);
  });

  it("returns undefined for a legacy summary without the separator", () => {
    expect(resolveCheckpointTailIncluded(validPayload().checkpoint, "SUMMARY")).toBeUndefined();
  });
});

describe("isCompactionCheckpointPayload", () => {
  it("accepts a valid payload", () => {
    expect(isCompactionCheckpointPayload(validPayload())).toBe(true);
  });

  it("rejects a missing or wrong checkpoint version", () => {
    const payload = validPayload();
    const { version: _version, ...checkpointWithoutVersion } = payload.checkpoint;

    expect(
      isCompactionCheckpointPayload({
        ...payload,
        checkpoint: checkpointWithoutVersion,
      }),
    ).toBe(false);
    expect(isCompactionCheckpointPayload(withCheckpoint({ version: 2 }))).toBe(
      false,
    );
  });

  it("rejects a negative coveredCount", () => {
    expect(
      isCompactionCheckpointPayload(withCheckpoint({ coveredCount: -1 })),
    ).toBe(false);
  });

  it("rejects an empty summaryId", () => {
    expect(isCompactionCheckpointPayload(withCheckpoint({ summaryId: "" }))).toBe(
      false,
    );
  });

  it("rejects an invalid source", () => {
    expect(
      isCompactionCheckpointPayload(withCheckpoint({ source: "scheduled" })),
    ).toBe(false);
  });

  it("accepts boolean tailIncluded flags", () => {
    expect(isCompactionCheckpointPayload(withCheckpoint({ tailIncluded: true }))).toBe(true);
    expect(isCompactionCheckpointPayload(withCheckpoint({ tailIncluded: false }))).toBe(true);
  });

  it("rejects a non-boolean tailIncluded", () => {
    for (const value of ["true", 1, null, {}]) {
      expect(isCompactionCheckpointPayload(withCheckpoint({ tailIncluded: value }))).toBe(
        false,
      );
    }
  });

  it("rejects a malformed summary role or content", () => {
    const payload = validPayload();

    expect(
      isCompactionCheckpointPayload({
        ...payload,
        summary: { role: "system", content: "SUMMARY" },
      }),
    ).toBe(false);
    expect(
      isCompactionCheckpointPayload({
        ...payload,
        summary: { role: "assistant", content: "SUMMARY" },
      }),
    ).toBe(false);
  });
});
