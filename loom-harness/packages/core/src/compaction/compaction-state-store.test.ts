/**
 * W57 压缩状态 sidecar 单测：missing/corrupt 降级、原子覆盖、路径安全。
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { beginCompaction, idleState } from "./compaction-state.js";
import {
  COMPACTION_STATE_SIDECAR_VERSION,
  CompactionStateStore,
  sanitizeSessionIdForFilename,
} from "./compaction-state-store.js";

let root: string;
let store: CompactionStateStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "loom-compaction-state-"));
  store = new CompactionStateStore({ stateRoot: root });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("CompactionStateStore", () => {
  it("returns a clear missing result for an absent sidecar", () => {
    const result = store.read("ses_absent");
    expect(result.kind).toBe("missing");
    expect(result.state).toBeNull();
    expect(result.path).toBe(join(root, "session", "compaction-state", "ses_absent.json"));
  });

  it("round-trips through the version 1 wrapper and leaves no tmp files", () => {
    const state = beginCompaction(idleState(1_000), {
      attemptId: "cmp_roundtrip",
      reason: "manual",
      baseCoveredCount: 33,
      baseCheckpointId: "cp_33",
      now: 2_000,
    });
    const path = store.write("ses_roundtrip", state);

    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      version?: unknown;
      body?: unknown;
    };
    expect(raw.version).toBe(COMPACTION_STATE_SIDECAR_VERSION);
    expect(raw.body).toEqual(state);

    const result = store.read("ses_roundtrip");
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.state).toEqual(state);

    const leftovers = readdirSync(dirname(path)).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("atomically replaces an existing sidecar", () => {
    store.write("ses_replace", idleState(1));
    const running = beginCompaction(idleState(2), {
      attemptId: "cmp_replace",
      reason: "watermark",
      now: 3,
    });
    store.write("ses_replace", running);

    const result = store.read("ses_replace");
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.state).toEqual(running);
  });

  it.each([
    ["invalid JSON", "{ not json"],
    ["wrong wrapper version", JSON.stringify({ version: 2, body: idleState(1) })],
    ["non-object top level", JSON.stringify([])],
    ["invalid body", JSON.stringify({ version: 1, body: { version: 1 } })],
  ])("degrades corrupt sidecars to null without throwing: %s", (_label, content) => {
    const path = store.pathFor("ses_corrupt");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");

    const result = store.read("ses_corrupt");
    expect(result.kind).toBe("corrupt");
    expect(result.state).toBeNull();
    if (result.kind === "corrupt") expect(result.error.length).toBeGreaterThan(0);
  });

  it("refuses to write an invalid state before touching disk", () => {
    const invalid = { ...idleState(1), status: "bogus" } as unknown as ReturnType<typeof idleState>;
    expect(() => store.write("ses_invalid", invalid)).toThrow(TypeError);
    expect(store.read("ses_invalid").kind).toBe("missing");
  });

  it("keeps every session id inside the sidecar directory", () => {
    const dir = join(root, "session", "compaction-state");
    for (const sid of ["../escape", "a/b", "..", "x y", "\u0000null"]) {
      const path = store.pathFor(sid);
      expect(dirname(path)).toBe(dir);
      expect(path.startsWith(`${dir}${sep}`)).toBe(true);
      expect(path.includes("..")).toBe(false);
    }
    expect(store.pathFor("ses_abc-123").endsWith("ses_abc-123.json")).toBe(true);
    expect(sanitizeSessionIdForFilename("ses_abc-123")).toBe("ses_abc-123");
  });

  it("gives distinct unsafe ids distinct filenames", () => {
    expect(store.pathFor("a/b")).not.toBe(store.pathFor("a_b"));
    expect(store.pathFor("../same")).not.toBe(store.pathFor("..\\same"));
  });
});
