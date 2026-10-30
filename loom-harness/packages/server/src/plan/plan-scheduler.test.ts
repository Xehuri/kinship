/**
 * PlanScheduler 验收：48h 视界、8/24h 三档、覆盖合并、单日唯一
 * plan.build/review、昨日遗留挂载、last-good 回退、覆盖层缺失/孤儿、
 * 重复对账幂等、shadow 不落队列、主时区边界与锚点/看门狗定时器。
 *
 * 全部使用临时根与可控时钟，不碰生产 ai/data。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { JsonMasterPlanStore } from "./json-master-plan-store.js";
import { JsonPlanOverlayStore } from "./json-plan-overlay-store.js";
import { JsonPlanStore } from "./json-plan-store.js";
import { PlanOverlayNotFoundError, type PlanOverlayDocument, type PlanOverlayOp } from "./plan-overlay.js";
import type { MasterEntry, MasterPlanDocument } from "./master-plan.js";
import {
  PlanScheduler,
  type PlanSchedulerObservation,
  type PlanSchedulerOverlayStore,
  type PlanSchedulerQueue,
  type PlanSchedulerLedgerRow,
} from "./plan-scheduler.js";
import type { PlanCoverage } from "./plan-store.js";
import { WakeQueue, type WakeQueueEntryInput, type WakeQueueReconcileResult } from "../serve/wake-queue.js";

const HOUR = 60 * 60 * 1000;
const TZ = "Asia/Shanghai";
const TODAY = "2026-10-28";
const YESTERDAY = "2026-10-27";
const NOW = Date.UTC(2026, 9, 27, 20, 0, 0); // 2026-10-28 04:00 +08
const COVERAGE: PlanCoverage = { profile: "merged_7", checkpoints: ["cov-06"], debt: [] };
const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "plan-scheduler-"));
  roots.push(root);
  return root;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function payloadOf(entry: WakeQueueEntryInput | undefined): Record<string, unknown> {
  const payload = entry?.payload;
  if (!isRecord(payload)) throw new Error(`payload 不是对象: ${String(payload)}`);
  return payload;
}

function entry(overrides: Partial<MasterEntry> = {}): MasterEntry {
  return {
    id: "daily-check",
    kind: "fixed",
    title: "每日检查",
    enabled: true,
    action: "probe.run",
    schedule: { kind: "daily", at: "06:00" },
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function master(
  entries: readonly MasterEntry[],
  options: { readonly timezone?: string; readonly version?: number } = {},
): MasterPlanDocument {
  return {
    schema: 1,
    kind: "master-plan",
    timezone: options.timezone ?? TZ,
    version: options.version ?? 1,
    created_at: NOW,
    updated_at: NOW,
    entries,
  };
}

function absentOverlay(): PlanSchedulerOverlayStore {
  return {
    async read(date: string): Promise<PlanOverlayDocument> {
      throw new PlanOverlayNotFoundError(date, `missing ${date}`);
    },
  };
}

function overlayDocument(date: string, ops: readonly PlanOverlayOp[]): PlanOverlayDocument {
  return {
    schema: 1,
    kind: "plan-overlay",
    date,
    base_version: 1,
    version: 2,
    status: "committed",
    created_at: NOW,
    updated_at: NOW,
    ops,
    notes: [],
    coverage: COVERAGE,
  };
}

interface QueueCall {
  readonly source: "plan";
  readonly entries: readonly WakeQueueEntryInput[];
}

interface FakeQueue {
  readonly queue: PlanSchedulerQueue;
  readonly calls: QueueCall[];
}

/** 按 id/at/payload 去重的假队列，模拟 WakeQueue.reconcileSource 的幂等语义。 */
function fakeQueue(): FakeQueue {
  const calls: QueueCall[] = [];
  const state = new Map<string, string>();
  const queue: PlanSchedulerQueue = {
    async reconcileSource(source, entries): Promise<WakeQueueReconcileResult> {
      calls.push({ source, entries });
      let added = 0;
      let updated = 0;
      const keep = new Set<string>();
      for (const row of entries) {
        keep.add(row.id);
        const signature = JSON.stringify({ at: row.at, payload: row.payload });
        const previous = state.get(row.id);
        if (previous === undefined) {
          state.set(row.id, signature);
          added += 1;
        } else if (previous !== signature) {
          state.set(row.id, signature);
          updated += 1;
        }
      }
      let cancelled = 0;
      for (const id of [...state.keys()]) {
        if (!keep.has(id)) {
          state.delete(id);
          cancelled += 1;
        }
      }
      return { added, updated, cancelled };
    },
  };
  return { queue, calls };
}

function idsOf(entries: readonly WakeQueueEntryInput[]): string[] {
  return entries.map((row) => row.id);
}

function schedulerAt(
  now: number,
  options: {
    readonly masterDoc?: MasterPlanDocument;
    readonly masterStore?: { read(): Promise<MasterPlanDocument>; readLastGood?(): Promise<MasterPlanDocument> };
    readonly overlay?: PlanSchedulerOverlayStore;
    readonly queue?: PlanSchedulerQueue;
    readonly observe?: (event: PlanSchedulerObservation) => void;
    readonly stateRoot?: string;
    readonly shadow?: boolean;
    readonly timezone?: string;
    readonly ledger?: (row: PlanSchedulerLedgerRow) => void | Promise<void>;
  } = {},
): PlanScheduler {
  const masterStore =
    options.masterStore ??
    ({
      read: async () => {
        const doc = options.masterDoc;
        if (doc === undefined) throw new Error("missing master fixture");
        return doc;
      },
    } satisfies { read(): Promise<MasterPlanDocument> });
  return new PlanScheduler({
    masterStore,
    overlayStore: options.overlay ?? absentOverlay(),
    ...(options.queue === undefined ? {} : { queue: options.queue }),
    mainSessionId: "ses_main",
    timezone: options.timezone ?? TZ,
    now: () => now,
    ...(options.observe === undefined ? {} : { observe: options.observe }),
    ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
    ...(options.shadow === undefined ? {} : { shadow: options.shadow }),
    ...(options.ledger === undefined ? {} : { ledger: options.ledger }),
    watchdogMs: 0,
  });
}

describe("PlanScheduler 对账", () => {
  it("48h 视界包含次日 00:00/00:40，越过视界的 once 被跳过", async () => {
    const doc = master([
      entry({ id: "night-wrap", action: "review.daily", schedule: { kind: "daily", at: "00:00" } }),
      entry({ id: "night-review", action: "review.daily", schedule: { kind: "daily", at: "00:40" } }),
      entry({
        id: "too-far",
        action: "probe.run",
        schedule: { kind: "once", date: "2026-10-30", at: "05:00" },
      }),
    ]);
    const { queue, calls } = fakeQueue();
    const result = await schedulerAt(NOW, { masterDoc: doc, queue }).reconcile({ reason: "manual" });

    expect(result.status).toBe("reconciled");
    const ids = idsOf(result.entries);
    expect(ids).toContain("plan:2026-10-29:night-wrap");
    expect(ids).toContain("plan:2026-10-29:night-review");
    expect(ids).not.toContain("plan:2026-10-30:too-far");
    expect(result.skipped.horizon).toBe(1);
    expect(result.entries.find((row) => row.id === "plan:2026-10-29:night-wrap")?.at).toBe(
      Date.UTC(2026, 9, 28, 16, 0, 0),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.source).toBe("plan");
    expect(calls[0]?.entries).toHaveLength(result.entries.length);
  });

  it("超过 8h 的覆盖检查点合并成一个 catch-up 条目", async () => {
    const now = Date.UTC(2026, 9, 28, 2, 0, 0); // 10:00 +08
    const doc = master([
      entry({
        id: "cov-a",
        kind: "anchor",
        action: "coverage.run",
        target_date: "previous_day",
        window: "22:00~00:00",
        schedule: { kind: "once", date: TODAY, at: "00:00" },
      }),
      entry({
        id: "cov-b",
        kind: "anchor",
        action: "coverage.run",
        window: "00:00~02:00",
        schedule: { kind: "once", date: TODAY, at: "01:00" },
      }),
    ]);
    const { queue } = fakeQueue();
    const scheduler = schedulerAt(now, { masterDoc: doc, queue });
    const result = await scheduler.reconcile({ reason: "boot" });
    const again = await scheduler.reconcile({ reason: "boot" });

    expect(result.entries).toHaveLength(1);
    expect(again.entries.map((row) => row.id)).toEqual(result.entries.map((row) => row.id));
    expect(again.queue?.added).toBe(0);
    const catchup = result.entries[0];
    expect(catchup?.id).toBe(`plan:${TODAY}:catchup:0100`);
    expect(catchup?.action).toBe("coverage.run");
    expect(catchup?.at).toBe(Date.UTC(2026, 9, 27, 17, 0, 0));
    const payload = payloadOf(catchup);
    expect(payload["late"]).toBe(true);
    expect(payload["slots"]).toMatchObject([
      { entry_id: "cov-a", at: "00:00", window: "22:00~00:00" },
      { entry_id: "cov-b", at: "01:00", window: "00:00~02:00" },
    ]);
    expect(catchup?.instruction).toContain("cov-a");
  });

  it("8-24h 的非覆盖条目各自迟到入队并带 late=true", async () => {
    const now = Date.UTC(2026, 9, 28, 2, 0, 0);
    const doc = master([
      entry({ id: "late-a", schedule: { kind: "once", date: TODAY, at: "00:00" } }),
      entry({ id: "late-b", schedule: { kind: "once", date: TODAY, at: "01:00" } }),
    ]);
    const { queue } = fakeQueue();
    const result = await schedulerAt(now, { masterDoc: doc, queue }).reconcile({ reason: "boot" });

    expect(result.entries).toHaveLength(2);
    for (const row of result.entries) {
      expect(row.at).toBe(now + 60_000);
      expect(payloadOf(row)["late"]).toBe(true);
    }
    expect(idsOf(result.entries)).toEqual([
      `plan:${TODAY}:late-a`,
      `plan:${TODAY}:late-b`,
    ]);
  });

  it("超过 24h 的检查点只记 skipped_debt，绝不入队或标完成", async () => {
    const now = Date.UTC(2026, 9, 28, 2, 0, 0);
    const root = tempRoot();
    const doc = master([
      entry({
        id: "stale-cov",
        kind: "anchor",
        action: "coverage.run",
        schedule: { kind: "once", date: YESTERDAY, at: "00:00" },
      }),
      entry({
        id: "old-care",
        schedule: { kind: "once", date: YESTERDAY, at: "06:00" },
      }),
    ]);
    const { queue } = fakeQueue();
    const observations: PlanSchedulerObservation[] = [];
    const result = await schedulerAt(now, {
      masterDoc: doc,
      queue,
      stateRoot: root,
      observe: (event) => observations.push(event),
    }).reconcile({ reason: "boot" });

    expect(result.entries).toHaveLength(0);
    expect(result.skipped.debt).toBe(1);
    expect(observations).toContainEqual({
      kind: "skipped_debt",
      date: YESTERDAY,
      entry_id: "stale-cov",
      at: "00:00",
    });
    const ledger = readFileSync(join(root, "plan", "scheduler.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as unknown);
    expect(ledger).toContainEqual(
      expect.objectContaining({ event: "skipped_debt", entry_id: "stale-cov" }),
    );
    expect(idsOf(result.entries)).not.toContain(`plan:${YESTERDAY}:old-care`);
  });

  it("plan.build / plan.review 每个日期只保留一个", async () => {
    const doc = master([
      entry({ id: "build-a", action: "plan.build", schedule: { kind: "daily", at: "05:00" } }),
      entry({ id: "build-b", action: "plan.build", schedule: { kind: "daily", at: "05:30" } }),
      entry({ id: "review-a", action: "plan.review", schedule: { kind: "daily", at: "07:30" } }),
      entry({ id: "review-b", action: "plan.review", schedule: { kind: "daily", at: "08:00" } }),
    ]);
    const { queue } = fakeQueue();
    const result = await schedulerAt(NOW, { masterDoc: doc, queue }).reconcile({ reason: "manual" });
    const ids = idsOf(result.entries);

    for (const date of [TODAY, "2026-10-29"]) {
      expect(ids.filter((id) => id === `plan:${date}:build`)).toHaveLength(1);
      expect(ids.filter((id) => id === `plan:${date}:review`)).toHaveLength(1);
    }
    expect(result.skipped.duplicate).toBeGreaterThanOrEqual(2);
  });

  it("真实 Json 母版/覆盖层 store：update 覆盖 at 后进入队列", async () => {
    const root = tempRoot();
    const masterStore = new JsonMasterPlanStore({ planRoot: root, now: () => NOW });
    await masterStore.write(master([entry({ id: "keep", schedule: { kind: "daily", at: "06:00" } })]), null);
    const overlayStore = new JsonPlanOverlayStore({
      planRoot: root,
      master: masterStore,
      now: () => NOW,
    });
    await overlayStore.write({
      date: TODAY,
      base_version: 1,
      ops: [{ op: "update", id: "keep", patch: { at: "06:30" } }],
      coverage: COVERAGE,
    });
    await overlayStore.commit(TODAY, 1);

    const queue = new WakeQueue({ stateRoot: tempRoot(), sessionID: "ses_main", now: () => NOW });
    const result = await schedulerAt(NOW, { masterStore, overlay: overlayStore, queue }).reconcile({
      reason: "manual",
    });
    const keep = result.entries.find((row) => row.id === `plan:${TODAY}:keep`);
    expect(keep?.at).toBe(Date.UTC(2026, 9, 27, 22, 30, 0));
    const snapshot = await queue.snapshot();
    expect(snapshot.entries.map((row) => row.id)).toContain(`plan:${TODAY}:keep`);
  });

  it("昨日只有 legacy 计划时也能读出遗留项", async () => {
    const root = tempRoot();
    const legacy = new JsonPlanStore({ planRoot: root, now: () => NOW });
    await legacy.write({
      date: YESTERDAY,
      items: [
        { id: "legacy-care", kind: "care", intent: "昨日遗留", status: "planned" },
      ],
      coverage: COVERAGE,
    });
    const masterStore = { read: async () => master([
      entry({
        id: "plan-build",
        action: "plan.build",
        schedule: { kind: "once", date: TODAY, at: "05:00" },
      }),
    ]) };
    const overlayStore = new JsonPlanOverlayStore({
      planRoot: root,
      master: masterStore,
      now: () => NOW,
    });
    const now = Date.UTC(2026, 9, 27, 22, 0, 0); // 06:00 +08
    const { queue } = fakeQueue();
    const result = await schedulerAt(now, { masterStore, overlay: overlayStore, queue }).reconcile({
      reason: "anchor-0500",
    });

    const build = result.entries.find((row) => row.id === `plan:${TODAY}:build`);
    expect(build).toBeDefined();
    expect(payloadOf(build)["leftovers"]).toMatchObject([
      { id: "legacy-care", status: "planned" },
    ]);
  });

  it("昨日未完成项挂到今日 plan.build payload，不单独入队", async () => {
    const now = Date.UTC(2026, 9, 27, 22, 0, 0); // 06:00 +08
    const doc = master([
      entry({
        id: "plan-build",
        action: "plan.build",
        schedule: { kind: "once", date: TODAY, at: "05:00" },
      }),
    ]);
    const yesterdayOps: readonly PlanOverlayOp[] = [
      {
        op: "add",
        item: { id: "leftover-care", kind: "care", intent: "昨日遗留", status: "planned", at: "09:00" },
      },
      {
        op: "add",
        item: { id: "carried-care", kind: "care", intent: "昨日结转", status: "carried", at: "10:00" },
      },
      {
        op: "add",
        item: { id: "done-care", kind: "care", intent: "昨日完成", status: "done", at: "11:00" },
      },
    ];
    const overlay: PlanSchedulerOverlayStore = {
      async read(date: string): Promise<PlanOverlayDocument> {
        if (date !== YESTERDAY) throw new PlanOverlayNotFoundError(date, `missing ${date}`);
        return overlayDocument(YESTERDAY, yesterdayOps);
      },
    };
    const { queue } = fakeQueue();
    const result = await schedulerAt(now, { masterDoc: doc, overlay, queue }).reconcile({
      reason: "anchor-0500",
    });

    const build = result.entries.find((row) => row.id === `plan:${TODAY}:build`);
    expect(build).toBeDefined();
    expect(build?.at).toBe(Date.UTC(2026, 9, 27, 21, 0, 0));
    expect(payloadOf(build)["leftovers"]).toMatchObject([
      { id: "leftover-care", status: "planned" },
      { id: "carried-care", status: "carried" },
    ]);
    expect(idsOf(result.entries)).not.toContain(`plan:${YESTERDAY}:leftover-care`);
  });
});

describe("PlanScheduler 容错与模式", () => {
  it("主会话缺失时 deferred_no_session，不触碰队列", async () => {
    const doc = master([entry({ id: "keep", schedule: { kind: "daily", at: "06:00" } })]);
    const { queue, calls } = fakeQueue();
    const observations: PlanSchedulerObservation[] = [];
    const scheduler = new PlanScheduler({
      masterStore: { read: async () => doc },
      overlayStore: absentOverlay(),
      queue,
      mainSession: () => null,
      timezone: TZ,
      now: () => NOW,
      observe: (event) => observations.push(event),
      watchdogMs: 0,
    });

    const result = await scheduler.reconcile({ reason: "boot" });

    expect(result.status).toBe("deferred_no_session");
    expect(result.entries).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(observations).toContainEqual({ kind: "deferred_no_session", reason: "boot" });
  });

  it("母版损坏时回退 last-good；两者都不可用则降级且不动队列", async () => {
    const doc = master([entry({ id: "keep", schedule: { kind: "daily", at: "06:00" } })]);
    const { queue, calls } = fakeQueue();
    const observations: PlanSchedulerObservation[] = [];
    const recovered = await schedulerAt(NOW, {
      masterStore: {
        read: async () => {
          throw new Error("master corrupt");
        },
        readLastGood: async () => doc,
      },
      queue,
      observe: (event) => observations.push(event),
    }).reconcile({ reason: "boot" });

    expect(recovered.status).toBe("reconciled");
    expect(idsOf(recovered.entries)).toContain(`plan:${TODAY}:keep`);
    expect(observations).toContainEqual(
      expect.objectContaining({ kind: "master_fallback" }),
    );

    const degraded = await schedulerAt(NOW, {
      masterStore: {
        read: async () => {
          throw new Error("master corrupt");
        },
        readLastGood: async () => {
          throw new Error("last-good missing");
        },
      },
      queue,
      observe: (event) => observations.push(event),
    }).reconcile({ reason: "watchdog" });

    expect(degraded.status).toBe("degraded");
    expect(degraded.entries).toHaveLength(0);
    expect(degraded.queue).toBeNull();
    expect(calls).toHaveLength(1);
    expect(observations).toContainEqual(
      expect.objectContaining({ kind: "master_error" }),
    );
  });

  it("覆盖层缺失时母版照常运行", async () => {
    const doc = master([entry({ id: "keep", schedule: { kind: "daily", at: "06:00" } })]);
    const { queue } = fakeQueue();
    const observations: PlanSchedulerObservation[] = [];
    const result = await schedulerAt(NOW, {
      masterDoc: doc,
      queue,
      observe: (event) => observations.push(event),
    }).reconcile({ reason: "boot" });

    expect(result.status).toBe("reconciled");
    expect(idsOf(result.entries)).toContain(`plan:${TODAY}:keep`);
    expect(observations.some((event) => event.kind === "overlay_error")).toBe(false);
  });

  it("母版漂移后的孤儿 op 只告警，不阻塞当日条目", async () => {
    const doc = master(
      [entry({ id: "keep", schedule: { kind: "daily", at: "06:00" } })],
      { version: 2 },
    );
    const overlay: PlanOverlayDocument = {
      schema: 1,
      kind: "plan-overlay",
      date: TODAY,
      base_version: 1,
      version: 2,
      status: "committed",
      created_at: NOW,
      updated_at: NOW,
      ops: [{ op: "update", id: "orphan-x", patch: { at: "07:00" } }],
      notes: [],
      coverage: COVERAGE,
    };
    const store: PlanSchedulerOverlayStore = {
      async read(date: string): Promise<PlanOverlayDocument> {
        if (date !== TODAY) throw new PlanOverlayNotFoundError(date, `missing ${date}`);
        return overlay;
      },
    };
    const observations: PlanSchedulerObservation[] = [];
    const { queue } = fakeQueue();
    const result = await schedulerAt(NOW, {
      masterDoc: doc,
      overlay: store,
      queue,
      observe: (event) => observations.push(event),
    }).reconcile({ reason: "manual" });

    expect(result.warnings).toContain(`${TODAY}:orphan_update:orphan-x`);
    expect(observations).toContainEqual(
      expect.objectContaining({ kind: "overlay_warning", warning: "orphan_update:orphan-x" }),
    );
    expect(idsOf(result.entries)).toContain(`plan:${TODAY}:keep`);
  });

  it("同一分钟重复对账得到相同 id，队列去重为 0 新增", async () => {
    const doc = master([entry({ id: "keep", schedule: { kind: "daily", at: "06:00" } })]);
    const { queue } = fakeQueue();
    const scheduler = schedulerAt(NOW, { masterDoc: doc, queue });

    const first = await scheduler.reconcile({ reason: "watchdog" });
    const second = await scheduler.reconcile({ reason: "watchdog" });

    expect(idsOf(second.entries)).toEqual(idsOf(first.entries));
    expect(second.entries).toEqual(first.entries);
    expect(first.queue?.added).toBe(first.entries.length);
    expect(second.queue?.added).toBe(0);
    expect(second.queue?.updated).toBe(0);
    expect(second.queue?.cancelled).toBe(0);
  });

  it("shadow 模式只写 shadow/jsonl，不调用队列", async () => {
    const root = tempRoot();
    const doc = master([entry({ id: "keep", schedule: { kind: "daily", at: "06:00" } })]);
    const { queue, calls } = fakeQueue();
    const result = await schedulerAt(NOW, {
      masterDoc: doc,
      queue,
      shadow: true,
      stateRoot: root,
    }).reconcile({ reason: "manual" });

    expect(result.status).toBe("shadow");
    expect(calls).toHaveLength(0);
    const path = join(root, "plan", "shadow", `${TODAY}.jsonl`);
    expect(existsSync(path)).toBe(true);
    const rows = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as WakeQueueEntryInput);
    expect(rows.map((row) => row.id)).toContain(`plan:${TODAY}:keep`);
  });

  it("日期键按母版时区计算，不跟随构造时区", async () => {
    const now = Date.UTC(2026, 9, 28, 3, 30, 0); // 纽约 10-27 23:30 EDT
    const doc = master(
      [entry({ id: "night", schedule: { kind: "daily", at: "00:00" } })],
      { timezone: "America/New_York" },
    );
    const { queue } = fakeQueue();
    const result = await schedulerAt(now, {
      masterDoc: doc,
      queue,
      timezone: TZ,
    }).reconcile({ reason: "manual" });

    expect(result.date).toBe(YESTERDAY);
    const nextMidnight = result.entries.find((row) => row.id === "plan:2026-10-28:night");
    expect(nextMidnight?.at).toBe(Date.UTC(2026, 9, 28, 4, 0, 0));
  });

  it("start() 在 05:00 触发 anchor 对账，dispose() 清掉后续定时器", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 27, 20, 59, 30))); // 04:59:30 +08
    const doc = master([entry({ id: "build", action: "plan.build", schedule: { kind: "daily", at: "05:00" } })]);
    const { queue, calls } = fakeQueue();
    const observations: PlanSchedulerObservation[] = [];
    const scheduler = new PlanScheduler({
      masterStore: { read: async () => doc },
      overlayStore: absentOverlay(),
      queue,
      mainSessionId: "ses_main",
      timezone: TZ,
      observe: (event) => observations.push(event),
      watchdogMs: 0,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(30_000);
    for (let attempt = 0; attempt < 20 && calls.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    expect(calls).toHaveLength(1);
    expect(observations).toContainEqual(
      expect.objectContaining({ kind: "reconcile", reason: "anchor-0500" }),
    );

    scheduler.dispose();
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(calls).toHaveLength(1);
  });
});

describe("PlanScheduler 参数校验", () => {
  it("拒绝空主会话、非法时区、倒挂的迟到档与 shadow 缺 stateRoot", () => {
    const doc = master([]);
    const base = {
      masterStore: { read: async () => doc },
      overlayStore: absentOverlay(),
      mainSessionId: "ses_main",
      queue: fakeQueue().queue,
    };
    expect(() => new PlanScheduler({ ...base, mainSessionId: " " })).toThrow(/mainSessionId/);
    expect(() => new PlanScheduler({ ...base, timezone: "Mars/Olympus" })).toThrow(/timezone/);
    expect(
      () => new PlanScheduler({ ...base, catchupMaxAgeHours: 12, debtAfterHours: 8 }),
    ).toThrow(/debtAfterHours/);
    expect(() => new PlanScheduler({ ...base, shadow: true })).toThrow(/stateRoot/);
  });
});
