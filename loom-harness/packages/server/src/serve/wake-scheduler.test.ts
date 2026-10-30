/**
 * WakeScheduler 单测：假定时器 + 真临时目录。
 *
 * Given 一个 stateRoot 与注入时钟；When arm/restore/advance；Then 校验 sidecar 生命周期、
 * 投递次数与文本、分块续时、以及所有坏输入的 fail-soft 行为。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  WakeScheduler,
  autoWakeNotifyProps,
  formatAutoWakeLine,
  type WakeSchedulerOptions,
} from "./wake-scheduler.js";

interface DeliverCall {
  readonly sessionID: string;
  readonly line: string;
  readonly props: Readonly<Record<string, unknown>>;
}

interface LogCall {
  readonly level: "warn" | "info";
  readonly msg: string;
  readonly fields: Record<string, unknown>;
}

interface Harness {
  readonly scheduler: WakeScheduler;
  readonly delivered: DeliverCall[];
  readonly logs: LogCall[];
  readonly sessions: Set<string>;
}

const BASE = new Date(2026, 9, 21, 10, 0, 0, 0).getTime();
const DAY_MS = 24 * 60 * 60 * 1000;

let root = "";

function makeHarness(
  extra: {
    readonly maxTimerMs?: number;
    readonly render?: WakeSchedulerOptions["render"];
  } = {},
): Harness {
  const delivered: DeliverCall[] = [];
  const logs: LogCall[] = [];
  const sessions = new Set<string>();
  const opts: WakeSchedulerOptions = {
    stateRoot: root,
    now: () => Date.now(),
    deliver: (sessionID, line, props) => {
      delivered.push({ sessionID, line, props });
    },
    hasSession: (sessionID) => sessions.has(sessionID),
    log: (level, msg, fields) => {
      logs.push({ level, msg, fields });
    },
    ...(extra.maxTimerMs === undefined ? {} : { maxTimerMs: extra.maxTimerMs }),
    ...(extra.render === undefined ? {} : { render: extra.render }),
  };
  return { scheduler: new WakeScheduler(opts), delivered, logs, sessions };
}

function wakeDir(): string {
  return join(root, "session", "wake");
}

function wakeFile(sessionID: string): string {
  return join(wakeDir(), `${sessionID}.json`);
}

function writeSidecar(sessionID: string, at: number): void {
  mkdirSync(wakeDir(), { recursive: true });
  writeFileSync(wakeFile(sessionID), `${JSON.stringify({ sessionID, at })}\n`, "utf8");
}

function readSidecar(sessionID: string): unknown {
  return JSON.parse(readFileSync(wakeFile(sessionID), "utf8"));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE);
  root = mkdtempSync(join(tmpdir(), "loom-wake-"));
});

afterEach(() => {
  vi.useRealTimers();
  if (root !== "") rmSync(root, { recursive: true, force: true });
  root = "";
});

describe("WakeScheduler arm/fire", () => {
  it("arms a future wake, persists the sidecar, delivers once and deletes it", () => {
    const h = makeHarness();
    h.sessions.add("sess_a");
    const at = BASE + 5_000;

    h.scheduler.arm("sess_a", at);

    expect(h.scheduler.pending("sess_a")).toBe(at);
    expect(existsSync(wakeFile("sess_a"))).toBe(true);
    expect(readSidecar("sess_a")).toMatchObject({ sessionID: "sess_a", at });

    vi.advanceTimersByTime(4_999);
    expect(h.delivered).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(h.delivered).toHaveLength(1);
    const call = h.delivered[0];
    expect(call?.sessionID).toBe("sess_a");
    expect(call?.line).toBe(formatAutoWakeLine(at));
    expect(call?.props["title"]).toBe("自动唤醒");
    expect(call?.props["variant"]).toBe("info");
    expect(call?.props["title"]).not.toBe("PTY 退出通知");
    expect(call?.props).toEqual(autoWakeNotifyProps(at));
    expect(existsSync(wakeFile("sess_a"))).toBe(false);
    expect(h.scheduler.pending("sess_a")).toBeUndefined();
  });

  it("arm(null) clears the timer and the sidecar", () => {
    const h = makeHarness();
    h.sessions.add("sess_a");

    h.scheduler.arm("sess_a", BASE + 10_000);
    expect(existsSync(wakeFile("sess_a"))).toBe(true);

    h.scheduler.arm("sess_a", null);

    expect(h.scheduler.pending("sess_a")).toBeUndefined();
    expect(existsSync(wakeFile("sess_a"))).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(h.delivered).toHaveLength(0);
  });

  it("re-arming replaces the previous timer and only the latest fires", () => {
    const h = makeHarness();
    h.sessions.add("sess_a");
    const latest = BASE + 3_000;

    h.scheduler.arm("sess_a", BASE + 1_000);
    h.scheduler.arm("sess_a", latest);

    expect(h.scheduler.pending("sess_a")).toBe(latest);
    expect(readSidecar("sess_a")).toMatchObject({ sessionID: "sess_a", at: latest });

    vi.advanceTimersByTime(2_000);
    expect(h.delivered).toHaveLength(0);

    vi.advanceTimersByTime(1_000);
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]?.line).toBe(formatAutoWakeLine(latest));
  });

  it("chunks long delays with maxTimerMs until the wake time is reached", () => {
    const h = makeHarness({ maxTimerMs: 1_000 });
    h.sessions.add("sess_a");
    const at = BASE + 2_500;

    h.scheduler.arm("sess_a", at);
    expect(h.scheduler.pending("sess_a")).toBe(at);

    vi.advanceTimersByTime(1_000);
    expect(h.delivered).toHaveLength(0);
    expect(h.scheduler.pending("sess_a")).toBe(at);

    vi.advanceTimersByTime(1_000);
    expect(h.delivered).toHaveLength(0);
    expect(h.scheduler.pending("sess_a")).toBe(at);

    vi.advanceTimersByTime(500);
    expect(h.delivered).toHaveLength(1);
    expect(h.scheduler.pending("sess_a")).toBeUndefined();
  });

  it("dispose prevents delivery", () => {
    const h = makeHarness();
    h.sessions.add("sess_a");

    h.scheduler.arm("sess_a", BASE + 5_000);
    h.scheduler.dispose();

    expect(h.scheduler.pending("sess_a")).toBeUndefined();
    vi.advanceTimersByTime(60_000);
    expect(h.delivered).toHaveLength(0);
  });

  it("renderer replaces the default line when it returns a string", () => {
    const h = makeHarness({ render: (sessionID, at) => `【心流唤醒】${sessionID}@${String(at)}` });
    h.sessions.add("sess_a");
    const at = BASE + 5_000;

    h.scheduler.arm("sess_a", at);
    vi.advanceTimersByTime(5_000);

    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]?.line).toBe(`【心流唤醒】sess_a@${String(at)}`);
    expect(existsSync(wakeFile("sess_a"))).toBe(false);
  });

  it("renderer null skips delivery and removes the sidecar (stale flow plan)", () => {
    const h = makeHarness({ render: () => null });
    h.sessions.add("sess_a");

    h.scheduler.arm("sess_a", BASE + 5_000);
    vi.advanceTimersByTime(5_000);

    expect(h.delivered).toHaveLength(0);
    expect(existsSync(wakeFile("sess_a"))).toBe(false);
    expect(h.logs.some((l) => l.msg.includes("stale"))).toBe(true);
  });

  it("renderer throw keeps the sidecar for retry (at-least-once)", () => {
    const h = makeHarness({
      render: () => {
        throw new Error("boom");
      },
    });
    h.sessions.add("sess_a");

    h.scheduler.arm("sess_a", BASE + 5_000);
    vi.advanceTimersByTime(5_000);

    expect(h.delivered).toHaveLength(0);
    expect(existsSync(wakeFile("sess_a"))).toBe(true);
    expect(h.logs.some((l) => l.msg.includes("render failed"))).toBe(true);
  });

  it("never delivers for an unknown session and deletes the sidecar", () => {
    const h = makeHarness();

    h.scheduler.arm("ghost", BASE + 1_000);
    vi.advanceTimersByTime(1_000);

    expect(h.delivered).toHaveLength(0);
    expect(existsSync(wakeFile("ghost"))).toBe(false);
    expect(h.logs.some((l) => l.msg.includes("session not found"))).toBe(true);
  });
});

describe("WakeScheduler restore", () => {
  it("arms a future sidecar", () => {
    const at = BASE + 4_000;
    writeSidecar("sess_a", at);
    const h = makeHarness();
    h.sessions.add("sess_a");

    expect(h.scheduler.restore()).toEqual({ restored: 1, dropped: 0 });
    expect(h.scheduler.pending("sess_a")).toBe(at);

    vi.advanceTimersByTime(4_000);
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]?.line).toBe(formatAutoWakeLine(at));
    expect(existsSync(wakeFile("sess_a"))).toBe(false);
  });

  it("fires a past-due sidecar within 24h immediately after boot", () => {
    const at = BASE - 60_000;
    writeSidecar("sess_a", at);
    const h = makeHarness();
    h.sessions.add("sess_a");

    expect(h.scheduler.restore()).toEqual({ restored: 1, dropped: 0 });

    vi.advanceTimersByTime(1);
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]?.line).toBe(formatAutoWakeLine(at));
    expect(existsSync(wakeFile("sess_a"))).toBe(false);
  });

  it("drops and deletes a sidecar older than 24h", () => {
    writeSidecar("sess_a", BASE - DAY_MS - 1);
    const h = makeHarness();
    h.sessions.add("sess_a");

    expect(h.scheduler.restore()).toEqual({ restored: 0, dropped: 1 });
    expect(existsSync(wakeFile("sess_a"))).toBe(false);

    vi.advanceTimersByTime(60_000);
    expect(h.delivered).toHaveLength(0);
  });

  it("returns zeros for a missing wake directory", () => {
    const h = makeHarness();
    expect(h.scheduler.restore()).toEqual({ restored: 0, dropped: 0 });
  });

  it("drops corrupt JSON, mismatched sessionID and invalid filenames without throwing", () => {
    mkdirSync(wakeDir(), { recursive: true });
    writeFileSync(wakeFile("badjson"), "{not-json", "utf8");
    writeFileSync(wakeFile("mismatch"), JSON.stringify({ sessionID: "other", at: BASE + 1_000 }), "utf8");
    writeFileSync(wakeFile("bad-name"), JSON.stringify({ sessionID: "bad-name", at: BASE + 1_000 }), "utf8");
    writeFileSync(join(wakeDir(), "notes.txt"), "ignored", "utf8");
    const h = makeHarness();

    let result: { restored: number; dropped: number } | undefined;
    expect(() => {
      result = h.scheduler.restore();
    }).not.toThrow();

    expect(result).toEqual({ restored: 0, dropped: 3 });
    expect(existsSync(wakeFile("badjson"))).toBe(false);
    expect(existsSync(wakeFile("mismatch"))).toBe(false);
    expect(existsSync(wakeFile("bad-name"))).toBe(false);
    expect(existsSync(join(wakeDir(), "notes.txt"))).toBe(true);
  });
});
