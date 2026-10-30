/**
 * Per-session context watcher acceptance tests (pure in-memory IO seams).
 *
 * Contract pinned here:
 *   - exact-stat seeding is silent; a content change yields a unified diff (not the full file);
 *   - touch (stat change, identical text) emits no notice but aligns the watermark;
 *   - remove / re-add map to remove / set notices; peek never advances, consume advances once;
 *   - reseed rebases the session baseline (suppresses included content, diffs from the new base);
 *   - a preview from an older generation is reported stale while a fresh check advances;
 *   - the shared template prevents replay for sessions registered after a consumed change, while
 *     sessions registered before keep their own baseline;
 *   - dynamic sources use (revision, bytes, text) gating and fail-soft rescan;
 *   - stat/read failures never throw: prior entries become removals, unknown paths are skipped.
 */

import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ContextBaselineTemplate,
  SessionContextWatcher,
  type ContextBaseline,
  type SessionContextDynamicSource,
  type SessionContextSource,
} from "./session-context.js";
import type { ContextChangeOutcome } from "./context-change.js";

const encoder = new TextEncoder();
const bytes = (text: string): number => encoder.encode(text).length;

const V1 = "# AGENTS\nrule one\nrule two\n";
const V2 = "# AGENTS\nrule one\nrule two changed\n";
const V3 = "# AGENTS\nrule one\nrule three\n";

function required<T>(value: T | null): T {
  if (value === null) throw new Error("expected a non-null value");
  return value;
}

interface FakeFile {
  readonly mtimeMs: number;
  readonly size: number;
  readonly text: string;
}

class FakeWorkspace {
  readonly root = "/fake-workspace";
  readonly files = new Map<string, FakeFile>();
  readonly readFailures = new Set<string>();

  readonly statFile = (absPath: string): { readonly mtimeMs: number; readonly size: number } | null => {
    const file = this.files.get(absPath);
    return file === undefined ? null : { mtimeMs: file.mtimeMs, size: file.size };
  };

  readonly readTextFile = (absPath: string): string | null => {
    if (this.readFailures.has(absPath)) return null;
    return this.files.get(absPath)?.text ?? null;
  };

  set(relPath: string, text: string, mtimeMs: number): void {
    this.files.set(join(this.root, relPath), { mtimeMs, size: bytes(text), text });
  }

  remove(relPath: string): void {
    this.files.delete(join(this.root, relPath));
  }

  failRead(relPath: string): void {
    this.readFailures.add(join(this.root, relPath));
  }
}

interface WatcherOverrides {
  readonly template?: ContextBaselineTemplate;
  readonly dynamicSources?: readonly SessionContextDynamicSource[];
  readonly onOutcome?: (outcome: ContextChangeOutcome) => void;
}

function watcherFor(
  workspace: FakeWorkspace,
  sources: readonly SessionContextSource[],
  overrides: WatcherOverrides = {},
): SessionContextWatcher {
  return new SessionContextWatcher({
    workspaceRoot: workspace.root,
    sources,
    statFile: workspace.statFile,
    readTextFile: workspace.readTextFile,
    ...overrides,
  });
}

describe("SessionContextWatcher default fs seams", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "loom-session-context-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("is silent when the seeded stat matches the file on disk", () => {
    const text = "# AGENTS\nrule one\n";
    writeFileSync(join(root, "AGENTS.md"), text, "utf8");
    const st = statSync(join(root, "AGENTS.md"));
    const watcher = new SessionContextWatcher({
      workspaceRoot: root,
      sources: [{ relPath: "AGENTS.md", content: text, mtimeMs: st.mtimeMs, size: st.size }],
    });

    expect(watcher.peek()).toBeNull();
    expect(watcher.check()).toBeNull();
  });
});

describe("SessionContextWatcher static sources", () => {
  it("reports a unified diff for a content change and consumes it exactly once", () => {
    const workspace = new FakeWorkspace();
    const before = [
      "line-1",
      "line-2",
      "line-3",
      "line-4",
      "line-5",
      "line-6",
      "line-7",
      "line-8",
      "line-9",
      "stable-tail",
      "",
    ].join("\n");
    const after = before.replace("line-5", "line-5-changed");
    workspace.set("AGENTS.md", before, 1);
    const outcomes: ContextChangeOutcome[] = [];
    const watcher = watcherFor(
      workspace,
      [{ relPath: "AGENTS.md", content: before, mtimeMs: 1, size: bytes(before) }],
      { onOutcome: (outcome) => outcomes.push(outcome) },
    );

    workspace.set("AGENTS.md", after, 2);
    const preview = required(watcher.peek());
    expect(preview.actions).toHaveLength(1);
    expect(preview.actions[0]?.kind).toBe("replace");
    const notice = preview.notices[0] ?? "";
    expect(notice).toContain("Updated instructions from: AGENTS.md");
    expect(notice).toContain("@@ -");
    expect(notice).toContain("+line-5-changed");
    expect(notice).not.toContain("line-1");
    expect(notice).not.toContain("line-9");
    expect(watcher.watermark.get("AGENTS.md")?.mtimeMs).toBe(1);

    const consumed = watcher.consume(preview);
    expect(consumed.stalePreviewNotices).toEqual([]);
    expect(consumed.outcome?.actions).toHaveLength(1);
    expect(outcomes).toEqual([]);
    expect(watcher.check()).toBeNull();

    workspace.set("AGENTS.md", `${after}extra\n`, 3);
    const fresh = required(watcher.check());
    expect(fresh.actions).toHaveLength(1);
    expect(outcomes).toEqual([fresh]);
  });

  it("aligns the watermark without a notice on touch (same text, new stat)", () => {
    const workspace = new FakeWorkspace();
    workspace.set("AGENTS.md", V1, 1);
    const watcher = watcherFor(workspace, [
      { relPath: "AGENTS.md", content: V1, mtimeMs: 1, size: bytes(V1) },
    ]);

    workspace.set("AGENTS.md", V1, 9);
    const preview = required(watcher.peek());
    expect(preview.actions).toEqual([]);
    expect(preview.notices).toEqual([]);
    expect(preview.observations).toHaveLength(1);

    const consumed = watcher.consume(preview);
    expect(consumed.outcome?.actions).toEqual([]);
    expect(watcher.watermark.get("AGENTS.md")?.mtimeMs).toBe(9);
    expect(watcher.peek()).toBeNull();
  });

  it("reports removal and a later re-appearance as set", () => {
    const workspace = new FakeWorkspace();
    workspace.set("AGENTS.md", V1, 1);
    const watcher = watcherFor(workspace, [
      { relPath: "AGENTS.md", content: V1, mtimeMs: 1, size: bytes(V1) },
    ]);

    workspace.remove("AGENTS.md");
    const removed = required(watcher.check());
    expect(removed.actions[0]?.kind).toBe("remove");
    expect(removed.notices[0] ?? "").toContain("Instructions removed: AGENTS.md");

    workspace.set("AGENTS.md", V2, 5);
    const readded = required(watcher.check());
    expect(readded.actions[0]?.kind).toBe("set");
    expect(readded.notices[0] ?? "").toContain("Additional instructions from: AGENTS.md");
  });

  it("keeps peek non-mutating across repeated calls", () => {
    const workspace = new FakeWorkspace();
    workspace.set("AGENTS.md", V1, 1);
    const watcher = watcherFor(workspace, [
      { relPath: "AGENTS.md", content: V1, mtimeMs: 1, size: bytes(V1) },
    ]);
    workspace.set("AGENTS.md", V2, 2);

    const first = required(watcher.peek());
    const second = required(watcher.peek());
    expect(second.actions).toEqual(first.actions);
    expect(second.notices).toEqual(first.notices);
    expect(watcher.watermark.get("AGENTS.md")?.content).toBe(V1);

    const consumed = watcher.consume(first);
    expect(consumed.outcome?.actions).toHaveLength(1);
    expect(watcher.check()).toBeNull();
  });

  it("seeds content-only sources with -1/byteLength and aligns on the first check", () => {
    const workspace = new FakeWorkspace();
    workspace.set("AGENTS.md", V1, 1);
    const watcher = watcherFor(workspace, [{ relPath: "AGENTS.md", content: V1 }]);
    expect(watcher.watermark.get("AGENTS.md")).toEqual({
      mtimeMs: -1,
      size: bytes(V1),
      content: V1,
    });

    const preview = required(watcher.peek());
    expect(preview.actions).toEqual([]);
    expect(preview.notices).toEqual([]);
    watcher.consume(preview);
    expect(watcher.watermark.get("AGENTS.md")?.mtimeMs).toBe(1);
    expect(watcher.peek()).toBeNull();
  });

  it("treats a content:null source as unwatched until the file appears", () => {
    const workspace = new FakeWorkspace();
    const watcher = watcherFor(workspace, [{ relPath: "AGENTS.md", content: null }]);
    expect(watcher.watermark.has("AGENTS.md")).toBe(false);
    expect(watcher.peek()).toBeNull();

    workspace.set("AGENTS.md", V1, 1);
    const outcome = required(watcher.check());
    expect(outcome.actions[0]?.kind).toBe("set");
    expect(outcome.notices[0] ?? "").toContain("Additional instructions from: AGENTS.md");
    expect(watcher.watermark.get("AGENTS.md")?.content).toBe(V1);
  });

  it("fails soft on read errors: prior entries become removals, unknown paths are skipped", () => {
    const workspace = new FakeWorkspace();
    workspace.set("AGENTS.md", V1, 1);
    const watcher = watcherFor(workspace, [
      { relPath: "AGENTS.md", content: V1, mtimeMs: 1, size: bytes(V1) },
    ]);
    workspace.set("AGENTS.md", V2, 2);
    workspace.failRead("AGENTS.md");

    const removed = required(watcher.check());
    expect(removed.actions[0]?.kind).toBe("remove");
    expect(watcher.watermark.has("AGENTS.md")).toBe(false);

    const barren = new FakeWorkspace();
    barren.set("AGENTS.md", V1, 1);
    barren.failRead("AGENTS.md");
    const unwatched = watcherFor(barren, [{ relPath: "AGENTS.md", content: null }]);
    expect(unwatched.check()).toBeNull();
  });
});

describe("SessionContextWatcher reseed", () => {
  it("suppresses baseline content and diffs the next change from the new baseline", () => {
    const workspace = new FakeWorkspace();
    workspace.set("AGENTS.md", V1, 1);
    const watcher = watcherFor(workspace, [
      { relPath: "AGENTS.md", content: V1, mtimeMs: 1, size: bytes(V1) },
    ]);
    expect(watcher.generation).toBe(0);

    const baseline: ContextBaseline = [
      { relPath: "AGENTS.md", content: V2, mtimeMs: 5, size: bytes(V2) },
    ];
    watcher.reseed(baseline);
    expect(watcher.generation).toBe(1);

    workspace.set("AGENTS.md", V2, 5);
    expect(watcher.peek()).toBeNull();

    workspace.set("AGENTS.md", V3, 7);
    const outcome = required(watcher.check());
    expect(outcome.actions[0]?.kind).toBe("replace");
    const diff = outcome.actions[0]?.kind === "replace" ? outcome.actions[0].diff : "";
    expect(diff).toContain("-rule two changed");
    expect(diff).toContain("+rule three");
  });

  it("drops static entries absent from the baseline and keeps dynamic entries", () => {
    const workspace = new FakeWorkspace();
    workspace.set("AGENTS.md", V1, 1);
    const template = new ContextBaselineTemplate(
      new Map([
        ["skills/catalog", { mtimeMs: 1, size: bytes("catalog-v1"), content: "catalog-v1" }],
      ]),
    );
    const watcher = watcherFor(
      workspace,
      [{ relPath: "AGENTS.md", content: V1, mtimeMs: 1, size: bytes(V1) }],
      {
        template,
        dynamicSources: [{ relPath: "skills/catalog", snapshot: () => ({ text: "catalog-v1", revision: 1 }) }],
      },
    );

    watcher.reseed([]);
    expect(watcher.watermark.has("AGENTS.md")).toBe(false);
    expect(watcher.watermark.has("skills/catalog")).toBe(true);
    const shared = template.snapshot();
    expect(shared.has("AGENTS.md")).toBe(false);
    expect(shared.has("skills/catalog")).toBe(true);
  });

  it("marks an older preview stale and advances from a fresh check", () => {
    const workspace = new FakeWorkspace();
    workspace.set("AGENTS.md", V1, 1);
    const watcher = watcherFor(workspace, [
      { relPath: "AGENTS.md", content: V1, mtimeMs: 1, size: bytes(V1) },
    ]);

    workspace.set("AGENTS.md", V2, 2);
    const preview = required(watcher.peek());
    workspace.set("AGENTS.md", V3, 3);
    watcher.reseed([{ relPath: "AGENTS.md", content: V2, mtimeMs: 2, size: bytes(V2) }]);
    expect(watcher.generation).toBe(1);

    const consumed = watcher.consume(preview);
    expect(consumed.stalePreviewNotices).toEqual(preview.notices);
    expect(consumed.outcome?.actions[0]?.kind).toBe("replace");
    expect(watcher.watermark.get("AGENTS.md")).toEqual({
      mtimeMs: 3,
      size: bytes(V3),
      content: V3,
    });
  });
});

describe("ContextBaselineTemplate sharing", () => {
  it("suppresses replay for sessions created after consumption but not before", () => {
    const workspace = new FakeWorkspace();
    workspace.set("AGENTS.md", V1, 1);
    const template = new ContextBaselineTemplate(
      new Map([["AGENTS.md", { mtimeMs: 1, size: bytes(V1), content: V1 }]]),
    );
    const sourcesV1: readonly SessionContextSource[] = [
      { relPath: "AGENTS.md", content: V1, mtimeMs: 1, size: bytes(V1) },
    ];

    const early = watcherFor(workspace, sourcesV1, { template });
    const late = watcherFor(workspace, sourcesV1, { template });
    workspace.set("AGENTS.md", V2, 2);

    const earlyOutcome = required(early.check());
    expect(earlyOutcome.actions[0]?.kind).toBe("replace");
    expect(template.snapshot().get("AGENTS.md")?.content).toBe(V2);

    const lateOutcome = required(late.check());
    expect(lateOutcome.actions[0]?.kind).toBe("replace");

    const afterSources: readonly SessionContextSource[] = [
      { relPath: "AGENTS.md", content: V2, mtimeMs: 2, size: bytes(V2) },
    ];
    const after = watcherFor(workspace, afterSources, { template });
    expect(after.peek()).toBeNull();
    expect(after.check()).toBeNull();
  });
});

describe("SessionContextWatcher dynamic sources", () => {
  it("gates on revision/bytes/text and skips a throwing rescan", () => {
    const workspace = new FakeWorkspace();
    let snapshot: { readonly text: string; readonly revision: number } | null = {
      text: "catalog-v1",
      revision: 1,
    };
    let rescanCalls = 0;
    let throwOnRescan = false;
    const dynamicSource: SessionContextDynamicSource = {
      relPath: "skills/catalog",
      rescan: () => {
        rescanCalls++;
        if (throwOnRescan) throw new Error("rescan boom");
      },
      snapshot: () => snapshot,
    };
    const watcher = watcherFor(workspace, [], { dynamicSources: [dynamicSource] });

    expect(watcher.check()).toBeNull();

    snapshot = { text: "catalog-v1", revision: 2 };
    const touch = required(watcher.check());
    expect(touch.actions).toEqual([]);
    expect(touch.notices).toEqual([]);
    expect(watcher.watermark.get("skills/catalog")?.mtimeMs).toBe(2);

    snapshot = { text: "catalog-v2", revision: 3 };
    const changed = required(watcher.check());
    expect(changed.actions[0]?.kind).toBe("replace");
    expect(changed.notices[0] ?? "").toContain("Updated instructions from: skills/catalog");

    throwOnRescan = true;
    snapshot = { text: "catalog-v3", revision: 4 };
    expect(watcher.check()).toBeNull();
    expect(rescanCalls).toBe(4);
  });

  it("seeds null snapshots as unseen and reports the first appearance as set", () => {
    const workspace = new FakeWorkspace();
    let snapshot: { readonly text: string; readonly revision: number } | null = null;
    const watcher = watcherFor(workspace, [], {
      dynamicSources: [{ relPath: "skills/catalog", snapshot: () => snapshot }],
    });

    expect(watcher.check()).toBeNull();
    snapshot = { text: "catalog-v1", revision: 1 };
    const first = required(watcher.check());
    expect(first.actions[0]?.kind).toBe("set");
    expect(first.notices[0] ?? "").toContain("Additional instructions from: skills/catalog");
  });
});
