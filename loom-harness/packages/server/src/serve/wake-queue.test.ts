/**
 * T05a 唤醒队列核心验收。
 *
 * 覆盖：顺序无关 upsert、cancel 幂等、来源对账、归档抑制、旧 sidecar 迁移、
 * 损坏容错、过期剔除、实例锁活/死 pid、watchdog mtime 重载与原子落盘。
 * 全部使用 mkdtemp 临时根与可控时钟，不碰真实状态目录。
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { writeJsonAtomic } from "../plan/atomic-write.js";
import {
  WAKE_QUEUE_RETRY_MS,
  WakeQueue,
  WakeQueueLockedError,
  toWakeEntry,
  type WakeQueueDelivered,
  type WakeQueueEntry,
  type WakeQueueEntryInput,
  type WakeQueueObservation,
  type WakeQueuePaths,
} from "./wake-queue.js";

const NOW = Date.UTC(2026, 9, 28, 4, 0, 0);
const SID = "ses_wake_queue";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

interface Clock {
  now: number;
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "wake-queue-"));
  roots.push(root);
  return root;
}

function makeQueue(root: string, clock: Clock = { now: NOW }): WakeQueue {
  return new WakeQueue({ stateRoot: root, sessionID: SID, now: () => clock.now });
}

function pathsAt(root: string): WakeQueuePaths {
  return makeQueue(root).paths();
}

function entry(overrides: Partial<WakeQueueEntryInput> = {}): WakeQueueEntryInput {
  return { id: "plan-1", source: "plan", at: NOW + 60_000, payload: {}, ...overrides };
}

function storedEntry(overrides: Partial<WakeQueueEntry> = {}): WakeQueueEntry {
  return {
    id: "stored-1",
    source: "plan",
    at: NOW + 60_000,
    payload: {},
    created_at: NOW,
    attempts: 0,
    ...overrides,
  };
}

interface DeliveryCall {
  readonly sessionID: string;
  readonly line: string;
  readonly entry: WakeQueueEntry;
}

interface DeadLetterCall {
  readonly entry: WakeQueueEntry;
  readonly error: unknown;
}

interface Harness {
  readonly queue: WakeQueue;
  readonly deliveries: DeliveryCall[];
  readonly deadLetters: DeadLetterCall[];
  readonly events: WakeQueueObservation[];
}

interface HarnessOptions {
  readonly render?: (entry: WakeQueueEntry) => string | null;
  readonly deliver?: (
    sessionID: string,
    line: string,
    entry: WakeQueueEntry,
  ) => Promise<void> | void;
  readonly hasSession?: (sessionID: string) => boolean;
  readonly maxTimerMs?: number;
}

function makeHarness(root: string, clock: Clock, options: HarnessOptions = {}): Harness {
  const deliveries: DeliveryCall[] = [];
  const deadLetters: DeadLetterCall[] = [];
  const events: WakeQueueObservation[] = [];
  const queue = new WakeQueue({
    stateRoot: root,
    sessionID: SID,
    now: () => clock.now,
    render: options.render ?? ((item) => `wake:${item.id}`),
    deliver: (sessionID, line, item) => {
      deliveries.push({ sessionID, line, entry: item });
      return options.deliver?.(sessionID, line, item);
    },
    ...(options.hasSession === undefined ? {} : { hasSession: options.hasSession }),
    ...(options.maxTimerMs === undefined ? {} : { maxTimerMs: options.maxTimerMs }),
    onDeadLetter: (item, error) => {
      deadLetters.push({ entry: item, error });
    },
    observe: (event) => {
      events.push(event);
    },
  });
  return { queue, deliveries, deadLetters, events };
}

async function advance(clock: Clock, ms: number): Promise<void> {
  clock.now += ms;
  await vi.advanceTimersByTimeAsync(ms);
}

function writeSidecar(
  root: string,
  entries: readonly WakeQueueEntry[],
  delivered: readonly WakeQueueDelivered[] = [],
  legacyMigratedAt?: number,
): void {
  const paths = pathsAt(root);
  mkdirSync(paths.dir, { recursive: true });
  writeJsonAtomic(paths.sidecar, {
    schema: 2,
    session_id: SID,
    entries,
    delivered,
    ...(legacyMigratedAt === undefined ? {} : { legacy_migrated_at: legacyMigratedAt }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) throw new Error(`不是 JSON 对象: ${path}`);
  return parsed;
}

function arrayField(document: Record<string, unknown>, field: string): unknown[] {
  const value = document[field];
  if (!Array.isArray(value)) throw new Error(`${field} 不是数组`);
  return value;
}

function first<T>(items: readonly T[]): T {
  const value = items[0];
  if (value === undefined) throw new Error("期望非空数组");
  return value;
}

/** 同进程内复用 pid；模拟进程重启前先删实例锁，避免把旧实例当作活锁。 */
function simulateProcessRestart(root: string): void {
  const lock = pathsAt(root).instance;
  if (existsSync(lock)) unlinkSync(lock);
}

function reapedPid(): number {
  const result = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  if (typeof result.pid !== "number") throw new Error("无法取得已退出子进程 pid");
  return result.pid;
}

describe("enqueue", () => {
  it("结果与入队顺序无关，且同一 id 只保留一条", async () => {
    const left = makeQueue(tempRoot());
    await left.enqueue(entry({ id: "b", at: NOW + 2_000 }));
    await left.enqueue(entry({ id: "a", at: NOW + 1_000 }));

    const right = makeQueue(tempRoot());
    await right.enqueue(entry({ id: "a", at: NOW + 1_000 }));
    await right.enqueue(entry({ id: "b", at: NOW + 2_000 }));

    const leftSnapshot = await left.snapshot();
    expect(leftSnapshot).toEqual(await right.snapshot());
    expect(leftSnapshot.entries.map((item) => item.id)).toEqual(["a", "b"]);
    expect(await left.pendingCount()).toBe(2);
  });

  it("同 id/at/payload 判 duplicate，内容不同判 updated，键序不影响相等", async () => {
    const queue = makeQueue(tempRoot());
    expect(await queue.enqueue(entry({ payload: { b: 2, a: 1 } }))).toBe("inserted");
    expect(await queue.enqueue(entry({ payload: { a: 1, b: 2 } }))).toBe("duplicate");
    expect(await queue.enqueue(entry({ payload: { a: 2 } }))).toBe("updated");
    expect(await queue.enqueue(entry({ at: NOW + 120_000, payload: { a: 2 } }))).toBe("updated");

    const snapshot = await queue.snapshot();
    expect(snapshot.entries).toHaveLength(1);
    expect(first(snapshot.entries).at).toBe(NOW + 120_000);
  });

  it("delivered 归档中的 id 再入队判 suppressed", async () => {
    const root = tempRoot();
    writeSidecar(root, [], [{ id: "plan-1", at: NOW, delivered_at: NOW + 1 }]);
    const queue = makeQueue(root);

    expect(await queue.restore()).toEqual({ restored: 0, migratedLegacy: false, dropped: 0 });
    expect(await queue.enqueue(entry())).toBe("suppressed");
    expect(await queue.pendingCount()).toBe(0);
  });
});

describe("cancel", () => {
  it("取消已存在条目返回 true，重复取消与未知 id 返回 false", async () => {
    const queue = makeQueue(tempRoot());
    expect(await queue.cancel("missing")).toBe(false);
    await queue.enqueue(entry());
    expect(await queue.cancel("plan-1")).toBe(true);
    expect(await queue.cancel("plan-1")).toBe(false);
    expect(await queue.pendingCount()).toBe(0);
  });

  it("取消后同 id 可再次入队（cancel 不写归档）", async () => {
    const queue = makeQueue(tempRoot());
    await queue.enqueue(entry());
    await queue.cancel("plan-1");
    expect(await queue.enqueue(entry())).toBe("inserted");
  });
});

describe("reconcileSource", () => {
  it("只增删改指定来源，其他来源与归档保持不变", async () => {
    const queue = makeQueue(tempRoot());
    await queue.enqueue(entry({ id: "plan-a", source: "plan", at: NOW + 1_000 }));
    await queue.enqueue(entry({ id: "flow-b", source: "flow", at: NOW + 1_000 }));
    await queue.enqueue(entry({ id: "special-c", source: "special", at: NOW + 1_000 }));

    const firstPass = await queue.reconcileSource("plan", [
      entry({ id: "plan-a", source: "plan", at: NOW + 2_000 }),
      entry({ id: "plan-d", source: "plan", at: NOW + 3_000 }),
    ]);
    expect(firstPass).toEqual({ added: 1, updated: 1, cancelled: 0 });

    const secondPass = await queue.reconcileSource("plan", [
      entry({ id: "plan-d", source: "plan", at: NOW + 3_000 }),
    ]);
    expect(secondPass).toEqual({ added: 0, updated: 0, cancelled: 1 });

    const snapshot = await queue.snapshot();
    expect(snapshot.entries.map((item) => item.id)).toEqual(["flow-b", "special-c", "plan-d"]);
    expect(snapshot.entries.filter((item) => item.source === "flow")).toHaveLength(1);
    expect(snapshot.entries.filter((item) => item.source === "special")).toHaveLength(1);
  });
});

describe("restore", () => {
  it("待办条目跨实例存活，归档 id 仍抑制再入队", async () => {
    const root = tempRoot();
    const clock: Clock = { now: NOW };
    const firstQueue = makeQueue(root, clock);
    await firstQueue.enqueue(entry({ id: "plan-a", at: NOW + 1_000 }));
    await firstQueue.enqueue(entry({ id: "flow-b", source: "flow", at: NOW + 2_000 }));

    simulateProcessRestart(root);
    const secondQueue = makeQueue(root, clock);
    expect(await secondQueue.restore()).toEqual({ restored: 2, migratedLegacy: false, dropped: 0 });
    expect((await secondQueue.snapshot()).entries.map((item) => item.id)).toEqual([
      "plan-a",
      "flow-b",
    ]);

    const deliveredRoot = tempRoot();
    writeSidecar(deliveredRoot, [], [{ id: "plan-a", at: NOW, delivered_at: NOW }]);
    const deliveredQueue = makeQueue(deliveredRoot);
    await deliveredQueue.restore();
    expect(await deliveredQueue.enqueue(entry({ id: "plan-a" }))).toBe("suppressed");
  });

  it("旧 wake/{sid}.json 只迁移一次、先落队列再改名，二次恢复不重复", async () => {
    const root = tempRoot();
    const paths = pathsAt(root);
    mkdirSync(dirname(paths.legacy), { recursive: true });
    writeFileSync(paths.legacy, `${JSON.stringify({ sessionID: SID, at: NOW + 60_000 })}\n`, "utf8");

    const clock: Clock = { now: NOW };
    const queue = makeQueue(root, clock);
    expect(await queue.restore()).toEqual({ restored: 1, migratedLegacy: true, dropped: 0 });

    const migrated = first((await queue.snapshot()).entries);
    expect(migrated).toMatchObject({
      id: "legacy-auto-wake",
      source: "special",
      action: "special.continue",
      at: NOW + 60_000,
    });
    expect(existsSync(paths.legacy)).toBe(false);
    const renamed = readdirSync(dirname(paths.legacy)).filter((name) =>
      name.startsWith(`${SID}.json.legacy-`),
    );
    expect(renamed).toHaveLength(1);
    expect(typeof readJson(paths.sidecar)["legacy_migrated_at"]).toBe("number");

    simulateProcessRestart(root);
    const again = makeQueue(root, clock);
    expect(await again.restore()).toEqual({ restored: 1, migratedLegacy: false, dropped: 0 });
    expect((await again.snapshot()).entries).toHaveLength(1);
  });

  it("损坏 sidecar 不抛错，后续写入自愈", async () => {
    const root = tempRoot();
    const paths = pathsAt(root);
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.sidecar, "{ this is not json", "utf8");

    const queue = makeQueue(root);
    expect(await queue.restore()).toEqual({ restored: 0, migratedLegacy: false, dropped: 0 });
    expect(await queue.enqueue(entry())).toBe("inserted");

    const document = readJson(paths.sidecar);
    expect(document["schema"]).toBe(2);
    expect(document["session_id"]).toBe(SID);
    expect(arrayField(document, "entries")).toHaveLength(1);
  });

  it("过期条目按来源窗口与 expires_at 剔除并回写", async () => {
    const root = tempRoot();
    writeSidecar(root, [
      storedEntry({ id: "old-plan", source: "plan", at: NOW - 49 * HOUR }),
      storedEntry({ id: "old-flow", source: "flow", at: NOW - 31 * DAY }),
      storedEntry({ id: "expired-special", source: "special", at: NOW + 1_000, expires_at: NOW }),
      storedEntry({ id: "recent-special", source: "special", at: NOW - 1 * HOUR }),
    ]);

    const queue = makeQueue(root);
    expect(await queue.restore()).toEqual({ restored: 1, migratedLegacy: false, dropped: 3 });
    expect((await queue.snapshot()).entries.map((item) => item.id)).toEqual(["recent-special"]);
    expect(arrayField(readJson(pathsAt(root).sidecar), "entries")).toHaveLength(1);
  });
});

describe("实例锁", () => {
  it("活 pid 拒绝获取并抛 WakeQueueLockedError", async () => {
    const root = tempRoot();
    const paths = pathsAt(root);
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(
      paths.instance,
      `${JSON.stringify({ pid: process.pid, started_at: NOW })}\n`,
      "utf8",
    );

    const queue = makeQueue(root);
    await expect(queue.restore()).rejects.toBeInstanceOf(WakeQueueLockedError);
  });

  it("死 pid 可接管，锁文件改写成当前进程", async () => {
    const root = tempRoot();
    const paths = pathsAt(root);
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(
      paths.instance,
      `${JSON.stringify({ pid: reapedPid(), started_at: NOW })}\n`,
      "utf8",
    );

    const queue = makeQueue(root);
    await queue.acquireInstanceLock();
    expect(readJson(paths.instance)["pid"]).toBe(process.pid);
    expect(await queue.restore()).toEqual({ restored: 0, migratedLegacy: false, dropped: 0 });
  });
});

describe("watchdogTick 与落盘", () => {
  it("mtime 变化时重读 sidecar，未变化时返回 false", async () => {
    const root = tempRoot();
    const queue = makeQueue(root);
    await queue.restore();
    expect(await queue.watchdogTick()).toBe(false);

    const paths = pathsAt(root);
    writeJsonAtomic(paths.sidecar, {
      schema: 2,
      session_id: SID,
      entries: [storedEntry({ id: "external", at: NOW + 5_000 })],
      delivered: [],
    });

    expect(await queue.watchdogTick()).toBe(true);
    expect((await queue.snapshot()).entries.map((item) => item.id)).toEqual(["external"]);
    expect(await queue.watchdogTick()).toBe(false);
  });

  it("并发写入串行化，sidecar 始终可解析且无临时文件残留", async () => {
    const root = tempRoot();
    const paths = pathsAt(root);
    const queue = makeQueue(root);

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        queue.enqueue(entry({ id: `plan-${String(index)}`, at: NOW + index })),
      ),
    );

    const document = readJson(paths.sidecar);
    expect(document["schema"]).toBe(2);
    expect(arrayField(document, "entries")).toHaveLength(8);
    expect(await queue.pendingCount()).toBe(8);
    expect(readdirSync(paths.dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("toWakeEntry 复用现有渲染面：payload.title 与 instruction 正确投影", async () => {
    const queue = makeQueue(tempRoot());
    await queue.enqueue(
      entry({ id: "render", payload: { title: "晨间计划" }, instruction: "按计划执行" }),
    );

    const projected = toWakeEntry(first((await queue.snapshot()).entries));
    expect(projected).toMatchObject({
      id: "render",
      title: "晨间计划",
      source: "master",
      at: NOW + 60_000,
      instructions: "按计划执行",
    });
  });
});

describe("T05b 定时投递", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("单会话单定时器始终指向最早条目", async () => {
    const clock: Clock = { now: NOW };
    const harness = makeHarness(tempRoot(), clock);
    await harness.queue.enqueue(entry({ id: "later", at: NOW + 10_000 }));
    await harness.queue.enqueue(entry({ id: "earliest", at: NOW + 4_000 }));

    await advance(clock, 3_999);
    expect(harness.deliveries).toHaveLength(0);
    expect(await harness.queue.pendingCount()).toBe(2);

    await advance(clock, 1);
    expect(harness.deliveries.map((call) => call.entry.id)).toEqual(["earliest"]);
    expect(harness.deliveries[0]?.line).toBe("wake:earliest");
    expect(await harness.queue.pendingCount()).toBe(1);
    expect(harness.events.some((event) => event.kind === "wake.armed")).toBe(true);
    expect(harness.events.some((event) => event.kind === "wake.delivered")).toBe(true);

    await advance(clock, 6_000);
    expect(harness.deliveries.map((call) => call.entry.id)).toEqual(["earliest", "later"]);
    expect(await harness.queue.pendingCount()).toBe(0);
  });

  it("maxTimerMs 分块续排，长延时仍只投递一次", async () => {
    const clock: Clock = { now: NOW };
    const harness = makeHarness(tempRoot(), clock, { maxTimerMs: 60_000 });
    await harness.queue.enqueue(entry({ id: "far-plan", at: NOW + 90_000 }));

    await advance(clock, 60_000);
    expect(harness.deliveries).toHaveLength(0);
    expect(harness.events.filter((event) => event.kind === "wake.armed")).toHaveLength(2);

    await advance(clock, 30_000);
    expect(harness.deliveries.map((call) => call.entry.id)).toEqual(["far-plan"]);
    await advance(clock, 60_000);
    expect(harness.deliveries).toHaveLength(1);
  });

  it("plan/flow/special 共存时只投递到期条目", async () => {
    const clock: Clock = { now: NOW };
    const harness = makeHarness(tempRoot(), clock);
    await harness.queue.enqueue(entry({ id: "plan-a", source: "plan", at: NOW + 1_000 }));
    await harness.queue.enqueue(entry({ id: "flow-b", source: "flow", at: NOW + 2_000 }));
    await harness.queue.enqueue(entry({ id: "special-c", source: "special", at: NOW + 3_000 }));

    await advance(clock, 1_000);
    expect(harness.deliveries.map((call) => call.entry.id)).toEqual(["plan-a"]);
    const snapshot = await harness.queue.snapshot();
    expect(snapshot.entries.map((item) => item.id)).toEqual(["flow-b", "special-c"]);
    expect(snapshot.delivered.map((record) => record.id)).toEqual(["plan-a"]);
  });

  it("render 返回 null 归档 stale 且不投递", async () => {
    const clock: Clock = { now: NOW };
    const harness = makeHarness(tempRoot(), clock, { render: () => null });
    await harness.queue.enqueue(entry({ id: "stale-plan", at: NOW + 1_000 }));

    await advance(clock, 1_000);
    expect(harness.deliveries).toHaveLength(0);
    const snapshot = await harness.queue.snapshot();
    expect(snapshot.entries).toHaveLength(0);
    expect(snapshot.delivered).toHaveLength(1);
    expect(first(snapshot.delivered)).toMatchObject({ id: "stale-plan", outcome: "stale" });
    expect(harness.events.some((event) => event.kind === "wake.stale")).toBe(true);
  });

  it("deliver 抛错只重试一次，第二次失败归档 failed 并记死信", async () => {
    const clock: Clock = { now: NOW };
    const errors: Error[] = [];
    const harness = makeHarness(tempRoot(), clock, {
      deliver: () => {
        const error = new Error("boom");
        errors.push(error);
        throw error;
      },
    });
    await harness.queue.enqueue(entry({ id: "retry-plan", at: NOW + 1_000 }));

    await advance(clock, 1_000);
    expect(harness.deliveries).toHaveLength(1);
    let snapshot = await harness.queue.snapshot();
    expect(snapshot.delivered).toHaveLength(0);
    expect(snapshot.entries).toHaveLength(1);
    expect(first(snapshot.entries)).toMatchObject({
      attempts: 1,
      at: NOW + 1_000 + WAKE_QUEUE_RETRY_MS,
    });
    expect(harness.deadLetters).toHaveLength(0);

    await advance(clock, WAKE_QUEUE_RETRY_MS);
    expect(harness.deliveries).toHaveLength(2);
    snapshot = await harness.queue.snapshot();
    expect(snapshot.entries).toHaveLength(0);
    expect(snapshot.delivered).toHaveLength(1);
    expect(first(snapshot.delivered)).toMatchObject({
      id: "retry-plan",
      outcome: "failed",
      attempts: 2,
      error: "boom",
    });
    expect(harness.deadLetters).toHaveLength(1);
    expect(errors).toHaveLength(2);
    expect(harness.deadLetters[0]?.error).toBe(errors[1]);
    expect(harness.events.some((event) => event.kind === "wake.failed")).toBe(true);

    await advance(clock, 10 * 60_000);
    expect(harness.deliveries).toHaveLength(2);
  });

  it("投递成功后归档，重启与对账都不重复投递", async () => {
    const root = tempRoot();
    const clock: Clock = { now: NOW };
    const harness = makeHarness(root, clock);
    await harness.queue.enqueue(entry({ id: "done-plan", at: NOW + 1_000 }));

    await advance(clock, 1_000);
    expect(harness.deliveries).toHaveLength(1);
    harness.queue.dispose();

    simulateProcessRestart(root);
    const restarted = makeHarness(root, clock);
    expect(await restarted.queue.restore()).toMatchObject({ restored: 0 });
    expect(await restarted.queue.enqueue(entry({ id: "done-plan", at: NOW + 1_000 }))).toBe(
      "suppressed",
    );
    expect(
      await restarted.queue.reconcileSource("plan", [entry({ id: "done-plan", at: NOW + 1_000 })]),
    ).toEqual({ added: 0, updated: 0, cancelled: 0 });

    await advance(clock, 5_000);
    expect(restarted.deliveries).toHaveLength(0);
  });

  it("dispose 后到点也不投递", async () => {
    const clock: Clock = { now: NOW };
    const harness = makeHarness(tempRoot(), clock);
    await harness.queue.enqueue(entry({ id: "disposed-plan", at: NOW + 1_000 }));

    harness.queue.dispose();
    await advance(clock, 1_000);
    expect(harness.deliveries).toHaveLength(0);
    expect(await harness.queue.pendingCount()).toBe(1);
  });

  it("watchdogTick 在投递占用期间为剩余待办重新武装定时器", async () => {
    const clock: Clock = { now: NOW };
    let release: (() => void) | undefined;
    const blocker = new Promise<void>((resolve) => {
      release = () => {
        resolve();
      };
    });
    const harness = makeHarness(tempRoot(), clock, { deliver: () => blocker });
    await harness.queue.enqueue(entry({ id: "first", at: NOW + 1_000 }));
    await harness.queue.enqueue(entry({ id: "second", at: NOW + 2_000 }));

    await advance(clock, 1_000);
    expect(harness.deliveries.map((call) => call.entry.id)).toEqual(["first"]);
    expect(await harness.queue.pendingCount()).toBe(1);

    expect(await harness.queue.watchdogTick()).toBe(true);
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    await advance(clock, 1_000);
    expect(harness.deliveries.map((call) => call.entry.id)).toEqual(["first", "second"]);
  });

  it("hasSession 为 false 时不投递并归档 stale", async () => {
    const clock: Clock = { now: NOW };
    const harness = makeHarness(tempRoot(), clock, { hasSession: () => false });
    await harness.queue.enqueue(entry({ id: "orphan-plan", at: NOW + 1_000 }));

    await advance(clock, 1_000);
    expect(harness.deliveries).toHaveLength(0);
    const snapshot = await harness.queue.snapshot();
    expect(snapshot.entries).toHaveLength(0);
    expect(first(snapshot.delivered)).toMatchObject({ id: "orphan-plan", outcome: "stale" });
  });

  it("restore 对已过期待办按 now 立即投递一次", async () => {
    const root = tempRoot();
    const clock: Clock = { now: NOW };
    writeSidecar(root, [storedEntry({ id: "past-due", at: NOW - 5_000 })]);
    const harness = makeHarness(root, clock);

    expect(await harness.queue.restore()).toMatchObject({ restored: 1 });
    expect(harness.deliveries).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.deliveries.map((call) => call.entry.id)).toEqual(["past-due"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.deliveries).toHaveLength(1);
  });

  it("observe 回调抛错不影响投递", async () => {
    const clock: Clock = { now: NOW };
    const delivered: string[] = [];
    const queue = new WakeQueue({
      stateRoot: tempRoot(),
      sessionID: SID,
      now: () => clock.now,
      render: (item) => `wake:${item.id}`,
      deliver: (_sessionID, _line, item) => {
        delivered.push(item.id);
      },
      observe: () => {
        throw new Error("observe boom");
      },
    });
    await queue.enqueue(entry({ id: "observed", at: NOW + 1_000 }));

    await advance(clock, 1_000);
    expect(delivered).toEqual(["observed"]);
  });
});
