import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readCompactionCache, writeCompactionCache, type ActiveCompaction } from "./compaction-cache.js";

const roots: string[] = [];

function stateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "loom-compaction-cache-"));
  roots.push(root);
  return root;
}

const BODY: ActiveCompaction = {
  sessionID: "ses_cache000000000001",
  status: "active",
  coveredCount: 951,
  summaryText: "SUM:951",
  anchorMessageId: "msg_anchor",
  anchorTimestampMs: 1792369793452,
  tailCount: 2,
  totalMessages: 953,
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("W52 compaction cache", () => {
  it("active 快照写读逐字段全等", () => {
    const root = stateRoot();
    writeCompactionCache(root, BODY.sessionID, BODY);
    expect(readCompactionCache(root, BODY.sessionID)).toEqual(BODY);
  });

  it("无文件/坏 JSON/错版本/错 sid/缺字段 -> null", () => {
    const root = stateRoot();
    expect(readCompactionCache(root, BODY.sessionID)).toBeNull();
    const file = join(root, "session", "compaction", `${BODY.sessionID}.json`);
    mkdirSync(join(root, "session", "compaction"), { recursive: true });
    writeFileSync(file, "{bad", "utf8");
    expect(readCompactionCache(root, BODY.sessionID)).toBeNull();
    writeFileSync(file, JSON.stringify({ version: 99, body: BODY }), "utf8");
    expect(readCompactionCache(root, BODY.sessionID)).toBeNull();
    writeFileSync(file, JSON.stringify({ version: 1, body: { ...BODY, status: "none" } }), "utf8");
    expect(readCompactionCache(root, BODY.sessionID)).toBeNull();
    writeFileSync(file, JSON.stringify({ version: 1, body: { ...BODY, sessionID: "other" } }), "utf8");
    expect(readCompactionCache(root, BODY.sessionID)).toBeNull();
    expect(readCompactionCache(root, "../escape")).toBeNull();
  });
});
