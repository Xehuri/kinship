/**
 * 收件箱摘要排班（T3）：只借既有 WakeQueue 的来源对账，不新建队列/定时器。
 *
 * 口径：
 *   - 每封 pending digest 信的应到时刻 = max(not_before/deferred_until, min(created+cadence, created+maxAge))；
 *   - 全量 pending digest 的最早应到时刻 = 唯一 inbox 队列条目；到点即排 now；
 *   - 无 pending digest = reconcileSource("inbox", []) 取消全部 inbox 条目；
 *   - 投递时按 entry.at 过滤（只有当时已可用的 pending digest 才入批），oldest first、≤ maxBatch。
 */

import type { InboxConfig } from "../config/section-checks.js";
import type { WakeQueue, WakeQueueEntry } from "../serve/wake-queue.js";
import {
  DEFAULT_DIGEST_CADENCE_MS,
  DEFAULT_DIGEST_MAX_AGE_MS,
  DEFAULT_DIGEST_MAX_BATCH,
} from "./defaults.js";
import {
  countsFromSnapshot,
  renderDigestEnvelope,
} from "./envelope.js";
import type { InboxJournalStore } from "./journal-store.js";
import type { InboxLog } from "./router.js";
import type { LetterRecord } from "./types.js";

export interface InboxDigestRuntimeOptions {
  readonly store: InboxJournalStore;
  readonly config: InboxConfig;
  readonly queue: Pick<WakeQueue, "reconcileSource">;
  readonly now?: () => number;
  readonly log?: InboxLog;
}

interface DigestBatch {
  readonly batchId: string;
  readonly ids: readonly string[];
}

function dueOf(
  letter: LetterRecord,
  cadenceMs: number,
  maxAgeMs: number,
): number {
  const floor = letter.deferred_until ?? letter.not_before ?? 0;
  const cadenceAt = letter.created_at + cadenceMs;
  const maxAgeAt = letter.created_at + maxAgeMs;
  return Math.max(floor, Math.min(cadenceAt, maxAgeAt));
}

function isDigestPending(letter: LetterRecord): boolean {
  return letter.class === "digest" && (letter.state === "pending" || letter.state === "deferred");
}

export class InboxDigestRuntime {
  readonly #store: InboxJournalStore;
  readonly #queue: Pick<WakeQueue, "reconcileSource">;
  readonly #now: () => number;
  readonly #cadenceMs: number;
  readonly #maxAgeMs: number;
  readonly #maxBatch: number;
  readonly #knownSources: readonly string[];
  readonly #log: InboxLog | undefined;
  readonly #batches = new Map<string, DigestBatch>();

  constructor(options: InboxDigestRuntimeOptions) {
    this.#store = options.store;
    this.#queue = options.queue;
    this.#now = options.now ?? Date.now;
    this.#cadenceMs = options.config.digest?.cadenceMs ?? DEFAULT_DIGEST_CADENCE_MS;
    this.#maxAgeMs = options.config.digest?.maxAgeMs ?? DEFAULT_DIGEST_MAX_AGE_MS;
    this.#maxBatch = options.config.digest?.maxBatch ?? DEFAULT_DIGEST_MAX_BATCH;
    this.#knownSources = Object.keys(options.config.sources ?? {});
    this.#log = options.log;
  }

  nextDue(now: number = this.#nowMs()): number | null {
    let due: number | null = null;
    for (const letter of this.#store.list({ class: "digest" })) {
      if (!isDigestPending(letter)) continue;
      const candidate = dueOf(letter, this.#cadenceMs, this.#maxAgeMs);
      const at = Math.max(candidate, now);
      if (letter.expires_at !== undefined && at >= letter.expires_at) continue;
      if (due === null || candidate < due) due = candidate;
    }
    return due;
  }

  async reconcile(): Promise<void> {
    const now = this.#nowMs();
    const due = this.nextDue(now);
    if (due === null) {
      await this.#queue.reconcileSource("inbox", []);
      return;
    }
    const at = Math.max(due, now);
    await this.#queue.reconcileSource("inbox", [
      {
        id: `inbox:digest:${String(at)}`,
        source: "inbox",
        action: "inbox.digest",
        at,
        payload: { title: "收件箱摘要", due_at: at },
      },
    ]);
  }

  render(entry: WakeQueueEntry): string | null {
    const records = this.#eligibleAt(entry.at);
    if (records.length === 0) {
      this.#batches.delete(entry.id);
      return null;
    }
    const batchId = `inbox:batch:${entry.id}`;
    this.#batches.set(entry.id, {
      batchId,
      ids: records.map((record) => record.id),
    });
    const counts = countsFromSnapshot(
      this.#store.snapshot({ now: this.#nowMs(), knownSources: this.#knownSources }),
      records.map((record) => record.id),
    );
    return renderDigestEnvelope(records, batchId, counts);
  }

  async markDelivered(entry: WakeQueueEntry): Promise<void> {
    const batch = this.#batches.get(entry.id);
    this.#batches.delete(entry.id);
    if (batch === undefined) {
      this.#log?.("warn", "loom inbox digest batch missing at delivery", {
        entryID: entry.id,
      });
      return;
    }
    const now = this.#nowMs();
    for (const id of batch.ids) {
      const record = this.#store.get(id);
      if (record === undefined) continue;
      if (record.state !== "pending" && record.state !== "deferred") continue;
      this.#store.appendEvent({
        schema: 1,
        event: "letter.delivered",
        at: now,
        id,
        delivered_at: now,
        attempts: record.attempts + 1,
        batch_id: batch.batchId,
      });
    }
    await this.reconcile();
  }

  #eligibleAt(at: number): readonly LetterRecord[] {
    return this.#store
      .list({ class: "digest" })
      .filter((record) => {
        if (!isDigestPending(record)) return false;
        if (record.expires_at !== undefined && at >= record.expires_at) return false;
        const floor = record.deferred_until ?? record.not_before ?? 0;
        return floor <= at;
      })
      .slice(0, this.#maxBatch);
  }

  #nowMs(): number {
    const value = this.#now();
    if (!Number.isFinite(value)) {
      throw new Error(`inbox digest clock returned non-finite value: ${String(value)}`);
    }
    return value;
  }
}
