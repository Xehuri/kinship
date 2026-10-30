/**
 * PlanScheduler（T08）：把母版 + 当日覆盖层折算成可投递的唤醒条目。
 *
 * 边界：
 *   - 只读 master / overlay / 昨日有效计划，绝不写完成状态或回写计划；
 *   - 只对 `source: "plan"` 做 reconcileSource，绝不碰 flow / special；
 *   - 不发用户通知；主会话完成条目后再写 `plan done`。
 *
 * 观察期（shadow）只把“本来会入队”的条目写到
 * `{stateRoot}/plan/shadow/{date}.jsonl`，不调用队列。
 * 账本 `{stateRoot}/plan/scheduler.jsonl` 或注入的 ledger 回调只追加事实行。
 */
// allow: SIZE_OK — T08 allowlist 只允许本文件承载对账、定时器与观测面。

import { appendFileSync, mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { isWakeAction } from "./actions.js";
import { writeTextAtomic } from "./atomic-write.js";
import { materializeMasterEntries, type MasterEntry, type MasterPlanDocument } from "./master-plan.js";
import {
  PlanOverlayNotFoundError,
  effectiveFromLegacyPlan,
  mergeOverlay,
  type EffectivePlan,
  type EffectivePlanEntry,
  type PlanOverlayDocument,
} from "./plan-overlay.js";
import type { PlanDocument, PlanItemStatus } from "./plan-store.js";
import { addDays, localDateTimeToEpoch, zonedDateKey, zonedNow } from "./timezone.js";
import type { WakeQueueEntryInput, WakeQueueReconcileResult } from "../serve/wake-queue.js";

export const PLAN_SCHEDULER_REASONS = [
  "boot",
  "anchor-0500",
  "anchor-0730",
  "watchdog",
  "manual",
] as const;
export type ReconcileReason = (typeof PLAN_SCHEDULER_REASONS)[number];

export const PLAN_SCHEDULER_LEDGER_SCHEMA = 1 as const;
const HOUR_MS = 60 * 60 * 1000;
const LATE_DELAY_MS = 60_000;
const DEFAULT_TIMEZONE = "Asia/Shanghai";
const DEFAULT_WATCHDOG_MS = 60_000;
const DEFAULT_HORIZON_HOURS = 48;
const DEFAULT_CATCHUP_MAX_AGE_HOURS = 8;
const DEFAULT_DEBT_AFTER_HOURS = 24;
const MAX_DATES = 20;
const MAX_HOURS = 24 * 7;

const TERMINAL_STATUSES: ReadonlySet<PlanItemStatus> = new Set(["done", "skipped", "carried"]);

export interface PlanSchedulerMasterStore {
  read(): Promise<MasterPlanDocument>;
  readLastGood?(): Promise<MasterPlanDocument>;
}

/** 生产传 JsonPlanOverlayStore；母版合并在调度器内完成，legacy 只读回退可选。 */
export interface PlanSchedulerOverlayStore {
  read(date: string): Promise<PlanOverlayDocument>;
  readLegacy?(date: string): Promise<PlanDocument | null>;
}

/** WakeQueue 结构兼容的最小面：调度器只允许对 plan 来源对账。 */
export interface PlanSchedulerQueue {
  reconcileSource(
    source: "plan",
    entries: readonly WakeQueueEntryInput[],
  ): Promise<WakeQueueReconcileResult>;
}

export interface PlanSchedulerLedgerRow {
  readonly schema: typeof PLAN_SCHEDULER_LEDGER_SCHEMA;
  readonly at: number;
  readonly date: string;
  readonly event: string;
  readonly reason?: string;
  readonly entry_id?: string;
  readonly detail?: string;
}

export interface PlanSchedulerSkipCounts {
  readonly horizon: number;
  readonly no_time: number;
  readonly debt: number;
  readonly duplicate: number;
}

export interface PlanSchedulerLeftover {
  readonly id: string;
  readonly status: PlanItemStatus;
  readonly title: string;
  readonly at?: string;
}

export type PlanSchedulerObservation =
  | {
      readonly kind: "reconcile";
      readonly reason: ReconcileReason;
      readonly date: string;
      readonly entries: number;
      readonly skipped: PlanSchedulerSkipCounts;
    }
  | { readonly kind: "deferred_no_session"; readonly reason: ReconcileReason }
  | { readonly kind: "master_error"; readonly reason: ReconcileReason; readonly message: string }
  | { readonly kind: "master_fallback"; readonly reason: ReconcileReason; readonly message: string }
  | { readonly kind: "overlay_error"; readonly date: string; readonly message: string }
  | { readonly kind: "overlay_warning"; readonly date: string; readonly warning: string }
  | { readonly kind: "skipped_debt"; readonly date: string; readonly entry_id: string; readonly at: string }
  | { readonly kind: "skipped_horizon"; readonly date: string; readonly entry_id: string; readonly at: string }
  | { readonly kind: "skipped_no_time"; readonly date: string; readonly entry_id: string }
  | { readonly kind: "duplicate"; readonly date: string; readonly entry_id: string }
  | { readonly kind: "coalesced"; readonly date: string; readonly id: string; readonly slots: number }
  | { readonly kind: "shadow"; readonly date: string; readonly path: string; readonly entries: number }
  | { readonly kind: "queue_error"; readonly message: string }
  | { readonly kind: "error"; readonly operation: string; readonly message: string };

export type ReconcileStatus = "reconciled" | "deferred_no_session" | "degraded" | "shadow";

export interface ReconcileResult {
  readonly status: ReconcileStatus;
  readonly reason: ReconcileReason;
  readonly date: string | null;
  readonly entries: readonly WakeQueueEntryInput[];
  readonly skipped: PlanSchedulerSkipCounts;
  readonly warnings: readonly string[];
  readonly queue: WakeQueueReconcileResult | null;
}

export interface PlanSchedulerOptions {
  readonly masterStore: PlanSchedulerMasterStore;
  readonly overlayStore: PlanSchedulerOverlayStore;
  readonly queue?: PlanSchedulerQueue;
  readonly mainSessionId?: string;
  readonly mainSession?: () => string | null | undefined | Promise<string | null | undefined>;
  readonly timezone?: string;
  readonly now?: () => number;
  readonly observe?: (event: PlanSchedulerObservation) => void;
  /** 0 关闭看门狗；缺省 60s。 */
  readonly watchdogMs?: number;
  readonly horizonHours?: number;
  readonly catchupMaxAgeHours?: number;
  readonly debtAfterHours?: number;
  readonly shadow?: boolean;
  /** shadow 文件与 scheduler.jsonl 的根；提供 ledger 回调时可省略。 */
  readonly stateRoot?: string;
  readonly ledger?: (row: PlanSchedulerLedgerRow) => void | Promise<void>;
}

export class PlanSchedulerValidationError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`[plan-scheduler:validation] ${field}: ${message}`);
    this.name = "PlanSchedulerValidationError";
    this.field = field;
  }
}

interface SchedulerItem {
  readonly id: string;
  readonly title: string | undefined;
  readonly intent: string | undefined;
  readonly at: string | undefined;
  readonly action: string | undefined;
  readonly payload: unknown;
  readonly instruction: string | undefined;
  readonly window: string | undefined;
  readonly target_date: string | undefined;
  readonly status: PlanItemStatus;
  readonly suppressed: boolean;
}

interface Slot {
  readonly date: string;
  readonly item: SchedulerItem;
  readonly slotAt: number;
}

interface PlannedEntry {
  readonly date: string;
  readonly entry: WakeQueueEntryInput;
}

interface ComputeInput {
  readonly master: MasterPlanDocument;
  readonly dates: readonly string[];
  readonly today: string;
  readonly leftovers: readonly PlanSchedulerLeftover[];
  readonly now: number;
  readonly effective: Map<string, EffectivePlan | null>;
}

interface ComputeOutput {
  readonly planned: readonly PlannedEntry[];
  readonly skipped: PlanSchedulerSkipCounts;
  readonly warnings: readonly string[];
}

type MutableSkipCounts = { horizon: number; no_time: number; debt: number; duplicate: number };

type TimerHandle = ReturnType<typeof setTimeout>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function unrefTimer(handle: TimerHandle | ReturnType<typeof setInterval>): void {
  const candidate: { unref?: () => void } = handle;
  candidate.unref?.();
}

function requireTimezone(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PlanSchedulerValidationError("timezone", "必须是非空 IANA 时区");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
  } catch {
    throw new PlanSchedulerValidationError("timezone", `不是有效 IANA 时区: ${value}`);
  }
  return value;
}

function requireHours(value: unknown, field: string, min: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new PlanSchedulerValidationError(field, `必须是 >=${String(min)} 的整数: ${String(value)}`);
  }
  return value;
}

function requireReason(value: unknown): ReconcileReason {
  if (typeof value !== "string" || !(PLAN_SCHEDULER_REASONS as readonly string[]).includes(value)) {
    throw new PlanSchedulerValidationError(
      "reason",
      `必须是 ${PLAN_SCHEDULER_REASONS.join(" | ")} 之一: ${String(value)}`,
    );
  }
  return value as ReconcileReason;
}

function fromEffectiveEntry(entry: EffectivePlanEntry): SchedulerItem {
  return {
    id: entry.id,
    title: entry.title,
    intent: entry.intent,
    at: entry.at,
    action: entry.action,
    payload: entry.payload,
    instruction: entry.instruction,
    window: entry.window,
    target_date: entry.target_date,
    status: entry.status,
    suppressed: entry.suppressed,
  };
}

function fromMasterEntry(entry: MasterEntry): SchedulerItem {
  return {
    id: entry.id,
    title: entry.title,
    intent: entry.intent,
    at: entry.schedule.at,
    action: entry.action,
    payload: entry.payload,
    instruction: entry.instruction,
    window: entry.window,
    target_date: entry.target_date,
    status: "planned",
    suppressed: false,
  };
}

function masterItems(master: MasterPlanDocument, date: string): readonly SchedulerItem[] {
  return materializeMasterEntries(master, date).map(fromMasterEntry);
}

function effectiveItems(plan: EffectivePlan): readonly SchedulerItem[] {
  return plan.entries.map(fromEffectiveEntry);
}

function collectLeftovers(plan: EffectivePlan): readonly PlanSchedulerLeftover[] {
  const rows: PlanSchedulerLeftover[] = [];
  for (const entry of plan.entries) {
    if (entry.suppressed) continue;
    if (entry.status !== "planned" && entry.status !== "blocked" && entry.status !== "carried") continue;
    // 计划/复核唤醒本身是调度动作，不是昨日遗留。
    if (entry.action === "plan.build" || entry.action === "plan.review") continue;
    rows.push({
      id: entry.id,
      status: entry.status,
      title: entry.title ?? entry.intent ?? entry.id,
      ...(entry.at === undefined ? {} : { at: entry.at }),
    });
  }
  return rows;
}

function plannedId(date: string, action: string | undefined, itemId: string): string {
  if (action === "plan.build") return `plan:${date}:build`;
  if (action === "plan.review") return `plan:${date}:review`;
  return `plan:${date}:${itemId}`;
}

function entryTitle(item: SchedulerItem): string {
  return item.title ?? item.intent ?? item.id;
}

function basePayload(date: string, item: SchedulerItem): Record<string, unknown> {
  return {
    ...(isRecord(item.payload) ? item.payload : {}),
    date,
    entry_id: item.id,
    title: entryTitle(item),
    ...(item.at === undefined ? {} : { at: item.at }),
    ...(item.action === undefined ? {} : { action: item.action }),
    ...(item.window === undefined ? {} : { window: item.window }),
    ...(item.target_date === undefined ? {} : { target_date: item.target_date }),
  };
}

function makeEntry(
  date: string,
  item: SchedulerItem,
  at: number,
  extra: Record<string, unknown>,
  instruction: string | undefined,
): WakeQueueEntryInput {
  const action = isWakeAction(item.action) ? item.action : undefined;
  return {
    id: plannedId(date, item.action, item.id),
    source: "plan",
    at,
    payload: { ...basePayload(date, item), ...extra },
    ...(action === undefined ? {} : { action }),
    ...(instruction === undefined ? {} : { instruction }),
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortPlanned(rows: readonly PlannedEntry[]): PlannedEntry[] {
  return [...rows].sort((left, right) => {
    if (left.entry.at !== right.entry.at) return left.entry.at - right.entry.at;
    return compareText(left.entry.id, right.entry.id);
  });
}

function dateRange(first: string, last: string): string[] {
  const dates: string[] = [];
  let key = first;
  while (key <= last && dates.length < MAX_DATES) {
    dates.push(key);
    key = addDays(key, 1);
  }
  return dates;
}

function catchupInstruction(date: string, slots: readonly Slot[]): string {
  const lines = [`补做 ${date} 的迟到覆盖：`];
  for (const slot of slots) {
    const window = slot.item.window === undefined ? "" : `（窗口 ${slot.item.window}）`;
    lines.push(`- ${slot.item.at ?? "?"} [${slot.item.id}] ${entryTitle(slot.item)}${window}`);
  }
  return lines.join("\n");
}

export class PlanScheduler {
  readonly #masterStore: PlanSchedulerMasterStore;
  readonly #overlayStore: PlanSchedulerOverlayStore;
  readonly #queue: PlanSchedulerQueue | undefined;
  readonly #mainSessionId: string | undefined;
  readonly #mainSession: PlanSchedulerOptions["mainSession"];
  #timezone: string;
  readonly #now: () => number;
  readonly #observeSink: ((event: PlanSchedulerObservation) => void) | undefined;
  readonly #ledgerSink: ((row: PlanSchedulerLedgerRow) => void | Promise<void>) | undefined;
  readonly #watchdogMs: number;
  readonly #horizonMs: number;
  readonly #catchupMaxAgeMs: number;
  readonly #debtAfterMs: number;
  readonly #shadow: boolean;
  readonly #stateRoot: string | undefined;

  #tail: Promise<unknown> = Promise.resolve();
  readonly #anchorTimers = new Map<ReconcileReason, TimerHandle>();
  #watchdogTimer: ReturnType<typeof setInterval> | null = null;
  #started = false;
  #disposed = false;

  constructor(options: PlanSchedulerOptions) {
    if (options.mainSession === undefined) {
      if (typeof options.mainSessionId !== "string" || options.mainSessionId.trim() === "") {
        throw new PlanSchedulerValidationError("mainSessionId", "必须提供 mainSessionId 或 mainSession 回调");
      }
    }
    if (options.masterStore === undefined || typeof options.masterStore.read !== "function") {
      throw new PlanSchedulerValidationError("masterStore", "必须提供 masterStore.read");
    }
    if (options.overlayStore === undefined || typeof options.overlayStore.read !== "function") {
      throw new PlanSchedulerValidationError("overlayStore", "必须提供 overlayStore.read");
    }
    const stateRoot =
      options.stateRoot === undefined
        ? undefined
        : requireAbsolute(options.stateRoot, "stateRoot");
    if (options.shadow === true && stateRoot === undefined) {
      throw new PlanSchedulerValidationError("stateRoot", "shadow 模式必须提供 stateRoot");
    }
    if (options.shadow !== true && options.queue === undefined) {
      throw new PlanSchedulerValidationError("queue", "非 shadow 模式必须提供 queue");
    }
    const horizonHours = requireHours(
      options.horizonHours ?? DEFAULT_HORIZON_HOURS,
      "horizonHours",
      1,
    );
    const catchupMaxAgeHours = requireHours(
      options.catchupMaxAgeHours ?? DEFAULT_CATCHUP_MAX_AGE_HOURS,
      "catchupMaxAgeHours",
      0,
    );
    const debtAfterHours = requireHours(
      options.debtAfterHours ?? DEFAULT_DEBT_AFTER_HOURS,
      "debtAfterHours",
      1,
    );
    if (debtAfterHours <= catchupMaxAgeHours) {
      throw new PlanSchedulerValidationError(
        "debtAfterHours",
        "必须大于 catchupMaxAgeHours，否则迟到档与补做档重叠",
      );
    }
    if (horizonHours > MAX_HOURS) {
      throw new PlanSchedulerValidationError(
        "horizonHours",
        `最长 ${String(MAX_HOURS)} 小时，避免日期范围失控`,
      );
    }
    if (debtAfterHours > MAX_HOURS) {
      throw new PlanSchedulerValidationError(
        "debtAfterHours",
        `最长 ${String(MAX_HOURS)} 小时，避免日期范围失控`,
      );
    }
    const watchdogMs = options.watchdogMs ?? DEFAULT_WATCHDOG_MS;
    if (!Number.isInteger(watchdogMs) || watchdogMs < 0) {
      throw new PlanSchedulerValidationError(
        "watchdogMs",
        `必须是非负整数: ${String(watchdogMs)}`,
      );
    }
    this.#masterStore = options.masterStore;
    this.#overlayStore = options.overlayStore;
    this.#queue = options.queue;
    this.#mainSessionId = options.mainSessionId;
    this.#mainSession = options.mainSession;
    this.#timezone = requireTimezone(options.timezone ?? DEFAULT_TIMEZONE);
    this.#now = options.now ?? Date.now;
    this.#observeSink = options.observe;
    this.#ledgerSink = options.ledger;
    this.#watchdogMs = watchdogMs;
    this.#horizonMs = horizonHours * HOUR_MS;
    this.#catchupMaxAgeMs = catchupMaxAgeHours * HOUR_MS;
    this.#debtAfterMs = debtAfterHours * HOUR_MS;
    this.#shadow = options.shadow === true;
    this.#stateRoot = stateRoot;
  }

  /** 每天 05:00 / 07:30 触发对账；看门狗按 watchdogMs 兜底。 */
  start(): void {
    if (this.#started || this.#disposed) return;
    this.#started = true;
    this.#scheduleAnchor("05:00", "anchor-0500");
    this.#scheduleAnchor("07:30", "anchor-0730");
    if (this.#watchdogMs > 0) {
      const handle = setInterval(() => {
        void this.#runWatchdog();
      }, this.#watchdogMs);
      unrefTimer(handle);
      this.#watchdogTimer = handle;
    }
  }

  dispose(): void {
    this.#disposed = true;
    for (const timer of this.#anchorTimers.values()) clearTimeout(timer);
    this.#anchorTimers.clear();
    if (this.#watchdogTimer !== null) {
      clearInterval(this.#watchdogTimer);
      this.#watchdogTimer = null;
    }
  }

  /** 串行对账；同一分钟重复调用产生相同 id，队列按 id/at/payload 去重。 */
  async reconcile(input: { readonly reason: ReconcileReason }): Promise<ReconcileResult> {
    const reason = requireReason(input.reason);
    const run = this.#tail.then(
      () => this.#reconcile(reason),
      () => this.#reconcile(reason),
    );
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #reconcile(reason: ReconcileReason): Promise<ReconcileResult> {
    const now = this.#nowMs();
    const emptySkipped: PlanSchedulerSkipCounts = {
      horizon: 0,
      no_time: 0,
      debt: 0,
      duplicate: 0,
    };
    const session = await this.#resolveSession();
    if (session === null) {
      const date = zonedDateKey(now, this.#timezone);
      this.#emit({ kind: "deferred_no_session", reason });
      await this.#record({ date, event: "deferred_no_session", reason });
      return {
        status: "deferred_no_session",
        reason,
        date: null,
        entries: [],
        skipped: emptySkipped,
        warnings: [],
        queue: null,
      };
    }

    const master = await this.#loadMaster(reason, now);
    if (master === null) {
      const date = zonedDateKey(now, this.#timezone);
      return {
        status: "degraded",
        reason,
        date: null,
        entries: [],
        skipped: emptySkipped,
        warnings: [],
        queue: null,
      };
    }

    this.#retime(master.timezone);
    const timezone = master.timezone;
    const today = zonedDateKey(now, timezone);
    const firstDate = zonedDateKey(now - this.#debtAfterMs, timezone);
    const lastDate = zonedDateKey(now + this.#horizonMs, timezone);
    const dates = dateRange(firstDate, lastDate);
    const effective = new Map<string, EffectivePlan | null>();
    const yesterday = addDays(today, -1);
    const leftovers = await this.#loadLeftovers(yesterday, master, effective);
    const computed = await this.#compute({
      master,
      dates,
      today,
      leftovers,
      now,
      effective,
    });
    const planned = sortPlanned(computed.planned);

    if (this.#shadow) {
      this.#writeShadow(planned, today);
      this.#emit({
        kind: "reconcile",
        reason,
        date: today,
        entries: planned.length,
        skipped: computed.skipped,
      });
      return {
        status: "shadow",
        reason,
        date: today,
        entries: planned.map((row) => row.entry),
        skipped: computed.skipped,
        warnings: computed.warnings,
        queue: null,
      };
    }

    const queue = this.#queue;
    if (queue === undefined) {
      throw new PlanSchedulerValidationError("queue", "非 shadow 模式缺少 queue");
    }
    let queueResult: WakeQueueReconcileResult;
    try {
      queueResult = await queue.reconcileSource(
        "plan",
        planned.map((row) => row.entry),
      );
    } catch (error) {
      const message = errorMessage(error);
      this.#emit({ kind: "queue_error", message });
      await this.#record({ date: today, event: "queue_error", reason, detail: message });
      return {
        status: "degraded",
        reason,
        date: today,
        entries: planned.map((row) => row.entry),
        skipped: computed.skipped,
        warnings: computed.warnings,
        queue: null,
      };
    }
    this.#emit({
      kind: "reconcile",
      reason,
      date: today,
      entries: planned.length,
      skipped: computed.skipped,
    });
    return {
      status: "reconciled",
      reason,
      date: today,
      entries: planned.map((row) => row.entry),
      skipped: computed.skipped,
      warnings: computed.warnings,
      queue: queueResult,
    };
  }

  async #loadMaster(
    reason: ReconcileReason,
    now: number,
  ): Promise<MasterPlanDocument | null> {
    try {
      return await this.#masterStore.read();
    } catch (error) {
      const message = errorMessage(error);
      const fallback = this.#masterStore.readLastGood;
      if (fallback === undefined) {
        this.#emit({ kind: "master_error", reason, message });
        await this.#record({
          date: zonedDateKey(now, this.#timezone),
          event: "master_error",
          reason,
          detail: message,
        });
        return null;
      }
      try {
        const doc = await fallback.call(this.#masterStore);
        this.#emit({ kind: "master_fallback", reason, message });
        await this.#record({
          date: zonedDateKey(now, this.#timezone),
          event: "master_fallback",
          reason,
          detail: message,
        });
        return doc;
      } catch (fallbackError) {
        const detail = `${message}; last-good: ${errorMessage(fallbackError)}`;
        this.#emit({ kind: "master_error", reason, message: detail });
        await this.#record({
          date: zonedDateKey(now, this.#timezone),
          event: "master_error",
          reason,
          detail,
        });
        return null;
      }
    }
  }

  async #loadLeftovers(
    date: string,
    master: MasterPlanDocument,
    cache: Map<string, EffectivePlan | null>,
  ): Promise<readonly PlanSchedulerLeftover[]> {
    const plan = await this.#loadEffective(date, master, cache);
    if (plan === null) return [];
    return collectLeftovers(plan);
  }

  async #loadEffective(
    date: string,
    master: MasterPlanDocument,
    cache: Map<string, EffectivePlan | null>,
  ): Promise<EffectivePlan | null> {
    const cached = cache.get(date);
    if (cached !== undefined) return cached;
    let plan: EffectivePlan | null = null;
    try {
      const overlay = await this.#overlayStore.read(date);
      try {
        plan = mergeOverlay(master, overlay, date);
      } catch (error) {
        await this.#noteOverlayError(date, error);
      }
    } catch (error) {
      if (error instanceof PlanOverlayNotFoundError) {
        plan = await this.#loadLegacy(date, master);
      } else {
        await this.#noteOverlayError(date, error);
      }
    }
    cache.set(date, plan);
    return plan;
  }

  async #loadLegacy(
    date: string,
    master: MasterPlanDocument,
  ): Promise<EffectivePlan | null> {
    const readLegacy = this.#overlayStore.readLegacy;
    if (readLegacy === undefined) return null;
    try {
      const legacy = await readLegacy.call(this.#overlayStore, date);
      return legacy === null ? null : effectiveFromLegacyPlan(legacy, master);
    } catch (error) {
      await this.#noteOverlayError(date, error);
      return null;
    }
  }

  async #noteOverlayError(date: string, error: unknown): Promise<void> {
    const message = errorMessage(error);
    this.#emit({ kind: "overlay_error", date, message });
    await this.#record({ date, event: "overlay_error", detail: message });
  }

  async #compute(input: ComputeInput): Promise<ComputeOutput> {
    const planned: PlannedEntry[] = [];
    const skipped: MutableSkipCounts = { horizon: 0, no_time: 0, debt: 0, duplicate: 0 };
    const warnings: string[] = [];
    const seen = new Set<string>();
    const lateCoverage: Slot[] = [];
    const horizonEnd = input.now + this.#horizonMs;
    const catchupOldest = input.now - this.#catchupMaxAgeMs;
    const debtOldest = input.now - this.#debtAfterMs;

    for (const date of input.dates) {
      const past = date < input.today;
      const plan = await this.#loadEffective(date, input.master, input.effective);
      let items: readonly SchedulerItem[];
      if (plan === null) {
        items = masterItems(input.master, date);
      } else {
        for (const warning of plan.warnings) {
          const text = `${date}:${warning}`;
          warnings.push(text);
          this.#emit({ kind: "overlay_warning", date, warning });
        }
        items = effectiveItems(plan);
      }

      for (const item of items) {
        if (item.suppressed) continue;
        if (TERMINAL_STATUSES.has(item.status)) continue;
        // 过去日期只追覆盖检查点；其余条目属于昨日遗留，统一挂到 plan.build。
        if (past && item.action !== "coverage.run") continue;
        if (item.at === undefined) {
          skipped.no_time += 1;
          this.#emit({ kind: "skipped_no_time", date, entry_id: item.id });
          continue;
        }
        let slotAt: number;
        try {
          slotAt = localDateTimeToEpoch(date, item.at, input.master.timezone);
        } catch (error) {
          this.#emit({ kind: "error", operation: "slot-at", message: errorMessage(error) });
          continue;
        }
        if (slotAt > horizonEnd) {
          skipped.horizon += 1;
          this.#emit({ kind: "skipped_horizon", date, entry_id: item.id, at: item.at });
          continue;
        }
        if (slotAt < debtOldest) {
          skipped.debt += 1;
          this.#emit({ kind: "skipped_debt", date, entry_id: item.id, at: item.at });
          await this.#record({
            date,
            event: "skipped_debt",
            reason: "older_than_debt",
            entry_id: item.id,
            detail: item.at,
          });
          continue;
        }
        const id = plannedId(date, item.action, item.id);
        if (seen.has(id)) {
          skipped.duplicate += 1;
          this.#emit({ kind: "duplicate", date, entry_id: item.id });
          continue;
        }
        seen.add(id);

        if (slotAt >= catchupOldest) {
          const extra: Record<string, unknown> = {};
          if (date === input.today && item.action === "plan.build" && input.leftovers.length > 0) {
            extra["leftovers"] = input.leftovers;
          }
          planned.push({
            date,
            entry: makeEntry(date, item, slotAt, extra, item.instruction),
          });
          continue;
        }

        const slot: Slot = { date, item, slotAt };
        if (item.action === "coverage.run") {
          lateCoverage.push(slot);
          continue;
        }
        planned.push({
          date,
          entry: makeEntry(date, item, input.now + LATE_DELAY_MS, { late: true }, item.instruction),
        });
      }
    }

    const lateByDate = new Map<string, Slot[]>();
    for (const slot of lateCoverage) {
      const rows = lateByDate.get(slot.date);
      if (rows === undefined) lateByDate.set(slot.date, [slot]);
      else rows.push(slot);
    }
    for (const [date, slots] of lateByDate) {
      const sorted = [...slots].sort((left, right) => {
        if (left.slotAt !== right.slotAt) return left.slotAt - right.slotAt;
        return compareText(left.item.id, right.item.id);
      });
      const anchorSlot = sorted.at(-1);
      if (anchorSlot === undefined || anchorSlot.item.at === undefined) continue;
      // 稳定锚：用该日最后一个迟到 coverage 的原始时刻做 id/at，避免每次
      // reconcile 以 now+60s 生成新 catchup（会重复补跑）。
      const id = `plan:${date}:catchup:${anchorSlot.item.at.replace(":", "")}`;
      if (seen.has(id)) {
        skipped.duplicate += 1;
        continue;
      }
      seen.add(id);
      const payloadSlots = sorted.map((slot) => ({
        entry_id: slot.item.id,
        title: entryTitle(slot.item),
        at: slot.item.at ?? "?",
        ...(slot.item.window === undefined ? {} : { window: slot.item.window }),
        ...(slot.item.target_date === undefined ? {} : { target_date: slot.item.target_date }),
      }));
      planned.push({
        date,
        entry: {
          id,
          source: "plan",
          action: "coverage.run",
          at: anchorSlot.slotAt,
          payload: {
            date,
            entry_id: "catchup",
            title: `补覆盖 ${date}`,
            late: true,
            slots: payloadSlots,
          },
          instruction: catchupInstruction(date, sorted),
        },
      });
      this.#emit({ kind: "coalesced", date, id, slots: sorted.length });
    }

    return { planned, skipped, warnings };
  }

  #writeShadow(planned: readonly PlannedEntry[], today: string): void {
    if (this.#stateRoot === undefined) return;
    const path = join(this.#stateRoot, "plan", "shadow", `${today}.jsonl`);
    const lines = planned.map((row) => JSON.stringify(row.entry));
    try {
      writeTextAtomic(path, `${lines.join("\n")}\n`);
      this.#emit({ kind: "shadow", date: today, path, entries: lines.length });
    } catch (error) {
      this.#emit({ kind: "error", operation: "shadow-write", message: errorMessage(error) });
    }
  }

  async #resolveSession(): Promise<string | null> {
    const callback = this.#mainSession;
    if (callback !== undefined) {
      try {
        const value = await callback();
        return typeof value === "string" && value.trim() !== "" ? value : null;
      } catch (error) {
        this.#emit({ kind: "error", operation: "main-session", message: errorMessage(error) });
        return null;
      }
    }
    const id = this.#mainSessionId;
    return id === undefined || id.trim() === "" ? null : id;
  }

  /** 首次读到母版后把锚点切到母版时区；已启动则立即重排。 */
  #retime(timezone: string): void {
    if (timezone === this.#timezone) return;
    this.#timezone = timezone;
    if (!this.#started || this.#disposed) return;
    for (const timer of this.#anchorTimers.values()) clearTimeout(timer);
    this.#anchorTimers.clear();
    this.#scheduleAnchor("05:00", "anchor-0500");
    this.#scheduleAnchor("07:30", "anchor-0730");
  }

  #scheduleAnchor(clock: string, reason: ReconcileReason): void {
    if (this.#disposed) return;
    const existing = this.#anchorTimers.get(reason);
    if (existing !== undefined) clearTimeout(existing);
    const at = this.#nextAnchor(clock);
    const delay = Math.max(0, at - this.#nowMs());
    const handle = setTimeout(() => {
      if (this.#anchorTimers.get(reason) === handle) this.#anchorTimers.delete(reason);
      void this.#fireAnchor(clock, reason);
    }, delay);
    unrefTimer(handle);
    this.#anchorTimers.set(reason, handle);
  }

  async #fireAnchor(clock: string, reason: ReconcileReason): Promise<void> {
    if (this.#disposed) return;
    try {
      await this.reconcile({ reason });
    } catch (error) {
      this.#emit({ kind: "error", operation: "anchor", message: errorMessage(error) });
    }
    if (!this.#disposed) this.#scheduleAnchor(clock, reason);
  }

  #nextAnchor(clock: string): number {
    const now = this.#nowMs();
    const date = zonedDateKey(now, this.#timezone);
    const today = localDateTimeToEpoch(date, clock, this.#timezone);
    if (today > now) return today;
    return localDateTimeToEpoch(addDays(date, 1), clock, this.#timezone);
  }

  async #runWatchdog(): Promise<void> {
    if (this.#disposed) return;
    try {
      await this.reconcile({ reason: "watchdog" });
    } catch (error) {
      this.#emit({ kind: "error", operation: "watchdog", message: errorMessage(error) });
    }
  }

  #nowMs(): number {
    const value = this.#now();
    if (!Number.isFinite(value)) {
      throw new PlanSchedulerValidationError("now", `时钟必须返回有限毫秒: ${String(value)}`);
    }
    return value;
  }

  #emit(event: PlanSchedulerObservation): void {
    const sink = this.#observeSink;
    if (sink === undefined) return;
    try {
      sink(event);
    } catch {
      // 观察回调自炸不得影响调度主流程
    }
  }

  /** 追加事实行；ledger 回调优先，其次写 scheduler.jsonl，均 best-effort。 */
  async #record(input: Omit<PlanSchedulerLedgerRow, "schema" | "at">): Promise<void> {
    const row: PlanSchedulerLedgerRow = {
      schema: PLAN_SCHEDULER_LEDGER_SCHEMA,
      at: this.#nowMs(),
      ...input,
    };
    const sink = this.#ledgerSink;
    if (sink !== undefined) {
      try {
        await sink(row);
      } catch (error) {
        this.#emit({ kind: "error", operation: "ledger", message: errorMessage(error) });
      }
      return;
    }
    if (this.#stateRoot === undefined) return;
    try {
      const dir = join(this.#stateRoot, "plan");
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, "scheduler.jsonl"), `${JSON.stringify(row)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch (error) {
      this.#emit({ kind: "error", operation: "ledger", message: errorMessage(error) });
    }
  }
}

function requireAbsolute(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PlanSchedulerValidationError(field, "必须是非空绝对路径");
  }
  if (!isAbsolute(value)) {
    throw new PlanSchedulerValidationError(field, `必须是绝对路径: ${value}`);
  }
  return resolve(value);
}
