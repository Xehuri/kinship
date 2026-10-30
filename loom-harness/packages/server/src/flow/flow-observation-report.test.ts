/**
 * L9 dashboard 与 bucket B dry-run：合成事件聚合、空窗、零写入。
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const OBS_SCRIPT = join(REPO_ROOT, "scripts", "flow-observation.mjs");
const BUCKET_SCRIPT = join(REPO_ROOT, "scripts", "flow-bucket-b-migration.mjs");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "loom-flow-dashboard-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seedWindow(startedAt: number, endsAt: number): void {
  mkdirSync(join(root, "flow-observation"), { recursive: true });
  writeFileSync(
    join(root, "flow-observation", "window.json"),
    `${JSON.stringify({ schema: 1, started_at: startedAt, ends_at: endsAt, days: 7 })}\n`,
    "utf8",
  );
}

function seedEvents(events: ReadonlyArray<Record<string, unknown>>): void {
  mkdirSync(join(root, "flow-observation"), { recursive: true });
  writeFileSync(
    join(root, "flow-observation", "events.jsonl"),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );
}

function report(): Record<string, unknown> {
  const text = execFileSync(process.execPath, [OBS_SCRIPT, "report", "--root", root, "--json"], {
    encoding: "utf8",
  });
  return JSON.parse(text) as Record<string, unknown>;
}

interface ObservedCounts {
  readonly lost_wakes: number;
  readonly duplicate_wakes: number;
  readonly flow_ended_without_idle: number;
  readonly duplicate_suppressed: number;
  readonly events: number;
}

function countsOf(summary: Record<string, unknown>): ObservedCounts {
  return summary["counts"] as ObservedCounts;
}

describe("flow observation dashboard", () => {
  it("reports a missing window cleanly as not_started", () => {
    const summary = report();
    expect(summary["window"]).toMatchObject({ state: "not_started" });
    expect(countsOf(summary).events).toBe(0);
    expect((summary["gate"] as { pass: boolean }).pass).toBe(false);
  });

  it("reports PASS for a complete window with delivered wake, idle and green CI", () => {
    const now = Date.now();
    seedWindow(now - 8 * DAY, now - 1 * DAY);
    seedEvents([
      { ts: now - 2 * DAY, type: "wake.armed", session_id: "s1", subject_at: now - 2 * DAY + HOUR, scheduled_at: now - 2 * DAY + HOUR },
      { ts: now - 2 * DAY + HOUR, type: "wake.delivered", session_id: "s1", subject_at: now - 2 * DAY + HOUR, scheduled_at: now - 2 * DAY + HOUR },
      { ts: now - 2 * DAY + 2 * HOUR, type: "flow.ended", session_id: "s1", subject_id: "flow_000000000001", state: "waiting_user", next_decision_at: null },
      { ts: now - 2 * DAY + 2 * HOUR + 1000, type: "session.idle", session_id: "s1", has_flow: true, flow: { subject_id: "flow_000000000001", state: "waiting_user" } },
    ]);
    execFileSync(process.execPath, [OBS_SCRIPT, "record-ci", "--root", root, "--status", "pass", "--detail", "unit"], {
      encoding: "utf8",
    });

    const summary = report();
    expect(summary["window"]).toMatchObject({ state: "complete" });
    expect(summary["gate"]).toEqual({ pass: true, reasons: [] });
    expect(countsOf(summary)).toMatchObject({ lost_wakes: 0, duplicate_wakes: 0, flow_ended_without_idle: 0 });
  });

  it("detects a lost wake after the grace window", () => {
    const now = Date.now();
    seedWindow(now - 8 * DAY, now - 1 * DAY);
    seedEvents([
      { ts: now - 3 * DAY, type: "wake.armed", session_id: "s1", subject_at: now - 3 * DAY + HOUR, scheduled_at: now - 3 * DAY + HOUR },
      { ts: now - 2 * DAY, type: "session.idle", session_id: "s1", has_flow: false, flow: null },
    ]);

    const summary = report();
    expect(summary["lost_wakes"]).toHaveLength(1);
    expect(summary["gate"]).toMatchObject({ pass: false });
    expect((summary["gate"] as { reasons: string[] }).reasons.join(" ")).toContain("lost wake");
  });

  it("treats a stale render as resolved and counts duplicate deliveries", () => {
    const now = Date.now();
    seedWindow(now - 8 * DAY, now - 1 * DAY);
    seedEvents([
      { ts: now - 3 * DAY, type: "wake.armed", session_id: "s1", subject_at: now - 3 * DAY + HOUR, scheduled_at: now - 3 * DAY + HOUR },
      { ts: now - 3 * DAY + HOUR, type: "wake.stale", session_id: "s1", scheduled_at: now - 3 * DAY + HOUR },
      { ts: now - 3 * DAY + 2 * HOUR, type: "wake.armed", session_id: "s1", subject_at: now - 3 * DAY + 3 * HOUR, scheduled_at: now - 3 * DAY + 3 * HOUR },
      { ts: now - 3 * DAY + 3 * HOUR, type: "wake.delivered", session_id: "s1", subject_at: now - 3 * DAY + 3 * HOUR, scheduled_at: now - 3 * DAY + 3 * HOUR },
      { ts: now - 3 * DAY + 3 * HOUR + 1, type: "wake.delivered", session_id: "s1", subject_at: now - 3 * DAY + 3 * HOUR, scheduled_at: now - 3 * DAY + 3 * HOUR },
      { ts: now - 3 * DAY + 4 * HOUR, type: "wake.duplicate_suppressed", session_id: "s1", subject_at: now - 3 * DAY + 3 * HOUR },
    ]);

    const summary = report();
    expect(countsOf(summary)).toMatchObject({
      lost_wakes: 0,
      duplicate_wakes: 1,
      duplicate_suppressed: 1,
    });
    expect(summary["duplicate_wakes"]).toMatchObject([{ session_id: "s1", count: 2 }]);
    expect(summary["gate"]).toMatchObject({ pass: false });
  });

  it("detects flow.ended without a nearby session.idle", () => {
    const now = Date.now();
    seedWindow(now - 8 * DAY, now - 1 * DAY);
    seedEvents([
      { ts: now - 2 * DAY, type: "flow.ended", session_id: "s1", subject_id: "flow_000000000001", state: "closed", next_decision_at: null },
    ]);

    const summary = report();
    expect(summary["flow_ended_without_idle"]).toHaveLength(1);
    expect((summary["gate"] as { reasons: string[] }).reasons.join(" ")).toContain("flowEnded without idle");
  });
});

describe("bucket B dry-run", () => {
  it("scans 30 files, prints planned replacements and writes nothing", () => {
    const fileListText = readFileSync(join(REPO_ROOT, "scripts", "flow-bucket-b-migration.mjs"), "utf8");
    const paths = [...fileListText.matchAll(/"packages\/[^"]+\.test\.ts"/g)].map((match) =>
      match[0].slice(1, -1),
    );
    const before = new Map(paths.map((relPath) => [relPath, readFileSync(join(REPO_ROOT, relPath), "utf8")]));

    const stdout = execFileSync(process.execPath, [BUCKET_SCRIPT, "--dry-run"], {
      encoding: "utf8",
    });
    expect(stdout).toContain("bucket-b dry-run:");
    expect(stdout).toContain(`files=${String(paths.length)}`);
    expect(stdout).toContain("writes=0");
    expect(stdout).toContain("no files were modified");

    const refused = spawnSync(process.execPath, [BUCKET_SCRIPT, "--apply"], { encoding: "utf8" });
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("refused");

    for (const [relPath, content] of before) {
      expect(readFileSync(join(REPO_ROOT, relPath), "utf8")).toBe(content);
    }
  });
});
