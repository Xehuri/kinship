/**
 * L9 观察窗单测：JSONL 结构、窗口文件、fail-soft、unset 回调、调度器投递/stale。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WakeScheduler } from "../serve/wake-scheduler.js";
import {
  createFlowObservationSink,
  FLOW_OBSERVATION_EVENTS_FILE,
  FLOW_OBSERVATION_WINDOW_FILE,
} from "./flow-observation.js";
import { JsonFlowStore } from "./json-flow-store.js";

const NOW = Date.UTC(2026, 9, 23, 9, 0, 0);

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "loom-flow-observation-"));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

function readLines(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("flow observation sink", () => {
  it("appends valid JSONL events with a timestamp", () => {
    const sink = createFlowObservationSink({ stateRoot: root, now: () => NOW });
    sink.observe({
      type: "wake.armed",
      session_id: "sess_observe",
      subject_at: NOW + 1_000,
      scheduled_at: NOW + 2_000,
    });
    sink.observe({
      type: "session.idle",
      session_id: "sess_observe",
      has_flow: false,
      flow: null,
    });

    const lines = readLines(sink.eventsFile);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      ts: NOW,
      type: "wake.armed",
      session_id: "sess_observe",
      subject_at: NOW + 1_000,
      scheduled_at: NOW + 2_000,
    });
    expect(lines[1]).toMatchObject({ ts: NOW, type: "session.idle", has_flow: false });
  });

  it("writes window.json with the requested duration", () => {
    const sink = createFlowObservationSink({ stateRoot: root, now: () => NOW });
    const window = sink.startWindow(7);

    expect(window).toEqual({
      schema: 1,
      started_at: NOW,
      ends_at: NOW + 7 * 24 * 60 * 60 * 1000,
      days: 7,
    });
    const stored = JSON.parse(
      readFileSync(join(sink.directory, FLOW_OBSERVATION_WINDOW_FILE), "utf8"),
    ) as Record<string, unknown>;
    expect(stored).toEqual(window);
  });

  it("never throws when the observation path is unwritable", () => {
    const fileAsRoot = join(root, "not-a-directory");
    writeFileSync(fileAsRoot, "x", "utf8");
    const sink = createFlowObservationSink({ stateRoot: fileAsRoot });

    expect(() =>
      sink.observe({ type: "wake.cleared", session_id: "sess_bad", subject_ats: [1] }),
    ).not.toThrow();
    expect(sink.startWindow(7)).toBeNull();
  });

  it("emits flow.unset through JsonFlowStore onUnset", async () => {
    const sink = createFlowObservationSink({ stateRoot: root, now: () => NOW });
    const store = new JsonFlowStore({
      stateRoot: root,
      now: () => NOW,
      onUnset: (record) => {
        sink.observe({
          type: "flow.unset",
          session_id: record.session_id,
          reason: record.reason,
          turn_idx: record.turn_idx,
        });
      },
    });

    await store.appendUnset("sess_unset", {
      turn_idx: 3,
      reason: "no_commit",
      had_tool_results: false,
    });

    const lines = readLines(join(root, "flow-observation", FLOW_OBSERVATION_EVENTS_FILE));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      type: "flow.unset",
      session_id: "sess_unset",
      reason: "no_commit",
      turn_idx: 3,
    });
  });
});

describe("wake scheduler observation", () => {
  it("emits wake.delivered with a derived subject_at", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const events: Array<Record<string, unknown>> = [];
    const sessions = new Set(["sess_wake"]);
    const scheduler = new WakeScheduler({
      stateRoot: root,
      now: () => Date.now(),
      deliver: () => {},
      render: () => "【心流唤醒】due",
      subjectAt: () => NOW + 1_000,
      observe: (event) => events.push(event as unknown as Record<string, unknown>),
      hasSession: (sessionID) => sessions.has(sessionID),
    });

    scheduler.arm("sess_wake", NOW + 1_000);
    vi.advanceTimersByTime(1_000);

    expect(events).toEqual([
      {
        type: "wake.delivered",
        session_id: "sess_wake",
        scheduled_at: NOW + 1_000,
        subject_at: NOW + 1_000,
      },
    ]);
  });

  it("emits wake.stale when the renderer reports null", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const events: Array<Record<string, unknown>> = [];
    const sessions = new Set(["sess_stale"]);
    const scheduler = new WakeScheduler({
      stateRoot: root,
      now: () => Date.now(),
      deliver: () => {
        throw new Error("must not deliver");
      },
      render: () => null,
      observe: (event) => events.push(event as unknown as Record<string, unknown>),
      hasSession: (sessionID) => sessions.has(sessionID),
    });

    scheduler.arm("sess_stale", NOW + 1_000);
    vi.advanceTimersByTime(1_000);

    expect(events).toEqual([
      { type: "wake.stale", session_id: "sess_stale", scheduled_at: NOW + 1_000 },
    ]);
    expect(existsSync(join(root, "session", "wake", "sess_stale.json"))).toBe(false);
  });
});
